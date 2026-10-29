//! The collection: its summary over any scope, and its folders.
//!
//! The page's graph also takes `query` — a card search in Scryfall's syntax — on these fields.
//! That parser is TypeScript's alone (`features/search/queryLanguage.ts`), so the spike leaves
//! the argument out; the port's decision is in `docs/reference/graphql.md`.

use async_graphql::{types::Json, Context, Object, Result};
use grimoire_core::collection::{summarise, CollectionQuery as Scope, CollectionSummary as Core};
use grimoire_core::collection_folders::{list_folders, CollectionFolder as CoreFolder};
use grimoire_core::folder_rules::FolderRule;
use grimoire_core::sorting::Marketplace as Market;

use crate::{invalidatedBy, marketplace_of, read, roots, Marketplace};

/// Totals over the copies a scope holds.
pub struct CollectionSummary(pub Core);

#[Object(rename_fields = "camelCase")]
impl CollectionSummary {
    /// Every copy, counting quantities.
    async fn total_cards(&self) -> i64 {
        self.0.total_cards
    }
    /// Distinct cards (oracle cards), however many printings and copies.
    async fn unique_cards(&self) -> i64 {
        self.0.unique_cards
    }
    /// Stacks — rows of the collection, each one printing, finish and condition.
    async fn entries(&self) -> i64 {
        self.0.entries
    }
    /// Copies offered for trade.
    async fn tradelist_cards(&self) -> i64 {
        self.0.tradelist_cards
    }
    /// Copies × unit price over the priced copies, in the marketplace's currency as a decimal.
    async fn value(&self) -> f64 {
        self.0.value
    }
    /// Copies with no price at the marketplace, left out of `value`.
    async fn unpriced(&self) -> i64 {
        self.0.unpriced
    }
    /// Copies flagged for the reader to review.
    async fn needs_review(&self) -> i64 {
        self.0.needs_review
    }
}

/// A folder of the collection's cabinet — the reader's own, or one the app keeps for a deck.
pub struct CollectionFolder(pub CoreFolder);

#[Object(rename_fields = "camelCase")]
impl CollectionFolder {
    async fn id(&self) -> i64 {
        self.0.id
    }
    async fn parent_id(&self) -> Option<i64> {
        self.0.parent_id
    }
    async fn name(&self) -> &str {
        &self.0.name
    }
    /// `user` for the reader's own folders; the app's own kinds otherwise (a deck's group).
    async fn kind(&self) -> &str {
        &self.0.kind
    }
    /// The deck a deck group belongs to.
    async fn deck_id(&self) -> Option<i64> {
        self.0.deck_id
    }
    async fn sort_order(&self) -> i64 {
        self.0.sort_order
    }
    /// Whether the folder's copies are kept out of every deck's reach.
    async fn locked(&self) -> bool {
        self.0.locked
    }
    /// The folder's folder rules — advisory criteria its cards are checked against — as stored:
    /// a JSON array of objects, each with a `kind`.
    async fn rules(&self) -> Json<Vec<FolderRule>> {
        Json(self.0.rules.clone())
    }
}

#[derive(Default)]
pub struct CollectionQuery;

#[Object(rename_fields = "camelCase")]
impl CollectionQuery {
    /// Totals over the collection, or over one folder (`folderId`) or the root alone
    /// (`rootOnly`).
    #[graphql(directive = invalidatedBy::apply(roots(&["collection"])))]
    #[allow(clippy::too_many_arguments)]
    async fn collection_summary(
        &self,
        ctx: &Context<'_>,
        folder_id: Option<i64>,
        root_only: Option<bool>,
        needs_review: Option<bool>,
        exclude_locked: Option<bool>,
        rule_breaks: Option<bool>,
        marketplace: Option<Marketplace>,
    ) -> Result<Option<CollectionSummary>> {
        let scope = Scope {
            folder_id,
            root_only: root_only.unwrap_or(false),
            needs_review,
            exclude_locked: exclude_locked.unwrap_or(false),
            rule_breaks: rule_breaks.unwrap_or(false),
            marketplace: Market::from_id(&marketplace_of(ctx, marketplace)),
            ..Scope::default()
        };
        Ok(Some(CollectionSummary(read(ctx, |c| {
            summarise(c, &scope)
        })?)))
    }

    /// Every folder of the collection's cabinet, parents before children.
    #[graphql(directive = invalidatedBy::apply(roots(&["collection"])))]
    async fn collection_folders(&self, ctx: &Context<'_>) -> Result<Option<Vec<CollectionFolder>>> {
        Ok(Some(
            read(ctx, list_folders)?
                .into_iter()
                .map(CollectionFolder)
                .collect(),
        ))
    }
}
