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

pub use odds::OddsMode;

use crate::deck::{get_deck, DeckCardRow};
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

/// The most turns [`draw_odds`] reads past the opening hand.
pub const MAX_TURNS: i64 = 20;
/// The largest opening hand [`draw_odds`] takes.
pub const MAX_HAND: i64 = 20;

/// `deck_draw_odds`' answer: the chance of drawing the matched cards from the opening hand on,
/// turn by turn.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawOdds {
    pub deck_id: i64,
    pub variant: String,
    /// Copies an opening hand is drawn from: the sized piles less the command zone
    /// ([`buckets::library_cards`], the page's odds table's population).
    pub library: i64,
    /// Copies in the library the question is about.
    pub successes: i64,
    /// The matched cards' names, once each, in the list's order.
    pub matched: Vec<String>,
    /// What was asked for and matched nothing in the library — a name, a pile or a type.
    pub unmatched: Vec<String>,
    pub want: i64,
    pub mode: odds::OddsMode,
    pub hand: i64,
    pub on_the_play: bool,
    /// The chance in the opening hand.
    pub opening_hand: f64,
    /// The chance by each turn's draw, from turn 1.
    pub by_turn: Vec<TurnOdds>,
}

/// One turn's reading.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnOdds {
    pub turn: i64,
    /// Cards seen by this turn's draw: the hand, plus a card a turn — none on turn 1 on the play.
    pub cards_seen: i64,
    pub chance: f64,
}

/// What [`draw_odds`] asks about: library rows matching any of these.
#[derive(Debug, Default, Clone, Copy)]
pub struct DrawWhat<'a> {
    /// Each a card's name (either face of a two-faced card), printing id or oracle id, any case.
    pub cards: &'a [String],
    /// A pile's name, any case.
    pub pile: Option<&'a str>,
    /// A card type as the page's `by Types` cut files a card ([`buckets::type_bucket`], the front
    /// face's), any case: one of [`buckets::TYPE_BUCKETS`] or [`buckets::OTHER`].
    pub card_type: Option<&'a str>,
}

/// `deck_draw_odds`: the chance of drawing `want` (at least, exactly or at most, `mode`) of the
/// cards `what` names, in an opening hand of `hand` and by each of the next `turns` turns' draws —
/// [`odds::hand_odds`] over [`buckets::library_cards`], one card more a turn (none on turn 1 on
/// the play). Mulligans, tutors and card draw are not modelled. `None` for a deck that does not
/// exist; a sentence for a question it cannot ask.
#[allow(clippy::too_many_arguments)]
pub fn draw_odds(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    what: DrawWhat<'_>,
    want: i64,
    mode: odds::OddsMode,
    hand: i64,
    turns: i64,
    on_the_play: bool,
) -> Result<Option<DrawOdds>, String> {
    if what.cards.is_empty() && what.pile.is_none() && what.card_type.is_none() {
        return Err("Name what to draw: cards, a pile or a card type.".to_owned());
    }
    if !(1..=MAX_HAND).contains(&hand) {
        return Err(format!("hand is from 1 to {MAX_HAND} cards."));
    }
    if !(0..=MAX_TURNS).contains(&turns) {
        return Err(format!("turns is from 0 to {MAX_TURNS}."));
    }
    if want < 0 {
        return Err("want is 0 or more.".to_owned());
    }
    let card_type = match what.card_type {
        None => None,
        Some(typed) => Some(
            buckets::TYPE_BUCKETS
                .iter()
                .chain([&buckets::OTHER])
                .find(|t| t.eq_ignore_ascii_case(typed.trim()))
                .copied()
                .ok_or_else(|| {
                    format!(
                        "type cannot be {typed:?}; use one of: {}, {}.",
                        buckets::TYPE_BUCKETS.join(", "),
                        buckets::OTHER
                    )
                })?,
        ),
    };
    let Some(detail) = get_deck(conn, deck_id, variant, Marketplace::from_opt(None))? else {
        return Ok(None);
    };
    let library = buckets::library_cards(&detail.cards);
    let named = |row: &DeckCardRow, asked: &str| {
        let asked = asked.trim();
        row.card_id.eq_ignore_ascii_case(asked)
            || row
                .oracle_id
                .as_deref()
                .is_some_and(|o| o.eq_ignore_ascii_case(asked))
            || row.name.eq_ignore_ascii_case(asked)
            || row
                .name
                .split(" // ")
                .any(|face| face.eq_ignore_ascii_case(asked))
    };
    let hit = |row: &DeckCardRow| {
        what.cards.iter().any(|asked| named(row, asked))
            || what
                .pile
                .is_some_and(|p| row.category_name.eq_ignore_ascii_case(p.trim()))
            || card_type.is_some_and(|t| buckets::type_bucket(row.type_line.as_deref()) == t)
    };
    let mut matched: Vec<String> = Vec::new();
    let mut successes = 0;
    for row in library.iter().copied().filter(|r| hit(r)) {
        successes += row.quantity;
        if !matched.contains(&row.name) {
            matched.push(row.name.clone());
        }
    }
    let mut unmatched: Vec<String> = what
        .cards
        .iter()
        .filter(|asked| !library.iter().any(|r| named(r, asked)))
        .cloned()
        .collect();
    if let Some(p) = what.pile {
        if !library
            .iter()
            .any(|r| r.category_name.eq_ignore_ascii_case(p.trim()))
        {
            unmatched.push(p.to_owned());
        }
    }
    if let Some(t) = card_type {
        if !library
            .iter()
            .any(|r| buckets::type_bucket(r.type_line.as_deref()) == t)
        {
            unmatched.push(t.to_owned());
        }
    }
    let deck: i64 = library.iter().map(|r| r.quantity).sum();
    let chance = |seen: i64| {
        odds::hand_odds(&odds::HandOdds {
            deck,
            successes,
            hand: seen,
            want,
            mode,
        })
    };
    let by_turn = (1..=turns)
        .map(|turn| {
            let cards_seen = hand + turn - i64::from(on_the_play);
            TurnOdds {
                turn,
                cards_seen,
                chance: chance(cards_seen),
            }
        })
        .collect();
    Ok(Some(DrawOdds {
        deck_id,
        variant: variant.to_owned(),
        library: deck,
        successes,
        matched,
        unmatched,
        want,
        mode,
        hand,
        on_the_play,
        opening_hand: chance(hand),
        by_turn,
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

#[cfg(test)]
mod odds_tests {
    use super::*;
    use crate::deck::fixtures::{input, kind_of, main_of, seeded};
    use crate::deck::{add_card, create_deck};

    /// A Modern deck: 4 Bolts and 2 Serra Angels in the main pile, 3 Serras in the sideboard and
    /// 5 in a switched-off Maybeboard (neither in the library).
    fn deck(conn: &Connection) -> i64 {
        let id = create_deck(conn, &input("Test", "modern")).unwrap().id;
        let main = main_of(conn, id);
        add_card(conn, id, "bolt-m10", Some(main), None, "live", None, 4).unwrap();
        add_card(conn, id, "serra-lea", Some(main), None, "live", None, 2).unwrap();
        let side = kind_of(conn, id, "side");
        add_card(conn, id, "serra-8ed", Some(side), None, "live", None, 3).unwrap();
        let maybe = kind_of(conn, id, "maybe");
        add_card(conn, id, "bolt-lea", Some(maybe), None, "live", None, 5).unwrap();
        id
    }

    fn ask<'a>(cards: &'a [String]) -> DrawWhat<'a> {
        DrawWhat {
            cards,
            ..Default::default()
        }
    }

    #[test]
    fn the_library_is_the_sized_piles_and_each_turn_draws_one_more() {
        let conn = seeded();
        let id = deck(&conn);
        let bolt = ["lightning bolt".to_owned()];
        let got = draw_odds(
            &conn,
            id,
            "live",
            ask(&bolt),
            1,
            OddsMode::AtLeast,
            2,
            2,
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!((got.library, got.successes), (6, 4));
        assert_eq!(got.matched, ["Lightning Bolt"]);
        // 1 − C(2,2)/C(6,2) = 14/15 in two cards; on the play turn 1 sees the same two.
        let two = odds::hand_odds(&odds::HandOdds {
            deck: 6,
            successes: 4,
            hand: 2,
            want: 1,
            mode: OddsMode::AtLeast,
        });
        assert_eq!(got.opening_hand, two);
        assert_eq!(
            got.by_turn.iter().map(|t| t.cards_seen).collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(got.by_turn[0].chance, two);
        assert_eq!(got.by_turn[1].chance, 1.0);
        let drawn = draw_odds(
            &conn,
            id,
            "live",
            ask(&bolt),
            1,
            OddsMode::AtLeast,
            2,
            1,
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(drawn.by_turn[0].cards_seen, 3);
    }

    #[test]
    fn a_pile_and_a_type_select_and_what_matches_nothing_is_named() {
        let conn = seeded();
        let id = deck(&conn);
        let creature = DrawWhat {
            card_type: Some("creature"),
            ..Default::default()
        };
        let got = draw_odds(
            &conn,
            id,
            "live",
            creature,
            1,
            OddsMode::AtLeast,
            7,
            0,
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(got.successes, 2);
        assert!(got.by_turn.is_empty());
        let nothing = ["Black Lotus".to_owned()];
        let got = draw_odds(
            &conn,
            id,
            "live",
            DrawWhat {
                cards: &nothing,
                pile: Some("Nowhere"),
                card_type: None,
            },
            1,
            OddsMode::Exactly,
            7,
            0,
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(got.successes, 0);
        assert_eq!(got.unmatched, ["Black Lotus", "Nowhere"]);
        assert_eq!(got.opening_hand, 0.0);
    }

    #[test]
    fn a_question_it_cannot_ask_is_a_sentence() {
        let conn = seeded();
        let id = deck(&conn);
        let none = DrawWhat::default();
        let why = draw_odds(&conn, id, "live", none, 1, OddsMode::AtLeast, 7, 0, true).unwrap_err();
        assert!(why.contains("Name what to draw"), "{why}");
        let bad = DrawWhat {
            card_type: Some("Goblin"),
            ..Default::default()
        };
        let why = draw_odds(&conn, id, "live", bad, 1, OddsMode::AtLeast, 7, 0, true).unwrap_err();
        assert!(why.contains("Creature"), "{why}");
        let bolt = ["Lightning Bolt".to_owned()];
        assert!(draw_odds(
            &conn,
            id,
            "live",
            ask(&bolt),
            1,
            OddsMode::AtLeast,
            0,
            0,
            true
        )
        .is_err());
        assert!(draw_odds(
            &conn,
            id,
            "live",
            ask(&bolt),
            1,
            OddsMode::AtLeast,
            7,
            21,
            true
        )
        .is_err());
        assert!(draw_odds(
            &conn,
            999,
            "live",
            ask(&bolt),
            1,
            OddsMode::AtLeast,
            7,
            0,
            true
        )
        .unwrap()
        .is_none());
    }
}
