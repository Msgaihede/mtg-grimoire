use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard, TryLockError};
use std::time::Duration;
// `Instant::now()` **panics** on `wasm32-unknown-unknown`. Gating the import rather than
// only its caller is the fence: on the web target the name is not in scope at all.
#[cfg(not(target_family = "wasm"))]
use std::time::Instant;

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

/// The reader's own database. `main` on every connection this module hands out.
pub const USER_DB: &str = "user.db";

/// The rebuildable half. Attached, never `main` — and the reason is that you cannot
/// `DETACH main`. Discarding a corrupt corpus has to be four statements and 5 ms, not a
/// process-wide reopen with two live connections in the way.
pub const CORPUS_DB: &str = "corpus.db";

/// What the one file was called before schema 27. Only `crate::split` names it.
pub const LEGACY_DB: &str = "mtg.db";

/// The schema name the corpus is attached under. Spelled once, so a query cannot be
/// half-qualified against a name somebody typed differently.
pub const CORPUS: &str = "corpus";

/// Which journal a schema actually ended up on.
///
/// A *value* rather than an assumption, because the answer is not the same on every platform
/// and the difference is about durability rather than speed. `PRAGMA journal_mode = WAL`
/// answers `delete` on the browser's `opfs-sahpool` VFS — measured 2026-08-28 on **both**
/// files of the pair, `main=delete corpus=delete` — and a database on a filesystem without
/// shared memory can answer `delete` on desktop too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Journal {
    /// Write-ahead logging — what desktop gets, and what [`checkpoint_truncate`] is for.
    Wal,
    /// A rollback journal. The web target's, and the only durability story available there.
    Delete,
    /// An in-memory database, which has no journal file to speak of.
    Memory,
    /// Something SQLite offers that this app never asks for. Never a panic and never a
    /// guess: a mode this build has not heard of must not be mistaken for one it has.
    Other,
}

impl Journal {
    /// Read SQLite's own answer. Case-insensitive: the pragma answers lowercase, but the
    /// value can also arrive from a stored string.
    pub fn parse(answer: &str) -> Journal {
        match answer.to_ascii_lowercase().as_str() {
            "wal" => Journal::Wal,
            "delete" => Journal::Delete,
            "memory" => Journal::Memory,
            _ => Journal::Other,
        }
    }
}

/// Apply the four file-level pragmas to one schema, and answer the journal SQLite settled on.
///
/// **`auto_vacuum` first, before any statement writes a page**, and that ordering is
/// load-bearing on both schemas for the same reason: once `journal_mode=WAL` has
/// materialised the file, `auto_vacuum` is a no-op that only a full `VACUUM` can apply.
/// Measured live while planning: WAL first leaves a brand-new database on `auto_vacuum = 0`
/// through every reopen, and a freshly-attached file opens on `delete` and `auto_vacuum = 0`
/// exactly the same way. Incremental rather than full: the return of freed pages is then
/// something the app asks for after a swap, not something SQLite pays for on every commit.
///
/// `schema` is `None` for `main` and `Some(CORPUS)` for the attached half. `foreign_keys`
/// and `busy_timeout` are **not** here: both are per-connection and take no schema.
///
/// **The journal is returned rather than discarded, and that is the web target's doing.**
/// `journal_mode` is issued with `query_row` and not `pragma_update`: the latter goes through
/// `execute_batch`, which throws returned rows away, so the old code could not see SQLite's
/// answer even in principle. The browser's pool refuses WAL, so a caller there has to be able
/// to *record* what it got instead of assuming; the same read makes a desktop that quietly
/// fell off WAL visible, which it was not.
pub fn apply_pragmas(conn: &Connection, schema: Option<&str>) -> rusqlite::Result<Journal> {
    conn.pragma_update(schema, "auto_vacuum", "INCREMENTAL")?;
    let qualified = match schema {
        Some(name) => format!("PRAGMA {name}.journal_mode = WAL"),
        None => "PRAGMA journal_mode = WAL".to_owned(),
    };
    let journal: String = conn.query_row(&qualified, [], |r| r.get(0))?;
    conn.pragma_update(schema, "synchronous", "NORMAL")?;
    conn.pragma_update(schema, "journal_size_limit", JOURNAL_SIZE_LIMIT)?;
    Ok(Journal::parse(&journal))
}

/// Open (or create) the SQLite database at `path` with the app's standard PRAGMAs:
/// incremental auto-vacuum, WAL journalling, `synchronous = NORMAL`, foreign-key
/// enforcement, a bounded WAL file and a busy timeout.
///
/// One file, and the app no longer opens one — [`open_write`] is what `init_state` calls.
/// This stays because `crate::split::convert` needs a plain handle on a single legacy file,
/// and because the pragma set has exactly one definition either way.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    apply_pragmas(&conn, None)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(conn)
}

/// Attach `<data_dir>/corpus.db` as [`CORPUS`] and give it the same pragmas as `main`.
///
/// **An attached file inherits neither `journal_size_limit` nor `synchronous`** — measured
/// against the real 788 MB database, which came up on `-1` and `2` against `main`'s
/// `67108864` and `1`. The corpus is the half that writes an 857 MB journal during an
/// ingest, so a ceiling that does not reach it is a ceiling on nothing.
///
/// The path is bound as a parameter; the schema name cannot be, which is why [`CORPUS`] is
/// interpolated. Creating the file if it is absent is deliberate and is the corpus's whole
/// character: a missing corpus is a rebuild, not an error.
pub fn attach_corpus(conn: &Connection, data_dir: &Path) -> rusqlite::Result<()> {
    let path = data_dir.join(CORPUS_DB);
    conn.execute(
        &format!("ATTACH DATABASE ?1 AS {CORPUS}"),
        [path.to_string_lossy().as_ref()],
    )?;
    apply_pragmas(conn, Some(CORPUS)).map(|_| ())
}

/// The one write connection: `user.db` as `main`, `corpus.db` attached.
///
/// The user file is `main` because you cannot `DETACH main`: discarding a corrupt corpus
/// has to be a `DETACH`, a delete and an `ATTACH`, not a process-wide reopen with two live
/// connections in the way. Its two smaller reasons point the same way — the file
/// `Connection::open` names is the one whose absence is a failure the app has a message for,
/// and `PRAGMA user_version` unqualified means `main`.
pub fn open_write(data_dir: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(data_dir.join(USER_DB))?;
    apply_pragmas(&conn, None)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    attach_corpus(&conn, data_dir)?;
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

/// A **read-only** handle over the same pair [`open_write`] opens.
///
/// Nothing is configured here, on either schema: those pragmas are properties of a file,
/// set by [`open_write`], and a read-only connection may not change them anyway. `ATTACH`
/// on a `SQLITE_OPEN_READ_ONLY` handle succeeds and the attached database is read-only too
/// — measured, a write to it answers `SQLITE_READONLY`, which is the guarantee this handle
/// exists for extended across both files.
pub fn open_read(data_dir: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        data_dir.join(USER_DB),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    let path = data_dir.join(CORPUS_DB);
    conn.execute(
        &format!("ATTACH DATABASE ?1 AS {CORPUS}"),
        [path.to_string_lossy().as_ref()],
    )?;
    Ok(conn)
}

/// Records whether the transaction now committing wrote to more than one of the
/// connection's databases.
///
/// **SQLite does not promise a cross-file commit is atomic in WAL mode**, and it does not
/// complain either — the commit succeeds and either file may be the one that survives a
/// power cut. There is exactly one such transaction in the crate's history
/// (`crate::reconcile::apply`, closed in schema 27 by moving `card_migrations` to the user
/// file), and this is what stops the second one being added by somebody who did not know.
///
/// Two atomics and a `fetch_or` inside SQLite's own callback: no allocation, no lock, and
/// nothing that could call back into the database — the same budget
/// [`crate::mirror::watch::Mask`] works to, and for the same reason, since they share a hook.
///
/// # What it cannot see
///
/// **The update hook does not fire for `WITHOUT ROWID` tables** — measured, an insert into
/// `image_cache` produced no callback at all and the row was there. Twelve corpus tables are
/// `WITHOUT ROWID`: `image_cache`, `marketplace_prices`, `art_tags`, `art_tag_parents`,
/// `art_taggings`, `art_tag_illustrations`, `oracle_tags`, `oracle_tag_parents`,
/// `oracle_taggings`, `oracle_tag_cards`, `cards_fts_idx` and `cards_fts_config`;
/// `muted_tags` is the one on the user side. A transaction whose *only* corpus write is to
/// one of those is invisible here, and `image_cache` is the likeliest candidate in the crate.
///
/// An authorizer would see them — it reports the schema name and does fire for
/// `WITHOUT ROWID`, both measured — but it fires at *prepare* time, and a `prepare_cached`
/// statement re-executed does not re-authorize (measured: one callback across two
/// executions). It cannot attribute a write to a transaction, which is the whole question
/// here. So this is the honest half of the fence rather than the whole one.
#[derive(Debug, Default)]
pub struct CrossFileFence {
    seen: AtomicU8,
    tripped: AtomicBool,
}

impl CrossFileFence {
    const MAIN: u8 = 1 << 0;
    const ATTACHED: u8 = 1 << 1;

    pub fn new() -> Self {
        Self::default()
    }

    /// From inside the update hook. `db` is SQLite's own schema name for the write.
    pub fn note(&self, db: &str) {
        let bit = if db == "main" {
            Self::MAIN
        } else {
            Self::ATTACHED
        };
        self.seen.fetch_or(bit, Ordering::Relaxed);
    }

    /// From the commit hook. Returns whether this commit crossed the files.
    ///
    /// **Never returns anything SQLite acts on.** A commit hook that aborted here would turn
    /// a diagnostic into data loss on a user's machine over a bug in this fence.
    pub fn settle(&self) -> bool {
        let crossed = self.seen.swap(0, Ordering::Relaxed) == (Self::MAIN | Self::ATTACHED);
        if crossed {
            self.tripped.store(true, Ordering::Relaxed);
        }
        crossed
    }

    /// From the rollback hook. A transaction that did not commit did not cross anything.
    pub fn clear(&self) {
        self.seen.store(0, Ordering::Relaxed);
    }

    /// Whether any commit on this connection has crossed the files since the process began.
    pub fn tripped(&self) -> bool {
        self.tripped.load(Ordering::Relaxed)
    }
}

/// How long a user-facing write waits for the write connection before answering "busy".
///
/// With the chunked ingest the longest anyone can be behind is one batch of 2 000 rows —
/// well under a second at the measured 2 600 rows/s. Five seconds is therefore not a
/// budget for a sync, it is the point at which something has genuinely gone wrong and the
/// honest answer is to say so rather than to hold a button down.
pub const WRITE_LOCK_WAIT: Duration = Duration::from_secs(5);

/// What a user-facing write says when it could not have the database inside
/// [`WRITE_LOCK_WAIT`].
///
/// A sentence rather than a lock error, and it names the wait: since the ingest was chunked
/// the only thing that can hold the connection for five seconds is something genuinely
/// stuck, and "try again in a moment" is both true and actionable.
///
/// Here rather than in [`crate::collection`], where it began: nine modules outside the
/// collection answer with it, and it is a statement about the *lock* — the other half of
/// [`WRITE_LOCK_WAIT`], and what [`crate::sync::with_write`] returns when [`lock_for`]
/// gives up. Note the near-neighbour [`BUSY_TIMEOUT`] is a different thing entirely:
/// SQLite's own internal wait, not this app's answer to a caller.
pub const BUSY: &str = "The card database is busy finishing a sync. Try that again in a moment.";

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
///
/// Gated because the web arm has no waiting to do, and an unused constant fails
/// `clippy -D warnings` on that target.
#[cfg(not(target_family = "wasm"))]
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
///
/// **On web there is no waiting arm at all** — see the body. One Worker means one thread, so
/// `timeout` has nothing to spend.
pub fn lock_for(
    mutex: &Mutex<Connection>,
    timeout: Duration,
) -> Option<MutexGuard<'_, Connection>> {
    // One thread — the Worker — so there is nobody to wait for, and no clock to wait by:
    // `Instant::now()` panics on wasm32-unknown-unknown, *before* the `try_lock` and whatever
    // the timeout, so even a `Duration::ZERO` call would panic. A `WouldBlock` here means
    // this same thread already holds the guard, which is a reentrancy bug to surface rather
    // than a wait to sit out. This is exactly the `Duration::ZERO` behaviour the doc above
    // already describes.
    #[cfg(target_family = "wasm")]
    {
        let _ = timeout;
        match mutex.try_lock() {
            Ok(guard) => Some(guard),
            Err(TryLockError::Poisoned(e)) => Some(e.into_inner()),
            Err(TryLockError::WouldBlock) => None,
        }
    }

    #[cfg(not(target_family = "wasm"))]
    {
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
}

/// Fold the write-ahead log back into the database and truncate the `-wal` file to zero.
///
/// Best-effort by contract: the caller runs this on the way out, and there is nothing
/// useful to do about a failure at that point — the WAL is a valid, recoverable journal
/// either way, and the next launch replays it. See the exit handler in `lib.rs`.
pub fn checkpoint_truncate(conn: &Connection) -> rusqlite::Result<()> {
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
}

/// The VFS name the pool registers under. Named rather than inline so that a future second
/// VFS cannot be confused with this one by a typo.
#[cfg(target_family = "wasm")]
pub const OPFS_VFS_NAME: &str = "opfs-sahpool";

/// How many files the pool preallocates.
///
/// **Files, not bytes**, and the app needs more of them than the spike did: two databases
/// rather than one, each with a rollback journal — the pool refuses WAL — plus SQLite's own
/// temporary files and headroom. Twelve was what probe 6 ran the pair on.
#[cfg(target_family = "wasm")]
const OPFS_INITIAL_CAPACITY: u32 = 12;

/// Install the browser's OPFS VFS and make it the default.
///
/// **Web only, and it must run inside a dedicated Worker.** `opfs-sahpool` holds exclusive
/// `FileSystemSyncAccessHandle`s, which are only obtainable off the main thread. That is not
/// a detail of the harness: it is why the whole database lives in one Worker.
///
/// **This call is the one-tab guard's trigger, and that was measured rather than assumed.**
/// A second document of the same origin fails *here* — not at [`open_pooled_pair`] — with
/// `CreateSyncAccessHandle(JsValue(NoModificationAllowedError: …))`. The first tab holds every
/// handle in the pool, so the second never gets as far as naming a database.
///
/// **Cross-origin isolation is not required.** The same page was served with and without
/// `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
/// and passed both ways; the timing difference was cache noise. Do not add those headers.
///
/// The error is a `String` because the crate hands back a `JsValue` and the caller needs its
/// *text*: [`crate::web::wire::Opened::from_open_error`] tells "already open elsewhere" from
/// "genuinely broken" by matching the DOMException's name inside it.
#[cfg(target_family = "wasm")]
pub async fn install_opfs_pool(directory: &str) -> Result<(), String> {
    let cfg = sqlite_wasm_vfs::sahpool::OpfsSAHPoolCfgBuilder::new()
        .vfs_name(OPFS_VFS_NAME)
        .directory(directory)
        .initial_capacity(OPFS_INITIAL_CAPACITY)
        .build();
    sqlite_wasm_vfs::sahpool::install::<rusqlite::ffi::WasmOsCallback>(&cfg, true)
        .await
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

/// [`open_write`]'s pair, on the pool installed by [`install_opfs_pool`].
///
/// The names are bare rather than paths: **the pool is the filesystem**. Everything else is
/// `open_write` line for line — `user.db` as `main`, `corpus.db` attached as [`CORPUS`], the
/// same four file pragmas on each schema and the same two per-connection ones — because the
/// split is a fact about the app's data and not about the medium it sits on.
///
/// **That the pool can hold two databases, and that `ATTACH` reaches the second through the
/// same VFS, was measured before this was written** (2026-08-28, Chrome/Edge 151, probe 6):
/// `PRAGMA database_list` answered `main=user.db corpus=corpus.db`, one transaction wrote to
/// both, a join across them answered, `DETACH` and re-`ATTACH` both worked, and both files
/// survived a page reload. It is not a thing to assume — the spike only ever proved one file.
///
/// Both journals come back [`Journal::Delete`]: the sahpool VFS refuses WAL on either half.
/// That is the web target's durability story, and the caller is expected to record it rather
/// than retry.
#[cfg(target_family = "wasm")]
pub fn open_pooled_pair() -> rusqlite::Result<(Connection, Journal, Journal)> {
    let conn = Connection::open(USER_DB)?;
    let user = apply_pragmas(&conn, None)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.execute(&format!("ATTACH DATABASE ?1 AS {CORPUS}"), [CORPUS_DB])?;
    let corpus = apply_pragmas(&conn, Some(CORPUS))?;
    Ok((conn, user, corpus))
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

    /// The four pragmas `db::open` sets are properties of a *file*, and an attached file
    /// inherits none of the two that matter. Measured against the real 788 MB database:
    /// `corpus.journal_size_limit` read -1 where main read 67108864, and `corpus.synchronous`
    /// read 2 (FULL) where main read 1 (NORMAL). The corpus is the file that writes an 857 MB
    /// journal during an ingest, so losing the ceiling loses it on the only file that needs it.
    #[test]
    fn an_attached_corpus_gets_the_same_pragmas_as_main() {
        let dir = scratch("pair");

        let conn = open_write(&dir).unwrap();

        let main_mode: String = conn
            .query_row("PRAGMA main.journal_mode", [], |r| r.get(0))
            .unwrap();
        let corpus_mode: String = conn
            .query_row("PRAGMA corpus.journal_mode", [], |r| r.get(0))
            .unwrap();
        let corpus_limit: i64 = conn
            .query_row("PRAGMA corpus.journal_size_limit", [], |r| r.get(0))
            .unwrap();
        let corpus_sync: i64 = conn
            .query_row("PRAGMA corpus.synchronous", [], |r| r.get(0))
            .unwrap();
        let corpus_vacuum: i64 = conn
            .query_row("PRAGMA corpus.auto_vacuum", [], |r| r.get(0))
            .unwrap();
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(main_mode.to_lowercase(), "wal");
        assert_eq!(
            corpus_mode.to_lowercase(),
            "wal",
            "the corpus must be WAL too"
        );
        assert_eq!(
            corpus_limit, JOURNAL_SIZE_LIMIT,
            "the WAL ceiling must reach the corpus"
        );
        assert_eq!(corpus_sync, 1, "the corpus must be synchronous = NORMAL");
        assert_eq!(
            corpus_vacuum, 2,
            "auto_vacuum must be set before WAL materialises the file"
        );
        assert_eq!(fk, 1, "foreign_keys is per-connection, not per-schema");
    }

    /// Both files exist afterwards, and they are two files. `ATTACH` on a path that does not
    /// exist creates it silently, which is the right failure for a rebuildable corpus and would
    /// be the wrong one for a collection — which is why the user file is the one `open` names.
    #[test]
    fn open_write_creates_both_files_and_they_are_distinct() {
        let dir = scratch("pair-files");

        let conn = open_write(&dir).unwrap();
        conn.execute_batch(
            "CREATE TABLE t (v TEXT);
             CREATE TABLE corpus.u (v TEXT);
             INSERT INTO t VALUES ('user');
             INSERT INTO u VALUES ('corpus');",
        )
        .unwrap();
        let unqualified: String = conn.query_row("SELECT v FROM u", [], |r| r.get(0)).unwrap();
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .unwrap();
        drop(conn);

        let user_there = dir.join(USER_DB).is_file();
        let corpus_there = dir.join(CORPUS_DB).is_file();
        let user_len = std::fs::metadata(dir.join(USER_DB)).unwrap().len();
        let corpus_len = std::fs::metadata(dir.join(CORPUS_DB)).unwrap().len();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(user_there && corpus_there);
        assert!(user_len > 0 && corpus_len > 0);
        // Fact 1: an unqualified name resolves into the attached database.
        assert_eq!(unqualified, "corpus");
    }

    /// The read handle sees both files and can write to neither. It is what every search uses,
    /// and a handle that *could* write is a handle that can stall the ingest it exists to run
    /// alongside — `open_read_only`'s reason, now doubled.
    #[test]
    fn the_read_handle_sees_both_files_and_writes_to_neither() {
        let dir = scratch("pair-read");
        let w = open_write(&dir).unwrap();
        w.execute_batch(
            "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('user');
             CREATE TABLE corpus.u (v TEXT); INSERT INTO u VALUES ('corpus');",
        )
        .unwrap();

        let r = open_read(&dir).unwrap();
        let user: String = r
            .query_row("SELECT v FROM t", [], |row| row.get(0))
            .unwrap();
        let corpus: String = r
            .query_row("SELECT v FROM u", [], |row| row.get(0))
            .unwrap();
        let write_user = r.execute("INSERT INTO t VALUES ('nope')", []);
        let write_corpus = r.execute("INSERT INTO u VALUES ('nope')", []);

        drop(r);
        drop(w);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(user, "user");
        assert_eq!(corpus, "corpus");
        assert!(
            write_user.is_err(),
            "the read handle must not write the user file"
        );
        assert!(
            write_corpus.is_err(),
            "the read handle must not write the corpus either"
        );
    }

    /// The exit checkpoint still empties both journals. `PRAGMA wal_checkpoint` with no schema
    /// name checkpoints every attached database — measured, both `-wal` files at 0 bytes — so
    /// `checkpoint_truncate` needs no change and this is what says so.
    #[test]
    fn a_truncating_checkpoint_empties_both_journals() {
        let dir = scratch("pair-checkpoint");
        let conn = open_write(&dir).unwrap();
        conn.execute_batch("CREATE TABLE t (v TEXT); CREATE TABLE corpus.u (v TEXT);")
            .unwrap();
        for i in 0..2000 {
            conn.execute("INSERT INTO t VALUES (?1)", [format!("row {i}")])
                .unwrap();
            conn.execute("INSERT INTO u VALUES (?1)", [format!("row {i}")])
                .unwrap();
        }
        let before_user = std::fs::metadata(dir.join("user.db-wal"))
            .map(|m| m.len())
            .unwrap_or(0);
        let before_corpus = std::fs::metadata(dir.join("corpus.db-wal"))
            .map(|m| m.len())
            .unwrap_or(0);

        checkpoint_truncate(&conn).unwrap();

        let after_user = std::fs::metadata(dir.join("user.db-wal"))
            .map(|m| m.len())
            .unwrap_or(0);
        let after_corpus = std::fs::metadata(dir.join("corpus.db-wal"))
            .map(|m| m.len())
            .unwrap_or(0);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            before_user > 0 && before_corpus > 0,
            "both should have had a WAL to truncate"
        );
        assert_eq!(after_user, 0);
        assert_eq!(
            after_corpus, 0,
            "an unqualified checkpoint must reach the attached file"
        );
    }

    /// A real file gets WAL. This is the assertion [`apply_pragmas`] has always *implied* and
    /// never made — `pragma_update` runs through `execute_batch`, which throws the answer away.
    #[test]
    fn a_file_database_reports_the_journal_it_actually_got() {
        let dir = scratch("journal");
        let conn = Connection::open(dir.join("journal.db")).unwrap();

        assert_eq!(apply_pragmas(&conn, None).unwrap(), Journal::Wal);

        // And the pragmas that do not depend on the medium are on. `foreign_keys` is not one
        // of them — it is per-connection and `open` sets it, not `apply_pragmas`.
        let av: i64 = conn
            .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
            .unwrap();
        assert_eq!(av, 2, "auto_vacuum INCREMENTAL is 2");

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **Both halves of the pair report, and separately.** A journal is a property of a
    /// *file*, so the answer for `main` says nothing about the attached corpus — which is the
    /// same reason `apply_pragmas` takes a schema at all, and the reason the corpus's
    /// `journal_size_limit` had to be set by hand.
    #[test]
    fn both_files_report_the_journal_they_got() {
        let dir = scratch("journal-pair");
        let conn = open_write(&dir).unwrap();

        // Re-asking is idempotent and answers what the file is on now.
        assert_eq!(apply_pragmas(&conn, None).unwrap(), Journal::Wal);
        assert_eq!(apply_pragmas(&conn, Some(CORPUS)).unwrap(), Journal::Wal);

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An in-memory database cannot be on WAL, and saying so is the whole point: the web
    /// target gets `delete` from the sahpool VFS for the same kind of reason, and the app
    /// has to be able to *see* which journal it ended up on rather than assume one.
    #[test]
    fn an_in_memory_database_reports_memory_rather_than_wal() {
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(apply_pragmas(&conn, None).unwrap(), Journal::Memory);
    }

    /// The vocabulary is closed, and an unknown answer is `Other` rather than a panic or a
    /// wrong guess. `truncate` is a real SQLite journal mode this app never asks for.
    #[test]
    fn an_unrecognised_journal_name_is_other_and_not_a_guess() {
        assert_eq!(Journal::parse("truncate"), Journal::Other);
        assert_eq!(Journal::parse("DELETE"), Journal::Delete);
        assert_eq!(Journal::parse("wal"), Journal::Wal);
        assert_eq!(Journal::parse("memory"), Journal::Memory);
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
