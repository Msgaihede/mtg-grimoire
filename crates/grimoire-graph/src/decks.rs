//! The decks: the gallery's rows, each deck's worth and its deck notes.
//!
//! A deck's `notes` and `value` are the two edges a widget listing decks reaches for, and both
//! go through a batch ([`crate::loaders`]): a list of forty decks asking for both is two reads,
//! not eighty.

use async_graphql::dataloader::DataLoader;
use async_graphql::{Context, Object, Result};
use grimoire_core::deck::{list_decks, DeckRow, DeckValue as CoreDeckValue};
use grimoire_core::deck_notes::{list_notes, DeckNoteCard as CoreNoteCard, DeckNoteRow};
use grimoire_core::sorting::Marketplace as Market;

use crate::loaders::{DeckNotes, DeckValues, ValueKey};
use crate::{invalidatedBy, marketplace_of, read, roots, Marketplace};

/// One deck, as the gallery lists it.
pub struct Deck(pub DeckRow);

/// A deck — a named list of cards for a format, with its own folder, deck tags and settings.
#[Object(rename_fields = "camelCase")]
impl Deck {
    async fn id(&self) -> i64 {
        self.0.id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// The format's key, e.g. `commander`, `modern`, `casual`.
    async fn format_key(&self) -> &str {
        &self.0.format_key
    }
    /// The format's display name, absent for a format this build does not know.
    async fn format_name(&self) -> Option<&str> {
        self.0.format_name.as_deref()
    }
    async fn description(&self) -> Option<&str> {
        self.0.description.as_deref()
    }
    /// The printing whose art is the deck's cover; pass it to the CardImage component.
    async fn cover_card_id(&self) -> Option<&str> {
        self.0.cover_card_id.as_deref()
    }
    async fn cover_artist(&self) -> Option<&str> {
        self.0.cover_artist.as_deref()
    }
    async fn archived(&self) -> bool {
        self.0.archived
    }
    /// How many cards the deck's live list holds, counting copies.
    async fn card_count(&self) -> i64 {
        self.0.card_count
    }
    /// When the deck last changed, in Unix seconds.
    async fn updated_at(&self) -> f64 {
        self.0.updated_at as f64
    }
    async fn folder_id(&self) -> Option<i64> {
        self.0.folder_id
    }
    async fn theory_enabled(&self) -> bool {
        self.0.theory_enabled
    }
    async fn virtual_only(&self) -> bool {
        self.0.virtual_only
    }
    async fn notes_open(&self) -> bool {
        self.0.notes_open
    }
    async fn todos_open(&self) -> bool {
        self.0.todos_open
    }
    /// The reader's Commander bracket for the deck, 0 when none was set.
    async fn bracket(&self) -> i64 {
        self.0.bracket
    }
    /// The deck's deck tags — the reader's own words about the whole deck (`Budget`, `Meme`).
    async fn tags(&self) -> &[String] {
        &self.0.tags
    }

    /// The deck's deck notes, in the reader's order — batched across every deck in the answer.
    async fn notes(&self, ctx: &Context<'_>) -> Result<Vec<DeckNote>> {
        let loader = ctx.data_unchecked::<DataLoader<DeckNotes>>();
        let notes = loader.load_one(self.0.id).await?.unwrap_or_default();
        Ok(notes.into_iter().map(DeckNote).collect())
    }

    /// What the deck's live list is worth — batched: one read per marketplace, whatever the
    /// number of decks.
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
}

/// What one deck is worth at one marketplace.
pub struct DeckValue(pub CoreDeckValue);

#[Object(rename_fields = "camelCase")]
impl DeckValue {
    async fn deck_id(&self) -> i64 {
        self.0.deck_id
    }
    /// Copies × unit price over the priced copies of the live list, in the marketplace's
    /// currency as a decimal; absent when no copy is priced.
    async fn value(&self) -> Option<f64> {
        self.0.value
    }
    /// How many copies have no price at the marketplace and are left out of `value`.
    async fn unpriced(&self) -> i64 {
        self.0.unpriced
    }
}

/// A deck note: what the reader wrote about one deck, optionally attached to cards in it.
pub struct DeckNote(pub DeckNoteRow);

#[Object(rename_fields = "camelCase")]
impl DeckNote {
    async fn id(&self) -> i64 {
        self.0.id
    }
    async fn deck_id(&self) -> i64 {
        self.0.deck_id
    }
    async fn title(&self) -> &str {
        &self.0.title
    }
    /// The note's text, as Markdown.
    async fn body(&self) -> &str {
        &self.0.body
    }
    async fn sort_order(&self) -> i64 {
        self.0.sort_order
    }
    /// The cards the note is attached to.
    async fn cards(&self) -> Vec<DeckNoteCard> {
        self.0.cards.iter().cloned().map(DeckNoteCard).collect()
    }
    /// In Unix seconds.
    async fn created_at(&self) -> f64 {
        self.0.created_at as f64
    }
    /// In Unix seconds.
    async fn updated_at(&self) -> f64 {
        self.0.updated_at as f64
    }
}

/// A card a deck note is attached to.
pub struct DeckNoteCard(pub CoreNoteCard);

#[Object(rename_fields = "camelCase")]
impl DeckNoteCard {
    async fn oracle_id(&self) -> &str {
        &self.0.oracle_id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// A printing of the card to draw — one in the deck when there is one.
    async fn card_id(&self) -> Option<&str> {
        self.0.card_id.as_deref()
    }
}

#[derive(Default)]
pub struct DecksQuery;

#[Object(rename_fields = "camelCase")]
impl DecksQuery {
    /// Every deck, in the gallery's order. `archived` narrows to the archived or the
    /// unarchived ones; absent, both.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn decks(&self, ctx: &Context<'_>, archived: Option<bool>) -> Result<Option<Vec<Deck>>> {
        let rows = read(ctx, list_decks)?;
        Ok(Some(
            rows.into_iter()
                .filter(|d| archived.is_none_or(|a| d.archived == a))
                .map(Deck)
                .collect(),
        ))
    }

    /// Every deck's worth at one marketplace.
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

    /// One deck's deck notes, in the reader's order.
    #[graphql(directive = invalidatedBy::apply(roots(&["decks"])))]
    async fn deck_notes(&self, ctx: &Context<'_>, deck_id: i64) -> Result<Option<Vec<DeckNote>>> {
        let notes = read(ctx, |c| list_notes(c, deck_id))?;
        Ok(Some(notes.into_iter().map(DeckNote).collect()))
    }
}
