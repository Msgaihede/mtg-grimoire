//! The scanner's review tray — the cards scanned and not yet added, which the home page's To
//! review widget counts.
//!
//! The tray is the row the page built, stored as the page sent it ([`grimoire_core::scanner::
//! stored_tray`]), so its words are read back here as the page reads them over `ipc`.

use async_graphql::{Context, Enum, Object, Result};
use grimoire_core::scanner::{
    stored_tray, ScannerTrayChoice as CoreChoice, ScannerTrayRow as CoreRow,
};

use crate::{invalidatedBy, read, roots};

/// A tray row's finish — a printing's, or `unknown` until the reader says.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(name = "ScannerTrayFinish", rename_items = "lowercase")]
pub enum ScannerTrayFinish {
    Nonfoil,
    Foil,
    Etched,
    Unknown,
}

impl ScannerTrayFinish {
    /// The stored word read back. **Any word but the three finishes is `unknown`**: the core
    /// stores a row's finish as the page sent it and checks nothing about it, and a finish this
    /// build cannot name is one the reader still has to settle.
    fn of(word: &str) -> Self {
        match word {
            "nonfoil" => ScannerTrayFinish::Nonfoil,
            "foil" => ScannerTrayFinish::Foil,
            "etched" => ScannerTrayFinish::Etched,
            _ => ScannerTrayFinish::Unknown,
        }
    }
}

/// One printing a tray row could be.
pub struct ScannerTrayChoice(pub CoreChoice);

#[Object(rename_fields = "camelCase")]
impl ScannerTrayChoice {
    async fn card_id(&self) -> &str {
        &self.0.card_id
    }
    async fn oracle_id(&self) -> Option<&str> {
        self.0.oracle_id.as_deref()
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    async fn set_code(&self) -> &str {
        &self.0.set_code
    }
    async fn collector_number(&self) -> &str {
        &self.0.collector_number
    }
    /// The finishes the printing exists in. Empty when unknown.
    async fn finishes(&self) -> Option<&[String]> {
        // The core writes a choice's list always, empty or not — as `ipc` hands it to the page.
        Some(&self.0.finishes)
    }
}

/// A card the scanner read and the reader has not yet added to the collection.
pub struct ScannerTrayRow(pub CoreRow);

#[Object(rename_fields = "camelCase")]
impl ScannerTrayRow {
    /// The page's own stable id for the row.
    async fn key(&self) -> &str {
        &self.0.key
    }
    async fn card_id(&self) -> &str {
        &self.0.card_id
    }
    async fn oracle_id(&self) -> Option<&str> {
        self.0.oracle_id.as_deref()
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    async fn set_code(&self) -> &str {
        &self.0.set_code
    }
    async fn collector_number(&self) -> &str {
        &self.0.collector_number
    }
    async fn finish(&self) -> ScannerTrayFinish {
        ScannerTrayFinish::of(&self.0.finish)
    }
    /// The finishes the row's printing exists in; null when unknown.
    async fn finishes(&self) -> Option<&[String]> {
        // The core leaves an empty list out of the row it hands `ipc`, so the page reads it as
        // absent.
        (!self.0.finishes.is_empty()).then_some(self.0.finishes.as_slice())
    }
    async fn quantity(&self) -> i64 {
        self.0.quantity
    }
    /// The printings the row could be, while it is still a choice to make; empty once settled.
    async fn choices(&self) -> Vec<ScannerTrayChoice> {
        self.0
            .choices
            .iter()
            .cloned()
            .map(ScannerTrayChoice)
            .collect()
    }
    /// When it was scanned, in Unix milliseconds.
    async fn added_at(&self) -> f64 {
        self.0.added_at as f64
    }
}

/// This domain's batch loaders, for one execution — none.
pub(crate) fn data(
    request: async_graphql::Request,
    _state: &std::sync::Arc<grimoire_core::state::State>,
) -> async_graphql::Request {
    request
}

#[derive(Default)]
pub struct ScannerQuery;

#[Object(rename_fields = "camelCase")]
impl ScannerQuery {
    /// The scanner's review tray, in the order it was scanned. An unreadable tray is an empty
    /// one.
    #[graphql(directive = invalidatedBy::apply(roots(&["scanner"])))]
    async fn scanner_tray(&self, ctx: &Context<'_>) -> Result<Option<Vec<ScannerTrayRow>>> {
        let rows = read(ctx, |c| Ok(stored_tray(c)))?;
        Ok(Some(rows.into_iter().map(ScannerTrayRow).collect()))
    }
}

#[cfg(test)]
mod tests {
    use grimoire_core::scanner::{store_tray, ScannerTrayChoice, ScannerTrayRow};
    use grimoire_core::state::fixtures::on_files;
    use serde_json::json;

    use crate::Graph;

    #[test]
    fn the_tray_answers_as_stored() {
        let state = on_files("graph-scanner", "http://127.0.0.1:1").0;
        let graph = Graph::new();
        let query = "{ scannerTray { key cardId oracleId finish finishes quantity addedAt
                         choices { cardId finishes } } }";
        let ask = || {
            let response = graph.run(&state, query, None, None, None);
            assert!(response.errors.is_empty(), "{:?}", response.errors);
            response.data.into_json().unwrap()["scannerTray"].clone()
        };
        assert_eq!(ask(), json!([]));

        let row = |key: &str, finish: &str, finishes: &[&str]| ScannerTrayRow {
            key: key.to_owned(),
            card_id: format!("c-{key}"),
            finish: finish.to_owned(),
            finishes: finishes.iter().map(|f| (*f).to_owned()).collect(),
            quantity: 2,
            added_at: 1_760_000_000_123,
            ..ScannerTrayRow::default()
        };
        let mut ambiguous = row("b", "unknown", &[]);
        ambiguous.choices = vec![ScannerTrayChoice {
            card_id: "c-x".to_owned(),
            ..ScannerTrayChoice::default()
        }];
        store_tray(
            &state.lock_db(),
            &[
                row("a", "foil", &["nonfoil", "foil"]),
                ambiguous,
                row("c", "shiny", &[]),
            ],
        )
        .unwrap();

        assert_eq!(
            ask(),
            json!([
                { "key": "a", "cardId": "c-a", "oracleId": null, "finish": "foil",
                  "finishes": ["nonfoil", "foil"], "quantity": 2, "addedAt": 1_760_000_000_123.0,
                  "choices": [] },
                { "key": "b", "cardId": "c-b", "oracleId": null, "finish": "unknown",
                  "finishes": null, "quantity": 2, "addedAt": 1_760_000_000_123.0,
                  "choices": [{ "cardId": "c-x", "finishes": [] }] },
                // A word no build writes reads as a finish still to settle.
                { "key": "c", "cardId": "c-c", "oracleId": null, "finish": "unknown",
                  "finishes": null, "quantity": 2, "addedAt": 1_760_000_000_123.0,
                  "choices": [] },
            ])
        );
    }
}
