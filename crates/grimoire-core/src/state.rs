//! What every host holds for as long as it runs: the connections, where the data lives, the
//! cross-file fence and the way out for an event.
//!
//! [`State`] is the half of the desktop's `AppState` that has no reason to know about a
//! window. A host builds one from the connections it opened, and from then on everything in
//! this crate that needs the database is handed a `&State` or a `&Connection` taken from it.
//!
//! **It is the every-host half as far as the extraction has got.** The Scryfall client, the
//! facet index and the sync-in-flight flag are here since the I/O step brought the card sync
//! and the index's lifecycle. The image cache and the pending pairing offer are every host's
//! too, and are still fields of the desktop's `AppState` — each is a type that has not moved
//! here yet, and arrives with the step that moves it.
//!
//! **[`with_write`] is the one definition of a user-facing write**, and it is here since the
//! extraction's domain step brought the managed wishlist and the token reconcile its body calls.
//!
//! **A host opens the connections; this does not.** Bringing the pair to head and running the
//! launch's logged passes is [`crate::schema::prepare_database`], which is this crate's too —
//! but the desktop converts a pre-27 single file first, with a module only it has, so what a
//! host-neutral "open the data folder" should be is left to the first host that is not the
//! desktop. [`State::new`] takes connections that are already at head.

use crate::db::{self, CrossFileFence};
use crate::events::EventSink;
use crate::hooks::{self, WriteObserver};
use crate::index::lifecycle::IndexSlot;
use crate::scryfall;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

/// The connections and what rides them.
///
/// **One connection writes, and every writer shares it** — the ingest included, which is why it
/// takes the lock a batch at a time rather than for its whole run. Take it through
/// [`State::lock_db`] where waiting is right, and through [`db::lock_for`] or
/// [`db::lock_background`] where it is not; `db` is public for those two.
pub struct State {
    /// The write connection, with the hooks [`State::new`] installed on it.
    pub db: Mutex<Connection>,
    /// The read-only connection, on a host that has one — see [`State::reader`].
    db_read: Option<Mutex<Connection>>,
    pub data_dir: PathBuf,
    /// Whether any transaction on `db` has committed across both files.
    ///
    /// An `Arc` because the update hook on `db` holds a clone of it for the life of the
    /// process. See [`CrossFileFence`], which also names what it cannot see.
    pub fence: Arc<CrossFileFence>,
    /// Where an event goes — see [`crate::events`].
    pub events: Arc<dyn EventSink>,
    /// Whether a card sync is in flight. Claimed with an atomic swap and released by a guard
    /// in [`crate::sync::run_sync`], so no way out of a run leaves it set.
    pub syncing: AtomicBool,
    /// The one Scryfall client: one pacing gate and one 429 lockout for everything that asks
    /// `api.scryfall.com` — the card sync here, and the tag feeds, which borrow it.
    pub client: scryfall::Client,
    /// The in-memory facet index and the generation of the corpus it describes — cold, which
    /// is a supported state and not an error, until the first build lands. Read it through
    /// [`crate::index::lifecycle::current`]; everything else about it is that module's.
    ///
    /// `RwLock` and not `Mutex`: every facet request reads it and only a sync or a collection
    /// write replaces it. The `Arc` inside is so a reader clones the handle and lets the lock
    /// go at once — a facet pass must never hold a lock a sync's rebuild is waiting on.
    pub index: RwLock<IndexSlot>,
    /// The host's observers, kept for the one thing the hooks cannot tell them — see
    /// [`State::corpus_replaced`]. The hooks hold their own handles on the same list.
    observers: Vec<Arc<dyn WriteObserver>>,
}

impl State {
    /// Take the connections a host opened and brought to head, and install the hooks.
    ///
    /// **The hooks go on before the write connection goes behind its mutex**, so there is no
    /// `State` whose fence is not riding and no observer that missed a write made through it.
    /// `observers` are the host's — see [`crate::hooks`]; a host with nothing to tell passes
    /// none and still gets the fence.
    ///
    /// **`read` is `None` on a host that can only have one connection.** A browser's storage
    /// permits exactly one (the light-app spec §6), so there the reads go through the write
    /// connection. Everywhere else it is a connection opened read-only on the same files
    /// ([`db::open_read`]), which is what lets a search answer from the last committed
    /// snapshot without queueing behind any writer.
    ///
    /// **`client` is the host's to build**, because where Scryfall's API lives and what lockout
    /// an earlier run earned are the host's to know: the desktop restores a persisted 429
    /// deadline into it before handing it over. No sync is in flight and the index is cold —
    /// the host starts the first build once the state is in an `Arc`.
    pub fn new(
        write: Connection,
        read: Option<Connection>,
        data_dir: PathBuf,
        events: Arc<dyn EventSink>,
        observers: Vec<Arc<dyn WriteObserver>>,
        client: scryfall::Client,
    ) -> State {
        let fence = Arc::new(CrossFileFence::new());
        hooks::install(&write, fence.clone(), observers.clone());
        State {
            db: Mutex::new(write),
            db_read: read.map(Mutex::new),
            data_dir,
            fence,
            events,
            syncing: AtomicBool::new(false),
            client,
            index: RwLock::default(),
            observers,
        }
    }

    /// Tell every observer the card corpus was just replaced — [`WriteObserver::corpus_replaced`].
    ///
    /// The card sync calls it the moment its swap has landed. In list order, like the hooks.
    pub fn corpus_replaced(&self) {
        for observer in &self.observers {
            observer.corpus_replaced();
        }
    }

    /// The connection reads go through: the read-only one where the host has it, and the write
    /// connection where it does not.
    ///
    /// For a caller that has to hand a mutex on — the image cache takes one — or wants a
    /// bounded ask ([`db::lock_for`]). Everything else takes [`State::lock_db_read`].
    ///
    /// ⚠️ **On a host with one connection this is the write connection's own mutex.** A read
    /// asked for while the same thread holds the write connection is then a lock taken twice,
    /// which a host with two never notices. Nothing has run that way yet.
    pub fn reader(&self) -> &Mutex<Connection> {
        self.db_read.as_ref().unwrap_or(&self.db)
    }

    /// Lock the write connection, waiting as long as it takes and recovering from a poisoned
    /// mutex — [`db::lock_blocking`], which has the reason.
    ///
    /// For work that owns its own wait: a sync's bookkeeping, a launch pass. A user-facing
    /// write does not come through here — it asks with a bound and answers [`db::BUSY`].
    pub fn lock_db(&self) -> MutexGuard<'_, Connection> {
        db::lock_blocking(&self.db)
    }

    /// Lock the connection reads go through, recovering from poisoning as [`State::lock_db`]
    /// does.
    ///
    /// Only ever held for a short run of queries and never across an `.await`, so on a host
    /// with a read connection of its own, waiting for it is bounded whatever the writer is
    /// doing.
    pub fn lock_db_read(&self) -> MutexGuard<'_, Connection> {
        db::lock_blocking(self.reader())
    }
}

/// Run `f` with the write connection, or answer [`crate::db::BUSY`].
///
/// Bounded rather than blocking: every caller is a button press on a worker thread, and the
/// one thing that can hold [`State::db`] for any length of time is a sync — which, since the
/// ingest was chunked, holds it for one batch at a time.
///
/// **This is the one definition of that rule**, the way [`crate::db::lock_plain`] is the one
/// definition of poison recovery. It was five identical private copies (`collection`, `deck`,
/// `deck_meta`, `deck_theory`, `wishlist`) plus six sites that inlined the same four lines,
/// each documented as "kept per-module the way every other one in this crate is" — which was
/// true, and was the problem.
///
/// Here rather than in [`crate::db`] because the parameter is [`State`]: `db` is the layer
/// below and must not learn about the app's state. **`&State`, and it was `&AppState` until the
/// extraction's domain step** — the desktop's `AppState` derefs to this struct, so a command
/// there holding an `Arc<AppState>` still passes `&state`, and `index::lifecycle`, which holds a
/// bare reference, needs no clone. A free function rather than a method so that every one of
/// those callers reads as it did; `src-tauri`'s `sync` re-exports it under its old name.
///
/// **It could not move before the modules its body names did**: [`written`] arms and settles
/// [`crate::managed_wishlist`] and runs [`crate::deck_tokens`]' reconcile around the caller's
/// closure, with no line to be cut at.
///
/// **Never call this while holding a guard on `state.db`** — it does not deadlock, because
/// [`crate::db::lock_for`] is a `try_lock`-plus-sleep loop rather than a blocking one, but a
/// same-thread reentrant call spends the whole [`crate::db::WRITE_LOCK_WAIT`] failing to
/// take a lock its own thread already holds, then answers [`crate::db::BUSY`] against itself.
/// `do_sync`'s orphan-sweep arm is the site that has to remember: it passes its already-open
/// connection down instead.
pub fn with_write<T>(
    state: &State,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    written(
        state,
        crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT),
        f,
    )
}

/// [`with_write`] that **waits for the write connection as long as it takes** instead of
/// answering [`crate::db::BUSY`]. ⚠️ **The one sanctioned unbounded wait on [`State::db`], and a
/// departure is the only press that earns it.**
///
/// Every other press is optional: the reader can press again, and a five-second "busy" is kinder
/// than a button that freezes for as long as whatever holds the connection. **Leaving a group is
/// not optional in that sense** — `pairing::sync_group_leave` is the reader's instruction that
/// this device be out of its group, the design promises that press always works (and
/// `SyncPanel`'s `LEAVE_WARNING` names an unreachable relay as its only cost), and a sync trip
/// (`sync_now`, `sync_engine::live`'s `trip`) holds this connection across its whole network round
/// trip — so under [`with_write`] a Leave pressed during a slow trip failed with "the database is
/// busy" (issue #546, item 7), which is a promise with a condition nobody wrote down.
///
/// **What makes the wait safe to have is that a trip always ends**: every relay request carries a
/// 10 s connect and 30 s read timeout (`sync_engine::client`'s client, and `entitlement`'s at
/// 10 s/10 s), so the holder gives the connection back in bounded time even with the network gone.
/// **What makes it safe to *call*** is [`with_write`]'s reentrancy rule, which is sharper here:
/// that one spends five seconds and answers BUSY against its own thread, where a same-thread call
/// to this one **deadlocks** (std's `Mutex` may also panic on it). Nothing may call it holding a
/// guard on `state.db`.
///
/// **Everything else is [`with_write`]'s, because it is [`with_write`]'s body** — the managed
/// wishlists armed and settled, the token reconcile, and the cross-file fence — and the lock is
/// [`crate::db::lock_blocking`], which recovers a poisoned mutex exactly as
/// [`crate::db::lock_for`] does.
///
/// ⚠️ **`pairing::sync_device_revoke` deliberately stays on [`with_write`].** A removal must
/// reach the relay to mean anything and is refused without it, and its first step is a round trip
/// of its own — so waiting out one trip to start another buys a reader nothing a second press
/// would not, and freezes the button for the length of both.
pub fn with_write_waiting<T>(
    state: &State,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    written(state, Some(crate::db::lock_blocking(&state.db)), f)
}

/// [`with_write`] and [`with_write_waiting`]'s shared body: `guard` is the write connection, or
/// `None` when the bounded wait gave up. **One body so the two cannot drift** — a waiting write
/// that skipped the managed-wishlist settle or the fence would be a second definition of "a
/// user-facing write", which is the thing [`with_write`] exists to have exactly one of.
fn written<T>(
    state: &State,
    guard: Option<MutexGuard<'_, Connection>>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let out = match guard {
        Some(conn) => {
            // **The managed wishlists ride every write, before and after** (issue #512). Armed
            // first so the write's own changes to a deck are marked, and settled after — outside
            // the write's transaction, which has committed or rolled back by then — so a folder
            // is rewritten once per press rather than once per row. Neither can fail the write:
            // an arm that did not take is a folder that catches up at the next launch.
            if let Err(e) = crate::managed_wishlist::arm(&conn) {
                eprintln!("the managed wishlists could not be armed on this connection: {e}");
            }
            let out = f(&conn);
            // **The token reconcile's backstop rides the same marks** (spec §4.2 rule 7): a
            // token no card in a list makes any more loses its entries, for the writes that
            // file no undo step and so could not do it inside their own transaction — the
            // Collection tab's filing and cut, a sync pull, undo and redo. Scryfall's
            // `reconcile::apply` takes this connection through `lock_db`, not through here, so
            // the marks it leaves are reconciled at the NEXT write that comes through here.
            // **Before the settle and not after it**, because the settle empties the dirty table
            // this reads — and because the reconcile's deletions are token entries, which a
            // managed wishlist's Tokens subfolder counts and whose triggers mark the settle's own
            // token table, so settling second files the reconciled count in the same write.
            // Logged, never failing the write, for the settle's reason.
            crate::deck_tokens::reconcile_dirty_logged(&conn);
            crate::managed_wishlist::settle_logged(&conn);
            out
        }
        None => Err(crate::db::BUSY.to_owned()),
    };
    // **Every user-facing write in the crate passes through here**, so a debug build runs the
    // whole suite with the fence armed and this is where a path that crossed the files stops
    // being a line in a log. Release keeps the `eprintln!` in the commit hook and nothing
    // else: the write has already happened by then, and a panic on a reader's machine would
    // be a worse answer than a sentence.
    debug_assert!(
        !state.fence.tripped(),
        "a transaction wrote to both user.db and corpus.db; SQLite does not guarantee those \
         commit together in WAL mode"
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn over_memory(observers: Vec<Arc<dyn WriteObserver>>) -> State {
        State::new(
            crate::schema::memory_pair(),
            None,
            PathBuf::from("nowhere"),
            crate::events::silent(),
            observers,
            scryfall::Client::new("http://127.0.0.1:1".into()),
        )
    }

    /// The fence a host reads off its state is the one riding that state's write connection —
    /// not a second one nobody installed. A debug build's user-facing write asserts on it.
    #[test]
    fn a_states_own_write_connection_trips_its_own_fence() {
        let state = over_memory(Vec::new());
        {
            let conn = state.lock_db();
            conn.execute_batch(
                "BEGIN;
                 INSERT INTO decks (name, format_key, created_at, updated_at)
                   VALUES ('one file', 'casual', 0, 0);
                 COMMIT;",
            )
            .unwrap();
        }
        assert!(!state.fence.tripped(), "a user-only transaction is fine");
        {
            let conn = state.lock_db();
            conn.execute_batch(
                "BEGIN;
                 INSERT INTO decks (name, format_key, created_at, updated_at)
                   VALUES ('two files', 'casual', 0, 0);
                 INSERT OR REPLACE INTO sets (code, name) VALUES ('zzz', 'probe');
                 COMMIT;",
            )
            .unwrap();
        }
        assert!(state.fence.tripped());
    }

    #[derive(Default)]
    struct Counter {
        rows: AtomicUsize,
        commits: AtomicUsize,
        swaps: AtomicUsize,
    }

    impl WriteObserver for Counter {
        fn row(&self, _db: &str, _table: &str) {
            self.rows.fetch_add(1, Ordering::Relaxed);
        }

        fn committed(&self) {
            self.commits.fetch_add(1, Ordering::Relaxed);
        }

        fn corpus_replaced(&self) {
            self.swaps.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// The one thing an observer hears that no hook carries: a sync that swapped `cards` says
    /// so once, to every observer the host gave the state — and to nobody when no row moved.
    #[test]
    fn a_replaced_corpus_is_told_to_every_observer_once_and_is_not_a_write() {
        let first = Arc::new(Counter::default());
        let second = Arc::new(Counter::default());
        let state = over_memory(vec![first.clone(), second.clone()]);

        state.corpus_replaced();

        for counter in [&first, &second] {
            assert_eq!(counter.swaps.load(Ordering::Relaxed), 1);
            assert_eq!(counter.rows.load(Ordering::Relaxed), 0);
            assert_eq!(counter.commits.load(Ordering::Relaxed), 0);
        }
        // And a state with nobody listening has nobody to tell.
        over_memory(Vec::new()).corpus_replaced();
    }

    #[test]
    fn an_observer_given_at_construction_hears_a_write_made_through_the_state() {
        let counter = Arc::new(Counter::default());
        let state = over_memory(vec![counter.clone()]);

        state
            .lock_db()
            .execute(
                "INSERT INTO decks (name, format_key, created_at, updated_at)
                 VALUES ('heard', 'casual', 0, 0)",
                [],
            )
            .unwrap();

        assert_eq!(counter.rows.load(Ordering::Relaxed), 1);
        assert_eq!(counter.commits.load(Ordering::Relaxed), 1);
    }

    /// The browser's shape: one connection, so a read goes through the one that writes.
    #[test]
    fn a_host_with_one_connection_reads_through_the_one_it_writes_with() {
        let state = over_memory(Vec::new());
        assert!(std::ptr::eq(state.reader(), &state.db));

        state
            .lock_db()
            .execute(
                "INSERT INTO decks (name, format_key, created_at, updated_at)
                 VALUES ('written', 'casual', 0, 0)",
                [],
            )
            .unwrap();
        let name: String = state
            .lock_db_read()
            .query_row("SELECT name FROM decks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "written");
    }

    /// The desktop's shape, on real files — two in-memory connections are two databases. The
    /// reads go through the second connection, which sees what the first committed and cannot
    /// write.
    ///
    /// **And the hooks are on the first.** With two connections in hand there is a wrong one to
    /// install them on, and a state hooked on its read connection would look healthy for ever:
    /// the fence never trips, no observer hears a write, and nothing errors. So the observer and
    /// the fence are asserted here as well as on the one-connection shape.
    #[test]
    fn a_host_with_two_reads_through_the_second_which_cannot_write() {
        let dir = crate::scratch::path("state-two-connections");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let write = db::open_write(&dir).unwrap();
        write
            .execute_batch(&format!(
                "CREATE TABLE main.notes (body TEXT NOT NULL);
                 CREATE TABLE {}.prices (amount INTEGER NOT NULL);",
                db::CORPUS
            ))
            .unwrap();
        let read = db::open_read(&dir).unwrap();
        let counter = Arc::new(Counter::default());
        let state = State::new(
            write,
            Some(read),
            dir,
            crate::events::silent(),
            vec![counter.clone()],
            scryfall::Client::new("http://127.0.0.1:1".into()),
        );
        assert!(!std::ptr::eq(state.reader(), &state.db));

        state
            .lock_db()
            .execute("INSERT INTO notes (body) VALUES ('committed')", [])
            .unwrap();
        assert_eq!(counter.rows.load(Ordering::Relaxed), 1);
        assert_eq!(counter.commits.load(Ordering::Relaxed), 1);
        assert!(!state.fence.tripped(), "one file, so far");
        state
            .lock_db()
            .execute_batch(
                "BEGIN;
                 INSERT INTO notes (body) VALUES ('and a second file');
                 INSERT INTO prices (amount) VALUES (1);
                 COMMIT;
                 DELETE FROM notes WHERE body = 'and a second file';",
            )
            .unwrap();
        assert!(
            state.fence.tripped(),
            "the fence rides the connection that writes"
        );

        let reader = state.lock_db_read();
        let body: String = reader
            .query_row("SELECT body FROM notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(body, "committed");
        assert!(
            reader
                .execute("INSERT INTO notes (body) VALUES ('refused')", [])
                .is_err(),
            "the read connection is opened read-only"
        );
    }
}
