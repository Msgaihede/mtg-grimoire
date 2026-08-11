use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard, TryLockError};
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
/// incremental auto-vacuum, WAL journalling, `synchronous = NORMAL`, foreign-key
/// enforcement, a bounded WAL file and a busy timeout.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    // FIRST, before any statement writes a page. On a database that does not exist yet
    // this is free and permanent; once `journal_mode=WAL` has materialised the file it is
    // a no-op that only a full `VACUUM` can apply (measured live while planning: WAL
    // first leaves a brand-new database on `auto_vacuum = 0` through every reopen).
    // Incremental rather than full: the return of freed pages is then something the app
    // asks for after a swap, not something SQLite pays for on every commit.
    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
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
/// queue behind whatever the writer is doing — and the writer's longest job is the ingest,
/// ~80 s of a 92–99 s sync, taken in 2 000-row batches.
/// Under WAL a reader does not block behind a writer at the SQLite level at all;
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

/// How long a user-facing write waits for the write connection before answering "busy".
///
/// With the chunked ingest the longest anyone can be behind is one batch of 2 000 rows —
/// well under a second at the measured 2 600 rows/s. Five seconds is therefore not a
/// budget for a sync, it is the point at which something has genuinely gone wrong and the
/// honest answer is to say so rather than to hold a button down.
pub const WRITE_LOCK_WAIT: Duration = Duration::from_secs(5);

/// Take any std mutex, waiting as long as it takes, and recover from poisoning.
///
/// Poisoning means some other thread panicked while holding the lock. A `Connection`
/// survives that (rusqlite rolls an open transaction back as it unwinds), and so does every
/// other thing this crate locks — a `HashMap`, a counter — so refusing to lock ever again
/// would brick the app for no gain.
///
/// This is the *one* definition of that rule. [`lock_blocking`] is it over a `Connection`,
/// `sync::lock_conn`/`lock_db`/`lock_db_read`/`lock_plain` are the names the rest of the
/// crate reaches it by, and [`lock_for`] applies the same recovery to the bounded case.
pub fn lock_plain<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// [`lock_plain`] over the one type most of this crate locks.
pub fn lock_blocking(mutex: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    lock_plain(mutex)
}

/// The same rule over an `RwLock` — the shape [`crate::sync::AppState::index`] uses, because
/// every facet request reads it and only a sync or a collection write replaces it.
///
/// Recovering from poisoning matters more here than it looks: `read().ok()` would report a
/// poisoned index as **cold**, which is at least safe, but `write().ok()` would silently drop
/// the publish and leave it cold *forever* — one panic anywhere and the app never faceted
/// again until it was restarted.
pub fn lock_read<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|e| e.into_inner())
}

/// [`lock_read`]'s other half.
pub fn lock_write<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|e| e.into_inner())
}

/// How long [`lock_for`] sleeps between attempts. Short enough that the wait is invisible,
/// long enough that a contended lock is not a spin.
const LOCK_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Take `mutex`, giving up after `timeout` rather than queueing behind whatever holds it.
///
/// The ingest no longer holds the write connection for its whole run — it takes and
/// releases it once per batch — but a bounded ask is still the right shape for callers
/// who have a real answer for "could not": the exit checkpoint (skip it, the WAL is a
/// valid journal either way), the image cache's bookkeeping (skip the row, one re-fetch
/// from an unlimited origin), and the user-facing writes that answer "busy" after
/// [`WRITE_LOCK_WAIT`] rather than freezing a button.
///
/// A `timeout` of [`Duration::ZERO`] is exactly one `try_lock` with no sleeping at all,
/// which is what a caller on an async worker thread wants: a contended write connection
/// is not worth parking a pool thread on when the work is optional anyway. The exit
/// checkpoint, which runs on its own thread with the process already ending, is the
/// caller that can afford to wait a little.
///
/// Poisoning is recovered exactly as [`lock_blocking`] does: the panicking thread's
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

    /// Some callers need the write lock *without* queueing for it behind whatever holds
    /// it: the exit checkpoint (which would park a window-less process the user believes
    /// has quit), the image cache's bookkeeping (which would hold a picture hostage to a
    /// write), and the user-facing writes that answer "busy" rather than freeze a button.
    /// Each has a correct answer for "could not".
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
        // thread parked on a lock, for a row it is perfectly happy to skip.
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
        // Set before WAL materialises the file, or it is a silent no-op that only a full
        // `VACUUM` can apply afterwards — see `crate::maintenance`.
        let auto_vacuum: i64 = conn
            .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
            .unwrap();

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(mode.to_lowercase(), "wal");
        assert_eq!(auto_vacuum, 2, "auto_vacuum must be INCREMENTAL (2)");
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
