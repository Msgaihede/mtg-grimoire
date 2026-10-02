//! What every host holds for as long as it runs: the connections, where the data lives, the
//! cross-file fence and the way out for an event.
//!
//! [`State`] is the half of the desktop's `AppState` that has no reason to know about a
//! window. A host builds one from the connections it opened, and from then on everything in
//! this crate that needs the database is handed a `&State` or a `&Connection` taken from it.
//!
//! **It is the every-host half as far as the extraction has got.** The Scryfall client, the
//! image cache, the facet index, the sync-in-flight flag and the pending pairing offer are every
//! host's too, and are still fields of the desktop's `AppState` — each is a type that has not
//! moved here yet, and arrives with the step that moves it. `with_write`, the one definition of
//! a user-facing write, is still the desktop's for the same reason: its body calls the managed
//! wishlist and the token reconcile.
//!
//! **A host opens the connections; this does not.** Bringing the pair to head is
//! [`crate::schema::bring_to_head`], and until the modules behind the launch's logged passes
//! move, what follows it is the host's. So [`State::new`] takes connections that are already
//! at head.

use crate::db::{self, CrossFileFence};
use crate::events::EventSink;
use crate::hooks::{self, WriteObserver};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

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
    pub fn new(
        write: Connection,
        read: Option<Connection>,
        data_dir: PathBuf,
        events: Arc<dyn EventSink>,
        observers: Vec<Arc<dyn WriteObserver>>,
    ) -> State {
        let fence = Arc::new(CrossFileFence::new());
        hooks::install(&write, fence.clone(), observers);
        State {
            db: Mutex::new(write),
            db_read: read.map(Mutex::new),
            data_dir,
            fence,
            events,
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
    }

    impl WriteObserver for Counter {
        fn row(&self, _db: &str, _table: &str) {
            self.rows.fetch_add(1, Ordering::Relaxed);
        }

        fn committed(&self) {
            self.commits.fetch_add(1, Ordering::Relaxed);
        }
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
    #[test]
    fn a_host_with_two_reads_through_the_second_which_cannot_write() {
        let dir = crate::scratch::path("state-two-connections");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let write = db::open_write(&dir).unwrap();
        write
            .execute_batch("CREATE TABLE main.notes (body TEXT NOT NULL)")
            .unwrap();
        let read = db::open_read(&dir).unwrap();
        let state = State::new(write, Some(read), dir, crate::events::silent(), Vec::new());
        assert!(!std::ptr::eq(state.reader(), &state.db));

        state
            .lock_db()
            .execute("INSERT INTO notes (body) VALUES ('committed')", [])
            .unwrap();
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
