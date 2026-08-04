//! Sync orchestrator: the one place that decides whether to talk to Scryfall, and
//! drives check → download → ingest → sets as a single supervised run.
//!
//! Three rules shape everything here:
//!
//! * **One sync at a time.** `syncing` is claimed with an atomic swap and released by
//!   an RAII guard, so an early return, an error, a panic, or a cancelled future all
//!   leave the flag clear. A stuck flag would lock the user out of syncing until they
//!   restart the app.
//! * **The database lock is never held across an `.await`.** A `MutexGuard` is `!Send`
//!   (holding one across an await would not even compile for a spawned future), and a
//!   lock held for the length of a 77 MB download would block every reader. Locks live
//!   in short synchronous scopes, or inside a [`tauri::async_runtime::spawn_blocking`]
//!   closure for the one long blocking operation, the ingest.
//! * **The expensive work is paid for once.** The 77 MB download is the costly step, so
//!   the metadata that makes the *next* check cheap (`bulk_etag`, `bulk_updated_at`) is
//!   written as soon as the ingest succeeds — before `/sets` is even called. A later
//!   failure then costs a retry of the cheap part only.
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
pub struct AppState {
    pub db: Mutex<Connection>,
    pub data_dir: PathBuf,
    pub syncing: AtomicBool,
    pub client: scryfall::Client,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub card_count: i64,
    /// Unix seconds, as a string (see [`unix_now`]).
    pub last_check_at: Option<String>,
    pub bulk_updated_at: Option<String>,
    pub data_dir: String,
    pub syncing: bool,
}

/// Payload of the `sync:progress` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// `checking` | `downloading` | `ingesting` | `sets` | `done` | `error`.
    pub phase: String,
    pub done: u64,
    pub total: u64,
    pub message: Option<String>,
}

impl Progress {
    fn new(phase: &str, done: u64, total: u64) -> Progress {
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
fn lock_db(state: &AppState) -> MutexGuard<'_, Connection> {
    state.db.lock().unwrap_or_else(|e| e.into_inner())
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
fn emit_done(app: &tauri::AppHandle, card_count: i64) {
    let n = card_count.max(0) as u64;
    emit(app, "done", n, n);
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
/// Errors are returned *and* emitted as a `sync:progress` event with phase `error`, so
/// a sync started at launch — with no caller to return to — still reaches the UI.
pub async fn run_sync(
    state: Arc<AppState>,
    app: tauri::AppHandle,
    force: bool,
) -> Result<SyncOutcome, String> {
    if state.syncing.swap(true, Ordering::SeqCst) {
        // Returned without a progress event on purpose: the sync already in flight is
        // the one driving `sync:progress`, and an `error` phase here would paint it as
        // failed in the UI.
        return Err("sync already running".into());
    }
    let _guard = SyncingGuard(&state.syncing);

    let result = do_sync(&state, &app, force).await;
    if let Err(e) = &result {
        let _ = app.emit("sync:progress", Progress::error(e.clone()));
    }
    result
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
        return Ok(unchanged(stored.card_count));
    }

    emit(app, "checking", 0, 0);
    let check = state
        .client
        .check_bulk_update(stored.etag.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    {
        let conn = lock_db(state);
        set_meta(&conn, K_LAST_CHECK_AT, &now.to_string()).map_err(|e| e.to_string())?;
    }

    let scryfall::BulkCheck::Available(info) = check else {
        // Not emitting a terminal phase here would leave the UI stuck on "checking"
        // for the common case — a 304 is what most runs get.
        emit_done(app, stored.card_count);
        return Ok(unchanged(stored.card_count));
    };
    let updated_at = Some(info.updated_at.clone()).filter(|s| !s.is_empty());

    // A 200 with the same `updated_at` we already ingested is the same file: the ETag
    // was lost (a proxy stripped it, or a previous run never stored one), not the data
    // rotated. Re-store the ETag so the next check is a free 304, and skip the 77 MB.
    // `card_count > 0` guards the case where the metadata survived but the cards did
    // not — an interrupted first run must still download.
    if updated_at.is_some() && updated_at == stored.bulk_updated_at && stored.card_count > 0 {
        {
            let conn = lock_db(state);
            set_meta_opt(&conn, K_BULK_ETAG, info.etag.as_deref()).map_err(|e| e.to_string())?;
        }
        emit_done(app, stored.card_count);
        return Ok(unchanged(stored.card_count));
    }

    // Without a size there is nothing to verify the download against, and an
    // `expected_size` of 0 would only surface later as a confusing size mismatch.
    if info.compressed_size == 0 {
        return Err("bulk listing had no size; refusing to download".into());
    }

    let gz = state.data_dir.join("tmp").join("default-cards.jsonl.gz");
    if let Some(parent) = gz.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }

    emit(app, "downloading", 0, info.compressed_size);
    let mut last_emit = 0u64;
    let downloaded = state
        .client
        .download(
            &info.jsonl_download_uri,
            &gz,
            info.compressed_size,
            &mut |done, total| {
                if done.saturating_sub(last_emit) >= DOWNLOAD_EMIT_BYTES || done >= total {
                    emit(app, "downloading", done, total);
                    last_emit = done;
                }
            },
        )
        .await;
    if let Err(e) = downloaded {
        // A short file is a resume point and is kept on purpose. Anything else — a
        // server lying about sizes, a rotated file, a dead connection — must not leave
        // a partial behind that every future resume then argues with.
        if !matches!(e, scryfall::ScryfallError::SizeMismatch { .. }) {
            let _ = std::fs::remove_file(&gz);
        }
        return Err(e.to_string());
    }

    // The ingest is a long *blocking* call (minutes of gzip + SQLite), so it runs on a
    // blocking thread with the lock taken inside the closure — never across an await.
    let ingested = {
        let state = state.clone();
        let app = app.clone();
        let gz = gz.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut conn = lock_db(&state);
            ingest::ingest_gz(&mut conn, &gz, &mut |n| {
                emit(&app, "ingesting", n, INGEST_TOTAL_ESTIMATE)
            })
        })
        .await
        .map_err(|e| format!("ingest task failed: {e}"))?
    };
    let stats = match ingested {
        Ok(s) => s,
        Err(e) => {
            // The file is the right size but its contents are unusable (or the database
            // refused it). Either way this exact file will not ingest next time either,
            // and a resume would only re-verify a file that is already complete.
            let _ = std::fs::remove_file(&gz);
            return Err(e.to_string());
        }
    };
    let _ = std::fs::remove_file(&gz);

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
    }

    emit(app, "sets", 0, 0);
    let sets = state.client.fetch_sets().await.map_err(|e| e.to_string())?;
    {
        let mut conn = lock_db(state);
        insert_sets(&mut conn, &sets).map_err(|e| e.to_string())?;
    }

    emit_done(app, card_count);
    Ok(SyncOutcome {
        updated: true,
        card_count,
        updated_at,
    })
}

/// Current sync state for the UI. `card_count` is counted live rather than read from
/// `sync_meta`, so it is right even if a previous run died before writing its meta.
pub fn status(state: &AppState) -> SyncStatus {
    let conn = lock_db(state);
    SyncStatus {
        card_count: count_cards(&conn),
        last_check_at: get_meta(&conn, K_LAST_CHECK_AT),
        bulk_updated_at: get_meta(&conn, K_BULK_UPDATED_AT),
        data_dir: state.data_dir.display().to_string(),
        syncing: state.syncing.load(Ordering::SeqCst),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        conn
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
            card_count: 1,
            last_check_at: Some("1800000000".into()),
            bulk_updated_at: None,
            data_dir: "D:\\app\\data".into(),
            syncing: true,
        })
        .unwrap();
        assert_eq!(
            status,
            serde_json::json!({
                "cardCount": 1,
                "lastCheckAt": "1800000000",
                "bulkUpdatedAt": null,
                "dataDir": "D:\\app\\data",
                "syncing": true
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
}
