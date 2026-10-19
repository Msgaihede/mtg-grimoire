//! **workerd**: the `#[wasm_bindgen]` class the `BotDevice` Durable Object holds, and the page
//! store over its synchronous SQL storage.
//!
//! Compiled for `wasm32-unknown-unknown` and nowhere else (`lib.rs` gates it). What a method here
//! *decides* is in [`crate::device`], where a desktop's `cargo test` reaches it.
//!
//! **Every method answers JSON text and none rejects or traps on a refusal**: `{"ok": …}` or
//! `{"err": "<sentence>"}` for the reads, the front's own shapes for `enroll` and `status`, and for
//! an add's two (`target`, `add`) also `{"refused": "<sentence>"}` — words for the reader, where an
//! `err`'s are the engine's and go nowhere. The
//! panic hook is installed when the module is instantiated, so a bug that does trap leaves its
//! sentence in the Worker's log first.
//!
//! **One isolate may hold several Durable Objects of the class**, and they share this module's
//! memory: so each object's [`Bot`] is its own value, mounted under its own id
//! ([`crate::vfs::mount`]), and nothing here is a global but the VFS's registry.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use js_sys::{Array, Function, Reflect, Uint8Array};
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::device::{self, Device, Options, Refusal};
use crate::vfs::PageStore;

#[wasm_bindgen(start)]
pub fn instantiated() {
    console_error_panic_hook::set_once();
}

/// The Durable Object's page store, as its script hands it over: an object with four methods,
/// each synchronous (`infrastructure/bot-device/src/store.ts`).
///
/// ```ts
/// size(file: string): number | null
/// read(file: string, no: number): Uint8Array | null
/// commit(file: string, size: number, nos: number[], pages: Uint8Array[], truncateFrom: number | null): void
/// remove(file: string): void
/// ```
struct JsStore(JsValue);

// One thread, no atomics: a JavaScript value never crosses to another. The page store's trait
// asks for nothing on this target; the registry that holds it is a `Mutex` for the native tests'
// sake (`crate::vfs`).
unsafe impl Send for JsStore {}
unsafe impl Sync for JsStore {}

fn said(e: JsValue) -> String {
    e.as_string()
        .or_else(|| {
            Reflect::get(&e, &"message".into())
                .ok()
                .and_then(|m| m.as_string())
        })
        .unwrap_or_else(|| format!("{e:?}"))
}

impl JsStore {
    fn method(&self, name: &str) -> Result<Function, String> {
        Reflect::get(&self.0, &name.into())
            .map_err(said)?
            .dyn_into::<Function>()
            .map_err(|_| format!("the page store has no `{name}`"))
    }
}

impl PageStore for JsStore {
    fn size(&self, file: &str) -> Result<Option<u64>, String> {
        let got = self
            .method("size")?
            .call1(&self.0, &file.into())
            .map_err(said)?;
        Ok(got.as_f64().map(|n| n as u64))
    }

    fn read(&self, file: &str, no: u64) -> Result<Option<Vec<u8>>, String> {
        let got = self
            .method("read")?
            .call2(&self.0, &file.into(), &(no as f64).into())
            .map_err(said)?;
        if got.is_null() || got.is_undefined() {
            return Ok(None);
        }
        Ok(Some(Uint8Array::new(&got).to_vec()))
    }

    fn commit(
        &self,
        file: &str,
        size: u64,
        pages: &[(u64, Vec<u8>)],
        truncate_from: Option<u64>,
    ) -> Result<(), String> {
        let nos = Array::new();
        let datas = Array::new();
        for (no, data) in pages {
            nos.push(&(*no as f64).into());
            datas.push(&Uint8Array::from(data.as_slice()));
        }
        let args = Array::of5(
            &file.into(),
            &(size as f64).into(),
            &nos,
            &datas,
            &truncate_from.map_or(JsValue::NULL, |t| (t as f64).into()),
        );
        self.method("commit")?
            .apply(&self.0, &args)
            .map(|_| ())
            .map_err(said)
    }

    fn remove(&self, file: &str) -> Result<(), String> {
        self.method("remove")?
            .call1(&self.0, &file.into())
            .map(|_| ())
            .map_err(said)
    }
}

fn json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|e| {
        serde_json::json!({ "err": format!("an answer could not be written: {e}") }).to_string()
    })
}

fn answer<T: Serialize>(result: Result<T, String>) -> String {
    match result {
        Ok(value) => json(&serde_json::json!({ "ok": value })),
        Err(e) => json(&serde_json::json!({ "err": e })),
    }
}

/// An add's answer: `{"ok"}`, `{"refused"}` for the reader, or `{"err"}`.
fn answer_add<T: Serialize>(result: Result<T, Refusal>) -> String {
    match result {
        Ok(value) => json(&serde_json::json!({ "ok": value })),
        Err(Refusal::Said(why)) => json(&serde_json::json!({ "refused": why })),
        Err(Refusal::Failed(e)) => json(&serde_json::json!({ "err": e })),
    }
}

const CLOSED: &str = "The bot device is closed.";

/// **One Durable Object's engine.** Built by [`Bot::open`] in the object's constructor and
/// [`Bot::close`]d before `deleteAll()`.
#[wasm_bindgen]
pub struct Bot {
    device: Rc<RefCell<Option<Rc<Device>>>>,
}

impl Bot {
    fn device(&self) -> Option<Rc<Device>> {
        self.device.borrow().clone()
    }
}

#[wasm_bindgen]
impl Bot {
    /// `Bot.open(store, kek, object, options)` — mount `store` under `object` (the Durable
    /// Object's id), sealed under `kek` (`BOT_KEK`, base64url), and open the engine. `options`
    /// is JSON (`{"relayUrl"?, "scryfallUrl"?}`; `"{}"` in production). Throws one sentence when
    /// the key is not a key or the databases will not open.
    pub fn open(store: JsValue, kek: &str, object: &str, options: &str) -> Result<Bot, JsValue> {
        let kek = device::kek(kek).map_err(|e| JsValue::from_str(&e))?;
        let options: Options = serde_json::from_str(options)
            .map_err(|e| JsValue::from_str(&format!("the device's options are not JSON: {e}")))?;
        let store: Arc<dyn PageStore> = Arc::new(JsStore(store));
        let device =
            Device::open(object, store, &kek, options).map_err(|e| JsValue::from_str(&e))?;
        Ok(Bot {
            device: Rc::new(RefCell::new(Some(Rc::new(device)))),
        })
    }

    /// `enroll(invite, capability): Promise<string>` — the front's `Enrolled | EnrollRefused`.
    pub fn enroll(&self, invite: String, capability: String) -> js_sys::Promise {
        let device = self.device();
        wasm_bindgen_futures::future_to_promise(async move {
            let Some(device) = device else {
                return Ok(json(&device::Enrolled::Refused {
                    ok: false,
                    code: "pairing_failed",
                    error: CLOSED.to_owned(),
                })
                .into());
            };
            Ok(json(&device.enroll(&invite, &capability).await).into())
        })
    }

    /// `advance(): Promise<string>` — what an alarm runs: `{nextInMs, purge, did}`.
    pub fn advance(&self) -> js_sys::Promise {
        let device = self.device();
        wasm_bindgen_futures::future_to_promise(async move {
            let Some(device) = device else {
                return Ok(json(&device::Advanced::default()).into());
            };
            let now = grimoire_core::platform::clock::now_ms();
            Ok(json(&device.advance(now).await).into())
        })
    }

    /// `status(): string` — the front's `BotStatus`.
    pub fn status(&self) -> String {
        match self.device() {
            Some(device) => json(&device.status()),
            None => json(&device::Status {
                enrolled: false,
                device_id: None,
                paired: false,
                last_pull_at: None,
                error: Some(CLOSED.to_owned()),
            }),
        }
    }

    /// `collection_by_name(name): string` — `{"ok": Holding | null}` or `{"err"}`.
    pub fn collection_by_name(&self, name: &str) -> String {
        answer(
            self.device()
                .ok_or_else(|| CLOSED.to_owned())
                .and_then(|d| d.collection_by_name(name)),
        )
    }

    /// `wishlist_by_name(name): string` — `{"ok": Holding | null}` or `{"err"}`.
    pub fn wishlist_by_name(&self, name: &str) -> String {
        answer(
            self.device()
                .ok_or_else(|| CLOSED.to_owned())
                .and_then(|d| d.wishlist_by_name(name)),
        )
    }

    /// `names(kind, prefix, limit): string` — `{"ok": [{name, value}]}`; `kind` is `collection`,
    /// `wishlist` or `deck`.
    pub fn names(&self, kind: &str, prefix: &str, limit: u32) -> String {
        answer(
            self.device()
                .ok_or_else(|| CLOSED.to_owned())
                .and_then(|d| d.names(kind, prefix, limit as usize)),
        )
    }

    /// `decks(prefix): string` — `{"ok": [DeckSummary]}`.
    pub fn decks(&self, prefix: &str) -> String {
        answer(
            self.device()
                .ok_or_else(|| CLOSED.to_owned())
                .and_then(|d| d.decks(prefix)),
        )
    }

    /// `deck_cards(uid): string` — `{"ok": {deck, cards} | null}`; `cards` are `TransferCard`s.
    pub fn deck_cards(&self, uid: &str) -> String {
        answer(
            self.device()
                .ok_or_else(|| CLOSED.to_owned())
                .and_then(|d| d.deck_cards(uid)),
        )
    }

    /// `folders(prefix, limit): string` — `{"ok": [{name, value}]}`: the collection's user
    /// folders, by path, the value each one's uid.
    pub fn folders(&self, prefix: &str, limit: u32) -> String {
        answer(
            self.device()
                .ok_or_else(|| CLOSED.to_owned())
                .and_then(|d| d.folders(prefix, limit as usize)),
        )
    }

    /// `target(table, folder): string` — `{"ok": {uid, path}}`, `{"refused"}` or `{"err"}`:
    /// where an add to `collection` or `wishlist` goes, `folder` named or `""` for the default.
    pub fn target(&self, table: &str, folder: &str) -> String {
        let now = grimoire_core::platform::clock::now_ms();
        answer_add(
            self.device()
                .ok_or_else(|| Refusal::Failed(CLOSED.to_owned()))
                .and_then(|d| d.target(table, folder, now)),
        )
    }

    /// `add(add): string` — `{"ok": uid}`, `{"refused"}` or `{"err"}`: a reader's Confirm, the
    /// `integration::add::Add` as JSON. No network.
    pub fn add(&self, add: &str) -> String {
        let now = grimoire_core::platform::clock::now_ms();
        answer_add(
            self.device()
                .ok_or_else(|| Refusal::Failed(CLOSED.to_owned()))
                .and_then(|d| d.add(add, now)),
        )
    }

    /// `close(): void` — let go of the engine. The connection closes when the last operation
    /// holding it ends; the script revokes its page store before `deleteAll()`, so a straggler
    /// writes nothing back.
    pub fn close(&self) {
        self.device.borrow_mut().take();
    }
}
