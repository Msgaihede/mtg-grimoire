pub mod card_row;
pub mod db;
pub mod ingest;
pub mod paths;
pub mod schema;
pub mod scryfall;
pub mod sync;

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use sync::AppState;
use tauri::Manager;

/// Production API host. `Client` takes it as a parameter so tests can point at a mock.
const SCRYFALL_API: &str = "https://api.scryfall.com";

/// Run a sync now. `force` bypasses the 24 h throttle; a second concurrent call is
/// refused rather than queued.
#[tauri::command]
async fn sync_run(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    force: bool,
) -> Result<sync::SyncOutcome, String> {
    sync::run_sync(state.inner().clone(), app, force).await
}

/// Current sync state.
///
/// `async`, and answered on the blocking pool, because a *sync* command body runs inline
/// on the IPC thread: this one counts 116 k rows and reads four meta keys, which is small
/// but not free, and a UI is expected to poll it. `sync::status` itself never waits on the
/// database — mid-sync it reports what it can and leaves the rest `None`.
#[tauri::command]
async fn sync_status(state: tauri::State<'_, Arc<AppState>>) -> Result<sync::SyncStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync::status(&state))
        .await
        .map_err(|e| format!("could not read sync status: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![sync_run, sync_status])
        .setup(|app| {
            // Printed as well as returned: a `Box<dyn Error>` out of `setup` reaches the
            // user as an escaped one-line panic, which turns a multi-line message naming
            // both candidate folders into something unreadable.
            let state = Arc::new(init_state(app).inspect_err(|e| eprintln!("{e}"))?);
            app.manage(state.clone());

            // Launch is never blocked on the network: the window comes up immediately
            // and this run reports itself through `sync:progress`. The throttle inside
            // makes it a no-op on all but the first launch of the day.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sync::run_sync(state, handle, false).await {
                    eprintln!("initial sync failed: {e}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Resolve the data directory, open the database and migrate it.
///
/// Every failure here is fatal *and* invisible — this runs before any window exists —
/// so the messages name the paths that were tried. Left unwrapped, the common case
/// (both candidate folders unwritable) surfaces as SQLite's "unable to open database
/// file", which says nothing about which folder or why.
fn init_state(app: &tauri::App) -> Result<AppState, String> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    let app_data = app.path().app_data_dir().map_err(|e| {
        format!(
            "MTG Collection Tracker could not locate a folder to store its data in: {e}\n\
             The per-user application data folder is unavailable on this system."
        )
    })?;

    let portable = exe_dir.as_ref().map(|d| d.join("data"));
    let fallback = app_data.join("data");
    let data_dir = match &exe_dir {
        Some(dir) => paths::resolve_data_dir(dir, &app_data),
        // No executable path (an unusual host, a deleted binary): the portable location
        // cannot even be named, so go straight to the per-user folder.
        None => {
            let _ = std::fs::create_dir_all(&fallback);
            fallback.clone()
        }
    };

    let db_path = data_dir.join("mtg.db");
    let conn = db::open(&db_path).map_err(|e| data_dir_error(portable.as_deref(), &fallback, e))?;
    schema::migrate(&conn).map_err(|e| {
        format!(
            "MTG Collection Tracker could not prepare its database at {}: {e}\n\
             The file may be from a newer version of the app, or damaged. Moving it \
             aside will let the app rebuild it from Scryfall.",
            db_path.display()
        )
    })?;

    Ok(AppState {
        db: Mutex::new(conn),
        data_dir,
        syncing: AtomicBool::new(false),
        client: scryfall::Client::new(SCRYFALL_API.to_owned()),
    })
}

/// The startup message for "nowhere to put the database", naming both candidates.
fn data_dir_error(portable: Option<&Path>, fallback: &Path, err: rusqlite::Error) -> String {
    let portable = portable.map_or_else(
        || "  (the app's own folder could not be determined)".to_owned(),
        |p| format!("  {}", p.display()),
    );
    format!(
        "MTG Collection Tracker could not create or open its database.\n\
         It tried these folders, in order:\n\
         {portable}\n  {fallback}\n\
         Check that one of them exists and is writable, then start the app again.\n\
         (SQLite: {err})",
        fallback = fallback.display()
    )
}

/// `data_dir` is resolved from `std::env::current_exe()` and the OS per-user data
/// folder, neither of which a test can control, so these cover the message instead —
/// the part a user actually has to act on.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_startup_error_names_both_candidate_folders() {
        let msg = data_dir_error(
            Some(Path::new("D:\\Apps\\mtg\\data")),
            Path::new("C:\\Users\\x\\AppData\\Roaming\\com.mtgcollection.tracker\\data"),
            rusqlite::Error::InvalidQuery,
        );
        assert!(msg.contains("D:\\Apps\\mtg\\data"), "{msg}");
        assert!(
            msg.contains("C:\\Users\\x\\AppData\\Roaming\\com.mtgcollection.tracker\\data"),
            "{msg}"
        );
        assert!(msg.contains("writable"), "{msg}");
    }

    #[test]
    fn the_startup_error_still_reads_when_the_exe_path_is_unknown() {
        let msg = data_dir_error(None, Path::new("C:\\data"), rusqlite::Error::InvalidQuery);
        assert!(msg.contains("could not be determined"), "{msg}");
        assert!(msg.contains("C:\\data"), "{msg}");
    }
}
