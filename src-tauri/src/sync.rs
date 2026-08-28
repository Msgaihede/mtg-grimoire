//! Sync orchestrator: the one place that decides whether to talk to Scryfall, and
//! drives check → download → ingest → sets → reconcile as a single supervised run.
//!
//! Three rules shape everything here:
//!
//! * **One sync at a time.** `syncing` is claimed with an atomic swap and released by
//!   an RAII guard, so an early return, an error, a panic, or a cancelled future all
//!   leave the flag clear. A stuck flag would lock the user out of syncing until they
//!   restart the app.
//! * **The database lock is never held across an `.await`.** A `MutexGuard` is `!Send`
//!   (holding one across an await would not even compile for a spawned future), and a
//!   lock held for the length of a 77 MB download would block every writer. Locks live
//!   in short synchronous scopes only. The one long blocking operation, the ingest, runs
//!   on a [`tauri::async_runtime::spawn_blocking`] thread and takes the lock itself, one
//!   batch at a time — this module hands it the mutex, never a guard.
//! * **The expensive work is paid for once.** The 77 MB download is the costly step, so
//!   the metadata that makes the *next* check cheap (`bulk_etag`, `bulk_updated_at`) is
//!   written as soon as the ingest succeeds — before `/sets` is even called. A later
//!   failure then costs a retry of the cheap part only, and [`finish_unchanged`] picks
//!   `/sets` back up on the next run so that retry actually happens.
//! * **A run that failed leaves no trace that it succeeded.** `last_check_at` is written
//!   only on the paths that return `Ok`. Stamping it right after the check — before the
//!   download and ingest that can still fail — would let one dead download throttle
//!   every *automatic* retry for 24 h, and the app has no other way to start one.
//!
//! Failures are also *persisted*, to `last_error`. A sync spawned at startup emits its
//! `sync:progress` events within milliseconds, before the webview has registered a
//! listener, and Tauri drops events that nobody is listening for — so the event is the
//! fast path, and `sync_meta` is the one the UI can still read a minute later.
//!
//! `sync_meta.value` is `NOT NULL`, so this module never writes an absent value as
//! NULL or as `""`: [`set_meta_opt`] deletes the row instead. See [`get_meta`].

use crate::{ingest, scryfall};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

/// `sync_meta` keys. Named constants because they are also read by `sync_status` and,
/// via the DTOs below, mirrored in the frontend.
const K_BULK_ETAG: &str = "bulk_etag";
const K_BULK_UPDATED_AT: &str = "bulk_updated_at";
const K_LAST_CHECK_AT: &str = "last_check_at";
const K_LAST_INGEST_AT: &str = "last_ingest_at";
const K_CARD_COUNT: &str = "card_count";
/// Lines the last ingest could not read as cards. Scryfall's bulk file has shipped
/// truncated lines and non-card objects before; the spec requires the count be *surfaced*
/// rather than swallowed, because a number climbing from 3 to 30 000 is the difference
/// between a stray token and a schema change that is quietly costing the user cards.
const K_LAST_INGEST_SKIPPED: &str = "last_ingest_skipped";
/// Why the last run failed, or no row at all if it did not. Survives the process, which
/// the `sync:progress` event does not.
const K_LAST_ERROR: &str = "last_error";

/// Where a 429 lockout is remembered, as unix seconds.
///
/// **`app_meta`, not `sync_meta`.** The lockout belongs to the *application* — Scryfall
/// limits an application, not a sync — and it is read at startup, before any sync has run.
/// The same separation the updater's two keys make, for the same reason.
pub const K_SCRYFALL_PENALTY_UNTIL: &str = "scryfall_penalty_until";

/// How long an update check stays fresh. Scryfall rebuilds the bulk files roughly
/// daily, and the app must not poll the API on every launch.
const CHECK_INTERVAL_SECS: u64 = 86_400;

/// Approximate row count of `default_cards`, used only as the denominator of the
/// ingest progress bar — the real count is not known until the ingest is finished.
const INGEST_TOTAL_ESTIMATE: u64 = 117_000;

/// Bytes of download between `sync:progress` events. The client's own callback fires
/// once per network chunk (thousands of times over 77 MB), which is far more than a
/// progress bar can use.
const DOWNLOAD_EMIT_BYTES: u64 = 1_000_000;

/// Everything a command or a background sync needs. Managed by Tauri as
/// `Arc<AppState>` so a spawned sync can own a handle of its own.
///
/// Two connections to one file, deliberately. `db` is the only one that writes, and every
/// writer shares it — the ingest included, which is why it takes the lock a batch at a
/// time rather than for its whole run. `db_read` is opened read-only so searches and
/// status polls answer from the last committed WAL snapshot without queueing behind any
/// writer at all. See [`crate::db::open_read_only`].
pub struct AppState {
    pub db: Mutex<Connection>,
    pub db_read: Mutex<Connection>,
    pub data_dir: PathBuf,
    pub syncing: AtomicBool,
    pub client: scryfall::Client,
    /// The image cache. Lives here so the `mtgimg://` handler can reach it from an
    /// `AppHandle` — that handle is the only state the handler is given.
    pub images: crate::images::Cache,
    /// The in-memory facet index and the generation of the corpus it describes — cold, which
    /// is a supported state and not an error, until the first build lands. Read it through
    /// [`crate::index::lifecycle::current`]; everything else about it is that module's.
    ///
    /// `RwLock` and not `Mutex`: every facet request reads it and only a sync or a collection
    /// write replaces it. The `Arc` inside is so a reader clones the handle and lets the lock
    /// go at once — a facet pass must never hold a lock a sync's rebuild is waiting on.
    pub index: std::sync::RwLock<crate::index::lifecycle::IndexSlot>,
    /// What the plain-text mirror still owes the disk, as three bits.
    ///
    /// An `Arc` and not a plain field because the update hook on `db` holds a clone of it for
    /// the life of the process — see [`crate::mirror::watch::install_hook`]. Written from
    /// inside SQLite's own callback and read by the mirror thread; no lock is involved either
    /// way, which is the point.
    pub mirror: Arc<crate::mirror::watch::Mask>,
    /// What the mirror's last pass did, for the Settings panel to read back.
    ///
    /// In memory rather than in the database, deliberately: the numbers describe a folder
    /// that may not survive a restart, and a count read back after one would be a claim about
    /// a disk nobody has looked at since. See [`crate::mirror::watch::LastPass`].
    pub mirror_status: Mutex<crate::mirror::watch::LastPass>,
    /// Whether any transaction on `db` has committed across both files.
    ///
    /// An `Arc` for [`AppState::mirror`]'s reason and by the same mechanism: the update hook
    /// on `db` holds a clone of it for the life of the process, because the two share that
    /// hook — SQLite allows one per connection. See [`crate::db::CrossFileFence`], which also
    /// names what it cannot see.
    pub fence: Arc<crate::db::CrossFileFence>,
}

/// Result of a sync run. `updated_at` is `Some` only when `updated` is true, so a
/// caller can never mistake stale metadata for freshly ingested data.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub updated: bool,
    pub card_count: i64,
    pub updated_at: Option<String>,
}

/// What the UI polls.
///
/// `syncing`, `data_dir` and `image_store_failures` are always answered — none of them
/// needs the database. The five database-derived fields are `None` only when the read-only
/// connection could not be used at all — not, as they once were, for the whole of every
/// ingest (see [`status`]). `None` there means "not readable right now", never "zero"; a UI
/// should keep showing its last value rather than render an empty collection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub card_count: Option<i64>,
    /// Unix seconds, as a string (see [`unix_now`]).
    pub last_check_at: Option<String>,
    pub bulk_updated_at: Option<String>,
    /// Why the last run failed. Cleared by the next run that gets anywhere.
    pub last_error: Option<String>,
    /// Lines the last ingest skipped. `None` before any ingest has run (and, like the
    /// fields above, whenever the database could not be read).
    pub last_ingest_skipped: Option<i64>,
    pub data_dir: String,
    pub syncing: bool,
    /// Card images fetched successfully and then refused by the filesystem this process
    /// run — a read-only data folder, a full disk (see [`crate::images::Cache`]).
    ///
    /// Not an `Option`: it is a process counter, not a database read, so there is no state
    /// in which it cannot be answered. It resets with the app because the failures it
    /// counts are about *this* run's data folder; a stale count carried across restarts
    /// would report a disk that has since been emptied.
    ///
    /// Surfaced because the counter existed for a whole plan with nothing reading it, and
    /// the condition it reports is otherwise invisible: images still *display* (the bytes
    /// are in hand), they simply are never cached, so the only symptom is a grid that
    /// re-downloads itself forever.
    pub image_store_failures: u64,
}

/// Every value [`Progress::phase`] takes, in the order a run that does all of them
/// produces them.
///
/// Mirrored by hand on the other side of the IPC boundary — `SyncPhase` in
/// `src/lib/ipc.ts`, and `PHASE_LABEL` in `src/lib/useSyncProgress.ts`, which must have an
/// entry for each or the mana line renders `undefined`. Pinned here by
/// `the_progress_phases_are_the_ones_the_frontend_mirrors` and there by
/// `useSyncProgress.test.ts`.
pub const PHASES: [&str; 8] = [
    "checking",
    "downloading",
    "ingesting",
    "reclaiming",
    "sets",
    "compacting",
    "done",
    "error",
];

/// Payload of the `sync:progress` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// One of [`PHASES`].
    pub phase: String,
    pub done: u64,
    pub total: u64,
    pub message: Option<String>,
}

impl Progress {
    fn new(phase: &str, done: u64, total: u64) -> Progress {
        // The frontend's `SyncPhase` is a closed union and `PHASE_LABEL` a total map over
        // it, so a phase that is not in [`PHASES`] renders as `undefined` under the mana
        // line and fails nothing else. Debug-only: a typo'd phase is a cosmetic bug, never
        // worth killing a sync over in a shipped build.
        debug_assert!(PHASES.contains(&phase), "unknown sync phase `{phase}`");
        Progress {
            phase: phase.to_owned(),
            done,
            total,
            message: None,
        }
    }

    fn error(message: String) -> Progress {
        Progress {
            phase: "error".to_owned(),
            done: 0,
            total: 0,
            message: Some(message),
        }
    }
}

/// Read `sync_meta`. A missing row and an unreadable one both read as `None`: this is
/// cache metadata, and the correct response to losing it is to check again.
pub fn get_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM sync_meta WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Write-or-delete. `sync_meta.value` is `NOT NULL`, so an absent value is stored as
/// the absence of the row — never as NULL, and never as `""`, which for an ETag would
/// mean replaying an `If-None-Match` header that can only fail to match.
pub fn set_meta_opt(conn: &Connection, key: &str, value: Option<&str>) -> rusqlite::Result<()> {
    match value.filter(|v| !v.is_empty()) {
        Some(v) => set_meta(conn, key, v),
        None => {
            conn.execute("DELETE FROM sync_meta WHERE key = ?1", params![key])?;
            Ok(())
        }
    }
}

/// Should this run talk to the API at all?
///
/// `force` always wins. Otherwise the check is due once [`CHECK_INTERVAL_SECS`] have
/// passed. A `last` in the future — a clock that moved backwards, a hand-edited value —
/// counts as due rather than underflowing the subtraction or throttling until the wall
/// clock catches up.
pub fn should_check(last: Option<u64>, now: u64, force: bool) -> bool {
    force || last.is_none_or(|l| l > now || now - l >= CHECK_INTERVAL_SECS)
}

/// Does this 200 describe the file that is already in the database?
///
/// The bulk endpoint answers 200 whenever the stored ETag does not match — including
/// when there is no stored ETag because a proxy stripped it, or an earlier run never got
/// one. `updated_at` is then the only evidence of whether the file actually rotated, and
/// re-downloading 77 MB to re-ingest the same rows is the failure this avoids.
///
/// `card_count > 0` is not a detail: metadata can outlive the cards it describes (an
/// interrupted first run, a swapped-in staging table that never landed), and an empty
/// database must download no matter what the metadata claims.
fn already_ingested(remote: Option<&str>, stored: Option<&str>, card_count: i64) -> bool {
    remote.is_some() && remote == stored && card_count > 0
}

/// The ETag to replay as `If-None-Match`, or `None` to force a full answer.
///
/// The stored ETag describes a *file*, not the state of this database, and the two come
/// apart: an interrupted first run, or a swap that never landed, leaves the metadata of a
/// bulk file behind with no cards to show for it. Replaying that ETag then earns a 304 —
/// "you already have this" — for a database that has nothing, and no amount of Refresh
/// can get past it, because every run asks the same unanswerable question. Sending no
/// ETag costs one 200 and a fresh download, which is exactly what an empty database wants.
///
/// This is the same reasoning as [`already_ingested`]'s `card_count > 0`, one step
/// earlier: that one guards the 200 path, this one stops the 304 happening at all.
fn conditional_etag(etag: Option<&str>, card_count: i64) -> Option<&str> {
    etag.filter(|_| card_count > 0)
}

/// The size the download will be verified against.
///
/// A listing with no size gives the download nothing to check itself against; the client
/// would fetch the whole file and then reject it as a mismatch against zero. Refuse
/// before spending the bandwidth, and say why.
fn check_download_size(compressed_size: u64) -> Result<u64, String> {
    if compressed_size == 0 {
        return Err("bulk listing had no size; refusing to download".into());
    }
    Ok(compressed_size)
}

/// Seconds since the Unix epoch. A clock before 1970 is not worth a panic: it reads as
/// 0, which makes every check due.
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// What a sync run reads out of the database before it does anything else.
struct StoredState {
    etag: Option<String>,
    bulk_updated_at: Option<String>,
    last_check: Option<u64>,
    card_count: i64,
}

fn read_stored_state(conn: &Connection) -> StoredState {
    StoredState {
        etag: get_meta(conn, K_BULK_ETAG),
        bulk_updated_at: get_meta(conn, K_BULK_UPDATED_AT),
        // An unparseable timestamp reads as "never checked": throttling on a value that
        // can never be compared would stall the sync permanently.
        last_check: get_meta(conn, K_LAST_CHECK_AT).and_then(|s| s.parse::<u64>().ok()),
        card_count: count_cards(conn),
    }
}

fn count_cards(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
        .unwrap_or(0)
}

/// Has `sets` never been filled? A failed count reads as "not empty" — if the database
/// cannot answer, a `/sets` fetch it cannot store either is not the fix.
fn sets_are_empty(conn: &Connection) -> bool {
    conn.query_row("SELECT count(*) FROM sets", [], |r| r.get::<_, i64>(0))
        .map(|n| n == 0)
        .unwrap_or(false)
}

/// Bookkeeping shared by every path that returns `Ok` after actually checking: the
/// check is fresh, and whatever failed last time no longer stands.
///
/// Deliberately *not* called on the throttled short-circuit — that run checked nothing,
/// and clearing `last_error` there would erase a failure the user never got to see.
fn mark_checked(conn: &Connection, now: u64) -> rusqlite::Result<()> {
    set_meta(conn, K_LAST_CHECK_AT, &now.to_string())?;
    set_meta_opt(conn, K_LAST_ERROR, None)
}

/// The outcome of a run that changed nothing.
fn unchanged(card_count: i64) -> SyncOutcome {
    SyncOutcome {
        updated: false,
        card_count,
        updated_at: None,
    }
}

/// Lock the database, recovering from a poisoned mutex.
///
/// Poisoning means some other thread panicked while holding the lock; the `Connection`
/// itself survives that (rusqlite rolls an open transaction back as it unwinds), so
/// refusing to lock ever again would brick every later sync and search for no gain.
///
/// Shared with [`crate::search`] so that recovery rule lives in exactly one place.
pub(crate) fn lock_db(state: &AppState) -> MutexGuard<'_, Connection> {
    lock_conn(&state.db)
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
pub(crate) fn lock_db_read(state: &AppState) -> MutexGuard<'_, Connection> {
    lock_conn(&state.db_read)
}

/// Run `f` with the write connection, or answer [`crate::db::BUSY`].
///
/// Bounded rather than blocking: every caller is a button press on a worker thread, and the
/// one thing that can hold `AppState.db` for any length of time is a sync — which, since the
/// ingest was chunked, holds it for one batch at a time.
///
/// **This is the one definition of that rule**, the way [`crate::db::lock_plain`] is the one
/// definition of poison recovery. It was five identical private copies (`collection`, `deck`,
/// `deck_meta`, `deck_theory`, `wishlist`) plus six sites that inlined the same four lines,
/// each documented as "kept per-module the way every other one in this crate is" — which was
/// true, and was the problem.
///
/// Here rather than in [`crate::db`] because the parameter is [`AppState`]: `db` is the layer
/// below and must not learn about the app's state. `&AppState` rather than `&Arc<AppState>`
/// so that both shapes of caller fit — a command holding an `Arc` gets deref coercion for
/// free, and [`crate::index::lifecycle`], which holds a bare reference, needs no clone.
///
/// **Never call this while holding a guard on `state.db`** — it does not deadlock, because
/// [`crate::db::lock_for`] is a `try_lock`-plus-sleep loop rather than a blocking one, but a
/// same-thread reentrant call spends the whole [`crate::db::WRITE_LOCK_WAIT`] failing to
/// take a lock its own thread already holds, then answers [`crate::db::BUSY`] against itself.
/// `do_sync`'s orphan-sweep arm is the site that has to remember: it passes its already-open
/// connection down instead.
pub(crate) fn with_write<T>(
    state: &AppState,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let out = match crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        Some(conn) => f(&conn),
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

/// Upsert `sets`, returning how many rows were written.
///
/// Rows with a blank `code` are skipped: `code` is the primary key, and SQLite would
/// happily store `''` as a real set that nothing can ever match.
pub fn insert_sets(conn: &mut Connection, sets: &[scryfall::SetRow]) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let mut written = 0usize;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO sets
                (code, name, arena_code, mtgo_code, set_type, released_at, icon_svg_uri)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
        )?;
        for s in sets {
            if s.code.trim().is_empty() {
                continue;
            }
            stmt.execute(params![
                s.code,
                s.name,
                s.arena_code,
                s.mtgo_code,
                s.set_type,
                s.released_at,
                s.icon_svg_uri,
            ])?;
            written += 1;
        }
    }
    tx.commit()?;
    Ok(written)
}

fn emit(app: &tauri::AppHandle, phase: &str, done: u64, total: u64) {
    // A dropped progress event is never worth failing a sync over.
    let _ = app.emit("sync:progress", Progress::new(phase, done, total));
}

/// The terminal event. Every path that leaves `do_sync` successfully sends one, so the
/// UI is never left showing a phase that has already finished.
///
/// `skipped` is `Some` only on the path that actually ingested — a run that found nothing
/// new has no lines of its own to report, and repeating the previous run's figure would
/// read as a fresh count.
fn emit_done(app: &tauri::AppHandle, card_count: i64, skipped: Option<u64>) {
    let n = card_count.max(0) as u64;
    let mut progress = Progress::new("done", n, n);
    progress.message = Some(done_message(n, skipped));
    let _ = app.emit("sync:progress", progress);
}

/// What the `done` event says. The skipped clause appears only when there is something
/// to report — "(0 lines skipped)" is noise on the run where everything went right.
fn done_message(card_count: u64, skipped: Option<u64>) -> String {
    let cards = format!("{} cards", group_digits(card_count));
    match skipped {
        Some(n) if n > 0 => format!(
            "{cards} ({} {} skipped)",
            group_digits(n),
            if n == 1 { "line" } else { "lines" }
        ),
        _ => cards,
    }
}

/// `116568` → `116,568`. The UI formats its own numbers, but this string is carried by
/// the event and has nowhere else to be formatted.
fn group_digits(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Clears `syncing` however the run ends — early return, error, panic, or a dropped
/// future. A flag left set would lock the user out of syncing until they restart.
struct SyncingGuard<'a>(&'a AtomicBool);

impl Drop for SyncingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Run one sync, refusing to start a second while one is in flight.
///
/// A failure is reported three ways because no one of them is reliable on its own: it is
/// returned to the caller (there is none for the sync spawned at startup), emitted as a
/// `sync:progress` event with phase `error` (Tauri drops events the webview is not yet
/// listening for, which at startup is all of them), and written to `sync_meta.last_error`
/// (which is still there whenever the UI gets around to asking).
pub async fn run_sync(
    state: Arc<AppState>,
    app: tauri::AppHandle,
    force: bool,
) -> Result<SyncOutcome, String> {
    if state.syncing.swap(true, Ordering::SeqCst) {
        // Returned without a progress event, and without touching `last_error`, on
        // purpose: the sync already in flight is the one driving `sync:progress`, and
        // recording this as *its* failure would be a lie about a run that is still going.
        return Err("sync already running".into());
    }
    let _guard = SyncingGuard(&state.syncing);

    let result = do_sync(&state, &app, force).await;
    // Unconditionally, and before the error funnel below: a 429 can be earned on a path that
    // *succeeds* overall — `reconcile_ids` logs its failure and returns — so keying this off
    // `Err` would drop exactly the lockouts nobody else records. An upsert of one integer is
    // not worth being clever about.
    persist_penalty(&state);
    note_mirror_after_sync(&state, &result);
    if let Err(e) = &result {
        {
            let conn = lock_db(&state);
            let _ = set_meta_opt(&conn, K_LAST_ERROR, Some(e.as_str()));
        }
        let _ = app.emit("sync:progress", Progress::error(e.clone()));
    }
    result
}

/// Tell the plain-text mirror that a sync finished, if it changed anything.
///
/// One of the four things that run a full mirror pass (spec §5). The update hook cannot carry
/// this: `cards` maps to no surface on purpose, because a sync rewrites 116 700 rows and a
/// per-row mark would be a hundred thousand hook fires and a rebuild every refresh.
///
/// **Gated on `updated`, not on `Ok`.** A throttled run that downloaded nothing changed no card
/// name and no printing, so marking there would spend a full render on every launch of the day
/// over a corpus byte for byte the one the last pass already mirrored. Hash comparison means it
/// would *write* nothing — the render is the cost, and it is avoidable.
///
/// A function rather than four lines inline in [`run_sync`] because [`run_sync`] takes a
/// `tauri::AppHandle` and this crate has no mock-app harness, so nothing in the suite can enter
/// it. This much is reachable, and the condition is the half worth testing; what stays untested
/// is the single call above it.
pub(crate) fn note_mirror_after_sync(state: &AppState, result: &Result<SyncOutcome, String>) {
    if let Ok(outcome) = result {
        if outcome.updated {
            state.mirror.mark_all();
        }
    }
}

/// Note a failed call to Scryfall in the error log.
///
/// Called where the [`scryfall::ScryfallError`] is still in hand, rather than from
/// [`run_sync`]'s funnel, because by the time an error reaches the funnel it is a `String`
/// and its *kind* — the difference between a rate limit and a parse failure, which is the
/// whole of what a reader acts on — has been thrown away.
///
/// Best-effort, and skipped rather than waited for if the write connection is busy: this
/// describes a failure that has already happened, on a path that is already returning an
/// error, and no part of it is worth blocking on.
fn note_scryfall(state: &Arc<AppState>, operation: &str, err: &scryfall::ScryfallError) {
    if let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        crate::errors::record(
            &conn,
            crate::errors::Source::ScryfallApi,
            operation,
            crate::errors::kind_of(err),
            &err.to_string(),
            None,
        );
    }
}

/// Note a failure of the app's own database work — a sweep, a reclaim, a compaction, a failed
/// index build.
///
/// These were `eprintln!` and nothing else, which in a release build is a message with
/// nowhere to go.
///
/// [`crate::errors::Source::Database`] with [`crate::errors::Kind::Io`]: this is the app's own
/// SQLite failing at its own work, and the fix is a disk or a database rather than a query.
/// `index/lifecycle.rs` kept an identical private copy of this until 2026-08-16.
///
/// Best-effort, and skipped rather than waited for if the write connection is busy: it
/// describes a failure that has already happened, on a path that is already returning an
/// error, and no part of it is worth blocking on.
///
/// **Take the write lock here only if you are not already holding it.** A same-thread
/// reentrant call does not deadlock — [`crate::db::lock_for`] is a `try_lock`-plus-sleep loop,
/// not a blocking one — but it spends the whole [`crate::db::WRITE_LOCK_WAIT`] failing to take
/// a lock its own thread already holds, then gives up and silently drops the `error_log` row
/// it was trying to write. `do_sync`'s orphan-sweep arm is the site that has to remember: it
/// has the connection in hand and calls [`crate::errors::record`] directly, because coming
/// through here would waste that whole wait against a lock that scope already holds.
/// `spawn_build` holds nothing, and `collection_source::with_write_owned` releases its guard before
/// calling `invalidate_owned` — which its own doc names as the house rule.
pub(crate) fn note_database(state: &AppState, operation: &str, message: &str) {
    if let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        crate::errors::record(
            &conn,
            crate::errors::Source::Database,
            operation,
            crate::errors::Kind::Io,
            message,
            None,
        );
    }
}

/// Write the client's current lockout deadline to `app_meta`, so a restart cannot shake it
/// off.
///
/// Best-effort throughout: this is bookkeeping about a refusal that has already happened,
/// and failing a sync over it would be absurd.
fn persist_penalty(state: &Arc<AppState>) {
    let until = state.client.penalty_until_unix();
    if let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        let _ = crate::update::set_app_meta(&conn, K_SCRYFALL_PENALTY_UNTIL, &until.to_string());
    }
}

/// Finish a run that found nothing new to ingest.
///
/// The `/sets` backfill is what makes "store the card metadata before fetching sets"
/// safe: `/sets` is otherwise only reached on the download path, so once an ETag is
/// stored every later run is a 304 that skips it, and a `/sets` call that failed during
/// the run which ingested the cards would leave the table empty until Scryfall next
/// rotates the bulk file. A `count(*)` is cheap; a permanently empty `sets` table is not.
async fn finish_unchanged(
    state: &Arc<AppState>,
    app: &tauri::AppHandle,
    now: u64,
    card_count: i64,
) -> Result<SyncOutcome, String> {
    let needs_sets = {
        let conn = lock_db(state);
        sets_are_empty(&conn)
    };
    if needs_sets {
        emit(app, "sets", 0, 0);
        let sets = state
            .client
            .fetch_sets()
            .await
            .inspect_err(|e| note_scryfall(state, "sets", e))
            .map_err(|e| e.to_string())?;
        let mut conn = lock_db(state);
        insert_sets(&mut conn, &sets).map_err(|e| e.to_string())?;
    }

    {
        let conn = lock_db(state);
        mark_checked(&conn, now).map_err(|e| e.to_string())?;
    }
    // On this path too, and that is the point: 304 is the answer most runs get, so a
    // reconcile that only ran after an ingest would run about as often as Scryfall rotates
    // its bulk file — while `/migrations` grows on its own schedule.
    reconcile_ids(state, app).await;
    // Nothing on this path replaced `cards` — that is what "unchanged" means — so the facet
    // index is still true and is deliberately left alone. The one exception is the once-ever
    // conversion, whose `VACUUM` renumbers the rowids the index is made of; it says so, and
    // then this is the rebuild it owes.
    if compact_once(state, app).await {
        crate::index::lifecycle::spawn_build(state);
    }
    emit_done(app, card_count, None);
    Ok(unchanged(card_count))
}

/// Poll Scryfall's id-migration log and apply it to the user's rows.
///
/// On the same 24 h cadence as everything else here, because it is called from the same two
/// places a sync can finish. Skipped entirely when there is nothing to reconcile: Scryfall
/// asks applications not to make requests they do not need, and a database with no
/// collection, no wishlist and no deck list has no ids to migrate.
///
/// A failure is logged and dropped. The bulk data is ingested either way, and an id
/// migration that did not apply today applies tomorrow — whereas failing the whole sync
/// over it would cost the user their card update.
async fn reconcile_ids(state: &Arc<AppState>, app: &tauri::AppHandle) {
    let worth_it = {
        // The read connection: this is one `count(*)` against each user table, and it must
        // not queue behind anything — least of all to decide *not* to do any work.
        let conn = lock_db_read(state);
        !crate::reconcile::user_data_is_empty(&conn)
    };
    if !worth_it {
        return;
    }
    let migrations = match state.client.fetch_migrations().await {
        Ok(m) => m,
        Err(e) => {
            // Logged in both senses now. The `eprintln!` is still useful in a dev console;
            // the row is the half a shipped build has, and this failure is otherwise silent
            // by design — it does not fail the sync, so nothing else would ever mention it.
            eprintln!("could not read Scryfall's id migrations: {e}");
            note_scryfall(state, "migrations", &e);
            return;
        }
    };
    // On a blocking thread, and taking the write lock inside it, for the reason the whole
    // module repeats: the lock is never held across an `.await`, and a pass over the log is
    // synchronous SQLite work.
    // Two handles: one moved into the blocking task, one kept here — and the arms below now
    // need the caller's for two independent reasons, which is why shadowing `state` is no
    // longer an option. A failure has to be written to the error log after the task has
    // consumed its own handle, and a pass that moved a `card_id` has to refresh the index's
    // `owned` set.
    let owned = state.clone();
    let applied = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = lock_db(&owned);
        crate::reconcile::apply(&mut conn, &migrations)
    })
    .await;
    match applied {
        Ok(Ok(stats)) if stats.repointed + stats.folded + stats.flagged > 0 => {
            // A repoint or a fold moves a collection row onto a different `card_id`, which
            // is a different rowid, which is a different bit in the index's `owned` set. The
            // cheap dimension refresh rather than a rebuild — the corpus did not move — and
            // a no-op on the ingest path, where the swap has already taken the index cold.
            // The arm is shared with a pass that only *flagged* rows, which moves no id at
            // all: that costs one re-read the app did not need, on the rare pass that has
            // already found something to tell the user about.
            crate::index::lifecycle::invalidate_owned(state);
            // Only when something moved. A pass that skipped every already-applied
            // migration — which is every pass after the first — has nothing to tell anyone.
            let _ = app.emit(
                "collection:reconciled",
                serde_json::json!({
                    "repointed": stats.repointed,
                    "folded": stats.folded,
                    "flagged": stats.flagged,
                }),
            );
        }
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            eprintln!("could not apply Scryfall's id migrations: {e}");
            note_database(state, "reconcile", &e.to_string());
        }
        Err(e) => {
            eprintln!("the id-migration task failed: {e}");
            note_database(state, "reconcile", &e.to_string());
        }
    }
}

/// Give the pages the swap just freed back to the filesystem, on the `reclaiming` phase.
///
/// The swap has dropped an entire copy of `cards`, and returning it is the difference
/// between a file that plateaus and one that grows by ~1 GB per refresh. Measured at 8.4 s
/// for 1.02 GB, so it gets a phase of its own rather than passing for a stalled `ingesting`
/// — and, uniquely among the phases, a real fraction: the freelist is counted once at entry
/// and only falls.
///
/// On a blocking thread, and taking the write connection one chunk at a time, for the same
/// reason the ingest does both: this is seconds of synchronous SQLite work, and a user
/// action that wants the connection must not be made to wait for all of it. See
/// [`crate::maintenance::reclaim_freed_pages`].
///
/// A failure is logged and nothing more. The cards are ingested and swapped in either way,
/// and a database whose freelist did not shrink is a database that works.
async fn reclaim_freed_pages(state: &Arc<AppState>, app: &tauri::AppHandle) {
    let joined = {
        let state = state.clone();
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::maintenance::reclaim_freed_pages(&state.db, &mut |done, total| {
                emit(&app, "reclaiming", done.max(0) as u64, total.max(0) as u64)
            })
        })
        .await
    };
    match joined {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            eprintln!("could not return freed pages after the swap: {e}");
            note_database(state, "reclaim", &e.to_string());
        }
        Err(e) => {
            eprintln!("the page-return task failed: {e}");
            note_database(state, "reclaim", &e.to_string());
        }
    }
}

/// Convert this database to incremental auto-vacuum, once, ever — and pay off any rebuild
/// an interrupted conversion left owing.
///
/// Runs here rather than in `migrate_single_file` because it is minutes of work on a large file and
/// `migrate_single_file` runs before there is a window to say so in. Runs *after* the sync rather than
/// before it because a sync is the one moment the user has already been told the app is
/// busy with the database — and because compacting a file that is about to be rewritten
/// would be work done twice.
///
/// Called from **both** paths that finish a run: the one that ingested and
/// [`finish_unchanged`]. The ETag makes 304 the common answer, so a legacy database whose
/// owner syncs daily and always hears "already up to date" would otherwise never reach a
/// compaction that is only ever going to happen once.
///
/// A failed *conversion* is recorded and never retried automatically: `VACUUM` needs free
/// space about the size of the database, so the common failure is a disk that will still be
/// full tomorrow. Plan 6's "Compact database" control is what clears the key and asks again.
/// A failed *rebuild* carries no such key — it is cheap, it needs no free space, and leaving
/// the search index wrong is not a state to settle into.
///
/// Whether either is due is asked of the **write** connection, not `db_read`, and that is
/// the difference between "once, ever" and "once per sync". `PRAGMA auto_vacuum` is answered
/// from a per-connection cache of the file header, and a connection refreshes it only when a
/// read transaction happens to notice the file changed — so immediately after a conversion
/// the read handle still reports `NONE` and would order the same 30 s `VACUUM` again on the
/// next Refresh of the session. The connection that ran the `VACUUM` is the one that knows.
/// Pinned by
/// `maintenance::tests::a_read_only_handle_reports_a_stale_auto_vacuum_after_a_conversion`.
///
/// Answers **whether it took the facet index cold**, which is to say whether a `VACUUM` was
/// attempted: a caller that hears `true` owes a rebuild whatever the outcome, because a
/// conversion that failed still leaves the index cleared and cold is not a state to settle
/// into either.
async fn compact_once(state: &Arc<AppState>, app: &tauri::AppHandle) -> bool {
    let (convert, rebuild) = {
        let conn = lock_db(state);
        (
            crate::maintenance::needs_conversion(&conn, crate::db::CORPUS)
                && get_meta(&conn, crate::maintenance::K_AUTO_VACUUM_ERROR).is_none(),
            // A launch normally pays this off first, so reaching it here means the kill
            // happened during *this* session — or that the launch's own rebuild failed.
            crate::maintenance::fts_rebuild_is_pending(&conn),
        )
    };
    if !convert && !rebuild {
        return false;
    }
    emit(app, "compacting", 0, 0);
    if convert {
        // **A `VACUUM` renumbers rowids**, which is exactly what desyncs `cards_fts` two
        // paragraphs up — and the facet index is rowids and nothing else. Cleared here rather
        // than left to the caller because this is the only place that knows a `VACUUM` is
        // coming, and because [`finish_unchanged`] reaches it too: on that path nothing else
        // in the run touches `cards`, so without this a legacy database would carry an index
        // pointing at pre-`VACUUM` rowids for the rest of the session. The rebuild is the
        // caller's, which is what the return value is for.
        //
        // Before the clone below and therefore before the `VACUUM` itself, which is the only
        // ordering that is safe: a clear after it would leave a window where the index is
        // published over rowids the `VACUUM` has already moved.
        crate::index::lifecycle::clear(state);
    }
    // As in `reconcile_ids`: one handle for the blocking task, one kept so a failure can
    // still be written down after the task has taken its own.
    let owned = state.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_db(&owned);
        if !convert {
            // Nothing to convert, only a rebuild owing: paying that off is not a
            // conversion attempt and must not be recorded as one.
            return crate::maintenance::rebuild_fts_if_pending(&conn).map(|_| ());
        }
        let result = crate::maintenance::convert_to_incremental(&conn);
        if let Err(e) = &result {
            let _ = set_meta(
                &conn,
                crate::maintenance::K_AUTO_VACUUM_ERROR,
                &e.to_string(),
            );
        }
        result
    })
    .await;
    match joined {
        Ok(Ok(())) => {}
        // Neither failure is the sync's failure: the cards are ingested and stored either
        // way, and a database that did not compact is a database that works.
        Ok(Err(e)) => {
            eprintln!("database compaction failed: {e}");
            note_database(state, "compact", &e.to_string());
        }
        Err(e) => {
            eprintln!("database compaction task failed: {e}");
            note_database(state, "compact", &e.to_string());
        }
    }
    convert
}

async fn do_sync(
    state: &Arc<AppState>,
    app: &tauri::AppHandle,
    force: bool,
) -> Result<SyncOutcome, String> {
    let now = unix_now();

    // Short synchronous scope: the guard is dropped at the closing brace, well before
    // the first `.await` below.
    let stored = {
        let conn = lock_db(state);
        read_stored_state(&conn)
    };

    if !should_check(stored.last_check, now, force) {
        // Nothing is written here — not even `last_error` is cleared. This run checked
        // nothing, so it has earned no claim about the state of the world.
        return Ok(unchanged(stored.card_count));
    }

    emit(app, "checking", 0, 0);
    let check = state
        .client
        .check_bulk_update(conditional_etag(stored.etag.as_deref(), stored.card_count))
        .await
        .inspect_err(|e| note_scryfall(state, "bulk_check", e))
        .map_err(|e| e.to_string())?;

    let scryfall::BulkCheck::Available(info) = check else {
        // The common case. `finish_unchanged` stamps `last_check_at` (this run really
        // did check) and emits a terminal phase, without which the UI would sit on
        // "checking" forever on the outcome most runs get.
        return finish_unchanged(state, app, now, stored.card_count).await;
    };
    let updated_at = Some(info.updated_at.clone()).filter(|s| !s.is_empty());

    if already_ingested(
        updated_at.as_deref(),
        stored.bulk_updated_at.as_deref(),
        stored.card_count,
    ) {
        // Re-store the ETag the 200 came with, so the next check is a free 304 again.
        {
            let conn = lock_db(state);
            set_meta_opt(&conn, K_BULK_ETAG, info.etag.as_deref()).map_err(|e| e.to_string())?;
        }
        return finish_unchanged(state, app, now, stored.card_count).await;
    }

    let expected_size = check_download_size(info.compressed_size)?;

    let gz = state.data_dir.join("tmp").join("default-cards.jsonl.gz");
    if let Some(parent) = gz.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }

    emit(app, "downloading", 0, expected_size);
    let mut last_emit = 0u64;
    let downloaded = state
        .client
        .download(
            &info.jsonl_download_uri,
            &gz,
            expected_size,
            &mut |done, total| {
                if done.saturating_sub(last_emit) >= DOWNLOAD_EMIT_BYTES || done >= total {
                    emit(app, "downloading", done, total);
                    last_emit = done;
                }
            },
        )
        .await;
    if let Err(e) = downloaded {
        note_scryfall(state, "bulk_download", &e);
        // A short file is a resume point and is kept on purpose. Anything else — a
        // server lying about sizes, a rotated file, a dead connection — must not leave
        // a partial behind that every future resume then argues with.
        if !matches!(e, scryfall::ScryfallError::SizeMismatch { .. }) {
            let _ = std::fs::remove_file(&gz);
        }
        return Err(e.to_string());
    }

    // The ingest is a long *blocking* call (minutes of gzip + SQLite), so it runs on a
    // blocking thread rather than on the async runtime — never across an await.
    let joined = {
        let state = state.clone();
        let app = app.clone();
        let gz = gz.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // No lock is taken here any more: the ingest takes it per batch and gives it
            // back, so a collection edit waits one batch rather than one sync.
            ingest::ingest_gz(&state.db, &gz, &mut |n| {
                emit(&app, "ingesting", n, INGEST_TOTAL_ESTIMATE)
            })
        })
        .await
    };
    let stats = match joined {
        Ok(Ok(s)) => s,
        // The task itself died (panicked, or the runtime is shutting down). The file is
        // no more use here than after any other ingest failure, and the module's rule is
        // that only a resumable partial survives a failed run.
        Err(e) => {
            let _ = std::fs::remove_file(&gz);
            return Err(format!("ingest task failed: {e}"));
        }
        Ok(Err(e)) => {
            // The file is the right size but its contents are unusable (or the database
            // refused it). Either way this exact file will not ingest next time either,
            // and a resume would only re-verify a file that is already complete.
            let _ = std::fs::remove_file(&gz);
            return Err(e.to_string());
        }
    };
    // **The swap has landed, so the facet index is now a liar — go cold immediately, before
    // anything else in this function gets a turn.** `swap_staging` dropped and recreated
    // `cards`, which renumbers every rowid, and the index is nothing but rowids: left
    // published it would count *other cards* into every facet, greying out options the search
    // would happily return printings for. The rebuild does not follow until the end of the run
    // (below), because two things between here and there move the ground again —
    // `reconcile_ids` can repoint a collection row onto another printing, and `compact_once`'s
    // one-time `VACUUM` renumbers the rowids a second time. For those few seconds the app
    // answers `ready: false` and every control stays live, which is the honest answer and the
    // safe one.
    //
    // A run that dies **after** this line — the `/sets` call is the one that reaches the
    // network again — leaves the index cold until the next launch or sync. That is the
    // degradation this whole module is built to make safe (no facet counts, every filter
    // live, nothing else changed), and it is strictly better than the alternative on offer,
    // which is counts about a corpus that no longer exists.
    //
    // **A run that dies *before* it does not, and that gap is open.** The two `Err` arms above
    // return early, so a death between `swap_staging`'s commit and this line — the blocking
    // task panicking on its way out, or the runtime shutting down under it — leaves the
    // *previous* index published over the new rowids, which is the one state this module says
    // must never exist. It is bounded (the next launch or sync rebuilds it) and it is not
    // closed here, because clearing in those arms needs a `spawn_build` decision to go with
    // it: a clear on a failed ingest with nothing scheduled leaves the app cold for the rest
    // of the session. Named rather than fixed.
    crate::index::lifecycle::clear(state);

    // Only now the unlink. 77 MB of blocking I/O, and until this line moved above it, it sat
    // inside the window the paragraph above is about.
    let _ = std::fs::remove_file(&gz);

    reclaim_freed_pages(state, app).await;

    {
        // The half that needs no network: after a swap, a row whose printing is gone is
        // flagged, and a row whose printing came back is cleared. Only on this path,
        // because only this path replaced `cards` — the answer cannot have changed on a
        // run that ingested nothing.
        //
        // Logged, never fatal: the cards are ingested and swapped in either way, and a
        // sweep that did not run today runs after the next ingest.
        let conn = lock_db(state);
        match crate::reconcile::sweep_orphans(&conn) {
            Ok((flagged, cleared)) if flagged > 0 || cleared > 0 => {
                eprintln!("collection review: {flagged} rows flagged, {cleared} cleared")
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("could not sweep for orphaned collection rows: {e}");
                // The connection is already in hand here, so this one records directly
                // rather than through `note_database` — which would deadlock trying to take
                // a lock this scope is holding.
                crate::errors::record(
                    &conn,
                    crate::errors::Source::Database,
                    "orphan_sweep",
                    crate::errors::Kind::Io,
                    &e.to_string(),
                    None,
                );
            }
        }
    }

    let card_count = stats.inserted as i64;
    {
        // Written before `/sets` is called, not after: the download is the expensive
        // part of a sync, and a failure fetching sets must not cost the user a repeat
        // of it. With these stored, a retry is a 304 plus one `/sets` call.
        let conn = lock_db(state);
        set_meta_opt(&conn, K_BULK_ETAG, info.etag.as_deref()).map_err(|e| e.to_string())?;
        set_meta_opt(&conn, K_BULK_UPDATED_AT, updated_at.as_deref()).map_err(|e| e.to_string())?;
        set_meta(&conn, K_LAST_INGEST_AT, &unix_now().to_string()).map_err(|e| e.to_string())?;
        set_meta(&conn, K_CARD_COUNT, &card_count.to_string()).map_err(|e| e.to_string())?;
        // Written even when it is zero: "the last ingest skipped nothing" is a different
        // statement from "no ingest has run", and the UI distinguishes them.
        set_meta(&conn, K_LAST_INGEST_SKIPPED, &stats.skipped.to_string())
            .map_err(|e| e.to_string())?;
    }

    emit(app, "sets", 0, 0);
    let sets = state
        .client
        .fetch_sets()
        .await
        .inspect_err(|e| note_scryfall(state, "sets", e))
        .map_err(|e| e.to_string())?;
    {
        let mut conn = lock_db(state);
        insert_sets(&mut conn, &sets).map_err(|e| e.to_string())?;
    }

    {
        // Last, because this is the record that the *whole* run succeeded. Stamping it
        // any earlier would let a failure between here and the check throttle the next
        // 24 hours of automatic retries.
        let conn = lock_db(state);
        mark_checked(&conn, now).map_err(|e| e.to_string())?;
    }
    reconcile_ids(state, app).await;
    // Its answer is ignored on purpose: this path swapped `cards`, so it owes a rebuild
    // whether or not a conversion also ran.
    let _ = compact_once(state, app).await;
    // Last, and only now: everything that could still move a rowid or a `card_id` has run,
    // so this build reads the generation the app will keep. ~767 ms on its own thread — the
    // sync is finished either way and nothing waits for it.
    crate::index::lifecycle::spawn_build(state);
    emit_done(app, card_count, Some(stats.skipped));
    Ok(SyncOutcome {
        updated: true,
        card_count,
        updated_at,
    })
}

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
    use rusqlite::Connection;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// A real file with both connections on it — the shape `init_state` builds — because
    /// a status that reads through `db_read` cannot be tested against a `db_read` that
    /// points somewhere else. (An in-memory pair cannot stand in: two in-memory
    /// connections are two different databases.)
    fn file_state(name: &str, syncing: bool) -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("mtgtest-sync-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::split::convert(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        let read = crate::db::open_read(&dir).unwrap();
        // **Hooked up, so what these fixtures drive runs with the cross-file fence
        // armed.** `crate::sync::with_write`'s `debug_assert` reads it, so a command
        // that committed to both files fails its own test rather than printing a line
        // nobody reads. The mask rides along because SQLite allows one update hook per
        // connection, and nothing here looks at it.
        let mirror = std::sync::Arc::new(crate::mirror::watch::Mask::default());
        let fence = std::sync::Arc::new(crate::db::CrossFileFence::new());
        crate::mirror::watch::install_hook(&conn, mirror.clone(), fence.clone());
        (
            AppState {
                db: Mutex::new(conn),
                db_read: Mutex::new(read),
                data_dir: PathBuf::from("D:\\app\\data"),
                syncing: AtomicBool::new(syncing),
                // Never called: these tests stop short of the network.
                client: crate::scryfall::Client::new("http://127.0.0.1:1".into()),
                // Never touched either — a `Cache` creates nothing until it is asked for
                // an image, so this directory does not have to exist.
                images: crate::images::Cache::new(PathBuf::from("D:\\app\\data\\images")),
                index: std::sync::RwLock::default(),
                // The mirror is never started in these tests; a clean mask and an empty record are
                // what an `AppState` looks like before the first pass.
                mirror,
                mirror_status: std::sync::Mutex::new(crate::mirror::watch::LastPass::default()),
                fence,
            },
            dir,
        )
    }

    fn set_row(code: &str, name: &str) -> crate::scryfall::SetRow {
        crate::scryfall::SetRow {
            code: code.into(),
            name: name.into(),
            arena_code: None,
            mtgo_code: None,
            set_type: None,
            released_at: None,
            icon_svg_uri: None,
        }
    }

    #[test]
    fn meta_roundtrip() {
        let conn = db();
        assert!(get_meta(&conn, "bulk_etag").is_none());
        set_meta(&conn, "bulk_etag", "W/\"abc\"").unwrap();
        assert_eq!(get_meta(&conn, "bulk_etag").as_deref(), Some("W/\"abc\""));
    }

    #[test]
    fn throttle_skips_recent_check() {
        let now = 1_800_000_000u64;
        assert!(should_check(None, now, false)); // never checked
        assert!(!should_check(Some(now - 3600), now, false)); // 1h ago, no force
        assert!(should_check(Some(now - 3600), now, true)); // forced
        assert!(should_check(Some(now - 90_000), now, false)); // >24h
    }

    /// `sync_meta.value` is `NOT NULL`, so "no value" has to be the absence of the
    /// row. An empty string counts as absent too: an ETag of `""` replayed as
    /// `If-None-Match` is a header that can only ever fail to match.
    #[test]
    fn an_absent_meta_value_is_a_missing_row_never_a_null() {
        let conn = db();
        set_meta(&conn, "bulk_etag", "W/\"abc\"").unwrap();

        set_meta_opt(&conn, "bulk_etag", None).unwrap();
        set_meta_opt(&conn, "bulk_updated_at", Some("")).unwrap();

        assert!(get_meta(&conn, "bulk_etag").is_none());
        assert!(get_meta(&conn, "bulk_updated_at").is_none());
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM sync_meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "an absent value must not leave a row behind");
    }

    /// A `last_check_at` in the future — a clock that moved backwards, or a corrupt
    /// value — must not underflow the subtraction, and must not throttle the sync
    /// until the wall clock catches up.
    #[test]
    fn a_check_timestamp_from_the_future_does_not_wedge_the_throttle() {
        assert!(should_check(Some(1_800_000_000), 1_700_000_000, false));
    }

    /// The throttle short-circuit as `do_sync` runs it: read what is stored, decide,
    /// and return the unchanged outcome — all before anything touches the network.
    #[test]
    fn a_recent_check_short_circuits_before_any_network_call() {
        let conn = db();
        let now = 1_800_000_000u64;
        set_meta(&conn, "last_check_at", &(now - 3600).to_string()).unwrap();
        set_meta(&conn, "bulk_etag", "W/\"abc\"").unwrap();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
             VALUES ('x','Lightning Bolt','lea','161','en','normal','{}')",
            [],
        )
        .unwrap();

        let stored = read_stored_state(&conn);

        assert_eq!(stored.last_check, Some(now - 3600));
        assert_eq!(stored.card_count, 1);
        assert!(!should_check(stored.last_check, now, false));
        let outcome = unchanged(stored.card_count);
        assert!(!outcome.updated);
        assert_eq!(outcome.card_count, 1);
        assert_eq!(
            outcome.updated_at, None,
            "`updated_at` is Some only when the run actually updated something"
        );
        // ...and forcing it must get past the same gate.
        assert!(should_check(stored.last_check, now, true));
    }

    /// A garbage `last_check_at` must read as "never checked" rather than throttling
    /// forever on a value that can never be compared.
    #[test]
    fn an_unparseable_check_timestamp_reads_as_never_checked() {
        let conn = db();
        set_meta(&conn, "last_check_at", "yesterday").unwrap();
        assert_eq!(read_stored_state(&conn).last_check, None);
    }

    /// The two decisions that stand between a run and a 77 MB download. Both were
    /// inline conditions; both are the kind that is wrong in one direction silently.
    #[test]
    fn already_ingested_needs_a_matching_timestamp_and_cards_to_show_for_it() {
        let ts = Some("2026-08-03T21:16:27.869+00:00");
        assert!(already_ingested(ts, ts, 116_000));

        // Metadata outliving its cards is exactly the state an interrupted first run
        // leaves behind: matching timestamps, nothing in the table.
        assert!(
            !already_ingested(ts, ts, 0),
            "an empty database must download whatever the metadata claims"
        );
        assert!(!already_ingested(
            Some("2026-08-04T09:00:00.000+00:00"),
            ts,
            116_000
        ));
        assert!(!already_ingested(ts, None, 116_000));
        // Two absent timestamps are not a match — they are two pieces of no evidence.
        assert!(!already_ingested(None, None, 116_000));
    }

    #[test]
    fn a_bulk_listing_without_a_size_is_refused_before_the_download() {
        let err = check_download_size(0).unwrap_err();
        assert!(err.contains("no size"), "{err}");
        assert_eq!(check_download_size(77_332_681).unwrap(), 77_332_681);
    }

    /// The bookkeeping every successful path shares. Its counterpart — that a *failed*
    /// run never reaches this — is control flow in `do_sync`: `mark_checked` is called
    /// only on the three paths that return `Ok`.
    #[test]
    fn mark_checked_stamps_the_check_and_clears_the_previous_failure() {
        let conn = db();
        set_meta(&conn, "last_error", "rate limited by Scryfall").unwrap();

        mark_checked(&conn, 1_800_000_000).unwrap();

        assert_eq!(
            get_meta(&conn, "last_check_at").as_deref(),
            Some("1800000000")
        );
        assert!(get_meta(&conn, "last_error").is_none());
    }

    /// `sets` is filled only on the download path, and once an ETag is stored every
    /// later run is a 304 that never gets there — so "is it empty?" is what decides
    /// whether a failed `/sets` is ever retried.
    #[test]
    fn an_empty_sets_table_is_recognised_as_needing_a_backfill() {
        let mut conn = db();
        assert!(sets_are_empty(&conn));
        insert_sets(&mut conn, &[set_row("dom", "Dominaria")]).unwrap();
        assert!(!sets_are_empty(&conn));
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

    #[test]
    fn sets_are_upserted_and_rows_without_a_code_are_skipped() {
        let mut conn = db();
        conn.execute(
            "INSERT INTO sets (code, name) VALUES ('dom', 'Stale Name')",
            [],
        )
        .unwrap();

        let rows = vec![
            set_row("dom", "Dominaria"),
            set_row("", "No code at all"),
            set_row("   ", "Whitespace code"),
            set_row("lea", "Limited Edition Alpha"),
        ];
        let inserted = insert_sets(&mut conn, &rows).unwrap();

        assert_eq!(inserted, 2, "rows without a usable primary key are skipped");
        let name: String = conn
            .query_row("SELECT name FROM sets WHERE code='dom'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            name, "Dominaria",
            "an existing set is updated, not duplicated"
        );
        let total: i64 = conn
            .query_row("SELECT count(*) FROM sets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 2);
    }

    /// Task 10's TypeScript mirrors these names by hand. A rename here that is not
    /// mirrored there is a silently `undefined` field in the UI, so the wire shape is
    /// pinned rather than assumed.
    #[test]
    fn dto_json_uses_the_camel_case_names_the_frontend_expects() {
        let outcome = serde_json::to_value(SyncOutcome {
            updated: true,
            card_count: 3,
            updated_at: Some("2026-08-03T21:16:27.869+00:00".into()),
        })
        .unwrap();
        assert_eq!(
            outcome,
            serde_json::json!({
                "updated": true,
                "cardCount": 3,
                "updatedAt": "2026-08-03T21:16:27.869+00:00"
            })
        );

        let status = serde_json::to_value(SyncStatus {
            card_count: Some(1),
            last_check_at: Some("1800000000".into()),
            bulk_updated_at: None,
            last_error: Some("rate limited by Scryfall".into()),
            last_ingest_skipped: Some(12),
            data_dir: "D:\\app\\data".into(),
            syncing: true,
            image_store_failures: 3,
        })
        .unwrap();
        assert_eq!(
            status,
            serde_json::json!({
                "cardCount": 1,
                "lastCheckAt": "1800000000",
                "bulkUpdatedAt": null,
                "lastError": "rate limited by Scryfall",
                "lastIngestSkipped": 12,
                "dataDir": "D:\\app\\data",
                "syncing": true,
                "imageStoreFailures": 3
            })
        );
        // The unreadable shape: nothing the database owns could be read, and `cardCount`
        // says so with `null` rather than lying with a `0` the UI would render as "empty".
        // `imageStoreFailures` is a number regardless — it is the field whose *cause* is
        // most likely to be the same full disk, so it must not go missing with the rest.
        let busy = serde_json::to_value(SyncStatus {
            card_count: None,
            last_check_at: None,
            bulk_updated_at: None,
            last_error: None,
            last_ingest_skipped: None,
            data_dir: "D:\\app\\data".into(),
            syncing: true,
            image_store_failures: 7,
        })
        .unwrap();
        assert_eq!(
            busy,
            serde_json::json!({
                "cardCount": null,
                "lastCheckAt": null,
                "bulkUpdatedAt": null,
                "lastError": null,
                "lastIngestSkipped": null,
                "dataDir": "D:\\app\\data",
                "syncing": true,
                "imageStoreFailures": 7
            })
        );

        let progress = serde_json::to_value(Progress::new("downloading", 5, 10)).unwrap();
        assert_eq!(
            progress,
            serde_json::json!({"phase":"downloading","done":5,"total":10,"message":null})
        );
        let failed = serde_json::to_value(Progress::error("boom".into())).unwrap();
        assert_eq!(
            failed,
            serde_json::json!({"phase":"error","done":0,"total":0,"message":"boom"})
        );
    }

    /// The phase strings are a hand-mirrored union, exactly as the DTO field names are, and
    /// they fail the same way: a phase the frontend has never heard of has no
    /// `PHASE_LABEL` entry, so the mana line renders `undefined` while the sync runs
    /// perfectly. This is the Rust half; `useSyncProgress.test.ts` pins the other.
    #[test]
    fn the_progress_phases_are_the_ones_the_frontend_mirrors() {
        assert_eq!(
            PHASES,
            [
                "checking",
                "downloading",
                "ingesting",
                "reclaiming",
                "sets",
                "compacting",
                "done",
                "error"
            ]
        );
        // And each really is what goes on the wire.
        for phase in PHASES {
            let json = serde_json::to_value(Progress::new(phase, 0, 0)).unwrap();
            assert_eq!(json["phase"], phase);
        }
    }

    /// Spec §8: parse failures are "logged and skipped with a count surfaced (not silently
    /// swallowed)". The count reaches the user two ways, because neither is reliable
    /// alone — in the terminal `done` event, and persisted for the status poll to find
    /// long after that event was dropped.
    #[test]
    fn the_done_message_reports_skipped_lines_only_when_there_were_any() {
        assert_eq!(
            done_message(116_568, Some(12)),
            "116,568 cards (12 lines skipped)"
        );
        assert_eq!(
            done_message(116_568, Some(1)),
            "116,568 cards (1 line skipped)"
        );
        // A clean run says nothing about skipping, and a run that ingested nothing new
        // has no figure of its own to quote.
        assert_eq!(done_message(116_568, Some(0)), "116,568 cards");
        assert_eq!(done_message(116_568, None), "116,568 cards");
        assert_eq!(done_message(0, None), "0 cards");
    }

    #[test]
    fn digits_are_grouped_in_threes_from_the_right() {
        assert_eq!(group_digits(0), "0");
        assert_eq!(group_digits(999), "999");
        assert_eq!(group_digits(1_000), "1,000");
        assert_eq!(group_digits(116_568), "116,568");
        assert_eq!(group_digits(1_234_567), "1,234,567");
    }

    /// A stored ETag with no cards behind it is a 304 waiting to happen — the server
    /// says "you already have it", and the empty database has no way to disagree. Every
    /// Refresh would ask the same unanswerable question, forever.
    #[test]
    fn an_empty_database_never_sends_an_if_none_match() {
        assert_eq!(
            conditional_etag(Some("W/\"abc\""), 116_568),
            Some("W/\"abc\"")
        );
        assert_eq!(
            conditional_etag(Some("W/\"abc\""), 0),
            None,
            "an empty `cards` must be able to get past its own ETag"
        );
        assert_eq!(conditional_etag(None, 116_568), None);
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
}
