//! The `#[wasm_bindgen]` surface `src/workers/db.ts` imports.
//!
//! Five functions, and every one of them returns a **JSON string**. Not a `JsValue`, and not
//! a `Result<JsValue, JsValue>`: the TypeScript side already has to know the shape of
//! [`crate::web::wire`], and a second, structural representation of the same thing is a
//! second place for it to drift. A caller does `JSON.parse` once and switches on `kind`.
//!
//! **Nothing here may panic.** A wasm trap does not arrive as a rejected promise with a
//! readable message — it arrives in the Worker's `onerror` with nothing the page can show,
//! which is how probe 2 spent a run sitting at "running…". Every entry point catches.

use crate::sync::AppState;
use crate::web::{net, route, wire};
use std::cell::RefCell;
use std::sync::{atomic::AtomicBool, Arc, Mutex, RwLock};
use wasm_bindgen::prelude::*;

thread_local! {
    /// The whole app's state, for the life of this Worker.
    ///
    /// A `thread_local` and not a `static`: a `Connection` is not `Sync`, and there is
    /// exactly one thread here anyway — that is the premise the entire web target rests on.
    static STATE: RefCell<Option<Arc<AppState>>> = const { RefCell::new(None) };
}

/// The `Arc`, cloned out so no `RefCell` borrow is ever held across an `.await`.
///
/// Holding one would be a `BorrowMutError` at runtime the first time an ingest ran while a
/// command arrived — a panic, which is the one thing this module must not produce.
fn state() -> Result<Arc<AppState>, String> {
    STATE
        .with(|s| s.borrow().clone())
        .ok_or_else(|| "the database is not open yet".to_owned())
}

fn json<T: serde::Serialize>(value: &T) -> String {
    // A DTO of ours that will not serialize is a bug here, and the caller still needs a
    // parseable answer rather than a trap.
    serde_json::to_string(value).unwrap_or_else(|e| {
        format!("{{\"kind\":\"failed\",\"message\":\"answer would not encode: {e}\"}}")
    })
}

/// A failure the caller can parse, for the entry points that do not answer a [`wire::Opened`].
fn err(message: impl std::fmt::Display) -> String {
    json(&serde_json::json!({ "kind": "err", "message": message.to_string() }))
}

/// Install the OPFS pool, open the database **pair**, migrate it, and remember it.
///
/// `directory` is the OPFS folder the pool lives in. There is no file argument: the pair's
/// names are fixed (`user.db` and `corpus.db`, [`crate::db::USER_DB`] and
/// [`crate::db::CORPUS_DB`]) and which one is `main` is a decision of the schema's, not of
/// the caller's. Answers a [`wire::Opened`].
///
/// **The `AlreadyOpen` arm is the one-tab guard**, and it fires on the *install* rather than
/// on the open — measured 2026-08-28: a second document of this origin cannot take the pool's
/// access handles and is refused with `NoModificationAllowedError` before it ever names a
/// database. That is not retried and not queued: spec §5.2 settled that the first tab wins
/// and the second says so.
///
/// **This must be called once per Worker, and `src/workers/db.ts` is what guarantees it.**
/// Nothing here is idempotent: a second call installs a second pool and replaces [`STATE`],
/// and until 2026-08-28 the Worker made that call twice — along with instantiating this whole
/// module twice, which is what corrupted the heap and cost two first runs in three. The dedup
/// lives on the TypeScript side because that is where the messages arrive.
#[wasm_bindgen]
pub async fn open(directory: String) -> String {
    console_error_panic_hook::set_once();

    if let Err(e) = crate::db::install_opfs_pool(&directory).await {
        return json(&wire::Opened::from_open_error(&e));
    }
    let (conn, journal, corpus_journal) = match crate::db::open_pooled_pair() {
        Ok(triple) => triple,
        Err(e) => return json(&wire::Opened::from_open_error(&format!("{e:?}"))),
    };
    if let Err(e) = crate::schema::prepare_database(&conn) {
        return json(&wire::Opened::Failed {
            message: format!("the database could not be migrated: {e}"),
        });
    }
    // Unqualified, so `main` — the user file, which is the version that gates compatibility.
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);

    let app = Arc::new(AppState {
        db: Mutex::new(conn),
        // There is no filesystem path here. The OPFS directory is what a reader would have
        // to look in, and it is what Settings shows in place of a folder.
        data_dir: std::path::PathBuf::from(format!("OPFS:/{directory}")),
        syncing: AtomicBool::new(false),
        index: RwLock::default(),
        // Nothing installs the update hook here — that is the mirror's, and the mirror is
        // desktop-only — so this can never trip. It is constructed rather than gated away
        // because the fence is `db`'s, not the mirror's, and `sync::with_write`'s
        // `debug_assert` reads it on every target.
        fence: Arc::new(crate::db::CrossFileFence::new()),
    });
    // A corpus may already be here from a previous session, so the index is built now
    // rather than only after an ingest — a cold index means every facet fails open.
    if let Err(e) = crate::index::lifecycle::build_now(&app) {
        // Not fatal, and deliberately so: faceting fails open by design, and refusing to
        // start over a facet index would trade a working app for a tidy one.
        web_log(&format!(
            "card index unavailable, facets will stay open: {e}"
        ));
    }
    STATE.with(|s| *s.borrow_mut() = Some(app));

    json(&wire::Opened::Ready {
        journal: format!("{journal:?}").to_lowercase(),
        corpus_journal: format!("{corpus_journal:?}").to_lowercase(),
        schema_version: version,
    })
}

/// Answer one [`wire::Request`], as a serialized [`wire::Response`].
///
/// Synchronous: the Worker is a thread with nothing else to do, so there is no
/// `spawn_blocking` to be had and none needed.
#[wasm_bindgen]
pub fn call(request_json: &str) -> String {
    let req: wire::Request = match serde_json::from_str(request_json) {
        Ok(r) => r,
        Err(e) => {
            // No id to answer against, so this cannot be a `Response::Err`. It is a bug in
            // the caller and it has to be visible somewhere.
            return json(&wire::Response::Event {
                event: "core://malformed-request".to_owned(),
                payload: serde_json::json!({ "message": e.to_string() }),
            });
        }
    };
    let app = match state() {
        Ok(a) => a,
        Err(message) => {
            return json(&wire::Response::Err {
                id: req.id,
                message,
            })
        }
    };
    match route::call(&app, &req.command, &req.args) {
        Ok(result) => json(&wire::Response::Ok { id: req.id, result }),
        Err(e) => json(&wire::Response::Err {
            id: req.id,
            message: e.to_string(),
        }),
    }
}

/// Download Scryfall's `default_cards` bulk file and ingest it, streaming throughout.
///
/// `on_progress` is called with the running insert count, every 2 000 rows — the same
/// [`crate::ingest`] batch that bounds how long the connection is held.
///
/// **Nothing is ever fully materialised**, and that is measured rather than intended:
/// `bytes_stream()` yields compressed chunks, each goes into the decoder, complete lines are
/// drained out and the partial tail carried to the next chunk. Peak memory is one chunk plus
/// one batch. 74.4 MB gzipped in, 598.8 MB of JSON out, 117 464 lines, **10.4 s** on a
/// desktop and 36.5 s on a OnePlus 12 (2026-08-27, against a 20-column subset of the row
/// this now writes in full).
///
/// **`navigator.storage.estimate()` is deliberately not consulted.** It reported 647 MB
/// during a fill and 7 MB immediately after a restart, against a file that was 532.8 MB both
/// times. Nothing may gate an ingest on it.
#[wasm_bindgen]
pub async fn ingest_cards(descriptor_url: String, on_progress: js_sys::Function) -> String {
    use futures_util::StreamExt as _;

    let app = match state() {
        Ok(a) => a,
        Err(message) => return err(message),
    };

    let descriptor = match net::get_json(&descriptor_url).await {
        Ok(v) => v,
        Err(message) => return err(message),
    };
    // `jsonl_download_uri`, **not** `download_uri`: Scryfall dropped the pre-2026-07-20
    // `download_uri`/`size` pair, and `scryfall::BulkInfo` reads the same key on desktop.
    let uri = descriptor["jsonl_download_uri"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    if uri.is_empty() {
        return err("the bulk descriptor named no jsonl_download_uri");
    }

    let response = match net::get(&uri).await {
        Ok(r) => r,
        Err(message) => return err(message),
    };
    let mut stream = response.bytes_stream();

    let mut sink = match crate::ingest::StreamIngest::begin(&app.db) {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    let mut report = |n: u64| {
        let _ = on_progress.call1(&JsValue::NULL, &JsValue::from_f64(n as f64));
    };

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => return err(format!("the download stopped partway: {e}")),
        };
        if let Err(e) = sink.push(&chunk, &mut report) {
            return err(e);
        }
    }
    let stats = match sink.finish(&mut report) {
        Ok(s) => s,
        Err(e) => return err(e),
    };

    // The swap renumbered every rowid, so the published index now answers about other cards.
    if let Err(e) = crate::index::lifecycle::build_now(&app) {
        web_log(&format!(
            "card index unavailable, facets will stay open: {e}"
        ));
    }

    json(&serde_json::json!({
        "kind": "ok",
        "inserted": stats.inserted,
        "skipped": stats.skipped,
    }))
}

// ---------------------------------------------------------------------------------------
// The three optional feeds
// ---------------------------------------------------------------------------------------
//
// **These are `#[wasm_bindgen]` entries and not routed commands, and the distinction is the
// whole seam.** [`crate::web::route::COMMANDS`] answers *queries*: it is synchronous, it
// takes the connection and it makes no network call. A refresh downloads tens of megabytes,
// reports itself as it goes and can only be `async`, so it arrives here beside
// [`ingest_cards`] — `combos_refresh` is deliberately absent from `COMMANDS`, and adding it
// there would be the wrong seam even though the name looks like every other command's.
//
// `src/lib/core/browser.ts` is what makes that invisible to the page: it maps the four
// refresh command names onto these entries, so `ipc.combosRefresh(true)` reaches this file on
// a browser and the Tauri command on a desktop, and no panel knows which.

/// Now, in unix seconds, **asked of SQLite rather than of the clock**.
///
/// `SystemTime::now()` and `Instant::now()` do not fail on `wasm32-unknown-unknown`, they
/// **panic** — and a wasm trap takes the Worker down with nothing the page can show. This is
/// `crate::tags::now_from`'s answer and `crate::combos::status_of`'s, reached for the same
/// reason on the same target.
fn now_seconds(app: &AppState) -> i64 {
    let conn = crate::sync::lock_db_read(app);
    conn.query_row("SELECT unixepoch()", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
}

/// One progress report, as the `{ event, payload }` envelope `db.ts` forwards verbatim.
///
/// **The event name comes from Rust**, because it already lives here — `combos::PROGRESS_EVENT`,
/// `Dataset::progress_event`, `marketplace_feed::PROGRESS_EVENT` — and a second table of the
/// same strings on the TypeScript side is a place for them to drift. `db.ts` re-emits this as
/// the Worker's `event` message and `browser.ts` hands it to whatever called `core.listen`,
/// so `ipc.onCombosProgress` needs no browser branch at all.
fn report(on_progress: &js_sys::Function, event: &str, phase: &str, done: u64, total: u64) {
    let envelope = serde_json::json!({
        "event": event,
        "payload": { "phase": phase, "done": done, "total": total },
    });
    let _ = on_progress.call1(&JsValue::NULL, &JsValue::from_str(&json(&envelope)));
}

/// How often the download phase reports itself, in bytes. `crate::tags`' `DOWNLOAD_EMIT_BYTES`
/// — a report per chunk would be thousands of `postMessage`s across a 63.7 MiB feed.
const PROGRESS_EMIT_BYTES: u64 = 1024 * 1024;

/// An answer `browser.ts` resolves a `core.call` with: the status DTO the desktop command
/// returns, under the same `kind` discipline every other entry point here uses.
fn done<T: serde::Serialize>(status: &T) -> String {
    json(&serde_json::json!({ "kind": "ok", "result": status }))
}

/// Download Commander Spellbook's `variants.json.gz` and store what it holds.
///
/// The browser's `combos_refresh`. `force` skips the weekly throttle exactly as the desktop
/// command's does — and there is no ETag half to skip, because a browser cannot read one: a
/// cross-origin `fetch` exposes no `ETag` header unless the host names it in
/// `Access-Control-Expose-Headers`, so this always downloads where the desktop can take a
/// 304. That is a real cost of the target rather than a shortcut, and it is why the throttle
/// is honoured here rather than ignored.
///
/// **The browser has already gunzipped this one and the desktop has not.** Spellbook sends
/// `Content-Encoding: gzip` even when the client asks for `identity`, and `fetch`
/// transparently decodes any such response with no way to opt out — so these chunks arrive
/// as plain JSON, while the same URL on desktop arrives still compressed. Nothing here has
/// to know: `feed::frame::Decoder` sniffs the two-byte magic and decides from the bytes.
///
/// Measured 2026-08-27: **a 2.01 MB peak framer buffer against a 610.2 MB document**, 111 148
/// variants seen and 105 516 kept, identical on a desktop and a OnePlus 12. A peak anywhere
/// near the document's own size means the framer desynchronised and is accumulating silently
/// — which is why `Elements` now refuses past `feed::frame::MAX_ELEMENT_BYTES` rather than
/// leaving that to a caller who might not look.
#[wasm_bindgen]
pub async fn ingest_combos(force: bool, on_progress: js_sys::Function) -> String {
    use futures_util::StreamExt as _;

    let app = match state() {
        Ok(a) => a,
        Err(message) => return err(message),
    };
    let event = crate::combos::PROGRESS_EVENT;

    // A refresh that is not due does nothing and says so, which is the desktop's answer and
    // costs zero bytes on a link the reader may be paying for.
    let status = crate::combos::status_of(&app);
    if !force && !status.stale {
        report(&on_progress, event, "done", 0, 0);
        return done(&status);
    }

    report(&on_progress, event, "checking", 0, 0);
    let response = match net::get(crate::combos::FEED_URL).await {
        Ok(r) => r,
        Err(message) => {
            report(&on_progress, event, "error", 0, 0);
            return err(message);
        }
    };
    let total = response.content_length().unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut sink = crate::combos::StreamRead::new();
    let mut got = 0u64;
    let mut last = 0u64;
    report(&on_progress, event, "downloading", 0, total);

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                report(&on_progress, event, "error", 0, 0);
                return err(format!("the combo download stopped partway: {e}"));
            }
        };
        got += chunk.len() as u64;
        if let Err(e) = sink.push(&chunk) {
            report(&on_progress, event, "error", 0, 0);
            return err(e);
        }
        if got.saturating_sub(last) >= PROGRESS_EMIT_BYTES {
            last = got;
            report(&on_progress, event, "downloading", got, total.max(got));
        }
    }
    report(&on_progress, event, "ingesting", 0, 0);
    let file = match sink.finish() {
        Ok(f) => f,
        Err(e) => {
            report(&on_progress, event, "error", 0, 0);
            return err(e);
        }
    };
    // `None` for the ETag, for the reason above: there is none to store.
    let fetched_at = now_seconds(&app);
    match crate::combos::store(&app.db, &file, None, fetched_at, &mut |_, _| {}) {
        Ok(_) => {
            report(&on_progress, event, "done", 0, 0);
            done(&crate::combos::status_of(&app))
        }
        Err(e) => {
            // **The previous combos are exactly where they were.** `store` stages and
            // promotes in one transaction, so a failure here changed no row — the panel is
            // owed the state the database is actually in rather than an empty one.
            report(&on_progress, event, "error", 0, 0);
            err(e)
        }
    }
}

/// Download one of Scryfall's two tag taxonomies and replace it.
///
/// The browser's `oracle_tags_refresh` and `art_tags_refresh`, which are one function here
/// for the reason they are one engine in `crate::tags`: the two files are the same file in
/// two dialects, and everything that differs is on the `Dataset`.
///
/// **No ETag and no 304**, for [`ingest_combos`]' reason. What survives is the *other* half of
/// the desktop's freshness check: the descriptor's `updated_at` is stored with the rows, so a
/// database that already holds this build of the file can still say so.
#[wasm_bindgen]
pub async fn ingest_tags(dataset: String, force: bool, on_progress: js_sys::Function) -> String {
    use futures_util::StreamExt as _;

    let ds: &'static crate::tags::Dataset = match dataset.as_str() {
        "oracle" => &crate::tags::oracle::ORACLE,
        "art" => &crate::tags::art::ART,
        other => return err(format!("there is no `{other}` tag dataset")),
    };
    let app = match state() {
        Ok(a) => a,
        Err(message) => return err(message),
    };
    let event = ds.progress_event;

    let status = crate::tags::status_of(ds, &app);
    if !force && !status.stale {
        report(&on_progress, event, "done", 0, 0);
        return done(&status);
    }

    report(&on_progress, event, "checking", 0, 0);
    // The per-type bulk endpoint, which is what `scryfall::Client::check_bulk_dataset` asks
    // on the desktop. `jsonl_download_uri` and **not** `download_uri`: Scryfall dropped the
    // pre-2026-07-20 pair, and `ingest_cards` reads the same key.
    let descriptor_url = format!("https://api.scryfall.com/bulk-data/{}", ds.bulk_name);
    let descriptor = match net::get_json(&descriptor_url).await {
        Ok(v) => v,
        Err(message) => {
            report(&on_progress, event, "error", 0, 0);
            return err(message);
        }
    };
    let uri = descriptor["jsonl_download_uri"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    if uri.is_empty() {
        report(&on_progress, event, "error", 0, 0);
        return err(format!(
            "the {} descriptor named no jsonl_download_uri",
            ds.bulk_name
        ));
    }
    let stamp = crate::tags::FileStamp {
        etag: None,
        updated_at: descriptor["updated_at"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
    };

    let response = match net::get(&uri).await {
        Ok(r) => r,
        Err(message) => {
            report(&on_progress, event, "error", 0, 0);
            return err(message);
        }
    };
    let total = response.content_length().unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut sink = match crate::tags::StreamTags::begin(ds, &app.db) {
        Ok(s) => s,
        Err(e) => {
            report(&on_progress, event, "error", 0, 0);
            return err(e);
        }
    };
    let mut got = 0u64;
    let mut last = 0u64;
    report(&on_progress, event, "downloading", 0, total);

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                report(&on_progress, event, "error", 0, 0);
                return err(format!(
                    "the {} download stopped partway: {e}",
                    ds.bulk_name
                ));
            }
        };
        got += chunk.len() as u64;
        if let Err(e) = sink.push(&chunk, &mut |_| {}) {
            report(&on_progress, event, "error", 0, 0);
            return err(e);
        }
        if got.saturating_sub(last) >= PROGRESS_EMIT_BYTES {
            last = got;
            report(&on_progress, event, "downloading", got, total.max(got));
        }
    }
    report(&on_progress, event, "ingesting", 0, 0);
    let ingested_at = now_seconds(&app);
    match sink.finish(&stamp, ingested_at, &mut |_| {}) {
        Ok(_) => {
            report(&on_progress, event, "done", 0, 0);
            done(&crate::tags::status_of(ds, &app))
        }
        Err(e) => {
            // The staged write was never promoted, so the previous taxonomy is untouched —
            // which is the rule that lets a failed refresh cost a reader nothing.
            report(&on_progress, event, "error", 0, 0);
            err(e)
        }
    }
}

/// Download one marketplace's price feed and replace that marketplace's rows.
///
/// The browser's `marketplace_feed_refresh`, and it takes no `force` because the desktop
/// command does not either: a reader who presses Refresh on a price panel is asking for now.
///
/// **`state.mirror.mark_all()` has no counterpart here and that is not an omission.** The
/// desktop calls it because a new price changes what every mirrored CSV would say; a browser
/// has no plain-text mirror, which is the same argument `web::route`'s `set_marketplace` arm
/// already makes one module over.
#[wasm_bindgen]
pub async fn ingest_prices(marketplace: String, on_progress: js_sys::Function) -> String {
    use futures_util::StreamExt as _;

    let Some(provider) = crate::marketplace_feed::provider_for(&marketplace) else {
        return err(format!(
            "\"{marketplace}\" has no price feed this app can download. Feeds: {}.",
            crate::marketplace_feed::PROVIDERS
                .iter()
                .map(|p| p.marketplace())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    };
    let app = match state() {
        Ok(a) => a,
        Err(message) => return err(message),
    };
    let event = crate::marketplace_feed::PROGRESS_EVENT;

    report(&on_progress, event, "downloading", 0, 0);
    let response = match net::get(provider.url()).await {
        Ok(r) => r,
        Err(message) => {
            report(&on_progress, event, "error", 0, 0);
            return err(message);
        }
    };
    let total = response.content_length().unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut sink = crate::marketplace_feed::StreamRead::new(provider);
    let mut got = 0u64;
    let mut last = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                report(&on_progress, event, "error", 0, 0);
                return err(format!("the price feed stopped partway: {e}"));
            }
        };
        got += chunk.len() as u64;
        if let Err(e) = sink.push(&chunk) {
            report(&on_progress, event, "error", 0, 0);
            return err(e);
        }
        if got.saturating_sub(last) >= PROGRESS_EMIT_BYTES {
            last = got;
            report(&on_progress, event, "downloading", got, total.max(got));
        }
    }
    report(&on_progress, event, "ingesting", 0, 0);
    let feed = match sink.finish() {
        Ok(f) => f,
        Err(e) => {
            report(&on_progress, event, "error", 0, 0);
            return err(e);
        }
    };
    let fetched_at = now_seconds(&app);
    match crate::marketplace_feed::store(&app.db, &feed, fetched_at) {
        Ok(_) => {
            report(&on_progress, event, "done", 0, 0);
            let conn = crate::sync::lock_db_read(&app);
            let now = conn
                .query_row("SELECT unixepoch()", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0);
            done(&crate::marketplace_feed::read_status(&conn, provider, now))
        }
        Err(e) => {
            // **A failed refresh leaves the previous prices in place** — stale prices with an
            // honest as-of line beat an empty table, which is the rule the whole feed follows.
            report(&on_progress, event, "error", 0, 0);
            err(e)
        }
    }
}

/// Drop the connection so the pool's access handles are released.
///
/// Called from the Worker's `close` path. Without it a reload can race its own predecessor
/// and be told the database is already open — by itself.
#[wasm_bindgen]
pub fn close() {
    STATE.with(|s| *s.borrow_mut() = None);
}

/// `console.warn`, for the things that are not failures and still must not be silent.
fn web_log(message: &str) {
    web_sys::console::warn_1(&JsValue::from_str(message));
}
