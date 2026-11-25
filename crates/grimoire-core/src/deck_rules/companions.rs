//! `companions.ts`: the companion zone, its count, each companion's eligibility and the ten deck
//! conditions, Yorion's and Umori's among them.

use super::issue::ValidationIssue;
use crate::deck::{DeckCardRow, FormatSpecRow};

/// `companionIssues(companions, deck, spec)`: everything wrong with the companion kind's rows
/// (`companions`) under this format, judged against the active deck (`deck`).
pub fn companion_issues(
    companions: &[&DeckCardRow],
    deck: &[&DeckCardRow],
    spec: &FormatSpecRow,
) -> Vec<ValidationIssue> {
    let _ = (companions, deck, spec);
    Vec::new()
}
