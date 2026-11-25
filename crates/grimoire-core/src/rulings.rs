//! Scryfall's **rulings**: what Wizards (and, now and then, Scryfall) have said about how a card
//! works, dated, one bulk file for every card.
//!
//! An agent asked how two cards interact has the oracle text and, with this, the rulings that
//! were written for exactly that question. The local MCP server's `card_rulings` and `get_card`
//! read them (`apps/desktop/src-tauri/src/mcp/tools.rs`); no page does. Spec:
//! `docs/superpowers/specs/2026-11-25-mcp-rulings-design.md`.
//!
//! Measured live on 2026-11-25 against that day's file:
//!
//! | | |
//! | --- | --- |
//! | Manifest | `GET /bulk-data/rulings` — `jsonl_download_uri` + `compressed_size`, the shape [`crate::scryfall::BulkInfo`] reads |
//! | Payload | 5 508 481 bytes gzipped JSONL, 26.8 MB of JSON, one `ruling` object per line, regenerated daily |
//! | Rulings | 80 928 over 20 387 oracle ids · median 3 a card, most 32 · `wotc` 80 859, `scryfall` 69 |
//! | Order | within a card the file is in date order (0 steps back) |
//! | Repeats | 43 lines repeat another of the same card exactly |
//!
//! **The rules every feed here keeps, kept here too.** It is Scryfall, so it goes through
//! [`crate::scryfall::Client`] and shares its pacing gate and its 429 lockout — one
//! `/bulk-data/rulings` a week and one download when it changed, never a request per card.
//! Nothing here may break a launch or a card sync: a refresh is spawned, best-effort and
//! silent, and a failure leaves the previous rulings in place with its reason in `error_log`.
//! A corpus that has never fetched the file is a supported state — every answer built on it says
//! so ([`RulingStatus::ingested_at`] is `None`).
//!
//! **Only the desktop fetches it** (the owner's decision, 2026-11-25): it is the one host with
//! the MCP server. The read commands answer on every host. A host that keeps no files is refused
//! by [`refresh`] before anything is asked: the ingest is a push sink ([`StreamRulings`]) so a
//! streamed driver can feed it, and none is written yet.
use crate::state::State;
use crate::tags::FileStamp;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Scryfall's name for the bulk entry, **and this feed's `operation` in `error_log` and its
/// [`crate::feed::backoff`] key**. Aliases [`crate::scryfall::BULK_RULINGS`].
pub const BULK_NAME: &str = crate::scryfall::BULK_RULINGS;

/// How long an ingested file stays fresh: a week, the tag files' figure and reason. Scryfall
/// regenerates the file daily and rulings move at a set's release, so a daily download would
/// buy almost nothing. **A weekly check nearly always finds a new file** — it was rebuilt six
/// times since the last one — so the week costs one 5.5 MB download; the ETag and the
/// `updated_at` short cut save only a forced refresh made the same day.
pub const REFRESH_INTERVAL_SECS: i64 = 7 * 86_400;

/// What [`refresh`] answers on a host that keeps no files, before it asks Scryfall anything.
pub const NO_FILES: &str =
    "Rulings are downloaded only where the app keeps files, and this host keeps none.";

/// The name the download is given under `data_dir/tmp/`.
const TMP_FILE: &str = "rulings.jsonl.gz";

/// Rows per staging transaction — [`crate::ingest`]'s number, for its reason: it is how long
/// another writer can be made to wait for the write connection.
const BATCH: usize = 2_000;

/// How much of the file is read at a time — `crate::ingest::ingest_gz`'s figure.
const READ_CHUNK: usize = 64 * 1024;

/// Oracle ids per `IN (…)` — `tags`' figure, for its reason.
const LOOKUP_CHUNK: usize = 500;

/// How long the ingest stands aside between two batches — `tags::YIELD_BETWEEN_BATCHES`, and
/// every one of its reasons.
const YIELD_BETWEEN_BATCHES: std::time::Duration = std::time::Duration::from_millis(5);

// ---------------------------------------------------------------------------------------
// What is answered
// ---------------------------------------------------------------------------------------

/// One ruling, as the file gave it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Ruling {
    /// `wotc` (Wizards' own) or `scryfall` (a note of Scryfall's), verbatim.
    pub source: String,
    /// `YYYY-MM-DD`, verbatim.
    pub published_at: String,
    pub comment: String,
}

/// One card's rulings, oldest first.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardRulings {
    /// The oracle id **that was asked about**, echoed.
    pub oracle_id: String,
    /// Empty for a card with no rulings and for an id the file never named alike; which of the
    /// two it is cannot be told from the rulings, and "the list was never downloaded" is
    /// [`RulingStatus`]'s to say.
    pub rulings: Vec<Ruling>,
}

/// Whether the rulings are there and how old they are — `tags::TagStatus`'s shape.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RulingStatus {
    /// Scryfall's own stamp for the file the rows came from, verbatim.
    pub updated_at: Option<String>,
    /// Unix seconds. **`None` is "never downloaded"**, and an empty answer then means nothing.
    pub ingested_at: Option<i64>,
    /// Unix seconds: when Scryfall was last asked. Moves on a 304, where `ingestedAt` does not.
    pub checked_at: Option<i64>,
    pub ruling_count: Option<i64>,
    pub card_count: Option<i64>,
    /// Checked longer ago than [`REFRESH_INTERVAL_SECS`], or never.
    pub stale: bool,
    /// A refresh is in flight right now.
    pub refreshing: bool,
}

/// What one ingest did. Every count is a fact about the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RulingStats {
    /// Rulings stored.
    pub rulings: u64,
    /// Distinct oracle ids among them.
    pub cards: u64,
    /// Lines that repeated a ruling already kept for the same card, word for word.
    pub duplicates: u64,
    /// Lines that were not a usable ruling.
    pub skipped_lines: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum RulingError {
    #[error("failed to read the rulings file: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error while storing rulings: {0}")]
    Db(#[from] rusqlite::Error),
    /// The file decoded and not one line was a ruling — a gzipped error page, a truncated
    /// download, another dataset. `tags::TagError::Empty`'s refusal, for its reason.
    #[error(
        "no rulings found in the rulings file ({skipped} lines skipped); keeping the previous ones"
    )]
    Empty { skipped: u64 },
    /// More lines were unusable than were rulings — [`crate::feed::mostly_unusable`].
    #[error(
        "only {kept} lines of the rulings file were rulings and {skipped} were not; \
         keeping the previous ones"
    )]
    MostlySkipped { kept: u64, skipped: u64 },
}

impl RulingError {
    /// How the error log should classify this.
    pub fn kind(&self) -> crate::errors::Kind {
        use crate::errors::Kind;
        match self {
            RulingError::Io(_) | RulingError::Db(_) => Kind::Io,
            RulingError::Empty { .. } | RulingError::MostlySkipped { .. } => Kind::Parse,
        }
    }
}

// ---------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------

/// One line of the file, narrowed to what is stored.
struct Line {
    oracle_id: String,
    source: String,
    published_at: String,
    comment: String,
}

/// One line as a ruling, or `None`. **What a line must be**: a JSON object whose `object` is
/// `ruling`, with a non-empty `oracle_id` and `comment` and a `source` and `published_at`. Every
/// line of the 2026-11-25 file is; anything else is counted and stepped over.
fn parse_line(bytes: &[u8]) -> Option<Line> {
    let text = std::str::from_utf8(bytes).ok()?;
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if v.get("object").and_then(serde_json::Value::as_str) != Some("ruling") {
        return None;
    }
    let field = |key: &str| {
        v.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    Some(Line {
        oracle_id: field("oracle_id")?,
        source: field("source")?,
        published_at: field("published_at")?,
        comment: field("comment")?,
    })
}

/// A line's identity for the repeat check: a hash of all four fields, so a ruling the file
/// lists twice for one card is stored once.
///
/// **A hash rather than the text**, which would hold the whole 16 MB of comments a second time
/// for a check that drops 43 lines. Two different rulings sharing a 64-bit hash would lose the
/// second — about one chance in 10¹⁰ over the whole file.
fn identity(line: &Line) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (
        &line.oracle_id,
        &line.source,
        &line.published_at,
        &line.comment,
    )
        .hash(&mut h);
    h.finish()
}

/// One staged row: `(oracle_id, seq, source, published_at, comment)`.
type Row = (String, i64, String, String, String);

/// What the push loop keeps between chunks — `tags::Accum`'s reason for being a struct: the
/// framer calls back per line, and that closure needs the whole of it.
#[derive(Default)]
struct Accum {
    stats: RulingStats,
    seen: HashSet<u64>,
    /// Each card's next `seq`: how many of its rulings have been kept so far.
    next_seq: HashMap<String, i64>,
    batch: Vec<Row>,
}

impl Accum {
    /// Fold one line in, or count it. Infallible, so it can be the framer's callback; the
    /// database is written after the framer returns.
    fn take_line(&mut self, bytes: &[u8]) {
        let Some(line) = parse_line(bytes) else {
            self.stats.skipped_lines += 1;
            return;
        };
        if !self.seen.insert(identity(&line)) {
            self.stats.duplicates += 1;
            return;
        }
        let seq = self.next_seq.entry(line.oracle_id.clone()).or_insert(0);
        let this = *seq;
        *seq += 1;
        self.stats.rulings += 1;
        self.batch.push((
            line.oracle_id,
            this,
            line.source,
            line.published_at,
            line.comment,
        ));
    }
}

/// Commit one batch to `rulings_staging`, then let go of the connection long enough for a
/// waiting writer to see it free — `tags::write_taggings`' discipline.
fn write_batch(db: &Mutex<Connection>, batch: &mut Vec<Row>) -> Result<(), RulingError> {
    {
        let mut conn = crate::db::lock_background(db);
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO rulings_staging (oracle_id, seq, source, published_at, comment)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for (oracle_id, seq, source, published_at, comment) in batch.iter() {
                stmt.execute(params![oracle_id, seq, source, published_at, comment])?;
            }
        }
        tx.commit()?;
    }
    crate::platform::pause(YIELD_BETWEEN_BATCHES);
    batch.clear();
    Ok(())
}

/// A rulings ingest as an object the caller pushes bytes into — `tags::StreamTags`' shape, so
/// a file read a chunk at a time ([`ingest_gz`]) and a body streamed a chunk at a time can both
/// feed it.
///
/// Everything is written to `rulings_staging`, which no reader sees, and promoted by one rename
/// transaction that also writes the `ruling_meta` row. So a failure partway leaves the previous
/// rulings exactly where they were; the next run's [`StreamRulings::begin`] drops what it left.
pub struct StreamRulings<'a> {
    db: &'a Mutex<Connection>,
    decoder: crate::feed::frame::Decoder,
    lines: crate::feed::frame::Lines,
    decoded: Vec<u8>,
    acc: Accum,
}

impl<'a> StreamRulings<'a> {
    /// Create an empty `rulings_staging` and get ready for the first chunk.
    pub fn begin(db: &'a Mutex<Connection>) -> Result<Self, RulingError> {
        {
            let conn = crate::db::lock_background(db);
            crate::schema::create_ruling_staging(&conn)?;
        }
        Ok(StreamRulings {
            db,
            decoder: crate::feed::frame::Decoder::new(),
            lines: crate::feed::frame::Lines::new(),
            decoded: Vec::new(),
            acc: Accum {
                batch: Vec::with_capacity(BATCH),
                ..Accum::default()
            },
        })
    }

    /// Feed one chunk of the file.
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), RulingError> {
        self.decoded.clear();
        self.decoder.push(chunk, &mut self.decoded)?;
        let acc = &mut self.acc;
        self.lines
            .push(&self.decoded, |line| acc.take_line(line))
            .map_err(std::io::Error::from)?;
        if self.acc.batch.len() >= BATCH {
            write_batch(self.db, &mut self.acc.batch)?;
        }
        Ok(())
    }

    /// Give up, and drop what was staged. Best-effort: what cannot be dropped now is dropped by
    /// the next run's [`StreamRulings::begin`].
    pub fn abandon(self) {
        let conn = crate::db::lock_background(self.db);
        let _ = crate::schema::drop_ruling_staging(&conn);
    }

    /// Flush what is owed, refuse a file that is not a list of rulings, and swap the staged rows
    /// into place with the watermark that says which file they came from.
    pub fn finish(
        mut self,
        stamp: &FileStamp,
        ingested_at: i64,
    ) -> Result<RulingStats, RulingError> {
        self.decoded.clear();
        self.decoder.finish(&mut self.decoded)?;
        {
            let acc = &mut self.acc;
            // The decoder can hold a small file's tail back until here, so the lines it frees
            // are folded before the last batch — `tags::StreamTags::finish_in_turns` has the
            // measurement.
            self.lines
                .push(&self.decoded, |line| acc.take_line(line))
                .map_err(std::io::Error::from)?;
            self.lines.finish(|line| acc.take_line(line));
        }
        if !self.acc.batch.is_empty() {
            write_batch(self.db, &mut self.acc.batch)?;
        }

        let StreamRulings { db, acc, .. } = self;
        let mut stats = acc.stats;
        stats.cards = acc.next_seq.len() as u64;
        // The swap below is unconditional, so this is the last place a file that is not a list
        // of rulings can be stopped; either refusal keeps the previous rows and drops staging.
        let refusal = if stats.rulings == 0 {
            Some(RulingError::Empty {
                skipped: stats.skipped_lines,
            })
        } else if crate::feed::mostly_unusable(stats.rulings, stats.skipped_lines) {
            Some(RulingError::MostlySkipped {
                kept: stats.rulings,
                skipped: stats.skipped_lines,
            })
        } else {
            None
        };
        if let Some(err) = refusal {
            let conn = crate::db::lock_background(db);
            crate::schema::drop_ruling_staging(&conn)?;
            return Err(err);
        }

        let mut conn = crate::db::lock_background(db);
        let tx = conn.transaction()?;
        crate::schema::swap_ruling_staging(&tx)?;
        // In the swap's transaction, and that is the contract: a watermark without its rows
        // would 304 past an empty list forever, and rows without one would download again.
        tx.execute(
            "INSERT INTO ruling_meta
                 (id, etag, updated_at, ingested_at, checked_at, ruling_count, card_count)
             VALUES (1, ?1, ?2, ?3, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                 etag = excluded.etag,
                 updated_at = excluded.updated_at,
                 ingested_at = excluded.ingested_at,
                 checked_at = excluded.checked_at,
                 ruling_count = excluded.ruling_count,
                 card_count = excluded.card_count",
            params![
                stamp.etag,
                stamp.updated_at,
                ingested_at,
                stats.rulings as i64,
                stats.cards as i64
            ],
        )?;
        tx.commit()?;
        Ok(stats)
    }
}

/// Read a downloaded rulings file into staging a chunk at a time and swap it into place.
pub fn ingest_gz(
    db: &Mutex<Connection>,
    gz_path: &Path,
    stamp: &FileStamp,
    ingested_at: i64,
) -> Result<RulingStats, RulingError> {
    use std::io::Read as _;
    // Opened before the database is touched: a missing file must not cost the staging table.
    let mut file = crate::platform::files::open(gz_path)?;
    let mut sink = StreamRulings::begin(db)?;
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        let n = match file.read(&mut buf) {
            Ok(n) => n,
            Err(e) => {
                sink.abandon();
                return Err(e.into());
            }
        };
        if n == 0 {
            break;
        }
        if let Err(e) = sink.push(&buf[..n]) {
            sink.abandon();
            return Err(e);
        }
    }
    sink.finish(stamp, ingested_at)
}

// ---------------------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------------------

/// The rulings of every card in `oracle_ids`, one entry per distinct id in the order asked,
/// each card's oldest first.
///
/// Blank and repeated ids are dropped; an id with no rows answers an empty list rather than
/// being absent, so "this card has no rulings" and "I did not ask" stay two answers.
pub fn rulings_for_cards(
    conn: &Connection,
    oracle_ids: &[String],
) -> rusqlite::Result<Vec<CardRulings>> {
    let mut order: Vec<&str> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for id in oracle_ids {
        let id = id.trim();
        if !id.is_empty() && seen.insert(id) {
            order.push(id);
        }
    }
    let mut found: HashMap<String, Vec<Ruling>> = HashMap::new();
    for chunk in order.chunks(LOOKUP_CHUNK) {
        let holes = vec!["?"; chunk.len()].join(", ");
        // `seq` is the file's order within a card, which is its date order: the primary key's
        // own order, so no sort.
        let mut stmt = conn.prepare(&format!(
            "SELECT oracle_id, source, published_at, comment FROM rulings
              WHERE oracle_id IN ({holes}) ORDER BY oracle_id, seq"
        ))?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                Ruling {
                    source: r.get(1)?,
                    published_at: r.get(2)?,
                    comment: r.get(3)?,
                },
            ))
        })?;
        for row in rows {
            let (oracle_id, ruling) = row?;
            found.entry(oracle_id).or_default().push(ruling);
        }
    }
    Ok(order
        .into_iter()
        .map(|id| CardRulings {
            oracle_id: id.to_owned(),
            rulings: found.remove(id).unwrap_or_default(),
        })
        .collect())
}

/// The stored watermark.
struct Meta {
    stamp: FileStamp,
    ingested_at: i64,
    checked_at: i64,
    ruling_count: i64,
    card_count: i64,
}

/// The watermark, or `None` when nothing was ever ingested. A row that cannot be read reads as
/// "never ingested", `tags::read_meta`'s choice and reason.
fn read_meta(conn: &Connection) -> Option<Meta> {
    conn.query_row(
        "SELECT etag, updated_at, ingested_at, checked_at, ruling_count, card_count
           FROM ruling_meta WHERE id = 1",
        [],
        |r| {
            Ok(Meta {
                stamp: FileStamp {
                    etag: r.get(0)?,
                    updated_at: r.get(1)?,
                },
                ingested_at: r.get(2)?,
                checked_at: r.get(3)?,
                ruling_count: r.get(4)?,
                card_count: r.get(5)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// Are there rows to read? The second half of the ETag decision, `tags::closure_is_populated`'s
/// reason: a watermark can outlive its rows, and replaying its ETag would 304 past an empty table.
fn is_populated(conn: &Connection) -> bool {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM rulings)", [], |r| {
        r.get::<_, i64>(0)
    })
    .map(|n| n == 1)
    .unwrap_or(false)
}

/// The feed's state, read from a connection the caller holds, at `now` (unix seconds).
pub fn read_status(conn: &Connection, now: i64) -> RulingStatus {
    let meta = read_meta(conn);
    RulingStatus {
        updated_at: meta.as_ref().and_then(|m| m.stamp.updated_at.clone()),
        ingested_at: meta.as_ref().map(|m| m.ingested_at),
        checked_at: meta.as_ref().map(|m| m.checked_at),
        ruling_count: meta.as_ref().map(|m| m.ruling_count),
        card_count: meta.as_ref().map(|m| m.card_count),
        stale: crate::tags::is_stale(
            meta.as_ref().map(|m| m.checked_at),
            REFRESH_INTERVAL_SECS,
            now,
        ),
        refreshing: is_refreshing(),
    }
}

/// [`read_status`] at SQLite's own now — the `rulings_status` command's body.
pub fn status_now(conn: &Connection) -> RulingStatus {
    read_status(conn, crate::tags::now_from(conn))
}

/// [`read_status`] on the state's read connection.
pub fn status_of(state: &State) -> RulingStatus {
    let conn = state.lock_db_read();
    status_now(&conn)
}

// ---------------------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------------------

/// The refreshes in flight, by name: [`BULK_NAME`] for the real one. A list rather than a flag
/// for the tests' sake alone — `tags::REFRESHING`'s shape — so a test in another module can hold
/// a claim of its own name ([`hold_refresh_for_test`]) without making this module's refresh
/// tests answer "already being refreshed" at random.
static REFRESHING: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

/// Clears the claim however the refresh ends — `tags::RefreshGuard`'s shape and reason.
pub(crate) struct RefreshGuard(&'static str);

impl RefreshGuard {
    fn claim(name: &'static str) -> Option<RefreshGuard> {
        let mut held = crate::db::lock_plain(&REFRESHING);
        if held.contains(&name) {
            return None;
        }
        held.push(name);
        Some(RefreshGuard(name))
    }
}

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        crate::db::lock_plain(&REFRESHING).retain(|n| *n != self.0);
    }
}

/// Is the rulings refresh in flight?
fn is_refreshing() -> bool {
    crate::db::lock_plain(&REFRESHING).contains(&BULK_NAME)
}

/// Is any claim held? [`crate::reset::cache_clear`]'s question: the download sits in
/// `data/tmp/` for exactly the span the claim is held.
pub(crate) fn any_refresh_running() -> bool {
    !crate::db::lock_plain(&REFRESHING).is_empty()
}

/// Hold a claim under `name` until the guard drops, with no download behind it. **`name` must
/// not be [`BULK_NAME`]** outside this module's own serialised tests.
#[cfg(test)]
pub(crate) fn hold_refresh_for_test(name: &'static str) -> RefreshGuard {
    RefreshGuard::claim(name).expect("a name no other test holds")
}

fn unix_now() -> i64 {
    crate::platform::clock::now_secs()
}

fn temp_path(state: &State) -> PathBuf {
    state.data_dir.join("tmp").join(TMP_FILE)
}

/// Write a failed refresh to `error_log` under [`BULK_NAME`], best-effort and never waited for
/// past a user write's patience — `tags::note_failure`'s contract.
fn note_failure(db: &Mutex<Connection>, kind: crate::errors::Kind, message: &str) {
    if let Some(conn) = crate::db::lock_for(db, crate::db::WRITE_LOCK_WAIT) {
        crate::errors::record(
            &conn,
            crate::errors::Source::ScryfallApi,
            BULK_NAME,
            kind,
            message,
            None,
        );
    }
}

/// Rest the feed for a day at launch: its file arrived whole and could not be used
/// ([`crate::feed::backoff`]).
fn note_unusable(db: &Mutex<Connection>) {
    if let Some(conn) = crate::db::lock_for(db, crate::db::WRITE_LOCK_WAIT) {
        let _ = crate::feed::backoff::note_unusable(&conn, BULK_NAME, unix_now());
    }
}

/// Note that Scryfall has been asked, on a run that found nothing to ingest, and the fresh ETag
/// where the answer carried one. **Nothing is written when there is no row**: a watermark with no
/// rows behind it is what would make the next run 304 past an empty list.
fn mark_checked(state: &State, etag: Option<Option<&str>>) {
    let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) else {
        return;
    };
    let now = unix_now();
    let _ = match etag {
        Some(etag) => conn.execute(
            "UPDATE ruling_meta SET checked_at = ?1, etag = ?2 WHERE id = 1",
            params![now, etag],
        ),
        None => conn.execute(
            "UPDATE ruling_meta SET checked_at = ?1 WHERE id = 1",
            params![now],
        ),
    };
}

/// Fetch the rulings file if it has changed, and replace the stored rulings with it.
///
/// `tags::refresh`'s contract for one file: `force` skips the week's throttle but not the ETag
/// check; every failure leaves the previous rulings where they were, and every one that came from
/// Scryfall or its file is in `error_log`; a file that arrived and could not be used rests the feed
/// for a day at launch; a 429 is written to disk before this returns. `progress` is called with
/// `(phase, done, total)`, phases `checking`, `downloading`, `ingesting`, `done` and `error`; no
/// event carries them, since no page listens.
pub async fn refresh(
    state: &Arc<State>,
    force: bool,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<RulingStatus, String> {
    let penalty_before = state.client.penalty_until_unix();
    let result = refresh_once(state, force, progress).await;
    if state.client.penalty_until_unix() != penalty_before {
        crate::sync::persist_penalty(state);
    }
    // Read once the claim is let go, so the answer does not say a refresh is still running.
    result.map(|()| status_of(state))
}

/// [`refresh`] without the lockout bookkeeping, which it wraps so no return below can skip it.
async fn refresh_once(
    state: &Arc<State>,
    force: bool,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<(), String> {
    let Some(_guard) = RefreshGuard::claim(BULK_NAME) else {
        return Err("Rulings are already being refreshed.".to_owned());
    };

    let (stamp, checked_at, populated) = {
        let conn = state.lock_db_read();
        let meta = read_meta(&conn);
        (
            meta.as_ref().map(|m| m.stamp.clone()).unwrap_or_default(),
            meta.as_ref().map(|m| m.checked_at),
            is_populated(&conn),
        )
    };
    if !force && !crate::tags::is_stale(checked_at, REFRESH_INTERVAL_SECS, unix_now()) {
        return Ok(());
    }
    // Before Scryfall is asked anything: this host could not keep the download.
    if !crate::platform::host::keeps_files() {
        return Err(NO_FILES.to_owned());
    }

    progress("checking", 0, 0);
    let conditional = stamp.etag.as_deref().filter(|_| populated);
    let check = match state
        .client
        .check_bulk_dataset(BULK_NAME, conditional)
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
        // The common case, and it costs no bytes: only "when did we last ask" moves.
        mark_checked(state, None);
        progress("done", 0, 0);
        return Ok(());
    };
    let updated_at = Some(info.updated_at.clone()).filter(|s| !s.is_empty());

    // A 200 for the file already held (an ETag a proxy stripped): store the ETag it came with,
    // so the next check is a free 304 again.
    if populated && updated_at.is_some() && updated_at == stamp.updated_at {
        mark_checked(state, Some(info.etag.as_deref()));
        progress("done", 0, 0);
        return Ok(());
    }

    if info.compressed_size == 0 {
        progress("error", 0, 0);
        return Err(format!(
            "the {BULK_NAME} listing had no size; refusing to download"
        ));
    }

    let gz = temp_path(state);
    if let Some(parent) = gz.parent() {
        if let Err(e) = crate::platform::files::create_dir_all(parent) {
            progress("error", 0, 0);
            return Err(format!("could not create {}: {e}", parent.display()));
        }
    }

    progress("downloading", 0, info.compressed_size);
    let downloaded = state
        .client
        .download(
            &info.jsonl_download_uri,
            &gz,
            info.compressed_size,
            &mut |done, total| progress("downloading", done, total),
        )
        .await;
    if let Err(e) = downloaded {
        note_failure(&state.db, crate::errors::kind_of(&e), &e.to_string());
        if matches!(e, crate::scryfall::ScryfallError::SizeMismatch { .. }) {
            // The body ended and disagreed with the manifest: upstream's answer, and the same
            // answer next launch. The short file is kept as a resume point, as the tags keep one.
            note_unusable(&state.db);
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
        // Eighty thousand inserts: off the async task, never across an `.await` with a lock.
        crate::platform::spawn::blocking(move || ingest_gz(&state.db, &gz, &stamp, unix_now()))
            .await
    };
    crate::scryfall::discard_partial(&gz);

    match joined {
        Ok(Ok(_)) => {
            if let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
                let _ = crate::feed::backoff::clear(&conn, BULK_NAME);
            }
            progress("done", 0, 0);
            Ok(())
        }
        Ok(Err(e)) => {
            note_failure(&state.db, e.kind(), &e.to_string());
            note_unusable(&state.db);
            progress("error", 0, 0);
            Err(e.to_string())
        }
        Err(e) => {
            note_unusable(&state.db);
            progress("error", 0, 0);
            Err(format!("the {BULK_NAME} file could not be processed: {e}"))
        }
    }
}

/// Should the launch refresh the rulings at `now`? Stale, and not resting after an unusable file.
pub fn due_at_launch(state: &State, now: i64) -> bool {
    let conn = state.lock_db_read();
    crate::tags::is_stale(
        read_meta(&conn).map(|m| m.checked_at),
        REFRESH_INTERVAL_SECS,
        now,
    ) && !crate::feed::backoff::resting(&conn, BULK_NAME, now)
}

/// Refresh the rulings at launch if they are due. **Silent, best-effort and never blocking**,
/// `tags::refresh_if_due`'s contract: a failure is already in `error_log`, and the honest
/// fallback is the rulings already on disk — or, on a first run, none, which every answer says.
pub async fn refresh_if_due(state: &Arc<State>) {
    if !due_at_launch(state, unix_now()) {
        return;
    }
    if let Err(e) = refresh(state, false, &mut |_, _, _| {}).await {
        eprintln!("could not refresh {BULK_NAME}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tags::testing::{gz_fixture, mem_db};
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    fn ruling(oracle_id: &str, date: &str, comment: &str) -> String {
        serde_json::json!({
            "object": "ruling",
            "oracle_id": oracle_id,
            "source": "wotc",
            "published_at": date,
            "comment": comment,
        })
        .to_string()
    }

    fn stamp() -> FileStamp {
        FileStamp {
            etag: Some("W/\"r1\"".to_owned()),
            updated_at: Some("2026-11-25T10:00:33.479+00:00".to_owned()),
        }
    }

    fn ingest(db: &Mutex<Connection>, lines: &[String]) -> Result<RulingStats, RulingError> {
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let path = gz_fixture(&refs);
        ingest_gz(db, &path, &stamp(), 1_800_000_000)
    }

    fn read(db: &Mutex<Connection>, ids: &[&str]) -> Vec<CardRulings> {
        let ids: Vec<String> = ids.iter().map(|s| (*s).to_owned()).collect();
        rulings_for_cards(&db.lock().unwrap(), &ids).unwrap()
    }

    fn staging_left(db: &Mutex<Connection>) -> bool {
        db.lock()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM corpus.sqlite_master WHERE name = 'rulings_staging')",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    /// The fixture file: every shape a line can take, one of each — see `rulings.jsonl`.
    fn fixture() -> Vec<String> {
        crate::tags::testing::fixture_lines("rulings.jsonl")
    }

    #[test]
    fn a_file_is_stored_in_file_order_with_repeats_and_bad_lines_counted() {
        let db = mem_db();
        let stats = ingest(&db, &fixture()).unwrap();
        assert_eq!(
            stats,
            RulingStats {
                rulings: 6,
                cards: 3,
                duplicates: 1,
                skipped_lines: 5,
            }
        );

        let got = read(&db, &["o-saga", "o-moon"]);
        assert_eq!(got[0].oracle_id, "o-saga", "in the order asked");
        let saga: Vec<(&str, &str)> = got[0]
            .rulings
            .iter()
            .map(|r| (r.published_at.as_str(), r.source.as_str()))
            .collect();
        assert_eq!(
            saga,
            [("2023-04-14", "wotc"), ("2023-05-01", "scryfall")],
            "the file's order, kept"
        );
        assert_eq!(got[1].oracle_id, "o-moon");
        assert_eq!(got[1].rulings.len(), 2, "the repeat is stored once");
        assert_eq!(
            got[1].rulings[1].comment, "Nonbasic lands lose their other land types and abilities.",
            "the text as written"
        );

        let seqs: Vec<i64> = {
            let conn = db.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT seq FROM rulings WHERE oracle_id = 'o-moon' ORDER BY seq")
                .unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.map(Result::unwrap).collect()
        };
        assert_eq!(seqs, [0, 1], "no gap where the repeat was");

        let status = read_status(&db.lock().unwrap(), 1_800_000_100);
        assert_eq!(status.ruling_count, Some(6));
        assert_eq!(status.card_count, Some(3));
        assert_eq!(status.ingested_at, Some(1_800_000_000));
        assert_eq!(status.checked_at, Some(1_800_000_000));
        assert_eq!(
            status.updated_at.as_deref(),
            Some("2026-11-25T10:00:33.479+00:00")
        );
        assert!(!status.stale);
        assert!(!staging_left(&db));
    }

    #[test]
    fn the_read_drops_blank_and_repeated_ids_and_answers_an_unknown_one_empty() {
        let db = mem_db();
        ingest(&db, &fixture()).unwrap();
        let got = read(&db, &["o-nothing", " ", "o-moon", "o-moon", ""]);
        let ids: Vec<&str> = got.iter().map(|c| c.oracle_id.as_str()).collect();
        assert_eq!(ids, ["o-nothing", "o-moon"]);
        assert!(got[0].rulings.is_empty(), "a card with none answers []");
        assert_eq!(got[1].rulings.len(), 2);
        assert!(read(&db, &[]).is_empty());
    }

    #[test]
    fn a_file_with_no_rulings_is_refused_and_keeps_the_previous_ones() {
        let db = mem_db();
        ingest(&db, &[ruling("o-keep", "2020-01-01", "Kept.")]).unwrap();

        let err = ingest(&db, &["not json".to_owned(), "{}".to_owned()]).unwrap_err();
        assert!(matches!(err, RulingError::Empty { skipped: 2 }), "{err}");
        assert_eq!(
            read(&db, &["o-keep"])[0].rulings.len(),
            1,
            "the old rows stay"
        );
        assert!(!staging_left(&db));
    }

    #[test]
    fn a_mostly_unusable_file_is_refused_and_keeps_the_previous_ones() {
        let db = mem_db();
        ingest(&db, &[ruling("o-keep", "2020-01-01", "Kept.")]).unwrap();

        let err = ingest(
            &db,
            &[
                ruling("o-new", "2021-01-01", "New."),
                "{}".to_owned(),
                "[]".to_owned(),
            ],
        )
        .unwrap_err();
        assert!(
            matches!(
                err,
                RulingError::MostlySkipped {
                    kept: 1,
                    skipped: 2
                }
            ),
            "{err}"
        );
        assert_eq!(read(&db, &["o-keep"])[0].rulings.len(), 1);
        assert!(read(&db, &["o-new"])[0].rulings.is_empty());
        assert!(!staging_left(&db));
        let status = read_status(&db.lock().unwrap(), 1_800_000_100);
        assert_eq!(status.ruling_count, Some(1), "nor did the watermark move");
    }

    #[test]
    fn a_second_ingest_replaces_the_first() {
        let db = mem_db();
        ingest(&db, &[ruling("o-old", "2020-01-01", "Old.")]).unwrap();
        ingest(&db, &[ruling("o-new", "2021-01-01", "New.")]).unwrap();
        assert!(read(&db, &["o-old"])[0].rulings.is_empty());
        assert_eq!(read(&db, &["o-new"])[0].rulings.len(), 1);
    }

    #[test]
    fn a_corpus_that_never_fetched_the_file_says_so() {
        let db = mem_db();
        let status = read_status(&db.lock().unwrap(), 1_800_000_000);
        assert_eq!(
            status,
            RulingStatus {
                updated_at: None,
                ingested_at: None,
                checked_at: None,
                ruling_count: None,
                card_count: None,
                stale: true,
                refreshing: status.refreshing,
            }
        );
        assert!(read(&db, &["o-bolt"])[0].rulings.is_empty());
    }

    // ---- refresh ------------------------------------------------------------------------

    /// The refreshes share the module's one claim, so they take turns.
    static REFRESHES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn gz_bytes(lines: &[String]) -> Vec<u8> {
        let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
        for l in lines {
            enc.write_all(l.as_bytes()).unwrap();
            enc.write_all(b"\n").unwrap();
        }
        enc.finish().unwrap()
    }

    fn descriptor<'a>(
        server: &'a httpmock::MockServer,
        updated_at: &str,
        size: u64,
        etag: &str,
    ) -> httpmock::Mock<'a> {
        use httpmock::prelude::*;
        let (updated_at, etag) = (updated_at.to_owned(), etag.to_owned());
        server.mock(|when, then| {
            when.method(GET)
                .path("/bulk-data/rulings")
                .header_missing("if-none-match");
            then.status(200)
                .header("etag", etag.as_str())
                .json_body(serde_json::json!({
                    "object": "bulk_data",
                    "type": "rulings",
                    "updated_at": updated_at,
                    "jsonl_download_uri": server.url("/rulings.jsonl.gz"),
                    "compressed_size": size
                }));
        })
    }

    fn file<'a>(server: &'a httpmock::MockServer, body: &[u8]) -> httpmock::Mock<'a> {
        use httpmock::prelude::*;
        let body = body.to_vec();
        server.mock(|when, then| {
            when.method(GET).path("/rulings.jsonl.gz");
            then.status(200).body(body.clone());
        })
    }

    fn logged(state: &State) -> i64 {
        state
            .lock_db()
            .query_row(
                "SELECT count(*) FROM error_log WHERE operation = ?1",
                [BULK_NAME],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[tokio::test]
    async fn a_refresh_checks_downloads_ingests_and_then_304s() {
        let _serial = REFRESHES.lock().await;
        use httpmock::prelude::*;
        let body = gz_bytes(&[
            ruling("o-saga", "2023-04-14", "First."),
            ruling("o-saga", "2023-05-01", "Second."),
        ]);
        let server = httpmock::MockServer::start_async().await;
        let got = file(&server, &body);
        descriptor(
            &server,
            "2026-11-25T10:00:33Z",
            body.len() as u64,
            "W/\"r1\"",
        );
        let not_modified = server.mock(|when, then| {
            when.method(GET)
                .path("/bulk-data/rulings")
                .header("if-none-match", "W/\"r1\"");
            then.status(304);
        });
        let (state, dir) = crate::state::fixtures::on_files("rulings-refresh", &server.base_url());

        let mut phases: Vec<String> = Vec::new();
        let first = refresh(&state, false, &mut |p, _, _| phases.push(p.to_owned()))
            .await
            .unwrap();
        assert_eq!(phases.first().map(String::as_str), Some("checking"));
        assert_eq!(phases.last().map(String::as_str), Some("done"));
        assert!(phases.iter().any(|p| p == "ingesting"), "{phases:?}");
        assert_eq!(first.ruling_count, Some(2));
        assert_eq!(first.card_count, Some(1));
        assert!(!first.stale);
        assert!(!first.refreshing, "the claim is let go");
        got.assert_calls(1);
        assert!(!temp_path(&state).exists(), "the download is removed");
        let read_back = rulings_for_cards(&state.lock_db(), &["o-saga".to_owned()]).unwrap();
        assert_eq!(read_back[0].rulings[1].comment, "Second.");

        // Inside the week, an unforced refresh asks nothing at all.
        let quiet = refresh(&state, false, &mut |_, _, _| {}).await.unwrap();
        assert_eq!(quiet.ingested_at, first.ingested_at);
        not_modified.assert_calls(0);
        assert!(!due_at_launch(&state, unix_now()));

        // Forced, the check is made and earns a 304: nothing is downloaded or rebuilt.
        let second = refresh(&state, true, &mut |_, _, _| {}).await.unwrap();
        not_modified.assert_calls(1);
        got.assert_calls(1);
        assert_eq!(second.ingested_at, first.ingested_at);
        assert_eq!(second.ruling_count, Some(2));

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A 200 for the very file held (a proxy that strips the ETag): nothing is downloaded, and
    /// the fresh ETag is stored so the next check can be a 304.
    #[tokio::test]
    async fn the_same_file_again_is_not_downloaded() {
        let _serial = REFRESHES.lock().await;
        let body = gz_bytes(&[ruling("o-saga", "2023-04-14", "First.")]);
        let server = httpmock::MockServer::start_async().await;
        let got = file(&server, &body);
        let (state, dir) = crate::state::fixtures::on_files("rulings-same", &server.base_url());
        ingest_gz(
            &state.db,
            &gz_fixture(&[&ruling("o-saga", "2023-04-14", "First.")]),
            &FileStamp {
                etag: None,
                updated_at: Some("2026-11-25T10:00:33Z".to_owned()),
            },
            1_700_000_000,
        )
        .unwrap();
        // The stored row carries no ETag, so the check is unconditional and answered 200.
        descriptor(
            &server,
            "2026-11-25T10:00:33Z",
            body.len() as u64,
            "W/\"r2\"",
        );

        let status = refresh(&state, true, &mut |_, _, _| {}).await.unwrap();
        got.assert_calls(0);
        assert_eq!(status.ingested_at, Some(1_700_000_000));
        let etag: Option<String> = state
            .lock_db()
            .query_row("SELECT etag FROM ruling_meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(etag.as_deref(), Some("W/\"r2\""));

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A body shorter than its manifest keeps the old rulings, is logged, and rests the feed
    /// for a day at launch.
    #[tokio::test]
    async fn a_short_download_keeps_the_old_rulings_and_rests_the_feed() {
        let _serial = REFRESHES.lock().await;
        let body = gz_bytes(&[ruling("o-new", "2023-04-14", "New.")]);
        let server = httpmock::MockServer::start_async().await;
        file(&server, &body);
        descriptor(
            &server,
            "2026-11-25T10:00:33Z",
            body.len() as u64 + 10,
            "W/\"r3\"",
        );
        let (state, dir) = crate::state::fixtures::on_files("rulings-short", &server.base_url());

        let err = refresh(&state, true, &mut |_, _, _| {}).await.unwrap_err();
        assert!(err.contains("expected"), "{err}");
        assert_eq!(logged(&state), 1);
        assert!(!due_at_launch(&state, unix_now()), "resting for a day");
        assert!(status_of(&state).ingested_at.is_none());

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A file that arrived whole and is not rulings is refused, logged, rests the feed, and
    /// leaves no download behind.
    #[tokio::test]
    async fn an_unusable_file_is_logged_and_rests_the_feed() {
        let _serial = REFRESHES.lock().await;
        let body = gz_bytes(&["<html>".to_owned()]);
        let server = httpmock::MockServer::start_async().await;
        file(&server, &body);
        descriptor(
            &server,
            "2026-11-25T10:00:33Z",
            body.len() as u64,
            "W/\"r4\"",
        );
        let (state, dir) = crate::state::fixtures::on_files("rulings-bad", &server.base_url());

        let err = refresh(&state, false, &mut |_, _, _| {}).await.unwrap_err();
        assert!(err.contains("no rulings found"), "{err}");
        assert_eq!(logged(&state), 1);
        assert!(!due_at_launch(&state, unix_now()));
        assert!(!temp_path(&state).exists());

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A 429 on the check is the application's lockout, and is written down for the next launch.
    #[tokio::test]
    async fn a_429_on_the_check_is_written_down() {
        let _serial = REFRESHES.lock().await;
        use httpmock::prelude::*;
        let server = httpmock::MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/bulk-data/rulings");
            then.status(429).header("retry-after", "45");
        });
        let (state, dir) = crate::state::fixtures::on_files("rulings-429", &server.base_url());

        let asked_at = crate::scryfall::unix_now();
        let err = refresh(&state, true, &mut |_, _, _| {}).await.unwrap_err();
        assert!(err.contains("rate limited"), "{err}");
        let stored: u64 =
            crate::app_meta::get_app_meta(&state.lock_db(), crate::sync::K_SCRYFALL_PENALTY_UNTIL)
                .and_then(|v| v.parse().ok())
                .expect("the lockout outlives the process");
        assert!(
            stored >= asked_at + 45,
            "{stored} covers the 45 s asked for"
        );
        assert_eq!(logged(&state), 1);

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_second_refresh_is_refused_while_one_runs() {
        let _serial = REFRESHES.lock().await;
        let (state, dir) = crate::state::fixtures::on_files("rulings-twice", "http://127.0.0.1:9");
        // The real name, which only these serialised tests may hold.
        let held = hold_refresh_for_test(BULK_NAME);
        assert!(any_refresh_running());
        assert!(status_of(&state).refreshing);
        let err = refresh(&state, true, &mut |_, _, _| {}).await.unwrap_err();
        assert_eq!(err, "Rulings are already being refreshed.");
        drop(held);
        assert!(!status_of(&state).refreshing);

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A host that keeps no files is refused before Scryfall is asked anything.
    #[tokio::test]
    async fn a_host_with_no_files_is_refused_before_any_request() {
        let _serial = REFRESHES.lock().await;
        let server = httpmock::MockServer::start_async().await;
        let check = descriptor(&server, "2026-11-25T10:00:33Z", 10, "W/\"r5\"");
        let (state, dir) = crate::state::fixtures::on_files("rulings-page", &server.base_url());

        let err = {
            let _page = crate::platform::host::emulate_page();
            refresh(&state, true, &mut |_, _, _| {}).await.unwrap_err()
        };
        assert_eq!(err, NO_FILES);
        check.assert_calls(0);

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
}
