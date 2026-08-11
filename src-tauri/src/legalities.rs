//! Scryfall's `legalities` object as one integer.
//!
//! 23 keys today and the list grows, so the format filter used to cost a `json_extract`
//! per key per row: 695 ms for one facet pass over the live 107 337-row paper corpus
//! against 16.8 ms for the mask. **Measured 2026-08-11 through `node:sqlite`, against a
//! page-for-page online backup of the live database** — the build to name for a figure like
//! this is SQLite's own, which is optimised C whether the caller is debug or release Rust,
//! so no cargo profile enters into it. It is also what lets the format filter into an index
//! at all — a JSON path cannot be indexed, a bitwise test on a column can.
//!
//! **The key order is frozen.** Bit positions are stored data: `cards.legal_mask` holds
//! them, so reordering this list silently reinterprets every row already on disk. Keys may
//! only ever be **appended**. A key Scryfall removes keeps its bit and stops being set; a
//! key Scryfall adds sets no bit until it is appended here and a sync has run.

use serde_json::Value;

/// Every `legalities` key. **Append only** — see the module docs. Bit *k* of a mask is
/// `LEGALITY_KEYS[k]`.
///
/// **This list is alphabetical. Scryfall's emission order is not, and never was.** Scryfall
/// emits `standard, future, historic, timeless, gladiator, pioneer, modern, …` — recorded in
/// `docs/superpowers/research/2026-08-04-scryfall-api.md` §4f, in the domain-rules research
/// beside it, and observable in every `legalities` object in
/// `tests/fixtures/cards_sample.jsonl`. The sort here was this list's author's choice.
///
/// Neither order carries any meaning, because the **append-only** rule outranks both: a 24th
/// key goes on the end whatever it is alphabetically and wherever Scryfall emits it. Never
/// re-sort to restore either — bit positions are stored data, and a re-sort silently
/// reinterprets every row already on disk.
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

/// The same mapping as an SQL expression over **`cards.legalities`**, for the one caller
/// that cannot run Rust per row: the v9 backfill.
///
/// Both the keys and the playable values are generated from [`LEGALITY_KEYS`] and
/// [`PLAYABLE`] rather than written out, so this expression and [`legal_mask`] cannot drift
/// apart. `column` and the values are identifiers and constants this crate supplies, never
/// user text.
///
/// **`cards.raw` is not a valid argument.** `raw` is a gzip BLOB from schema v3 on, and
/// SQLite reads a BLOB argument to `json_extract` as JSONB — a gzip member is not valid
/// JSONB, so this expression raises `malformed JSON` and fails the whole migration for
/// every user who has synced since v3, rather than yielding NULL. It is invisible to tests,
/// because fixture databases hold text `raw`. A reader that must go through `raw` wraps its
/// argument in `schema::json_raw`; `legalities` is its own TEXT column and needs no guard.
pub fn mask_sql(column: &str) -> String {
    let playable: Vec<String> = PLAYABLE.iter().map(|v| format!("'{v}'")).collect();
    let playable = playable.join(",");
    let terms: Vec<String> = LEGALITY_KEYS
        .iter()
        .enumerate()
        .map(|(i, key)| {
            format!(
                "(CASE WHEN json_extract({column}, '$.{key}') IN ({playable}) \
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
    use rusqlite::{params, Connection};

    /// The list is append-only because bit positions are on disk. This test is the fence:
    /// it fails on a reorder, a removal, or an insertion anywhere but the end, and an
    /// append is the one edit that walks through it.
    ///
    /// The **whole** array is written out rather than a few sampled positions, because a
    /// swapped neighbouring pair is exactly what a spot check misses — `pauper`/
    /// `paupercommander` traded places leaves any sample of indices 0, 9, 18 and 22 green
    /// while silently reinterpreting both bits in every row already stored.
    #[test]
    fn the_key_order_is_frozen() {
        assert_eq!(
            LEGALITY_KEYS,
            [
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
            ]
        );
        assert_eq!(
            LEGALITY_KEYS.len(),
            23,
            "appending a key is allowed and deliberate: update this count and the list \
             above together, and know that every mask already on disk keeps its meaning \
             only because the append went on the end"
        );
    }

    /// A duplicate key is the one input where the two implementations genuinely disagree
    /// with neither of them containing a bug: [`bit`] returns `position`, the **first**
    /// index, and stops, while [`mask_sql`] emits a term per *entry* — so a key listed
    /// twice sets **both** of its bits in SQL and only the first in Rust. Measured by
    /// duplicating `pauper` at index 21: the expression answers 2 101 248 (bits 12 and 21)
    /// where [`legal_mask`] answers 4 096, and the extra bit belongs to whichever format
    /// later occupies that position.
    ///
    /// It is only *duplicates* that diverge. Joining the terms with `+` rather than `|` is
    /// otherwise safe, because `enumerate` gives every term its own bit and no two can ever
    /// sum into a carry.
    #[test]
    fn the_key_list_holds_no_duplicates() {
        let mut seen = std::collections::HashSet::new();
        for key in LEGALITY_KEYS {
            assert!(seen.insert(key), "{key} appears twice");
        }
    }

    /// 64 bits is the ceiling, and it is not a soft one. A 65th key does **not** quietly set
    /// no bit: both [`bit`] and [`mask_sql`] build it with `1u64 << i`, which **panics** in a
    /// debug build and, in release, masks the shift count to `1 << 0` and **collides with the
    /// first key** — every `alchemy` printing reading as legal in the new format and vice
    /// versa, in SQL and in Rust alike. That is worse than a lost bit, which is why the
    /// ceiling is asserted rather than trusted. Scryfall is at 23.
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
    /// are — **one term at a time**, which is the whole point.
    ///
    /// Asking only whether the key and the bit each appear *somewhere* in one long string
    /// proves nothing about which is paired with which: a fully reversed assignment, which
    /// disagrees with [`bit`] on 22 of the 23 keys and would corrupt the backfill of every
    /// row, names every key and emits every bit and passes that test green (measured).
    /// Nor can the bit be looked for by bare containment even within a term — `1` is a
    /// substring of `16` — so it is anchored to the `THEN` that assigns it.
    #[test]
    fn the_sql_expression_names_every_key_once() {
        let sql = mask_sql("legalities");
        let terms: Vec<&str> = sql.split(" + ").collect();
        assert_eq!(
            terms.len(),
            LEGALITY_KEYS.len(),
            "one term per key, no more"
        );
        for (k, key) in LEGALITY_KEYS.iter().enumerate() {
            let term = terms[k];
            assert!(
                term.contains(&format!("'$.{key}'")),
                "term {k} should read {key}: {term}"
            );
            assert!(
                term.contains(&format!("THEN {} ", 1u64 << k)),
                "term for {key} should set bit {}: {term}",
                1u64 << k
            );
        }
    }

    /// The strongest fence available: run the generated SQL through **real SQLite** and
    /// assert it lands on the same integer [`legal_mask`] does, over the same input. Every
    /// other test here reasons about the *shape* of a string; this one is the only place
    /// the two implementations are compared by their answers, which is what the v9 backfill
    /// actually depends on. It is also what proves the expression parses and executes at
    /// all — a test over a `String` cannot.
    ///
    /// Each key is asked on its own, so a shifted or reversed assignment fails on the
    /// first key rather than waiting for an input lucky enough to expose it.
    #[test]
    fn the_sql_expression_and_the_rust_mapping_land_on_the_same_integer() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE cards (legalities TEXT)", [])
            .unwrap();
        let query = format!("SELECT ({}) FROM cards", mask_sql("legalities"));

        let sql_mask = |legalities: Option<String>| -> u64 {
            conn.execute("DELETE FROM cards", []).unwrap();
            conn.execute(
                "INSERT INTO cards (legalities) VALUES (?1)",
                params![legalities],
            )
            .unwrap();
            conn.query_row(&query, [], |r| r.get::<_, i64>(0)).unwrap() as u64
        };

        for (k, key) in LEGALITY_KEYS.iter().enumerate() {
            let mut obj = serde_json::Map::new();
            obj.insert((*key).to_string(), Value::from("legal"));
            let v = Value::Object(obj);
            assert_eq!(legal_mask(&v), 1u64 << k, "Rust bit for {key}");
            assert_eq!(
                sql_mask(Some(v.to_string())),
                1u64 << k,
                "SQL bit for {key}"
            );
        }

        // The four values a card actually carries, in one object, so the agreement covers
        // which values count and not only which keys do.
        let mixed = serde_json::json!({
            "vintage": "restricted",
            "modern": "legal",
            "standard": "not_legal",
            "pauper": "banned",
        });
        let expected = bit("vintage").unwrap() | bit("modern").unwrap();
        assert_eq!(legal_mask(&mixed), expected);
        assert_eq!(sql_mask(Some(mixed.to_string())), expected);

        // A NULL column is the row the backfill meets on any card Scryfall gave no
        // legalities: `NULL IN (…)` is NULL, which is not true, so every CASE takes its
        // ELSE and the row masks to 0 — the same answer `legal_mask` gives `Value::Null`,
        // and not itself a NULL that would land in a NOT NULL column.
        assert_eq!(sql_mask(None), 0);
        assert_eq!(legal_mask(&Value::Null), 0);
    }
}
