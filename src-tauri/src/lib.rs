pub mod card;
pub mod card_row;
pub mod collection;
pub mod db;
pub mod deck;
pub mod deck_audit;
pub mod deck_meta;
pub mod deck_theory;
pub mod filters;
pub mod images;
pub mod ingest;
pub mod maintenance;
pub mod paths;
pub mod reconcile;
pub mod schema;
pub mod scryfall;
pub mod search;
pub mod sorting;
pub mod sync;
pub mod update;
pub mod wishlist;

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
/// but not free, and a UI is expected to poll it. `sync::status` reads through the
/// read-only connection, so a poll never queues behind an ingest — see `sync::status`.
#[tauri::command]
async fn sync_status(state: tauri::State<'_, Arc<AppState>>) -> Result<sync::SyncStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync::status(&state))
        .await
        .map_err(|e| format!("could not read sync status: {e}"))
}

/// What the app knows about a newer release, read from `app_meta` and the process's own
/// state. No network — the ribbon polls this.
#[tauri::command]
async fn update_status(
    state: tauri::State<'_, Arc<AppState>>,
    updater: tauri::State<'_, Arc<update::Updater>>,
) -> Result<update::UpdateStatus, String> {
    Ok(update::status(state.inner(), updater.inner()))
}

/// Ask GitHub. `force` skips the 24 h throttle; a second concurrent call is refused.
#[tauri::command]
async fn update_check(
    state: tauri::State<'_, Arc<AppState>>,
    updater: tauri::State<'_, Arc<update::Updater>>,
    force: bool,
) -> Result<update::UpdateStatus, String> {
    update::check(state.inner(), updater.inner(), force).await
}

/// Download, verify and stage the update. Changes nothing about the running app.
#[tauri::command]
async fn update_download(
    state: tauri::State<'_, Arc<AppState>>,
    updater: tauri::State<'_, Arc<update::Updater>>,
    app: tauri::AppHandle,
) -> Result<update::UpdateStatus, String> {
    update::download(state.inner(), updater.inner(), &app).await
}

/// Install what was staged, and leave. The window closes moments after this answers.
#[tauri::command]
async fn update_apply(
    updater: tauri::State<'_, Arc<update::Updater>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    update::apply(updater.inner(), &app)
}

/// Open the release on github.com, for the install kinds that cannot update in place.
#[tauri::command]
async fn update_open_release_page(
    state: tauri::State<'_, Arc<AppState>>,
    updater: tauri::State<'_, Arc<update::Updater>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = update::status(state.inner(), updater.inner())
        .available
        .map(|r| r.html_url)
        .filter(|u| u.starts_with("https://github.com/"))
        .unwrap_or_else(|| format!("https://github.com/{}/releases/latest", update::REPO));
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("could not open the release page: {e}"))
}

/// Where update checks are sent.
///
/// Always `api.github.com` in a shipped build — the override below is compiled out entirely,
/// so a release binary has no way to be pointed at another host whatever its environment
/// says. That is the whole reason for the `cfg`: this exists so a **debug** build can be
/// aimed at a local release fixture and made to download, verify, swap and relaunch for
/// real, which is the one part of the updater no test can reach. Nothing else can honestly
/// prove the portable swap works.
fn update_api_base() -> String {
    #[cfg(debug_assertions)]
    if let Ok(base) = std::env::var("MTG_GRIMOIRE_UPDATE_API") {
        if !base.is_empty() {
            eprintln!("update checks pointed at {base} (debug build only)");
            return base;
        }
    }
    update::GITHUB_API.to_owned()
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
    // **Before the builder, and it has to be before it.** A build that has just replaced
    // its predecessor is launched with `--await-predecessor`, and what it is waiting for is
    // the old process to release the single-instance lock. By the time
    // `tauri_plugin_single_instance` has initialised, the decision is already made: a
    // second instance is given exit code 0, no window and no stderr, so a successor that
    // starts too early simply vanishes — and the user is left looking at the old version
    // with nothing to say why. See `update::await_predecessor`.
    let exe = std::env::current_exe().unwrap_or_default();
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == update::AWAIT_FLAG) {
        update::await_predecessor(&exe, update::predecessor_pid(args));
    }

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
        // Card art, served from the local cache. Tauri has no `registerSchemesAsPrivileged`
        // (that is Electron): registering the scheme here is what privileges it, and the
        // CSP in tauri.conf.json is what lets the page load from it. On Windows the origin
        // is `http://mtgimg.localhost/…` and elsewhere `mtgimg://localhost/…`, so only the
        // path is ever read.
        //
        // Asynchronous, because a cache miss is a network fetch: the synchronous form
        // would block the webview's resource loader — every other image on the page
        // included — for the length of one download.
        .register_asynchronous_uri_scheme_protocol("mtgimg", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_owned();
            tauri::async_runtime::spawn(async move {
                responder.respond(images::serve(&app, &path).await);
            });
        })
        .invoke_handler(tauri::generate_handler![
            sync_run,
            sync_status,
            search::search_cards,
            search::list_sets,
            card::card_detail,
            card::card_printings,
            images::prefetch_images,
            images::prewarm_collection,
            collection::collection_add,
            collection::collection_set_quantity,
            collection::collection_update,
            collection::collection_remove,
            collection::collection_list,
            collection::collection_summary,
            wishlist::wishlist_add,
            wishlist::wishlist_set_quantity,
            wishlist::wishlist_remove,
            wishlist::wishlist_list,
            deck::deck_create,
            deck::deck_update,
            deck::deck_delete,
            deck::deck_duplicate,
            deck::deck_set_cover_image,
            deck::deck_set_folder,
            deck::deck_list,
            deck::deck_get,
            deck::deck_add_card,
            deck::deck_set_card_quantity,
            deck::deck_move_card,
            deck::deck_swap_printing,
            deck::deck_missing_to_wishlist,
            deck::format_specs_list,
            deck_meta::deck_category_list,
            deck_meta::deck_category_create,
            deck_meta::deck_category_rename,
            deck_meta::deck_category_set_active,
            deck_meta::deck_category_reorder,
            deck_meta::deck_category_delete,
            deck_meta::deck_tag_list,
            deck_meta::deck_tag_create,
            deck_meta::deck_tag_update,
            deck_meta::deck_tag_delete,
            deck_meta::deck_tag_suggestions,
            deck_meta::deck_card_set_tag,
            deck_meta::deck_folder_list,
            deck_meta::deck_folder_create,
            deck_meta::deck_folder_rename,
            deck_meta::deck_folder_move,
            deck_meta::deck_folder_delete,
            deck_audit::deck_audit_list,
            deck_theory::deck_theory_diff,
            deck_theory::deck_theory_copy_from_live,
            deck_theory::deck_theory_missing_to_wishlist,
            update_status,
            update_check,
            update_download,
            update_apply,
            update_open_release_page
        ])
        .setup(|app| {
            // Printed as well as returned: a `Box<dyn Error>` out of `setup` reaches the
            // user as an escaped one-line panic, which turns a multi-line message naming
            // both candidate folders into something unreadable.
            let state = Arc::new(init_state(app).inspect_err(|e| eprintln!("{e}"))?);
            app.manage(state.clone());

            // Here rather than before the builder, and the difference is one rare bug: this
            // deletes a staged build, and the second instance of a double-click would
            // otherwise delete the *first* instance's staged update on its way to being
            // refused. `setup` runs only for the instance that won the single-instance
            // guard, so what it clears is always its own. (The `.old` a swap leaves is
            // deleted earlier still, by `await_predecessor`; this is the path that finally
            // clears one whose successor never got that far.)
            let exe = std::env::current_exe().unwrap_or_default();
            update::clean_up(&exe);

            // Decided once here — `Updater::new` probes whether it can write beside the exe
            // — so a status poll never re-answers a question that cannot change.
            let updater = Arc::new(update::Updater::new(update_api_base(), exe));
            app.manage(updater.clone());

            // Launch is never blocked on the network: the window comes up immediately
            // and this run reports itself through `sync:progress`. The throttle inside
            // makes it a no-op on all but the first launch of the day.
            let handle = app.handle().clone();
            let sync_state = state.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sync::run_sync(sync_state, handle, false).await {
                    eprintln!("initial sync failed: {e}");
                }
            });

            // The daily update check, in its own task rather than chained onto the sync:
            // the two answer to different services on different schedules, and a Scryfall
            // failure must not be the reason the app stops noticing its own releases. Its
            // result is written to `app_meta`, so the ribbon reads it without an event —
            // which also means nothing is lost if this finishes before the webview is
            // listening, the trap `sync:progress` has to work around.
            tauri::async_runtime::spawn(async move {
                if let Err(e) = update::check(&state, &updater, false).await {
                    eprintln!("update check failed: {e}");
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

/// How long the exit handler will wait for the write connection.
///
/// Nothing short-lived contends for `db` any more: searches and status polls read through
/// `db_read`, and the image cache's bookkeeping asks with a zero timeout it is content to
/// lose. What is left is the sync, which now takes the connection one batch at a time — so
/// this wait is nearly always instant, and five seconds is simply where it stops trying. A
/// window-less process still sitting on a lock is a process the user believes has quit.
const EXIT_CHECKPOINT_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

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
    // The *write* connection: a read-only handle may not checkpoint. Bounded, because
    // the alternative is parking a window-less process for the length of an ingest — and
    // a skipped checkpoint costs disk space, never data. The WAL is a complete journal
    // and the next launch replays it.
    //
    // Bound to a local rather than matched in tail position: the guard borrows from
    // `state`, and a `match` at the end of the body would still hold it when `state` is
    // dropped.
    let held = db::lock_for(&state.db, EXIT_CHECKPOINT_WAIT);
    match held {
        Some(conn) => {
            let _ = db::checkpoint_truncate(&conn);
        }
        None => eprintln!(
            "skipped the exit checkpoint: a sync still holds the database. \
             The write-ahead log will be folded in on the next launch."
        ),
    }
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
            "MTG Grimoire could not locate a folder to store its data in: {e}\n\
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
    schema::prepare_database(&conn).map_err(|e| {
        format!(
            "MTG Grimoire could not prepare its database at {}: {e}\n\
             The file may be from a newer version of the app, or damaged. Moving it \
             aside will let the app rebuild it from Scryfall.",
            db_path.display()
        )
    })?;
    // Opened after `prepare_database`, and only after: a read-only connection to a file
    // that has no tables yet would be a handle that can never be made useful. Same error
    // message as the write connection — if this fails, the folder is the reason.
    let conn_read = db::open_read_only(&db_path)
        .map_err(|e| data_dir_error(portable.as_deref(), &fallback, e))?;

    // Built before the struct, because `data_dir` is moved into it.
    let images = images::Cache::new(data_dir.join("images"));

    Ok(AppState {
        db: Mutex::new(conn),
        db_read: Mutex::new(conn_read),
        data_dir,
        syncing: AtomicBool::new(false),
        client: scryfall::Client::new(SCRYFALL_API.to_owned()),
        images,
    })
}

/// The startup message for "nowhere to put the database", naming both candidates.
fn data_dir_error(portable: Option<&Path>, fallback: &Path, err: rusqlite::Error) -> String {
    let portable = portable.map_or_else(
        || "  (the app's own folder could not be determined)".to_owned(),
        |p| format!("  {}", p.display()),
    );
    format!(
        "MTG Grimoire could not create or open its database.\n\
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
            Path::new("C:\\Users\\x\\AppData\\Roaming\\com.mtggrimoire.app\\data"),
            rusqlite::Error::InvalidQuery,
        );
        assert!(msg.contains("D:\\Apps\\mtg\\data"), "{msg}");
        assert!(
            msg.contains("C:\\Users\\x\\AppData\\Roaming\\com.mtggrimoire.app\\data"),
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
