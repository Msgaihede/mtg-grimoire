//! **The light app's Android host** — the light-app spec §5, phase 4.
//!
//! A second Tauri project over `grimoire-core`, holding almost nothing of its own:
//!
//! - **the mobile entry point**, [`run`], which Tauri's Android shell calls from the activity;
//! - **one command, [`core_call`]**, which answers every call the page makes by forwarding it to
//!   [`grimoire_core::dispatch`] — so a command the core's table does not have is refused here
//!   in the table's own words, and `src/lib/core` picks this transport by asking nothing of the
//!   page (see [`HOST_MARK`]);
//! - **the startup gate** the page waits on before it mounts ([`startup`]), answered inside
//!   `core_call` because the core has no window to start;
//! - **the `mtgimg` protocol**, answered by the core's [`grimoire_core::images::answer`] — the
//!   same contract the desktop's `mtgimg://` handler hands its webview;
//! - **the desktop's two file commands**, `export_save_file` and `import_pick_file`, answered
//!   through the system's own picker and save dialog ([`files`]), and **a navigation guard** that
//!   keeps the window on the app's pages and hands every web link to the system browser
//!   ([`navigation`]) — step 4.3.
//!
//! **What it starts is the desktop's launch less what is the desktop's alone** ([`start`]): the
//! facet index, the image upkeep, the card sync and, behind it on a first run, the optional
//! feeds. No mirror, no updater, no second window, no live sync (phase 6).
//!
//! **It also builds and runs on a desktop**, as a debugging aid: `cargo run -p grimoire-light`
//! after `npm run mobile:build` opens the light app in a phone-sized window over its own data
//! folder (`light-data` beside the binary, never the desktop app's). Nothing ships that way.

use std::path::PathBuf;
use std::sync::Arc;

use grimoire_core::state::State;
use serde_json::Value;
use tauri::Manager;

mod downloads;
mod files;
mod navigation;
mod startup;

use startup::{Startup, StartupStatus};

/// What the host tells `src/lib/core` before the page's first script runs: that every command
/// goes through [`core_call`]. Below the `Core` seam and nowhere else — no page, and nothing under
/// `mobile/`, may read it (`mobile/phone/fence.test.ts`) — so the light app stays one program
/// that asks nothing about where it runs, and only the transport under it differs.
pub const HOST_MARK: &str = "window.__GRIMOIRE_CORE__ = \"table\";";

/// The one command this host registers: answer `name` with `args` through the core's table.
///
/// `body` is a raw body, base64 — Tauri accepts none on Android, so a `bytes` command's payload
/// rides here as text (spec §2.4) — and is refused when it does not decode, rather than
/// forwarded as nothing.
///
/// **`startup_status` is answered here, not by the core**: it is the question the page asks
/// before the state exists, and the core has no state to answer it from until [`start`] has
/// built one. Every other name before that is told the app is still starting, which the page's
/// gate never sends — it mounts nothing until the answer is `ready`.
#[tauri::command]
async fn core_call(
    app: tauri::AppHandle,
    name: String,
    args: Option<Value>,
    body: Option<String>,
) -> Result<Value, String> {
    if name == startup::COMMAND {
        let status = app.state::<Startup>().status();
        return serde_json::to_value(status).map_err(|e| e.to_string());
    }
    // The two file commands need no state: a dialog and a document, never the database.
    if files::answers(&name) {
        return files::answer(&app, &name, args).await;
    }
    let Some(state) = app.try_state::<Arc<State>>() else {
        return Err(format!("{name}: the app is still starting."));
    };
    let state = Arc::clone(&state);
    if downloads::answers(&name) {
        let hold = app.state::<downloads::Hold>();
        return downloads::answer(state, &hold, &name, args).await;
    }
    let body = body.map(|b| decode_body(&name, &b)).transpose()?;
    grimoire_core::dispatch(&state, &name, args.unwrap_or(Value::Null), body).await
}

/// A raw body, from the base64 it crossed the bridge as.
fn decode_body(name: &str, text: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|e| format!("{name}: its body is not base64: {e}"))
}

/// The Tauri app: the protocol, the command, the startup gate, and the launch on a thread of its
/// own — `setup` runs on the UI thread, and opening and migrating the databases is seconds on a
/// first run (the desktop's `startup` module has the measurement that moved its launch off it).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Used from Rust only — the capability grants the page none of them (`Cargo.toml` says
        // why). `fs` before `dialog`, which reads through it.
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation::guard())
        // Card art from the cache. On Android a custom scheme is served at
        // `http://mtgimg.localhost/…` and on a desktop at `mtgimg://localhost/…` or
        // `http://mtgimg.localhost/…`; only the path is read, so one handler serves them all.
        // Asynchronous, because a miss is a network fetch and the synchronous form would hold the
        // webview's loader — every other image on the page — for the length of one download.
        .register_asynchronous_uri_scheme_protocol("mtgimg", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_owned();
            tauri::async_runtime::spawn(async move {
                responder.respond(to_response(serve(&app, &path).await));
            });
        })
        .append_invoke_initialization_script(HOST_MARK)
        .invoke_handler(tauri::generate_handler![core_call])
        .setup(|app| {
            app.manage(Startup::default());
            app.manage(downloads::Hold::default());
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("startup".into())
                .spawn(move || start(&handle))?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the light app could not start");
}

/// One image request's answer, before the state exists and after.
async fn serve(app: &tauri::AppHandle, path: &str) -> grimoire_core::images::Reply {
    use grimoire_core::images::{answer, parse_request_path, Reply};
    if parse_request_path(path).is_none() {
        return Reply::not_an_image();
    }
    let Some(state) = app.try_state::<Arc<State>>() else {
        return Reply::not_ready();
    };
    answer(&state, path).await
}

/// A [`grimoire_core::images::Reply`] in the type Tauri's protocol handler hands its webview —
/// the same conversion `src-tauri`'s `images::to_response` makes.
fn to_response(reply: grimoire_core::images::Reply) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response};
    let mut builder = Response::builder()
        .status(reply.status)
        .header(header::CONTENT_TYPE, reply.content_type)
        .header(header::CACHE_CONTROL, reply.cache_control);
    if let Some(secs) = reply.retry_after {
        builder = builder.header(header::RETRY_AFTER, secs.to_string());
    }
    builder.body(reply.body).expect("image response")
}

/// Where the databases live: the app's private data folder on a phone; beside the binary on a
/// desktop, so a debugging run never opens the desktop app's own folder (the two share an
/// identifier, which is what `app_data_dir` is keyed by).
fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(mobile) {
        app.path()
            .app_data_dir()
            .map(|d| d.join("data"))
            .map_err(|e| format!("MTG Grimoire could not locate its data folder: {e}"))
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("light-data")))
            .ok_or_else(|| "MTG Grimoire could not locate the folder it runs from.".to_owned())
    }
}

/// The launch, on the `startup` thread — the desktop's `desktop::start` less what only the
/// desktop has. [`startup::settle`] goes after the last `manage` and before the first background
/// task, for the desktop's reason: before it the page mounts nothing, after it every piece of
/// state a command reaches is in place.
fn start(app: &tauri::AppHandle) {
    let state = match open(app) {
        Ok(state) => Arc::new(state),
        Err(message) => {
            eprintln!("{message}");
            startup::settle(app, StartupStatus::Failed { message });
            return;
        }
    };
    app.manage(Arc::clone(&state));

    // The facet index: a full scan on a thread of its own, so the first searches answer before it.
    grimoire_core::index::lifecycle::spawn_build(&state);
    // The image cache's budget: a pass a minute after launch and every minute after.
    spawn_upkeep(&state);

    // **Whether the launch's downloads wait — decided before the page is told it may mount.** The
    // prompt asks `light_downloads` once, as it mounts; decided after `settle`, a question landing
    // first reads `held: false`, the hold comes down after it, and a metered first run sits with
    // no cards and no prompt (found in review, 2026-10-03). Nothing starts until after `settle`.
    let start_downloads = downloads::decide(
        &state,
        &app.state::<downloads::Hold>(),
        downloads::metered(),
    );

    startup::settle(app, StartupStatus::Ready);

    // The corpus check the launch no longer waits for — see `schema::check_corpus`.
    let check = Arc::clone(&state);
    let _ = std::thread::Builder::new()
        .name("corpus-check".into())
        .spawn(move || check_corpus(&check));

    // The launch's downloads — unless Android said the link is metered and the reader has not
    // said "always": then they wait for the page's prompt (`downloads`, step 4.4).
    if start_downloads {
        spawn_downloads(&state);
    }
}

/// The card sync, and the optional feeds — behind it on a first run, beside it after: on a first
/// run the reader waits for the cards, and ~46 MB of feeds on the same link would make that wait
/// longer for data no screen can use until the cards are there (issue #551). The launch calls it,
/// or the page's mobile-data prompt does once the reader says yes.
pub(crate) fn spawn_downloads(state: &Arc<State>) {
    let first_run = {
        let conn = state.lock_db_read();
        !grimoire_core::sync::has_cards(&conn)
    };
    let sync_state = Arc::clone(state);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = grimoire_core::sync::run_sync(Arc::clone(&sync_state), false).await {
            eprintln!("initial sync failed: {e}");
        }
        if first_run {
            spawn_optional_feeds(&sync_state);
        }
    });
    if !first_run {
        spawn_optional_feeds(state);
    }
}

/// Open the data folder and build the state over it: the core's [`grimoire_core::launch::open`],
/// an event sink that forwards to the page, and no write observers — the desktop's three are its
/// mirror, its other windows and its live socket, and this host has none of them.
fn open(app: &tauri::AppHandle) -> Result<State, String> {
    let data_dir = data_dir(app)?;
    let opened = grimoire_core::launch::open(&data_dir)?;
    Ok(State::new(
        opened.write,
        Some(opened.read),
        data_dir,
        Arc::new(PageEvents(app.clone())),
        Vec::new(),
        opened.client,
        opened.images,
    ))
}

/// The selected marketplace's price feed, both Tagger files and the combos, each on a task of its
/// own — four services on four schedules, and none of them may be the reason another stops. The
/// desktop's `spawn_optional_feeds` has each one's argument.
fn spawn_optional_feeds(state: &Arc<State>) {
    let s = Arc::clone(state);
    tauri::async_runtime::spawn(async move {
        grimoire_core::marketplace_feed::refresh_selected_if_due(&s).await;
    });
    let s = Arc::clone(state);
    tauri::async_runtime::spawn(async move {
        grimoire_core::tags::oracle::refresh_if_due(&s).await;
    });
    let s = Arc::clone(state);
    tauri::async_runtime::spawn(async move {
        grimoire_core::tags::art::refresh_if_due(&s).await;
    });
    let s = Arc::clone(state);
    tauri::async_runtime::spawn(async move {
        grimoire_core::combos::refresh_if_due(&s).await;
    });
}

/// The image cache's upkeep loop: the core's pass, every [`grimoire_core::images::UPKEEP_TICK`],
/// on a thread that sleeps between — the ten lines the core's CLAUDE.md says a host owes.
fn spawn_upkeep(state: &Arc<State>) {
    use grimoire_core::images::{upkeep_tick, UPKEEP_TICK};
    let state = Arc::clone(state);
    let spawned = std::thread::Builder::new()
        .name("image-upkeep".into())
        .spawn(move || {
            let mut stores_at_last_pass: Option<u64> = None;
            loop {
                std::thread::sleep(UPKEEP_TICK);
                upkeep_tick(&state, &mut stores_at_last_pass);
            }
        });
    if let Err(e) = spawned {
        eprintln!("image cache: could not start the upkeep thread, so nothing is evicted: {e}");
    }
}

/// The full corpus check, and the mark that makes the next launch replace a damaged file — the
/// desktop's `check_corpus_in_background` without its `error_log` row's wording.
fn check_corpus(state: &State) {
    use grimoire_core::schema::{check_corpus, mark_corpus_damaged, CorpusCheck};
    if let CorpusCheck::Damaged(answer) = check_corpus(&state.data_dir) {
        eprintln!("the card database is damaged and will be replaced at the next launch: {answer}");
        if let Err(e) = mark_corpus_damaged(&state.data_dir, &answer) {
            eprintln!("could not mark the card database for replacement: {e}");
        }
    }
}

/// The engine's events, forwarded to the page — `sync:progress`, the feeds' progress and
/// `collection:reconciled`, each as `app.emit` sends one. A dropped event is never worth failing
/// anything over.
struct PageEvents(tauri::AppHandle);

impl grimoire_core::events::EventSink for PageEvents {
    fn emit(&self, name: &str, payload: Value) {
        use tauri::Emitter;
        let _ = self.0.emit(name, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A body that is not base64 is refused by name, never forwarded as nothing.
    #[test]
    fn a_body_that_is_not_base64_is_refused_in_words() {
        let err = decode_body("scanner_frame", "not base64!").unwrap_err();
        assert!(
            err.starts_with("scanner_frame: its body is not base64"),
            "{err}"
        );
        assert_eq!(decode_body("x", "AAEC").unwrap(), vec![0u8, 1, 2]);
    }

    /// The mark `src/lib/core/index.ts` reads. Its spelling is the contract between the two
    /// sides; `src/lib/core/core.test.ts` pins the same string from the other side.
    #[test]
    fn the_host_mark_names_the_table() {
        assert_eq!(HOST_MARK, "window.__GRIMOIRE_CORE__ = \"table\";");
    }

    /// The image answer's headers survive the conversion — the core's contract, unbent.
    #[test]
    fn a_reply_keeps_its_status_and_headers() {
        let r = to_response(grimoire_core::images::Reply::not_ready());
        assert_eq!(r.status(), 503);
        assert_eq!(r.headers().get("retry-after").unwrap(), "1");
        assert_eq!(r.headers().get("cache-control").unwrap(), "no-store");
    }
}
