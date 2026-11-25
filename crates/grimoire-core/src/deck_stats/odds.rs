//! `openingHand.ts`: `choose` and `handOdds`, the hypergeometric chance of meeting a card in an
//! opening hand. Four numbers and a mode; which rows were counted is the caller's question
//! (`buckets::library_cards`).
//!
//! Every operation is the TypeScript's, in its order — `choose`'s running product
//! multiply-then-divide, each term `(C(s,i) · C(d−s, n−i)) / C(d, n)`, the terms summed from the
//! low end — so the answer is the same `f64` JavaScript prints.

use serde::{Deserialize, Serialize};

/// `OddsMode`: at least, exactly or at most the copies asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OddsMode {
    #[default]
    AtLeast,
    Exactly,
    AtMost,
}

/// `HandOdds`: the four numbers and the mode one reading is made of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandOdds {
    /// Copies in the deck drawn from.
    pub deck: i64,
    /// Copies of the thing asked about.
    pub successes: i64,
    /// Cards drawn.
    pub hand: i64,
    /// Copies asked about.
    pub want: i64,
    pub mode: OddsMode,
}

/// `choose(n, k)`: `n` choose `k` as a running product, `0` for a `k` outside `[0, n]`.
pub fn choose(n: i64, k: i64) -> f64 {
    if k < 0 || k > n {
        return 0.0;
    }
    let mut out = 1.0;
    for i in 0..k {
        out = (out * (n - i) as f64) / (i + 1) as f64;
    }
    out
}

/// `handOdds`: the probability, in `[0, 1]`. `0` for an empty deck or an empty hand; a hand
/// larger than the deck draws the whole deck.
pub fn hand_odds(odds: &HandOdds) -> f64 {
    let HandOdds {
        deck,
        successes,
        hand,
        want,
        mode,
    } = *odds;
    if deck <= 0 || hand <= 0 {
        return 0.0;
    }
    let drawn = hand.min(deck);
    let exact =
        |i: i64| (choose(successes, i) * choose(deck - successes, drawn - i)) / choose(deck, drawn);
    let top = drawn.min(successes);
    let mut p = 0.0;
    match mode {
        OddsMode::Exactly => {
            p = if want > top || want < 0 {
                0.0
            } else {
                exact(want)
            }
        }
        OddsMode::AtMost => {
            for i in 0..=want.min(top) {
                p += exact(i);
            }
        }
        OddsMode::AtLeast => {
            for i in want.max(0)..=top {
                p += exact(i);
            }
        }
    }
    // `Math.max(0, Math.min(1, p))`, which passes a NaN through where `f64::clamp` would too.
    p.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck_golden::{assert_same, load, name};
    use serde_json::json;

    const ODDS: &str = include_str!("../../../../packages/ui/features/decks/__golden__/odds.json");

    /// Every case of `odds.json`: `handOdds` over the grid, and `choose` over its own.
    #[test]
    fn the_odds_golden_is_the_typescript_s_to_the_last_bit() {
        let golden = load(ODDS);
        let (mut odds, mut chooses) = (0, 0);
        for case in &golden.cases {
            if let Some(expected) = case.get("choose") {
                let n = case["n"].as_i64().expect("n");
                let k = case["k"].as_i64().expect("k");
                assert_same(
                    &serde_json::to_value(choose(n, k)).unwrap(),
                    expected,
                    name(case),
                );
                chooses += 1;
            } else {
                let input: HandOdds = serde_json::from_value(case.clone()).expect("a HandOdds");
                assert_same(
                    &serde_json::to_value(hand_odds(&input)).unwrap(),
                    &case["odds"],
                    name(case),
                );
                odds += 1;
            }
        }
        assert!(
            odds >= 150 && chooses > 0,
            "{odds} odds and {chooses} chooses"
        );
    }

    #[test]
    fn the_modes_serialise_as_the_typescript_spells_them() {
        let modes = [OddsMode::AtLeast, OddsMode::Exactly, OddsMode::AtMost];
        assert_eq!(json!(modes), json!(["atLeast", "exactly", "atMost"]));
    }
}
