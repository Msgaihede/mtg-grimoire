//! The eight card types as one integer, so a type filter can live in an index.
//!
//! [`crate::legalities`]' argument, one column over: `type_line` is not in
//! `idx_cards_collapse`, and `schema.rs` records that putting it there was measured and was a
//! straight loss. A `LIKE` predicate therefore knocks the collapsed browse off its covering
//! index — the class of change that file measures at 455–505 ms against 22–47 ms. A bitwise
//! test on an integer column stays inside it.
//!
//! **The key order is frozen and append-only.** Bit positions are stored data: `cards.type_mask`
//! holds them, so reordering this list silently reinterprets every row already on disk. A type
//! that stops existing keeps its bit and stops being set; a type this app learns to filter on
//! sets no bit until it is appended here and the corpus has been backfilled or resynced —
//! [`crate::legalities`]' rule verbatim, and the reason `the_key_order_is_frozen` is a test.
//!
//! **This is a third type vocabulary and it must not be folded into either of the other two.**
//! `autoCategory.ts` files a card into exactly one bucket (Land first, so Dryad Arbor is a land)
//! and `deckBuckets.ts` into exactly one bar (Creature first, so an artifact land heads the
//! Artifact bar). They disagree with each other about Land on purpose. This one answers a third
//! question — *does this card have this type* — so Dryad Arbor is in both Land and Creature, and
//! a reader pressing `Creature` who could not find an artifact creature has been told a
//! falsehood.

/// Every card type this app filters on. **Append only** — see the module docs. Bit *k* of a
/// mask is `TYPE_KEYS[k]`.
///
/// Alphabetical, like [`crate::legalities::LEGALITY_KEYS`] and for the same non-reason: the
/// order carries no meaning and the append-only rule outranks any wish to re-sort. What a
/// reader sees is `CARD_TYPES` in `useCardSearch.ts`, which is Creature-first and Land-last —
/// a matching order and a display order are two constants here for `autoCategory.ts`'s reason.
pub const TYPE_KEYS: [&str; 8] = [
    "Artifact",
    "Battle",
    "Creature",
    "Enchantment",
    "Instant",
    "Land",
    "Planeswalker",
    "Sorcery",
];

/// The SQL that computes [`type_mask`] over a column, for the corpus schema 5 backfill.
///
/// **A mirror of the function below, and the pair is pinned by a test** — the shape
/// `legalities.rs` uses for its own backfill. Both the terms and the bits they set are
/// generated from [`TYPE_KEYS`] rather than written out, so an appended key reaches this
/// expression with no second edit and the two cannot drift apart. `col` is an identifier this
/// crate supplies, never user text.
///
/// Whole-word matching is done by padding: the em dash and the ASCII hyphen become a ` ~ `
/// marker, `//` becomes a space, the whole line is wrapped in spaces, and each type is looked
/// for as `% Word %`. That is what keeps `Plane` from ever matching `Planeswalker` if the list
/// grows, and it is the part of the rule this expression and [`type_mask`] spell the same way.
///
/// **Two places where they do not, both outside anything Scryfall publishes, and both worth
/// reading before a key is appended.** The pattern searches the *whole* padded line, where
/// [`type_mask`] reads only the half before each face's dash — so a line whose **subtype**
/// spelled one of the eight, `Enchantment — Creature`, would mask to both here and to
/// `Enchantment` there. No Scryfall subtype spells one of them, and stopping the search at the
/// first marker is not the fix: `Creature — Human Cleric // Land` is an ordinary modal
/// double-faced card, and an expression that read no further than its first `—` would drop the
/// Land every reader filtering for lands is looking for. The second is case: SQLite's `LIKE`
/// folds ASCII where `==` in Rust does not, so `LAND CREATURE` masks to both here and to
/// nothing there. `the_backfill_sql_and_the_rust_function_agree` is the fence over the lines
/// that are real, and a key whose word can appear as a subtype is what would make either
/// divergence reachable.
pub fn type_mask_sql(col: &str) -> String {
    let padded = format!(
        "(' ' || replace(replace(replace({col}, '—', ' ~ '), '//', ' '), '-', ' ~ ') || ' ')"
    );
    let terms: Vec<String> = TYPE_KEYS
        .iter()
        .enumerate()
        .map(|(k, name)| {
            format!(
                "(CASE WHEN {padded} LIKE '% {name} %' THEN {} ELSE 0 END)",
                1u32 << k
            )
        })
        .collect();
    format!("coalesce({}, 0)", terms.join(" + "))
}

/// The types a type line names, as a bit per [`TYPE_KEYS`] entry.
///
/// Both faces of a double-faced card count — `cards.type_line` holds `Sorcery // Land`, and an
/// MDFC land is a land to anyone filtering for lands. Within each face only the **type** half
/// is read: everything after the `—` is subtypes.
///
/// **The comparison folds ASCII case, and one real card is why.** `capital offense` (Unstable,
/// UST 52) is printed in lower case as the joke, so `cards.type_line` is literally `"instant"` —
/// and it is the *only* row of 117 738 in the live corpus whose type line carries a type word in
/// any case but Scryfall's own. A case-sensitive `==` gave it a mask of 0 where
/// [`type_mask_sql`]'s `LIKE` gave it the Instant bit, because SQLite's `LIKE` folds ASCII case
/// and Rust's `==` does not. That is two answers about one card that would have parted at a
/// **sync**: the backfill writes 16, the next ingest writes 0, and the card leaves the Instant
/// chip on a morning nothing else changed. `eq_ignore_ascii_case` is the side that agrees with
/// the SQL *and* with the reader, an instant in lower case still being an instant.
///
/// **Found by replaying the rung against a copy of the real corpus**, not by the fixtures: every
/// hand-written type line in this file is title case, so the divergence was documented as
/// unreachable and shipped one card wide.
pub fn type_mask(type_line: &str) -> u32 {
    let mut mask = 0u32;
    for face in type_line.split("//") {
        // Scryfall prints an em dash; a hyphen appears in hand-written fixtures. Either ends
        // the type half.
        let types = face.split(['—', '-']).next().unwrap_or("");
        for word in types.split_whitespace() {
            if let Some(k) = TYPE_KEYS
                .iter()
                .position(|name| name.eq_ignore_ascii_case(word))
            {
                mask |= 1 << k;
            }
        }
    }
    mask
}

/// The picked type chips as one mask — OR within, which is what a chip row means.
///
/// A word this build does not know contributes nothing, so a request naming only unknown types
/// masks to 0. The caller reads that as "no type filter at all", matching
/// [`crate::filters::picked_rarities`]' rule that a blank list adds no SQL.
pub fn mask_of(picked: &[String]) -> u32 {
    let mut mask = 0u32;
    for want in picked {
        if let Some(k) = TYPE_KEYS.iter().position(|name| *name == want) {
            mask |= 1 << k;
        }
    }
    mask
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bit(name: &str) -> u32 {
        1 << TYPE_KEYS.iter().position(|k| *k == name).unwrap()
    }

    /// The list is append-only because bit positions are on disk in `cards.type_mask`. This
    /// test is the fence: it fails on a reorder, a removal, or an insertion anywhere but the
    /// end, and an append is the one edit that walks through it —
    /// [`crate::legalities`]'s `the_key_order_is_frozen`, one column over.
    ///
    /// The **whole** array is written out rather than a few sampled positions, because a
    /// swapped neighbouring pair is exactly what a spot check misses: `Instant`/`Land` trading
    /// places leaves any sample of indices 0 and 7 green while every stored mask quietly
    /// reinterprets both bits.
    #[test]
    fn the_key_order_is_frozen() {
        assert_eq!(
            TYPE_KEYS,
            [
                "Artifact",
                "Battle",
                "Creature",
                "Enchantment",
                "Instant",
                "Land",
                "Planeswalker",
                "Sorcery",
            ]
        );
    }

    #[test]
    fn a_plain_creature_masks_to_one_bit() {
        assert_eq!(type_mask("Creature — Human Wizard"), bit("Creature"));
    }

    /// Dryad Arbor is the card the whole "contains" rule is written for: `autoCategory.ts`
    /// files it under Land alone, and a *filter* must find it under both.
    #[test]
    fn a_card_with_two_types_carries_both_bits() {
        assert_eq!(
            type_mask("Land Creature — Forest Dryad"),
            bit("Land") | bit("Creature")
        );
        assert_eq!(
            type_mask("Artifact Creature — Golem"),
            bit("Artifact") | bit("Creature")
        );
    }

    /// `cards.type_line` on a double-faced card holds both halves, and an MDFC land is a land
    /// to anyone filtering for lands.
    #[test]
    fn both_faces_count() {
        assert_eq!(type_mask("Sorcery // Land"), bit("Sorcery") | bit("Land"));
    }

    /// The reason matching is whole-word and not a substring: `TYPE_KEYS` is append-only, and
    /// the day anyone appends `Plane`, a substring test would match every Planeswalker.
    #[test]
    fn a_type_word_is_matched_whole_and_never_as_a_substring() {
        assert_eq!(
            type_mask("Legendary Planeswalker — Jace"),
            bit("Planeswalker")
        );
        // The guard that keeps the above honest as the list grows.
        assert!(
            !TYPE_KEYS.contains(&"Plane"),
            "appending `Plane` needs this test re-read"
        );
    }

    /// `capital offense` (Unstable, UST 52) prints its whole card in lower case as the joke, so
    /// `cards.type_line` is literally `"instant"` — the one row of 117 738 in the live corpus
    /// whose type line is not in Scryfall's own case.
    ///
    /// **It is a sync-time divergence rather than a wrong answer**, which is what makes it worth
    /// a test of its own: SQLite's `LIKE` folds ASCII case, so the corpus schema 5 backfill gave
    /// this card the Instant bit while a case-sensitive ingest gave it none — the card would have
    /// answered the Instant chip until the next sync and then quietly stopped.
    #[test]
    fn a_lower_case_type_line_is_still_that_type() {
        assert_eq!(type_mask("instant"), bit("Instant"));
        assert_eq!(type_mask("INSTANT"), bit("Instant"));
        assert_eq!(
            type_mask("legendary creature — human"),
            bit("Creature"),
            "the subtype half is still dropped, whatever its case"
        );
    }

    #[test]
    fn supertypes_and_subtypes_contribute_nothing() {
        assert_eq!(
            type_mask("Legendary Enchantment Creature — God"),
            bit("Enchantment") | bit("Creature")
        );
        // `Forest` is a subtype, not a type; only the half before the dash is read.
        assert_eq!(type_mask("Land — Forest"), bit("Land"));
    }

    #[test]
    fn a_blank_or_unknown_line_masks_to_nothing() {
        assert_eq!(type_mask(""), 0);
        assert_eq!(type_mask("Vanguard"), 0);
    }

    #[test]
    fn mask_of_ors_the_named_types_and_drops_the_rest() {
        assert_eq!(
            mask_of(&["Creature".to_owned(), "Land".to_owned()]),
            bit("Creature") | bit("Land")
        );
        assert_eq!(mask_of(&["Shiny".to_owned()]), 0);
        assert_eq!(mask_of(&[]), 0);
    }

    /// The strongest fence available: run the generated SQL through **real SQLite** and assert
    /// it lands on the same integer [`type_mask`] does, over the same lines. Every other test
    /// here reasons about Rust alone; this one is the only place the two implementations are
    /// compared by their answers, which is what the corpus schema 5 backfill depends on. It is
    /// also what proves the expression parses and executes at all — a test over a `String`
    /// cannot. `legalities.rs`'s
    /// `the_sql_expression_and_the_rust_mapping_land_on_the_same_integer` is the same idea.
    #[test]
    fn the_backfill_sql_and_the_rust_function_agree() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (line TEXT);").unwrap();
        let lines = [
            "Creature — Human Wizard",
            "Land Creature — Forest Dryad",
            "Artifact Creature — Golem",
            "Legendary Planeswalker — Jace",
            "Legendary Enchantment Creature — God",
            "Sorcery // Land",
            "Land — Forest",
            "Instant",
            "Battle — Siege",
            "Vanguard",
            "",
            // `capital offense` (UST 52), the one live row whose type line is not title case.
            // It is in this list rather than only in its own test because this is the
            // assertion that would have caught the divergence: every other line here is title
            // case, so the two sides agreed over the whole fixture and disagreed in the corpus.
            "instant",
        ];
        for line in lines {
            conn.execute("INSERT INTO t (line) VALUES (?1)", [line])
                .unwrap();
        }
        let sql = format!("SELECT line, {} FROM t", type_mask_sql("line"));
        let mut stmt = conn.prepare(&sql).unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(rows.len(), lines.len());
        for (line, from_sql) in rows {
            assert_eq!(
                from_sql as u32,
                type_mask(&line),
                "SQL and Rust disagree about {line:?}"
            );
        }
    }

    /// A NULL type line must mask to 0 rather than to NULL — the column is `NOT NULL`.
    #[test]
    fn a_null_type_line_masks_to_zero_in_sql() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (line TEXT); INSERT INTO t (line) VALUES (NULL);")
            .unwrap();
        let sql = format!("SELECT {} FROM t", type_mask_sql("line"));
        let got: i64 = conn.query_row(&sql, [], |r| r.get(0)).unwrap();
        assert_eq!(got, 0);
    }
}
