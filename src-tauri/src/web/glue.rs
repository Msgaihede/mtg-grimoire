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

/// Download Commander Spellbook's `variants.json.gz` and store what it holds.
///
/// `fetched_at` comes from `Date.now()` in the Worker, in **unix seconds**. It is a
/// parameter and not a call to `SystemTime::now()`, which **panics** on
/// `wasm32-unknown-unknown` — and which this target cannot even name, because `sync.rs` and
/// `combos.rs` both gate that import off.
///
/// **The browser has already gunzipped this one and the desktop has not.** Spellbook sends
/// `Content-Encoding: gzip` even when the client asks for `identity`, and `fetch`
/// transparently decodes any such response with no way to opt out — so these chunks arrive
/// as plain JSON, while the same URL on desktop arrives still compressed. Nothing here has
/// to know: `feed::frame::Decoder` sniffs the two-byte magic and decides from the bytes.
///
/// `peakBuffer` is reported because a row count cannot see the failure this parser has.
/// Measured 2026-08-27: **2.01 MB against a 610.2 MB document**, 111 148 variants seen and
/// 105 516 kept, identical on a desktop and a OnePlus 12. A peak anywhere near the
/// document's own size means the framer desynchronised and is accumulating silently.
#[wasm_bindgen]
pub async fn ingest_combos(url: String, fetched_at: f64) -> String {
    use futures_util::StreamExt as _;

    let app = match state() {
        Ok(a) => a,
        Err(message) => return err(message),
    };
    let response = match net::get(&url).await {
        Ok(r) => r,
        Err(message) => return err(message),
    };
    let mut stream = response.bytes_stream();
    let mut sink = crate::combos::StreamRead::new();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => return err(format!("the combo download stopped partway: {e}")),
        };
        if let Err(e) = sink.push(&chunk) {
            return err(e);
        }
    }
    let peak = sink.peak_buffer();
    let file = match sink.finish() {
        Ok(f) => f,
        Err(e) => return err(e),
    };
    match crate::combos::store(&app.db, &file, None, fetched_at as i64, &mut |_, _| {}) {
        Ok(done) => json(&serde_json::json!({
            "kind": "ok",
            "combos": done.combos,
            "cards": done.cards,
            "skipped": done.skipped,
            "seen": done.seen,
            "peakBuffer": peak,
        })),
        Err(e) => err(e),
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
