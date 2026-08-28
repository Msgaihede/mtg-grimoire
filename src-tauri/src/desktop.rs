//! Everything that only exists when there is a Tauri window: the command registry, the
//! app's startup, and the seventeen commands that have no module of their own.
//!
//! Split out of `lib.rs` so that the crate's *module map* is the only thing at the root.
//! `lib.rs` is then readable as the one place that says what compiles where, and this file
//! is `#[cfg(not(target_family = "wasm"))]` in one line rather than in a hundred.
//!
//! The `#[cfg(desktop)]` / `#[cfg(mobile)]` gates *inside* are a different axis and are
//! Android's, not wasm's: this whole file is already excluded from the browser build.

// **These are here because `lib.rs`'s bare paths were crate-root paths.** Every one of them
// was spelled `sync::…`, `card::…`, `deck::…` in the file this was cut out of, and that
// resolves at the crate root and nowhere else — Rust 2018 looks a bare path up in the
// *current* module and the extern prelude, so from a submodule `sync::AppState` reads as a
// crate named `sync`. Importing the modules rather than rewriting ~300 call sites keeps this
// move a move: not one path below changed.
use crate::sync::AppState;
use crate::{
    card, collection, collection_alloc, collection_folders, combos, db, deck, deck_audit,
    deck_meta, deck_theory, deck_undo, errors, export, flatten, images, import, index, listview,
    marketplace, marketplace_feed, mirror, nav, paths, reset, schema, scryfall, search, sync,
    sync_engine, sync_pair, tags, update, wishlist, wishlist_folders, zoom,
};
// **Not in the list above, because this file compiles for Android too.** Its name says
// `desktop`, but its gate is `cfg(not(target_family = "wasm"))` — desktop *and* mobile — while
// `window` is `#[cfg(desktop)]` in `lib.rs` (`WebviewWindow::center()` does not exist on
// Android). The one call site below is already gated; only the import was not, and an
// unconditional `use` of a configured-out module is an error even when nothing calls it.
//
// Nothing in CI catches this: there is no Android job, so `main` compiled for Windows and
// Linux while `cargo build --target aarch64-linux-android` failed. Found by building an APK.
#[cfg(desktop)]
use crate::window;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
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

/// Every release the last check saw, newest first. No network — this reads the page that
/// check already fetched and cached, which is why expanding the version history costs
/// nothing out of GitHub's 60 requests an hour.
#[tauri::command]
async fn update_history(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<update::ReleaseNote>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || update::history(&state))
        .await
        .map_err(|e| format!("could not read the version history: {e}"))
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
        sync::with_write(&state, |conn| {
            errors::clear(conn).map_err(|e| format!("could not clear the error log: {e}"))
        })
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
/// Desktop only: it is called from the single-instance callback, which does not exist on
/// Android — and `WebviewWindow::unminimize` is itself `#[cfg(desktop)]` in tauri 2.11.5, so
/// this function does not merely go unused on a phone, it does not compile there.
#[cfg(desktop)]
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
    //
    // **Desktop only, and this one is "must not run" rather than "cannot compile"** — the
    // block builds fine for Android. There is no portable exe on a phone to swap, no
    // single-instance lock to wait on, and `current_exe()` there names the app's own
    // native-library directory. The flag is one only a self-replacing build ever passes
    // itself, so on Android this is dead weight with a `current_exe()` syscall attached.
    #[cfg(desktop)]
    {
        let exe = std::env::current_exe().unwrap_or_default();
        let args: Vec<String> = std::env::args().collect();
        if args.iter().any(|a| a == update::AWAIT_FLAG) {
            update::await_predecessor(&exe, update::predecessor_pid(args));
        }
    }

    // First, before every other plugin: this one has to decide whether the process
    // lives at all, and by the time another plugin has initialised, a second instance
    // has already opened `mtg.db` and the image cache directory that the first one
    // owns. Two processes sharing a WAL database is survivable; two sharing the temp
    // `.gz` an ingest streams from is not.
    //
    // **On Android the crate does not exist.** `tauri-plugin-single-instance`'s `lib.rs`
    // opens with `#![cfg(not(any(target_os = "android", target_os = "ios")))]`, so `init` is
    // not a no-op there — it is an unresolved name and a hard compile error. Android needs
    // none of it: the OS runs one task per application and there is no second process to
    // refuse. Two `let` bindings rather than one attribute inside the chain, because an
    // attribute on a mid-chain method call is not valid Rust — the same reason the MCP
    // bridge below is bound separately.
    #[cfg(desktop)]
    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_existing_window(app);
        }));
    #[cfg(mobile)]
    let builder = tauri::Builder::default();

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        // The system file picker: choosing a custom deck cover (`dialog:allow-open`) and
        // naming an export's destination (`dialog:allow-save`, `export_write_file` writes
        // there). Only those two verbs are granted in `capabilities/desktop.json` — message,
        // ask and confirm are unreachable from the webview however this is initialised. The
        // app's own questions are drawn in the page (`DeleteConfirm`, the settings dialog),
        // which is a deliberate choice and not an oversight: a native message box cannot be
        // styled, tested over CDP, or read by the story runner.
        .plugin(tauri_plugin_dialog::init())
        // Putting a decklist export on the clipboard, the other way out beside the save
        // dialog. `clipboard-manager:allow-write-text` only — nothing here reads the
        // clipboard, so `:default`'s read half is deliberately not granted.
        .plugin(tauri_plugin_clipboard_manager::init());

    // Android only, and it is here for `picked.rs` alone — see that module. Registering it is
    // what makes `app.try_state::<tauri_plugin_fs::Fs<_>>()` resolvable and what wires the
    // Kotlin `FsPlugin` into the activity, so a `content://` URI the document picker answered
    // can be turned into a file descriptor. **It grants the webview nothing**:
    // `capabilities/mobile.json` has no `fs:` entry, so every one of this plugin's own commands
    // is denied at the ACL and the page's filesystem access is unchanged — none.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_fs::init());

    // Windows 11 Snap Layouts for the app's own maximize button — and therefore desktop only,
    // since Android draws no caption at all and `capabilities/mobile.json` grants neither of
    // the two verbs. The crate itself compiles everywhere (a `#[cfg(not(windows))]` dummy that
    // still registers both commands, which is what keeps `capabilities/` resolvable on the
    // Linux CI leg), so this gate is about not *asking* for an overlay over a button that is
    // not on screen.
    //
    // `tauri.conf.json` sets
    // `decorations: false`, so the flyout Windows raises over a native maximize button is
    // gone — the OS asks its own frame `WM_NCHITTEST`, never a `<button>` in a webview.
    // This parks a transparent child window over that button's rectangle and answers
    // `HTMAXBUTTON`.
    //
    // **The id is the whole contract, and it fails silently on both sides.** A typo here
    // or in `SNAP_BUTTON_ID` creates no overlay, raises no error and logs nothing: the
    // button keeps working and Snap Layouts simply never appear, which is a regression no
    // test and no launch can catch. `src/lib/window.ts` holds the frontend's copy and says
    // the same thing.
    //
    // A no-op everywhere else — the crate's dummy implementation on non-Windows, and
    // documented as inert on Windows 10, where the OS has no Snap Layouts to raise.
    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_snap_layout::init()
            .button_id("snap-maximize-button")
            .build(),
    );

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
    // takes the narrow bind for the same reason `capabilities/desktop.json` takes
    // `dialog:allow-open` over `dialog:default`.
    //
    // Port 9223 (the plugin counts upward from it if it is busy), deliberately clear of the
    // three ports this repo hardcodes: 1420 Vite, 6006 Storybook, 9222 CDP.
    //
    // **`desktop` as well as `debug_assertions`, and the second half is not decoration.**
    // `tauri android dev` produces a *debug* build, so `debug_assertions` alone puts this
    // socket on the phone. `127.0.0.1` is a much weaker fence there than it is here: a
    // workstation's loopback is reachable by processes the reader installed deliberately,
    // whereas a phone's is reachable by every app on it, and this one evaluates arbitrary
    // JavaScript in a webview where `withGlobalTauri` has already put every command within
    // one `invoke`. **Denying the three commands in `capabilities/mobile.json` does not
    // cover this** — the listener is opened in Rust and the ACL is not in that path, so the
    // capability closes the front door of a house whose wall is missing. This `cfg` is the
    // wall.
    #[cfg(all(debug_assertions, desktop))]
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
            card::card_meld_parts,
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
            collection::collection_import_commit,
            collection_folders::collection_folder_list,
            collection_folders::collection_folder_create,
            collection_folders::collection_folder_rename,
            collection_folders::collection_folder_move,
            collection_folders::collection_folder_reorder,
            collection_folders::collection_folder_delete,
            collection_folders::collection_set_folder,
            collection_folders::collection_folder_summary,
            // The two writes that move copies across the deck boundary. Registered from
            // `collection_alloc::commands` so the wire names match the crate's own — see that
            // module. `generate_handler!` names a command after the last path segment.
            collection_alloc::commands::collection_to_deck,
            collection_alloc::commands::deck_to_collection,
            wishlist::wishlist_add,
            wishlist::wishlist_set_quantity,
            wishlist::wishlist_remove,
            wishlist::wishlist_list,
            wishlist::wishlist_import_commit,
            wishlist::wishlist_set_printing,
            wishlist_folders::wishlist_folder_list,
            wishlist_folders::wishlist_folder_create,
            wishlist_folders::wishlist_folder_rename,
            wishlist_folders::wishlist_folder_move,
            wishlist_folders::wishlist_folder_reorder,
            wishlist_folders::wishlist_folder_delete,
            wishlist_folders::wishlist_set_folder,
            wishlist_folders::wishlist_folder_summary,
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
            deck::deck_search_open,
            deck::set_deck_search_open,
            deck::deck_add_card,
            deck::deck_set_card_quantity,
            deck::deck_category_clear,
            deck::deck_move_card,
            deck::deck_swap_printing,
            deck::deck_set_card_finish,
            deck::deck_missing_to_wishlist,
            import::import_resolve,
            import::deck_import_commit,
            import::import_read_file,
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
            deck_meta::deck_tag_remove_from_deck,
            deck_meta::deck_tag_all,
            deck_meta::deck_card_set_tag,
            deck_meta::deck_folder_list,
            deck_meta::deck_folder_create,
            deck_meta::deck_folder_rename,
            deck_meta::deck_folder_move,
            deck_meta::deck_folder_reorder,
            deck_meta::deck_folder_delete,
            deck_audit::deck_audit_list,
            deck_undo::deck_undo_state,
            deck_undo::deck_undo_apply,
            deck_undo::deck_redo_apply,
            deck_theory::deck_theory_diff,
            deck_theory::deck_theory_slots,
            deck_theory::deck_theory_copy_from_live,
            deck_theory::deck_theory_missing_to_wishlist,
            marketplace::get_marketplace,
            marketplace::set_marketplace,
            zoom::card_zoom,
            zoom::set_card_zoom,
            nav::nav_collapsed,
            nav::set_nav_collapsed,
            listview::list_view,
            listview::set_list_view,
            flatten::flatten_state,
            flatten::set_flatten_state,
            marketplace_feed::marketplace_feed_refresh,
            marketplace_feed::marketplace_feed_status,
            combos::combos_status,
            combos::combos_refresh,
            combos::combos_for_cards,
            tags::oracle::oracle_tags_refresh,
            tags::oracle::oracle_tags_status,
            tags::oracle::oracle_tags_for_cards,
            tags::oracle::oracle_tags_for_printings,
            tags::art::art_tags_refresh,
            tags::art::art_tags_status,
            tags::query::tag_search,
            tags::query::tag_children,
            tags::query::tag_resolve,
            tags::muted::tag_mute,
            tags::muted::tag_unmute,
            tags::muted::tags_muted,
            export::export_write_file,
            reset::collection_clear,
            reset::wishlist_clear,
            reset::decks_clear,
            reset::cache_clear,
            error_log_list,
            error_log_clear,
            update_status,
            update_history,
            update_check,
            update_download,
            update_apply,
            update_open_release_page,
            // The plain-text mirror. Four commands and no more: the Backup panel's read, the
            // two settings, and the button that rewrites the folder now.
            mirror::settings::mirror_status,
            mirror::settings::mirror_set_enabled,
            mirror::settings::mirror_set_root,
            mirror::settings::mirror_rebuild,
            // Pairing (spec §7.5 and §7.6). Nine commands: the panel's read, the five
            // steps of the handshake, cancelling one, and the two things a roster row
            // can be told.
            sync_pair::pairing::sync_pairing_status,
            sync_pair::pairing::sync_pairing_begin,
            sync_pair::pairing::sync_pairing_accept,
            sync_pair::pairing::sync_pairing_respond,
            sync_pair::pairing::sync_pairing_confirm,
            sync_pair::pairing::sync_pairing_complete,
            sync_pair::pairing::sync_pairing_cancel,
            sync_pair::pairing::sync_device_rename,
            sync_pair::pairing::sync_device_revoke,
            // The relay and the review queue (spec §7.2–§7.4, §7.7). Five: the panel's read, the
            // relay address, one round trip now, the rows carrying a sentence, and clearing
            // one of them.
            sync_engine::commands::sync_relay_status,
            sync_engine::commands::sync_relay_set_url,
            sync_engine::commands::sync_now,
            sync_engine::commands::sync_review_list,
            sync_engine::commands::sync_review_clear
        ])
        .setup(|app| {
            // First, and before anything that can fail: the window is created **hidden**
            // (`tauri.conf.json`'s `"visible": false`), so until this runs the app has no
            // window at all. It opens at the largest of 1920×1080 and 1280×720 that the
            // monitor's *work area* holds — a 1080p desk cannot hold a 1080-tall window once
            // Windows has taken its taskbar out of it. See `window.rs`.
            // Android has no hidden-window step and no rungs to choose between — the
            // activity is already on screen and the OS sizes it.
            #[cfg(desktop)]
            window::open_sized_to_monitor(app.handle());

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

            // The plain-text mirror, in two halves that must stay in this order. **Desktop
            // only, and this is the decision rather than a limitation**: the mirror's whole
            // point is a folder a reader opens in a text editor, syncs with Dropbox or greps,
            // and on Android that directory is reachable mainly through a file-manager app and
            // often not by other apps at all. `tauri-plugin-dialog`'s own manifest records
            // Android support as "partial — Does not support folder picker", so the reader
            // could not choose the root either.
            //
            // The module still *compiles* on Android — `AppState` carries
            // `mirror::watch::{Mask, LastPass}` and six sites construct them — so what is
            // gated is the hook and the thread, which is the whole of what makes the mirror
            // do anything. `mirror_status` there answers a mirror that never runs.
            #[cfg(desktop)]
            {
                // First the hook, on `state.db` and **nowhere else**: that is the one
                // connection every user-facing write in this crate goes through
                // (`sync::with_write`), and `db_read` is opened read-only so it could never
                // fire one. It is installed before the thread starts so that nothing written
                // between here and the first pass can slip past unmarked — though the first
                // pass is `Dirty::ALL` and would cover it anyway, which is what makes this
                // ordering cheap insurance rather than a rule.
                //
                // The guard is bound rather than left a temporary so it is released before
                // `spawn`, which is the lifetime it had before the block existed.
                //
                // The third argument is the cross-file fence, which arrived with the
                // user/corpus split: the hook has to be able to tell the mirror which of the
                // two databases a write landed in.
                let conn = db::lock_blocking(&state.db);
                mirror::watch::install_hook(&conn, state.mirror.clone(), state.fence.clone());
                drop(conn);

                // Then the thread. Detached and never fatal, exactly like the facet warm-up
                // above: it runs one full pass now — the whole of what makes the folder
                // correct after a crash — and then wakes two seconds after the reader stops
                // editing. It reads through `db_read` and never takes the write connection, so
                // no press it overlaps can be answered `db::BUSY` by it.
                mirror::watch::spawn(state.clone());
            }

            // Here rather than before the builder, and the difference is one rare bug: this
            // deletes a staged build, and the second instance of a double-click would
            // otherwise delete the *first* instance's staged update on its way to being
            // refused. `setup` runs only for the instance that won the single-instance
            // guard, so what it clears is always its own. (The `.old` a swap leaves is
            // deleted earlier still, by `await_predecessor`; this is the path that finally
            // clears one whose successor never got that far.)
            let exe = std::env::current_exe().unwrap_or_default();
            // Desktop only: what it deletes is a staged `.new`/`.old` beside the executable,
            // and on Android that directory is the app's own native-library folder — nothing
            // ever stages anything there, and `current_exe()` may name a read-only mount.
            #[cfg(desktop)]
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
                tags::oracle::refresh_if_due(&tags_state, &tags_app).await;
            });

            // Scryfall's Art Tags, on a fifth task rather than chained onto the oracle one
            // above. **They are the same shape of job and that is exactly why they must not
            // share a task**: the art file is 12.5 MB against the oracle file's 5.85 MB, so
            // awaiting one before the other would make the bigger download the reason the
            // smaller taxonomy is late — and on a first run, the reason a deck add is still
            // categorising by card type minutes after launch. They contend for the write
            // connection a batch at a time, which is the engine's job and not the launch's.
            // Silent and best-effort, like every one of its siblings.
            let art_state = state.clone();
            let art_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tags::art::refresh_if_due(&art_state, &art_app).await;
            });

            // Commander Spellbook's combo database, on a sixth task — and, unlike the two
            // above it, **only if this database has ever fetched it**. That is
            // `refresh_if_due`'s own rule and it belongs there rather than here: the tag files
            // are what a deck add is categorised by, so a first run goes and gets them, while
            // combos are the fourth bracket signal and a database without them simply reads
            // three. Nothing downloads until a reader presses Refresh in Settings. Silent and
            // best-effort, like every one of its siblings.
            let combo_state = state.clone();
            let combo_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                combos::refresh_if_due(&combo_state, &combo_app).await;
            });

            // The daily update check, in its own task rather than chained onto the sync:
            // the two answer to different services on different schedules, and a Scryfall
            // failure must not be the reason the app stops noticing its own releases. Its
            // result is written to `app_meta`, so the ribbon reads it without an event —
            // which also means nothing is lost if this finishes before the webview is
            // listening, the trap `sync:progress` has to work around.
            //
            // **Desktop only.** On Android the store is what notices a new release, and asking
            // GitHub would spend a request and an `app_meta` row to learn something the app
            // cannot act on — `Updater::new` has already answered `InstallKind::Managed`
            // there, so every asset is refused and every button is hidden.
            #[cfg(desktop)]
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
    // `cfg!(desktop)` is passed in rather than tested inside, so both branches compile and are
    // tested on every platform — see `paths::data_dir_for`. On Android `portable` stays a name
    // that never becomes the answer: `data_dir_error` still reports both candidates, and the
    // one beside the executable is never probed.
    let data_dir = paths::data_dir_for(exe_dir.as_deref(), &app_data, cfg!(desktop));

    // **Before any connection the app keeps.** A folder holding a single pre-27 `mtg.db` is
    // taken apart here, and a `corpus.db` that will not open at all is deleted here — both
    // are file operations, and a file the app is holding open is a file it cannot replace.
    schema::prepare_data_dir(&data_dir).map_err(|e| {
        format!(
            "MTG Grimoire could not prepare its data folder at {}: {e}\n\
             The collection file may be from a newer version of the app, or damaged. \
             Moving it aside will let the app start from empty.",
            data_dir.display()
        )
    })?;
    let user_path = data_dir.join(db::USER_DB);
    let conn =
        db::open_write(&data_dir).map_err(|e| data_dir_error(portable.as_deref(), &fallback, e))?;
    schema::prepare_database(&conn).map_err(|e| {
        format!(
            "MTG Grimoire could not prepare its database at {}: {e}\n\
             The file may be from a newer version of the app, or damaged. Moving it \
             aside will let the app rebuild it from Scryfall.",
            user_path.display()
        )
    })?;
    // Opened after `prepare_database`, and only after: a read-only connection to a file
    // that has no tables yet would be a handle that can never be made useful. Same error
    // message as the write connection — if this fails, the folder is the reason. It attaches
    // the corpus too: every search reads `cards` and `collection_entries` in one statement,
    // and a handle that saw only one file would report an empty collection rather than fail.
    let conn_read =
        db::open_read(&data_dir).map_err(|e| data_dir_error(portable.as_deref(), &fallback, e))?;

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
        // Clean, and hooked up by `setup` for the index's reason: the hook holds a clone of
        // this `Arc`, and there is no `Arc` until this value has been put in one. Nothing has
        // been written yet either, so a clean mask is the truth — the startup pass is
        // `Dirty::ALL` regardless.
        mirror: Arc::new(mirror::watch::Mask::default()),
        mirror_status: Mutex::new(mirror::watch::LastPass::default()),
        // The mask's twin, and hooked up in the same call for the same reason: SQLite allows
        // one update hook per connection, so the fence has to ride in the mirror's.
        fence: Arc::new(db::CrossFileFence::new()),
        pairing: Mutex::new(None),
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
    /// The other half of the bridge's fence, and the half a capability file cannot hold.
    ///
    /// `the_mcp_bridge_gets_three_permissions_and_never_its_default` above and
    /// `the_mobile_capability_drops_every_verb_the_platform_has_no_answer_for` below both
    /// assert **ACL** facts, and both would stay green while a debug APK listened on the
    /// phone: the socket is opened by `Builder::build()` in Rust, and the ACL is not in that
    /// path. So the thing to assert is the `cfg` itself.
    ///
    /// **Asserting on source text is ugly, and it is the honest option here.** A `cfg` is
    /// resolved at compile time, so no runtime probe on this host can observe what an
    /// Android build did with it; and the plugin compiles for `aarch64-linux-android`
    /// perfectly well, so a green cross-compile proves nothing either. The regression this
    /// guards is somebody widening the gate back to `debug_assertions` while chasing a
    /// bridge problem — a one-token edit that no other test in this file can see.
    #[test]
    fn the_mcp_bridge_is_gated_on_desktop_and_not_only_on_a_debug_build() {
        // Lines, not a byte offset: the needle would otherwise have to carry an escaped
        // newline, and the first `find` in a file that also contains this very test is a
        // trap — it would happily match the test's own text if the two ever swapped order.
        //
        // **`desktop.rs` and not `lib.rs`**: the registration moved here with `run()` when
        // `lib.rs` became the crate's module map and nothing else. The needle below is now
        // in the same file as this test, which is exactly the trap the paragraph above
        // names — it survives because the quoted copy is mid-line and `l.trim()` of it is
        // the whole `.position(…)` call, and because `run()` sits above `mod tests`.
        let lines: Vec<&str> = include_str!("desktop.rs").lines().collect();
        let at = lines
            .iter()
            .position(|l| l.trim() == "tauri_plugin_mcp_bridge::Builder::new()")
            .expect("the bridge registration moved; this test must follow it");

        assert_eq!(
            lines[at - 2].trim(),
            "#[cfg(all(debug_assertions, desktop))]",
            concat!(
                "the MCP bridge must be gated on `all(debug_assertions, desktop)`. ",
                "`tauri android dev` builds with `debug_assertions` on, so the weaker gate ",
                "opens an unauthenticated JavaScript-evaluating socket on the phone's ",
                "loopback, where every installed app can reach it. Denying the commands in ",
                "`mobile.json` does not help: the listener is opened in Rust, not through ",
                "the ACL.",
            )
        );
    }

    #[test]
    fn the_mcp_bridge_gets_three_permissions_and_never_its_default() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop.json")).unwrap();
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
        let caps = include_str!("../capabilities/desktop.json");
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

    /// The custom title bar's four window verbs, and the two the snap overlay needs.
    ///
    /// `core:window:default` grants only the *getters* -- `is-maximized`, the position and
    /// size reads, the monitor queries -- so every mutator here had to be named. That is also
    /// what makes this list worth pinning: the four are the whole of what a webview can do to
    /// this window, and the family they come from contains `allow-set-always-on-top`,
    /// `allow-set-fullscreen`, `allow-set-position` and thirty more. Reaching for
    /// `core:window:default` while debugging would not widen it -- the default has no mutators
    /// at all -- but reaching for `core:window:allow-*` one entry at a time is exactly how a
    /// window gets an ACL nobody decided on.
    ///
    /// The frontend's half of the contract is `src/lib/window.ts`, which exports one function
    /// per permission and says so.
    #[test]
    fn the_title_bar_gets_four_window_verbs_and_the_overlay_two() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop.json")).unwrap();
        let granted: Vec<&str> = caps["permissions"]
            .as_array()
            .expect("the capability must list permissions")
            .iter()
            .map(|p| p.as_str().expect("every permission is a string"))
            .collect();

        let window: Vec<&str> = granted
            .iter()
            .copied()
            .filter(|p| p.starts_with("core:window:"))
            .collect();
        assert_eq!(
            window,
            [
                "core:window:allow-minimize",
                "core:window:allow-toggle-maximize",
                "core:window:allow-close",
                "core:window:allow-start-dragging",
            ],
            "the window's permission set changed"
        );

        let snap: Vec<&str> = granted
            .iter()
            .copied()
            .filter(|p| p.starts_with("snap-layout:"))
            .collect();
        assert_eq!(
            snap,
            [
                "snap-layout:allow-update-snap-bounds",
                "snap-layout:allow-detach-snap-bounds",
            ],
            "the snap overlay's permission set changed"
        );

        // The two commands above are the whole plugin, so `snap-layout:default` grants exactly
        // the same thing today -- and is still refused, because naming them is what records
        // that both were looked at. A plugin's default is a promise about *its* future, not
        // about this app's.
        assert!(!caps.to_string().contains("snap-layout:default"));
    }

    /// The desktop capability is what shipped as `default.json`, unchanged. Splitting the file
    /// must not be a widening or a narrowing of what the shipped app can do — this is the
    /// assertion that makes the split a refactor.
    ///
    /// `platforms` is a real field: `tauri-utils`' `acl::capability::Capability` declares
    /// `pub platforms: Option<Vec<Target>>`, serialising as `"macOS"`, `"windows"`, `"linux"`,
    /// `"android"`, `"iOS"`. Omitting it targets every platform, which is exactly why one file
    /// could not stay one file.
    #[test]
    fn the_desktop_capability_is_the_permission_set_that_shipped() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop.json")).unwrap();
        let got: Vec<&str> = cap["permissions"]
            .as_array()
            .expect("the capability must list permissions")
            .iter()
            .map(|p| p.as_str().expect("every permission is a string"))
            .collect();
        assert_eq!(
            got,
            vec![
                "core:default",
                "opener:default",
                "dialog:allow-open",
                "dialog:allow-save",
                "clipboard-manager:allow-write-text",
                "core:window:allow-minimize",
                "core:window:allow-toggle-maximize",
                "core:window:allow-close",
                "core:window:allow-start-dragging",
                "snap-layout:allow-update-snap-bounds",
                "snap-layout:allow-detach-snap-bounds",
                "mcp-bridge:allow-report-ipc-event",
                "mcp-bridge:allow-request-script-injection",
                "mcp-bridge:allow-script-result",
            ]
        );
        assert_eq!(
            cap["platforms"],
            serde_json::json!(["windows", "linux", "macOS"])
        );
    }

    /// Android's capability, and every absence in it is a decision.
    ///
    /// **The four window verbs are gone because three of them do not exist.** In tauri 2.11.5,
    /// `minimize`, `toggle_maximize` and `start_dragging` are all `#[cfg(desktop)]`
    /// (`tauri/src/window/plugin.rs`); only `close` is in the shared handler, and an app that
    /// can close itself from a button no phone user expects is not a feature. `TitleBar` is
    /// hidden on Android for the same reason — see `src/lib/platform.ts`.
    ///
    /// **Snap Layouts are gone** because there is no caption to park an overlay over.
    ///
    /// **The MCP bridge is gone** because it binds a WebSocket that authenticates nothing and
    /// evaluates arbitrary JavaScript, and `tauri android dev` produces a *debug* build — so
    /// `#[cfg(debug_assertions)]` puts that socket on a phone rather than on this
    /// workstation's loopback. Denying the three commands is not the whole answer, because the
    /// socket is opened in Rust and the ACL is not in that path; it is the half this file can
    /// do. Android is driven over CDP instead (see the reference doc).
    ///
    /// **`opener` is narrowed from `:default` to two verbs.** `opener:default` is
    /// `allow-open-url` + `allow-reveal-item-in-dir` + `allow-default-urls`, and revealing an
    /// item in a directory is not a thing Android's opener supports — its own manifest records
    /// Android as "partial — Only allows to open URLs via `open`". `allow-default-urls` stays:
    /// it is what permits `https:`, `http:`, `mailto:` and `tel:`.
    #[test]
    fn the_mobile_capability_drops_every_verb_the_platform_has_no_answer_for() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/mobile.json")).unwrap();
        let got: Vec<&str> = cap["permissions"]
            .as_array()
            .expect("the capability must list permissions")
            .iter()
            .map(|p| p.as_str().expect("every permission is a string"))
            .collect();
        assert_eq!(
            got,
            vec![
                "core:default",
                "opener:allow-open-url",
                "opener:allow-default-urls",
                "dialog:allow-open",
                "dialog:allow-save",
                "clipboard-manager:allow-write-text",
            ]
        );
        assert_eq!(cap["platforms"], serde_json::json!(["android"]));

        for denied in [
            "core:window:allow-minimize",
            "core:window:allow-toggle-maximize",
            "core:window:allow-close",
            "core:window:allow-start-dragging",
            "snap-layout:allow-update-snap-bounds",
            "snap-layout:allow-detach-snap-bounds",
            "mcp-bridge:allow-report-ipc-event",
            "mcp-bridge:allow-request-script-injection",
            "mcp-bridge:allow-script-result",
            "opener:default",
        ] {
            assert!(!got.contains(&denied), "{denied} must not reach Android");
        }

        // No `fs:` permission, on any platform, ever. Task 5 adds `tauri-plugin-fs` to the
        // Android build and reaches it from **Rust**, where the ACL is not in the path. A
        // grant here would be the page gaining a filesystem, which is the one thing this app
        // has never given it.
        assert!(
            !got.iter().any(|p| p.starts_with("fs:")),
            "no fs: permission is granted anywhere"
        );
    }

    /// The two files are a split and not a rewrite: no permission may exist in one and be
    /// unaccounted for in the other, and `default.json` must be gone rather than left behind
    /// as a third file targeting every platform — which is what would silently hand Android
    /// the window verbs back.
    #[test]
    fn the_capability_directory_is_exactly_the_two_platform_files() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .expect("capabilities/ must exist")
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["desktop.json", "mobile.json"]);
    }

    /// Without `decorations: false` the app draws two title bars: Windows' and
    /// `src/components/TitleBar.tsx`'s. With it and without the title bar, the window cannot
    /// be moved, maximized or closed at all.
    ///
    /// `shadow: true` is the other half of an undecorated window on Windows and is easy to
    /// lose because nothing breaks without it: the window simply renders with square corners
    /// and no drop shadow on Windows 11, sitting flat against the desktop with no border
    /// against a dark wallpaper.
    #[test]
    fn the_main_window_is_undecorated_and_keeps_its_shadow() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &conf["app"]["windows"][0];
        assert_eq!(
            main["decorations"],
            serde_json::Value::Bool(false),
            "the app draws its own title bar"
        );
        assert_eq!(
            main["shadow"],
            serde_json::Value::Bool(true),
            "an undecorated window needs its shadow asked for"
        );
    }

    /// The Android bundle block, pinned for the reason every other config assertion here is:
    /// `tauri.conf.json` is embedded at compile time and nothing else in the build reads these
    /// three fields back. A `minSdkVersion` silently dropped in a merge is a build that still
    /// succeeds and an app that installs on devices whose WebView cannot render it.
    ///
    /// **`minSdkVersion` 26 rather than the config default 24, and the reason is measurable**:
    /// this app's floor is whatever the system WebView on that release can run, and API 26
    /// (Android 8.0, 2017) is where the WebView became independently updatable through Play for
    /// every device. Going lower widens the device list and widens the set of WebViews that
    /// have to render a React 19 bundle.
    ///
    /// **`debugApplicationIdSuffix` is `.debug` so a debug build and a release build install
    /// side by side.** Without it a `tauri android dev` install replaces a release install and
    /// takes its data directory's place — which on a phone means the corpus is rebuilt.
    ///
    /// `versionCode` is left unset: Tauri derives it as `major*1000000 + minor*1000 + patch`,
    /// which is monotonic as long as release-please only ever moves the version forward.
    #[test]
    fn the_android_bundle_names_its_floor_and_its_debug_suffix() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let android = &conf["bundle"]["android"];
        assert_eq!(android["minSdkVersion"], 26);
        assert_eq!(android["debugApplicationIdSuffix"], ".debug");
        assert!(android["versionCode"].is_null());
    }

    /// **And the same two numbers where the build actually reads them, which is not that file.**
    ///
    /// `gen/android/` is generated once by `tauri android init` and then **committed**, because
    /// it carries hand-edits an `init` would drop. So `bundle.android` above is read at
    /// *generation* time and baked into `app/build.gradle.kts`; a later edit to
    /// `tauri.conf.json` alone changes nothing about the APK, silently. The test above would
    /// stay green through exactly that drift, which is the failure it looks like it prevents.
    ///
    /// Verified rather than assumed on 2026-08-28: the config was set to 26, `android init`
    /// re-run, and the generated Gradle went from `minSdk = 24` to `minSdk = 26`.
    #[test]
    fn the_generated_gradle_carries_the_floor_the_config_asked_for() {
        let gradle = include_str!("../gen/android/app/build.gradle.kts");
        assert!(
            gradle.contains("minSdk = 26"),
            "gen/android/app/build.gradle.kts must carry minSdkVersion 26 — re-run \
             `npx tauri android init` after changing bundle.android in tauri.conf.json"
        );
        assert!(
            gradle.contains("applicationIdSuffix = \".debug\""),
            "the debug suffix must reach the Gradle project, not just the Tauri config"
        );
        // compileSdk/targetSdk come from the CLI template rather than from this repo's config,
        // and are pinned here so a CLI upgrade that moves them is a red build rather than a
        // surprise on the phone.
        assert!(gradle.contains("compileSdk = 36"));
        assert!(gradle.contains("targetSdk = 36"));
    }

    /// The manifest asks for `INTERNET` and nothing else, and every absence is the point: no
    /// storage permission (the document picker grants access per-URI, which is what
    /// `picked.rs` opens), no location, no camera. A permission here is a permission a Play
    /// listing has to justify, and the generated template asked for exactly this one.
    #[test]
    fn the_android_manifest_asks_for_the_internet_and_nothing_else() {
        let manifest = include_str!("../gen/android/app/src/main/AndroidManifest.xml");
        let asked: Vec<&str> = manifest
            .match_indices("<uses-permission")
            .map(|(i, _)| {
                let rest = &manifest[i..];
                let end = rest.find("/>").unwrap_or(rest.len());
                &rest[..end]
            })
            .collect();
        assert_eq!(asked.len(), 1, "exactly one permission: {asked:?}");
        assert!(
            asked[0].contains("android.permission.INTERNET"),
            "the one permission is INTERNET: {asked:?}"
        );
    }

    /// **`android:allowBackup` is `false`, and the regression this guards is the attribute's
    /// *absence*** — an unset `allowBackup` defaults to **true**, which is the state the
    /// generated template shipped in. So there is nothing to see in a diff: the failure is a
    /// line that is not there.
    ///
    /// Android Auto Backup would copy the app's data directory into the reader's Google Drive.
    /// **This app's design is that no server holds anything it can read** — no account, no
    /// signup, end-to-end encryption for the sync that does exist — and uploading somebody's
    /// collection, their decks and what they paid for each card, without them ever choosing it,
    /// contradicts that. The ~500 MB corpus against Auto Backup's 25 MB quota is the *second*
    /// reason and the weaker one: it is repaired by excluding the corpus and backing up the
    /// user tables, which is the same privacy failure with a smaller payload.
    ///
    /// **The assertion reads the value out of the `<application>` open tag, and that is the
    /// whole point of it.** A `manifest.contains("allowBackup=\"false\"")` could not tell the
    /// attribute's absence from its presence, because the comment standing above the element in
    /// the manifest quotes it verbatim — deleting the attribute would leave that test green.
    /// Scoping to the tag fails on the deletion *and* on the sneakier mutation, a flip to
    /// `"true"`. Both were run.
    ///
    /// `include_str!` for `the_android_manifest_asks_for_the_internet_and_nothing_else`'s
    /// reason: `gen/android/` is committed and `android init` is not re-run, so this file is a
    /// source file — and a re-init that silently restored the template's manifest, dropping the
    /// attribute with it, is exactly what turns red here.
    #[test]
    fn the_android_application_refuses_auto_backup() {
        let manifest = include_str!("../gen/android/app/src/main/AndroidManifest.xml");
        let open = manifest
            .find("<application")
            .expect("the manifest declares an <application> element");
        let rest = &manifest[open..];
        let tag = &rest[..rest.find('>').expect("the <application> tag is closed")];

        let value = tag
            .split_whitespace()
            .find_map(|attr| attr.strip_prefix("android:allowBackup="))
            .unwrap_or_else(|| {
                panic!(
                    "<application> must set android:allowBackup — unset defaults to true, and \
                     Android Auto Backup would upload the reader's collection to Google Drive: \
                     {tag}"
                )
            });
        assert_eq!(
            value, "\"false\"",
            "android:allowBackup must be exactly \"false\": {tag}"
        );
    }
}
