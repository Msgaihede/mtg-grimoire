//! A playtest: the reader's deck against another, the opponent's seat played by phase.rs's AI.
//! `session.rs` is the game, `view.rs` the wire; `docs/reference/playtest.md` has the design.

pub mod session;
pub mod view;

pub use session::Playtest;
pub use view::{Difficulty, PlaytestAction, PlaytestStep, PlaytestView};

#[cfg(test)]
mod tests;
