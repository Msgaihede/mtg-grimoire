//! Which of a deck's stacks the reader has hidden in the deck editor's Stacks view — the setting,
//! and nothing else (issue #618).
//!
//! **What a hidden stack is is TypeScript's; the row is this crate's.** Hiding a stack draws its
//! heading and none of its cards, which is a question about a desk this crate never draws —
//! `features/decks/useHiddenStacks.ts` answers it. All Rust owns is one `app_meta` row holding a
//! JSON object of deck id → the category ids hidden in that deck.
//!
//! **This is [`crate::shelffolds`] keyed by deck rather than by page**, and every rule is that
//! module's:
//!
//! * **Reading can never fail.** A missing row, a row that is not JSON, a deck entry that is not an
//!   array, an element that is not a positive integer — each reads as "nothing hidden" for that
//!   much and no more. [`hidden_stacks`] is infallible by signature.
//! * **A write preserves what this build does not understand**: the row is read back as a raw
//!   `serde_json::Map` and only the deck being written is touched.
//! * **Unhiding the last stack deletes the deck's entry** rather than storing an empty list, so the
//!   row does not collect one key for every deck a reader has ever hidden anything in.
//! * **A stale id is stored and answered, never pruned.** A pile deleted in another window leaves
//!   an entry behind; while no pile has that id the editor ignores it, and pruning here would mean
//!   reading `deck_categories`, which this module has no reason to. `deck_categories.id` can be
//!   reused (no `AUTOINCREMENT`), so a new pile can inherit a deleted one's hidden state — and
//!   draws its heading with the eye on it, one press from showing its cards. That is accepted
//!   rather than guarded, [`crate::shelffolds`]' own trade before its create-time clear.
//! * **Per device and never synced** — the reader's choice (2026-09-28): `app_meta` is on no
//!   capture spec, so a stack hidden on one device stays drawn on another.
//! * **No migration**: `app_meta` is schema v6's key/value table, and this is a key in it.
use rusqlite::Connection;
use serde_json::{Map, Value};

/// The `app_meta` key.
pub const K_HIDDEN_STACKS: &str = "hidden_stacks";

/// What [`store`] says to an id that names no deck or no pile: both are `INTEGER PRIMARY KEY`
/// rows, so neither can be zero or negative, and storing one would put an entry in the row no
/// deck could ever match.
pub const NOT_AN_ID: &str = "A hidden stack is named by a deck id and a category id.";

/// The row as it stands, with nothing thrown away — the shape a write has to preserve. Every
/// failure collapses into an empty map, [`crate::shelffolds`]' read rule at its widest.
fn stored_object(conn: &Connection) -> Map<String, Value> {
    match crate::app_meta::get_app_meta(conn, K_HIDDEN_STACKS)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// One deck's usable ids, ascending and without repeats. Elements are dropped one at a time, so a
/// single hand-edited value costs that stack its memory and leaves its neighbours intact.
pub fn stored(conn: &Connection, deck_id: i64) -> Vec<i64> {
    let mut ids: Vec<i64> = match stored_object(conn).get(&deck_id.to_string()) {
        Some(Value::Array(ids)) => ids
            .iter()
            .filter_map(Value::as_i64)
            .filter(|id| *id > 0)
            .collect(),
        _ => Vec::new(),
    };
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Hide or show one stack, leaving every other deck in the row and every other stack of this
/// deck exactly as it was. Showing a stack that is not hidden, and hiding one that is, write the
/// same row back — harmless, and simpler than a read to find out.
pub fn store(
    conn: &Connection,
    deck_id: i64,
    category_id: i64,
    hidden: bool,
) -> Result<(), String> {
    if deck_id <= 0 || category_id <= 0 {
        return Err(NOT_AN_ID.to_owned());
    }
    let mut row = stored_object(conn);
    let key = deck_id.to_string();
    let mut ids = stored(conn, deck_id);
    ids.retain(|id| *id != category_id);
    if hidden {
        ids.push(category_id);
        ids.sort_unstable();
    }
    if ids.is_empty() {
        row.remove(&key);
    } else {
        row.insert(key, Value::from(ids));
    }
    let json = serde_json::to_string(&Value::Object(row))
        .map_err(|e| format!("could not save the hidden stacks: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_HIDDEN_STACKS, &json)
        .map_err(|e| format!("could not save the hidden stacks: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// A fresh install has hidden nothing, in any deck.
    #[test]
    fn a_missing_row_hides_nothing() {
        let conn = db();
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_HIDDEN_STACKS), None);
        assert!(stored(&conn, 1).is_empty());
    }

    #[test]
    fn a_hidden_stack_round_trips_and_shows_again() {
        let conn = db();
        store(&conn, 4, 12, true).unwrap();
        store(&conn, 4, 9, true).unwrap();
        assert_eq!(stored(&conn, 4), vec![9, 12]);
        store(&conn, 4, 12, false).unwrap();
        assert_eq!(stored(&conn, 4), vec![9]);
    }

    /// Hiding twice is one hidden stack, and showing one that was never hidden writes nothing new.
    #[test]
    fn a_repeated_press_is_idempotent() {
        let conn = db();
        store(&conn, 4, 12, true).unwrap();
        store(&conn, 4, 12, true).unwrap();
        assert_eq!(stored(&conn, 4), vec![12]);
        store(&conn, 4, 7, false).unwrap();
        assert_eq!(stored(&conn, 4), vec![12]);
    }

    /// Two decks are two entries, and a write to one leaves the other alone.
    #[test]
    fn each_deck_keeps_its_own_stacks() {
        let conn = db();
        store(&conn, 4, 12, true).unwrap();
        store(&conn, 5, 12, true).unwrap();
        store(&conn, 5, 12, false).unwrap();
        assert_eq!(stored(&conn, 4), vec![12]);
        assert!(stored(&conn, 5).is_empty());
    }

    /// Showing a deck's last hidden stack takes its key out of the row rather than leaving `[]`.
    #[test]
    fn showing_the_last_stack_removes_the_decks_entry() {
        let conn = db();
        store(&conn, 4, 12, true).unwrap();
        store(&conn, 4, 12, false).unwrap();
        let raw = crate::app_meta::get_app_meta(&conn, K_HIDDEN_STACKS).unwrap();
        assert_eq!(raw, "{}");
    }

    #[test]
    fn an_id_that_is_not_positive_is_refused_and_writes_nothing() {
        let conn = db();
        for (deck, category) in [(0, 1), (1, 0), (-4, 1), (1, -12)] {
            assert_eq!(store(&conn, deck, category, true).unwrap_err(), NOT_AN_ID);
        }
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_HIDDEN_STACKS), None);
    }

    /// A row this build cannot read costs the reader their hidden stacks and nothing else.
    #[test]
    fn an_unreadable_row_hides_nothing_rather_than_failing() {
        let conn = db();
        for junk in [
            "",
            "not json",
            "[]",
            "null",
            "true",
            r#"{"4":12}"#,
            r#"{"4":{"12":true}}"#,
        ] {
            crate::app_meta::set_app_meta(&conn, K_HIDDEN_STACKS, junk).unwrap();
            assert!(
                stored(&conn, 4).is_empty(),
                "`{junk}` must read as nothing hidden"
            );
        }
    }

    /// **One bad element costs one stack**: a string, a fraction, a zero and a negative are dropped
    /// while the valid neighbours in the same list survive.
    #[test]
    fn one_bad_element_costs_one_stack_and_its_neighbours_survive() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_HIDDEN_STACKS, r#"{"4":["12",1.5,0,-3,14,9,14]}"#)
            .unwrap();
        assert_eq!(stored(&conn, 4), vec![9, 14]);
    }

    /// An entry this build cannot read is kept by a write to another deck.
    #[test]
    fn a_write_keeps_what_this_build_does_not_understand() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_HIDDEN_STACKS, r#"{"x":{"y":1}}"#).unwrap();
        store(&conn, 4, 12, true).unwrap();
        let raw = crate::app_meta::get_app_meta(&conn, K_HIDDEN_STACKS).unwrap();
        let row: Map<String, Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(row.get("x"), Some(&serde_json::json!({ "y": 1 })));
        assert_eq!(stored(&conn, 4), vec![12]);
    }

    #[test]
    fn a_write_over_a_junk_row_takes_effect() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_HIDDEN_STACKS, "not json").unwrap();
        store(&conn, 4, 12, true).unwrap();
        assert_eq!(stored(&conn, 4), vec![12]);
    }
}
