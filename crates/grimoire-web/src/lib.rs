//! **The light app's web host** — the light-app spec §6, phase 5.
//!
//! `grimoire-core` compiled to WASM and loaded by one dedicated Worker, with the page talking
//! to it through the `Core` seam (`src/lib/core`). It holds almost nothing of its own:
//!
//! - **`open(directory)`** — the OPFS pool, the two databases on one connection, the state;
//! - **`call(name, args, body?)`** — every command, forwarded to `grimoire_core::dispatch`, so
//!   a command the core's table does not have is refused here in the table's own words;
//! - **`listen(handler)`** — the engine's events, handed to the Worker's script.
//!
//! Built with `node scripts/build-wasm.mjs` into `dist-wasm/` (`wasm-bindgen --target web`:
//! `grimoire_web.js` and `grimoire_web_bg.wasm`).
//!
//! | Module | Compiled for | Holds |
//! | --- | --- | --- |
//! | [`wire`] | every target | The JSON each export answers, and the one-tab guard's string match |
//! | [`host`] | every target | What the exports decide: the start, a call's refusals, the one `open` |
//! | `glue` | the browser only | The `#[wasm_bindgen]` shell, the pool's install, the `thread_local`s |
//!
//! **Only `glue` is gated to the target**, so `cargo test`, `clippy --workspace` and
//! `cargo fmt -p grimoire-web` reach everything with a decision in it on a desktop. A module
//! gated to the browser is invisible to `cargo test`, and a typo in a wire string there is a
//! silent `undefined` in a page — the first web host's rule, kept.
//!
//! **What it does not do yet**: start a download (a browser has no temp file for one to land
//! in), keep a card image, or notice a corpus the browser evicted. Those are the web phase's
//! next steps; `grimoire_core::launch`'s `unreadable_corpus_seam` is where the last one is
//! written down.
//!
//! ⚠️ **Compiling is not running.** This crate's tests run its decisions natively, on a thread
//! standing in for a Worker (`grimoire_core::platform::alone`); the module itself is run by
//! the `web` job, in a headless browser, and by nothing on a desktop.

pub mod host;
pub mod wire;

#[cfg(target_family = "wasm")]
mod glue;
