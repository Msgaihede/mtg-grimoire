//! `commanders.ts`: who may sit in the command zone, who may sit there *with* them, and what
//! colours the rest of the deck may be once they do.
//!
//! **Keyed by `spec.commander_rule`, never by a format key** — six rule names (`edh`, `brawl`,
//! `oathbreaker`, `pdh`, `duel`, `tlr`) cover the seeded commander formats. **The front face
//! decides** ([`front_face`]), and **`color_identity` is concatenated letters**, never JSON
//! ([`identity_of`]).

use super::issue::ValidationIssue;
use super::{face_text, faces_of, js_trim};
use crate::deck::{DeckCardRow, FormatSpecRow};
use serde_json::Value;

/// The em dash Scryfall's type lines and the printed partner variants use (U+2014). Written as an
/// escape so an editor cannot swap it for an en dash invisibly.
pub(crate) const EM_DASH: char = '\u{2014}';

/// WUBRG, the order Magic prints colours in and the order a message reads them back in.
pub(crate) const COLOR_ORDER: [char; 5] = ['W', 'U', 'B', 'R', 'G'];

/// The four fields every rule reads, taken from the face the card is cast as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontFace {
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub power: Option<String>,
    pub toughness: Option<String>,
}

/// The card as its front face: the row's own fields (a joined `"A // B"` type line read as its
/// left half), with `card_faces[0]`'s string fields laid over them where it has them.
pub fn front_face(card: &DeckCardRow) -> FrontFace {
    let own = FrontFace {
        type_line: card
            .type_line
            .as_deref()
            .map(|t| js_trim(t.split("//").next().unwrap_or("")).to_owned()),
        oracle_text: card.oracle_text.clone(),
        power: card.power.clone(),
        toughness: card.toughness.clone(),
    };
    let Some(face) = first_face(card.faces.as_deref()) else {
        return own;
    };
    let over = |key: &str, own: Option<String>| face_text(&face, key).map(str::to_owned).or(own);
    FrontFace {
        type_line: over("type_line", own.type_line),
        oracle_text: over("oracle_text", own.oracle_text),
        power: over("power", own.power),
        toughness: over("toughness", own.toughness),
    }
}

/// `card_faces[0]` when it is an object (and not an array), else `None`.
fn first_face(faces: Option<&str>) -> Option<Value> {
    faces_of(faces).into_iter().next().filter(Value::is_object)
}

/// Everything left of the em dash: supertypes and card types.
pub(crate) fn card_types_of(type_line: &str) -> &str {
    type_line.split(EM_DASH).next().unwrap_or("")
}

/// Everything right of it, trimmed: the subtypes.
pub(crate) fn subtypes_of(type_line: &str) -> &str {
    match type_line.find(EM_DASH) {
        None => "",
        Some(dash) => js_trim(&type_line[dash + EM_DASH.len_utf8()..]),
    }
}

/// Substring tests, as the TypeScript's: no printed card type or subtype contains another.
pub(crate) fn is_legendary(type_line: &str) -> bool {
    card_types_of(type_line).contains("Legendary")
}

pub(crate) fn has_card_type(type_line: &str, card_type: &str) -> bool {
    card_types_of(type_line).contains(card_type)
}

pub(crate) fn has_subtype(type_line: &str, subtype: &str) -> bool {
    subtypes_of(type_line).contains(subtype)
}

pub(crate) fn is_planeswalker_card(card: &DeckCardRow) -> bool {
    front_face(card)
        .type_line
        .is_some_and(|t| has_card_type(&t, "Planeswalker"))
}

/// A colour identity: a set of WUBRG letters. An empty set is a real identity (colourless), which
/// is not the same as having none — [`commander_identity`] answers `None` for that.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Identity(u8);

impl Identity {
    fn bit(colour: char) -> Option<u8> {
        COLOR_ORDER
            .iter()
            .position(|c| *c == colour)
            .map(|i| 1 << i)
    }

    /// Whether `colour` (one of WUBRG) is in it.
    pub fn has(self, colour: char) -> bool {
        Self::bit(colour).is_some_and(|b| self.0 & b != 0)
    }

    /// Every colour of `self` is in `other`.
    pub fn within(self, other: Identity) -> bool {
        self.0 & !other.0 == 0
    }

    pub fn union(self, other: Identity) -> Identity {
        Identity(self.0 | other.0)
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// The letters in WUBRG order, `""` for colourless.
    pub fn letters(self) -> String {
        COLOR_ORDER.iter().filter(|c| self.has(**c)).collect()
    }

    /// Read from concatenated letters, upper-cased first; anything not WUBRG is dropped.
    pub fn from_letters(letters: &str) -> Identity {
        let mut bits = 0;
        for c in letters.to_uppercase().chars() {
            bits |= Self::bit(c).unwrap_or(0);
        }
        Identity(bits)
    }
}

/// A card's colour identity — `identityOf`.
pub fn identity_of(card: &DeckCardRow) -> Identity {
    Identity::from_letters(card.color_identity.as_deref().unwrap_or(""))
}

/// The identity the deck is judged against: the union across the command zone (CR 702.124c), or
/// under Oathbreaker across its planeswalkers only; `None` when there is nothing to derive one
/// from, which is not the empty identity.
pub fn commander_identity(zone: &[&DeckCardRow], spec: &FormatSpecRow) -> Option<Identity> {
    let oathbreaker = spec.commander_rule.as_deref() == Some("oathbreaker");
    let definers: Vec<&&DeckCardRow> = zone
        .iter()
        .filter(|card| !oathbreaker || is_planeswalker_card(card))
        .collect();
    if definers.is_empty() {
        return None;
    }
    Some(
        definers
            .into_iter()
            .fold(Identity::default(), |union, card| {
                union.union(identity_of(card))
            }),
    )
}

/// CR 903.5c: every card must have a colour identity inside the commander's. One finding per row,
/// in the rows' order.
pub fn color_identity_issues(cards: &[&DeckCardRow], commander: Identity) -> Vec<ValidationIssue> {
    cards
        .iter()
        .filter_map(|card| {
            let identity = identity_of(card);
            if identity.within(commander) {
                return None;
            }
            Some(ValidationIssue::error(
                "color-identity",
                format!(
                    "{}'s color identity ({}) is outside your commander's ({}).",
                    card.name,
                    name_identity(identity),
                    name_identity(commander)
                ),
                Some(vec![card.card_id.clone()]),
            ))
        })
        .collect()
}

/// An identity as the reader sees it printed: WUBRG order, and a word for the empty set.
pub(crate) fn name_identity(identity: Identity) -> String {
    let letters = identity.letters();
    if letters.is_empty() {
        "colorless".to_owned()
    } else {
        letters
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_reads_letters_in_any_order_and_case() {
        let id = Identity::from_letters("gw");
        assert_eq!(id.letters(), "WG");
        assert!(Identity::from_letters("W").within(id));
        assert!(!Identity::from_letters("U").within(id));
        assert!(Identity::default().within(Identity::default()));
        assert_eq!(name_identity(Identity::default()), "colorless");
        assert_eq!(Identity::from_letters("C2").letters(), "");
    }

    #[test]
    fn type_line_halves() {
        assert_eq!(
            card_types_of("Legendary Creature \u{2014} Elf"),
            "Legendary Creature "
        );
        assert_eq!(
            subtypes_of("Legendary Creature \u{2014}  Time Lord Doctor "),
            "Time Lord Doctor"
        );
        assert_eq!(subtypes_of("Instant"), "");
    }
}
