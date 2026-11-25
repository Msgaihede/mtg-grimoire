//! **`show_search`'s translation** — an agent's text and checked filters into what the Search
//! page's bar holds ([`SearchHandoff`]). Pure: no state, no window. A value the bar has a control
//! for lands on the control; one it has none for goes into the text as a term, so the page shows
//! the whole of the search and nothing is silently dropped.

use super::filters::CheckedFilters;
use grimoire_core::tags::query::TagRef;
use serde::Serialize;

/// The formats the page's picker offers (`FORMATS` in `useCardSearch.ts`).
pub const PICKER_FORMATS: [&str; 7] = [
    "standard",
    "pioneer",
    "modern",
    "legacy",
    "vintage",
    "pauper",
    "commander",
];

/// The rarities the page has a chip for (`RARITIES` in `filterOptions.ts`).
pub const CHIP_RARITIES: [&str; 4] = ["common", "uncommon", "rare", "mythic"];

/// The page's sort keys (`SEARCH_SORT_OPTIONS` in `useCardSearch.ts`).
pub const SORT_KEYS: [&str; 8] = [
    "name",
    "set",
    "type",
    "rarity",
    "price",
    "manaValue",
    "released",
    "imageUpdated",
];

/// The most characters of `text` a call may carry.
pub const MAX_TEXT_CHARS: usize = 1000;

/// A search as the page's bar holds it. `id` is assigned when it is sent.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHandoff {
    pub id: u64,
    pub text: String,
    pub format: Option<String>,
    pub colors: Vec<String>,
    pub colors_strict: bool,
    pub types: Vec<String>,
    pub rarities: Vec<String>,
    pub sets: Vec<String>,
    pub mana_values: Vec<u64>,
    pub mana_x: bool,
    pub owned: Option<bool>,
    pub price_min: Option<f64>,
    pub price_max: Option<f64>,
    pub borders: Vec<String>,
    pub finishes: Vec<String>,
    pub universe: Option<String>,
    pub tags: Vec<TagRef>,
    pub sort: Option<HandoffSort>,
    pub all_printings: Option<bool>,
}

/// A sort the agent asked for; `dir` is `"asc"` or `"desc"`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HandoffSort {
    pub key: String,
    pub dir: String,
}

/// The page's shape of a search: the text the agent typed, then the terms the bar has no control
/// for (`is:gamechanger`, a format outside the picker, a rarity with no chip), joined by single
/// spaces. `id` is 0 here.
pub(super) fn handoff(
    text: Option<&str>,
    f: &CheckedFilters,
    sort: Option<HandoffSort>,
    all_printings: Option<bool>,
) -> SearchHandoff {
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = text.map(str::trim).filter(|t| !t.is_empty()) {
        parts.push(t.to_owned());
    }
    if f.game_changer {
        parts.push("is:gamechanger".to_owned());
    }
    let format = match &f.format {
        Some(key) if PICKER_FORMATS.contains(&key.as_str()) => Some(key.clone()),
        Some(key) => {
            parts.push(format!("f:{key}"));
            None
        }
        None => None,
    };
    let rarities = if f
        .rarities
        .iter()
        .all(|r| CHIP_RARITIES.contains(&r.as_str()))
    {
        f.rarities.clone()
    } else {
        let terms: Vec<String> = f.rarities.iter().map(|r| format!("r:{r}")).collect();
        parts.push(match terms.as_slice() {
            [one] => one.clone(),
            many => format!("({})", many.join(" or ")),
        });
        Vec::new()
    };
    SearchHandoff {
        id: 0,
        text: parts.join(" "),
        format,
        colors: f.colors.clone(),
        colors_strict: f.colors_exact.unwrap_or(false),
        types: f.types.iter().map(|t| (*t).to_owned()).collect(),
        rarities,
        sets: f.sets.clone(),
        mana_values: f.mana_values.clone(),
        mana_x: f.mana_x,
        owned: f.owned,
        price_min: f.price_min,
        price_max: f.price_max,
        borders: f.borders.clone(),
        finishes: f.finishes.clone(),
        universe: f.universe.clone(),
        tags: f.oracle_tags.clone(),
        sort,
        all_printings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The text between `start` and the next `]`.
    fn list_after<'a>(src: &'a str, start: &str) -> &'a str {
        let from = src.find(start).expect("the list is in the page's source") + start.len();
        let rest = &src[from..];
        &rest[..rest.find(']').expect("the list closes")]
    }

    /// The `value: "…"` strings between `start` and the next `]`.
    fn values_in(src: &str, start: &str) -> Vec<String> {
        list_after(src, start)
            .split("value: \"")
            .skip(1)
            .filter_map(|s| s.split('"').next())
            .map(str::to_owned)
            .collect()
    }

    /// Every `"…"` between `start` and the next `]`.
    fn quoted_in(src: &str, start: &str) -> Vec<String> {
        list_after(src, start)
            .split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn a_picker_format_lands_on_the_select_and_another_goes_into_the_text() {
        let f = CheckedFilters {
            format: Some("commander".into()),
            ..Default::default()
        };
        let h = handoff(Some("t:creature"), &f, None, None);
        assert_eq!(h.format.as_deref(), Some("commander"));
        assert_eq!(h.text, "t:creature");
        let f = CheckedFilters {
            format: Some("premodern".into()),
            ..Default::default()
        };
        let h = handoff(Some("t:creature"), &f, None, None);
        assert_eq!(h.format, None);
        assert_eq!(h.text, "t:creature f:premodern");
    }

    #[test]
    fn rarities_stay_on_the_chips_unless_one_has_none_then_all_go_in_one_group() {
        let chips = CheckedFilters {
            rarities: vec!["rare".into(), "mythic".into()],
            ..Default::default()
        };
        let h = handoff(None, &chips, None, None);
        assert_eq!(h.rarities, ["rare", "mythic"]);
        assert_eq!(h.text, "");
        let one = CheckedFilters {
            rarities: vec!["special".into()],
            ..Default::default()
        };
        assert_eq!(handoff(None, &one, None, None).text, "r:special");
        let mixed = CheckedFilters {
            rarities: vec!["rare".into(), "special".into()],
            ..Default::default()
        };
        let h = handoff(None, &mixed, None, None);
        assert!(h.rarities.is_empty());
        assert_eq!(h.text, "(r:rare or r:special)");
    }

    #[test]
    fn game_changers_are_a_term_and_the_text_is_never_padded() {
        let f = CheckedFilters {
            game_changer: true,
            format: Some("oathbreaker".into()),
            ..Default::default()
        };
        assert_eq!(
            handoff(Some("   "), &f, None, None).text,
            "is:gamechanger f:oathbreaker"
        );
        assert_eq!(
            handoff(Some("  bolt  "), &f, None, None).text,
            "bolt is:gamechanger f:oathbreaker"
        );
        assert_eq!(
            handoff(None, &CheckedFilters::default(), None, None).text,
            ""
        );
    }

    #[test]
    fn the_rest_is_carried_in_the_pages_shape() {
        let tag = TagRef {
            slug: "ramp".into(),
            label: "Ramp".into(),
            namespace: "oracle".into(),
        };
        let f = CheckedFilters {
            colors: vec!["U".into(), "R".into()],
            colors_exact: Some(true),
            oracle_tags: vec![tag.clone()],
            borders: vec!["borderless".into()],
            universe: Some("beyond".into()),
            mana_values: vec![1, 8],
            mana_x: true,
            owned: Some(false),
            price_max: Some(2.5),
            ..Default::default()
        };
        let sort = HandoffSort {
            key: "price".into(),
            dir: "desc".into(),
        };
        let h = handoff(None, &f, Some(sort.clone()), Some(true));
        assert_eq!(
            (h.colors.clone(), h.colors_strict),
            (vec!["U".to_owned(), "R".to_owned()], true)
        );
        assert_eq!(h.tags, [tag]);
        assert_eq!(h.sort, Some(sort));
        assert_eq!(h.all_printings, Some(true));
        let wire = serde_json::to_value(&h).unwrap();
        for key in [
            "colorsStrict",
            "manaValues",
            "manaX",
            "priceMax",
            "allPrintings",
        ] {
            assert!(wire.get(key).is_some(), "{key}");
        }
    }

    /// The three lists are the page's: a format added to the picker, a rarity given a chip or a
    /// sort key added there must be added here, or the hand-off sends a value the bar cannot draw.
    #[test]
    fn the_lists_match_the_pages_own() {
        let search = include_str!("../../../../../packages/ui/features/search/useCardSearch.ts");
        let options = include_str!("../../../../../packages/ui/features/search/filterOptions.ts");
        assert_eq!(
            values_in(search, "export const FORMATS = ["),
            PICKER_FORMATS
        );
        assert_eq!(
            values_in(search, "export const SEARCH_SORT_OPTIONS = ["),
            SORT_KEYS
        );
        assert_eq!(
            quoted_in(options, "export const RARITIES = ["),
            CHIP_RARITIES
        );
    }
}
