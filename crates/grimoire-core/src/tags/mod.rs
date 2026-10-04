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
use crate::state::State;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

pub mod art;
pub mod muted;
pub mod oracle;
pub mod query;

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

/// A tag name reduced to what Scryfall matches on.
///
/// **The function moved to [`crate::slug`] and this is the same one**, re-exported so that
/// every caller inside this module keeps its spelling. It moved because `schema` needs it
/// too.
pub use crate::slug::normalize;

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

/// **How a host with no files writes the closure**: [`CLOSURE_BATCH_WITHOUT_FILES`] rows to a
/// transaction, and **in key order** — subjects sorted by id, each subject's rows by slug —
/// where every other host writes [`BATCH`] rows in the file's order, as it always has.
/// [`ClosurePlan::of_this_host`] picks, and the rows that end up in the table are the same
/// rows either way (`a_page_writes_the_closure_a_desktop_writes`).
///
/// A host with no files is a browser, whose database is on a rollback journal
/// ([`crate::db::Journal`]): every page a transaction touches is written twice, once to the
/// journal and once to the file, and every commit is a journal made, synced and deleted. The
/// closure's key is `(subject, slug)` and the file's order scatters subjects across it, so in
/// file order nearly every row lands on a page of its own. In key order the table is filled
/// from one end and a page is written when it is full.
///
/// **Chosen from a native measurement and not from a browser's**, which is the thing to
/// re-time. The real art file as a dev corpus held it (11 603 tags, 53 237 illustrations,
/// 979 249 closure rows), a release build, NTFS, 2026-10-04, two runs each — the closure's
/// write alone, in seconds:
///
/// | Journal | File order, 2 000 | File order, 8 000 | Key order, 2 000 | Key order, 8 000 |
/// | --- | --- | --- | --- | --- |
/// | DELETE (what a browser's file gets) | 16.6, 17.8 | 10.5, 10.5 | 6.1, 5.4 | 2.6, 2.8 |
/// | WAL (every native host) | 10.4, 11.6 | 9.8, 8.3 | 4.2, 5.2 | 2.1, 2.1 |
///
/// (File order at 32 000 rows, from an earlier pass of the same probe: 7.4–7.6 s on DELETE,
/// 6.1–6.9 s on WAL.) Sorting the subjects took 6–13 ms. In a browser the same loop, in file
/// order at 2 000 rows, ran at about 49 ms a batch — most of a 23.6 s art finish (headless
/// Chrome 154) — and **no browser has run it in key order**.
///
/// **Eight thousand and not more**: a turn is taken only between two batches, so a batch is
/// also the longest a command waits behind this loop. If a browser shows neither change is
/// where its time goes, [`ClosurePlan::of_this_host`] is the one place to put back.
///
/// ⚠️ **The desktop would gain as much** — a weekly art refresh spends ten seconds on this
/// loop and key order would make it four — and is deliberately left as it was: this change
/// was made for the host that answers nothing while the loop runs, and the desktop's
/// statements were not to move with it.
const CLOSURE_BATCH_WITHOUT_FILES: usize = 8_000;

/// How [`write_closure`] writes on this host: how many rows to a transaction, and in which
/// order. See [`CLOSURE_BATCH_WITHOUT_FILES`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ClosurePlan {
    batch: usize,
    in_key_order: bool,
}

impl ClosurePlan {
    fn of_this_host() -> ClosurePlan {
        if crate::platform::host::keeps_files() {
            ClosurePlan {
                batch: BATCH,
                in_key_order: false,
            }
        } else {
            ClosurePlan {
                batch: CLOSURE_BATCH_WITHOUT_FILES,
                in_key_order: true,
            }
        }
    }
}

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
///
/// **It answers one ingest and not two, and since issue #551 it is not what serves a user
/// write.** With two batch loops running — the launch runs both tag files and the combos at
/// once — whichever is not writing is already parked in `lock()` when the other lets go, so the
/// connection passes straight between them and the gap this sleep opens is never free. Every
/// batch here takes the connection through [`crate::db::lock_background`], which does not start
/// a batch while a [`crate::db::lock_for`] is waiting; that is what serves the user write. The
/// sleep stays for the callers that block rather than poll — another ingest, or a `lock_db` —
/// which it still hands the connection to.
const YIELD_BETWEEN_BATCHES: std::time::Duration = std::time::Duration::from_millis(5);

/// Let go of the connection long enough for a waiting writer to see that it is free.
/// **Call it with no guard in scope** — see [`YIELD_BETWEEN_BATCHES`].
fn stand_aside() {
    crate::platform::pause(YIELD_BETWEEN_BATCHES);
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
/// A `Vec<Vec<u32>>` rather than a memo table, and it has to be affordable for **both** datasets
/// now that this engine is shared. The oracle side is 4 521 tags at depth ≤ 5, which is a walk
/// measured in microseconds; the art side is the bigger claim at **11 531 tags, max depth 10, and
/// 43 % of them with more than one parent** (`art.rs`'s module table). Still fine — depth bounds
/// the walk and every branch stops at the `seen` set — and it is no longer a guess: the whole art
/// ingest, of which this is one step, measured **58.3 s** end to end for 952 729 closure rows in a
/// debug build, and that time is dominated by the inserts rather than by this. **Timed on its
/// own since** (2026-10-04, a release build, the art file as a dev corpus held it — 11 603 tags):
/// **4.5 ms**, against some eleven seconds of closure inserts — which is why the finish takes
/// its turns between batches and none in here. The simple version
/// is the one whose termination argument fits in the paragraph above; if a third dataset ever
/// arrives deeper or wider than the art one, this is the line to re-read.
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
    /// More lines were unusable than were tags — [`crate::feed::mostly_unusable`], and
    /// [`Empty`]'s larger sibling (issue #551). One good line among thousands of bad ones used to
    /// swap in a taxonomy of one tag, and stamp the watermark that kept it for a week.
    ///
    /// [`Empty`]: TagError::Empty
    #[error(
        "only {tags} lines of the tag file were tags and {skipped} were not; \
         keeping the previous ones"
    )]
    MostlySkipped { tags: u64, skipped: u64 },
}

impl TagError {
    /// How the error log should classify this.
    pub fn kind(&self) -> crate::errors::Kind {
        use crate::errors::Kind;
        match self {
            TagError::Io(_) | TagError::Db(_) => Kind::Io,
            TagError::Empty { .. } | TagError::Untagged { .. } | TagError::MostlySkipped { .. } => {
                Kind::Parse
            }
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

/// Everything the read loop used to keep in locals.
///
/// It is a struct rather than seven bindings because [`StreamTags`] hands the whole of it to
/// one closure — `Lines::push` calls back per line, and a closure that captured seven
/// `&mut` fields of `self` would collide with the `&self.lines` driving it.
#[derive(Default)]
struct Accum {
    stats: TagStats,
    /// The file, and the two maps that intern it: uuid → tag index, which resolves
    /// `parent_ids` once the file has been read to the end, and subject id → subject index.
    g: Graph,
    parent_ids: Vec<Vec<String>>,
    by_id: HashMap<String, u32>,
    subject_of: HashMap<String, u32>,
    /// …and the third, which interns [`Graph::weights`]. A map rather than a linear scan of a
    /// four-entry list: the vocabulary is small in every file measured, but a file that had
    /// gone wrong in that particular way would turn the scan quadratic over 475 163 taggings
    /// on a background thread with no window to say so in.
    weight_of: HashMap<String, u32>,
    /// `weight` and `annotation` are never held whole: they go straight to staging with the
    /// row that carries them.
    batch: Vec<(u32, u32, Option<String>, Option<String>)>,
}

impl Accum {
    /// Fold one line into the graph, or count it skipped.
    ///
    /// **Infallible, and that is what lets it be the `Lines::push` callback.** The database
    /// is never touched here; [`StreamTags::flush_full_batches`] does that after the framer
    /// has returned, which is [`crate::ingest::StreamIngest`]'s arrangement exactly.
    fn take_line(&mut self, ds: &Dataset, line: &[u8]) {
        // Parsed with the lock *not* held: it is the expensive half of the loop, and the
        // whole point of batching is that the connection is free during it.
        let parsed = std::str::from_utf8(line)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            .as_ref()
            .and_then(|v| parse_tag_line(ds, v));
        let Some(tag) = parsed else {
            // **A blank line counts as skipped, and that is deliberately not
            // `crate::ingest::StreamIngest`'s rule one feed over.** `BufRead::lines()`, which
            // the pull loop this replaced used, yields an empty record for a blank line and
            // `serde_json` refuses it — so counting it here is what keeps the two drivers'
            // `skipped_lines` identical. A stream that merely *ends* on a newline produces no
            // such record: `frame::Lines::finish` emits nothing for an empty tail.
            self.stats.skipped_lines += 1;
            return;
        };

        let index = self.g.tags.len() as u32;
        // An **id** the file repeats is one tag, not two: the first line wins and the
        // second's taggings are folded onto it, exactly as the `INSERT OR IGNORE`s below
        // would have them. (Two *different* ids sharing a slug fold the same way, one table
        // down: the slug is the key everything here is stored under.)
        let index = *self.by_id.entry(tag.id.clone()).or_insert(index);
        if index == self.g.tags.len() as u32 {
            self.g.tags.push(Tag {
                id: tag.id,
                slug: tag.slug,
                label: tag.label,
                description: tag.description,
                parents: Vec::new(),
            });
            self.parent_ids.push(tag.parent_ids);
        }

        for tagging in tag.taggings {
            let subject = match self.subject_of.get(&tagging.subject) {
                Some(&s) => s,
                None => {
                    let s = self.g.subjects.len() as u32;
                    self.subject_of.insert(tagging.subject.clone(), s);
                    self.g.subjects.push(tagging.subject);
                    self.g.held.push(Vec::new());
                    s
                }
            };
            // The weight the closure will fold, interned. **A tagging that states none is
            // read as [`DEFAULT_WEIGHT`] here and stored as NULL below** — the closure's
            // column is `NOT NULL` and the taggings table's is not, so the two disagree on
            // purpose: one records what the file said, the other what the search must rank.
            let weight = {
                let w = tagging.weight.as_deref().unwrap_or(DEFAULT_WEIGHT);
                match self.weight_of.get(w) {
                    Some(&i) => i,
                    None => {
                        let i = self.g.weights.len() as u32;
                        self.weight_of.insert(w.to_owned(), i);
                        self.g.weights.push(w.to_owned());
                        i
                    }
                }
            };
            self.g.held[subject as usize].push((index, weight));
            self.batch
                .push((subject, index, tagging.weight, tagging.annotation));
        }
    }
}

/// A tag ingest as an object the caller pushes bytes into, rather than a loop that pulls.
///
/// [`ingest_gz`] is the driver: it reads the file a chunk at a time and pushes each one here,
/// and the state a read loop would keep in locals lives in [`Accum`] —
/// [`crate::ingest::StreamIngest`]'s arrangement, one feed over.
///
/// **Gzipped or not is decided from the bytes** — [`crate::feed::frame::Decoder`] sniffs the
/// two magic bytes rather than trusting a header.
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
pub struct StreamTags<'a> {
    ds: &'a Dataset,
    db: &'a Mutex<Connection>,
    decoder: crate::feed::frame::Decoder,
    lines: crate::feed::frame::Lines,
    decoded: Vec<u8>,
    acc: Accum,
    written: u64,
}

impl<'a> StreamTags<'a> {
    /// Create `ds`'s staging tables and get ready for the first chunk.
    ///
    /// Made here rather than on the first `push` so that a caller that never gets a byte
    /// still leaves a database in the state the next run expects — [`crate::ingest::
    /// StreamIngest::begin`]'s reason.
    pub fn begin(ds: &'a Dataset, db: &'a Mutex<Connection>) -> Result<Self, TagError> {
        {
            let conn = crate::db::lock_background(db);
            (ds.create_staging)(&conn)?;
        }
        Ok(StreamTags {
            ds,
            db,
            decoder: crate::feed::frame::Decoder::new(),
            lines: crate::feed::frame::Lines::new(),
            decoded: Vec::new(),
            acc: Accum {
                batch: Vec::with_capacity(BATCH),
                ..Accum::default()
            },
            written: 0,
        })
    }

    /// Feed one chunk of the download.
    pub fn push(&mut self, chunk: &[u8], progress: &mut dyn FnMut(u64)) -> Result<(), TagError> {
        self.decoded.clear();
        self.decoder.push(chunk, &mut self.decoded)?;
        {
            let acc = &mut self.acc;
            let ds = self.ds;
            self.lines
                .push(&self.decoded, |line| acc.take_line(ds, line))
                .map_err(std::io::Error::from)?;
        }
        self.flush_full_batches(progress)
    }

    /// Commit whatever whole batches the last chunk produced, then let go of the connection.
    ///
    /// The batch can overshoot [`BATCH`] by one line's taggings, because a line is folded
    /// whole before the framer returns. It is bounded by that line, which the framer already
    /// caps at `feed::frame::MAX_LINE_BYTES`, and the pull loop this replaced held the same
    /// parsed line in memory anyway.
    fn flush_full_batches(&mut self, progress: &mut dyn FnMut(u64)) -> Result<(), TagError> {
        if self.acc.batch.len() >= BATCH {
            self.acc.stats.taggings += self.acc.batch.len() as u64;
            write_taggings(self.ds, self.db, &self.acc.g, &mut self.acc.batch)?;
            self.written = self.acc.stats.taggings;
            progress(self.written);
        }
        Ok(())
    }

    /// Give up on a stream that will not be finished, and drop the staging tables it filled —
    /// for a caller that feeds this from the network, where a body that stops arriving is an
    /// ordinary failure ([`crate::ingest::StreamIngest::abandon`] has the argument). Best-effort:
    /// tables that could not be dropped now are dropped by the next run's
    /// [`Dataset::create_staging`].
    pub fn abandon(self) {
        let conn = crate::db::lock_background(self.db);
        let _ = (self.ds.drop_staging)(&conn);
    }

    /// Flush what is owed, refuse a file that is not a taxonomy, and swap staging into place.
    ///
    /// `progress` is called with the running row count every [`BATCH`] rows, and once more
    /// when the swap is done.
    ///
    /// **[`StreamTags::finish_in_turns`] with no turn to take, run where it stands**
    /// (`platform::timer::unbroken`): one body for every host, and on this door — the
    /// file-backed ingest's, on a host with threads — it is the synchronous function it always
    /// was, statement for statement.
    pub fn finish(
        self,
        stamp: &FileStamp,
        ingested_at: i64,
        progress: &mut dyn FnMut(u64),
    ) -> Result<TagStats, TagError> {
        crate::platform::timer::unbroken(self.finish_in_turns(
            stamp,
            ingested_at,
            progress,
            &mut crate::platform::timer::NoTurn,
        ))
    }

    /// [`StreamTags::finish`], **giving the host a turn in every gap between two batches**.
    ///
    /// The finish is four loops of short transactions — the last taggings, the tags, the
    /// edges and the closure — and then the swap. Each batch takes the write connection,
    /// commits and lets go, so between two of them the database is whole and nothing is held:
    /// what has been written so far is in the `_staging` twins, which no reader can see, and
    /// the live tables are the previous taxonomy until the swap's one transaction. That gap
    /// is where `turn` is awaited. Handed a `platform::timer::Breather`, the engine goes back
    /// to its event loop there on a budget of work, and a command a page sent is answered —
    /// from the previous tags — before the next batch. On a host with one thread nothing else
    /// could let it in: the first measured browser run answered nothing for 10.8 s of an
    /// oracle finish and 23.6 s of an art one (`docs/reference/light-app.md` §9.2).
    ///
    /// **Nothing is held across a turn** — no guard, no transaction. Every batch is written
    /// by a function that takes the connection and has let go before it returns, so the
    /// `.await`s below sit between calls and never inside one;
    /// `nothing_is_held_across_a_turn` is the compiler's word for it.
    ///
    /// **What still runs to its end without a turn**: the graph walk
    /// ([`ancestor_closures`], pure CPU) and the swap, which is one transaction by need —
    /// four renames, the two indexes a rename does not carry, and the watermark.
    pub async fn finish_in_turns<P: FnMut(u64) + ?Sized>(
        mut self,
        stamp: &FileStamp,
        ingested_at: i64,
        progress: &mut P,
        turn: &mut impl crate::platform::timer::Turn,
    ) -> Result<TagStats, TagError> {
        self.decoded.clear();
        self.decoder.finish(&mut self.decoded)?;
        {
            let acc = &mut self.acc;
            let ds = self.ds;
            // **The full-batch drain runs again below, and that is not belt-and-braces.**
            // `flate2::write::GzDecoder` holds a tail back until `try_finish`, so a file
            // small enough to arrive in one chunk delivers its last lines *after* the push
            // loop has ended — `crate::ingest::StreamIngest::finish` names the measurement.
            self.lines
                .push(&self.decoded, |line| acc.take_line(ds, line))
                .map_err(std::io::Error::from)?;
            self.lines.finish(|line| acc.take_line(ds, line));
        }
        self.flush_full_batches(&mut |written| progress(written))?;
        turn.take().await;

        // Destructured so the rest of this reads as the pull loop's tail did — the swap, the
        // refusals and the graph walk are unchanged from the day they were written.
        let StreamTags {
            ds,
            db,
            acc,
            mut written,
            ..
        } = self;
        let Accum {
            mut stats,
            mut g,
            parent_ids,
            by_id,
            mut batch,
            ..
        } = acc;

        if !batch.is_empty() {
            stats.taggings += batch.len() as u64;
            write_taggings(ds, db, &g, &mut batch)?;
            written = stats.taggings;
            turn.take().await;
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
        //
        // **And a third: more lines unusable than tags** — [`crate::feed::mostly_unusable`].
        let tags = g.tags.len() as u64;
        let refusal = match (tags, stats.taggings) {
            (0, _) => Some(TagError::Empty {
                skipped: stats.skipped_lines,
            }),
            (_, 0) => Some(TagError::Untagged { tags }),
            _ if crate::feed::mostly_unusable(tags, stats.skipped_lines) => {
                Some(TagError::MostlySkipped {
                    tags,
                    skipped: stats.skipped_lines,
                })
            }
            _ => None,
        };
        if let Some(err) = refusal {
            let conn = crate::db::lock_background(db);
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
            flush_tags(db, &tags_sql, chunk)?;
            written += chunk.len() as u64;
            progress(written);
            turn.take().await;
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
        write_edges(ds, db, &g, &mut written, progress, turn).await?;

        // The closure. Computed with no lock held — this is pure CPU over the tag list — and then
        // unioned per subject: a subject holding two tags that share an ancestor gets that
        // ancestor once, which is what the `(subject, slug)` primary key would insist on anyway.
        let closures = ancestor_closures(&g.tags);
        stats.closure_rows =
            write_closure(ds, db, &g, &closures, &mut written, progress, turn).await?;

        {
            let mut conn = crate::db::lock_background(db);
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
}

/// How much of the file is read at a time by [`ingest_gz`]. `crate::ingest::ingest_gz`'s
/// figure, so the two ingests behave the same way against the same disk.
const READ_CHUNK: usize = 64 * 1024;

/// Stream a gzipped tag file into `ds`'s staging tables, flatten the hierarchy, and swap the
/// result into place.
///
/// **The driver over [`StreamTags`], and nothing about the ingest lives here.** It
/// reads the file [`READ_CHUNK`] bytes at a time and pushes; every rule the ingest follows —
/// the batched connection, the staged write, the two refusals, the watermark in the swap's own
/// transaction — is documented on the type.
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
    use std::io::Read as _;

    // Opened before the database is touched: a missing or unreadable path must not cost the
    // caller the staging tables it was about to fill.
    let mut file = crate::platform::files::open(gz_path)?;
    let mut sink = StreamTags::begin(ds, db)?;
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        sink.push(&buf[..n], progress)?;
    }
    sink.finish(stamp, ingested_at, progress)
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
    let mut conn = crate::db::lock_background(db);
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

/// One batch of tags, then let go of the connection. `sql` is the five-column insert
/// [`StreamTags::finish_in_turns`] builds once for the dataset.
fn flush_tags(db: &Mutex<Connection>, sql: &str, chunk: &[Tag]) -> Result<(), TagError> {
    let mut conn = crate::db::lock_background(db);
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(sql)?;
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
    Ok(())
}

/// The parent edges, batched the same way — with a turn for the host after each batch.
async fn write_edges<P: FnMut(u64) + ?Sized>(
    ds: &Dataset,
    db: &Mutex<Connection>,
    g: &Graph,
    written: &mut u64,
    progress: &mut P,
    turn: &mut impl crate::platform::timer::Turn,
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
            turn.take().await;
        }
    }
    if !pending.is_empty() {
        let n = pending.len() as u64;
        flush_edges(ds, db, &mut pending)?;
        *written += n;
        turn.take().await;
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
    let mut conn = crate::db::lock_background(db);
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
/// **How many rows to a transaction, and in which order, is [`ClosurePlan`]'s**: the file's
/// order and [`BATCH`] rows on a host with files, the key's order and larger batches on one
/// without. The rows are the same.
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
async fn write_closure<P: FnMut(u64) + ?Sized>(
    ds: &Dataset,
    db: &Mutex<Connection>,
    g: &Graph,
    closures: &[Vec<u32>],
    written: &mut u64,
    progress: &mut P,
    turn: &mut impl crate::platform::timer::Turn,
) -> Result<u64, TagError> {
    let mut rows = 0u64;
    let plan = ClosurePlan::of_this_host();
    let batch = plan.batch;
    // The subjects, in the order their rows are written: the file's, or the key's.
    let mut order: Vec<u32> = (0..g.held.len() as u32).collect();
    if plan.in_key_order {
        order.sort_unstable_by(|a, b| g.subjects[*a as usize].cmp(&g.subjects[*b as usize]));
    }
    let mut pending: Vec<(&str, &str, &str)> = Vec::with_capacity(batch);
    // Tag index → the strongest weight of the taggings that reach it. A map rather than a set
    // for both datasets: the value is simply never written for one that carries no weight,
    // and one code path is one place for the union to be right.
    let mut inherited: HashMap<u32, &str> = HashMap::new();
    for subject in order {
        let subject = subject as usize;
        let held = &g.held[subject];
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
        if plan.in_key_order {
            // By slug, and by index where two tags share one: the insert is `OR IGNORE`, so
            // the first of such a pair is the row that stays, and on every host that is the
            // lower index.
            slugs.sort_unstable_by(|a, b| {
                (g.tags[*a as usize].slug.as_str(), a).cmp(&(g.tags[*b as usize].slug.as_str(), b))
            });
        } else {
            slugs.sort_unstable();
        }
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
        if pending.len() >= batch {
            let n = pending.len() as u64;
            flush_closure(ds, db, &mut pending)?;
            *written += n;
            progress(*written);
            // Between two subjects and between two transactions: the one place in this
            // loop where nothing is half-written and nothing is held.
            turn.take().await;
        }
    }
    if !pending.is_empty() {
        let n = pending.len() as u64;
        flush_closure(ds, db, &mut pending)?;
        *written += n;
        turn.take().await;
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
    let mut conn = crate::db::lock_background(db);
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

pub fn status_of(ds: &Dataset, state: &State) -> TagStatus {
    let conn = state.lock_db_read();
    let now = now_from(&conn);
    read_status(ds, &conn, now)
}

/// Now, in unix seconds, **asked of SQLite rather than of the clock**.
///
/// `unwrap_or(0)` reads as "1970", which makes a taxonomy stale — the same answer
/// [`unix_now`] gives for a clock before the epoch, and the safe direction: a stale taxonomy
/// is re-checked, a fresh one is not. `sync_engine::entitlement::now` is the precedent.
pub(crate) fn now_from(conn: &Connection) -> i64 {
    conn.query_row("SELECT unixepoch()", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
}

/// Seconds since the Unix epoch. A clock before 1970 reads as 0, which makes a taxonomy
/// stale — [`crate::sync`]'s choice, for its reason.
fn unix_now() -> i64 {
    crate::platform::clock::now_secs()
}

// ---------------------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------------------

/// One refresh **per dataset** at a time.
///
/// A list of names rather than a flag, which is [`crate::marketplace_feed`]'s shape one family
/// over and for its reason: a single flag would make an art refresh refuse because an oracle
/// one happened to be running, and the two share nothing but a rate limiter. Module-level
/// rather than a field on the [`State`] because it is this module's concern alone.
static REFRESHING: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

/// Clears the claim however the refresh ends — an early return, an error, a dropped future.
/// `sync::SyncingGuard`'s shape, for its reason: a latched flag locks the user out until they
/// restart the app.
pub(crate) struct RefreshGuard(&'static str);

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

/// Is a refresh of **either** dataset in flight?
///
/// **[`crate::reset::cache_clear`] is the one caller, and the question is about `data/tmp/`
/// rather than about tags.** A refresh downloads into [`temp_path`] and then reopens that file
/// to ingest it, so a cache sweep landing between the two fails the refresh — and both
/// datasets are fetched uninvited at every launch that finds them a week old, so a reader
/// pressing Clear in the first minute is not a contrived case. The claim is the answer because
/// it is held for exactly the span the file is in use.
pub(crate) fn any_refresh_running() -> bool {
    !crate::db::lock_plain(&REFRESHING).is_empty()
}

/// Hold a refresh claim under `name` until the guard is dropped, with no download behind it.
///
/// For a test in another module that needs [`any_refresh_running`] to answer `true`.
/// **`name` must be neither dataset's `bulk_name`** — the registry is process-wide and the
/// tests run in parallel, so claiming a real one would make this module's own refresh tests
/// answer "already being refreshed" at random.
#[cfg(test)]
pub(crate) fn hold_refresh_for_test(name: &'static str) -> RefreshGuard {
    RefreshGuard::claim(name).expect("a test-only name no other test claims")
}

/// Where a tag file is downloaded to. Beside the bulk file's `tmp/`, and deleted either way.
fn temp_path(ds: &Dataset, state: &State) -> PathBuf {
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
fn mark_checked(ds: &Dataset, state: &State, etag: Option<Option<&str>>) {
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
/// `progress` is called with `(phase, done, total)`; a caller that has somebody to tell hands
/// it [`emit`], which says each as the binding's [`Dataset::progress_event`]. Taken as a
/// callback for [`crate::ingest`]'s reason — it is what lets the whole path be driven from a
/// test.
///
/// Every failure leaves the previous tags exactly where they were, and every one that came
/// from Scryfall or from the file it served is written to `error_log`. (A listing with no
/// size, and a `tmp/` that cannot be created, are refusals *before* any of that and are
/// returned as a sentence — there is nothing about the outside world to record.) A file that
/// arrived and could not be used also rests the dataset for a day at launch —
/// [`crate::feed::backoff`].
///
/// **A 429 the check earns is written to disk before this returns** (issue #551). The check
/// goes through the one Scryfall client, so the lockout is charged to the whole application,
/// but only [`crate::sync::run_sync`] used to persist it — so a restart after a tag check's
/// 429 walked straight back into the lockout the docs forbid ignoring. Written only when this
/// run moved the deadline, so a refresh that talked to nobody writes nothing.
pub async fn refresh(
    ds: &'static Dataset,
    state: &Arc<State>,
    force: bool,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<TagStatus, String> {
    let penalty_before = state.client.penalty_until_unix();
    let result = refresh_once(ds, state, force, progress).await;
    if state.client.penalty_until_unix() != penalty_before {
        crate::sync::persist_penalty(state);
    }
    result
}

/// [`refresh`] without the lockout bookkeeping, which it wraps so that no return below can
/// skip it.
async fn refresh_once(
    ds: &'static Dataset,
    state: &Arc<State>,
    force: bool,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<TagStatus, String> {
    let Some(_guard) = RefreshGuard::claim(ds.bulk_name) else {
        // Refused rather than queued, exactly as a second concurrent sync is: the run already
        // in flight is the one driving the progress event.
        return Err(format!("{} are already being refreshed.", ds.label));
    };

    let (stamp, checked_at, populated) = {
        let conn = state.lock_db_read();
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

    // A host that keeps no files has no `tmp/` to download into: the body goes to the sink
    // as it arrives. Decided before the download is asked for, never after.
    if !crate::platform::host::keeps_files() {
        return refresh_streamed(ds, state, &info, updated_at, progress).await;
    }

    let gz = temp_path(ds, state);
    if let Some(parent) = gz.parent() {
        if let Err(e) = crate::platform::files::create_dir_all(parent) {
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
        if matches!(e, crate::scryfall::ScryfallError::SizeMismatch { .. }) {
            // The body ended and disagreed with the manifest's size: upstream's answer, and it
            // will be the same answer next launch.
            note_unusable(ds, &state.db);
        } else {
            crate::scryfall::discard_partial(&gz);
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
        // Seconds of gzip and hundreds of thousands of inserts: off the async task where the
        // host has somewhere to put it, and never across an `.await` with a lock in hand.
        crate::platform::spawn::blocking(move || {
            ingest_gz(ds, &state.db, &gz, &stamp, unix_now(), &mut |_| {})
        })
        .await
    };
    crate::scryfall::discard_partial(&gz);

    match joined {
        Ok(Ok(_)) => {
            if let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
                let _ = crate::feed::backoff::clear(&conn, ds.bulk_name);
            }
            progress("done", 0, 0);
            Ok(status_of(ds, state))
        }
        Ok(Err(e)) => {
            note_failure(ds, &state.db, e.kind(), &e.to_string());
            note_unusable(ds, &state.db);
            progress("error", 0, 0);
            Err(e.to_string())
        }
        Err(e) => {
            note_unusable(ds, &state.db);
            progress("error", 0, 0);
            Err(format!(
                "the {} file could not be processed: {e}",
                ds.bulk_name
            ))
        }
    }
}

/// The download and the ingest of [`refresh_once`] as one pass, **on a host that keeps no
/// files**: one streamed `GET`, each chunk pushed into [`StreamTags`] as it arrives.
///
/// `sync`'s streamed card run, one family over, and its three rules: **no lock crosses an
/// `.await`** — the sink takes the write connection a batch at a time inside `push` and has
/// let go before it returns; **the size check is the stream's**, which answers the end of the
/// body only when the listed number of bytes arrived, so the swap in `finish` is unreachable
/// over a short one; and **a run that fails drops what it staged**, because here a connection
/// that dies mid-body is an ordinary failure rather than a kill.
///
/// The phases are the file-backed run's, each true as said: `downloading` counts bytes while
/// the body arrives, and `ingesting` — once, with no count, as that run says it — is the
/// graph walk, the closure and the swap that follow the last byte. **That tail takes a turn
/// between its batches** ([`StreamTags::finish_in_turns`], on the breather the loop below
/// keeps), so a command a page sends during it is answered from the previous tags; only the
/// swap itself, one transaction, answers nothing until it has committed.
async fn refresh_streamed(
    ds: &'static Dataset,
    state: &Arc<State>,
    info: &crate::scryfall::BulkInfo,
    updated_at: Option<String>,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<TagStatus, String> {
    let total = info.compressed_size;
    // The sink first, the request second: a database that cannot take the staging tables is
    // found out before the file is asked for, not after.
    let mut sink = match StreamTags::begin(ds, &state.db) {
        Ok(sink) => sink,
        Err(e) => {
            note_failure(ds, &state.db, e.kind(), &e.to_string());
            progress("error", 0, 0);
            return Err(e.to_string());
        }
    };
    progress("downloading", 0, total);
    let mut stream = match state.client.stream(&info.jsonl_download_uri, total).await {
        Ok(stream) => stream,
        Err(e) => {
            sink.abandon();
            note_failure(ds, &state.db, crate::errors::kind_of(&e), &e.to_string());
            progress("error", 0, 0);
            return Err(e.to_string());
        }
    };

    let mut last_emit = 0u64;
    let mut breather = crate::platform::timer::Breather::new(crate::feed::WORK_BUDGET);
    loop {
        // Nothing is held across either `.await` of the loop.
        let chunk = match stream.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => {
                sink.abandon();
                note_failure(ds, &state.db, crate::errors::kind_of(&e), &e.to_string());
                // The body ended and disagreed with the listing's size: upstream's answer,
                // and it will be the same answer next launch.
                if matches!(e, crate::scryfall::ScryfallError::SizeMismatch { .. }) {
                    note_unusable(ds, &state.db);
                }
                progress("error", 0, 0);
                return Err(e.to_string());
            }
        };
        if let Err(e) = sink.push(&chunk, &mut |_| {}) {
            sink.abandon();
            note_failure(ds, &state.db, e.kind(), &e.to_string());
            note_unusable(ds, &state.db);
            progress("error", 0, 0);
            return Err(e.to_string());
        }
        let done = stream.received();
        if done.saturating_sub(last_emit) >= DOWNLOAD_EMIT_BYTES || done >= total {
            last_emit = done;
            progress("downloading", done, total);
        }
        // The turn a queued command is answered in — `sync`'s streamed run has why the
        // await above is not one.
        breather.breathe().await;
    }

    progress("ingesting", 0, 0);
    let stamp = FileStamp {
        etag: info.etag.clone(),
        updated_at,
    };
    // The same breather the chunk loop kept: the finish is longer than the download was,
    // and it takes its turns on the budget the download did.
    match sink
        .finish_in_turns(&stamp, unix_now(), &mut |_| {}, &mut breather)
        .await
    {
        Ok(_) => {
            if let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
                let _ = crate::feed::backoff::clear(&conn, ds.bulk_name);
            }
            progress("done", 0, 0);
            Ok(status_of(ds, state))
        }
        Err(e) => {
            note_failure(ds, &state.db, e.kind(), &e.to_string());
            note_unusable(ds, &state.db);
            progress("error", 0, 0);
            Err(e.to_string())
        }
    }
}

/// Rest `ds` for a day at launch: its file arrived whole and could not be used, and fetching
/// it again at the next start would only fail the same way — [`crate::feed::backoff`].
/// Best-effort for [`note_failure`]'s reason.
fn note_unusable(ds: &Dataset, db: &Mutex<Connection>) {
    if let Some(conn) = crate::db::lock_for(db, crate::db::WRITE_LOCK_WAIT) {
        let _ = crate::feed::backoff::note_unusable(&conn, ds.bulk_name, unix_now());
    }
}

/// Refresh `ds` at startup if it is due.
///
/// **Silent, best-effort and never blocking.** It runs before there is a window to complain
/// in, a failure is already in `error_log`, and the honest fallback is the tags already on
/// disk — or, on a first run that fails, whatever the app did before that taxonomy existed.
/// Neither the launch nor the card sync may ever wait on it.
///
/// **A dataset whose last file arrived and could not be used rests for a day first**
/// ([`crate::feed::backoff`]), which [`refresh`] itself does not: a reader's Refresh is how they
/// ask for another try.
pub async fn refresh_if_due(ds: &'static Dataset, state: &Arc<State>) {
    if !due_at_launch(ds, state, unix_now()) {
        return;
    }
    if let Err(e) = refresh(ds, state, false, &mut |phase, done, total| {
        emit(ds, state, phase, done, total)
    })
    .await
    {
        eprintln!("could not refresh {}: {e}", ds.bulk_name);
    }
}

/// Should the launch refresh `ds` at `now`? Stale, and not resting after an unusable file. `pub`
/// for [`crate::downloads::launch_due`].
pub fn due_at_launch(ds: &Dataset, state: &State, now: i64) -> bool {
    let conn = state.lock_db_read();
    is_stale(
        read_meta(ds, &conn).map(|m| m.checked_at),
        ds.refresh_interval_secs,
        now,
    ) && !crate::feed::backoff::resting(&conn, ds.bulk_name, now)
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

/// Say one step of `ds`'s refresh, as its [`Dataset::progress_event`], through the host's
/// event sink ([`crate::events::EventSink`]). Dropped if nobody is listening, which is why each
/// binding also has a status read: the event is the fast path, the watermark table is the one
/// a reader can still consult a minute later.
pub fn emit(ds: &Dataset, state: &State, phase: &str, done: u64, total: u64) {
    debug_assert!(
        PHASES.contains(&phase),
        "unknown {} phase `{phase}`",
        ds.bulk_name
    );
    crate::events::emit(
        &*state.events,
        ds.progress_event,
        &TagProgress {
            phase: phase.to_owned(),
            done,
            total,
        },
    );
}

/// **The fence, and it is the compiler's**: a finish that takes turns may hold no lock across
/// one, and a future that keeps a `MutexGuard` across an `.await` is not `Send`.
/// `sync_engine::client`'s has the argument, and why the bound is
/// [`crate::platform::Sendable`] rather than `Send`. Never called.
#[allow(dead_code)]
fn nothing_is_held_across_a_turn(
    sink: StreamTags<'_>,
    stamp: &FileStamp,
    breather: &mut crate::platform::timer::Breather,
) {
    fn sendable<T: crate::platform::Sendable>(_: T) {}
    sendable(sink.finish_in_turns(stamp, 0, &mut |_| {}, breather));
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
        let conn = crate::schema::memory_pair();
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

    /// One line of this crate's `tests/fixtures/{name}` per element, ready for [`gz_fixture`].
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

    /// The re-export above is what keeps five call sites inside this module — and `schema`'s
    /// own test — spelled the way they always were. A re-export that quietly stopped pointing
    /// at `slug` would be invisible everywhere else. (It lived beside the function until
    /// `slug` moved to `grimoire-core`, which cannot name this module.)
    #[test]
    fn the_normalize_re_export_is_slugs_function() {
        assert_eq!(
            normalize("Spot-Removal"),
            crate::slug::normalize("Spot-Removal")
        );
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

    // ---- the push-shaped ingest -------------------------------------------------------
    //
    // `ingest_gz` is a driver over `StreamTags`. What these hold is that pushing the same
    // bytes straight into the sink, in chunks of any size, agrees with it.

    use crate::tags::testing::{gz_fixture, mem_db};

    /// One oracle tag line. `parents` are uuids, `cards` are oracle ids.
    fn line(id: &str, slug: &str, parents: &[&str], cards: &[&str]) -> String {
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
            r#"{{"object":"tag","id":"{id}","label":"{slug}","slug":"{slug}","type":"oracle","description":null,"parent_ids":[{parents}],"child_ids":[],"aliases":[],"taggings":[{taggings}]}}"#
        )
    }

    fn gz_bytes(lines: &[&str]) -> Vec<u8> {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write as _;
        let mut e = GzEncoder::new(Vec::new(), Compression::fast());
        for l in lines {
            e.write_all(l.as_bytes()).unwrap();
            e.write_all(b"\n").unwrap();
        }
        e.finish().unwrap()
    }

    /// Every `(subject, slug)` the closure holds, sorted — the whole of what an ingest is for.
    fn closure_rows(db: &Mutex<Connection>) -> Vec<(String, String)> {
        let conn = crate::db::lock_blocking(db);
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {subject}, slug FROM {table} ORDER BY 1, 2",
                subject = crate::tags::oracle::ORACLE.subject_column,
                table = crate::tags::oracle::ORACLE.closure_table
            ))
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows
    }

    fn push_all(db: &Mutex<Connection>, bytes: &[u8], chunk: usize) -> Result<TagStats, TagError> {
        let mut sink = StreamTags::begin(&crate::tags::oracle::ORACLE, db)?;
        for c in bytes.chunks(chunk) {
            sink.push(c, &mut |_| {})?;
        }
        sink.finish(&FileStamp::default(), 1_800_000_000, &mut |_| {})
    }

    /// The two drivers must not disagree, and the chunk size must not change the answer.
    ///
    /// Seven bytes at a time splits gzip members, JSON lines and multi-byte structure all in
    /// the middle.
    #[test]
    fn a_chunked_push_produces_exactly_what_the_file_driver_does() {
        let lines = [
            line("a1", "ramp", &[], &["oid-1", "oid-2"]),
            line("a2", "ramp-land", &["a1"], &["oid-3"]),
            line("a3", "removal", &[], &["oid-1"]),
            "this line is not JSON at all".to_owned(),
            // A blank line, which `BufRead::lines()` yields as an empty record and the framer
            // yields as an empty slice: both drivers must call it skipped, or the two counts
            // drift by one on any file that has one.
            String::new(),
        ];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();

        let by_file = mem_db();
        let from_file = ingest_gz(
            &crate::tags::oracle::ORACLE,
            &by_file,
            &gz_fixture(&refs),
            &FileStamp::default(),
            1_800_000_000,
            &mut |_| {},
        )
        .unwrap();

        let by_stream = mem_db();
        let from_stream = push_all(&by_stream, &gz_bytes(&refs), 7).unwrap();

        assert_eq!(from_stream, from_file, "the two drivers must count alike");
        assert_eq!(from_stream.tags, 3);
        assert_eq!(from_stream.taggings, 4);
        assert_eq!(
            from_stream.skipped_lines, 2,
            "the junk line and the blank one"
        );
        assert_eq!(closure_rows(&by_stream), closure_rows(&by_file));
        // The flattening really happened: `oid-3` holds `ramp-land` and its ancestor `ramp`.
        assert!(closure_rows(&by_stream).contains(&("oid-3".into(), "ramp".into())));
    }

    /// Plain JSONL ingests exactly as the gzipped file does — the decoder decides from the
    /// bytes rather than from a header.
    #[test]
    fn a_stream_that_arrives_already_decompressed_ingests_identically() {
        let lines = [
            line("a1", "ramp", &[], &["oid-1"]),
            line("a2", "ramp-land", &["a1"], &["oid-2"]),
        ];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let plain = refs.join("\n").into_bytes();

        let gz = mem_db();
        let gz_stats = push_all(&gz, &gz_bytes(&refs), 64).unwrap();
        let raw = mem_db();
        // No trailing newline either: `Lines::finish` is what emits the last record, and a
        // stream cut off at the end of its last line is the common case rather than the edge.
        let raw_stats = push_all(&raw, &plain, 64).unwrap();

        assert_eq!(raw_stats, gz_stats);
        assert_eq!(closure_rows(&raw), closure_rows(&gz));
        assert_eq!(raw_stats.taggings, 2);
    }

    /// A file that decoded and held no tag swaps nothing — the refusal that stops a gzipped
    /// error page replacing a working taxonomy with an empty one. It has to survive the move
    /// to a push driver, because it is the failure that does not self-heal: a swap would
    /// stamp the ETag too, and every weekly check after it would be told 304.
    #[test]
    fn a_stream_with_no_tag_in_it_is_refused_and_swaps_nothing() {
        let db = mem_db();
        let err = push_all(&db, b"not json\nstill not json\n", 5).unwrap_err();
        assert!(
            matches!(err, TagError::Empty { skipped: 2 }),
            "expected Empty {{ skipped: 2 }}, got {err:?}"
        );
        assert!(closure_rows(&db).is_empty());
    }

    /// Tags with not one tagging between them is the other refusal, and the more dangerous:
    /// the art file served under the oracle name looks exactly like this.
    #[test]
    fn a_stream_of_tags_with_no_taggings_is_refused() {
        let db = mem_db();
        let lines = [
            line("a1", "ramp", &[], &[]),
            line("a2", "removal", &[], &[]),
        ];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let err = push_all(&db, &gz_bytes(&refs), 64).unwrap_err();
        assert!(
            matches!(err, TagError::Untagged { tags: 2 }),
            "expected Untagged {{ tags: 2 }}, got {err:?}"
        );
    }

    /// A tagging count larger than one batch has to cross the flush boundary the push driver
    /// moved: the pull loop flushed inside its per-tagging loop and this one flushes after
    /// the framer returns, so an off-by-a-batch here would be silent.
    #[test]
    fn a_file_larger_than_one_batch_stores_every_tagging() {
        let db = mem_db();
        let cards: Vec<String> = (0..BATCH * 2 + 17).map(|i| format!("oid-{i}")).collect();
        let card_refs: Vec<&str> = cards.iter().map(String::as_str).collect();
        let one = line("a1", "ramp", &[], &card_refs);
        let stats = push_all(&db, &gz_bytes(&[one.as_str()]), 4096).unwrap();

        assert_eq!(stats.taggings, cards.len() as u64);
        assert_eq!(stats.closure_rows, cards.len() as u64);
        assert_eq!(closure_rows(&db).len(), cards.len());
    }

    /// **Taggings are committed while the stream is still arriving, not all at the end.**
    ///
    /// That is what gives the connection back between batches — the discipline this ingest
    /// is built around, because holding the shared write mutex for a whole ingest is what
    /// turns a reader's edit into a frozen button. It is invisible to a row count: an ingest
    /// that buffered all 475 163 taggings and wrote them in `finish` stores exactly the same
    /// rows. So the assertion is on **when** progress fires, and it is counted inside the
    /// push loop rather than over the whole run.
    ///
    /// Plain bytes rather than gzipped, deliberately: `flate2` holds a tail back until
    /// `try_finish`, so a small compressed fixture delivers everything to `finish` and this
    /// would pass without proving anything.
    #[test]
    fn taggings_are_committed_while_the_stream_is_still_arriving() {
        let db = mem_db();
        let cards: Vec<String> = (0..BATCH + 5).map(|i| format!("oid-{i}")).collect();
        let card_refs: Vec<&str> = cards.iter().map(String::as_str).collect();
        let lines = [
            line("a1", "ramp", &[], &card_refs),
            line("a2", "removal", &[], &card_refs),
        ];
        let bytes = lines.join("\n").into_bytes();

        let mut during_push: Vec<u64> = Vec::new();
        let mut after: Vec<u64> = Vec::new();
        let mut sink = StreamTags::begin(&crate::tags::oracle::ORACLE, &db).unwrap();
        for c in bytes.chunks(4096) {
            sink.push(c, &mut |n| during_push.push(n)).unwrap();
        }
        let stats = sink
            .finish(&FileStamp::default(), 1_800_000_000, &mut |n| after.push(n))
            .unwrap();

        assert!(
            !during_push.is_empty(),
            "a batch must be committed before the stream ends; got {during_push:?}"
        );
        assert!(
            during_push.iter().all(|n| *n >= BATCH as u64),
            "each report is the running tagging count: {during_push:?}"
        );
        assert!(!after.is_empty(), "the swap reports too");
        let all: Vec<u64> = during_push.iter().chain(after.iter()).copied().collect();
        assert!(
            all.windows(2).all(|w| w[1] >= w[0]),
            "the running count must never go backwards: {all:?}"
        );
        assert_eq!(stats.taggings, 2 * cards.len() as u64);
    }

    /// The most transactions [`crate::db::lock_background`] lets a bounded ask wait behind with
    /// two ingests running: the one holding the connection when the ask arrives, and the other
    /// ingest's, already parked in `lock()` before the ask registered.
    const MOST_BATCHES_BEHIND: usize = 2;

    /// **Two ingests at once must not starve a user write**, which is the case the per-batch
    /// release alone could not answer (issue #551). One ingest lets go between batches and a
    /// polling writer eventually lands in the gap; two ingests hand the connection straight to
    /// each other, because whichever is not writing is already parked in `lock()` when the
    /// other lets go, so a `try_lock` poll never finds it free. The launch runs three of them
    /// together — both tag files and the combos — so this is the shape the app is actually in
    /// for the first minute after a weekly refresh comes due.
    ///
    /// A file-backed database for `oracle::tests::a_writer_gets_the_connection_between_batches`'
    /// reason, and the writer only counts an ask that **began while both ingests were
    /// running**: an ask made after one of them finished is the single-ingest case, which
    /// already worked.
    ///
    /// # It counts transactions, not milliseconds
    ///
    /// "About a batch, not an ingest" is a statement about **how many batches** an ask waits
    /// behind, and that is what is asserted: a `commit_hook` counts every transaction the
    /// connection commits, and each ask records how many landed between it beginning and it
    /// being answered. [`crate::db::lock_background`] makes the answer at most
    /// [`MOST_BATCHES_BEHIND`] by construction — the batch in hand when the ask arrives, and
    /// the other ingest's, already parked in `lock()` before the ask registered; after those
    /// both loops stand aside. How long each of those takes is a fact about the machine, and it
    /// is not bounded at all: a swap rebuilds every index over the fixture in one transaction.
    ///
    /// **It was a wall-clock bound until 2026-09-30**, `worst < WRITE_LOCK_WAIT / 2`, and that
    /// was wrong in both directions. On a loaded `windows-latest` runner it failed a PR that
    /// touched no Rust (run 36704904751, attempt 1): one ask waited 4.72 s, with 39 asks over a
    /// 7.17 s overlap and none refused, and the re-run passed. And on Linux it passed *with the
    /// fix removed*, because a debug build parses slowly enough to leave gaps a poll lands in.
    /// Measured on Linux (debug), 2026-09-30:
    ///
    /// | tree | worst ask, transactions behind | worst wall wait |
    /// | --- | --- | --- |
    /// | as shipped, 3 runs | 2 | 181 ms |
    /// | as shipped, 12 spinning threads on 4 cores, 10 runs, ~830 asks | 2 | ≥ 540 ms |
    /// | every loop here on `lock_blocking`, 3 runs | 37–52 | 242–363 ms |
    /// | only `flush_closure` on `lock_blocking`, 3 runs | 29–53 | — |
    /// | only `write_taggings` on `lock_blocking`, 6 runs | 3–5 | — |
    ///
    /// So under load the wall wait swelled while the count did not move, and every reverted
    /// tree fails the count where the old bound passed it. **The taggings row is the one that
    /// still depends on the machine**: that loop parses between batches with no lock held, so
    /// how far a regression in it gets is the parse-to-commit ratio again. Its lowest run
    /// reached 3, which a bound of 3 would have passed, and that is why the bound has no slack
    /// above what the rule allows. The closure loop writes from memory and parses nothing
    /// between batches, so two of them saturate the connection on any machine. The tag and
    /// edge loops are the same shape but barely run here — the fixture's tags have no parents
    /// and fit one batch. `db::tests::a_bounded_asker_gets_its_turn_between_two_batch_loops`
    /// takes the parse out entirely and remains the test of the discipline itself.
    ///
    /// **No refusal is asserted either**, for the same reason: an ask told busy behind two slow
    /// transactions is a slow machine, and one told busy because the loops ignored it has
    /// dozens behind it and fails the count. Each ask is still made with
    /// [`crate::db::WRITE_LOCK_WAIT`], the production call, and a refusal is marked in the
    /// failure's table.
    #[test]
    fn a_bounded_writer_gets_its_turn_while_two_ingests_run_at_once() {
        use crate::platform::clock::Tick;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::time::Duration;

        let dir = crate::scratch::path("tags-two-ingests-at-once");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Mutex::new(crate::db::open_write(&dir).unwrap());
        crate::schema::build_pair(&db.lock().unwrap());

        // Many lines of a hundred taggings each, so each ingest runs dozens of batches of
        // taggings and as many again of closure rows — the real files' shape (~50 taggings a
        // line in the oracle file), rather than one line the framer folds into one batch.
        let fixture = |ds: &Dataset| {
            let lines: Vec<String> = (0..1000)
                .map(|t| {
                    let taggings = (0..100)
                        .map(|s| format!(r#"{{"{}":"s-{t}-{s}"}}"#, ds.subject_column))
                        .collect::<Vec<_>>()
                        .join(",");
                    format!(
                        r#"{{"object":"tag","id":"t{t}","slug":"tag-{t}","parent_ids":[],"taggings":[{taggings}]}}"#
                    )
                })
                .collect();
            let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
            gz_fixture(&refs)
        };
        let oracle = fixture(&crate::tags::oracle::ORACLE);
        let art = fixture(&crate::tags::art::ART);

        // Every transaction the connection commits, whoever took the lock for it and however.
        // Counted by SQLite rather than by the ingest's own progress callback, so a loop that
        // reports nothing — or one written tomorrow — is still counted.
        let commits = std::sync::Arc::new(AtomicUsize::new(0));
        {
            let commits = commits.clone();
            crate::db::lock_blocking(&db)
                .commit_hook(Some(move || {
                    commits.fetch_add(1, Ordering::SeqCst);
                    false
                }))
                .unwrap();
        }

        struct Ask {
            waited: Duration,
            got: bool,
            /// Transactions the ingests committed between the ask beginning and it being
            /// answered — the batches it waited behind.
            behind: usize,
        }
        let running = AtomicUsize::new(2);
        let started = [AtomicBool::new(false), AtomicBool::new(false)];
        let mut asks: Vec<Ask> = Vec::new();
        let mut overlap = Duration::ZERO;
        std::thread::scope(|scope| {
            let jobs = [
                (&crate::tags::oracle::ORACLE, &oracle, &started[0]),
                (&crate::tags::art::ART, &art, &started[1]),
            ];
            for (ds, path, started) in jobs {
                let (db, running) = (&db, &running);
                scope.spawn(move || {
                    let result = ingest_gz(
                        ds,
                        db,
                        path,
                        &FileStamp::default(),
                        1_800_000_000,
                        &mut |_| started.store(true, Ordering::SeqCst),
                    );
                    // Before the unwrap: a failed ingest must still release the writer's loop.
                    running.fetch_sub(1, Ordering::SeqCst);
                    result.unwrap();
                });
            }
            // Both have committed a batch, so both are demonstrably mid-run.
            while !started.iter().all(|s| s.load(Ordering::SeqCst)) {
                if running.load(Ordering::SeqCst) < 2 {
                    return;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            let overlap_began = Tick::now();
            while running.load(Ordering::SeqCst) == 2 {
                let before = commits.load(Ordering::SeqCst);
                let asked = Tick::now();
                let guard = crate::db::lock_for(&db, crate::db::WRITE_LOCK_WAIT);
                let waited = asked.elapsed();
                // Read with the guard still held, so nothing can commit between the answer and
                // the count.
                let behind = commits.load(Ordering::SeqCst) - before;
                let got = guard.is_some();
                drop(guard);
                asks.push(Ask {
                    waited,
                    got,
                    behind,
                });
                std::thread::sleep(Duration::from_millis(20));
            }
            overlap = overlap_began.elapsed();
        });

        let table = asks
            .iter()
            .map(|a| {
                format!(
                    "{:?}/{}{}",
                    a.waited,
                    a.behind,
                    if a.got { "" } else { " BUSY" }
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        assert!(
            asks.len() >= 3,
            "the two ingests overlapped for only {overlap:?} ({} asks) — too short to prove \
             anything; make the fixture larger",
            asks.len()
        );
        let most = asks.iter().map(|a| a.behind).max().unwrap_or_default();
        assert!(
            most <= MOST_BATCHES_BEHIND,
            "an ask waited behind {most} ingest transactions while two ingests ran; \
             the priority rule allows {MOST_BATCHES_BEHIND}. Every ask as wait/transactions \
             behind ({overlap:?} overlap): {table}"
        );
    }

    // ---- a finish that takes turns ------------------------------------------------------

    /// A file whose finish runs every loop more than once: `tags` tags under one root, each
    /// tagging one subject of its own — so two batches of tags, two of edges and three of
    /// closure rows at `tags = BATCH + 100`.
    fn wide_file(ds: &Dataset, tags: usize, prefix: &str) -> Vec<String> {
        (0..tags)
            .map(|t| {
                let parents = if t == 0 { "" } else { r#""t0""# };
                format!(
                    r#"{{"object":"tag","id":"t{t}","slug":"{prefix}-{t}","parent_ids":[{parents}],"taggings":[{{"{}":"s-{t}","weight":"median"}}]}}"#,
                    ds.subject_column
                )
            })
            .collect()
    }

    /// Every transaction `db` commits from here on, counted by SQLite itself.
    fn count_commits(db: &Mutex<Connection>) -> std::sync::Arc<std::sync::atomic::AtomicUsize> {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let commits = std::sync::Arc::new(AtomicUsize::new(0));
        let counted = commits.clone();
        crate::db::lock_blocking(db)
            .commit_hook(Some(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                false
            }))
            .unwrap();
        commits
    }

    /// **The file-backed ingest commits exactly what it did before its finish learned to take
    /// turns** — the same batches, so the same number of transactions, counted by SQLite's
    /// commit hook rather than by anything the ingest says about itself.
    ///
    /// Both figures were read off the code as it stood before the finish was restated
    /// (2026-10-04, the same test over `HEAD`'s file) and are pinned as numbers on purpose.
    /// For the oracle file: one taggings batch (the whole small file arrives in `finish`,
    /// where `flate2` lets go of it), two of tags, two of edges, three of closure rows and
    /// the swap — nine — and the four `CREATE`s that make the staging tables, each its own
    /// transaction. The art file's lines are longer by its subject key, so the decoder hands
    /// some over before `finish` and its taggings are two batches: fourteen.
    #[test]
    fn the_file_driver_commits_exactly_the_batches_it_always_did() {
        use std::sync::atomic::Ordering;
        for (ds, native_commits) in [
            (&crate::tags::oracle::ORACLE, 13),
            (&crate::tags::art::ART, 14),
        ] {
            let db = mem_db();
            let lines = wide_file(ds, BATCH + 100, "tag");
            let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
            let path = gz_fixture(&refs);
            let commits = count_commits(&db);
            let stats = ingest_gz(
                ds,
                &db,
                &path,
                &FileStamp::default(),
                1_800_000_000,
                &mut |_| {},
            )
            .unwrap();
            assert_eq!(stats.tags as usize, BATCH + 100);
            assert_eq!(stats.closure_rows as usize, 2 * (BATCH + 100) - 1);
            assert_eq!(
                commits.load(Ordering::SeqCst),
                native_commits,
                "{}: the file-backed ingest's transactions",
                ds.bulk_name
            );
        }
    }

    /// Everything a taxonomy stores but its watermark, as text: tags, edges, taggings and
    /// the closure with its weight where the dataset carries one — each in key order.
    fn everything(ds: &Dataset, db: &Mutex<Connection>) -> Vec<String> {
        let conn = crate::db::lock_blocking(db);
        let subject = ds.subject_column;
        let weight = if ds.carries_weight { "weight" } else { "''" };
        let mut out = Vec::new();
        for sql in [
            format!(
                "SELECT slug || '|' || id || '|' || label || '|' || slug_norm
                   FROM {} ORDER BY slug",
                ds.tags_table
            ),
            format!(
                "SELECT child_slug || '>' || parent_slug FROM {} ORDER BY 1",
                ds.parents_table
            ),
            format!(
                "SELECT {subject} || '|' || slug || '|' || coalesce(weight, '-')
                   FROM {} ORDER BY {subject}, slug",
                ds.taggings_table
            ),
            format!(
                "SELECT {subject} || '|' || slug || '|' || {weight}
                   FROM {} ORDER BY {subject}, slug",
                ds.closure_table
            ),
        ] {
            let mut stmt = conn.prepare(&sql).unwrap();
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            out.push(format!("-- {} rows", rows.len()));
            out.extend(rows);
        }
        out
    }

    /// **A page writes the closure a desktop writes.** The two hosts write it differently —
    /// a page in key order and larger batches ([`ClosurePlan`]) — and what is in the table
    /// afterwards must not differ by a row or by a weight, for either taxonomy.
    ///
    /// The file is made to be hard on that: subjects first met in descending order, so key
    /// order and file order are opposites; a hierarchy three deep with a tag under two
    /// parents; taggings whose weights disagree along one lineage, so the fold decides; and
    /// **two tags that share a slug** with different weights on one subject — the insert is
    /// `OR IGNORE`, so which of the pair is written first is which weight is stored.
    #[test]
    fn a_page_writes_the_closure_a_desktop_writes() {
        for ds in [&crate::tags::oracle::ORACLE, &crate::tags::art::ART] {
            let subject = ds.subject_column;
            let tagging = |s: usize, weight: &str| {
                format!(r#"{{"{subject}":"s-{s:05}","weight":"{weight}"}}"#)
            };
            let tag = |id: &str, slug: &str, parents: &[&str], taggings: Vec<String>| {
                let parents = parents
                    .iter()
                    .map(|p| format!("\"{p}\""))
                    .collect::<Vec<_>>()
                    .join(",");
                format!(
                    r#"{{"object":"tag","id":"{id}","slug":"{slug}","parent_ids":[{parents}],"taggings":[{}]}}"#,
                    taggings.join(",")
                )
            };
            // Four closure rows a subject, so past two of a page's batches — met last-first.
            let subjects = CLOSURE_BATCH_WITHOUT_FILES / 2 + 50;
            let lines = [
                tag("r", "animal", &[], vec![]),
                tag("d", "dog", &["r"], vec![tagging(7, "weak")]),
                tag("p", "pet", &[], vec![]),
                // Under two parents, on every subject, last subject first.
                tag(
                    "h",
                    "hound",
                    &["d", "p"],
                    (0..subjects).rev().map(|s| tagging(s, "strong")).collect(),
                ),
                // The same slug again under another id, tagging a subject `dog` already tags.
                tag("d2", "dog", &[], vec![tagging(7, "very_strong")]),
                tag(
                    "z",
                    "aardvark",
                    &["r"],
                    vec![tagging(3, "median"), tagging(9, "weak")],
                ),
            ];
            let bytes = lines.join("\n").into_bytes();
            let ingest = |db: &Mutex<Connection>| {
                let mut sink = StreamTags::begin(ds, db).unwrap();
                for chunk in bytes.chunks(64 * 1024) {
                    sink.push(chunk, &mut |_| {}).unwrap();
                }
                sink.finish(&FileStamp::default(), 1_800_000_000, &mut |_| {})
                    .unwrap()
            };

            let desktop = mem_db();
            let on_a_desktop = ingest(&desktop);
            let page = mem_db();
            let on_a_page = {
                let _page = crate::platform::host::emulate_page();
                assert!(ClosurePlan::of_this_host().in_key_order);
                ingest(&page)
            };
            assert!(!ClosurePlan::of_this_host().in_key_order);

            assert_eq!(on_a_page, on_a_desktop, "{}: the counts", ds.bulk_name);
            assert!(
                on_a_page.closure_rows as usize > 2 * CLOSURE_BATCH_WITHOUT_FILES,
                "more than two of a page's batches: {on_a_page:?}"
            );
            let (page, desktop) = (everything(ds, &page), everything(ds, &desktop));
            assert_eq!(page.len(), desktop.len(), "{}", ds.bulk_name);
            for (n, (a, b)) in page.iter().zip(&desktop).enumerate() {
                assert_eq!(a, b, "{}: row {n}", ds.bulk_name);
            }
            // And the fold is what it should be, on both: `s-00007` is a strong `hound`, so
            // it is a strong `dog` and a strong `animal`, whatever its own `dog` taggings say.
            if ds.carries_weight {
                for slug in ["animal", "dog", "hound", "pet"] {
                    let row = format!("s-00007|{slug}|strong");
                    assert!(page.contains(&row), "{row}");
                }
            }
        }
    }

    /// A turn that is a page asking: in every gap it sends the engine a command through the
    /// table and reads the live closure, and keeps what it was told.
    ///
    /// On an emulated page a connection asked for while it is held is a panic that names the
    /// line (`platform::alone`), so every answer here is also proof that the finish held
    /// nothing in that gap.
    struct Asking<'a> {
        ds: &'a Dataset,
        state: &'a Arc<State>,
        status: &'static str,
        /// Per gap: the status command's answer, and how many rows the live closure held.
        told: Vec<(serde_json::Value, i64)>,
    }

    impl crate::platform::timer::Turn for Asking<'_> {
        async fn take(&mut self) {
            let status =
                crate::commands::dispatch(self.state, self.status, serde_json::Value::Null, None)
                    .await
                    .expect("a status asked in a gap is answered");
            let rows = self
                .state
                .lock_db_read()
                .query_row(
                    &format!("SELECT count(*) FROM {}", self.ds.closure_table),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            self.told.push((status, rows));
        }
    }

    /// **A command in a gap of the finish is answered, and sees the previous tags** — for
    /// both taxonomies, on a host with one thread and one connection. Every loop of the
    /// finish runs more than once over this file, so there is a gap after the last taggings,
    /// after each batch of tags, of edges and of closure rows; in each the page is told the
    /// previous file's counts and reads the previous closure, whole. After the finish it is
    /// told the new ones.
    ///
    /// The engine's half of it. `tags::oracle`'s
    /// `a_command_sent_during_a_streamed_finish_is_answered_from_the_previous_tags` is the
    /// whole refresh, with the turns taken by the breather a streamed download keeps.
    #[tokio::test]
    async fn a_command_in_a_gap_of_the_finish_is_answered_and_sees_the_previous_tags() {
        use serde_json::json;
        /// Tags in the new file: its closure is two rows a tag, so this is past one of a
        /// page's closure batches and the loop has a gap inside it.
        const WIDE: usize = CLOSURE_BATCH_WITHOUT_FILES / 2 + 100;
        for (ds, status, name) in [
            (
                &crate::tags::oracle::ORACLE,
                "oracle_tags_status",
                "tags-gaps-oracle",
            ),
            (&crate::tags::art::ART, "art_tags_status", "tags-gaps-art"),
        ] {
            let _page = crate::platform::host::emulate_page();
            let (state, _heard, dir) = crate::state::fixtures::single(name, "http://127.0.0.1:1");

            // The previous taxonomy: three tags, five closure rows.
            let old = wide_file(ds, 3, "old").join("\n").into_bytes();
            let mut sink = StreamTags::begin(ds, &state.db).unwrap();
            sink.push(&old, &mut |_| {}).unwrap();
            sink.finish(&FileStamp::default(), 1_700_000_000, &mut |_| {})
                .unwrap();

            let new = wide_file(ds, WIDE, "new").join("\n").into_bytes();
            let mut sink = StreamTags::begin(ds, &state.db).unwrap();
            for chunk in new.chunks(64 * 1024) {
                sink.push(chunk, &mut |_| {}).unwrap();
            }
            let mut page = Asking {
                ds,
                state: &state,
                status,
                told: Vec::new(),
            };
            let stats = sink
                .finish_in_turns(&FileStamp::default(), 1_800_000_000, &mut |_| {}, &mut page)
                .await
                .unwrap();
            assert_eq!(stats.tags as usize, WIDE);

            // The last taggings, three batches of tags, three of edges, and two of closure
            // rows — a page's are `CLOSURE_BATCH_WITHOUT_FILES` each.
            assert!(
                page.told.len() >= 9,
                "{}: a gap after every batch, and {} were taken",
                ds.bulk_name,
                page.told.len()
            );
            for (n, (status, rows)) in page.told.iter().enumerate() {
                assert_eq!(status["tagCount"], json!(3), "{} gap {n}", ds.bulk_name);
                assert_eq!(
                    status["ingestedAt"],
                    json!(1_700_000_000),
                    "{} gap {n}",
                    ds.bulk_name
                );
                assert_eq!(*rows, 5, "{} gap {n}: the previous closure", ds.bulk_name);
            }

            let after = crate::commands::dispatch(&state, status, serde_json::Value::Null, None)
                .await
                .unwrap();
            assert_eq!(after["tagCount"], json!(WIDE));
            assert_eq!(after["ingestedAt"], json!(1_800_000_000));
            let rows: i64 = state
                .lock_db_read()
                .query_row(
                    &format!("SELECT count(*) FROM {}", ds.closure_table),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(rows as usize, 2 * WIDE - 1);

            drop(state);
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// **What the page hears**: the event's name, and the keys it reads — camelCase, nothing
    /// more. The payload leaves through the host's sink, which is what took a window's place.
    #[test]
    fn a_step_of_a_refresh_reaches_the_sink_as_the_event_the_page_listens_for() {
        let (state, heard, dir) = crate::state::fixtures::listening("tags-heard");

        emit(&oracle::ORACLE, &state, "downloading", 5, 9);
        emit(&art::ART, &state, "ingesting", 0, 0);

        assert_eq!(
            heard.taken(),
            vec![
                (
                    "oracle-tags:progress".to_owned(),
                    serde_json::json!({"phase": "downloading", "done": 5, "total": 9})
                ),
                (
                    "art-tags:progress".to_owned(),
                    serde_json::json!({"phase": "ingesting", "done": 0, "total": 0})
                ),
            ]
        );
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
}
