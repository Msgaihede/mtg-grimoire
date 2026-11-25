//! `engine.ts`: how big the deck is, how many copies of a card it holds, whether the format's
//! card pool admits them, the mana-value ceiling — and the two entry points, `validate_deck` and
//! `validate_for_marks`.
//!
//! **Every rule is read from data**, as in the TypeScript: the sizes and copy limits come from the
//! seeded `format_specs` row, the pool from each card's own `legalities` blob, what `restricted`
//! means from `restricted_semantic`, whether a format is judged against a pool from
//! `has_legality_data`, and whether it is judged at all from `validates`. There is no format key
//! compared in this file and there must never be one.

use crate::deck::DeckCardRow;

/// `kinds.ts`' `SIZE_KINDS`: the category kinds the format's deck size counts together. The
/// switch (`category_active`) decides whether a pile counts at all; the kind decides only whether
/// it is played *beside* the deck (`side`, `companion`) or *in* it. A switched-on Maybeboard is in
/// the deck.
pub const SIZE_KINDS: [&str; 3] = ["main", "commander", "maybe"];

/// Every card fact null together — the deck read is a `LEFT JOIN` and this is what a miss looks
/// like: `layout`, `rarity`, `legalities` and `oracle_id` all `None`.
pub fn is_orphan(card: &DeckCardRow) -> bool {
    card.layout.is_none()
        && card.rarity.is_none()
        && card.legalities.is_none()
        && card.oracle_id.is_none()
}

/// The mana value of a printed cost: `{2}{U}` is 3, `{X}` is 0 (CR 202.3b), a hybrid counts its
/// greater half (`{2/W}` is 2), `{½}` is a half, and any other symbol is one mana.
///
/// The symbols are `/\{([^}]*)\}/g`'s matches: a `{`, then everything up to the next `}`.
pub fn mana_value_of(cost: Option<&str>) -> f64 {
    let Some(cost) = cost.filter(|c| !c.is_empty()) else {
        return 0.0;
    };
    symbols(cost).map(symbol_value).sum::<f64>()
}

/// The brace-less symbols of a cost, in order — the captures of `/\{([^}]*)\}/g`.
///
/// A `{` with no `}` after it ends the matches, since no later `{` can have one either. A `{`
/// inside a symbol is part of it (`[^}]*` admits it), so `{{2}` is the one symbol `{2`.
pub fn symbols(cost: &str) -> impl Iterator<Item = &str> {
    let mut rest = cost;
    std::iter::from_fn(move || {
        let open = rest.find('{')?;
        let after = &rest[open + 1..];
        let close = after.find('}')?;
        let symbol = &after[..close];
        rest = &after[close + 1..];
        Some(symbol)
    })
}

/// One brace-less symbol's contribution — `engine.ts`' `symbolValue`.
fn symbol_value(token: &str) -> f64 {
    // A hybrid is paid one way or the other; its mana value is the greater half.
    if token.contains('/') {
        return token
            .split('/')
            .map(symbol_value)
            .fold(f64::NEG_INFINITY, f64::max);
    }
    let upper = token.to_uppercase();
    if upper == "X" || upper == "Y" || upper == "Z" {
        return 0.0;
    }
    if token == "½" {
        return 0.5;
    }
    super::js_number(token).unwrap_or(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mana_value_reads_every_symbol_kind() {
        assert_eq!(mana_value_of(None), 0.0);
        assert_eq!(mana_value_of(Some("")), 0.0);
        assert_eq!(mana_value_of(Some("{2}{U}")), 3.0);
        assert_eq!(mana_value_of(Some("{X}{B}{B}{B}")), 3.0);
        assert_eq!(mana_value_of(Some("{2/W}{2/W}")), 4.0);
        assert_eq!(mana_value_of(Some("{W/U}{G/P}")), 2.0);
        assert_eq!(mana_value_of(Some("{½}")), 0.5);
        assert_eq!(mana_value_of(Some("{10}")), 10.0);
        assert_eq!(mana_value_of(Some("{}")), 0.0);
        assert_eq!(mana_value_of(Some("{2")), 0.0);
        assert_eq!(mana_value_of(Some("{{2}")), 1.0);
    }

    #[test]
    fn symbols_are_the_regex_s_captures() {
        assert_eq!(symbols("{2}{U}").collect::<Vec<_>>(), ["2", "U"]);
        assert_eq!(symbols("a{1}b{").collect::<Vec<_>>(), ["1"]);
        assert_eq!(symbols("{{2}}").collect::<Vec<_>>(), ["{2"]);
    }
}
