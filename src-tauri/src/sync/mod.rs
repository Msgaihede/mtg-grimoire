//! **The card sync is `grimoire-core`'s, re-exported here beside the desktop's own state.**
//!
//! `run_sync` and everything it drives — the check, the download, the ingest, the set list, the
//! migration log, the reclaim and the one-time compaction — are in
//! `crates/grimoire-core/src/sync.rs` since the extraction's I/O step, and a path through this
//! module reaches that crate's item unless this file defines it. What it defines names a
//! window or something only the desktop holds:
//!
//! * [`AppState`], which wraps the core's [`State`] and adds the mirror's fields, the other
//!   windows' change mask and the pending pairing.
//! * [`lock_db`], [`lock_db_read`] and [`lock_plain`] — one-line delegates
//!   under the names seventy-odd files here reach a connection by.
//!
//! `status` went home with the image cache, whose failure count it reads, and the five tests
//! that built an `AppState` to ask it went with it, onto the core's `State`.

pub use grimoire_core::sync::*;

use grimoire_core::state::State;
use rusqlite::Connection;
use std::sync::{Arc, Mutex, MutexGuard};

/// Everything a command needs. Managed by Tauri as `Arc<AppState>`, so a command's blocking
/// task can own a handle of its own; a sync owns one on the core inside it, `state.core`.
///
/// **It wraps `grimoire-core`'s [`State`] and derefs to it**, so `state.db`, `state.data_dir`,
/// `state.fence` and `state.events` are that struct's fields, read here exactly as they were
/// while this one declared them — and a function that takes `&State` can be handed this. The
/// core holds what every host needs and has no reason to know about a window: the connections,
/// the data directory, the cross-file fence and the event sink, with the one update hook
/// already on the write connection.
///
/// Two connections to one file, deliberately. `db` is the only one that writes, and every
/// writer shares it — the ingest included, which is why it takes the lock a batch at a
/// time rather than for its whole run. The other is opened read-only so searches and
/// status polls answer from the last committed WAL snapshot without queueing behind any
/// writer at all: take it through [`lock_db_read`], or as a mutex through [`State::reader`].
/// See [`crate::db::open_read_only`].
///
/// **Not everything below is the desktop's for good.** The two mirror fields and the change
/// mask are; `pairing` is every host's, and waits here for the type it holds to move with the
/// sync step. `syncing`, `client`, `index` and `images` went to [`State`] with the card sync,
/// the facet index and the image cache, and are read here through the deref exactly as they
/// were — `state.images` is how the `mtgimg://` handler still reaches the cache from an
/// `AppHandle`, the only state it is given.
pub struct AppState {
    /// The every-host half, built by [`State::new`].
    ///
    /// **An `Arc`, because the card sync and the index's build each take one**: both hand the
    /// state to work that outlives the call ([`grimoire_core::sync::run_sync`],
    /// `index::lifecycle::spawn_build`), and the engine cannot be handed an `Arc<AppState>` it
    /// has never heard of. `state.core.clone()` is what those two are given.
    pub core: Arc<State>,
    /// What the plain-text mirror still owes the disk, as three bits.
    ///
    /// An `Arc` and not a plain field because the update hook on `db` holds a clone of it for
    /// the life of the process — it is one of the observers [`crate::mirror::watch::observers`]
    /// hands to [`State::new`]. Written from inside SQLite's own callback and read by the
    /// mirror thread; no lock is involved either way, which is the point.
    pub mirror: Arc<crate::mirror::watch::Mask>,
    /// What the mirror's last pass did, for the Settings panel to read back.
    ///
    /// In memory rather than in the database, deliberately: the numbers describe a folder
    /// that may not survive a restart, and a count read back after one would be a claim about
    /// a disk nobody has looked at since. See [`crate::mirror::watch::LastPass`].
    pub mirror_status: Mutex<crate::mirror::watch::LastPass>,
    /// Which user tables have been written since the other windows were last told — see
    /// [`crate::changes`]. An `Arc` for [`AppState::mirror`]'s reason: the update hook on `db`
    /// holds a clone of it for the life of the process, as a second observer.
    pub changes: Arc<crate::changes::Changes>,
    /// A pairing in flight, if there is one.
    ///
    /// **In memory rather than in the database, deliberately**, and it is the same argument
    /// [`AppState::mirror_status`] makes one field up: an offer that survived a restart would
    /// be an invite a reader printed last month still being accepted today. It outlives the
    /// webview, which is what a reader who opens Settings twice needs, and dies with the
    /// process, which is what makes the pairing token one-time in fact.
    ///
    /// It holds the derived pair key, which is the other reason it is here and not in SQLite:
    /// nothing this side of a completed pairing has any business surviving a crash.
    ///
    /// **An async lock, because it is held across a request** — an `accept`, a `confirm` and a
    /// `poll` each keep it while they talk to the relay's rendezvous, and that is what two things
    /// rest on: a Cancel waits behind the request in flight and so wins, and two polls — two
    /// windows with Settings open — cannot both find the offer unspent and both complete it.
    /// **Taken before the lane, never after.**
    pub pairing: tokio::sync::Mutex<Option<crate::sync_pair::pairing::Pending>>,
}

/// **What keeps every reader of `state.db` unedited.** `AppState` is named in seventy-odd files
/// and its connection in half of them; a field access and a method call both auto-deref, and a
/// `&AppState` coerces to the `&State` a function in the core asks for.
impl std::ops::Deref for AppState {
    type Target = State;

    fn deref(&self) -> &State {
        &self.core
    }
}

/// Run a sync operation on a blocking worker, with a runtime of its own to drive it.
///
/// **Still a worker, though nothing in the operation holds the connection across a request any
/// more.** A stretch is SQLite work, and a wait for the connection when a reader's write has it:
/// blocking, both, and so kept off the async runtime's own threads. What the worker no longer
/// does is keep every other writer out for the length of a network round trip.
///
/// The outer `Err` is the worker itself failing — a panic in the operation — and each caller
/// words that for its own press.
pub async fn on_a_worker<T, F, Fut>(work: F) -> Result<Result<T, String>, tauri::Error>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T, String>>,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        runtime.block_on(work())
    })
    .await
}

/// Lock the database, recovering from a poisoned mutex.
///
/// Poisoning means some other thread panicked while holding the lock; the `Connection`
/// itself survives that (rusqlite rolls an open transaction back as it unwinds), so
/// refusing to lock ever again would brick every later sync and search for no gain.
///
/// Shared with [`crate::search`] so that recovery rule lives in exactly one place — which is
/// [`State::lock_db`] now, and this is the name every caller here has always reached it by.
pub(crate) fn lock_db(state: &State) -> MutexGuard<'_, Connection> {
    state.lock_db()
}

/// Lock any std mutex, recovering from poisoning — the rule [`lock_db`] applies, for what
/// is not a connection (the mirror's record of its last pass is the caller today).
///
/// A one-line delegate on purpose: the recovery rule has
/// exactly one definition, in [`crate::db::lock_plain`], and a second copy of
/// `unwrap_or_else(|e| e.into_inner())` is a second place for it to drift.
pub(crate) fn lock_plain<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    crate::db::lock_plain(mutex)
}

/// Lock the read-only connection, recovering from poisoning as [`lock_db`] does.
///
/// A different mutex from `db`, which is the point: this one is only ever held for a short
/// run of queries — one search, or the five reads [`status`] makes — and never across an
/// `.await`, so waiting for it is bounded no matter what the writer is doing.
///
/// [`State::lock_db_read`], by the name its callers know. On the desktop that is always the
/// second connection; a host with only one reads through the one it writes with.
pub(crate) fn lock_db_read(state: &State) -> MutexGuard<'_, Connection> {
    state.lock_db_read()
}

/// [`with_write`] — the one definition of a user-facing write — is `grimoire-core`'s since the
/// extraction's domain step, re-exported at the name every caller here knows it by. It takes
/// `&State`, which an `&AppState` derefs to.
///
/// Its waiting twin is not re-exported any more: its one caller is a stretch of a sync operation,
/// through the lane (`grimoire_core::state::Lane`), and a departure takes the lane like the rest.
pub(crate) use grimoire_core::state::with_write;
