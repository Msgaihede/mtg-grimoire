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

use serde_json::Value;

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

    #[test]
    fn faces_of_is_an_array_or_nothing() {
        assert_eq!(faces_of(None).len(), 0);
        assert_eq!(faces_of(Some("not json")).len(), 0);
        assert_eq!(faces_of(Some("{\"a\":1}")).len(), 0);
        assert_eq!(faces_of(Some("[{\"a\":1}, null, 3]")).len(), 3);
    }
}
