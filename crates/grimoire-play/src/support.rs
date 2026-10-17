//! **What the rules engine plays of a deck**, asked before a game (issue #1078): which of its
//! cards phase.rs's oracle parser reads only in part, so the Playtesting page can mark a deck
//! and its cards before the reader picks it.
//!
//! The verdict is phase's own, never this crate's: each face is parsed exactly as a game parses
//! it (`cards::parsed_faces`, `build_oracle_face`) and asked `card_face_gaps`, the check phase's
//! coverage report and its deck builder's "N of M cards supported" are built on. A card with no
//! gap is played in full; a card with one is still dealt and played (a body with a cost and a
//! type), but the parts named in its gaps do nothing. **Facts, not sentences**: a gap is phase's
//! label (`Effect:…`, `Keyword:…`, `Trigger:…`), and the page words it.
//!
//! **Each card is parsed once per window** ([`SupportCache`]): the setup screen asks about every
//! deck the reader has, and decks share most of their cards.

use std::collections::{BTreeMap, HashMap};

use engine::game::coverage::card_face_gaps;
use serde::Serialize;

use crate::cards::{engine_name, parsed_faces, CardFacts};

/// One deck's answer: how many different cards it has, and which of them the engine does not
/// play in full.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckSupport {
    /// The deck's different cards, its commanders among them. Two printings of one card are one.
    pub cards: u32,
    /// The cards with a gap, by name.
    pub unsupported: Vec<UnsupportedCard>,
}

/// One card of a deck that the engine plays only in part.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedCard {
    /// A printing's Scryfall id — the first of the deck's rows of this card — for its picture.
    pub card_id: String,
    pub name: String,
    /// Copies in the deck, every printing of it together.
    pub quantity: u32,
    pub commander: bool,
    /// phase's coverage labels for what it does not play, every face's, each once.
    pub gaps: Vec<String>,
}

/// The gaps of every card asked about so far, by its oracle id (its name where it has none).
/// One per window, held by the host: the engine's rev is fixed for the life of the binary, so an
/// answer never goes stale.
#[derive(Debug, Default)]
pub struct SupportCache(HashMap<String, Vec<String>>);

impl SupportCache {
    /// The gaps of one card, parsed the first time it is asked about.
    fn gaps(&mut self, card: &CardFacts) -> Result<Vec<String>, String> {
        let key = card.oracle_id.clone().unwrap_or_else(|| card.name.clone());
        if let Some(gaps) = self.0.get(&key) {
            return Ok(gaps.clone());
        }
        let mut gaps: Vec<String> = Vec::new();
        for face in parsed_faces(card)? {
            for gap in card_face_gaps(&face) {
                if !gaps.contains(&gap) {
                    gaps.push(gap);
                }
            }
        }
        self.0.insert(key, gaps.clone());
        Ok(gaps)
    }
}

/// What the engine plays of `cards`, a deck as `deck_cards` answers it. **Runs the oracle
/// parser**, so it belongs on `on_engine_stack` like a game.
pub fn deck_support(cards: &[CardFacts], known: &mut SupportCache) -> Result<DeckSupport, String> {
    let mut seen: BTreeMap<String, Option<UnsupportedCard>> = BTreeMap::new();
    for card in cards {
        let gaps = known.gaps(card)?;
        let entry = seen.entry(engine_name(card)).or_insert_with(|| {
            (!gaps.is_empty()).then(|| UnsupportedCard {
                card_id: card.card_id.clone(),
                name: card.name.clone(),
                quantity: 0,
                commander: false,
                gaps,
            })
        });
        if let Some(unsupported) = entry {
            unsupported.quantity += card.quantity;
            unsupported.commander |= card.commander;
        }
    }
    Ok(DeckSupport {
        cards: seen.len() as u32,
        unsupported: seen.into_values().flatten().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::on_engine_stack;

    fn card(id: &str, name: &str, type_line: &str, text: &str, quantity: u32) -> CardFacts {
        CardFacts {
            card_id: id.into(),
            name: name.into(),
            quantity,
            oracle_id: Some(format!("oracle-{name}")),
            mana_cost: Some("{1}{G}".into()),
            type_line: Some(type_line.into()),
            oracle_text: Some(text.into()),
            power: Some("2".into()),
            toughness: Some("2".into()),
            cmc: Some(2.0),
            layout: Some("normal".into()),
            colors: vec!["G".into()],
            color_identity: vec!["G".into()],
            ..CardFacts::default()
        }
    }

    fn deck() -> Vec<CardFacts> {
        vec![
            card("bears-a", "Grizzly Bears", "Creature — Bear", "", 2),
            card("bears-b", "Grizzly Bears", "Creature — Bear", "", 2),
            card(
                "elves",
                "Llanowar Elves",
                "Creature — Elf Druid",
                "{T}: Add {G}.",
                4,
            ),
            // Rules text no parser has a word for: the gap a real card's unparsed line leaves.
            card(
                "moon",
                "Moonlit Bard",
                "Creature — Elf Bard",
                "Whenever the moon is full, sing a song of the old forest to every listener.",
                3,
            ),
        ]
    }

    #[test]
    fn a_deck_names_the_cards_the_engine_plays_only_in_part() {
        let (support, again, cached) = on_engine_stack(|| {
            let mut known = SupportCache::default();
            let support = deck_support(&deck(), &mut known).unwrap();
            let cached = known.0.len();
            let again = deck_support(&deck(), &mut known).unwrap();
            (support, again, cached)
        })
        .unwrap();
        assert_eq!(support.cards, 3, "two printings of the bears are one card");
        assert_eq!(support.unsupported.len(), 1, "{:?}", support.unsupported);
        let bard = &support.unsupported[0];
        assert_eq!(
            (bard.name.as_str(), bard.card_id.as_str()),
            ("Moonlit Bard", "moon")
        );
        assert_eq!(bard.quantity, 3);
        assert!(!bard.commander);
        assert!(!bard.gaps.is_empty(), "a gap names what is not played");
        assert_eq!(cached, 3, "one parse per card, the printings' shared");
        assert_eq!(again, support, "a second deck is answered from the cache");
    }

    #[test]
    fn an_unsupported_cards_copies_are_summed_across_its_printings() {
        let support = on_engine_stack(|| {
            let mut cards = deck();
            let mut second = cards[3].clone();
            second.card_id = "moon-promo".into();
            second.quantity = 1;
            second.commander = true;
            cards.push(second);
            deck_support(&cards, &mut SupportCache::default()).unwrap()
        })
        .unwrap();
        let bard = &support.unsupported[0];
        assert_eq!(bard.quantity, 4);
        assert!(bard.commander, "a commander among its printings marks it");
        assert_eq!(bard.card_id, "moon", "the first printing's picture");
    }
}
