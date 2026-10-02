//! **The card sync is `grimoire-core`'s, re-exported here beside the desktop's own state.**
//!
//! `run_sync` and everything it drives — the check, the download, the ingest, the set list, the
//! migration log, the reclaim and the one-time compaction — are in
//! `crates/grimoire-core/src/sync.rs` since the extraction's I/O step, and a path through this
//! module reaches that crate's item unless this file defines it. What it defines names a
//! window or something only the desktop holds:
//!
//! * [`AppState`], which wraps the core's [`State`] and adds the mirror's fields, the other
//!   windows' change mask, the image cache and the pending pairing.
//! * [`lock_db`], [`lock_db_read`], [`lock_conn`] and [`lock_plain`] — one-line delegates
//!   under the names seventy-odd files here reach a connection by.
//! * [`status`], which reads the image cache's failure count beside five `sync_meta` rows. It
//!   goes home with the cache.
//!
//! And five tests, with the `file_state` they share: each asks [`status`], or drives
//! `with_write` over an [`AppState`] built on a file `split` converted.

pub use grimoire_core::sync::*;

use grimoire_core::state::State;
use rusqlite::Connection;
use std::sync::atomic::Ordering;
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
/// mask are; `images` and `pairing` are every host's, and wait here for the type each one
/// holds to move — the image cache with the I/O step's third part, the pending pairing with
/// the sync step. `syncing`, `client` and `index` went to [`State`] with the card sync and
/// the facet index, and are read here through the deref exactly as they were.
pub struct AppState {
    /// The every-host half, built by [`State::new`].
    ///
    /// **An `Arc`, because the card sync and the index's build each take one**: both hand the
    /// state to work that outlives the call ([`grimoire_core::sync::run_sync`],
    /// `index::lifecycle::spawn_build`), and the engine cannot be handed an `Arc<AppState>` it
    /// has never heard of. `state.core.clone()` is what those two are given.
    pub core: Arc<State>,
    /// The image cache. Lives here so the `mtgimg://` handler can reach it from an
    /// `AppHandle` — that handle is the only state the handler is given.
    pub images: crate::images::Cache,
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
    pub pairing: Mutex<Option<crate::sync_pair::pairing::Pending>>,
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

/// Lock a connection mutex, recovering from poisoning.
///
/// The rule [`lock_db`] and [`lock_db_read`] both apply, in one place, over any mutex —
/// [`crate::images::Cache`] is handed `&Mutex<Connection>` rather than an `AppState`, so
/// it needs the rule without the state.
///
/// A one-line delegate on purpose: the recovery rule has exactly one definition, in
/// [`crate::db::lock_blocking`], which the ingest also reaches directly.
pub(crate) fn lock_conn(mutex: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    crate::db::lock_blocking(mutex)
}

/// Lock any std mutex, recovering from poisoning — the same rule as [`lock_conn`], for the
/// maps and counters that are not connections ([`crate::images::Cache`]'s single-flight
/// map is the one caller today).
///
/// A one-line delegate for the same reason [`lock_conn`] is one: the recovery rule has
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

/// [`with_write`] and [`with_write_waiting`] — the one definition of a user-facing write —
/// are `grimoire-core`'s since the extraction's domain step, re-exported at the names every
/// caller here knows them by. They take `&State`, which an `&AppState` derefs to.
pub(crate) use grimoire_core::state::{with_write, with_write_waiting};

/// Current sync state for the UI.
///
/// Read through the **read-only** connection, which is what makes the header's numbers
/// stay live during a sync: this used to share the write connection, and so answered
/// `None` for every database-derived field for the whole of an ingest — 44 s when that
/// was written, ~80 s of a 92–99 s sync since schema v3 gzipped `raw`. Under WAL a
/// reader sees the last committed snapshot without blocking, so mid-sync this reports the
/// pre-swap figures — which are true, and are what the user is still looking at in the
/// results list. (The ingest now releases the write lock between batches too, but that is
/// belt to this brace: a poll must not depend on catching a gap.)
///
/// The fields stay `Option` regardless, because the read can still fail outright — this
/// app runs from a USB stick, and the database going away underneath it is the case they
/// are `Option` *for*. `None` means "not readable right now", never "zero".
///
/// `image_store_failures` is the one field here that never touches the connection at all —
/// it is read straight off the image cache's atomic, which is what makes it answerable on
/// exactly the polls where a full disk has also made the database unreadable.
///
/// `card_count` is counted live rather than read from `sync_meta`, so it is right even if
/// a previous run died before writing its meta — and it is counted *here* rather than
/// through [`count_cards`], whose `unwrap_or(0)` is right for its own callers (an empty
/// database must download) and wrong for this one. `Some(0)` is not the smaller lie: `0`
/// is what the UI renders as "no card data yet", so a failed count would put a first-run
/// overlay over a running app and throw away the figures it already had. `None` is what
/// the frontend's `mergeStatus` keys off to keep them; the test
/// `a_count_that_cannot_be_read_is_none_and_never_zero` pins this side of that contract.
pub fn status(state: &AppState) -> SyncStatus {
    let conn = lock_db_read(state);
    SyncStatus {
        card_count: conn
            .query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
            .ok(),
        last_check_at: get_meta(&conn, K_LAST_CHECK_AT),
        bulk_updated_at: get_meta(&conn, K_BULK_UPDATED_AT),
        last_error: get_meta(&conn, K_LAST_ERROR),
        last_ingest_skipped: get_meta(&conn, K_LAST_INGEST_SKIPPED).and_then(|s| s.parse().ok()),
        data_dir: state.data_dir.display().to_string(),
        syncing: state.syncing.load(Ordering::SeqCst),
        // An atomic in memory, so this one is answered even when the read above was not.
        image_store_failures: state.images.store_failures(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A real file with both connections on it — the shape `init_state` builds — because
    /// a status that reads through `db_read` cannot be tested against a `db_read` that
    /// points somewhere else. (An in-memory pair cannot stand in: two in-memory
    /// connections are two different databases.)
    fn file_state(name: &str, syncing: bool) -> (AppState, std::path::PathBuf) {
        let dir = crate::scratch::path(&format!("sync-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::split::convert(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        let read = crate::db::open_read(&dir).unwrap();
        // **Hooked up, so what these fixtures drive runs with the cross-file fence
        // armed.** `State::new` installs it, `crate::sync::with_write`'s `debug_assert`
        // reads it, so a command that committed to both files fails its own test rather
        // than printing a line nobody reads. The desktop's three observers ride along as
        // they do in the app, and nothing here looks at them: the wake is a throwaway,
        // since nothing in this fixture starts `sync_engine::live`.
        let mirror = std::sync::Arc::new(crate::mirror::watch::Mask::default());
        let changes = std::sync::Arc::new(crate::changes::Changes::new());
        (
            AppState {
                // The flag is the core's field now, so it is set on the way in.
                core: Arc::new({
                    let core = State::new(
                        conn,
                        Some(read),
                        PathBuf::from("D:\\app\\data"),
                        grimoire_core::events::silent(),
                        crate::mirror::watch::observers(
                            mirror.clone(),
                            changes.clone(),
                            Default::default(),
                        ),
                        // Never called: these tests stop short of the network.
                        crate::scryfall::Client::new("http://127.0.0.1:1".into()),
                    );
                    core.syncing.store(syncing, Ordering::SeqCst);
                    core
                }),
                // Never touched either — a `Cache` creates nothing until it is asked for
                // an image, so this directory does not have to exist.
                images: crate::images::Cache::new(PathBuf::from("D:\\app\\data\\images")),
                // The mirror is never started in these tests; a clean mask and an empty record are
                // what an `AppState` looks like before the first pass.
                mirror,
                mirror_status: std::sync::Mutex::new(crate::mirror::watch::LastPass::default()),
                pairing: std::sync::Mutex::new(None),
                changes,
            },
            dir,
        )
    }

    /// The status a UI polls *during* a sync. The header used to go blank for the whole of
    /// an ingest — a 44 s one then, ~80 s of a 92–99 s sync now — because the poll shared
    /// the write connection with it. The read-only connection exists for exactly this, and
    /// under WAL it answers from the last committed snapshot without waiting for anyone.
    ///
    /// The ingest also releases that write connection between batches now, so this test
    /// holds it by hand: what is being pinned is that a poll answers while the connection
    /// is held, not that it catches a gap between two batches.
    #[test]
    fn status_answers_real_numbers_while_the_write_connection_is_held() {
        let (state, dir) = file_state("status", true);
        {
            let conn = lock_db(&state);
            set_meta(&conn, K_LAST_CHECK_AT, "1800000000").unwrap();
            set_meta(&conn, K_LAST_ERROR, "rate limited by Scryfall").unwrap();
            set_meta(&conn, K_LAST_INGEST_SKIPPED, "12").unwrap();
            conn.execute(
                "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
                 VALUES ('x','Lightning Bolt','lea','161','en','normal','{}')",
                [],
            )
            .unwrap();
            crate::db::checkpoint_truncate(&conn).unwrap();
        }
        let state = Arc::new(state);

        // Stands in for the ingest. Called from another thread, as the real poll is, so a
        // regression to a blocking lock fails here in five seconds instead of hanging.
        let held = state.db.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let state = state.clone();
            std::thread::spawn(move || {
                let _ = tx.send(status(&state));
            });
        }
        let busy = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("status must not queue behind the writer");
        drop(held);

        assert!(busy.syncing);
        assert_eq!(busy.data_dir, "D:\\app\\data");
        assert_eq!(
            busy.card_count,
            Some(1),
            "the read connection can count cards while the writer is busy"
        );
        assert_eq!(busy.last_check_at.as_deref(), Some("1800000000"));
        assert_eq!(busy.last_error.as_deref(), Some("rate limited by Scryfall"));
        assert_eq!(busy.last_ingest_skipped, Some(12));

        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The other half of the `Option`, and the case the whole nullable DTO exists for: a
    /// status read that genuinely cannot count answers `None`, never `Some(0)`.
    ///
    /// This is a USB-stick app, so "the database went away underneath us" is a Tuesday.
    /// `Some(0)` there is not a smaller lie than a wrong number: `0` is the value the UI
    /// reads as "no card data yet", and it takes the whole screen with a first-run overlay
    /// over a running app. `None` is what `mergeStatus` keys off to keep the figures it
    /// already had, so this test is the backend half of that contract.
    #[test]
    fn a_count_that_cannot_be_read_is_none_and_never_zero() {
        let (state, dir) = file_state("unreadable", false);
        {
            // Stands in for the volume disappearing: the table the count needs is gone,
            // which is what the read connection then reports. (Deleting the file itself
            // is not available as a test — Windows will not unlink an open one.)
            let conn = lock_db(&state);
            conn.execute_batch("DROP TABLE cards_fts; DROP TABLE cards;")
                .unwrap();
        }

        let broken = status(&state);

        assert_eq!(
            broken.card_count, None,
            "an unreadable count must not be reported as an empty collection"
        );
        // The two that never needed the database still answer, as they always did.
        assert!(!broken.syncing);
        assert_eq!(broken.data_dir, "D:\\app\\data");

        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The skipped count survives the process, which the `done` event does not: the
    /// startup sync emits it before the webview is listening, and Tauri drops it.
    #[test]
    fn the_skipped_count_is_readable_from_the_status_long_after_the_event() {
        let (state, dir) = file_state("skipped", false);
        set_meta(&lock_db(&state), K_LAST_INGEST_SKIPPED, "12").unwrap();

        assert_eq!(status(&state).last_ingest_skipped, Some(12));

        // No ingest yet is not the same as an ingest that skipped nothing.
        let (fresh, fresh_dir) = file_state("skipped-fresh", false);
        assert_eq!(status(&fresh).last_ingest_skipped, None);

        drop(state);
        drop(fresh);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&fresh_dir);
    }

    /// A write that cannot have the connection answers the one sentence, after spending the one
    /// bound — and runs `f` when it can. Five copies of this helper agreed on that by accident
    /// until 2026-08-16; now there is one and this is what holds it.
    #[test]
    fn with_write_answers_busy_rather_than_queueing_when_the_connection_is_held() {
        let (state, dir) = file_state("with-write-busy", false);
        let held = crate::db::lock_blocking(&state.db);

        let start = std::time::Instant::now();
        let answer: Result<(), String> = with_write(&state, |_| Ok(()));
        let waited = start.elapsed();

        assert_eq!(
            answer.unwrap_err(),
            crate::db::BUSY,
            "a write that cannot have the connection answers the one sentence"
        );
        // It spent the bound rather than failing instantly or queueing forever.
        assert!(
            waited >= crate::db::WRITE_LOCK_WAIT,
            "with_write must spend the whole bound before giving up, waited {waited:?}"
        );
        assert!(
            waited < crate::db::WRITE_LOCK_WAIT * 2,
            "the wait is bounded, and took {waited:?}"
        );
        drop(held);

        // And with the connection free it runs `f` and hands back its answer.
        let answer = with_write(&state, |c| {
            c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())
        });
        assert_eq!(answer.unwrap(), 1);

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// **The waiting write outlasts the bound [`with_write`] gives up at, and runs `f` once the
    /// connection comes back** — issue #546, item 7: a Leave pressed during a sync trip that held
    /// the connection for longer than five seconds answered BUSY, and "leaving is always possible"
    /// had a condition.
    ///
    /// The holder is **another thread**, because that is the real shape (a trip on the blocking
    /// pool) and because a same-thread call would never return — see the helper's doc. It holds
    /// for the bound plus half a second, so an implementation that quietly kept the bound fails
    /// with BUSY rather than passing on timing luck.
    #[test]
    fn with_write_waiting_outlasts_the_bound_and_runs_once_the_connection_is_free() {
        let (state, dir) = file_state("with-write-waiting", false);
        let hold = crate::db::WRITE_LOCK_WAIT + std::time::Duration::from_millis(500);
        let (taken_tx, taken_rx) = std::sync::mpsc::channel();

        let (answer, waited) = std::thread::scope(|scope| {
            let holder = scope.spawn(|| {
                let held = crate::db::lock_blocking(&state.db);
                taken_tx.send(()).expect("signal");
                std::thread::sleep(hold);
                drop(held);
            });
            taken_rx.recv().expect("the holder took the connection");

            let start = std::time::Instant::now();
            let answer = with_write_waiting(&state, |c| {
                c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
                    .map_err(|e| e.to_string())
            });
            let waited = start.elapsed();
            holder.join().expect("the holder");
            (answer, waited)
        });

        assert_eq!(
            answer.expect("the waiting write gave up, which is the bug"),
            1
        );
        assert!(
            waited > crate::db::WRITE_LOCK_WAIT,
            "it ran before the holder let go, so nothing was held: waited {waited:?}"
        );

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
}
