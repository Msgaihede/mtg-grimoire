//! The game: the reader's deck against the goldfish — an opponent that does nothing and never
//! loses — or against one other deck or three, each opponent's seat played by phase.rs's AI.
//! Goldfishing is this game with the goldfish across the table and the sandbox on.
//! `session.rs` is the game, `view.rs` the wire; `docs/reference/playtest.md` has the design.

pub mod session;
pub mod view;

pub use session::{OpponentDeck, Playtest};
pub use view::{Difficulty, PlaytestAction, PlaytestPlayer, PlaytestStep, PlaytestView};

#[cfg(test)]
mod goldfish_tests;
#[cfg(test)]
mod tests;
