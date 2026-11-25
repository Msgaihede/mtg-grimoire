//! The parts of `packages/ui/lib/mana.ts` the stats read: `MANA_KEYS`, `emptyPips`, `addPips`,
//! `countPips`, `producedKeys` and `hasVariableCost`.
//!
//! The cost tokeniser is `mana.ts`' `SYMBOL` (`/\{([^}]*)\}/g`), which is the same expression
//! `engine.ts` reads mana values with — so it is [`symbols`], one tokeniser for both ports as
//! there is one for both TypeScript files. `manaParts` and the glyph table are drawing, not
//! arithmetic, and are not ported.

use crate::deck_rules::engine::symbols;
use serde::ser::{Serialize, SerializeMap, Serializer};
use std::ops::{Index, IndexMut};

/// `ManaKey`: WUBRG plus colourless. Serialises as its letter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
pub enum ManaKey {
    W,
    U,
    B,
    R,
    G,
    C,
}

/// `MANA_KEYS`, in their printed order — the order every per-colour figure is read in.
pub const MANA_KEYS: [ManaKey; 6] = [
    ManaKey::W,
    ManaKey::U,
    ManaKey::B,
    ManaKey::R,
    ManaKey::G,
    ManaKey::C,
];

impl ManaKey {
    /// The key's one letter, as `colors` and `produced_mana` spell it.
    pub fn letter(self) -> char {
        match self {
            ManaKey::W => 'W',
            ManaKey::U => 'U',
            ManaKey::B => 'B',
            ManaKey::R => 'R',
            ManaKey::G => 'G',
            ManaKey::C => 'C',
        }
    }

    /// `isPipKey`: the key a whole token names, if it names one of the six.
    fn of(token: &str) -> Option<ManaKey> {
        match token {
            "W" => Some(ManaKey::W),
            "U" => Some(ManaKey::U),
            "B" => Some(ManaKey::B),
            "R" => Some(ManaKey::R),
            "G" => Some(ManaKey::G),
            "C" => Some(ManaKey::C),
            _ => None,
        }
    }

    fn at(self) -> usize {
        self as usize
    }
}

/// `Record<ManaKey, T>`: one value per key, every key present. Serialises as a JSON object keyed
/// `W`…`C`, which is the TypeScript record's shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ByMana<T>(pub [T; 6]);

impl<T> Index<ManaKey> for ByMana<T> {
    type Output = T;
    fn index(&self, key: ManaKey) -> &T {
        &self.0[key.at()]
    }
}

impl<T> IndexMut<ManaKey> for ByMana<T> {
    fn index_mut(&mut self, key: ManaKey) -> &mut T {
        &mut self.0[key.at()]
    }
}

impl<T: Serialize> Serialize for ByMana<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(6))?;
        for key in MANA_KEYS {
            map.serialize_entry(&key, &self[key])?;
        }
        map.end()
    }
}

/// `PipCounts`: one count per key.
pub type PipCounts = ByMana<i64>;

/// `emptyPips`: six zeroes.
pub fn empty_pips() -> PipCounts {
    ByMana([0; 6])
}

/// `producedKeys`: the keys whose letter `produced` names, in [`MANA_KEYS`] order. `None` and
/// `""` are both empty; whether that means *makes no mana* or *unknown* is the caller's to keep.
/// Any letter that is not one of the six (`"2"`, a lowercase `"w"`) is dropped.
pub fn produced_keys(produced: Option<&str>) -> Vec<ManaKey> {
    let Some(produced) = produced.filter(|p| !p.is_empty()) else {
        return Vec::new();
    };
    MANA_KEYS
        .into_iter()
        .filter(|key| produced.contains(key.letter()))
        .collect()
}

/// `hasVariableCost`: does the cost name `{X}` (either case)? `{Y}` and `{Z}` are not X.
pub fn has_variable_cost(cost: Option<&str>) -> bool {
    let Some(cost) = cost.filter(|c| !c.is_empty()) else {
        return false;
    };
    symbols(cost).any(|symbol| symbol.to_lowercase() == "x")
}

/// `addPips`: fold one cost into `into`, `copies` times. Each symbol is uppercased and split on
/// `/`, and every half that is one of the six keys is a pip of it — so a hybrid is one pip of
/// each half, a twobrid or Phyrexian one of its colour, `{C}` a colourless pip, and generic
/// nothing.
pub fn add_pips(into: &mut PipCounts, cost: Option<&str>, copies: i64) {
    let Some(cost) = cost.filter(|c| !c.is_empty()) else {
        return;
    };
    for symbol in symbols(cost) {
        for half in symbol.to_uppercase().split('/') {
            if let Some(key) = ManaKey::of(half) {
                into[key] += copies;
            }
        }
    }
}

/// `countPips`: one cost's pips, one copy.
pub fn count_pips(cost: Option<&str>) -> PipCounts {
    let mut counts = empty_pips();
    add_pips(&mut counts, cost, 1);
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck_golden::{assert_same, load, name};
    use serde_json::{json, Value};

    const GOLDEN: &str =
        include_str!("../../../../packages/ui/features/decks/__golden__/mana.json");

    /// Every string of `mana.json`: `countPips`, `hasVariableCost` and `producedKeys`.
    #[test]
    fn the_mana_golden_reads_as_the_typescript_does() {
        let golden = load(GOLDEN);
        for case in &golden.cases {
            let input = case["input"].as_str();
            let actual = json!({
                "countPips": count_pips(input),
                "hasVariableCost": has_variable_cost(input),
                "producedKeys": produced_keys(input),
            });
            let expected = json!({
                "countPips": case["countPips"],
                "hasVariableCost": case["hasVariableCost"],
                "producedKeys": case["producedKeys"],
            });
            assert_same(
                &serde_json::to_value(&actual).unwrap(),
                &expected,
                name(case),
            );
        }
    }

    #[test]
    fn pips_serialise_as_the_record_does() {
        let value = serde_json::to_value(count_pips(Some("{1}{W/B}{W/B}{C}"))).unwrap();
        assert_eq!(
            value,
            json!({ "W": 2, "U": 0, "B": 2, "R": 0, "G": 0, "C": 1 })
        );
        let keys: Vec<Value> = produced_keys(Some("GW2u"))
            .iter()
            .map(|k| json!(k))
            .collect();
        assert_eq!(keys, [json!("W"), json!("G")]);
    }

    #[test]
    fn add_pips_weights_and_accumulates() {
        let mut counts = empty_pips();
        add_pips(&mut counts, Some("{R}{R}"), 4);
        add_pips(&mut counts, Some("{W/U}"), 2);
        add_pips(&mut counts, Some("{1}{C}"), 1);
        add_pips(&mut counts, None, 9);
        add_pips(&mut counts, Some("{G}"), 0);
        assert_eq!(counts.0, [2, 2, 0, 8, 0, 1]);
    }
}
