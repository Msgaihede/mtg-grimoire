//! `DeckStats.tsx`' `deckStats` and `isShort`: every number the deck stats band draws.
//!
//! **Copies throughout, never rows**, and **a switched-off pile counts toward nothing** but
//! `by_category` and `inactive` — the TypeScript's two rules, read off `category_active` and never
//! off a kind. The sums run in the TypeScript's row order and with its formulas
//! (`unit_price * quantity` per row, the average as one division at the end), so every `f64` here
//! is the one JavaScript computes.

use super::buckets::{
    card_mana_value, curve_bucket, is_creature, is_land, is_mdfc_land, CURVE_BUCKETS,
};
use super::mana::{
    count_pips, empty_pips, has_variable_cost, produced_keys, ByMana, ManaKey, PipCounts, MANA_KEYS,
};
use crate::deck::DeckCardRow;
use crate::deck_rules::engine::SIZE_KINDS;
use serde::Serialize;

/// `CategoryCount`: one pile's copies, addressed by id (two piles may share a name).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryCount {
    pub id: i64,
    pub name: String,
    pub quantity: i64,
}

/// `DeckStatsSummary`, field for field. The TypeScript type's docs say what each one means; the
/// ones a port gets wrong are noted here.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckStatsSummary {
    /// Copies in every active pile.
    pub copies: i64,
    /// Copies in the active piles of a [`SIZE_KINDS`] kind — the headline figure. A pile is judged
    /// by its **first** row's kind and switch, all its rows' copies with it, as the TypeScript's
    /// `Map` of piles is (a read's rows never disagree about their pile).
    pub sized: i64,
    /// Copies per pile over **every** row, switched-off piles included, in first-row order.
    pub by_category: Vec<CategoryCount>,
    /// The active piles `sized` leaves out, in the same order.
    pub elsewhere: Vec<CategoryCount>,
    /// Copies in switched-off piles.
    pub inactive: i64,
    pub lands: i64,
    pub nonlands: i64,
    /// A subset of `nonlands`, never part of `lands`.
    pub mdfc_lands: i64,
    pub unknown_mana_value: i64,
    pub curve: [i64; CURVE_BUCKETS],
    /// `None` (JSON `null`) when the deck does not split its X spells out; `Some(0)` when it does
    /// and has none.
    pub variable_cost: Option<i64>,
    pub curve_creatures: [i64; CURVE_BUCKETS],
    /// `None` exactly when `variable_cost` is.
    pub variable_cost_creatures: Option<i64>,
    pub pips: PipCounts,
    pub pip_cards: PipCounts,
    pub sources: PipCounts,
    pub sources_known: bool,
    pub curve_by_color: ByMana<[i64; CURVE_BUCKETS]>,
    pub spells_by_color: PipCounts,
    /// `None` for a deck with no nonland that has a mana value.
    pub average_mana_value: Option<f64>,
    /// `None` when nothing is priced, and the two halves with it.
    pub price: Option<f64>,
    pub owned_price: Option<f64>,
    pub missing_price: Option<f64>,
    pub unpriced: i64,
    pub owned: i64,
    pub missing: i64,
}

/// `isShort`: a row in a switched-on pile holding fewer copies than it wants — the rows the
/// ledger's `N missing` counts.
pub fn is_short(card: &DeckCardRow) -> bool {
    card.category_active && card.owned_quantity < card.quantity
}

/// A pile while it is counted: its first row's id, name, kind and switch.
struct Tallied<'a> {
    id: i64,
    name: &'a str,
    kind: &'a str,
    active: bool,
    quantity: i64,
}

impl Tallied<'_> {
    /// The one reading of the size rule — on the pile's **first** row's kind and switch, as the
    /// TypeScript's `Map` keeps them.
    fn sizes(&self) -> bool {
        self.active && SIZE_KINDS.contains(&self.kind)
    }

    fn count(&self) -> CategoryCount {
        CategoryCount {
            id: self.id,
            name: self.name.to_owned(),
            quantity: self.quantity,
        }
    }
}

/// `deckStats(cards, separateXGroup)`. `separate_x_group` moves a nonland whose cost names `{X}`
/// out of its numeric bucket and into `variable_cost`; it changes no other number (the average
/// and the colour curves keep the card at its mana value).
pub fn deck_stats(cards: &[DeckCardRow], separate_x_group: bool) -> DeckStatsSummary {
    let counted: Vec<&DeckCardRow> = cards.iter().filter(|c| c.category_active).collect();
    let lands: Vec<&DeckCardRow> = counted
        .iter()
        .copied()
        .filter(|c| is_land(c.type_line.as_deref()))
        .collect();
    let nonlands: Vec<&DeckCardRow> = counted
        .iter()
        .copied()
        .filter(|c| !is_land(c.type_line.as_deref()))
        .collect();
    let copies_of = |rows: &[&DeckCardRow]| rows.iter().map(|c| c.quantity).sum::<i64>();

    // Copies per pile over every row, keyed by id in first-seen order (the `Map`'s).
    let mut tally: Vec<Tallied> = Vec::new();
    for card in cards {
        if let Some(at) = tally.iter_mut().find(|t| t.id == card.category_id) {
            at.quantity += card.quantity;
            continue;
        }
        tally.push(Tallied {
            id: card.category_id,
            name: &card.category_name,
            kind: &card.category_kind,
            active: card.category_active,
            quantity: card.quantity,
        });
    }

    let mut curve = [0i64; CURVE_BUCKETS];
    let mut curve_creatures = [0i64; CURVE_BUCKETS];
    let mut curve_by_color: ByMana<[i64; CURVE_BUCKETS]> = ByMana([[0; CURVE_BUCKETS]; 6]);
    let mut spells_by_color = empty_pips();
    let mut mana_valued: i64 = 0;
    let mut mana_value_total: f64 = 0.0;
    let mut unknown_mana_value: i64 = 0;
    let mut variable_cost: i64 = 0;
    let mut variable_cost_creatures: i64 = 0;
    for card in &nonlands {
        let Some(mv) = card_mana_value(card) else {
            unknown_mana_value += card.quantity;
            continue;
        };
        // Letters, never JSON. A gold spell is in every colour it is; `C` is no colour at all.
        let colors = card.colors.as_deref().unwrap_or("");
        for key in MANA_KEYS {
            let in_it = match key {
                ManaKey::C => colors.is_empty(),
                _ => colors.contains(key.letter()),
            };
            if !in_it {
                continue;
            }
            curve_by_color[key][curve_bucket(mv)] += card.quantity;
            spells_by_color[key] += card.quantity;
        }
        mana_valued += card.quantity;
        mana_value_total += mv * card.quantity as f64;

        let creature = is_creature(card.type_line.as_deref());
        if separate_x_group && has_variable_cost(card.mana_cost.as_deref()) {
            variable_cost += card.quantity;
            if creature {
                variable_cost_creatures += card.quantity;
            }
            continue;
        }
        let bucket = curve_bucket(mv);
        curve[bucket] += card.quantity;
        if creature {
            curve_creatures[bucket] += card.quantity;
        }
    }

    let mut pips = empty_pips();
    let mut pip_cards = empty_pips();
    let mut sources = empty_pips();
    let mut sources_known = false;
    for card in &counted {
        let own = count_pips(card.mana_cost.as_deref());
        for key in MANA_KEYS {
            if own[key] == 0 {
                continue;
            }
            pips[key] += own[key] * card.quantity;
            pip_cards[key] += card.quantity;
        }
        if card.produced_mana.is_some() {
            sources_known = true;
        }
        for key in produced_keys(card.produced_mana.as_deref()) {
            sources[key] += card.quantity;
        }
    }
    // Supply only where some counted cost asks for it; colourless always.
    for key in MANA_KEYS {
        if key != ManaKey::C && pips[key] == 0 {
            sources[key] = 0;
        }
    }

    let mut price: f64 = 0.0;
    let mut priced: i64 = 0;
    let mut unpriced: i64 = 0;
    let mut owned: i64 = 0;
    let mut missing: i64 = 0;
    let mut owned_price: f64 = 0.0;
    let mut missing_price: f64 = 0.0;
    for card in &counted {
        let have = card.owned_quantity.min(card.quantity);
        let short = card.quantity - have;
        owned += have;
        missing += short;
        match card.unit_price {
            None => unpriced += card.quantity,
            Some(unit) => {
                price += unit * card.quantity as f64;
                priced += card.quantity;
                owned_price += unit * have as f64;
                missing_price += unit * short as f64;
            }
        }
    }
    let money = |sum: f64| (priced != 0).then_some(sum);

    DeckStatsSummary {
        copies: copies_of(&counted),
        sized: tally.iter().filter(|t| t.sizes()).map(|t| t.quantity).sum(),
        by_category: tally.iter().map(Tallied::count).collect(),
        elsewhere: tally
            .iter()
            .filter(|t| t.active && !t.sizes())
            .map(Tallied::count)
            .collect(),
        inactive: cards
            .iter()
            .filter(|c| !c.category_active)
            .map(|c| c.quantity)
            .sum(),
        lands: copies_of(&lands),
        nonlands: copies_of(&nonlands),
        mdfc_lands: nonlands
            .iter()
            .filter(|c| is_mdfc_land(c))
            .map(|c| c.quantity)
            .sum(),
        unknown_mana_value,
        curve,
        variable_cost: separate_x_group.then_some(variable_cost),
        curve_creatures,
        variable_cost_creatures: separate_x_group.then_some(variable_cost_creatures),
        pips,
        pip_cards,
        sources,
        sources_known,
        curve_by_color,
        spells_by_color,
        average_mana_value: (mana_valued != 0).then(|| mana_value_total / mana_valued as f64),
        price: money(price),
        owned_price: money(owned_price),
        missing_price: money(missing_price),
        unpriced,
        owned,
        missing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck_golden::{assert_same, load, name};
    use serde_json::{json, Value};

    const STATS: &str =
        include_str!("../../../../packages/ui/features/decks/__golden__/stats.json");

    /// Every case of `stats.json`: `deckStats` both ways of `separateXGroup`, and `isShort` per
    /// row.
    #[test]
    fn the_stats_golden_sums_as_the_typescript_does() {
        let golden = load(STATS);
        for case in &golden.cases {
            let cards = golden.cards(&case["cards"]);
            let shorts: Vec<Value> = cards
                .iter()
                .map(|row| json!({ "id": row.id, "short": is_short(row) }))
                .collect();
            let expected_shorts: Vec<Value> = case["rows"]
                .as_array()
                .expect("rows")
                .iter()
                .map(|row| json!({ "id": row["id"], "short": row["short"] }))
                .collect();
            let actual = json!({
                "stats": deck_stats(&cards, false),
                "statsX": deck_stats(&cards, true),
                "shorts": shorts,
            });
            let expected = json!({
                "stats": case["stats"],
                "statsX": case["statsX"],
                "shorts": expected_shorts,
            });
            assert_same(
                &serde_json::to_value(&actual).unwrap(),
                &expected,
                name(case),
            );
        }
    }
}
