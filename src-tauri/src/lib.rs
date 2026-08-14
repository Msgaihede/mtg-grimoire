pub mod card;
pub mod card_row;
pub mod collection;
pub mod db;
pub mod deck;
pub mod deck_audit;
pub mod deck_import;
pub mod deck_meta;
pub mod deck_theory;
pub mod errors;
pub mod export;
pub mod filters;
pub mod images;
pub mod index;
pub mod ingest;
pub mod legalities;
pub mod maintenance;
pub mod marketplace;
pub mod marketplace_feed;
pub mod oracle_tags;
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

/// The error log, newest first.
///
/// Read through `db_read` like every other read, so opening Settings during a sync answers
/// rather than queueing behind the ingest — which matters more here than anywhere: the
/// reason to open this panel is usually that something is going wrong right now.
#[tauri::command]
async fn error_log_list(
    state: tauri::State<'_, Arc<AppState>>,
    limit: i64,
) -> Result<Vec<errors::ErrorEntry>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = sync::lock_db_read(&state);
        errors::list(&conn, limit).map_err(|e| format!("could not read the error log: {e}"))
    })
    .await
    .map_err(|e| format!("could not read the error log: {e}"))?
}

/// Empty the error log. The one write the UI can make to it.
#[tauri::command]
async fn error_log_clear(state: tauri::State<'_, Arc<AppState>>) -> Result<usize, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        match db::lock_for(&state.db, db::WRITE_LOCK_WAIT) {
            Some(conn) => {
                errors::clear(&conn).map_err(|e| format!("could not clear the error log: {e}"))
            }
            None => Err(collection::BUSY.to_owned()),
        }
    })
    .await
    .map_err(|e| format!("could not clear the error log: {e}"))?
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

    let builder = tauri::Builder::default()
        // First, before every other plugin: this one has to decide whether the process
        // lives at all, and by the time another plugin has initialised, a second instance
        // has already opened `mtg.db` and the image cache directory that the first one
        // owns. Two processes sharing a WAL database is survivable; two sharing the temp
        // `.gz` an ingest streams from is not.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_existing_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        // The system file picker: choosing a custom deck cover (`dialog:allow-open`) and
        // naming an export's destination (`dialog:allow-save`, `export_write_file` writes
        // there). Only those two verbs are granted in `capabilities/default.json` — message,
        // ask and confirm are unreachable from the webview however this is initialised. The
        // app's own questions are drawn in the page (`DeleteConfirm`, the settings dialog),
        // which is a deliberate choice and not an oversight: a native message box cannot be
        // styled, tested over CDP, or read by the story runner.
        .plugin(tauri_plugin_dialog::init())
        // Putting a decklist export on the clipboard, the other way out beside the save
        // dialog. `clipboard-manager:allow-write-text` only — nothing here reads the
        // clipboard, so `:default`'s read half is deliberately not granted.
        .plugin(tauri_plugin_clipboard_manager::init());

    // The MCP bridge, and the only reason the chain is split in two: this plugin exists in a
    // debug build and not in a release one, which `.plugin(…)` mid-chain cannot express.
    //
    // It opens a WebSocket server inside this process; `@hypothesi/tauri-mcp-server` in
    // `.mcp.json` is the client that dials it. That is what lets an agent drive the real
    // window — read the DOM, invoke commands, watch IPC go past — the way `scripts/cdp.mjs`
    // drives the page over CDP. The two are complementary, not rivals: CDP sees the webview,
    // this sees the webview *and* the Rust side of every `invoke`.
    //
    // **`127.0.0.1`, never the plugin's own `0.0.0.0` default.** The bridge evaluates
    // arbitrary JavaScript in the webview on request and authenticates nothing — and since
    // `withGlobalTauri` puts `window.__TAURI__` in reach of that script, every command in the
    // handler below is one `invoke` away from anyone who can open the socket. The plugin's
    // default is for driving a phone across your LAN; this app is a single local user, so it
    // takes the narrow bind for the same reason `capabilities/default.json` takes
    // `dialog:allow-open` over `dialog:default`.
    //
    // Port 9223 (the plugin counts upward from it if it is busy), deliberately clear of the
    // three ports this repo hardcodes: 1420 Vite, 6006 Storybook, 9222 CDP.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .bind_address("127.0.0.1")
            .build(),
    );

    builder
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
            index::facets::facet_cards,
            card::card_detail,
            card::card_printings,
            card::card_image_uri,
            card::printing_group_by,
            card::set_printing_group_by,
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
            deck::deck_set_view_state,
            deck::deck_list,
            deck::deck_get,
            deck::deck_last_format,
            deck::deck_add_card,
            deck::deck_set_card_quantity,
            deck::deck_move_card,
            deck::deck_swap_printing,
            deck::deck_missing_to_wishlist,
            deck_import::deck_import_resolve,
            deck_import::deck_import_commit,
            deck_import::deck_import_read_file,
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
            marketplace::get_marketplace,
            marketplace::set_marketplace,
            marketplace_feed::marketplace_feed_refresh,
            marketplace_feed::marketplace_feed_status,
            oracle_tags::oracle_tags_refresh,
            oracle_tags::oracle_tags_status,
            oracle_tags::oracle_tags_for_cards,
            oracle_tags::oracle_tags_for_printings,
            export::export_write_file,
            error_log_list,
            error_log_clear,
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

            // Warm the facet index: ~767 ms of full table scan on its own thread and its own
            // read-only connection, so the window comes up now and the first searches answer
            // out of `db_read` untouched. Here rather than inside `init_state` because that
            // returns an `AppState` and this needs the `Arc` — and because it must run after
            // `prepare_database`, which is the last thing that can change what `cards` is.
            // Until it lands, `facet_cards` answers `ready: false` and every filter control
            // stays live. Nothing about it is fatal; the handle is dropped and the thread
            // runs detached.
            index::lifecycle::spawn_build(&state);

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

            // The selected marketplace's price feed, if it is one this app downloads and it is
            // due. Its own task for the update check's reason — three services, three
            // schedules, and none of them may be the reason another stops running — and
            // deliberately *only* the selected one: nobody downloads 63.7 MiB for a
            // marketplace they never picked, which is the whole shape of
            // `refresh_selected_if_due`. Silent and best-effort; a failure is already in
            // `error_log` and the honest fallback is the prices already on disk.
            let feed_state = state.clone();
            let feed_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                marketplace_feed::refresh_selected_if_due(&feed_state, &feed_app).await;
            });

            // Scryfall's Oracle Tags, if the stored copy is due. Its own task for the same
            // reason as the two above — a fourth service on a fourth schedule, and none of
            // them may be the reason another stops running — and deliberately *after* the
            // card sync is spawned rather than chained onto it: the two write different
            // tables, both take the connection a batch at a time, and a tag file that never
            // arrives must cost the corpus nothing. Silent and best-effort; a failure is
            // already in `error_log` and the honest fallback is categorising by card type,
            // which is what the app did before this existed.
            let tags_state = state.clone();
            let tags_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                oracle_tags::refresh_if_due(&tags_state, &tags_app).await;
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
    // Before the checkpoint, and with the same wait: any `image_cache` row still owed is
    // bytes already on disk that nothing will ever serve, so paying the queue off here is
    // the difference between a warm cache and re-fetching those images forever. It is one
    // upsert per owed row and the queue is empty on a normal exit.
    state.images.flush_records(&state.db, EXIT_CHECKPOINT_WAIT);

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

    // Re-enter any 429 lockout an earlier run earned, before a single request can go out.
    //
    // Scryfall limits the *application*, not the process, so restarting the app is not a way
    // out of a lockout — and going straight back in is exactly what turns "your access is
    // limited for 30 seconds" into the temporary or permanent ban the docs promise repeat
    // offenders. `restore_penalty` clamps, so neither a clock that moved nor a hand-edited
    // row can lock the app out for longer than this app would ever impose on itself.
    let client = scryfall::Client::new(SCRYFALL_API.to_owned());
    if let Some(until) = update::get_app_meta(&conn, sync::K_SCRYFALL_PENALTY_UNTIL)
        .and_then(|v| v.parse::<u64>().ok())
    {
        client.restore_penalty(until, scryfall::unix_now());
    }

    Ok(AppState {
        db: Mutex::new(conn),
        db_read: Mutex::new(conn_read),
        data_dir,
        syncing: AtomicBool::new(false),
        client,
        images,
        // Cold, and built by `setup` the moment this state is in an `Arc` — see there for
        // why the build cannot be started from in here.
        index: std::sync::RwLock::default(),
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

    /// Same argument as the CSP test above, for the same reason: the MCP bridge's blast
    /// radius is set entirely in **configuration**, so nothing else can fail when it is
    /// widened. It evaluates arbitrary JavaScript in the window, and `withGlobalTauri` puts
    /// every command in the handler within one `invoke` of that script — which is the point,
    /// and is why the permission list is the narrow one and not `mcp-bridge:default`.
    ///
    /// `:default` grants all thirteen of the plugin's commands. The webview invokes three;
    /// the other ten are dispatched in Rust by the plugin's own `websocket.rs` and never
    /// cross the IPC boundary, so the ACL is not even in their path.
    /// `docs/reference/tauri-mcp-bridge.md` has the working out. The likely way this
    /// regresses is someone debugging a bridge problem by reaching for `:default` — which
    /// would fix nothing, because a command the ACL never sees cannot be denied by it.
    #[test]
    fn the_mcp_bridge_gets_three_permissions_and_never_its_default() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let granted: Vec<&str> = caps["permissions"]
            .as_array()
            .expect("the capability must list permissions")
            .iter()
            .map(|p| p.as_str().expect("every permission is a string"))
            .collect();

        let bridge: Vec<&str> = granted
            .iter()
            .copied()
            .filter(|p| p.starts_with("mcp-bridge:"))
            .collect();
        assert_eq!(
            bridge,
            [
                "mcp-bridge:allow-report-ipc-event",
                "mcp-bridge:allow-request-script-injection",
                "mcp-bridge:allow-script-result",
            ],
            "the bridge's permission set changed"
        );

        // `bridge.js` reaches the IPC through `window.__TAURI__` and there is no other route.
        // Dropping this does not fail a build or a launch: the bridge still connects, and
        // then IPC monitoring, script injection and every `execute_js` return value go quiet
        // — which is the failure mode nobody reports because everything still answers.
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["app"]["withGlobalTauri"],
            serde_json::Value::Bool(true),
            "the MCP bridge needs window.__TAURI__ exposed"
        );
    }

    /// The two permissions the export feature needs, and the two families it must never gain
    /// on the way — same argument as `dialog:allow-open` above: the narrowest permission,
    /// never a plugin's `:default`.
    #[test]
    fn the_capability_grants_two_new_narrow_permissions_and_no_filesystem() {
        let caps = include_str!("../capabilities/default.json");
        assert!(caps.contains("\"dialog:allow-save\""));
        assert!(caps.contains("\"clipboard-manager:allow-write-text\""));
        // The whole reason `export_write_file` exists. See `export.rs`.
        assert!(
            !caps.contains("\"fs:"),
            "no fs: permission is granted anywhere, deliberately"
        );
        // Nothing in this app reads the clipboard.
        assert!(!caps.contains("allow-read-text"));
        // Never a :default -- dialog's is five commands, clipboard's includes the read.
        assert!(!caps.contains("dialog:default"));
        assert!(!caps.contains("clipboard-manager:default"));
    }
}
