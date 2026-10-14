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
//!
//! **The deck's tokens are its own printings** ([`deck_tokens`], issue #991): one printing per
//! token the list keeps, the one its token wall draws, so a Treasure made on the board wears the
//! art the reader picked for this deck and not the printing the rules engine happens to know.
use std::collections::HashMap;

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

/// One token the deck's list keeps, in the printing a game draws it by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayToken {
    /// What a game matches the token by — phase's presets name the same Scryfall oracle id.
    pub oracle_id: String,
    pub name: String,
    /// The printing: the list's entry with the most copies (the first of a tie, in
    /// [`crate::deck_tokens::deck_token_rows`]' order), or the implicit entry's for a token the
    /// reader has not set.
    pub card_id: String,
    /// The names of the deck cards that make it. Empty for a token the reader added by hand.
    pub sources: Vec<String>,
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

/// The tokens `variant`'s list keeps, one per token, in the printing the deck's token wall draws
/// ([`PlayToken::card_id`]). Emblems and game helpers are not tokens a game creates, and are left
/// out.
pub fn deck_tokens(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
) -> Result<Vec<PlayToken>, String> {
    let rows =
        crate::deck_tokens::deck_token_rows(conn, deck_id, variant, Marketplace::from_opt(None))?;
    let mut out: Vec<PlayToken> = Vec::new();
    // Per token: its index in `out`, and the copies of the entry that holds it there (`None` for
    // the implicit entry, which any stored entry outranks).
    let mut held: HashMap<String, (usize, Option<i64>)> = HashMap::new();
    for row in rows {
        if row.layout == "emblem" || !is_token_line(row.type_line.as_deref()) {
            continue;
        }
        let copies = (!row.implicit).then_some(row.quantity);
        match held.get_mut(&row.oracle_id) {
            Some((at, best)) => {
                if copies > *best {
                    out[*at].card_id = row.card_id;
                    *best = copies;
                }
            }
            None => {
                held.insert(row.oracle_id.clone(), (out.len(), copies));
                out.push(PlayToken {
                    oracle_id: row.oracle_id,
                    name: row.name,
                    card_id: row.card_id,
                    sources: row.sources.into_iter().map(|s| s.name).collect(),
                });
            }
        }
    }
    Ok(out)
}

/// Whether a type line is a token's — any face of it beginning `Token`. A helper (`The Monarch`,
/// a `Card` type line) is not one.
fn is_token_line(type_line: Option<&str>) -> bool {
    type_line.is_some_and(|t| {
        t.split(" // ")
            .any(|face| face.trim_start().starts_with("Token"))
    })
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

    mod tokens {
        use super::super::deck_tokens;
        use crate::deck_tokens::fixtures::*;
        use rusqlite::{params, Connection};

        fn play(conn: &Connection, deck: i64, category: i64, card: &Card<'_>) {
            conn.execute(
                "INSERT INTO deck_cards
                     (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                      name, quantity, created_at, updated_at)
                 VALUES (?1,?2,'live',?3,?4,?5,'en',?6,1,unixepoch(),unixepoch())",
                params![
                    deck,
                    category,
                    card.id,
                    card.set_code,
                    card.collector_number,
                    card.name
                ],
            )
            .unwrap();
        }

        fn a_tithe_deck() -> (Connection, i64) {
            let conn = open();
            tithe().insert(&conn);
            treasure().insert(&conn);
            treasure_older().insert(&conn);
            let (deck, main, _) = deck_with_piles(&conn);
            play(&conn, deck, main, &tithe());
            (conn, deck)
        }

        #[test]
        fn a_token_the_reader_has_not_set_is_its_default_printing() {
            let (conn, deck) = a_tithe_deck();
            let out = deck_tokens(&conn, deck, "live").unwrap();
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].oracle_id, treasure().oracle_id);
            assert_eq!(out[0].name, "Treasure");
            assert_eq!(out[0].card_id, treasure().id);
            assert_eq!(out[0].sources, vec!["Smothering Tithe".to_string()]);
        }

        #[test]
        fn a_set_token_is_the_printing_with_the_most_copies() {
            let (conn, deck) = a_tithe_deck();
            seed_entry(&conn, deck, "live", &treasure(), "nonfoil", 1);
            seed_entry(&conn, deck, "live", &treasure_older(), "foil", 3);
            let out = deck_tokens(&conn, deck, "live").unwrap();
            assert_eq!(out.len(), 1, "one token, however many printings it keeps");
            assert_eq!(out[0].card_id, treasure_older().id);
        }

        #[test]
        fn a_set_printing_at_zero_still_outranks_the_default() {
            let (conn, deck) = a_tithe_deck();
            seed_entry(&conn, deck, "live", &treasure_older(), "foil", 0);
            let out = deck_tokens(&conn, deck, "live").unwrap();
            assert_eq!(out[0].card_id, treasure_older().id);
        }
    }
}
