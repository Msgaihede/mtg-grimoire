//! **The browser's card scanner** — the light app's phase 7, step 7.5.
//!
//! `card-scanner` compiled to WASM and loaded by a dedicated Worker of its own, beside the
//! engine's and never inside it (`docs/reference/light-app.md` §11.2 has why). The page hands
//! it bytes and gets JSON back:
//!
//! - **`load(bundle?, labels?, detection?, recognition?)`** — build the session, replacing any
//!   there was, from the reference bundle, the labels the engine encoded
//!   (`card_scanner::labels`) and the two OCR models. Answers what loaded, as facts;
//! - **`frame(jpeg, detail?, options)`** — one frame through the session, and its verdict;
//! - **`reset()`**, **`set_filters(filters)`** — the session's own two;
//! - **`memory_bytes()`** — the module's linear memory, which only ever grows;
//! - **`start()`** — the clock and the panic hook. Run as the module is instantiated; calling
//!   it again changes nothing.
//!
//! Built by `node scripts/build-wasm.mjs` into `dist-wasm/scanner/` (`wasm-bindgen --target
//! web`: `grimoire_scan.js` and `grimoire_scan_bg.wasm`), with `simd128`.
//!
//! | Module | Compiled for | Holds |
//! | --- | --- | --- |
//! | [`scanner`] | every target | The session, what a load reports, the filters a reload carries, and the JSON every export answers |
//! | `glue` | the browser only | The `#[wasm_bindgen]` shell, the `thread_local`, `performance.now()` and the console |
//!
//! **Every string an export answers is `{"ok": …}` or `{"err": "<sentence>"}`** — the web
//! host's envelope — and none may throw for anything it is handed: bytes that are not a bundle,
//! labels cut short, a model that is not a model, a JPEG that is not one and options that are
//! not JSON are each an answer. **A trap is only ever a real panic**, and a panic here ends
//! the instance: the module is built with `panic = "abort"`, where the crate's own guard
//! guards nothing (`docs/reference/card-scanner.md` §11). The Worker is thrown away and a new
//! one loaded; that is the whole of the containment, and the reason this module is not the
//! one that holds the database.
//!
//! **Rust supplies facts.** A load says what loaded and what the crate said about what did
//! not; a sentence about a download, a file or a browser is the page's to write.

pub mod scanner;

#[cfg(target_family = "wasm")]
mod glue;
