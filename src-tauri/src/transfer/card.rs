//! The one card shape both halves of a transfer speak — Rust's copy of
//! `src/features/transfer/TransferCard.ts`.
//!
//! **`null` means this surface does not have this fact, never "empty".** That distinction is
//! what `availableFields` reads to decide a checkbox does not exist: a deck has no condition,
//! so a deck's rows carry `condition: None` and the Condition box never draws — rather than
//! drawing over a column of blanks. Ported here field for field, and the nullability is part
//! of the port: an `Option` collapsed to a plain value on this side would be a fact this half
//! claims every surface has.
//!
//! **Nothing here is a constructor.** TypeScript's `fromDeckCard`/`fromCollectionRow`/
//! `fromWishRow` build these from the three row types and stay TypeScript's — Rust supplies
//! facts, TS draws conclusions, and this struct exists to be *read* from the shared corpus and
//! rendered, never to be assembled from a database row.

use super::Surface;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

/// A card on its way out of the app, on any of the three surfaces.
///
/// `deny_unknown_fields` is the fence this whole module is built around: the corpus is written
/// by TypeScript, so a field **added** to `TransferCard.ts` and not to this struct is a refused
/// deserialisation here rather than a column quietly absent from every mirrored file.
///
/// **It is one-directional, and the other direction is worth knowing rather than assuming.**
/// serde reads a missing `Option<T>` as `None` — the field is not required whatever this
/// struct says — so a field TypeScript *deletes* loads here perfectly happily, every row
/// carrying `None` for it. Nothing about that is red. What catches it is the golden files: a
/// field that stopped being written stops appearing in them, which is a byte difference in
/// every mirrored file that used to carry it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Card {
    pub name: String,
    pub quantity: i64,
    pub set_code: Option<String>,
    pub collector_number: Option<String>,
    /// `DeckFinish` — `"foil"`, `"etched"` or nothing.
    ///
    /// **A string rather than an enum, deliberately.** Every writer only ever compares it to
    /// those two words, and `'nonfoil'` is the collection's own spelling of the regular copy
    /// that TypeScript already folds to `null` before a card reaches here — so an enum would
    /// buy a third spelling to keep in step and nothing else.
    pub finish: Option<String>,
    pub lang: Option<String>,
    pub category_name: Option<String>,
    /// `CategoryKind` — `main`, `side`, `commander`, `companion`, `maybe`.
    pub category_kind: Option<String>,
    pub category_active: Option<bool>,
    pub condition: Option<String>,
    pub tradelist_quantity: Option<i64>,
    pub purchase_price: Option<f64>,
    pub purchase_currency: Option<String>,
    pub acquired_at: Option<String>,
    pub acquisition_source: Option<String>,
    pub serial_number: Option<String>,
    pub grading: Option<String>,
    pub altered: Option<bool>,
    pub signed: Option<bool>,
    pub proxy: Option<bool>,
    pub misprint: Option<bool>,
    /// The collection's free-text `collection_entries.tags` — **not a deck label.**
    ///
    /// The two mean different things, which is worth saying here rather than leaving to
    /// whoever reads the CSV header: this one is a string the reader typed on a copy they own,
    /// and [`Card::label_name`] is a row of `deck_labels`. No surface has both —
    /// `SURFACE_FIELDS` gives this to the collection and the label to the deck — so the two
    /// checkboxes can never be drawn together and the two columns can never appear in one
    /// file. That was already true while the deck's column said `Tag` and this one said `Tags`;
    /// the rename is what makes it legible from the header row alone.
    pub tags: Option<String>,
    pub notes: Option<String>,
    pub set_name: Option<String>,
    pub rarity: Option<String>,
    pub type_line: Option<String>,
    pub unit_price: Option<f64>,
    /// The deck label this card wears — one row of `deck_labels`, by name. `None` on a surface
    /// with no labels and on a deck card wearing none.
    ///
    /// A name, because that is what a file can carry and what an import finds a row by.
    pub label_name: Option<String>,
    /// That label's colour, `#rrggbb`. A separate field from [`Card::label_name`] because only
    /// some formats can carry it separately — Archidekt's `^Keeper,#4aab08^` holds both in one
    /// group, a CSV spends a column on each.
    pub label_color: Option<String>,
    /// This printing's `legalities` blob, JSON, verbatim.
    ///
    /// **Not a field**: it is never written to a file and never draws a checkbox. It is what
    /// the Arena *row* filter reads, and all three surfaces answer it — `cards.legalities` is
    /// a fact about the printing, so a collection row carries it as readily as a deck card
    /// does.
    pub legalities: Option<String>,
}

/// The corpus's scenarios, by name.
///
/// A `BTreeMap` rather than a `HashMap` because a sweep over it writes files: iteration order
/// is what decides the order a failure is reported in, and a set of goldens compared in a
/// different order every run is a diff nobody can read twice.
pub type Scenarios = BTreeMap<String, Scenario>;

/// One named scenario — a surface and the cards on it.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub surface: Surface,
    pub cards: Vec<Card>,
}

/// The corpus file itself.
///
/// A root object rather than a bare map, so the file has somewhere to grow a sibling key
/// later without every scenario name having to stay distinct from it.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CorpusFile {
    pub scenarios: Scenarios,
}

/// Read the shared corpus, or panic saying why.
///
/// **A test helper, and it panics on purpose.** Its two failures — the file is not there, or
/// TypeScript changed a field — are both "this checkout is inconsistent with itself", which is
/// exactly what a suite should stop on rather than route around; a `Result` here would let a
/// caller fall back to an empty map and report a green sweep over nothing.
pub fn load_corpus(path: &Path) -> Scenarios {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "the shared corpus is not readable at {}: {e}. It is TypeScript's file — see \
             src/features/transfer/__golden__/corpus.json",
            path.display()
        )
    });
    let file: CorpusFile = serde_json::from_str(&text).unwrap_or_else(|e| {
        panic!(
            "the shared corpus at {} did not deserialise: {e}. A field TypeScript has and this \
             struct does not is what this reads like",
            path.display()
        )
    });
    file.scenarios
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The corpus is TypeScript's, and this is the one place the two card shapes meet.
    /// `deny_unknown_fields` is what makes a field added on that side a red build here
    /// rather than a column silently missing from every mirrored CSV.
    fn corpus_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/features/transfer/__golden__/corpus.json")
    }

    /// Every field `TransferCard.ts` declares, written out with a value apiece.
    ///
    /// Hand-written rather than lifted off the corpus, because the name check below has to
    /// hold on a day the corpus is mid-edit: a row this suite owns is the only one that is
    /// certainly complete, and a check made of the thing it is checking proves nothing.
    const EVERY_FIELD: &str = r##""name":"Bolt","quantity":1,"setCode":"2X2","collectorNumber":"117","finish":null,"lang":"en","categoryName":"Removal","categoryKind":"main","categoryActive":true,"condition":"NM","tradelistQuantity":2,"purchasePrice":1.25,"purchaseCurrency":"USD","acquiredAt":"2026-01-02","acquisitionSource":"trade","serialNumber":"7/500","grading":"PSA 10","altered":false,"signed":true,"proxy":false,"misprint":false,"tags":"burn, staple","notes":"a note","setName":"Double Masters 2022","rarity":"uncommon","typeLine":"Instant","unitPrice":2.5,"labelName":"Cut candidate","labelColor":"#4aab08","legalities":"{}""##;

    /// Wrap one card body in the smallest corpus that holds it.
    fn corpus_with(card_body: &str) -> String {
        let head = r#"{"scenarios":{"x":{"surface":"deck","cards":[{"#;
        let tail = r#"}]}}}"#;
        format!("{head}{card_body}{tail}")
    }

    #[test]
    fn every_scenario_in_the_shared_corpus_deserialises() {
        let scenarios = load_corpus(&corpus_path());
        assert!(
            scenarios.contains_key("deck") && scenarios.contains_key("collection"),
            "the corpus lost a scenario this suite depends on"
        );
        assert!(scenarios["empty"].cards.is_empty());
        let deck = &scenarios["deck"];
        assert_eq!(deck.surface, Surface::Deck);
        assert!(
            deck.cards.iter().any(|c| c.name.contains("//")),
            "the corpus must keep a split card name"
        );
    }

    #[test]
    fn a_field_typescript_has_and_rust_does_not_is_an_error() {
        let json = r#"{"scenarios":{"x":{"surface":"deck","cards":[
            {"name":"Bolt","quantity":1,"aFieldRustDoesNotKnow":true}]}}}"#;
        assert!(serde_json::from_str::<CorpusFile>(json).is_err());

        // The line above is the whole fence and it really is mutation-sensitive: measured with
        // `deny_unknown_fields` deleted, that short row **deserialises** — serde reads a
        // missing `Option<T>` as `None`, so the 28 absent fields cost it nothing and the
        // unknown one is the only thing refusing it.
        //
        // What follows is a different question the same corpus can answer: are the 30 names
        // this struct spells the 30 `TransferCard.ts` spells? A complete row must load, and
        // the same row plus one unknown key must be refused *by name* — which is what a Rust
        // field renamed on this side looks like from the outside.
        serde_json::from_str::<CorpusFile>(&corpus_with(EVERY_FIELD))
            .expect("the field list here is TransferCard.ts's, so a complete row must load");
        let extended = corpus_with(&format!(r#"{EVERY_FIELD},"aFieldRustDoesNotKnow":true"#));
        let err = serde_json::from_str::<CorpusFile>(&extended)
            .expect_err("an unknown field must be refused")
            .to_string();
        assert!(
            err.contains("unknown field"),
            "the corpus fence is gone — this refusal is about something else: {err}"
        );
    }
}
