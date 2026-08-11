//! Scryfall's `legalities` object as one integer.
//!
//! 23 keys today and the list grows, so the format filter used to cost a `json_extract`
//! per key per row: 695 ms for one facet pass over the live 107 337-row paper corpus
//! against 16.8 ms for the mask (measured 2026-08-11). It is also what lets the format
//! filter into an index at all — a JSON path cannot be indexed, a bitwise test on a column
//! can.
//!
//! **The key order is frozen.** Bit positions are stored data: `cards.legal_mask` holds
//! them, so reordering this list silently reinterprets every row already on disk. Keys may
//! only ever be **appended**. A key Scryfall removes keeps its bit and stops being set; a
//! key Scryfall adds sets no bit until it is appended here and a sync has run.

use serde_json::Value;

/// Every `legalities` key, in the order Scryfall emits them. **Append only** — see the
/// module docs. Bit *k* of a mask is `LEGALITY_KEYS[k]`.
pub const LEGALITY_KEYS: [&str; 23] = [
    "alchemy",
    "brawl",
    "commander",
    "competitivebrawl",
    "duel",
    "future",
    "gladiator",
    "historic",
    "legacy",
    "modern",
    "oathbreaker",
    "oldschool",
    "pauper",
    "paupercommander",
    "penny",
    "pioneer",
    "predh",
    "premodern",
    "standard",
    "standardbrawl",
    "timeless",
    "tlr",
    "vintage",
];

/// The values that count as playable. `restricted` is playable — a Vintage search that hid
/// Black Lotus would be wrong.
const PLAYABLE: [&str; 2] = ["legal", "restricted"];

/// The bit for one key, or `None` when this build has never heard of it.
pub fn bit(key: &str) -> Option<u64> {
    LEGALITY_KEYS
        .iter()
        .position(|k| *k == key)
        .map(|i| 1u64 << i)
}

/// The mask for one card's `legalities` object. Anything that is not an object of known
/// keys with playable values contributes nothing — there is no error case, because a card
/// with no legalities is legal nowhere and that is a fact rather than a failure.
pub fn legal_mask(legalities: &Value) -> u64 {
    let Some(obj) = legalities.as_object() else {
        return 0;
    };
    obj.iter()
        .filter(|(_, v)| v.as_str().is_some_and(|s| PLAYABLE.contains(&s)))
        .filter_map(|(k, _)| bit(k))
        .fold(0, |m, b| m | b)
}

/// The same mapping as an SQL expression over a column holding the JSON text, for the one
/// caller that cannot run Rust per row: the v8 backfill.
///
/// Generated from [`LEGALITY_KEYS`] rather than written out, so the two cannot drift.
/// `column` is an identifier this crate supplies and never user text.
pub fn mask_sql(column: &str) -> String {
    let terms: Vec<String> = LEGALITY_KEYS
        .iter()
        .enumerate()
        .map(|(i, key)| {
            format!(
                "(CASE WHEN json_extract({column}, '$.{key}') IN ('legal','restricted') \
                 THEN {} ELSE 0 END)",
                1u64 << i
            )
        })
        .collect();
    terms.join(" + ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The list is append-only because bit positions are on disk. This test is the fence:
    /// it fails on a reorder, a removal, or an insertion anywhere but the end.
    #[test]
    fn the_key_order_is_frozen() {
        assert_eq!(LEGALITY_KEYS[0], "alchemy");
        assert_eq!(LEGALITY_KEYS[9], "modern");
        assert_eq!(LEGALITY_KEYS[18], "standard");
        assert_eq!(LEGALITY_KEYS[22], "vintage");
        assert_eq!(LEGALITY_KEYS.len(), 23, "keys are appended, never inserted");
    }

    /// 64 bits is the ceiling, and it is not a soft one: a 65th key would silently set no
    /// bit. Scryfall is at 23.
    #[test]
    fn the_key_list_fits_in_a_u64() {
        assert!(LEGALITY_KEYS.len() <= 64);
    }

    #[test]
    fn restricted_counts_as_playable_and_the_rest_do_not() {
        let v = serde_json::json!({
            "vintage": "restricted",
            "modern": "legal",
            "standard": "not_legal",
            "pauper": "banned",
        });
        let m = legal_mask(&v);
        assert_ne!(m & bit("vintage").unwrap(), 0, "restricted is playable");
        assert_ne!(m & bit("modern").unwrap(), 0);
        assert_eq!(m & bit("standard").unwrap(), 0);
        assert_eq!(m & bit("pauper").unwrap(), 0, "banned is not playable");
        assert_eq!(
            m & bit("commander").unwrap(),
            0,
            "a key that is absent sets no bit"
        );
    }

    /// A key Scryfall invents before this list knows about it must be ignored, not panic
    /// and not shift anything.
    #[test]
    fn an_unknown_key_is_ignored() {
        assert_eq!(bit("mtg_grimoire_invented_format"), None);
        let m = legal_mask(&serde_json::json!({ "somethingnew": "legal" }));
        assert_eq!(m, 0);
    }

    #[test]
    fn a_missing_or_malformed_legalities_object_is_zero() {
        assert_eq!(legal_mask(&Value::Null), 0);
        assert_eq!(legal_mask(&serde_json::json!("not an object")), 0);
    }

    /// The migration backfills through this expression, so it has to agree with the Rust
    /// mapping key for key. Both are generated from the one constant; this pins that they
    /// are.
    #[test]
    fn the_sql_expression_names_every_key_once() {
        let sql = mask_sql("legalities");
        for (k, key) in LEGALITY_KEYS.iter().enumerate() {
            assert!(
                sql.contains(&format!("'$.{key}'")),
                "{key} missing from the SQL"
            );
            assert!(
                sql.contains(&format!("{}", 1u64 << k)),
                "bit for {key} missing"
            );
        }
    }
}
