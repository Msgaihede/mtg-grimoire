//! The parts of `packages/ui/features/decks/deckBuckets.ts` the stats read: the faces of a type
//! line, the three readings of it (`is_land`, `type_bucket`, `is_mdfc_land`), a row's mana value
//! and curve bucket, the three card filters and `type_counts`.
//!
//! **Three questions, three answers**, as the TypeScript's module doc says: [`is_land`] asks
//! what the deck casts (the front face *names* Land anywhere), [`type_bucket`] what heading the
//! card sits under (the *first* of [`TYPE_BUCKETS`] the front names — Urza's Saga is an
//! Enchantment there), and [`is_mdfc_land`] what can be played off the back of a spell. None may
//! be folded into another. Every test is a case-sensitive substring test, as `includes` is.

use crate::deck::DeckCardRow;
use crate::deck_rules::engine::{mana_value_of, SIZE_KINDS};
use serde::Serialize;

/// `TYPE_BUCKETS`: the eight card types in printed order — the order that decides a card with
/// two of them.
pub const TYPE_BUCKETS: [&str; 8] = [
    "Creature",
    "Planeswalker",
    "Instant",
    "Sorcery",
    "Artifact",
    "Enchantment",
    "Battle",
    "Land",
];

/// `OTHER`: where a token, a scheme or an orphaned row goes.
pub const OTHER: &str = "Other";

/// `CURVE_BUCKETS`: 0 through 7 exactly, and 8 open-ended.
pub const CURVE_BUCKETS: usize = 9;

/// `MODAL_DFC`: the one `layout` [`is_mdfc_land`] accepts.
pub const MODAL_DFC: &str = "modal_dfc";

/// `Bucket`: one named pile of copies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub key: String,
    pub label: String,
    /// Copies, never rows.
    pub count: i64,
}

/// `front`: the face a deck is cast from — everything before the first `//`, untrimmed.
pub fn front(type_line: Option<&str>) -> &str {
    type_line.unwrap_or("").split("//").next().unwrap_or("")
}

/// `back`: every half after the first, rejoined; `""` for a card with only a front.
pub fn back(type_line: Option<&str>) -> &str {
    let line = type_line.unwrap_or("");
    match line.find("//") {
        // `halves.slice(1).join("//")` is the text after the first separator, verbatim.
        Some(cut) => &line[cut + 2..],
        None => "",
    }
}

/// `isLand`: the front face names Land — the land/nonland split every figure but the type bars
/// reads.
pub fn is_land(type_line: Option<&str>) -> bool {
    front(type_line).contains("Land")
}

/// `isMdfcLand`: a modal DFC whose front is not a land and whose back is — a second number beside
/// the Lands figure, never part of it. `layout` gates it, because a transform card's land back
/// cannot be played as one.
pub fn is_mdfc_land(card: &DeckCardRow) -> bool {
    if card.layout.as_deref() != Some(MODAL_DFC) {
        return false;
    }
    let type_line = card.type_line.as_deref();
    !is_land(type_line) && back(type_line).contains("Land")
}

/// `cardManaValue`: the synced `cmc`, else the printed cost's mana value, else `None`.
pub fn card_mana_value(card: &DeckCardRow) -> Option<f64> {
    if card.cmc.is_some() {
        return card.cmc;
    }
    card.mana_cost
        .as_deref()
        .map(|cost| mana_value_of(Some(cost)))
}

/// `curveBucket`: `Math.min(8, Math.max(0, Math.floor(mv)))`. A NaN — which no JSON number and
/// no SQLite REAL can be — lands in bucket 0 here and on no bucket in JavaScript.
pub fn curve_bucket(mana_value: f64) -> usize {
    mana_value.floor().clamp(0.0, (CURVE_BUCKETS - 1) as f64) as usize
}

/// `typeBucket`: the first of [`TYPE_BUCKETS`] the front face names, else [`OTHER`].
pub fn type_bucket(type_line: Option<&str>) -> &'static str {
    let line = front(type_line);
    TYPE_BUCKETS
        .into_iter()
        .find(|bucket| line.contains(bucket))
        .unwrap_or(OTHER)
}

/// `isCreature`: [`type_bucket`]'s answer is Creature — so the creature split and the Creature
/// bar are one count.
pub fn is_creature(type_line: Option<&str>) -> bool {
    type_bucket(type_line) == "Creature"
}

/// `activeCards`: the rows in switched-on piles — what every chart is drawn over.
pub fn active_cards(cards: &[DeckCardRow]) -> Vec<&DeckCardRow> {
    cards.iter().filter(|card| card.category_active).collect()
}

/// `sizedCards`: the active rows whose kind the format's size rule counts ([`SIZE_KINDS`]).
pub fn sized_cards(cards: &[DeckCardRow]) -> Vec<&DeckCardRow> {
    cards
        .iter()
        .filter(|card| card.category_active && SIZE_KINDS.contains(&card.category_kind.as_str()))
        .collect()
}

/// `libraryCards`: [`sized_cards`] less the command zone — the library an opening hand is drawn
/// from.
pub fn library_cards(cards: &[DeckCardRow]) -> Vec<&DeckCardRow> {
    sized_cards(cards)
        .into_iter()
        .filter(|card| card.category_kind != "commander")
        .collect()
}

/// `typeCounts`: copies per [`type_bucket`], one bucket per type something is in, in
/// [`TYPE_BUCKETS`] order with [`OTHER`] last. Over the rows it is handed — the page hands it
/// the active ones.
pub fn type_counts<'a>(cards: impl IntoIterator<Item = &'a DeckCardRow>) -> Vec<Bucket> {
    // (printed position, bucket), in first-seen order; the sort below is stable, as JS's is.
    let mut counts: Vec<(usize, Bucket)> = Vec::new();
    for card in cards {
        let label = type_bucket(card.type_line.as_deref());
        let key = label.to_lowercase();
        if let Some((_, seen)) = counts.iter_mut().find(|(_, b)| b.key == key) {
            seen.count += card.quantity;
            continue;
        }
        let at = TYPE_BUCKETS
            .iter()
            .position(|bucket| *bucket == label)
            .unwrap_or(TYPE_BUCKETS.len());
        counts.push((
            at,
            Bucket {
                key,
                label: label.to_owned(),
                count: card.quantity,
            },
        ));
    }
    counts.sort_by_key(|(at, _)| *at);
    counts.into_iter().map(|(_, bucket)| bucket).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck_golden::{assert_same, load, name};
    use serde_json::{json, Value};

    const MANA: &str = include_str!("../../../../packages/ui/features/decks/__golden__/mana.json");
    const STATS: &str =
        include_str!("../../../../packages/ui/features/decks/__golden__/stats.json");

    /// Every string of `mana.json`: the type-line readers.
    #[test]
    fn the_mana_golden_reads_type_lines_as_the_typescript_does() {
        let golden = load(MANA);
        let mut mdfc = golden.card(&json!({ "id": 0, "layout": MODAL_DFC }));
        for case in &golden.cases {
            let input = case["input"].as_str();
            mdfc.type_line = input.map(str::to_owned);
            let actual = json!({
                "front": front(input),
                "back": back(input),
                "isLand": is_land(input),
                "isCreature": is_creature(input),
                "typeBucket": type_bucket(input),
                "isMdfcLand": is_mdfc_land(&mdfc),
            });
            let expected = json!({
                "front": case["front"],
                "back": case["back"],
                "isLand": case["isLand"],
                "isCreature": case["isCreature"],
                "typeBucket": case["typeBucket"],
                "isMdfcLand": case["isMdfcLand"],
            });
            assert_same(
                &serde_json::to_value(&actual).unwrap(),
                &expected,
                name(case),
            );
        }
    }

    /// Every case of `stats.json`: `typeCounts`, the three filters, and each row's mana value and
    /// MDFC-land answer.
    #[test]
    fn the_stats_golden_buckets_as_the_typescript_does() {
        let golden = load(STATS);
        let ids = |rows: Vec<&DeckCardRow>| rows.iter().map(|row| row.id).collect::<Vec<_>>();
        for case in &golden.cases {
            let cards = golden.cards(&case["cards"]);
            let rows: Vec<Value> = cards
                .iter()
                .map(|row| {
                    json!({
                        "id": row.id,
                        "manaValue": card_mana_value(row),
                        "mdfcLand": is_mdfc_land(row),
                    })
                })
                .collect();
            let expected_rows: Vec<Value> = case["rows"]
                .as_array()
                .expect("rows")
                .iter()
                .map(|row| json!({ "id": row["id"], "manaValue": row["manaValue"], "mdfcLand": row["mdfcLand"] }))
                .collect();
            let actual = json!({
                "typeCounts": type_counts(&cards),
                "activeIds": ids(active_cards(&cards)),
                "sizedIds": ids(sized_cards(&cards)),
                "libraryIds": ids(library_cards(&cards)),
                "rows": rows,
            });
            let expected = json!({
                "typeCounts": case["typeCounts"],
                "activeIds": case["activeIds"],
                "sizedIds": case["sizedIds"],
                "libraryIds": case["libraryIds"],
                "rows": expected_rows,
            });
            assert_same(
                &serde_json::to_value(&actual).unwrap(),
                &expected,
                name(case),
            );
        }
    }

    #[test]
    fn faces_split_at_the_first_separator() {
        assert_eq!(front(Some("Sorcery // Land")), "Sorcery ");
        assert_eq!(front(None), "");
        assert_eq!(back(Some("A // B // C")), " B // C");
        assert_eq!(back(Some("Instant")), "");
        assert_eq!(back(Some("Land //")), "");
    }

    #[test]
    fn curve_buckets_floor_and_clamp() {
        assert_eq!(curve_bucket(0.0), 0);
        assert_eq!(curve_bucket(3.5), 3);
        assert_eq!(curve_bucket(7.0), 7);
        assert_eq!(curve_bucket(8.0), 8);
        assert_eq!(curve_bucket(13.0), 8);
        assert_eq!(curve_bucket(-2.0), 0);
        assert_eq!(curve_bucket(-0.5), 0);
    }
}
