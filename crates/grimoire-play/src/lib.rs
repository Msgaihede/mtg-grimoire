//! Games played on a deck, over phase.rs's rules engine: the goldfish board (`session`, `view`)
//! and a playtest against phase's AI (`playtest`). The `Cargo.toml` says what this crate is and
//! why only the desktop links it.

pub mod cards;
pub mod playtest;
pub mod session;
pub mod view;

pub use cards::{CardFacts, FaceFacts};
pub use playtest::{Difficulty, Playtest, PlaytestAction, PlaytestStep, PlaytestView};
pub use session::Goldfish;
pub use view::{GoldfishAction, GoldfishStep, GoldfishView};

/// The stack every call into the engine runs on. phase's own `.cargo/config.toml` sets
/// `RUST_MIN_STACK` to 16 MiB because its recursion overflowed at 1 MiB; a Tauri command runs on
/// a tokio worker with 2 MiB, so a call made there directly is an overflow waiting for the card
/// that recurses deepest — an abort, not a panic, with the whole app.
pub const ENGINE_STACK: usize = 16 * 1024 * 1024;

/// Run `work` on a thread of its own with [`ENGINE_STACK`], and wait for it. One thread per call:
/// a goldfish action is a reader's click, and a spawn is tens of microseconds against the engine's
/// milliseconds. A panic in the engine is caught here and is one sentence, never the app.
pub fn on_engine_stack<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    std::thread::Builder::new()
        .name("rules-engine".into())
        .stack_size(ENGINE_STACK)
        .spawn(work)
        .map_err(|e| format!("The rules engine could not start: {e}"))?
        .join()
        .map_err(|_| "The rules engine failed on that action. Start a new game.".to_string())
}

#[cfg(test)]
mod tests;
