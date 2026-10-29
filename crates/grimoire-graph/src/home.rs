//! The home page's own reads — its layout, the recently viewed strip, set completion, price
//! movers and one printing's price history, the collection's and the wishlist's value over time,
//! sticky notes, the new printings feed, deck completion, the deck-card review count and the sets
//! still to come.
//!
//! Every argument defaults to what the matching widget asks when nobody has configured it, so a
//! bare `{ priceMovers { … } }` is the question the Price movers widget asks out of the box.
//!
//! **Every money figure here is a decimal amount in the asked marketplace's currency**, and every
//! instant is Unix **seconds** — the core's `unixepoch()`, never milliseconds.
//!
//! **`homeLayout` answers the document as the core stores it.** The page runs
//! `parseLayout` (`features/home/layout.ts`) over it, which places a version-1 document's tiles
//! on the grid — and where a tile lands depends on the footprint the widget registry
//! (`features/home/widgets.ts`) gives each kind, which is TypeScript's. So a version-1 row answers
//! here with `version: 1` and every tile's `x`, `y`, `w` and `h` at `0`, its `span` kept: the
//! fact, not the page's placement of it. Every layout this build has written is version 2 and
//! reads the same on both sides.

use async_graphql::{types::Json, Context, Enum, InputObject, Object, Result};
use grimoire_core::deck_completion::{
    deck_completion_for, review_count, Compare, DeckCompletion as CoreDeckCompletion,
};
use grimoire_core::home::{HomeLayout as CoreLayout, HomeWidget as CoreWidget};
use grimoire_core::new_printings::{
    feed, Ask, NewPrinting as CoreNewPrinting, NewPrintingDeck as CoreNewPrintingDeck,
    NewPrintings as CoreNewPrintings,
};
use grimoire_core::price_history::{
    movers_in, PriceHistory as CorePriceHistory, PriceMover as CorePriceMover, PriceMoverScope,
    PriceMovers as CorePriceMovers, PricePoint as CorePricePoint,
};
use grimoire_core::recent_cards::{recent, RecentCard as CoreRecentCard};
use grimoire_core::set_completion::{set_completion_of, SetCompletion as CoreSetCompletion};
use grimoire_core::sorting::Marketplace as Market;
use grimoire_core::sticky_notes::{list_notes, StickyNoteRow};
use grimoire_core::upcoming_sets::{
    upcoming_sets_for, UpcomingSet as CoreUpcomingSet, UpcomingSets as CoreUpcomingSets,
};
use grimoire_core::value_history::{
    ValueBucket as CoreValueBucket, ValueHistory as CoreValueHistory, ValuePoint as CoreValuePoint,
};

use crate::enums::{DeckVariant, Finish};
use crate::{invalidatedBy, marketplace_of, read, roots, Marketplace};

// ── Enums ────────────────────────────────────────────────────────────────────────────────────

/// Which baseline price movers are measured against.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(name = "PriceMoverWindow")]
pub enum PriceMoverWindow {
    /// The snapshot from seven days ago.
    #[graphql(name = "DAYS_7")]
    Days7,
    /// The snapshot from thirty days ago.
    #[graphql(name = "DAYS_30")]
    Days30,
    /// The oldest snapshot kept.
    #[graphql(name = "ALL")]
    All,
}

impl PriceMoverWindow {
    /// The word the core reads.
    fn id(self) -> &'static str {
        match self {
            PriceMoverWindow::Days7 => "7d",
            PriceMoverWindow::Days30 => "30d",
            PriceMoverWindow::All => "all",
        }
    }
}

/// Which way a mover went: `up` gainers, `down` losers, `both` the two together ranked by the
/// size of the move.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(name = "PriceMoverDirection", rename_items = "lowercase")]
pub enum PriceMoverDirection {
    Both,
    Up,
    Down,
}

impl PriceMoverDirection {
    fn id(self) -> &'static str {
        match self {
            PriceMoverDirection::Both => "both",
            PriceMoverDirection::Up => "up",
            PriceMoverDirection::Down => "down",
        }
    }
}

/// How a value history is cut into lines: `total` is one line and no buckets; `type`, `color`
/// and `set` put every copy in exactly one bucket, so a point's bucket values sum to its total.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(name = "ValueSplit", rename_items = "lowercase")]
pub enum ValueSplit {
    Total,
    Type,
    Color,
    Set,
}

impl ValueSplit {
    fn id(self) -> &'static str {
        match self {
            ValueSplit::Total => "total",
            ValueSplit::Type => "type",
            ValueSplit::Color => "color",
            ValueSplit::Set => "set",
        }
    }
}

/// What deck completion measures. `collection`: every non-virtual deck's live list against the
/// copies the collection files in that deck's own folder group. `theory`: every deck that keeps a
/// theory list (virtual ones included), its live list against that plan.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(name = "DeckCompletionCompare", rename_items = "lowercase")]
pub enum DeckCompletionCompare {
    Collection,
    Theory,
}

/// How a planned copy is matched under `theory` (ignored under `collection`). `exact`: only the
/// exact printing and finish counts. `missing`: any printing of the same card in the live list
/// counts, so what is missing is what no printing in the deck covers.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(name = "DeckCompletionMatch", rename_items = "lowercase")]
pub enum DeckCompletionMatch {
    Exact,
    Missing,
}

/// A closed word the core answers as a string, read back — an error naming the word when this
/// build does not know it — a wrong answer is worse than a refused field.
fn known<T>(word: &str, what: &str, parse: impl FnOnce(&str) -> Option<T>) -> Result<T> {
    parse(word).ok_or_else(|| async_graphql::Error::new(format!("`{word}` is not a {what}.")))
}

// ── Layout ───────────────────────────────────────────────────────────────────────────────────

/// One tile on the home page and where it sits on the page's square-cell grid. Cell coordinates
/// count from the top-left corner.
pub struct HomeWidget(pub CoreWidget);

#[Object(rename_fields = "camelCase")]
impl HomeWidget {
    /// Stable across moves; unique within the layout.
    async fn id(&self) -> &str {
        &self.0.id
    }
    /// Which widget this is, e.g. `summary`, `priceMovers`, `stickyNotes`. An open set: a layout
    /// written by a newer build may carry kinds this one does not know.
    async fn kind(&self) -> &str {
        &self.0.kind
    }
    /// Column of the tile's left edge, in cells. `0` on a version-1 document's tile, which has
    /// never been placed.
    async fn x(&self) -> i64 {
        i64::from(self.0.x)
    }
    /// Row of the tile's top edge, in cells. `0` on a version-1 document's tile.
    async fn y(&self) -> i64 {
        i64::from(self.0.y)
    }
    /// Width, in cells. `0` on a version-1 document's tile — the page places it from `span`.
    async fn w(&self) -> i64 {
        i64::from(self.0.w)
    }
    /// Height, in cells. `0` on a version-1 document's tile.
    async fn h(&self) -> i64 {
        i64::from(self.0.h)
    }
    /// The legacy width (1 = one column, 2 = the whole row) kept for older builds. Use `w`
    /// instead.
    async fn span(&self) -> Option<i64> {
        self.0.span.map(i64::from)
    }
    /// The tile's own settings, as the widget stored them (keys depend on `kind`). `null` means
    /// every setting is at its default.
    async fn config(&self) -> Option<Json<serde_json::Value>> {
        (!self.0.config.is_null()).then(|| Json(self.0.config.clone()))
    }
}

/// The whole home page: which tiles it shows and where.
pub struct HomeLayout(pub CoreLayout);

#[Object(rename_fields = "camelCase")]
impl HomeLayout {
    /// The layout document's version: `2` for every layout this build writes, `1` for one an
    /// older build wrote (whose tiles have no place yet).
    async fn version(&self) -> i64 {
        i64::from(self.0.version)
    }
    /// Every tile, in stored order. Empty when the reader removed them all.
    async fn widgets(&self) -> Vec<HomeWidget> {
        self.0.widgets.iter().cloned().map(HomeWidget).collect()
    }
}

// ── Recently viewed, set completion ──────────────────────────────────────────────────────────

/// A card this device opened recently.
pub struct RecentCard(pub CoreRecentCard);

#[Object(rename_fields = "camelCase")]
impl RecentCard {
    /// The printing's Scryfall id.
    async fn card_id(&self) -> &str {
        &self.0.card_id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    async fn set_code(&self) -> &str {
        &self.0.set_code
    }
    /// When it was last opened, in Unix seconds.
    async fn viewed_at(&self) -> f64 {
        self.0.viewed_at as f64
    }
}

/// How much of one set the collection holds.
pub struct SetCompletion(pub CoreSetCompletion);

#[Object(rename_fields = "camelCase")]
impl SetCompletion {
    async fn set_code(&self) -> &str {
        &self.0.set_code
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// Release date as `YYYY-MM-DD`, or null where Scryfall published none.
    async fn released_at(&self) -> Option<&str> {
        self.0.released_at.as_deref()
    }
    /// Distinct collector numbers the collection holds any copy of (any finish or language)
    /// within `1..size`; every collector number held when `size` is null.
    async fn owned(&self) -> i64 {
        self.0.owned
    }
    /// The set's printed size, or null when unknown.
    async fn size(&self) -> Option<i64> {
        self.0.size
    }
}

// ── Prices ───────────────────────────────────────────────────────────────────────────────────

/// One printing (in one finish) whose price moved.
pub struct PriceMover(pub CorePriceMover);

#[Object(rename_fields = "camelCase")]
impl PriceMover {
    /// The printing's Scryfall id.
    async fn card_id(&self) -> &str {
        &self.0.card_id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    async fn set_code(&self) -> &str {
        &self.0.set_code
    }
    /// Null for a printing whose set has left the card data.
    async fn set_name(&self) -> Option<&str> {
        self.0.set_name.as_deref()
    }
    async fn finish(&self) -> Result<Finish> {
        known(&self.0.finish, "finish", Finish::from_id)
    }
    /// Today's price.
    async fn now(&self) -> f64 {
        self.0.now
    }
    /// The price in the baseline snapshot.
    async fn then(&self) -> f64 {
        self.0.then
    }
    /// `now - then`, signed; never 0 (a printing that did not move is not a mover).
    async fn delta(&self) -> f64 {
        self.0.delta
    }
}

/// The price movers and what they were measured against. An empty `movers` with `days` of 0 or 1
/// means there is no history yet, not that nothing moved.
pub struct PriceMovers(pub CorePriceMovers);

#[Object(rename_fields = "camelCase")]
impl PriceMovers {
    /// Largest move first.
    async fn movers(&self) -> Vec<PriceMover> {
        self.0.movers.iter().cloned().map(PriceMover).collect()
    }
    /// The baseline snapshot actually used, in Unix seconds; null when no snapshot is old enough
    /// to compare against.
    async fn since(&self) -> Option<f64> {
        self.0.since.map(|s| s as f64)
    }
    /// How many distinct days of price snapshots this marketplace holds.
    async fn days(&self) -> i64 {
        self.0.days
    }
}

/// One day of one printing's price.
pub struct PricePoint(pub CorePricePoint);

#[Object(rename_fields = "camelCase")]
impl PricePoint {
    /// That day's UTC midnight, in Unix seconds.
    async fn day(&self) -> f64 {
        self.0.day as f64
    }
    async fn price(&self) -> f64 {
        self.0.price
    }
}

/// One printing's daily price at one marketplace in one finish. Snapshots exist only for
/// printings that are owned, wished for or watched by a Price movers widget.
pub struct PriceHistory(pub CorePriceHistory);

#[Object(rename_fields = "camelCase")]
impl PriceHistory {
    /// One per day, oldest first, stopping before today.
    async fn points(&self) -> Vec<PricePoint> {
        self.0.points.iter().cloned().map(PricePoint).collect()
    }
    /// Today's live price; null when this marketplace has no price for it today.
    async fn now(&self) -> Option<f64> {
        self.0.now
    }
    /// Today's UTC midnight according to the database, in Unix seconds.
    async fn today(&self) -> f64 {
        self.0.today as f64
    }
}

/// Narrows price movers to the printings named here instead of every owned printing. Folder ids
/// are direct — a folder's subfolders are not included unless listed. A scope naming nothing
/// answers no movers.
#[derive(InputObject, Default)]
#[graphql(name = "PriceMoverScopeInput")]
pub struct PriceMoverScopeInput {
    /// Collection folder ids; `0` is copies filed in no folder.
    pub collection_folders: Option<Vec<i64>>,
    /// Wishlist folder ids; `0` is wishes filed in no folder.
    pub wishlist_folders: Option<Vec<i64>>,
    /// Printing ids (Scryfall), owned or not, each measured in every finish it is priced in. A
    /// card only has history once it is owned, wished for or watched.
    pub cards: Option<Vec<String>>,
}

// ── Value history ────────────────────────────────────────────────────────────────────────────

/// One line of a value history.
pub struct ValueBucket(pub CoreValueBucket);

#[Object(rename_fields = "camelCase")]
impl ValueBucket {
    /// The bucket's word. `type`: lowercase card type (`creature` … `land`) or `other`. `color`:
    /// `W` `U` `B` `R` `G`, `c` (colorless) or `multi`. `set`: the set code, or `other`.
    async fn key(&self) -> &str {
        &self.0.key
    }
    /// The set's name under the `set` split; null otherwise.
    async fn name(&self) -> Option<&str> {
        self.0.name.as_deref()
    }
}

/// One point of a value history.
pub struct ValuePoint(pub CoreValuePoint);

#[Object(rename_fields = "camelCase")]
impl ValuePoint {
    /// The period's UTC midnight, in Unix seconds. Daily for recent history, weekly further back
    /// (a weekly point answers its latest day).
    async fn day(&self) -> f64 {
        self.0.day as f64
    }
    /// Σ copies × price over the priced copies; an unpriced copy adds 0.
    async fn total(&self) -> f64 {
        self.0.total
    }
    /// One value per bucket of the history, in the same order; empty under the `total` split.
    async fn values(&self) -> &[f64] {
        &self.0.values
    }
    /// How much of `total - previous total` came from price changes alone; the rest is copies
    /// added or removed. Null on the first point.
    async fn moved(&self) -> Option<f64> {
        self.0.moved
    }
    /// True on the last point only: today's value, computed live.
    async fn live(&self) -> bool {
        self.0.live
    }
}

/// A value over time: every kept snapshot period before today, oldest first, plus a live point
/// for today. No points at all when there is nothing to value.
pub struct ValueHistory(pub CoreValueHistory);

#[Object(rename_fields = "camelCase")]
impl ValueHistory {
    /// The lines the split cuts the value into; empty for `total`. At most eight named buckets
    /// plus `other` for `type` and `set`.
    async fn buckets(&self) -> Vec<ValueBucket> {
        self.0.buckets.iter().cloned().map(ValueBucket).collect()
    }
    async fn points(&self) -> Vec<ValuePoint> {
        self.0.points.iter().cloned().map(ValuePoint).collect()
    }
    /// Today's UTC midnight according to the database, in Unix seconds.
    async fn today(&self) -> f64 {
        self.0.today as f64
    }
}

// ── Sticky notes ─────────────────────────────────────────────────────────────────────────────

/// One of the reader's sticky notes on the home page — free prose attached to no deck and no
/// card (not a deck note).
pub struct StickyNote(pub StickyNoteRow);

#[Object(rename_fields = "camelCase")]
impl StickyNote {
    async fn id(&self) -> i64 {
        self.0.id
    }
    /// May be empty; the app then derives a heading from the body.
    async fn title(&self) -> &str {
        &self.0.title
    }
    /// The note's text, as CommonMark Markdown.
    async fn body(&self) -> &str {
        &self.0.body
    }
    /// The note's colour word. Open-ended: a word the app does not know is drawn as `slate`.
    async fn color(&self) -> &str {
        &self.0.color
    }
    async fn pinned(&self) -> bool {
        self.0.pinned
    }
    /// The reader's own arrangement, ascending.
    async fn sort_order(&self) -> i64 {
        self.0.sort_order
    }
    /// Unix seconds.
    async fn created_at(&self) -> f64 {
        self.0.created_at as f64
    }
    /// Unix seconds.
    async fn updated_at(&self) -> f64 {
        self.0.updated_at as f64
    }
}

// ── New printings ────────────────────────────────────────────────────────────────────────────

/// A JSON array of strings stored as text, read leniently: anything else is `None`, and an
/// entry that is not a string is dropped.
fn string_list(json: Option<&str>) -> Option<Vec<String>> {
    match serde_json::from_str::<serde_json::Value>(json?).ok()? {
        serde_json::Value::Array(items) => Some(
            items
                .into_iter()
                .filter_map(|v| match v {
                    serde_json::Value::String(s) => Some(s),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    }
}

/// A deck holding the card a new printing reprints.
pub struct NewPrintingDeck(pub CoreNewPrintingDeck);

#[Object(rename_fields = "camelCase")]
impl NewPrintingDeck {
    async fn deck_id(&self) -> i64 {
        self.0.deck_id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// Copies across the deck's categories, live and theory summed.
    async fn quantity(&self) -> i64 {
        self.0.quantity
    }
    /// `live` if the live list holds it at all, else `theory`.
    async fn variant(&self) -> Result<DeckVariant> {
        known(&self.0.variant, "deck list", DeckVariant::from_id)
    }
    /// Whether the deck is virtual (not built from owned copies).
    async fn virtual_only(&self) -> bool {
        self.0.virtual_only
    }
}

/// A recently released printing of a card the watched decks already hold.
pub struct NewPrinting(pub CoreNewPrinting);

#[Object(rename_fields = "camelCase")]
impl NewPrinting {
    /// The printing's Scryfall id.
    async fn printing_id(&self) -> &str {
        &self.0.printing_id
    }
    async fn oracle_id(&self) -> &str {
        &self.0.oracle_id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    async fn set_code(&self) -> &str {
        &self.0.set_code
    }
    async fn set_name(&self) -> Option<&str> {
        self.0.set_name.as_deref()
    }
    async fn collector_number(&self) -> &str {
        &self.0.collector_number
    }
    /// Release date, `YYYY-MM-DD`.
    async fn released_at(&self) -> &str {
        &self.0.released_at
    }
    async fn rarity(&self) -> Option<&str> {
        self.0.rarity.as_deref()
    }
    /// Scryfall's `promo_types` for the printing, e.g. `showcase`, `borderless`.
    async fn promo_types(&self) -> Option<Vec<String>> {
        string_list(self.0.promo_types.as_deref())
    }
    /// The finishes the printing exists in: `nonfoil`, `foil`, `etched`.
    async fn finishes(&self) -> Option<Vec<String>> {
        string_list(self.0.finishes.as_deref())
    }
    /// The printing's language code, e.g. `en`.
    async fn lang(&self) -> &str {
        &self.0.lang
    }
    /// The decks holding the card.
    async fn decks(&self) -> Vec<NewPrintingDeck> {
        self.0.decks.iter().cloned().map(NewPrintingDeck).collect()
    }
}

/// Recent reprints of cards in the watched decks, newest first, and the facts that tell an empty
/// feed's three causes apart (no deck watched, nothing reprinted, card data too short).
pub struct NewPrintings(pub CoreNewPrintings);

#[Object(rename_fields = "camelCase")]
impl NewPrintings {
    async fn printings(&self) -> Vec<NewPrinting> {
        self.0.printings.iter().cloned().map(NewPrinting).collect()
    }
    /// How many decks the scope resolved to; 0 is a real answer.
    async fn decks_watched(&self) -> i64 {
        self.0.decks_watched
    }
    /// The window's far edge, `YYYY-MM-DD`.
    async fn since(&self) -> &str {
        &self.0.since
    }
    /// The oldest release date in the answer, `YYYY-MM-DD`; null when empty.
    async fn oldest(&self) -> Option<&str> {
        self.0.oldest.as_deref()
    }
    /// When this device last saw a non-empty feed, in Unix seconds; null for never. A printing
    /// released after it is unseen.
    async fn seen_at(&self) -> Option<f64> {
        self.0.seen_at.map(|s| s as f64)
    }
}

// ── Deck completion ──────────────────────────────────────────────────────────────────────────

/// How far one deck is along, counted exactly as the deck editor counts: every active pile
/// (sideboard and companion included), a copy matching on exact printing and finish.
pub struct DeckCompletion(pub CoreDeckCompletion);

#[Object(rename_fields = "camelCase")]
impl DeckCompletion {
    async fn deck_id(&self) -> i64 {
        self.0.deck_id
    }
    /// Which list the figures are a fraction of: `live` under `collection`, `theory` under
    /// `theory`.
    async fn list(&self) -> Result<DeckVariant> {
        known(&self.0.list, "deck list", DeckVariant::from_id)
    }
    /// Copies the measured list asks for.
    async fn wanted(&self) -> i64 {
        self.0.wanted
    }
    /// Of those, copies already covered. Never more than `wanted`.
    async fn owned(&self) -> i64 {
        self.0.owned
    }
    /// `wanted - owned`; never negative.
    async fn missing(&self) -> i64 {
        self.0.missing
    }
    /// What the missing copies cost. Null when nothing in the list is priced at this marketplace
    /// (draw a dash, not 0).
    async fn missing_cost(&self) -> Option<f64> {
        self.0.missing_cost
    }
    /// Missing copies this marketplace has no price for, left out of `missingCost`.
    async fn unpriced_missing(&self) -> i64 {
        self.0.unpriced_missing
    }
}

// ── Upcoming sets ────────────────────────────────────────────────────────────────────────────

/// A set with paper printings still to be released.
pub struct UpcomingSet(pub CoreUpcomingSet);

#[Object(rename_fields = "camelCase")]
impl UpcomingSet {
    async fn code(&self) -> &str {
        &self.0.code
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// The set's earliest card date in the window, `YYYY-MM-DD`.
    async fn released_at(&self) -> &str {
        &self.0.released_at
    }
    /// Cards previewed so far (one per card, whatever its printings).
    async fn previewed(&self) -> i64 {
        self.0.previewed
    }
    /// Distinct cards in it that the reader's non-virtual decks hold (live or theory), basic
    /// lands left out.
    async fn in_decks(&self) -> i64 {
        self.0.in_decks
    }
}

/// The sets still to come, and the day they were counted from.
pub struct UpcomingSets(pub CoreUpcomingSets);

#[Object(rename_fields = "camelCase")]
impl UpcomingSets {
    /// Today's date according to the database (UTC), `YYYY-MM-DD`.
    async fn today(&self) -> &str {
        &self.0.today
    }
    /// Soonest first, then by code.
    async fn sets(&self) -> Vec<UpcomingSet> {
        self.0.sets.iter().cloned().map(UpcomingSet).collect()
    }
}

// ── Root fields ──────────────────────────────────────────────────────────────────────────────

/// This domain's batch loaders, for one execution — none: no field here reads per row.
pub(crate) fn data(
    request: async_graphql::Request,
    _state: &std::sync::Arc<grimoire_core::state::State>,
) -> async_graphql::Request {
    request
}

#[derive(Default)]
pub struct HomeQuery;

#[Object(rename_fields = "camelCase")]
impl HomeQuery {
    /// The home page's tiles and where they sit, as stored. A version-1 document (an older
    /// build's) answers its tiles unplaced — `x`, `y`, `w` and `h` at `0`, `span` kept — where
    /// the page places them on the grid itself.
    #[graphql(directive = invalidatedBy::apply(roots(&["homeLayout"])))]
    async fn home_layout(&self, ctx: &Context<'_>) -> Result<Option<HomeLayout>> {
        let layout = read(ctx, |c| Ok(grimoire_core::home::stored(c)))?;
        Ok(Some(HomeLayout(layout)))
    }

    /// The cards this device opened most recently, newest first.
    #[graphql(directive = invalidatedBy::apply(roots(&["recentCards"])))]
    async fn recent_cards(
        &self,
        ctx: &Context<'_>,
        #[graphql(default_with = "Some(8)", desc = "At most this many, clamped to 1–24.")]
        limit: Option<i32>,
    ) -> Result<Option<Vec<RecentCard>>> {
        let limit = u32::try_from(limit.unwrap_or(8).max(1)).unwrap_or(1);
        let cards = read(ctx, |c| Ok(recent(c, limit)))?;
        Ok(Some(cards.into_iter().map(RecentCard).collect()))
    }

    /// Every set the collection holds a card from, with how much of it is owned.
    #[graphql(directive = invalidatedBy::apply(roots(&["collection"])))]
    async fn set_completion(&self, ctx: &Context<'_>) -> Result<Option<Vec<SetCompletion>>> {
        let sets = read(ctx, set_completion_of)?;
        Ok(Some(sets.into_iter().map(SetCompletion).collect()))
    }

    /// The owned printings whose price moved most since the window's baseline snapshot, largest
    /// move first — or, given a `scope`, the printings it names.
    // A scope can name wishlist folders, whose writes the app's own reader leaves to the next read.
    #[graphql(directive = invalidatedBy::apply(roots(&["collection", "wishlist"])))]
    async fn price_movers(
        &self,
        ctx: &Context<'_>,
        #[graphql(default_with = "Some(PriceMoverWindow::Days7)")] window: Option<PriceMoverWindow>,
        #[graphql(default_with = "Some(PriceMoverDirection::Both)")] direction: Option<
            PriceMoverDirection,
        >,
        #[graphql(
            default_with = "Some(100)",
            desc = "At most this many movers, clamped to 1–100."
        )]
        limit: Option<i32>,
        #[graphql(desc = "Absent for every owned printing.")] scope: Option<PriceMoverScopeInput>,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<PriceMovers>> {
        let market = Market::from_id(&marketplace_of(ctx, marketplace));
        let window = window.unwrap_or(PriceMoverWindow::Days7).id();
        let direction = direction.unwrap_or(PriceMoverDirection::Both).id();
        let limit = i64::from(limit.unwrap_or(100));
        let scope = scope.map(|s| PriceMoverScope {
            collection_folders: s.collection_folders.unwrap_or_default(),
            wishlist_folders: s.wishlist_folders.unwrap_or_default(),
            cards: s.cards.unwrap_or_default(),
        });
        let movers = read(ctx, |c| {
            movers_in(c, window, direction, market, limit, scope.as_ref())
        })?;
        Ok(Some(PriceMovers(movers)))
    }

    /// One printing's daily price in one finish, before today, beside today's price.
    #[graphql(directive = invalidatedBy::apply(roots(&["collection"])))]
    async fn price_history(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "The printing's Scryfall id.")] card_id: String,
        #[graphql(default_with = "Some(Finish::Nonfoil)")] finish: Option<Finish>,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<PriceHistory>> {
        let market = Market::from_id(&marketplace_of(ctx, marketplace));
        let finish = finish.unwrap_or(Finish::Nonfoil).id();
        let history = read(ctx, |c| {
            grimoire_core::price_history::history(c, &card_id, finish, market)
        })?;
        Ok(Some(PriceHistory(history)))
    }

    /// The collection's value over time, cut by `split`.
    #[graphql(directive = invalidatedBy::apply(roots(&["collection"])))]
    async fn collection_value_history(
        &self,
        ctx: &Context<'_>,
        #[graphql(default_with = "Some(ValueSplit::Type)")] split: Option<ValueSplit>,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<ValueHistory>> {
        let market = Market::from_id(&marketplace_of(ctx, marketplace));
        let split = split.unwrap_or(ValueSplit::Type).id();
        let history = read(ctx, |c| {
            grimoire_core::value_history::history(c, split, market)
        })?;
        Ok(Some(ValueHistory(history)))
    }

    /// The wishlist's value (what the wishes would cost) over time, cut by `split`. A step not
    /// explained by `moved` is wishes added, bought or removed.
    #[graphql(directive = invalidatedBy::apply(roots(&["wishlist"])))]
    async fn wishlist_value_history(
        &self,
        ctx: &Context<'_>,
        #[graphql(default_with = "Some(ValueSplit::Type)")] split: Option<ValueSplit>,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<ValueHistory>> {
        let market = Market::from_id(&marketplace_of(ctx, marketplace));
        let split = split.unwrap_or(ValueSplit::Type).id();
        let history = read(ctx, |c| {
            grimoire_core::value_history::wishlist_history(c, split, market)
        })?;
        Ok(Some(ValueHistory(history)))
    }

    /// Every sticky note, in the reader's arrangement.
    #[graphql(directive = invalidatedBy::apply(roots(&["stickyNotes"])))]
    async fn sticky_notes(&self, ctx: &Context<'_>) -> Result<Option<Vec<StickyNote>>> {
        // The command's own rule: an unreadable table is no notes, never an error.
        let notes = read(ctx, |c| Ok(list_notes(c).unwrap_or_default()))?;
        Ok(Some(notes.into_iter().map(StickyNote).collect()))
    }

    /// Recent reprints of cards the watched decks hold, newest first.
    // Its own root, which the sync names; a deck write changes which cards are watched as well.
    #[graphql(directive = invalidatedBy::apply(roots(&["newPrintings", "decks"])))]
    #[allow(clippy::too_many_arguments)]
    async fn new_printings(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "Watch only these decks. Absent watches every deck.")] deck_ids: Option<
            Vec<i64>,
        >,
        #[graphql(
            default_with = "Some(90)",
            desc = "How far back to look, in days, clamped to 1–365."
        )]
        days: Option<i32>,
        #[graphql(
            default_with = "Some(vec![\"en\".to_owned()])",
            desc = "Language codes to answer in; an empty list is every language (one row per language of a reprint)."
        )]
        langs: Option<Vec<String>>,
        #[graphql(default_with = "Some(false)", desc = "Watch virtual decks too.")] include_virtual: Option<
            bool,
        >,
        #[graphql(
            default_with = "Some(true)",
            desc = "Count cards that are only on a deck's theory list."
        )]
        include_theory: Option<bool>,
        #[graphql(default_with = "Some(false)", desc = "Include basic lands.")]
        include_basics: Option<bool>,
        #[graphql(
            default_with = "Some(100)",
            desc = "At most this many printings, clamped to 1–100."
        )]
        limit: Option<i32>,
    ) -> Result<Option<NewPrintings>> {
        let ask = Ask {
            scope: if deck_ids.is_none() { "all" } else { "chosen" }.to_owned(),
            deck_ids: deck_ids.unwrap_or_default(),
            days: i64::from(days.unwrap_or(90)),
            langs: langs.unwrap_or_else(|| vec!["en".to_owned()]),
            include_virtual: include_virtual.unwrap_or(false),
            include_theory: include_theory.unwrap_or(true),
            include_basics: include_basics.unwrap_or(false),
            limit: Some(i64::from(limit.unwrap_or(100))),
        };
        Ok(Some(NewPrintings(read(ctx, |c| feed(c, &ask))?)))
    }

    /// How far every deck the comparison applies to is along (archived decks included), one row
    /// per deck. Join on `deckId` for the deck's name.
    // Owned copies are collection rows: a binder write moves the answer with no deck write.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks", "collection"])))]
    async fn deck_completion(
        &self,
        ctx: &Context<'_>,
        #[graphql(default_with = "Some(DeckCompletionCompare::Collection)")] compare: Option<
            DeckCompletionCompare,
        >,
        #[graphql(default_with = "Some(DeckCompletionMatch::Exact)")] theory_match: Option<
            DeckCompletionMatch,
        >,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<Vec<DeckCompletion>>> {
        let market = Market::from_id(&marketplace_of(ctx, marketplace));
        let compare = Compare::from_opt(
            Some(match compare.unwrap_or(DeckCompletionCompare::Collection) {
                DeckCompletionCompare::Collection => "collection",
                DeckCompletionCompare::Theory => "theory",
            }),
            Some(match theory_match.unwrap_or(DeckCompletionMatch::Exact) {
                DeckCompletionMatch::Exact => "exact",
                DeckCompletionMatch::Missing => "missing",
            }),
        );
        let rows = read(ctx, |c| deck_completion_for(c, market, compare))?;
        Ok(Some(rows.into_iter().map(DeckCompletion).collect()))
    }

    /// How many deck card rows are flagged for review (rows, not copies) — e.g. after an import
    /// or sync could not settle them.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn deck_cards_to_review_count(&self, ctx: &Context<'_>) -> Result<Option<i64>> {
        Ok(Some(read(ctx, review_count)?))
    }

    /// Sets with paper printings releasing after today and within `days`.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn upcoming_sets(
        &self,
        ctx: &Context<'_>,
        #[graphql(
            default_with = "Some(90)",
            desc = "How far ahead to look, in days, clamped to 1–365."
        )]
        days: Option<i32>,
    ) -> Result<Option<UpcomingSets>> {
        let days = i64::from(days.unwrap_or(90));
        Ok(Some(UpcomingSets(read(ctx, |c| {
            upcoming_sets_for(c, days)
        })?)))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use grimoire_core::schema::fixtures::{deck, seed_card};
    use grimoire_core::state::{fixtures::on_files, State};
    use serde_json::{json, Value};

    use super::string_list;
    use crate::Graph;

    fn answer(state: &Arc<State>, query: &str) -> Value {
        let response = Graph::new().run(state, query, None, None, None);
        assert!(response.errors.is_empty(), "{:?}", response.errors);
        response.data.into_json().unwrap()
    }

    /// Every root field of the domain, every field of its answer, in one document: none errs and
    /// none is null.
    #[test]
    fn every_home_root_field_answers() {
        let state = on_files("graph-home-all", "http://127.0.0.1:1").0;
        {
            let conn = state.lock_db();
            seed_card(&conn, "c-bolt", "lea", "161");
            deck(&conn, "Burn");
            grimoire_core::recent_cards::record(&conn, "c-bolt", 1_760_000_000).unwrap();
            grimoire_core::sticky_notes::create_note(&conn, "Trade night", "Bring it.", "amber")
                .unwrap();
        }
        let data = answer(
            &state,
            r#"{
              homeLayout { version widgets { id kind x y w h span config } }
              recentCards { cardId name setCode viewedAt }
              setCompletion { setCode name releasedAt owned size }
              priceMovers { movers { cardId name setCode setName finish now then delta } since days }
              scoped: priceMovers(window: ALL, direction: up, limit: 5,
                                  scope: { collectionFolders: [0], cards: ["c-bolt"] },
                                  marketplace: cardmarket) { days }
              priceHistory(cardId: "c-bolt") { points { day price } now today }
              collectionValueHistory { buckets { key name } points { day total values moved live } today }
              wishlistValueHistory(split: set) { buckets { key } points { total } today }
              stickyNotes { id title body color pinned sortOrder createdAt updatedAt }
              newPrintings { printings { printingId oracleId name setCode setName collectorNumber
                                         releasedAt rarity promoTypes finishes lang
                                         decks { deckId name quantity variant virtualOnly } }
                             decksWatched since oldest seenAt }
              chosen: newPrintings(deckIds: [], langs: []) { decksWatched }
              deckCompletion { deckId list wanted owned missing missingCost unpricedMissing }
              theory: deckCompletion(compare: theory, theoryMatch: missing) { deckId }
              deckCardsToReviewCount
              upcomingSets { today sets { code name releasedAt previewed inDecks } }
            }"#,
        );
        for (field, value) in data.as_object().unwrap() {
            assert!(!value.is_null(), "{field} answered null");
        }
        assert_eq!(
            data["recentCards"],
            json!([{ "cardId": "c-bolt", "name": "Lightning Bolt", "setCode": "lea",
                     "viewedAt": 1_760_000_000.0 }])
        );
        assert_eq!(data["stickyNotes"][0]["title"], json!("Trade night"));
        assert_eq!(data["stickyNotes"][0]["color"], json!("amber"));
        assert_eq!(data["deckCardsToReviewCount"], json!(0));
        assert_eq!(data["chosen"]["decksWatched"], json!(0));
        // A fresh install's layout is the core's default, every tile placed.
        let widgets = data["homeLayout"]["widgets"].as_array().unwrap();
        assert_eq!(data["homeLayout"]["version"], json!(2));
        assert_eq!(widgets.len(), grimoire_core::home::DEFAULT_WIDGET_COUNT);
        assert!(widgets
            .iter()
            .all(|w| w["config"].is_null() && w["w"] != json!(0)));
    }

    /// The layout as stored: a version-1 row's tiles unplaced with their spans, a tile's settings
    /// as stored, and `null` for a tile with none.
    #[test]
    fn a_layout_answers_as_the_core_stores_it() {
        let state = on_files("graph-home-layout", "http://127.0.0.1:1").0;
        grimoire_core::app_meta::set_app_meta(
            &state.lock_db(),
            grimoire_core::home::K_HOME_LAYOUT,
            r#"{"version":1,"widgets":[
                {"id":"decks","kind":"decks","span":2,"config":{"deckIds":[3,1]}},
                {"id":"x","kind":"fromTheFuture","span":1}]}"#,
        )
        .unwrap();
        let data = answer(
            &state,
            "{ homeLayout { version widgets { id kind x y w h span config } } }",
        );
        assert_eq!(
            data["homeLayout"],
            json!({ "version": 1, "widgets": [
                { "id": "decks", "kind": "decks", "x": 0, "y": 0, "w": 0, "h": 0, "span": 2,
                  "config": { "deckIds": [3, 1] } },
                { "id": "x", "kind": "fromTheFuture", "x": 0, "y": 0, "w": 0, "h": 0, "span": 1,
                  "config": null },
            ] })
        );
    }

    /// `promoTypes` and `finishes` are JSON text in the core, read leniently as the page reads
    /// them: an array keeps its strings, anything else is null.
    #[test]
    fn a_stored_string_list_is_read_leniently() {
        assert_eq!(string_list(None), None);
        assert_eq!(string_list(Some("not json")), None);
        assert_eq!(string_list(Some(r#"{"a":1}"#)), None);
        assert_eq!(string_list(Some("[]")), Some(vec![]));
        assert_eq!(
            string_list(Some(r#"["foil", 3, null, "etched"]"#)),
            Some(vec!["foil".to_owned(), "etched".to_owned()])
        );
    }
}
