//! **The filter checks `find_cards` and `show_search` share.** An agent's `filters` object is read
//! once, here, into [`CheckedFilters`] — every value checked against its field's vocabulary, every
//! sentence a refusal the agent can act on — and each tool then translates the result its own way:
//! `find_cards` into a `SearchRequest` ([`search_request`]), `show_search` into the page's bar
//! (`show::handoff`).
//!
//! `show_search` alone takes `borders`, `finishes` and `universe` ([`SHOW_FIELDS`]); `find_cards`
//! keeps its thirteen ([`FIND_FIELDS`]), and a call naming one of the three there is refused as any
//! unknown field is.

use super::tools::{format_key, run, Args};
use crate::sync::AppState;
use grimoire_core::tags::query::TagRef;
use serde_json::{json, Map, Value};
use std::sync::Arc;

/// The fields `find_cards`' `filters` object may hold.
pub(super) const FIND_FIELDS: [&str; 13] = [
    "format",
    "colors",
    "colorsExact",
    "types",
    "rarities",
    "sets",
    "manaValues",
    "manaX",
    "owned",
    "priceMin",
    "priceMax",
    "oracleTags",
    "gameChanger",
];

/// The fields `show_search`'s `filters` object may hold: `find_cards`' and the page's three more.
pub(super) const SHOW_FIELDS: [&str; 16] = [
    "format",
    "colors",
    "colorsExact",
    "types",
    "rarities",
    "sets",
    "manaValues",
    "manaX",
    "owned",
    "priceMin",
    "priceMax",
    "oracleTags",
    "gameChanger",
    "borders",
    "finishes",
    "universe",
];

const BORDERS: [&str; 3] = ["regular", "borderless", "fullart"];
const FINISHES: [&str; 3] = ["nonfoil", "foil", "etched"];
const UNIVERSES: [&str; 2] = ["beyond", "within"];

/// What a `filters` object came to once every value was checked.
#[derive(Debug, Default, Clone)]
pub(super) struct CheckedFilters {
    pub(super) format: Option<String>,
    pub(super) colors: Vec<String>,
    pub(super) colors_exact: Option<bool>,
    pub(super) types: Vec<&'static str>,
    pub(super) rarities: Vec<String>,
    pub(super) sets: Vec<String>,
    pub(super) mana_values: Vec<u64>,
    pub(super) mana_x: bool,
    pub(super) owned: Option<bool>,
    pub(super) price_min: Option<f64>,
    pub(super) price_max: Option<f64>,
    pub(super) oracle_tags: Vec<TagRef>,
    pub(super) game_changer: bool,
    pub(super) borders: Vec<String>,
    pub(super) finishes: Vec<String>,
    pub(super) universe: Option<String>,
}

/// A list field whose every item must be one of `allowed`, lowercased.
fn words_of(filters: &Args, field: &str, allowed: &[&str]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for typed in filters.texts(field)? {
        let typed = typed.to_lowercase();
        if !allowed.contains(&typed.as_str()) {
            return Err(format!(
                "filters.{field} cannot hold {typed:?}; use any of: {}.",
                allowed.join(", ")
            ));
        }
        out.push(typed);
    }
    Ok(out)
}

/// `filters` read into [`CheckedFilters`], every value checked against its field's vocabulary
/// first. `fields` is the set the calling tool accepts.
pub(super) async fn checked(
    state: &Arc<AppState>,
    filters: &Args,
    fields: &[&str],
) -> Result<CheckedFilters, String> {
    if let Some(key) = filters.0.keys().find(|k| !fields.contains(&k.as_str())) {
        return Err(format!(
            "filters has no field {key:?}; its fields are: {}.",
            fields.join(", ")
        ));
    }
    let mut out = CheckedFilters::default();
    if let Some(typed) = filters.text("format")? {
        let specs = run(state, "format_specs_list", json!({})).await?;
        out.format = format_key(Some(typed), "filters.format", &specs)?;
    }
    out.colors = filters
        .texts("colors")?
        .iter()
        .map(|c| c.to_uppercase())
        .collect();
    if let Some(bad) = out
        .colors
        .iter()
        .find(|c| !["W", "U", "B", "R", "G", "C"].contains(&c.as_str()))
    {
        return Err(format!(
            "filters.colors cannot hold {bad:?}; use W, U, B, R, G, or C alone for colourless."
        ));
    }
    if out.colors.iter().any(|c| c == "C") && out.colors.len() > 1 {
        return Err(
            "filters.colors cannot mix C (colourless) with other colours; use C alone.".to_owned(),
        );
    }
    out.colors_exact = filters.switch("colorsExact")?;
    for typed in filters.texts("types")? {
        let Some(key) = grimoire_core::cardtypes::TYPE_KEYS
            .iter()
            .find(|k| k.eq_ignore_ascii_case(&typed))
        else {
            return Err(format!(
                "filters.types cannot hold {typed:?}; use any of: {}.",
                grimoire_core::cardtypes::TYPE_KEYS.join(", ")
            ));
        };
        out.types.push(*key);
    }
    out.rarities = words_of(filters, "rarities", &grimoire_core::filters::ALL_RARITIES)?;
    out.sets = filters
        .texts("sets")?
        .iter()
        .map(|s| s.to_lowercase())
        .collect();
    match filters.0.get("manaValues") {
        None | Some(Value::Null) => {}
        Some(Value::Array(values)) => {
            for v in values {
                let Some(n) = v.as_u64().filter(|n| *n <= 8) else {
                    return Err(format!(
                        "filters.manaValues cannot hold {v}; use whole numbers from 0 to 8 (8 means 8 or more)."
                    ));
                };
                out.mana_values.push(n);
            }
        }
        Some(_) => return Err("filters.manaValues must be a list of whole numbers.".to_owned()),
    }
    out.mana_x = filters.flag("manaX")?;
    out.owned = filters.switch("owned")?;
    out.price_min = filters.amount("priceMin")?;
    out.price_max = filters.amount("priceMax")?;
    let tags = filters.texts("oracleTags")?;
    if !tags.is_empty() {
        if tags.len() > 64 {
            return Err("filters.oracleTags takes at most 64 tags.".to_owned());
        }
        let asks: Vec<Value> = tags
            .iter()
            .map(|t| json!({ "namespace": "oracle", "value": t }))
            .collect();
        let resolved = run(state, "tag_resolve", json!({ "asks": asks })).await?;
        let resolved = resolved.as_array().cloned().unwrap_or_default();
        for (typed, hit) in tags.iter().zip(resolved.iter()) {
            let field = |name: &str| hit.get(name).and_then(Value::as_str).map(str::to_owned);
            let Some(slug) = field("slug") else {
                return Err(format!(
                    "filters.oracleTags has no tag {typed:?}; look slugs up with find_tags."
                ));
            };
            out.oracle_tags.push(TagRef {
                slug,
                label: field("label").unwrap_or_default(),
                namespace: field("namespace").unwrap_or_else(|| "oracle".to_owned()),
            });
        }
    }
    out.game_changer = filters.flag("gameChanger")?;
    out.borders = words_of(filters, "borders", &BORDERS)?;
    out.finishes = words_of(filters, "finishes", &FINISHES)?;
    if let Some(typed) = filters.text("universe")? {
        let typed = typed.to_lowercase();
        if !UNIVERSES.contains(&typed.as_str()) {
            return Err(format!(
                "filters.universe cannot be {typed:?}; use one of: {}.",
                UNIVERSES.join(", ")
            ));
        }
        out.universe = Some(typed);
    }
    Ok(out)
}

/// The `SearchRequest` fields `f` sets — what `find_cards` searches by. The page-only fields
/// (`borders`, `finishes`, `universe`) are not part of it.
pub(super) fn search_request(f: &CheckedFilters) -> Map<String, Value> {
    let mut req = Map::new();
    if let Some(format) = &f.format {
        req.insert("format".into(), json!(format));
    }
    if !f.colors.is_empty() {
        req.insert("colors".into(), json!(f.colors.concat()));
    }
    if let Some(exact) = f.colors_exact {
        req.insert("colorsStrict".into(), json!(exact));
    }
    if !f.types.is_empty() {
        req.insert("types".into(), json!(f.types));
    }
    if !f.rarities.is_empty() {
        req.insert("rarities".into(), json!(f.rarities));
    }
    if !f.sets.is_empty() {
        req.insert("sets".into(), json!(f.sets));
    }
    if !f.mana_values.is_empty() {
        req.insert("manaValues".into(), json!(f.mana_values));
    }
    if f.mana_x {
        req.insert("manaX".into(), json!(true));
    }
    if let Some(owned) = f.owned {
        req.insert("owned".into(), json!(owned));
    }
    if let Some(n) = f.price_min {
        req.insert("priceMin".into(), json!(n));
    }
    if let Some(n) = f.price_max {
        req.insert("priceMax".into(), json!(n));
    }
    if !f.oracle_tags.is_empty() {
        let slugs: Vec<&str> = f.oracle_tags.iter().map(|t| t.slug.as_str()).collect();
        req.insert(
            "oracleTags".into(),
            json!({ "include": slugs, "exclude": [] }),
        );
    }
    if f.game_changer {
        req.insert(
            "predicates".into(),
            json!([{ "field": "is", "op": "colon", "value": "gamechanger" }]),
        );
    }
    req
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_new_fields_are_refused_by_find_cards_and_checked_for_show_search() {
        let state = crate::mcp::testing::state("filters-new-fields");
        for field in ["borders", "finishes", "universe"] {
            let args = Args(json!({ field: "x" }).as_object().unwrap().clone());
            let why = checked(&state, &args, &FIND_FIELDS).await.err().unwrap();
            assert!(why.contains(&format!("{field:?}")), "{why}");
        }
        let bad = [
            ("borders", json!(["shiny"])),
            ("finishes", json!(["gold"])),
            ("universe", json!("outer")),
        ];
        for (field, value) in bad {
            let args = Args(json!({ field: value }).as_object().unwrap().clone());
            let why = checked(&state, &args, &SHOW_FIELDS).await.err().unwrap();
            assert!(why.contains(&format!("filters.{field}")), "{why}");
            assert!(!why.contains("  "), "{why}");
        }
        let ok = Args(
            json!({ "borders": ["Borderless"], "finishes": ["etched"], "universe": "within" })
                .as_object()
                .unwrap()
                .clone(),
        );
        let f = checked(&state, &ok, &SHOW_FIELDS).await.unwrap();
        assert_eq!(
            (f.borders, f.finishes, f.universe),
            (
                vec!["borderless".to_owned()],
                vec!["etched".to_owned()],
                Some("within".to_owned())
            )
        );
    }
}
