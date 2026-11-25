//! Reading the deck goldens — the files under `packages/ui/features/decks/__golden__/` that the
//! TypeScript engine writes (`packages/ui/features/decks/golden/*.golden.test.ts`) and
//! [`crate::deck_rules`] and [`crate::deck_stats`] must reproduce.
//!
//! A golden file is `{ about, base, specs?, cases }`. `base` is one whole `DeckCard` (the
//! validation fixtures' `card()` default) and every card in a case is written as **the fields
//! that differ from it** — so a card is `{ ...base, ...override }`, which [`card`] rebuilds and
//! deserialises into a [`DeckCardRow`]. `specs` holds the `FormatSpec`s a case names by key.
//!
//! [`same`] is how an answer is compared: exact JSON, except that two numbers are equal when their
//! `f64` values are — JavaScript writes `1` for `1.0`, and `serde_json` keeps the two apart.

use crate::combos::DeckCombo;
use crate::deck::{DeckCardRow, FormatSpecRow};
use serde_json::{Map, Value};

/// One golden file, parsed.
pub(crate) struct Golden {
    pub base: Map<String, Value>,
    pub specs: Map<String, Value>,
    pub cases: Vec<Value>,
}

/// Parse a golden file's text. Panics on a malformed file: a golden that cannot be read is a test
/// that cannot pass.
pub(crate) fn load(text: &str) -> Golden {
    let mut file: Value = serde_json::from_str(text).expect("a golden is JSON");
    let take = |file: &mut Value, key: &str| file.get_mut(key).map(Value::take);
    let base = match take(&mut file, "base") {
        Some(Value::Object(base)) => base,
        _ => Map::new(),
    };
    let specs = match take(&mut file, "specs") {
        Some(Value::Object(specs)) => specs,
        _ => Map::new(),
    };
    let cases = match take(&mut file, "cases") {
        Some(Value::Array(cases)) => cases,
        _ => panic!("a golden has cases"),
    };
    assert!(!cases.is_empty(), "a golden with no cases proves nothing");
    Golden { base, specs, cases }
}

impl Golden {
    /// One card: `base` with `over`'s fields laid on it.
    pub fn card(&self, over: &Value) -> DeckCardRow {
        let mut whole = self.base.clone();
        if let Value::Object(over) = over {
            for (k, v) in over {
                whole.insert(k.clone(), v.clone());
            }
        }
        serde_json::from_value(Value::Object(whole)).expect("a golden card is a DeckCard")
    }

    /// Every card of a case's list (an array of overrides).
    pub fn cards(&self, list: &Value) -> Vec<DeckCardRow> {
        list.as_array()
            .expect("a golden card list is an array")
            .iter()
            .map(|over| self.card(over))
            .collect()
    }

    /// The spec a case names by key.
    pub fn spec(&self, key: &Value) -> FormatSpecRow {
        let key = key.as_str().expect("a case names its spec by key");
        let spec = self
            .specs
            .get(key)
            .unwrap_or_else(|| panic!("the golden carries spec {key}"));
        serde_json::from_value(spec.clone()).expect("a golden spec is a FormatSpec")
    }
}

/// A case's combos, as the TypeScript wrote them.
pub(crate) fn combos(list: &Value) -> Vec<DeckCombo> {
    serde_json::from_value(list.clone()).expect("golden combos are DeckCombos")
}

/// Exact JSON equality, with numbers compared as `f64`.
pub(crate) fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// [`same`], or a panic naming the case and showing both answers.
pub(crate) fn assert_same(actual: &Value, expected: &Value, case: &str) {
    assert!(
        same(actual, expected),
        "golden case {case:?}\n--- rust ---\n{}\n--- typescript ---\n{}",
        serde_json::to_string_pretty(actual).unwrap(),
        serde_json::to_string_pretty(expected).unwrap()
    );
}

/// A case's `name`.
pub(crate) fn name(case: &Value) -> &str {
    case["name"].as_str().expect("a golden case has a name")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_are_equal_by_value() {
        assert!(same(&json!({ "a": [1, 2.5] }), &json!({ "a": [1.0, 2.5] })));
        assert!(!same(&json!({ "a": 1 }), &json!({ "a": 1, "b": null })));
        assert!(!same(&json!([1]), &json!([1, 1])));
    }
}
