//! Scryfall's **Art Tags**: what an illustration *depicts*.
//!
//! `cards.type_line` says a card is a Creature — Hound. It does not say the picture is of a
//! dog asleep in front of a fire, and that is the sentence a themed deck is actually built in.
//! Scryfall's community-curated art taxonomy does, and publishes it as a bulk dataset keyed on
//! `illustration_id` — a column this database already carries on every printing, and the right
//! key rather than `oracle_id`: **an art tag is a fact about a picture, not about a card.** A
//! card printed with five illustrations has five, and the dog is in one of them.
//!
//! **The fetch, the parse, the graph walk, the staged write and the swap are [`super`]'s**,
//! along with the five rules that shape them. This module is the binding: [`ART`] names the
//! tables and the id, and the two commands wire it to the frontend.
//!
//! Everything below was measured live on 2026-08-20 against that day's file:
//!
//! | | |
//! | --- | --- |
//! | Manifest | `GET /bulk-data/art_tags` — id `48da5752-eeb6-4126-bf97-8829e20ad14f`, `jsonl_download_uri` + `compressed_size`, no `download_uri`/`size` |
//! | Payload | 12 544 874 bytes gzipped JSONL, one `tag` object per line |
//! | Tags | 11 531 · 3 219 roots · **4 970 with more than one parent (43 %)** · max depth 10 |
//! | Taggings | 475 163 over 52 349 distinct illustration ids |
//! | Closure | **951 499 rows — 2.0× the direct taggings** |
//! | `weight` | median 462 008 · strong 5 980 · weak 4 495 · very_strong 2 680 |
//!
//! # The hierarchy is the feature, not an optimisation
//!
//! The bulk file stores **direct** taggings only, and a category tag has none of its own. `dog`
//! is directly tagged on 137 illustrations and reaches **439** once its descendants are
//! followed; `dragon` goes 416 → 1 660. An implementation that read `art_taggings` instead of
//! the closure would return 31 % of the dogs and look, from the outside, exactly like one that
//! worked. That is what [`super::ancestor_closures`] is for, and why 43 % of tags having more
//! than one parent means every parent edge is followed rather than the first.
//!
//! **Nothing here may break a launch or a card sync.** A failure leaves the previous tags in
//! place and writes the reason to `error_log`; a database that has never fetched this file is
//! a supported state, and the app it describes is the app before this module existed.

use super::{Dataset, TagStatus};
use crate::sync::AppState;
use std::sync::Arc;

/// The event a refresh reports itself through.
///
/// **Its own channel rather than the oracle one**, for [`super::Dataset::progress_event`]'s
/// reason: the two taxonomies are separate files on separate schedules and either may be
/// refreshing while the other is, so one shared line would have them fighting over it. The
/// phase names on it are [`super::PHASES`], the same five.
pub const PROGRESS_EVENT: &str = "art-tags:progress";

/// How long an ingested art tag file stays fresh.
///
/// **The same week the oracle taxonomy gets, for the same reason.** Scryfall regenerates the
/// file daily, but it is hand-curated and moves in increments — a tag here or there against
/// 11 531 — so re-downloading and re-flattening 475 163 taggings into 951 499 closure rows
/// every morning would buy almost nothing. It is also the *stabler* answer for a reader: an
/// art theme they are building a deck around should not quietly re-rank itself between two
/// sessions on the same afternoon.
///
/// The ETag makes a check that finds nothing cost zero bytes either way, and
/// [`art_tags_refresh`]'s `force` is the way past this for anyone who wants today's file.
pub const REFRESH_INTERVAL_SECS: i64 = 7 * 86_400;

/// Scryfall's Art Tags — what an illustration *depicts*.
///
/// The one place the art taxonomy's tables, columns and schedule are written down; everything
/// above and below reaches [`super`] through it.
pub const ART: Dataset = Dataset {
    bulk_name: crate::scryfall::BULK_ART_TAGS,
    label: "Art tags",
    subject_column: "illustration_id",
    tags_table: "art_tags",
    parents_table: "art_tag_parents",
    taggings_table: "art_taggings",
    closure_table: "art_tag_illustrations",
    meta_table: "art_tag_meta",
    progress_event: PROGRESS_EVENT,
    refresh_interval_secs: REFRESH_INTERVAL_SECS,
    tmp_file: "art-tags.jsonl.gz",
    // **The one dataset that sets this.** Art taggings use the full scale — median 462 008,
    // strong 5 980, weak 4 495, very_strong 2 680 on 2026-08-20 — where oracle taggings are
    // 99.74 % median with `strong` occurring exactly once in the entire file. So a weight
    // means something here and nothing there, and `art_tag_illustrations.weight` is the
    // column `super::write_closure` folds `super::stronger` into.
    carries_weight: true,
    create_staging: crate::schema::create_art_tag_staging,
    drop_staging: crate::schema::drop_art_tag_staging,
    swap_staging: crate::schema::swap_art_tag_staging,
};

/// [`TagStatus`] under this dataset's name, as the frontend's own type mirrors it. The shape
/// is the engine's and is identical for every taxonomy; only the noun in front of it is art's.
pub type ArtTagStatus = TagStatus;

/// Payload of [`PROGRESS_EVENT`] — [`super::TagProgress`], under the name the frontend knows.
pub type ArtTagProgress = super::TagProgress;

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// Download the Art Tags file if it has changed and rebuild the taxonomy from it.
///
/// `force` skips the weekly throttle, not the ETag check.
#[tauri::command]
pub async fn art_tags_refresh(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    force: bool,
) -> Result<ArtTagStatus, String> {
    let state = state.inner().clone();
    super::refresh(&ART, &state, force, &mut |phase, done, total| {
        super::emit(&ART, &app, phase, done, total)
    })
    .await
}

/// Whether there is an art taxonomy, which file it came from, and how old it is.
///
/// `async`, and answered on the blocking pool, because a sync command body runs inline on the
/// IPC thread and this takes `db_read`'s mutex.
#[tauri::command]
pub async fn art_tags_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ArtTagStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || super::status_of(&ART, &state))
        .await
        .map_err(|e| format!("could not read the art tag status: {e}"))
}

/// Refresh the taxonomy at startup if it is due.
///
/// **Silent, best-effort and never blocking** — [`super::refresh_if_due`]'s contract. The
/// honest fallback here is a Tags page that says it has nothing yet, which is what a database
/// that has never fetched this file has; neither the launch, the card sync nor the *oracle*
/// refresh may ever wait on it, and 12.5 MB is the reason that last one is worth saying.
pub async fn refresh_if_due(state: &Arc<AppState>, app: &tauri::AppHandle) {
    super::refresh_if_due(&ART, state, app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    // The engine this binding drives. The parser, the walk, the staged write and the swap all
    // live one module up, and the tests below reach them through `ART` — which is also the
    // only way a caller ever should.
    use crate::tags::testing::{fixture_lines, gz_fixture, mem_db};
    use crate::tags::*;
    use rusqlite::Connection;
    use std::sync::Mutex;

    /// `src-tauri/tests/fixtures/art-tags-sample.jsonl`, gzipped the way the bulk origin
    /// serves it.
    ///
    /// **A hand-written file rather than a `format!` helper**, because three of the seven
    /// things it has to exercise are things a formatter cannot say: an `annotation` key that
    /// is *absent* rather than null (~99 % of the real file), a `"description": null`, and a
    /// line that is not JSON at all. Every line's `"type"` is `"illustration"` and every
    /// tagging key is `illustration_id` — an art fixture written with `oracle_id` would sail
    /// through an ingest that read the wrong column and prove nothing.
    fn art_fixture() -> std::path::PathBuf {
        let lines = fixture_lines("art-tags-sample.jsonl");
        gz_fixture(&lines.iter().map(String::as_str).collect::<Vec<_>>())
    }

    fn ingest(db: &Mutex<Connection>, gz: &std::path::Path) -> Result<TagStats, TagError> {
        ingest_gz(
            &ART,
            db,
            gz,
            &FileStamp::default(),
            1_800_000_000,
            &mut |_| {},
        )
    }

    /// Every `(slug, weight)` the closure holds for one illustration, sorted by slug.
    fn closure_of(db: &Mutex<Connection>, illustration_id: &str) -> Vec<(String, String)> {
        let conn = crate::db::lock_blocking(db);
        let mut stmt = conn
            .prepare(
                "SELECT slug, weight FROM art_tag_illustrations
                  WHERE illustration_id = ?1 ORDER BY slug",
            )
            .unwrap();
        let rows = stmt
            .query_map([illustration_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        rows
    }

    fn slugs_of(db: &Mutex<Connection>, illustration_id: &str) -> Vec<String> {
        closure_of(db, illustration_id)
            .into_iter()
            .map(|(slug, _)| slug)
            .collect()
    }

    fn weight_of(db: &Mutex<Connection>, illustration_id: &str, slug: &str) -> String {
        closure_of(db, illustration_id)
            .into_iter()
            .find(|(s, _)| s == slug)
            .unwrap_or_else(|| panic!("{illustration_id} must hold {slug}"))
            .1
    }

    /// **The whole ingest over the hand-written file**: the counts it reports, the hierarchy
    /// it flattens, and the weight each closure row resolves to.
    ///
    /// The hierarchy half is the one that matters most, because getting it wrong looks like
    /// working. `dog` is directly tagged on 137 illustrations in the real file and reaches 439
    /// through its descendants; a direct-only ingest returns 31 % of the dogs and reports no
    /// error at all.
    #[test]
    fn art_ingest_flattens_the_hierarchy_and_resolves_weights() {
        let db = mem_db();
        let stats = ingest(&db, &art_fixture()).unwrap();

        assert_eq!(stats.tags, 9);
        assert_eq!(stats.taggings, 13);
        assert_eq!(
            stats.skipped_lines, 2,
            "the truncated JSON line and the card object"
        );
        assert_eq!(stats.dangling_parents, 1, "wolf's `id-retired-canine`");
        assert_eq!(stats.closure_rows, 24);

        // The grandchild's illustration carries the grandchild, the parent and the
        // grandparent — two levels, which is what stops a one-level walk passing.
        assert_eq!(slugs_of(&db, "illus-grandchild"), ["beast", "dog", "hound"]);
        // Both parents of a two-parent tag, to their roots. 43 % of the real file's tags have
        // more than one, so `parent_ids[0]` would lose a lineage from nearly half of them.
        assert_eq!(
            slugs_of(&db, "illus-two-parents"),
            ["beast", "dog", "dog-dragon", "dragon"]
        );
        // Two tags that share an ancestor give that ancestor **one** row, not two — which the
        // closure's primary key would insist on anyway, and which is where a weight has to be
        // resolved rather than collided.
        assert_eq!(
            closure_of(&db, "illus-castle"),
            [
                ("castle".to_owned(), "median".to_owned()),
                ("mountain".to_owned(), "strong".to_owned()),
                ("scenery".to_owned(), "strong".to_owned()),
            ]
        );

        // …and the row reachable from a weak and a strong tagging resolved to the strong one,
        // in **both** file orders. Only the second of these fails on a last-write-wins fold,
        // which is why the fixture carries the pair: `illus-both-weights` meets the weak
        // tagging first, `illus-strong-first` meets the strong one first.
        assert_eq!(weight_of(&db, "illus-both-weights", "dog"), "strong");
        assert_eq!(weight_of(&db, "illus-strong-first", "dog"), "strong");
        // An unrecognised weight ranks **below** every known one: `hound`'s `colossal` must
        // not outrank `dog`'s `weak` on the row they share. The other direction is how junk
        // gets promoted into a filtered result.
        assert_eq!(weight_of(&db, "illus-unknown-weight", "dog"), "weak");
        // It is still stored verbatim where nothing outranks it. Rust supplies the fact.
        assert_eq!(weight_of(&db, "illus-unknown-weight", "hound"), "colossal");

        let conn = crate::db::lock_blocking(&db);
        // The facts the closure was computed from are kept beside it: what the file said
        // directly, and the edges that were walked. An annotation the file omits is NULL and
        // one it states is stored — ~99 % of the real file's taggings omit it, which is a
        // different absence from `description`'s explicit null and needs a different parse.
        let (weight, annotation): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT weight, annotation FROM art_taggings
                  WHERE illustration_id = 'illus-grandchild' AND slug = 'hound'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(weight.as_deref(), Some("median"));
        assert_eq!(annotation.as_deref(), Some("the hound fills the frame"));
        let omitted: Option<String> = conn
            .query_row(
                "SELECT annotation FROM art_taggings
                  WHERE illustration_id = 'illus-both-weights' AND slug = 'dog'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(omitted, None);

        let edges: i64 = conn
            .query_row("SELECT count(*) FROM art_tag_parents", [], |r| r.get(0))
            .unwrap();
        assert_eq!(edges, 7, "both of dog-dragon's, and none to the retired id");

        // Scryfall's uuid and the normalised slug, which are the two columns schema v20 added
        // and the two ways this feature fails silently: `slug_norm` is what a typed needle is
        // compared against, and `id` is what a mute is keyed on because Tagger renames tags.
        let (id, norm): (String, String) = conn
            .query_row(
                "SELECT id, slug_norm FROM art_tags WHERE slug = 'dog-dragon'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(id, "id-dog-dragon");
        assert_eq!(norm, "dogdragon");

        // The watermark landed with the rows.
        let (tags, taggings): (i64, i64) = conn
            .query_row(
                "SELECT tag_count, tagging_count FROM art_tag_meta WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((tags, taggings), (9, 13));
    }

    /// **A tagging that states no weight is NULL in `art_taggings` and `median` in the
    /// closure**, and the two disagree on purpose.
    ///
    /// The taggings table records what the file said; the closure records what a search has to
    /// rank, and its column is `NOT NULL` with no default precisely so a forgotten weight is a
    /// constraint failure rather than a blank. `median` is Scryfall's own word for "a normal
    /// tagging" — the alternative, an empty string, is an unrecognised value that `stronger`
    /// ranks below `weak`, which would make a tagging Scryfall bothered to record the weakest
    /// signal in the database. Nothing in the 2026-08-20 file needs this: all 475 163 taggings
    /// carry a weight.
    #[test]
    fn a_tagging_with_no_weight_is_null_in_the_file_and_median_in_the_closure() {
        let db = mem_db();
        ingest(&db, &art_fixture()).unwrap();

        assert_eq!(weight_of(&db, "illus-no-weight", "beast"), "median");
        let stored: Option<String> = crate::db::lock_blocking(&db)
            .query_row(
                "SELECT weight FROM art_taggings
                  WHERE illustration_id = 'illus-no-weight' AND slug = 'beast'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, None, "what the file said, which was nothing");
    }

    /// **An art file that names `oracle_id` is the wrong file**, and must yield no taggings
    /// rather than half a taxonomy.
    ///
    /// The two datasets are the same document in two dialects, so a line from the oracle file
    /// parses perfectly as a tag here — only its taggings name a key this one does not read.
    /// Falling back to the other dataset's key would file an oracle id in
    /// `art_tag_illustrations`, where it joins to nothing and looks like an art tag nobody
    /// drew.
    #[test]
    fn an_oracle_keyed_line_contributes_no_art_taggings() {
        let db = mem_db();
        let line = r#"{"object":"tag","id":"id-ramp","label":"Ramp","slug":"ramp","type":"oracle","parent_ids":[],"taggings":[{"oracle_id":"oid-1","weight":"median"}]}"#;
        let stats = ingest(&db, &gz_fixture(&[line])).unwrap();

        assert_eq!(stats.tags, 1, "the tag itself still parses");
        assert_eq!(stats.taggings, 0, "and none of its taggings do");
        assert_eq!(stats.closure_rows, 0);
        let rows: i64 = crate::db::lock_blocking(&db)
            .query_row("SELECT count(*) FROM art_tag_illustrations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(rows, 0);
    }

    /// The oracle rule, on the second dataset: a file that yields no tags is a bad download,
    /// not an empty taxonomy. Swapping here would trade working rows for none.
    #[test]
    fn an_art_file_with_no_tags_is_refused_and_swaps_nothing() {
        let db = mem_db();
        let err = ingest(
            &db,
            &gz_fixture(&["<html>Service Unavailable</html>", r#"{"object":"card"}"#]),
        )
        .unwrap_err();

        assert!(
            matches!(err, TagError::Empty { skipped: 2 }),
            "expected Empty {{ skipped: 2 }}, got {err:?}"
        );
        let conn = crate::db::lock_blocking(&db);
        let n: i64 = conn
            .query_row("SELECT count(*) FROM art_tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        // And the staging tables were dropped rather than left lying around.
        let staged: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name LIKE 'art_%_staging'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(staged, 0);
    }
}
