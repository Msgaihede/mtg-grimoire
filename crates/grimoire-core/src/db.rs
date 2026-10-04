use crate::platform::clock::Tick;
use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard, TryLockError};
use std::time::Duration;

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
/// **A value rather than an assumption**, because the answer is not the same on every host and
/// the difference is about durability rather than speed. `PRAGMA journal_mode = WAL` answers
/// `delete` on a browser's `opfs-sahpool` VFS — measured on both files of the pair by the first
/// web host (2026-08-28, Chrome and Edge 151) — and a desktop whose data folder sits on a
/// filesystem with no shared memory can answer `delete` too. [`apply_pragmas`] asks for WAL
/// everywhere and answers what it was given; [`open_single`] hands both answers to its host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Journal {
    /// Write-ahead logging — what the desktop and Android get, and what [`checkpoint_truncate`]
    /// is for.
    Wal,
    /// A rollback journal. A browser's, and the only durability story available there.
    Delete,
    /// An in-memory database, which has no journal file to speak of.
    Memory,
    /// Something SQLite offers that this app never asks for. Never a panic and never a guess: a
    /// mode this build has not heard of must not be mistaken for one it has.
    Other,
}

impl Journal {
    /// Read SQLite's own answer. Case-insensitive: the pragma answers lowercase, but the value
    /// can also arrive from a stored string.
    pub fn parse(answer: &str) -> Journal {
        match answer.to_ascii_lowercase().as_str() {
            "wal" => Journal::Wal,
            "delete" => Journal::Delete,
            "memory" => Journal::Memory,
            _ => Journal::Other,
        }
    }

    /// The word a host reports it by — SQLite's own, lowercase.
    pub fn as_str(self) -> &'static str {
        match self {
            Journal::Wal => "wal",
            Journal::Delete => "delete",
            Journal::Memory => "memory",
            Journal::Other => "other",
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
/// `journal_mode` is issued with `query_row`, because setting it answers a row — **and the row
/// is the answer**, returned rather than thrown away since the web host: a browser's storage
/// refuses WAL, so a host there has to be able to *say* what it got ([`Journal`]). The same
/// statements, in the same order, as before it was read.
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
///
/// Answers the journal the corpus got, which is not promised to be `main`'s: a journal is a
/// property of a file.
pub fn attach_corpus(conn: &Connection, data_dir: &Path) -> rusqlite::Result<Journal> {
    let path = data_dir.join(CORPUS_DB);
    conn.execute(
        &format!("ATTACH DATABASE ?1 AS {CORPUS}"),
        [path.to_string_lossy().as_ref()],
    )?;
    apply_pragmas(conn, Some(CORPUS))
}

/// The one write connection: `user.db` as `main`, `corpus.db` attached.
///
/// The user file is `main` because you cannot `DETACH main`: discarding a corrupt corpus
/// has to be a `DETACH`, a delete and an `ATTACH`, not a process-wide reopen with two live
/// connections in the way. Its two smaller reasons point the same way — the file
/// `Connection::open` names is the one whose absence is a failure the app has a message for,
/// and `PRAGMA user_version` unqualified means `main`.
pub fn open_write(data_dir: &Path) -> rusqlite::Result<Connection> {
    open_pair(data_dir, None).map(|pair| pair.conn)
}

/// [`open_write`] for a caller that wants to know which journal each file got — the same
/// statements, with the two answers kept. [`crate::launch::open`] is the caller.
pub fn open_write_pair(data_dir: &Path) -> rusqlite::Result<Pair> {
    open_pair(data_dir, None)
}

/// [`open_write`]'s and [`open_single`]'s one body, so the pair cannot be opened two ways.
///
/// `temp_store` is the one statement between them, and `None` issues nothing: a host with a
/// folder gets exactly the statements, in exactly the order, it got before there was a second
/// caller.
fn open_pair(dir: &Path, temp_store: Option<&str>) -> rusqlite::Result<Pair> {
    let conn = Connection::open(dir.join(USER_DB))?;
    let journal = apply_pragmas(&conn, None)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    if let Some(store) = temp_store {
        conn.pragma_update(None, "temp_store", store)?;
    }
    let corpus_journal = attach_corpus(&conn, dir)?;
    Ok(Pair {
        conn,
        journal,
        corpus_journal,
    })
}

/// The pair on a connection that may write it, and the journal each file actually got.
pub struct Pair {
    /// `user.db` as `main`, `corpus.db` attached as [`CORPUS`] — [`open_write`]'s pair.
    pub conn: Connection,
    /// `main`'s journal — the reader's own file.
    pub journal: Journal,
    /// The corpus's. Reported apart because a journal is a property of a *file*: the corpus is
    /// the half that writes an ingest's worth of journal, and one field would hide the day the
    /// two stop agreeing.
    pub corpus_journal: Journal,
}

/// Where a one-connection host's SQLite builds its temporary b-trees — the sort behind every
/// `CREATE INDEX` of a staging swap, an FTS rebuild, a materialised subquery.
///
/// **`FILE`, and it is a decision about a browser's memory rather than a measured necessity.**
/// The SQLite a browser build compiles (`sqlite-wasm-rs`, `SQLITE_TEMP_STORE=2`) keeps them in
/// memory unless told otherwise, and there memory is the module's linear memory, which grows
/// and is never given back: a first ingest's index replay over ~117 000 rows would be the
/// session's high-water mark for good. In the VFS they are files that are deleted when the
/// statement ends. The first web host ran this way end to end — 148.6–171.6 MB peak linear
/// memory over a whole first run — and that is the only figure there is: the setting was first
/// added against a failure later traced to something else (a module instantiated twice), and
/// **memory has never been measured in its place**. Nothing spills for small work either way:
/// SQLite gives each temporary b-tree a page cache of its own and opens the file only when
/// that overflows, so the managed wishlists' `temp` tables on every write never reach one.
///
/// **What it costs is file slots**: on a pooled VFS each such file takes one of the pool's
/// preallocated files while it lives, which is why the web host's pool is sized well past the
/// two databases and their two journals.
///
/// On a host with a folder this is SQLite's own default (`SQLITE_TEMP_STORE=1`), which is why
/// [`open_single`] can set it on every host and a native test can read it back.
const SINGLE_TEMP_STORE: &str = "FILE";

/// **The pair on one connection, for a host that can have only one** — a browser, whose
/// storage is SQLite's own OPFS VFS and permits exactly one connection.
///
/// [`open_write`], statement for statement — `user.db` as `main`, `corpus.db` attached, the
/// same four file pragmas on each and the same two on the connection — with two differences:
///
/// * **the journal each file got is answered** rather than assumed ([`Journal`]). The pragmas
///   still *ask* for WAL: a host whose storage has it gets it, and one whose storage refuses
///   answers `delete` and says so;
/// * **`temp_store`** is set ([`SINGLE_TEMP_STORE`] has the reason).
///
/// **There is no [`open_read`] to follow it.** The connection is the host's only one: its
/// [`crate::state::State`] is built with `read: None`, every read goes through the mutex that
/// writes do, and a read asked for while the same thread holds the connection is a lock taken
/// twice — `commands`' table test runs every command that way.
///
/// `databases` is what the two file names are joined to, and **it is empty where the VFS is
/// the filesystem**: a pool's names are bare (`user.db`, `corpus.db`), so a web host passes
/// `Path::new("")`. A test passes a scratch directory, which is the whole of what makes this
/// reachable from a native suite. Nothing here creates a folder or asks whether a file exists
/// — a browser has neither question to ask ([`crate::platform::files`]).
///
/// **What a rollback journal changes, for whoever reads on**: there is no `-wal` to
/// checkpoint, so [`checkpoint_truncate`] has nothing to fold and a host that got
/// [`Journal::Delete`] has no exit handler to run; and a reader cannot run beside a writer —
/// with one connection there is no "beside".
pub fn open_single(databases: &Path) -> rusqlite::Result<Pair> {
    open_pair(databases, Some(SINGLE_TEMP_STORE))
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
/// nothing that could call back into the database — the budget every
/// [`crate::hooks::WriteObserver`] works to, and for the same reason, since they share a hook:
/// [`crate::hooks::install`] is what puts this on a connection, ahead of the observers.
///
/// # What it cannot see
///
/// **The update hook does not fire for `WITHOUT ROWID` tables** — measured, an insert into
/// `image_cache` produced no callback at all and the row was there. Twelve corpus tables are
/// `WITHOUT ROWID`: `image_cache`, `marketplace_prices`, `art_tags`, `art_tag_parents`,
/// `art_taggings`, `art_tag_illustrations`, `oracle_tags`, `oracle_tag_parents`,
/// `oracle_taggings`, `oracle_tag_cards`, `cards_fts_idx` and `cards_fts_config`. **Six are on
/// the user side** — `muted_tags`, `device_names`, `sync_devices` and `sync_state`, which a
/// command marks by hand, and `price_snapshots` and `sync_peers`, which only the app writes; the
/// census and its `sqlite_master` test are the desktop's `changes::MARKED_BY_COMMAND` and
/// `changes::WRITTEN_BY_THE_APP` — `changes` is one of that host's observers and stays there. Two of the six are synced — `muted_tags` and, since
/// user schema v31, `device_names` ([`crate::schema::SYNCED_TABLES`]). A transaction whose *only*
/// corpus write is to one of the first twelve is invisible here, and `image_cache` is the
/// likeliest candidate in the crate.
/// **The same blind spot is why live sync's write-wake rides `commit_hook` rather than this
/// one**: `commit_hook` fires once per transaction regardless of a table's rowid shape, where an
/// update-hook debounce would silently never sync a muted tag or a device rename. See
/// `sync_engine::live` and the design spec §6.3.
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
    ///
    /// **`temp` is not a file this fence is about.** The per-connection bookkeeping
    /// [`crate::managed_wishlist`] keeps there (a list of decks to revisit) is advisory and dies
    /// with the connection, so a commit that lost it would lose nothing a reader owns — and every
    /// deck write makes one, beside its own row in `main`.
    pub fn note(&self, db: &str) {
        if db == "temp" {
            return;
        }
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
/// [`crate::state::State::lock_db`] and `lock_db_read` are how the rest of the crate reaches
/// it, and [`lock_for`] applies the same recovery to the bounded case.
pub fn lock_plain<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// [`lock_plain`] over the one type most of this crate locks.
///
/// **On a host with one connection this is where a lock taken twice ends** — a read asked for
/// by a thread that already holds the write connection is the same mutex again. A desktop
/// with one connection would wait here for ever; a browser's Worker traps, because std's
/// `Mutex` panics on a recursive lock where there are no threads. A test that stands in for
/// such a host ([`crate::platform::alone`]) gets that as a panic naming the line that asked,
/// which is what `#[track_caller]` is here for; everywhere else this is `Mutex::lock`.
#[track_caller]
pub fn lock_blocking(mutex: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    crate::platform::alone::lock(mutex)
}

/// Take `mutex`, **waiting as long as it takes — and counted as an ask while it waits**, so a
/// batch loop stands aside for it exactly as it does for [`lock_for`].
///
/// [`lock_blocking`] waits too, but invisibly: a thread parked in `Mutex::lock` is nobody
/// [`lock_background`] knows to defer to, so under the launch's three ingests it gets the
/// connection whenever it happens to catch it free. That was the right shape for a departure's
/// one write and is the wrong one for a sync operation's stretches, which are the waits
/// [`crate::state::with_write_waiting`] makes now and which used to come through [`lock_for`]
/// as a whole operation.
///
/// **On a host with no second thread it does not wait at all**: a Worker cannot pause, and
/// nothing but its own caller can be holding the lock there — so a contended ask goes straight
/// to [`lock_blocking`], which is a trap in a browser and a named panic in a test standing in
/// for one. A stretch asked for by a caller that holds the connection is a bug on every host
/// ([`crate::state::with_write_waiting`]); this is where it stops being a silent one.
#[track_caller]
pub fn lock_waiting(mutex: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    // Held until this returns, and withdrawn by its `Drop`.
    let mut waiting: Option<Waiting> = None;
    loop {
        match mutex.try_lock() {
            Ok(guard) => return guard,
            Err(TryLockError::Poisoned(e)) => return e.into_inner(),
            Err(TryLockError::WouldBlock) => {
                waiting.get_or_insert_with(|| Waiting::register(key_of(mutex)));
                if !crate::platform::pause(LOCK_POLL_INTERVAL) {
                    return lock_blocking(mutex);
                }
            }
        }
    }
}

/// The same rule over an `RwLock` — the shape [`crate::sync::AppState::index`] uses, because
/// every facet request reads it and only a sync or a collection write replaces it.
///
/// Recovering from poisoning matters more here than it looks: `read().ok()` would report a
/// poisoned index as **cold**, which is at least safe, but `write().ok()` would silently drop
/// the publish and leave it cold *forever* — one panic anywhere and the app never faceted
/// again until it was restarted.
///
/// A lock of a state's own, like the connection's, so it is taken through
/// [`crate::platform::alone`] for [`lock_blocking`]'s reason: on a host with one thread, a
/// read asked for while that thread is replacing the value is a trap, and a test standing in
/// for one hears about it.
#[track_caller]
pub fn lock_read<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    crate::platform::alone::read(lock)
}

/// [`lock_read`]'s other half.
#[track_caller]
pub fn lock_write<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    crate::platform::alone::write(lock)
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
///
/// **A caller that has to wait says so, and every background batch loop stands aside for it.**
/// From its first failed `try_lock` until it returns, the ask is registered against this mutex
/// in [`WAITING`], and [`lock_background`] — which every ingest takes the connection through,
/// batch by batch — will not start another batch while it is. That is what makes the wait
/// about one batch however many ingests are running: two loops that take the connection with
/// a blocking `lock()` hand it straight to each other, because whichever is not writing is
/// already parked when the other lets go, and a `try_lock` poll never finds it free (issue
/// #551, and `a_bounded_asker_gets_its_turn_between_two_batch_loops`). A zero timeout never
/// registers, because it never waits.
///
/// **On a host with one thread a contended ask is `None` at once** — nobody but the caller can
/// be holding the lock, and it will not let go while this polls. ⚠️ Most callers drop their
/// work on `None` (an `error_log` row, a stamp, a flush), so there a self-contended ask is a
/// write that silently never happens. A test standing in for such a host
/// ([`crate::platform::alone`]) is told instead: the contended arm panics with the line that
/// asked, which is what `#[track_caller]` is here for.
#[track_caller]
pub fn lock_for(
    mutex: &Mutex<Connection>,
    timeout: Duration,
) -> Option<MutexGuard<'_, Connection>> {
    let started = Tick::now();
    // Held until this returns, the lock or `None` alike, and withdrawn by its `Drop`.
    let mut waiting: Option<Waiting> = None;
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Some(guard),
            Err(TryLockError::Poisoned(e)) => return Some(e.into_inner()),
            Err(TryLockError::WouldBlock) => {
                // A test standing in for a host with one thread: the holder is the caller.
                crate::platform::alone::refuse_held("a connection, with a bound");
                if started.elapsed() >= timeout {
                    return None;
                }
                waiting.get_or_insert_with(|| Waiting::register(key_of(mutex)));
                // A host with no second thread has nobody to wait for: the lock is held by
                // this thread's own caller, and it will not be let go while this one polls.
                if !crate::platform::pause(LOCK_POLL_INTERVAL) {
                    return None;
                }
            }
        }
    }
}

/// The bounded asks ([`lock_for`]) waiting on each connection right now, as `(mutex address,
/// count)`.
///
/// **Keyed on the mutex, not global**, because the test suite runs hundreds of connections in
/// one process: a single counter would make every ingest test pause whenever any other test
/// waited on its own connection. The app has one write connection, so in the shipped build
/// this is one entry or none. A `Vec` because it is never longer than the number of
/// connections being waited on at once.
static WAITING: Mutex<Vec<(usize, usize)>> = Mutex::new(Vec::new());

/// How long [`lock_background`] will stand aside before it takes its turn anyway.
///
/// A cap rather than an unbounded deference, so a steady stream of asks — or one that never
/// withdraws — cannot park an ingest for good. [`WRITE_LOCK_WAIT`] because no user-facing ask
/// waits longer than that, so a loop that has stood aside this long is no longer standing aside
/// *for* anyone who is still going to get an answer.
const BACKGROUND_DEFERENCE_CAP: Duration = WRITE_LOCK_WAIT;

/// How often [`lock_background`] looks again while it stands aside. Well under
/// [`LOCK_POLL_INTERVAL`], so a loop resumes promptly once the ask it deferred to is served.
const BACKGROUND_DEFERENCE_POLL: Duration = Duration::from_millis(5);

fn key_of(mutex: &Mutex<Connection>) -> usize {
    mutex as *const Mutex<Connection> as usize
}

/// One registered ask in [`WAITING`], withdrawn when it is dropped.
struct Waiting(usize);

impl Waiting {
    fn register(key: usize) -> Waiting {
        let mut waiting = lock_plain(&WAITING);
        match waiting.iter_mut().find(|(k, _)| *k == key) {
            Some((_, n)) => *n += 1,
            None => waiting.push((key, 1)),
        }
        Waiting(key)
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        let mut waiting = lock_plain(&WAITING);
        if let Some(i) = waiting.iter().position(|(k, _)| *k == self.0) {
            waiting[i].1 -= 1;
            if waiting[i].1 == 0 {
                waiting.swap_remove(i);
            }
        }
    }
}

fn someone_is_waiting(key: usize) -> bool {
    lock_plain(&WAITING).iter().any(|(k, _)| *k == key)
}

/// Take the write connection for **one batch of background work**, after any bounded ask
/// already waiting on it has had its turn.
///
/// Every loop that writes a feed into staging a batch at a time takes the connection through
/// here — the card ingest, both tag ingests and the combos — and a user-facing write takes it
/// through [`lock_for`]. The two halves are the whole of the priority rule: while a
/// [`lock_for`] is waiting, no batch loop starts another batch, so the ask is served when the
/// batch in hand commits rather than whenever it happens to catch the connection free. Without
/// it, three ingests running together (the launch fetches both tag files and the combos at
/// once) left a collection edit "busy" after its five seconds, and the price feed's `store`,
/// which asks the same way, dropped a 63.7 MiB download it had already paid for.
///
/// Background work waiting on background work is unchanged: this blocks like
/// [`lock_blocking`] once no ask is waiting, and two ingests share the connection exactly as
/// they did. The deference is capped at [`BACKGROUND_DEFERENCE_CAP`].
#[track_caller]
pub fn lock_background(mutex: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    let key = key_of(mutex);
    let started = Tick::now();
    while someone_is_waiting(key) && started.elapsed() < BACKGROUND_DEFERENCE_CAP {
        if !crate::platform::pause(BACKGROUND_DEFERENCE_POLL) {
            break;
        }
    }
    lock_blocking(mutex)
}

/// Fold the write-ahead log back into the database and truncate the `-wal` file to zero.
///
/// Best-effort by contract: the caller runs this on the way out, and there is nothing
/// useful to do about a failure at that point — the WAL is a valid, recoverable journal
/// either way, and the next launch replays it. See the exit handler in `lib.rs`.
pub fn checkpoint_truncate(conn: &Connection) -> rusqlite::Result<()> {
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
}

/// Run `f` inside a `SAVEPOINT` named `name`: released when it succeeds, rolled back to when it
/// fails, so its writes land together or not at all.
///
/// **A savepoint rather than a transaction because it nests.** Outside any transaction it behaves
/// as `BEGIN … COMMIT`; inside a caller's it is a step that caller can still roll back. So a
/// write whose several statements must agree — a change and the `activity` row describing it
/// (issue #550) — can be made atomic here without changing what it does when a bulk caller has
/// already opened a transaction around it.
///
/// A rollback that itself fails leaves the error `f` raised as the answer, and if this call was
/// the one that opened the transaction, a plain `ROLLBACK` follows: a savepoint left open on an
/// autocommit connection would quietly swallow every later write into a transaction nothing
/// commits.
pub fn in_savepoint<T>(
    conn: &Connection,
    name: &str,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let outermost = conn.is_autocommit();
    conn.execute_batch(&format!("SAVEPOINT {name}"))
        .map_err(|e| e.to_string())?;
    match f() {
        Ok(value) => match conn.execute_batch(&format!("RELEASE {name}")) {
            Ok(()) => Ok(value),
            Err(e) => {
                abandon(conn, name, outermost);
                Err(e.to_string())
            }
        },
        Err(e) => {
            abandon(conn, name, outermost);
            Err(e)
        }
    }
}

/// Undo an [`in_savepoint`] whose body or release failed, and make sure it leaves no transaction
/// open that it opened itself.
fn abandon(conn: &Connection, name: &str, outermost: bool) {
    let _ = conn.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"));
    if outermost && !conn.is_autocommit() {
        let _ = conn.execute_batch("ROLLBACK");
    }
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

        let started = Tick::now();
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
        let started = Tick::now();
        assert!(lock_for(&mutex, Duration::ZERO).is_none());
        assert!(
            started.elapsed() < LOCK_POLL_INTERVAL,
            "a zero timeout must not sleep, and took {:?}",
            started.elapsed()
        );
    }

    /// **Two batch loops at once hand the connection straight to each other, so a bounded asker
    /// needs them to stand aside for it** (issue #551). The loops are the ingests' shape with the parsing taken
    /// out — take the connection, hold it for a batch, let go, stand aside five milliseconds —
    /// and the batch is the ~15 ms the tag ingest's own comment measures. One such loop leaves a
    /// 5 ms gap a 20 ms poll lands in within a few tries; with two, whichever is not writing is
    /// already parked in `lock()` when the other lets go, so there is no gap at all.
    ///
    /// Synthetic on purpose: a real ingest's parse happens with no lock held, so whether two of
    /// them saturate the connection depends on how fast this machine parses JSON against how
    /// fast it commits — a debug build on a RAM disk parses slowly enough to leave gaps (the
    /// real-ingest version of this test, `tags::tests::
    /// a_bounded_writer_gets_its_turn_while_two_ingests_run_at_once`, measured a worst wait of
    /// ~400 ms over a 4.5 s overlap on Linux), a release build writing to a real disk does not.
    /// This holds the lock discipline to account independent of either.
    ///
    /// Measured on Linux (debug) with the loops on `lock_blocking`, before [`lock_background`]
    /// existed: five of ten `lock_for(2 s)` asks across two runs were told busy, and the rest
    /// waited 0.3–2 s. Through [`lock_background`] every ask was served in 20–44 ms.
    #[test]
    fn a_bounded_asker_gets_its_turn_between_two_batch_loops() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let mutex = Mutex::new(Connection::open_in_memory().unwrap());
        let stop = AtomicBool::new(false);
        let mut asks: Vec<(Duration, bool)> = Vec::new();
        std::thread::scope(|scope| {
            for _ in 0..2 {
                scope.spawn(|| {
                    while !stop.load(Ordering::SeqCst) {
                        let batch = lock_background(&mutex);
                        std::thread::sleep(Duration::from_millis(15));
                        drop(batch);
                        std::thread::sleep(Duration::from_millis(5));
                    }
                });
            }
            // Both loops are running before the first ask.
            std::thread::sleep(Duration::from_millis(60));
            for _ in 0..5 {
                let asked = Tick::now();
                let got = lock_for(&mutex, Duration::from_secs(2)).is_some();
                asks.push((asked.elapsed(), got));
                std::thread::sleep(Duration::from_millis(10));
            }
            stop.store(true, Ordering::SeqCst);
        });

        let worst = asks.iter().map(|(w, _)| *w).max().unwrap_or_default();
        assert!(
            asks.iter().all(|(_, got)| *got),
            "an asker was told busy between two batch loops: {asks:?}"
        );
        assert!(
            worst < Duration::from_millis(500),
            "an asker waited {worst:?} between two 15 ms batch loops: {asks:?}"
        );
    }

    /// **And so does a wait with no bound** — a sync operation's stretch, which registers while
    /// it waits as a bounded ask does, so the batch loops stand aside for it.
    #[test]
    fn a_waiting_ask_gets_its_turn_between_two_batch_loops() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let mutex = Mutex::new(Connection::open_in_memory().unwrap());
        let stop = AtomicBool::new(false);
        let mut waits: Vec<Duration> = Vec::new();
        std::thread::scope(|scope| {
            for _ in 0..2 {
                scope.spawn(|| {
                    while !stop.load(Ordering::SeqCst) {
                        let batch = lock_background(&mutex);
                        std::thread::sleep(Duration::from_millis(15));
                        drop(batch);
                        std::thread::sleep(Duration::from_millis(5));
                    }
                });
            }
            std::thread::sleep(Duration::from_millis(60));
            for _ in 0..5 {
                let asked = Tick::now();
                drop(lock_waiting(&mutex));
                waits.push(asked.elapsed());
                std::thread::sleep(Duration::from_millis(10));
            }
            stop.store(true, Ordering::SeqCst);
        });
        let worst = waits.iter().max().copied().unwrap_or_default();
        assert!(
            worst < Duration::from_millis(500),
            "a waiting ask waited {worst:?} between two 15 ms batch loops: {waits:?}"
        );
        assert!(
            !someone_is_waiting(key_of(&mutex)),
            "an ask that was served is still registered"
        );
    }

    /// A scratch directory of its own per test — these all touch real files, and the
    /// suite runs them in parallel.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = crate::scratch::path(&format!("db-{name}"));
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

    /// SQLite's answer to `journal_mode = WAL` is read, not assumed: a file gets WAL, and an
    /// in-memory database — which cannot — says `memory`. A browser's pool says `delete` for
    /// the same kind of reason, and its host reports the word.
    #[test]
    fn the_journal_a_schema_got_is_what_sqlite_answered() {
        let dir = scratch("journal");
        let conn = Connection::open(dir.join("t.db")).unwrap();
        assert_eq!(apply_pragmas(&conn, None).unwrap(), Journal::Wal);
        assert_eq!(attach_corpus(&conn, &dir).unwrap(), Journal::Wal);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);

        let memory = Connection::open_in_memory().unwrap();
        assert_eq!(apply_pragmas(&memory, None).unwrap(), Journal::Memory);

        assert_eq!(Journal::parse("DELETE"), Journal::Delete);
        assert_eq!(Journal::parse("truncate"), Journal::Other);
        for journal in [Journal::Wal, Journal::Delete, Journal::Memory] {
            assert_eq!(Journal::parse(journal.as_str()), journal);
        }
        assert_eq!(Journal::Other.as_str(), "other");
    }

    /// Every pragma a connection and its two files carry, in one row — what "the same pragmas"
    /// means when two openers are compared.
    fn pragmas(conn: &Connection) -> Vec<(String, String)> {
        [
            "main.journal_mode",
            "corpus.journal_mode",
            "main.auto_vacuum",
            "corpus.auto_vacuum",
            "main.synchronous",
            "corpus.synchronous",
            "main.journal_size_limit",
            "corpus.journal_size_limit",
            "foreign_keys",
            "busy_timeout",
        ]
        .into_iter()
        .map(|name| {
            let value = conn
                .query_row(&format!("PRAGMA {name}"), [], |r| {
                    r.get::<_, rusqlite::types::Value>(0)
                })
                .unwrap();
            (name.to_owned(), format!("{value:?}"))
        })
        .collect()
    }

    /// **The one-connection opener is `open_write` plus what it reports and one pragma.** The
    /// pair, the file pragmas on both halves and the two on the connection are the same row for
    /// row; what differs is `temp_store`, and that the journals come back.
    #[test]
    fn the_single_opener_sets_what_the_write_opener_sets_and_says_what_it_got() {
        let folder = scratch("single-folder");
        let pool = scratch("single-pool");

        let write = open_write(&folder).unwrap();
        let single = open_single(&pool).unwrap();
        assert_eq!(pragmas(&single.conn), pragmas(&write));
        // A file on this machine can have WAL, so that is what was asked for and what came back.
        assert_eq!(single.journal, Journal::Wal);
        assert_eq!(single.corpus_journal, Journal::Wal);

        let temp_store = |conn: &Connection| -> i64 {
            conn.query_row("PRAGMA temp_store", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(temp_store(&single.conn), 1, "temp_store must be FILE (1)");
        assert_eq!(
            temp_store(&write),
            0,
            "a host with a folder is left on SQLite's default, as it always was"
        );

        // One connection over both files: an unqualified name reaches the attached one.
        single
            .conn
            .execute_batch(
                "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('user');
                 CREATE TABLE corpus.u (v TEXT); INSERT INTO u VALUES ('corpus');",
            )
            .unwrap();
        let both: (String, String) = single
            .conn
            .query_row("SELECT t.v, u.v FROM t, u", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(both, ("user".to_owned(), "corpus".to_owned()));

        drop(write);
        drop(single);
        assert!(pool.join(USER_DB).is_file() && pool.join(CORPUS_DB).is_file());
        let _ = std::fs::remove_dir_all(&folder);
        let _ = std::fs::remove_dir_all(&pool);
    }

    /// **A pool's names are bare**, so the host passes an empty path — and joined to nothing,
    /// the two names are the two names.
    #[test]
    fn an_empty_place_names_the_two_files_bare() {
        assert_eq!(Path::new("").join(USER_DB), Path::new("user.db"));
        assert_eq!(Path::new("").join(CORPUS_DB).to_string_lossy(), "corpus.db");
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

    fn saved(conn: &Connection) -> Vec<i64> {
        let mut stmt = conn.prepare("SELECT v FROM t ORDER BY v").unwrap();
        let out = stmt.query_map([], |r| r.get(0)).unwrap();
        out.map(Result::unwrap).collect()
    }

    /// Issue #550: a write and the row describing it land together or not at all, whether or
    /// not a caller already holds a transaction — and a failure never leaves one open.
    #[test]
    fn a_savepoint_keeps_its_writes_together_and_nests_inside_a_callers_transaction() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (v INTEGER)").unwrap();

        let failed: Result<(), String> = in_savepoint(&conn, "sp", || {
            conn.execute("INSERT INTO t VALUES (1)", []).unwrap();
            Err("the second statement failed".into())
        });
        assert!(failed.is_err());
        assert!(
            saved(&conn).is_empty(),
            "the first write rolled back with the second"
        );
        assert!(conn.is_autocommit(), "no transaction was left open");

        in_savepoint(&conn, "sp", || {
            conn.execute("INSERT INTO t VALUES (2)", [])
                .map_err(|e| e.to_string())
        })
        .unwrap();
        assert_eq!(saved(&conn), vec![2]);
        assert!(
            conn.is_autocommit(),
            "an outermost savepoint commits on release"
        );

        // Inside a caller's transaction the savepoint is a step: its failure undoes only itself,
        // and the caller still decides the rest.
        conn.execute_batch("BEGIN; INSERT INTO t VALUES (3);")
            .unwrap();
        let _ = in_savepoint(&conn, "sp", || -> Result<(), String> {
            conn.execute("INSERT INTO t VALUES (4)", []).unwrap();
            Err("no".into())
        });
        assert!(
            !conn.is_autocommit(),
            "the caller's transaction is still the caller's"
        );
        conn.execute_batch("ROLLBACK").unwrap();
        assert_eq!(saved(&conn), vec![2]);
    }
}
