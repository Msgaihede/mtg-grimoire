//! The one update hook on the write connection, and who it tells.
//!
//! **SQLite allows one update hook, one commit hook and one rollback hook per connection**, and
//! installing a second replaces the first without a word. So everything that needs to hear
//! about a write has to ride one installer, and this is it: [`install`] puts the three hooks
//! on a connection, carries the one thing this crate itself reads — the cross-file fence — and
//! tells every [`WriteObserver`] it was given.
//!
//! **A host registers observers; it never installs a hook of its own.** The desktop has three:
//! the plain-text mirror's mask, the other windows' change mask and live sync's wake. A host
//! with one window and no mirror registers none and still gets the fence.
//!
//! **The callbacks run inside SQLite**, on the writer's thread, with the write connection's
//! mutex held. What an observer may do there is what the fence does: an atomic `fetch_or`, a
//! lookup in a list built beforehand, a notify that cannot block. No allocation that matters,
//! no lock that another thread can hold for long, and **nothing that calls back into the
//! database** — SQLite forbids that from a hook outright.
//!
//! **A row is an over-approximation and a commit is not.** The update hook fires per row and
//! before the transaction ends, so a rolled-back write is still heard as rows; the commit hook
//! fires once, only for a transaction that committed. An observer that wants "something was
//! written and it is durable" listens for the commit.
//!
//! # What the update hook cannot see
//!
//! * **A `WITHOUT ROWID` table.** The hook does not fire for one at all — [`WriteObserver::row`]
//!   never hears it, and neither does the fence ([`crate::db::CrossFileFence`] lists them). The
//!   commit is still heard, which is why a wake that must not miss a write rides
//!   [`WriteObserver::committed`].
//! * **A bare `DELETE FROM t`** with no `WHERE`, on a table with no triggers and no foreign key
//!   naming it. SQLite's truncate optimisation empties the table without visiting a row.
//!
//! Both are properties of SQLite rather than of this installer, and both are pinned below.

use crate::db::CrossFileFence;
use rusqlite::Connection;
use std::sync::Arc;

/// Something that hears about writes on the write connection.
///
/// Both methods default to nothing, so an observer implements the half it listens for.
///
/// **`Send + Sync`, and called from inside SQLite's own callback** — see the module doc for
/// what that allows. An implementation that takes a lock another thread can hold is a write
/// that can stall behind it.
pub trait WriteObserver: Send + Sync {
    /// From the update hook: one row of `table` was inserted, updated or deleted. `db` is
    /// SQLite's schema name for the write — `main` for the user file, [`crate::db::CORPUS`]
    /// for the card database, `temp` for the connection's own scratch tables.
    ///
    /// A table name is unique across the two files (`crate::schema::TABLES`, and the test that
    /// keeps every table on exactly one side), so an observer that only wants the table may
    /// ignore `db`.
    fn row(&self, _db: &str, _table: &str) {}

    /// From the commit hook: a transaction on this connection committed. Not called for a
    /// rollback.
    fn committed(&self) {}
}

/// Put the three hooks on `conn`: the fence, and every observer in the order given.
///
/// **Install this on the write connection and nowhere else.** A read-only connection can never
/// fire it, and a second call on the same connection **replaces** the first — the observers of
/// the earlier call hear nothing from then on. [`crate::state::State::new`] is the one caller a
/// host needs; a test that wants a hooked bare connection calls this directly.
///
/// **Observers are told in the order of `observers`**, on both hooks. Where one observer's
/// answer depends on another having been told first, the order of that list is the contract.
///
/// **A hook that will not install costs a diagnostic, never a launch.** Each call fails only for
/// a connection this crate never makes — one already lent out, or borrowed from a shared handle
/// — so there is nothing to recover, and refusing to start over it would be the wrong trade.
///
/// **The commit hook never answers `true`.** That would abort the commit, which would turn a
/// diagnostic into data loss over a bug in the fence or in an observer.
pub fn install(
    conn: &Connection,
    fence: Arc<CrossFileFence>,
    observers: Vec<Arc<dyn WriteObserver>>,
) {
    let observers: Arc<[Arc<dyn WriteObserver>]> = observers.into();

    let marker = fence.clone();
    let hearing = observers.clone();
    if let Err(e) = conn.update_hook(Some(
        move |_action: rusqlite::hooks::Action, db: &str, table: &str, _rowid: i64| {
            marker.note(db);
            for observer in hearing.iter() {
                observer.row(db, table);
            }
        },
    )) {
        eprintln!("nothing will hear of a row written on this connection: {e}");
    }

    let settling = fence.clone();
    let _ = conn.commit_hook(Some(move || {
        if settling.settle() {
            // Said out loud rather than asserted: this is a diagnostic on a user's machine and
            // the write has already happened. The host's user-facing write is where a debug
            // build turns it into a failing test.
            eprintln!(
                "a transaction wrote to both the user database and the card database; \
                 SQLite does not guarantee those commit together"
            );
        }
        for observer in observers.iter() {
            observer.committed();
        }
        false
    }));

    // A transaction that did not commit did not cross anything — and without this, the bits it
    // left would be charged to the next ordinary commit.
    let _ = conn.rollback_hook(Some(move || fence.clear()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// Writes down everything it hears, under a name, into a log several observers can share.
    struct Recorder {
        name: &'static str,
        log: Arc<Mutex<Vec<String>>>,
    }

    impl WriteObserver for Recorder {
        fn row(&self, db: &str, table: &str) {
            self.log
                .lock()
                .unwrap()
                .push(format!("{} row {db}.{table}", self.name));
        }

        fn committed(&self) {
            self.log
                .lock()
                .unwrap()
                .push(format!("{} committed", self.name));
        }
    }

    fn recorder(name: &'static str, log: &Arc<Mutex<Vec<String>>>) -> Arc<dyn WriteObserver> {
        Arc::new(Recorder {
            name,
            log: log.clone(),
        })
    }

    fn heard(log: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
        std::mem::take(&mut *log.lock().unwrap())
    }

    const A_DECK: &str = "INSERT INTO decks (name, format_key, created_at, updated_at)
                          VALUES ('one file', 'casual', 0, 0)";
    const A_SET: &str = "INSERT OR REPLACE INTO sets (code, name) VALUES ('zzz', 'probe')";

    /// A transaction that writes both files commits non-atomically in WAL mode, and SQLite will
    /// not say so. The fence riding this installer is what says so.
    #[test]
    fn the_fence_trips_on_a_transaction_that_writes_both_files() {
        let conn = crate::schema::memory_pair();
        let fence = Arc::new(CrossFileFence::new());
        install(&conn, fence.clone(), Vec::new());

        conn.execute_batch(&format!("BEGIN; {A_DECK}; COMMIT;"))
            .unwrap();
        assert!(!fence.tripped(), "a user-only transaction is fine");
        conn.execute_batch(&format!("BEGIN; {A_SET}; COMMIT;"))
            .unwrap();
        assert!(!fence.tripped(), "and so is a corpus-only one");

        conn.execute_batch(&format!("BEGIN; {A_DECK}; {A_SET}; COMMIT;"))
            .unwrap();
        assert!(fence.tripped(), "a cross-file transaction must be caught");
    }

    /// The rollback hook's whole job. `settle` runs from the commit hook, which a `ROLLBACK`
    /// never reaches, so the abandoned transaction cannot trip the fence either way — what the
    /// clear buys is the *next* commit, which would otherwise inherit the abandoned bits.
    #[test]
    fn a_rolled_back_transaction_is_not_charged_to_the_next_commit() {
        let conn = crate::schema::memory_pair();
        let fence = Arc::new(CrossFileFence::new());
        install(&conn, fence.clone(), Vec::new());

        conn.execute_batch(&format!("BEGIN; {A_DECK}; {A_SET}; ROLLBACK;"))
            .unwrap();
        assert!(!fence.tripped(), "a rollback is not a commit");

        conn.execute(A_DECK, []).unwrap();
        assert!(
            !fence.tripped(),
            "the abandoned transaction's bits must not be charged to the next write"
        );
    }

    #[test]
    fn an_observer_hears_each_row_with_its_schema_and_table() {
        let conn = crate::schema::memory_pair();
        let log = Arc::new(Mutex::new(Vec::new()));
        install(
            &conn,
            Arc::new(CrossFileFence::new()),
            vec![recorder("a", &log)],
        );

        conn.execute(A_DECK, []).unwrap();
        conn.execute(A_SET, []).unwrap();

        assert_eq!(
            heard(&log),
            [
                "a row main.decks",
                "a committed",
                "a row corpus.sets",
                "a committed",
            ]
        );
    }

    /// A commit is a fact about what is durable; a rollback is not one. The rows of the
    /// abandoned transaction are still heard — the update hook fires before the transaction
    /// ends — which is the over-approximation the module doc names.
    #[test]
    fn an_observer_hears_a_commit_and_never_a_rollback() {
        let conn = crate::schema::memory_pair();
        let log = Arc::new(Mutex::new(Vec::new()));
        install(
            &conn,
            Arc::new(CrossFileFence::new()),
            vec![recorder("a", &log)],
        );

        conn.execute_batch(&format!("BEGIN; {A_DECK}; ROLLBACK;"))
            .unwrap();
        assert_eq!(heard(&log), ["a row main.decks"]);

        conn.execute_batch(&format!("BEGIN; {A_DECK}; {A_DECK}; COMMIT;"))
            .unwrap();
        assert_eq!(
            heard(&log),
            ["a row main.decks", "a row main.decks", "a committed"],
            "one commit for the transaction, however many rows it wrote"
        );
    }

    /// The order of the list is the order of the calls, on both hooks. The desktop leans on it:
    /// its sync wake is told of a commit before its change mask rings.
    #[test]
    fn observers_are_told_in_the_order_they_were_given() {
        let conn = crate::schema::memory_pair();
        let log = Arc::new(Mutex::new(Vec::new()));
        install(
            &conn,
            Arc::new(CrossFileFence::new()),
            vec![
                recorder("first", &log),
                recorder("second", &log),
                recorder("third", &log),
            ],
        );

        conn.execute(A_DECK, []).unwrap();

        assert_eq!(
            heard(&log),
            [
                "first row main.decks",
                "second row main.decks",
                "third row main.decks",
                "first committed",
                "second committed",
                "third committed",
            ]
        );
    }

    /// Asks the fence what it knows at the moment it hears a commit.
    struct AsksTheFence {
        fence: Arc<CrossFileFence>,
        saw_it_tripped: std::sync::atomic::AtomicBool,
    }

    impl WriteObserver for AsksTheFence {
        fn committed(&self) {
            self.saw_it_tripped
                .store(self.fence.tripped(), Ordering::Relaxed);
        }
    }

    /// **The fence is ahead of every observer on the commit hook**, so an observer that asks it
    /// about the commit it has just heard gets that commit's answer rather than the one before.
    /// None of the desktop's three asks today; the order is the installer's promise all the same.
    #[test]
    fn the_fence_has_settled_by_the_time_an_observer_hears_the_commit() {
        let conn = crate::schema::memory_pair();
        let fence = Arc::new(CrossFileFence::new());
        let asking = Arc::new(AsksTheFence {
            fence: fence.clone(),
            saw_it_tripped: std::sync::atomic::AtomicBool::new(false),
        });
        install(&conn, fence, vec![asking.clone()]);

        conn.execute_batch(&format!("BEGIN; {A_DECK}; {A_SET}; COMMIT;"))
            .unwrap();

        assert!(asking.saw_it_tripped.load(Ordering::Relaxed));
    }

    /// **The update hook's first blind spot, pinned where the hook is installed.** A write to a
    /// `WITHOUT ROWID` table is a commit nobody heard a row of — which is why an observer that
    /// must not miss a write listens for the commit, and why a host marks such a table by hand.
    /// If SQLite ever starts reporting these, this goes red and the hand marks become redundant
    /// rather than wrong.
    #[test]
    fn a_without_rowid_write_reaches_the_commit_and_never_the_row() {
        let conn = crate::schema::memory_pair();
        conn.execute_batch("CREATE TABLE main.keyed (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID")
            .unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        install(
            &conn,
            Arc::new(CrossFileFence::new()),
            vec![recorder("a", &log)],
        );

        conn.execute("INSERT INTO keyed (k, v) VALUES ('a', 'b')", [])
            .unwrap();

        assert_eq!(heard(&log), ["a committed"]);
        let stored: i64 = conn
            .query_row("SELECT count(*) FROM keyed", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, 1, "the row is there; the hook did not see it go in");
    }

    /// **The second blind spot**: a bare `DELETE` on a table with no triggers and nothing
    /// pointing at it takes the truncate optimisation, and no row is heard.
    #[test]
    fn a_bare_delete_on_a_table_nothing_points_at_is_heard_as_a_commit_only() {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            "CREATE TABLE main.plain (id INTEGER PRIMARY KEY, v TEXT);
             INSERT INTO plain (v) VALUES ('a'), ('b'), ('c');",
        )
        .unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        install(
            &conn,
            Arc::new(CrossFileFence::new()),
            vec![recorder("a", &log)],
        );

        assert_eq!(conn.execute("DELETE FROM plain", []).unwrap(), 3);

        assert_eq!(heard(&log), ["a committed"]);
    }

    /// The rule the whole module follows from, shown rather than cited: SQLite keeps one hook of
    /// each kind per connection, so a second installer takes the first one's observers off.
    #[test]
    fn a_second_install_replaces_the_first() {
        let conn = crate::schema::memory_pair();
        let log = Arc::new(Mutex::new(Vec::new()));
        let first_fence = Arc::new(CrossFileFence::new());
        install(&conn, first_fence.clone(), vec![recorder("first", &log)]);
        install(
            &conn,
            Arc::new(CrossFileFence::new()),
            vec![recorder("second", &log)],
        );

        conn.execute_batch(&format!("BEGIN; {A_DECK}; {A_SET}; COMMIT;"))
            .unwrap();

        assert_eq!(
            heard(&log),
            [
                "second row main.decks",
                "second row corpus.sets",
                "second committed",
            ]
        );
        assert!(
            !first_fence.tripped(),
            "the first installer's fence rode a hook that is no longer there"
        );
    }

    /// An observer that does nothing, for the measurement below.
    struct Counting(AtomicUsize);

    impl WriteObserver for Counting {
        fn row(&self, _db: &str, _table: &str) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// **What the observer list costs per row** — the one thing this installer added to a hook
    /// that used to call its three riders directly. An ingest writes about 117 000 rows through
    /// the hooked connection, so a cost per row is a cost per sync.
    ///
    /// `cargo test -p grimoire-core --release -- --ignored --nocapture what_three_observers`
    /// prints the figures; `docs/reference/light-app.md` §6.3 has the ones taken when this
    /// landed. One `UPDATE` over every row, so the statement's own cost is paid once and what is
    /// left is SQLite's per-row work plus the hook; the best of several rounds, because the
    /// machine this runs on is rarely idle.
    #[test]
    #[ignore = "a measurement, not a test: run it with --release --ignored --nocapture"]
    fn what_three_observers_cost_per_row() {
        const ROWS: usize = 100_000;
        const ROUNDS: usize = 9;

        fn best_ns_per_row(observers: Vec<Arc<dyn WriteObserver>>) -> f64 {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE probe (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
                 WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < {ROWS})
                 INSERT INTO probe (id, n) SELECT i, 0 FROM seq;"
            ))
            .unwrap();
            install(&conn, Arc::new(CrossFileFence::new()), observers);
            (0..ROUNDS)
                .map(|_| {
                    let tick = crate::platform::clock::Tick::now();
                    let changed = conn.execute("UPDATE probe SET n = n + 1", []).unwrap();
                    let spent = tick.elapsed();
                    assert_eq!(changed, ROWS);
                    spent.as_nanos() as f64 / ROWS as f64
                })
                .fold(f64::INFINITY, f64::min)
        }

        let counters: Vec<Arc<Counting>> = (0..3)
            .map(|_| Arc::new(Counting(AtomicUsize::new(0))))
            .collect();
        let none = best_ns_per_row(Vec::new());
        let three = best_ns_per_row(
            counters
                .iter()
                .map(|c| c.clone() as Arc<dyn WriteObserver>)
                .collect(),
        );
        for counter in &counters {
            assert_eq!(counter.0.load(Ordering::Relaxed), ROWS * ROUNDS);
        }
        println!(
            "per row: {none:.1} ns with no observer, {three:.1} ns with three ({:+.1} ns)",
            three - none
        );
    }
}
