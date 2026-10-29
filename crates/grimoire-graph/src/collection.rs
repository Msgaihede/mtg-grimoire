//! The collection: its entries, its totals and breakdowns, its folders and their folder rules —
//! what the home page's Summary, Collection value, To review and Folders widgets read, and the
//! binder itself, paged.
//!
//! The shapes the wishlist answers too — a breakdown bucket, a shelf count, rule conflicts — are
//! declared here and `crate::wishlist` uses them.
//!
//! **Folder scope is one spelling on both lists**: `folderId` names a folder, `rootOnly` narrows
//! to the cards filed nowhere, and neither is every folder. The core's `CollectionQuery` takes
//! exactly that; `crate::wishlist` translates it into the wishlist's `folderId` / `flatten`.
//!
//! A card search is `filters` ([`CardFilterInput`]) where the page takes `query` in Scryfall's
//! syntax — the one deliberate difference (`docs/reference/graphql.md`).
//!
//! An entry's `folder` and a folder's `summary` go through a batch ([`CollectionFolders`],
//! [`CollectionFolderSummaries`]): a page of five hundred entries asking for their folders is one
//! read of the folder list, not five hundred.

use std::collections::HashMap;
use std::sync::Arc;

use async_graphql::dataloader::{DataLoader, Loader};
use async_graphql::futures_util::future::BoxFuture;
use async_graphql::{types::Json, Context, Enum, Object, Result};
use grimoire_core::collection::{
    breakdown, list_entries, shelf_counts, summarise, BreakdownRow as CoreBreakdownRow,
    CollectionPage as CorePage, CollectionQuery as Scope, CollectionRow, CollectionSummary as Core,
    ShelfCount as CoreShelfCount,
};
use grimoire_core::collection_folders::{
    folder_summary, list_folders, rule_conflicts, CollectionFolder as CoreFolder,
    CollectionFolderSummary as CoreFolderSummary,
};
use grimoire_core::folder_rules::{
    FolderConflicts as CoreFolderConflicts, RuleConflicts as CoreConflicts,
};
use grimoire_core::sorting::{Marketplace as Market, SortTerm};
use grimoire_core::state::State;

use crate::enums::{Condition, Finish};
use crate::filters::{core_filters, CardFilterInput};
use crate::{invalidatedBy, marketplace_of, read, roots, Marketplace};

/// The core's page-size cap on `collection_list` and `wishlist_list`.
pub(crate) const PAGE_MAX: i64 = 500;
/// The page size a list field answers with when the document names none — the core's own.
pub(crate) const PAGE_DEFAULT: i64 = 100;

/// A `limit`/`offset` pair as the two list reads take them: never negative, never past the cap.
pub(crate) fn page_of(limit: Option<i64>, offset: Option<i64>) -> (u32, u32) {
    let limit = limit.unwrap_or(PAGE_DEFAULT).clamp(1, PAGE_MAX);
    let offset = offset.unwrap_or(0).clamp(0, i64::from(u32::MAX));
    (limit as u32, offset as u32)
}

/// One sort column, ascending unless `descending` — the shape both lists take.
pub(crate) fn sort_of(key: Option<&str>, descending: Option<bool>) -> Option<Vec<SortTerm>> {
    key.map(|key| {
        vec![SortTerm {
            key: key.to_owned(),
            dir: if descending.unwrap_or(false) {
                "desc"
            } else {
                "asc"
            }
            .to_owned(),
        }]
    })
}

/// One way to slice the collection or the wishlist: by `rarity`, by `color` (a colour bucket —
/// `multi` for two or more colours, `c` for colourless), by `set`, or by `finish`.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "lowercase")]
pub enum BreakdownDimension {
    Rarity,
    Color,
    Set,
    Finish,
}

impl BreakdownDimension {
    /// The word the core's `breakdown` reads.
    pub fn id(self) -> &'static str {
        match self {
            BreakdownDimension::Rarity => "rarity",
            BreakdownDimension::Color => "color",
            BreakdownDimension::Set => "set",
            BreakdownDimension::Finish => "finish",
        }
    }
}

/// What to order collection entries by. `price` is one copy's price, `value` is price × copies
/// held, `added` is when the entry was last written.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "lowercase")]
pub enum CollectionSortKey {
    Name,
    Set,
    Finish,
    Quantity,
    Value,
    Price,
    Added,
}

impl CollectionSortKey {
    /// The sort key the core's `COLLECTION_SORTS` names.
    pub fn id(self) -> &'static str {
        match self {
            CollectionSortKey::Name => "name",
            CollectionSortKey::Set => "set",
            CollectionSortKey::Finish => "finish",
            CollectionSortKey::Quantity => "quantity",
            CollectionSortKey::Value => "value",
            CollectionSortKey::Price => "price",
            CollectionSortKey::Added => "added",
        }
    }
}

/// One bucket of the whole collection or the whole wishlist, sliced along one
/// `BreakdownDimension`. The buckets partition the list: summed, they are its total.
pub struct BreakdownRow(pub CoreBreakdownRow);

#[Object(rename_fields = "camelCase")]
impl BreakdownRow {
    /// The bucket: a rarity, a colour bucket (`multi` and `c` included), a lowercase set code, or
    /// a finish — and on the wishlist's finish slice, `any` for wishes that name no finish.
    async fn key(&self) -> &str {
        &self.0.key
    }
    /// A readable name where the key is a code — the set's name beside its set code. Null for the
    /// other dimensions.
    async fn name(&self) -> Option<&str> {
        self.0.name.as_deref()
    }
    /// Copies in the bucket, not entries.
    async fn cards(&self) -> i64 {
        self.0.cards
    }
    /// What the bucket's copies are worth at the marketplace, in its currency, as a decimal —
    /// summed over the copies it prices. Null when it prices none of them, which is not zero.
    async fn value(&self) -> Option<f64> {
        self.0.value
    }
}

/// One folder's counts within a filtered list — the heading of one shelf on the collection's or
/// the wishlist's Shelves view. Only shelves holding something in scope have one.
pub struct ShelfCount(pub CoreShelfCount);

#[Object(rename_fields = "camelCase")]
impl ShelfCount {
    /// The folder, or `0` for the cards (or wishes) filed in no folder.
    async fn folder_id(&self) -> i64 {
        self.0.folder_id
    }
    /// Tiles the shelf draws: on the collection one per printing and finish, on the wishlist one
    /// per wish.
    async fn tiles(&self) -> i64 {
        self.0.tiles
    }
    /// Copies, summed over the shelf.
    async fn copies(&self) -> i64 {
        self.0.copies
    }
    /// What the shelf is worth (collection) or costs (wishlist) at the marketplace, in its
    /// currency, as a decimal. Null when it prices nothing on the shelf.
    async fn value(&self) -> Option<f64> {
        self.0.value
    }
    /// What the marketplace could not price: copies on the collection, wishes on the wishlist.
    async fn unpriced(&self) -> i64 {
        self.0.unpriced
    }
    /// Up to four Scryfall card ids to draw as the shelf's thumbnails, by card name. Ignores the
    /// filters.
    async fn peek(&self) -> &[String] {
        &self.0.peek
    }
}

/// One folder holding entries that break its folder rules (its own or inherited) — counted in
/// that folder alone, not the folders inside it.
pub struct FolderConflicts<'a>(pub &'a CoreFolderConflicts);

#[Object(rename_fields = "camelCase")]
impl FolderConflicts<'_> {
    async fn folder_id(&self) -> i64 {
        self.0.folder_id
    }
    /// Rule-breaking entries filed directly in this folder.
    async fn entries(&self) -> i64 {
        self.0.entries
    }
    /// Copies, summed over those entries.
    async fn copies(&self) -> i64 {
        self.0.copies
    }
}

/// Which entries break a folder rule of the folder they are filed in — a rule conflict. Folder
/// rules are advisory: they never refuse a card, they outline the ones that do not match. A rule
/// only breaks on a fact the app knows (an unpriced card passes a price rule).
pub struct RuleConflicts(pub CoreConflicts);

#[Object(rename_fields = "camelCase")]
impl RuleConflicts {
    async fn folders(&self) -> Vec<FolderConflicts<'_>> {
        self.0.folders.iter().map(FolderConflicts).collect()
    }
    /// Every conflicting entry's id.
    async fn ids(&self) -> &[i64] {
        &self.0.ids
    }
}

/// What one collection folder holds **directly** — not counting the folders inside it. A folder
/// holding nothing directly has none.
pub struct CollectionFolderSummary(pub Arc<CoreFolderSummary>);

#[Object(rename_fields = "camelCase")]
impl CollectionFolderSummary {
    async fn folder_id(&self) -> i64 {
        self.0.folder_id
    }
    /// Copies filed directly in this folder.
    async fn cards(&self) -> i64 {
        self.0.cards
    }
    /// What those copies are worth at the marketplace, in its currency, as a decimal. Null when it
    /// prices none of them.
    async fn value(&self) -> Option<f64> {
        self.0.value
    }
}

/// One folder of the collection's filing tree. Flat: build the tree from `parentId`. A card filed
/// in no folder is at the root, which is not a folder.
///
/// Behind an `Arc` because the batch that answers an entry's `folder` hands one folder to every
/// entry filed in it.
pub struct CollectionFolder(pub Arc<CoreFolder>);

#[Object(rename_fields = "camelCase")]
impl CollectionFolder {
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
    /// Whose folder it is: `user` (one the reader made), `deck` (the app's folder holding the
    /// copies a deck uses — see `deckId`) or `removed` (Recently removed: copies that left the
    /// collection but not the database).
    async fn kind(&self) -> &str {
        &self.0.kind
    }
    /// The deck a `deck` folder stands for. Null for every other kind.
    async fn deck_id(&self) -> Option<i64> {
        self.0.deck_id
    }
    /// Its position among its siblings, ascending.
    async fn sort_order(&self) -> i64 {
        self.0.sort_order
    }
    /// Whether the reader set this folder aside (cards held for a trade, a display case), so the
    /// app stops offering its cards to decks. The folder's own flag: a folder inside a locked
    /// folder is locked too, which this does not repeat.
    async fn locked(&self) -> bool {
        self.0.locked
    }
    /// The folder's own folder rules (inherited ones are not repeated) — criteria a card filed
    /// here is expected to meet, as stored: a list of `{ kind, … }` objects (`price`/`manaValue`
    /// with `min`/`max`, `colors`/`types`/`sets`/`rarities`/`finishes`/`conditions`/`borders`
    /// with `values`, `released` with `from`/`to`, and `group` with `op` (`and`/`or`) and nested
    /// `rules`). `[]` for none.
    async fn rules(&self) -> Json<&[grimoire_core::folder_rules::FolderRule]> {
        Json(&self.0.rules)
    }
    /// What this folder holds directly, not counting its sub-folders. Null when it holds nothing
    /// directly. Batched: one read per marketplace, whatever the number of folders.
    async fn summary(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "The marketplace prices are quoted at. Defaults to the reader's.")]
        marketplace: Option<Marketplace>,
    ) -> Result<Option<CollectionFolderSummary>> {
        let loader = ctx.data_unchecked::<DataLoader<CollectionFolderSummaries>>();
        let key = FolderKey {
            marketplace: marketplace_of(ctx, marketplace),
            folder_id: self.0.id,
        };
        Ok(loader.load_one(key).await?.map(CollectionFolderSummary))
    }
}

/// The collection folder `folder_id` names, through the execution's batch — `None` at the root
/// or for a folder gone between the two reads. `crate::wishlist` reaches it for a wish's owned
/// places.
pub(crate) async fn collection_folder(
    ctx: &Context<'_>,
    folder_id: Option<i64>,
) -> Result<Option<CollectionFolder>> {
    let Some(id) = folder_id else {
        return Ok(None);
    };
    let loader = ctx.data_unchecked::<DataLoader<CollectionFolders>>();
    Ok(loader.load_one(id).await?.map(CollectionFolder))
}

/// One entry of the collection: a stack of identical copies — one printing, finish, condition and
/// folder — and what the card database still knows about that printing. Card fields are null when
/// the printing has left the card database; the copies are still the reader's.
pub struct CollectionEntry<'a>(pub &'a CollectionRow);

#[Object(rename_fields = "camelCase")]
impl CollectionEntry<'_> {
    async fn id(&self) -> i64 {
        self.0.id
    }
    /// The printing's Scryfall id.
    async fn card_id(&self) -> &str {
        &self.0.card_id
    }
    /// The card's Scryfall oracle id. Null only when the printing has left the card database.
    async fn oracle_id(&self) -> Option<&str> {
        self.0.oracle_id.as_deref()
    }
    async fn name(&self) -> Option<&str> {
        self.0.name.as_deref()
    }
    /// The folder these copies are filed in, or null at the root of the collection.
    async fn folder_id(&self) -> Option<i64> {
        self.0.folder_id
    }
    async fn folder_name(&self) -> Option<&str> {
        self.0.folder_name.as_deref()
    }
    /// The folder these copies are filed in, or null at the root. Batched: one read of the folder
    /// list however many entries ask.
    async fn folder(&self, ctx: &Context<'_>) -> Result<Option<CollectionFolder>> {
        collection_folder(ctx, self.0.folder_id).await
    }
    /// As recorded on the entry, lowercase.
    async fn set_code(&self) -> &str {
        &self.0.set_code
    }
    async fn set_name(&self) -> Option<&str> {
        self.0.set_name.as_deref()
    }
    async fn collector_number(&self) -> &str {
        &self.0.collector_number
    }
    /// The printing's language code, e.g. `en`.
    async fn lang(&self) -> &str {
        &self.0.lang
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
    async fn finish(&self) -> Result<Finish> {
        Finish::from_id(&self.0.finish)
            .ok_or_else(|| format!("unknown finish `{}`", self.0.finish).into())
    }
    async fn condition(&self) -> Result<Condition> {
        Condition::from_id(&self.0.condition)
            .ok_or_else(|| format!("unknown condition `{}`", self.0.condition).into())
    }
    /// Copies in this stack.
    async fn quantity(&self) -> i64 {
        self.0.quantity
    }
    /// How many of those copies the reader has marked for trade.
    async fn tradelist_quantity(&self) -> i64 {
        self.0.tradelist_quantity
    }
    /// One copy's price at this finish, at the marketplace, in its currency, as a decimal. Null
    /// when that marketplace has no price for it — never another marketplace's figure.
    async fn unit_price(&self) -> Option<f64> {
        self.0.unit_price
    }
    /// What the reader paid per copy, as recorded, in `purchaseCurrency`.
    async fn purchase_price(&self) -> Option<f64> {
        self.0.purchase_price
    }
    async fn purchase_currency(&self) -> Option<&str> {
        self.0.purchase_currency.as_deref()
    }
    /// When the reader got these copies, as recorded — usually an ISO 8601 date.
    async fn acquired_at(&self) -> Option<&str> {
        self.0.acquired_at.as_deref()
    }
    /// Where the reader got them, in their own words.
    async fn acquisition_source(&self) -> Option<&str> {
        self.0.acquisition_source.as_deref()
    }
    /// A serialised printing's number, e.g. `042/500`.
    async fn serial_number(&self) -> Option<&str> {
        self.0.serial_number.as_deref()
    }
    async fn altered(&self) -> bool {
        self.0.altered
    }
    async fn signed(&self) -> bool {
        self.0.signed
    }
    async fn proxy(&self) -> bool {
        self.0.proxy
    }
    async fn misprint(&self) -> bool {
        self.0.misprint
    }
    /// A graded slab's details as stored — `{ company, grade, cert }` — or null.
    async fn grading(&self) -> Option<Json<serde_json::Value>> {
        json_column(self.0.grading.as_deref())
    }
    /// The reader's entry tags on this stack — free text, shared by every copy in it. Not
    /// Scryfall tags, deck labels or deck tags.
    async fn entry_tags(&self) -> Vec<String> {
        grimoire_core::deck::read_tags(&self.0.tags)
    }
    /// The reader's entry note on this stack — free text.
    async fn entry_note(&self) -> Option<&str> {
        self.0.notes.as_deref()
    }
    /// A sentence saying why this entry needs the reader's attention (its printing vanished from
    /// Scryfall, or a merge landed it), or null.
    async fn needs_review(&self) -> Option<&str> {
        self.0.needs_review.as_deref()
    }
    /// When the entry was last written, in Unix seconds.
    async fn updated_at(&self) -> f64 {
        self.0.updated_at as f64
    }
}

/// A stored JSON document, or nothing for a blank or unreadable column — a widget gets nothing
/// rather than an error for one row's stored document (the page's `parseJson`).
fn json_column(text: Option<&str>) -> Option<Json<serde_json::Value>> {
    match serde_json::from_str(text?) {
        Ok(serde_json::Value::Null) | Err(_) => None,
        Ok(value) => Some(Json(value)),
    }
}

/// One page of collection entries.
pub struct CollectionEntryPage(pub CorePage);

#[Object(rename_fields = "camelCase")]
impl CollectionEntryPage {
    async fn items(&self) -> Vec<CollectionEntry<'_>> {
        self.0.items.iter().map(CollectionEntry).collect()
    }
    /// Entries matching, across every page.
    async fn total(&self) -> i64 {
        self.0.total
    }
}

/// The collection's totals, over the same filters as the entries they caption.
pub struct CollectionSummary(pub Core);

#[Object(rename_fields = "camelCase")]
impl CollectionSummary {
    /// Copies, not entries.
    async fn total_cards(&self) -> i64 {
        self.0.total_cards
    }
    /// Distinct printings recorded.
    async fn unique_cards(&self) -> i64 {
        self.0.unique_cards
    }
    /// Entries (stacks).
    async fn entries(&self) -> i64 {
        self.0.entries
    }
    /// Copies marked for trade.
    async fn tradelist_cards(&self) -> i64 {
        self.0.tradelist_cards
    }
    /// What the copies are worth at the marketplace, in its currency, as a decimal — over the
    /// copies it prices. Read beside `unpriced`.
    async fn value(&self) -> f64 {
        self.0.value
    }
    /// Copies the marketplace has no price for, and so left out of `value`.
    async fn unpriced(&self) -> i64 {
        self.0.unpriced
    }
    /// Entries that need the reader's attention.
    async fn needs_review(&self) -> i64 {
        self.0.needs_review
    }
}

/// How many folder-list batches have run — the tests assert a whole page of entries is one.
#[cfg(test)]
pub(crate) static FOLDER_BATCHES: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// Where a batch runs: a thread of its own, driven to the end there — `crate::loaders`' reason
/// (nothing in the crate has a runtime to spawn on).
pub(crate) fn on_a_thread_of_its_own(batch: BoxFuture<'static, ()>) {
    std::thread::spawn(move || futures_executor::block_on(batch));
}

/// One folder's summary at one marketplace — the key a `summary(marketplace:)` edge asks for.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct FolderKey {
    pub marketplace: String,
    pub folder_id: i64,
}

/// The collection's folders a level of the answer asked about, read in one `list_folders`.
pub struct CollectionFolders(Arc<State>);

impl Loader<i64> for CollectionFolders {
    type Value = Arc<CoreFolder>;
    type Error = Arc<String>;

    async fn load(&self, keys: &[i64]) -> Result<HashMap<i64, Self::Value>, Self::Error> {
        #[cfg(test)]
        FOLDER_BATCHES.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let folders = list_folders(&self.0.lock_db_read()).map_err(Arc::new)?;
        Ok(folders
            .into_iter()
            .filter(|f| keys.contains(&f.id))
            .map(|f| (f.id, Arc::new(f)))
            .collect())
    }
}

/// Every collection folder's summary, read once per marketplace the level asked about:
/// `folder_summary` answers every folder in one statement, so the batch is the marketplaces.
pub struct CollectionFolderSummaries(Arc<State>);

impl Loader<FolderKey> for CollectionFolderSummaries {
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
            CollectionFolders(state.clone()),
            on_a_thread_of_its_own,
        ))
        .data(DataLoader::new(
            CollectionFolderSummaries(state.clone()),
            on_a_thread_of_its_own,
        ))
}

/// The scope arguments every filtered collection read takes, as the core's query.
#[allow(clippy::too_many_arguments)]
fn scope_of(
    ctx: &Context<'_>,
    filters: Option<CardFilterInput>,
    folder_id: Option<i64>,
    root_only: Option<bool>,
    exclude_locked: Option<bool>,
    needs_review: Option<bool>,
    rule_breaks: Option<bool>,
    marketplace: Option<Marketplace>,
) -> Result<Scope> {
    Ok(Scope {
        cards: core_filters(filters)?,
        folder_id,
        // `folderId` wins over `rootOnly` in the core as on the page.
        root_only: folder_id.is_none() && root_only.unwrap_or(false),
        exclude_locked: exclude_locked.unwrap_or(false),
        needs_review,
        rule_breaks: rule_breaks.unwrap_or(false),
        marketplace: Market::from_id(&marketplace_of(ctx, marketplace)),
        ..Scope::default()
    })
}

#[derive(Default)]
pub struct CollectionQuery;

#[Object(rename_fields = "camelCase")]
impl CollectionQuery {
    /// The collection's totals — copies, entries, value — over every entry, or over the ones the
    /// arguments narrow to. The arguments are `collectionEntries`' and mean what they mean there.
    // Its arguments carry no descriptions of their own so the field prints on one line, which
    // `tests.rs`' `every_root_field_carries_its_cache_roots` reads.
    #[graphql(directive = invalidatedBy::apply(roots(&["collection"])))]
    #[allow(clippy::too_many_arguments)]
    async fn collection_summary(
        &self,
        ctx: &Context<'_>,
        filters: Option<CardFilterInput>,
        folder_id: Option<i64>,
        root_only: Option<bool>,
        exclude_locked: Option<bool>,
        needs_review: Option<bool>,
        rule_breaks: Option<bool>,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<CollectionSummary>> {
        let scope = scope_of(
            ctx,
            filters,
            folder_id,
            root_only,
            exclude_locked,
            needs_review,
            rule_breaks,
            marketplace,
        )?;
        Ok(Some(CollectionSummary(read(ctx, |c| {
            summarise(c, &scope)
        })?)))
    }

    /// The collection's entries, one page at a time — every entry, or the ones the arguments
    /// narrow to. Name order unless `sort` says otherwise.
    #[graphql(directive = invalidatedBy::apply(roots(&["collection"])))]
    #[allow(clippy::too_many_arguments)]
    async fn collection_entries(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "Only the cards this search matches.")] filters: Option<CardFilterInput>,
        #[graphql(
            desc = "Only the copies filed directly in this folder — not in the folders inside it. Absent: every folder."
        )]
        folder_id: Option<i64>,
        #[graphql(desc = "Only the copies filed in no folder. Ignored when `folderId` is given.")]
        root_only: Option<bool>,
        #[graphql(
            desc = "Leave out the copies in locked (set-aside) folders and the folders inside them. Ignored when `folderId` is given."
        )]
        exclude_locked: Option<bool>,
        #[graphql(desc = "`true`: only entries needing review; `false`: only the others.")]
        needs_review: Option<bool>,
        #[graphql(desc = "`true`: only entries that break a folder rule of their folder.")]
        rule_breaks: Option<bool>,
        #[graphql(desc = "The marketplace prices are quoted at. Defaults to the reader's.")]
        marketplace: Option<Marketplace>,
        sort: Option<CollectionSortKey>,
        #[graphql(desc = "Reverse `sort`.")] descending: Option<bool>,
        #[graphql(desc = "Entries per page, 100 by default and at most 500.")] limit: Option<i64>,
        #[graphql(desc = "Entries to skip. Default 0.")] offset: Option<i64>,
    ) -> Result<Option<CollectionEntryPage>> {
        let mut scope = scope_of(
            ctx,
            filters,
            folder_id,
            root_only,
            exclude_locked,
            needs_review,
            rule_breaks,
            marketplace,
        )?;
        (scope.limit, scope.offset) = page_of(limit, offset);
        scope.sort = sort_of(sort.map(CollectionSortKey::id), descending);
        Ok(Some(CollectionEntryPage(read(ctx, |c| {
            list_entries(c, &scope)
        })?)))
    }

    /// Per-folder counts of the collection's entries — one row per folder holding something the
    /// arguments match.
    #[graphql(directive = invalidatedBy::apply(roots(&["collection"])))]
    #[allow(clippy::too_many_arguments)]
    async fn collection_shelf_counts(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "Only the cards this search matches.")] filters: Option<CardFilterInput>,
        #[graphql(
            desc = "Only the copies filed directly in this folder — not in the folders inside it. Absent: every folder."
        )]
        folder_id: Option<i64>,
        #[graphql(desc = "Only the copies filed in no folder. Ignored when `folderId` is given.")]
        root_only: Option<bool>,
        #[graphql(
            desc = "Leave out the copies in locked (set-aside) folders and the folders inside them. Ignored when `folderId` is given."
        )]
        exclude_locked: Option<bool>,
        #[graphql(desc = "`true`: only entries needing review; `false`: only the others.")]
        needs_review: Option<bool>,
        #[graphql(desc = "`true`: only entries that break a folder rule of their folder.")]
        rule_breaks: Option<bool>,
        #[graphql(desc = "The marketplace prices are quoted at. Defaults to the reader's.")]
        marketplace: Option<Marketplace>,
        #[graphql(
            desc = "Count only these folders (direct members of each), `0` for the root. Replaces `folderId`, `rootOnly` and `excludeLocked`."
        )]
        shelves: Option<Vec<i64>>,
    ) -> Result<Option<Vec<ShelfCount>>> {
        let mut scope = scope_of(
            ctx,
            filters,
            folder_id,
            root_only,
            exclude_locked,
            needs_review,
            rule_breaks,
            marketplace,
        )?;
        scope.shelves = shelves;
        let rows = read(ctx, |c| shelf_counts(c, &scope))?;
        Ok(Some(rows.into_iter().map(ShelfCount).collect()))
    }

    /// The whole collection sliced along one dimension — copies and value per bucket. Takes no
    /// filters.
    #[graphql(directive = invalidatedBy::apply(roots(&["collection"])))]
    async fn collection_breakdown(
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

    /// Every folder of the collection, flat — including the app's own (each deck's folder,
    /// Recently removed). Build the tree from `parentId`.
    #[graphql(directive = invalidatedBy::apply(roots(&["collection"])))]
    async fn collection_folders(&self, ctx: &Context<'_>) -> Result<Option<Vec<CollectionFolder>>> {
        Ok(Some(
            read(ctx, list_folders)?
                .into_iter()
                .map(|f| CollectionFolder(Arc::new(f)))
                .collect(),
        ))
    }

    /// What each collection folder holds directly (not counting its sub-folders), for every
    /// folder that holds something.
    #[graphql(directive = invalidatedBy::apply(roots(&["collection"])))]
    async fn collection_folder_summaries(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "The marketplace prices are quoted at. Defaults to the reader's.")]
        marketplace: Option<Marketplace>,
    ) -> Result<Option<Vec<CollectionFolderSummary>>> {
        let marketplace = Market::from_id(&marketplace_of(ctx, marketplace));
        let rows = read(ctx, |c| folder_summary(c, marketplace))?;
        Ok(Some(
            rows.into_iter()
                .map(|r| CollectionFolderSummary(Arc::new(r)))
                .collect(),
        ))
    }

    /// Which collection entries break a folder rule of the folder they are filed in, and how many
    /// per folder. A price rule is checked at the marketplace.
    #[graphql(directive = invalidatedBy::apply(roots(&["collection"])))]
    async fn collection_rule_conflicts(
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
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    use grimoire_core::collection::{add_entry, EntryInput};
    use grimoire_core::collection_folders::{create_folder, set_folder_rules};
    use grimoire_core::entry_tags::set_collection_tags;
    use grimoire_core::folder_rules::FolderRule;
    use grimoire_core::schema::fixtures::seed_card;
    use grimoire_core::state::{fixtures::on_files, State};
    use serde_json::{json, Value};

    use super::{json_column, page_of, FOLDER_BATCHES};
    use crate::Graph;

    fn answer(state: &Arc<State>, query: &str) -> Value {
        let response = Graph::new().run(state, query, None, None, None);
        assert!(response.errors.is_empty(), "{:?}", response.errors);
        response.data.into_json().unwrap()
    }

    /// Two printings: two copies of one at the root, graded and tagged, and three of the other in
    /// a folder whose set rule they break.
    fn stocked(name: &str) -> (Arc<State>, i64) {
        let state = on_files(name, "http://127.0.0.1:1").0;
        let binder = {
            let conn = state.lock_db();
            seed_card(&conn, "bolt-a", "lea", "1");
            seed_card(&conn, "bolt-b", "m10", "2");
            let binder = create_folder(&conn, None, "Binder").unwrap().id;
            set_folder_rules(
                &conn,
                binder,
                vec![FolderRule::Sets {
                    values: vec!["lea".into()],
                }],
            )
            .unwrap();
            let root = add_entry(
                &conn,
                &EntryInput {
                    card_id: "bolt-a".into(),
                    finish: "nonfoil".into(),
                    quantity: 2,
                    grading: Some(r#"{"company":"PSA","grade":"9"}"#.into()),
                    notes: Some("From the prerelease.".into()),
                    ..EntryInput::default()
                },
            )
            .unwrap();
            set_collection_tags(&conn, root.id, &["Cube".into(), "Trade bait".into()]).unwrap();
            add_entry(
                &conn,
                &EntryInput {
                    card_id: "bolt-b".into(),
                    finish: "foil".into(),
                    quantity: 3,
                    folder_id: Some(binder),
                    ..EntryInput::default()
                },
            )
            .unwrap();
            binder
        };
        (state, binder)
    }

    /// Every root field of the domain answers, nested edges included.
    #[test]
    fn every_collection_root_answers() {
        let (state, binder) = stocked("graph-collection-roots");
        let data = answer(
            &state,
            "{
              collectionSummary { totalCards entries uniqueCards tradelistCards value unpriced needsReview }
              collectionEntries(sort: quantity, descending: true) {
                total
                items {
                  id cardId oracleId name folderId folderName setCode setName collectorNumber lang
                  rarity manaCost typeLine layout finish condition quantity tradelistQuantity
                  unitPrice purchasePrice purchaseCurrency acquiredAt acquisitionSource serialNumber
                  altered signed proxy misprint grading entryTags entryNote needsReview updatedAt
                  folder { id name kind summary { folderId cards value } }
                }
              }
              collectionShelfCounts { folderId tiles copies value unpriced peek }
              collectionBreakdown(dimension: set, marketplace: cardmarket) { key name cards value }
              collectionFolders { id parentId name kind deckId sortOrder locked rules summary { cards } }
              collectionFolderSummaries { folderId cards value }
              collectionRuleConflicts { folders { folderId entries copies } ids }
            }",
        );
        assert_eq!(data["collectionSummary"]["totalCards"], json!(5));
        assert_eq!(data["collectionSummary"]["entries"], json!(2));

        let items = data["collectionEntries"]["items"].as_array().unwrap();
        assert_eq!(data["collectionEntries"]["total"], json!(2));
        // Three copies before two: the sort and its direction reached the core.
        let (filed, root) = (&items[0], &items[1]);
        assert_eq!(filed["quantity"], json!(3));
        assert_eq!(filed["finish"], json!("foil"));
        assert_eq!(filed["folder"]["id"], json!(binder));
        assert_eq!(filed["folder"]["name"], json!("Binder"));
        assert_eq!(filed["folder"]["summary"]["cards"], json!(3));
        assert_eq!(filed["entryTags"], json!([]));
        assert_eq!(filed["grading"], Value::Null);
        // The stored JSON columns, parsed: the grading document and the entry tags.
        assert_eq!(root["folder"], Value::Null);
        assert_eq!(root["grading"], json!({ "company": "PSA", "grade": "9" }));
        assert_eq!(root["entryTags"], json!(["Cube", "Trade bait"]));
        assert_eq!(root["entryNote"], json!("From the prerelease."));
        assert!(root["updatedAt"].is_f64());

        assert!(!data["collectionShelfCounts"].as_array().unwrap().is_empty());
        let sets: Vec<&str> = data["collectionBreakdown"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["key"].as_str().unwrap())
            .collect();
        assert!(sets.contains(&"lea") && sets.contains(&"m10"), "{sets:?}");
        let folder = data["collectionFolders"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["id"] == json!(binder))
            .unwrap();
        assert_eq!(
            folder["rules"],
            json!([{ "kind": "sets", "values": ["lea"] }])
        );
        assert!(data["collectionFolderSummaries"].is_array());
        assert_eq!(
            data["collectionRuleConflicts"]["folders"],
            json!([{ "folderId": binder, "entries": 1, "copies": 3 }])
        );
    }

    /// The scope arguments narrow: a folder, the root alone, a shelf and a structured card search.
    #[test]
    fn the_scope_arguments_narrow_the_collection() {
        let (state, binder) = stocked("graph-collection-scope");
        let data = answer(
            &state,
            &format!(
                "{{
                  folder: collectionSummary(folderId: {binder}) {{ totalCards }}
                  root: collectionSummary(rootOnly: true) {{ totalCards }}
                  searched: collectionEntries(filters: {{ setCode: \"m10\" }}) {{ total items {{ cardId }} }}
                  shelves: collectionShelfCounts(shelves: [0]) {{ folderId copies }}
                }}"
            ),
        );
        assert_eq!(data["folder"]["totalCards"], json!(3));
        assert_eq!(data["root"]["totalCards"], json!(2));
        assert_eq!(
            data["searched"],
            json!({ "total": 1, "items": [{ "cardId": "bolt-b" }] })
        );
        assert_eq!(data["shelves"], json!([{ "folderId": 0, "copies": 2 }]));
    }

    /// An entry's `folder` is a batch: one read of the folder list for a whole page of entries.
    #[test]
    fn a_page_of_entries_costs_one_folder_read() {
        let (state, binder) = stocked("graph-collection-batch");
        {
            let conn = state.lock_db();
            for n in 0..6 {
                let id = format!("bolt-{n}");
                seed_card(&conn, &id, "m11", &n.to_string());
                let entry = EntryInput {
                    card_id: id,
                    finish: "nonfoil".into(),
                    quantity: 1,
                    folder_id: Some(binder),
                    ..EntryInput::default()
                };
                add_entry(&conn, &entry).unwrap();
            }
        }
        // The counter is shared with any test running beside this one: run twice and take the
        // smaller difference, as `tests.rs` does for deck notes.
        let runs: Vec<usize> = (0..2)
            .map(|_| {
                let before = FOLDER_BATCHES.load(Ordering::SeqCst);
                answer(
                    &state,
                    "{ collectionEntries { items { folder { name } } } }",
                );
                FOLDER_BATCHES.load(Ordering::SeqCst) - before
            })
            .collect();
        assert_eq!(runs.into_iter().min(), Some(1));
    }

    #[test]
    fn a_page_is_clamped_to_the_core_s_bounds() {
        assert_eq!(page_of(None, None), (100, 0));
        assert_eq!(page_of(Some(0), Some(-4)), (1, 0));
        assert_eq!(page_of(Some(9_000), Some(20)), (500, 20));
    }

    /// The page's `parseJson`: a blank, unreadable or `null` column is nothing, not an error.
    #[test]
    fn a_json_column_reads_leniently() {
        assert!(json_column(None).is_none());
        assert!(json_column(Some("")).is_none());
        assert!(json_column(Some("{not json")).is_none());
        assert!(json_column(Some("null")).is_none());
        assert_eq!(
            json_column(Some(r#"{"grade":"10"}"#)).unwrap().0,
            json!({ "grade": "10" })
        );
    }
}
