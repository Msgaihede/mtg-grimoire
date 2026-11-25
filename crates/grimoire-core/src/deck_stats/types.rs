//! `stats/typeBreakdownCounts.ts`: the creature split (`creatureSplit`, read off the curve), the
//! subtypes of a face (`subtypes`), and the Creature and Land panels' figures (`typeBreakdown`).

use super::buckets::{active_cards, front, is_creature, is_land, is_mdfc_land};
use super::mana::ManaKey;
use super::summary::DeckStatsSummary;
use crate::deck::DeckCardRow;
use crate::deck_rules::{is_js_space, js_trim};
use serde::Serialize;
use std::cmp::Ordering;

/// `CreatureSplit`: one side of the `Creatures vs noncreatures` band.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatureSplit {
    pub creatures: i64,
    pub noncreatures: i64,
    pub total: i64,
}

/// `creatureSplit`: both halves **read off the curve** — `sum(curve) + (variableCost ?? 0)` and
/// the same over the creature arrays — so the band and the curve's legend are one number.
pub fn creature_split(stats: &DeckStatsSummary) -> CreatureSplit {
    let total = stats.curve.iter().sum::<i64>() + stats.variable_cost.unwrap_or(0);
    let creatures =
        stats.curve_creatures.iter().sum::<i64>() + stats.variable_cost_creatures.unwrap_or(0);
    CreatureSplit {
        creatures,
        noncreatures: total - creatures,
        total,
    }
}

/// `SubtypeRow`: a subtype and the copies that carry it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtypeRow {
    pub name: String,
    pub count: i64,
}

/// `LandSlice`: the lands carrying exactly this set of basic land types, `types` in WUBRG order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandSlice {
    pub key: String,
    pub label: String,
    pub types: Vec<ManaKey>,
    pub count: i64,
}

/// `TypeBreakdown`: the Creature and Land panels' figures.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeBreakdown {
    pub creatures: i64,
    pub creature_types: Vec<SubtypeRow>,
    pub lands: i64,
    pub land_slices: Vec<LandSlice>,
    pub mdfc_lands: i64,
}

/// `BASIC_TYPES`: the five basic land types and their mana, WUBRG.
const BASIC_TYPES: [(&str, ManaKey); 5] = [
    ("Plains", ManaKey::W),
    ("Island", ManaKey::U),
    ("Swamp", ManaKey::B),
    ("Mountain", ManaKey::R),
    ("Forest", ManaKey::G),
];

/// `NO_BASIC_TYPE`: the label of the slice with none of the five.
pub const NO_BASIC_TYPE: &str = "No basic land type";

/// `MULTI_WORD_TYPES`: the one creature type printed as two words.
const MULTI_WORD_TYPES: [&str; 1] = ["Time Lord"];

/// JavaScript's `LineTerminator` — what a regex `.` refuses.
fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `subtypes`: the words after a face's dash, `[]` for a face with none.
///
/// The TypeScript is `/\s*(?:—|\s-\s)\s*(.*)$/.exec(face)`, then `match[1].trim()`. Its match is
/// the first separator — an em dash, or a hyphen with JS whitespace either side — whose tail
/// (after the whitespace that follows it) holds no line terminator, because `.*$` cannot cross
/// one; a separator that fails that leaves the search to a later one. The leading `\s*` only
/// moves where the match starts, never what it captures.
///
/// Then the TypeScript's own steps: a multi-word type found with whitespace or an end either
/// side (`(^|\s)Time Lord(\s|$)`) is taken out, by **its first occurrence** (`String.replace`
/// with a string pattern) — which is not always the one the test matched, so `"Time Lordling
/// Time Lord"` loses the `Time Lord` of `Lordling`, faithfully. The rest splits on runs of JS
/// whitespace (`split(/\s+/).filter(Boolean)`).
pub fn subtypes(face: &str) -> Vec<String> {
    let Some(tail) = separated_tail(face) else {
        return Vec::new();
    };
    let mut rest = js_trim(tail).to_owned();
    let mut found = Vec::new();
    for name in MULTI_WORD_TYPES {
        if stands_alone(&rest, name) {
            found.push(name.to_owned());
            rest = rest.replacen(name, " ", 1);
        }
    }
    found.extend(
        rest.split(is_js_space)
            .filter(|word| !word.is_empty())
            .map(str::to_owned),
    );
    found
}

/// The capture of `/\s*(?:—|\s-\s)\s*(.*)$/`, if the expression matches `face`.
fn separated_tail(face: &str) -> Option<&str> {
    let chars: Vec<(usize, char)> = face.char_indices().collect();
    for (i, &(_, c)) in chars.iter().enumerate() {
        // Where the separator ends, as an index into `chars`.
        let after = if c == '\u{2014}' {
            i + 1
        } else if is_js_space(c)
            && chars.get(i + 1).is_some_and(|&(_, h)| h == '-')
            && chars.get(i + 2).is_some_and(|&(_, s)| is_js_space(s))
        {
            i + 3
        } else {
            continue;
        };
        // `\s*`, greedily, then `(.*)$`: the rest to the end, with no line terminator in it.
        let start = chars[after..]
            .iter()
            .find(|&&(_, c)| !is_js_space(c))
            .map_or(face.len(), |&(at, _)| at);
        let tail = &face[start..];
        if !tail.contains(is_js_line_terminator) {
            return Some(tail);
        }
    }
    None
}

/// The TypeScript's `new RegExp(…).test(rest)` of `(^|\s)Time Lord(\s|$)`: `name` somewhere with
/// the start or JS whitespace before it and the end or JS whitespace after.
fn stands_alone(rest: &str, name: &str) -> bool {
    rest.match_indices(name).any(|(at, _)| {
        let before = rest[..at].chars().next_back().is_none_or(is_js_space);
        let after = rest[at + name.len()..]
            .chars()
            .next()
            .is_none_or(is_js_space);
        before && after
    })
}

/// `typeBreakdown`: the Creature and Land panels over the **active** copies. A land is
/// `isLand` (its basic types read off the front face); a creature is `isCreature` and not a land;
/// an MDFC land is counted beside the pie, in no slice.
pub fn type_breakdown(cards: &[DeckCardRow]) -> TypeBreakdown {
    let mut creatures = 0;
    let mut lands = 0;
    let mut mdfc_lands = 0;
    // Both in first-seen order, as the TypeScript's `Map`s are (a re-`set` keeps its place).
    let mut tally: Vec<SubtypeRow> = Vec::new();
    let mut slices: Vec<LandSlice> = Vec::new();

    for card in active_cards(cards) {
        let type_line = card.type_line.as_deref();
        let face = front(type_line);
        if is_land(type_line) {
            lands += card.quantity;
            let words = subtypes(face);
            let types: Vec<(&str, ManaKey)> = BASIC_TYPES
                .into_iter()
                .filter(|(word, _)| words.iter().any(|w| w == word))
                .collect();
            let key = if types.is_empty() {
                "none".to_owned()
            } else {
                types.iter().map(|(_, mana)| mana.letter()).collect()
            };
            match slices.iter_mut().find(|slice| slice.key == key) {
                Some(slice) => slice.count += card.quantity,
                None => slices.push(LandSlice {
                    label: if types.is_empty() {
                        NO_BASIC_TYPE.to_owned()
                    } else {
                        types
                            .iter()
                            .map(|(word, _)| *word)
                            .collect::<Vec<_>>()
                            .join(" ")
                    },
                    types: types.iter().map(|(_, mana)| *mana).collect(),
                    key,
                    count: card.quantity,
                }),
            }
            continue;
        }
        if is_mdfc_land(card) {
            mdfc_lands += card.quantity;
        }
        if !is_creature(type_line) {
            continue;
        }
        creatures += card.quantity;
        // A set, so a line that prints one type twice counts the copy once under it.
        let mut once: Vec<String> = Vec::new();
        for name in subtypes(face) {
            if !once.contains(&name) {
                once.push(name);
            }
        }
        for name in once {
            match tally.iter_mut().find(|row| row.name == name) {
                Some(row) => row.count += card.quantity,
                None => tally.push(SubtypeRow {
                    name,
                    count: card.quantity,
                }),
            }
        }
    }

    // Stable sorts, as JavaScript's are.
    tally.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| locale_compare_en(&a.name, &b.name))
    });
    slices.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| slice_rank(a).cmp(&slice_rank(b)))
    });

    TypeBreakdown {
        creatures,
        creature_types: tally,
        lands,
        land_slices: slices,
        mdfc_lands,
    }
}

/// `sliceRank`: fewer types first, then WUBRG, the no-type slice after every typed one
/// (`Number.MAX_SAFE_INTEGER`).
fn slice_rank(slice: &LandSlice) -> i64 {
    if slice.types.is_empty() {
        return (1 << 53) - 1;
    }
    slice
        .types
        .iter()
        .fold(slice.types.len() as i64, |rank, mana| {
            let at = BASIC_TYPES
                .iter()
                .position(|(_, key)| key == mana)
                .map_or(-1, |at| at as i64);
            rank * 8 + at + 1
        })
}

/// `a.localeCompare(b, "en")` — ICU's root collation, as V8 compares, **for ASCII** and the
/// handful of other characters a type line prints ([`COLLATION_ORDER`]): every subtype Scryfall
/// prints is ASCII, and the core has no collation tables to do more.
///
/// Two levels, measured against Node's ICU: the primary weights in [`COLLATION_ORDER`]'s order
/// (whitespace, then punctuation, then digits, then letters with a letter's two cases equal),
/// then — when the primary sequences are equal — each character's variant from the left
/// (lowercase before uppercase, a space before a no-break space). The control characters ICU
/// ignores are skipped. **Beyond those characters this is an approximation**: any other
/// character sorts after every letter, by code point, with no accent or case level — so `é`
/// sorts after `z` here and beside `e` in JavaScript.
pub(crate) fn locale_compare_en(a: &str, b: &str) -> Ordering {
    let keys = |s: &str| s.chars().filter_map(collation_key).collect::<Vec<_>>();
    let (a, b) = (keys(a), keys(b));
    let primary = |keys: &[(u32, u8)]| keys.iter().map(|k| k.0).collect::<Vec<_>>();
    primary(&a)
        .cmp(&primary(&b))
        .then_with(|| a.iter().map(|k| k.1).cmp(b.iter().map(|k| k.1)))
}

/// ICU's order of every non-ignorable ASCII character that is not a letter, and of the dashes,
/// curly quotes and no-break space a type line can carry, as Node sorts them (`"en"`,
/// 2026-11-25). One entry per primary weight; the characters of one entry differ only in
/// variant, in the order written. The 26 letters follow, a primary each.
const COLLATION_ORDER: [&str; 54] = [
    "\t",
    "\n",
    "\u{b}",
    "\u{c}",
    "\r",
    " \u{a0}",
    "_",
    "-",
    "\u{2010}",
    "\u{2011}",
    "\u{2012}",
    "\u{2013}",
    "\u{2014}",
    "\u{2015}",
    ",",
    ";",
    ":",
    "!",
    "?",
    ".",
    "'\u{2018}\u{2019}",
    "\"\u{201c}\u{201d}",
    "(",
    ")",
    "[",
    "]",
    "{",
    "}",
    "@",
    "*",
    "/",
    "\\",
    "&",
    "#",
    "%",
    "`",
    "^",
    "+",
    "<",
    "=",
    ">",
    "|",
    "~",
    "$",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
];

/// One character's (primary, variant) weight, or `None` for an ignorable control character.
fn collation_key(c: char) -> Option<(u32, u8)> {
    let letters = COLLATION_ORDER.len() as u32;
    if c.is_ascii_alphabetic() {
        let lower = c.to_ascii_lowercase();
        let primary = letters + (lower as u32 - 'a' as u32);
        return Some((primary, u8::from(c.is_ascii_uppercase())));
    }
    for (at, group) in COLLATION_ORDER.iter().enumerate() {
        if let Some(variant) = group.chars().position(|g| g == c) {
            return Some((at as u32, variant as u8));
        }
    }
    if c.is_ascii() {
        // U+0000–U+0008, U+000E–U+001F and U+007F: completely ignorable.
        return None;
    }
    Some((letters + 26 + c as u32, 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck_golden::{assert_same, load, name};
    use crate::deck_stats::summary::deck_stats;
    use serde_json::json;

    const MANA: &str = include_str!("../../../../packages/ui/features/decks/__golden__/mana.json");
    const STATS: &str =
        include_str!("../../../../packages/ui/features/decks/__golden__/stats.json");

    /// Every case of `stats.json`: `typeBreakdown`, and `creatureSplit` both ways of
    /// `separateXGroup`.
    #[test]
    fn the_stats_golden_breaks_types_down_as_the_typescript_does() {
        let golden = load(STATS);
        for case in &golden.cases {
            let cards = golden.cards(&case["cards"]);
            let actual = json!({
                "typeBreakdown": type_breakdown(&cards),
                "split": creature_split(&deck_stats(&cards, false)),
                "splitX": creature_split(&deck_stats(&cards, true)),
            });
            let expected = json!({
                "typeBreakdown": case["typeBreakdown"],
                "split": case["split"],
                "splitX": case["splitX"],
            });
            assert_same(
                &serde_json::to_value(&actual).unwrap(),
                &expected,
                name(case),
            );
        }
    }

    /// Every string of `mana.json`: `subtypes` of the string as written.
    #[test]
    fn the_mana_golden_reads_subtypes_as_the_typescript_does() {
        let golden = load(MANA);
        for case in &golden.cases {
            let actual = json!(case["input"].as_str().map(subtypes));
            assert_same(
                &serde_json::to_value(&actual).unwrap(),
                &case["subtypes"],
                name(case),
            );
        }
    }

    /// The hand-written stand-in for `/\s*(?:—|\s-\s)\s*(.*)$/`.
    #[test]
    fn the_separator_is_the_first_that_reaches_the_end() {
        assert_eq!(separated_tail("Creature — Elf"), Some("Elf"));
        assert_eq!(separated_tail("Creature - Elf"), Some("Elf"));
        assert_eq!(separated_tail("Creature-Elf"), None);
        assert_eq!(separated_tail("Creature -Elf"), None);
        assert_eq!(separated_tail("Creature —Elf"), Some("Elf"));
        assert_eq!(separated_tail("—"), Some(""));
        assert_eq!(separated_tail("Creature —\nElf"), Some("Elf"));
        assert_eq!(separated_tail("Creature -\nElf"), Some("Elf"));
        assert_eq!(separated_tail("A — B\nC — D"), Some("D"));
        assert_eq!(separated_tail("A — B\u{2028}C"), None);
        assert_eq!(separated_tail("A — B — C"), Some("B — C"));
        assert_eq!(separated_tail("A – B"), None);
        assert_eq!(separated_tail("A\u{a0}-\u{a0}B"), Some("B"));
    }

    /// The hand-written stand-in for `(^|\s)Time Lord(\s|$)`, and the first-occurrence replace.
    #[test]
    fn a_two_word_type_stands_alone_or_not_at_all() {
        assert!(stands_alone("Time Lord", "Time Lord"));
        assert!(stands_alone("Doctor Time Lord", "Time Lord"));
        assert!(!stands_alone("Time Lordling", "Time Lord"));
        assert!(!stands_alone("XTime Lord", "Time Lord"));
        assert_eq!(
            subtypes("Creature — Time Lord Doctor"),
            ["Time Lord", "Doctor"]
        );
        assert_eq!(
            subtypes("Creature — Time Lordling Time Lord"),
            ["Time Lord", "ling", "Time", "Lord"]
        );
        assert_eq!(
            subtypes("Artifact Creature — Assembly-Worker"),
            ["Assembly-Worker"]
        );
        assert!(subtypes("Creature — ").is_empty());
    }

    /// The pairs Node's `localeCompare(…, "en")` was asked on 2026-11-25.
    #[test]
    fn collation_matches_icu_for_ascii() {
        use Ordering::{Greater, Less};
        for (a, b, want) in [
            ("Assembly-Worker", "Assembly", Greater),
            ("Assembly-Worker", "AssemblyA", Less),
            ("elf", "Elf", Less),
            ("Elves", "Elf", Greater),
            ("Time Lord", "TimeLord", Less),
            ("Time Lord", "Time-Lord", Less),
            ("a-b", "a_b", Greater),
            ("a'b", "a-b", Greater),
            ("a1", "aa", Less),
            ("10", "2", Less),
            ("Ab", "aB", Greater),
            ("aB", "Ab", Less),
            ("Abc", "abd", Less),
            ("x.y", "x-y", Greater),
            ("Urza's", "Urzas", Less),
            (" a", "a", Less),
            ("a\tb", "a b", Less),
        ] {
            assert_eq!(locale_compare_en(a, b), want, "{a:?} against {b:?}");
        }
        assert_eq!(locale_compare_en("a\u{1}b", "ab"), Ordering::Equal);
    }
}
