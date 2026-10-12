//! How wide the reader dragged the deck editor's card search column, per deck — the setting, and
//! nothing else (issue #932).
//!
//! **The column is TypeScript's; the row is this crate's.** How narrow the column may be pulled
//! (one card), how wide the desk beside it can spare and what an un-dragged column opens at are
//! questions about a window this crate never sees — `CardSearchPanel.tsx` and
//! `features/decks/useDeckSearchWidth.ts` answer them. All Rust owns is one `app_meta` row holding
//! a JSON object of deck id → width in CSS pixels.
//!
//! **Per deck rather than one width for every deck**, and that is the issue's ask and the panel's
//! own argument: how much room the list beside the column needs is a fact about what is *in* the
//! list, so a column dragged wide for a 17-pile Commander deck is the wrong column for a 60-card
//! Standard one. The deck editor is keyed by deck id, so each deck mounts its own column and reads
//! its own entry.
//!
//! **This is [`crate::stackhide`]'s shape with [`crate::deckpane`]'s band**, and every rule is one
//! of theirs:
//!
//! * **Reading can never fail.** A missing row, a row that is not JSON, a deck entry that is not a
//!   whole number inside [`MIN_SEARCH_WIDTH`]..=[`MAX_SEARCH_WIDTH`] — each reads as "never
//!   dragged" for that deck and no other. [`stored`] is infallible by signature.
//! * **Writing is where validation lives**: an id that is not positive and a width outside the
//!   band are refused in a sentence. The band is a *storage* sanity check and deliberately not the
//!   UI's clamp, [`crate::deckpane::MIN_PANE_WIDTH`]'s split: the frontend clamps again where it
//!   draws, against a row it can measure.
//! * **A write preserves what this build does not understand**: the row is read back as a raw
//!   `serde_json::Map` and only the deck being written is touched.
//! * **A stale id is stored and answered, never pruned.** A deck deleted since leaves its entry
//!   behind, and pruning here would mean reading `decks`, which this module has no reason to.
//! * **Per device and never synced**: `app_meta` is on no capture spec, and a width is a fact
//!   about this device's window as much as about the deck.
//! * **No migration**: `app_meta` is schema v6's key/value table, and this is a key in it.
use rusqlite::Connection;
use serde_json::{Map, Value};

/// The `app_meta` key.
pub const K_DECK_SEARCH_WIDTH: &str = "deck_search_width";

/// The narrowest column this crate will store, in CSS pixels — under the panel's own one-card
/// floor (206), so a build that re-measures that floor needs no change here.
pub const MIN_SEARCH_WIDTH: u32 = 100;

/// The widest column this crate will store, in CSS pixels. The panel's own cap is half the window,
/// so this is past any monitor the app is likely to be drawn on — and a row claiming `40000` is
/// refused at the door rather than discovered as a deck with no room left for its cards.
pub const MAX_SEARCH_WIDTH: u32 = 4000;

/// What [`store`] says to an id that names no deck: `decks.id` is an `INTEGER PRIMARY KEY`, so it
/// cannot be zero or negative.
pub const NOT_A_DECK: &str = "A card search width is stored for a deck, named by its id.";

/// Is this a width this crate will store?
pub fn is_storable_width(width: u32) -> bool {
    (MIN_SEARCH_WIDTH..=MAX_SEARCH_WIDTH).contains(&width)
}

/// The row as it stands, with nothing thrown away — the shape a write has to preserve.
fn stored_object(conn: &Connection) -> Map<String, Value> {
    match crate::app_meta::get_app_meta(conn, K_DECK_SEARCH_WIDTH)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// The width the reader last dragged this deck's search column to, or `None` if they never have
/// (or what is stored is not a width). `None` is "never dragged", not zero: what an un-dragged
/// column opens at lives on the other side of the wire.
///
/// `as_u64` and not `as_f64`, [`crate::deckpane::stored`]'s rule: this build writes an integer, so
/// a fraction is something else's and is refused rather than rounded into a number nobody chose.
pub fn stored(conn: &Connection, deck_id: i64) -> Option<u32> {
    stored_object(conn)
        .get(&deck_id.to_string())
        .and_then(Value::as_u64)
        .and_then(|w| u32::try_from(w).ok())
        .filter(|w| is_storable_width(*w))
}

/// Remember one deck's search column width, leaving every other deck in the row exactly as it was.
pub fn store(conn: &Connection, deck_id: i64, width: u32) -> Result<(), String> {
    if deck_id <= 0 {
        return Err(NOT_A_DECK.to_owned());
    }
    if !is_storable_width(width) {
        return Err(format!(
            "{width} is not a card search width this app stores. \
             Expected a whole number of pixels between {MIN_SEARCH_WIDTH} and {MAX_SEARCH_WIDTH}."
        ));
    }
    let mut row = stored_object(conn);
    row.insert(deck_id.to_string(), Value::from(width));
    let json = serde_json::to_string(&Value::Object(row))
        .map_err(|e| format!("could not save the card search width: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_DECK_SEARCH_WIDTH, &json)
        .map_err(|e| format!("could not save the card search width: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// A fresh install has dragged nothing, in any deck.
    #[test]
    fn a_missing_row_is_never_dragged() {
        let conn = db();
        assert_eq!(
            crate::app_meta::get_app_meta(&conn, K_DECK_SEARCH_WIDTH),
            None
        );
        assert_eq!(stored(&conn, 1), None);
    }

    #[test]
    fn a_width_round_trips_and_a_second_drag_replaces_it() {
        let conn = db();
        store(&conn, 4, 512).unwrap();
        assert_eq!(stored(&conn, 4), Some(512));
        store(&conn, 4, 300).unwrap();
        assert_eq!(stored(&conn, 4), Some(300));
    }

    /// Two decks are two entries, and a write to one leaves the other alone.
    #[test]
    fn each_deck_keeps_its_own_width() {
        let conn = db();
        store(&conn, 4, 512).unwrap();
        store(&conn, 5, 260).unwrap();
        assert_eq!(stored(&conn, 4), Some(512));
        assert_eq!(stored(&conn, 5), Some(260));
        assert_eq!(stored(&conn, 6), None);
    }

    #[test]
    fn an_id_that_is_not_positive_is_refused_and_writes_nothing() {
        let conn = db();
        for deck in [0, -4] {
            assert_eq!(store(&conn, deck, 400).unwrap_err(), NOT_A_DECK);
        }
        assert_eq!(
            crate::app_meta::get_app_meta(&conn, K_DECK_SEARCH_WIDTH),
            None
        );
    }

    /// The band's two ends are stored and one pixel past either is refused.
    #[test]
    fn a_width_outside_the_band_is_refused_and_writes_nothing() {
        let conn = db();
        store(&conn, 4, MIN_SEARCH_WIDTH).unwrap();
        store(&conn, 5, MAX_SEARCH_WIDTH).unwrap();
        for width in [0, MIN_SEARCH_WIDTH - 1, MAX_SEARCH_WIDTH + 1, 40_000] {
            assert!(store(&conn, 6, width).is_err(), "{width} must be refused");
        }
        assert_eq!(stored(&conn, 6), None);
        assert_eq!(stored(&conn, 4), Some(MIN_SEARCH_WIDTH));
        assert_eq!(stored(&conn, 5), Some(MAX_SEARCH_WIDTH));
    }

    /// A row this build cannot read costs the reader their width and nothing else.
    #[test]
    fn an_unreadable_row_is_never_dragged_rather_than_failing() {
        let conn = db();
        for junk in [
            "",
            "not json",
            "[]",
            "null",
            "512",
            r#"{"4":"512"}"#,
            r#"{"4":512.5}"#,
            r#"{"4":-512}"#,
            r#"{"4":3}"#,
            r#"{"4":40000}"#,
            r#"{"4":{"width":512}}"#,
        ] {
            crate::app_meta::set_app_meta(&conn, K_DECK_SEARCH_WIDTH, junk).unwrap();
            assert_eq!(
                stored(&conn, 4),
                None,
                "`{junk}` must read as never dragged"
            );
        }
    }

    /// One deck's bad entry costs that deck its width and leaves its neighbours intact.
    #[test]
    fn one_bad_entry_costs_one_deck() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_DECK_SEARCH_WIDTH, r#"{"4":"x","5":420}"#).unwrap();
        assert_eq!(stored(&conn, 4), None);
        assert_eq!(stored(&conn, 5), Some(420));
    }

    /// An entry this build cannot read is kept by a write to another deck.
    #[test]
    fn a_write_keeps_what_this_build_does_not_understand() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_DECK_SEARCH_WIDTH, r#"{"x":{"y":1}}"#).unwrap();
        store(&conn, 4, 512).unwrap();
        let raw = crate::app_meta::get_app_meta(&conn, K_DECK_SEARCH_WIDTH).unwrap();
        let row: Map<String, Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(row.get("x"), Some(&serde_json::json!({ "y": 1 })));
        assert_eq!(stored(&conn, 4), Some(512));
    }

    #[test]
    fn a_write_over_a_junk_row_takes_effect() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_DECK_SEARCH_WIDTH, "not json").unwrap();
        store(&conn, 4, 512).unwrap();
        assert_eq!(stored(&conn, 4), Some(512));
    }
}
