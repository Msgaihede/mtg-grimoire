use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

/// Ceiling on the write-ahead log *file* after a checkpoint, in bytes.
///
/// A 116 k-row ingest writes a WAL the size of the database it replaced (measured: 857 MB
/// against an 880 MB `mtg.db`). SQLite recycles that space internally but never shrinks
/// the file on its own, so without this a portable app leaves nearly a gigabyte of dead
/// journal beside its exe — on a USB stick, that is the difference between fitting and
/// not. 64 MB is far more than the app's steady-state write volume needs.
const JOURNAL_SIZE_LIMIT: i64 = 64 * 1024 * 1024;

/// How long a connection waits for a lock before giving up.
///
/// Under WAL a reader never blocks behind the writer, so this covers only the moments
/// SQLite genuinely serialises — a checkpoint, a schema change (which the staging swap
/// is). Without it those surface as an instant `SQLITE_BUSY` in the middle of a search.
const BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);

/// Open (or create) the SQLite database at `path` with the app's standard PRAGMAs:
/// WAL journalling, `synchronous = NORMAL`, foreign-key enforcement, a bounded WAL file
/// and a busy timeout.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_size_limit", JOURNAL_SIZE_LIMIT)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(conn)
}

/// A second, **read-only** connection to the same database file.
///
/// Reads and writes share one `Mutex<Connection>` otherwise, which makes every search
/// queue behind whatever the writer is doing — and the writer's longest job is a 44 s
/// ingest. Under WAL a reader does not block behind a writer at the SQLite level at all;
/// the only thing that was serialising them was the mutex. A separate connection with its
/// own lock removes it, so search keeps answering during a sync.
///
/// `SQLITE_OPEN_READ_ONLY` is not decoration: it is what guarantees this handle can never
/// be the one that starts a write transaction and stalls the real writer.
pub fn open_read_only(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // Not journal_mode/synchronous: those are properties of the file, set by `open`, and
    // a read-only connection may not change them anyway.
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(conn)
}

/// How long [`lock_for`] sleeps between attempts. Short enough that the wait is invisible,
/// long enough that a contended lock is not a spin.
const LOCK_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Take `mutex`, giving up after `timeout` rather than queueing behind whatever holds it.
///
/// The write connection is held for the whole of a 44 s ingest. Callers who cannot pay
/// that — the exit checkpoint, the image cache's bookkeeping — ask for a bound instead,
/// because for both of them "could not" is a real answer: skip the checkpoint (the WAL is
/// a valid journal either way), skip the row (one re-fetch from an unlimited origin).
///
/// A `timeout` of [`Duration::ZERO`] is exactly one `try_lock` with no sleeping at all,
/// which is what a caller on an async worker thread wants: contention on the *write*
/// connection means an ingest that will hold it for the next 44 s, so polling for it would
/// park a pool thread on a lock it was never going to win. The exit checkpoint, which runs
/// on its own thread with the process already ending, is the caller that can afford to
/// wait a little.
///
/// Poisoning is recovered exactly as `sync::lock_db` does: the panicking thread's
/// `Connection` survives, and refusing the lock forever would brick the app for no gain.
pub fn lock_for(
    mutex: &Mutex<Connection>,
    timeout: Duration,
) -> Option<MutexGuard<'_, Connection>> {
    let deadline = Instant::now() + timeout;
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Some(guard),
            Err(TryLockError::Poisoned(e)) => return Some(e.into_inner()),
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(LOCK_POLL_INTERVAL);
            }
        }
    }
}

/// Fold the write-ahead log back into the database and truncate the `-wal` file to zero.
///
/// Best-effort by contract: the caller runs this on the way out, and there is nothing
/// useful to do about a failure at that point — the WAL is a valid, recoverable journal
/// either way, and the next launch replays it. See the exit handler in `lib.rs`.
pub fn checkpoint_truncate(conn: &Connection) -> rusqlite::Result<()> {
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts5_with_diacritics_is_available() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE t USING fts5(name, tokenize='unicode61 remove_diacritics 2');
             INSERT INTO t(name) VALUES ('Théoden of Rohan');",
        )
        .unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM t WHERE t MATCH 'theoden'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 1);
    }

    /// Guards the spike's finding: the `remove_diacritics 2` argument is genuinely
    /// honored (not silently ignored), and it folds *decomposed* diacritics
    /// (base char + combining mark) too — Scryfall names arrive in both forms.
    #[test]
    fn remove_diacritics_2_is_honored_and_folds_decomposed_forms() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE off USING fts5(name, tokenize='unicode61 remove_diacritics 0');
             INSERT INTO off(name) VALUES ('Théoden of Rohan');
             CREATE VIRTUAL TABLE on2 USING fts5(name, tokenize='unicode61 remove_diacritics 2');
             INSERT INTO on2(name) VALUES ('Se\u{301}ance');",
        )
        .unwrap();

        let without: i64 = conn
            .query_row(
                "SELECT count(*) FROM off WHERE off MATCH 'theoden'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(without, 0, "tokenizer argument must not be ignored");

        let decomposed: i64 = conn
            .query_row(
                "SELECT count(*) FROM on2 WHERE on2 MATCH 'seance'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(decomposed, 1, "combining marks must be folded away");
    }

    /// Two callers need the write lock *without* being willing to wait out a 44 s
    /// ingest: the exit checkpoint (which would park a window-less process the user
    /// believes has quit) and the image cache's bookkeeping (which would hold a picture
    /// hostage to a sync). Both have a correct answer for "could not".
    #[test]
    fn lock_for_gives_up_instead_of_waiting_out_an_ingest() {
        let mutex = std::sync::Mutex::new(Connection::open_in_memory().unwrap());

        let taken = lock_for(&mutex, Duration::from_millis(50));
        assert!(taken.is_some(), "an uncontended lock is taken immediately");

        let started = std::time::Instant::now();
        let blocked = lock_for(&mutex, Duration::from_millis(50));
        assert!(blocked.is_none(), "a held lock must not be waited out");
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "giving up took {:?}",
            started.elapsed()
        );

        drop(taken);
        let taken = lock_for(&mutex, Duration::from_millis(50));
        assert!(taken.is_some());

        // Zero is a plain `try_lock`, and not sleeping is the whole point of it: the image
        // cache asks from an async worker thread, where even one 20 ms poll is a pool
        // thread parked on a lock that an ingest is going to hold for another 44 seconds.
        let started = std::time::Instant::now();
        assert!(lock_for(&mutex, Duration::ZERO).is_none());
        assert!(
            started.elapsed() < LOCK_POLL_INTERVAL,
            "a zero timeout must not sleep, and took {:?}",
            started.elapsed()
        );
    }

    /// A scratch directory of its own per test — these all touch real files, and the
    /// suite runs them in parallel.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mtgtest-db-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn open_sets_wal() {
        let dir = scratch("wal");

        let conn = open(&dir.join("t.db")).unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        let synchronous: i64 = conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        let foreign_keys: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        let journal_limit: i64 = conn
            .query_row("PRAGMA journal_size_limit", [], |r| r.get(0))
            .unwrap();
        let busy: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(mode.to_lowercase(), "wal");
        assert_eq!(synchronous, 1, "synchronous should be NORMAL (1)");
        assert_eq!(foreign_keys, 1, "foreign_keys should be ON");
        assert_eq!(journal_limit, JOURNAL_SIZE_LIMIT);
        assert_eq!(busy, BUSY_TIMEOUT.as_millis() as i64);
    }

    /// The read-only handle exists so a search never waits on the writer. It has to be
    /// genuinely read-only: a handle that *could* write is a handle that can take the
    /// write lock and stall the ingest it was supposed to run alongside.
    #[test]
    fn a_read_only_connection_reads_and_refuses_to_write() {
        let dir = scratch("readonly");
        let path = dir.join("t.db");
        let w = open(&path).unwrap();
        w.execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('bolt');")
            .unwrap();

        let r = open_read_only(&path).unwrap();
        let v: String = r
            .query_row("SELECT v FROM t", [], |row| row.get(0))
            .unwrap();
        let write = r.execute("INSERT INTO t VALUES ('nope')", []);
        let busy: i64 = r
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();

        drop(r);
        drop(w);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(v, "bolt");
        assert!(
            write.is_err(),
            "the read connection must not be able to write"
        );
        assert_eq!(busy, BUSY_TIMEOUT.as_millis() as i64);
    }

    /// What the exit handler buys: without a truncating checkpoint the `-wal` file
    /// outlives the process at the size of the last ingest (measured at 857 MB), because
    /// the app never closes its connection.
    #[test]
    fn a_truncating_checkpoint_empties_the_wal_file() {
        let dir = scratch("checkpoint");
        let path = dir.join("t.db");
        let conn = open(&path).unwrap();
        conn.execute_batch("CREATE TABLE t (v TEXT);").unwrap();
        for i in 0..2000 {
            conn.execute("INSERT INTO t VALUES (?1)", [format!("row {i}")])
                .unwrap();
        }
        let wal = path.with_extension("db-wal");
        let before = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);

        checkpoint_truncate(&conn).unwrap();

        let after = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            before > 0,
            "the writes should have produced a WAL to truncate"
        );
        assert_eq!(
            after, 0,
            "the -wal file must be emptied, not just checkpointed"
        );
    }
}
