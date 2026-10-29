//! Scryfall's two Tagger datasets — **Oracle Tags** (what a card does: `removal`, `ramp`) and
//! **Art Tags** (what an illustration shows: `dragon`, `forest`) — their tree, their search, each
//! dataset's freshness, and the tags the reader has muted. Ported from the page's graph
//! (`packages/ui/lib/graphql/schema/tags.ts`).
//!
//! A "tag" in this file is only ever one of those two datasets: never an entry tag on a
//! collection or wishlist row, a deck tag, a deck label or a keyword ability
//! (`docs/agent/DOMAIN_VOCABULARY.md`).

use std::sync::Arc;

use async_graphql::{Context, Object, Request, Result};
use grimoire_core::state::State;
use grimoire_core::tags::art::ART;
use grimoire_core::tags::muted::{list as list_muted, MutedTag as CoreMuted};
use grimoire_core::tags::oracle::{
    read_card_tags, read_printing_tags, CardTags, PrintingTags, ORACLE,
};
use grimoire_core::tags::query::{
    run_tag_children, run_tag_search, TagHit as CoreHit, TagRef as CoreRef,
};
use grimoire_core::tags::{status_of, TagStatus as CoreStatus};

use crate::enums::TagNamespace;
use crate::{invalidatedBy, read, roots};

/// This domain's batch loaders, for one execution — none: the Oracle-tag batch is the cards
/// domain's, where the edge is.
pub(crate) fn data(request: Request, _state: &Arc<State>) -> Request {
    request
}

/// The core's namespace word as the enum; a word this build does not know is an error.
fn namespace_of(ns: &str) -> Result<TagNamespace> {
    TagNamespace::from_id(ns)
        .ok_or_else(|| async_graphql::Error::new(format!("unknown tag namespace `{ns}`")))
}

/// The word the core's tag reads take: one namespace, or `both`.
fn namespace_arg(ns: Option<TagNamespace>) -> &'static str {
    ns.map_or("both", TagNamespace::id)
}

/// A Scryfall tag named from somewhere else.
pub struct TagRef(pub CoreRef);

/// A Scryfall tag named from somewhere else — enough to show it and ask about it again.
#[Object(rename_fields = "camelCase")]
impl TagRef {
    /// The tag's slug, e.g. `spot-removal` — what `otag:`/`atag:` take in a search query.
    async fn slug(&self) -> &str {
        &self.0.slug
    }
    /// The tag's name for display.
    async fn label(&self) -> &str {
        &self.0.label
    }
    async fn namespace(&self) -> Result<TagNamespace> {
        namespace_of(&self.0.namespace)
    }
}

/// One Scryfall tag with its reach and its place in the tag tree.
pub struct TagHit(pub CoreHit);

/// One Scryfall tag (an Oracle Tag or an Art Tag) with its reach and its place in the tag tree.
/// Muted tags never appear.
#[Object(rename_fields = "camelCase")]
impl TagHit {
    /// The tag's slug — what `otag:` (Oracle) or `atag:` (Art) take in a search query.
    async fn slug(&self) -> &str {
        &self.0.slug
    }
    /// Scryfall's stable id for the tag. May be empty on a database not refreshed lately.
    async fn id(&self) -> &str {
        &self.0.id
    }
    /// The tag's name for display.
    async fn label(&self) -> &str {
        &self.0.label
    }
    async fn namespace(&self) -> Result<TagNamespace> {
        namespace_of(&self.0.namespace)
    }
    /// Scryfall's own description of the tag.
    async fn description(&self) -> Option<&str> {
        self.0.description.as_deref()
    }
    /// How many subjects the tag reaches, its descendants included: oracle cards for an Oracle
    /// Tag, illustrations for an Art Tag. Not a count of printings.
    async fn card_count(&self) -> i64 {
        self.0.card_count
    }
    /// How many direct child tags it has (muted ones not counted).
    async fn child_count(&self) -> i64 {
        self.0.child_count
    }
    /// Every parent tag — a tag can sit under several.
    async fn parents(&self) -> Vec<TagRef> {
        self.0.parents.iter().cloned().map(TagRef).collect()
    }
}

/// How fresh one of Scryfall's tag datasets is on this machine.
pub struct TagStatus(pub CoreStatus);

/// How fresh one of Scryfall's tag datasets is on this machine. Every nullable field is null
/// when the dataset has never been downloaded.
#[Object(rename_fields = "camelCase")]
impl TagStatus {
    /// Scryfall's own timestamp for the file these tags came from.
    async fn updated_at(&self) -> Option<&str> {
        self.0.updated_at.as_deref()
    }
    /// When the dataset was last loaded, in Unix seconds. Null: never downloaded.
    async fn ingested_at(&self) -> Option<f64> {
        self.0.ingested_at.map(|s| s as f64)
    }
    /// When Scryfall was last asked whether a newer file exists, in Unix seconds.
    async fn checked_at(&self) -> Option<f64> {
        self.0.checked_at.map(|s| s as f64)
    }
    /// Tags in the dataset.
    async fn tag_count(&self) -> Option<i64> {
        self.0.tag_count
    }
    /// Tag-to-subject assignments in the dataset.
    async fn tagging_count(&self) -> Option<i64> {
        self.0.tagging_count
    }
    /// A refresh is due.
    async fn stale(&self) -> bool {
        self.0.stale
    }
    /// A refresh is running right now.
    async fn refreshing(&self) -> bool {
        self.0.refreshing
    }
}

/// A Scryfall tag the reader has hidden.
pub struct MutedTag(pub CoreMuted);

/// A Scryfall tag the reader has hidden from the tag search and the tag tree. Muting hides the
/// tag, never a card.
#[Object(rename_fields = "camelCase")]
impl MutedTag {
    async fn namespace(&self) -> Result<TagNamespace> {
        namespace_of(&self.0.namespace)
    }
    /// Scryfall's stable id for the tag.
    async fn tag_id(&self) -> &str {
        &self.0.tag_id
    }
    /// The slug as it read when the tag was muted. May be out of date.
    async fn slug(&self) -> &str {
        &self.0.slug
    }
    /// When it was muted, in Unix seconds.
    async fn muted_at(&self) -> f64 {
        self.0.muted_at as f64
    }
}

/// One card's Oracle Tags, keyed by its oracle id.
pub struct CardOracleTags(pub CardTags);

/// One card's Oracle Tags, keyed by its oracle id.
#[Object(rename_fields = "camelCase")]
impl CardOracleTags {
    async fn oracle_id(&self) -> &str {
        &self.0.oracle_id
    }
    /// Oracle tag slugs (`removal`, `ramp`), sorted, with every ancestor tag included. Empty for
    /// an untagged card, an unknown id, and a database that has never downloaded the Oracle
    /// tags — check `oracleTagsStatus` to tell them apart.
    async fn slugs(&self) -> &[String] {
        &self.0.slugs
    }
}

/// One printing's Oracle Tags, keyed by the printing id.
pub struct PrintingOracleTags(pub PrintingTags);

/// One printing's Oracle Tags (the card's, since every printing shares them), keyed by the
/// printing id.
#[Object(rename_fields = "camelCase")]
impl PrintingOracleTags {
    /// The printing's Scryfall id.
    async fn card_id(&self) -> &str {
        &self.0.card_id
    }
    /// Oracle tag slugs (`removal`, `ramp`), sorted, with every ancestor tag included. Empty for
    /// an untagged card, an unknown id, and a database that has never downloaded the Oracle
    /// tags — check `oracleTagsStatus` to tell them apart.
    async fn slugs(&self) -> &[String] {
        &self.0.slugs
    }
}

#[derive(Default)]
pub struct TagsQuery;

#[Object(rename_fields = "camelCase")]
impl TagsQuery {
    /// Find Scryfall tags (Oracle Tags and Art Tags) by name: the exact match first, then names
    /// starting with the text, then names containing it. Empty text lists the tags with the
    /// widest reach. Muted tags are left out.
    #[graphql(directive = invalidatedBy::apply(roots(&["tag-search"])))]
    async fn tag_search(
        &self,
        ctx: &Context<'_>,
        #[graphql(
            default_with = "Some(String::new())",
            desc = "Part of a tag's name, e.g. `remov` or `dragon`."
        )]
        text: Option<String>,
        #[graphql(
            desc = "Which dataset: `oracle` (what a card does) or `art` (what an illustration shows). Absent asks both, Art Tags ranked first."
        )]
        namespace: Option<TagNamespace>,
        #[graphql(default = 50, desc = "At most this many tags.")] limit: Option<i32>,
    ) -> Result<Option<Vec<TagHit>>> {
        let text = text.unwrap_or_default();
        let limit = u32::try_from(limit.unwrap_or(50)).unwrap_or(0);
        let hits = read(ctx, |c| {
            run_tag_search(c, &text, namespace_arg(namespace), limit)
        })?;
        Ok(Some(hits.into_iter().map(TagHit).collect()))
    }

    /// One level of the Scryfall tag tree: the direct children of a tag, or the top-level tags
    /// when no parent is named. Every child is listed, unlimited. Muted tags (and so their
    /// subtrees) are left out.
    #[graphql(directive = invalidatedBy::apply(roots(&["tag-children"])))]
    async fn tag_children(
        &self,
        ctx: &Context<'_>,
        #[graphql(
            desc = "Which dataset: `oracle` (what a card does) or `art` (what an illustration shows). Absent asks both, Art Tags ranked first."
        )]
        namespace: Option<TagNamespace>,
        #[graphql(desc = "The parent tag's slug. Absent: the top-level tags.")] parent: Option<
            String,
        >,
    ) -> Result<Option<Vec<TagHit>>> {
        let hits = read(ctx, |c| {
            run_tag_children(c, namespace_arg(namespace), parent.as_deref())
        })?;
        Ok(Some(hits.into_iter().map(TagHit).collect()))
    }

    /// The Scryfall tags the reader has muted, by dataset and then by slug. A muted tag is
    /// hidden from tag search and the tag tree; its cards are not hidden.
    #[graphql(directive = invalidatedBy::apply(roots(&["tags-muted"])))]
    async fn muted_tags(&self, ctx: &Context<'_>) -> Result<Option<Vec<MutedTag>>> {
        Ok(Some(
            read(ctx, list_muted)?.into_iter().map(MutedTag).collect(),
        ))
    }

    /// The Oracle Tags (what a card does) of a set of cards, by oracle id. One entry per
    /// distinct id — match rows by `oracleId`, never by position. A single card's are also on
    /// `CardSummary.oracleTags` and `CardDetail.oracleTags`.
    #[graphql(directive = invalidatedBy::apply(roots(&["tags", "oracleTags"])))]
    async fn oracle_tags_for_cards(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "Oracle ids.")] oracle_ids: Vec<String>,
    ) -> Result<Option<Vec<CardOracleTags>>> {
        let tags = read(ctx, |c| {
            read_card_tags(c, &oracle_ids).map_err(|e| format!("could not read the tags: {e}"))
        })?;
        Ok(Some(tags.into_iter().map(CardOracleTags).collect()))
    }

    /// The Oracle Tags (what a card does) of a set of printings, by printing id. One entry per
    /// distinct id — match rows by `cardId`, never by position.
    #[graphql(directive = invalidatedBy::apply(roots(&["tags", "oracleTags"])))]
    async fn oracle_tags_for_printings(
        &self,
        ctx: &Context<'_>,
        #[graphql(desc = "Printing ids.")] card_ids: Vec<String>,
    ) -> Result<Option<Vec<PrintingOracleTags>>> {
        let tags = read(ctx, |c| {
            read_printing_tags(c, &card_ids).map_err(|e| format!("could not read the tags: {e}"))
        })?;
        Ok(Some(tags.into_iter().map(PrintingOracleTags).collect()))
    }

    /// How fresh the Oracle Tags dataset (what a card does) is on this machine. Never fails — a
    /// dataset never downloaded answers nulls with `stale: true`.
    #[graphql(directive = invalidatedBy::apply(roots(&["tags", "oracleTags"])))]
    async fn oracle_tags_status(&self, ctx: &Context<'_>) -> Result<Option<TagStatus>> {
        let state = ctx.data_unchecked::<Arc<State>>();
        Ok(Some(TagStatus(status_of(&ORACLE, state))))
    }

    /// How fresh the Art Tags dataset (what an illustration shows) is on this machine. Never
    /// fails — a dataset never downloaded answers nulls with `stale: true`.
    #[graphql(directive = invalidatedBy::apply(roots(&["artTags"])))]
    async fn art_tags_status(&self, ctx: &Context<'_>) -> Result<Option<TagStatus>> {
        let state = ctx.data_unchecked::<Arc<State>>();
        Ok(Some(TagStatus(status_of(&ART, state))))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::cards::tests::{answer, seeded};

    #[test]
    fn every_tags_root_field_answers() {
        let state = seeded("graph-tags-roots");
        let data = answer(
            &state,
            r#"{
                tagSearch(text: "remov") { slug label namespace cardCount childCount parents { slug } }
                oracle: tagSearch(namespace: oracle, limit: 1) { slug }
                tagChildren(namespace: oracle) { slug childCount }
                under: tagChildren(namespace: oracle, parent: "removal") { slug parents { slug namespace } }
                mutedTags { slug }
                oracleTagsForCards(oracleIds: ["o-bolt", "o-bear"]) { oracleId slugs }
                oracleTagsForPrintings(cardIds: ["bolt-m11"]) { cardId slugs }
                oracleTagsStatus { ingestedAt stale refreshing }
                artTagsStatus { tagCount stale }
            }"#,
        );
        let hit = &data["tagSearch"][0];
        assert_eq!(hit["slug"], json!("removal"));
        assert_eq!(hit["namespace"], json!("oracle"));
        assert_eq!(data["oracle"].as_array().unwrap().len(), 1);
        assert_eq!(
            data["tagChildren"],
            json!([{ "slug": "removal", "childCount": 1 }])
        );
        assert_eq!(
            data["under"],
            json!([{ "slug": "burn", "parents": [{ "slug": "removal", "namespace": "oracle" }] }])
        );
        assert_eq!(data["mutedTags"], json!([]));
        let mut cards = data["oracleTagsForCards"].as_array().unwrap().clone();
        cards.sort_by_key(|c| c["oracleId"].as_str().unwrap().to_owned());
        assert_eq!(
            cards,
            vec![
                json!({ "oracleId": "o-bear", "slugs": [] }),
                json!({ "oracleId": "o-bolt", "slugs": ["burn", "removal"] })
            ]
        );
        assert_eq!(
            data["oracleTagsForPrintings"],
            json!([{ "cardId": "bolt-m11", "slugs": ["burn", "removal"] }])
        );
        // Never downloaded: nulls, and due.
        assert_eq!(
            data["oracleTagsStatus"],
            json!({ "ingestedAt": null, "stale": true, "refreshing": false })
        );
        assert_eq!(
            data["artTagsStatus"],
            json!({ "tagCount": null, "stale": true })
        );
    }
}
