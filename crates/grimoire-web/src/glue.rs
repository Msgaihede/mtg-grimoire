//! **The browser**: the three `#[wasm_bindgen]` exports a dedicated Worker imports, the OPFS
//! pool, and the three `thread_local`s that are this host's whole memory.
//!
//! Compiled for `wasm32-unknown-unknown` and nowhere else (`lib.rs` gates the module), which is
//! why there is so little here: everything these exports *decide* is in [`crate::host`] and
//! [`crate::wire`], where a desktop's `cargo test` reaches it. What is left is what only a
//! browser can do — hold a JavaScript function, install a VFS over
//! `FileSystemSyncAccessHandle`s, write to a console.
//!
//! **Every export answers a JSON string, and none may reject or trap.** A trap in a Worker does
//! not arrive as a rejected promise with a message — it arrives in the Worker's `onerror` with
//! nothing a page can show. So a call before `open` is an answer, arguments that are not JSON
//! are an answer, and the panic hook is installed before anything can panic, so a bug that
//! does trap leaves its sentence in the console first.
//!
//! **It must run in a dedicated Worker, and exactly one instance of this module per Worker.**
//! The pool's handles exist only off the main thread; and two instances of a `wasm-bindgen`
//! module in one Worker corrupt each other's heap, which cost the first web host two first
//! runs in three. The Worker's script memoises the *load*; [`open`] memoises the *open*.

use std::cell::RefCell;
use std::path::Path;
use std::sync::Arc;

use futures_util::FutureExt as _;
use grimoire_core::events::EventSink;
use grimoire_core::state::State;
use serde_json::Value;
use wasm_bindgen::prelude::*;

use crate::host::{self, Once};
use crate::wire::Opened;

thread_local! {
    /// The app's state, for the life of this Worker — set once, by the first [`open`] that
    /// answers `ready`. A `thread_local` and not a `static`: a `Connection` is not `Sync`, and
    /// there is exactly one thread here, which is the premise the whole host rests on.
    static STATE: RefCell<Option<Arc<State>>> = const { RefCell::new(None) };

    /// The first [`open`], which every later one awaits — [`Once`] has the reason.
    static OPENING: Once<String> = const { Once::new() };

    /// Where an event goes: the function [`listen`] was last given.
    static HANDLER: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

#[wasm_bindgen]
extern "C" {
    /// `console.warn`, for what is not a failure and still must not be silent — the core's own
    /// `eprintln!` goes nowhere on this target.
    #[wasm_bindgen(js_namespace = console)]
    fn warn(message: &str);
}

/// Runs as the module is instantiated: a panic from here on is written to the Worker's console
/// with its sentence and its line before it traps.
#[wasm_bindgen(start)]
pub fn instantiated() {
    console_error_panic_hook::set_once();
}

/// `open(directory: string): Promise<string>` — install the OPFS pool in `directory`, open the
/// two databases on one connection, bring them to head, build the state and the facet index,
/// and remember the state for the life of this Worker.
///
/// Resolves to one of ([`Opened`]):
///
/// ```text
/// {"kind":"ready","journal":"delete","corpusJournal":"delete","schemaVersion":59}
/// {"kind":"already-open"}
/// {"kind":"failed","message":"…"}
/// ```
///
/// **Called twice, it opens once**: a second call — before the first has finished or after —
/// installs no second pool and replaces no state; it resolves to what the first did, whatever
/// that was. A page that wants another attempt reloads, which is a new Worker.
///
/// **`already-open` is the one-tab guard, and it fires at the install**: a second document of
/// this origin cannot take the pool's access handles, and is refused before it names a
/// database. Not retried and not queued **here** — the first tab wins. What the page makes
/// of the refusal is its own: it tells a second tab so, and asks again, with a new Worker,
/// when the Web Lock says no other document is alive (`src/lib/core/web/holder.ts`).
///
/// **A `ready` answer starts the launch's downloads and does not wait for them**
/// ([`host::launch_downloads`]): the card sync and then, one after another, the optional
/// feeds, as one task on this Worker's own event loop. They say what they are doing through
/// [`listen`]'s handler. **No upkeep loop** ([`host::start`] says why).
///
/// **And it starts live sync** ([`host::live_sync`]), a second task beside the first and for
/// the Worker's life: the relay's doorbell, which opens no socket until this device is in a
/// sync group.
///
/// **A corpus that will not open is thrown away and built again**, through the pool's own
/// delete ([`host::start_replacing`]); `user.db` is never touched, and the console is told.
#[wasm_bindgen]
pub async fn open(directory: String) -> String {
    let opening = OPENING.with(|once| once.get(move || open_once(directory).boxed_local()));
    opening.await
}

async fn open_once(directory: String) -> String {
    console_error_panic_hook::set_once();
    let pool = match install_pool(&directory).await {
        Ok(pool) => pool,
        Err(text) => return Opened::from_install_error(&text).to_json(),
    };
    // The pool's delete only. What decides that it is called, and how often, is the core's
    // (`launch::open_single_replacing`); which files are the corpus's, in what order, and
    // that every one is attempted whatever an earlier one answered, are `host`'s.
    let mut delete_corpus = || -> Result<(), String> {
        host::delete_corpus(&pool.list(), &mut |name| {
            pool.delete_db(name)
                .map(|_| ())
                .map_err(|e| format!("{e}: {e:?}"))
        })
    };
    // An empty place: the pool is the filesystem, and its two names are bare.
    let started = host::start_replacing(
        Path::new(""),
        &directory,
        Arc::new(PageEvents),
        &mut delete_corpus,
    );
    match started {
        Ok(started) => {
            if started.corpus_replaced {
                warn(host::CORPUS_REPLACED);
            }
            if let Err(e) = &started.index {
                warn(&format!(
                    "card index unavailable, facets will stay open: {e}"
                ));
            }
            STATE.with(|state| *state.borrow_mut() = Some(Arc::clone(&started.state)));
            // Spawned, never awaited: `open` answers now, and the downloads run between the
            // calls that follow it. Its first poll comes after this function has returned.
            wasm_bindgen_futures::spawn_local(host::launch_downloads(Arc::clone(&started.state)));
            // The relay's doorbell, behind the downloads and for the Worker's life. On an
            // install in no sync group — every one that has paired nothing — its first poll
            // is one read of `sync_group` and a five-second timer.
            wasm_bindgen_futures::spawn_local(host::live_sync(started.state, started.writes));
            started.opened.to_json()
        }
        Err(message) => Opened::Failed { message }.to_json(),
    }
}

/// Install the OPFS VFS and make it SQLite's default, so the bare names
/// `grimoire_core::db::open_single` opens are files in the pool.
///
/// **Cross-origin isolation is not required** — the first web host served the same page with
/// and without `COOP`/`COEP` and passed both ways. Do not add those headers for this.
///
/// The error is text because the crate hands back a `JsValue` and the caller needs its words:
/// [`Opened::from_install_error`] tells "held by another tab" from "broken" by the
/// `DOMException`'s name inside it.
///
/// What the install answers is the pool's management handle, **kept for one thing**: its
/// `delete_db`, which is how a corpus that will not open is thrown away ([`open_once`]). It
/// is not stored past the open — asking `install` again for a VFS that is registered answers
/// the handle and installs nothing, should a later step want it.
async fn install_pool(
    directory: &str,
) -> Result<sqlite_wasm_vfs::sahpool::OpfsSAHPoolUtil, String> {
    let cfg = sqlite_wasm_vfs::sahpool::OpfsSAHPoolCfgBuilder::new()
        .vfs_name(host::POOL_VFS)
        .directory(directory)
        .initial_capacity(host::POOL_CAPACITY)
        .build();
    sqlite_wasm_vfs::sahpool::install::<rusqlite::ffi::WasmOsCallback>(&cfg, true)
        .await
        // Both forms: the crate's own sentence, and the debug text, which is where the
        // browser's `DOMException` — and so its name — is.
        .map_err(|e| format!("{e}: {e:?}"))
}

/// `call(name: string, args: string, body?: Uint8Array): Promise<string>` — answer the command
/// `name` through `grimoire_core::dispatch`.
///
/// `args` is JSON text — `"null"`, or the object a desktop page would hand Tauri. Resolves to
/// `{"ok": <value>}` or `{"err": "<sentence>"}`, and **never rejects**: a call before [`open`]
/// has answered `ready` is an `err`, and so are arguments that are not JSON.
#[wasm_bindgen]
pub async fn call(name: String, args: String, body: Option<Vec<u8>>) -> String {
    // The `Arc`, cloned out: no `RefCell` borrow is ever held across an `.await`, which would
    // be a `BorrowMutError` the first time a call arrived while another was in flight.
    let state = STATE.with(|state| state.borrow().clone());
    host::call(state, &name, &args, body).await
}

/// `listen(handler: (name: string, payload: string) => void): void` — where the engine's
/// events go from now on. `payload` is JSON text.
///
/// One handler: a second call replaces the first. An event raised before any handler was given
/// is dropped, as an event with nobody listening always is (`grimoire_core::events`).
#[wasm_bindgen]
pub fn listen(handler: js_sys::Function) {
    HANDLER.with(|slot| *slot.borrow_mut() = Some(handler));
}

/// The state's event sink: every `EventSink::emit` reaches [`listen`]'s handler.
///
/// **A unit type, with the function in a `thread_local` beside it**, because the core's sink is
/// `Send + Sync` — an event is raised from whatever thread the work is on — and a
/// `js_sys::Function` is neither. Here there is one thread, so the function is where every
/// emit can find it and the trait is asked to give up nothing.
struct PageEvents;

impl EventSink for PageEvents {
    fn emit(&self, name: &str, payload: Value) {
        // Cloned out before it is called: a handler that calls `listen` must not find the
        // slot borrowed.
        let Some(handler) = HANDLER.with(|slot| slot.borrow().clone()) else {
            return;
        };
        // A handler that throws has dropped its own event; nothing here fails over it.
        let _ = handler.call2(
            &JsValue::NULL,
            &JsValue::from_str(name),
            &JsValue::from_str(&host::payload_text(&payload)),
        );
    }
}
