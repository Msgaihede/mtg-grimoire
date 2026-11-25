//! Deck validation and the Commander bracket estimate — **the Rust port of
//! `packages/ui/features/decks/validation/`**, so an agent reading a deck through the core gets
//! the deck page's own answers with no window open.
//!
//! **A port, not a second design.** The TypeScript is the behaviour of record: the deck page keeps
//! drawing its conclusions there, and nothing on the page reads this module. What keeps the two
//! copies one behaviour is the shared golden files under `packages/ui/features/decks/__golden__/`,
//! written by the TypeScript engine (`packages/ui/features/decks/golden/*.golden.test.ts`) and
//! reproduced here by each file's golden test. When the two disagree, this file is wrong — and a
//! change to the TypeScript is ported here in the same commit that regenerates the golden.
//!
//! One file per TypeScript file, under the same name: [`engine`] (`engine.ts`: size, copies, the
//! pool, the mana-value ceiling, and the two entry points), [`singleton`] (`singleton.ts`: the
//! printed copy-count exceptions), [`commanders`] (`commanders.ts`: the command zone, partners and
//! colour identity), [`companions`] (`companions.ts`: the ten conditions) and [`bracket`]
//! (`bracket.ts`: the advisory floor). [`issue`] is `types.ts`' `ValidationIssue`.
//!
//! **The inputs are the core's own rows.** `DeckCard` and `FormatSpec` are the hand-written
//! TypeScript mirrors of [`crate::deck::DeckCardRow`] and [`crate::deck::FormatSpecRow`], so the
//! port reads those two structs directly — a core command is `deck::get`, then this, with no
//! third shape of a card in between.
//!
//! **No regular expressions.** The core has no `regex` dependency and this module does not add
//! one: each of the TypeScript's expressions is written out as a matcher beside the constant it
//! replaces, with a test, and the goldens are what prove the two equal. JavaScript's `\s` is the
//! character set [`is_js_space`] answers, and its `\b` is an ASCII word boundary.

pub mod bracket;
pub mod commanders;
pub mod companions;
pub mod engine;
pub mod issue;
pub mod singleton;

pub use issue::{Severity, ValidationIssue};

use crate::deck::{get_deck, list_format_specs};
use crate::sorting::Marketplace;
use bracket::{bracket_warning, describe_reason, estimate_bracket, BracketEstimate};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

/// `deck_check`'s answer: what the deck page's validation panel and bracket readout say about one
/// list of one deck, read in the core so a host with no window can say it too.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCheck {
    pub deck_id: i64,
    pub variant: String,
    pub format_key: String,
    /// The format's display name, or `None` for a key `format_specs` does not carry.
    pub format_name: Option<String>,
    /// Whether the format is judged at all: `false` for a `validates`-off format (`unspecified`)
    /// and for a key the seed does not carry. An unchecked deck has no `issues` and is **not
    /// checked**, never "legal" — the panel's own words.
    pub checked: bool,
    /// [`engine::validate_deck`]: what is wrong with the deck — its active piles.
    pub issues: Vec<ValidationIssue>,
    /// [`engine::inactive_card_issues`]: what is wrong with the cards in switched-off piles, each
    /// judged on its own facts (could it ever come in) — the other half of the page's card marks.
    pub parked: Vec<ValidationIssue>,
    /// The bracket readout, only where the format has a commander rule — the page's own condition
    /// for drawing it.
    pub bracket: Option<DeckBracket>,
}

/// The bracket readout for one list: the estimate, the bracket the reader set, and the sentence
/// the page shows when the set bracket is below the floor.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckBracket {
    pub estimate: BracketEstimate,
    /// `decks.bracket`; `0` is Auto (no bracket set).
    pub set: i64,
    /// [`bracket::bracket_warning`] against `set`, or `None`.
    pub warning: Option<String>,
    /// Each of `estimate.reasons` as the page words it ([`bracket::describe_reason`]).
    pub reasons: Vec<String>,
    /// When Commander Spellbook's combo list was last downloaded (Unix seconds), or `None` when it
    /// never was — so an empty `estimate.combos` can be told apart from a deck with no combos.
    pub combos_downloaded_at: Option<i64>,
}

/// `deck_check`: one list of one deck judged as the deck page judges it — `None` for a deck that
/// does not exist (or an unsaved draft, which `get_deck` does not answer).
///
/// The combos the bracket reads are matched over the **active** rows' printings, deduplicated and
/// sorted, which is `useBracketReading`'s rule: a switched-off pile is not the deck.
pub fn check_deck(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
) -> Result<Option<DeckCheck>, String> {
    let Some(detail) = get_deck(conn, deck_id, variant, Marketplace::from_opt(None))? else {
        return Ok(None);
    };
    let format_key = detail.deck.format_key.clone();
    let spec = list_format_specs(conn)?
        .into_iter()
        .find(|spec| spec.key == format_key);
    let Some(spec) = spec else {
        return Ok(Some(DeckCheck {
            deck_id,
            variant: variant.to_owned(),
            format_key,
            format_name: None,
            checked: false,
            issues: Vec::new(),
            parked: Vec::new(),
            bracket: None,
        }));
    };
    let cards = &detail.cards;
    let bracket = match spec.commander_rule {
        None => None,
        Some(_) => {
            let mut ids: Vec<String> = cards
                .iter()
                .filter(|c| c.category_active)
                .map(|c| c.card_id.clone())
                .collect();
            ids.sort();
            ids.dedup();
            let combos = crate::combos::match_combos(conn, &ids)?;
            let now = conn
                .query_row("SELECT unixepoch()", [], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?;
            let estimate = estimate_bracket(cards, &combos);
            let set = detail.deck.bracket;
            Some(DeckBracket {
                warning: bracket_warning(set, &estimate),
                reasons: estimate.reasons.iter().map(describe_reason).collect(),
                estimate,
                set,
                combos_downloaded_at: crate::combos::read_status(conn, now).fetched_at,
            })
        }
    };
    Ok(Some(DeckCheck {
        deck_id,
        variant: variant.to_owned(),
        format_key,
        format_name: Some(spec.display_name.clone()),
        checked: spec.validates,
        issues: engine::validate_deck(cards, &spec),
        parked: if spec.validates {
            engine::inactive_card_issues(cards, &spec)
        } else {
            Vec::new()
        },
        bracket,
    }))
}

/// `faces` parsed as JavaScript's `JSON.parse` would, keeping it only when it is an array:
/// `card_faces` verbatim. A blob that is not JSON, or JSON that is not an array, is no faces at
/// all — never a panic, because a validator that throws on bad data hides the deck it was asked
/// about. Each caller reads its elements with [`Value::get`], which answers `None` for an element
/// that is not an object, as `face.oracle_text` answers `undefined` there.
pub(crate) fn faces_of(faces: Option<&str>) -> Vec<Value> {
    match faces.map(serde_json::from_str::<Value>) {
        Some(Ok(Value::Array(faces))) => faces,
        _ => Vec::new(),
    }
}

/// A string field of a face, or `None` — `typeof value === "string" ? value : null`.
pub(crate) fn face_text<'a>(face: &'a Value, key: &str) -> Option<&'a str> {
    face.get(key).and_then(Value::as_str)
}

/// JavaScript's whitespace: what `\s` matches and what `String.prototype.trim` strips —
/// `WhiteSpace` and `LineTerminator` in ECMA-262. Rust's [`char::is_whitespace`] differs at two
/// code points (it has U+0085 and lacks U+FEFF), which is why this is written out.
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `s.trim()`, as JavaScript trims.
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `Number(token)` where the answer is finite, else `None` — the one coercion the mana-value
/// arithmetic leans on, and a place JavaScript is generous: `""` and whitespace are `0`, the
/// string is trimmed first, `0x`/`0o`/`0b` integers read in their radix, and `"Infinity"` (or
/// anything past `f64`'s range) is not finite. Rust's own parser would also take `inf`, `nan` and
/// `infinity` in any case, which JavaScript reads as `NaN`; those are refused here.
pub(crate) fn js_number(token: &str) -> Option<f64> {
    let t = js_trim(token);
    if t.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return None;
            }
            // Past `u128` is past any mana cost; JavaScript would still read it, as a float.
            let value = u128::from_str_radix(digits, radix).ok()? as f64;
            return value.is_finite().then_some(value);
        }
    }
    // StrDecimalLiteral: a sign, digits with an optional point, an optional exponent. Every
    // character Rust's parser would also accept outside that grammar is a letter, so allowing
    // only these is what refuses `inf` and `nan`.
    if !t
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E'))
    {
        return None;
    }
    let value: f64 = t.parse().ok()?;
    value.is_finite().then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_number_reads_as_javascript_does() {
        assert_eq!(js_number(""), Some(0.0));
        assert_eq!(js_number("  "), Some(0.0));
        assert_eq!(js_number("2"), Some(2.0));
        assert_eq!(js_number(" 2 "), Some(2.0));
        assert_eq!(js_number("10"), Some(10.0));
        assert_eq!(js_number(".5"), Some(0.5));
        assert_eq!(js_number("5."), Some(5.0));
        assert_eq!(js_number("+3"), Some(3.0));
        assert_eq!(js_number("-1"), Some(-1.0));
        assert_eq!(js_number("1e2"), Some(100.0));
        assert_eq!(js_number("0x10"), Some(16.0));
        assert_eq!(js_number("0b11"), Some(3.0));
        assert_eq!(js_number("0o7"), Some(7.0));
        assert_eq!(js_number("0x"), None);
        assert_eq!(js_number("-0x10"), None);
        assert_eq!(js_number("W"), None);
        assert_eq!(js_number("½"), None);
        assert_eq!(js_number("Infinity"), None);
        assert_eq!(js_number("inf"), None);
        assert_eq!(js_number("nan"), None);
        assert_eq!(js_number("1e400"), None);
        assert_eq!(js_number("1e"), None);
        assert_eq!(js_number("2/W"), None);
    }

    #[test]
    fn js_trim_strips_javascript_whitespace_only() {
        assert_eq!(js_trim("\u{FEFF} a \u{00A0}"), "a");
        assert_eq!(js_trim("\u{0085}a"), "\u{0085}a");
    }

    /// The coverage fence, as `packages/ui/features/decks/golden/coverage.golden.test.ts` holds it
    /// on the TypeScript side: a rule with no golden case is a rule this port is not held to.
    #[test]
    fn the_goldens_cover_every_rule() {
        use crate::deck_golden::load;
        use std::collections::BTreeSet;

        let validation = load(include_str!(
            "../../../../packages/ui/features/decks/__golden__/validation.json"
        ));
        let whole = load(include_str!(
            "../../../../packages/ui/features/decks/__golden__/whole-deck.json"
        ));
        let companions = load(include_str!(
            "../../../../packages/ui/features/decks/__golden__/companions.json"
        ));
        let bracket = load(include_str!(
            "../../../../packages/ui/features/decks/__golden__/bracket.json"
        ));
        let words = |values: Vec<&Value>| -> BTreeSet<String> {
            values
                .into_iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        };
        let issues = |cases: &[Value], fields: &[&str]| -> Vec<Value> {
            cases
                .iter()
                .flat_map(|c| {
                    fields
                        .iter()
                        .flat_map(move |f| c[*f].as_array().unwrap().clone())
                })
                .map(|issue| issue["code"].clone())
                .collect()
        };

        // `types.ts`' vocabulary, both ways: every code answered somewhere, and no other.
        const CODES: [&str; 23] = [
            "deck-size",
            "sideboard-size",
            "copy-limit",
            "singleton",
            "restricted",
            "banned",
            "not-legal",
            "unknown-legality",
            "unknown-copy-limit",
            "orphan",
            "mana-value",
            "commander-zone",
            "commander-missing",
            "commander-count",
            "commander-eligibility",
            "commander-partner",
            "commander-banned",
            "color-identity",
            "companion-zone",
            "companion-count",
            "companion-eligibility",
            "companion-unknown",
            "companion-condition",
        ];
        let mut seen = issues(&validation.cases, &["deck", "marks"]);
        seen.extend(issues(&whole.cases, &["deck", "marks"]));
        seen.extend(issues(&companions.cases, &["issues"]));
        let seen = words(seen.iter().collect());
        let vocabulary: BTreeSet<String> = CODES.iter().map(|c| (*c).to_owned()).collect();
        assert_eq!(seen, vocabulary, "the issue codes the goldens answer");

        // Every commander rule a spec carries is judged by some case.
        let rules = words(
            validation
                .specs
                .values()
                .map(|s| &s["commanderRule"])
                .collect(),
        );
        let judged = words(
            validation
                .cases
                .iter()
                .map(|c| &validation.specs[c["spec"].as_str().unwrap()]["commanderRule"])
                .collect(),
        );
        assert_eq!(judged, rules, "the commander rules the cases judge");

        // Each of the ten companions sits in a companion zone somewhere.
        let zoned = words(
            companions
                .cases
                .iter()
                .flat_map(|c| c["cards"].as_array().unwrap())
                .filter(|row| row["categoryKind"] == "companion")
                .map(|row| &row["name"])
                .collect(),
        );
        for (name, _) in companions::COMPANIONS {
            assert!(zoned.contains(name), "no golden case zones {name}");
        }

        // Every bracket reason fires, and every combo letter the ingest admits is read.
        let reasons = words(
            bracket
                .cases
                .iter()
                .flat_map(|c| c["estimate"]["reasons"].as_array().unwrap())
                .map(|r| &r["code"])
                .collect(),
        );
        for code in bracket::ReasonCode::ALL {
            let code = serde_json::to_value(code).unwrap();
            assert!(
                reasons.contains(code.as_str().unwrap()),
                "no case fires {code}"
            );
        }
        let letters = words(
            bracket
                .cases
                .iter()
                .flat_map(|c| c["combos"].as_array().unwrap())
                .map(|combo| &combo["bracketTag"])
                .collect(),
        );
        for letter in crate::combos::BRACKET_TAGS {
            assert!(
                letters.contains(letter),
                "no case reads the letter {letter}"
            );
        }
    }

    #[test]
    fn faces_of_is_an_array_or_nothing() {
        assert_eq!(faces_of(None).len(), 0);
        assert_eq!(faces_of(Some("not json")).len(), 0);
        assert_eq!(faces_of(Some("{\"a\":1}")).len(), 0);
        assert_eq!(faces_of(Some("[{\"a\":1}, null, 3]")).len(), 3);
    }
}

#[cfg(test)]
mod check_tests {
    use super::*;
    use crate::deck::fixtures::{input, kind_of, main_of, seeded};
    use crate::deck::{add_card, create_deck, update_deck, DeckPatch};

    fn deck(conn: &Connection, format: &str) -> i64 {
        create_deck(conn, &input("Test", format)).unwrap().id
    }

    fn put(conn: &Connection, deck: i64, card: &str, pile: i64, quantity: i64) {
        add_card(conn, deck, card, Some(pile), None, "live", None, quantity).unwrap();
    }

    fn codes(issues: &[ValidationIssue]) -> Vec<&'static str> {
        issues.iter().map(|i| i.code).collect()
    }

    #[test]
    fn a_deck_is_judged_as_the_page_judges_it() {
        let conn = seeded();
        let id = deck(&conn, "modern");
        let main = main_of(&conn, id);
        put(&conn, id, "bolt-m10", main, 4);
        // Serra's blob has no `modern` key: a pool that does not name a card does not hold it.
        put(&conn, id, "serra-8ed", main, 1);
        let check = check_deck(&conn, id, "live").unwrap().unwrap();
        assert!(check.checked);
        assert_eq!(check.format_name.as_deref(), Some("Modern"));
        assert_eq!(codes(&check.issues), ["deck-size", "not-legal"]);
        assert!(check.parked.is_empty());
        assert!(check.bracket.is_none(), "Modern has no commander rule");
    }

    #[test]
    fn a_switched_off_pile_is_parked_not_judged_with_the_deck() {
        let conn = seeded();
        let id = deck(&conn, "modern");
        put(&conn, id, "bolt-m10", main_of(&conn, id), 4);
        put(&conn, id, "serra-8ed", kind_of(&conn, id, "maybe"), 1);
        let check = check_deck(&conn, id, "live").unwrap().unwrap();
        assert_eq!(codes(&check.issues), ["deck-size"]);
        assert_eq!(codes(&check.parked), ["not-legal"]);
    }

    #[test]
    fn an_unspecified_or_unknown_format_is_not_checked() {
        let conn = seeded();
        let id = deck(&conn, "unspecified");
        put(&conn, id, "serra-8ed", main_of(&conn, id), 9);
        let check = check_deck(&conn, id, "live").unwrap().unwrap();
        assert!(!check.checked);
        assert!(check.issues.is_empty() && check.parked.is_empty());

        conn.execute("UPDATE decks SET format_key = 'gone' WHERE id = ?1", [id])
            .unwrap();
        let check = check_deck(&conn, id, "live").unwrap().unwrap();
        assert!(!check.checked);
        assert_eq!(check.format_key, "gone");
        assert_eq!(check.format_name, None);
    }

    #[test]
    fn a_commander_deck_has_a_bracket_floor_and_says_when_combos_were_never_downloaded() {
        let conn = seeded();
        let id = deck(&conn, "commander");
        put(&conn, id, "bolt-m10", main_of(&conn, id), 1);
        let check = check_deck(&conn, id, "live").unwrap().unwrap();
        let bracket = check.bracket.expect("Commander has a commander rule");
        assert_eq!(bracket.estimate.floor, bracket::BASE_FLOOR);
        assert_eq!(bracket.set, 0);
        assert_eq!(bracket.warning, None);
        assert!(bracket.reasons.is_empty());
        assert_eq!(bracket.combos_downloaded_at, None);

        let patch = DeckPatch {
            bracket: Some(1),
            ..Default::default()
        };
        update_deck(&conn, id, &patch).unwrap();
        let bracket = check_deck(&conn, id, "live")
            .unwrap()
            .unwrap()
            .bracket
            .unwrap();
        assert_eq!(bracket.set, 1);
        // Set below a floor no rule reached: nothing in the deck contradicts the reader's 1.
        assert_eq!(bracket.warning, None);
    }

    #[test]
    fn a_deck_that_does_not_exist_is_none() {
        let conn = seeded();
        assert!(check_deck(&conn, 999, "live").unwrap().is_none());
        assert!(check_deck(&conn, 999, "nonsense").is_err());
    }
}
