//! Deck statistics and draw odds — **the Rust port of the deck page's arithmetic**:
//! `packages/ui/features/decks/DeckStats.tsx`' `deckStats`, the parts of `deckBuckets.ts` and
//! `packages/ui/lib/mana.ts` it reads, `stats/typeBreakdownCounts.ts` and `openingHand.ts`.
//!
//! **A port, not a second design**, held to the TypeScript by the goldens under
//! `packages/ui/features/decks/__golden__/` exactly as [`crate::deck_rules`] is (its module doc
//! says how). What is ported is the arithmetic the page draws conclusions with — never chart
//! geometry, labels or display folding.
//!
//! [`mana`] is the cost tokeniser and pip counts, [`buckets`] the type and curve buckets and the
//! card filters (`sized_cards`, `library_cards`), [`summary`] the `DeckStatsSummary`, [`types`]
//! the type breakdown and [`odds`] the hypergeometric draw odds.

pub mod buckets;
pub mod mana;
pub mod odds;
pub mod summary;
pub mod types;

use crate::deck::get_deck;
use crate::sorting::Marketplace;
use buckets::{active_cards, type_counts, Bucket};
use rusqlite::Connection;
use serde::Serialize;
use summary::{deck_stats, DeckStatsSummary};
use types::{creature_split, type_breakdown, CreatureSplit, TypeBreakdown};

/// `deck_stats`' answer: every number the deck page's stats band draws for one list of one deck.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckStatsRead {
    pub deck_id: i64,
    pub variant: String,
    /// The deck's own setting, which moves `{X}` spells out of their numeric bucket into
    /// `summary.variableCost` — the one argument that changes a number in `summary`.
    pub separate_x_group: bool,
    pub summary: DeckStatsSummary,
    /// Copies per card type over the active piles — the Card distribution's `by Types` bars.
    pub type_counts: Vec<Bucket>,
    /// Creature and land subtypes, as the Type breakdown tile counts them.
    pub type_breakdown: TypeBreakdown,
    /// Creatures against noncreatures, as the curve's split bar reads them.
    pub creature_split: CreatureSplit,
}

/// `deck_stats`: one list of one deck counted as the stats band counts it, its prices at
/// `marketplace` (`summary.price` and its splits) — `None` for a deck that does not exist.
pub fn read_stats(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    marketplace: Marketplace,
) -> Result<Option<DeckStatsRead>, String> {
    let Some(detail) = get_deck(conn, deck_id, variant, marketplace)? else {
        return Ok(None);
    };
    let separate_x_group = detail.deck.separate_x_group;
    let summary = deck_stats(&detail.cards, separate_x_group);
    Ok(Some(DeckStatsRead {
        deck_id,
        variant: variant.to_owned(),
        separate_x_group,
        type_counts: type_counts(active_cards(&detail.cards)),
        type_breakdown: type_breakdown(&detail.cards),
        creature_split: creature_split(&summary),
        summary,
    }))
}

#[cfg(test)]
mod read_tests {
    use super::*;
    use crate::deck::fixtures::{input, kind_of, main_of, seeded};
    use crate::deck::{add_card, create_deck};

    #[test]
    fn a_deck_is_counted_as_the_stats_band_counts_it() {
        let conn = seeded();
        let id = create_deck(&conn, &input("Test", "modern")).unwrap().id;
        let main = main_of(&conn, id);
        add_card(&conn, id, "bolt-m10", Some(main), None, "live", None, 4).unwrap();
        add_card(&conn, id, "serra-lea", Some(main), None, "live", None, 2).unwrap();
        let maybe = kind_of(&conn, id, "maybe");
        add_card(&conn, id, "serra-8ed", Some(maybe), None, "live", None, 3).unwrap();

        let read = read_stats(&conn, id, "live", Marketplace::Tcgplayer)
            .unwrap()
            .unwrap();
        assert!(!read.separate_x_group);
        let s = &read.summary;
        assert_eq!((s.copies, s.sized, s.inactive), (6, 6, 3));
        assert_eq!((s.lands, s.nonlands), (0, 6));
        assert_eq!(s.curve[1], 4);
        assert_eq!(s.curve[5], 2);
        // (4 × 1 + 2 × 5) / 6, the switched-off Maybeboard counting toward nothing.
        assert_eq!(s.average_mana_value, Some(14.0 / 6.0));
        let types: Vec<(&str, i64)> = read
            .type_counts
            .iter()
            .map(|b| (b.label.as_str(), b.count))
            .collect();
        assert_eq!(types, [("Creature", 2), ("Instant", 4)]);
        assert!(read_stats(&conn, 999, "live", Marketplace::Tcgplayer)
            .unwrap()
            .is_none());
    }
}
