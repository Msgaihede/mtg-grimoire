//! A pile of cards as text — Rust's copy of `src/features/transfer/export/format.ts`.
//!
//! **A port, not a second design.** The TypeScript writer is the behaviour of record and the
//! golden files under `src/features/transfer/__golden__/` are what says so: 70 files, five
//! scenarios crossed with seven formats and two field sets, written from that writer and
//! reproduced here byte for byte by [`tests::every_golden_file_is_reproduced_byte_for_byte`].
//! When the two disagree, this file is wrong.
//!
//! LF and a trailing newline, always. The importer takes CRLF, a lone LF and a lone CR, so it
//! would read any of them — but a file this app wrote should have one answer, and `\n` is the
//! one every other tool in this space emits.
//!
//! An empty list is an empty string in every format, **CSV included**. A header row over no
//! rows is a file that claims to be a decklist and is not one. **That covers a list a format
//! empties for itself**: Arena and MTGO write only switched-on piles, so a deck that is
//! entirely maybeboard is an empty file in those two rather than a heading over nothing, and
//! [`omitted_count`] is what says so out loud.

use super::csv::csv_row;
use super::fields::{csv_header, read, FieldId, FIELD_IDS};
use super::fold::fold_for_fields;
use super::{Card, Format};
use std::borrow::Cow;

/// The maybeboard's heading, spelled once — it is `SECTION_CATEGORY.maybeboard`'s word read
/// backwards, and the importer's `SECTIONS` map is what reads it.
const MAYBEBOARD: &str = "Maybeboard";

/// What a kind is called in a format whose section vocabulary is fixed.
///
/// **No arm for `maybe` in the sense the word suggests** — nothing anywhere may branch on a
/// kind being `maybe`, and this does not: a pile whose kind is `maybe` but which the reader
/// has switched **on** counts toward the deck like any other, so it writes under `Deck`.
/// [`section_of`] is where a switched-*off* pile becomes a maybeboard, and it asks
/// `category_active` rather than the kind, which is the whole of what `is_active = 0` means.
/// Rewriting this entry to `Maybeboard` "because that is what it is called" is the bug that
/// rule exists to keep out — it would file a switched-on Maybeboard out of the deck it counts
/// toward, and leave a reader's own switched-off `Ramp` under `Deck` beside it.
///
/// **The fallback arm has no counterpart in TypeScript and exists because the types differ.**
/// Over there `KIND_SECTION` is a `Record<CategoryKind, string>` over a closed union, so the
/// compiler makes it total; here `Card::category_kind` is an `Option<String>` read from JSON,
/// which no match can exhaust.
///
/// **It answers `""`, which is what TypeScript answers, and the temptation to improve on that
/// is the reason this paragraph is long.** `KIND_SECTION[kind]` is `undefined` for a kind
/// outside the union, `sectionOf`'s guard tests `=== null` rather than `== null`, so the
/// `undefined` is returned and reaches `sectioned` as the empty string. A blank heading is not
/// a file anybody wants — but answering `Deck` here instead was three divergences rather than
/// one: the heading, the **sort position** (`sectioned` puts a key its order does not name
/// first, where `Deck` sorts third) and the **fold key**, which decides whether such a row
/// merges with a real main-deck row at all. Unreachable from the database, where
/// `deck_categories.kind` is CHECK-constrained to the five words; reachable through
/// `corpus.json`, where `Card::category_kind` is an unvalidated `Option<String>`. A port
/// reproduces what the original does, including where the original is unfortunate.
fn kind_section(kind: &str) -> &'static str {
    match kind {
        "commander" => "Commander",
        "companion" => "Companion",
        "side" => "Sideboard",
        "main" | "maybe" => "Deck",
        _ => "",
    }
}

/// The order sections come out in.
///
/// **The kind of list whose order *is* the information**, and deliberately not alphabetical.
/// It is the order a decklist is read in, from the zone the game starts with down to the cards
/// that are not in the deck at all; alphabetically it would open on `Commander`, then
/// `Companion`, `Deck`, `Maybeboard`, `Sideboard`, which puts the cards that count toward
/// nothing in the middle of the ones that do.
const SECTION_ORDER: [&str; 5] = ["Commander", "Companion", "Deck", "Sideboard", MAYBEBOARD];

/// The section a card writes under, or `None` on a surface that has no piles at all.
fn section_of(card: &Card) -> Option<&'static str> {
    let kind = card.category_kind.as_deref()?;
    Some(if card.category_active == Some(false) {
        MAYBEBOARD
    } else {
        kind_section(kind)
    })
}

/// The formats with no maybeboard, which therefore write **only** the piles that are switched
/// on.
///
/// One predicate rather than the same two-name test written at each of its two readers:
/// [`written`] and [`omitted_count`] are the two halves of one rule — what is left out, and how
/// much of it — and a drift between them is a number on screen that quietly stops describing
/// the file.
///
/// The test at each reader is `category_active` and never the kind: `is_active = 0` is the
/// whole of what a maybeboard is, and a reader's own switched-off pile behaves the same way.
fn active_only(format: Format) -> bool {
    matches!(format, Format::Arena | Format::Mtgo)
}

/// The `*F*` / `*E*` marker a line ends with, or `""` for the regular copy.
///
/// The one thing every text format here can say about a finish, and the channel `parse.ts`
/// reads back — a leading space included, so a caller appends it and nothing has to remember
/// not to emit a trailing one on a plain row.
///
/// **Not written by `arena` or `mtgo`**, which have no marker in the format; the finish is lost
/// on a round trip through either, which is the same thing already true of a category there.
fn finish_mark(card: &Card) -> &'static str {
    match card.finish.as_deref() {
        Some("foil") => " *F*",
        Some("etched") => " *E*",
        _ => "",
    }
}

/// Archidekt's `1x`; everyone else's `1`.
#[derive(Clone, Copy)]
enum SetCase {
    Upper,
    Lower,
}

#[derive(Clone, Copy)]
enum SetWrap {
    Parens,
    Brackets,
}

/// How one format shapes the segments a field set turns on.
#[derive(Clone, Copy)]
struct LineSpec {
    quantity_suffix: &'static str,
    set_case: SetCase,
    set_wrap: SetWrap,
}

fn line_spec(format: Format) -> LineSpec {
    match format {
        Format::Plain | Format::Mtgo | Format::Arena | Format::Moxfield | Format::Csv => LineSpec {
            quantity_suffix: "",
            set_case: SetCase::Upper,
            set_wrap: SetWrap::Parens,
        },
        // Lowercase against every other writer on purpose: it is what Archidekt itself emits,
        // and our own parser uppercases what it reads, so the round trip is unaffected either
        // way.
        Format::Archidekt => LineSpec {
            quantity_suffix: "x",
            set_case: SetCase::Lower,
            set_wrap: SetWrap::Parens,
        },
        Format::Tcgplayer => LineSpec {
            quantity_suffix: "",
            set_case: SetCase::Upper,
            set_wrap: SetWrap::Brackets,
        },
    }
}

/// One line, assembled from the segments the field set turns on.
///
/// **No per-format gating here, and that is the point.** The set handed in has already been
/// intersected with what this format can carry, so a `set_code` reaching this function is a
/// `set_code` the format has somewhere to put. Six line formats fall out of one composer and a
/// three-field spec.
fn write_line(card: &Card, fields: &[FieldId], spec: LineSpec) -> String {
    let mut parts = vec![
        format!("{}{}", card.quantity, spec.quantity_suffix),
        card.name.clone(),
    ];
    if fields.contains(&FieldId::SetCode) {
        if let Some(code) = card.set_code.as_deref().filter(|s| !s.is_empty()) {
            let set = match spec.set_case {
                SetCase::Lower => code.to_lowercase(),
                SetCase::Upper => code.to_uppercase(),
            };
            parts.push(match spec.set_wrap {
                SetWrap::Brackets => format!("[{set}]"),
                SetWrap::Parens => format!("({set})"),
            });
        }
    }
    // Absence and not emptiness, exactly as TypeScript spells it: an empty collector number is
    // still a collector number the card claims to have, and it writes the trailing space that
    // says so. Nothing in the corpus carries one; the asymmetry with the set code above is the
    // port being faithful rather than tidy.
    if fields.contains(&FieldId::CollectorNumber) {
        if let Some(number) = card.collector_number.as_deref() {
            parts.push(number.to_string());
        }
    }
    let mut line = parts.join(" ");
    if fields.contains(&FieldId::Category) {
        if let Some(name) = card.category_name.as_deref() {
            // `{noDeck}` is what makes an export and a re-import keep a maybeboard — the only
            // format here that can say it.
            let flag = if card.category_active == Some(false) {
                "{noDeck}"
            } else {
                ""
            };
            line.push_str(&format!(" [{name}{flag}]"));
        }
    }
    if fields.contains(&FieldId::Finish) {
        line.push_str(finish_mark(card));
    }
    // Archidekt's label. **Last on the line**, which is where Archidekt itself puts it and — not
    // by coincidence — the first thing `stripDecorations` peels: every pattern in that loop is
    // anchored to the end, so the tail has to come off before the bracket, and the bracket
    // before `*F*`.
    //
    // **No per-format test here**, exactly as there is none for the bracket or the finish: only
    // `archidekt` lists `Tag` in its format fields, so a set reaching this function with `Tag`
    // in it is a set a caret group belongs in. The colour is read off the card rather than off
    // a second field, because in this syntax it is part of the tag rather than a channel beside
    // it. A label whose colour this build cannot read writes the name alone, which the parser
    // reads straight back as a label with no colour.
    if fields.contains(&FieldId::Tag) {
        if let Some(tag) = card.tag_name.as_deref().filter(|t| !t.is_empty()) {
            let colour = match card.tag_color.as_deref() {
                Some(c) => format!(",{c}"),
                None => String::new(),
            };
            line.push_str(&format!(" ^{tag}{colour}^"));
        }
    }
    line
}

/// The cards a format will not write, in **copies**.
///
/// Only `arena` and `mtgo` leave anything out, and only a pile the reader has switched off:
/// neither format has a maybeboard, and writing one into an Arena deck produces an illegal
/// import at the other end. The dialog draws this number, so the omission is never silent.
///
/// Copies rather than rows because that is the sentence the reader is owed — six basic lands on
/// one row are six cards missing from the file, and "1 card" would be a true statement about
/// the array and a false one about the deck. `category_active == None` — a surface with no
/// piles at all — omits nothing, the same as a switched-on pile.
pub fn omitted_count(cards: &[Card], format: Format) -> i64 {
    if !active_only(format) {
        return 0;
    }
    cards
        .iter()
        .filter(|card| card.category_active == Some(false))
        .map(|card| card.quantity)
        .sum()
}

/// The cards a format writes, in the caller's own order.
fn written<'a>(cards: &'a [Card], format: Format) -> Cow<'a, [Card]> {
    if !active_only(format) {
        return Cow::Borrowed(cards);
    }
    Cow::Owned(
        cards
            .iter()
            .filter(|card| card.category_active != Some(false))
            .cloned()
            .collect(),
    )
}

/// Cards under headings: one group per key, **in first-appearance order**, or one flat list
/// with no heading at all when `key_of` answers `None` for every card — the shape a surface
/// with no piles writes.
///
/// First appearance is what keeps this file pure — the caller's array order is the file's
/// order, so a deck's own category order needs no second argument and no `DeckCategory` here.
/// A `Vec` of pairs rather than a map for [`fold_for_fields`]'s reason: Rust has no ordered
/// `HashMap`, and TypeScript's `Map` is what carries insertion order for free over there.
fn sectioned(
    cards: &[Card],
    key_of: &dyn Fn(&Card) -> Option<String>,
    write: &dyn Fn(&Card) -> String,
    order: Option<&[&str]>,
) -> String {
    if cards.iter().all(|card| key_of(card).is_none()) {
        return cards.iter().map(write).collect::<Vec<_>>().join("\n");
    }
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for card in cards {
        let key = key_of(card).unwrap_or_default();
        let line = write(card);
        match groups.iter_mut().find(|(name, _)| *name == key) {
            Some((_, rows)) => rows.push(line),
            None => groups.push((key, vec![line])),
        }
    }
    if let Some(order) = order {
        // A key the order does not name sorts first, which is `Array.prototype.indexOf`'s `-1`.
        // Both sorts are stable, so anything the order cannot separate keeps first-appearance
        // order.
        groups.sort_by_key(|(name, _)| {
            order
                .iter()
                .position(|section| *section == name.as_str())
                .map_or(-1_i64, |at| at as i64)
        });
    }
    groups
        .into_iter()
        .map(|(name, rows)| {
            let mut block = name;
            for row in rows {
                block.push('\n');
                block.push_str(&row);
            }
            block
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// What a format tells two rows apart by **beyond the fields the reader chose**.
type Discriminator = Box<dyn Fn(&Card) -> String>;

/// The structural facts [`format_export`]'s own match branches on unconditionally, handed to
/// [`fold_for_fields`] as its discriminator.
///
/// A field is something the reader can switch on or off; a format's *structure* is not — Arena
/// and Moxfield group by section and MTGO prefixes `SB:` from it whether or not `Category` is
/// among the chosen fields, so a Main deck row and a Sideboard row of the same printing must
/// never fold together on the strength of `Category` being off. Archidekt keys on the category
/// name **and** the active flag together, because it writes `{noDeck}` from the second and
/// would otherwise fold a switched-off copy into a switched-on one and silently drop the flag.
/// `Plain`, `Tcgplayer` and `Csv` key on nothing — they are flat and branch on nothing
/// structural, so two rows that agree on the chosen fields really are indistinguishable in that
/// file.
///
/// **A match with no wildcard arm, and that absence is the whole point.** A format this
/// function says nothing about is a format that folds with no discriminator at all — the same
/// silent Sideboard-into-Main-deck fold the arms below exist to close, reproduced by omission
/// for whichever format arrives next rather than by a typo anyone would catch. A new
/// [`Format`] variant fails to compile here; the explicit `None` says "checked, and flat"
/// rather than "not checked yet".
fn discriminator(format: Format) -> Option<Discriminator> {
    match format {
        // `section_of` answers `None` on a category-less surface, where there is nothing
        // structural to key on and every row shares the same `""` — folding is untouched there.
        Format::Arena => Some(Box::new(|card| section_of(card).unwrap_or_default().into())),
        Format::Moxfield => Some(Box::new(|card| section_of(card).unwrap_or_default().into())),
        Format::Mtgo => Some(Box::new(|card| section_of(card).unwrap_or_default().into())),
        // TypeScript reaches for `JSON.stringify([name, active])` because it needs a spelling of
        // the pair that cannot be forged by a name containing the separator. `Debug` is that
        // spelling here and is infallible where `serde_json::to_string` returns a `Result`: it
        // quotes and escapes the string, so no `category_name` can impersonate a different pair.
        Format::Archidekt => Some(Box::new(|card| {
            format!(
                "{:?}",
                (card.category_name.as_deref(), card.category_active)
            )
        })),
        Format::Plain => None,
        Format::Tcgplayer => None,
        Format::Csv => None,
    }
}

/// Render a pile of cards as decklist text in one of the seven [`Format`]s, over the fields the
/// reader chose.
///
/// An empty list is `""` in every format, CSV's header included — a header with nothing under
/// it is a file that claims to be a decklist and is not one. **A list a format empties for
/// itself answers the same way**: the filter runs first, so an Arena export of a deck that is
/// entirely maybeboard is `""` rather than a `Deck` heading over nothing. Every non-empty
/// result ends in a single trailing `\n`.
///
/// **Filter first, fold second, and the order is load-bearing.** Folding first can merge a
/// switched-off row into a switched-on one — the folded row inherits the FIRST card's
/// `category_active` — so an Arena export would carry copies that [`omitted_count`] reports as
/// omitted in the same breath. Filtering first means nothing inactive survives to be folded,
/// and the sentence beside the format stays true of the file under it.
///
/// **Fold may only merge rows the file itself cannot tell apart — see [`discriminator`].** A
/// foil and a regular copy of one printing in one Arena-eligible category really do collapse to
/// `3 Bolt (LTC) 285`, because Arena has no finish channel and two identical lines would be a
/// malformed decklist; the same two rows in different sections must not, because the merged row
/// would silently move one of them to the other's zone.
pub fn format_export(cards: &[Card], format: Format, fields: &[FieldId]) -> String {
    let keyed = discriminator(format);
    let rows = fold_for_fields(&written(cards, format), fields, keyed.as_deref());
    if rows.is_empty() {
        return String::new();
    }
    let spec = line_spec(format);
    let line = |card: &Card| write_line(card, fields, spec);

    let mut text = match format {
        Format::Plain => rows.iter().map(&line).collect::<Vec<_>>().join("\n"),
        // MTGO's own export omits the printing entirely — it resolves a name against whatever
        // copies a player owns rather than pinning one, so naming a set here would be a promise
        // this format was never in a position to keep. `SB:` is a one-line override rather than
        // a heading, which is exactly how the importer reads it back.
        Format::Mtgo => rows
            .iter()
            .map(|card| {
                let section = section_of(card);
                let prefix = if section == Some("Sideboard") || section == Some("Companion") {
                    "SB: "
                } else {
                    ""
                };
                format!("{prefix}{}", line(card))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        // Arena's and Moxfield's headings and lines differ only in which fields the reader has
        // switched on — Moxfield's defaults include `Finish`, Arena's do not — so one arm
        // covers both.
        Format::Arena | Format::Moxfield => sectioned(
            &rows,
            &|card| section_of(card).map(str::to_string),
            &line,
            Some(&SECTION_ORDER),
        ),
        // Grouped by the pile's own name rather than a section word, and in the caller's order:
        // a deck's array order is its category order, and imposing one here would re-file
        // somebody's deck on the way out.
        Format::Archidekt => sectioned(&rows, &|card| card.category_name.clone(), &line, None),
        // Flat, and grouped by nothing: Mass Entry reads every line as one item, so a heading
        // here would be read as a card. `written` has left the switched-off piles in — see the
        // writer.
        Format::Tcgplayer => rows.iter().map(&line).collect::<Vec<_>>().join("\n"),
        Format::Csv => {
            let columns: Vec<FieldId> = FIELD_IDS
                .iter()
                .copied()
                .filter(|id| fields.contains(id))
                .collect();
            let header = csv_row(
                &columns
                    .iter()
                    .map(|id| csv_header(*id).to_string())
                    .collect::<Vec<_>>(),
            );
            let mut lines = vec![header];
            for card in &rows {
                lines.push(csv_row(
                    &columns.iter().map(|id| read(*id, card)).collect::<Vec<_>>(),
                ));
            }
            lines.join("\n")
        }
    };
    text.push('\n');
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer::card::load_corpus;
    use crate::transfer::fields::{available_fields, default_fields};

    /// A card with nothing to say but a name and a count. Every fixture below is this plus the
    /// one fact the test is about, so nothing a test does not name can be what makes it pass.
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

    fn bolt() -> Card {
        base()
    }

    fn shock() -> Card {
        Card {
            name: "Shock".into(),
            ..base()
        }
    }

    /// In a pile the reader has switched on.
    fn active_bolt(quantity: i64) -> Card {
        Card {
            quantity,
            category_name: Some("Removal".into()),
            category_kind: Some("main".into()),
            category_active: Some(true),
            ..base()
        }
    }

    /// The same printing, in a pile the reader has switched off.
    fn inactive_bolt(quantity: i64) -> Card {
        Card {
            quantity,
            category_name: Some("Cuts".into()),
            category_kind: Some("main".into()),
            category_active: Some(false),
            ..base()
        }
    }

    fn side_bolt() -> Card {
        Card {
            category_name: Some("Sideboard".into()),
            category_kind: Some("side".into()),
            category_active: Some(true),
            ..base()
        }
    }

    /// The fence. `npm run golden` writes these files from the TypeScript writer; this asserts
    /// the Rust one reproduces them byte for byte. A drift in either is red here.
    #[test]
    fn every_golden_file_is_reproduced_byte_for_byte() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/features/transfer/__golden__");
        let scenarios = load_corpus(&dir.join("corpus.json"));

        let mut checked = 0usize;
        for (name, scenario) in &scenarios {
            for format in Format::ALL {
                for (set_name, fields) in [
                    ("all", available_fields(format, scenario.surface)),
                    ("default", default_fields(format, scenario.surface)),
                ] {
                    let file = dir.join(format!("{name}.{}.{set_name}.txt", format.key()));
                    let expected = std::fs::read_to_string(&file)
                        .unwrap_or_else(|e| panic!("{}: {e}", file.display()));
                    assert_eq!(
                        format_export(&scenario.cards, format, &fields),
                        expected,
                        "{} disagrees with the TypeScript writer",
                        file.display()
                    );
                    checked += 1;
                }
            }
        }
        assert_eq!(
            checked, 70,
            "the golden matrix changed size without this test noticing"
        );
    }

    #[test]
    fn arena_filters_before_it_folds() {
        // One printing, two rows: one in a switched-on pile, one switched off. Folding first
        // would merge them and carry the omitted copy into the file.
        let cards = vec![active_bolt(2), inactive_bolt(3)];
        let text = format_export(&cards, Format::Arena, &[FieldId::Quantity, FieldId::Name]);
        assert!(text.contains("2 Lightning Bolt"), "got: {text}");
        assert!(
            !text.contains("5 Lightning Bolt"),
            "the maybeboard copies leaked in: {text}"
        );
        assert_eq!(omitted_count(&cards, Format::Arena), 3);
    }

    /// The test above is a regression test for the *output*, and it is **not** sensitive to the
    /// filter/fold order — measured, not assumed. Arena's discriminator is [`section_of`],
    /// which already encodes `category_active`, so a switched-off deck row keys on
    /// `"Maybeboard"` and a switched-on one on `"Deck"` and the two cannot fold whichever order
    /// runs first.
    ///
    /// The order bites on the one shape the discriminator is blind to: a row that carries
    /// `category_active` without a kind, where `section_of` is `None` and every row shares the
    /// same `""`. Folding first merges 2 + 3 into a row that inherits the **first** card's
    /// `category_active` and then survives the filter — five copies in a file that reports
    /// three of them omitted. Filtering first leaves two.
    #[test]
    fn filtering_first_is_what_keeps_a_switched_off_copy_out_of_an_arena_file() {
        let on = Card {
            quantity: 2,
            category_active: Some(true),
            ..base()
        };
        let off = Card {
            quantity: 3,
            category_active: Some(false),
            ..base()
        };
        let cards = vec![on, off];
        let text = format_export(&cards, Format::Arena, &[FieldId::Quantity, FieldId::Name]);
        assert_eq!(text, "2 Lightning Bolt\n", "the fold ran before the filter");
        assert_eq!(omitted_count(&cards, Format::Arena), 3);
    }

    /// And the other direction, which loses copies rather than inventing them: with the
    /// switched-off row **first**, folding first produces a row carrying `Some(false)` that the
    /// filter then throws away whole — the two switched-on copies going with it, silently.
    #[test]
    fn and_folding_first_would_swallow_the_switched_on_copies_behind_a_switched_off_row() {
        let off = Card {
            quantity: 3,
            category_active: Some(false),
            ..base()
        };
        let on = Card {
            quantity: 2,
            category_active: Some(true),
            ..base()
        };
        let text = format_export(
            &[off, on],
            Format::Arena,
            &[FieldId::Quantity, FieldId::Name],
        );
        assert_eq!(
            text, "2 Lightning Bolt\n",
            "the switched-on copies vanished"
        );
    }

    #[test]
    fn a_switched_on_maybe_pile_writes_under_deck_and_a_switched_off_ramp_does_not() {
        let on = Card {
            category_kind: Some("maybe".into()),
            category_active: Some(true),
            ..bolt()
        };
        let off = Card {
            category_name: Some("Ramp".into()),
            category_kind: Some("main".into()),
            category_active: Some(false),
            ..shock()
        };
        let text = format_export(
            &[on, off],
            Format::Moxfield,
            &[FieldId::Quantity, FieldId::Name],
        );
        let deck = text.find("Deck").unwrap();
        let maybe = text.find("Maybeboard").unwrap();
        assert!(deck < maybe);
        assert!(text[deck..maybe].contains("Lightning Bolt"));
        assert!(text[maybe..].contains("Shock"));
    }

    #[test]
    fn mtgo_prefixes_a_sideboard_card_and_names_no_printing() {
        let text = format_export(
            &[side_bolt()],
            Format::Mtgo,
            &[FieldId::Quantity, FieldId::Name],
        );
        assert_eq!(text, "SB: 1 Lightning Bolt\n");
    }

    #[test]
    fn an_empty_list_is_an_empty_string_in_every_format_csv_included() {
        for format in Format::ALL {
            assert_eq!(format_export(&[], format, &FIELD_IDS), "", "{format:?}");
        }
    }

    #[test]
    fn a_deck_that_is_entirely_maybeboard_is_empty_in_arena_rather_than_a_heading_over_nothing() {
        let text = format_export(
            &[inactive_bolt(1)],
            Format::Arena,
            &[FieldId::Quantity, FieldId::Name],
        );
        assert_eq!(text, "");
    }

    #[test]
    fn every_non_empty_file_ends_in_exactly_one_newline() {
        for format in Format::ALL {
            let text = format_export(&[bolt()], format, &FIELD_IDS);
            assert!(
                text.ends_with('\n') && !text.ends_with("\n\n"),
                "{format:?}: {text:?}"
            );
        }
    }

    /// The half of Archidekt's discriminator no golden file can reach: both field sets there
    /// carry `Category`, so the *name* half is already keyed as an ordinary field and only the
    /// active flag needs the discriminator. Two rows of one printing under one pile name, one
    /// switched off, must stay two lines — the merged row would inherit the first card's flag
    /// and silently drop `{noDeck}` from three copies.
    #[test]
    fn an_archidekt_fold_never_crosses_the_active_flag() {
        let on = Card {
            quantity: 1,
            category_name: Some("Cuts".into()),
            category_kind: Some("main".into()),
            category_active: Some(true),
            ..base()
        };
        let off = Card {
            category_active: Some(false),
            ..on.clone()
        };
        let text = format_export(
            &[on, off],
            Format::Archidekt,
            &[FieldId::Quantity, FieldId::Name, FieldId::Category],
        );
        assert_eq!(
            text,
            "Cuts\n1x Lightning Bolt [Cuts]\n1x Lightning Bolt [Cuts{noDeck}]\n"
        );

        // And the other half, or the assertion above is only a claim about these two fixtures:
        // with `Category` switched **off** the two rows agree on every chosen field, so the
        // discriminator is the only thing keeping them apart.
        let on = Card {
            category_name: Some("Cuts".into()),
            category_kind: Some("main".into()),
            category_active: Some(true),
            ..base()
        };
        let off = Card {
            category_active: Some(false),
            ..on.clone()
        };
        let text = format_export(
            &[on, off],
            Format::Archidekt,
            &[FieldId::Quantity, FieldId::Name],
        );
        assert_eq!(text, "Cuts\n1x Lightning Bolt\n1x Lightning Bolt\n");
    }

    /// TCGplayer is a cart rather than a decklist: the pile a reader switched off is usually
    /// exactly what they still have to buy, so it keeps those rows and reports nothing omitted.
    /// The dialog's omission line never fires for it, and `plain` and `csv` answer the same way.
    #[test]
    fn only_arena_and_mtgo_omit_anything_and_they_count_copies_rather_than_rows() {
        // Two different cards, because TCGplayer keys on nothing structural: two rows of *one*
        // printing across a switched-off pile boundary really do fold there, and folding is not
        // what this test is about.
        let cut = Card {
            quantity: 4,
            category_name: Some("Cuts".into()),
            category_kind: Some("main".into()),
            category_active: Some(false),
            ..shock()
        };
        let cards = vec![active_bolt(1), cut];
        for format in Format::ALL {
            let expected = if matches!(format, Format::Arena | Format::Mtgo) {
                4
            } else {
                0
            };
            assert_eq!(omitted_count(&cards, format), expected, "{format:?}");
        }
        let text = format_export(
            &cards,
            Format::Tcgplayer,
            &[FieldId::Quantity, FieldId::Name],
        );
        assert_eq!(text, "1 Lightning Bolt\n4 Shock\n");
        assert_eq!(
            format_export(&cards, Format::Arena, &[FieldId::Quantity, FieldId::Name]),
            "Deck\n1 Lightning Bolt\n",
            "Arena cuts the pile TCGplayer keeps"
        );
    }

    /// A flat format keys on nothing structural, so two rows in different sections really are
    /// indistinguishable in that file and fold. The same two rows in Arena must not — which is
    /// the whole of what the discriminator buys, checked from both ends here.
    #[test]
    fn a_flat_format_folds_two_sections_together_and_a_sectioned_one_does_not() {
        let cards = vec![active_bolt(2), side_bolt()];
        let fields = [FieldId::Quantity, FieldId::Name];
        assert_eq!(
            format_export(&cards, Format::Plain, &fields),
            "3 Lightning Bolt\n"
        );
        assert_eq!(
            format_export(&cards, Format::Arena, &fields),
            "Deck\n2 Lightning Bolt\n\nSideboard\n1 Lightning Bolt\n"
        );
    }

    /// **M12: a `category_kind` outside the five words answers `""`, which is what TypeScript
    /// answers, and it is three facts rather than one.** `KIND_SECTION[kind]` is `undefined`
    /// over there and `sectionOf`'s guard tests `=== null`, so the blank reaches `sectioned` —
    /// where a key the order does not name sorts **first**, and folds against a key of its own.
    /// This arm answered `Deck` and so disagreed on the heading, on the sort position (third)
    /// and on whether such a row merges with a real main-deck row.
    ///
    /// Unreachable from the database — `deck_categories.kind` is CHECK-constrained to the five
    /// — and reachable through `corpus.json`, where `Card::category_kind` is an unvalidated
    /// `Option<String>`. No golden file can hold it for that reason, which is why this is a
    /// targeted test rather than a scenario.
    #[test]
    fn a_kind_outside_the_five_words_writes_a_blank_heading_sorted_first() {
        let odd = Card {
            name: "Chittering Rats".into(),
            category_name: Some("Tokens".into()),
            category_kind: Some("tokens".into()),
            category_active: Some(true),
            ..base()
        };
        let text = format_export(
            &[active_bolt(2), odd],
            Format::Moxfield,
            &[FieldId::Quantity, FieldId::Name],
        );
        assert_eq!(
            text, "\n1 Chittering Rats\n\nDeck\n2 Lightning Bolt\n",
            "a kind the app cannot classify files under a blank heading, first"
        );
    }

    /// `SECTION_ORDER` is a **sort**, and until this test nothing held it to being one: every
    /// scenario in the corpus happens to list its piles in section order already, so a
    /// mutation that dropped the order argument entirely — grouping in first-appearance order
    /// like Archidekt — left all 70 golden files and every other test here green. A deck whose
    /// maybeboard and sideboard are listed *before* its first main-deck card is what tells a
    /// sort from an accident, and it is an ordinary deck: the array is the reader's own
    /// category order, which nothing obliges to run Commander-first.
    #[test]
    fn the_sections_are_sorted_rather_than_written_in_the_order_the_piles_arrive() {
        let pile = |name: &str, kind: &str, active: bool| Card {
            name: name.into(),
            category_name: Some(kind.into()),
            category_kind: Some(kind.into()),
            category_active: Some(active),
            ..base()
        };
        let cards = vec![
            pile("Mana Crypt", "main", false),
            pile("Pyroblast", "side", true),
            pile("Lightning Bolt", "main", true),
            pile("Lurrus of the Dream-Den", "companion", true),
            pile("Bruna, Light of Alabaster", "commander", true),
        ];
        assert_eq!(
            format_export(
                &cards,
                Format::Moxfield,
                &[FieldId::Quantity, FieldId::Name]
            ),
            "Commander\n1 Bruna, Light of Alabaster\n\n\
             Companion\n1 Lurrus of the Dream-Den\n\n\
             Deck\n1 Lightning Bolt\n\n\
             Sideboard\n1 Pyroblast\n\n\
             Maybeboard\n1 Mana Crypt\n"
        );
    }

    /// An empty set code is not a set code — the wishlist really holds one, from an exporter
    /// that had a collector number and no set and wrote the parentheses anyway. The number
    /// survives; the brackets do not.
    #[test]
    fn an_empty_set_code_writes_no_printing_hint_but_keeps_the_collector_number() {
        let card = Card {
            set_code: Some(String::new()),
            collector_number: Some("76".into()),
            ..base()
        };
        let fields = [
            FieldId::Quantity,
            FieldId::Name,
            FieldId::SetCode,
            FieldId::CollectorNumber,
        ];
        assert_eq!(
            format_export(&[card], Format::Tcgplayer, &fields),
            "1 Lightning Bolt 76\n"
        );
    }
}
