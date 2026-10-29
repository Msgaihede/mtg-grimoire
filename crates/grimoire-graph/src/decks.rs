//! The decks and what hangs off them — the page's `schema/decks.ts`: their values and colour
//! bars, the cards in one, its categories, the deck labels its cards wear, the folders decks are
//! filed in, deck notes and deck to-do lists, a deck's history, the formats a deck is checked
//! against, and the home page's activity feed.
//!
//! **The words are the app's, and they are not interchangeable.** A *deck label* is the coloured
//! mark on one card inside a deck; a *deck tag* is free text describing a whole deck; neither is a
//! Scryfall tag. A *deck note* is prose about one deck that can name cards; a *card note* is the
//! same rows read from a card's side; a *deck to-do list* is not a note at all.
//!
//! **An edge on a deck never reads once per deck.** The gallery-wide reads (`list_decks`,
//! `pip_costs`, `list_folders`, `list_format_specs`) answer every row at once, so each is read at
//! most once per execution ([`Lists`], the page's `ctx.once`) and every edge picks its row out of
//! that answer. The per-deck reads (notes, to-do lists, labels, categories, history) go through a
//! batch ([`PerDeck`], and [`crate::loaders`] for notes and values): a list of forty decks asking
//! for all of them is one read per edge, not two hundred.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex, PoisonError};

use async_graphql::dataloader::{DataLoader, Loader};
use async_graphql::futures_util::future::BoxFuture;
use async_graphql::{Context, Enum, EnumType, Json, Object, Result};
use grimoire_core::activity::{recent, ActivityEntry as CoreActivityEntry};
use grimoire_core::deck::{
    get_deck, list_decks, list_format_specs, pip_costs, DeckCardRow, DeckDetail as CoreDeckDetail,
    DeckPipCosts as CorePipCosts, DeckRow, DeckValue as CoreDeckValue, FormatSpecRow,
    PipCost as CorePipCost,
};
use grimoire_core::deck_audit::{
    list as audit_list, list_of_decks as audit_of_decks, DeckAuditEntry,
};
use grimoire_core::deck_meta::{
    categories_of_decks, labels_of_decks, list_all_labels, list_categories, list_folders,
    list_labels, DeckCategoryRow, DeckFolderRow, DeckLabelRow, GlobalLabel,
};
use grimoire_core::deck_notes::{
    list_notes, notes_for_card, CardNoteRow, DeckNoteCard as CoreNoteCard, DeckNoteRow,
};
use grimoire_core::deck_todos::{
    every_list, lists_for, lists_of_decks, DeckTodoList as CoreTodoList,
    DeckTodoListEntry as CoreTodoListEntry,
};
use grimoire_core::sorting::Marketplace as Market;
use grimoire_core::state::State;
use rusqlite::Connection;
use serde_json::Value;

use crate::enums::{DeckVariant, Finish};
use crate::loaders::{DeckNotes, DeckValues, ValueKey};
use crate::{invalidatedBy, marketplace_of, read, roots, Marketplace};

// ---------------------------------------------------------------------------------------------
// Shared reads: one per execution.
// ---------------------------------------------------------------------------------------------

/// A gallery-wide read's answer, read at most once per execution and shared by every field that
/// reaches it. A refused read is not kept, so the next field asks again and is refused in its
/// own words.
struct Once<T>(Mutex<Option<Arc<Vec<Arc<T>>>>>);

impl<T> Default for Once<T> {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

impl<T> Once<T> {
    fn get(
        &self,
        ctx: &Context<'_>,
        read_all: impl FnOnce(&Connection) -> Result<Vec<T>, String>,
    ) -> Result<Arc<Vec<Arc<T>>>> {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(rows) = &*slot {
            return Ok(rows.clone());
        }
        let rows: Arc<Vec<Arc<T>>> =
            Arc::new(read(ctx, read_all)?.into_iter().map(Arc::new).collect());
        *slot = Some(rows.clone());
        Ok(rows)
    }
}

/// The gallery-wide reads of one execution.
#[derive(Default)]
struct Lists {
    decks: Once<DeckRow>,
    folders: Once<DeckFolderRow>,
    formats: Once<FormatSpecRow>,
    pip_costs: Once<CorePipCosts>,
}

fn lists<'a>(ctx: &'a Context<'_>) -> &'a Lists {
    ctx.data_unchecked::<Lists>()
}

fn all_decks(ctx: &Context<'_>) -> Result<Arc<Vec<Arc<DeckRow>>>> {
    lists(ctx).decks.get(ctx, list_decks)
}

fn all_folders(ctx: &Context<'_>) -> Result<Arc<Vec<Arc<DeckFolderRow>>>> {
    lists(ctx).folders.get(ctx, list_folders)
}

fn all_formats(ctx: &Context<'_>) -> Result<Arc<Vec<Arc<FormatSpecRow>>>> {
    lists(ctx).formats.get(ctx, list_format_specs)
}

fn all_pip_costs(ctx: &Context<'_>) -> Result<Arc<Vec<Arc<CorePipCosts>>>> {
    lists(ctx).pip_costs.get(ctx, pip_costs)
}

/// The deck a back-edge names, out of the execution's one deck list.
fn deck_by_id(ctx: &Context<'_>, id: Option<i64>) -> Result<Option<Deck>> {
    let Some(id) = id else { return Ok(None) };
    Ok(all_decks(ctx)?
        .iter()
        .find(|d| d.id == id)
        .map(|d| Deck(d.clone())))
}

// ---------------------------------------------------------------------------------------------
// Per-deck batches.
// ---------------------------------------------------------------------------------------------

/// How many per-deck batches have run — the tests assert a whole list is one per edge.
#[cfg(test)]
static PER_DECK_BATCHES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// A core read that answers many decks at once, given the rest of the edge's arguments.
type BatchRead<A, V> = fn(&Connection, &[i64], &A) -> Result<HashMap<i64, Vec<V>>, String>;

/// One per-deck edge, batched: the keys a level of the answer asked for are grouped by the rest
/// of their arguments (a list, a marketplace, a limit), and each group is one read.
struct PerDeck<A, V> {
    state: Arc<State>,
    read: BatchRead<A, V>,
}

impl<A, V> Loader<(A, i64)> for PerDeck<A, V>
where
    A: Clone + Eq + Hash + Send + Sync + 'static,
    V: Send + Sync + 'static,
{
    type Value = Vec<Arc<V>>;
    type Error = Arc<String>;

    async fn load(&self, keys: &[(A, i64)]) -> Result<HashMap<(A, i64), Self::Value>, Self::Error> {
        #[cfg(test)]
        PER_DECK_BATCHES.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut groups: HashMap<&A, Vec<i64>> = HashMap::new();
        for (args, deck_id) in keys {
            groups.entry(args).or_default().push(*deck_id);
        }
        let conn = self.state.lock_db_read();
        let mut out = HashMap::new();
        for (args, ids) in groups {
            let mut found = (self.read)(&conn, &ids, args).map_err(Arc::new)?;
            for id in ids {
                let rows = found.remove(&id).unwrap_or_default();
                out.insert((args.clone(), id), rows.into_iter().map(Arc::new).collect());
            }
        }
        Ok(out)
    }
}

/// `crate::loaders`' spawner, for the same reason: nothing here has a runtime to spawn on, so a
/// batch gets a thread of its own and is driven to the end there.
fn on_a_thread_of_its_own(batch: BoxFuture<'static, ()>) {
    std::thread::spawn(move || futures_executor::block_on(batch));
}

fn per_deck<A, V>(state: &Arc<State>, read: BatchRead<A, V>) -> DataLoader<PerDeck<A, V>>
where
    A: Clone + Eq + Hash + Send + Sync + 'static,
    V: Send + Sync + 'static,
{
    DataLoader::new(
        PerDeck {
            state: state.clone(),
            read,
        },
        on_a_thread_of_its_own,
    )
}

type TodoLists = PerDeck<(), CoreTodoList>;
/// Keyed by the list (`live` / `theory`).
type Labels = PerDeck<String, DeckLabelRow>;
/// Keyed by the list and the marketplace's id.
type Categories = PerDeck<(String, String), DeckCategoryRow>;
/// Keyed by the limit.
type History = PerDeck<i64, DeckAuditEntry>;

fn todo_lists_of(
    conn: &Connection,
    ids: &[i64],
    _: &(),
) -> Result<HashMap<i64, Vec<CoreTodoList>>, String> {
    lists_of_decks(conn, ids)
}

// `&String`, not `&str`: the shape is `BatchRead`'s, whose key is the owned word.
#[allow(clippy::ptr_arg)]
fn labels_of(
    conn: &Connection,
    ids: &[i64],
    variant: &String,
) -> Result<HashMap<i64, Vec<DeckLabelRow>>, String> {
    labels_of_decks(conn, ids, variant)
}

fn categories_of(
    conn: &Connection,
    ids: &[i64],
    (variant, marketplace): &(String, String),
) -> Result<HashMap<i64, Vec<DeckCategoryRow>>, String> {
    categories_of_decks(conn, ids, variant, Market::from_id(marketplace))
}

fn history_of(
    conn: &Connection,
    ids: &[i64],
    limit: &i64,
) -> Result<HashMap<i64, Vec<DeckAuditEntry>>, String> {
    audit_of_decks(conn, ids, *limit)
}

/// This domain's batch loaders and shared reads, for one execution.
pub(crate) fn data(request: async_graphql::Request, state: &Arc<State>) -> async_graphql::Request {
    request
        .data(crate::loaders::deck_notes(state))
        .data(crate::loaders::deck_values(state))
        .data(Lists::default())
        .data(per_deck(state, todo_lists_of as BatchRead<_, _>))
        .data(per_deck(state, labels_of as BatchRead<_, _>))
        .data(per_deck(state, categories_of as BatchRead<_, _>))
        .data(per_deck(state, history_of as BatchRead<_, _>))
}

// ---------------------------------------------------------------------------------------------
// Stored text read back, and the core's words as enums.
// ---------------------------------------------------------------------------------------------

/// JSON text the core hands over unread, parsed for the reader; the text itself if it does not
/// parse, so a malformed cell is still visible rather than an error — the page's `parseJsonText`.
fn parse_json_text(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_owned()))
}

/// A JSON-text array of strings (`finishes`, `promo_types`), its non-string members dropped;
/// `None` when it is not an array — the page's `parseStringArray`.
fn parse_string_array(text: Option<&str>) -> Option<Vec<String>> {
    match parse_json_text(text?) {
        Value::Array(items) => Some(
            items
                .into_iter()
                .filter_map(|v| match v {
                    Value::String(s) => Some(s),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    }
}

/// The core's stored word read back as one of an enum's values; an error naming both for a word
/// this build does not know — a wrong answer is worse than a refused field.
fn word<T: EnumType>(id: &str) -> Result<T> {
    T::items()
        .iter()
        .find(|item| item.name == id)
        .map(|item| item.value)
        .ok_or_else(|| {
            format!(
                "Enum \"{}\" cannot represent value: \"{id}\"",
                std::any::type_name::<T>().rsplit("::").next().unwrap_or("")
            )
            .into()
        })
}

/// What a deck category is for, which is what the rules read (its name is the reader's and can
/// be anything). `main` is every pile the reader makes; `side` is the Sideboard, `commander` the
/// Commander zone, `companion` the Companion zone, `maybe` the Maybeboard. A deck's size counts
/// active `main`, `commander` and `maybe` piles; `side` and `companion` are played beside the
/// deck.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "lowercase")]
pub enum CategoryKind {
    Main,
    Side,
    Commander,
    Companion,
    Maybe,
}

/// Who made a deck category: `user` (the reader, including the four predefined piles), or `auto`
/// (the app, while filing a card — such a pile is drawn only while it holds a card).
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "lowercase")]
pub enum CategoryOrigin {
    User,
    Auto,
}

/// Where Magic is played, in Scryfall's words: `paper`, `arena` (MTG Arena) or `mtgo` (Magic
/// Online).
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "lowercase")]
pub enum Game {
    Paper,
    Arena,
    Mtgo,
}

/// The platform a deck is built for: one of the `Game` values, or `any` for a deck not pinned to
/// one (the default).
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "lowercase")]
pub enum DeckGame {
    Paper,
    Arena,
    Mtgo,
    Any,
}

/// What a deck's managed wishlist folder holds, kept up to date by the app: `off` (no folder),
/// `all` (every card the deck's theory list plans), `missing` (the planned cards the live list
/// lacks) or `other` (planned cards held in a different printing). Only a deck with a theory list
/// beside its live one uses it.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "lowercase")]
pub enum ManagedWishlistMode {
    Off,
    All,
    Missing,
    Other,
}

/// How a deck keeps the tokens and emblems its cards make: `managed` and `collection` draw a
/// Tokens & Emblems pile in the deck editor, `hidden` leaves it out. The pile never counts toward
/// the deck's size or legality.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "lowercase")]
pub enum TokenMode {
    Managed,
    Collection,
    Hidden,
}

/// Which rule a format judges its commander by. A rule name, not a format name: two formats may
/// share one (`predh` uses `edh`).
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "lowercase")]
pub enum CommanderRule {
    Edh,
    Brawl,
    Oathbreaker,
    Pdh,
    Duel,
    Tlr,
}

/// What a card Scryfall marks `restricted` means in a format: `max_one` (one copy at most, as in
/// Vintage) or `banned_as_commander` (in the singleton formats that use the word).
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "snake_case")]
pub enum RestrictedMeaning {
    MaxOne,
    BannedAsCommander,
}

// ---------------------------------------------------------------------------------------------
// Object types.
// ---------------------------------------------------------------------------------------------

/// One deck, as the deck gallery lists it.
pub struct Deck(pub Arc<DeckRow>);

/// One deck, as the deck gallery lists it. Every deck has a live list (the cards as built); a
/// deck with `theoryEnabled` also has a theory list (the version being planned).
#[Object(rename_fields = "camelCase")]
impl Deck {
    async fn id(&self) -> i64 {
        self.0.id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// The format's id (`commander`, `modern`, `casual`, …).
    async fn format_key(&self) -> &str {
        &self.0.format_key
    }
    /// The format's display name; absent for a format this app no longer knows.
    async fn format_name(&self) -> Option<&str> {
        self.0.format_name.as_deref()
    }
    async fn game_key(&self) -> Result<DeckGame> {
        word(&self.0.game_key)
    }
    async fn description(&self) -> Option<&str> {
        self.0.description.as_deref()
    }
    /// The printing whose art crop is the deck's cover.
    async fn cover_card_id(&self) -> Option<&str> {
        self.0.cover_card_id.as_deref()
    }
    /// The cover's illustrator. Credit them wherever the cover is shown; when absent, do not
    /// draw the cover.
    async fn cover_artist(&self) -> Option<&str> {
        self.0.cover_artist.as_deref()
    }
    async fn archived(&self) -> bool {
        self.0.archived
    }
    /// Copies in the live list's active `main`, `commander` and `maybe` categories — what “a
    /// 60-card deck” means.
    async fn card_count(&self) -> i64 {
        self.0.card_count
    }
    /// Unix seconds of the last change to the deck or its cards.
    async fn updated_at(&self) -> f64 {
        self.0.updated_at as f64
    }
    /// The deck folder it is filed in; absent at the root.
    async fn folder_id(&self) -> Option<i64> {
        self.0.folder_id
    }
    /// Whether the deck keeps a theory list (a plan) beside its live one.
    async fn theory_enabled(&self) -> bool {
        self.0.theory_enabled
    }
    /// Whether the deck is tracked without owning the cards (an Arena or MTGO list, a proxy
    /// pile). Such a deck reads nothing from the collection.
    async fn virtual_only(&self) -> bool {
        self.0.virtual_only
    }
    /// The list the deck editor was last showing.
    async fn last_variant(&self) -> Result<DeckVariant> {
        word(&self.0.last_variant)
    }
    async fn managed_wishlist(&self) -> Result<ManagedWishlistMode> {
        word(&self.0.managed_wishlist)
    }
    async fn token_mode(&self) -> Result<TokenMode> {
        word(&self.0.token_mode)
    }
    /// The Commander bracket (1–5) the reader declared for the deck, or 0 when they have not
    /// (the app then estimates one).
    async fn bracket(&self) -> i64 {
        self.0.bracket
    }
    /// Deck tags: the reader's free-text words for the whole deck (`Budget`, `Meme`), in the
    /// order added. Not deck labels and not Scryfall tags.
    async fn tags(&self) -> &[String] {
        &self.0.tags
    }
    /// Whether the deck editor's Notes band is expanded.
    async fn notes_open(&self) -> bool {
        self.0.notes_open
    }
    /// Whether the deck editor's To-do band is expanded.
    async fn todos_open(&self) -> bool {
        self.0.todos_open
    }

    /// What the deck's live cards are worth at a marketplace.
    /// `marketplace` is the one to price at; the reader's own when omitted.
    async fn value(
        &self,
        ctx: &Context<'_>,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<DeckValue>> {
        let loader = ctx.data_unchecked::<DataLoader<DeckValues>>();
        let key = ValueKey {
            marketplace: marketplace_of(ctx, marketplace),
            deck_id: self.0.id,
        };
        Ok(loader.load_one(key).await?.map(DeckValue))
    }

    /// The live list's printed mana costs, for a colour bar. Empty for a deck of lands or no
    /// cards.
    async fn pip_costs(&self, ctx: &Context<'_>) -> Result<Vec<PipCost>> {
        Ok(all_pip_costs(ctx)?
            .iter()
            .find(|p| p.deck_id == self.0.id)
            .map(|p| p.costs.iter().cloned().map(PipCost).collect())
            .unwrap_or_default())
    }

    /// The deck folder it is filed in; absent at the root.
    async fn folder(&self, ctx: &Context<'_>) -> Result<Option<DeckFolder>> {
        let Some(id) = self.0.folder_id else {
            return Ok(None);
        };
        Ok(all_folders(ctx)?
            .iter()
            .find(|f| f.id == id)
            .map(|f| DeckFolder(f.clone())))
    }

    /// The deck's format and its rules; absent for a format this app no longer knows.
    async fn format(&self, ctx: &Context<'_>) -> Result<Option<Format>> {
        Ok(all_formats(ctx)?
            .iter()
            .find(|f| f.key == self.0.format_key)
            .map(|f| Format(f.clone())))
    }

    /// The deck's notes, in the reader's order.
    async fn notes(&self, ctx: &Context<'_>) -> Result<Vec<DeckNote>> {
        let loader = ctx.data_unchecked::<DataLoader<DeckNotes>>();
        let notes = loader.load_one(self.0.id).await?.unwrap_or_default();
        Ok(notes.into_iter().map(DeckNote).collect())
    }

    /// The deck's to-do lists, in the reader's order — empty ones included.
    async fn todo_lists(&self, ctx: &Context<'_>) -> Result<Vec<DeckTodoList>> {
        let loader = ctx.data_unchecked::<DataLoader<TodoLists>>();
        let lists = loader.load_one(((), self.0.id)).await?.unwrap_or_default();
        Ok(lists.into_iter().map(DeckTodoList).collect())
    }

    /// The deck labels this deck's cards wear in one list, most-used first.
    async fn labels(
        &self,
        ctx: &Context<'_>,
        #[graphql(default_with = "Some(DeckVariant::Live)")] variant: Option<DeckVariant>,
    ) -> Result<Vec<DeckLabelUsage>> {
        let variant = variant.unwrap_or_default().id().to_owned();
        let loader = ctx.data_unchecked::<DataLoader<Labels>>();
        let labels = loader
            .load_one((variant, self.0.id))
            .await?
            .unwrap_or_default();
        Ok(labels.into_iter().map(DeckLabelUsage).collect())
    }

    /// The categories of one of the deck's lists, in order, empty ones included.
    /// `marketplace` is the one to price at; the reader's own when omitted.
    async fn categories(
        &self,
        ctx: &Context<'_>,
        #[graphql(default_with = "Some(DeckVariant::Live)")] variant: Option<DeckVariant>,
        marketplace: Option<Marketplace>,
    ) -> Result<Vec<DeckCategory>> {
        let key = (
            (
                variant.unwrap_or_default().id().to_owned(),
                marketplace_of(ctx, marketplace),
            ),
            self.0.id,
        );
        let loader = ctx.data_unchecked::<DataLoader<Categories>>();
        let piles = loader.load_one(key).await?.unwrap_or_default();
        Ok(piles.into_iter().map(DeckCategory).collect())
    }

    /// The deck's history, newest first.
    /// At most `limit` lines (1–500).
    async fn history(
        &self,
        ctx: &Context<'_>,
        #[graphql(default = 50)] limit: Option<i32>,
    ) -> Result<Vec<DeckHistoryEntry>> {
        let limit = i64::from(limit.unwrap_or(50));
        let loader = ctx.data_unchecked::<DataLoader<History>>();
        let lines = loader
            .load_one((limit, self.0.id))
            .await?
            .unwrap_or_default();
        Ok(lines.into_iter().map(DeckHistoryEntry).collect())
    }
}

/// What one deck's cards are worth at one marketplace: the live list's copies in active
/// categories of kind `main`, `commander` or `maybe` — the same cards a deck's `cardCount`
/// counts. Sideboard, companion, switched-off categories and the theory list are not included.
pub struct DeckValue(pub CoreDeckValue);

/// What one deck's cards are worth at one marketplace: the live list's copies in active
/// categories of kind `main`, `commander` or `maybe` — the same cards a deck's `cardCount`
/// counts. Sideboard, companion, switched-off categories and the theory list are not included.
#[Object(rename_fields = "camelCase")]
impl DeckValue {
    async fn deck_id(&self) -> i64 {
        self.0.deck_id
    }
    /// The total, as a decimal amount in the marketplace's currency (`12.5` is $12.50 or €12.50
    /// — see `marketplace.currency`). Summed over the copies that have a price; absent when none
    /// do, which is not the same as zero.
    async fn value(&self) -> Option<f64> {
        self.0.value
    }
    /// Copies in that pile with no price at this marketplace, left out of `value`.
    async fn unpriced(&self) -> i64 {
        self.0.unpriced
    }
}

/// One distinct printed mana cost in a deck, and how many copies pay it.
pub struct PipCost(pub CorePipCost);

/// One distinct printed mana cost in a deck, and how many copies pay it.
#[Object(rename_fields = "camelCase")]
impl PipCost {
    /// The printed cost in Scryfall's symbol form — `"{1}{R}"`, `"{2/W}"`, and
    /// `"{1}{R} // {1}{U}"` for a card with two faces. Never empty: lands and other costless
    /// cards are left out.
    async fn cost(&self) -> &str {
        &self.0.cost
    }
    /// Copies in the deck with this cost.
    async fn copies(&self) -> i64 {
        self.0.copies
    }
}

/// Every printed mana cost in one deck's live list.
pub struct DeckPipCosts(pub Arc<CorePipCosts>);

/// Every printed mana cost in one deck's live list (active `main`, `commander` and `maybe`
/// categories) — what the deck gallery's colour bar is drawn from. Count the coloured symbols in
/// each `cost`, weighted by `copies`.
#[Object(rename_fields = "camelCase")]
impl DeckPipCosts {
    async fn deck_id(&self) -> i64 {
        self.0.deck_id
    }
    /// Each cost once, in no particular order.
    async fn costs(&self) -> Vec<PipCost> {
        self.0.costs.iter().cloned().map(PipCost).collect()
    }
}

/// A deck label as worn in one list of one deck.
pub struct DeckLabelUsage(pub Arc<DeckLabelRow>);

/// A deck label as worn in one list (live or theory) of one deck, with how many copies there
/// wear it. A deck label is the reader's coloured mark on one card inside a deck — not a deck
/// tag and not a Scryfall tag.
#[Object(rename_fields = "camelCase")]
impl DeckLabelUsage {
    /// The label's id — the same as `DeckLabel.id`.
    async fn id(&self) -> i64 {
        self.0.id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// The label's colour, normally `#rrggbb`; older rows may hold a palette word.
    async fn color(&self) -> &str {
        &self.0.color
    }
    /// Copies wearing it in this deck's list. Never zero.
    async fn card_count(&self) -> i64 {
        self.0.card_count
    }
}

/// A deck label, across every deck.
pub struct DeckLabel(pub GlobalLabel);

/// A deck label: the reader's coloured mark for a card inside a deck (`Cut candidate`,
/// `Upgrade`). One label is shared by every deck — renaming or recolouring it changes it
/// everywhere — and a card in a deck wears at most one. Not a deck tag and not a Scryfall tag.
#[Object(rename_fields = "camelCase")]
impl DeckLabel {
    async fn id(&self) -> i64 {
        self.0.id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// The label's colour, normally `#rrggbb`; older rows may hold a palette word.
    async fn color(&self) -> &str {
        &self.0.color
    }
    /// Copies wearing it across every deck and both lists. `0` when unused.
    async fn card_count(&self) -> i64 {
        self.0.card_count
    }
    /// Decks with at least one card wearing it.
    async fn deck_count(&self) -> i64 {
        self.0.deck_count
    }
}

/// One category of one list of a deck.
pub struct DeckCategory(pub Arc<DeckCategoryRow>);

/// One category of one list (live or theory) of a deck: a named pile of cards, drawn as a column
/// in the deck editor.
#[Object(rename_fields = "camelCase")]
impl DeckCategory {
    async fn id(&self) -> i64 {
        self.0.id
    }
    async fn deck_id(&self) -> i64 {
        self.0.deck_id
    }
    async fn variant(&self) -> Result<DeckVariant> {
        word(&self.0.variant)
    }
    /// As the reader named it.
    async fn name(&self) -> &str {
        &self.0.name
    }
    async fn kind(&self) -> Result<CategoryKind> {
        word(&self.0.kind)
    }
    async fn origin(&self) -> Result<CategoryOrigin> {
        word(&self.0.origin)
    }
    /// Whether the pile counts. A switched-off pile counts toward no deck size, copy limit or
    /// legality check; the Maybeboard starts switched off.
    async fn is_active(&self) -> bool {
        self.0.is_active
    }
    async fn sort_order(&self) -> i64 {
        self.0.sort_order
    }
    /// Copies in the pile, not rows.
    async fn card_count(&self) -> i64 {
        self.0.card_count
    }
    /// Unit price × copies over the pile, as a decimal amount in the marketplace's currency; a
    /// partial sum over the copies that have a price, absent when none do.
    async fn total_price(&self) -> Option<f64> {
        self.0.total_price
    }
}

/// One card row in one category of one deck list.
pub struct DeckCard(pub DeckCardRow);

/// One card row in one category of one deck list: the printing, how many copies, the deck label
/// it wears, the card's facts, its price, and how many of it the reader owns for this deck. Card
/// facts are absent when the printing has left the card database.
#[Object(rename_fields = "camelCase")]
impl DeckCard {
    async fn id(&self) -> i64 {
        self.0.id
    }
    /// The Scryfall id of the printing.
    async fn card_id(&self) -> &str {
        &self.0.card_id
    }
    /// The card across all its printings (Scryfall's oracle id).
    async fn oracle_id(&self) -> Option<&str> {
        self.0.oracle_id.as_deref()
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// Copies in this row.
    async fn quantity(&self) -> i64 {
        self.0.quantity
    }
    async fn variant(&self) -> Result<DeckVariant> {
        word(&self.0.variant)
    }
    async fn category_id(&self) -> i64 {
        self.0.category_id
    }
    async fn category_name(&self) -> &str {
        &self.0.category_name
    }
    async fn category_kind(&self) -> Result<CategoryKind> {
        word(&self.0.category_kind)
    }
    /// False when the row's category is switched off, so it counts toward nothing.
    async fn category_active(&self) -> bool {
        self.0.category_active
    }
    /// The deck label this card wears, if any. The three label fields go together.
    async fn label_id(&self) -> Option<i64> {
        self.0.label_id
    }
    async fn label_name(&self) -> Option<&str> {
        self.0.label_name.as_deref()
    }
    async fn label_color(&self) -> Option<&str> {
        self.0.label_color.as_deref()
    }
    /// Lowercase, as Scryfall stores it.
    async fn set_code(&self) -> &str {
        &self.0.set_code
    }
    async fn set_name(&self) -> Option<&str> {
        self.0.set_name.as_deref()
    }
    async fn collector_number(&self) -> &str {
        &self.0.collector_number
    }
    async fn lang(&self) -> &str {
        &self.0.lang
    }
    /// The finish the deck plays: `foil` or `etched`, or absent for the regular (nonfoil) copy.
    async fn finish(&self) -> Result<Option<Finish>> {
        self.0.finish.as_deref().map(word).transpose()
    }
    /// A sentence when a sync could not keep this row's printing.
    async fn needs_review(&self) -> Option<&str> {
        self.0.needs_review.as_deref()
    }
    /// In Scryfall's symbol form, e.g. `"{2}{G}{G}"`.
    async fn mana_cost(&self) -> Option<&str> {
        self.0.mana_cost.as_deref()
    }
    /// Mana value.
    async fn cmc(&self) -> Option<f64> {
        self.0.cmc
    }
    async fn type_line(&self) -> Option<&str> {
        self.0.type_line.as_deref()
    }
    async fn oracle_text(&self) -> Option<&str> {
        self.0.oracle_text.as_deref()
    }
    /// Colour letters run together (`"WU"`), not a list. `""` is colourless.
    async fn colors(&self) -> Option<&str> {
        self.0.colors.as_deref()
    }
    /// Colour identity letters run together (`"WU"`).
    async fn color_identity(&self) -> Option<&str> {
        self.0.color_identity.as_deref()
    }
    /// The colours of mana the card can make, letters run together (`"C"` for colourless); `""`
    /// when it makes none, absent when unknown.
    async fn produced_mana(&self) -> Option<&str> {
        self.0.produced_mana.as_deref()
    }
    /// This printing's legality per format, as Scryfall gives it: an object of format key →
    /// `legal` | `not_legal` | `restricted` | `banned`.
    async fn legalities(&self) -> Option<Json<Value>> {
        self.0
            .legalities
            .as_deref()
            .map(|t| Json(parse_json_text(t)))
    }
    /// As printed — may be `"*"`.
    async fn power(&self) -> Option<&str> {
        self.0.power.as_deref()
    }
    async fn toughness(&self) -> Option<&str> {
        self.0.toughness.as_deref()
    }
    async fn layout(&self) -> Option<&str> {
        self.0.layout.as_deref()
    }
    async fn rarity(&self) -> Option<&str> {
        self.0.rarity.as_deref()
    }
    /// Scryfall's `card_faces` array for a card with more than one face, verbatim; absent for a
    /// one-faced card.
    async fn faces(&self) -> Option<Json<Value>> {
        self.0.faces.as_deref().map(|t| Json(parse_json_text(t)))
    }
    /// On the Commander Game Changers list.
    async fn game_changer(&self) -> Option<bool> {
        self.0.game_changer
    }
    /// Every finish this printing exists in (`nonfoil`, `foil`, `etched`) — not the finish the
    /// deck plays, which is `finish`.
    async fn printing_finishes(&self) -> Option<Vec<String>> {
        parse_string_array(self.0.finishes.as_deref())
    }
    /// Scryfall's `promo_types` (`surgefoil`, `halofoil`, …), which name a foil's kind.
    async fn promo_types(&self) -> Option<Vec<String>> {
        parse_string_array(self.0.promo_types.as_deref())
    }
    /// Printed at uncommon on any printing — what makes a Pauper Commander commander.
    async fn ever_uncommon(&self) -> bool {
        self.0.ever_uncommon
    }
    /// One copy's price at the marketplace asked for, at the row's finish, as a decimal amount in
    /// that marketplace's currency; absent when it has none.
    async fn unit_price(&self) -> Option<f64> {
        self.0.unit_price
    }
    /// Copies of this printing and finish the reader owns for this row: on the live list, the
    /// copies filed in the deck's own collection group; on the theory list, every copy the deck
    /// could use. Always 0 in a switched-off category.
    async fn owned_quantity(&self) -> i64 {
        self.0.owned_quantity
    }
}

/// One list (live or theory) of one deck, with everything in it.
pub struct DeckDetail {
    deck: Deck,
    cards: Vec<DeckCard>,
    categories: Vec<DeckCategory>,
    labels: Vec<DeckLabelUsage>,
}

impl From<CoreDeckDetail> for DeckDetail {
    fn from(detail: CoreDeckDetail) -> Self {
        Self {
            deck: Deck(Arc::new(detail.deck)),
            cards: detail.cards.into_iter().map(DeckCard).collect(),
            categories: detail
                .categories
                .into_iter()
                .map(|c| DeckCategory(Arc::new(c)))
                .collect(),
            labels: detail
                .labels
                .into_iter()
                .map(|l| DeckLabelUsage(Arc::new(l)))
                .collect(),
        }
    }
}

/// One list (live or theory) of one deck, with everything in it.
#[Object(rename_fields = "camelCase")]
impl DeckDetail {
    async fn deck(&self) -> &Deck {
        &self.deck
    }
    /// Every card row of the list, by category order then name.
    async fn cards(&self) -> &[DeckCard] {
        &self.cards
    }
    /// Every category of the list, in order — empty and switched-off ones included.
    async fn categories(&self) -> &[DeckCategory] {
        &self.categories
    }
    /// The deck labels the list's cards wear.
    async fn labels(&self) -> &[DeckLabelUsage] {
        &self.labels
    }
}

/// A folder of the deck gallery's tree.
pub struct DeckFolder(pub Arc<DeckFolderRow>);

/// A folder of the deck gallery's tree. Folders nest through `parentId`; a folder files decks and
/// belongs to none.
#[Object(rename_fields = "camelCase")]
impl DeckFolder {
    async fn id(&self) -> i64 {
        self.0.id
    }
    /// The folder this one is inside; absent at the root.
    async fn parent_id(&self) -> Option<i64> {
        self.0.parent_id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// Its place among its siblings.
    async fn sort_order(&self) -> i64 {
        self.0.sort_order
    }
    async fn parent(&self, ctx: &Context<'_>) -> Result<Option<DeckFolder>> {
        let Some(parent) = self.0.parent_id else {
            return Ok(None);
        };
        Ok(all_folders(ctx)?
            .iter()
            .find(|f| f.id == parent)
            .map(|f| DeckFolder(f.clone())))
    }
    /// The folders directly inside this one, in order.
    async fn subfolders(&self, ctx: &Context<'_>) -> Result<Vec<DeckFolder>> {
        let mut inside: Vec<DeckFolder> = all_folders(ctx)?
            .iter()
            .filter(|f| f.parent_id == Some(self.0.id))
            .map(|f| DeckFolder(f.clone()))
            .collect();
        inside.sort_by_key(|f| f.0.sort_order);
        Ok(inside)
    }
    /// The decks filed directly in this folder (not in its subfolders).
    async fn decks(&self, ctx: &Context<'_>) -> Result<Vec<Deck>> {
        Ok(all_decks(ctx)?
            .iter()
            .filter(|d| d.folder_id == Some(self.0.id))
            .map(|d| Deck(d.clone()))
            .collect())
    }
}

/// One deck format and its rules.
pub struct Format(pub Arc<FormatSpecRow>);

/// One deck format and its rules as data — what a deck's legality is checked against. Seeded
/// with the app; changes only with an app update.
#[Object(rename_fields = "camelCase")]
impl Format {
    /// The format's id, as a deck's `formatKey` names it (`commander`, `modern`, …).
    async fn key(&self) -> &str {
        &self.0.key
    }
    async fn display_name(&self) -> &str {
        &self.0.display_name
    }
    /// Whether a new deck can be made in this format.
    async fn enabled_in_picker(&self) -> bool {
        self.0.enabled_in_picker
    }
    /// The fewest cards a deck may hold.
    async fn deck_min(&self) -> i64 {
        self.0.deck_min
    }
    /// The most cards a deck may hold; absent when there is no maximum.
    async fn deck_max(&self) -> Option<i64> {
        self.0.deck_max
    }
    /// The most copies of one card (basic lands aside); absent when unlimited.
    async fn max_copies(&self) -> Option<i64> {
        self.0.max_copies
    }
    /// The largest sideboard: `0` means none allowed, absent means uncapped.
    async fn sideboard_max(&self) -> Option<i64> {
        self.0.sideboard_max
    }
    async fn singleton(&self) -> bool {
        self.0.singleton
    }
    async fn requires_commander(&self) -> bool {
        self.0.requires_commander
    }
    /// How the commander is judged; absent for a format with no command zone.
    async fn commander_rule(&self) -> Result<Option<CommanderRule>> {
        self.0.commander_rule.as_deref().map(word).transpose()
    }
    /// Starting life total.
    async fn life(&self) -> i64 {
        self.0.life
    }
    async fn restricted_meaning(&self) -> Result<RestrictedMeaning> {
        word(&self.0.restricted_semantic)
    }
    /// Whether cards carry a legality for this format (false for Casual and Limited).
    async fn has_legality_data(&self) -> bool {
        self.0.has_legality_data
    }
    /// A per-card mana value ceiling, when the format has one.
    async fn max_mana_value(&self) -> Option<i64> {
        self.0.max_mana_value
    }
    async fn allows_companion(&self) -> bool {
        self.0.allows_companion
    }
    /// Where a format picker lists it.
    async fn sort_order(&self) -> i64 {
        self.0.sort_order
    }
    /// The platforms the format is playable on. Never empty.
    async fn games(&self) -> Result<Vec<Game>> {
        self.0.games.iter().map(|g| word(g)).collect()
    }
    /// Whether a deck in this format is checked at all — false only for a deck whose format
    /// nobody has chosen yet.
    async fn validates(&self) -> bool {
        self.0.validates
    }
}

/// A deck note: the reader's prose about one deck.
pub struct DeckNote(pub DeckNoteRow);

/// A deck note: the reader's prose about one deck, optionally naming cards in it. Not a sticky
/// note (the home page's), not an entry note (on a collection or wishlist row), and not a deck
/// to-do list.
#[Object(rename_fields = "camelCase")]
impl DeckNote {
    async fn id(&self) -> i64 {
        self.0.id
    }
    async fn deck_id(&self) -> i64 {
        self.0.deck_id
    }
    /// The heading as typed; may be empty, in which case the app shows the body's first line or
    /// `Untitled note`.
    async fn title(&self) -> &str {
        &self.0.title
    }
    /// The note, as Markdown (CommonMark) source.
    async fn body(&self) -> &str {
        &self.0.body
    }
    /// The reader's order within the deck.
    async fn sort_order(&self) -> i64 {
        self.0.sort_order
    }
    /// The cards the note names. Often empty.
    async fn cards(&self) -> Vec<DeckNoteCard> {
        self.0.cards.iter().cloned().map(DeckNoteCard).collect()
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

/// A card a deck note names.
pub struct DeckNoteCard(pub CoreNoteCard);

/// A card a deck note names.
#[Object(rename_fields = "camelCase")]
impl DeckNoteCard {
    /// The card across all its printings — what the note attaches by.
    async fn oracle_id(&self) -> &str {
        &self.0.oracle_id
    }
    /// The card's name, or its oracle id when the card database has no row for it.
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// A printing to draw a picture of — the deck's own where it holds one. Absent when none is
    /// known.
    async fn card_id(&self) -> Option<&str> {
        self.0.card_id.as_deref()
    }
}

/// A deck note seen from one card it names.
pub struct CardNote(pub CardNoteRow);

/// A deck note seen from one card it names: the same note as `DeckNote`, carrying the deck it was
/// written in instead of its cards.
#[Object(rename_fields = "camelCase")]
impl CardNote {
    /// The deck note's id.
    async fn id(&self) -> i64 {
        self.0.id
    }
    async fn deck_id(&self) -> i64 {
        self.0.deck_id
    }
    async fn deck_name(&self) -> &str {
        &self.0.deck_name
    }
    /// The heading as typed; may be empty.
    async fn title(&self) -> &str {
        &self.0.title
    }
    /// The note, as Markdown (CommonMark) source.
    async fn body(&self) -> &str {
        &self.0.body
    }
    /// The deck the note is in.
    async fn deck(&self, ctx: &Context<'_>) -> Result<Option<Deck>> {
        deck_by_id(ctx, Some(self.0.deck_id))
    }
}

/// One of a deck's to-do lists.
pub struct DeckTodoList(pub Arc<CoreTodoList>);

/// One of a deck's to-do lists: a titled Markdown document of headings, text and `- [ ]` /
/// `- [x]` to-dos. A deck can have many. Not a deck note.
#[Object(rename_fields = "camelCase")]
impl DeckTodoList {
    async fn id(&self) -> i64 {
        self.0.id
    }
    async fn deck_id(&self) -> i64 {
        self.0.deck_id
    }
    /// The heading as typed; may be empty (shown as `Untitled list`).
    async fn title(&self) -> &str {
        &self.0.title
    }
    /// The list as Markdown: headings, paragraphs and task lines `- [ ] open` / `- [x] done`.
    /// Empty for a list with nothing in it yet.
    async fn body(&self) -> &str {
        &self.0.body
    }
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

/// A deck to-do list as read across every deck.
pub struct DeckTodoListEntry(pub CoreTodoListEntry);

/// A deck to-do list as read across every deck, with the deck it belongs to — only lists whose
/// body is not empty.
#[Object(rename_fields = "camelCase")]
impl DeckTodoListEntry {
    /// The to-do list's id.
    async fn id(&self) -> i64 {
        self.0.id
    }
    async fn deck_id(&self) -> i64 {
        self.0.deck_id
    }
    async fn deck_name(&self) -> &str {
        &self.0.deck_name
    }
    /// Whether the deck is archived.
    async fn archived(&self) -> bool {
        self.0.archived
    }
    /// Whether the deck editor's To-do band is expanded for this deck.
    async fn todos_open(&self) -> bool {
        self.0.todos_open
    }
    /// The heading as typed; may be empty.
    async fn title(&self) -> &str {
        &self.0.title
    }
    /// The list as Markdown: headings, paragraphs and task lines `- [ ] open` / `- [x] done`.
    /// Never empty here.
    async fn body(&self) -> &str {
        &self.0.body
    }
    /// The list's order within its deck.
    async fn sort_order(&self) -> i64 {
        self.0.sort_order
    }
    /// Unix seconds of the last edit.
    async fn updated_at(&self) -> f64 {
        self.0.updated_at as f64
    }
    async fn deck(&self, ctx: &Context<'_>) -> Result<Option<Deck>> {
        deck_by_id(ctx, Some(self.0.deck_id))
    }
}

/// One line of a deck's history.
pub struct DeckHistoryEntry(pub Arc<DeckAuditEntry>);

/// One line of a deck's history: what changed, as facts rather than a sentence. Newest first.
#[Object(rename_fields = "camelCase")]
impl DeckHistoryEntry {
    async fn id(&self) -> i64 {
        self.0.id
    }
    async fn deck_id(&self) -> i64 {
        self.0.deck_id
    }
    /// Unix seconds.
    async fn at(&self) -> f64 {
        self.0.at as f64
    }
    /// The list changed — meaningful only for card changes; deck-level lines always say `live`.
    /// Do not filter history by it.
    async fn variant(&self) -> Result<DeckVariant> {
        word(&self.0.variant)
    }
    /// What the line is about. Known kinds: `add`, `remove` and `quantity` change how many
    /// copies a deck holds; `move` moves cards between categories; `swap` changes a card's
    /// printing; `label` puts a deck label on a card or creates, renames or deletes one;
    /// `category`, `folder` and `deck` change a category, the deck's folder, or a setting of the
    /// deck itself. A history written by a newer version of the app can hold other kinds: show
    /// them, do not drop them.
    // A string and never an enum: a row written by a newer build carries a kind this one has
    // never heard of, and an enum would turn that row into an error and null the whole list.
    async fn kind(&self) -> &str {
        &self.0.kind
    }
    /// The printing the change was about; absent for changes about no card.
    async fn card_id(&self) -> Option<&str> {
        self.0.card_id.as_deref()
    }
    async fn card_name(&self) -> Option<&str> {
        self.0.card_name.as_deref()
    }
    /// The change's details; the shape depends on `kind`, and every key may be missing. Roughly:
    /// add `{category, quantity}`; remove `{category, quantity, reason}`; quantity `{category,
    /// from, to}`; move `{from, to}` (category names); swap `{category, fromSet, toSet,
    /// folded}`; label `{label, previous}` or `{action, label, previous}`; category `{action,
    /// name, previousName, cards}`; folder `{action, folder}`; deck `{field, from, to}`.
    async fn payload(&self) -> Json<Value> {
        Json(parse_json_text(&self.0.payload))
    }
    /// Signed change in copies (+n added, −n removed); 0 when no count changed.
    async fn delta(&self) -> i64 {
        self.0.delta
    }
}

/// One line of the home page's activity feed.
pub struct ActivityEntry(pub CoreActivityEntry);

/// One line of the home page's activity feed: a recent change to the collection, the wishlist or
/// a deck, as facts rather than a sentence. `id` is unique only within a `scope`.
#[Object(rename_fields = "camelCase")]
impl ActivityEntry {
    /// Unique within its scope only; key by scope and id.
    async fn id(&self) -> i64 {
        self.0.id
    }
    /// Unix seconds.
    async fn at(&self) -> f64 {
        self.0.at as f64
    }
    /// Where the change was made: `collection`, `wishlist` or `deck` (a newer app may write
    /// another word).
    async fn scope(&self) -> &str {
        &self.0.scope
    }
    /// What was done; the words depend on `scope`. Collection and wishlist: `add`, `remove`,
    /// `quantity`, `move`, `edit`, `folder`, `import`, `clear`. Deck: the `DeckHistoryKind`
    /// words.
    async fn kind(&self) -> &str {
        &self.0.kind
    }
    /// The deck changed; present only when `scope` is `deck`.
    async fn deck_id(&self) -> Option<i64> {
        self.0.deck_id
    }
    /// The printing the change was about; absent when it was about no one card.
    async fn card_id(&self) -> Option<&str> {
        self.0.card_id.as_deref()
    }
    async fn card_name(&self) -> Option<&str> {
        self.0.card_name.as_deref()
    }
    /// The change's details; the shape depends on `scope` and `kind`, and every key may be
    /// missing. Deck lines carry `DeckHistoryEntry.payload`'s shapes.
    async fn payload(&self) -> Json<Value> {
        Json(parse_json_text(&self.0.payload))
    }
    /// Signed change in copies (+n added, −n removed); 0 when no count changed.
    async fn delta(&self) -> i64 {
        self.0.delta
    }
    /// The deck changed, when `scope` is `deck` and the deck still exists.
    async fn deck(&self, ctx: &Context<'_>) -> Result<Option<Deck>> {
        deck_by_id(ctx, self.0.deck_id)
    }
}

// ---------------------------------------------------------------------------------------------
// Root fields.
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct DecksQuery;

#[Object(rename_fields = "camelCase")]
impl DecksQuery {
    /// Every deck, as the deck gallery lists them: archived decks last, then most recently
    /// changed first. `archived`: only archived decks (`true`) or only active ones (`false`);
    /// omit for both.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn decks(&self, ctx: &Context<'_>, archived: Option<bool>) -> Result<Option<Vec<Deck>>> {
        Ok(Some(
            all_decks(ctx)?
                .iter()
                .filter(|d| archived.is_none_or(|a| d.archived == a))
                .map(|d| Deck(d.clone()))
                .collect(),
        ))
    }

    /// One list of one deck, with its cards, categories and the deck labels its cards wear.
    /// Absent when no deck has that id.
    /// `marketplace` is the one to price at; the reader's own when omitted.
    // Owned counts on the cards are collection rows, so a binder write changes this answer too.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks", "collection"])))]
    async fn deck(
        &self,
        ctx: &Context<'_>,
        id: i64,
        #[graphql(default_with = "Some(DeckVariant::Live)")] variant: Option<DeckVariant>,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<DeckDetail>> {
        let variant = variant.unwrap_or_default();
        let marketplace = Market::from_id(&marketplace_of(ctx, marketplace));
        let detail = read(ctx, |c| get_deck(c, id, variant.id(), marketplace))?;
        Ok(detail.map(DeckDetail::from))
    }

    /// What every deck's live cards are worth at a marketplace, one row per deck.
    /// `marketplace` is the one to price at; the reader's own when omitted.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn deck_values(
        &self,
        ctx: &Context<'_>,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<Vec<DeckValue>>> {
        let marketplace = Market::from_id(&marketplace_of(ctx, marketplace));
        let values = read(ctx, |c| {
            grimoire_core::deck::deck_values_for(c, marketplace)
        })?;
        Ok(Some(values.into_iter().map(DeckValue).collect()))
    }

    /// Every deck's printed mana costs, for colour bars. A deck with no costed cards is absent.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn deck_pip_costs(&self, ctx: &Context<'_>) -> Result<Option<Vec<DeckPipCosts>>> {
        Ok(Some(
            all_pip_costs(ctx)?
                .iter()
                .map(|p| DeckPipCosts(p.clone()))
                .collect(),
        ))
    }

    /// One deck's deck notes, in the reader's order. Empty when it has none.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn deck_notes(&self, ctx: &Context<'_>, deck_id: i64) -> Result<Option<Vec<DeckNote>>> {
        let notes = read(ctx, |c| list_notes(c, deck_id))?;
        Ok(Some(notes.into_iter().map(DeckNote).collect()))
    }

    /// Every deck note, in any deck, that names a card. `oracleId` is the card across all its
    /// printings (Scryfall's oracle id).
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn card_notes(
        &self,
        ctx: &Context<'_>,
        oracle_id: String,
    ) -> Result<Option<Vec<CardNote>>> {
        let notes = read(ctx, |c| notes_for_card(c, &oracle_id))?;
        Ok(Some(notes.into_iter().map(CardNote).collect()))
    }

    /// Every deck to-do list with something in it, across all decks (archived ones included),
    /// most recently edited first.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn deck_todo_lists(&self, ctx: &Context<'_>) -> Result<Option<Vec<DeckTodoListEntry>>> {
        let lists = read(ctx, every_list)?;
        Ok(Some(lists.into_iter().map(DeckTodoListEntry).collect()))
    }

    /// One deck's to-do lists, in the reader's order — empty ones included.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn deck_todo_lists_for_deck(
        &self,
        ctx: &Context<'_>,
        deck_id: i64,
    ) -> Result<Option<Vec<DeckTodoList>>> {
        let lists = read(ctx, |c| lists_for(c, deck_id))?;
        Ok(Some(
            lists
                .into_iter()
                .map(|l| DeckTodoList(Arc::new(l)))
                .collect(),
        ))
    }

    /// Every deck label there is, worn or not, most-used first.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn deck_labels(&self, ctx: &Context<'_>) -> Result<Option<Vec<DeckLabel>>> {
        let labels = read(ctx, list_all_labels)?;
        Ok(Some(labels.into_iter().map(DeckLabel).collect()))
    }

    /// The deck labels one list of one deck is wearing, with how many copies wear each,
    /// most-used first.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn deck_labels_in_deck(
        &self,
        ctx: &Context<'_>,
        deck_id: i64,
        #[graphql(default_with = "Some(DeckVariant::Live)")] variant: Option<DeckVariant>,
    ) -> Result<Option<Vec<DeckLabelUsage>>> {
        let variant = variant.unwrap_or_default();
        let labels = read(ctx, |c| list_labels(c, deck_id, variant.id()))?;
        Ok(Some(
            labels
                .into_iter()
                .map(|l| DeckLabelUsage(Arc::new(l)))
                .collect(),
        ))
    }

    /// Every deck folder, flat; build the tree from `parentId` (or walk `subfolders` from the
    /// ones with none).
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn deck_folders(&self, ctx: &Context<'_>) -> Result<Option<Vec<DeckFolder>>> {
        Ok(Some(
            all_folders(ctx)?
                .iter()
                .map(|f| DeckFolder(f.clone()))
                .collect(),
        ))
    }

    /// The categories of one list of one deck, in order, empty ones included.
    /// `marketplace` is the one to price at; the reader's own when omitted.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn deck_categories(
        &self,
        ctx: &Context<'_>,
        deck_id: i64,
        #[graphql(default_with = "Some(DeckVariant::Live)")] variant: Option<DeckVariant>,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<Vec<DeckCategory>>> {
        let variant = variant.unwrap_or_default();
        let marketplace = Market::from_id(&marketplace_of(ctx, marketplace));
        let piles = read(ctx, |c| {
            list_categories(c, deck_id, variant.id(), marketplace)
        })?;
        Ok(Some(
            piles
                .into_iter()
                .map(|p| DeckCategory(Arc::new(p)))
                .collect(),
        ))
    }

    /// One deck's history, newest first. Empty for a deck that does not exist.
    /// At most `limit` lines (1–500).
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn deck_history(
        &self,
        ctx: &Context<'_>,
        deck_id: i64,
        #[graphql(default = 50)] limit: Option<i32>,
    ) -> Result<Option<Vec<DeckHistoryEntry>>> {
        let limit = i64::from(limit.unwrap_or(50));
        let lines = read(ctx, |c| audit_list(c, deck_id, limit))?;
        Ok(Some(
            lines
                .into_iter()
                .map(|l| DeckHistoryEntry(Arc::new(l)))
                .collect(),
        ))
    }

    /// Every deck format and its rules, in picker order.
    #[graphql(directive = invalidatedBy::apply(roots(&["formatSpecs"])))]
    async fn formats(&self, ctx: &Context<'_>) -> Result<Option<Vec<Format>>> {
        Ok(Some(
            all_formats(ctx)?
                .iter()
                .map(|f| Format(f.clone()))
                .collect(),
        ))
    }

    /// Recent changes to the collection, the wishlist and every deck, newest first — the home
    /// page's activity feed. At most `limit` lines (1–500).
    // The feed's own root is invalidated by nothing; it is a record of these three roots' writes.
    #[graphql(directive = invalidatedBy::apply(roots(&["collection", "wishlist", "decks"])))]
    async fn activity(
        &self,
        ctx: &Context<'_>,
        #[graphql(default = 50)] limit: Option<i32>,
    ) -> Result<Option<Vec<ActivityEntry>>> {
        // A negative limit is the core's floor of one line, as any other out-of-range one is.
        let limit = u32::try_from(limit.unwrap_or(50)).unwrap_or(0);
        let lines = read(ctx, |c| recent(c, limit))?;
        Ok(Some(lines.into_iter().map(ActivityEntry).collect()))
    }
}

#[cfg(test)]
mod tests {
    //! The decks over a real database: rows written through the core's own functions, every
    //! answer read back through [`crate::Graph::run`].

    use std::sync::atomic::Ordering;

    use grimoire_core::deck::{create_deck, update_deck, DeckInput, DeckPatch};
    use grimoire_core::deck_meta::{create_category, create_folder, create_label, set_card_label};
    use grimoire_core::deck_notes::create_note;
    use grimoire_core::deck_todos::create_list;
    use grimoire_core::schema::fixtures::{deck, deck_card};
    use grimoire_core::state::fixtures::on_files;
    use serde_json::json;

    use super::*;
    use crate::Graph;

    fn answer(state: &Arc<State>, query: &str) -> Value {
        let response = Graph::new().run(state, query, None, None, None);
        assert!(response.errors.is_empty(), "{:?}", response.errors);
        response.data.into_json().unwrap()
    }

    /// Burn, filed two folders deep, with a labelled card, a note naming a card, a to-do list and
    /// a history; and Spare, a bare deck at the root.
    struct World {
        state: Arc<State>,
        burn: i64,
        spare: i64,
    }

    fn world(name: &str) -> World {
        let state = on_files(name, "http://127.0.0.1:1").0;
        let (burn, spare) = {
            let conn = state.lock_db();
            let constructed = create_folder(&conn, None, "Constructed").unwrap();
            let red = create_folder(&conn, Some(constructed.id), "Red").unwrap();
            let burn = create_deck(
                &conn,
                &DeckInput {
                    name: "Burn".into(),
                    format_key: "modern".into(),
                    game_key: "any".into(),
                    folder_id: Some(red.id),
                    ..DeckInput::default()
                },
            )
            .unwrap()
            .id;
            update_deck(
                &conn,
                burn,
                &DeckPatch {
                    description: Some("Twenty to the face.".into()),
                    ..DeckPatch::default()
                },
            )
            .unwrap();
            let main = create_category(&conn, burn, "live", "Burn spells")
                .unwrap()
                .id;
            // A printing the card database does not hold: the row stands, its facts absent.
            deck_card(&conn, burn, "bolt-lea", main, 4);
            let cut = create_label(&conn, Some(burn), "Cut", "#ff0000").unwrap();
            set_card_label(&conn, burn, "bolt-lea", main, "live", None, Some(cut.id)).unwrap();
            create_note(&conn, burn, "Mana", "Fourteen sources.", &["o-bolt".into()]).unwrap();
            create_list(&conn, burn, "Upgrades", "- [ ] Eidolon").unwrap();
            (burn, deck(&conn, "Spare"))
        };
        World { state, burn, spare }
    }

    /// Every root field of the domain in one document, each answering without an error.
    #[test]
    fn every_root_field_answers() {
        let World { state, burn, .. } = world("graph-decks-roots");
        let data = answer(
            &state,
            &format!(
                r#"{{
                decks(archived: false) {{ id }}
                deck(id: {burn}, marketplace: cardmarket) {{
                    deck {{ name gameKey lastVariant managedWishlist tokenMode }}
                    cards {{ name quantity variant categoryKind labelName finish legalities
                             faces printingFinishes promoTypes ownedQuantity }}
                    categories {{ name kind origin variant isActive cardCount totalPrice }}
                    labels {{ name cardCount }}
                }}
                missing: deck(id: 404) {{ deck {{ id }} }}
                deckValues {{ deckId value unpriced }}
                deckPipCosts {{ deckId costs {{ cost copies }} }}
                deckNotes(deckId: {burn}) {{ title cards {{ oracleId name }} }}
                cardNotes(oracleId: "o-bolt") {{ title deckName deck {{ name }} }}
                deckTodoLists {{ title body deckName deck {{ name }} }}
                deckTodoListsForDeck(deckId: {burn}) {{ title body }}
                deckLabels {{ name color cardCount deckCount }}
                deckLabelsInDeck(deckId: {burn}) {{ name cardCount }}
                theoryLabels: deckLabelsInDeck(deckId: {burn}, variant: theory) {{ name }}
                deckFolders {{ name parentId }}
                deckCategories(deckId: {burn}) {{ name kind }}
                deckHistory(deckId: {burn}, limit: 5) {{ kind variant payload delta }}
                formats {{ key games commanderRule restrictedMeaning }}
                activity(limit: 10) {{ scope kind payload deckId deck {{ name }} }}
            }}"#
            ),
        );

        assert_eq!(data["decks"].as_array().unwrap().len(), 2);
        let detail = &data["deck"];
        assert_eq!(detail["deck"]["name"], json!("Burn"));
        assert_eq!(detail["deck"]["gameKey"], json!("any"));
        assert_eq!(detail["deck"]["lastVariant"], json!("live"));
        assert_eq!(
            detail["cards"],
            json!([{
                "name": "Lightning Bolt", "quantity": 4, "variant": "live", "categoryKind": "main",
                "labelName": "Cut", "finish": null, "legalities": null, "faces": null,
                "printingFinishes": null, "promoTypes": null, "ownedQuantity": 0
            }])
        );
        assert!(detail["categories"].as_array().unwrap().len() >= 4);
        assert_eq!(detail["labels"], json!([{ "name": "Cut", "cardCount": 4 }]));
        assert_eq!(data["missing"], Value::Null);
        assert_eq!(data["cardNotes"][0]["deck"]["name"], json!("Burn"));
        assert_eq!(data["deckTodoLists"][0]["deck"]["name"], json!("Burn"));
        assert_eq!(
            data["deckLabelsInDeck"],
            json!([{ "name": "Cut", "cardCount": 4 }])
        );
        assert_eq!(data["theoryLabels"], json!([]));
        assert_eq!(data["deckFolders"].as_array().unwrap().len(), 2);
        assert!(!data["formats"].as_array().unwrap().is_empty());
        // The description change is a `deck` line whose payload is an object, not its text.
        let history = data["deckHistory"].as_array().unwrap();
        let described = history
            .iter()
            .find(|l| l["payload"]["field"] == json!("description"))
            .unwrap_or_else(|| panic!("{history:?}"));
        assert_eq!(described["kind"], json!("deck"));
        let activity = data["activity"].as_array().unwrap();
        let line = activity
            .iter()
            .find(|l| l["scope"] == json!("deck"))
            .unwrap_or_else(|| panic!("{activity:?}"));
        assert_eq!(line["deck"]["name"], json!("Burn"));
        assert!(line["payload"].is_object());
    }

    /// Every edge of a deck and of a folder, nested under the gallery's list.
    #[test]
    fn a_deck_s_edges_answer() {
        let World { state, burn, spare } = world("graph-decks-edges");
        let data = answer(
            &state,
            r#"{
                decks {
                    id
                    pipCosts { cost }
                    folder { name parent { name parent { name } } }
                    format { key }
                    notes { title }
                    todoLists { title }
                    labels { name cardCount }
                    theory: labels(variant: theory) { name }
                    categories(marketplace: manapool) { name kind }
                    history(limit: 1) { kind }
                    value { unpriced }
                }
                deckFolders {
                    name
                    subfolders { name decks { name } }
                    decks { name }
                }
            }"#,
        );
        let decks = data["decks"].as_array().unwrap();
        let by_id = |id: i64| decks.iter().find(|d| d["id"] == json!(id)).unwrap();
        let burn = by_id(burn);
        assert_eq!(
            burn["folder"],
            json!({ "name": "Red", "parent": { "name": "Constructed", "parent": null } })
        );
        assert_eq!(burn["format"], json!({ "key": "modern" }));
        assert_eq!(burn["notes"], json!([{ "title": "Mana" }]));
        assert_eq!(burn["todoLists"], json!([{ "title": "Upgrades" }]));
        assert_eq!(burn["labels"], json!([{ "name": "Cut", "cardCount": 4 }]));
        assert_eq!(burn["theory"], json!([]));
        assert!(burn["categories"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["kind"] == json!("side")));
        assert_eq!(burn["history"].as_array().unwrap().len(), 1);
        // A printing the card database lacks has no cost to draw.
        assert_eq!(burn["pipCosts"], json!([]));

        let spare = by_id(spare);
        assert_eq!(spare["folder"], Value::Null);
        assert_eq!(spare["notes"], json!([]));
        assert_eq!(spare["todoLists"], json!([]));
        assert_eq!(spare["categories"], json!([]));

        let folders = data["deckFolders"].as_array().unwrap();
        let constructed = folders
            .iter()
            .find(|f| f["name"] == json!("Constructed"))
            .unwrap();
        assert_eq!(
            constructed["subfolders"],
            json!([{ "name": "Red", "decks": [{ "name": "Burn" }] }])
        );
        assert_eq!(constructed["decks"], json!([]));
    }

    /// The per-deck edges are one read each per level, however many decks: four edges, four
    /// batches.
    #[test]
    fn a_list_of_decks_costs_one_read_per_edge() {
        let state = on_files("graph-decks-batch", "http://127.0.0.1:1").0;
        {
            let conn = state.lock_db();
            for n in 0..12 {
                deck(&conn, &format!("Deck {n}"));
            }
        }
        // The counter is shared with the tests running beside this one, so run twice and take
        // the smaller difference: a neighbour's batch can land inside one window, not both.
        let runs: Vec<usize> = (0..2)
            .map(|_| {
                let before = PER_DECK_BATCHES.load(Ordering::SeqCst);
                let data = answer(
                    &state,
                    "{ decks { todoLists { id } labels { id } categories { id } history { id } } }",
                );
                assert_eq!(data["decks"].as_array().unwrap().len(), 12);
                PER_DECK_BATCHES.load(Ordering::SeqCst) - before
            })
            .collect();
        assert_eq!(runs.into_iter().min(), Some(4));
    }

    /// Stored JSON text is parsed leniently: text that is not JSON stays
    /// visible as a string, and a list keeps only its strings.
    #[test]
    fn stored_json_text_is_read_as_the_page_read_it() {
        assert_eq!(
            parse_json_text(r#"{"modern":"legal"}"#),
            json!({ "modern": "legal" })
        );
        assert_eq!(parse_json_text("{not json"), json!("{not json"));
        assert_eq!(
            parse_string_array(Some(r#"["foil", 3, "etched"]"#)),
            Some(vec!["foil".to_owned(), "etched".to_owned()])
        );
        assert_eq!(parse_string_array(Some(r#"{"foil":true}"#)), None);
        assert_eq!(parse_string_array(Some("nonfoil")), None);
        assert_eq!(parse_string_array(None), None);
    }

    /// A stored word this build does not know is an error naming the enum, not a guess.
    #[test]
    fn an_unknown_word_is_refused_by_name() {
        assert_eq!(word::<TokenMode>("hidden").unwrap(), TokenMode::Hidden);
        assert_eq!(
            word::<RestrictedMeaning>("banned_as_commander").unwrap(),
            RestrictedMeaning::BannedAsCommander
        );
        assert_eq!(
            word::<DeckGame>("holodeck").unwrap_err().message,
            "Enum \"DeckGame\" cannot represent value: \"holodeck\""
        );
    }
}
