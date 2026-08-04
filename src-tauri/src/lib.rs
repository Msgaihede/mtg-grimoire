pub mod card_row;
pub mod db;
pub mod images;
pub mod ingest;
pub mod paths;
pub mod schema;
pub mod scryfall;
pub mod search;
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

/// Bring the running instance forward when a second launch is refused.
///
/// Without this, double-clicking the exe a second time looks like nothing happened —
/// the guard is silent by design, so the app has to answer with the window itself.
fn focus_existing_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First, before every other plugin: this one has to decide whether the process
        // lives at all, and by the time another plugin has initialised, a second instance
        // has already opened `mtg.db` and the image cache directory that the first one
        // owns. Two processes sharing a WAL database is survivable; two sharing the temp
        // `.gz` an ingest streams from is not.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_existing_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            sync_run,
            sync_status,
            search::search_cards
        ])
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // `build` + `run(callback)` rather than `run(context)`, for one event: `Exit`.
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                checkpoint_on_exit(app);
            }
        });
}

/// Fold the write-ahead log back into `mtg.db` on the way out.
///
/// The app holds its connection open for its whole life, so nothing ever checkpoints the
/// WAL on its own: after an ingest the `-wal` file is the size of the database it
/// replaced (measured: 857 MB) and it *stays* there after the process exits, until
/// something else opens and cleanly closes the file. For an app whose selling point is
/// running from a USB stick, that is the difference between fitting and not.
///
/// Best-effort by design, and silent: this runs after the last window is gone, so there
/// is no one to tell and nothing to do. A skipped checkpoint costs disk space, never
/// data — the WAL is a complete, recoverable journal, and the next launch replays it.
fn checkpoint_on_exit(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    // The *write* connection: a read-only handle may not checkpoint.
    let conn = sync::lock_db(&state);
    let _ = db::checkpoint_truncate(&conn);
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
    // Opened after `migrate`, and only after: a read-only connection to a file that has
    // no tables yet would be a handle that can never be made useful. Same error message
    // as the write connection — if this fails, the folder is the reason.
    let conn_read = db::open_read_only(&db_path)
        .map_err(|e| data_dir_error(portable.as_deref(), &fallback, e))?;

    Ok(AppState {
        db: Mutex::new(conn),
        db_read: Mutex::new(conn_read),
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

    /// The CSP is configuration, not code, so nothing else can fail when it is loosened.
    /// This is the guard: it reads the shipped config and pins the sources the app
    /// genuinely needs — Tauri's IPC transport, which is a `fetch` to
    /// `http://ipc.localhost` on Windows, and the image protocol — while refusing any
    /// wildcard. `style-src-attr` is here because the virtualised result list positions
    /// every row with an inline `style` attribute, and a hash injected into `style-src`
    /// at build time is what would otherwise silently disable `'unsafe-inline'` for it.
    #[test]
    fn the_shipped_csp_allows_ipc_and_images_and_nothing_wild() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let security = &conf["app"]["security"];
        let csp = security["csp"]
            .as_str()
            .expect("app.security.csp must not be null");
        for required in [
            "default-src 'self'",
            "ipc:",
            "http://ipc.localhost",
            "mtgimg:",
            "http://mtgimg.localhost",
            "style-src-attr 'unsafe-inline'",
            "object-src 'none'",
        ] {
            assert!(csp.contains(required), "CSP is missing `{required}`: {csp}");
        }
        assert!(
            !csp.contains('*'),
            "no wildcard sources belong in the CSP: {csp}"
        );

        // Dev has to reach Vite's HMR socket, which production must not carry.
        let dev = security["devCsp"]
            .as_str()
            .expect("app.security.devCsp must be set");
        assert!(dev.contains("ws://localhost:1420"), "{dev}");
        assert!(
            !csp.contains("localhost:1420"),
            "dev-only sources leaked into csp: {csp}"
        );
        // The dev policy is the one under daily pressure — every "just let me load this"
        // is proposed against it, and a wildcard added here is a wildcard nobody sees
        // fail. It is also what every UI task is smoke-tested under, so a source that is
        // wild in dev is a source production has never been exercised without.
        assert!(
            !dev.contains('*'),
            "no wildcard sources belong in devCsp: {dev}"
        );
    }
}
