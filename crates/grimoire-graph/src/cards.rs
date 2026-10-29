//! The cards domain: the card corpus — search, one printing in full, every printing of a card,
//! prices per finish, the sets, and what the reader holds of a card. Ported from the page's graph
//! (`packages/ui/lib/graphql/schema/cards.ts`), and answered by the core's own reads
//! (`search`, `card`).
//!
//! **One deliberate difference from the page:** `searchCards` takes `filters: CardFilterInput`
//! ([`crate::filters`]) where the page took `query: String` in Scryfall's syntax, which only
//! TypeScript parses.
//!
//! **Left out:** `treatments` on `CardSummary`, `CardDetail` and `Printing`. The page derives it
//! from `promo_types` through `lib/treatment.ts`, a hand-written naming table that is
//! TypeScript's on purpose ("naming is a judgement"); `docs/reference/graphql.md` names a card's
//! treatments as a conclusion the graph does not serve.
//!
//! **A card's Oracle tags are an edge** (`oracleTags` on `CardSummary` and `CardDetail`), read
//! through [`OracleTags`]: every card a level of the answer reaches is one
//! `oracle_tags_for_cards` read.

use std::collections::HashMap;
use std::sync::Arc;

use async_graphql::dataloader::{DataLoader, Loader};
use async_graphql::futures_util::future::BoxFuture;
use async_graphql::{Context, Enum, InputObject, Object, Request, Result};
use grimoire_core::card::{
    get_card, holdings, list_printings, meld_parts, read_printing_prices, tcgplayer_ids,
    CardDetail as CoreDetail, CardFace as CoreFace, CardHoldings as CoreHoldings,
    FinishPrices as CorePrices, MeldRelation as CoreMeld, Printing as CorePrinting,
    PrintingPrices as CorePrintingPrices, PrintingsResponse, TcgplayerIds as CoreTcgplayerIds,
};
use grimoire_core::filters::CardFilters;
use grimoire_core::search::{
    run_list_sets, run_search, CardSummary as CoreSummary, SearchRequest, SearchResponse,
    SetSummary,
};
use grimoire_core::sorting::{Marketplace as Market, SortTerm};
use grimoire_core::state::State;
use grimoire_core::tags::oracle::read_card_tags;

use crate::enums::Finish;
use crate::filters::{core_filters, CardFilterInput};
use crate::{invalidatedBy, marketplace_of, read, roots, Marketplace};

/// How many Oracle-tag batches have run — the tests assert a whole list is one.
#[cfg(test)]
pub(crate) static TAG_BATCHES: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// A batch's future, driven to the end on a thread of its own — the reason is
/// [`crate::loaders`]' (nothing in the crate has a runtime to spawn on).
fn on_a_thread_of_its_own(batch: BoxFuture<'static, ()>) {
    std::thread::spawn(move || futures_executor::block_on(batch));
}

/// Every card's Oracle tags, for the cards (by oracle id) a level of the answer asked about.
pub struct OracleTags(Arc<State>);

impl Loader<String> for OracleTags {
    type Value = Vec<String>;
    type Error = Arc<String>;

    async fn load(&self, keys: &[String]) -> Result<HashMap<String, Self::Value>, Self::Error> {
        #[cfg(test)]
        TAG_BATCHES.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let tags = read_card_tags(&self.0.lock_db_read(), keys)
            .map_err(|e| Arc::new(format!("could not read the tags: {e}")))?;
        Ok(tags.into_iter().map(|t| (t.oracle_id, t.slugs)).collect())
    }
}

/// This domain's batch loaders, for one execution.
pub(crate) fn data(request: Request, state: &Arc<State>) -> Request {
    request.data(DataLoader::new(
        OracleTags(state.clone()),
        on_a_thread_of_its_own,
    ))
}

/// One card's Oracle tags through the batch; none for a printing with no oracle id.
async fn oracle_tags_of(ctx: &Context<'_>, oracle_id: Option<&str>) -> Result<Vec<String>> {
    let Some(id) = oracle_id.filter(|id| !id.is_empty()) else {
        return Ok(Vec::new());
    };
    let loader = ctx.data_unchecked::<DataLoader<OracleTags>>();
    Ok(loader.load_one(id.to_owned()).await?.unwrap_or_default())
}

/// A JSON array of strings, as Scryfall's list columns are stored — empty for null or junk.
fn json_strings(json: Option<&str>) -> Vec<String> {
    json.and_then(|j| serde_json::from_str::<Vec<serde_json::Value>>(j).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| match v {
            serde_json::Value::String(s) => Some(s),
            _ => None,
        })
        .collect()
}

/// The finishes a printing exists in. Unknown words are dropped, not guessed at.
fn finishes_of(json: Option<&str>) -> Vec<Finish> {
    json_strings(json)
        .iter()
        .filter_map(|f| Finish::from_id(f))
        .collect()
}

/// A copy of a printing's prices — the core's struct is not `Clone`, its figures are.
fn prices_of(p: &CorePrices) -> FinishPrices {
    FinishPrices(CorePrices {
        nonfoil: p.nonfoil,
        foil: p.foil,
        etched: p.etched,
    })
}

/// What one printing costs per finish (Near Mint), at one marketplace.
pub struct FinishPrices(pub CorePrices);

/// What one printing costs per finish (Near Mint), at one marketplace. In the marketplace's own
/// currency, in whole units (2.18 is $2.18 or €2.18) — see `Query.marketplace` for which
/// currency. Null when that marketplace quotes no price; never filled in from another
/// marketplace.
#[Object(rename_fields = "camelCase")]
impl FinishPrices {
    async fn nonfoil(&self) -> Option<f64> {
        self.0.nonfoil
    }
    async fn foil(&self) -> Option<f64> {
        self.0.foil
    }
    async fn etched(&self) -> Option<f64> {
        self.0.etched
    }
}

/// One printing's prices per finish, keyed by its id.
pub struct PrintingPrices(pub CorePrintingPrices);

/// One printing's prices per finish, keyed by its id.
#[Object(rename_fields = "camelCase")]
impl PrintingPrices {
    /// The printing's Scryfall id.
    async fn card_id(&self) -> &str {
        &self.0.card_id
    }
    async fn finish_prices(&self) -> FinishPrices {
        prices_of(&self.0.finish_prices)
    }
}

/// One card search result.
pub struct CardSummary(pub CoreSummary);

/// One card search result: a printing (or, with `onePerCard`, a card represented by its newest
/// matching printing) with the columns a card grid needs.
#[Object(rename_fields = "camelCase")]
impl CardSummary {
    /// The printing's Scryfall id (a UUID). To draw its art, pass it to the app's `CardImage`
    /// component (through `cardImageUrl(id, face, variant)`); never build an image URL by hand.
    async fn id(&self) -> &str {
        &self.0.id
    }
    /// The oracle card this printing is of — shared by every printing of the same card.
    async fn oracle_id(&self) -> Option<&str> {
        self.0.oracle_id.as_deref()
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// Lowercase set code, e.g. `m21`.
    async fn set_code(&self) -> &str {
        &self.0.set_code
    }
    async fn set_name(&self) -> Option<&str> {
        self.0.set_name.as_deref()
    }
    async fn collector_number(&self) -> &str {
        &self.0.collector_number
    }
    /// `common`, `uncommon`, `rare`, `mythic`, `special` or `bonus`.
    async fn rarity(&self) -> Option<&str> {
        self.0.rarity.as_deref()
    }
    async fn type_line(&self) -> Option<&str> {
        self.0.type_line.as_deref()
    }
    /// In Scryfall's symbol notation, e.g. `{2}{R}{R}`.
    async fn mana_cost(&self) -> Option<&str> {
        self.0.mana_cost.as_deref()
    }
    /// Scryfall's layout word: `normal`, `transform`, `modal_dfc`, `split`, `meld`, …
    async fn layout(&self) -> &str {
        &self.0.layout
    }
    /// This printing's price — nonfoil, falling back to foil, then etched. In the marketplace's
    /// own currency, in whole units (2.18 is $2.18 or €2.18) — see `Query.marketplace` for which
    /// currency. Null when that marketplace quotes no price; never filled in from another
    /// marketplace.
    async fn price(&self) -> Option<f64> {
        self.0.price
    }
    /// With `onePerCard`, the cheapest `price` among the printings this row stands for;
    /// otherwise equal to `price`. In the marketplace's own currency, in whole units. Null when
    /// that marketplace quotes no price; never filled in from another marketplace.
    async fn price_low(&self) -> Option<f64> {
        self.0.price_low
    }
    /// With `onePerCard`, the dearest `price` among the printings this row stands for;
    /// otherwise equal to `price`. In the marketplace's own currency, in whole units. Null when
    /// that marketplace quotes no price; never filled in from another marketplace.
    async fn price_high(&self) -> Option<f64> {
        self.0.price_high
    }
    /// The finishes this printing is published in. Empty when the corpus does not say.
    async fn finishes(&self) -> Vec<Finish> {
        finishes_of(self.0.finishes.as_deref())
    }
    /// One of the cards the Commander bracket system counts as a game changer.
    async fn game_changer(&self) -> bool {
        self.0.game_changer
    }
    /// The printing's release date, `YYYY-MM-DD`. A date after today is a card not out yet.
    async fn released_at(&self) -> Option<&str> {
        self.0.released_at.as_deref()
    }
    /// When Scryfall last replaced this printing's images, as an ISO 8601 timestamp.
    async fn image_updated_at(&self) -> Option<&str> {
        self.0.image_updated_at.as_deref()
    }
    /// Copies of this printing in the reader's collection, every finish and condition
    /// together. 0 when none.
    async fn owned_quantity(&self) -> i64 {
        self.0.owned_quantity
    }
    /// Whether a wishlist entry covers this printing — pinned to it, or wishing for any
    /// printing of the card.
    async fn wishlisted(&self) -> bool {
        self.0.wishlisted
    }
    /// How many matching printings this row stands for: 1 unless the search was asked with
    /// `onePerCard`.
    async fn printings(&self) -> i64 {
        self.0.printings
    }
    /// The card's Scryfall Oracle tags — what the card does (`removal`, `ramp`,
    /// `card-advantage`) — as slugs, sorted, with every ancestor tag included. Empty for an
    /// untagged card and on a database that has never downloaded the Oracle tags (see
    /// `Query.oracleTagsStatus`). Not deck labels, deck tags or keyword abilities.
    async fn oracle_tags(&self, ctx: &Context<'_>) -> Result<Vec<String>> {
        oracle_tags_of(ctx, self.0.oracle_id.as_deref()).await
    }
}

/// One page of a card search.
pub struct CardSearchResult {
    items: Vec<CardSummary>,
    total: i64,
    total_is_capped: bool,
}

impl From<SearchResponse> for CardSearchResult {
    fn from(r: SearchResponse) -> Self {
        Self {
            items: r.items.into_iter().map(CardSummary).collect(),
            total: r.total,
            total_is_capped: r.total_is_capped,
        }
    }
}

/// One page of a card search, and how many cards matched in all.
#[Object(rename_fields = "camelCase")]
impl CardSearchResult {
    async fn items(&self) -> &[CardSummary] {
        &self.items
    }
    /// How many matched, counted no further than 5000 — read with `totalIsCapped`. With
    /// `onePerCard`, counts cards; otherwise printings.
    async fn total(&self) -> i64 {
        self.total
    }
    /// The count stopped at its ceiling: there are `total` matches or more.
    async fn total_is_capped(&self) -> bool {
        self.total_is_capped
    }
}

/// One physical side of a multi-faced card.
pub struct CardFace(pub CoreFace);

/// One physical side of a multi-faced card (transform, modal double-faced, split…).
#[Object(rename_fields = "camelCase")]
impl CardFace {
    /// Empty when the face carries no name.
    async fn name(&self) -> &str {
        &self.0.name
    }
    async fn type_line(&self) -> Option<&str> {
        self.0.type_line.as_deref()
    }
    async fn oracle_text(&self) -> Option<&str> {
        self.0.oracle_text.as_deref()
    }
    /// In Scryfall's symbol notation. Null or empty means no cost.
    async fn mana_cost(&self) -> Option<&str> {
        self.0.mana_cost.as_deref()
    }
    async fn artist(&self) -> Option<&str> {
        self.0.artist.as_deref()
    }
}

/// Whether a card may be played in one format.
pub struct CardLegality {
    format: String,
    status: String,
}

/// Whether a card may be played in one format.
#[Object(rename_fields = "camelCase")]
impl CardLegality {
    /// Scryfall's format key: `standard`, `modern`, `commander`, `vintage`, …
    async fn format(&self) -> &str {
        &self.format
    }
    /// `legal`, `not_legal`, `restricted` or `banned`.
    async fn status(&self) -> &str {
        &self.status
    }
}

/// The `legalities` column read as rows — empty for null or junk.
fn legalities_of(json: Option<&str>) -> Vec<CardLegality> {
    let Some(serde_json::Value::Object(map)) =
        json.and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
    else {
        return Vec::new();
    };
    map.into_iter()
        .filter_map(|(format, status)| match status {
            serde_json::Value::String(status) => Some(CardLegality { format, status }),
            _ => None,
        })
        .collect()
}

/// Everything about one printing of a card.
pub struct CardDetail(pub CoreDetail);

/// Everything about one printing of a card, as the card detail pane shows it.
#[Object(rename_fields = "camelCase")]
impl CardDetail {
    /// The printing's Scryfall id (a UUID). To draw its art, pass it to the app's `CardImage`
    /// component (through `cardImageUrl(id, face, variant)`); never build an image URL by hand.
    async fn id(&self) -> &str {
        &self.0.id
    }
    /// The oracle card this printing is of — shared by every printing of the same card. Pass it
    /// to `cardPrintings` or `cardHoldings`.
    async fn oracle_id(&self) -> Option<&str> {
        self.0.oracle_id.as_deref()
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// Lowercase set code, e.g. `m21`.
    async fn set_code(&self) -> &str {
        &self.0.set_code
    }
    async fn set_name(&self) -> Option<&str> {
        self.0.set_name.as_deref()
    }
    async fn collector_number(&self) -> &str {
        &self.0.collector_number
    }
    async fn rarity(&self) -> Option<&str> {
        self.0.rarity.as_deref()
    }
    /// Scryfall's layout word.
    async fn layout(&self) -> &str {
        &self.0.layout
    }
    /// Scryfall's language code, e.g. `en`.
    async fn lang(&self) -> &str {
        &self.0.lang
    }
    /// In Scryfall's symbol notation, e.g. `{2}{R}{R}`.
    async fn mana_cost(&self) -> Option<&str> {
        self.0.mana_cost.as_deref()
    }
    /// Mana value. A Float because a few joke cards have half-mana costs.
    async fn cmc(&self) -> Option<f64> {
        self.0.cmc
    }
    async fn type_line(&self) -> Option<&str> {
        self.0.type_line.as_deref()
    }
    async fn oracle_text(&self) -> Option<&str> {
        self.0.oracle_text.as_deref()
    }
    /// Scryfall's id for the artwork. Two printings differ in art exactly when this does.
    async fn illustration_id(&self) -> Option<&str> {
        self.0.illustration_id.as_deref()
    }
    /// The illustrator. Scryfall's image policy asks for this credit wherever the art is shown.
    async fn artist(&self) -> Option<&str> {
        self.0.artist.as_deref()
    }
    /// The printing's release date, `YYYY-MM-DD`.
    async fn released_at(&self) -> Option<&str> {
        self.0.released_at.as_deref()
    }
    /// The card's standing in every format Scryfall tracks.
    async fn legalities(&self) -> Vec<CardLegality> {
        legalities_of(self.0.legalities.as_deref())
    }
    /// This printing's price per finish, at the marketplace `card` was asked at.
    async fn finish_prices(&self) -> FinishPrices {
        prices_of(&self.0.finish_prices)
    }
    /// The finishes this printing is published in. Empty when the corpus does not say.
    async fn finishes(&self) -> Vec<Finish> {
        finishes_of(self.0.finishes.as_deref())
    }
    /// Scryfall's image quality word: `highres_scan`, `lowres`, `placeholder` or `missing`.
    async fn image_status(&self) -> Option<&str> {
        self.0.image_status.as_deref()
    }
    /// Each physical side, front first. Empty for a single-faced card.
    async fn faces(&self) -> Vec<CardFace> {
        self.0
            .faces
            .iter()
            .map(|f| {
                CardFace(CoreFace {
                    name: f.name.clone(),
                    type_line: f.type_line.clone(),
                    oracle_text: f.oracle_text.clone(),
                    mana_cost: f.mana_cost.clone(),
                    artist: f.artist.clone(),
                })
            })
            .collect()
    }
    /// The card's Scryfall Oracle tags — what the card does (`removal`, `ramp`,
    /// `card-advantage`) — as slugs, sorted, with every ancestor tag included. Empty for an
    /// untagged card and on a database that has never downloaded the Oracle tags (see
    /// `Query.oracleTagsStatus`). Not deck labels, deck tags or keyword abilities.
    async fn oracle_tags(&self, ctx: &Context<'_>) -> Result<Vec<String>> {
        oracle_tags_of(ctx, self.0.oracle_id.as_deref()).await
    }
}

/// One paper printing of a card.
pub struct Printing(pub CorePrinting);

/// One paper printing of a card, as the all-printings list shows it.
#[Object(rename_fields = "camelCase")]
impl Printing {
    /// The printing's Scryfall id (a UUID). To draw its art, pass it to the app's `CardImage`
    /// component (through `cardImageUrl(id, face, variant)`); never build an image URL by hand.
    async fn id(&self) -> &str {
        &self.0.id
    }
    /// Lowercase set code, e.g. `m21`.
    async fn set_code(&self) -> &str {
        &self.0.set_code
    }
    async fn set_name(&self) -> Option<&str> {
        self.0.set_name.as_deref()
    }
    async fn collector_number(&self) -> &str {
        &self.0.collector_number
    }
    /// The printing's release date, `YYYY-MM-DD`.
    async fn released_at(&self) -> Option<&str> {
        self.0.released_at.as_deref()
    }
    async fn rarity(&self) -> Option<&str> {
        self.0.rarity.as_deref()
    }
    /// Scryfall's id for the artwork. Two printings differ in art exactly when this does.
    async fn illustration_id(&self) -> Option<&str> {
        self.0.illustration_id.as_deref()
    }
    async fn artist(&self) -> Option<&str> {
        self.0.artist.as_deref()
    }
    /// Scryfall's language code, e.g. `en`.
    async fn lang(&self) -> &str {
        &self.0.lang
    }
    /// The finishes this printing is published in. Empty when the corpus does not say.
    async fn finishes(&self) -> Vec<Finish> {
        finishes_of(self.0.finishes.as_deref())
    }
    /// This printing's price per finish, at the marketplace `cardPrintings` was asked at.
    async fn finish_prices(&self) -> FinishPrices {
        prices_of(&self.0.finish_prices)
    }
    /// Scryfall marks this printing a promo.
    async fn promo(&self) -> bool {
        self.0.promo
    }
    async fn full_art(&self) -> bool {
        self.0.full_art
    }
    /// Scryfall's frame effects: `showcase`, `extendedart`, `legendary`, …
    async fn frame_effects(&self) -> Vec<String> {
        json_strings(self.0.frame_effects.as_deref())
    }
    /// `black`, `white`, `borderless`, `silver` or `gold`.
    async fn border_color(&self) -> Option<&str> {
        self.0.border_color.as_deref()
    }
    /// Scryfall's layout word.
    async fn layout(&self) -> &str {
        &self.0.layout
    }
}

/// Every paper printing of one card.
pub struct PrintingsPage {
    items: Vec<Printing>,
    total: i64,
}

impl From<PrintingsResponse> for PrintingsPage {
    fn from(r: PrintingsResponse) -> Self {
        Self {
            items: r.items.into_iter().map(Printing).collect(),
            total: r.total,
        }
    }
}

/// Every paper printing of one card, newest first, up to a limit.
#[Object(rename_fields = "camelCase")]
impl PrintingsPage {
    async fn items(&self) -> &[Printing] {
        &self.items
    }
    /// How many paper printings the card has in all. More than `items` holds when the list was
    /// cut at its limit.
    async fn total(&self) -> i64 {
        self.total
    }
}

/// Another card a meld card is part of.
pub struct MeldRelation(pub CoreMeld);

/// Another card a meld card is part of: the card two halves meld into, or one of the halves a
/// melded card is made from.
#[Object(rename_fields = "camelCase")]
impl MeldRelation {
    /// The printing's Scryfall id (a UUID). To draw its art, pass it to the app's `CardImage`
    /// component (through `cardImageUrl(id, face, variant)`); never build an image URL by hand.
    async fn id(&self) -> &str {
        &self.0.id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// `meld_part` (a half) or `meld_result` (the melded card).
    async fn component(&self) -> &str {
        &self.0.component
    }
    async fn artist(&self) -> Option<&str> {
        self.0.artist.as_deref()
    }
}

/// What the reader holds of one card.
pub struct CardHoldings(pub CoreHoldings);

/// What the reader holds of one card, counted across every printing of it (the oracle card, not
/// one piece of cardboard).
#[Object(rename_fields = "camelCase")]
impl CardHoldings {
    /// Copies in the collection — every printing, finish and folder together.
    async fn owned(&self) -> i64 {
        self.0.owned
    }
    /// Copies the wishlist asks for, every wishlist entry for the card together.
    async fn wished(&self) -> i64 {
        self.0.wished
    }
    /// How many decks play the card (decks, not copies; built lists only).
    async fn decks(&self) -> i64 {
        self.0.decks
    }
}

/// TCGplayer's product ids for one printing.
pub struct TcgplayerIds(pub CoreTcgplayerIds);

/// TCGplayer's product ids for one printing. Both are null for a printing TCGplayer does not
/// sell.
#[Object(rename_fields = "camelCase")]
impl TcgplayerIds {
    /// The ordinary product, sold as Normal and Foil.
    async fn product_id(&self) -> Option<i64> {
        self.0.product_id
    }
    /// The etched-foil product, which TCGplayer lists separately.
    async fn etched_product_id(&self) -> Option<i64> {
        self.0.etched_product_id
    }
}

/// One Magic set in the card corpus.
pub struct CardSet(pub SetSummary);

/// One Magic set in the card corpus.
#[Object(rename_fields = "camelCase")]
impl CardSet {
    /// Lowercase set code, e.g. `m21` — what `s:` takes in a search query.
    async fn code(&self) -> &str {
        &self.0.code
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// Scryfall's set type: `expansion`, `core`, `masters`, `commander`, …
    async fn set_type(&self) -> Option<&str> {
        self.0.set_type.as_deref()
    }
    /// The set's release date, `YYYY-MM-DD`.
    async fn released_at(&self) -> Option<&str> {
        self.0.released_at.as_deref()
    }
    /// Paper printings of this set in the local corpus. 0 for a digital-only set.
    async fn card_count(&self) -> i64 {
        self.0.card_count
    }
}

/// What a card search can be ordered by. `price` is at the marketplace the search was asked at;
/// `released` is the printing's release date; `imageUpdated` when Scryfall last replaced its
/// images.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(name = "CardSearchSortKey", rename_items = "camelCase")]
pub enum CardSearchSortKey {
    Name,
    Set,
    Type,
    Rarity,
    Price,
    ManaValue,
    Released,
    ImageUpdated,
}

impl CardSearchSortKey {
    /// The key the core's search sorts on (`search::SEARCH_SORTS`).
    fn id(self) -> &'static str {
        match self {
            CardSearchSortKey::Name => "name",
            CardSearchSortKey::Set => "set",
            CardSearchSortKey::Type => "type",
            CardSearchSortKey::Rarity => "rarity",
            CardSearchSortKey::Price => "price",
            CardSearchSortKey::ManaValue => "manaValue",
            CardSearchSortKey::Released => "released",
            CardSearchSortKey::ImageUpdated => "imageUpdated",
        }
    }
}

/// One ordering column of a card search.
#[derive(InputObject, Clone, Debug)]
#[graphql(name = "CardSearchSort")]
pub struct CardSearchSort {
    /// The column.
    pub key: CardSearchSortKey,
    /// Largest, latest or last-in-the-alphabet first.
    #[graphql(default_with = "Some(false)")]
    pub descending: Option<bool>,
}

/// The core's search request: the filters, flattened, and the arguments only a search has.
///
/// The filters are destructured whole, so a field the core adds to `CardFilters` fails to compile
/// here rather than being dropped from every search without a word.
struct SearchArgs {
    filters: CardFilters,
    one_per_card: bool,
    owned: Option<bool>,
    paper_only: Option<bool>,
    min_price: Option<f64>,
    max_price: Option<f64>,
    sort: Option<Vec<CardSearchSort>>,
    limit: i32,
    offset: i32,
    marketplace: Market,
}

impl SearchArgs {
    fn into_request(self) -> SearchRequest {
        let CardFilters {
            text,
            format,
            colors,
            colors_strict,
            set_code,
            oracle_id,
            sets,
            mana_values,
            mana_x,
            rarity,
            rarities,
            types,
            borders,
            printed_finishes,
            universe,
            paper_only,
            playable_only,
            art_tags,
            oracle_tags,
            art_weight_floor,
            predicates,
        } = self.filters;
        SearchRequest {
            text,
            format,
            colors,
            colors_strict,
            set_code,
            oracle_id,
            sets,
            mana_values,
            mana_x,
            rarity,
            rarities,
            types,
            borders,
            printed_finishes,
            universe,
            // The argument's `false` shows digital printings; otherwise the filter's word,
            // which absent is the search's own default (paper only).
            paper_only: if self.paper_only == Some(false) {
                Some(false)
            } else {
                paper_only
            },
            playable_only,
            art_tags,
            oracle_tags,
            art_weight_floor,
            predicates,
            price_min: self.min_price,
            price_max: self.max_price,
            owned: self.owned,
            collapse: self.one_per_card.then_some(true),
            sort: self.sort.map(|terms| {
                terms
                    .into_iter()
                    .map(|s| SortTerm {
                        key: s.key.id().to_owned(),
                        dir: if s.descending == Some(true) {
                            "desc"
                        } else {
                            "asc"
                        }
                        .to_owned(),
                    })
                    .collect()
            }),
            marketplace: self.marketplace,
            // The core reads 0 as its default page and caps the rest.
            limit: u32::try_from(self.limit).unwrap_or(0),
            offset: u32::try_from(self.offset).unwrap_or(0),
            available_for_deck: None,
        }
    }
}

#[derive(Default)]
pub struct CardsQuery;

#[Object(rename_fields = "camelCase")]
impl CardsQuery {
    /// Search every Magic card in the corpus (not only the reader's) — the same search the app's
    /// Search page runs. Each row also says how many copies the reader owns and whether it is
    /// wishlisted.
    #[graphql(directive = invalidatedBy::apply(roots(&["cards"])))]
    #[allow(clippy::too_many_arguments)]
    async fn search_cards(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "Which cards to list. Absent matches every card.")] filters: Option<
            CardFilterInput,
        >,
        #[graphql(
            default_with = "Some(false)",
            desc = "Fold every printing of a card into one row (its newest matching printing stands for it); `printings`, `priceLow` and `priceHigh` then span them."
        )]
        one_per_card: Option<bool>,
        #[graphql(
            desc = "True: only printings in the reader's collection. False: only printings not in it. Absent: both."
        )]
        owned: Option<bool>,
        #[graphql(
            default_with = "Some(true)",
            desc = "Hide digital-only (Arena, MTGO) printings."
        )]
        paper_only: Option<bool>,
        #[graphql(
            desc = "Only printings priced at least this much at the marketplace, in its currency's whole units. Unpriced printings never match a bound."
        )]
        min_price: Option<f64>,
        #[graphql(desc = "Only printings priced at most this much at the marketplace.")]
        max_price: Option<f64>,
        #[graphql(
            desc = "Columns to order by, the first deciding and the rest breaking ties. Absent: relevance when there is free text, otherwise name."
        )]
        sort: Option<Vec<CardSearchSort>>,
        #[graphql(default = 50, desc = "Rows per page, at most 200.")] limit: Option<i32>,
        #[graphql(default = 0, desc = "Rows to skip.")] offset: Option<i32>,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<CardSearchResult>> {
        let req = SearchArgs {
            filters: core_filters(filters)?,
            one_per_card: one_per_card == Some(true),
            owned,
            paper_only,
            min_price,
            max_price,
            sort,
            limit: limit.unwrap_or(50),
            offset: offset.unwrap_or(0),
            marketplace: Market::from_id(&marketplace_of(ctx, marketplace)),
        }
        .into_request();
        Ok(Some(read(ctx, |c| run_search(c, &req))?.into()))
    }

    /// One printing of a card in full — text, faces, legalities and prices per finish. Null when
    /// no printing has that id.
    #[graphql(directive = invalidatedBy::apply(roots(&["card"])))]
    async fn card(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "The printing's Scryfall id.")] id: String,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<CardDetail>> {
        let market = Market::from_id(&marketplace_of(ctx, marketplace));
        Ok(read(ctx, |c| get_card(c, &id, market))?.map(CardDetail))
    }

    /// Every paper printing of one card (by its oracle id), newest first, each priced per
    /// finish.
    #[graphql(directive = invalidatedBy::apply(roots(&["card"])))]
    async fn card_printings(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "The oracle card — `oracleId` on `CardSummary` or `CardDetail`.")]
        oracle_id: String,
        #[graphql(desc = "At most this many printings (default 400, at most 1000).")] limit: Option<
            i32,
        >,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<PrintingsPage>> {
        let market = Market::from_id(&marketplace_of(ctx, marketplace));
        let page = read(ctx, |c| {
            list_printings(c, &oracle_id, market, limit.map(i64::from))
        })?;
        Ok(Some(page.into()))
    }

    /// Prices per finish for a set of printings, in one read. A printing id the corpus does not
    /// hold is left out of the answer; match rows by `cardId`.
    #[graphql(directive = invalidatedBy::apply(roots(&["cards"])))]
    async fn printing_prices(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "Printing ids.")] card_ids: Vec<String>,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<Vec<PrintingPrices>>> {
        let market = Market::from_id(&marketplace_of(ctx, marketplace));
        let prices = read(ctx, |c| read_printing_prices(c, &card_ids, market))?;
        Ok(Some(prices.into_iter().map(PrintingPrices).collect()))
    }

    /// How many copies of a card the reader owns, wants, and how many decks play it — every
    /// printing of the card together.
    #[graphql(directive = invalidatedBy::apply(roots(&["card", "collection", "wishlist", "decks"])))]
    async fn card_holdings(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "The oracle card — `oracleId` on `CardSummary` or `CardDetail`.")]
        oracle_id: String,
    ) -> Result<Option<CardHoldings>> {
        Ok(Some(CardHoldings(read(ctx, |c| holdings(c, &oracle_id))?)))
    }

    /// The cards a meld printing is part of. Empty for every card that is not a meld card.
    #[graphql(directive = invalidatedBy::apply(roots(&["card"])))]
    async fn card_meld_parts(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "The printing's Scryfall id.")] id: String,
    ) -> Result<Option<Vec<MeldRelation>>> {
        let parts = read(ctx, |c| meld_parts(c, &id))?;
        Ok(Some(parts.into_iter().map(MeldRelation).collect()))
    }

    /// TCGplayer's product ids for one printing, for a link to its product page. Both null when
    /// TCGplayer does not sell it.
    #[graphql(directive = invalidatedBy::apply(roots(&["card"])))]
    async fn card_tcgplayer_ids(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "The printing's Scryfall id.")] id: String,
    ) -> Result<Option<TcgplayerIds>> {
        Ok(Some(TcgplayerIds(read(ctx, |c| tcgplayer_ids(c, &id))?)))
    }

    /// Every Magic set in the card corpus, newest first.
    #[graphql(directive = invalidatedBy::apply(roots(&["sets"])))]
    async fn sets(&self, ctx: &Context<'_>) -> Result<Option<Vec<CardSet>>> {
        Ok(Some(
            read(ctx, run_list_sets)?.into_iter().map(CardSet).collect(),
        ))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    use grimoire_core::state::{fixtures::on_files, State};
    use serde_json::{json, Value};

    use super::TAG_BATCHES;
    use crate::Graph;

    /// A user schema with a corpus of three printings of two cards, two sets and two Oracle
    /// tags (one under the other) on Lightning Bolt — the user schema has no corpus rows of its
    /// own.
    #[rustfmt::skip]
    pub(crate) fn seeded(name: &str) -> Arc<State> {
        let state = on_files(name, "http://127.0.0.1:1").0;
        {
            let conn = state.lock_db();
            let rows = [
                ("bolt-lea", "o-bolt", "Lightning Bolt", "lea", "Limited Edition Alpha", "161", "Instant", 400.5, "1993-08-05",
                 r#"["nonfoil","shiny"]"#, r#"["showcase",3]"#),
                ("bolt-m11", "o-bolt", "Lightning Bolt", "m11", "Magic 2011", "146", "Instant", 1.5, "2010-07-16",
                 r#"["nonfoil","foil"]"#, "not json"),
                ("bear-lea", "o-bear", "Grizzly Bears", "lea", "Limited Edition Alpha", "189", "Creature — Bear", 2.0, "1993-08-05",
                 r#"["nonfoil"]"#, "[]"),
            ];
            for (id, oracle, name, set, set_name, cn, tl, usd, released, finishes, frames) in rows {
                conn.execute(
                    "INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number, lang, layout,
                         type_line, rarity, price_usd, released_at, finishes, frame_effects, legalities,
                         is_paper, search_text, raw, prices)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'en', 'normal', ?7, 'common', ?8, ?9, ?10, ?11,
                         '{\"modern\":\"legal\",\"vintage\":\"restricted\"}', 1, ?3 || ' ' || ?7, '{}', json_object('usd', CAST(?8 AS TEXT)))",
                    rusqlite::params![id, oracle, name, set, set_name, cn, tl, usd, released, finishes, frames],
                )
                .unwrap();
            }
            conn.execute_batch(
                "INSERT INTO sets (code, name, set_type, released_at) VALUES
                     ('lea', 'Limited Edition Alpha', 'core', '1993-08-05'),
                     ('m11', 'Magic 2011', 'core', '2010-07-16');
                 INSERT INTO oracle_tags (slug, label, id, slug_norm) VALUES
                     ('removal', 'Removal', 'r', 'removal'), ('burn', 'Burn', 'b', 'burn');
                 INSERT INTO oracle_tag_parents (child_slug, parent_slug) VALUES ('burn', 'removal');
                 INSERT INTO oracle_tag_cards (oracle_id, slug) VALUES
                     ('o-bolt', 'burn'), ('o-bolt', 'removal');
                 INSERT INTO cards_fts(cards_fts) VALUES('rebuild');",
            )
            .unwrap();
        }
        state
    }

    pub(crate) fn answer(state: &Arc<State>, query: &str) -> Value {
        let response = Graph::new().run(state, query, None, None, None);
        assert!(response.errors.is_empty(), "{:?}", response.errors);
        response.data.into_json().unwrap()
    }

    #[test]
    fn every_cards_root_field_answers() {
        let state = seeded("graph-cards-roots");
        let data = answer(
            &state,
            r#"{
                searchCards { total totalIsCapped items { id oracleId name price finishes oracleTags } }
                card(id: "bolt-lea") {
                    id name setName legalities { format status } finishes faces { name }
                    finishPrices { nonfoil foil etched } oracleTags
                }
                missing: card(id: "nope") { id }
                cardPrintings(oracleId: "o-bolt") { total items { id setCode finishes frameEffects finishPrices { nonfoil } } }
                printingPrices(cardIds: ["bolt-m11", "nope"]) { cardId finishPrices { nonfoil } }
                cardHoldings(oracleId: "o-bolt") { owned wished decks }
                cardMeldParts(id: "bolt-lea") { id }
                cardTcgplayerIds(id: "bolt-lea") { productId etchedProductId }
                sets { code name cardCount }
            }"#,
        );
        assert_eq!(data["searchCards"]["total"], json!(3));
        let card = &data["card"];
        assert_eq!(card["setName"], json!("Limited Edition Alpha"));
        // An unknown finish is dropped, not guessed at.
        assert_eq!(card["finishes"], json!(["nonfoil"]));
        let mut legalities = card["legalities"].as_array().unwrap().clone();
        legalities.sort_by_key(|l| l["format"].as_str().unwrap().to_owned());
        assert_eq!(
            legalities,
            vec![
                json!({ "format": "modern", "status": "legal" }),
                json!({ "format": "vintage", "status": "restricted" })
            ]
        );
        assert_eq!(card["faces"], json!([]));
        assert_eq!(card["oracleTags"], json!(["burn", "removal"]));
        assert_eq!(data["missing"], Value::Null);

        let printings = &data["cardPrintings"];
        assert_eq!(printings["total"], json!(2));
        let frames = |id: &str| {
            printings["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == json!(id))
                .unwrap()["frameEffects"]
                .clone()
        };
        // A non-string member and a column that is not JSON both read as what they can.
        assert_eq!(frames("bolt-lea"), json!(["showcase"]));
        assert_eq!(frames("bolt-m11"), json!([]));

        assert_eq!(
            data["printingPrices"],
            json!([{ "cardId": "bolt-m11", "finishPrices": { "nonfoil": 1.5 } }])
        );
        assert_eq!(
            data["cardHoldings"],
            json!({ "owned": 0, "wished": 0, "decks": 0 })
        );
        assert_eq!(data["cardMeldParts"], json!([]));
        assert_eq!(
            data["cardTcgplayerIds"],
            json!({ "productId": null, "etchedProductId": null })
        );
        let sets: Vec<&str> = data["sets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["code"].as_str().unwrap())
            .collect();
        assert_eq!(sets, vec!["m11", "lea"]);
    }

    /// The structured filter narrows the same search the Search page runs, beside the search's
    /// own arguments.
    #[test]
    fn filters_narrow_a_search() {
        let state = seeded("graph-cards-filters");
        let data = answer(
            &state,
            r#"{
                bolts: searchCards(filters: { text: "bolt" }) { total items { id } }
                bears: searchCards(filters: { oracleId: "o-bear" }) { total items { name } }
                alpha: searchCards(filters: { sets: ["lea"] }, sort: [{ key: name, descending: true }]) { items { name } }
                tagged: searchCards(filters: { oracleTags: { include: ["removal"] } }) { total }
                folded: searchCards(filters: { text: "bolt" }, onePerCard: true) { total items { printings } }
                cheap: searchCards(maxPrice: 10) { total }
            }"#,
        );
        assert_eq!(data["bolts"]["total"], json!(2));
        assert_eq!(data["bears"]["items"], json!([{ "name": "Grizzly Bears" }]));
        assert_eq!(
            data["alpha"]["items"],
            json!([{ "name": "Lightning Bolt" }, { "name": "Grizzly Bears" }])
        );
        assert_eq!(data["tagged"]["total"], json!(2));
        assert_eq!(data["folded"]["total"], json!(1));
        assert_eq!(data["folded"]["items"], json!([{ "printings": 2 }]));
        assert_eq!(data["cheap"]["total"], json!(2));
    }

    /// A page of search rows asking for their Oracle tags is one tags read, not one per row.
    #[test]
    fn a_page_of_cards_costs_one_tags_read() {
        let state = seeded("graph-cards-batch");
        let query = "{ searchCards { items { oracleId oracleTags } } }";
        // The counter is shared with any test running beside this one: take the smaller of two
        // runs, as the decks' batch test does.
        let runs: Vec<usize> = (0..2)
            .map(|_| {
                let before = TAG_BATCHES.load(Ordering::SeqCst);
                let data = answer(&state, query);
                for item in data["searchCards"]["items"].as_array().unwrap() {
                    let want = if item["oracleId"] == json!("o-bolt") {
                        json!(["burn", "removal"])
                    } else {
                        json!([])
                    };
                    assert_eq!(item["oracleTags"], want, "{item}");
                }
                TAG_BATCHES.load(Ordering::SeqCst) - before
            })
            .collect();
        assert_eq!(runs.into_iter().min(), Some(1));
    }
}
