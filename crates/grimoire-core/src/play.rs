//! The facts a game needs about a deck's cards — what the goldfish board deals from.
//!
//! **A read and nothing else.** The game itself is `crates/grimoire-play`, over phase.rs's rules
//! engine, and only the desktop host links it (`docs/reference/goldfish.md` has why); this module
//! is the half that is SQLite, so it is the core's like every other read of `deck_cards`.
//!
//! **What [`crate::deck::get_deck`] answers, plus three facts it does not carry**, read from the
//! printing's Scryfall blob (`cards.raw`, opened by [`crate::card_row::raw_json`]): its `keywords` (Scryfall's casing, which phase's oracle parser uses to
//! tell a keyword-only line like `Flying` from rules text), and `loyalty` and `defense`, which no
//! deck view draws. Read per printing, as the rest of a deck row is.
//!
//! **Which cards are in the game is the deck's own rule** (`features/decks/CLAUDE.md` §2): an
//! inactive pile is not in the deck, so it is not in the game; the sideboard, the maybeboard and
//! a companion start outside it (CR 702.139a — a companion is revealed from outside the game,
//! which a goldfish board does not model yet); the commander pile starts in the command zone.
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::deck::{get_deck, DeckCardRow};
use crate::sorting::Marketplace;

/// One printing of the deck, with its count. The same card in two printings is two rows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayCard {
    pub card_id: String,
    pub name: String,
    pub quantity: u32,
    pub commander: bool,
    pub oracle_id: Option<String>,
    pub mana_cost: Option<String>,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub loyalty: Option<String>,
    pub defense: Option<String>,
    pub cmc: Option<f64>,
    pub layout: Option<String>,
    /// Single letters, `["G", "W"]` — the row stores them run together (`"GW"`).
    pub colors: Vec<String>,
    pub color_identity: Vec<String>,
    pub keywords: Vec<String>,
    /// Scryfall's `card_faces`, verbatim, for a card with several.
    pub faces: Option<String>,
}

/// The categories whose cards start the game: the main deck and the commander.
const IN_THE_GAME: &[&str] = &["main", "commander"];

/// What a deck that cannot be played says.
pub const NO_DECK: &str = "That deck is gone.";

/// The deck's cards as a game deals them. `variant` is `live` or `theory`, as the editor's.
pub fn deck_cards(conn: &Connection, deck_id: i64, variant: &str) -> Result<Vec<PlayCard>, String> {
    let detail = get_deck(conn, deck_id, variant, Marketplace::from_opt(None))?
        .ok_or_else(|| NO_DECK.to_string())?;
    // `raw` is a gzip BLOB on every row written since the first post-v3 sync, which SQLite's JSON
    // functions read as malformed JSONB — a hard error, not a NULL (`schema::json_raw` has the
    // record) — so the blob comes back whole and is opened here, by the one function that opens it.
    let mut raw = conn
        .prepare_cached("SELECT CAST(raw AS BLOB) FROM cards WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in detail.cards {
        if !row.category_active || !IN_THE_GAME.contains(&row.category_kind.as_str()) {
            continue;
        }
        if row.quantity <= 0 {
            continue;
        }
        let blob: Option<Vec<u8>> = raw
            .query_row([&row.card_id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        let json: serde_json::Value = blob
            .and_then(|b| crate::card_row::raw_json(&b))
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let keywords = json
            .get("keywords")
            .and_then(|k| serde_json::from_value::<Vec<String>>(k.clone()).ok())
            .unwrap_or_default();
        let loyalty = text_of(json.get("loyalty"));
        let defense = text_of(json.get("defense"));
        out.push(card(row, keywords, loyalty, defense));
    }
    Ok(out)
}

/// Scryfall writes loyalty and defense as strings (`"3"`, `"X"`); a number is read as one too
/// rather than dropped.
fn text_of(v: Option<&serde_json::Value>) -> Option<String> {
    match v? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn letters(s: Option<String>) -> Vec<String> {
    s.unwrap_or_default()
        .chars()
        .filter(char::is_ascii_alphabetic)
        .map(|c| c.to_string())
        .collect()
}

fn card(
    row: DeckCardRow,
    keywords: Vec<String>,
    loyalty: Option<String>,
    defense: Option<String>,
) -> PlayCard {
    PlayCard {
        commander: row.category_kind == "commander",
        quantity: u32::try_from(row.quantity).unwrap_or(0),
        card_id: row.card_id,
        name: row.name,
        oracle_id: row.oracle_id,
        mana_cost: row.mana_cost,
        type_line: row.type_line,
        oracle_text: row.oracle_text,
        power: row.power,
        toughness: row.toughness,
        loyalty,
        defense,
        cmc: row.cmc,
        layout: row.layout,
        colors: letters(row.colors),
        color_identity: letters(row.color_identity),
        keywords,
        faces: row.faces,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_are_single_letters() {
        assert_eq!(
            letters(Some("GW".into())),
            vec!["G".to_string(), "W".to_string()]
        );
        assert!(letters(None).is_empty());
    }
}
