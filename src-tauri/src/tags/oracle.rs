//! Scryfall's **Oracle Tags**: what a card *does* rather than what it is.
//!
//! `cards.type_line` says a card is an Instant. It does not say the card is a tutor, a board
//! wipe, a ramp piece or a counterspell — and those are the words a deck is actually built
//! in. Scryfall's community-curated tag taxonomy does, and publishes it as a bulk dataset
//! keyed on `oracle_id`, which is the column this database already carries on every printing.
//!
//! **The fetch, the parse, the graph walk, the staged write and the swap are [`super`]'s**,
//! along with the five rules that shape them. This module is the binding: [`ORACLE`] names
//! the tables and the id, the four commands wire it to the frontend, and the read paths below
//! are the genuinely oracle-shaped part — they answer about *cards*, and most of the app is
//! holding a printing id when it asks.
//!
//! Everything below was measured live on 2026-08-14 against that day's file:
//!
//! | | |
//! | --- | --- |
//! | Manifest | `GET /bulk-data/oracle_tags` — `jsonl_download_uri` + `compressed_size`, no `download_uri`/`size` |
//! | Payload | ~5.85 MB gzipped JSONL, one `tag` object per line |
//! | Tags | 4 521 · 926 with no parent · **684 with more than one parent** · max depth 5 |
//! | Taggings | 229 633 over 35 969 distinct oracle ids |
//! | `weight` | `median` on 99.74 % of taggings |
//!
//! **Nothing here may break a launch or a card sync.** A failure leaves the previous tags in
//! place and writes the reason to `error_log`. Categorising by card type is the honest
//! fallback, and it is what the app did before this file existed.

use super::{read_tags_keyed, Dataset, TagStatus};
use crate::sync::AppState;
use rusqlite::Connection;
use serde::Serialize;
use std::sync::Arc;

/// The event a refresh reports itself through.
///
/// **Its own event rather than a ninth `sync::PHASES` value**, for
/// [`crate::marketplace_feed::PROGRESS_EVENT`]'s reason: that list is a closed union on the
/// TypeScript side and a phase it does not know renders as `undefined`. This is also not a
/// sync — it can run while one is in flight, and the two would otherwise fight over one line.
pub const PROGRESS_EVENT: &str = "oracle-tags:progress";

/// How long an ingested tag file stays fresh.
///
/// **A week, where the card corpus gets a day**, and the difference is what the two files
/// are. `default_cards` gains printings continuously and a card the user just bought must be
/// findable; the tag taxonomy is hand-curated by Scryfall's community and moves in
/// increments — a new tag here or there against 4 521 — so re-downloading and re-flattening
/// 229 633 taggings every morning would buy almost nothing. It is also the *stabler* answer
/// for a reader: a deck's categories should not quietly regroup themselves between two
/// sessions on the same afternoon.
///
/// The ETag makes a check that finds nothing cost zero bytes either way, and
/// [`oracle_tags_refresh`]'s `force` is the way past this for anyone who wants today's file.
pub const REFRESH_INTERVAL_SECS: i64 = 7 * 86_400;

/// Scryfall's Oracle Tags — what a card *does*.
///
/// The one place the oracle taxonomy's tables, columns and schedule are written down;
/// everything above and below reaches [`super`] through it.
pub const ORACLE: Dataset = Dataset {
    bulk_name: crate::scryfall::BULK_ORACLE_TAGS,
    label: "Oracle tags",
    subject_column: "oracle_id",
    tags_table: "oracle_tags",
    parents_table: "oracle_tag_parents",
    taggings_table: "oracle_taggings",
    closure_table: "oracle_tag_cards",
    meta_table: "oracle_tag_meta",
    progress_event: PROGRESS_EVENT,
    refresh_interval_secs: REFRESH_INTERVAL_SECS,
    tmp_file: "oracle-tags.jsonl.gz",
    // 99.74 % of oracle taggings are `median` and `strong` occurs exactly once in the
    // entire file, so there is no cluster to rank against. The closure stores no weight
    // and nothing may branch on one. See the 2026-08-14 research.
    carries_weight: false,
    create_staging: crate::schema::create_oracle_tag_staging,
    drop_staging: crate::schema::drop_oracle_tag_staging,
    swap_staging: crate::schema::swap_oracle_tag_staging,
};

/// [`TagStatus`] under the name this dataset's command has always answered with, and the one
/// the frontend's own type mirrors. The shape is the engine's and is identical for every
/// taxonomy; only the noun in front of it is oracle's.
pub type OracleTagStatus = TagStatus;

/// Payload of [`PROGRESS_EVENT`] — [`super::TagProgress`], under the name the frontend knows.
pub type OracleTagProgress = super::TagProgress;

// ---------------------------------------------------------------------------------------
// The read path
// ---------------------------------------------------------------------------------------

/// One card's tags, as the frontend receives them.
///
/// **Raw slugs, in no meaningful order and with nothing filtered out.** Which of them names a
/// deck category, which one wins when a card holds several, and which are noise is a question
/// about how a decklist should read — a conclusion, and so TypeScript's. This is the fact.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardTags {
    pub oracle_id: String,
    /// Every tag the card holds *and* every ancestor of those tags, sorted. Empty for a card
    /// the taxonomy says nothing about — which is a real answer, and the reason an untagged
    /// card still gets an entry rather than being missing from the list.
    pub slugs: Vec<String>,
}

/// One **printing's** tags, as the frontend receives them.
///
/// A separate type from [`CardTags`] because the id in it is a different id — `cards.id`, not
/// `cards.oracle_id` — and echoing a printing id back in a field called `oracleId` would be a
/// lie the caller has no way to notice. The `slugs` are identical in kind and meaning: every
/// printing of a card holds the same tags, because a tag is a fact about the oracle text.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrintingTags {
    /// The printing id **that was asked about**, echoed verbatim, so an answer can be matched
    /// back to a request positionally and without parsing.
    pub card_id: String,
    /// As [`CardTags::slugs`]. Empty for an untagged card, a card id this database does not
    /// have, and a printing whose `oracle_id` is NULL alike — **all three mean "fall back to
    /// the type line"**, and telling them apart would be a distinction no caller acts on.
    pub slugs: Vec<String>,
}

/// The tags of every card in `oracle_ids`, one entry per id, in the order asked.
///
/// **One round trip for a whole decklist**, which is the point: an import resolves a hundred
/// lines and then needs a category for each, and a command per card would be a hundred IPC
/// hops against a table that answers in microseconds.
///
/// Duplicates and blanks in the request are dropped; an id the closure has no rows for comes
/// back with an empty `slugs` rather than being absent, so the caller can tell "this card has
/// no tags" from "I forgot to ask about this card" without a second data structure.
pub fn read_card_tags(conn: &Connection, oracle_ids: &[String]) -> rusqlite::Result<Vec<CardTags>> {
    Ok(read_tags_keyed(conn, oracle_ids, BY_ORACLE_ID)?
        .into_iter()
        .map(|(oracle_id, slugs)| CardTags { oracle_id, slugs })
        .collect())
}

/// The tags of every **printing** in `card_ids`, one entry per id, in the order asked.
///
/// The same answer [`read_card_tags`] gives, reached from the other end — and the reason it
/// exists is that most of the app is holding the wrong id. A quick add, a drag from the
/// search results, the sidebar's deck entry and a resolved decklist line all carry a
/// `cards.id`; `CardSummary` does not even have an `oracleId` field. The alternatives were
/// widening a hot list DTO or threading an extra field through five drag sources, for a
/// column one rule reads. This resolves it in SQL instead.
///
/// **A card id this database has never seen, and a printing whose `oracle_id` is NULL, both
/// answer an empty list rather than an error.** An orphaned deck row is an ordinary state
/// here (`cards` is dropped and rebuilt on every sync), and nothing about choosing a category
/// may be allowed to fail a deck add.
pub fn read_printing_tags(
    conn: &Connection,
    card_ids: &[String],
) -> rusqlite::Result<Vec<PrintingTags>> {
    Ok(read_tags_keyed(conn, card_ids, BY_PRINTING_ID)?
        .into_iter()
        .map(|(card_id, slugs)| PrintingTags { card_id, slugs })
        .collect())
}

/// `oracle_tag_cards` read directly: the key *is* the closure's own column.
const BY_ORACLE_ID: &str = "SELECT oracle_id, slug FROM oracle_tag_cards
      WHERE oracle_id IN ({holes}) ORDER BY oracle_id, slug";

/// The same closure reached through `cards`, keyed on the printing.
///
/// One statement per chunk and not a lookup per card: `cards.id` is the primary key and
/// `oracle_id` has `idx_cards_oracle`, so this is a point lookup per requested id followed by
/// a prefix scan of a `WITHOUT ROWID` table — never a scan of either.
///
/// **A plain `JOIN`, deliberately, where a `LEFT JOIN` looks friendlier.** The missing rows
/// are put back by the caller below, which has to do it anyway for an id that simply has no
/// tags; a `LEFT JOIN` would only add a NULL-slug row per untagged card for that same code to
/// filter out again. It is also what makes a NULL `oracle_id` answer nothing without a word
/// about it: `NULL = NULL` is not true in SQL, so such a printing matches no closure row.
const BY_PRINTING_ID: &str = "SELECT c.id, t.slug
       FROM cards c
       JOIN oracle_tag_cards t ON t.oracle_id = c.oracle_id
      WHERE c.id IN ({holes}) ORDER BY c.id, t.slug";

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// Download the Oracle Tags file if it has changed and rebuild the taxonomy from it.
///
/// `force` skips the weekly throttle, not the ETag check.
#[tauri::command]
pub async fn oracle_tags_refresh(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    force: bool,
) -> Result<OracleTagStatus, String> {
    let state = state.inner().clone();
    super::refresh(&ORACLE, &state, force, &mut |phase, done, total| {
        super::emit(&ORACLE, &app, phase, done, total)
    })
    .await
}

/// Whether there is a taxonomy, which file it came from, and how old it is.
///
/// `async`, and answered on the blocking pool, because a sync command body runs inline on the
/// IPC thread and this takes `db_read`'s mutex.
#[tauri::command]
pub async fn oracle_tags_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<OracleTagStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || super::status_of(&ORACLE, &state))
        .await
        .map_err(|e| format!("could not read the oracle tag status: {e}"))
}

/// Every tag each of `oracle_ids` holds, inherited ones included — one entry per id, in the
/// order asked, empty for a card the taxonomy says nothing about.
///
/// Read through `db_read` like every other read, so a decklist import answers during a sync
/// rather than queueing behind the ingest.
#[tauri::command]
pub async fn oracle_tags_for_cards(
    state: tauri::State<'_, Arc<AppState>>,
    oracle_ids: Vec<String>,
) -> Result<Vec<CardTags>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        read_card_tags(&conn, &oracle_ids).map_err(|e| format!("could not read the tags: {e}"))
    })
    .await
    .map_err(|e| format!("could not read the tags: {e}"))?
}

/// The same answer as [`oracle_tags_for_cards`], asked with **printing** ids — one entry per
/// requested `cards.id`, in the order asked, empty for anything the taxonomy (or the corpus)
/// says nothing about.
///
/// This is the one most of the app wants: a quick add, every drag source and a resolved
/// decklist line all hold a printing id, and `CardSummary` carries no oracle id at all.
#[tauri::command]
pub async fn oracle_tags_for_printings(
    state: tauri::State<'_, Arc<AppState>>,
    card_ids: Vec<String>,
) -> Result<Vec<PrintingTags>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        read_printing_tags(&conn, &card_ids).map_err(|e| format!("could not read the tags: {e}"))
    })
    .await
    .map_err(|e| format!("could not read the tags: {e}"))?
}

/// Refresh the taxonomy at startup if it is due.
///
/// **Silent, best-effort and never blocking** — [`super::refresh_if_due`]'s contract. The
/// honest fallback here is categorising by card type, exactly as the app did before this file
/// existed; neither the launch nor the card sync may ever wait on it.
pub async fn refresh_if_due(state: &Arc<AppState>, app: &tauri::AppHandle) {
    super::refresh_if_due(&ORACLE, state, app).await
}
#[cfg(test)]
mod tests {
    use super::*;
    // The engine these bindings drive. The parser, the walk, the staged write and the swap
    // all live one module up, and the tests below reach them through `ORACLE` — which is
    // also the only way a caller ever should.
    use crate::tags::testing::{gz_fixture, mem_db};
    use crate::tags::*;
    use flate2::{write::GzEncoder, Compression};
    use rusqlite::{params, Connection};
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    /// One tag line. `parents` are uuids; `cards` are oracle ids.
    fn tag(id: &str, slug: &str, parents: &[&str], cards: &[&str]) -> String {
        let parents = parents
            .iter()
            .map(|p| format!("\"{p}\""))
            .collect::<Vec<_>>()
            .join(",");
        let taggings = cards
            .iter()
            .map(|c| format!("{{\"oracle_id\":\"{c}\",\"weight\":\"median\"}}"))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            r#"{{"object":"tag","id":"{id}","label":"{slug}","slug":"{slug}","type":"oracle","description":"About {slug}.","parent_ids":[{parents}],"child_ids":[],"aliases":[],"taggings":[{taggings}]}}"#
        )
    }

    fn ingest(db: &Mutex<Connection>, lines: &[&str]) -> Result<TagStats, TagError> {
        let p = gz_fixture(lines);
        ingest_gz(
            &ORACLE,
            db,
            &p,
            &FileStamp::default(),
            1_800_000_000,
            &mut |_| {},
        )
    }

    /// Every slug stored for one card, sorted — which is what an assertion about the closure
    /// actually wants to read.
    fn slugs_for(db: &Mutex<Connection>, oracle_id: &str) -> Vec<String> {
        let conn = crate::db::lock_blocking(db);
        read_card_tags(&conn, &[oracle_id.to_owned()])
            .unwrap()
            .pop()
            .map(|t| t.slugs)
            .unwrap_or_default()
    }

    // ---- the file -------------------------------------------------------------------

    /// The shape of a real line, field by field. Everything this app stores comes off this
    /// one function, so a rename on Scryfall's side has to fail here and not silently
    /// somewhere downstream.
    #[test]
    fn a_tag_line_parses_into_its_slug_parents_and_taggings() {
        let line = r#"{"object":"tag","id":"a1","label":"Tutor Battle","slug":"tutor-battle","type":"oracle","uri":"https://api.scryfall.com/x","description":"Cards that tutor battle cards.","parent_ids":["p1","p2"],"child_ids":["c1"],"aliases":[],"taggings":[{"oracle_id":"oid-1","weight":"median"},{"oracle_id":"oid-2","weight":"median","annotation":"sort of"}]}"#;
        let v: serde_json::Value = serde_json::from_str(line).unwrap();

        let tag = parse_tag_line(&ORACLE, &v).expect("a tag object must parse");

        assert_eq!(tag.id, "a1");
        assert_eq!(tag.slug, "tutor-battle");
        assert_eq!(tag.label, "Tutor Battle");
        assert_eq!(
            tag.description.as_deref(),
            Some("Cards that tutor battle cards.")
        );
        // Both parents, in file order. Reading only the first is the one decision this
        // module makes twice over, and it is not made here.
        assert_eq!(tag.parent_ids, vec!["p1".to_owned(), "p2".to_owned()]);
        assert_eq!(
            tag.taggings,
            vec![
                TaggingLine {
                    subject: "oid-1".into(),
                    weight: Some("median".into()),
                    annotation: None,
                },
                TaggingLine {
                    subject: "oid-2".into(),
                    weight: Some("median".into()),
                    annotation: Some("sort of".into()),
                },
            ]
        );
    }

    /// The four ways a line is *not* a tag this app can act on. Each is stepped over rather
    /// than guessed at: a blank slug is not a primary key, and a blank id is a value every
    /// unresolved `parent_ids` entry would otherwise match.
    #[test]
    fn a_line_this_app_cannot_act_on_parses_to_nothing() {
        for line in [
            // Not a tag object at all.
            r#"{"object":"card","id":"a1","slug":"bolt"}"#,
            // No id: `parent_ids` are matched against it.
            r#"{"object":"tag","slug":"ramp","label":"Ramp"}"#,
            r#"{"object":"tag","id":"  ","slug":"ramp"}"#,
            // No slug: the primary key of four tables.
            r#"{"object":"tag","id":"a1","label":"Ramp"}"#,
        ] {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            assert!(
                parse_tag_line(&ORACLE, &v).is_none(),
                "must not parse: {line}"
            );
        }

        // A tag with no parents, no taggings and no description is a real tag — a brand new
        // root nobody has used yet — and must parse.
        let bare: serde_json::Value =
            serde_json::from_str(r#"{"object":"tag","id":"a1","slug":"ramp"}"#).unwrap();
        let tag = parse_tag_line(&ORACLE, &bare).unwrap();
        assert_eq!(tag.label, "ramp", "the slug stands in for a missing label");
        assert!(tag.parent_ids.is_empty() && tag.taggings.is_empty());
    }

    // ---- the walk -------------------------------------------------------------------

    /// Build a graph from `(slug, parent indices)` pairs, which is what the walk actually
    /// takes — the file's uuids are already resolved by then.
    fn graph(shape: &[(&str, &[u32])]) -> Vec<Tag> {
        shape
            .iter()
            .map(|(slug, parents)| Tag {
                // The uuid is the file's own join key, resolved to indices before the walk
                // runs; nothing below this line reads it.
                id: String::new(),
                slug: (*slug).to_owned(),
                label: (*slug).to_owned(),
                description: None,
                parents: parents.to_vec(),
            })
            .collect()
    }

    fn closure_slugs(tags: &[Tag], of: usize) -> Vec<String> {
        let mut slugs: Vec<String> = ancestor_closures(tags)[of]
            .iter()
            .map(|&i| tags[i as usize].slug.clone())
            .collect();
        slugs.sort();
        slugs
    }

    /// **684 of 4 521 tags have more than one parent, and both ancestries count.** A walk
    /// that followed `parent_ids[0]` would return `tutor` and `interaction` here and lose
    /// `battle-matters` and `permanent-matters` — the card would silently vanish from half
    /// the categories it belongs to, and nothing downstream could tell.
    #[test]
    fn a_tag_with_two_parents_inherits_both_ancestries() {
        // 0 interaction ← 1 tutor ┐
        //                          ├── 3 tutor-battle
        // 2 battle-matters ────────┘   (and 2's own parent, 4)
        let tags = graph(&[
            ("interaction", &[]),
            ("tutor", &[0]),
            ("battle-matters", &[4]),
            ("tutor-battle", &[1, 2]),
            ("permanent-matters", &[]),
        ]);

        assert_eq!(
            closure_slugs(&tags, 3),
            vec![
                "battle-matters".to_owned(),
                "interaction".to_owned(),
                "permanent-matters".to_owned(),
                "tutor".to_owned(),
                "tutor-battle".to_owned(),
            ],
            "both lineages, to their roots, plus the tag itself"
        );
        // And a root is still its own closure — never empty, or a card holding only root
        // tags would come back untagged.
        assert_eq!(closure_slugs(&tags, 0), vec!["interaction".to_owned()]);
    }

    /// Today's file has no cycles. Nothing promises tomorrow's will not, and the failure
    /// would be a background thread spinning forever with no window to say so in — so the
    /// walk carries its own `seen` set and this is what proves it.
    #[test]
    fn a_cycle_terminates_instead_of_hanging() {
        // a → b → c → a, plus a tag hanging off the loop.
        let tags = graph(&[("a", &[2]), ("b", &[0]), ("c", &[1]), ("leaf", &[0])]);

        assert_eq!(
            closure_slugs(&tags, 3),
            vec![
                "a".to_owned(),
                "b".to_owned(),
                "c".to_owned(),
                "leaf".to_owned()
            ],
            "every member of the loop, once each"
        );
        // A one-node self-loop is the degenerate case and must not spin either. (The ingest
        // drops that edge before it gets here; the walk does not depend on it having.)
        let selfish = graph(&[("a", &[0])]);
        assert_eq!(closure_slugs(&selfish, 0), vec!["a".to_owned()]);
    }

    // ---- the ingest -----------------------------------------------------------------

    /// End to end over a small file: the tags, the edges, the taggings and the closure all
    /// land, and a card inherits its tag's ancestors.
    #[test]
    fn an_ingest_stores_the_tags_the_edges_and_the_flattened_closure() {
        let db = mem_db();
        let stats = ingest(
            &db,
            &[
                &tag("p1", "tutor", &[], &[]),
                &tag("p2", "battle-matters", &[], &["oid-2"]),
                &tag("a1", "tutor-battle", &["p1", "p2"], &["oid-1"]),
            ],
        )
        .unwrap();

        assert_eq!(stats.tags, 3);
        assert_eq!(stats.taggings, 2);
        assert_eq!(stats.dangling_parents, 0);

        // The card holding the child tag holds all three; the card holding a root holds one.
        assert_eq!(
            slugs_for(&db, "oid-1"),
            vec![
                "battle-matters".to_owned(),
                "tutor".to_owned(),
                "tutor-battle".to_owned()
            ]
        );
        assert_eq!(slugs_for(&db, "oid-2"), vec!["battle-matters".to_owned()]);
        assert_eq!(stats.closure_rows, 4);

        let conn = crate::db::lock_blocking(&db);
        // The facts the closure was computed from are kept: what the card was *directly*
        // tagged with, and the hierarchy that was walked.
        let direct: Vec<String> = conn
            .prepare("SELECT slug FROM oracle_taggings WHERE oracle_id='oid-1'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(direct, vec!["tutor-battle".to_owned()]);

        let edges: Vec<(String, String)> = conn
            .prepare("SELECT child_slug, parent_slug FROM oracle_tag_parents ORDER BY parent_slug")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            edges,
            vec![
                ("tutor-battle".to_owned(), "battle-matters".to_owned()),
                ("tutor-battle".to_owned(), "tutor".to_owned()),
            ],
            "both edges, not just the first"
        );

        // The label and description came off the line, and `weight` was stored verbatim.
        let (label, description, weight): (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT t.label, t.description, g.weight
                   FROM oracle_tags t JOIN oracle_taggings g ON g.slug = t.slug
                  WHERE t.slug = 'tutor-battle'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(label, "tutor-battle");
        assert_eq!(description.as_deref(), Some("About tutor-battle."));
        assert_eq!(weight.as_deref(), Some("median"));

        // And the watermark landed with the rows.
        let (tags_stored, taggings_stored): (i64, i64) = conn
            .query_row(
                "SELECT tag_count, tagging_count FROM oracle_tag_meta WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((tags_stored, taggings_stored), (3, 2));
    }

    /// **A parent id the file never defines is tolerated, counted, and costs the tag nothing
    /// else.** Today's file has none; a tag Scryfall deletes while a child still points at it
    /// would produce one, and the answer must be "that tag has one fewer ancestor", never a
    /// failed refresh or a panic on an index that is not there.
    #[test]
    fn a_dangling_parent_id_is_counted_and_stepped_over() {
        let db = mem_db();
        let stats = ingest(
            &db,
            &[
                &tag("p1", "tutor", &[], &[]),
                &tag("a1", "tutor-battle", &["p1", "ghost"], &["oid-1"]),
            ],
        )
        .unwrap();

        assert_eq!(stats.dangling_parents, 1);
        assert_eq!(stats.tags, 2, "the tag itself is unaffected");
        assert_eq!(
            slugs_for(&db, "oid-1"),
            vec!["tutor".to_owned(), "tutor-battle".to_owned()],
            "the parent that exists is still inherited"
        );

        let edges: i64 = crate::db::lock_blocking(&db)
            .query_row("SELECT count(*) FROM oracle_tag_parents", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            edges, 1,
            "an edge to a tag that does not exist is not stored"
        );
    }

    /// A cycle in the *file* — not just in a hand-built graph — must ingest and terminate.
    #[test]
    fn a_cycle_in_the_file_ingests_without_hanging() {
        let db = mem_db();
        let stats = ingest(
            &db,
            &[
                &tag("a", "alpha", &["c"], &[]),
                &tag("b", "beta", &["a"], &[]),
                &tag("c", "gamma", &["b"], &["oid-1"]),
            ],
        )
        .unwrap();

        assert_eq!(stats.tags, 3);
        assert_eq!(
            slugs_for(&db, "oid-1"),
            vec!["alpha".to_owned(), "beta".to_owned(), "gamma".to_owned()],
            "every member of the loop, once each"
        );
    }

    /// [`crate::ingest`]'s rule: Scryfall's bulk files have held truncated lines and objects
    /// this app does not know, and one of those must not cost the user the whole taxonomy.
    #[test]
    fn a_malformed_line_is_skipped_rather_than_fatal() {
        let db = mem_db();
        let stats = ingest(
            &db,
            &[
                &tag("a1", "ramp", &[], &["oid-1"]),
                "NOT JSON",
                r#"{"object":"card","id":"x"}"#,
                r#"{"object":"tag","id":"b1"}"#, // no slug
                &tag("c1", "removal", &[], &["oid-2"]),
            ],
        )
        .unwrap();

        assert_eq!(stats.tags, 2);
        assert_eq!(stats.skipped_lines, 3);
        assert_eq!(slugs_for(&db, "oid-1"), vec!["ramp".to_owned()]);
        assert_eq!(slugs_for(&db, "oid-2"), vec!["removal".to_owned()]);
    }

    /// A gzipped error page, the wrong dataset, a file of nothing but cards — each decodes
    /// fine and yields zero tags. Swapping that in would trade a working taxonomy for an
    /// empty one, so it is refused outright and the previous rows are left alone.
    #[test]
    fn a_file_with_no_tags_refuses_to_swap() {
        let db = mem_db();
        ingest(&db, &[&tag("a1", "ramp", &[], &["oid-1"])]).unwrap();

        let err = ingest(
            &db,
            &["<html>Service Unavailable</html>", r#"{"object":"card"}"#],
        )
        .unwrap_err();
        assert!(
            matches!(err, TagError::Empty { skipped: 2 }),
            "expected Empty {{ skipped: 2 }}, got {err:?}"
        );

        assert_eq!(
            slugs_for(&db, "oid-1"),
            vec!["ramp".to_owned()],
            "an empty file must not touch the live tables"
        );
        let staging: i64 = crate::db::lock_blocking(&db)
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name LIKE 'oracle_tag%_staging'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(staging, 0, "the empty staging tables are dropped, not left");

        // The refusal costs the connection nothing: a real ingest still swaps.
        let stats = ingest(&db, &[&tag("b1", "removal", &[], &["oid-2"])]).unwrap();
        assert_eq!(stats.tags, 1);
        assert_eq!(slugs_for(&db, "oid-1"), Vec::<String>::new());
        assert_eq!(slugs_for(&db, "oid-2"), vec!["removal".to_owned()]);
    }

    /// **The two columns schema v20 added, and the one way this whole feature fails
    /// silently.** `slug_norm` is what a typed needle is compared against — normalised on
    /// both sides, so a column left empty here is a search that matches nothing with no
    /// error anywhere, and `idx_oracle_tags_norm` indexing one value. `id` is Scryfall's
    /// uuid, which is what a mute is keyed on: their docs say not to treat slugs or labels
    /// as permanent identifiers, so a mute keyed on a slug un-mutes itself the week Tagger
    /// renames the tag.
    #[test]
    fn the_ingest_stores_the_uuid_and_the_normalised_slug() {
        let db = mem_db();
        ingest(&db, &[&tag("a1", "Spot-Removal", &[], &["oid-1"])]).unwrap();
        let conn = crate::db::lock_blocking(&db);

        let (id, norm): (String, String) = conn
            .query_row(
                "SELECT id, slug_norm FROM oracle_tags WHERE slug = 'Spot-Removal'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();

        assert_eq!(id, "a1", "Scryfall's uuid, verbatim");
        assert_eq!(
            norm, "spotremoval",
            "`normalize`'s answer, which is what the search compares against"
        );
    }

    /// A refresh **replaces**, so a tag Scryfall retires stops being an answer. The staging
    /// swap is what makes that true; appending would leave every tag a card has ever held.
    #[test]
    fn a_second_ingest_replaces_the_first_rather_than_adding_to_it() {
        let db = mem_db();
        ingest(
            &db,
            &[
                &tag("p1", "tutor", &[], &[]),
                &tag("a1", "tutor-battle", &["p1"], &["oid-1"]),
            ],
        )
        .unwrap();

        // Scryfall renames the child and drops the parent link.
        ingest(&db, &[&tag("a1", "tutor-battles", &[], &["oid-1"])]).unwrap();

        assert_eq!(slugs_for(&db, "oid-1"), vec!["tutor-battles".to_owned()]);
        let tags: i64 = crate::db::lock_blocking(&db)
            .query_row("SELECT count(*) FROM oracle_tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            tags, 1,
            "the retired tag is gone, not kept beside the new one"
        );
    }

    /// A file that never opens must not cost the caller the staging tables it was about to
    /// fill — [`crate::ingest`]'s ordering, for its reason.
    #[test]
    fn a_missing_file_fails_before_touching_staging() {
        let db = mem_db();
        ingest(&db, &[&tag("a1", "ramp", &[], &["oid-1"])]).unwrap();

        let missing = std::env::temp_dir().join("mtgtest-tags-does-not-exist.jsonl.gz");
        let _ = std::fs::remove_file(&missing);
        let err = ingest_gz(
            &ORACLE,
            &db,
            &missing,
            &FileStamp::default(),
            1_800_000_000,
            &mut |_| {},
        )
        .unwrap_err();
        assert!(
            matches!(err, TagError::Io(_)),
            "expected io error, got {err:?}"
        );
        assert_eq!(slugs_for(&db, "oid-1"), vec!["ramp".to_owned()]);
    }

    /// The whole point of batching. The ingest writes hundreds of thousands of rows, and
    /// holding the write connection for all of them is what turns a collection edit made
    /// during a refresh into a frozen button — [`crate::ingest`]'s measured lesson.
    ///
    /// The probe runs on another thread, as a command would, and only counts a lock it wins
    /// *while the ingest is demonstrably running*: between the first progress callback (a
    /// batch has committed) and the ingest returning. Without that window an ingest that held
    /// the connection end to end would simply make the probe wait and then collect its locks
    /// from an idle mutex.
    #[test]
    fn a_writer_gets_the_connection_between_batches() {
        use std::sync::atomic::AtomicUsize;

        // A file-backed database, as the app has: an in-memory one writes far faster than
        // the probe below can ask, which would make the count a measure of the fixture
        // rather than of the locking.
        let dir = std::env::temp_dir().join("mtgtest-oracle-tags-chunked");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("mtg.db")).unwrap();
        crate::schema::migrate(&conn).unwrap();
        let db = Mutex::new(conn);

        // Ten batches of taggings and as many again of closure rows, so the run has plenty
        // of release points left once counting opens.
        let cards: Vec<String> = (0..BATCH * 10).map(|i| format!("oid-{i}")).collect();
        let refs: Vec<&str> = cards.iter().map(String::as_str).collect();
        let lines = [
            tag("p1", "tutor", &[], &[]),
            tag("a1", "tutor-battle", &["p1"], &refs),
        ];
        let p = gz_fixture(&[lines[0].as_str(), lines[1].as_str()]);

        let taken = AtomicUsize::new(0);
        let ingesting = AtomicBool::new(false);
        let done = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                while taken.load(Ordering::SeqCst) < 3 && !done.load(Ordering::SeqCst) {
                    let won =
                        crate::db::lock_for(&db, std::time::Duration::from_millis(200)).is_some();
                    if won && ingesting.load(Ordering::SeqCst) && !done.load(Ordering::SeqCst) {
                        taken.fetch_add(1, Ordering::SeqCst);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            });
            let stats = ingest_gz(
                &ORACLE,
                &db,
                &p,
                &FileStamp::default(),
                1_800_000_000,
                &mut |_| ingesting.store(true, Ordering::SeqCst),
            );
            // Set before any assertion: a panic here must still release the probe, or the
            // scope would join a thread that never leaves its loop.
            done.store(true, Ordering::SeqCst);
            assert_eq!(stats.unwrap().taggings, BATCH as u64 * 10);
        });

        assert!(
            taken.load(Ordering::SeqCst) >= 3,
            "a writer must be able to take the connection while the ingest is running, \
             and took it {} times",
            taken.load(Ordering::SeqCst)
        );
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- the read path ---------------------------------------------------------------

    /// One round trip for a whole decklist, and the contract that makes it usable: one entry
    /// per id, in the order asked, empty for a card the taxonomy says nothing about.
    #[test]
    fn the_read_path_answers_every_id_it_was_asked_about() {
        let db = mem_db();
        ingest(
            &db,
            &[
                &tag("p1", "tutor", &[], &[]),
                &tag("a1", "tutor-battle", &["p1"], &["oid-1"]),
                &tag("b1", "ramp", &[], &["oid-2"]),
            ],
        )
        .unwrap();
        let conn = crate::db::lock_blocking(&db);

        let asked = [
            "oid-2".to_owned(),
            "oid-untagged".to_owned(),
            "oid-1".to_owned(),
            // A repeat and a blank: both dropped rather than answered twice or with a row
            // that can match nothing.
            "oid-2".to_owned(),
            "   ".to_owned(),
        ];
        let got = read_card_tags(&conn, &asked).unwrap();

        assert_eq!(
            got,
            vec![
                CardTags {
                    oracle_id: "oid-2".into(),
                    slugs: vec!["ramp".into()]
                },
                CardTags {
                    oracle_id: "oid-untagged".into(),
                    // Present and empty, which is a different answer from absent: the caller
                    // can tell "no tags" from "never asked".
                    slugs: vec![]
                },
                CardTags {
                    oracle_id: "oid-1".into(),
                    slugs: vec!["tutor".into(), "tutor-battle".into()]
                },
            ]
        );
    }

    /// The chunking is invisible: a list longer than [`LOOKUP_CHUNK`] answers exactly as a
    /// short one does. Written against a list that crosses the boundary twice, because an
    /// off-by-one in `chunks` would drop or duplicate exactly the rows at the seams.
    #[test]
    fn a_list_longer_than_one_chunk_still_answers_every_id() {
        let db = mem_db();
        let cards: Vec<String> = (0..LOOKUP_CHUNK * 2 + 7)
            .map(|i| format!("oid-{i}"))
            .collect();
        let refs: Vec<&str> = cards.iter().map(String::as_str).collect();
        let line = tag("a1", "ramp", &[], &refs);
        ingest(&db, &[line.as_str()]).unwrap();
        let conn = crate::db::lock_blocking(&db);

        let got = read_card_tags(&conn, &cards).unwrap();

        assert_eq!(got.len(), cards.len());
        assert!(
            got.iter().all(|c| c.slugs == vec!["ramp".to_owned()]),
            "every id in every chunk must come back tagged"
        );
        assert_eq!(got[0].oracle_id, cards[0], "and in the order asked");
        assert_eq!(got[cards.len() - 1].oracle_id, cards[cards.len() - 1]);
    }

    /// Seed printings the printing-keyed read path can resolve. `oracle_id` is nullable in
    /// this schema, and `None` here is a real state: an old row, or a `reversible_card` whose
    /// top-level id Scryfall omits.
    fn seed_printings(db: &Mutex<Connection>, rows: &[(&str, Option<&str>)]) {
        let conn = crate::db::lock_blocking(db);
        for (id, oracle_id) in rows {
            conn.execute(
                "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang,
                                    layout, raw)
                 VALUES (?1, ?2, 'Card', 'x', '1', 'en', 'normal', '{}')",
                params![id, oracle_id],
            )
            .unwrap();
        }
    }

    /// **Most of the app holds a printing id, not an oracle id** — the quick add, all four
    /// drag sources, and every resolved decklist line — so this is the read path that gets
    /// used. It answers exactly what the oracle-keyed one does, keyed the other way, and the
    /// contract is the same: one entry per requested id, in the order asked.
    #[test]
    fn the_printing_read_path_answers_every_id_it_was_asked_about() {
        let db = mem_db();
        ingest(
            &db,
            &[
                &tag("p1", "tutor", &[], &[]),
                &tag("a1", "tutor-battle", &["p1"], &["oid-1"]),
                &tag("b1", "ramp", &[], &["oid-2"]),
            ],
        )
        .unwrap();
        seed_printings(
            &db,
            &[
                ("print-1a", Some("oid-1")),
                // A second printing of the same card: a tag is a fact about the oracle text,
                // so both must answer the same slugs.
                ("print-1b", Some("oid-1")),
                ("print-2", Some("oid-2")),
                ("print-untagged", Some("oid-nobody-tagged")),
                // `cards.oracle_id` is NULLABLE, and a row with none can join to nothing.
                ("print-no-oracle", None),
            ],
        );
        let conn = crate::db::lock_blocking(&db);

        let asked = [
            "print-2".to_owned(),
            "print-1b".to_owned(),
            // Never in `cards` at all — the orphan case, which a deck row can genuinely be.
            "print-gone".to_owned(),
            "print-no-oracle".to_owned(),
            "print-1a".to_owned(),
            "print-untagged".to_owned(),
            // A repeat and a blank, dropped as they are on the other path.
            "print-1a".to_owned(),
            "  ".to_owned(),
        ];
        let got = read_printing_tags(&conn, &asked).unwrap();

        assert_eq!(
            got,
            vec![
                PrintingTags {
                    card_id: "print-2".into(),
                    slugs: vec!["ramp".into()]
                },
                PrintingTags {
                    card_id: "print-1b".into(),
                    slugs: vec!["tutor".into(), "tutor-battle".into()]
                },
                // Unknown card, NULL oracle id and untagged card are indistinguishable, and
                // that is the contract: all three mean "fall back to the type line". None of
                // them is an error, because nothing about categorising may fail a deck add.
                PrintingTags {
                    card_id: "print-gone".into(),
                    slugs: vec![]
                },
                PrintingTags {
                    card_id: "print-no-oracle".into(),
                    slugs: vec![]
                },
                PrintingTags {
                    card_id: "print-1a".into(),
                    slugs: vec!["tutor".into(), "tutor-battle".into()]
                },
                PrintingTags {
                    card_id: "print-untagged".into(),
                    slugs: vec![]
                },
            ]
        );
        // Both printings of one card answered the same thing, which is the whole reason this
        // path can exist at all.
        assert_eq!(got[1].slugs, got[4].slugs);
    }

    /// **One query per chunk, and no table scan in it.** The decklist import asks about a
    /// hundred printings at once, and this crate has already paid once for a plan that read
    /// `SCAN c` where it meant to read an index — `deck_import`'s 46 s. `cards.id` is the
    /// primary key and `oracle_id` carries `idx_cards_oracle`, so both sides of this join are
    /// searched, never scanned.
    #[test]
    fn the_printing_lookup_is_searched_not_scanned() {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();

        let sql = BY_PRINTING_ID.replace("{holes}", "?,?");
        let plan: Vec<String> = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            // Bound even though nothing runs: the planner is asked about *this* statement,
            // and rusqlite refuses a parameter count that does not match.
            .query_map(params!["print-1", "print-2"], |r| r.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();

        assert!(
            !plan.iter().any(|step| step.starts_with("SCAN")),
            "no step of this plan may scan a table: {plan:#?}"
        );
        assert!(
            plan.iter().any(|step| step.starts_with("SEARCH c")),
            "the printing is a primary-key lookup: {plan:#?}"
        );
        assert!(
            plan.iter().any(|step| step.starts_with("SEARCH t")),
            "and its tags a prefix scan of the closure's own key: {plan:#?}"
        );
    }

    /// An empty request is answered without asking the database anything — which matters
    /// because the caller is a render path that may well have nothing to ask about yet.
    /// Proven against a connection with **no schema at all**: any statement would fail with
    /// "no such table", so an `Ok(vec![])` is evidence that none was prepared.
    #[test]
    fn an_empty_request_never_touches_the_database() {
        let bare = Connection::open_in_memory().unwrap();

        assert_eq!(read_card_tags(&bare, &[]).unwrap(), vec![]);
        assert_eq!(read_printing_tags(&bare, &[]).unwrap(), vec![]);
        // And a request of nothing but blanks is the same request.
        assert_eq!(
            read_printing_tags(&bare, &["   ".to_owned()]).unwrap(),
            vec![]
        );
    }

    /// The printing path's DTO names the id it actually carries. Echoing a `cards.id` back in
    /// a field called `oracleId` would be a lie the caller has no way to notice, so the two
    /// read paths answer two types.
    #[test]
    fn the_printing_dto_names_the_id_it_carries() {
        let json = serde_json::to_value(PrintingTags {
            card_id: "print-1".into(),
            slugs: vec!["ramp".into()],
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"cardId": "print-1", "slugs": ["ramp"]})
        );
    }

    /// Before the first refresh there is no taxonomy, and the read path has to say so rather
    /// than fail: the app falls back to card types, which is what it did before this module
    /// existed.
    #[test]
    fn an_empty_database_answers_empty_rather_than_failing() {
        let db = mem_db();
        let conn = crate::db::lock_blocking(&db);

        assert_eq!(
            read_card_tags(&conn, &["oid-1".to_owned()]).unwrap(),
            vec![CardTags {
                oracle_id: "oid-1".into(),
                slugs: vec![]
            }]
        );
        // The printing path too: this is what a deck add asks before any refresh has run,
        // and `oracle_tags_status` is the thing the UI would have to guard if either failed.
        assert_eq!(
            read_printing_tags(&conn, &["print-1".to_owned()]).unwrap(),
            vec![PrintingTags {
                card_id: "print-1".into(),
                slugs: vec![]
            }]
        );

        let status = read_status(&ORACLE, &conn, 1_800_000_000);
        assert_eq!(status.ingested_at, None, "never ingested");
        assert_eq!(status.checked_at, None);
        assert!(status.stale, "and stale by definition");
        assert_eq!(status.tag_count, None);
        assert_eq!(status.tagging_count, None);
        assert_eq!(status.updated_at, None);
        // `refreshing` is deliberately not asserted here. It reads a **process-wide** static,
        // not this database — one refresh at a time means one per *application* — so a test
        // that does not own the flag can only assert it by getting lucky about which sibling
        // is running beside it. Asserting it here failed exactly that way, against the
        // end-to-end refresh test.
    }

    // ---- status ----------------------------------------------------------------------

    /// The watermark is what a re-run reads to decide whether to download at all.
    #[test]
    fn the_status_reports_the_file_the_rows_came_from() {
        let db = mem_db();
        let p = gz_fixture(&[&tag("a1", "ramp", &[], &["oid-1"])]);
        let stamp = FileStamp {
            etag: Some("W/\"abc\"".into()),
            updated_at: Some("2026-08-14T21:00:00Z".into()),
        };
        ingest_gz(&ORACLE, &db, &p, &stamp, 1_800_000_000, &mut |_| {}).unwrap();
        let conn = crate::db::lock_blocking(&db);

        let status = read_status(&ORACLE, &conn, 1_800_000_000);
        assert_eq!(status.updated_at.as_deref(), Some("2026-08-14T21:00:00Z"));
        assert_eq!(status.ingested_at, Some(1_800_000_000));
        // An ingest is also a check, so the two stamps start out equal; only a later 304
        // moves one without the other.
        assert_eq!(status.checked_at, Some(1_800_000_000));
        assert_eq!(status.tag_count, Some(1));
        assert_eq!(status.tagging_count, Some(1));
        assert!(!status.stale, "just ingested");

        // The ETag is stored for the next `If-None-Match`, and it is the one thing the status
        // deliberately does not publish: it is a cache key, not something to render.
        let (etag, populated): (Option<String>, bool) = (
            conn.query_row("SELECT etag FROM oracle_tag_meta WHERE id=1", [], |r| {
                r.get(0)
            })
            .unwrap(),
            closure_is_populated(&ORACLE, &conn),
        );
        assert_eq!(etag.as_deref(), Some("W/\"abc\""));
        assert!(populated);

        assert!(
            read_status(&ORACLE, &conn, 1_800_000_000 + REFRESH_INTERVAL_SECS).stale,
            "a week later it is due again"
        );
    }

    /// Never ingested is stale; so is a stamp from the future, which is a clock that moved
    /// rather than a reason to wait a week.
    #[test]
    fn staleness_survives_a_clock_that_moved() {
        assert!(is_stale(None, REFRESH_INTERVAL_SECS, 1_800_000_000));
        assert!(!is_stale(
            Some(1_800_000_000),
            REFRESH_INTERVAL_SECS,
            1_800_000_000
        ));
        assert!(!is_stale(
            Some(1_800_000_000),
            REFRESH_INTERVAL_SECS,
            1_800_000_000 + REFRESH_INTERVAL_SECS - 1
        ));
        assert!(is_stale(
            Some(1_800_000_000),
            REFRESH_INTERVAL_SECS,
            1_800_000_000 + REFRESH_INTERVAL_SECS
        ));
        assert!(
            is_stale(Some(1_800_000_100), REFRESH_INTERVAL_SECS, 1_800_000_000),
            "future stamp"
        );
    }

    /// The phases the frontend mirrors, and each really is what goes on the wire — a phase
    /// the TypeScript union does not know renders as `undefined` under the activity line.
    #[test]
    fn the_progress_phases_are_the_ones_the_frontend_mirrors() {
        assert_eq!(
            PHASES,
            ["checking", "downloading", "ingesting", "done", "error"]
        );
        for phase in PHASES {
            let json = serde_json::to_value(OracleTagProgress {
                phase: phase.to_owned(),
                done: 0,
                total: 0,
            })
            .unwrap();
            assert_eq!(json["phase"], phase);
        }
    }

    /// The DTO the frontend actually receives: camelCase keys, raw slugs, and **no category
    /// name, order or whitelist anywhere in it**. Rust supplies the fact; TypeScript draws
    /// the conclusion, and this is the line between them.
    #[test]
    fn the_card_tag_dto_is_camel_case_and_carries_nothing_but_slugs() {
        let json = serde_json::to_value(CardTags {
            oracle_id: "oid-1".into(),
            slugs: vec!["tutor".into(), "tutor-battle".into()],
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"oracleId": "oid-1", "slugs": ["tutor", "tutor-battle"]})
        );

        let status = serde_json::to_value(OracleTagStatus {
            updated_at: Some("2026-08-14T21:00:00Z".into()),
            ingested_at: Some(1_800_000_000),
            checked_at: Some(1_800_000_600),
            tag_count: Some(4521),
            tagging_count: Some(229_633),
            stale: false,
            refreshing: false,
        })
        .unwrap();
        assert_eq!(
            status,
            serde_json::json!({
                "updatedAt": "2026-08-14T21:00:00Z",
                "ingestedAt": 1_800_000_000i64,
                "checkedAt": 1_800_000_600i64,
                "tagCount": 4521,
                "taggingCount": 229_633,
                "stale": false,
                "refreshing": false
            })
        );
    }

    // ---- the fetch -------------------------------------------------------------------

    /// The manifest entry, through the *same* client the card sync uses — so this dataset
    /// shares Scryfall's pacing gate and its 429 lockout rather than opening a second budget.
    /// `jsonl_download_uri` and `compressed_size` and neither of the pre-2026-07-20
    /// `download_uri`/`size` fields, which is the shape measured live on 2026-08-14.
    #[tokio::test]
    async fn the_oracle_tag_manifest_entry_parses() {
        use httpmock::prelude::*;
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET)
                .path("/bulk-data/oracle_tags")
                .header("user-agent", crate::scryfall::USER_AGENT)
                .header_exists("accept");
            then.status(200)
                .header("etag", "W/\"tags\"")
                .json_body(serde_json::json!({
                    "object": "bulk_data",
                    "type": "oracle_tags",
                    "updated_at": "2026-08-14T21:00:00.000+00:00",
                    "jsonl_download_uri":
                        "https://data.scryfall.io/oracle-tags/oracle-tags-20260814.jsonl.gz",
                    "compressed_size": 6_133_248u64
                }));
        });
        let client = crate::scryfall::Client::new(server.base_url());

        let crate::scryfall::BulkCheck::Available(info) = client
            .check_bulk_dataset(crate::scryfall::BULK_ORACLE_TAGS, None)
            .await
            .unwrap()
        else {
            panic!("a 200 must parse as Available")
        };

        assert_eq!(info.compressed_size, 6_133_248);
        assert_eq!(info.updated_at, "2026-08-14T21:00:00.000+00:00");
        assert!(info.jsonl_download_uri.ends_with(".jsonl.gz"));
        assert_eq!(info.etag.as_deref(), Some("W/\"tags\""));
    }

    /// The stored ETag is replayed as `If-None-Match`, and a 304 is what makes a re-run cost
    /// zero bytes — the whole reason the watermark carries one.
    #[tokio::test]
    async fn a_matching_etag_costs_no_download() {
        use httpmock::prelude::*;
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET)
                .path("/bulk-data/oracle_tags")
                .header("if-none-match", "W/\"tags\"");
            then.status(304);
        });
        let client = crate::scryfall::Client::new(server.base_url());

        assert!(matches!(
            client
                .check_bulk_dataset(crate::scryfall::BULK_ORACLE_TAGS, Some("W/\"tags\""))
                .await
                .unwrap(),
            crate::scryfall::BulkCheck::NotModified
        ));
    }

    /// An `AppState` pointed at a scratch directory, a database of its own, and a Scryfall
    /// that is really a mock server — [`crate::marketplace_feed`]'s `test_state`, with the
    /// base URL injected, which is what lets the whole refresh be driven here.
    fn test_state(base_url: String) -> (Arc<AppState>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "mtgtest-tags-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("mtg.db")).unwrap();
        crate::schema::prepare_database(&conn).unwrap();
        let read = crate::db::open_read_only(&dir.join("mtg.db")).unwrap();
        (
            Arc::new(AppState {
                db: Mutex::new(conn),
                db_read: Mutex::new(read),
                data_dir: dir.clone(),
                syncing: AtomicBool::new(false),
                client: crate::scryfall::Client::new(base_url),
                images: crate::images::Cache::new(dir.join("images")),
                index: std::sync::RwLock::default(),
            }),
            dir,
        )
    }

    /// The gzipped bytes of a JSONL body, as the bulk origin serves them.
    fn gz_bytes(lines: &[&str]) -> Vec<u8> {
        let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
        for l in lines {
            enc.write_all(l.as_bytes()).unwrap();
            enc.write_all(b"\n").unwrap();
        }
        enc.finish().unwrap()
    }

    /// **The whole path, from the manifest entry to a stored closure — and then the 304 that
    /// makes the second run free.** The one test that proves the pieces are wired to each
    /// other: the check, the download against the size the manifest promised, the ingest, the
    /// swap, and the watermark that stops it all happening again.
    ///
    /// The second half is the reason `checked_at` exists. A 304 leaves the rows alone, so
    /// `ingestedAt` must not move — but something has to, or a taxonomy that is simply up to
    /// date is "due" again on the very next launch and spends one API call per start forever.
    #[tokio::test]
    async fn a_refresh_checks_downloads_ingests_and_then_304s() {
        use httpmock::prelude::*;
        let body = gz_bytes(&[
            &tag("p1", "tutor", &[], &[]),
            &tag("a1", "tutor-battle", &["p1"], &["oid-1"]),
        ]);
        let server = MockServer::start_async().await;
        let file = server.mock(|when, then| {
            when.method(GET).path("/oracle-tags.jsonl.gz");
            then.status(200).body(body.clone());
        });
        // The first check has no ETag to replay; the second does, and gets a 304.
        server.mock(|when, then| {
            when.method(GET)
                .path("/bulk-data/oracle_tags")
                .header_missing("if-none-match");
            then.status(200)
                .header("etag", "W/\"t1\"")
                .json_body(serde_json::json!({
                    "object": "bulk_data",
                    "type": "oracle_tags",
                    "updated_at": "2026-08-14T21:00:00.000+00:00",
                    "jsonl_download_uri": server.url("/oracle-tags.jsonl.gz"),
                    "compressed_size": body.len() as u64
                }));
        });
        let not_modified = server.mock(|when, then| {
            when.method(GET)
                .path("/bulk-data/oracle_tags")
                .header("if-none-match", "W/\"t1\"");
            then.status(304);
        });
        let (state, dir) = test_state(server.base_url());

        let mut phases: Vec<String> = Vec::new();
        let first = refresh(&ORACLE, &state, false, &mut |phase, _, _| {
            phases.push(phase.to_owned())
        })
        .await
        .unwrap();

        assert_eq!(phases.first().map(String::as_str), Some("checking"));
        assert_eq!(phases.last().map(String::as_str), Some("done"));
        assert!(
            phases.iter().any(|p| p == "downloading") && phases.iter().any(|p| p == "ingesting"),
            "a first run downloads and ingests: {phases:?}"
        );
        assert_eq!(first.tag_count, Some(2));
        assert_eq!(first.tagging_count, Some(1));
        assert_eq!(
            first.updated_at.as_deref(),
            Some("2026-08-14T21:00:00.000+00:00")
        );
        assert!(!first.stale);
        assert_eq!(
            slugs_for(&state.db, "oid-1"),
            vec!["tutor".to_owned(), "tutor-battle".to_owned()],
            "the closure the frontend reads is in place"
        );
        file.assert_calls(1);

        // Forced, because the throttle would otherwise short-circuit this without a request
        // at all — which is the *other* thing `checked_at` buys, and is not what this half is
        // measuring.
        let mut again: Vec<String> = Vec::new();
        let second = refresh(&ORACLE, &state, true, &mut |phase, _, _| {
            again.push(phase.to_owned())
        })
        .await
        .unwrap();

        assert_eq!(again, vec!["checking".to_owned(), "done".to_owned()]);
        not_modified.assert_calls(1);
        file.assert_calls(1); // and not a byte was downloaded again
        assert_eq!(
            second.ingested_at, first.ingested_at,
            "a 304 must not claim the rows were rebuilt"
        );
        assert!(
            second.checked_at >= first.checked_at,
            "but it is evidence the file has been asked about: {:?} then {:?}",
            first.checked_at,
            second.checked_at
        );
        assert_eq!(second.tag_count, Some(2), "and the rows are untouched");

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The card corpus's own call must keep asking for `default_cards` and nothing else:
    /// parameterising the endpoint is exactly the change that could have pointed the sync at
    /// the wrong file, and the failure would be a `cards` table full of tag objects.
    #[tokio::test]
    async fn the_card_sync_still_asks_for_default_cards() {
        use httpmock::prelude::*;
        let server = MockServer::start();
        let hit = server.mock(|when, then| {
            when.method(GET).path("/bulk-data/default_cards");
            then.status(304);
        });
        let client = crate::scryfall::Client::new(server.base_url());

        assert!(matches!(
            client.check_bulk_update(Some("W/\"x\"")).await.unwrap(),
            crate::scryfall::BulkCheck::NotModified
        ));
        hit.assert();
    }
}
