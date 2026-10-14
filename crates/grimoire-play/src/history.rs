//! Undo and redo for both boards: the game as it was before each of the reader's actions, to go
//! back to, and the game as it was before each undo, to come forward to again (issue #1022).
//!
//! **A moment is a whole game, not an inverse.** `GameState` is persistent (`im`), so a clone is
//! a handful of reference counts — the same fact the checkpoint that makes a refusal change
//! nothing relies on. Restoring a moment is therefore exact for every action a board has, the
//! rules' and the sandbox's alike, where an inverse per action would be a second rules engine.
//! Redo restores the moment too rather than replaying the action, so the AI's dice cannot make a
//! redone turn come out differently from the one that was undone.
//!
//! **A new action ends the redo trail**, as every editor's does: the game it led to is no longer
//! the one on the board's future.

use std::collections::VecDeque;

/// How many actions back a board can go. Mirrored by `UNDO_LIMIT` in
/// `packages/ui/features/playtesting/undo.ts`, which keeps the log for as many.
pub(crate) const UNDO_LIMIT: usize = 100;

pub(crate) struct History<T> {
    /// Oldest first; the last is the moment before the latest action.
    past: VecDeque<T>,
    /// The latest undone first-out: the last is the one redo comes forward to.
    future: Vec<T>,
}

impl<T> Default for History<T> {
    fn default() -> Self {
        History {
            past: VecDeque::new(),
            future: Vec::new(),
        }
    }
}

impl<T> History<T> {
    /// An action has been taken from `before`: it can be undone, and nothing can be redone.
    pub(crate) fn record(&mut self, before: T) {
        if self.past.len() == UNDO_LIMIT {
            self.past.pop_front();
        }
        self.past.push_back(before);
        self.future.clear();
    }

    /// The moment to go back to from `now`, which redo will come forward to again.
    pub(crate) fn undo(&mut self, now: T) -> Option<T> {
        let then = self.past.pop_back()?;
        self.future.push(now);
        Some(then)
    }

    /// The moment to come forward to from `now`, which undo will go back to again.
    pub(crate) fn redo(&mut self, now: T) -> Option<T> {
        let then = self.future.pop()?;
        self.past.push_back(now);
        Some(then)
    }

    pub(crate) fn can_undo(&self) -> bool {
        !self.past.is_empty()
    }

    pub(crate) fn can_redo(&self) -> bool {
        !self.future.is_empty()
    }
}

/// What a board says when there is nothing to go back or forward to.
pub(crate) const NOTHING_TO_UNDO: &str = "There is nothing to undo.";
pub(crate) const NOTHING_TO_REDO: &str = "There is nothing to redo.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undo_and_redo_walk_the_moments_in_order() {
        let mut h = History::default();
        h.record(0);
        h.record(1);
        // The board is at 2.
        assert_eq!(h.undo(2), Some(1));
        assert_eq!(h.undo(1), Some(0));
        assert_eq!(h.undo(0), None);
        assert_eq!(h.redo(0), Some(1));
        assert_eq!(h.redo(1), Some(2));
        assert_eq!(h.redo(2), None);
    }

    #[test]
    fn a_new_action_ends_the_redo_trail() {
        let mut h = History::default();
        h.record(0);
        assert_eq!(h.undo(1), Some(0));
        assert!(h.can_redo());
        h.record(0);
        assert!(!h.can_redo());
        assert!(h.can_undo());
    }

    #[test]
    fn the_oldest_moment_goes_first_past_the_limit() {
        let mut h = History::default();
        for i in 0..UNDO_LIMIT + 5 {
            h.record(i);
        }
        let mut now = UNDO_LIMIT + 5;
        let mut back = 0;
        while let Some(then) = h.undo(now) {
            now = then;
            back += 1;
        }
        assert_eq!(back, UNDO_LIMIT);
        assert_eq!(now, 5);
    }
}
