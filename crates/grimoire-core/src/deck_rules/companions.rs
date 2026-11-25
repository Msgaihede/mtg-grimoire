//! `companions.ts`: the companion zone, its count, each companion's eligibility and the ten deck
//! conditions, Yorion's and Umori's among them.
//!
//! **Keyed by printed name**, as the TypeScript is: ten cards with ten English conditions, each a
//! predicate over the starting deck that names the cards failing it. A name outside the ten warns
//! where the card prints a `Companion —` line and is refused where it does not.
//!
//! The three regular expressions (`COMPANION_LINE`, `CHANGELING`, `BARE_ACTIVATED_KEYWORDS`) are
//! hand-written matchers below, each with tests quoting the expression it replaces. Their `^` is
//! the `m` flag's — the text's start or just after any JavaScript line terminator — and their `\b`
//! is JavaScript's ASCII word boundary.

use std::collections::HashMap;

use super::commanders::{
    card_types_of, color_identity_issues, commander_identity, front_face, subtypes_of, EM_DASH,
};
use super::engine::{is_orphan, mana_value_of, symbols, SIZE_KINDS};
use super::issue::ValidationIssue;
use super::{face_text, faces_of, is_js_space, js_trim};
use crate::deck::{DeckCardRow, FormatSpecRow};

/// `STARTING_DECK`: the kinds a condition reads — `SIZE_KINDS`, so never the sideboard and never
/// the companion itself, and a switched-on Maybeboard is in.
const STARTING_DECK: [&str; 3] = SIZE_KINDS;

/// `NAMES_SHOWN`: how many offenders a sentence names before it counts the rest.
const NAMES_SHOWN: usize = 3;

/// One companion's condition over the starting deck — `CompanionRule.applies`.
type Rule = fn(&[&DeckCardRow], &FormatSpecRow) -> Vec<ValidationIssue>;

/// `COMPANIONS`: the ten, by printed name. `pub(crate)` so the goldens' coverage fence can list
/// the names.
pub(crate) const COMPANIONS: [(&str, Rule); 10] = [
    ("Gyruda, Doom of Depths", gyruda),
    ("Jegantha, the Wellspring", jegantha),
    ("Kaheera, the Orphanguard", kaheera),
    ("Keruga, the Macrosage", keruga),
    ("Lurrus of the Dream-Den", lurrus),
    ("Lutri, the Spellchaser", lutri),
    ("Obosh, the Preypiercer", obosh),
    ("Umori, the Collector", umori),
    ("Yorion, Sky Nomad", yorion),
    ("Zirda, the Dawnwaker", zirda),
];

// -----------------------------------------------------------------------------------------
// The zone.
// -----------------------------------------------------------------------------------------

/// `companionIssues(companions, deck, spec)`: everything wrong with the companion kind's rows
/// (`companions`) under this format, judged against the active deck (`deck`) — whether the format
/// has a companion at all, how many there are, whether each may be one and its condition holds,
/// and, under a commander rule, whether it fits the commander's colours.
pub fn companion_issues(
    companions: &[&DeckCardRow],
    deck: &[&DeckCardRow],
    spec: &FormatSpecRow,
) -> Vec<ValidationIssue> {
    if companions.is_empty() {
        return Vec::new();
    }

    // Read from the row, never from the key (Gladiator's cell is the one that is false).
    if !spec.allows_companion {
        return vec![ValidationIssue::error(
            "companion-zone",
            format!(
                "{} has no sideboard, so it has no companions.",
                spec.display_name
            ),
            Some(distinct_card_ids(companions)),
        )];
    }

    let mut issues = Vec::new();
    let count: i64 = companions.iter().map(|card| card.quantity).sum();
    if count > 1 {
        issues.push(ValidationIssue::error(
            "companion-count",
            format!(
                "{} decks have one companion; you have {count}.",
                spec.display_name
            ),
            None,
        ));
    }

    let starting_deck: Vec<&DeckCardRow> = deck
        .iter()
        .copied()
        .filter(|card| STARTING_DECK.contains(&card.category_kind.as_str()))
        .collect();
    // Only where there is a commander rule; `None` from an empty zone is no identity, while an
    // empty identity (a colourless commander) is a real one.
    let identity = if spec.commander_rule.is_none() {
        None
    } else {
        let zone: Vec<&DeckCardRow> = deck
            .iter()
            .copied()
            .filter(|card| card.category_kind == "commander")
            .collect();
        commander_identity(&zone, spec)
    };

    for &companion in companions {
        if is_orphan(companion) {
            continue;
        }
        issues.extend(eligibility(companion, &starting_deck, spec));
        if let Some(identity) = identity {
            issues.extend(color_identity_issues(&[companion], identity));
        }
    }
    issues
}

/// `eligibility`: one of the ten answers its condition; anything else warns where its front face
/// prints a companion line and is refused where it does not.
///
/// The TypeScript looks the name up as `COMPANIONS[companion.name]`, a plain object, so a card
/// named after an `Object.prototype` member (`constructor`, `toString`) would find one and throw.
/// No printed card is named so; here such a name is simply not one of the ten.
fn eligibility(
    companion: &DeckCardRow,
    starting_deck: &[&DeckCardRow],
    spec: &FormatSpecRow,
) -> Vec<ValidationIssue> {
    if let Some((_, rule)) = COMPANIONS.iter().find(|(name, _)| *name == companion.name) {
        return rule(starting_deck, spec);
    }
    if has_companion_line(front_face(companion).oracle_text.as_deref().unwrap_or("")) {
        return vec![ValidationIssue::warning(
            "companion-unknown",
            format!(
                "{}'s companion condition isn't supported yet, so it wasn't checked.",
                companion.name
            ),
            Some(vec![companion.card_id.clone()]),
        )];
    }
    vec![ValidationIssue::error(
        "companion-eligibility",
        format!(
            "{} has no companion ability, so it can't be your companion.",
            companion.name
        ),
        Some(vec![companion.card_id.clone()]),
    )]
}

// -----------------------------------------------------------------------------------------
// The ten.
// -----------------------------------------------------------------------------------------

/// "Your starting deck contains only cards with even mana values." A land's 0 is even.
fn gyruda(deck: &[&DeckCardRow], _: &FormatSpecRow) -> Vec<ValidationIssue> {
    offender_issue(
        "Gyruda, Doom of Depths",
        "every card in your deck to have an even mana value",
        "does not",
        "do not",
        &failing(
            deck,
            |_| true,
            |card| mana_value(card).is_some_and(|value| value % 2.0 != 0.0),
        ),
    )
}

/// "No card in your starting deck has more than one of the same mana symbol in its mana cost."
fn jegantha(deck: &[&DeckCardRow], _: &FormatSpecRow) -> Vec<ValidationIssue> {
    offender_issue(
        "Jegantha, the Wellspring",
        "no mana cost in your deck to repeat a mana symbol",
        "repeats one",
        "repeat one",
        &failing(deck, |_| true, repeats_a_mana_symbol),
    )
}

/// `KAHEERA_TYPES`: Kaheera's five, as printed.
const KAHEERA_TYPES: [&str; 5] = ["Cat", "Elemental", "Nightmare", "Dinosaur", "Beast"];

/// "Each creature card in your starting deck is a Cat, Elemental, Nightmare, Dinosaur, or Beast
/// card." A changeling is every type, read off its keyword (its subtype line says Shapeshifter).
fn kaheera(deck: &[&DeckCardRow], _: &FormatSpecRow) -> Vec<ValidationIssue> {
    let (last, rest) = KAHEERA_TYPES.split_last().expect("five types");
    offender_issue(
        "Kaheera, the Orphanguard",
        &format!(
            "every creature card in your deck to be a {} or {last}",
            rest.join(", ")
        ),
        "is not",
        "are not",
        &failing(
            deck,
            |card| has_type(card, "Creature"),
            |card| {
                !has_changeling(&all_oracle_text(card)) && {
                    let subtypes = subtypes(card);
                    !KAHEERA_TYPES.iter().any(|t| subtypes.contains(t))
                }
            },
        ),
    )
}

/// "Your starting deck contains only cards with mana value 3 or greater and land cards."
fn keruga(deck: &[&DeckCardRow], _: &FormatSpecRow) -> Vec<ValidationIssue> {
    offender_issue(
        "Keruga, the Macrosage",
        "every nonland card in your deck to have mana value 3 or greater",
        "does not",
        "do not",
        &failing(
            deck,
            |card| !is_land(card),
            |card| mana_value(card).is_some_and(|value| value < 3.0),
        ),
    )
}

/// "Each permanent card in your starting deck has mana value 2 or less."
fn lurrus(deck: &[&DeckCardRow], _: &FormatSpecRow) -> Vec<ValidationIssue> {
    offender_issue(
        "Lurrus of the Dream-Den",
        "every permanent card in your deck to have mana value 2 or less",
        "does not",
        "do not",
        &failing(deck, is_permanent, |card| {
            mana_value(card).is_some_and(|value| value > 2.0)
        }),
    )
}

/// "Each nonland card in your starting deck has a different name." Copies are summed by name
/// across rows, as the copy limit sums them.
fn lutri(deck: &[&DeckCardRow], _: &FormatSpecRow) -> Vec<ValidationIssue> {
    let nonlands: Vec<&DeckCardRow> = judgeable(deck).filter(|card| !is_land(card)).collect();
    let mut counts: HashMap<&str, i64> = HashMap::new();
    for card in &nonlands {
        *counts.entry(card.name.as_str()).or_insert(0) += card.quantity;
    }
    let repeated: Vec<&DeckCardRow> = nonlands
        .iter()
        .copied()
        .filter(|card| counts.get(card.name.as_str()).copied().unwrap_or(0) > 1)
        .collect();
    offender_issue(
        "Lutri, the Spellchaser",
        "every nonland card in your deck to have a different name",
        "appears more than once",
        "appear more than once",
        &repeated,
    )
}

/// "Your starting deck contains only cards with odd mana values and land cards."
fn obosh(deck: &[&DeckCardRow], _: &FormatSpecRow) -> Vec<ValidationIssue> {
    offender_issue(
        "Obosh, the Preypiercer",
        "every nonland card in your deck to have an odd mana value",
        "does not",
        "do not",
        &failing(
            deck,
            |card| !is_land(card),
            |card| mana_value(card).is_some_and(|value| value % 2.0 == 0.0),
        ),
    )
}

/// `umoriIssues`: "Each nonland card in your starting deck shares a card type." It fails on the
/// set, so the sentence is built around the type most of the deck has — the first to reach the
/// highest count, in the order the types were first met — and names the cards without it.
fn umori(deck: &[&DeckCardRow], _: &FormatSpecRow) -> Vec<ValidationIssue> {
    let nonlands: Vec<(&DeckCardRow, Vec<&'static str>)> = judgeable(deck)
        .filter(|card| !is_land(card))
        .map(|card| (card, types_of(card)))
        .filter(|(_, types)| !types.is_empty())
        .collect();
    let Some((_, first)) = nonlands.first() else {
        return Vec::new();
    };
    if first
        .iter()
        .any(|t| nonlands.iter().all(|(_, types)| types.contains(t)))
    {
        return Vec::new();
    }

    // A `Map` in insertion order.
    let mut counts: Vec<(&'static str, usize)> = Vec::new();
    for (_, types) in &nonlands {
        for &t in types {
            match counts.iter_mut().find(|(seen, _)| *seen == t) {
                Some((_, n)) => *n += 1,
                None => counts.push((t, 1)),
            }
        }
    }
    let (commonest, _) =
        counts.iter().skip(1).fold(
            counts[0],
            |best, &entry| if entry.1 > best.1 { entry } else { best },
        );
    let offenders: Vec<&DeckCardRow> = nonlands
        .iter()
        .filter(|(_, types)| !types.contains(&commonest))
        .map(|(card, _)| *card)
        .collect();

    let names = distinct_names(&offenders);
    vec![ValidationIssue::error(
        "companion-condition",
        format!(
            concat!(
                "Umori, the Collector needs every nonland card in your deck to share a card ",
                "type; most of yours are {}, but {} {} not."
            ),
            commonest,
            name_list(&names),
            if names.len() == 1 { "is" } else { "are" }
        ),
        Some(distinct_card_ids(&offenders)),
    )]
}

/// `yorionIssues`: "Your starting deck contains at least twenty cards more than the minimum deck
/// size." The one condition that reads the spec, and it counts every row of the starting deck —
/// orphans included, since it judges no card.
fn yorion(deck: &[&DeckCardRow], spec: &FormatSpecRow) -> Vec<ValidationIssue> {
    let needed = spec.deck_min + 20;
    let size: i64 = deck.iter().map(|card| card.quantity).sum();
    if size >= needed {
        return Vec::new();
    }
    vec![ValidationIssue::error(
        "companion-condition",
        format!(
            concat!(
                "Yorion, Sky Nomad needs at least {} cards in your deck, twenty more than ",
                "{}'s minimum of {}; you have {}."
            ),
            needed, spec.display_name, spec.deck_min, size
        ),
        None,
    )]
}

/// "Each permanent card in your starting deck has an activated ability."
fn zirda(deck: &[&DeckCardRow], _: &FormatSpecRow) -> Vec<ValidationIssue> {
    offender_issue(
        "Zirda, the Dawnwaker",
        "every permanent card in your deck to have an activated ability",
        "does not",
        "do not",
        &failing(deck, is_permanent, |card| !has_activated_ability(card)),
    )
}

/// `judgeable`: the cards a condition can judge — an orphaned row has no facts.
fn judgeable<'a>(deck: &'a [&'a DeckCardRow]) -> impl Iterator<Item = &'a DeckCardRow> + 'a {
    deck.iter().copied().filter(|card| !is_orphan(card))
}

/// `failing`: the judgeable cards a condition `applies` to and that `fails` it.
fn failing<'a>(
    deck: &'a [&'a DeckCardRow],
    applies: impl Fn(&DeckCardRow) -> bool,
    fails: impl Fn(&DeckCardRow) -> bool,
) -> Vec<&'a DeckCardRow> {
    judgeable(deck)
        .filter(|card| applies(card) && fails(card))
        .collect()
}

/// `repeatsAManaSymbol`: one of the card's costs prints a symbol twice, compared as printed.
fn repeats_a_mana_symbol(card: &DeckCardRow) -> bool {
    mana_costs_of(card).iter().any(|cost| {
        let mut seen: Vec<&str> = Vec::new();
        for symbol in symbols(cost) {
            if seen.contains(&symbol) {
                return true;
            }
            seen.push(symbol);
        }
        false
    })
}

// -----------------------------------------------------------------------------------------
// Sentences.
// -----------------------------------------------------------------------------------------

/// `offenderIssue`: the sentence nine of the ten use — what the companion needs, then which cards
/// do not do it, with the verb agreeing with how many are named.
fn offender_issue(
    companion: &str,
    requirement: &str,
    singular: &str,
    plural: &str,
    offenders: &[&DeckCardRow],
) -> Vec<ValidationIssue> {
    if offenders.is_empty() {
        return Vec::new();
    }
    let names = distinct_names(offenders);
    vec![ValidationIssue::error(
        "companion-condition",
        format!(
            "{companion} needs {requirement}; {} {}.",
            name_list(&names),
            if names.len() == 1 { singular } else { plural }
        ),
        Some(distinct_card_ids(offenders)),
    )]
}

/// `nameList`: up to three names (`A`, `A and B`, `A, B and C`), then
/// `A, B, C and N other` / `others`.
fn name_list(names: &[&str]) -> String {
    if names.len() <= NAMES_SHOWN {
        return match names.split_last() {
            Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
            _ => names.concat(),
        };
    }
    let rest = names.len() - NAMES_SHOWN;
    format!(
        "{} and {rest} other{}",
        names[..NAMES_SHOWN].join(", "),
        if rest == 1 { "" } else { "s" }
    )
}

/// `distinctNames`: the names in the order the read returned them, each once.
fn distinct_names<'a>(cards: &[&'a DeckCardRow]) -> Vec<&'a str> {
    let mut names: Vec<&str> = Vec::new();
    for card in cards {
        if !names.contains(&card.name.as_str()) {
            names.push(&card.name);
        }
    }
    names
}

/// `distinctCardIds`: the printings, in order, each once.
fn distinct_card_ids(cards: &[&DeckCardRow]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for card in cards {
        if !ids.contains(&card.card_id) {
            ids.push(card.card_id.clone());
        }
    }
    ids
}

// -----------------------------------------------------------------------------------------
// Card facts the conditions read.
// -----------------------------------------------------------------------------------------

/// `cardTypesOf`: the front face's supertypes and card types, `""` with no type line.
fn card_types(card: &DeckCardRow) -> String {
    front_face(card)
        .type_line
        .map(|line| card_types_of(&line).to_owned())
        .unwrap_or_default()
}

/// `subtypesOf`: the front face's subtypes, `""` with no type line.
fn subtypes(card: &DeckCardRow) -> String {
    front_face(card)
        .type_line
        .map(|line| subtypes_of(&line).to_owned())
        .unwrap_or_default()
}

/// `hasCardType`: a substring test, as everywhere in the TypeScript.
fn has_type(card: &DeckCardRow, card_type: &str) -> bool {
    card_types(card).contains(card_type)
}

/// `isLand`.
fn is_land(card: &DeckCardRow) -> bool {
    has_type(card, "Land")
}

/// `PERMANENT_TYPES`: CR 110.4a's list (`Kindred` is not on it).
const PERMANENT_TYPES: [&str; 6] = [
    "Artifact",
    "Battle",
    "Creature",
    "Enchantment",
    "Land",
    "Planeswalker",
];

/// `isPermanent`.
fn is_permanent(card: &DeckCardRow) -> bool {
    let types = card_types(card);
    PERMANENT_TYPES.iter().any(|t| types.contains(t))
}

/// `CARD_TYPES`: the card types a deck card can have — no supertypes (Umori's rule), and no
/// `Plane`, which as a substring would give every planeswalker two types.
const CARD_TYPES: [&str; 9] = [
    "Artifact",
    "Battle",
    "Creature",
    "Enchantment",
    "Instant",
    "Kindred",
    "Land",
    "Planeswalker",
    "Sorcery",
];

/// `typesOf`: the card types this card has, in [`CARD_TYPES`]' order.
fn types_of(card: &DeckCardRow) -> Vec<&'static str> {
    let printed = card_types(card);
    CARD_TYPES
        .iter()
        .copied()
        .filter(|t| printed.contains(t))
        .collect()
}

/// `manaValue`: the `cmc` column, else the printed cost's value, else `None`.
fn mana_value(card: &DeckCardRow) -> Option<f64> {
    card.cmc.or_else(|| {
        card.mana_cost
            .as_deref()
            .map(|cost| mana_value_of(Some(cost)))
    })
}

/// `manaCostsOf`: every printed cost apart — the top-level string split on `//`, and each face's
/// own — trimmed, non-empty, each once.
fn mana_costs_of(card: &DeckCardRow) -> Vec<String> {
    let mut costs: Vec<String> = Vec::new();
    let mut add = |cost: &str| {
        let cost = js_trim(cost);
        if !cost.is_empty() && !costs.iter().any(|seen| seen == cost) {
            costs.push(cost.to_owned());
        }
    };
    for half in card.mana_cost.as_deref().unwrap_or("").split("//") {
        add(half);
    }
    for face in faces_of(card.faces.as_deref()) {
        add(face_text(&face, "mana_cost").unwrap_or(""));
    }
    costs
}

/// `allOracleText`: the card's own text and every face's, joined by `\n`.
fn all_oracle_text(card: &DeckCardRow) -> String {
    let mut parts = vec![card.oracle_text.clone().unwrap_or_default()];
    for face in faces_of(card.faces.as_deref()) {
        if let Some(text) = face_text(&face, "oracle_text") {
            parts.push(text.to_owned());
        }
    }
    parts.join("\n")
}

/// `hasActivatedAbility`: a colon anywhere, reminder text included (a basic land's whole text is
/// `({T}: Add {U}.)`), or one of the keywords printed with no colon.
fn has_activated_ability(card: &DeckCardRow) -> bool {
    let text = all_oracle_text(card);
    text.contains(':') || has_bare_activated_keyword(&text)
}

// -----------------------------------------------------------------------------------------
// The matchers.
// -----------------------------------------------------------------------------------------

/// The `m` flag's `^`: byte offsets of the text's start and of every point just after a
/// JavaScript line terminator (`\n`, `\r`, U+2028, U+2029).
fn line_starts(text: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(
        text.char_indices()
            .filter(|&(_, c)| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
            .map(|(at, c)| at + c.len_utf8()),
    )
}

/// JavaScript's `\b` just after a word character ending at byte `at`: the text ends there, or the
/// next character is not `[A-Za-z0-9_]` (anything outside ASCII is not a word character).
fn word_ends(text: &str, at: usize) -> bool {
    text.as_bytes()
        .get(at)
        .is_none_or(|&b| !(b.is_ascii_alphanumeric() || b == b'_'))
}

/// `COMPANION_LINE`, ``new RegExp(`^Companion[ \t]*${EM_DASH}`, "m")``: a line opening with
/// `Companion`, then only spaces and tabs, then an em dash. `Old Companion —` does not match.
fn has_companion_line(text: &str) -> bool {
    line_starts(text).any(|at| {
        text[at..]
            .strip_prefix("Companion")
            .is_some_and(|rest| rest.trim_start_matches([' ', '\t']).starts_with(EM_DASH))
    })
}

/// `CHANGELING`, `/^Changeling\b/m`: a line opening with the keyword — not a line that merely
/// mentions a token with changeling.
fn has_changeling(text: &str) -> bool {
    const KEYWORD: &str = "Changeling";
    line_starts(text)
        .any(|at| text[at..].starts_with(KEYWORD) && word_ends(text, at + KEYWORD.len()))
}

/// The alternatives of `BARE_ACTIVATED_KEYWORDS`, as printed.
const BARE_ACTIVATED_KEYWORDS: [&str; 11] = [
    "Equip",
    "Crew",
    "Saddle",
    "Cycling",
    "Unearth",
    "Ninjutsu",
    "Scavenge",
    "Embalm",
    "Fortify",
    "Reconfigure",
    "Aura swap",
];

/// `BARE_ACTIVATED_KEYWORDS`,
/// `/(?:^|—\s*)(?:Equip|Crew|…|Aura swap)\b/im`: a keyword, in any case, opening a line or
/// following an em dash and any JavaScript whitespace (line breaks included), then a word
/// boundary. Without the `u` flag, `i` folds ASCII letters only: no other character matches one.
fn has_bare_activated_keyword(text: &str) -> bool {
    // `\s*` is greedy and a keyword never starts with whitespace, so after a dash the keyword
    // can only start where the whitespace ends.
    let after_dashes = text.match_indices(EM_DASH).map(|(at, dash)| {
        let rest = &text[at + dash.len()..];
        text.len() - rest.trim_start_matches(is_js_space).len()
    });
    line_starts(text)
        .chain(after_dashes)
        .any(|at| keyword_at(text, at))
}

/// One of [`BARE_ACTIVATED_KEYWORDS`] at byte `at`, ASCII case folded, then `\b`.
fn keyword_at(text: &str, at: usize) -> bool {
    let rest = &text.as_bytes()[at..];
    BARE_ACTIVATED_KEYWORDS.iter().any(|keyword| {
        rest.get(..keyword.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(keyword.as_bytes()))
            && word_ends(text, at + keyword.len())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck_golden::{assert_same, load, name};

    /// `^Companion[ \t]*—` with `m`.
    #[test]
    fn companion_line_is_line_anchored_with_only_spaces_and_tabs() {
        assert!(has_companion_line("Companion — Your starting deck…"));
        assert!(has_companion_line("Companion\u{2014}"));
        assert!(has_companion_line("Companion \t \u{2014} x"));
        for terminator in ["\n", "\r", "\u{2028}", "\u{2029}"] {
            assert!(has_companion_line(&format!(
                "Flying{terminator}Companion — x"
            )));
        }
        assert!(!has_companion_line("Old Companion — x"));
        assert!(!has_companion_line(" Companion — x"));
        assert!(!has_companion_line("companion — x"));
        assert!(!has_companion_line("Companion \u{2013} x"));
        assert!(!has_companion_line("Companion\u{00A0}\u{2014} x"));
        assert!(!has_companion_line("Companion"));
        assert!(!has_companion_line(""));
    }

    /// `^Changeling\b` with `m`: case-sensitive, and `\b` is ASCII.
    #[test]
    fn changeling_is_the_keyword_opening_a_line() {
        assert!(has_changeling(
            "Changeling (This card is every creature type.)"
        ));
        assert!(has_changeling("Changeling"));
        assert!(has_changeling("Flying\nChangeling"));
        assert!(has_changeling("Flying\u{2028}Changeling"));
        assert!(has_changeling("Changelingé"));
        assert!(has_changeling("Changeling\u{2014}x"));
        assert!(!has_changeling(
            "Create a 1/1 Shapeshifter token with changeling."
        ));
        assert!(!has_changeling("Changelings you control get +1/+1."));
        assert!(!has_changeling("Changeling2"));
        assert!(!has_changeling("Changeling_"));
        assert!(!has_changeling("changeling"));
    }

    /// `(?:^|—\s*)(?:Equip|…|Aura swap)\b` with `i` and `m`, no `u`.
    #[test]
    fn bare_keywords_open_a_line_or_follow_a_dash() {
        assert!(has_bare_activated_keyword(
            "Equipped creature gets +1/-1.\nEquip {1}"
        ));
        assert!(has_bare_activated_keyword("Murasame \u{2014} Equip {5}"));
        assert!(has_bare_activated_keyword("Murasame\u{2014}Equip {5}"));
        assert!(has_bare_activated_keyword(
            "Murasame \u{2014}\u{00A0}\n Equip"
        ));
        assert!(has_bare_activated_keyword("equip {1}"));
        assert!(has_bare_activated_keyword("CREW 2"));
        assert!(has_bare_activated_keyword("aURA SWAP {1}"));
        assert!(has_bare_activated_keyword("Flying\rSaddle 1"));
        assert!(has_bare_activated_keyword("Flying\u{2029}Cycling {2}"));
        assert!(has_bare_activated_keyword("Equipé"));
        assert!(has_bare_activated_keyword("Cycling-{2}"));
        assert!(has_bare_activated_keyword("Flying\nUnearth"));
        assert!(!has_bare_activated_keyword("Equipped creature gets +2/+0."));
        assert!(!has_bare_activated_keyword("Flying, cycling {2}"));
        assert!(!has_bare_activated_keyword("Murasame \u{2013} Equip {5}"));
        assert!(!has_bare_activated_keyword("Crew1"));
        assert!(!has_bare_activated_keyword("Equip_"));
        assert!(!has_bare_activated_keyword("Aura  swap"));
        assert!(!has_bare_activated_keyword("EQU\u{0131}P {1}"));
        assert!(!has_bare_activated_keyword("EQU\u{0130}P {1}"));
        assert!(!has_bare_activated_keyword("\u{017F}cavenge {2}"));
        assert!(!has_bare_activated_keyword("Megamorph {2}{G}"));
        assert!(!has_bare_activated_keyword(""));
    }

    #[test]
    fn name_list_names_three_then_counts() {
        assert_eq!(name_list(&[]), "");
        assert_eq!(name_list(&["A"]), "A");
        assert_eq!(name_list(&["A", "B"]), "A and B");
        assert_eq!(name_list(&["A", "B", "C"]), "A, B and C");
        assert_eq!(name_list(&["A", "B", "C", "D"]), "A, B, C and 1 other");
        assert_eq!(
            name_list(&["A", "B", "C", "D", "E"]),
            "A, B, C and 2 others"
        );
    }

    #[test]
    fn golden() {
        let golden = load(include_str!(
            "../../../../packages/ui/features/decks/__golden__/companions.json"
        ));
        for case in &golden.cases {
            let cards = golden.cards(&case["cards"]);
            let spec = golden.spec(&case["spec"]);
            let active: Vec<&DeckCardRow> = cards.iter().filter(|c| c.category_active).collect();
            let zone: Vec<&DeckCardRow> = active
                .iter()
                .copied()
                .filter(|c| c.category_kind == "companion")
                .collect();
            let issues = companion_issues(&zone, &active, &spec);
            assert_same(
                &serde_json::to_value(&issues).expect("issues serialise"),
                &case["issues"],
                name(case),
            );
        }
    }
}
