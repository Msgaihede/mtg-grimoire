//! Scryfall's **Oracle Tags**: fetch the bulk file, flatten its hierarchy, and store what a
//! card *does* rather than what it is.
//!
//! `cards.type_line` says a card is an Instant. It does not say the card is a tutor, a board
//! wipe, a ramp piece or a counterspell — and those are the words a deck is actually built
//! in. Scryfall's community-curated tag taxonomy does, and publishes it as a bulk dataset
//! keyed on `oracle_id`, which is the column this database already carries on every printing.
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
//! Five rules shape this module:
//!
//! * **Rust supplies facts; TypeScript draws conclusions.** Nothing here names a category,
//!   ranks one tag above another, or filters the taxonomy down to the useful part of it.
//!   [`oracle_tags_for_cards`] answers raw slugs in one round trip and the frontend decides
//!   what they mean — which is what lets the naming change without a migration.
//! * **The hierarchy is flattened once, at ingest, into `oracle_tag_cards`.** A card tagged
//!   `tutor-battle` is *also* a `tutor`, and asking that question per lookup would mean a
//!   recursive walk per card. It is walked once here and stored as a closure instead, so the
//!   read is a prefix scan over a `WITHOUT ROWID` primary key.
//! * **Every parent is followed, not the first one.** See [`ancestor_closures`], which is the
//!   only place that decision is expressed.
//! * **This is Scryfall**, so it goes through [`crate::scryfall::Client`] and shares its
//!   pacing gate and its 429 lockout. A second client would be a second application as far as
//!   the rate limiter is concerned. (The price feeds in [`crate::marketplace_feed`] have their
//!   own client for exactly the opposite reason: they are *not* Scryfall.)
//! * **Nothing here may break a launch or a card sync.** The refresh is spawned, best-effort
//!   and silent; a failure leaves the previous tags in place and writes the reason to
//!   `error_log`. Categorising by card type is the honest fallback, and it is what the app
//!   did before this file existed.
//!
//! # Bad input is never fatal
//!
//! [`crate::ingest`]'s rule, for its reason: an unparseable line is counted and stepped over.
//! The one exception is a file that yields *no* tags — a gzipped error page, the wrong
//! dataset, a truncated download — which is refused outright and swaps nothing.

use crate::sync::AppState;
use flate2::read::GzDecoder;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

/// The event a refresh reports itself through.
///
/// **Its own event rather than a ninth `sync::PHASES` value**, for
/// [`crate::marketplace_feed::PROGRESS_EVENT`]'s reason: that list is a closed union on the
/// TypeScript side and a phase it does not know renders as `undefined`. This is also not a
/// sync — it can run while one is in flight, and the two would otherwise fight over one line.
pub const PROGRESS_EVENT: &str = "oracle-tags:progress";

/// Every value [`OracleTagProgress::phase`] takes, in the order one refresh produces them.
/// Mirrored by hand on the other side of the IPC boundary.
pub const PHASES: [&str; 5] = ["checking", "downloading", "ingesting", "done", "error"];

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

/// Rows per staging transaction, and so also rows between progress callbacks —
/// [`crate::ingest`]'s number, for its reason: it is how long another writer can be made to
/// wait for the write connection.
const BATCH: usize = 2_000;

/// Bytes of download between progress events. 5.85 MB against reqwest's chunk callback,
/// which fires far more often than a progress bar can use.
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
/// within a handful of polls, and costs a full refresh (~470 batches over the live file)
/// roughly 2.4 s — which is a weekly background task's to spend.
const YIELD_BETWEEN_BATCHES: std::time::Duration = std::time::Duration::from_millis(5);

/// Let go of the connection long enough for a waiting writer to see that it is free.
/// **Call it with no guard in scope** — see [`YIELD_BETWEEN_BATCHES`].
fn stand_aside() {
    std::thread::sleep(YIELD_BETWEEN_BATCHES);
}

/// Oracle ids per `IN (…)` in the read path.
///
/// A chunk rather than one statement for the whole list: SQLite's bound-parameter ceiling is
/// a compile-time option of whatever build is linked, and a decklist import is allowed to ask
/// about every line at once. 500 is far under every ceiling SQLite has shipped and still one
/// statement for any list a person types by hand.
const LOOKUP_CHUNK: usize = 500;

// ---------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------

/// One `tag` object from the bulk file, narrowed to what this app stores.
///
/// `child_ids` is deliberately absent: it is the same edges as `parent_ids` read the other
/// way round, and storing both would be two sources of truth for one graph.
#[derive(Debug, Clone, PartialEq)]
struct TagLine {
    /// Scryfall's uuid. The join key **inside the file** — `parent_ids` are these — and
    /// nothing else: it is resolved to slugs during the ingest and never stored.
    id: String,
    slug: String,
    label: String,
    description: Option<String>,
    /// Every parent, in file order. 684 of 4 521 tags carry more than one.
    parent_ids: Vec<String>,
    taggings: Vec<TaggingLine>,
}

/// One entry of a tag's `taggings` array.
#[derive(Debug, Clone, PartialEq)]
struct TaggingLine {
    oracle_id: String,
    /// `median` on 99.74 % of them. Stored because it is data we were handed; **nothing
    /// anywhere may branch on it**, and the moment something wants to, that is a decision to
    /// make in TypeScript against a fact this column already carries.
    weight: Option<String>,
    annotation: Option<String>,
}

/// Read one line of the bulk file.
///
/// `None` for anything this app cannot act on, which the caller counts and steps over:
///
/// * not a `tag` object — the dataset holds nothing else today, and a future sibling object
///   must not be filed as a tag with an empty slug,
/// * no `id` — the uuid every `parent_ids` entry is matched against, so a blank one would
///   silently collect every parentless reference,
/// * no `slug` — the primary key of every table here.
///
/// Everything else is optional and defaulted rather than refused: `label` falls back to the
/// slug (so a reader is always shown *something*), and a missing `parent_ids`/`taggings` is
/// an empty list, which is what a root tag and an unused tag genuinely are.
fn parse_tag_line(v: &serde_json::Value) -> Option<TagLine> {
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
                // A tagging with no oracle id joins to nothing. Dropped here rather than
                // stored as a row no card can ever match.
                oracle_id: non_empty(t["oracle_id"].as_str())?,
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
    slug: String,
    label: String,
    description: Option<String>,
    /// Resolved indices into the tag list. Filled once the whole file has been read, because
    /// a parent may appear on any later line — and a parent id the file never defines is
    /// dropped here rather than carried as an edge to nothing.
    parents: Vec<u32>,
}

/// For every tag, the tags a card inherits by holding it: **the tag itself, plus every
/// ancestor above it**, as indices into `tags`.
///
/// This is the whole of the hierarchy's effect on the app, and it is deliberately one
/// function so that the decision inside it has exactly one place to be changed.
///
/// # The one knob: every parent, or only the first
///
/// **Every entry of `parent_ids` is followed.** 684 of the 4 521 tags in the 2026-08-14 file
/// have more than one parent, and their ancestries genuinely differ: `tutor-battle` sits
/// under both `tutor` and `battle-matters`, and a card holding it belongs in either list. The
/// alternative — take `parent_ids[0]` and ignore the rest — would give every tag a single
/// lineage, which is smaller and simpler and wrong for those 684. Flipping this is one line:
/// iterate `parents.first()` instead of `parents`. Nothing else in the crate encodes the
/// choice, and no caller can tell which was made except by the rows it produces.
///
/// # What it does not assume
///
/// * **Cycles.** Today's file has none; nothing promises tomorrow's will not. Each walk
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

#[derive(Debug, thiserror::Error)]
pub enum TagError {
    #[error("failed to read the oracle tag file: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error while storing oracle tags: {0}")]
    Db(#[from] rusqlite::Error),
    /// The file decoded and not one line was a tag. A gzipped error page, the wrong dataset,
    /// a truncated download — none of which may replace a working taxonomy with an empty one.
    /// [`crate::ingest::IngestError::Empty`] refuses a bulk card file for the same reason.
    #[error(
        "no tags found in the oracle tag file ({skipped} lines skipped); keeping the previous ones"
    )]
    Empty { skipped: u64 },
}

impl TagError {
    /// How the error log should classify this.
    pub fn kind(&self) -> crate::errors::Kind {
        use crate::errors::Kind;
        match self {
            TagError::Io(_) | TagError::Db(_) => Kind::Io,
            TagError::Empty { .. } => Kind::Parse,
        }
    }
}

/// What one ingest did. Every count is a fact about the file, and the three "skipped" ones
/// are counted rather than fatal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TagStats {
    pub tags: u64,
    /// Taggings **read from the file**. The insert is `OR IGNORE`, so a card listed twice
    /// under one tag is one stored row and this figure can exceed the table's count by
    /// however many times that happened — which is the honest reading of "what the file
    /// said", and the one worth keeping when the two disagree.
    pub taggings: u64,
    /// Rows in the closure: one per (card, tag) *including* inherited tags, so this is
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

/// Stream a gzipped Oracle Tags file into the staging tables, flatten the hierarchy, and
/// swap the result into place.
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
/// Everything is written to `oracle_tag_*_staging`, which no reader can see, and promoted by
/// one rename transaction at the end. So a failure partway — an I/O error mid-stream, a
/// process that dies — leaves the previous taxonomy exactly where it was and a committed
/// staging table that the next run's [`crate::schema::create_oracle_tag_staging`] drops before
/// it writes a row. **A half-populated closure is the one state that must never be visible**,
/// because a card whose ancestors landed and whose siblings did not reads as a card that is
/// simply not in that category.
///
/// `progress` is called with the running row count every [`BATCH`] rows, and once more when
/// the swap is done.
pub fn ingest_gz(
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
        crate::schema::create_oracle_tag_staging(&conn)?;
    }

    let mut stats = TagStats::default();
    let mut written = 0u64;

    // The tag list, and the uuid → index map that resolves `parent_ids` once the file has
    // been read to the end. 4 521 entries: this is the only thing held whole.
    let mut tags: Vec<Tag> = Vec::new();
    let mut parent_ids: Vec<Vec<String>> = Vec::new();
    let mut by_id: HashMap<String, u32> = HashMap::new();

    // The taggings, interned. 229 633 of them over 35 969 oracle ids, so the ids are held
    // once each and referred to by index — 8 bytes per tagging instead of a string apiece.
    // `weight` and `annotation` are never held at all: they go straight to staging with the
    // row that carries them.
    let mut oracle_ids: Vec<String> = Vec::new();
    let mut card_of: HashMap<String, u32> = HashMap::new();
    let mut card_tags: Vec<Vec<u32>> = Vec::new();

    let mut batch: Vec<(u32, u32, Option<String>, Option<String>)> = Vec::with_capacity(BATCH);

    let reader = BufReader::new(GzDecoder::new(file));
    for line in reader.lines() {
        let line = line?;
        // Parsed with the lock *not* held: it is the expensive half of the loop, and the
        // whole point of batching is that the connection is free during it.
        let parsed = serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .as_ref()
            .and_then(parse_tag_line);
        let Some(tag) = parsed else {
            stats.skipped_lines += 1;
            continue;
        };

        let index = tags.len() as u32;
        // An **id** the file repeats is one tag, not two: the first line wins and the
        // second's taggings are folded onto it, exactly as the `INSERT OR IGNORE`s below
        // would have them. (Two *different* ids sharing a slug fold the same way, one table
        // down: the slug is the key everything here is stored under.)
        let index = *by_id.entry(tag.id.clone()).or_insert(index);
        if index == tags.len() as u32 {
            tags.push(Tag {
                slug: tag.slug,
                label: tag.label,
                description: tag.description,
                parents: Vec::new(),
            });
            parent_ids.push(tag.parent_ids);
        }

        for tagging in tag.taggings {
            let card = match card_of.get(&tagging.oracle_id) {
                Some(&c) => c,
                None => {
                    let c = oracle_ids.len() as u32;
                    card_of.insert(tagging.oracle_id.clone(), c);
                    oracle_ids.push(tagging.oracle_id);
                    card_tags.push(Vec::new());
                    c
                }
            };
            card_tags[card as usize].push(index);
            batch.push((card, index, tagging.weight, tagging.annotation));
            if batch.len() >= BATCH {
                stats.taggings += batch.len() as u64;
                write_taggings(db, &oracle_ids, &tags, &mut batch)?;
                written = stats.taggings;
                progress(written);
            }
        }
    }
    if !batch.is_empty() {
        stats.taggings += batch.len() as u64;
        write_taggings(db, &oracle_ids, &tags, &mut batch)?;
        written = stats.taggings;
    }

    // Not one line was a tag: the download is bad, not the taxonomy. Swapping here would
    // trade a working set of categories for none, so refuse — and drop the staging tables
    // rather than leave them lying around.
    if tags.is_empty() {
        let conn = crate::db::lock_blocking(db);
        crate::schema::drop_oracle_tag_staging(&conn)?;
        return Err(TagError::Empty {
            skipped: stats.skipped_lines,
        });
    }
    stats.tags = tags.len() as u64;

    // The tags themselves.
    for chunk in tags.chunks(BATCH) {
        let mut conn = crate::db::lock_blocking(db);
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT OR IGNORE INTO oracle_tags_staging (slug, label, description)
                 VALUES (?1, ?2, ?3)",
            )?;
            for tag in chunk {
                stmt.execute(params![tag.slug, tag.label, tag.description])?;
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
                Some(&parent) if parent as usize != child => tags[child].parents.push(parent),
                Some(_) => {}
                None => stats.dangling_parents += 1,
            }
        }
    }
    write_edges(db, &tags, &mut written, progress)?;

    // The closure. Computed with no lock held — this is pure CPU over 4 521 tags — and then
    // unioned per card: a card holding two tags that share an ancestor gets that ancestor
    // once, which is what the `(oracle_id, slug)` primary key would insist on anyway.
    let closures = ancestor_closures(&tags);
    stats.closure_rows = write_closure(
        db,
        &tags,
        &oracle_ids,
        &card_tags,
        &closures,
        &mut written,
        progress,
    )?;

    {
        let mut conn = crate::db::lock_blocking(db);
        let tx = conn.transaction()?;
        crate::schema::swap_oracle_tag_staging(&tx)?;
        // In the same transaction as the swap, and that is the contract: a watermark without
        // its rows would 304 past an empty taxonomy forever, and rows without their watermark
        // would re-download a file the database already holds.
        tx.execute(
            "INSERT INTO oracle_tag_meta
                (id, etag, updated_at, ingested_at, checked_at, tag_count, tagging_count)
             VALUES (1, ?1, ?2, ?3, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                etag = excluded.etag,
                updated_at = excluded.updated_at,
                ingested_at = excluded.ingested_at,
                checked_at = excluded.checked_at,
                tag_count = excluded.tag_count,
                tagging_count = excluded.tagging_count",
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
    db: &Mutex<Connection>,
    oracle_ids: &[String],
    tags: &[Tag],
    batch: &mut Vec<(u32, u32, Option<String>, Option<String>)>,
) -> Result<(), TagError> {
    let mut conn = crate::db::lock_blocking(db);
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT OR IGNORE INTO oracle_taggings_staging (oracle_id, slug, weight, annotation)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        // `OR IGNORE` rather than a plain insert: the same card listed twice under one tag is
        // one fact, and a duplicate must cost the batch it is in nothing.
        for (card, tag, weight, annotation) in batch.iter() {
            stmt.execute(params![
                oracle_ids[*card as usize],
                tags[*tag as usize].slug,
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
    db: &Mutex<Connection>,
    tags: &[Tag],
    written: &mut u64,
    progress: &mut dyn FnMut(u64),
) -> Result<(), TagError> {
    let mut pending: Vec<(&str, &str)> = Vec::with_capacity(BATCH);
    for tag in tags {
        for &parent in &tag.parents {
            pending.push((tag.slug.as_str(), tags[parent as usize].slug.as_str()));
        }
        if pending.len() >= BATCH {
            flush_edges(db, &mut pending)?;
            *written += BATCH as u64;
            progress(*written);
        }
    }
    if !pending.is_empty() {
        let n = pending.len() as u64;
        flush_edges(db, &mut pending)?;
        *written += n;
    }
    Ok(())
}

fn flush_edges(db: &Mutex<Connection>, pending: &mut Vec<(&str, &str)>) -> Result<(), TagError> {
    let mut conn = crate::db::lock_blocking(db);
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT OR IGNORE INTO oracle_tag_parents_staging (child_slug, parent_slug)
             VALUES (?1, ?2)",
        )?;
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

/// The closure itself: for each card, every tag it holds and every ancestor of those tags.
///
/// Returns the number of rows written. The per-card `HashSet` is what makes two tags sharing
/// an ancestor one row rather than a primary-key collision.
fn write_closure(
    db: &Mutex<Connection>,
    tags: &[Tag],
    oracle_ids: &[String],
    card_tags: &[Vec<u32>],
    closures: &[Vec<u32>],
    written: &mut u64,
    progress: &mut dyn FnMut(u64),
) -> Result<u64, TagError> {
    let mut rows = 0u64;
    let mut pending: Vec<(&str, &str)> = Vec::with_capacity(BATCH);
    let mut inherited: HashSet<u32> = HashSet::new();
    for (card, held) in card_tags.iter().enumerate() {
        inherited.clear();
        for &tag in held {
            inherited.extend(closures[tag as usize].iter().copied());
        }
        // Sorted for the same reason `ancestor_closures` sorts: a run's rows should not
        // depend on a hash seed.
        let mut slugs: Vec<u32> = inherited.iter().copied().collect();
        slugs.sort_unstable();
        for tag in slugs {
            pending.push((oracle_ids[card].as_str(), tags[tag as usize].slug.as_str()));
            rows += 1;
        }
        // Flushed between cards, never inside one: a batch boundary in the middle of a card's
        // tags is exactly the half-written state the staging tables exist to hide, and there
        // is no reason to create one when the next card is a natural seam.
        if pending.len() >= BATCH {
            let n = pending.len() as u64;
            flush_closure(db, &mut pending)?;
            *written += n;
            progress(*written);
        }
    }
    if !pending.is_empty() {
        let n = pending.len() as u64;
        flush_closure(db, &mut pending)?;
        *written += n;
    }
    Ok(rows)
}

fn flush_closure(db: &Mutex<Connection>, pending: &mut Vec<(&str, &str)>) -> Result<(), TagError> {
    let mut conn = crate::db::lock_blocking(db);
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT OR IGNORE INTO oracle_tag_cards_staging (oracle_id, slug) VALUES (?1, ?2)",
        )?;
        for (oracle_id, slug) in pending.iter() {
            stmt.execute(params![oracle_id, slug])?;
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

/// Both read paths' shared half: dedupe the request, ask in chunks, and answer one
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

/// What the UI needs to say whether the taxonomy is there and how old it is.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OracleTagStatus {
    /// Scryfall's own stamp for the file these rows came from, verbatim. `None` where nothing
    /// has been ingested — and, separately, where a response carried none.
    pub updated_at: Option<String>,
    /// Unix seconds. **`None` is "never ingested"**, which is the state that means the app is
    /// categorising by card type and not by what a card does.
    pub ingested_at: Option<i64>,
    /// Unix seconds: when Scryfall was last **asked** whether the file had changed. Moves on a
    /// 304, where `ingestedAt` does not — so the two coming apart is the ordinary state of an
    /// up-to-date taxonomy, not a fault.
    pub checked_at: Option<i64>,
    pub tag_count: Option<i64>,
    pub tagging_count: Option<i64>,
    /// Checked longer ago than [`REFRESH_INTERVAL_SECS`], or never ingested at all.
    pub stale: bool,
    /// A refresh is in flight right now.
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
/// an absence, and both mean "fall back to card types".
fn read_meta(conn: &Connection) -> Option<TagMeta> {
    conn.query_row(
        "SELECT etag, updated_at, ingested_at, checked_at, tag_count, tagging_count
           FROM oracle_tag_meta WHERE id = 1",
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
fn closure_is_populated(conn: &Connection) -> bool {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM oracle_tag_cards)", [], |r| {
        r.get::<_, i64>(0)
    })
    .map(|n| n == 1)
    .unwrap_or(false)
}

/// Has this file earned another look? **`checked_at`, not `ingested_at`** — a 304 means the
/// rows are current, and asking again tomorrow because they were *built* a week ago would
/// spend one API call per launch to learn nothing. Never checked is stale by definition, and a
/// stamp in the future (a clock that moved) counts as stale rather than underflowing.
pub fn is_stale(checked_at: Option<i64>, now: i64) -> bool {
    match checked_at {
        None => true,
        Some(at) => at > now || now - at >= REFRESH_INTERVAL_SECS,
    }
}

/// The taxonomy's state, read from a connection the caller already holds.
pub fn read_status(conn: &Connection, now: i64) -> OracleTagStatus {
    let meta = read_meta(conn);
    OracleTagStatus {
        updated_at: meta.as_ref().and_then(|m| m.stamp.updated_at.clone()),
        ingested_at: meta.as_ref().map(|m| m.ingested_at),
        checked_at: meta.as_ref().map(|m| m.checked_at),
        tag_count: meta.as_ref().map(|m| m.tag_count),
        tagging_count: meta.as_ref().map(|m| m.tagging_count),
        stale: is_stale(meta.as_ref().map(|m| m.checked_at), now),
        refreshing: REFRESHING.load(Ordering::SeqCst),
    }
}

fn status_of(state: &AppState) -> OracleTagStatus {
    let conn = crate::sync::lock_db_read(state);
    read_status(&conn, unix_now())
}

/// Seconds since the Unix epoch. A clock before 1970 reads as 0, which makes the taxonomy
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

/// One refresh at a time. A module-level flag rather than a field on `AppState`, for
/// [`crate::marketplace_feed`]'s reason: it is this module's concern alone.
static REFRESHING: AtomicBool = AtomicBool::new(false);

/// Clears the claim however the refresh ends — an early return, an error, a dropped future.
/// `sync::SyncingGuard`'s shape, for its reason: a latched flag locks the user out until they
/// restart the app.
struct RefreshGuard;

impl RefreshGuard {
    /// Claim the refresh, or `None` if one is already running.
    fn claim() -> Option<RefreshGuard> {
        (!REFRESHING.swap(true, Ordering::SeqCst)).then_some(RefreshGuard)
    }
}

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        REFRESHING.store(false, Ordering::SeqCst);
    }
}

/// Where the tag file is downloaded to. Beside the bulk file's `tmp/`, and deleted either way.
fn temp_path(state: &AppState) -> PathBuf {
    state.data_dir.join("tmp").join("oracle-tags.jsonl.gz")
}

/// Write a failed refresh to `error_log`, best-effort.
///
/// `Source::ScryfallApi` because that is exactly what this is — unlike
/// [`crate::marketplace_feed`], which has to borrow `Database` for want of a source of its
/// own. The `operation` names the dataset so a reader can tell a tag failure from a card one.
fn note_failure(db: &Mutex<Connection>, kind: crate::errors::Kind, message: &str) {
    // Skipped rather than waited for if the connection is busy: this describes a failure that
    // has already happened, on a path that is already returning an error.
    if let Some(conn) = crate::db::lock_for(db, crate::db::WRITE_LOCK_WAIT) {
        crate::errors::record(
            &conn,
            crate::errors::Source::ScryfallApi,
            "oracle_tags",
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
fn mark_checked(state: &Arc<AppState>, etag: Option<Option<&str>>) {
    let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) else {
        return;
    };
    let now = unix_now();
    let _ = match etag {
        Some(etag) => conn.execute(
            "UPDATE oracle_tag_meta SET checked_at = ?1, etag = ?2 WHERE id = 1",
            params![now, etag],
        ),
        None => conn.execute(
            "UPDATE oracle_tag_meta SET checked_at = ?1 WHERE id = 1",
            params![now],
        ),
    };
}

/// Fetch the Oracle Tags file if it has changed, and replace the taxonomy with it.
///
/// `force` skips the [`REFRESH_INTERVAL_SECS`] throttle but **not** the ETag check: a forced
/// refresh that finds the same file answers in well under a second and downloads nothing.
///
/// `progress` is called with `(phase, done, total)`; the command below turns that into the
/// [`PROGRESS_EVENT`]. Taken as a callback rather than an `AppHandle` for
/// [`crate::ingest`]'s reason — it is what lets the whole path be driven from a test.
///
/// Every failure leaves the previous tags exactly where they were, and every one that came
/// from Scryfall or from the file it served is written to `error_log`. (A listing with no
/// size, and a `tmp/` that cannot be created, are refusals *before* any of that and are
/// returned as a sentence — there is nothing about the outside world to record.)
pub async fn refresh(
    state: &Arc<AppState>,
    force: bool,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<OracleTagStatus, String> {
    let Some(_guard) = RefreshGuard::claim() else {
        // Refused rather than queued, exactly as a second concurrent sync is: the run already
        // in flight is the one driving the progress event.
        return Err("Oracle tags are already being refreshed.".into());
    };

    let (stamp, checked_at, populated) = {
        let conn = crate::sync::lock_db_read(state);
        let meta = read_meta(&conn);
        (
            meta.as_ref().map(|m| m.stamp.clone()).unwrap_or_default(),
            meta.as_ref().map(|m| m.checked_at),
            closure_is_populated(&conn),
        )
    };
    if !force && !is_stale(checked_at, unix_now()) {
        return Ok(status_of(state));
    }

    progress("checking", 0, 0);
    // The stored ETag describes a *file*, not the state of this database: replaying it when
    // the closure is empty earns a 304 for a taxonomy that has nothing in it, and no amount of
    // refreshing gets past that. `crate::sync::conditional_etag`, one dataset over.
    let conditional = stamp.etag.as_deref().filter(|_| populated);
    let check = match state
        .client
        .check_bulk_dataset(crate::scryfall::BULK_ORACLE_TAGS, conditional)
        .await
    {
        Ok(check) => check,
        Err(e) => {
            note_failure(&state.db, crate::errors::kind_of(&e), &e.to_string());
            progress("error", 0, 0);
            return Err(e.to_string());
        }
    };

    let crate::scryfall::BulkCheck::Available(info) = check else {
        // The common case, and it costs zero bytes. The rows are untouched and only the
        // "when did we last ask" stamp moves — without which an up-to-date taxonomy would be
        // due again on the very next launch.
        mark_checked(state, None);
        progress("done", 0, 0);
        return Ok(status_of(state));
    };
    let updated_at = Some(info.updated_at.clone()).filter(|s| !s.is_empty());

    // A 200 with the file we already hold: the endpoint answers 200 whenever the stored ETag
    // does not match, including when a proxy stripped it, so `updated_at` is the only other
    // evidence the file actually rotated. Store the ETag it came with, so the next check is a
    // free 304 again.
    if populated && updated_at.is_some() && updated_at == stamp.updated_at {
        mark_checked(state, Some(info.etag.as_deref()));
        progress("done", 0, 0);
        return Ok(status_of(state));
    }

    if info.compressed_size == 0 {
        progress("error", 0, 0);
        return Err("the oracle tag listing had no size; refusing to download".into());
    }

    let gz = temp_path(state);
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
        note_failure(&state.db, crate::errors::kind_of(&e), &e.to_string());
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
            ingest_gz(&state.db, &gz, &stamp, unix_now(), &mut |_| {})
        })
        .await
    };
    let _ = std::fs::remove_file(&gz);

    match joined {
        Ok(Ok(_)) => {
            progress("done", 0, 0);
            Ok(status_of(state))
        }
        Ok(Err(e)) => {
            note_failure(&state.db, e.kind(), &e.to_string());
            progress("error", 0, 0);
            Err(e.to_string())
        }
        Err(e) => {
            progress("error", 0, 0);
            Err(format!("the oracle tag file could not be processed: {e}"))
        }
    }
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// Payload of [`PROGRESS_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleTagProgress {
    /// One of [`PHASES`].
    pub phase: String,
    pub done: u64,
    pub total: u64,
}

/// Emit one progress event. Dropped if nobody is listening, which is Tauri's behaviour and is
/// why [`oracle_tags_status`] exists: the event is the fast path, the table is the one a
/// reader can still consult a minute later.
fn emit(app: &tauri::AppHandle, phase: &str, done: u64, total: u64) {
    debug_assert!(
        PHASES.contains(&phase),
        "unknown oracle tag phase `{phase}`"
    );
    let _ = app.emit(
        PROGRESS_EVENT,
        OracleTagProgress {
            phase: phase.to_owned(),
            done,
            total,
        },
    );
}

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
    refresh(&state, force, &mut |phase, done, total| {
        emit(&app, phase, done, total)
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
    tauri::async_runtime::spawn_blocking(move || status_of(&state))
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
/// **Silent, best-effort and never blocking.** It runs before there is a window to complain
/// in, a failure is already in `error_log`, and the honest fallback is the tags already on
/// disk — or, on a first run that fails, categorising by card type exactly as the app did
/// before this file existed. Neither the launch nor the card sync may ever wait on it.
pub async fn refresh_if_due(state: &Arc<AppState>, app: &tauri::AppHandle) {
    let due = {
        let conn = crate::sync::lock_db_read(state);
        is_stale(read_meta(&conn).map(|m| m.checked_at), unix_now())
    };
    if !due {
        return;
    }
    let app = app.clone();
    if let Err(e) = refresh(state, false, &mut |phase, done, total| {
        emit(&app, phase, done, total)
    })
    .await
    {
        eprintln!("could not refresh the oracle tags: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    /// A migrated in-memory database behind the write mutex, which is how the ingest is
    /// handed one.
    fn mem_db() -> Mutex<Connection> {
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
    /// read test and the printing-keyed one below build the same three lines, so they hash to
    /// one path. `File::create` truncates, so whichever ran second emptied the file the first
    /// was still streaming, and that test failed with `Io(Kind(UnexpectedEof))` on its
    /// `ingest(…).unwrap()` — a panic naming neither the race nor the other test. It went red on
    /// `rust (windows-latest)` while Linux passed, which is what a timing race looks like.
    ///
    /// So: write a private file and move it into place. Losing the move is fine — the bytes are
    /// keyed on the content, so whoever won wrote the same file — and a reader with the fixture
    /// open is what makes the move fail rather than something to avoid.
    fn gz_fixture(lines: &[&str]) -> std::path::PathBuf {
        use std::hash::{DefaultHasher, Hash, Hasher};
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
    /// `gz_fixture` builds cannot be the private file another one is building.
    fn next_fixture_id() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

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
        ingest_gz(db, &p, &FileStamp::default(), 1_800_000_000, &mut |_| {})
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

        let tag = parse_tag_line(&v).expect("a tag object must parse");

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
                    oracle_id: "oid-1".into(),
                    weight: Some("median".into()),
                    annotation: None,
                },
                TaggingLine {
                    oracle_id: "oid-2".into(),
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
            assert!(parse_tag_line(&v).is_none(), "must not parse: {line}");
        }

        // A tag with no parents, no taggings and no description is a real tag — a brand new
        // root nobody has used yet — and must parse.
        let bare: serde_json::Value =
            serde_json::from_str(r#"{"object":"tag","id":"a1","slug":"ramp"}"#).unwrap();
        let tag = parse_tag_line(&bare).unwrap();
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
            let stats = ingest_gz(&db, &p, &FileStamp::default(), 1_800_000_000, &mut |_| {
                ingesting.store(true, Ordering::SeqCst)
            });
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
    /// `SCAN c` where it meant to read an index — `import`'s 46 s. `cards.id` is the
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

        let status = read_status(&conn, 1_800_000_000);
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
        ingest_gz(&db, &p, &stamp, 1_800_000_000, &mut |_| {}).unwrap();
        let conn = crate::db::lock_blocking(&db);

        let status = read_status(&conn, 1_800_000_000);
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
            closure_is_populated(&conn),
        );
        assert_eq!(etag.as_deref(), Some("W/\"abc\""));
        assert!(populated);

        assert!(
            read_status(&conn, 1_800_000_000 + REFRESH_INTERVAL_SECS).stale,
            "a week later it is due again"
        );
    }

    /// Never ingested is stale; so is a stamp from the future, which is a clock that moved
    /// rather than a reason to wait a week.
    #[test]
    fn staleness_survives_a_clock_that_moved() {
        assert!(is_stale(None, 1_800_000_000));
        assert!(!is_stale(Some(1_800_000_000), 1_800_000_000));
        assert!(!is_stale(
            Some(1_800_000_000),
            1_800_000_000 + REFRESH_INTERVAL_SECS - 1
        ));
        assert!(is_stale(
            Some(1_800_000_000),
            1_800_000_000 + REFRESH_INTERVAL_SECS
        ));
        assert!(is_stale(Some(1_800_000_100), 1_800_000_000), "future stamp");
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
        let first = refresh(&state, false, &mut |phase, _, _| {
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
        let second = refresh(&state, true, &mut |phase, _, _| {
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
