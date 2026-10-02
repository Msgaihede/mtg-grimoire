//! Everything that only exists when there is a Tauri window: the command registry, the
//! app's startup, and the commands that have no module of their own. (This said *seventeen*
//! while there were ten; `grep -c '^#\[tauri::command\]'` is the count, and it is not kept here.
//! **Anchor it** — `generate_handler!`'s own comment below names the attribute, so the
//! unanchored grep answers one more than there are commands.)
//!
//! Split out of `lib.rs` so that the crate's *module map* is the only thing at the root.

// **These are here because `lib.rs`'s bare paths were crate-root paths.** Every one of them
// was spelled `sync::…`, `card::…`, `deck::…` in the file this was cut out of, and that
// resolves at the crate root and nowhere else — Rust 2018 looks a bare path up in the
// *current* module and the extern prelude, so from a submodule `sync::AppState` reads as a
// crate named `sync`. Importing the modules rather than rewriting ~300 call sites keeps this
// move a move: not one path below changed.
use crate::sync::AppState;
use crate::{
    activity, camera, card, collection, collection_alloc, collection_folders, combos, db, deck,
    deck_audit, deck_completion, deck_meta, deck_missing, deck_notes, deck_pull, deck_query,
    deck_quick_add, deck_theory, deck_todos, deck_tokens, deck_undo, deckpane, decksort, errors,
    export, home, images, import, index, listview, markcolors, marketplace, marketplace_feed,
    mirror, nav, new_printings, paths, price_history, recent_cards, reset, scanner, schema,
    scryfall, search, searchopen, set_completion, share, shelffolds, stackhide, startup, startview,
    sticky_notes, sync, sync_engine, sync_pair, tags, upcoming_sets, update, value_history, window,
    wishlist, wishlist_folders, wishlist_optimize, zoom,
};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Production API host. `Client` takes it as a parameter so tests can point at a mock.
const SCRYFALL_API: &str = "https://api.scryfall.com";

/// Run a sync now. `force` bypasses the 24 h throttle; a second concurrent call is
/// refused rather than queued.
#[tauri::command]
async fn sync_run(
    state: tauri::State<'_, Arc<AppState>>,
    force: bool,
) -> Result<sync::SyncOutcome, String> {
    sync::run_sync(state.core.clone(), force).await
}

/// Open another window onto the same app — Ctrl+Shift+N. `caller` is the window that asked, so the
/// new one opens beside it (Tauri injects it by type; the name is ours, and is not `window` because
/// that is the module). `async` because building a window from a synchronous command deadlocks on
/// Windows; see `window::open_new`.
#[tauri::command]
async fn window_new(app: tauri::AppHandle, caller: tauri::WebviewWindow) -> Result<(), String> {
    window::open_new(&app, Some(&caller)).map(|_| ())
}

/// How many windows are open — what the Update panel's hint says a restart will close.
#[tauri::command]
fn window_count(app: tauri::AppHandle) -> usize {
    app.webview_windows().len()
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
    let marks = state.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        sync::with_write(&state, |conn| {
            errors::clear(conn).map_err(|e| format!("could not clear the error log: {e}"))
        })
    })
    .await
    .map_err(|e| format!("could not clear the error log: {e}"))?;
    // `errors::clear` is a bare `DELETE FROM error_log`, and the table has no triggers and no
    // foreign key names it — so SQLite truncates it without visiting a row and the update hook
    // hears nothing. The other windows' logs hear about a clear from here. See `crate::changes`'
    // module doc, and the `mirror::watch` test that pins the blind spot.
    if out.is_ok() {
        marks.changes.mark_table("error_log");
    }
    out
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

/// The variable that opens the MCP bridge in a debug build — see the registration in [`run`].
#[cfg(debug_assertions)]
const MCP_BRIDGE_ENV: &str = "MTG_GRIMOIRE_MCP_BRIDGE";

/// Whether the environment asked for the MCP bridge: **exactly `1`**. Anything else — unset,
/// empty, `0`, `true` — leaves the port shut, because the direction to be wrong in is closed.
#[cfg(debug_assertions)]
fn mcp_bridge_requested(value: Option<&str>) -> bool {
    value == Some("1")
}

pub fn run() {
    // **Before the builder, and it has to be before it.** A build that has just replaced
    // its predecessor is launched with `--await-predecessor`, and what it is waiting for is
    // the old process to release the single-instance lock. By the time
    // `tauri_plugin_single_instance` has initialised, the decision is already made: a
    // second instance is given exit code 0, no window and no stderr, so a successor that
    // starts too early simply vanishes — and the user is left looking at the old version
    // with nothing to say why. See `update::await_predecessor`.
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
    // **The second launch is still refused; what it asks for is a window in this one.** The
    // callback below runs in the first process when the second is turned away, and it used to
    // bring `main` forward. It opens another window instead — the same app, one more view onto
    // it — because more windows in one process share one `AppState`, one write connection and
    // one set of background services, where a second process on the same data folder would
    // need every one of those rebuilt to tolerate a peer. See `window::open_new`.
    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // **A relaunch opens a window, the way Edge and VS Code do** — and Windows' own
            // middle-click on the taskbar icon is a relaunch, so that gesture works with no UI of
            // ours. Spawned, never inline: this runs inside the plugin's window procedure, and
            // building a window from a handler deadlocks on Windows (see `window::open_new`).
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let from = window::focused(&app);
                if let Err(e) = window::open_new(&app, from.as_ref()) {
                    eprintln!("a second launch could not open a window: {e}");
                }
            });
        }));

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        // The system file dialogs — choosing a decklist, saving an export, moving the mirror —
        // **opened from Rust through `DialogExt` and never from the page** (`file_dialog.rs`,
        // issue #545), so the path the reader chose goes to the read or the write without
        // crossing IPC. Registered because `DialogExt` is this plugin's Rust half;
        // `capabilities/desktop.json` grants it **no `dialog:` permission at all**, so the
        // webview cannot summon one of its windows — open, save, message, ask or confirm. The
        // app's own questions are drawn in the page (`DeleteConfirm`, the settings dialog),
        // which is a deliberate choice and not an oversight: a native message box cannot be
        // styled, tested over CDP, or read by the story runner.
        .plugin(tauri_plugin_dialog::init())
        // Putting a decklist export on the clipboard, the other way out beside the save
        // dialog. `clipboard-manager:allow-write-text` only — nothing here reads the
        // clipboard, so `:default`'s read half is deliberately not granted.
        .plugin(tauri_plugin_clipboard_manager::init());

    // Windows 11 Snap Layouts for the app's own maximize button. The crate itself compiles
    // everywhere (a `#[cfg(not(windows))]` dummy that still registers both commands, which is
    // what keeps `capabilities/` resolvable on the Linux CI leg).
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
    let builder = builder.plugin(
        tauri_plugin_snap_layout::init()
            .button_id("snap-maximize-button")
            .build(),
    );

    // **The navigation guard**: no window leaves the app's own pages (`app_origin`). A plugin
    // hook rather than an `on_navigation` on a window builder, because `main` is built from the
    // config and every `window-N` by `window::open_new` — a hook on either builder is a window
    // the other one forgot. It is what keeps a link dropped on the window from loading a remote
    // page in it; the camera handler checks the same origin set in case anything else does.
    let builder = builder.plugin(crate::app_origin::guard());

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
    // takes the narrow bind for the same reason `capabilities/desktop.json` names each
    // permission it grants rather than any plugin's `:default`.
    //
    // Port 9223 (the plugin counts upward from it if it is busy), deliberately clear of the
    // three ports this repo hardcodes: 1420 Vite, 6006 Storybook, 9222 CDP.
    //
    // **Debug builds only, and the `cfg` is the fence rather than the capability.** The listener
    // is opened in Rust and the ACL is not in that path, so no capability can close it.
    //
    // ⚠️ **And only when asked for, since 2026-09-28** — `MTG_GRIMOIRE_MCP_BRIDGE=1` in the
    // environment `tauri dev` is launched from (issue #545). The loopback bind keeps the LAN
    // out and keeps nothing on this machine out: the plugin's `accept_async` never reads the
    // handshake's `Origin` and has no auth option, and browsers apply no CORS to a WebSocket, so
    // a page open in the developer's own browser could scan 9223–9322 and send `execute_js` —
    // and with `withGlobalTauri` on, that script is one `invoke` from every command below.
    // Whether a page can reach the loopback at all is the browser's local-network policy, which
    // is not a fence this app controls. So the port stays shut on every dev launch that did not
    // ask for an agent, which is most of them. Vendoring the plugin to refuse any handshake that
    // carries an `Origin` (the Node client sends none) was the other fix on the table, and would
    // be the one to reach for if the bridge ever has to be on by default again.
    #[cfg(debug_assertions)]
    let builder = if mcp_bridge_requested(std::env::var(MCP_BRIDGE_ENV).ok().as_deref()) {
        eprintln!(
            "{MCP_BRIDGE_ENV}=1: the MCP bridge is listening on 127.0.0.1 (debug build only)"
        );
        builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        )
    } else {
        builder
    };

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
            search::search_marks,
            search::list_sets,
            index::facets::facet_cards,
            card::card_detail,
            card::card_printings,
            card::printing_prices,
            card::card_meld_parts,
            card::card_tcgplayer_ids,
            card::card_holdings,
            card::card_image_uri,
            card::printing_group_by,
            card::set_printing_group_by,
            images::prefetch_images,
            images::prewarm_collection,
            collection::collection_add,
            collection::collection_set_quantity,
            collection::collection_update,
            collection::collection_set_printing,
            collection::collection_remove,
            collection::collection_list,
            collection::collection_summary,
            // The Shelves wall's per-shelf figures — `collection_summary`'s scope, grouped by
            // shelf. A read like its neighbour, so it sits with it.
            collection::collection_shelf_counts,
            // The home page's value widget: the same money as `collection_summary`, one
            // dimension at a time. A read like its neighbour, so it sits with it.
            collection::collection_breakdown,
            collection::collection_import_commit,
            // Issue #555's four: the import's numbers without the write (a read, on
            // `db_read`), the two bulk presses as one transaction each, and the session undo
            // every bulk collection or wishlist write answers a ticket for. `bulk_undo` by its
            // full path, so the module list above stays as it was.
            collection::collection_import_preview,
            collection::collection_remove_many,
            collection_folders::collection_set_folder_many,
            crate::bulk_undo::bulk_undo,
            collection_folders::collection_folder_list,
            collection_folders::collection_folder_create,
            collection_folders::collection_folder_rename,
            collection_folders::collection_folder_set_locked,
            collection_folders::collection_folder_move,
            collection_folders::collection_folder_reorder,
            collection_folders::collection_folder_delete,
            collection_folders::collection_removed_clear,
            collection_folders::collection_set_folder,
            collection_folders::collection_folder_summary,
            // Publishing a binder as a read-only page, and reading somebody else's. Registered
            // from `share::commands` for the pairs above's reason: `generate_handler!` names a
            // command after the **last path segment**, so these are `share_list`,
            // `share_create`, `share_refresh`, `share_revoke` and `share_open`.
            //
            // **Four of the five reach the network and `share_open` reaches it with no token at
            // all** — viewing a share needs the link and nothing else (spec §9), which is the
            // whole of the entitlement asymmetry this feature is built around.
            share::commands::share_list,
            share::commands::share_create,
            share::commands::share_refresh,
            share::commands::share_revoke,
            share::commands::share_open,
            // The two writes that move copies across the deck boundary. Registered from
            // `collection_alloc::commands` so the wire names match the crate's own — see that
            // module. `generate_handler!` names a command after the last path segment.
            collection_alloc::commands::collection_to_deck,
            collection_alloc::commands::deck_to_collection,
            // The third crossing, and the one that moves custody without writing a
            // `deck_cards` row — see `deck_pull`. Registered from its `commands` module for
            // the pair above's reason: `generate_handler!` names a command after the last
            // path segment, so these are `deck_pull_plan` and `deck_pull_from_collection`.
            deck_pull::commands::deck_pull_plan,
            deck_pull::commands::deck_pull_from_collection,
            // The fourth crossing, and the first that *creates* copies rather than moving
            // them — see `deck_quick_add`. Same registration shape as the pair above:
            // `generate_handler!` names a command after the last path segment, so these are
            // `deck_quick_add_wishes` and `deck_quick_add_to_collection`.
            deck_quick_add::commands::deck_quick_add_wishes,
            deck_quick_add::commands::deck_quick_add_to_collection,
            // The fifth crossing: the pair above read deck-wide — see `deck_missing`. Same
            // registration shape again, `generate_handler!` naming a command after the last
            // path segment, so these are `deck_missing_plan` and `deck_missing_to_collection`.
            deck_missing::commands::deck_missing_plan,
            deck_missing::commands::deck_missing_to_collection,
            wishlist::wishlist_add,
            wishlist::wishlist_set_quantity,
            wishlist::wishlist_remove,
            wishlist::wishlist_list,
            // The same, one table over — and summed, the wishlist header's Total cost.
            wishlist::wishlist_shelf_counts,
            // The home page's wishlist widget — the header figures, and the same money one
            // dimension at a time. Both are reads, so they sit with `wishlist_list`.
            wishlist::wishlist_summary,
            wishlist::wishlist_breakdown,
            wishlist::wishlist_import_commit,
            wishlist::wishlist_set_printing,
            wishlist_optimize::wishlist_optimize_plan,
            wishlist_optimize::wishlist_optimize_apply,
            wishlist_folders::wishlist_folder_list,
            wishlist_folders::wishlist_folder_create,
            wishlist_folders::wishlist_folder_rename,
            wishlist_folders::wishlist_folder_move,
            wishlist_folders::wishlist_folder_reorder,
            wishlist_folders::wishlist_folder_delete,
            wishlist_folders::wishlist_folder_clear,
            wishlist_folders::wishlist_folder_delete_with_wishes,
            wishlist_folders::wishlist_set_folder,
            wishlist_folders::wishlist_folder_summary,
            deck::deck_create,
            deck::deck_update,
            deck::deck_delete,
            deck::deck_duplicate,
            deck::deck_set_folder,
            deck::deck_set_view_state,
            deck::deck_list,
            // The gallery's two second reads — the colour bar's mana costs for every deck at
            // once, and the bracket estimate's facts for the decks the page names. Both are
            // reads and take `db_read`, so they sit with `deck_list` rather than with the card
            // writes below.
            deck::deck_pip_costs,
            deck::deck_bracket_reads,
            // The home page's deck tiles — every deck's value at one shop, in one read. A
            // third gallery-wide read, so it sits with the two above rather than with the
            // card writes below.
            deck::deck_values,
            deck::deck_get,
            // The two reads a folder rule is answered from: what one deck's live list plays,
            // and which decks play a given set of cards. Both are reads and take `db_read`,
            // so they sit with `deck_list`/`deck_get` rather than with the card writes below.
            deck::deck_played_keys,
            deck::deck_ids_playing,
            deck::deck_last_format,
            deck::deck_add_card,
            deck::deck_add_card_to_other_list,
            deck::deck_set_card_quantity,
            deck::deck_category_clear,
            deck::deck_clear,
            deck::deck_move_card,
            deck::deck_swap_printing,
            deck::deck_set_card_finish,
            deck::deck_missing_to_wishlist,
            import::import_resolve,
            import::deck_import_commit,
            import::import_pick_file,
            deck::format_specs_list,
            deck_meta::deck_category_list,
            deck_meta::deck_category_create,
            deck_meta::deck_category_rename,
            deck_meta::deck_category_set_active,
            deck_meta::deck_category_reorder,
            deck_meta::deck_category_delete,
            deck_meta::deck_label_list,
            deck_meta::deck_label_create,
            deck_meta::deck_label_update,
            deck_meta::deck_label_delete,
            deck_meta::deck_label_remove_from_deck,
            deck_meta::deck_label_all,
            deck_meta::deck_card_set_label,
            deck_meta::deck_folder_list,
            deck_meta::deck_folder_create,
            deck_meta::deck_folder_rename,
            deck_meta::deck_folder_move,
            deck_meta::deck_folder_reorder,
            deck_meta::deck_folder_delete,
            deck_audit::deck_audit_list,
            // The collection's and the wishlist's history, read beside the deck's own — see
            // `activity`'s doc in `lib.rs`. The home page's Recent widget is its one caller.
            activity::activity_recent,
            deck_undo::deck_undo_state,
            deck_undo::deck_undo_apply,
            deck_undo::deck_redo_apply,
            deck_theory::deck_theory_diff,
            deck_theory::deck_theory_slots,
            deck_query::deck_query_cards,
            deck_theory::deck_theory_missing_to_wishlist,
            // The tokens and emblems a deck needs, one row per entry, the four writes over their
            // entries (user schema v52, which retired `deck_token_set`, `deck_token_clear` and
            // `deck_token_add`; v55 retired `deck_token_state` and `deck_token_reset` for
            // `deck_token_remove`), and every token printing in the corpus for Add printing's
            // All tokens. `generate_handler!` names a command after the **last path segment**, so
            // `deck_tokens::deck_tokens` registers as `deck_tokens` — the module and the read wear
            // the same name on purpose, because the wire name is the one `src/lib/ipc.ts` invokes
            // and `deck_tokens_list` would be a second thing to remember.
            deck_tokens::deck_tokens,
            deck_tokens::deck_token_set_quantity,
            deck_tokens::deck_token_swap,
            deck_tokens::deck_token_add_printing,
            deck_tokens::deck_token_remove,
            deck_tokens::token_printings,
            // The Notes band's read, its six writes, and the one read that is not deck-scoped at
            // all. `generate_handler!` names a command after the **last path segment** again, so
            // `deck_notes::deck_notes` registers as `deck_notes` — the module and the read wear
            // one name for `deck_tokens`' reason, and `card_notes` is filed here rather than with
            // the card commands because the rows it answers are a deck's.
            //
            // **No capability entry for any of them**: Tauri v2's ACL gates `core:` and `plugin:`
            // commands, and an app's own `#[tauri::command]` is always callable.
            deck_notes::deck_notes,
            deck_notes::deck_note_create,
            deck_notes::deck_note_update,
            deck_notes::deck_note_delete,
            deck_notes::deck_note_attach,
            deck_notes::deck_note_detach,
            deck_notes::deck_note_reorder,
            deck_notes::card_notes,
            // The To-do band's lists — a deck's read and its three writes — and the home widget's
            // read across every deck (user schema v59, which replaced #672's `deck_todos` /
            // `deck_todos_set` pair when one column became a table). `deck_todos::deck_todo_lists`
            // registers as `deck_todo_lists`, the last-path-segment rule above: the name #672's
            // widget read wore, which is the deck's read now. Both reads are **fallible**, unlike
            // the sticky notes' — an autosaving dialog opened over a failed read's `[]` would be
            // writing beside lists the reader can no longer see. No capability entry, the
            // app-command rule.
            deck_todos::deck_todo_lists,
            deck_todos::deck_todo_list_create,
            deck_todos::deck_todo_list_update,
            deck_todos::deck_todo_list_delete,
            deck_todos::every_deck_todo_list,
            marketplace::get_marketplace,
            marketplace::set_marketplace,
            zoom::card_zoom,
            zoom::set_card_zoom,
            nav::nav_collapsed,
            nav::set_nav_collapsed,
            listview::list_view,
            listview::set_list_view,
            searchopen::search_open,
            searchopen::set_search_open,
            // Which shelves the reader folded — `search_open`'s pair, one level deeper.
            shelffolds::shelf_folds,
            shelffolds::set_shelf_folds,
            // Which stacks the reader hid in a deck — `shelf_folds`' pair, keyed by deck.
            stackhide::hidden_stacks,
            stackhide::set_stack_hidden,
            markcolors::mark_colors,
            markcolors::set_mark_color,
            decksort::deck_sort,
            decksort::set_deck_sort,
            // The decks page's folder tree — how wide the reader dragged it, and whether they
            // shut it down to a rail. One row and one pair, beside the deck gallery's own order.
            deckpane::deck_folder_pane,
            deckpane::set_deck_folder_pane,
            // The home page's own two pairs, beside the other `app_meta` view state: which
            // widgets the reader has and how they are arranged, and which view the app opens
            // on. Both reads are infallible by signature — see each module's doc.
            home::home_layout,
            home::set_home_layout,
            // The Notes widget's own five, and the read is infallible by signature for
            // `home_layout`'s reason — a widget drawing its first frame can do nothing with an
            // error that is not "draw the notes you already have". The four writes go through
            // `with_write` and answer `db::BUSY` when a sync holds the connection.
            sticky_notes::sticky_notes,
            sticky_notes::sticky_note_create,
            sticky_notes::sticky_note_update,
            sticky_notes::sticky_note_delete,
            sticky_notes::sticky_note_reorder,
            // The Recently viewed widget: the read is infallible by signature, and the write is
            // the card modal's, which ignores a BUSY — a missed entry costs one tile.
            recent_cards::recent_cards,
            recent_cards::record_recent_card,
            // The Set completion and Price movers widgets, and a mover's detail: three reads on
            // the read-only connection. The movers' history is written by the launch, a sync and
            // a feed store, never by a command — see `price_history`'s doc.
            set_completion::set_completion,
            price_history::price_movers,
            price_history::price_history,
            // The Collection value graph: one read on the read-only connection, over the same
            // snapshots and the live collection — the day's `copies` are written beside the
            // price by that same snapshot, never by a command.
            value_history::collection_value_history,
            // The New printings widget: the feed, and the cursor that puts its gold dots out.
            // The read is two `SELECT`s on the read-only connection; the write takes its clock
            // from the caller, never `SystemTime::now()` — `recent_cards`' rule.
            new_printings::new_printings,
            new_printings::mark_new_printings_seen,
            // The Deck completion widget: every deck's missing count and cost, on the read-only
            // connection, by the deck editor's own rules.
            deck_completion::deck_completion,
            // To review's deck-card count — its own read, not `sync_relay_status`'s six-table sum.
            deck_completion::deck_review_count,
            // The Coming soon widget: one `SELECT` over `cards` on the read-only connection, its
            // only clock SQLite's `date('now')`.
            upcoming_sets::upcoming_sets,
            startview::start_view,
            startview::set_start_view,
            marketplace_feed::marketplace_feed_refresh,
            marketplace_feed::marketplace_feed_status,
            combos::combos_status,
            combos::combos_refresh,
            // **Two reads whose names differ by one letter and which ask opposite
            // questions.** `combos_for_cards` (plural) takes a set of printing ids and
            // answers which combos that set *fully contains* — the deck bracket's fourth
            // signal. `combos_for_card` (singular) takes one `oracle_id` and answers every
            // combo that *names* it, however many of the other pieces the reader has; that
            // is the card page's question and it is paged.
            combos::combos_for_cards,
            combos::combos_for_card,
            combos::combos_clear,
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
            export::export_save_file,
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
            // The plain-text mirror. Four commands for the folder: the Backup panel's read,
            // the two settings, and the button that rewrites it now.
            mirror::settings::mirror_status,
            mirror::settings::mirror_set_enabled,
            mirror::settings::mirror_pick_root,
            mirror::settings::mirror_rebuild,
            // Pairing (spec §7.5 and §7.6). The panel's read, the presses (offer, accept,
            // confirm, cancel), the one poll that carries both `respond` and `complete` now
            // that the relay carries the two blobs those used to be commands for, the two
            // things a roster row can be told, and — since the leave-group spec §2.1 — this
            // device's own way out.
            sync_pair::pairing::sync_pairing_status,
            sync_pair::pairing::sync_pairing_begin,
            sync_pair::pairing::sync_pairing_accept,
            sync_pair::pairing::sync_pairing_confirm,
            sync_pair::pairing::sync_pairing_poll,
            sync_pair::pairing::sync_pairing_cancel,
            sync_pair::pairing::sync_device_rename,
            sync_pair::pairing::sync_device_revoke,
            sync_pair::pairing::sync_group_leave,
            // The scanner, its prefs and its tray. The session's state is managed separately
            // below — see scanner.rs; the prefs and the tray are `app_meta` rows on `AppState`.
            scanner::scanner_status,
            // Whether another window holds the scanner — one window scans at a time, on a lease
            // renewed by the open view's heartbeat, its frames and every tray or prefs write —
            // asked without taking it, so a second window's Scanner view can say so before it
            // opens a camera. See `scanner::LEASE`.
            scanner::scanner_elsewhere,
            // The mounted view's heartbeat: it takes the lease, so the view holds the scanner from
            // its first render whatever its camera is doing.
            scanner::scanner_hold,
            scanner::scanner_frame,
            scanner::scanner_reset,
            scanner::scanner_capture,
            scanner::scanner_set_filters,
            scanner::scanner_prefs,
            scanner::set_scanner_prefs,
            scanner::scanner_tray,
            scanner::set_scanner_tray,
            scanner::scanner_tray_commit,
            // The relay, the membership and the review queue (spec §6.1, §7.2–§7.4, §7.7 and
            // §10). The panel's two reads, the Connect press, the claim code the reader pastes
            // back, one round trip now, the rows carrying a sentence, clearing one of them, and
            // the live socket's state.
            // **`sync_relay_set_url` is gone** — the relay is one hosted service, so its address
            // is compiled in and stopped being a setting.
            sync_engine::commands::sync_relay_status,
            sync_engine::commands::sync_supporter_status,
            sync_engine::commands::sync_patreon_begin,
            sync_engine::commands::sync_patreon_claim,
            sync_engine::commands::sync_now,
            sync_engine::commands::sync_review_list,
            sync_engine::commands::sync_review_clear,
            sync_engine::commands::sync_live_state,
            // Whether the background startup has landed — the one command the page asks before
            // it mounts anything that needs `AppState`. See `startup`.
            startup::startup_status,
            // Another window onto the same app, and how many there are. Neither takes
            // `AppState`, so both answer before `startup_status` does — a relaunch during a
            // slow startup still gets its window.
            window_new,
            window_count
        ])
        .setup(|app| {
            // First, and before anything that can fail: the window is created **hidden**
            // (`tauri.conf.json`'s `"visible": false`), so until this runs the app has no
            // window at all. It opens at the largest of 1920×1080 and 1280×720 that the
            // monitor's *work area* holds — a 1080p desk cannot hold a 1080-tall window once
            // Windows has taken its taskbar out of it. See `window.rs`.
            //
            // The in-app QR scanner's camera grant — see `camera`'s own doc for why WebView2
            // needs one at all. `camera::install` is a no-op off Windows, so calling it on Linux
            // costs nothing. **Every later window gets both calls too**, from
            // `window::open_new` — this is only the first window's copy of them.
            if let Some(main) = app.get_webview_window("main") {
                window::open_sized_to_monitor(&main);
                camera::install(&main);
            }

            // Everything else happens on a thread of its own, and the window is already up to
            // wait for it. Tauri calls this closure from inside the event loop, on the window's
            // own UI thread, so a `setup` that opens and migrates the databases is a window that
            // cannot answer a message for as long as that takes — measured at 26.5 s on a cold
            // corpus — and Explorer's `WM_GETICON` is one of the messages. See `startup`.
            //
            // Managed first, so the page's very first `startup_status` has something to ask.
            app.manage(startup::Startup::default());
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("startup".to_owned())
                .spawn(move || start(&handle))?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // `build` + `run(callback)` rather than `run(context)`, for two events: `ExitRequested`
        // (before the window goes, for a last push) and `Exit` (after, for the WAL checkpoint).
        .run(|app, event| match event {
            // **A last push, with a hard budget.** The same discipline `EXIT_CHECKPOINT_WAIT`
            // already applies, and for the reason its doc gives: a window-less process still
            // sitting on a lock is a process the user believes has quit.
            //
            // The budget can be this brutal because **nothing is ever lost**. `sync_ops` is
            // durable and `pushed_at IS NULL` survives the process, so a missed shutdown push
            // is a delay until the next launch, not a loss.
            tauri::RunEvent::ExitRequested { api, .. } => {
                if EXIT_PUSH_TRIED.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                let Some(state) = app.try_state::<Arc<AppState>>() else {
                    return;
                };
                if !crate::sync_engine::live::anything_pending(&state) {
                    return;
                }
                api.prevent_exit();
                let handle = app.clone();
                let owned = (*state).clone();
                tauri::async_runtime::spawn(async move {
                    // **The timeout bounds the *wait*, not the *work*.** `push_now` runs on
                    // `spawn_blocking`'s OS thread pool, and `tokio::time::timeout` can only stop
                    // *awaiting* that future — it cannot cancel the thread. If the round trip is
                    // stuck inside `client::run_once` (a slow or unresponsive relay, bounded only
                    // by `reqwest`'s own `connect_timeout`/`read_timeout` in `client.rs`), the
                    // orphaned thread is still holding `state.db`'s write lock when this timeout
                    // elapses and `handle.exit(0)` is called below.
                    //
                    // `exit(0)` does not skip straight to the OS: it synchronously drives
                    // `RunEvent::Exit` → `checkpoint_on_exit` on this same process, **before**
                    // anything actually terminates — and that handler makes two more bounded
                    // attempts on the very same mutex (`flush_records` then `lock_for`). Without
                    // `EXIT_PUSH_TIMED_OUT` below, a stuck push would compound worst-case shutdown
                    // to roughly `EXIT_PUSH_BUDGET + 2×EXIT_CHECKPOINT_WAIT` (≈12s) rather than the
                    // 2s this budget promises on its own.
                    if tokio::time::timeout(
                        EXIT_PUSH_BUDGET,
                        crate::sync_engine::live::push_now(owned),
                    )
                    .await
                    .is_err()
                    {
                        EXIT_PUSH_TIMED_OUT.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    handle.exit(0);
                });
            }
            tauri::RunEvent::Exit => checkpoint_on_exit(app),
            _ => {}
        });
}

/// Build [`AppState`] and everything hung off it, then start the background services.
///
/// Runs on the `startup` thread `setup` spawns, never on the UI thread — see [`startup`]. The
/// order inside is the order `setup` had, with two things added. [`startup::settle`] goes
/// **after the last `manage` and the mirror's hook, and before the first background task**:
/// before it the page has not mounted the app, so no command can run; after it every piece of
/// state a command reaches is in place, and every write it makes passes the hook. And the corpus
/// integrity check that used to hold the launch runs behind it, on a thread of its own.
fn start(app: &tauri::AppHandle) {
    // The write-side half of live sync's wake. One `Arc` for the whole process: the
    // commit hook `init_state` installs calls `notify_one` on it, through the
    // `sync_engine::live::WriteWake` observer, and `sync_engine::live::spawn`'s `select!`
    // wakes on the same handle — see the warning on `live::spawn` for why it must be
    // `notify_one` and never `notify_waiters`. Created here rather than on `AppState`
    // because nothing else needs to reach it: `init_state` and `live::spawn` are the whole
    // of its life.
    let writes = Arc::new(tokio::sync::Notify::new());

    // A refusal is drawn by the page, under a title bar that can still close the window, and
    // printed as well for a console that has one. It used to be returned from `setup`, which
    // Tauri turns into a panic: an escaped one-line message in a debug console, and in a release
    // build — no console at all — a window that simply vanished.
    let state = match init_state(app, &writes) {
        Ok(state) => Arc::new(state),
        Err(message) => {
            eprintln!("{message}");
            startup::settle(app, startup::StartupStatus::Failed { message });
            return;
        }
    };
    app.manage(state.clone());

    // The scanner's own state, beside `AppState` rather than inside it — it loads
    // lazily on the first status call and shares nothing but the data directory.
    app.manage(Arc::new(scanner::ScannerState::new(state.data_dir.clone())));

    // Warm the facet index: ~767 ms of full table scan on its own thread and its own
    // read-only connection, so the window comes up now and the first searches answer
    // out of `db_read` untouched. Here rather than inside `init_state`, which builds a state
    // and starts nothing: a build is the first thing that *runs* on one, and it must run after
    // `prepare_database`, which is the last thing that can change what `cards` is.
    // Until it lands, `facet_cards` answers `ready: false` and every filter control
    // stays live. Nothing about it is fatal; the handle is dropped and the thread
    // runs detached.
    index::lifecycle::spawn_build(&state.core);
    // The image cache's budget: a thread of its own, first pass a minute in (`images::evict`).
    images::spawn_upkeep(&state);

    // The plain-text mirror, in two halves that must stay in this order.
    {
        // First the hook, on `state.db` and **nowhere else** — and it is already there:
        // `init_state` built the core's `State`, which installs the hook on the write
        // connection before that connection is ever lent out, with the mirror's mask as one
        // of its observers (`mirror::watch::observers`). That is the one connection every
        // user-facing write in this crate goes through (`sync::with_write`), and the read
        // connection is opened read-only so it could never fire one. Installed before the
        // thread starts, so nothing written between there and the first pass can slip past
        // unmarked — though the first pass is `Dirty::ALL` and would cover it anyway, which
        // is what makes this ordering cheap insurance rather than a rule.

        // Then the thread. Detached and never fatal, exactly like the facet warm-up
        // above: it runs one full pass now — the whole of what makes the folder
        // correct after a crash — and then wakes two seconds after the reader stops
        // editing. It reads through a connection of its own and never takes the write
        // connection, so no press it overlaps can be answered `db::BUSY` by it.
        mirror::watch::spawn(state.clone());

        // The other windows' refresh — see `crate::changes`. After the hook, and the order
        // costs nothing either way: a commit that rings before this task is waiting leaves
        // `notify_one`'s one stored permit, so its first wait returns at once rather than
        // missing that commit. Above `startup::settle` like the mirror's thread, because it
        // is a spawn that does no work until something is written.
        crate::changes::spawn_emitter(app.clone(), state.clone());
    }

    // Here rather than before the builder, and the difference is one rare bug: this
    // deletes a staged build (and, since issue #551, every file in `data/updates/`),
    // and the second instance of a double-click would otherwise delete the *first*
    // instance's staged update on its way to being refused. `setup` runs only for the instance that won the single-instance
    // guard, so what it clears is always its own. (The `.old` a swap leaves is
    // deleted earlier still, by `await_predecessor`; this is the path that finally
    // clears one whose successor never got that far.)
    let exe = std::env::current_exe().unwrap_or_default();
    update::clean_up(&exe, &state.data_dir);

    // Decided once here — `Updater::new` probes whether it can write beside the exe
    // — so a status poll never re-answers a question that cannot change.
    let updater = Arc::new(update::Updater::new(update_api_base(), exe));
    app.manage(updater.clone());

    // **The page mounts the app on this line**, so everything a command can reach must already
    // be managed above it — `AppState`, the scanner's state, the updater — and the mirror's hook
    // must already be on the write connection. What follows is background work that reports
    // through its own events and polls, exactly as it did when the window waited for it.
    startup::settle(app, startup::StartupStatus::Ready);

    // The full integrity check `prepare_data_dir` no longer runs before a window can open —
    // see `schema::check_corpus`. On its own thread and its own read-only connection, never
    // `db_read`: it reads the whole corpus, which is seconds warm and tens of seconds cold, and
    // a search queued behind that would be the frozen window this move exists to remove.
    let check_state = state.clone();
    let _ = std::thread::Builder::new()
        .name("corpus-check".to_owned())
        .spawn(move || check_corpus_in_background(&check_state));

    // Launch is never blocked on the network: the window comes up immediately
    // and this run reports itself through `sync:progress`. The throttle inside
    // makes it a no-op on all but the first launch of the day.
    //
    // **On a first run the optional feeds wait for it** (issue #551). A corpus with no card in
    // it means the reader is looking at the modal first-run wait, and the tag files and the
    // combos are ~46 MB against the card file's 77 MB on the same link — started beside it
    // they made that wait about 1.6× longer on a slow line, for data no screen can use until
    // the cards are there. So they start when the card sync ends, **whether it succeeded or
    // not**: a failed card download must not also cost the reader the feeds, and each of them
    // is independent of the corpus. On every later launch they start at once, beside the sync,
    // exactly as before — the sync is a 304 then, and there is nothing to wait for.
    let first_run = {
        let conn = sync::lock_db_read(&state);
        !sync::has_cards(&conn)
    };
    let handle = app.clone();
    let sync_state = state.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sync::run_sync(sync_state.core.clone(), false).await {
            eprintln!("initial sync failed: {e}");
        }
        if first_run {
            spawn_optional_feeds(&handle, &sync_state);
        }
    });
    if !first_run {
        spawn_optional_feeds(app, &state);
    }

    // The daily update check, in its own task rather than chained onto the sync:
    // the two answer to different services on different schedules, and a Scryfall
    // failure must not be the reason the app stops noticing its own releases. Its
    // result is written to `app_meta`, so the ribbon reads it without an event —
    // which also means nothing is lost if this finishes before the webview is
    // listening, the trap `sync:progress` has to work around.
    let update_state = state.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = update::check(&update_state, &updater, false).await {
            eprintln!("update check failed: {e}");
        }
    });

    // The relay doorbell. Its own task for the same reason as the five above — five
    // services, five schedules, and none of them may be the reason another stops
    // running. It opens no socket at all until this installation is in a group, which
    // is every installation that has connected nothing.
    crate::sync_engine::live::spawn(app.clone(), state.clone(), writes.clone());
}

/// Start the launch's optional feeds, each on a task of its own: the selected marketplace's
/// price feed, both Tagger files and the combos. [`start`] calls this beside the card sync, or
/// behind it on a first run — see the comment there.
fn spawn_optional_feeds(app: &tauri::AppHandle, state: &Arc<AppState>) {
    // The selected marketplace's price feed, if it is one this app downloads and it is
    // due. Its own task for the update check's reason — three services, three
    // schedules, and none of them may be the reason another stops running — and
    // deliberately *only* the selected one: nobody downloads 63.7 MiB for a
    // marketplace they never picked, which is the whole shape of
    // `refresh_selected_if_due`. Silent and best-effort; a failure is already in
    // `error_log` and the honest fallback is the prices already on disk.
    let feed_state = state.clone();
    let feed_app = app.clone();
    tauri::async_runtime::spawn(async move {
        marketplace_feed::refresh_selected_if_due(&feed_state, &feed_app).await;
    });

    // Scryfall's Oracle Tags, if the stored copy is due. Its own task for the same
    // reason as the two above — a fourth service on a fourth schedule, and none of
    // them may be the reason another stops running — and deliberately *after* the
    // card sync is spawned rather than chained onto it: the two write different
    // tables, both take the connection a batch at a time, and a tag file that never
    // arrives must cost the corpus nothing. (A first run is the one exception, and
    // there it is the *card* download that must not be made to wait — see `start`.) Silent and best-effort; a failure is
    // already in `error_log` and the honest fallback is categorising by card type,
    // which is what the app did before this existed.
    let tags_state = state.clone();
    let tags_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tags::oracle::refresh_if_due(&tags_state, &tags_app).await;
    });

    // Scryfall's Art Tags, on a fifth task rather than chained onto the oracle one
    // above. **They are the same shape of job and that is exactly why they must not
    // share a task**: the art file is 12.5 MB against the oracle file's 5.85 MB, so
    // awaiting one before the other would make the bigger download the reason the
    // smaller taxonomy is late — and on a first run, the reason a deck add is still
    // categorising by card type minutes after launch. They contend for the write
    // connection a batch at a time, which is the engine's job and not the launch's —
    // and `db::lock_background` is what keeps that contention from starving a user
    // write. Silent and best-effort, like every one of its siblings.
    let art_state = state.clone();
    let art_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tags::art::refresh_if_due(&art_state, &art_app).await;
    });

    // Commander Spellbook's combo database, on a sixth task — a sixth service on a
    // sixth schedule, and none of them may be the reason another stops running. **It
    // is fetched uninvited, exactly like the two tagger files above it**, which
    // reverses what this comment argued: that a database which had never seen the file
    // should wait to be asked, because a bracket estimate can read three signals
    // instead of four and that is a supported state rather than an error. Supported is
    // not the same as visible. What the old rule actually bought was a readout quietly
    // drawn from three signals — no error, no empty state, just a number a little too
    // low — until the reader found a Refresh button they had no reason to go looking
    // for. An answer that is wrong in a way nobody can see the cause of is the worse
    // failure, so the gate is plain staleness now and a first run goes and gets the
    // file.
    //
    // Its own task rather than chained onto either tag refresh above, and that is the
    // argument those two already make against each other, now covering three files
    // rather than two: they are the same shape of job, which is exactly why they must
    // not share a task. Whichever went first would be the reason the others were late
    // — 27.5 MB gzipped here against the art file's 12.5 MB and the oracle file's
    // 5.85 MB — and "late" is a deck add still filing by card type, or a bracket still
    // reading three signals, minutes after launch. They contend for the write
    // connection a batch at a time, which is the engine's job and not the launch's.
    // Silent and best-effort, like every one of its siblings: a failure is already in
    // `error_log` and the honest fallback is the combos already on disk.
    let combo_state = state.clone();
    let combo_app = app.clone();
    tauri::async_runtime::spawn(async move {
        combos::refresh_if_due(&combo_state, &combo_app).await;
    });
}

/// Run [`schema::check_corpus`] and act on a damaged answer: leave the mark that makes the next
/// launch replace the corpus, and say so in `error_log`.
///
/// **The corpus is not replaced now, and cannot be**: every connection the app keeps has it
/// attached, and a file the app is holding open is a file Windows will not delete. So this session
/// goes on with it — a query that reaches a bad page fails on its own terms — and the reader is
/// told what the next launch will do rather than being asked to do anything.
///
/// The log row is best-effort by [`errors::record`]'s own contract, and it waits for the write
/// connection only as long as a user-facing write would: a sync holding it past that costs the
/// row, never the mark.
fn check_corpus_in_background(state: &AppState) {
    let answer = match schema::check_corpus(&state.data_dir) {
        schema::CorpusCheck::Sound => return,
        schema::CorpusCheck::Unanswered(why) => {
            eprintln!("the card database's integrity check did not finish: {why}");
            return;
        }
        schema::CorpusCheck::Damaged(answer) => answer,
    };
    if let Err(e) = schema::mark_corpus_damaged(&state.data_dir, &answer) {
        eprintln!("the card database is damaged, and marking it for replacement failed: {e}");
    }
    if let Some(conn) = db::lock_for(&state.db, db::WRITE_LOCK_WAIT) {
        errors::record(
            &conn,
            errors::Source::Database,
            "corpus check",
            errors::Kind::Io,
            "The card database is damaged. It will be rebuilt from Scryfall the next time the \
             app starts; your collection, decks and wishlist are not affected.",
            Some(&answer),
        );
    }
}

/// How long the exit handler will wait for a last push. Two seconds, because the alternative
/// is a window-less process on the taskbar and the cost of giving up is a delay, never data.
const EXIT_PUSH_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);

/// So a second `ExitRequested` — or `exit(0)` re-entering — cannot start a second push.
static EXIT_PUSH_TRIED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Set when the last-push `timeout` above elapsed rather than the push finishing.
///
/// **What this actually records:** the *wait* was given up on, not that the *work* stopped —
/// the `spawn_blocking` thread it was watching may still be running, and may still hold
/// `state.db`'s write lock, when `checkpoint_on_exit` runs moments later. `checkpoint_on_exit`
/// reads this to shorten its own two bounded attempts on that same lock
/// (`EXIT_CHECKPOINT_WAIT_AFTER_A_STUCK_PUSH`) rather than spending the usual 5s on each —
/// see the comment beside the timeout above for why the two would otherwise compound.
static EXIT_PUSH_TIMED_OUT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// How long the exit handler will wait for the write connection.
///
/// Nothing short-lived contends for `db` any more: searches and status polls read through
/// `db_read`, and the image cache's bookkeeping asks with a zero timeout it is content to
/// lose. What is left is the sync, which now takes the connection one batch at a time — so
/// this wait is nearly always instant, and five seconds is simply where it stops trying. A
/// window-less process still sitting on a lock is a process the user believes has quit.
const EXIT_CHECKPOINT_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// The same wait, shortened, for the one case where it is very likely to be spent for nothing:
/// [`EXIT_PUSH_TIMED_OUT`] is set only when the last-push `timeout` already gave up on the write
/// lock once, after `EXIT_PUSH_BUDGET` (2s) of a relay that was slow or not answering at all. A
/// thread that has already outlasted that budget rarely releases the lock in the next moment
/// either, so a second full `EXIT_CHECKPOINT_WAIT` mostly buys nothing — one second is still a
/// real, honest attempt (the checkpoint is fast whenever the lock is actually free, which is
/// every ordinary shutdown), and caps the compounded worst case at
/// `EXIT_PUSH_BUDGET + 2×this` ≈ 4s instead of ≈ 12s, which is the whole point: the checkpoint
/// is worth trying, never worth a process that outstays its welcome on the taskbar for it.
const EXIT_CHECKPOINT_WAIT_AFTER_A_STUCK_PUSH: std::time::Duration =
    std::time::Duration::from_secs(1);

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
    //
    // **Shortened when the last-push `timeout` in `ExitRequested` already gave up on this
    // same lock** — see [`EXIT_PUSH_TIMED_OUT`]'s doc. `push_now`'s `spawn_blocking` thread may
    // still be holding it here: a `timeout` around a `spawn_blocking` future stops *awaiting*
    // it, not the OS thread underneath, so a push stuck in the network can still own the write
    // connection when `RunEvent::Exit` runs this function moments later. Two full
    // `EXIT_CHECKPOINT_WAIT`s stacked on top of a budget already spent waiting on a slow relay
    // is exactly the "process the user believes has quit" symptom this whole feature exists to
    // avoid — see [`EXIT_CHECKPOINT_WAIT_AFTER_A_STUCK_PUSH`] for the arithmetic.
    let wait = if EXIT_PUSH_TIMED_OUT.load(std::sync::atomic::Ordering::SeqCst) {
        EXIT_CHECKPOINT_WAIT_AFTER_A_STUCK_PUSH
    } else {
        EXIT_CHECKPOINT_WAIT
    };
    // Before the checkpoint, and with the same wait: any `image_cache` row still owed is
    // bytes already on disk that nothing will ever serve, so paying the queue off here is
    // the difference between a warm cache and re-fetching those images forever. It is one
    // upsert per owed row and the queue is empty on a normal exit.
    state.images.flush_records(&state.db, wait);

    let held = db::lock_for(&state.db, wait);
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
///
/// `writes` is live sync's wake, which [`start`] made and keeps: it is handed in because the
/// write connection's hook is installed here, as the core's `State` is built, and the wake is
/// one of the three observers that ride it.
fn init_state(
    app: &tauri::AppHandle,
    writes: &Arc<tokio::sync::Notify>,
) -> Result<AppState, String> {
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
    let data_dir = paths::data_dir_for(exe_dir.as_deref(), &app_data);

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
    let conn =
        db::open_write(&data_dir).map_err(|e| data_dir_error(portable.as_deref(), &fallback, e))?;
    // **Never "move it aside"** (issue #550). That sentence told the reader the app would rebuild
    // `user.db` from Scryfall, which has been false since schema 27 made it the one file in the
    // folder nothing can rebuild. A corpus that will not migrate no longer reaches here at all —
    // `prepare_database` replaces it — so what does is the collection from a newer build, or a
    // folder that is full or read-only, and the error itself now names which file it was.
    schema::prepare_database(&conn).map_err(|e| {
        format!(
            "MTG Grimoire could not prepare its databases in {}: {e}\n\
             If this says the collection is from a newer version, run that version of the app. \
             Otherwise the folder may be full or read-only. Do not delete {}: it holds your \
             collection, decks and wishlist and cannot be rebuilt. Copies taken before each \
             upgrade are in the {} folder beside it.",
            data_dir.display(),
            db::USER_DB,
            schema::USER_BACKUPS_DIR,
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

    // The name the mirror stamps into its manifest, minted here, on this connection and
    // **before the hook goes on it**, so the mirror itself never writes to the database and
    // this one write of the launch's is heard by nobody — see
    // `mirror::settings::K_INSTALLATION`. A failure leaves manifests unstamped, which is what
    // every build before the stamp wrote.
    if let Err(e) = mirror::settings::ensure_installation(&conn) {
        eprintln!("the backup mirror could not name this installation: {e}");
    }

    // Clean, both of them: nothing has been written through the hook yet, so a clean mask is
    // the truth — and the mirror's startup pass is `Dirty::ALL` regardless.
    let mirror = Arc::new(mirror::watch::Mask::default());
    let changes = Arc::new(crate::changes::Changes::new());

    // **The hook goes on here**, inside `State::new`, before the write connection is behind its
    // mutex: the cross-file fence, which is the core's own, and the desktop's three observers
    // in the order the hook has always called them. SQLite allows one update hook per
    // connection, so the core owns the installer and everything else that needs to hear about
    // a write registers with it — see `grimoire_core::hooks`.
    //
    // The state starts with no sync in flight and a cold index, which `start` builds once this
    // function has returned — see there for why nothing is started from in here.
    let core = grimoire_core::state::State::new(
        conn,
        Some(conn_read),
        data_dir,
        Arc::new(WindowEvents(app.clone())),
        mirror::watch::observers(mirror.clone(), changes.clone(), writes.clone()),
        client,
    );

    Ok(AppState {
        core: Arc::new(core),
        images,
        mirror,
        mirror_status: Mutex::new(mirror::watch::LastPass::default()),
        changes,
        pairing: Mutex::new(None),
    })
}

/// The desktop's [`grimoire_core::events::EventSink`]: an event the engine raises goes to every
/// window, as `app.emit` sends one.
///
/// **The card sync is its first caller**: `sync:progress` and `collection:reconciled` arrive
/// here from `grimoire_core::sync`, which takes no window. The three feeds and live sync still
/// name their `AppHandle`, and move onto the sink as each moves to the core. A dropped event
/// is never worth failing anything over, here as at those call sites.
struct WindowEvents(tauri::AppHandle);

impl grimoire_core::events::EventSink for WindowEvents {
    fn emit(&self, name: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.0.emit(name, payload);
    }
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

    /// **The `User-Agent` every request carries is built in `grimoire-core`, from that crate's
    /// own package version** — so that version has to be this app's, or Scryfall, the feeds and
    /// the relay are told a version that is not running. Two manifests hold the number and
    /// release-please bumps both (`release-please-config.json`'s `extra-files`); this is what
    /// goes red on a release pull request that moved one without the other.
    #[test]
    fn the_core_wears_the_apps_version() {
        let expected = concat!("MTGGrimoire/", env!("CARGO_PKG_VERSION"), " (");
        assert!(
            scryfall::USER_AGENT.starts_with(expected),
            "`{}` does not name this build, {}: crates/grimoire-core/Cargo.toml and \
             src-tauri/Cargo.toml must carry the same version",
            scryfall::USER_AGENT,
            env!("CARGO_PKG_VERSION")
        );

        // And the release tooling is told about both manifests and both lockfile entries.
        // Whitespace taken out, so a reformatted file is the same file.
        let config: String = include_str!("../../release-please-config.json")
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        for path in [
            "\"path\":\"src-tauri/Cargo.toml\"",
            "\"path\":\"crates/grimoire-core/Cargo.toml\"",
            "$.package[?(@.name.value=='mtg-grimoire')].version",
            "$.package[?(@.name.value=='grimoire-core')].version",
        ] {
            assert!(
                config.contains(path),
                "release-please no longer bumps {path}"
            );
        }
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
    /// `the_mcp_bridge_gets_three_permissions_and_never_its_default` asserts **ACL** facts, and
    /// would stay green while a release build listened on the loopback: the socket is opened by
    /// `Builder::build()` in Rust, and the ACL is not in that path. So the thing to assert is
    /// the `cfg` itself.
    ///
    /// **Asserting on source text is ugly, and it is the honest option here.** A `cfg` is
    /// resolved at compile time, and the tests are a debug build, so no runtime probe here can
    /// observe what a release build did with it. The regression this guards is somebody dropping
    /// the gate while chasing a bridge problem — a one-line edit that no other test in this file
    /// can see.
    ///
    /// **Two gates since 2026-09-28, and this pins both**: the `cfg`, and the environment check
    /// inside it (issue #545) — the `let builder` the registration sits in must be the `if` on
    /// [`mcp_bridge_requested`], so a debug launch that did not ask keeps the port shut.
    #[test]
    fn the_mcp_bridge_is_gated_on_a_debug_build() {
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
        // The `let builder` the registration is the value of — the nearest one above it.
        let binding = (0..at)
            .rev()
            .find(|&i| lines[i].trim_start().starts_with("let builder = "))
            .expect("the bridge registration is no longer a `let builder`");

        assert!(
            lines[binding]
                .trim()
                .starts_with("let builder = if mcp_bridge_requested("),
            concat!(
                "the MCP bridge must open only when `MTG_GRIMOIRE_MCP_BRIDGE=1` asks for it: ",
                "the socket authenticates nothing and reads no `Origin`, so any page in the ",
                "developer's browser that can reach the loopback can drive the window.",
            )
        );
        assert_eq!(
            lines[binding - 1].trim(),
            "#[cfg(debug_assertions)]",
            concat!(
                "the MCP bridge must be gated on `debug_assertions`: without it a release build ",
                "opens an unauthenticated JavaScript-evaluating socket on the loopback. ",
                "Denying the commands in `desktop.json` does not help: the listener is opened ",
                "in Rust, not through the ACL.",
            )
        );
    }

    /// Exactly `1` opens it. Every near miss stays shut, because a bridge that opens on a
    /// spelling nobody meant is the failure, and one that stays shut costs a relaunch.
    #[cfg(debug_assertions)]
    #[test]
    fn the_mcp_bridge_opens_on_exactly_one() {
        assert!(mcp_bridge_requested(Some("1")));
        for no in [
            None,
            Some(""),
            Some("0"),
            Some("true"),
            Some("yes"),
            Some(" 1"),
        ] {
            assert!(!mcp_bridge_requested(no), "{no:?}");
        }
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

    /// The file commands' half of the ACL, which is **nothing at all** (issue #545): no `fs:`,
    /// because Rust does every read and write, and no `dialog:`, because Rust opens every dialog
    /// (`file_dialog.rs`). A `dialog:allow-open` back in this file would not reopen the hole by
    /// itself — no command takes a path any more — but it would let a script in the page put a
    /// native window over the app, and it would be the first half of somebody "simplifying" a
    /// command back into one that takes the path `open()` answered.
    ///
    /// The clipboard is the one plugin write the export feature still needs from the page, and
    /// only its write.
    #[test]
    fn the_capability_grants_no_dialog_no_filesystem_and_only_the_clipboard_write() {
        let caps = include_str!("../capabilities/desktop.json");
        assert!(
            !caps.contains("\"dialog:"),
            "the page opens no dialog; Rust does (file_dialog.rs)"
        );
        assert!(
            !caps.contains("\"fs:"),
            "no fs: permission is granted anywhere, deliberately"
        );
        assert!(caps.contains("\"clipboard-manager:allow-write-text\""));
        // Nothing in this app reads the clipboard.
        assert!(!caps.contains("allow-read-text"));
    }

    /// **No plugin's `:default` but core's** — CLAUDE.md's rule, held by the build rather than by
    /// whoever reviews the next plugin. A plugin's default is a promise about *its* future and not
    /// about this app's: `opener:default` held `allow-reveal-item-in-dir`, an unscoped list of
    /// paths nothing here ever called, until 2026-09-28. `core:default` is the one exception
    /// because it is Tauri's own baseline — events, the app and window getters — and every
    /// window needs it to hear anything at all.
    #[test]
    fn the_capability_grants_no_default_but_core_s() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop.json")).unwrap();
        let defaults: Vec<&str> = caps["permissions"]
            .as_array()
            .expect("the capability must list permissions")
            .iter()
            .map(|p| p.as_str().expect("every permission is a string"))
            .filter(|p| *p == "default" || p.ends_with(":default"))
            .collect();
        assert_eq!(defaults, ["core:default"]);
    }

    /// `openUrl` and nothing else of the opener's (`src/lib/externalLinks.ts`, and
    /// `update_open_release_page` in Rust, which the ACL does not gate). `allow-default-urls` is
    /// the scope `allow-open-url` needs to open anything — `http(s)`, `mailto` and `tel` — and the
    /// pair is `opener:default` (`tauri-plugin-opener-2.5.4/permissions/default.toml`) less its
    /// third entry, `allow-reveal-item-in-dir`.
    #[test]
    fn the_opener_opens_urls_and_nothing_on_disk() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop.json")).unwrap();
        let opener: Vec<&str> = caps["permissions"]
            .as_array()
            .expect("the capability must list permissions")
            .iter()
            .map(|p| p.as_str().expect("every permission is a string"))
            .filter(|p| p.starts_with("opener:"))
            .collect();
        assert_eq!(
            opener,
            ["opener:allow-open-url", "opener:allow-default-urls"]
        );
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

    /// The whole permission set the shipped app has, pinned: a widening or a narrowing of what
    /// the app can do is a decision, and this is where it has to be made on purpose.
    ///
    /// `platforms` is a real field: `tauri-utils`' `acl::capability::Capability` declares
    /// `pub platforms: Option<Vec<Target>>`, and omitting it targets every platform.
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
                "opener:allow-open-url",
                "opener:allow-default-urls",
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

    /// One capability file and no other: a second file naming these windows would widen what
    /// they may do without touching the permission set pinned above.
    #[test]
    fn the_capability_directory_is_exactly_the_desktop_file() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .expect("capabilities/ must exist")
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["desktop.json"]);
    }

    /// A window the app opens with no capability gets no `core:` — so its `listen` rejects and
    /// `core/tauri.ts` swallows it — no window verbs, no clipboard: a window that half works and
    /// says nothing. Every label `window::open_new` mints must be granted what `main` is.
    #[test]
    fn every_window_the_app_opens_is_granted_the_desktop_capability() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop.json")).unwrap();
        assert_eq!(
            caps["windows"],
            serde_json::json!(["main", format!("{}*", window::LABEL_PREFIX)])
        );
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
}
