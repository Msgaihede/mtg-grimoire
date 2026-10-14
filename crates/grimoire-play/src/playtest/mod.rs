//! A playtest: the reader's deck against one other or three, each opponent's seat played by
//! phase.rs's AI.
//! `session.rs` is the game, `view.rs` the wire; `docs/reference/playtest.md` has the design.

pub mod session;
pub mod view;

pub use session::{OpponentDeck, Playtest};
pub use view::{Difficulty, PlaytestAction, PlaytestPlayer, PlaytestStep, PlaytestView};

#[cfg(test)]
mod tests;
