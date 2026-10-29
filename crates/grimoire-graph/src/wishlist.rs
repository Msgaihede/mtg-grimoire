//! The wishlist: its wishes, its totals and breakdowns, its folders and their folder rules, and
//! the optimise plan — what the home page's Summary, Wishlist value, To review, Folders and
//! Wishlist savings widgets read.
//!
//! The shapes the collection answers too (`BreakdownRow`, `ShelfCount`, `RuleConflicts`) are
//! `crate::collection`'s, and so is the folder-scope spelling: `folderId` / `rootOnly` / neither,
//! translated here into the core's `WishlistQuery` `folder_id` / `flatten` ([`query_of`]).
//!
//! A wish's `folder`, a move's `folder` and a folder's `summary` go through a batch
//! ([`WishlistFolders`], [`WishlistFolderSummaries`]); an owned place's `folder` through the
//! collection's.

use std::collections::HashMap;
use std::sync::Arc;

use async_graphql::dataloader::{DataLoader, Loader};
use async_graphql::{types::Json, Context, Enum, Object, Result};
use grimoire_core::folder_rules::FolderRule;
use grimoire_core::sorting::Marketplace as Market;
use grimoire_core::state::State;
use grimoire_core::wishlist::{
    breakdown, list_wishes, shelf_counts, summarise_wishlist, WishOwnedPlace as CorePlace, WishRow,
    WishlistPage as CorePage, WishlistQuery as Scope, WishlistSummary as CoreSummary,
};
use grimoire_core::wishlist_folders::{
    folder_summary, list_folders, rule_conflicts, WishlistFolder as CoreFolder,
    WishlistFolderSummary as CoreFolderSummary,
};
use grimoire_core::wishlist_optimize::{
    plan, OptimizePrinting as CorePrinting, WishOptimizeMove as CoreMove,
    WishlistOptimizePlan as CorePlan,
};

use crate::collection::{
    collection_folder, on_a_thread_of_its_own, page_of, sort_of, BreakdownDimension, BreakdownRow,
    CollectionFolder, FolderKey, RuleConflicts, ShelfCount,
};
use crate::enums::Finish;
use crate::filters::{core_filters, CardFilterInput};
use crate::{invalidatedBy, marketplace_of, read, roots, Marketplace};

/// What to order wishes by. `price` is one copy's price, `cost` is price × copies wanted, `added`
/// is when the wish was last written.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "lowercase")]
pub enum WishlistSortKey {
    Name,
    Quantity,
    Cost,
    Price,
    Added,
}

impl WishlistSortKey {
    /// The sort key the core's `WISHLIST_SORTS` names.
    pub fn id(self) -> &'static str {
        match self {
            WishlistSortKey::Name => "name",
            WishlistSortKey::Quantity => "quantity",
            WishlistSortKey::Cost => "cost",
            WishlistSortKey::Price => "price",
            WishlistSortKey::Added => "added",
        }
    }
}

/// A stored finish word as the graph's enum: absent is `None` (any finish), and a word this build
/// does not know is an error rather than a quiet "any".
fn finish_of(stored: Option<&str>) -> Result<Option<Finish>> {
    stored
        .map(|f| Finish::from_id(f).ok_or_else(|| format!("unknown finish `{f}`").into()))
        .transpose()
}

/// What one wishlist folder holds **directly** — not counting the folders inside it.
pub struct WishlistFolderSummary(pub Arc<CoreFolderSummary>);

#[Object(rename_fields = "camelCase")]
impl WishlistFolderSummary {
    async fn folder_id(&self) -> i64 {
        self.0.folder_id
    }
    /// Wishes filed directly in this folder.
    async fn wishes(&self) -> i64 {
        self.0.wishes
    }
    /// Copies those wishes want, summed.
    async fn copies(&self) -> i64 {
        self.0.copies
    }
    /// What those copies cost at the marketplace, in its currency, as a decimal — over the wishes
    /// it prices. Read beside `unpriced`.
    async fn cost(&self) -> f64 {
        self.0.cost
    }
    /// Wishes here the marketplace has no price for, and so left out of `cost`.
    async fn unpriced(&self) -> i64 {
        self.0.unpriced
    }
}

/// One folder of the wishlist's filing tree. Flat: build the tree from `parentId`. A wish filed in
/// no folder is at the root, which is not a folder.
///
/// Behind an `Arc` because the batch that answers a wish's `folder` hands one folder to every wish
/// filed in it.
pub struct WishlistFolder(pub Arc<CoreFolder>);

#[Object(rename_fields = "camelCase")]
impl WishlistFolder {
    async fn id(&self) -> i64 {
        self.0.id
    }
    /// The folder this one sits inside, or null at the root.
    async fn parent_id(&self) -> Option<i64> {
        self.0.parent_id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// Its position among its siblings, ascending.
    async fn sort_order(&self) -> i64 {
        self.0.sort_order
    }
    /// The deck this folder is the managed wishlist of — kept by the app as what that deck's
    /// planned list still lacks, and not editable by hand. Null for a folder the reader made.
    async fn managed_deck_id(&self) -> Option<i64> {
        self.0.managed_deck_id
    }
    /// Whether this is a managed wishlist's `Tokens` sub-folder: the token printings that deck
    /// still lacks.
    async fn managed_tokens(&self) -> bool {
        self.0.managed_tokens
    }
    /// The folder's own folder rules (inherited ones are not repeated), as stored —
    /// `CollectionFolder.rules`' shape. `conditions` rules are ignored on the wishlist. `[]` for
    /// none.
    async fn rules(&self) -> Json<&[FolderRule]> {
        Json(&self.0.rules)
    }
    /// What this folder holds directly, not counting its sub-folders. Null when the backend
    /// answered no row for it. Batched: one read per marketplace, whatever the number of folders.
    async fn summary(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "The marketplace prices are quoted at. Defaults to the reader's.")]
        marketplace: Option<Marketplace>,
    ) -> Result<Option<WishlistFolderSummary>> {
        let loader = ctx.data_unchecked::<DataLoader<WishlistFolderSummaries>>();
        let key = FolderKey {
            marketplace: marketplace_of(ctx, marketplace),
            folder_id: self.0.id,
        };
        Ok(loader.load_one(key).await?.map(WishlistFolderSummary))
    }
}

/// The wishlist folder `folder_id` names, through the execution's batch — `None` at the root or
/// for a folder gone between the two reads.
async fn wishlist_folder(
    ctx: &Context<'_>,
    folder_id: Option<i64>,
) -> Result<Option<WishlistFolder>> {
    let Some(id) = folder_id else {
        return Ok(None);
    };
    let loader = ctx.data_unchecked::<DataLoader<WishlistFolders>>();
    Ok(loader.load_one(id).await?.map(WishlistFolder))
}

/// One collection folder's share of the copies the collection already holds of a wish's card.
pub struct WishOwnedPlace<'a>(pub &'a CorePlace);

#[Object(rename_fields = "camelCase")]
impl WishOwnedPlace<'_> {
    /// The collection folder, or null for copies filed in no folder.
    async fn folder_id(&self) -> Option<i64> {
        self.0.folder_id
    }
    /// The collection folder, or null at the root.
    async fn folder(&self, ctx: &Context<'_>) -> Result<Option<CollectionFolder>> {
        collection_folder(ctx, self.0.folder_id).await
    }
    /// Copies here of the printing the wish asks for.
    async fn exact(&self) -> i64 {
        self.0.exact
    }
    /// Copies here of other printings of the same card.
    async fn other(&self) -> i64 {
        self.0.other
    }
    /// Whether the copies here are spoken for: the folder is a deck's, or locked (set aside).
    /// False at the root.
    async fn held(&self) -> bool {
        self.0.held
    }
}

/// One wish: a card the reader wants, how many copies, and where it is filed. A wish pins one
/// printing (`cardId`) or asks for any printing of the card (`cardId` null).
pub struct WishlistEntry<'a>(pub &'a WishRow);

#[Object(rename_fields = "camelCase")]
impl WishlistEntry<'_> {
    async fn id(&self) -> i64 {
        self.0.id
    }
    /// The card's Scryfall oracle id.
    async fn oracle_id(&self) -> Option<&str> {
        self.0.oracle_id.as_deref()
    }
    /// The pinned printing's Scryfall id, or null for any printing.
    async fn card_id(&self) -> Option<&str> {
        self.0.card_id.as_deref()
    }
    /// The printing to draw the wish as — its own if pinned, else the card's newest printing.
    /// Never read as what the wish is for. Null when no printing is known.
    async fn art_card_id(&self) -> Option<&str> {
        self.0.art_card_id.as_deref()
    }
    /// The folder this wish is filed in, or null at the root of the wishlist.
    async fn folder_id(&self) -> Option<i64> {
        self.0.folder_id
    }
    /// The folder this wish is filed in, or null at the root.
    async fn folder(&self, ctx: &Context<'_>) -> Result<Option<WishlistFolder>> {
        wishlist_folder(ctx, self.0.folder_id).await
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// Null for any printing.
    async fn set_code(&self) -> Option<&str> {
        self.0.set_code.as_deref()
    }
    async fn collector_number(&self) -> Option<&str> {
        self.0.collector_number.as_deref()
    }
    async fn lang(&self) -> Option<&str> {
        self.0.lang.as_deref()
    }
    async fn rarity(&self) -> Option<&str> {
        self.0.rarity.as_deref()
    }
    /// In Scryfall's notation, e.g. `{2}{G}{G}`.
    async fn mana_cost(&self) -> Option<&str> {
        self.0.mana_cost.as_deref()
    }
    async fn type_line(&self) -> Option<&str> {
        self.0.type_line.as_deref()
    }
    /// Scryfall's layout word.
    async fn layout(&self) -> Option<&str> {
        self.0.layout.as_deref()
    }
    /// Copies wanted.
    async fn quantity(&self) -> i64 {
        self.0.quantity
    }
    /// The finish the reader wants, or null for any.
    async fn preferred_finish(&self) -> Result<Option<Finish>> {
        finish_of(self.0.preferred_finish.as_deref())
    }
    /// The cheapest way to buy one copy at the marketplace, in its currency, as a decimal — at the
    /// preferred finish if one is named. Null when that marketplace has no price.
    async fn unit_price(&self) -> Option<f64> {
        self.0.unit_price
    }
    /// How many other wishes ask for the same card — a chance to buy it twice.
    async fn elsewhere(&self) -> i64 {
        self.0.elsewhere
    }
    /// Copies the collection already holds of the printing this wish asks for (any printing, for
    /// an unpinned wish). Reported only: nothing subtracts it.
    async fn owned_exact(&self) -> i64 {
        self.0.owned_exact
    }
    /// Copies the collection holds of other printings of the same card.
    async fn owned_other(&self) -> i64 {
        self.0.owned_other
    }
    /// Where those owned copies are filed, per collection folder.
    async fn owned_places(&self) -> Vec<WishOwnedPlace<'_>> {
        self.0.owned_places.iter().map(WishOwnedPlace).collect()
    }
    /// The reader's entry tags on this wish — free text. Not Scryfall tags, deck labels or deck
    /// tags.
    async fn entry_tags(&self) -> Vec<String> {
        grimoire_core::deck::read_tags(&self.0.tags)
    }
    /// The reader's entry note on this wish — free text.
    async fn entry_note(&self) -> Option<&str> {
        self.0.notes.as_deref()
    }
    /// A sentence saying why this wish needs the reader's attention, or null.
    async fn needs_review(&self) -> Option<&str> {
        self.0.needs_review.as_deref()
    }
    /// When the wish was last written, in Unix seconds.
    async fn updated_at(&self) -> f64 {
        self.0.updated_at as f64
    }
}

/// One page of wishes.
pub struct WishlistEntryPage(pub CorePage);

#[Object(rename_fields = "camelCase")]
impl WishlistEntryPage {
    async fn items(&self) -> Vec<WishlistEntry<'_>> {
        self.0.items.iter().map(WishlistEntry).collect()
    }
    /// Wishes matching, across every page.
    async fn total(&self) -> i64 {
        self.0.total
    }
}

/// The whole wishlist's totals, every folder and the root.
pub struct WishlistSummary(pub CoreSummary);

#[Object(rename_fields = "camelCase")]
impl WishlistSummary {
    /// Wishes (rows), not copies.
    async fn wishes(&self) -> i64 {
        self.0.wishes
    }
    /// Copies wanted, summed.
    async fn copies(&self) -> i64 {
        self.0.copies
    }
    /// What those copies cost at the marketplace, in its currency, as a decimal — an any-printing
    /// wish at its cheapest printing, over the copies it prices. Read beside `unpriced`.
    async fn cost(&self) -> f64 {
        self.0.cost
    }
    /// Copies the marketplace has no price for, and so left out of `cost`.
    async fn unpriced(&self) -> i64 {
        self.0.unpriced
    }
}

/// One printing in a wishlist optimise plan.
pub struct OptimizePrinting<'a>(pub &'a CorePrinting);

#[Object(rename_fields = "camelCase")]
impl OptimizePrinting<'_> {
    /// The printing's Scryfall id.
    async fn card_id(&self) -> &str {
        &self.0.card_id
    }
    async fn set_code(&self) -> &str {
        &self.0.set_code
    }
    async fn collector_number(&self) -> &str {
        &self.0.collector_number
    }
    async fn lang(&self) -> &str {
        &self.0.lang
    }
    /// One copy at the wish's finish, at the marketplace, in its currency, as a decimal. Null when
    /// unpriced — only ever on the printing a wish is moving from.
    async fn price(&self) -> Option<f64> {
        self.0.price
    }
}

/// One pinned wish that a cheaper printing of the same card could answer.
pub struct WishOptimizeMove<'a>(pub &'a CoreMove);

#[Object(rename_fields = "camelCase")]
impl WishOptimizeMove<'_> {
    async fn wish_id(&self) -> i64 {
        self.0.wish_id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// Copies wanted.
    async fn quantity(&self) -> i64 {
        self.0.quantity
    }
    async fn preferred_finish(&self) -> Result<Option<Finish>> {
        finish_of(self.0.preferred_finish.as_deref())
    }
    /// The wishlist folder the wish is filed in, or null at the root.
    async fn folder_id(&self) -> Option<i64> {
        self.0.folder_id
    }
    async fn folder(&self, ctx: &Context<'_>) -> Result<Option<WishlistFolder>> {
        wishlist_folder(ctx, self.0.folder_id).await
    }
    /// The printing now.
    async fn from(&self) -> OptimizePrinting<'_> {
        OptimizePrinting(&self.0.from)
    }
    /// The cheaper printing.
    async fn to(&self) -> OptimizePrinting<'_> {
        OptimizePrinting(&self.0.to)
    }
    /// `from.price - to.price`, in the marketplace's currency. Null when `from` is unpriced.
    async fn saved_per_copy(&self) -> Option<f64> {
        self.0.saved_per_copy
    }
    /// `savedPerCopy` × `quantity`. Null with it.
    async fn saved(&self) -> Option<f64> {
        self.0.saved
    }
    /// Whether the wish is in a deck's managed wishlist — informational only: its printing
    /// follows the deck.
    async fn managed(&self) -> bool {
        self.0.managed
    }
}

/// What moving the wishes in scope to their cheapest priced printings would save. Nothing is
/// written. `moves`, `alreadyCheapest` and `skipped` partition `considered`.
pub struct WishlistOptimizePlan(pub CorePlan);

#[Object(rename_fields = "camelCase")]
impl WishlistOptimizePlan {
    async fn moves(&self) -> Vec<WishOptimizeMove<'_>> {
        self.0.moves.iter().map(WishOptimizeMove).collect()
    }
    /// Wishes looked at.
    async fn considered(&self) -> i64 {
        self.0.considered
    }
    /// Already on the cheapest priced printing, plus every any-printing wish.
    async fn already_cheapest(&self) -> i64 {
        self.0.already_cheapest
    }
    /// Passed over: no card to compare against, or no printing priced at the wish's finish.
    async fn skipped(&self) -> i64 {
        self.0.skipped
    }
}

/// The wishlist's folders a level of the answer asked about, read in one `list_folders`.
pub struct WishlistFolders(Arc<State>);

impl Loader<i64> for WishlistFolders {
    type Value = Arc<CoreFolder>;
    type Error = Arc<String>;

    async fn load(&self, keys: &[i64]) -> Result<HashMap<i64, Self::Value>, Self::Error> {
        let folders = list_folders(&self.0.lock_db_read()).map_err(Arc::new)?;
        Ok(folders
            .into_iter()
            .filter(|f| keys.contains(&f.id))
            .map(|f| (f.id, Arc::new(f)))
            .collect())
    }
}

/// Every wishlist folder's summary, read once per marketplace the level asked about.
pub struct WishlistFolderSummaries(Arc<State>);

impl Loader<FolderKey> for WishlistFolderSummaries {
    type Value = Arc<CoreFolderSummary>;
    type Error = Arc<String>;

    async fn load(
        &self,
        keys: &[FolderKey],
    ) -> Result<HashMap<FolderKey, Self::Value>, Self::Error> {
        let mut marketplaces: Vec<&str> = keys.iter().map(|k| k.marketplace.as_str()).collect();
        marketplaces.sort_unstable();
        marketplaces.dedup();
        let conn = self.0.lock_db_read();
        let mut out = HashMap::new();
        for marketplace in marketplaces {
            for row in folder_summary(&conn, Market::from_id(marketplace)).map_err(Arc::new)? {
                let key = FolderKey {
                    marketplace: marketplace.to_owned(),
                    folder_id: row.folder_id,
                };
                out.insert(key, Arc::new(row));
            }
        }
        Ok(out)
    }
}

/// This domain's batch loaders, for one execution.
pub(crate) fn data(request: async_graphql::Request, state: &Arc<State>) -> async_graphql::Request {
    request
        .data(DataLoader::new(
            WishlistFolders(state.clone()),
            on_a_thread_of_its_own,
        ))
        .data(DataLoader::new(
            WishlistFolderSummaries(state.clone()),
            on_a_thread_of_its_own,
        ))
}

/// The scope arguments every filtered wishlist read takes, as the core's query. The core reads
/// `folder_id: None` as the root and needs `flatten` for "every folder", so the collection's
/// spelling is translated here.
fn query_of(
    ctx: &Context<'_>,
    filters: Option<CardFilterInput>,
    folder_id: Option<i64>,
    root_only: Option<bool>,
    shelves: Option<Vec<i64>>,
    needs_review: Option<bool>,
    marketplace: Option<Marketplace>,
) -> Result<Scope> {
    Ok(Scope {
        cards: core_filters(filters)?,
        folder_id,
        flatten: folder_id.is_none() && !root_only.unwrap_or(false),
        shelves,
        needs_review,
        marketplace: Market::from_id(&marketplace_of(ctx, marketplace)),
        ..Scope::default()
    })
}

#[derive(Default)]
pub struct WishlistQuery;

#[Object(rename_fields = "camelCase")]
impl WishlistQuery {
    /// The whole wishlist's totals — wishes, copies, cost. Takes no filters.
    #[graphql(directive = invalidatedBy::apply(roots(&["wishlist"])))]
    async fn wishlist_summary(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "The marketplace prices are quoted at. Defaults to the reader's.")]
        marketplace: Option<Marketplace>,
    ) -> Result<Option<WishlistSummary>> {
        let marketplace = Market::from_id(&marketplace_of(ctx, marketplace));
        Ok(Some(WishlistSummary(read(ctx, |c| {
            summarise_wishlist(c, marketplace)
        })?)))
    }

    /// The wishlist's wishes, one page at a time — every wish, or the ones the arguments narrow
    /// to. Name order unless `sort` says otherwise.
    // `ownedPlaces` moves with a collection write or a collection folder's lock.
    #[graphql(directive = invalidatedBy::apply(roots(&["wishlist", "collection"])))]
    #[allow(clippy::too_many_arguments)]
    async fn wishlist_entries(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "Only the cards this search matches.")] filters: Option<CardFilterInput>,
        #[graphql(
            desc = "Only the wishes filed directly in this folder — not in the folders inside it. Absent: every folder."
        )]
        folder_id: Option<i64>,
        #[graphql(desc = "Only the wishes filed in no folder. Ignored when `folderId` is given.")]
        root_only: Option<bool>,
        #[graphql(
            desc = "Only the wishes filed directly in these folders, `0` for the root. Replaces `folderId` and `rootOnly`."
        )]
        shelves: Option<Vec<i64>>,
        #[graphql(desc = "`true`: only wishes needing review; `false`: only the others.")]
        needs_review: Option<bool>,
        #[graphql(desc = "The marketplace prices are quoted at. Defaults to the reader's.")]
        marketplace: Option<Marketplace>,
        sort: Option<WishlistSortKey>,
        #[graphql(desc = "Reverse `sort`.")] descending: Option<bool>,
        #[graphql(desc = "Wishes per page, 100 by default and at most 500.")] limit: Option<i64>,
        #[graphql(desc = "Wishes to skip. Default 0.")] offset: Option<i64>,
    ) -> Result<Option<WishlistEntryPage>> {
        let mut query = query_of(
            ctx,
            filters,
            folder_id,
            root_only,
            shelves,
            needs_review,
            marketplace,
        )?;
        (query.limit, query.offset) = page_of(limit, offset);
        query.sort = sort_of(sort.map(WishlistSortKey::id), descending);
        Ok(Some(WishlistEntryPage(read(ctx, |c| {
            list_wishes(c, &query)
        })?)))
    }

    /// Per-folder counts of the wishlist's wishes — one row per folder holding a wish the
    /// arguments match.
    #[graphql(directive = invalidatedBy::apply(roots(&["wishlist"])))]
    #[allow(clippy::too_many_arguments)]
    async fn wishlist_shelf_counts(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "Only the cards this search matches.")] filters: Option<CardFilterInput>,
        #[graphql(
            desc = "Only the wishes filed directly in this folder — not in the folders inside it. Absent: every folder."
        )]
        folder_id: Option<i64>,
        #[graphql(desc = "Only the wishes filed in no folder. Ignored when `folderId` is given.")]
        root_only: Option<bool>,
        #[graphql(
            desc = "Only the wishes filed directly in these folders, `0` for the root. Replaces `folderId` and `rootOnly`."
        )]
        shelves: Option<Vec<i64>>,
        #[graphql(desc = "`true`: only wishes needing review; `false`: only the others.")]
        needs_review: Option<bool>,
        #[graphql(desc = "The marketplace prices are quoted at. Defaults to the reader's.")]
        marketplace: Option<Marketplace>,
    ) -> Result<Option<Vec<ShelfCount>>> {
        let query = query_of(
            ctx,
            filters,
            folder_id,
            root_only,
            shelves,
            needs_review,
            marketplace,
        )?;
        let rows = read(ctx, |c| shelf_counts(c, &query))?;
        Ok(Some(rows.into_iter().map(ShelfCount).collect()))
    }

    /// The whole wishlist sliced along one dimension — copies and cost per bucket (`value` is the
    /// cost). Takes no filters.
    #[graphql(directive = invalidatedBy::apply(roots(&["wishlist"])))]
    async fn wishlist_breakdown(
        &self,
        ctx: &Context<'_>,
        dimension: BreakdownDimension,
        #[graphql(desc = "The marketplace prices are quoted at. Defaults to the reader's.")]
        marketplace: Option<Marketplace>,
    ) -> Result<Option<Vec<BreakdownRow>>> {
        let marketplace = Market::from_id(&marketplace_of(ctx, marketplace));
        let rows = read(ctx, |c| breakdown(c, dimension.id(), marketplace))?;
        Ok(Some(rows.into_iter().map(BreakdownRow).collect()))
    }

    /// Every folder of the wishlist, flat — including the decks' managed wishlists. Build the tree
    /// from `parentId`.
    #[graphql(directive = invalidatedBy::apply(roots(&["wishlist"])))]
    async fn wishlist_folders(&self, ctx: &Context<'_>) -> Result<Option<Vec<WishlistFolder>>> {
        Ok(Some(
            read(ctx, list_folders)?
                .into_iter()
                .map(|f| WishlistFolder(Arc::new(f)))
                .collect(),
        ))
    }

    /// What each wishlist folder holds directly (not counting its sub-folders) — wishes, copies,
    /// cost.
    #[graphql(directive = invalidatedBy::apply(roots(&["wishlist"])))]
    async fn wishlist_folder_summaries(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "The marketplace prices are quoted at. Defaults to the reader's.")]
        marketplace: Option<Marketplace>,
    ) -> Result<Option<Vec<WishlistFolderSummary>>> {
        let marketplace = Market::from_id(&marketplace_of(ctx, marketplace));
        let rows = read(ctx, |c| folder_summary(c, marketplace))?;
        Ok(Some(
            rows.into_iter()
                .map(|r| WishlistFolderSummary(Arc::new(r)))
                .collect(),
        ))
    }

    /// Which wishes break a folder rule of the folder they are filed in, and how many per folder.
    /// A price rule is checked at the marketplace.
    #[graphql(directive = invalidatedBy::apply(roots(&["wishlist"])))]
    async fn wishlist_rule_conflicts(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "The marketplace prices are quoted at. Defaults to the reader's.")]
        marketplace: Option<Marketplace>,
    ) -> Result<Option<RuleConflicts>> {
        let marketplace = Market::from_id(&marketplace_of(ctx, marketplace));
        Ok(Some(RuleConflicts(read(ctx, |c| {
            rule_conflicts(c, marketplace)
        })?)))
    }

    /// What re-pointing every pinned wish in scope to its cheapest priced printing would save, at
    /// the marketplace. Nothing is written. Every wish by default.
    #[graphql(directive = invalidatedBy::apply(roots(&["wishlist"])))]
    #[allow(clippy::too_many_arguments)]
    async fn wishlist_optimize_plan(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "Only the cards this search matches.")] filters: Option<CardFilterInput>,
        #[graphql(
            desc = "Only the wishes filed directly in this folder — not in the folders inside it. Absent: every folder."
        )]
        folder_id: Option<i64>,
        #[graphql(desc = "Only the wishes filed in no folder. Ignored when `folderId` is given.")]
        root_only: Option<bool>,
        #[graphql(
            desc = "Only the wishes filed directly in these folders, `0` for the root. Replaces `folderId` and `rootOnly`."
        )]
        shelves: Option<Vec<i64>>,
        #[graphql(desc = "`true`: only wishes needing review; `false`: only the others.")]
        needs_review: Option<bool>,
        #[graphql(desc = "The marketplace prices are quoted at. Defaults to the reader's.")]
        marketplace: Option<Marketplace>,
        #[graphql(
            desc = "Include the decks' managed wishlists (their moves are marked `managed`). Default false."
        )]
        include_managed: Option<bool>,
    ) -> Result<Option<WishlistOptimizePlan>> {
        let query = query_of(
            ctx,
            filters,
            folder_id,
            root_only,
            shelves,
            needs_review,
            marketplace,
        )?;
        let include_managed = include_managed.unwrap_or(false);
        Ok(Some(WishlistOptimizePlan(read(ctx, |c| {
            plan(c, &query, include_managed)
        })?)))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use grimoire_core::collection::{add_entry, EntryInput};
    use grimoire_core::entry_tags::set_wish_tags;
    use grimoire_core::schema::fixtures::seed_card;
    use grimoire_core::state::{fixtures::on_files, State};
    use grimoire_core::wishlist::{add_wish, WishInput};
    use grimoire_core::wishlist_folders::create_folder;
    use serde_json::{json, Value};

    use crate::Graph;

    fn answer(state: &Arc<State>, query: &str) -> Value {
        let response = Graph::new().run(state, query, None, None, None);
        assert!(response.errors.is_empty(), "{:?}", response.errors);
        response.data.into_json().unwrap()
    }

    /// A wish pinned to a printing, wanted foil and filed in `Wanted`, with entry tags and a note,
    /// whose card the collection already holds two copies of in a folder; and an any-printing wish
    /// at the root.
    fn stocked(name: &str) -> (Arc<State>, i64, i64) {
        let state = on_files(name, "http://127.0.0.1:1").0;
        let ids = {
            let conn = state.lock_db();
            seed_card(&conn, "bolt-a", "lea", "1");
            seed_card(&conn, "bolt-b", "m10", "2");
            let shelf =
                grimoire_core::collection_folders::create_folder(&conn, None, "Shelf").unwrap();
            add_entry(
                &conn,
                &EntryInput {
                    card_id: "bolt-a".into(),
                    finish: "nonfoil".into(),
                    quantity: 2,
                    folder_id: Some(shelf.id),
                    ..EntryInput::default()
                },
            )
            .unwrap();
            let wanted = create_folder(&conn, None, "Wanted").unwrap().id;
            let pinned = add_wish(
                &conn,
                &WishInput {
                    card_id: Some("bolt-a".into()),
                    quantity: 4,
                    preferred_finish: Some("foil".into()),
                    notes: Some("For the cube.".into()),
                    folder_id: Some(wanted),
                    ..WishInput::default()
                },
            )
            .unwrap();
            set_wish_tags(&conn, pinned.id, &["Cube".into()]).unwrap();
            add_wish(
                &conn,
                &WishInput {
                    oracle_id: Some("o-bolt-b".into()),
                    name: Some("Lightning Bolt".into()),
                    quantity: 1,
                    ..WishInput::default()
                },
            )
            .unwrap();
            (wanted, shelf.id)
        };
        (state, ids.0, ids.1)
    }

    /// Every root field of the domain answers, nested edges included.
    #[test]
    fn every_wishlist_root_answers() {
        let (state, wanted, shelf) = stocked("graph-wishlist-roots");
        let data = answer(
            &state,
            "{
              wishlistSummary { wishes copies cost unpriced }
              wishlistEntries(sort: quantity, descending: true) {
                total
                items {
                  id oracleId cardId artCardId folderId name setCode collectorNumber lang rarity
                  manaCost typeLine layout quantity preferredFinish unitPrice elsewhere ownedExact
                  ownedOther entryTags entryNote needsReview updatedAt
                  folder { id name managedDeckId managedTokens rules summary { wishes copies cost unpriced } }
                  ownedPlaces { folderId exact other held folder { id name } }
                }
              }
              wishlistShelfCounts { folderId tiles copies value unpriced peek }
              wishlistBreakdown(dimension: finish) { key name cards value }
              wishlistFolders { id parentId name sortOrder managedDeckId managedTokens rules summary(marketplace: cardmarket) { folderId } }
              wishlistFolderSummaries { folderId wishes copies cost unpriced }
              wishlistRuleConflicts { folders { folderId entries copies } ids }
              wishlistOptimizePlan(includeManaged: true) {
                considered alreadyCheapest skipped
                moves { wishId name quantity preferredFinish folderId folder { name } managed saved savedPerCopy
                        from { cardId setCode collectorNumber lang price } to { cardId price } }
              }
            }",
        );
        assert_eq!(data["wishlistSummary"]["wishes"], json!(2));
        assert_eq!(data["wishlistSummary"]["copies"], json!(5));

        let items = data["wishlistEntries"]["items"].as_array().unwrap();
        assert_eq!(data["wishlistEntries"]["total"], json!(2));
        let (pinned, any) = (&items[0], &items[1]);
        assert_eq!(pinned["quantity"], json!(4));
        assert_eq!(pinned["preferredFinish"], json!("foil"));
        assert_eq!(pinned["folder"]["id"], json!(wanted));
        assert_eq!(pinned["folder"]["name"], json!("Wanted"));
        assert_eq!(pinned["folder"]["rules"], json!([]));
        assert_eq!(pinned["folder"]["summary"]["copies"], json!(4));
        // The entry tags, parsed out of the stored column; the note under its domain name.
        assert_eq!(pinned["entryTags"], json!(["Cube"]));
        assert_eq!(pinned["entryNote"], json!("For the cube."));
        // The owned copies' place, and the collection folder behind it.
        assert_eq!(pinned["ownedExact"], json!(2));
        assert_eq!(
            pinned["ownedPlaces"],
            json!([{ "folderId": shelf, "exact": 2, "other": 0, "held": false,
                     "folder": { "id": shelf, "name": "Shelf" } }])
        );
        assert_eq!(any["cardId"], Value::Null);
        assert_eq!(any["preferredFinish"], Value::Null);
        assert_eq!(any["folder"], Value::Null);
        assert_eq!(any["entryTags"], json!([]));

        assert!(data["wishlistShelfCounts"].is_array());
        assert!(data["wishlistBreakdown"].is_array());
        assert!(data["wishlistFolders"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["id"] == json!(wanted)));
        assert!(data["wishlistFolderSummaries"].is_array());
        assert_eq!(data["wishlistRuleConflicts"]["ids"], json!([]));
        assert!(data["wishlistOptimizePlan"]["moves"].is_array());
    }

    /// The collection's folder-scope spelling, translated into the wishlist's `folderId` /
    /// `flatten`: a folder, the root alone, and neither (every folder).
    #[test]
    fn the_folder_scope_is_the_collection_s_spelling() {
        let (state, wanted, _) = stocked("graph-wishlist-scope");
        let data = answer(
            &state,
            &format!(
                "{{
                  everywhere: wishlistEntries {{ total }}
                  folder: wishlistEntries(folderId: {wanted}) {{ items {{ quantity }} }}
                  root: wishlistEntries(rootOnly: true) {{ items {{ quantity }} }}
                  shelves: wishlistShelfCounts(shelves: [{wanted}]) {{ folderId copies }}
                  searched: wishlistEntries(filters: {{ oracleId: \"o-bolt-b\" }}) {{ total }}
                }}"
            ),
        );
        assert_eq!(data["everywhere"]["total"], json!(2));
        assert_eq!(data["folder"]["items"], json!([{ "quantity": 4 }]));
        assert_eq!(data["root"]["items"], json!([{ "quantity": 1 }]));
        assert_eq!(
            data["shelves"],
            json!([{ "folderId": wanted, "copies": 4 }])
        );
        assert_eq!(data["searched"]["total"], json!(1));
    }
}
