//! What a file can say about a card, and which formats and surfaces can say it — Rust's copy of
//! `src/features/transfer/fields.ts`.
//!
//! **Two independent declarations, and a caller draws their intersection.** A *format* says what
//! channels it has — Arena's line has nowhere to put a finish, so Arena does not offer one. A
//! *surface* says what facts it holds — a wishlist has no piles, so no wishlist mirror offers a
//! category. Neither declaration knows about the other, which is what stops this becoming a
//! per-surface list of things to remember to hide.
//!
//! **There is no `label` here, and that is deliberate.** A checkbox's word belongs to the export
//! dialog, which stays TypeScript; porting the labels would create a second place for a word to
//! drift with nothing on this side reading it. What is ported is the two declarations, the CSV
//! header (which is data — a file's column name, and what a reader matches an incoming header
//! against) and the read.

use super::{Card, Format, Surface};

/// Every field, **in the order a CSV writes its columns**.
///
/// `TRANSFER_FIELD_IDS`' order, variant for variant. The first six are today's deck CSV header
/// spelled in today's order, which is what makes [`default_fields`] for `(Csv, Deck)` a
/// byte-for-byte reproduction of what shipped — `Tag` and `TagColor` sit *after* them on purpose,
/// because inserting into the six would change the column order of every CSV already written for
/// a field that is switched off by default there.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FieldId {
    Quantity,
    Name,
    SetCode,
    CollectorNumber,
    Category,
    Finish,
    /// The deck label — one row of `deck_tags`, by name.
    ///
    /// **`Tag` against the collection's `Tags` three rows down, and the near-collision is
    /// deliberate rather than survived.** They are two different facts (a `deck_tags` row against
    /// `collection_entries.tags`, free text), and no surface holds both — [`surface_fields`]
    /// gives this one to the deck and that one to the collection — so the two columns can never
    /// be in one file. Renaming either would cost every reader who already has a `Tags` column,
    /// for a confusion the registry cannot actually produce.
    Tag,
    /// That label's colour, and **a field only because a CSV cell holds one value.**
    ///
    /// Archidekt writes the pair as `^Keeper,#4aab08^`, so its writer reads the colour off the
    /// card whenever `Tag` is on and offers no box of its own. A CSV has to spend a column, so it
    /// gets one, off by default: the colour repeats down every row wearing that label, and it
    /// only decides anything on the way back in for a label the importing database has never
    /// seen.
    TagColor,
    Condition,
    Lang,
    TradelistQuantity,
    PurchasePrice,
    PurchaseCurrency,
    AcquiredAt,
    AcquisitionSource,
    SerialNumber,
    Grading,
    Altered,
    Signed,
    Proxy,
    Misprint,
    /// The collection's free-text `collection_entries.tags` — see [`FieldId::Tag`].
    Tags,
    Notes,
    SetName,
    Rarity,
    TypeLine,
    UnitPrice,
}

/// Every field in registry order. The array **is** the column order: everything that produces a
/// field list filters this rather than building one of its own.
pub const FIELD_IDS: [FieldId; 27] = [
    FieldId::Quantity,
    FieldId::Name,
    FieldId::SetCode,
    FieldId::CollectorNumber,
    FieldId::Category,
    FieldId::Finish,
    FieldId::Tag,
    FieldId::TagColor,
    FieldId::Condition,
    FieldId::Lang,
    FieldId::TradelistQuantity,
    FieldId::PurchasePrice,
    FieldId::PurchaseCurrency,
    FieldId::AcquiredAt,
    FieldId::AcquisitionSource,
    FieldId::SerialNumber,
    FieldId::Grading,
    FieldId::Altered,
    FieldId::Signed,
    FieldId::Proxy,
    FieldId::Misprint,
    FieldId::Tags,
    FieldId::Notes,
    FieldId::SetName,
    FieldId::Rarity,
    FieldId::TypeLine,
    FieldId::UnitPrice,
];

/// What no format may omit. A line with no count and no name is not a card.
pub const ALWAYS: [FieldId; 2] = [FieldId::Quantity, FieldId::Name];

/// The field's wire word — the string `TRANSFER_FIELD_IDS` spells it with.
///
/// **A spelling, not a label, and not the CSV header either** — [`Format::key`] one file over,
/// for the same reason. It is what `__golden__/fields.json` names a field by, so the registry
/// fence can compare the two implementations' field lists id for id rather than only through
/// the bytes a CSV header row happens to expose. A wrong entry here is a red
/// `every_format_and_surface_offers_the_fields_typescript_says` rather than a silent
/// mismatch: the golden is written from TypeScript's own ids.
pub fn key(id: FieldId) -> &'static str {
    match id {
        FieldId::Quantity => "quantity",
        FieldId::Name => "name",
        FieldId::SetCode => "setCode",
        FieldId::CollectorNumber => "collectorNumber",
        FieldId::Category => "category",
        FieldId::Finish => "finish",
        FieldId::Tag => "tag",
        FieldId::TagColor => "tagColor",
        FieldId::Condition => "condition",
        FieldId::Lang => "lang",
        FieldId::TradelistQuantity => "tradelistQuantity",
        FieldId::PurchasePrice => "purchasePrice",
        FieldId::PurchaseCurrency => "purchaseCurrency",
        FieldId::AcquiredAt => "acquiredAt",
        FieldId::AcquisitionSource => "acquisitionSource",
        FieldId::SerialNumber => "serialNumber",
        FieldId::Grading => "grading",
        FieldId::Altered => "altered",
        FieldId::Signed => "signed",
        FieldId::Proxy => "proxy",
        FieldId::Misprint => "misprint",
        FieldId::Tags => "tags",
        FieldId::Notes => "notes",
        FieldId::SetName => "setName",
        FieldId::Rarity => "rarity",
        FieldId::TypeLine => "typeLine",
        FieldId::UnitPrice => "unitPrice",
    }
}

/// The CSV column name — and what a CSV *reader* matches an incoming header against.
///
/// **Data rather than a label**: the words here are written into files and read back out of
/// them, which is why they are ported and the checkbox captions are not.
pub fn csv_header(id: FieldId) -> &'static str {
    match id {
        FieldId::Quantity => "Quantity",
        FieldId::Name => "Name",
        FieldId::SetCode => "Set",
        FieldId::CollectorNumber => "Collector number",
        FieldId::Category => "Category",
        FieldId::Finish => "Finish",
        FieldId::Tag => "Tag",
        FieldId::TagColor => "Tag colour",
        FieldId::Condition => "Condition",
        FieldId::Lang => "Language",
        FieldId::TradelistQuantity => "Tradelist quantity",
        FieldId::PurchasePrice => "Purchase price",
        FieldId::PurchaseCurrency => "Purchase currency",
        FieldId::AcquiredAt => "Acquired",
        FieldId::AcquisitionSource => "Acquired from",
        FieldId::SerialNumber => "Serial number",
        FieldId::Grading => "Grading",
        FieldId::Altered => "Altered",
        FieldId::Signed => "Signed",
        FieldId::Proxy => "Proxy",
        FieldId::Misprint => "Misprint",
        FieldId::Tags => "Tags",
        FieldId::Notes => "Notes",
        FieldId::SetName => "Set name",
        FieldId::Rarity => "Rarity",
        FieldId::TypeLine => "Type line",
        FieldId::UnitPrice => "Price",
    }
}

/// `"yes"` / `"no"` / `""` — the third answer is a card that has nothing to say, not a `false`.
fn flag(v: Option<bool>) -> String {
    match v {
        Some(true) => "yes".to_string(),
        Some(false) => "no".to_string(),
        None => String::new(),
    }
}

/// `""` for `None`, and **never `0`** — `unwrap_or_default` here would write a tradelist quantity
/// of zero into every row of a surface that has no tradelist at all.
fn num_i(v: Option<i64>) -> String {
    match v {
        Some(n) => n.to_string(),
        None => String::new(),
    }
}

/// The same rule for a price.
///
/// Rust's `f64` Display is the shortest representation that round-trips, which is what JavaScript's
/// `String(n)` gives too — so `2.5` is `2.5` and `2.0` is `2` on both sides.
///
/// **They part company in five places, not one** (measured both ways on 2026-08-25, debug build:
/// `node -e` against `rustc -O`):
///
/// | value | JavaScript | Rust |
/// | --- | --- | --- |
/// | `-0.0` | `0` | `-0` |
/// | `1e-7` (and anything below `1e-6`) | `1e-7` | `0.0000001` |
/// | `5e-7` | `5e-7` | `0.0000005` |
/// | `1e21` and above | `1e+21` | `1000000000000000000000` |
/// | infinity | `Infinity` / `-Infinity` | `inf` / `-inf` |
///
/// `NaN` agrees. **None of the five is reachable for a price** through any write the app offers —
/// `collection_entries.purchase_price` is an unconstrained `REAL`, so a hand-edited `0.0000005`
/// would write `5e-7` from the export dialog and `0.0000005` from the mirror, and that is the
/// whole of the exposure. The sentence here used to name only `1e21`, which is how a note that
/// no build checks comes to be four cases short.
fn num_f(v: Option<f64>) -> String {
    match v {
        Some(n) => n.to_string(),
        None => String::new(),
    }
}

/// A borrowed string, or `""` when the card has nothing to say.
fn text(v: &Option<String>) -> String {
    v.as_deref().unwrap_or_default().to_string()
}

/// What this card says in this field — **`""` when it has nothing to say**, which is what an
/// empty cell means.
pub fn read(id: FieldId, card: &Card) -> String {
    match id {
        FieldId::Quantity => card.quantity.to_string(),
        FieldId::Name => card.name.clone(),
        FieldId::SetCode => text(&card.set_code),
        FieldId::CollectorNumber => text(&card.collector_number),
        FieldId::Category => text(&card.category_name),
        FieldId::Finish => text(&card.finish),
        FieldId::Tag => text(&card.tag_name),
        FieldId::TagColor => text(&card.tag_color),
        FieldId::Condition => text(&card.condition),
        FieldId::Lang => text(&card.lang),
        FieldId::TradelistQuantity => num_i(card.tradelist_quantity),
        FieldId::PurchasePrice => num_f(card.purchase_price),
        FieldId::PurchaseCurrency => text(&card.purchase_currency),
        FieldId::AcquiredAt => text(&card.acquired_at),
        FieldId::AcquisitionSource => text(&card.acquisition_source),
        FieldId::SerialNumber => text(&card.serial_number),
        FieldId::Grading => text(&card.grading),
        FieldId::Altered => flag(card.altered),
        FieldId::Signed => flag(card.signed),
        FieldId::Proxy => flag(card.proxy),
        FieldId::Misprint => flag(card.misprint),
        FieldId::Tags => text(&card.tags),
        FieldId::Notes => text(&card.notes),
        FieldId::SetName => text(&card.set_name),
        FieldId::Rarity => text(&card.rarity),
        FieldId::TypeLine => text(&card.type_line),
        FieldId::UnitPrice => num_f(card.unit_price),
    }
}

/// The printing pair, which five of the seven formats offer together or not at all.
const PRINTING: [FieldId; 2] = [FieldId::SetCode, FieldId::CollectorNumber];

/// What one format can carry, and what is on before anybody chooses.
struct FormatFields {
    /// What may be switched on. [`ALWAYS`] is implicit and never listed here.
    optional: &'static [FieldId],
    /// What is on by default — chosen to reproduce today's output byte for byte.
    default_on: &'static [FieldId],
}

const ARENA: [FieldId; 2] = PRINTING;
const MOXFIELD: [FieldId; 3] = [FieldId::SetCode, FieldId::CollectorNumber, FieldId::Finish];
/// **`Tag` and not `TagColor`**: the colour rides inside `^Keeper,#4aab08^`, so it is part of what
/// `Tag` writes here rather than a channel of its own. On by default like this format's other
/// four — Archidekt's defaults are everything Archidekt can say, and the caret group is something
/// Archidekt itself emits.
const ARCHIDEKT: [FieldId; 5] = [
    FieldId::SetCode,
    FieldId::CollectorNumber,
    FieldId::Finish,
    FieldId::Category,
    FieldId::Tag,
];
/// CSV's defaults are a deliberate core with everything else opt-in. `Condition` is among them so
/// a collection CSV separates a NM copy from an LP one without the reader having to know that is
/// what makes them two rows; on a deck it is not available and drops out.
const CSV_DEFAULT_ON: [FieldId; 5] = [
    FieldId::SetCode,
    FieldId::CollectorNumber,
    FieldId::Category,
    FieldId::Finish,
    FieldId::Condition,
];

/// `FORMAT_FIELDS`, one arm per format.
fn format_fields(format: Format) -> FormatFields {
    match format {
        Format::Plain => FormatFields {
            optional: &[FieldId::Finish],
            default_on: &[FieldId::Finish],
        },
        // MTGO's `SB:` is structure, not a field, and the format says nothing else about a card.
        Format::Mtgo => FormatFields {
            optional: &[],
            default_on: &[],
        },
        Format::Arena => FormatFields {
            optional: &ARENA,
            default_on: &ARENA,
        },
        Format::Moxfield => FormatFields {
            optional: &MOXFIELD,
            default_on: &MOXFIELD,
        },
        Format::Archidekt => FormatFields {
            optional: &ARCHIDEKT,
            default_on: &ARCHIDEKT,
        },
        Format::Tcgplayer => FormatFields {
            optional: &PRINTING,
            default_on: &PRINTING,
        },
        // Everything, and the surface is what narrows it.
        Format::Csv => FormatFields {
            optional: &FIELD_IDS,
            default_on: &CSV_DEFAULT_ON,
        },
    }
}

/// `SURFACE_FIELDS` — what facts each of the app's three lists holds.
pub fn surface_fields(surface: Surface) -> &'static [FieldId] {
    match surface {
        Surface::Deck => &[
            FieldId::Quantity,
            FieldId::Name,
            FieldId::SetCode,
            FieldId::CollectorNumber,
            FieldId::Category,
            FieldId::Finish,
            FieldId::Tag,
            FieldId::TagColor,
            FieldId::Lang,
            FieldId::SetName,
            FieldId::Rarity,
            FieldId::TypeLine,
            FieldId::UnitPrice,
        ],
        Surface::Collection => &[
            FieldId::Quantity,
            FieldId::Name,
            FieldId::SetCode,
            FieldId::CollectorNumber,
            FieldId::Finish,
            FieldId::Condition,
            FieldId::Lang,
            FieldId::TradelistQuantity,
            FieldId::PurchasePrice,
            FieldId::PurchaseCurrency,
            FieldId::AcquiredAt,
            FieldId::AcquisitionSource,
            FieldId::SerialNumber,
            FieldId::Grading,
            FieldId::Altered,
            FieldId::Signed,
            FieldId::Proxy,
            FieldId::Misprint,
            FieldId::Tags,
            FieldId::Notes,
            FieldId::SetName,
            FieldId::Rarity,
            FieldId::TypeLine,
            FieldId::UnitPrice,
        ],
        // No `SetName`: a `WishRow` carries a set code and nothing about the set.
        Surface::Wishlist => &[
            FieldId::Quantity,
            FieldId::Name,
            FieldId::SetCode,
            FieldId::CollectorNumber,
            FieldId::Finish,
            FieldId::Lang,
            FieldId::Notes,
            FieldId::Rarity,
            FieldId::TypeLine,
            FieldId::UnitPrice,
        ],
    }
}

/// The intersection, **in [`FIELD_IDS`] order** — which is what makes a CSV's columns stable.
///
/// Filtering the registry rather than walking either declaration is the whole of it: a format's
/// list and a surface's list are each written for a human to read, and either could be spelled in
/// any order tomorrow without a file's columns moving.
pub fn available_fields(format: Format, surface: Surface) -> Vec<FieldId> {
    let offered = format_fields(format);
    let held = surface_fields(surface);
    FIELD_IDS
        .iter()
        .copied()
        .filter(|id| (ALWAYS.contains(id) || offered.optional.contains(id)) && held.contains(id))
        .collect()
}

/// What is on before anybody chooses: the format's defaults, narrowed to what the surface has.
pub fn default_fields(format: Format, surface: Surface) -> Vec<FieldId> {
    let offered = format_fields(format);
    available_fields(format, surface)
        .into_iter()
        .filter(|id| ALWAYS.contains(id) || offered.default_on.contains(id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every field `None` but the two `ALWAYS` ones — which is what "this card has nothing to
    /// say" looks like, and the row every read test starts from.
    fn sample() -> Card {
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

    #[test]
    fn the_intersection_is_the_registry_order_not_the_declaration_order() {
        let got = available_fields(Format::Csv, Surface::Collection);
        let mut sorted = got.clone();
        sorted.sort_by_key(|f| FIELD_IDS.iter().position(|x| x == f).unwrap());
        assert_eq!(
            got, sorted,
            "a CSV's columns must come out in registry order"
        );
    }

    /// The test above cannot see a reordered [`FIELD_IDS`], because it sorts by that same array —
    /// so this one pins the columns themselves. It is what goes red when a field is moved into
    /// the first six, which is the change the registry's own comment forbids.
    #[test]
    fn the_csv_deck_columns_are_pinned_in_registry_order() {
        assert_eq!(
            available_fields(Format::Csv, Surface::Deck),
            vec![
                FieldId::Quantity,
                FieldId::Name,
                FieldId::SetCode,
                FieldId::CollectorNumber,
                FieldId::Category,
                FieldId::Finish,
                FieldId::Tag,
                FieldId::TagColor,
                FieldId::Lang,
                FieldId::SetName,
                FieldId::Rarity,
                FieldId::TypeLine,
                FieldId::UnitPrice,
            ]
        );
    }

    #[test]
    fn a_deck_offers_no_condition_and_a_wishlist_offers_no_category() {
        assert!(!available_fields(Format::Csv, Surface::Deck).contains(&FieldId::Condition));
        assert!(!available_fields(Format::Csv, Surface::Wishlist).contains(&FieldId::Category));
        assert!(available_fields(Format::Csv, Surface::Collection).contains(&FieldId::Condition));
    }

    #[test]
    fn archidekt_offers_the_label_and_not_its_colour() {
        let f = available_fields(Format::Archidekt, Surface::Deck);
        assert!(
            f.contains(&FieldId::Tag),
            "the caret group is Archidekt's own"
        );
        assert!(
            !f.contains(&FieldId::TagColor),
            "the colour rides inside the group"
        );
    }

    #[test]
    fn mtgo_offers_nothing_optional_at_all() {
        assert_eq!(
            available_fields(Format::Mtgo, Surface::Deck),
            vec![FieldId::Quantity, FieldId::Name]
        );
    }

    /// Today's deck CSV header, spelled in today's order — the byte-for-byte claim the registry's
    /// first six exist to keep.
    #[test]
    fn the_deck_csv_defaults_are_todays_six_column_header() {
        let header: Vec<&str> = default_fields(Format::Csv, Surface::Deck)
            .into_iter()
            .map(csv_header)
            .collect();
        assert_eq!(
            header,
            vec![
                "Quantity",
                "Name",
                "Set",
                "Collector number",
                "Category",
                "Finish"
            ]
        );
    }

    /// A CSV reader matches an incoming header against these words, so two fields sharing one
    /// would make a column unreadable — and a duplicate entry in [`FIELD_IDS`] shows up here too.
    #[test]
    fn no_two_fields_share_a_csv_header() {
        let mut seen = std::collections::HashSet::new();
        for id in FIELD_IDS {
            let header = csv_header(id);
            assert!(!header.is_empty(), "{id:?} has no CSV column name");
            assert!(
                seen.insert(header),
                "two fields both write the {header} column"
            );
        }
    }

    #[test]
    fn absence_reads_as_an_empty_cell_and_a_false_flag_reads_as_no() {
        let card = Card {
            altered: Some(false),
            proxy: None,
            notes: None,
            ..sample()
        };
        assert_eq!(read(FieldId::Altered, &card), "no");
        assert_eq!(read(FieldId::Proxy, &card), "");
        assert_eq!(read(FieldId::Notes, &card), "");
    }

    /// The general form of the rule above: a card with nothing to say writes an empty cell in
    /// **every** field but the two that are always there.
    #[test]
    fn a_card_with_nothing_to_say_writes_an_empty_cell_everywhere_but_the_always_two() {
        let card = sample();
        for id in FIELD_IDS {
            if ALWAYS.contains(&id) {
                continue;
            }
            assert_eq!(read(id, &card), "", "{id:?} invented a value out of None");
        }
        assert_eq!(read(FieldId::Quantity, &card), "1");
        assert_eq!(read(FieldId::Name, &card), "Lightning Bolt");
    }

    /// `None` is not zero and zero is not `None` — the two `unwrap_or_default` would collapse.
    #[test]
    fn a_true_flag_reads_yes_and_a_zero_is_not_an_absence() {
        let card = Card {
            signed: Some(true),
            tradelist_quantity: Some(0),
            purchase_price: Some(1.25),
            unit_price: Some(2.0),
            ..sample()
        };
        assert_eq!(read(FieldId::Signed, &card), "yes");
        assert_eq!(read(FieldId::TradelistQuantity, &card), "0");
        assert_eq!(read(FieldId::PurchasePrice, &card), "1.25");
        assert_eq!(read(FieldId::UnitPrice, &card), "2");
        assert_eq!(read(FieldId::Misprint, &sample()), "");
    }

    /// `__golden__/fields.json`, which is TypeScript's answer to the two questions this file
    /// exists to answer.
    #[derive(serde::Deserialize)]
    struct FieldsGolden {
        surfaces: std::collections::BTreeMap<String, Vec<String>>,
        available: std::collections::BTreeMap<String, Vec<String>>,
        default: std::collections::BTreeMap<String, Vec<String>>,
    }

    fn fields_golden() -> FieldsGolden {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/features/transfer/__golden__/fields.json");
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "the registry golden is not readable at {}: {e}. It is TypeScript's file — \
                 run `npm run golden`",
                path.display()
            )
        });
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    fn keys(ids: &[FieldId]) -> Vec<String> {
        ids.iter().map(|id| key(*id).to_owned()).collect()
    }

    /// **The registry fence, one level above the rendered bytes.**
    ///
    /// The 70 golden `.txt` files fence the *writer*, and for six of the seven formats they
    /// cannot fence this file: `write_line` renders exactly seven ids, so adding `Lang` to
    /// `Format::Plain`'s `optional` here and nowhere else moves **zero golden bytes** while
    /// changing the fold key — and one printing held in two languages would then export as two
    /// lines from the mirror and one from the export dialog, with every test in both suites
    /// green. Spec §6's promise that skipping the Rust half is a red `cargo test` was true of
    /// CSV alone, whose header row *is* the field list spelled out.
    ///
    /// So the tables themselves are committed, in the shape that already works: written from
    /// TypeScript by `npm run golden`, asserted here and in `golden.test.ts`. All 21 pairs on
    /// both axes, plus `SURFACE_FIELDS` — which is not recoverable from the intersections,
    /// because a field no format offers drops out of every one of them.
    #[test]
    fn every_format_and_surface_offers_the_fields_typescript_says() {
        let golden = fields_golden();
        assert_eq!(golden.available.len(), 21, "7 formats × 3 surfaces");
        assert_eq!(golden.default.len(), 21);

        for surface in Surface::ALL {
            assert_eq!(
                golden.surfaces.get(surface.key()),
                Some(&keys(surface_fields(surface))),
                "SURFACE_FIELDS disagrees for {}",
                surface.key()
            );
        }
        for format in Format::ALL {
            for surface in Surface::ALL {
                let at = format!("{}.{}", format.key(), surface.key());
                assert_eq!(
                    golden.available.get(&at),
                    Some(&keys(&available_fields(format, surface))),
                    "available_fields disagrees at {at}"
                );
                assert_eq!(
                    golden.default.get(&at),
                    Some(&keys(&default_fields(format, surface))),
                    "default_fields disagrees at {at}"
                );
            }
        }
    }
}
