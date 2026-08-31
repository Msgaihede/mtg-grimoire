//! Rows the chosen fields cannot tell apart become one row, with the copies summed — Rust's copy
//! of `src/features/transfer/export/fold.ts`.
//!
//! **A correctness rule wearing a formatting hat.** The collection's grain keeps 2 NM and 1 LP
//! Lightning Bolt as two rows on purpose. A plain-text mirror has no condition channel, so writing
//! them as two lines produces a file that names one card twice — and a reader pasting that into
//! Moxfield gets a deck with a duplicate in it. Fold on what the file can actually say, and the
//! same two rows separate again the moment Condition is switched on.
//!
//! The two quantity fields are **summed, never keyed on**: they are what folding accumulates.
//!
//! **The chosen `fields` are not the only thing a writer can tell rows apart by — the optional
//! `discriminator` is for the rest.** A field is something the reader can switch on or off; a
//! *structural* fact — which section a line lands under, whether a bracket carries `{noDeck}` — is
//! something the writer branches on unconditionally, whether or not the field that names it
//! (`category`) is in the chosen set. Folding on `fields` alone can merge a Sideboard row into a
//! Main deck row: the merged row inherits the *first* card's section, so each format's own
//! discriminator is what keeps a fold from crossing a line the file itself draws.

use super::fields::{read, FieldId};
use super::Card;
use std::collections::hash_map::Entry;
use std::collections::HashMap;

/// The two fields folding accumulates. Keying on either would defeat the whole exercise: two rows
/// alike in everything but their count would stay two lines naming one card.
const SUMMED: [FieldId; 2] = [FieldId::Quantity, FieldId::TradelistQuantity];

/// Fold `cards` down to the rows `fields` (plus `discriminator`) can still tell apart.
///
/// **Insertion order is the caller's order and stays the file's order.** Rust has no ordered
/// `HashMap` — TypeScript's `Map` is what carries this for free over there — so the output is a
/// `Vec` and the map holds an *index into it*: a first sighting pushes, a later one adds into the
/// row already sitting where it landed.
///
/// **The key is a `Vec<String>`, never a joined one.** TypeScript reaches for `JSON.stringify`
/// because it needs escaping: a joined key lets a card name — or a discriminator's own return
/// value — containing the separator collide with a genuinely different row. A vector of the values
/// themselves needs no escaping at all, which is the same guarantee reached more cheaply. The
/// discriminator's answer rides as one more entry in that same flat vector, `""` when there is no
/// discriminator, so a caller that passes one and a caller that does not build keys of the same
/// shape.
pub fn fold_for_fields(
    cards: &[Card],
    fields: &[FieldId],
    discriminator: Option<&dyn Fn(&Card) -> String>,
) -> Vec<Card> {
    let keyed: Vec<FieldId> = fields
        .iter()
        .copied()
        .filter(|id| !SUMMED.contains(id))
        .collect();
    let mut out: Vec<Card> = Vec::new();
    let mut at: HashMap<Vec<String>, usize> = HashMap::new();
    for card in cards {
        let mut key: Vec<String> = keyed.iter().map(|id| read(*id, card)).collect();
        key.push(discriminator.map_or_else(String::new, |d| d(card)));
        match at.entry(key) {
            Entry::Vacant(slot) => {
                slot.insert(out.len());
                out.push(card.clone());
            }
            Entry::Occupied(slot) => {
                let seen = &mut out[*slot.get()];
                seen.quantity += card.quantity;
                // `None` is absence, not poison: it contributes nothing to the sum but must never
                // suppress one. A group where every row is `None` stays `None` — the surface never
                // had the fact — but one known value anywhere in the group has to survive,
                // whichever row it arrived on.
                seen.tradelist_quantity = match (seen.tradelist_quantity, card.tradelist_quantity) {
                    (None, None) => None,
                    (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
                };
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A card with nothing to say but a name and a count. Every fixture below is this plus the one
    /// fact the test is about, so nothing a test does not name can be what makes it pass.
    fn base() -> Card {
        Card {
            name: "Lightning Bolt".into(),
            quantity: 1,
            set_code: None,
            collector_number: None,
            finish: None,
            lang: None,
            category_name: None,
            category_kind: None,
            category_active: None,
            condition: None,
            tradelist_quantity: None,
            purchase_price: None,
            purchase_currency: None,
            acquired_at: None,
            acquisition_source: None,
            serial_number: None,
            grading: None,
            altered: None,
            signed: None,
            proxy: None,
            misprint: None,
            tags: None,
            notes: None,
            set_name: None,
            rarity: None,
            type_line: None,
            unit_price: None,
            tag_name: None,
            tag_color: None,
            legalities: None,
        }
    }

    /// Two of the same printing, in Near Mint.
    fn nm_bolt() -> Card {
        Card {
            quantity: 2,
            condition: Some("NM".into()),
            ..base()
        }
    }

    /// One more of it, played. The collection keeps this as its own row on purpose.
    fn lp_bolt() -> Card {
        Card {
            quantity: 1,
            condition: Some("LP".into()),
            ..base()
        }
    }

    fn main_bolt() -> Card {
        Card {
            category_name: Some("Removal".into()),
            category_kind: Some("main".into()),
            ..base()
        }
    }

    fn side_bolt() -> Card {
        Card {
            category_name: Some("Sideboard".into()),
            category_kind: Some("side".into()),
            ..base()
        }
    }

    fn shock() -> Card {
        Card {
            name: "Shock".into(),
            ..base()
        }
    }

    #[test]
    fn two_rows_the_chosen_fields_cannot_tell_apart_become_one() {
        let cards = vec![nm_bolt(), lp_bolt()];
        let folded = fold_for_fields(&cards, &[FieldId::Quantity, FieldId::Name], None);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].quantity, 3);
    }

    #[test]
    fn and_separate_again_the_moment_condition_is_on() {
        let cards = vec![nm_bolt(), lp_bolt()];
        let folded = fold_for_fields(
            &cards,
            &[FieldId::Quantity, FieldId::Name, FieldId::Condition],
            None,
        );
        assert_eq!(folded.len(), 2);
        assert_eq!(folded[0].quantity, 2);
        assert_eq!(folded[1].quantity, 1);
    }

    #[test]
    fn a_discriminator_stops_a_sideboard_row_folding_into_a_main_deck_one() {
        let cards = vec![main_bolt(), side_bolt()];
        let section = |c: &Card| c.category_kind.clone().unwrap_or_default();
        let folded = fold_for_fields(&cards, &[FieldId::Quantity, FieldId::Name], Some(&section));
        assert_eq!(
            folded.len(),
            2,
            "a fold may never cross a line the file itself draws"
        );

        // And the other half, or the test above is only a claim about these two fixtures: with no
        // discriminator these same rows really do fold, so it is the discriminator doing the work
        // rather than some fact the two cards happen to differ in.
        let without = fold_for_fields(&cards, &[FieldId::Quantity, FieldId::Name], None);
        assert_eq!(without.len(), 1);
    }

    #[test]
    fn the_callers_order_is_the_files_order() {
        let cards = vec![shock(), nm_bolt(), lp_bolt()];
        let folded = fold_for_fields(&cards, &[FieldId::Quantity, FieldId::Name], None);
        assert_eq!(folded.len(), 2);
        assert_eq!(
            folded[0].name, "Shock",
            "insertion order must survive the fold"
        );
        assert_eq!(folded[1].name, "Lightning Bolt");
    }

    #[test]
    fn a_tradelist_quantity_is_summed_and_absence_never_suppresses_a_known_value() {
        let a = Card {
            tradelist_quantity: None,
            ..nm_bolt()
        };
        let b = Card {
            tradelist_quantity: Some(2),
            ..nm_bolt()
        };
        let folded = fold_for_fields(&[a, b], &[FieldId::Quantity, FieldId::Name], None);
        assert_eq!(folded[0].tradelist_quantity, Some(2));

        let both_none = vec![
            Card {
                tradelist_quantity: None,
                ..nm_bolt()
            };
            2
        ];
        let folded = fold_for_fields(&both_none, &[FieldId::Quantity, FieldId::Name], None);
        assert_eq!(
            folded[0].tradelist_quantity, None,
            "a surface without the fact keeps None"
        );

        // The other half of "summed, never keyed on", and the half the two tests above cannot
        // see: with the field itself switched **on**, two rows differing only in it still fold.
        // A collection CSV really does offer this column, so keying on it would write two lines
        // naming one card whenever the reader had listed some of a playset for trade.
        let a = Card {
            tradelist_quantity: Some(2),
            ..nm_bolt()
        };
        let b = Card {
            tradelist_quantity: Some(1),
            ..nm_bolt()
        };
        let folded = fold_for_fields(
            &[a, b],
            &[FieldId::Quantity, FieldId::Name, FieldId::TradelistQuantity],
            None,
        );
        assert_eq!(
            folded.len(),
            1,
            "a summed field is never part of the key, switched on or not"
        );
        assert_eq!(folded[0].tradelist_quantity, Some(3));
    }

    /// The `Vec<String>` key's own rule, which is the reason `JSON.stringify` is on the other
    /// side: a key joined into one string lets two genuinely different rows collide whenever a
    /// value can contain the separator — and here both keyed fields are free text a reader typed,
    /// so *every* separator is one of them. These two rows join to the same string under a comma
    /// and must still come out as two.
    #[test]
    fn a_value_holding_the_separator_cannot_make_two_rows_one() {
        let a = Card {
            name: "Ach! Hans, Run!".into(),
            tags: Some("burn".into()),
            ..base()
        };
        let b = Card {
            name: "Ach! Hans".into(),
            tags: Some(" Run!,burn".into()),
            ..base()
        };
        let folded = fold_for_fields(
            &[a, b],
            &[FieldId::Quantity, FieldId::Name, FieldId::Tags],
            None,
        );
        assert_eq!(folded.len(), 2, "the key must not be a joined string");
    }
}
