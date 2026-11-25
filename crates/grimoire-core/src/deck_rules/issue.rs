//! `types.ts`' `ValidationIssue`: one finding, in the shape the TypeScript answers it.

use serde::Serialize;

/// `error` breaks the format's rules; `warning` is a fact worth a look (an orphaned row, a
/// legality this app cannot read). Nothing here ever blocks a save.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

/// One finding.
///
/// **Serialised exactly as the TypeScript's object is**, field for field and absence for
/// absence: `cardIds` is absent on a finding about the deck itself (its size, its sideboard), and
/// `rowIds` is set only by [`super::engine::validate_for_marks`]. The goldens compare the two
/// shapes as JSON, so a `null` where the TypeScript leaves the key out is a failure.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub severity: Severity,
    /// The stable machine handle — `types.ts` lists the whole vocabulary, by the module that
    /// emits each.
    pub code: &'static str,
    /// The whole story in one sentence, card names and numbers included.
    pub message: String,
    /// `deck_cards.card_id` values: the printings the sentence is about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_ids: Option<Vec<String>>,
    /// `deck_cards.id` values: the rows a card mark files this finding under.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_ids: Option<Vec<i64>>,
}

impl ValidationIssue {
    /// An error, about the given printings or (with `None`) about the deck itself.
    pub fn error(
        code: &'static str,
        message: impl Into<String>,
        card_ids: Option<Vec<String>>,
    ) -> Self {
        Self {
            severity: Severity::Error,
            code,
            message: message.into(),
            card_ids,
            row_ids: None,
        }
    }

    /// A warning, about the given printings or (with `None`) about the deck itself.
    pub fn warning(
        code: &'static str,
        message: impl Into<String>,
        card_ids: Option<Vec<String>>,
    ) -> Self {
        Self {
            severity: Severity::Warning,
            code,
            message: message.into(),
            card_ids,
            row_ids: None,
        }
    }
}
