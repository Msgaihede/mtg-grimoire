//! `bracket.ts`: the Commander bracket, estimated — **a floor, an advisory, and never a verdict**.
//! Game Changers (a column), mass land denial and extra turns (oracle-text greps read a sentence at
//! a time), and Commander Spellbook's combos (each carrying its editors' `bracket_tag`). The floor
//! spans 2 to 4: 1 and 5 are an intent only a reader can write down.
//!
//! The TypeScript's three regular expressions are hand-written matchers here (`has_lands`,
//! `is_table_facing`, `is_turn_denial`), each with a test; JavaScript's `\b` is an ASCII word
//! boundary, which is the whole difference between `lands` and `Islands`.

use super::{face_text, faces_of};
use crate::combos::DeckCombo;
use crate::deck::DeckCardRow;
use serde::Serialize;

/// `BracketReason.code`: which rule set the floor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReasonCode {
    GameChangers,
    MassLandDenial,
    ExtraTurns,
    Combo,
}

impl ReasonCode {
    /// Every code, in the order [`estimate_bracket`] reads its signals.
    pub const ALL: [ReasonCode; 4] = [
        ReasonCode::GameChangers,
        ReasonCode::MassLandDenial,
        ReasonCode::ExtraTurns,
        ReasonCode::Combo,
    ];
}

/// `BracketReason`: one rule that reached the floor, and the cards it read. `combo` is the combo
/// behind a [`ReasonCode::Combo`] reason and **absent** (not `null`) on every other, as the
/// TypeScript object leaves the key out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BracketReason {
    pub code: ReasonCode,
    /// The bracket this rule alone forces: 2, 3 or 4.
    pub floor: i64,
    /// The Game Changers, the denial, the extra-turn cards, or the combo's cards in Spellbook's
    /// order.
    pub cards: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub combo: Option<DeckCombo>,
}

/// `BracketEstimate`: the floor (2–4) and everything it was read from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BracketEstimate {
    pub floor: i64,
    pub game_changers: usize,
    pub game_changer_names: Vec<String>,
    pub mass_land_denial: Vec<String>,
    pub extra_turns: Vec<String>,
    /// Combos with `template_count == 0`: the deck definitely has them, and only these feed the
    /// floor.
    pub combos: Vec<DeckCombo>,
    /// Every other combo — it also needs a template this app cannot check, so it is shown and
    /// never counted.
    pub possible_combos: Vec<DeckCombo>,
    /// The rules that fired **at** the floor; empty exactly when none fired at all.
    pub reasons: Vec<BracketReason>,
}

/// `BASE_FLOOR`: where the estimate starts — 2, Core, the bracket a deck that flags nothing reads
/// as. It is where the maximum starts, not a rule, so it never appears among the reasons.
pub const BASE_FLOOR: i64 = 2;

/// `COMBO_FLOOR`: Spellbook's `bracketTag` as a floor. `E` (for any deck) raises nothing; `B` is
/// a legality finding rather than a power one, and raises nothing either. `S` and `O` take the
/// lower of the two brackets Spellbook hedges between.
pub const COMBO_FLOOR: [(&str, Option<i64>); 7] = [
    ("R", Some(4)),
    ("S", Some(3)),
    ("P", Some(3)),
    ("O", Some(2)),
    ("C", Some(2)),
    ("E", None),
    ("B", None),
];

/// `COMBO_FLOOR[tag] ?? null`: a letter's floor, and `None` for `E`, `B` and any letter this
/// build does not know (a later Spellbook letter raises nothing).
///
/// One oddity is not ported: the TypeScript indexes a plain object, so a tag spelled like an
/// `Object.prototype` member (`"constructor"`, `"toString"`) reads a function there and poisons
/// its `Math.max` into `NaN`. Here such a tag is unknown like any other. The ingest admits only
/// `combos::BRACKET_TAGS`, so neither side can meet one.
pub fn combo_floor(tag: &str) -> Option<i64> {
    COMBO_FLOOR
        .iter()
        .find(|(letter, _)| *letter == tag)
        .and_then(|(_, floor)| *floor)
}

/// `comboBrackets`: the brackets a combo belongs in, as the card side draws them — its floor
/// through 5. `B` is the empty list (banned is not a bracket); `E`, and any unknown letter, all
/// five (the TypeScript's `?? 1`).
pub fn combo_brackets(tag: &str) -> Vec<i64> {
    if tag == "B" {
        return Vec::new();
    }
    let floor = combo_floor(tag).unwrap_or(1);
    (1..=5).filter(|n| *n >= floor).collect()
}

/// `estimateBracket`: this deck's bracket floor.
///
/// Switched-off piles are dropped (`category_active`), and each card is read **once, by name** —
/// the first active row of a name is the one whose facts count. `game_changer` counts only when
/// `Some(true)`: an orphaned row's `None` is not counted either way. The combos are taken as
/// given — the caller matched them against the same active rows.
pub fn estimate_bracket(cards: &[DeckCardRow], combos: &[DeckCombo]) -> BracketEstimate {
    let mut game_changer_names = Vec::new();
    let mut mass_land_denial = Vec::new();
    let mut extra_turns = Vec::new();

    let mut seen = std::collections::HashSet::new();
    for card in cards.iter().filter(|card| card.category_active) {
        if !seen.insert(card.name.as_str()) {
            continue;
        }
        if card.game_changer == Some(true) {
            game_changer_names.push(card.name.clone());
        }
        let text = text_of(card);
        if is_mass_land_denial(&text) {
            mass_land_denial.push(card.name.clone());
        }
        if is_extra_turn(&text) {
            extra_turns.push(card.name.clone());
        }
    }

    // `== 0` against everything else, so the split is total and an unreadable count lands on the
    // side that raises nothing.
    let (definite, possible_combos): (Vec<DeckCombo>, Vec<DeckCombo>) = combos
        .iter()
        .cloned()
        .partition(|combo| combo.template_count == 0);

    let fired = rules_that_fired(
        &game_changer_names,
        &mass_land_denial,
        &extra_turns,
        &definite,
    );
    let floor = fired
        .iter()
        .fold(BASE_FLOOR, |high, reason| high.max(reason.floor));

    BracketEstimate {
        floor,
        game_changers: game_changer_names.len(),
        game_changer_names,
        mass_land_denial,
        extra_turns,
        combos: definite,
        possible_combos,
        reasons: fired
            .into_iter()
            .filter(|reason| reason.floor == floor)
            .collect(),
    }
}

/// `rulesThatFired`: every rule that fired, each with the floor it alone forces.
///
/// ```text
/// 4  ≥ 4 Game Changers · any mass land denial · ≥ 3 extra-turn cards · a combo tagged R
/// 3  1–3 Game Changers · a combo tagged P or S
/// 2  any extra-turn card · a combo tagged C or O
/// ```
///
/// The order is the TypeScript's — the three signals this app always has, then the combos — and
/// it matters: [`bracket_warning`] names the first reason.
fn rules_that_fired(
    game_changer_names: &[String],
    mass_land_denial: &[String],
    extra_turns: &[String],
    combos: &[DeckCombo],
) -> Vec<BracketReason> {
    let reason = |code, floor, cards: &[String]| BracketReason {
        code,
        floor,
        cards: cards.to_vec(),
        combo: None,
    };
    let mut fired = Vec::new();

    match game_changer_names.len() {
        0 => {}
        1..=3 => fired.push(reason(ReasonCode::GameChangers, 3, game_changer_names)),
        _ => fired.push(reason(ReasonCode::GameChangers, 4, game_changer_names)),
    }

    if !mass_land_denial.is_empty() {
        fired.push(reason(ReasonCode::MassLandDenial, 4, mass_land_denial));
    }

    match extra_turns.len() {
        0 => {}
        1..=2 => fired.push(reason(ReasonCode::ExtraTurns, 2, extra_turns)),
        _ => fired.push(reason(ReasonCode::ExtraTurns, 4, extra_turns)),
    }

    for combo in combos {
        if let Some(floor) = combo_floor(&combo.bracket_tag) {
            fired.push(BracketReason {
                combo: Some(combo.clone()),
                ..reason(ReasonCode::Combo, floor, &combo.cards)
            });
        }
    }

    fired
}

/// `NAMES_IN_A_SENTENCE`: past three names, a sentence counts instead.
const NAMES_IN_A_SENTENCE: usize = 3;

/// `nameList`: up to three names, else the first three and `and N more`.
fn name_list(names: &[String]) -> String {
    if names.len() <= NAMES_IN_A_SENTENCE {
        return names.join(", ");
    }
    let shown = names[..NAMES_IN_A_SENTENCE].join(", ");
    format!("{shown} and {} more", names.len() - NAMES_IN_A_SENTENCE)
}

/// `describeReason`: one reason as a noun phrase, worded once for the panel and the warning
/// alike. A combo names **all** its cards: a combo is the set.
pub fn describe_reason(reason: &BracketReason) -> String {
    let n = reason.cards.len();
    let s = if n == 1 { "" } else { "s" };
    match reason.code {
        ReasonCode::GameChangers => format!("{n} Game Changer{s}: {}", name_list(&reason.cards)),
        ReasonCode::MassLandDenial => format!("mass land denial: {}", name_list(&reason.cards)),
        ReasonCode::ExtraTurns => {
            format!("{n} extra-turn card{s}: {}", name_list(&reason.cards))
        }
        ReasonCode::Combo => format!("the combo {}", reason.cards.join(" + ")),
    }
}

/// `bracketWarning`: the deck's set bracket against its floor, in one advisory sentence — or
/// `None`, most of the time. `set` below 1 is Auto (`0`), and nothing fires upward. A set of 1
/// on a deck that fires no rule is told nothing: its floor is [`BASE_FLOOR`], but there is no
/// reason to name.
pub fn bracket_warning(set: i64, estimate: &BracketEstimate) -> Option<String> {
    if set < 1 || estimate.floor <= set {
        return None;
    }
    let first = estimate.reasons.first()?;
    Some(format!(
        concat!(
            "Set to bracket {}, but the cards suggest bracket {}+ ({}). ",
            "Mention it to your playgroup."
        ),
        set,
        estimate.floor,
        describe_reason(first)
    ))
}

/// `textOf`: the row's oracle text and every face's, joined by `\n` and lowercased once. A
/// `faces` blob that is not a JSON array is no faces at all; a face without a string
/// `oracle_text` adds nothing (not even its line).
fn text_of(card: &DeckCardRow) -> String {
    let faces = faces_of(card.faces.as_deref());
    let mut parts = vec![card.oracle_text.as_deref().unwrap_or("")];
    parts.extend(
        faces
            .iter()
            .filter_map(|face| face_text(face, "oracle_text")),
    );
    parts.join("\n").to_lowercase()
}

/// `sentencesOf`: `text.split(/[.\n]/)`, empty pieces included.
fn sentences_of(text: &str) -> impl Iterator<Item = &str> {
    text.split(['.', '\n'])
}

/// `isMassLandDenial`: some sentence is about `lands` (the word), does not merely spare them, and
/// either says `destroy all` or is a sacrifice aimed at the table.
fn is_mass_land_denial(text: &str) -> bool {
    sentences_of(text).any(|sentence| {
        if !has_lands(sentence) || spares_the_lands(sentence) {
            return false;
        }
        if sentence.contains("destroy all") {
            return true;
        }
        sentence.contains("sacrific") && is_table_facing(sentence)
    })
}

/// `sparesTheLands`: the sentence has an `except` and no `lands` before its first one, so it
/// lists what it leaves alone. The prefix is matched as a string of its own, as `slice` makes it:
/// its end is a word boundary.
fn spares_the_lands(sentence: &str) -> bool {
    sentence
        .find("except")
        .is_some_and(|except| !has_lands(&sentence[..except]))
}

/// `isExtraTurn`: some sentence says `extra turn` and is not a [`TURN_DENIAL`](is_turn_denial).
/// Per sentence, so Ugin's Nexus' denial cannot hide the turn it grants in the next one.
fn is_extra_turn(text: &str) -> bool {
    sentences_of(text).any(|sentence| sentence.contains("extra turn") && !is_turn_denial(sentence))
}

/// `LANDS`: `/\blands\b/` — the word `lands`, bounded by JavaScript's ASCII `\b` (a word
/// character is `[A-Za-z0-9_]`, so `islands` and `homelands` miss and `élands` hits).
fn has_lands(text: &str) -> bool {
    has_word(text, "lands")
}

/// `TABLE_FACING`: `/each player|each opponent|all lands/`.
fn is_table_facing(sentence: &str) -> bool {
    ["each player", "each opponent", "all lands"]
        .iter()
        .any(|phrase| sentence.contains(phrase))
}

/// `TURN_DENIAL`: `/extra turn[^.\n]*?skips that turn|skips that turn[^.\n]*?instead/`.
fn is_turn_denial(text: &str) -> bool {
    then_in_clause(text, "extra turn", "skips that turn")
        || then_in_clause(text, "skips that turn", "instead")
}

/// `first[^.\n]*?second`: an occurrence of `first`, then `second` with no `.` or `\n` between.
/// `second` holds neither character, so it must lie wholly inside the run that follows `first`
/// up to the next `.` or `\n`. Laziness changes nothing for a yes/no test.
fn then_in_clause(text: &str, first: &str, second: &str) -> bool {
    starts_of(text, first).any(|at| {
        let rest = &text[at + first.len()..];
        let clause = rest.find(['.', '\n']).map_or(rest, |end| &rest[..end]);
        clause.contains(second)
    })
}

/// `\bword\b` for a `word` of ASCII word characters, with JavaScript's ASCII boundary: the
/// neighbouring byte, if any, is not `[A-Za-z0-9_]`. A non-ASCII neighbour is a multi-byte
/// character whose bytes are all ≥ 0x80, so it is never a word byte — as in JavaScript.
fn has_word(text: &str, word: &str) -> bool {
    let bytes = text.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    starts_of(text, word).any(|at| {
        let end = at + word.len();
        (at == 0 || !is_word(bytes[at - 1])) && (end == bytes.len() || !is_word(bytes[end]))
    })
}

/// Every byte offset `needle` starts at, overlapping occurrences included — what a regex tries
/// as it walks the string.
fn starts_of<'a>(text: &'a str, needle: &'a str) -> impl Iterator<Item = usize> + 'a {
    text.char_indices()
        .map(|(at, _)| at)
        .filter(move |&at| text[at..].starts_with(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck_golden::{assert_same, combos, load, name};
    use serde_json::json;

    const GOLDEN: &str =
        include_str!("../../../../packages/ui/features/decks/__golden__/bracket.json");

    /// Every case of `bracket.golden.test.ts`: the estimate, each reason's sentence, the warning
    /// at set brackets 0–5, and each combo's brackets.
    #[test]
    fn answers_as_the_typescript_does() {
        let golden = load(GOLDEN);
        for case in &golden.cases {
            let case_name = name(case);
            let cards = golden.cards(&case["cards"]);
            let combos = combos(&case["combos"]);
            let estimate = estimate_bracket(&cards, &combos);
            assert_same(
                &serde_json::to_value(&estimate).unwrap(),
                &case["estimate"],
                case_name,
            );
            let reasons: Vec<String> = estimate.reasons.iter().map(describe_reason).collect();
            assert_same(&json!(reasons), &case["reasons"], case_name);
            let warnings: Vec<Option<String>> =
                (0..=5).map(|set| bracket_warning(set, &estimate)).collect();
            assert_same(&json!(warnings), &case["warnings"], case_name);
            let brackets: Vec<Vec<i64>> = combos
                .iter()
                .map(|combo| combo_brackets(&combo.bracket_tag))
                .collect();
            assert_same(&json!(brackets), &case["comboBrackets"], case_name);
        }
    }

    #[test]
    fn lands_is_the_word_with_an_ascii_boundary() {
        assert!(has_lands("lands"));
        assert!(has_lands("destroy all lands"));
        assert!(has_lands("all nonbasic lands."));
        assert!(has_lands("(lands)"));
        assert!(has_lands("lands-"));
        assert!(has_lands("lands'"));
        assert!(has_lands("—lands—"));
        // A non-ASCII letter is not a word character to JavaScript's `\b`.
        assert!(has_lands("élands"));
        assert!(has_lands("landsé"));
        assert!(!has_lands("islands"));
        assert!(!has_lands("homelands"));
        assert!(!has_lands("highlands"));
        assert!(!has_lands("_lands"));
        assert!(!has_lands("lands_"));
        assert!(!has_lands("lands2"));
        assert!(!has_lands("2lands"));
        assert!(!has_lands("landscape"));
        assert!(!has_lands("land"));
        assert!(!has_lands(""));
        // Case-sensitive, as the regex is: the text it reads is lowercased first.
        assert!(!has_lands("Lands"));
        // A later occurrence counts when the first is inside a word.
        assert!(has_lands("islands and lands"));
    }

    #[test]
    fn table_facing_is_any_of_three_phrases() {
        assert!(is_table_facing("each player sacrifices"));
        assert!(is_table_facing("each opponent sacrifices"));
        assert!(is_table_facing("sacrifice all lands"));
        assert!(is_table_facing("xeach playerx"));
        assert!(!is_table_facing("sacrifice two lands"));
        assert!(!is_table_facing("each other player"));
        assert!(!is_table_facing(""));
    }

    #[test]
    fn turn_denial_is_either_alternative_within_one_clause() {
        assert!(is_turn_denial(
            "if a player would begin an extra turn, that player skips that turn instead"
        ));
        assert!(is_turn_denial("extra turnskips that turn"));
        assert!(is_turn_denial("skips that turn instead"));
        assert!(is_turn_denial("skips that turninstead"));
        assert!(is_turn_denial(
            "that player skips that turn and then instead"
        ));
        // A `.` or `\n` between the halves breaks the match.
        assert!(!is_turn_denial(
            "an extra turn. that player skips that turn"
        ));
        assert!(!is_turn_denial(
            "an extra turn\nthat player skips that turn"
        ));
        assert!(!is_turn_denial("skips that turn. instead"));
        // `\r` is not in the class, so it does not.
        assert!(is_turn_denial("an extra turn\rthat player skips that turn"));
        // Order matters: the second half must follow the first.
        assert!(!is_turn_denial("skips that turn, then an extra turn"));
        assert!(!is_turn_denial("instead skips that turn"));
        assert!(!is_turn_denial("take an extra turn after this one"));
        // Any occurrence of the first half may start the match, not only the first one.
        assert!(is_turn_denial(
            "an extra turn. another extra turn, it skips that turn"
        ));
        assert!(!is_turn_denial(""));
    }

    #[test]
    fn sentences_split_on_points_and_newlines() {
        let all: Vec<&str> = sentences_of("a. b\nc..").collect();
        assert_eq!(all, ["a", " b", "c", "", ""]);
        assert_eq!(sentences_of("").collect::<Vec<_>>(), [""]);
    }

    #[test]
    fn mass_land_denial_reads_a_sentence_at_a_time() {
        assert!(is_mass_land_denial("destroy all lands."));
        assert!(is_mass_land_denial("destroy all nonbasic lands."));
        assert!(is_mass_land_denial(
            "each player sacrifices four lands of their choice."
        ));
        assert!(is_mass_land_denial(
            "each player sacrifices all lands they control except for three."
        ));
        // Spared: every mention of lands follows the first `except`.
        assert!(!is_mass_land_denial(
            "destroy all permanents except for artifacts and lands."
        ));
        // A cost, not the table.
        assert!(!is_mass_land_denial("sacrifice two lands."));
        // Two sentences are never one.
        assert!(!is_mass_land_denial("destroy all creatures. lands untap."));
        assert!(!is_mass_land_denial("destroy all islands."));
    }

    #[test]
    fn extra_turns_read_a_sentence_at_a_time() {
        assert!(is_extra_turn("take an extra turn after this one."));
        assert!(is_extra_turn("take two extra turns after this one."));
        assert!(!is_extra_turn(
            "if a player would begin an extra turn, that player skips that turn instead."
        ));
        assert!(is_extra_turn(concat!(
            "if a player would begin an extra turn, that player skips that turn instead.\n",
            "exile it and take an extra turn after this one."
        )));
        assert!(!is_extra_turn("extra\nturn"));
    }

    #[test]
    fn combo_floor_is_total_over_the_seven_letters() {
        let letters: Vec<&str> = COMBO_FLOOR.iter().map(|(letter, _)| *letter).collect();
        assert_eq!(letters, crate::combos::BRACKET_TAGS);
        assert_eq!(combo_floor("R"), Some(4));
        assert_eq!(combo_floor("E"), None);
        assert_eq!(combo_floor("Z"), None);
        assert_eq!(combo_floor("r"), None);
        assert_eq!(combo_brackets("B"), Vec::<i64>::new());
        assert_eq!(combo_brackets("E"), [1, 2, 3, 4, 5]);
        assert_eq!(combo_brackets("R"), [4, 5]);
        assert_eq!(combo_brackets("constructor"), [1, 2, 3, 4, 5]);
    }

    #[test]
    fn reason_codes_serialise_as_the_typescript_words() {
        let words: Vec<serde_json::Value> = ReasonCode::ALL
            .iter()
            .map(|code| serde_json::to_value(code).unwrap())
            .collect();
        assert_eq!(
            words,
            ["game-changers", "mass-land-denial", "extra-turns", "combo"]
        );
    }
}
