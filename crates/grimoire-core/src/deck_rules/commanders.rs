//! `commanders.ts`: who may sit in the command zone, who may sit there *with* them, and what
//! colours the rest of the deck may be once they do.
//!
//! **Keyed by `spec.commander_rule`, never by a format key** — six rule names (`edh`, `brawl`,
//! `oathbreaker`, `pdh`, `duel`, `tlr`) cover the seeded commander formats. **The front face
//! decides** ([`front_face`]), and **`color_identity` is concatenated letters**, never JSON
//! ([`identity_of`]).
//!
//! The TypeScript's regular expressions are written out as matchers below, each beside the
//! expression it replaces and each with its own test.

use super::issue::ValidationIssue;
use super::singleton::is_js_word;
use super::{face_text, faces_of, is_js_space, js_trim};
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

/// `isInstantOrSorcery`, by the front face.
pub(crate) fn is_instant_or_sorcery(card: &DeckCardRow) -> bool {
    front_face(card)
        .type_line
        .is_some_and(|t| has_card_type(&t, "Instant") || has_card_type(&t, "Sorcery"))
}

/// `isBackground`: a legendary Background — a legal *second* commander and nothing else.
pub(crate) fn is_background(type_line: &str) -> bool {
    is_legendary(type_line) && has_subtype(type_line, "Background")
}

/// `isTheDoctor`: a legendary creature whose creature types are **Time Lord Doctor and nothing
/// else** — Susan Foreman is a legendary Time Lord and is not the Doctor. The subtypes are read
/// with `.replace(/\s+/g, " ").trim()`.
pub(crate) fn is_the_doctor(type_line: &str) -> bool {
    if !is_legendary(type_line) || !has_card_type(type_line, "Creature") {
        return false;
    }
    squeeze_js_space(subtypes_of(type_line)) == "Time Lord Doctor"
}

/// `s.replace(/\s+/g, " ").trim()`: every run of JavaScript whitespace one space, then trimmed.
fn squeeze_js_space(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    js_trim(&out).to_owned()
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

/// `unionIdentity`: several definers, one identity.
fn union_identity(cards: &[&DeckCardRow]) -> Identity {
    cards.iter().fold(Identity::default(), |union, card| {
        union.union(identity_of(card))
    })
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

// ---------------------------------------------------------------------------------------------
// Eligibility — CR 903.3 and its per-format variants.
// ---------------------------------------------------------------------------------------------

/// One rule name's answer to "what may sit in the command zone", as data — `RuleDefinition`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuleDefinition {
    /// What this format calls the card, and how the sentence introduces it.
    pub noun: &'static str,
    pub noun_phrase: &'static str,
    /// The prose after "must be", so every refusal says what would have worked.
    pub requirement: &'static str,
    pub legendary: bool,
    pub creature: bool,
    pub planeswalker: bool,
    /// Vehicles and Spacecraft qualify only **with a power and toughness** (CR 903.3, 2026).
    pub vehicle: bool,
    pub spacecraft: bool,
    /// CR 903.3's escape hatch: the cards whose own rules text grants it.
    pub can_be_your_commander: bool,
    /// TRAP C: Pauper Commander's commander is judged by rarity, never by its legality key.
    pub ever_uncommon: bool,
}

const EDH_REQUIREMENT: &str = concat!(
    "a legendary creature, a legendary Vehicle or Spacecraft with a power and toughness, or a ",
    "card that says it can be your commander"
);

/// EDH's rule plus planeswalkers — Brawl's (CR 903.12c) and Tiny Leaders'.
const BROAD_REQUIREMENT: &str = concat!(
    "a legendary creature or planeswalker, a legendary Vehicle or Spacecraft with a power and ",
    "toughness, or a card that says it can be your commander"
);

const COMMANDER_NOUN: (&str, &str) = ("commander", "a commander");

/// `RULES`, one row per `format_specs.commander_rule` value.
pub const RULES: [(&str, RuleDefinition); 6] = [
    (
        "edh",
        RuleDefinition {
            noun: COMMANDER_NOUN.0,
            noun_phrase: COMMANDER_NOUN.1,
            requirement: EDH_REQUIREMENT,
            legendary: true,
            creature: true,
            planeswalker: false,
            vehicle: true,
            spacecraft: true,
            can_be_your_commander: true,
            ever_uncommon: false,
        },
    ),
    (
        "brawl",
        RuleDefinition {
            noun: COMMANDER_NOUN.0,
            noun_phrase: COMMANDER_NOUN.1,
            requirement: BROAD_REQUIREMENT,
            legendary: true,
            creature: true,
            planeswalker: true,
            vehicle: true,
            spacecraft: true,
            can_be_your_commander: true,
            ever_uncommon: false,
        },
    ),
    // The signature spell is a zone rule, not an eligibility one (`command_zone_ineligibility`).
    (
        "oathbreaker",
        RuleDefinition {
            noun: "oathbreaker",
            noun_phrase: "an oathbreaker",
            requirement: "a planeswalker",
            legendary: false,
            creature: false,
            planeswalker: true,
            vehicle: false,
            spacecraft: false,
            can_be_your_commander: false,
            ever_uncommon: false,
        },
    ),
    (
        "pdh",
        RuleDefinition {
            noun: COMMANDER_NOUN.0,
            noun_phrase: COMMANDER_NOUN.1,
            requirement: "a creature, Vehicle or Spacecraft that has been printed at uncommon",
            legendary: false,
            creature: true,
            planeswalker: false,
            vehicle: true,
            spacecraft: true,
            can_be_your_commander: false,
            ever_uncommon: true,
        },
    ),
    // EDH's eligibility; what makes it its own rule is TRAP A (`restricted` bans a commander).
    (
        "duel",
        RuleDefinition {
            noun: COMMANDER_NOUN.0,
            noun_phrase: COMMANDER_NOUN.1,
            requirement: EDH_REQUIREMENT,
            legendary: true,
            creature: true,
            planeswalker: false,
            vehicle: true,
            spacecraft: true,
            can_be_your_commander: true,
            ever_uncommon: false,
        },
    ),
    // Planeswalkers like Brawl, Vehicles like EDH — and Spacecraft, which the format's own pool
    // admits though the research doc's cell does not name it.
    (
        "tlr",
        RuleDefinition {
            noun: COMMANDER_NOUN.0,
            noun_phrase: COMMANDER_NOUN.1,
            requirement: BROAD_REQUIREMENT,
            legendary: true,
            creature: true,
            planeswalker: true,
            vehicle: true,
            spacecraft: true,
            can_be_your_commander: true,
            ever_uncommon: false,
        },
    ),
];

/// `RULES[rule]`.
pub fn rule_definition(rule: &str) -> Option<&'static RuleDefinition> {
    RULES
        .iter()
        .find(|(name, _)| *name == rule)
        .map(|(_, def)| def)
}

/// The phrase the cards print; rules text, so the test is on the unstripped oracle text.
const CAN_BE_YOUR_COMMANDER: &str = "can be your commander";

/// `CREATURE_OFF_THE_BATTLEFIELD`:
/// `/isn['’]t on the battlefield, it['’]s an? [^.\n]*\bcreature in addition to its other types/i`
/// — Grist, the Hunger Tide's ability, which makes the card a creature in the command zone
/// (issue #1547).
///
/// Without the `u` flag, `i` folds ASCII letters only (a non-ASCII character never canonicalises
/// to an ASCII one), and `\b` is an ASCII word boundary; both are read here a byte at a time,
/// which is exact because every byte of a multi-byte character is non-ASCII.
pub(crate) fn creature_off_the_battlefield(text: &str) -> bool {
    let b = text.as_bytes();
    (0..b.len()).any(|start| off_the_battlefield_at(b, start))
}

fn off_the_battlefield_at(b: &[u8], at: usize) -> bool {
    const TYPES: &[u8] = b"creature in addition to its other types";
    let Some(after) = literal_ci(b, at, b"isn")
        .and_then(|i| apostrophe(b, i))
        .and_then(|i| literal_ci(b, i, b"t on the battlefield, it"))
        .and_then(|i| apostrophe(b, i))
        .and_then(|i| literal_ci(b, i, b"s a"))
        // `n?` then a space: when an `n` follows it must be taken, or the space cannot match.
        .map(|i| literal_ci(b, i, b"n").unwrap_or(i))
        .and_then(|i| literal_ci(b, i, b" "))
    else {
        return false;
    };
    // `[^.\n]*\bcreature…`: any start before the first `.` or `\n`, at a word boundary. The byte
    // before `after` is the space just matched, so the first candidate is always a boundary.
    for p in after..b.len() {
        if p > after && matches!(b[p - 1], b'.' | b'\n') {
            return false;
        }
        let boundary = !is_js_word(char::from(b[p - 1]));
        if boundary && literal_ci(b, p, TYPES).is_some() {
            return true;
        }
    }
    false
}

/// `lit` at `at`, ASCII case-insensitively; the index just past it.
fn literal_ci(b: &[u8], at: usize, lit: &[u8]) -> Option<usize> {
    let end = at.checked_add(lit.len())?;
    b.get(at..end)?.eq_ignore_ascii_case(lit).then_some(end)
}

/// `['’]`.
fn apostrophe(b: &[u8], at: usize) -> Option<usize> {
    if b.get(at) == Some(&b'\'') {
        return Some(at + 1);
    }
    const RIGHT_QUOTE: &[u8] = "\u{2019}".as_bytes();
    b.get(at..at + RIGHT_QUOTE.len())
        .filter(|s| *s == RIGHT_QUOTE)
        .map(|_| at + RIGHT_QUOTE.len())
}

/// `commanderIneligibility`: why this card cannot sit in the command zone under this rule, or
/// `None` if it can. About the card **on its own**: a Background is refused here and made legal by
/// [`validate_commander_zone`]'s pairing, and an orphan (no type line) is not judged.
///
/// An unknown rule name is `None` too; the TypeScript reads `RULES[rule]` and would throw.
pub fn commander_ineligibility(
    card: &DeckCardRow,
    rule: &str,
    spec: &FormatSpecRow,
) -> Option<String> {
    let front = front_face(card);
    let type_line = front.type_line.as_deref()?;
    let def = rule_definition(rule)?;
    let format = &spec.display_name;
    let name = &card.name;
    let noun = def.noun;
    let oracle = front.oracle_text.as_deref().unwrap_or("");

    if def.can_be_your_commander && oracle.contains(CAN_BE_YOUR_COMMANDER) {
        return None;
    }

    let vehicle = def.vehicle && has_subtype(type_line, "Vehicle");
    let spacecraft = def.spacecraft && has_subtype(type_line, "Spacecraft");
    // A printed P/T box: both columns null is a card that genuinely has none.
    let has_power_and_toughness = front.power.is_some() && front.toughness.is_some();
    let creature = has_card_type(type_line, "Creature") || creature_off_the_battlefield(oracle);
    let type_ok = (def.creature && creature)
        || (def.planeswalker && has_card_type(type_line, "Planeswalker"))
        || ((vehicle || spacecraft) && has_power_and_toughness);
    let legendary_ok = !def.legendary || is_legendary(type_line);

    if legendary_ok && type_ok {
        // TRAP C: rarity is the whole of Pauper Commander's commander rule.
        if def.ever_uncommon && !card.ever_uncommon {
            return Some(format!(
                "{name} has never been printed at uncommon, so it can't be your {noun} in {format}."
            ));
        }
        return None;
    }

    if (vehicle || spacecraft) && !has_power_and_toughness && legendary_ok {
        // "legendary" only where the rule asks for it.
        let legendary = if def.legendary { "legendary " } else { "" };
        let kind = if vehicle { "Vehicle" } else { "Spacecraft" };
        return Some(format!(
            "{name} has no power and toughness, so it can't be your {noun} in {format}; a {legendary}{kind} needs one."
        ));
    }

    if def.creature && is_background(type_line) {
        return Some(format!(
            "{name} is a Background, so it can only be a second commander beside a card that says \u{201C}Choose a Background\u{201D}."
        ));
    }

    Some(format!(
        "{name} isn't a legal {noun} in {format}: {} must be {}.",
        def.noun_phrase, def.requirement
    ))
}

/// `commandZoneIneligibility`: [`commander_ineligibility`] everywhere but Oathbreaker, whose zone
/// also holds the signature spell — an instant or sorcery is accepted there and nowhere else. The
/// one predicate for "may this card go in the zone" (the importer and **Set as commander** ask it).
pub fn command_zone_ineligibility(
    card: &DeckCardRow,
    rule: &str,
    spec: &FormatSpecRow,
) -> Option<String> {
    if rule == "oathbreaker" && is_instant_or_sorcery(card) {
        return None;
    }
    commander_ineligibility(card, rule, spec)
}

// ---------------------------------------------------------------------------------------------
// Partner abilities — CR 702.124 and its named variants.
// ---------------------------------------------------------------------------------------------

/// JavaScript's `LineTerminator`: where the `m` flag's `^` and `$` match.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Every position the `m` flag's `^` matches, as the text from there on, in order.
fn line_starts(text: &str) -> impl Iterator<Item = &str> {
    std::iter::once(0)
        .chain(
            text.char_indices()
                .filter(|(_, c)| is_line_terminator(*c))
                .map(|(i, c)| i + c.len_utf8()),
        )
        .map(move |i| &text[i..])
}

/// `[ \t]*(?:\(|$)` at the start of `rest`, with the `m` flag's `$`. Greedy and unambiguous: after
/// fewer blanks the next character is a blank, which is neither.
fn closes(rest: &str) -> bool {
    match rest.trim_start_matches([' ', '\t']).chars().next() {
        None => true,
        Some(c) => c == '(' || is_line_terminator(c),
    }
}

/// `([^\n(]+?)[ \t]*(?:\(|$)` at the start of `rest`: the shortest capture of at least one
/// character after which the line closes.
fn lazy_capture(rest: &str) -> Option<&str> {
    for (i, c) in rest.char_indices() {
        if c == '\n' || c == '(' {
            return None;
        }
        let end = i + c.len_utf8();
        if closes(&rest[end..]) {
            return Some(&rest[..end]);
        }
    }
    None
}

/// `PARTNER_PLAIN`: `/^Partner[ \t]*(?:\(|$)/m` — line-anchored, so `Partner with …` and
/// `Partner—…` are not plain partner, and the reminder text is optional.
fn partner_plain(text: &str) -> bool {
    line_starts(text).any(|line| line.strip_prefix("Partner").is_some_and(closes))
}

/// `PARTNER_WITH`'s capture: `/^Partner with ([^\n(]+?)[ \t]*(?:\(|$)/m`, first match.
fn partner_with(text: &str) -> Option<&str> {
    line_starts(text).find_map(|line| line.strip_prefix("Partner with ").and_then(lazy_capture))
}

/// `PARTNER_VARIANT`'s capture: `/^Partner—([^\n(]+?)[ \t]*(?:\(|$)/m`, first match.
fn partner_variant(text: &str) -> Option<&str> {
    line_starts(text).find_map(|line| {
        line.strip_prefix("Partner")
            .and_then(|rest| rest.strip_prefix(EM_DASH))
            .and_then(lazy_capture)
    })
}

const CHOOSE_A_BACKGROUND: &str = "Choose a Background";
const DOCTORS_COMPANION: &str = "Doctor's companion";

/// `PartnerFacts`: every way one card can be half of a pair, read off its front face.
struct PartnerFacts {
    plain: bool,
    /// The card `Partner with` names, printed and trimmed.
    with_name: Option<String>,
    /// The tag after `Partner—`: "Friends forever", "Character select", …
    variant: Option<String>,
    chooses_background: bool,
    doctors_companion: bool,
    is_background: bool,
    is_doctor: bool,
}

fn partner_facts_of(card: &DeckCardRow) -> PartnerFacts {
    let front = front_face(card);
    let oracle = front.oracle_text.as_deref().unwrap_or("");
    let type_line = front.type_line.as_deref().unwrap_or("");
    PartnerFacts {
        plain: partner_plain(oracle),
        with_name: partner_with(oracle).map(|n| js_trim(n).to_owned()),
        variant: partner_variant(oracle).map(|v| js_trim(v).to_owned()),
        chooses_background: oracle.contains(CHOOSE_A_BACKGROUND),
        doctors_companion: oracle.contains(DOCTORS_COMPANION),
        is_background: is_background(type_line),
        is_doctor: is_the_doctor(type_line),
    }
}

/// `abilityLabel`: how a message names the ability, or `None` when the card has none.
fn ability_label(facts: &PartnerFacts) -> Option<String> {
    if facts.plain {
        return Some("partner".to_owned());
    }
    if let Some(variant) = &facts.variant {
        return Some(format!("partner{EM_DASH}{variant}"));
    }
    if let Some(name) = &facts.with_name {
        return Some(format!("partner with {name}"));
    }
    if facts.chooses_background {
        return Some("\u{201C}Choose a Background\u{201D}".to_owned());
    }
    if facts.doctors_companion {
        return Some("Doctor's companion".to_owned());
    }
    None
}

/// `namesCard`: `Partner with` names a card by its printed name; a two-faced card by its front.
fn names_card(printed: &str, card: &DeckCardRow) -> bool {
    let wanted = js_trim(printed);
    wanted == card.name || wanted == js_trim(card.name.split(" // ").next().unwrap_or(""))
}

/// `sameTag`.
fn same_tag(a: &str, b: &str) -> bool {
    js_trim(a).to_lowercase() == js_trim(b).to_lowercase()
}

/// `Pairing`.
enum Pairing<'a> {
    /// `excused` is the card the pairing — and only the pairing — makes a legal commander.
    Ok { excused: Option<&'a DeckCardRow> },
    /// `covers`: both cards' own eligibility sentences are already said (two Backgrounds only).
    Failed { message: String, covers: bool },
}

/// `pairingOf`, CR 702.124: two commanders are legal only through a shared partner ability, and
/// the variants never mix (702.124f).
fn pairing_of<'a>(a: &'a DeckCardRow, b: &'a DeckCardRow) -> Pairing<'a> {
    let fa = partner_facts_of(a);
    let fb = partner_facts_of(b);
    let ok = Pairing::Ok { excused: None };

    if fa.plain && fb.plain {
        return ok;
    }
    // 702.124e: the naming is mutual.
    if let (Some(wa), Some(wb)) = (&fa.with_name, &fb.with_name) {
        if names_card(wa, b) && names_card(wb, a) {
            return ok;
        }
    }
    if let (Some(va), Some(vb)) = (&fa.variant, &fb.variant) {
        if same_tag(va, vb) {
            return ok;
        }
    }
    if fa.chooses_background && fb.is_background {
        return Pairing::Ok { excused: Some(b) };
    }
    if fb.chooses_background && fa.is_background {
        return Pairing::Ok { excused: Some(a) };
    }
    if (fa.doctors_companion && fb.is_doctor) || (fb.doctors_companion && fa.is_doctor) {
        return ok;
    }
    Pairing::Failed {
        message: pairing_failure(a, &fa, b, &fb),
        covers: fa.is_background && fb.is_background,
    }
}

/// `pairingFailure`: the most specific true sentence about why these two cannot both be
/// commanders.
fn pairing_failure(
    a: &DeckCardRow,
    fa: &PartnerFacts,
    b: &DeckCardRow,
    fb: &PartnerFacts,
) -> String {
    if fa.is_background && fb.is_background {
        return format!(
            "{} and {} are both Backgrounds; a Background is a second commander beside a card that says \u{201C}Choose a Background\u{201D}.",
            a.name, b.name
        );
    }
    if fa.chooses_background || fb.chooses_background {
        let (chooser, other) = if fa.chooses_background {
            (a, b)
        } else {
            (b, a)
        };
        return format!(
            "{} says \u{201C}Choose a Background\u{201D}, so the other commander must be a legendary Background; {} isn't one.",
            chooser.name, other.name
        );
    }
    if fa.doctors_companion || fb.doctors_companion {
        let (companion, other) = if fa.doctors_companion { (a, b) } else { (b, a) };
        return format!(
            "{} has Doctor's companion, so the other commander must be a legendary Time Lord Doctor; {} isn't one.",
            companion.name, other.name
        );
    }
    // Name the side that is wrong, not the first side.
    if let Some(wanted) = fa.with_name.as_deref().filter(|w| !names_card(w, b)) {
        return format!(
            "{} partners only with {wanted}; {} isn't that card.",
            a.name, b.name
        );
    }
    if let Some(wanted) = fb.with_name.as_deref().filter(|w| !names_card(w, a)) {
        return format!(
            "{} partners only with {wanted}; {} isn't that card.",
            b.name, a.name
        );
    }
    match (ability_label(fa), ability_label(fb)) {
        (Some(la), Some(lb)) => format!(
            "{} has {la} and {} has {lb}; two commanders must share one partner ability.",
            a.name, b.name
        ),
        (Some(label), None) => format!(
            "{} has {label}, but {} has no partner ability; a second commander needs one.",
            a.name, b.name
        ),
        (None, Some(label)) => format!(
            "{} has {label}, but {} has no partner ability; a second commander needs one.",
            b.name, a.name
        ),
        (None, None) => format!(
            "{} and {} can't both be commanders; a second commander needs a partner ability.",
            a.name, b.name
        ),
    }
}

// ---------------------------------------------------------------------------------------------
// The zone.
// ---------------------------------------------------------------------------------------------

/// `validateCommanderZone`: how many cards the command zone holds, whether each may be there,
/// whether two may be there together, and — under `banned_as_commander` — whether one is banned
/// from it. Called for **every** format: a card in a `commander` pile of a format with none is in
/// the wrong pile.
pub fn validate_commander_zone(
    zone: &[&DeckCardRow],
    spec: &FormatSpecRow,
) -> Vec<ValidationIssue> {
    let format = &spec.display_name;
    let rule = match spec.commander_rule.as_deref() {
        Some(rule) if spec.requires_commander => rule,
        _ => {
            return zone
                .iter()
                .map(|card| {
                    ValidationIssue::error(
                        "commander-zone",
                        format!(
                            "{format} decks have no commander; move {} to the main deck.",
                            card.name
                        ),
                        Some(vec![card.card_id.clone()]),
                    )
                })
                .collect();
        }
    };
    if rule == "oathbreaker" {
        return oathbreaker_zone_issues(zone, spec);
    }

    let count: i64 = zone.iter().map(|card| card.quantity).sum();
    if count == 0 {
        return vec![ValidationIssue::error(
            "commander-missing",
            format!("{format} decks need a commander; the command zone is empty."),
            None,
        )];
    }

    let mut issues = Vec::new();
    // CR 702.124g: never more than two, and only ever two through a partner ability.
    if count > 2 {
        issues.push(ValidationIssue::error(
            "commander-count",
            format!(
                "{format} decks have at most two commanders, and only with a partner ability; you have {count}."
            ),
            None,
        ));
    }

    // Pairing is about two rows; two copies in one row is the copy pass's to say.
    let pair = (zone.len() == 2).then(|| pairing_of(zone[0], zone[1]));
    for card in zone {
        match &pair {
            Some(Pairing::Ok {
                excused: Some(excused),
            }) if std::ptr::eq(*excused, *card) => continue,
            Some(Pairing::Failed { covers: true, .. }) => continue,
            _ => {}
        }
        if let Some(why) = commander_ineligibility(card, rule, spec) {
            issues.push(ValidationIssue::error(
                "commander-eligibility",
                why,
                Some(vec![card.card_id.clone()]),
            ));
        }
    }
    if let Some(Pairing::Failed { message, .. }) = pair {
        issues.push(ValidationIssue::error(
            "commander-partner",
            message,
            Some(zone.iter().map(|card| card.card_id.clone()).collect()),
        ));
    }
    issues.extend(banned_as_commander_issues(zone, spec));
    issues
}

/// `oathbreakerZoneIssues`: a planeswalker and an instant or sorcery, the spell inside the
/// planeswalker's identity. Partner oathbreakers are legal and bring a signature spell each; a
/// pair is held to its **union** — this app's permissive reading, since the zone does not say
/// which spell is whose.
fn oathbreaker_zone_issues(zone: &[&DeckCardRow], spec: &FormatSpecRow) -> Vec<ValidationIssue> {
    let format = &spec.display_name;
    if zone.is_empty() {
        return vec![ValidationIssue::error(
            "commander-missing",
            format!(
                "{format} decks need an oathbreaker and a signature spell; the command zone is empty."
            ),
            None,
        )];
    }

    let mut issues = Vec::new();
    let walkers: Vec<&DeckCardRow> = zone
        .iter()
        .copied()
        .filter(|card| is_planeswalker_card(card))
        .collect();
    let spells: Vec<&DeckCardRow> = zone
        .iter()
        .copied()
        .filter(|card| is_instant_or_sorcery(card))
        .collect();
    for card in zone {
        if let Some(why) = command_zone_ineligibility(card, "oathbreaker", spec) {
            issues.push(ValidationIssue::error(
                "commander-eligibility",
                why,
                Some(vec![card.card_id.clone()]),
            ));
        }
    }

    match walkers.len() {
        0 => issues.push(ValidationIssue::error(
            "commander-missing",
            format!("{format} decks need an oathbreaker: one planeswalker in the command zone."),
            None,
        )),
        1 => {}
        2 => {
            if let Pairing::Failed { message, .. } = pairing_of(walkers[0], walkers[1]) {
                issues.push(ValidationIssue::error(
                    "commander-partner",
                    message,
                    Some(walkers.iter().map(|card| card.card_id.clone()).collect()),
                ));
            }
        }
        many => issues.push(ValidationIssue::error(
            "commander-count",
            format!(
                "{format} decks have at most two oathbreakers, and only with a partner ability; you have {many}."
            ),
            None,
        )),
    }

    // One signature spell **per oathbreaker**; the sentence quotes the cap, never the walkers.
    let spell_cap = walkers.len().clamp(1, 2);
    if spells.is_empty() {
        issues.push(ValidationIssue::error(
            "commander-missing",
            format!(
                "{format} decks need a signature spell: one instant or sorcery in the command zone."
            ),
            None,
        ));
    } else if spells.len() > spell_cap {
        let message = if spell_cap == 1 {
            format!(
                "{format} decks have one signature spell; you have {}.",
                spells.len()
            )
        } else {
            format!(
                "{format} decks have one signature spell per oathbreaker, so at most two; you have {}.",
                spells.len()
            )
        };
        issues.push(ValidationIssue::error("commander-count", message, None));
    }

    // Outside the walker-count branches on purpose: two oathbreakers must not switch it off.
    if !walkers.is_empty() {
        let oathbreakers = union_identity(&walkers);
        let possessive = if walkers.len() > 1 {
            "oathbreakers'"
        } else {
            "oathbreaker's"
        };
        for spell in &spells {
            let identity = identity_of(spell);
            if identity.within(oathbreakers) {
                continue;
            }
            issues.push(ValidationIssue::error(
                "color-identity",
                format!(
                    "{}'s color identity ({}) is outside your {possessive} ({}); a signature spell must fit inside it.",
                    spell.name,
                    name_identity(identity),
                    name_identity(oathbreakers)
                ),
                Some(vec![spell.card_id.clone()]),
            ));
        }
    }
    issues
}

/// `bannedAsCommanderIssues`, TRAP A's second meaning: where `restricted` is *banned as a
/// commander* (Duel Commander, Tiny Leaders: Reborn) it is a command-zone rule, and the main deck
/// stays silent about it.
fn banned_as_commander_issues(zone: &[&DeckCardRow], spec: &FormatSpecRow) -> Vec<ValidationIssue> {
    if !spec.has_legality_data || spec.restricted_semantic != "banned_as_commander" {
        return Vec::new();
    }
    zone.iter()
        .filter(|card| legality_status(card, &spec.key).as_deref() == Some("restricted"))
        .map(|card| {
            ValidationIssue::error(
                "commander-banned",
                format!(
                    "{} is banned as a commander in {}.",
                    card.name, spec.display_name
                ),
                Some(vec![card.card_id.clone()]),
            )
        })
        .collect()
}

/// `legalityStatus`: `legalities` parsed here (the zone is one or two rows), a status only when
/// the blob is a JSON object and the key's value a string.
fn legality_status(card: &DeckCardRow, key: &str) -> Option<String> {
    let text = card.legalities.as_deref()?;
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(blob)) => blob.get(key).and_then(Value::as_str).map(str::to_owned),
        _ => None,
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

    /// `isTheDoctor`'s `.replace(/\s+/g, " ").trim()`.
    #[test]
    fn the_doctor_is_time_lord_doctor_and_nothing_else() {
        assert!(is_the_doctor(
            "Legendary Creature \u{2014} Time Lord Doctor"
        ));
        assert!(is_the_doctor(
            "Legendary Creature \u{2014}  Time Lord\u{00A0}\t Doctor\u{FEFF}"
        ));
        assert!(!is_the_doctor("Legendary Creature \u{2014} Time Lord"));
        assert!(!is_the_doctor("Creature \u{2014} Time Lord Doctor"));
        assert!(!is_the_doctor(
            "Legendary Creature \u{2014} Time Lord Doctor Human"
        ));
        assert_eq!(squeeze_js_space(" a \u{2003}\n b "), "a b");
    }

    /// `/isn['’]t on the battlefield, it['’]s an? [^.\n]*\bcreature in addition to its
    /// other types/i`.
    #[test]
    fn creature_off_the_battlefield_is_the_regex() {
        let yes = |t: &str| creature_off_the_battlefield(t);
        assert!(yes(concat!(
            "As long as Grist, the Hunger Tide isn't on the battlefield, it's a 1/1 Insect ",
            "creature in addition to its other types."
        )));
        assert!(yes(
            "isn\u{2019}t on the battlefield, it\u{2019}s an Elemental creature in addition to its other types"
        ));
        assert!(yes(
            "ISN'T ON THE BATTLEFIELD, IT'S A CREATURE IN ADDITION TO ITS OTHER TYPES"
        ));
        assert!(yes(
            "isn't on the battlefield, it's a x. isn't on the battlefield, it's a creature in addition to its other types"
        ));
        assert!(yes(
            "isn't on the battlefield, it's a é creature in addition to its other types"
        ));
        // `[^.\n]*` stops at a sentence or a line end; `\b` needs a boundary; `an? ` needs its
        // space; the folding is ASCII only (`ı` does not fold to `i`).
        assert!(!yes(
            "isn't on the battlefield, it's a 1/1 Insect. creature in addition to its other types"
        ));
        assert!(!yes(
            "isn't on the battlefield, it's a 1/1 Insect\ncreature in addition to its other types"
        ));
        assert!(!yes(
            "isn't on the battlefield, it's a Insectcreature in addition to its other types"
        ));
        assert!(!yes(
            "isn't on the battlefield, it's ancreature in addition to its other types"
        ));
        assert!(!yes(
            "\u{0131}sn't on the battlefield, it's a creature in addition to its other types"
        ));
        assert!(!yes(
            "isn`t on the battlefield, it's a creature in addition to its other types"
        ));
        assert!(!yes(""));
        // `\r` is not in `[^.\n]`'s exclusion.
        assert!(yes(
            "isn't on the battlefield, it's a 1/1\r creature in addition to its other types"
        ));
    }

    /// `/^Partner[ \t]*(?:\(|$)/m`.
    #[test]
    fn partner_plain_is_line_anchored() {
        assert!(partner_plain("Flying\nPartner"));
        assert!(partner_plain("Partner (You can have two commanders.)"));
        assert!(partner_plain("Partner \t(x)"));
        assert!(partner_plain("Partner  "));
        assert!(partner_plain("Flying\r\nPartner\r\nVigilance"));
        assert!(partner_plain("Flying\u{2028}Partner"));
        assert!(partner_plain("Flying\u{2029}Partner\u{2028}x"));
        assert!(!partner_plain("Flying, Partner"));
        assert!(!partner_plain("Partners in crime"));
        assert!(!partner_plain("Partner with Amy Pond"));
        assert!(!partner_plain("Partner\u{2014}Friends forever"));
        assert!(!partner_plain("partner"));
        assert!(!partner_plain(""));
    }

    /// `/^Partner with ([^\n(]+?)[ \t]*(?:\(|$)/m` — the capture, before `.trim()`.
    #[test]
    fn partner_with_is_the_regex_s_capture() {
        assert_eq!(
            partner_with("Partner with Yannik, Scavenging Sentinel (When …)\nMenace"),
            Some("Yannik, Scavenging Sentinel")
        );
        assert_eq!(
            partner_with("Partner with Nikara, Lair Scavenger\nVigilance"),
            Some("Nikara, Lair Scavenger")
        );
        assert_eq!(partner_with("Menace\nPartner with Amy \t \nx"), Some("Amy"));
        assert_eq!(partner_with("Partner with Amy\r\n"), Some("Amy"));
        assert_eq!(partner_with("Partner with Amy\u{2028}x"), Some("Amy"));
        assert_eq!(
            partner_with("Partner with Amy\u{00A0}"),
            Some("Amy\u{00A0}")
        );
        // The capture takes at least one character, whatever it is.
        assert_eq!(partner_with("Partner with  (no one)"), Some(" "));
        assert_eq!(partner_with("Partner with \r\nx"), Some("\r"));
        assert_eq!(partner_with("Partner with (no one)"), None);
        assert_eq!(partner_with("Partner with \nAmy"), None);
        assert_eq!(partner_with("Partner with "), None);
        assert_eq!(partner_with("Flying, Partner with Amy"), None);
        // A miss on one line does not stop the search.
        assert_eq!(
            partner_with("Partner with (x)\nPartner with Rory"),
            Some("Rory")
        );
    }

    /// `/^Partner—([^\n(]+?)[ \t]*(?:\(|$)/m`.
    #[test]
    fn partner_variant_is_the_regex_s_capture() {
        assert_eq!(
            partner_variant("Haste\nPartner\u{2014}Friends forever (You can …)"),
            Some("Friends forever")
        );
        assert_eq!(
            partner_variant("Partner\u{2014}Character select"),
            Some("Character select")
        );
        assert_eq!(partner_variant("Partner\u{2014}(x)"), None);
        assert_eq!(partner_variant("Partner\u{2013}Friends forever"), None);
        assert_eq!(partner_variant("Partner \u{2014}Friends forever"), None);
    }

    #[test]
    fn every_rule_has_a_definition() {
        for rule in ["edh", "brawl", "oathbreaker", "pdh", "duel", "tlr"] {
            assert!(rule_definition(rule).is_some(), "{rule}");
        }
        assert!(rule_definition("vintage").is_none());
    }
}
