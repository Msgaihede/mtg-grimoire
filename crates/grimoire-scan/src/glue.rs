//! **The browser**: the eight `#[wasm_bindgen]` exports a dedicated Worker imports, and the one
//! `thread_local` that is this module's whole memory.
//!
//! Compiled for `wasm32-unknown-unknown` and nowhere else (`lib.rs` gates the module), which
//! is why there is so little here: everything these exports *answer* is built in
//! [`crate::scanner`], where a desktop's `cargo test` reaches it. What is left is what only a
//! browser can do — read `performance.now()`, write to a console, say how large the module's
//! memory has grown.
//!
//! **Every export is synchronous, and none may throw.** A frame is one call that returns its
//! verdict; there is nothing to await, because the crate runs a frame where it stands
//! (`card_scanner::host`).
//!
//! **After a panic the instance is finished, and says so rather than trapping twice.** The
//! module is built with `panic = "abort"`: a panic inside a frame is a trap out of that call,
//! after the hook below has written its sentence to the console, and nothing runs the
//! destructors on the way — so the scanner's `RefCell` is left borrowed for good. Every later
//! call finds it so and answers `{"err": …}` ([`scanner::PANICKED`]) instead of a second trap.
//! That is a courtesy, not a recovery: the heap a panic left behind is nobody's to trust, and
//! the Worker's script ends the Worker on the first trap.

use std::cell::RefCell;

use wasm_bindgen::prelude::*;

use crate::scanner::{self, Scanner};

#[wasm_bindgen]
extern "C" {
    /// `performance.now()`, off the global scope: the host is a Worker, which has no
    /// `window`. `catch`, because a host with no such object would otherwise throw, and a
    /// throw here is a trap.
    #[wasm_bindgen(js_namespace = performance, js_name = now, catch)]
    fn performance_now() -> Result<f64, JsValue>;

    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(message: &str);
}

thread_local! {
    /// The scanner, for the life of this Worker. A `thread_local` and not a `static`: a
    /// session is not `Sync`, and there is exactly one thread here.
    static SCANNER: RefCell<Option<Scanner>> = const { RefCell::new(None) };
}

/// One piece of work on the scanner, which is made on first use — or [`scanner::PANICKED`]
/// as an `err`, when an earlier call never gave it back.
fn with(work: impl FnOnce(&mut Scanner) -> String) -> String {
    SCANNER.with(|slot| match slot.try_borrow_mut() {
        Ok(mut held) => work(held.get_or_insert_with(Scanner::new)),
        Err(_) => scanner::err(scanner::PANICKED),
    })
}

fn now_ms() -> f64 {
    performance_now().unwrap_or(0.0)
}

/// `start(): void` — hand the crate `performance.now()` as its clock, and install a panic
/// hook that writes the panic's sentence and line to the console before the trap that follows
/// it. The default hook writes to a stderr this target does not have, so without one a panic
/// is `RuntimeError: unreachable` and nothing else.
///
/// **Run by the glue as the module is instantiated, before any export can be called** — and
/// an export all the same, so a script may say it. Saying it again changes nothing: the crate
/// keeps the first clock it is given, and the hook is the same hook.
#[wasm_bindgen(start)]
pub fn start() {
    std::panic::set_hook(Box::new(|info| {
        console_error(&format!("the card scanner panicked: {info}"))
    }));
    card_scanner::host::set_clock(now_ms);
}

/// `load(labels?): string` — build the session from the labels the engine encoded, replacing
/// any there was. Answers `{"ok": <facts>}` ([`scanner::Loaded`]):
///
/// ```text
/// {"ok":{"labels":118475,"unapplied_filters":null}}
/// ```
///
/// Taken, not borrowed: the glue has already copied it into this module's memory, and
/// `Scanner::load` lets it go as soon as it has been read.
#[wasm_bindgen]
pub fn load(labels: Option<Vec<u8>>) -> String {
    with(|scanner| scanner.load_json(labels))
}

/// `frame(jpeg): string` — one frame through the session. Answers `{"ok": <Verdict>}`. See
/// [`Scanner::frame`].
#[wasm_bindgen]
pub fn frame(jpeg: &[u8]) -> String {
    with(|scanner| scanner.frame(jpeg))
}

/// `load_neural(detector, embedder, gallery, meta): string | undefined` — give the session the
/// Neural scanner's four files, as the page fetched them from the app's origin. Answers nothing, or
/// the crate's sentence when they would not load ([`Scanner::load_neural`]) — **never a throw**,
/// and not the envelope: there is no value to carry, only a refusal. After a panic it answers
/// [`scanner::PANICKED`], as every string export does.
///
/// Taken, not borrowed, for `load`'s reason: the glue has copied each into this module's
/// memory, and the recogniser keeps those buffers rather than copy them a second time.
#[wasm_bindgen]
pub fn load_neural(
    detector: Vec<u8>,
    embedder: Vec<u8>,
    gallery: Vec<u8>,
    meta: Vec<u8>,
) -> Option<String> {
    SCANNER.with(|slot| match slot.try_borrow_mut() {
        Ok(mut held) => held
            .get_or_insert_with(Scanner::new)
            .load_neural(detector, embedder, gallery, meta),
        Err(_) => Some(scanner::PANICKED.to_owned()),
    })
}

/// `load_neural_evidence(symbol_net, band_net, symbols, bands): string | undefined` — give the
/// session the Neural scanner's printing evidence, which the page fetches once `load_neural` has
/// answered. Answers nothing, or the crate's sentence ([`Scanner::load_neural_evidence`]) —
/// `load_neural`'s shape, for its reason, and [`scanner::PANICKED`] after a panic.
#[wasm_bindgen]
pub fn load_neural_evidence(
    symbol_net: Vec<u8>,
    band_net: Vec<u8>,
    symbols: Vec<u8>,
    bands: Vec<u8>,
) -> Option<String> {
    SCANNER.with(|slot| match slot.try_borrow_mut() {
        Ok(mut held) => held
            .get_or_insert_with(Scanner::new)
            .load_neural_evidence(symbol_net, band_net, symbols, bands),
        Err(_) => Some(scanner::PANICKED.to_owned()),
    })
}

/// `reset(): string` — forget the card in front of the lens. `{"ok":null}`.
#[wasm_bindgen]
pub fn reset() -> String {
    with(Scanner::reset)
}

/// `set_filters(filters): string` — `filters` is a `ScanFilters` as JSON. `{"ok":null}`, or
/// `{"err": …}` in the crate's own words. See [`Scanner::set_filters`].
#[wasm_bindgen]
pub fn set_filters(filters: &str) -> String {
    with(|scanner| scanner.set_filters(filters))
}

/// `memory_bytes(): number` — the module's linear memory, in bytes. It only ever grows, so it
/// is a high-water mark, and what the page gets back by ending the Worker.
#[wasm_bindgen]
pub fn memory_bytes() -> f64 {
    core::arch::wasm32::memory_size(0) as f64 * 65_536.0
}
