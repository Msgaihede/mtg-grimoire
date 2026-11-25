//! `singleton.ts`: the copy-count exceptions a card prints for itself ("A deck can have any number
//! of cards named …", "A deck can have up to seven cards named …"), read from oracle text and
//! never from a list of names, and the basic-land test.
//!
//! The anchor is the **whole clause from "A deck"**: the bare fragment "any number of cards named"
//! is also printed by cards that *search a library* for copies of themselves (Battalion Foot
//! Soldier), which is no deckbuilding permission at all.

/// `ANY_NUMBER_PHRASE`: the unlimited cards' clause, whole.
pub const ANY_NUMBER_PHRASE: &str = "A deck can have any number of cards named";

/// `UP_TO_PHRASE`: the capped cards' clause (Seven Dwarves, Nazgûl).
pub const UP_TO_PHRASE: &str = "A deck can have up to";

/// `WORD_NUMBERS`: the counts are printed as words, so a digit-only parse would read Seven Dwarves
/// as a singleton card. The table runs to twenty; digits are read after it.
const WORD_NUMBERS: [(&str, f64); 20] = [
    ("one", 1.0),
    ("two", 2.0),
    ("three", 3.0),
    ("four", 4.0),
    ("five", 5.0),
    ("six", 6.0),
    ("seven", 7.0),
    ("eight", 8.0),
    ("nine", 9.0),
    ("ten", 10.0),
    ("eleven", 11.0),
    ("twelve", 12.0),
    ("thirteen", 13.0),
    ("fourteen", 14.0),
    ("fifteen", 15.0),
    ("sixteen", 16.0),
    ("seventeen", 17.0),
    ("eighteen", 18.0),
    ("nineteen", 19.0),
    ("twenty", 20.0),
];

/// How many copies a deck may hold by the card's **own** text: `Some(INFINITY)`, a printed count,
/// or `None` when the card says nothing about it — `copyException`.
///
/// A clause whose count cannot be read is `Some(INFINITY)`, not `None`: the card is known to allow
/// more than one copy, and [`unreadable_copy_count`] lets the caller say it was not checked.
pub fn copy_exception(oracle_text: Option<&str>) -> Option<f64> {
    let text = oracle_text.filter(|t| !t.is_empty())?;
    if text.contains(ANY_NUMBER_PHRASE) {
        return Some(f64::INFINITY);
    }
    let printed = up_to_count(text)?;
    Some(count_of(printed).unwrap_or(f64::INFINITY))
}

/// The word printed after [`UP_TO_PHRASE`] when it could not be read as a number, and `None`
/// otherwise — `unreadableCopyCount`.
pub fn unreadable_copy_count(oracle_text: Option<&str>) -> Option<&str> {
    let text = oracle_text.filter(|t| !t.is_empty())?;
    if text.contains(ANY_NUMBER_PHRASE) {
        return None;
    }
    let printed = up_to_count(text)?;
    count_of(printed).is_none().then_some(printed)
}

/// CR 100.2a — `isBasicLand`: `Basic` **and** `Land` on the front face's type line, because
/// `"Basic Creature — Shapeshifter"` is a real type line and a two-faced card whose back is a
/// basic land is one card.
pub fn is_basic_land(type_line: Option<&str>) -> bool {
    type_line.is_some_and(|t| {
        let front = t.split("//").next().unwrap_or("");
        front.contains("Basic") && front.contains("Land")
    })
}

/// `UP_TO_COUNT`'s capture, first match: `` new RegExp(`${UP_TO_PHRASE} (\\w+) cards named`) ``.
///
/// JavaScript's `\w` is ASCII (`[A-Za-z0-9_]`). The run is greedy and cannot end early — a
/// shorter run leaves a word character where the space must be — so each occurrence of the phrase
/// is one candidate: the whole word run after it, then ` cards named`.
fn up_to_count(text: &str) -> Option<&str> {
    let mut from = 0;
    while let Some(at) = text[from..].find(UP_TO_PHRASE) {
        let start = from + at;
        let after = &text[start + UP_TO_PHRASE.len()..];
        if let Some(word) = after.strip_prefix(' ') {
            let run = word.find(|c: char| !is_js_word(c)).unwrap_or(word.len());
            if run > 0 && word[run..].starts_with(" cards named") {
                return Some(&word[..run]);
            }
        }
        // The phrase starts with an ASCII letter, so one byte on is a character boundary.
        from = start + 1;
    }
    None
}

/// JavaScript's `\w` without the `u` flag: `[A-Za-z0-9_]`.
pub(crate) fn is_js_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `countOf`: a word from the table (case-folded), then `Number.parseInt(printed, 10)` — its
/// leading digits — then nothing. The printed word is `\w+`, so it is ASCII with no sign.
fn count_of(printed: &str) -> Option<f64> {
    let lower = printed.to_ascii_lowercase();
    if let Some((_, n)) = WORD_NUMBERS.iter().find(|(word, _)| *word == lower) {
        return Some(*n);
    }
    let digits = printed.len()
        - printed
            .trim_start_matches(|c: char| c.is_ascii_digit())
            .len();
    if digits == 0 {
        return None;
    }
    printed[..digits].parse::<f64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck_golden::{assert_same, load, name};
    use crate::deck_rules::engine::mana_value_of;
    use serde_json::{json, Value};

    #[test]
    fn the_anchors_are_whole_sentences() {
        assert_eq!(
            ANY_NUMBER_PHRASE,
            "A deck can have any number of cards named"
        );
        assert_eq!(UP_TO_PHRASE, "A deck can have up to");
    }

    /// `/A deck can have up to (\w+) cards named/`, case by case.
    #[test]
    fn up_to_count_is_the_regex_s_first_capture() {
        let up = |t| up_to_count(t);
        assert_eq!(
            up("A deck can have up to seven cards named X."),
            Some("seven")
        );
        assert_eq!(up("A deck can have up to 12 cards named X."), Some("12"));
        assert_eq!(
            up("A deck can have up to seven_ cards named X"),
            Some("seven_")
        );
        // `\w+` must start right after the one space.
        assert_eq!(up("A deck can have up to  seven cards named X"), None);
        // Case-sensitive.
        assert_eq!(up("a deck can have up to seven cards named X"), None);
        // The run must be followed by " cards named"; a hyphen or an accent ends it.
        assert_eq!(up("A deck can have up to ninety-nine cards named X"), None);
        assert_eq!(up("A deck can have up to sevén cards named X"), None);
        assert_eq!(up("A deck can have up to sevencards named X"), None);
        // A failed occurrence does not stop the search.
        assert_eq!(
            up("A deck can have up to as many. A deck can have up to nine cards named Y"),
            Some("nine")
        );
        assert_eq!(up("A deck can have up to seven cards named"), Some("seven"));
    }

    #[test]
    fn count_of_reads_words_then_leading_digits() {
        assert_eq!(count_of("seven"), Some(7.0));
        assert_eq!(count_of("SEVEN"), Some(7.0));
        assert_eq!(count_of("07"), Some(7.0));
        assert_eq!(count_of("3rd"), Some(3.0));
        assert_eq!(count_of("1e3"), Some(1.0));
        assert_eq!(count_of("thirty"), None);
        assert_eq!(count_of("_7"), None);
    }

    #[test]
    fn copy_exceptions_from_printed_text() {
        let rats = "A deck can have any number of cards named Relentless Rats.";
        assert_eq!(copy_exception(Some(rats)), Some(f64::INFINITY));
        assert_eq!(copy_exception(Some("Lightning Bolt deals 3 damage.")), None);
        assert_eq!(copy_exception(None), None);
        assert_eq!(copy_exception(Some("")), None);
        let thirty = "A deck can have up to thirty cards named Goblin Trapfinder.";
        assert_eq!(copy_exception(Some(thirty)), Some(f64::INFINITY));
        assert_eq!(unreadable_copy_count(Some(thirty)), Some("thirty"));
        assert_eq!(unreadable_copy_count(Some(rats)), None);
    }

    #[test]
    fn basic_lands() {
        assert!(is_basic_land(Some("Basic Snow Land — Forest")));
        assert!(!is_basic_land(Some("Basic Creature — Shapeshifter")));
        assert!(!is_basic_land(Some(
            "Creature — Human // Basic Land — Island"
        )));
        assert!(!is_basic_land(None));
    }

    /// `Infinity` is spelled as a string in the golden, which JSON cannot hold.
    fn spelled(value: Option<f64>) -> Value {
        match value {
            Some(v) if v == f64::INFINITY => json!("Infinity"),
            Some(v) => json!(v),
            None => Value::Null,
        }
    }

    #[test]
    fn rules_text_golden() {
        let golden = load(include_str!(
            "../../../../packages/ui/features/decks/__golden__/rules-text.json"
        ));
        for case in &golden.cases {
            let text = case["text"].as_str();
            let actual = json!({
                "copyException": spelled(copy_exception(text)),
                "unreadableCopyCount": unreadable_copy_count(text),
                "isBasicLand": is_basic_land(text),
                "manaValueOf": mana_value_of(text),
            });
            let expected = json!({
                "copyException": case["copyException"],
                "unreadableCopyCount": case["unreadableCopyCount"],
                "isBasicLand": case["isBasicLand"],
                "manaValueOf": case["manaValueOf"],
            });
            assert_same(&actual, &expected, name(case));
        }
    }
}
