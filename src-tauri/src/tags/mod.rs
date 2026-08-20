//! Scryfall's tag taxonomies: fetch a bulk file, flatten its hierarchy, and store what it
//! says about a card.
//!
//! Scryfall publishes two of these, and they are the same file in two dialects. Both are
//! gzipped JSONL, one `tag` object per line, each with a slug, a uuid, a list of parent
//! uuids and a list of taggings; what a tagging *names* is nearly all that differs —
//! `oracle_id` for [`oracle`], the card's rules text, and `illustration_id` for [`art`], the
//! specific piece of art. The one other difference is whether a tagging's `weight` survives
//! into the closure, which [`Dataset::carries_weight`] declares and [`write_closure`] is the
//! only reader of. So the fetch, the parse, the graph walk, the staged write and the swap
//! live here once, parameterised over a [`Dataset`], and each namespace's module is a
//! binding: a `const Dataset`, its Tauri commands, and whatever read path is specific to the
//! ids it deals in.
//!
//! Five rules shape this module. They were written for the oracle taxonomy and hold for
//! every one:
//!
//! * **Rust supplies facts; TypeScript draws conclusions.** Nothing here names a category,
//!   ranks one tag above another, or filters a taxonomy down to the useful part of it. The
//!   read paths answer raw slugs and the frontend decides what they mean — which is what lets
//!   the naming change without a migration.
//! * **The hierarchy is flattened once, at ingest, into the closure table.** A card tagged
//!   `tutor-battle` is *also* a `tutor`, and asking that question per lookup would mean a
//!   recursive walk per card. It is walked once here and stored instead, so the read is a
//!   prefix scan over a `WITHOUT ROWID` primary key.
//! * **Every parent is followed, not the first one.** See [`ancestor_closures`], which is the
//!   only place that decision is expressed.
//! * **This is Scryfall**, so it goes through [`crate::scryfall::Client`] and shares its
//!   pacing gate and its 429 lockout. A second client would be a second application as far as
//!   the rate limiter is concerned. (The price feeds in [`crate::marketplace_feed`] have their
//!   own client for exactly the opposite reason: they are *not* Scryfall.)
//! * **Nothing here may break a launch or a card sync.** A refresh is spawned, best-effort
//!   and silent; a failure leaves the previous tags in place and writes the reason to
//!   `error_log`. A database that has never fetched a tag file is a supported state, not a
//!   broken one.
//!
//! # Bad input is never fatal
//!
//! [`crate::ingest`]'s rule, for its reason: an unparseable line is counted and stepped over.
//! The one exception is a file that yields *no* tags — a gzipped error page, the wrong
//! dataset, a truncated download — which is refused outright and swaps nothing.

pub mod art;
pub mod oracle;

use crate::sync::AppState;
use flate2::read::GzDecoder;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

// ---------------------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------------------

/// Everything that differs between one tag taxonomy and another.
///
/// **Names, not values.** Every `&'static str` here is a table name, a column name or an
/// event name, and every one of them comes from a `const` in this crate — never from a
/// caller, never from the file. That is what makes it sound for the SQL below to build its
/// statements with `format!`: the *parameters* are still bound, and the only thing
/// interpolated is an identifier this repository wrote down.
///
/// The three staging functions are function pointers rather than more names because the
/// `CREATE TABLE`s they run are literals in [`crate::schema`], one per family, each fenced
/// against the live table's shape by a test there. A binding hands over its family's three;
/// nothing in this module needs to know what they say.
pub struct Dataset {
    /// The `/bulk-data/{name}` entry to check, and the `operation` a failure is logged under
    /// — so a reader of `error_log` can tell a tag failure from a card one, and one taxonomy
    /// from the other.
    pub bulk_name: &'static str,
    /// How to name this taxonomy in a sentence a reader sees. Capitalised, because the one
    /// place it is used sentence-initially is the refusal a second concurrent refresh gets.
    pub label: &'static str,
    /// What a tagging is *about*: the column the taggings and closure tables are keyed on,
    /// and the key the file's tagging objects carry it under. The one field that changes the
    /// meaning of the data rather than just where it is stored.
    pub subject_column: &'static str,
    /// The taxonomy: one row per tag, keyed on slug.
    pub tags_table: &'static str,
    /// The parent edges, `(child_slug, parent_slug)`.
    pub parents_table: &'static str,
    /// What the file said directly, before the hierarchy is applied.
    pub taggings_table: &'static str,
    /// The flattened closure: every tag a subject holds *plus* every ancestor of those tags.
    /// The table every read path actually reads.
    pub closure_table: &'static str,
    /// The one-row watermark: which file the rows came from and when it was last asked about.
    pub meta_table: &'static str,
    /// The event a refresh reports itself through.
    ///
    /// **One per dataset rather than a shared channel**, for
    /// [`crate::marketplace_feed::PROGRESS_EVENT`]'s reason one family over: the phase list is
    /// a closed union on the TypeScript side, and two taxonomies refreshing at once would
    /// otherwise fight over one progress line.
    pub progress_event: &'static str,
    /// How long an ingested file stays fresh. See [`is_stale`], which spends it.
    pub refresh_interval_secs: i64,
    /// The name the download is given under `data_dir/tmp/`.
    pub tmp_file: &'static str,
    /// Whether the closure table stores a resolved `weight` beside each row.
    ///
    /// False for the oracle taxonomy, and the reason is in the data: 99.74 % of oracle
    /// taggings are `median` and `strong` occurs exactly once in the whole file, so there is
    /// no cluster to rank against and nothing may branch on one. An art tagging's weight is
    /// genuinely informative — the 2026-08-20 file uses the full scale (median 462 008,
    /// strong 5 980, weak 4 495, very_strong 2 680) — and folding it over the taggings a
    /// closure row descends from is the one step of [`write_closure`] that is not the same
    /// for both taxonomies.
    ///
    /// **It is also what picks the `INSERT`**: [`flush_closure`] writes three columns where
    /// this is set and two where it is not, because `art_tag_illustrations.weight` is
    /// `NOT NULL` with no default and `oracle_tag_cards` has no such column at all. Setting
    /// it on a dataset whose closure table has no `weight` is `no such column` at the first
    /// insert of a refresh, which is loud rather than silent — deliberately.
    pub carries_weight: bool,
    /// Create this family's four empty staging tables, dropping any an interrupted run left.
    pub create_staging: fn(&Connection) -> rusqlite::Result<()>,
    /// Drop them. What a refused or failed run leaves owing.
    pub drop_staging: fn(&Connection) -> rusqlite::Result<()>,
    /// Promote the four staging tables over the live ones, **inside the caller's
    /// transaction** and replaying this family's indexes. A rename carries the *staging*
    /// table's indexes rather than the live table's, so a swap that forgets the replay leaves
    /// the app correct and merely slow — which is the kind of failure nobody reports.
    pub swap_staging: fn(&Connection) -> rusqlite::Result<()>,
}

/// A live table's staging twin.
///
/// The `_staging` suffix is the convention [`crate::schema::ORACLE_TAG_TABLES`] and its art
/// counterpart write down as pairs, and those lists are what a swap renames. A name built
/// here that the list does not agree with is `no such table` at the first insert of a
/// refresh — loud, immediate, and covered by every ingest test.
fn staging(live: &str) -> String {
    format!("{live}_staging")
}

/// A tag name reduced to what Scryfall matches on: lowercase, every non-alphanumeric
/// removed.
///
/// **One copy, deliberately.** The ingest writes it into `slug_norm` and the search compares
/// a typed needle against that column; if the two ever normalised differently the search
/// would match nothing and no test would fail, because each half would still be
/// self-consistent.
///
/// Verified live 2026-08-20 — `otag:"spot removal"`, `otag:spot-removal`, `otag:spotremoval`
/// and `otag:SPOT-REMOVAL` all return exactly 4,907 cards.
pub fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Scryfall's four tagging weights, **weakest first**. Their definitions, from `docs/api/tags`:
/// `weak` "a minor detail or background element", `median` "a normal tagging", `strong` "a
/// primary focus", `very_strong` "exemplary".
///
/// Bulk data is lowercase snake; Tagger's GraphQL returns the same values uppercase. This app
/// only ever reads bulk data, so lowercase is the whole vocabulary.
///
/// **Here rather than in a binding**, even though only the art taxonomy spends them
/// ([`Dataset::carries_weight`]): `weight` is a field of every tagging in every one of these
/// files, [`write_closure`] is the only caller, and an engine reaching into one namespace's
/// module for a scale that is Scryfall's would be the wrong way round the moment a third
/// dataset carried one.
pub const WEIGHTS: [&str; 4] = ["weak", "median", "strong", "very_strong"];

/// What a tagging that states no weight is read as in the closure.
///
/// Scryfall's own word for "a normal tagging", and the honest reading of a file that did not
/// single this tagging out. **Nothing in the 2026-08-20 art file needs it** — all 475 163
/// taggings carry a weight (median 462 008 · strong 5 980 · weak 4 495 · very_strong 2 680) —
/// so this is the answer for a shape that does not occur today rather than a common path.
///
/// The alternative, an empty string, would be an unrecognised value that [`stronger`] ranks
/// *below* `weak`: a tagging Scryfall bothered to make would become the weakest signal in the
/// database, and `art_tag_illustrations.weight` is `NOT NULL`, so it would be a blank in a
/// column every read path selects. The raw absence is still kept verbatim — the taggings
/// table's `weight` is nullable and stores what the file said, or nothing.
const DEFAULT_WEIGHT: &str = "median";

/// The stronger of two weights. **An unrecognised value ranks below every known one** — a
/// weight this build has not heard of must never silently outrank `very_strong`, which is the
/// direction that would quietly promote junk into a filtered result.
///
/// Ties keep `a`, so folding this over a subject's taggings is stable: the answer does not
/// depend on which equally-strong tagging the walk happened to reach first.
pub fn stronger<'a>(a: &'a str, b: &'a str) -> &'a str {
    let rank = |w: &str| {
        WEIGHTS
            .iter()
            .position(|x| *x == w)
            .map(|i| i as i32)
            .unwrap_or(-1)
    };
    if rank(b) > rank(a) {
        b
    } else {
        a
    }
}

/// Every value [`TagProgress::phase`] takes, in the order one refresh produces them.
/// Mirrored by hand on the other side of the IPC boundary.
///
/// **One list for every dataset**: both emit the same five names, on the event channels their
/// [`Dataset::progress_event`]s name, so the TypeScript union is written once too.
pub const PHASES: [&str; 5] = ["checking", "downloading", "ingesting", "done", "error"];

/// Rows per staging transaction, and so also rows between progress callbacks —
/// [`crate::ingest`]'s number, for its reason: it is how long another writer can be made to
/// wait for the write connection.
const BATCH: usize = 2_000;

/// Bytes of download between progress events. Against reqwest's chunk callback, which fires
/// far more often than a progress bar can use.
const DOWNLOAD_EMIT_BYTES: u64 = 512 * 1024;

/// How long the ingest stands aside between two batches.
///
/// **Releasing the write connection is not the same as letting anyone else have it.** Every
/// user-facing write in this crate asks through [`crate::db::lock_for`], which polls a
/// `try_lock` every 20 ms — so a loop that commits a batch and re-takes the mutex microseconds
/// later has released it in a way no poller can observe. Every poll lands inside the next
/// batch, and a collection edit made during the refresh is told "busy" after its five seconds,
/// which is exactly the frozen-button failure batching exists to prevent.
///
/// [`crate::ingest`] needs nothing like this because ~30 ms of gzip and JSON parsing sits
/// between its batches; three of the four loops here have nothing between them but a slice
/// index. Five milliseconds against a batch that measures ~10–20 ms puts a waiting writer in
/// within a handful of polls, and costs a full oracle refresh (~470 batches over the
/// 2026-08-14 file) roughly 2.4 s — which is a weekly background task's to spend.
const YIELD_BETWEEN_BATCHES: std::time::Duration = std::time::Duration::from_millis(5);

/// Let go of the connection long enough for a waiting writer to see that it is free.
/// **Call it with no guard in scope** — see [`YIELD_BETWEEN_BATCHES`].
fn stand_aside() {
    std::thread::sleep(YIELD_BETWEEN_BATCHES);
}

/// Ids per `IN (…)` in a read path.
///
/// A chunk rather than one statement for the whole list: SQLite's bound-parameter ceiling is
/// a compile-time option of whatever build is linked, and a decklist import is allowed to ask
/// about every line at once. 500 is far under every ceiling SQLite has shipped and still one
/// statement for any list a person types by hand.
const LOOKUP_CHUNK: usize = 500;

// ---------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------

/// One `tag` object from a bulk file, narrowed to what this app stores.
///
/// `child_ids` is deliberately absent: it is the same edges as `parent_ids` read the other
/// way round, and storing both would be two sources of truth for one graph.
#[derive(Debug, Clone, PartialEq)]
struct TagLine {
    /// Scryfall's uuid: the join key **inside the file** — `parent_ids` are these — and the
    /// stable identity of the tag outside it. Slugs and labels are explicitly not permanent
    /// (Scryfall's docs say so), so a mute keyed on one silently un-mutes itself the week
    /// Tagger renames the tag; this is what such a list is keyed on instead, and it is stored
    /// beside the slug from schema v20 on.
    id: String,
    slug: String,
    label: String,
    description: Option<String>,
    /// Every parent, in file order. 684 of the oracle file's 4 521 tags carry more than one.
    parent_ids: Vec<String>,
    taggings: Vec<TaggingLine>,
}

/// One entry of a tag's `taggings` array.
#[derive(Debug, Clone, PartialEq)]
struct TaggingLine {
    /// What the tagging is about, read from the key [`Dataset::subject_column`] names: an
    /// `oracle_id` in the oracle file, an `illustration_id` in the art one.
    subject: String,
    /// `median` on 99.74 % of oracle taggings; a real signal in the art file. Stored because
    /// it is data we were handed — see [`Dataset::carries_weight`] for which closure acts
    /// on it.
    weight: Option<String>,
    annotation: Option<String>,
}

/// Read one line of a bulk file.
///
/// `None` for anything this app cannot act on, which the caller counts and steps over:
///
/// * not a `tag` object — the datasets hold nothing else today, and a future sibling object
///   must not be filed as a tag with an empty slug,
/// * no `id` — the uuid every `parent_ids` entry is matched against, so a blank one would
///   silently collect every parentless reference,
/// * no `slug` — the primary key of every table here.
///
/// Everything else is optional and defaulted rather than refused: `label` falls back to the
/// slug (so a reader is always shown *something*), and a missing `parent_ids`/`taggings` is
/// an empty list, which is what a root tag and an unused tag genuinely are.
fn parse_tag_line(ds: &Dataset, v: &serde_json::Value) -> Option<TagLine> {
    if v["object"].as_str() != Some("tag") {
        return None;
    }
    let id = non_empty(v["id"].as_str())?;
    let slug = non_empty(v["slug"].as_str())?;
    let label = non_empty(v["label"].as_str()).unwrap_or_else(|| slug.clone());
    let parent_ids = v["parent_ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| non_empty(p.as_str()))
        .collect();
    let taggings = v["taggings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            Some(TaggingLine {
                // A tagging with no subject id joins to nothing. Dropped here rather than
                // stored as a row no card can ever match. **The other dataset's key is not
                // read as a fallback**: an art file served under the oracle name is the wrong
                // file, and it must yield nothing rather than half a taxonomy.
                subject: non_empty(t[ds.subject_column].as_str())?,
                weight: non_empty(t["weight"].as_str()),
                annotation: non_empty(t["annotation"].as_str()),
            })
        })
        .collect();
    Some(TagLine {
        id,
        slug,
        label,
        description: non_empty(v["description"].as_str()),
        parent_ids,
        taggings,
    })
}

/// A trimmed, owned string, or `None` for absent and blank alike. `""` is not a slug, not a
/// uuid and not a description.
fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

// ---------------------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------------------

/// One tag, as the ingest holds it while the file is being read.
#[derive(Debug, Clone)]
struct Tag {
    /// Scryfall's uuid, carried through to `{tags_table}.id`. See [`TagLine::id`] for why a
    /// slug is not identity.
    id: String,
    slug: String,
    label: String,
    description: Option<String>,
    /// Resolved indices into the tag list. Filled once the whole file has been read, because
    /// a parent may appear on any later line — and a parent id the file never defines is
    /// dropped here rather than carried as an edge to nothing.
    parents: Vec<u32>,
}

/// One file, as the ingest holds it: the tags, the subjects their taggings named, and which
/// tags each subject was given directly.
///
/// Together rather than as four locals because the write loops below take all of them at
/// once, and a `&Graph` is one argument where four would put [`write_closure`] over the
/// argument ceiling clippy enforces.
#[derive(Debug, Default)]
struct Graph {
    /// Every tag, in file order.
    tags: Vec<Tag>,
    /// Every subject id a tagging named, interned. The oracle file holds 229 633 taggings
    /// over 35 969 oracle ids, so the ids are held once each and referred to by index —
    /// 4 bytes per tagging instead of a string apiece.
    subjects: Vec<String>,
    /// Per subject, the tags it holds **directly**, as `(tag, weight)` pairs of indices into
    /// [`Graph::tags`] and [`Graph::weights`]. The ancestors are added by [`write_closure`],
    /// from the walk — and the weight rides along because a closure row's weight is folded
    /// over exactly these taggings, long after the line that carried it has been written to
    /// staging and dropped.
    held: Vec<Vec<(u32, u32)>>,
    /// Every distinct `weight` string the file used, interned.
    ///
    /// Four values over 475 163 art taggings (measured 2026-08-20), so an index is 4 bytes a
    /// tagging where a `String` would be twenty-odd plus an allocation. Interned rather than
    /// mapped to a rank because an unrecognised weight is stored **verbatim**: Rust supplies
    /// the fact, and a value this build has not heard of is still what Scryfall said.
    weights: Vec<String>,
}

/// For every tag, the tags a subject inherits by holding it: **the tag itself, plus every
/// ancestor above it**, as indices into `tags`.
///
/// This is the whole of the hierarchy's effect on the app, and it is deliberately one
/// function so that the decision inside it has exactly one place to be changed.
///
/// # The one knob: every parent, or only the first
///
/// **Every entry of `parent_ids` is followed.** 684 of the 4 521 tags in the 2026-08-14
/// oracle file have more than one parent, and their ancestries genuinely differ:
/// `tutor-battle` sits under both `tutor` and `battle-matters`, and a card holding it belongs
/// in either list. The alternative — take `parent_ids[0]` and ignore the rest — would give
/// every tag a single lineage, which is smaller and simpler and wrong for those 684. Flipping
/// this is one line: iterate `parents.first()` instead of `parents`. Nothing else in the
/// crate encodes the choice, and no caller can tell which was made except by the rows it
/// produces.
///
/// # What it does not assume
///
/// * **Cycles.** Today's files have none; nothing promises tomorrow's will not. Each walk
///   carries its own `seen` set, and a tag already in it is not descended into again — so a
///   cycle yields the loop's members once each and terminates, rather than hanging a
///   background thread with no window to say so in.
/// * **That a parent exists.** Ids the file never defines are already gone by the time this
///   runs (see [`Tag::parents`]), so there is nothing here to index out of bounds.
///
/// A `Vec<Vec<u32>>` rather than a memo table: 4 521 tags at depth ≤ 5 is a walk measured in
/// microseconds, and the simple version is the one whose termination argument fits in the
/// paragraph above.
fn ancestor_closures(tags: &[Tag]) -> Vec<Vec<u32>> {
    let mut out = Vec::with_capacity(tags.len());
    for start in 0..tags.len() as u32 {
        let mut seen: HashSet<u32> = HashSet::from([start]);
        let mut stack = vec![start];
        while let Some(current) = stack.pop() {
            // Every parent, which is the knob. `parents.first()` here — and only here —
            // would make this a single-lineage taxonomy.
            for &parent in &tags[current as usize].parents {
                if seen.insert(parent) {
                    stack.push(parent);
                }
            }
        }
        let mut closure: Vec<u32> = seen.into_iter().collect();
        // Sorted so the rows a run produces do not depend on a hash seed. Nothing reads the
        // order, but a diff of two ingests should be about the data.
        closure.sort_unstable();
        out.push(closure);
    }
    out
}

// ---------------------------------------------------------------------------------------
// Errors and stats
// ---------------------------------------------------------------------------------------

/// **The dataset is not in these messages, and does not need to be**: every one of them
/// reaches `error_log` through [`note_failure`], which files it under
/// [`Dataset::bulk_name`] in the `operation` column.
#[derive(Debug, thiserror::Error)]
pub enum TagError {
    #[error("failed to read the tag file: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error while storing tags: {0}")]
    Db(#[from] rusqlite::Error),
    /// The file decoded and not one line was a tag. A gzipped error page, a truncated
    /// download, a file of nothing but cards — none of which may replace a working taxonomy
    /// with an empty one. [`crate::ingest::IngestError::Empty`] refuses a bulk card file for
    /// the same reason.
    #[error("no tags found in the tag file ({skipped} lines skipped); keeping the previous ones")]
    Empty { skipped: u64 },
    /// The file was full of tags and **not one of them tagged anything**.
    ///
    /// [`Empty`]'s sibling, and a separate variant because it points somewhere else entirely.
    /// `Empty` is a download that went wrong; this is a download that went *right* and was the
    /// wrong file — the other taxonomy served under this dataset's name, or Scryfall renaming
    /// the key [`Dataset::subject_column`] reads. Both files parse as thousands of perfectly
    /// good tags, and the taggings are the only place the difference shows.
    ///
    /// **Refusing is not fussiness, it is the only thing that self-heals.** A swap here would
    /// promote an empty closure over a working one *and* stamp the watermark in the same
    /// transaction, so the next weekly check would replay that ETag, be told 304, and keep an
    /// empty taxonomy forever with nothing in `error_log` to say why.
    ///
    /// [`Empty`]: TagError::Empty
    #[error("the tag file held {tags} tags and not one tagging; keeping the previous ones")]
    Untagged { tags: u64 },
}

impl TagError {
    /// How the error log should classify this.
    pub fn kind(&self) -> crate::errors::Kind {
        use crate::errors::Kind;
        match self {
            TagError::Io(_) | TagError::Db(_) => Kind::Io,
            TagError::Empty { .. } | TagError::Untagged { .. } => Kind::Parse,
        }
    }
}

/// What one ingest did. Every count is a fact about the file, and the three "skipped" ones
/// are counted rather than fatal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TagStats {
    pub tags: u64,
    /// Taggings **read from the file**. The insert is `OR IGNORE`, so a subject listed twice
    /// under one tag is one stored row and this figure can exceed the table's count by
    /// however many times that happened — which is the honest reading of "what the file
    /// said", and the one worth keeping when the two disagree.
    pub taggings: u64,
    /// Rows in the closure: one per (subject, tag) *including* inherited tags, so this is
    /// always at least the number of *distinct* taggings.
    pub closure_rows: u64,
    /// Lines that were not a usable tag object.
    pub skipped_lines: u64,
    /// `parent_ids` entries naming a tag the file never defined. Zero in every file measured
    /// so far; a number that suddenly moves is worth seeing.
    pub dangling_parents: u64,
}

/// Which file a set of rows came from, written with the swap.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileStamp {
    /// The response's weak ETag, replayed as `If-None-Match` next time.
    pub etag: Option<String>,
    /// Scryfall's `updated_at` for the file, verbatim.
    pub updated_at: Option<String>,
}

// ---------------------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------------------

/// Stream a gzipped tag file into `ds`'s staging tables, flatten the hierarchy, and swap the
/// result into place.
///
/// # The connection is taken a batch at a time
///
/// [`crate::ingest::ingest_gz`]'s discipline, and its reason: `db` is the shared write
/// connection, and holding it for the length of an ingest is what turns a user's edit into a
/// frozen button. Every insert loop here commits every [`BATCH`] rows and gives the guard
/// straight back; the parse and the graph walk hold no lock at all.
///
/// # A failed run leaves nothing half-built
///
/// Everything is written to the `_staging` twins, which no reader can see, and promoted by
/// one rename transaction at the end. So a failure partway — an I/O error mid-stream, a
/// process that dies — leaves the previous taxonomy exactly where it was and a committed
/// staging table that the next run's [`Dataset::create_staging`] drops before it writes a
/// row. **A half-populated closure is the one state that must never be visible**, because a
/// card whose ancestors landed and whose siblings did not reads as a card that is simply not
/// in that category.
///
/// `progress` is called with the running row count every [`BATCH`] rows, and once more when
/// the swap is done.
pub fn ingest_gz(
    ds: &Dataset,
    db: &Mutex<Connection>,
    gz_path: &Path,
    stamp: &FileStamp,
    ingested_at: i64,
    progress: &mut dyn FnMut(u64),
) -> Result<TagStats, TagError> {
    // Opened before the database is touched: a missing or unreadable path must not cost the
    // caller the staging tables it was about to fill.
    let file = std::fs::File::open(gz_path)?;
    {
        let conn = crate::db::lock_blocking(db);
        (ds.create_staging)(&conn)?;
    }

    let mut stats = TagStats::default();
    let mut written = 0u64;

    // The file, and the two maps that intern it: uuid → tag index, which resolves
    // `parent_ids` once the file has been read to the end, and subject id → subject index.
    let mut g = Graph::default();
    let mut parent_ids: Vec<Vec<String>> = Vec::new();
    let mut by_id: HashMap<String, u32> = HashMap::new();
    let mut subject_of: HashMap<String, u32> = HashMap::new();
    // …and the third, which interns `Graph::weights`. A map rather than a linear scan of a
    // four-entry list: the vocabulary is small in every file measured, but a file that had
    // gone wrong in that particular way would turn the scan quadratic over 475 163 taggings
    // on a background thread with no window to say so in.
    let mut weight_of: HashMap<String, u32> = HashMap::new();

    // `weight` and `annotation` are never held whole: they go straight to staging with the
    // row that carries them.
    let mut batch: Vec<(u32, u32, Option<String>, Option<String>)> = Vec::with_capacity(BATCH);

    let reader = BufReader::new(GzDecoder::new(file));
    for line in reader.lines() {
        let line = line?;
        // Parsed with the lock *not* held: it is the expensive half of the loop, and the
        // whole point of batching is that the connection is free during it.
        let parsed = serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .as_ref()
            .and_then(|v| parse_tag_line(ds, v));
        let Some(tag) = parsed else {
            stats.skipped_lines += 1;
            continue;
        };

        let index = g.tags.len() as u32;
        // An **id** the file repeats is one tag, not two: the first line wins and the
        // second's taggings are folded onto it, exactly as the `INSERT OR IGNORE`s below
        // would have them. (Two *different* ids sharing a slug fold the same way, one table
        // down: the slug is the key everything here is stored under.)
        let index = *by_id.entry(tag.id.clone()).or_insert(index);
        if index == g.tags.len() as u32 {
            g.tags.push(Tag {
                id: tag.id,
                slug: tag.slug,
                label: tag.label,
                description: tag.description,
                parents: Vec::new(),
            });
            parent_ids.push(tag.parent_ids);
        }

        for tagging in tag.taggings {
            let subject = match subject_of.get(&tagging.subject) {
                Some(&s) => s,
                None => {
                    let s = g.subjects.len() as u32;
                    subject_of.insert(tagging.subject.clone(), s);
                    g.subjects.push(tagging.subject);
                    g.held.push(Vec::new());
                    s
                }
            };
            // The weight the closure will fold, interned. **A tagging that states none is
            // read as [`DEFAULT_WEIGHT`] here and stored as NULL below** — the closure's
            // column is `NOT NULL` and the taggings table's is not, so the two disagree on
            // purpose: one records what the file said, the other what the search must rank.
            let weight = {
                let w = tagging.weight.as_deref().unwrap_or(DEFAULT_WEIGHT);
                match weight_of.get(w) {
                    Some(&i) => i,
                    None => {
                        let i = g.weights.len() as u32;
                        weight_of.insert(w.to_owned(), i);
                        g.weights.push(w.to_owned());
                        i
                    }
                }
            };
            g.held[subject as usize].push((index, weight));
            batch.push((subject, index, tagging.weight, tagging.annotation));
            if batch.len() >= BATCH {
                stats.taggings += batch.len() as u64;
                write_taggings(ds, db, &g, &mut batch)?;
                written = stats.taggings;
                progress(written);
            }
        }
    }
    if !batch.is_empty() {
        stats.taggings += batch.len() as u64;
        write_taggings(ds, db, &g, &mut batch)?;
        written = stats.taggings;
    }

    // **Two ways a file that decoded perfectly is still not a taxonomy**, and the swap below
    // is unconditional, so this is the last place either can be stopped. Both leave the
    // previous rows exactly where they were and drop the staging tables rather than leave
    // them lying around.
    //
    // Not one line was a tag is the obvious one: a gzipped error page, a truncated download.
    // **Tags but not one tagging is the one that only exists because there are two datasets
    // of the same shape** — the art file served under the oracle name, or Scryfall renaming
    // the key `Dataset::subject_column` reads — and it is the more dangerous of the two,
    // because it does not self-heal. A swap would write an empty closure *and* the watermark
    // in one transaction, and the next weekly check would replay that ETag, take its 304 and
    // leave the taxonomy empty forever with nothing in `error_log` to explain it.
    let refusal = match (g.tags.is_empty(), stats.taggings) {
        (true, _) => Some(TagError::Empty {
            skipped: stats.skipped_lines,
        }),
        (false, 0) => Some(TagError::Untagged {
            tags: g.tags.len() as u64,
        }),
        _ => None,
    };
    if let Some(err) = refusal {
        let conn = crate::db::lock_blocking(db);
        (ds.drop_staging)(&conn)?;
        return Err(err);
    }
    stats.tags = g.tags.len() as u64;

    // The tags themselves. **Five columns, and `slug_norm` is [`normalize`]'s answer for the
    // slug in the same row**: the search compares a normalised needle against that column, so
    // a column left empty here is a search that matches nothing with no error anywhere.
    let tags_sql = format!(
        "INSERT OR IGNORE INTO {staging} (slug, id, label, description, slug_norm)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        staging = staging(ds.tags_table)
    );
    for chunk in g.tags.chunks(BATCH) {
        let mut conn = crate::db::lock_blocking(db);
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(&tags_sql)?;
            for tag in chunk {
                stmt.execute(params![
                    tag.slug,
                    tag.id,
                    tag.label,
                    tag.description,
                    normalize(&tag.slug)
                ])?;
            }
        }
        tx.commit()?;
        drop(conn);
        stand_aside();
        written += chunk.len() as u64;
        progress(written);
    }

    // The edges, once every id in the file is known. A parent the file never defined is
    // counted and dropped: an edge to a tag that does not exist is not a hierarchy, and
    // carrying it would only make the walk below reach for an index that is not there.
    for (child, ids) in parent_ids.iter().enumerate() {
        for id in ids {
            match by_id.get(id) {
                // A tag naming itself as its own parent is a one-node cycle; the walk
                // survives it either way, but the edge says nothing and is not stored.
                Some(&parent) if parent as usize != child => g.tags[child].parents.push(parent),
                Some(_) => {}
                None => stats.dangling_parents += 1,
            }
        }
    }
    write_edges(ds, db, &g, &mut written, progress)?;

    // The closure. Computed with no lock held — this is pure CPU over the tag list — and then
    // unioned per subject: a subject holding two tags that share an ancestor gets that
    // ancestor once, which is what the `(subject, slug)` primary key would insist on anyway.
    let closures = ancestor_closures(&g.tags);
    stats.closure_rows = write_closure(ds, db, &g, &closures, &mut written, progress)?;

    {
        let mut conn = crate::db::lock_blocking(db);
        let tx = conn.transaction()?;
        (ds.swap_staging)(&tx)?;
        // In the same transaction as the swap, and that is the contract: a watermark without
        // its rows would 304 past an empty taxonomy forever, and rows without their watermark
        // would re-download a file the database already holds.
        tx.execute(
            &format!(
                "INSERT INTO {meta}
                    (id, etag, updated_at, ingested_at, checked_at, tag_count, tagging_count)
                 VALUES (1, ?1, ?2, ?3, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                    etag = excluded.etag,
                    updated_at = excluded.updated_at,
                    ingested_at = excluded.ingested_at,
                    checked_at = excluded.checked_at,
                    tag_count = excluded.tag_count,
                    tagging_count = excluded.tagging_count",
                meta = ds.meta_table
            ),
            // `?3` twice: an ingest is also a check, and the two stamps only come apart when a
            // later run is told 304.
            params![
                stamp.etag,
                stamp.updated_at,
                ingested_at,
                stats.tags as i64,
                stats.taggings as i64
            ],
        )?;
        tx.commit()?;
    }
    progress(written);
    Ok(stats)
}

/// Commit one batch of taggings, then let go of the connection.
fn write_taggings(
    ds: &Dataset,
    db: &Mutex<Connection>,
    g: &Graph,
    batch: &mut Vec<(u32, u32, Option<String>, Option<String>)>,
) -> Result<(), TagError> {
    let sql = format!(
        "INSERT OR IGNORE INTO {staging} ({subject}, slug, weight, annotation)
         VALUES (?1, ?2, ?3, ?4)",
        staging = staging(ds.taggings_table),
        subject = ds.subject_column
    );
    let mut conn = crate::db::lock_blocking(db);
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(&sql)?;
        // `OR IGNORE` rather than a plain insert: the same subject listed twice under one tag
        // is one fact, and a duplicate must cost the batch it is in nothing.
        for (subject, tag, weight, annotation) in batch.iter() {
            stmt.execute(params![
                g.subjects[*subject as usize],
                g.tags[*tag as usize].slug,
                weight,
                annotation
            ])?;
        }
    }
    tx.commit()?;
    drop(conn);
    stand_aside();
    batch.clear();
    Ok(())
}

/// The parent edges, batched the same way.
fn write_edges(
    ds: &Dataset,
    db: &Mutex<Connection>,
    g: &Graph,
    written: &mut u64,
    progress: &mut dyn FnMut(u64),
) -> Result<(), TagError> {
    let mut pending: Vec<(&str, &str)> = Vec::with_capacity(BATCH);
    for tag in &g.tags {
        for &parent in &tag.parents {
            pending.push((tag.slug.as_str(), g.tags[parent as usize].slug.as_str()));
        }
        if pending.len() >= BATCH {
            flush_edges(ds, db, &mut pending)?;
            *written += BATCH as u64;
            progress(*written);
        }
    }
    if !pending.is_empty() {
        let n = pending.len() as u64;
        flush_edges(ds, db, &mut pending)?;
        *written += n;
    }
    Ok(())
}

fn flush_edges(
    ds: &Dataset,
    db: &Mutex<Connection>,
    pending: &mut Vec<(&str, &str)>,
) -> Result<(), TagError> {
    let sql = format!(
        "INSERT OR IGNORE INTO {staging} (child_slug, parent_slug) VALUES (?1, ?2)",
        staging = staging(ds.parents_table)
    );
    let mut conn = crate::db::lock_blocking(db);
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(&sql)?;
        for (child, parent) in pending.iter() {
            stmt.execute(params![child, parent])?;
        }
    }
    tx.commit()?;
    drop(conn);
    stand_aside();
    pending.clear();
    Ok(())
}

/// The closure itself: for each subject, every tag it holds and every ancestor of those tags.
///
/// Returns the number of rows written. The per-subject map is what makes two tags sharing an
/// ancestor one row rather than a primary-key collision.
///
/// # The weight
///
/// Where [`Dataset::carries_weight`] is set, each row also carries **the strongest weight
/// among the direct taggings it descends from** — [`stronger`] folded over them, not the last
/// one seen. A row reached only through ancestry inherits the weight of the tagging that
/// produced it, and a row two taggings both reach resolves rather than races: an illustration
/// whose `dog` tagging is weak but whose `hound` tagging is strong is not a weak `dog`, and
/// `hound`'s ancestor *is* `dog`, so both land on the one row. Deciding this per row at read
/// time would instead be work on every keystroke of a tag search.
fn write_closure(
    ds: &Dataset,
    db: &Mutex<Connection>,
    g: &Graph,
    closures: &[Vec<u32>],
    written: &mut u64,
    progress: &mut dyn FnMut(u64),
) -> Result<u64, TagError> {
    let mut rows = 0u64;
    let mut pending: Vec<(&str, &str, &str)> = Vec::with_capacity(BATCH);
    // Tag index → the strongest weight of the taggings that reach it. A map rather than a set
    // for both datasets: the value is simply never written for one that carries no weight,
    // and one code path is one place for the union to be right.
    let mut inherited: HashMap<u32, &str> = HashMap::new();
    for (subject, held) in g.held.iter().enumerate() {
        inherited.clear();
        for &(tag, weight_index) in held {
            let weight = g.weights[weight_index as usize].as_str();
            for &ancestor in &closures[tag as usize] {
                inherited
                    .entry(ancestor)
                    .and_modify(|best| *best = stronger(best, weight))
                    .or_insert(weight);
            }
        }
        // Sorted for the same reason `ancestor_closures` sorts: a run's rows should not
        // depend on a hash seed.
        let mut slugs: Vec<u32> = inherited.keys().copied().collect();
        slugs.sort_unstable();
        for tag in slugs {
            pending.push((
                g.subjects[subject].as_str(),
                g.tags[tag as usize].slug.as_str(),
                inherited[&tag],
            ));
            rows += 1;
        }
        // Flushed between subjects, never inside one: a batch boundary in the middle of a
        // subject's tags is exactly the half-written state the staging tables exist to hide,
        // and there is no reason to create one when the next subject is a natural seam.
        if pending.len() >= BATCH {
            let n = pending.len() as u64;
            flush_closure(ds, db, &mut pending)?;
            *written += n;
            progress(*written);
        }
    }
    if !pending.is_empty() {
        let n = pending.len() as u64;
        flush_closure(ds, db, &mut pending)?;
        *written += n;
    }
    Ok(rows)
}

/// One batch of closure rows, in the two- or three-column shape
/// [`Dataset::carries_weight`] declares.
///
/// Two statements rather than one that always binds a weight, because the column genuinely is
/// not there on the oracle side: `oracle_tag_cards` is `(oracle_id, slug)` and always has
/// been.
fn flush_closure(
    ds: &Dataset,
    db: &Mutex<Connection>,
    pending: &mut Vec<(&str, &str, &str)>,
) -> Result<(), TagError> {
    let table = staging(ds.closure_table);
    let subject = ds.subject_column;
    let sql = if ds.carries_weight {
        format!("INSERT OR IGNORE INTO {table} ({subject}, slug, weight) VALUES (?1, ?2, ?3)")
    } else {
        format!("INSERT OR IGNORE INTO {table} ({subject}, slug) VALUES (?1, ?2)")
    };
    let mut conn = crate::db::lock_blocking(db);
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(&sql)?;
        for (subject, slug, weight) in pending.iter() {
            if ds.carries_weight {
                stmt.execute(params![subject, slug, weight])?;
            } else {
                stmt.execute(params![subject, slug])?;
            }
        }
    }
    tx.commit()?;
    drop(conn);
    stand_aside();
    pending.clear();
    Ok(())
}

// ---------------------------------------------------------------------------------------
// The read path
// ---------------------------------------------------------------------------------------

/// Every read path's shared half: dedupe the request, ask in chunks, and answer one
/// `(key, slugs)` pair per requested key **in the order asked**.
///
/// `sql` carries one `{holes}` where the `IN (…)` list goes and must select `(key, slug)` in
/// that order. Written once because the *contract* is the valuable part — order preserved,
/// duplicates and blanks dropped, a miss answered with an empty list rather than an absence —
/// and two copies of it would be two places for that to drift.
///
/// An empty request touches the database not at all: `chunks` of an empty slice yields nothing,
/// so no statement is ever prepared.
fn read_tags_keyed(
    conn: &Connection,
    keys: &[String],
    sql: &str,
) -> rusqlite::Result<Vec<(String, Vec<String>)>> {
    let mut wanted: Vec<&str> = Vec::with_capacity(keys.len());
    let mut seen: HashSet<&str> = HashSet::new();
    for key in keys {
        let key = key.trim();
        if !key.is_empty() && seen.insert(key) {
            wanted.push(key);
        }
    }

    let mut found: HashMap<String, Vec<String>> = HashMap::new();
    for chunk in wanted.chunks(LOOKUP_CHUNK) {
        let holes = vec!["?"; chunk.len()].join(",");
        let mut stmt = conn.prepare_cached(&sql.replace("{holes}", &holes))?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (key, slug) = row?;
            found.entry(key).or_default().push(slug);
        }
    }

    Ok(wanted
        .into_iter()
        .map(|key| (key.to_owned(), found.remove(key).unwrap_or_default()))
        .collect())
}

// ---------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------

/// What the UI needs to say whether a taxonomy is there and how old it is.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagStatus {
    /// Scryfall's own stamp for the file these rows came from, verbatim. `None` where nothing
    /// has been ingested — and, separately, where a response carried none.
    pub updated_at: Option<String>,
    /// Unix seconds. **`None` is "never ingested"**, which for the oracle taxonomy means the
    /// app is categorising by card type and not by what a card does.
    pub ingested_at: Option<i64>,
    /// Unix seconds: when Scryfall was last **asked** whether the file had changed. Moves on a
    /// 304, where `ingestedAt` does not — so the two coming apart is the ordinary state of an
    /// up-to-date taxonomy, not a fault.
    pub checked_at: Option<i64>,
    pub tag_count: Option<i64>,
    pub tagging_count: Option<i64>,
    /// Checked longer ago than [`Dataset::refresh_interval_secs`], or never ingested at all.
    pub stale: bool,
    /// A refresh **of this dataset** is in flight right now.
    pub refreshing: bool,
}

/// The stored watermark: which file the rows came from, when they were built, and when
/// Scryfall was last asked about them.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TagMeta {
    stamp: FileStamp,
    ingested_at: i64,
    checked_at: i64,
    tag_count: i64,
    tagging_count: i64,
}

/// The stored watermark, or `None` when nothing has ever been ingested.
///
/// A row that cannot be read is reported as "never ingested" rather than failing the call:
/// there is nothing a caller could usefully do with an error that it does not already do with
/// an absence, and both mean "there is no taxonomy here".
fn read_meta(ds: &Dataset, conn: &Connection) -> Option<TagMeta> {
    conn.query_row(
        &format!(
            "SELECT etag, updated_at, ingested_at, checked_at, tag_count, tagging_count
               FROM {meta} WHERE id = 1",
            meta = ds.meta_table
        ),
        [],
        |r| {
            Ok(TagMeta {
                stamp: FileStamp {
                    etag: r.get(0)?,
                    updated_at: r.get(1)?,
                },
                ingested_at: r.get(2)?,
                checked_at: r.get(3)?,
                tag_count: r.get(4)?,
                tagging_count: r.get(5)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// Are there closure rows to read? The second half of the ETag decision, and
/// [`crate::sync`]'s `card_count > 0` for its reason: metadata can outlive the rows it
/// describes, and replaying an `If-None-Match` for a file whose rows are gone earns a 304
/// that no amount of refreshing can get past.
fn closure_is_populated(ds: &Dataset, conn: &Connection) -> bool {
    conn.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM {closure})",
            closure = ds.closure_table
        ),
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n == 1)
    .unwrap_or(false)
}

/// Has this file earned another look? **`checked_at`, not `ingested_at`** — a 304 means the
/// rows are current, and asking again tomorrow because they were *built* a week ago would
/// spend one API call per launch to learn nothing. Never checked is stale by definition, and a
/// stamp in the future (a clock that moved) counts as stale rather than underflowing.
///
/// `interval` rather than a [`Dataset`] because this is the whole of the arithmetic and a
/// caller reading it should not have to look a field up to check it.
pub fn is_stale(checked_at: Option<i64>, interval: i64, now: i64) -> bool {
    match checked_at {
        None => true,
        Some(at) => at > now || now - at >= interval,
    }
}

/// The taxonomy's state, read from a connection the caller already holds.
pub fn read_status(ds: &Dataset, conn: &Connection, now: i64) -> TagStatus {
    let meta = read_meta(ds, conn);
    TagStatus {
        updated_at: meta.as_ref().and_then(|m| m.stamp.updated_at.clone()),
        ingested_at: meta.as_ref().map(|m| m.ingested_at),
        checked_at: meta.as_ref().map(|m| m.checked_at),
        tag_count: meta.as_ref().map(|m| m.tag_count),
        tagging_count: meta.as_ref().map(|m| m.tagging_count),
        stale: is_stale(
            meta.as_ref().map(|m| m.checked_at),
            ds.refresh_interval_secs,
            now,
        ),
        refreshing: is_refreshing(ds.bulk_name),
    }
}

fn status_of(ds: &Dataset, state: &AppState) -> TagStatus {
    let conn = crate::sync::lock_db_read(state);
    read_status(ds, &conn, unix_now())
}

/// Seconds since the Unix epoch. A clock before 1970 reads as 0, which makes a taxonomy
/// stale — [`crate::sync`]'s choice, for its reason.
fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------------------

/// One refresh **per dataset** at a time.
///
/// A list of names rather than a flag, which is [`crate::marketplace_feed`]'s shape one family
/// over and for its reason: a single flag would make an art refresh refuse because an oracle
/// one happened to be running, and the two share nothing but a rate limiter. Module-level
/// rather than a field on `AppState` because it is this module's concern alone.
static REFRESHING: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

/// Clears the claim however the refresh ends — an early return, an error, a dropped future.
/// `sync::SyncingGuard`'s shape, for its reason: a latched flag locks the user out until they
/// restart the app.
struct RefreshGuard(&'static str);

impl RefreshGuard {
    /// Claim `dataset`, or `None` if a refresh of it is already running.
    fn claim(dataset: &'static str) -> Option<RefreshGuard> {
        let mut held = crate::db::lock_plain(&REFRESHING);
        if held.contains(&dataset) {
            return None;
        }
        held.push(dataset);
        Some(RefreshGuard(dataset))
    }
}

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        crate::db::lock_plain(&REFRESHING).retain(|d| *d != self.0);
    }
}

/// Is a refresh of this dataset in flight?
fn is_refreshing(dataset: &str) -> bool {
    crate::db::lock_plain(&REFRESHING).contains(&dataset)
}

/// Where a tag file is downloaded to. Beside the bulk file's `tmp/`, and deleted either way.
fn temp_path(ds: &Dataset, state: &AppState) -> PathBuf {
    state.data_dir.join("tmp").join(ds.tmp_file)
}

/// Write a failed refresh to `error_log`, best-effort.
///
/// `Source::ScryfallApi` because that is exactly what this is — unlike
/// [`crate::marketplace_feed`], which has to borrow `Database` for want of a source of its
/// own. The `operation` is [`Dataset::bulk_name`], so a reader can tell a tag failure from a
/// card one and one taxonomy from the other.
fn note_failure(ds: &Dataset, db: &Mutex<Connection>, kind: crate::errors::Kind, message: &str) {
    // Skipped rather than waited for if the connection is busy: this describes a failure that
    // has already happened, on a path that is already returning an error.
    if let Some(conn) = crate::db::lock_for(db, crate::db::WRITE_LOCK_WAIT) {
        crate::errors::record(
            &conn,
            crate::errors::Source::ScryfallApi,
            ds.bulk_name,
            kind,
            message,
            None,
        );
    }
}

/// Note that Scryfall has been asked, on a run that found nothing to ingest — and, where the
/// answer carried one, the fresh ETag to replay next time.
///
/// Best-effort and skipped rather than waited for if the connection is busy: the worst a lost
/// stamp costs is one more conditional request a week from now. **Nothing is written when
/// there is no row**, which is the never-ingested state: a watermark with no rows behind it is
/// exactly what would make the next run 304 past an empty taxonomy.
fn mark_checked(ds: &Dataset, state: &Arc<AppState>, etag: Option<Option<&str>>) {
    let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) else {
        return;
    };
    let now = unix_now();
    let _ = match etag {
        Some(etag) => conn.execute(
            &format!(
                "UPDATE {meta} SET checked_at = ?1, etag = ?2 WHERE id = 1",
                meta = ds.meta_table
            ),
            params![now, etag],
        ),
        None => conn.execute(
            &format!(
                "UPDATE {meta} SET checked_at = ?1 WHERE id = 1",
                meta = ds.meta_table
            ),
            params![now],
        ),
    };
}

/// Fetch `ds`'s bulk file if it has changed, and replace that taxonomy with it.
///
/// `force` skips the [`Dataset::refresh_interval_secs`] throttle but **not** the ETag check: a
/// forced refresh that finds the same file answers in well under a second and downloads
/// nothing.
///
/// `progress` is called with `(phase, done, total)`; a binding's command turns that into its
/// [`Dataset::progress_event`]. Taken as a callback rather than an `AppHandle` for
/// [`crate::ingest`]'s reason — it is what lets the whole path be driven from a test.
///
/// Every failure leaves the previous tags exactly where they were, and every one that came
/// from Scryfall or from the file it served is written to `error_log`. (A listing with no
/// size, and a `tmp/` that cannot be created, are refusals *before* any of that and are
/// returned as a sentence — there is nothing about the outside world to record.)
pub async fn refresh(
    ds: &'static Dataset,
    state: &Arc<AppState>,
    force: bool,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<TagStatus, String> {
    let Some(_guard) = RefreshGuard::claim(ds.bulk_name) else {
        // Refused rather than queued, exactly as a second concurrent sync is: the run already
        // in flight is the one driving the progress event.
        return Err(format!("{} are already being refreshed.", ds.label));
    };

    let (stamp, checked_at, populated) = {
        let conn = crate::sync::lock_db_read(state);
        let meta = read_meta(ds, &conn);
        (
            meta.as_ref().map(|m| m.stamp.clone()).unwrap_or_default(),
            meta.as_ref().map(|m| m.checked_at),
            closure_is_populated(ds, &conn),
        )
    };
    if !force && !is_stale(checked_at, ds.refresh_interval_secs, unix_now()) {
        return Ok(status_of(ds, state));
    }

    progress("checking", 0, 0);
    // The stored ETag describes a *file*, not the state of this database: replaying it when
    // the closure is empty earns a 304 for a taxonomy that has nothing in it, and no amount of
    // refreshing gets past that. `crate::sync::conditional_etag`, one dataset over.
    let conditional = stamp.etag.as_deref().filter(|_| populated);
    let check = match state
        .client
        .check_bulk_dataset(ds.bulk_name, conditional)
        .await
    {
        Ok(check) => check,
        Err(e) => {
            note_failure(ds, &state.db, crate::errors::kind_of(&e), &e.to_string());
            progress("error", 0, 0);
            return Err(e.to_string());
        }
    };

    let crate::scryfall::BulkCheck::Available(info) = check else {
        // The common case, and it costs zero bytes. The rows are untouched and only the
        // "when did we last ask" stamp moves — without which an up-to-date taxonomy would be
        // due again on the very next launch.
        mark_checked(ds, state, None);
        progress("done", 0, 0);
        return Ok(status_of(ds, state));
    };
    let updated_at = Some(info.updated_at.clone()).filter(|s| !s.is_empty());

    // A 200 with the file we already hold: the endpoint answers 200 whenever the stored ETag
    // does not match, including when a proxy stripped it, so `updated_at` is the only other
    // evidence the file actually rotated. Store the ETag it came with, so the next check is a
    // free 304 again.
    if populated && updated_at.is_some() && updated_at == stamp.updated_at {
        mark_checked(ds, state, Some(info.etag.as_deref()));
        progress("done", 0, 0);
        return Ok(status_of(ds, state));
    }

    if info.compressed_size == 0 {
        progress("error", 0, 0);
        return Err(format!(
            "the {} listing had no size; refusing to download",
            ds.bulk_name
        ));
    }

    let gz = temp_path(ds, state);
    if let Some(parent) = gz.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            progress("error", 0, 0);
            return Err(format!("could not create {}: {e}", parent.display()));
        }
    }

    progress("downloading", 0, info.compressed_size);
    let mut last_emit = 0u64;
    let downloaded = state
        .client
        .download(
            &info.jsonl_download_uri,
            &gz,
            info.compressed_size,
            &mut |done, total| {
                if done.saturating_sub(last_emit) >= DOWNLOAD_EMIT_BYTES || done >= total {
                    last_emit = done;
                    progress("downloading", done, total);
                }
            },
        )
        .await;
    if let Err(e) = downloaded {
        note_failure(ds, &state.db, crate::errors::kind_of(&e), &e.to_string());
        // A short file is a resume point and is kept on purpose; anything else must not leave
        // a partial behind that every future resume then argues with.
        if !matches!(e, crate::scryfall::ScryfallError::SizeMismatch { .. }) {
            let _ = std::fs::remove_file(&gz);
        }
        progress("error", 0, 0);
        return Err(e.to_string());
    }

    progress("ingesting", 0, 0);
    let stamp = FileStamp {
        etag: info.etag.clone(),
        updated_at,
    };
    let joined = {
        let state = state.clone();
        let gz = gz.clone();
        // Seconds of gzip and hundreds of thousands of inserts: a blocking thread, never the
        // async runtime, and never across an `.await` with a lock in hand.
        tauri::async_runtime::spawn_blocking(move || {
            ingest_gz(ds, &state.db, &gz, &stamp, unix_now(), &mut |_| {})
        })
        .await
    };
    let _ = std::fs::remove_file(&gz);

    match joined {
        Ok(Ok(_)) => {
            progress("done", 0, 0);
            Ok(status_of(ds, state))
        }
        Ok(Err(e)) => {
            note_failure(ds, &state.db, e.kind(), &e.to_string());
            progress("error", 0, 0);
            Err(e.to_string())
        }
        Err(e) => {
            progress("error", 0, 0);
            Err(format!(
                "the {} file could not be processed: {e}",
                ds.bulk_name
            ))
        }
    }
}

/// Refresh `ds` at startup if it is due.
///
/// **Silent, best-effort and never blocking.** It runs before there is a window to complain
/// in, a failure is already in `error_log`, and the honest fallback is the tags already on
/// disk — or, on a first run that fails, whatever the app did before that taxonomy existed.
/// Neither the launch nor the card sync may ever wait on it.
pub async fn refresh_if_due(ds: &'static Dataset, state: &Arc<AppState>, app: &tauri::AppHandle) {
    let due = {
        let conn = crate::sync::lock_db_read(state);
        is_stale(
            read_meta(ds, &conn).map(|m| m.checked_at),
            ds.refresh_interval_secs,
            unix_now(),
        )
    };
    if !due {
        return;
    }
    let app = app.clone();
    if let Err(e) = refresh(ds, state, false, &mut |phase, done, total| {
        emit(ds, &app, phase, done, total)
    })
    .await
    {
        eprintln!("could not refresh {}: {e}", ds.bulk_name);
    }
}

// ---------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------

/// Payload of a [`Dataset::progress_event`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagProgress {
    /// One of [`PHASES`].
    pub phase: String,
    pub done: u64,
    pub total: u64,
}

/// Emit one progress event. Dropped if nobody is listening, which is Tauri's behaviour and is
/// why each binding also has a status command: the event is the fast path, the watermark table
/// is the one a reader can still consult a minute later.
fn emit(ds: &Dataset, app: &tauri::AppHandle, phase: &str, done: u64, total: u64) {
    debug_assert!(
        PHASES.contains(&phase),
        "unknown {} phase `{phase}`",
        ds.bulk_name
    );
    let _ = app.emit(
        ds.progress_event,
        TagProgress {
            phase: phase.to_owned(),
            done,
            total,
        },
    );
}

/// What both bindings' test modules build their input out of.
///
/// Here rather than in one of them because a sibling module cannot reach into another's
/// `mod tests`, and the alternative is a second copy of [`testing::gz_fixture`] — which
/// carries a race fix subtle enough that two copies would be two chances to lose it.
#[cfg(test)]
pub(crate) mod testing {
    use rusqlite::Connection;
    use std::sync::Mutex;

    /// A migrated in-memory database behind the write mutex, which is how the ingest is
    /// handed one.
    pub(crate) fn mem_db() -> Mutex<Connection> {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        Mutex::new(conn)
    }

    /// Tests run in parallel and share the temp directory, so the file name is keyed on the
    /// content — [`crate::ingest`]'s `gz_fixture`, for its reason.
    ///
    /// **Nothing ever opens that path for writing, and that is the whole point** (2026-08-20).
    /// Keying the name on the content stops two *different* fixtures colliding and guarantees
    /// that two **identical** ones collide — which is common here, not rare: the oracle-keyed
    /// read test and the printing-keyed one build the same three lines, so they hash to one
    /// path. `File::create` truncates, so whichever ran second emptied the file the first was
    /// still streaming, and that test failed with `Io(Kind(UnexpectedEof))` on its
    /// `ingest(…).unwrap()` — a panic naming neither the race nor the other test. It went red
    /// on `rust (windows-latest)` while Linux passed, which is what a timing race looks like.
    ///
    /// So: write a private file and move it into place. Losing the move is fine — the bytes
    /// are keyed on the content, so whoever won wrote the same file — and a reader with the
    /// fixture open is what makes the move fail rather than something to avoid.
    pub(crate) fn gz_fixture(lines: &[&str]) -> std::path::PathBuf {
        use flate2::{write::GzEncoder, Compression};
        use std::hash::{DefaultHasher, Hash, Hasher};
        use std::io::Write;
        let mut h = DefaultHasher::new();
        lines.hash(&mut h);
        let p = std::env::temp_dir().join(format!(
            "mtgtest-tags-{}-{:016x}.jsonl.gz",
            lines.len(),
            h.finish()
        ));
        if !p.exists() {
            let tmp = p.with_extension(format!("{}.tmp", next_fixture_id()));
            let mut enc = GzEncoder::new(std::fs::File::create(&tmp).unwrap(), Compression::fast());
            for l in lines {
                enc.write_all(l.as_bytes()).unwrap();
                enc.write_all(b"\n").unwrap();
            }
            enc.finish().unwrap();
            if std::fs::rename(&tmp, &p).is_err() {
                let _ = std::fs::remove_file(&tmp);
            }
        }
        p
    }

    /// A number no other fixture write in this process is using, so the private file a
    /// [`gz_fixture`] builds cannot be the private file another one is building.
    fn next_fixture_id() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

    /// One line of `src-tauri/tests/fixtures/{name}` per element, ready for [`gz_fixture`].
    ///
    /// A file rather than a `format!` for the art fixture, because the things it has to
    /// exercise are things a formatter cannot say: an `annotation` key that is **absent**
    /// rather than null, a `"description": null`, and a line that is not JSON at all.
    pub(crate) fn fixture_lines(name: &str) -> Vec<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} must be readable: {e}", path.display()))
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The ingest and the search have to agree, and nothing would tell us if they stopped.**
    /// `slug_norm` is written by [`normalize`] and a typed needle is compared against it by
    /// [`normalize`]; two copies that drifted would each stay self-consistent and the search
    /// would simply return nothing.
    ///
    /// The four spellings are the ones measured against Scryfall on 2026-08-20:
    /// `otag:"spot removal"`, `otag:spot-removal`, `otag:spotremoval` and `otag:SPOT-REMOVAL`
    /// each returned exactly 4,907 cards, so all four have to fold to one key here.
    #[test]
    fn every_spelling_of_a_tag_name_normalises_to_one_key() {
        for spelling in [
            "spot removal",
            "spot-removal",
            "spotremoval",
            "SPOT-REMOVAL",
        ] {
            assert_eq!(normalize(spelling), "spotremoval", "{spelling}");
        }

        // Digits are kept — `cycle-2` and `cycle2` are one tag, and dropping the 2 would fold
        // it onto `cycle`.
        assert_eq!(normalize("Cycle-2"), "cycle2");
        // And a name with nothing alphanumeric in it normalises to nothing, which is a needle
        // that matches no row rather than one that matches every row.
        assert_eq!(normalize("---"), "");
    }

    /// A closure row reachable from two taggings of different weights resolves to the
    /// stronger. A printing whose `dog` tagging is weak but whose `hound` tagging is strong
    /// is not a weak match — and `hound`'s ancestor is `dog`, so both land on one row.
    #[test]
    fn the_closure_keeps_the_strongest_weight_of_the_taggings_it_descends_from() {
        assert_eq!(stronger("weak", "strong"), "strong");
        assert_eq!(stronger("strong", "weak"), "strong");
        assert_eq!(stronger("median", "very_strong"), "very_strong");
        assert_eq!(stronger("median", "median"), "median");
        // An unknown weight sorts below every known one rather than above: a value this build
        // has not heard of must never silently outrank `very_strong`.
        assert_eq!(stronger("median", "zzz"), "median");
    }
}
