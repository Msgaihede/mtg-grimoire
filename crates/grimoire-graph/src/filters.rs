//! **A card search, as a structured input** — the graph's spelling of the core's
//! [`CardFilters`], for every field that lists cards.
//!
//! The page spells the same question in Scryfall's syntax (`t:creature c:g otag:ramp`), parsed by
//! TypeScript alone. The graph takes it structured instead (the owner's decision, 2026-10-29):
//! the schema validates every part of it before anything runs, which is what a model writing a
//! widget needs to be told, and it is the core's own shape rather than a second grammar.
//!
//! **One interpretation, the core's.** The input serialises to the camelCase JSON the page already
//! sends and is read by `CardFilters`' own `Deserialize`, so a filter means here exactly what it
//! means on the Search page — no field is translated by hand.

use async_graphql::{Enum, InputObject};
use grimoire_core::filters::CardFilters;
use serde::Serialize;

use crate::enums::Finish;

/// Which cards to list. Every field narrows; absent fields do not. Tag slugs come from the
/// `tagSearch` and `tagChildren` fields.
#[derive(InputObject, Serialize, Default, Clone, Debug)]
#[graphql(name = "CardFilterInput", rename_fields = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct CardFilterInput {
    /// Free text, prefix-matched against the card's name and rules text.
    pub text: Option<String>,
    /// Only cards legal in this format (its key, e.g. `commander`, `modern`).
    pub format: Option<String>,
    /// Colour identity letters from `WUBRGC`, e.g. `UR`: cards that fit in a deck of those
    /// colours. `C` alone is the colourless cards.
    pub colors: Option<String>,
    /// With `colors`: exactly that identity — `UR` answers the Izzet cards alone, not mono-blue,
    /// mono-red or colourless.
    pub colors_strict: Option<bool>,
    /// One set's code, e.g. `mh3`.
    pub set_code: Option<String>,
    /// One card, every printing (its oracle id).
    pub oracle_id: Option<String>,
    /// Any of these set codes.
    pub sets: Option<Vec<String>>,
    /// Any of these mana values (0–255). X counts as 0, as Scryfall counts it.
    pub mana_values: Option<Vec<u8>>,
    /// Also cards with `{X}` in their printed cost (joins the mana values as one more choice).
    pub mana_x: Option<bool>,
    /// One rarity: `common`, `uncommon`, `rare`, `mythic`, `special`, `bonus`.
    pub rarity: Option<String>,
    /// Any of these rarities.
    pub rarities: Option<Vec<String>>,
    /// Any of these card types, capitalised: `Artifact`, `Battle`, `Creature`, `Enchantment`,
    /// `Instant`, `Land`, `Planeswalker`, `Sorcery`.
    pub types: Option<Vec<String>>,
    /// Any of `regular`, `borderless`, `fullart`.
    pub borders: Option<Vec<String>>,
    /// Printings made in any of these finishes.
    pub printed_finishes: Option<Vec<Finish>>,
    /// `beyond` (Universes Beyond) or `within` (Universes Within); absent, both.
    pub universe: Option<String>,
    /// Only printings made on paper. Absent: true in a card search, false in the collection.
    pub paper_only: Option<bool>,
    /// Only printings legal in at least one format.
    pub playable_only: Option<bool>,
    /// Art Tags (what the illustration shows), by slug.
    pub art_tags: Option<TagTermsInput>,
    /// Oracle Tags (what the card does), by slug.
    pub oracle_tags: Option<TagTermsInput>,
    /// With `artTags`: `strong` keeps only art the tag is central to.
    pub art_weight_floor: Option<String>,
    /// Field-level conditions, every one of which must hold — the Search box's keywords.
    pub predicates: Option<Vec<PredicateInput>>,
}

/// Tag slugs to require and to rule out.
#[derive(InputObject, Serialize, Default, Clone, Debug)]
#[graphql(name = "TagTermsInput")]
pub struct TagTermsInput {
    #[graphql(default)]
    pub include: Vec<String>,
    #[graphql(default)]
    pub exclude: Vec<String>,
}

/// One condition on one field — `type contains goblin`, `mana value ≥ 3` — or a group of them.
#[derive(InputObject, Serialize, Clone, Debug)]
#[graphql(name = "PredicateInput")]
pub struct PredicateInput {
    pub field: PredicateField,
    pub op: PredicateOp,
    /// What the field is compared with, as text: `goblin`, `3`, `ur`.
    #[graphql(default)]
    pub value: String,
    /// Rules the condition out instead of requiring it.
    #[graphql(default)]
    pub negated: bool,
    /// With `field: anyOf` or `allOf`: the conditions grouped.
    #[graphql(default)]
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub terms: Vec<PredicateInput>,
}

/// The field a condition is about.
#[derive(Enum, Serialize, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "camelCase")]
#[serde(rename_all = "camelCase")]
pub enum PredicateField {
    Name,
    TypeLine,
    OracleText,
    Keyword,
    Artist,
    Colors,
    ColorIdentity,
    Cmc,
    Power,
    Toughness,
    Rarity,
    SetCode,
    Format,
    AnyOf,
    AllOf,
    Text,
    OracleTag,
    ArtTag,
    Flavor,
    Watermark,
    ManaCost,
}

/// How a condition compares: `colon` is the field's own sense (contains, includes, legal in).
#[derive(Enum, Serialize, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "camelCase")]
#[serde(rename_all = "camelCase")]
pub enum PredicateOp {
    Colon,
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
}

impl CardFilterInput {
    /// The core's filters, read by its own `Deserialize`.
    pub fn into_core(self) -> async_graphql::Result<CardFilters> {
        let json =
            serde_json::to_value(self).map_err(|e| async_graphql::Error::new(e.to_string()))?;
        serde_json::from_value(json).map_err(|e| async_graphql::Error::new(e.to_string()))
    }
}

/// The filters of an optional argument — none narrows nothing.
pub fn core_filters(input: Option<CardFilterInput>) -> async_graphql::Result<CardFilters> {
    input.map_or_else(|| Ok(CardFilters::default()), CardFilterInput::into_core)
}
