//! **The browser's card scanner** — the light app's phase 7, step 7.5.
//!
//! `card-scanner` compiled to WASM and loaded by a dedicated Worker of its own, beside the
//! engine's and never inside it (`docs/reference/light-app.md` §11.2 has why). The page hands
//! it bytes and gets JSON back:
//!
//! - **`load(labels?)`** — build the session, replacing any there was, from the labels the
//!   engine encoded (`card_scanner::labels`). Answers how many attached, as a fact;
//! - **`load_neural(detector, embedder, gallery, meta)`** — the Neural scanner's four files
//!   (`crates/card-neural`), which the page fetches from the app's origin. Answers nothing, or
//!   the crate's sentence for files that would not load;
//! - **`load_neural_evidence(symbol_net, band_net, symbols, bands)`** — their printing evidence,
//!   fetched after them; the same answer;
//! - **`frame(jpeg)`** — one frame through the session, and its verdict;
//! - **`reset()`**, **`set_filters(filters)`** — the session's own two;
//! - **`memory_bytes()`** — the module's linear memory, which only ever grows;
//! - **`start()`** — the clock and the panic hook. Run as the module is instantiated; calling
//!   it again changes nothing.
//!
//! Built by `node scripts/build-wasm.ts` into `dist-wasm/scanner/` (`wasm-bindgen --target
//! web`: `grimoire_scan.js` and `grimoire_scan_bg.wasm`), with `simd128`.
//!
//! | Module | Compiled for | Holds |
//! | --- | --- | --- |
//! | [`scanner`] | every target | The session, what a load reports, the filters a reload carries, and the JSON every export answers |
//! | `glue` | the browser only | The `#[wasm_bindgen]` shell, the `thread_local`, `performance.now()` and the console |
//!
//! **Every string an export answers is `{"ok": …}` or `{"err": "<sentence>"}`** — the web
//! host's envelope; `load_neural` and `load_neural_evidence`, which have no value to carry,
//! answer a sentence or nothing — and none may throw for anything it is handed: labels cut
//! short, Neural files that are not them, a JPEG that is not one and filters that are not JSON
//! are each an answer. **A trap is only ever a real panic**, and a panic here ends
//! the instance: the module is built with `panic = "abort"`, where the crate's own guard
//! guards nothing (`docs/reference/card-scanner.md` §11). The Worker is thrown away and a new
//! one loaded; that is the whole of the containment, and the reason this module is not the
//! one that holds the database.
//!
//! **Rust supplies facts.** A load says how many labels attached, and the Neural loads what the
//! crate said about files that would not load; a sentence about a fetch, a file or a browser is
//! the page's to write.

pub mod scanner;

#[cfg(target_family = "wasm")]
mod glue;
