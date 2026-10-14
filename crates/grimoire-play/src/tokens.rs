//! **The deck's own tokens** (issue #991): the printing the reader set for each token in the
//! deck's token wall, which both boards draw a token by, ahead of the printing phase's preset
//! names.
//!
//! phase's presets and the app's deck tokens name a token by the same Scryfall oracle id
//! (`TokenImageRef::scryfall_oracle_id`), which is what ties the two together. A token object the
//! engine made carries its preset's reference; one with no oracle id on it is matched by name,
//! and only when the deck keeps exactly one token of that name — `Spirit` alone is 22 tokens.

use std::collections::{HashMap, HashSet};

use engine::game::token_presets::known_token_presets;
use engine::types::card::TokenImageRef;
use serde::{Deserialize, Serialize};

use crate::view::TokenOffer;

/// One token the deck keeps, in the printing the reader set for it (`grimoire_core::play`'s
/// `PlayToken`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenFacts {
    pub oracle_id: String,
    pub name: String,
    /// The printing a board draws the token by.
    pub card_id: String,
    /// The deck cards that make it; empty for a token the reader added by hand.
    pub sources: Vec<String>,
}

/// One seat's tokens, ready to be looked up.
#[derive(Debug, Clone, Default)]
pub(crate) struct DeckTokens {
    /// One per oracle id, in the deck's order.
    tokens: Vec<TokenFacts>,
    by_oracle: HashMap<String, TokenFacts>,
    /// Lowercased name → the printing, for a name the deck keeps once; `None` for a name it keeps
    /// more than once, which says nothing.
    by_name: HashMap<String, Option<String>>,
}

impl DeckTokens {
    pub(crate) fn new(tokens: &[TokenFacts]) -> Self {
        let mut out = DeckTokens::default();
        for t in tokens {
            out.by_name
                .entry(t.name.to_lowercase())
                .and_modify(|p| *p = None)
                .or_insert_with(|| Some(t.card_id.clone()));
            if !out.by_oracle.contains_key(&t.oracle_id) {
                out.by_oracle.insert(t.oracle_id.clone(), t.clone());
                out.tokens.push(t.clone());
            }
        }
        out
    }

    /// The deck's printing of a token object, by its preset's reference or else its name.
    pub(crate) fn printing_of(&self, image: Option<&TokenImageRef>, name: &str) -> Option<String> {
        match image.and_then(|r| r.scryfall_oracle_id.as_deref()) {
            Some(oracle) => self.by_oracle.get(oracle).map(|t| t.card_id.clone()),
            None => self.by_name.get(&name.to_lowercase()).cloned().flatten(),
        }
    }

    /// The tokens the board offers to make: every preset phase says one of `deck_names` makes,
    /// and every token the deck keeps that a preset can make, drawn in the deck's printing where
    /// it keeps one. Sorted by name, then source.
    pub(crate) fn offers(&self, deck_names: &HashSet<&str>) -> Vec<TokenOffer> {
        let presets = known_token_presets();
        let oracle_of = |image: &Option<TokenImageRef>| {
            image.as_ref().and_then(|r| r.scryfall_oracle_id.clone())
        };
        let mut offered: HashSet<String> = HashSet::new();
        let mut tokens: Vec<TokenOffer> = presets
            .iter()
            .filter_map(|preset| {
                let source = preset
                    .source_card_names
                    .iter()
                    .find(|n| deck_names.contains(n.as_str()))?;
                let oracle = oracle_of(&preset.token_image_ref);
                let deck = oracle.as_ref().and_then(|o| self.by_oracle.get(o));
                offered.extend(oracle);
                Some(TokenOffer {
                    preset: preset.id.clone(),
                    name: preset.body.display_name.clone(),
                    source: source.clone(),
                    card_id: deck.map(|t| t.card_id.clone()).or_else(|| {
                        preset
                            .token_image_ref
                            .as_ref()
                            .map(|r| r.scryfall_id.clone())
                    }),
                })
            })
            .collect();
        tokens.sort_by(|a, b| a.name.cmp(&b.name).then(a.source.cmp(&b.source)));
        tokens.dedup_by(|a, b| a.name == b.name && a.source == b.source);
        // The deck's tokens phase does not tie to one of its cards: one Scryfall names for a card
        // phase's catalog lists under others, and one the reader added by hand. Any preset of the
        // token makes it; the lowest id, so the same deck offers the same preset every game.
        // Past the dedup, which would fold two hand-added tokens of one name into one.
        for token in &self.tokens {
            if offered.contains(&token.oracle_id) {
                continue;
            }
            let Some(preset) = presets
                .iter()
                .filter(|p| oracle_of(&p.token_image_ref).as_deref() == Some(&token.oracle_id))
                .min_by(|a, b| a.id.cmp(&b.id))
            else {
                continue;
            };
            tokens.push(TokenOffer {
                preset: preset.id.clone(),
                name: preset.body.display_name.clone(),
                source: token.sources.first().cloned().unwrap_or_default(),
                card_id: Some(token.card_id.clone()),
            });
        }
        tokens.sort_by(|a, b| a.name.cmp(&b.name).then(a.source.cmp(&b.source)));
        tokens
    }
}

/// A Treasure preset phase ties to a card, for the boards' tests: `(preset id, oracle id, the
/// card)`. Read off the catalog, so a move of phase's pin cannot leave a test naming a preset
/// that is gone.
#[cfg(test)]
pub(crate) fn a_treasure() -> (String, String, String) {
    known_token_presets()
        .iter()
        .filter(|p| p.body.display_name == "Treasure")
        .filter_map(|p| {
            let oracle = p.token_image_ref.as_ref()?.scryfall_oracle_id.clone()?;
            let source = p.source_card_names.iter().find(|n| !n.contains("//"))?;
            Some((p.id.clone(), oracle, source.clone()))
        })
        .min()
        .expect("phase's catalog has a Treasure a card makes")
}

/// The deck's Treasure, set to the printing `deck-treasure`, for the boards' tests.
#[cfg(test)]
pub(crate) fn a_treasure_facts(oracle: &str, source: &str) -> TokenFacts {
    TokenFacts {
        oracle_id: oracle.into(),
        name: "Treasure".into(),
        card_id: "deck-treasure".into(),
        sources: vec![source.into()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(oracle: &str, name: &str, card_id: &str, sources: &[&str]) -> TokenFacts {
        TokenFacts {
            oracle_id: oracle.into(),
            name: name.into(),
            card_id: card_id.into(),
            sources: sources.iter().map(|s| (*s).into()).collect(),
        }
    }

    #[test]
    fn a_token_the_deck_sets_is_offered_in_its_printing() {
        let (preset, oracle, source) = a_treasure();
        let names = HashSet::from([source.as_str()]);

        let phase = DeckTokens::new(&[]).offers(&names);
        let offer = phase.iter().find(|o| o.preset == preset).unwrap();
        assert_ne!(offer.card_id.as_deref(), Some("deck-treasure"));

        let deck = DeckTokens::new(&[set(&oracle, "Treasure", "deck-treasure", &[&source])]);
        let offers = deck.offers(&names);
        let offer = offers.iter().find(|o| o.preset == preset).unwrap();
        assert_eq!(offer.card_id.as_deref(), Some("deck-treasure"));
        assert_eq!(offer.source, source);
    }

    #[test]
    fn a_token_the_reader_added_is_offered_with_no_source() {
        let (_, oracle, _) = a_treasure();
        let deck = DeckTokens::new(&[set(&oracle, "Treasure", "deck-treasure", &[])]);
        let offers = deck.offers(&HashSet::new());
        assert_eq!(offers.len(), 1, "one offer for the one token: {offers:?}");
        assert_eq!(offers[0].name, "Treasure");
        assert_eq!(offers[0].source, "");
        assert_eq!(offers[0].card_id.as_deref(), Some("deck-treasure"));
    }

    #[test]
    fn a_token_the_catalog_cannot_make_is_not_offered() {
        let deck = DeckTokens::new(&[set("not-an-oracle", "Treasure", "deck-treasure", &[])]);
        assert!(deck.offers(&HashSet::new()).is_empty());
    }

    #[test]
    fn a_token_object_is_matched_by_oracle_and_else_by_a_name_kept_once() {
        let deck = DeckTokens::new(&[
            set("o-treasure", "Treasure", "deck-treasure", &[]),
            set("o-spirit-1", "Spirit", "deck-spirit-1", &[]),
            set("o-spirit-2", "Spirit", "deck-spirit-2", &[]),
        ]);
        let image = |oracle: Option<&str>| TokenImageRef {
            scryfall_id: "phase".into(),
            scryfall_oracle_id: oracle.map(Into::into),
            face_name: None,
            preset_id: "p".into(),
        };
        assert_eq!(
            deck.printing_of(Some(&image(Some("o-spirit-2"))), "Spirit")
                .as_deref(),
            Some("deck-spirit-2")
        );
        assert_eq!(
            deck.printing_of(Some(&image(Some("o-other"))), "Treasure"),
            None,
            "an oracle id the deck does not keep is not matched by name"
        );
        assert_eq!(
            deck.printing_of(None, "treasure").as_deref(),
            Some("deck-treasure")
        );
        assert_eq!(
            deck.printing_of(None, "Spirit"),
            None,
            "two Spirits say nothing"
        );
    }
}
