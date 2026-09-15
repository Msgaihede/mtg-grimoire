//! `build-hashes` — build the reference bundle, repeatably.
//!
//! **This is a tool that gets re-run, not a script that was run once.** Magic releases a set
//! every few weeks, so regenerating the bundle is routine maintenance and the cost of a
//! re-run has to be proportional to what changed, not to the size of the corpus.
//!
//! That is what the sidecar cache is for, and its key is **the image URI, not a timestamp**.
//! Scryfall's image URLs carry a cache-buster (`…/0/0/<id>.webp?1783910776`) that equals the
//! printing's `image_updated_at`, so "are these bytes still current" is a string comparison —
//! the same rule `src-tauri/src/images.rs` already relies on. No clock, no mtime, nothing a
//! filesystem can round away. A newly released set costs a few hundred fetches; a full build
//! from empty costs 168,582.
//!
//! **The URI versions the image; it does not version the descriptor.** Those are two separate
//! questions and conflating them produced a wrong bundle in three seconds: after the hashing
//! changed, every row's URI still matched, the builder reported "113375 already current", and
//! it wrote a bundle stamped with the new format version and filled with descriptors computed
//! by the old one. Nothing downstream could have detected that — every read succeeds and every
//! answer is quietly a few bits wrong. So the hash cache is keyed on
//! `<kind>@<FORMAT_VERSION>`, and changing how the bits are computed invalidates the hashes
//! while leaving the cached *images* alone. That is what makes a descriptor change a four
//! minute local re-hash instead of another 4.5 GB download.
//!
//! ```text
//! # what a re-run would do, without doing it
//! build-hashes --corpus <corpus.db> --dry-run
//!
//! # the real thing, from the app's corpus
//! build-hashes --corpus <corpus.db> --out card-hashes.bin
//!
//! # or from Scryfall's default_cards file, which is what CI has instead of a corpus
//! build-hashes --bulk default-cards.jsonl --out card-hashes.bin --sections card
//! ```
//!
//! **Publishing is `.github/workflows/scanner-bundle.yml`'s job**, to the release
//! `scanner-bundle-v<FORMAT_VERSION>` as the asset `card-hashes.bin`, beside the two OCR models.
//! Release builds download all three from there and embed them.
//!
//! **`--bulk` reads what Scryfall serves, which is not what its name suggests.** The bulk-data
//! descriptor has carried `jsonl_download_uri` and no `download_uri` since 2026-07-20, and the
//! file behind it is gzipped JSON Lines — so the input is one card object per line once
//! gunzipped. A JSON array is still accepted, sniffed from the first byte. Either way the file
//! is streamed one card at a time: it is hundreds of megabytes, and nothing here holds it whole.
//!
//! **Every request carries a User-Agent.** `cards.scryfall.io` answers **HTTP 400** without
//! one — measured 2026-09-01 — and a 400 does not read like a policy refusal, so a build that
//! omitted it would look like 168,582 corrupt images rather than one missing header.

use card_scanner::hash::{hash_rgb, Descriptor, HashKind};
use card_scanner::index::{BundleBuilder, Section, ID_LEN};
use clap::{ArgGroup, Parser};
use rusqlite::{Connection, OpenFlags};
use serde::de::{self, SeqAccess, Visitor};
use serde::Deserializer as _;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Instant;

/// Identifies this tool to Scryfall. Their guidance asks for something specific rather than a
/// library default, so a problem can be traced back to a person.
const USER_AGENT: &str = "MTGGrimoire-card-scanner/0.1 (+https://github.com/Msgaihede/mtg-grimoire)";

#[derive(Parser, Debug)]
#[command(name = "build-hashes", about = "Build the card-scanner reference bundle")]
#[command(group(ArgGroup::new("source").required(true).args(["corpus", "bulk"])))]
struct Args {
    /// The app's `corpus.db`. Opened read-only and never written.
    #[arg(long)]
    corpus: Option<PathBuf>,
    /// Scryfall's `default_cards` bulk file, uncompressed: JSON Lines as Scryfall serves it, or a
    /// JSON array. Streamed, never read whole. The alternative to `--corpus` for a machine that
    /// has no app database, which is every CI runner.
    #[arg(long)]
    bulk: Option<PathBuf>,
    /// Sidecar holding one row per fetched image. Delete it to force a full rebuild.
    #[arg(long, default_value = "card-hashes-cache.db")]
    cache: PathBuf,
    /// Where to write the bundle. Skipped entirely with `--dry-run`.
    #[arg(long, default_value = "card-hashes-v1.bin")]
    out: PathBuf,

    #[arg(long, default_value = "dhash-chroma")]
    hash: HashArg,
    #[arg(long, default_value_t = 256)]
    bits: u16,

    /// Simultaneous fetches. `cards.scryfall.io` is documented as having no rate limit — the
    /// ≤10/s figure is `api.scryfall.com`'s — so this bounds *this* machine rather than
    /// Scryfall's patience. Sixteen is what the app's own image cache uses.
    #[arg(long, default_value_t = 16)]
    concurrency: usize,

    /// Stop after this many *new* fetches. For proving a run end to end without moving
    /// gigabytes.
    #[arg(long)]
    limit: Option<usize>,

    /// Report what a run would fetch, then stop.
    #[arg(long)]
    dry_run: bool,

    /// Which sections to build.
    #[arg(long, default_value = "both")]
    sections: SectionArg,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum HashArg {
    Dhash,
    Phash,
    DhashChroma,
    DhashChroma32,
}

#[derive(Clone, Copy, Debug, PartialEq, clap::ValueEnum)]
enum SectionArg {
    Card,
    Art,
    Both,
}

impl From<HashArg> for HashKind {
    fn from(h: HashArg) -> Self {
        match h {
            HashArg::Dhash => HashKind::DHash,
            HashArg::Phash => HashKind::PHash,
            HashArg::DhashChroma => HashKind::DHashChroma,
            HashArg::DhashChroma32 => HashKind::DHashChroma32,
        }
    }
}

/// One image that may need fetching.
#[derive(Debug, Clone)]
struct Job {
    section: Section,
    /// Raw 16-byte id — the printing's for [`Section::Card`], the illustration's for
    /// [`Section::Art`].
    id: [u8; ID_LEN],
    url: String,
}

fn parse_uuid(s: &str) -> Option<[u8; ID_LEN]> {
    card_scanner::index::parse_uuid(s)
}

/// One printing as the builder reads it: `(id, illustration_id, image_uris)`, the last as the
/// JSON text the app's `cards.image_uris` column holds. Both sources yield exactly this, so
/// nothing downstream of [`collect_jobs`] can tell which one a run was built from.
type Row = (String, Option<String>, String);

/// The corpus source: the query `build-hashes` has always run.
fn rows_from_corpus(corpus: &Connection) -> rusqlite::Result<Vec<Row>> {
    let mut stmt = corpus.prepare(
        "SELECT id, illustration_id, image_uris FROM cards
         WHERE image_uris IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    rows.collect()
}

/// The three fields of a Scryfall card object the bundle needs. Every other field is skipped
/// by the parser without being built.
#[derive(serde::Deserialize)]
struct BulkCard {
    id: String,
    illustration_id: Option<String>,
    image_uris: Option<serde_json::Value>,
}

impl BulkCard {
    /// `None` for a card with no top-level `image_uris` — a double-faced card keeps its images
    /// on `card_faces` — which is the row the corpus query's `IS NOT NULL` leaves out too: the
    /// app's ingest stores only the top-level object in that column.
    fn into_row(self) -> Option<Row> {
        let uris = self.image_uris?;
        Some((self.id, self.illustration_id, uris.to_string()))
    }
}

type BulkItem = Result<Row, serde_json::Error>;

const ROWS_DROPPED: &str = "the row reader was dropped";

/// The bulk source, streamed one card at a time.
///
/// **A thread, because serde's streaming reads are push-shaped and a caller wants to pull.**
/// A `SeqAccess` visitor is handed each array element and there is no way to suspend it
/// between two, so the parse runs on its own thread and sends rows down a bounded channel. The
/// bound is what keeps memory flat: the parser waits whenever the builder has not caught up.
fn rows_from_bulk<R: Read + Send + 'static>(reader: R) -> BulkRows {
    let (tx, rx) = mpsc::sync_channel(1024);
    let worker = std::thread::spawn(move || {
        if let Err(e) = read_bulk(BufReader::new(reader), &tx) {
            let _ = tx.send(Err(e));
        }
    });
    BulkRows { rx, worker: Some(worker) }
}

/// Parse `reader` as a JSON array or as JSON Lines, whichever its first byte says, and send
/// every card that has images.
fn read_bulk<R: BufRead>(
    mut reader: R,
    tx: &mpsc::SyncSender<BulkItem>,
) -> Result<(), serde_json::Error> {
    // Peek at the first byte that is not whitespace, consuming only the whitespace before it.
    let is_array = loop {
        let buf = reader.fill_buf().map_err(serde_json::Error::io)?;
        if buf.is_empty() {
            return Ok(());
        }
        match buf.iter().position(|b| !b.is_ascii_whitespace()) {
            Some(i) => {
                let first = buf[i];
                reader.consume(i);
                break first == b'[';
            }
            None => {
                let n = buf.len();
                reader.consume(n);
            }
        }
    };

    if is_array {
        let mut de = serde_json::Deserializer::from_reader(reader);
        (&mut de).deserialize_seq(Cards(tx))?;
        return de.end();
    }
    for card in serde_json::Deserializer::from_reader(reader).into_iter::<BulkCard>() {
        if let Some(row) = card?.into_row() {
            tx.send(Ok(row))
                .map_err(|_| <serde_json::Error as de::Error>::custom(ROWS_DROPPED))?;
        }
    }
    Ok(())
}

/// Deserializes one array element at a time and sends it on, so the array is never built.
struct Cards<'a>(&'a mpsc::SyncSender<BulkItem>);

impl<'de> Visitor<'de> for Cards<'_> {
    type Value = ();

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("an array of Scryfall card objects")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(card) = seq.next_element::<BulkCard>()? {
            if let Some(row) = card.into_row() {
                self.0.send(Ok(row)).map_err(|_| de::Error::custom(ROWS_DROPPED))?;
            }
        }
        Ok(())
    }
}

/// The receiving end of [`rows_from_bulk`].
struct BulkRows {
    rx: mpsc::Receiver<BulkItem>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Iterator for BulkRows {
    type Item = BulkItem;

    fn next(&mut self) -> Option<BulkItem> {
        if let Ok(item) = self.rx.recv() {
            return Some(item);
        }
        // **The channel closing is not proof the file ended.** A parser that panicked drops its
        // sender exactly as one that finished does, and reading that as the end would build and
        // publish a bundle missing every card after the panic.
        match self.worker.take()?.join() {
            Ok(()) => None,
            Err(_) => Some(Err(de::Error::custom("the bulk reader panicked"))),
        }
    }
}

/// Turn a source's rows into every (id, url) pair the bundle wants.
///
/// The art section is keyed by `illustration_id` and deduplicated here: 117,619 printings
/// share 50,963 artworks, so fetching per printing would move 2.3× the bytes for exactly the
/// same set of hashes.
fn collect_jobs<E>(
    rows: impl IntoIterator<Item = Result<Row, E>>,
    sections: SectionArg,
) -> Result<Vec<Job>, E> {
    let mut jobs = Vec::new();
    let mut seen_art = std::collections::HashSet::new();

    for row in rows {
        let (id, illustration_id, uris) = row?;
        let Ok(uris) = serde_json::from_str::<serde_json::Value>(&uris) else { continue };

        if matches!(sections, SectionArg::Card | SectionArg::Both) {
            // `thumb` — 146×204, ~8 KB, and a *whole card*. A perceptual hash downsamples to
            // 32×32 regardless, so this is already more resolution than the descriptor
            // consumes, and it needs no art window to be located.
            if let (Some(raw), Some(url)) = (parse_uuid(&id), uris["thumb"].as_str()) {
                jobs.push(Job { section: Section::Card, id: raw, url: url.to_string() });
            }
        }

        if matches!(sections, SectionArg::Art | SectionArg::Both) {
            if let (Some(ill), Some(url)) = (illustration_id.as_deref(), uris["art"].as_str()) {
                if let Some(raw) = parse_uuid(ill) {
                    if seen_art.insert(raw) {
                        jobs.push(Job { section: Section::Art, id: raw, url: url.to_string() });
                    }
                }
            }
        }
    }
    Ok(jobs)
}

fn open_cache(path: &PathBuf) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS hashes (
             section   TEXT NOT NULL,
             id        BLOB NOT NULL,
             algo      TEXT NOT NULL,
             bits      INTEGER NOT NULL,
             image_uri TEXT NOT NULL,
             hash      BLOB NOT NULL,
             PRIMARY KEY (section, id, algo, bits)
         ) WITHOUT ROWID;
         -- Rows that failed, so a re-run does not retry a permanent 404 every time. A
         -- transient failure is simply absent and will be retried.
         -- **The fetched bytes, keyed independently of the descriptor.** Changing the
         -- descriptor invalidates every hash but none of the images, and without this a
         -- descriptor experiment costs another 4.5 GB and half an hour. With it, a rebuild
         -- is a local re-hash. This is the whole reason the colour rebuild is the last full
         -- download rather than the second of many.
         CREATE TABLE IF NOT EXISTS images (
             section TEXT NOT NULL,
             id BLOB NOT NULL,
             image_uri TEXT NOT NULL,
             bytes BLOB NOT NULL,
             PRIMARY KEY (section, id)
         ) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS gone (
             section TEXT NOT NULL, id BLOB NOT NULL, status INTEGER NOT NULL,
             PRIMARY KEY (section, id)
         ) WITHOUT ROWID;",
    )?;
    Ok(conn)
}

enum Fetched {
    Ok { job: Job, descriptor: Descriptor, bytes: Option<Vec<u8>> },
    /// A definitive answer that there is no image — recorded so it is not retried.
    Gone { job: Job, status: u16 },
    /// Anything that might succeed later. Not recorded; simply absent.
    Transient { url: String, why: String },
}

/// Hash bytes that are already in hand — from the cache, or freshly fetched.
fn hash_bytes(_job: &Job, bytes: &[u8], kind: HashKind, bits: u16) -> Option<Descriptor> {
    let img = image::load_from_memory(bytes).ok()?;
    Some(hash_rgb(&img.to_rgb8(), kind, bits))
}

fn fetch_and_hash(job: &Job, kind: HashKind, bits: u16) -> Fetched {
    let mut last = String::new();
    // Three attempts with a widening pause. A 429 or a 5xx is worth retrying; a 404 is not,
    // and returns immediately below.
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(250 * (1 << attempt)));
        }
        match ureq::get(&job.url).header("User-Agent", USER_AGENT).call() {
            Ok(mut resp) => {
                let status = resp.status().as_u16();
                if status == 404 || status == 410 {
                    return Fetched::Gone { job: job.clone(), status };
                }
                if status != 200 {
                    last = format!("HTTP {status}");
                    continue;
                }
                match resp.body_mut().read_to_vec() {
                    Ok(bytes) => match image::load_from_memory(&bytes) {
                        Ok(img) => {
                            return Fetched::Ok {
                                job: job.clone(),
                                descriptor: hash_rgb(&img.to_rgb8(), kind, bits),
                                bytes: Some(bytes),
                            }
                        }
                        Err(e) => {
                            // A body that will not decode is not going to decode next time
                            // either, but it is also not a 404 — treat it as transient once
                            // and let the retry prove it.
                            last = format!("decode: {e}");
                        }
                    },
                    Err(e) => last = format!("read: {e}"),
                }
            }
            Err(ureq::Error::StatusCode(code)) => {
                if code == 404 || code == 410 {
                    return Fetched::Gone { job: job.clone(), status: code };
                }
                last = format!("HTTP {code}");
            }
            Err(e) => last = e.to_string(),
        }
    }
    Fetched::Transient { url: job.url.clone(), why: last }
}

/// Read whichever source was named into the jobs the bundle wants. The `source` group makes
/// clap require exactly one of the two, so this never sees neither or both.
fn read_jobs(args: &Args) -> Result<Vec<Job>, String> {
    if let Some(path) = &args.bulk {
        eprintln!("streaming {}…", path.display());
        let file = std::fs::File::open(path)
            .map_err(|e| format!("cannot open bulk file {}: {e}", path.display()))?;
        return collect_jobs(rows_from_bulk(file), args.sections)
            .map_err(|e| format!("cannot read bulk file {}: {e}", path.display()));
    }

    let path = args.corpus.as_ref().expect("clap requires --corpus or --bulk");
    if !path.exists() {
        return Err(format!("no corpus at {}", path.display()));
    }
    let corpus = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("cannot open corpus {}: {e}", path.display()))?;
    eprintln!("reading {}…", path.display());
    let rows = rows_from_corpus(&corpus).map_err(|e| format!("corpus query failed: {e}"))?;
    let rows = rows.into_iter().map(Ok::<_, std::convert::Infallible>);
    let Ok(jobs) = collect_jobs(rows, args.sections);
    Ok(jobs)
}

fn main() -> std::process::ExitCode {
    let args = Args::parse();
    if !matches!(args.bits, 128 | 256) {
        eprintln!("--bits must be 128 or 256, got {}", args.bits);
        return std::process::ExitCode::from(2);
    }
    let kind: HashKind = args.hash.into();
    // **The cache key carries the descriptor version, not just the kind's name.**
    //
    // Without it, changing how the bits are computed produces a bundle of *stale* descriptors
    // in three seconds flat and says "113375 already current" while doing it — the URI has not
    // changed, so every row still looks fresh, and the result is a bundle stamped with the new
    // version and filled with the old bits. That is the one failure the format version exists
    // to prevent, and keying the cache on anything less lets it through the back door.
    //
    // Sharing `FORMAT_VERSION` rather than inventing a second number means there is exactly
    // one thing to remember when the hashing changes.
    let algo = format!("{}@{}", kind.as_str(), card_scanner::index::FORMAT_VERSION);
    let algo = algo.as_str();

    let started = Instant::now();
    let jobs = match read_jobs(&args) {
        Ok(j) => j,
        Err(message) => {
            eprintln!("{message}");
            return std::process::ExitCode::from(1);
        }
    };
    let n_card = jobs.iter().filter(|j| j.section == Section::Card).count();
    let n_art = jobs.len() - n_card;
    eprintln!("  {n_card} printings, {n_art} artworks — {} images in the bundle", jobs.len());
    // **An empty source is a failure, not a small bundle.** The emit below keeps only ids the
    // source names, so a source naming none writes a valid, empty bundle — and CI would publish
    // it over the real one, leaving every release build a scanner that recognises nothing.
    if jobs.is_empty() {
        eprintln!("the source names no images; refusing to write an empty bundle");
        return std::process::ExitCode::from(1);
    }

    let mut cache = match open_cache(&args.cache) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cannot open cache {}: {e}", args.cache.display());
            return std::process::ExitCode::from(1);
        }
    };

    // What is already current? The URI *is* the version, so a row whose stored `image_uri`
    // still matches the corpus needs nothing.
    let mut have: std::collections::HashMap<(String, Vec<u8>), String> =
        std::collections::HashMap::new();
    {
        let mut stmt = cache
            .prepare("SELECT section, id, image_uri FROM hashes WHERE algo = ?1 AND bits = ?2")
            .expect("cache schema");
        let rows = stmt
            .query_map(rusqlite::params![algo, args.bits], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?, r.get::<_, String>(2)?))
            })
            .expect("cache read");
        for row in rows.flatten() {
            have.insert((row.0, row.1), row.2);
        }
    }
    let mut gone: std::collections::HashSet<(String, Vec<u8>)> = std::collections::HashSet::new();
    {
        let mut stmt = cache.prepare("SELECT section, id FROM gone").expect("cache schema");
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))
            .expect("cache read");
        for row in rows.flatten() {
            gone.insert(row);
        }
    }

    // Images already in hand for the current URI. Changing the descriptor invalidates every
    // hash and none of these, so a descriptor experiment costs a local re-hash rather than
    // another 4.5 GB.
    let mut cached_images: std::collections::HashMap<(String, Vec<u8>), String> =
        std::collections::HashMap::new();
    {
        let mut stmt = cache
            .prepare("SELECT section, id, image_uri FROM images")
            .expect("cache schema");
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?, r.get::<_, String>(2)?))
            })
            .expect("cache read");
        for row in rows.flatten() {
            cached_images.insert((row.0, row.1), row.2);
        }
    }

    let mut todo: Vec<Job> = jobs
        .iter()
        .filter(|j| {
            let key = (j.section.as_str().to_string(), j.id.to_vec());
            if gone.contains(&key) {
                return false;
            }
            have.get(&key).map(|uri| uri != &j.url).unwrap_or(true)
        })
        .cloned()
        .collect();

    // Anything whose bytes are cached at the current URI can be hashed without the network.
    let (local, remote): (Vec<Job>, Vec<Job>) = todo.into_iter().partition(|j| {
        cached_images
            .get(&(j.section.as_str().to_string(), j.id.to_vec()))
            .is_some_and(|uri| uri == &j.url)
    });
    todo = remote;

    eprintln!(
        "  {} already current, {} known missing, {} re-hashed from cached images, {} to fetch",
        have.len(),
        gone.len(),
        local.len(),
        todo.len()
    );

    if let Some(limit) = args.limit {
        todo.truncate(limit);
        eprintln!("  --limit {limit}: fetching {} of them", todo.len());
    }

    // ── Re-hash whatever is already on disk ───────────────────────────────────────
    if !local.is_empty() && !args.dry_run {
        let started_local = Instant::now();
        let mut done_local = 0usize;
        let total_local = local.len();
        for chunk in local.chunks(2000) {
            let mut rows = Vec::with_capacity(chunk.len());
            for job in chunk {
                let bytes: Option<Vec<u8>> = cache
                    .query_row(
                        "SELECT bytes FROM images WHERE section = ?1 AND id = ?2",
                        rusqlite::params![job.section.as_str(), &job.id[..]],
                        |r| r.get(0),
                    )
                    .ok();
                if let Some(b) = bytes {
                    if let Some(d) = hash_bytes(job, &b, kind, args.bits) {
                        rows.push((job.clone(), d));
                    }
                }
            }
            let tx = cache.transaction().expect("begin");
            for (job, d) in &rows {
                let _ = tx.execute(
                    "INSERT OR REPLACE INTO hashes (section, id, algo, bits, image_uri, hash)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![
                        job.section.as_str(),
                        &job.id[..],
                        algo,
                        args.bits,
                        job.url,
                        d.to_bytes()
                    ],
                );
            }
            let _ = tx.commit();
            done_local += chunk.len();
            eprintln!(
                "  re-hashed {done_local}/{total_local} from cache ({:.0}/s)",
                done_local as f64 / started_local.elapsed().as_secs_f64().max(0.001)
            );
        }
    }

    if args.dry_run {
        let bytes = todo
            .iter()
            .map(|j| if j.section == Section::Card { 8_000u64 } else { 70_000 })
            .sum::<u64>();
        eprintln!(
            "\ndry run: {} fetches, roughly {:.2} GB at the measured means (8 KB thumb, 70 KB art)",
            todo.len(),
            bytes as f64 / 1e9
        );
        return std::process::ExitCode::SUCCESS;
    }

    // ── Fetch ─────────────────────────────────────────────────────────────────────
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(args.concurrency.clamp(1, 64))
        .build()
        .expect("thread pool");

    let done = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    let total = todo.len();
    let results: Mutex<Vec<Fetched>> = Mutex::new(Vec::with_capacity(total.min(4096)));
    let cache = Mutex::new(cache);

    pool.install(|| {
        use rayon::prelude::*;
        todo.par_chunks(512).for_each(|chunk| {
            let batch: Vec<Fetched> =
                chunk.par_iter().map(|job| fetch_and_hash(job, kind, args.bits)).collect();

            // One writer at a time, one transaction per batch. SQLite has a single writer
            // and a transaction per row would dominate the whole run.
            let mut guard = cache.lock().expect("cache lock");
            let tx = guard.transaction().expect("begin");
            for r in &batch {
                match r {
                    Fetched::Ok { job, descriptor, bytes } => {
                        if let Some(raw) = bytes {
                            let _ = tx.execute(
                                "INSERT OR REPLACE INTO images (section, id, image_uri, bytes)
                                 VALUES (?1, ?2, ?3, ?4)",
                                rusqlite::params![
                                    job.section.as_str(),
                                    &job.id[..],
                                    job.url,
                                    raw
                                ],
                            );
                        }
                        let _ = tx.execute(
                            "INSERT OR REPLACE INTO hashes (section, id, algo, bits, image_uri, hash)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                            rusqlite::params![
                                job.section.as_str(),
                                &job.id[..],
                                algo,
                                args.bits,
                                job.url,
                                descriptor.to_bytes()
                            ],
                        );
                    }
                    Fetched::Gone { job, status } => {
                        let _ = tx.execute(
                            "INSERT OR REPLACE INTO gone (section, id, status) VALUES (?1, ?2, ?3)",
                            rusqlite::params![job.section.as_str(), &job.id[..], status],
                        );
                    }
                    Fetched::Transient { .. } => {
                        failed.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            let _ = tx.commit();
            drop(guard);

            let n = done.fetch_add(batch.len(), Ordering::Relaxed) + batch.len();
            let secs = started.elapsed().as_secs_f64().max(0.001);
            eprintln!(
                "  {n}/{total}  {:.0}/s  {:.0}s elapsed  {} failed",
                n as f64 / secs,
                secs,
                failed.load(Ordering::Relaxed)
            );
            results.lock().expect("results").extend(batch);
        });
    });

    let transient = results
        .into_inner()
        .expect("results")
        .into_iter()
        .filter_map(|r| match r {
            Fetched::Transient { url, why } => Some(format!("  {url} — {why}")),
            _ => None,
        })
        .collect::<Vec<_>>();
    if !transient.is_empty() {
        eprintln!(
            "\n{} fetches failed and were NOT recorded, so the next run retries them:",
            transient.len()
        );
        for line in transient.iter().take(10) {
            eprintln!("{line}");
        }
        if transient.len() > 10 {
            eprintln!("  …and {} more", transient.len() - 10);
        }
    }
    // **A run that lost more than a sliver of its fetches writes no bundle and fails.** A transient
    // failure is left out of the cache and so out of the bundle, and `scanner-bundle.yml` publishes
    // whatever this writes: an image host that fell over for ten minutes would otherwise ship a
    // bundle missing every card it could not reach, embedded by every release until next week.
    if too_many_transient(transient.len(), total) {
        eprintln!(
            "\n{} of {total} fetches failed transiently — more than {}% of the fetches attempted — \
             so no bundle was written. What did fetch is cached; a re-run retries only the rest.",
            transient.len(),
            MAX_TRANSIENT_PER_MILLE as f64 / 10.0
        );
        return std::process::ExitCode::from(1);
    }

    // ── Emit ──────────────────────────────────────────────────────────────────────
    let cache = cache.into_inner().expect("cache");
    let mut builder = BundleBuilder::new(kind, args.bits);
    // **Ordered, because CI decides whether to publish by comparing bundles byte for byte.**
    // `built_at` makes every header differ, so `scanner-bundle.yml` compares everything past
    // it — which only means "the same hashes" if the same hashes are always written in the same
    // order. It is the primary key's order, so this costs no sort.
    let mut stmt = cache
        .prepare(
            "SELECT section, id, hash FROM hashes WHERE algo = ?1 AND bits = ?2
             ORDER BY section, id",
        )
        .expect("cache schema");
    let rows = stmt
        .query_map(rusqlite::params![algo, args.bits], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?, r.get::<_, Vec<u8>>(2)?))
        })
        .expect("cache read");

    // Only ids the *current* corpus still names. A printing Scryfall withdrew stays in the
    // cache — re-fetching it later would be free — but must not reach the bundle.
    let wanted: std::collections::HashSet<(String, Vec<u8>)> = jobs
        .iter()
        .map(|j| (j.section.as_str().to_string(), j.id.to_vec()))
        .collect();

    let mut skipped = 0usize;
    for row in rows.flatten() {
        let (section, id, bytes) = row;
        if !wanted.contains(&(section.clone(), id.clone())) {
            skipped += 1;
            continue;
        }
        let (Some(descriptor), Ok(raw)) =
            (Descriptor::from_bytes(&bytes, args.bits), <[u8; ID_LEN]>::try_from(&id[..]))
        else {
            skipped += 1;
            continue;
        };
        let section = if section == "card" { Section::Card } else { Section::Art };
        builder.push(section, raw, &descriptor);
    }

    let built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let bundle = builder.finish(built_at);
    let bytes = bundle.to_bytes();

    if let Err(e) = std::fs::write(&args.out, &bytes) {
        eprintln!("cannot write {}: {e}", args.out.display());
        return std::process::ExitCode::from(1);
    }

    eprintln!(
        "\nwrote {} — {} card + {} art entries, {:.2} MB, {} algo at {} bits{}",
        args.out.display(),
        bundle.cards.len(),
        bundle.arts.len(),
        bytes.len() as f64 / 1e6,
        algo,
        args.bits,
        if skipped > 0 { format!(", {skipped} cached rows not in this corpus") } else { String::new() }
    );
    eprintln!("  in {:.0}s", started.elapsed().as_secs_f64());
    eprintln!(
        "\nrelease builds embed the asset card-hashes.bin from the release scanner-bundle-v{}, \
         which .github/workflows/scanner-bundle.yml publishes",
        card_scanner::index::FORMAT_VERSION
    );

    std::process::ExitCode::SUCCESS
}

/// How many transient fetch failures per thousand attempted a build tolerates: 0.5%.
///
/// A weekly run over a busy image host loses a handful to timeouts and retries them next week; a
/// run past this lost something bigger than a handful, and its bundle would be short by exactly
/// the cards it could not reach.
const MAX_TRANSIENT_PER_MILLE: usize = 5;

/// Did more than [`MAX_TRANSIENT_PER_MILLE`] of the `attempted` fetches fail transiently? Integer
/// arithmetic, so exactly 0.5% is still a build. Nothing attempted is never too many.
fn too_many_transient(failed: usize, attempted: usize) -> bool {
    failed * 1000 > attempted * MAX_TRANSIENT_PER_MILLE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn more_than_half_a_percent_of_transient_failures_fails_the_build() {
        assert!(!too_many_transient(0, 0), "a run that fetched nothing failed nothing");
        assert!(!too_many_transient(0, 113_375));
        assert!(!too_many_transient(5, 1_000), "exactly 0.5% is still a build");
        assert!(too_many_transient(6, 1_000));
        assert!(!too_many_transient(566, 113_375));
        assert!(too_many_transient(567, 113_375));
        assert!(too_many_transient(1, 100), "one of a new set's hundred is 1%");
        assert!(too_many_transient(1, 1));
    }

    #[test]
    fn a_bulk_file_yields_the_rows_the_corpus_query_does() {
        let json = r#"[
      {"id":"00000000-0000-0000-0000-000000000001","illustration_id":"00000000-0000-0000-0000-0000000000aa",
       "image_uris":{"small":"https://cards.scryfall.io/small/front/0/0/1.jpg?1"}},
      {"id":"00000000-0000-0000-0000-000000000002","card_faces":[{}]}
    ]"#;
        let rows: Vec<_> = rows_from_bulk(json.as_bytes()).collect::<Result<_, _>>().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "00000000-0000-0000-0000-000000000001");
        assert!(rows[0].2.contains("cards.scryfall.io/small"));
    }

    /// The shape Scryfall actually serves: its bulk descriptor has only a `jsonl_download_uri`,
    /// so a gunzipped `default_cards` is one object per line rather than an array.
    #[test]
    fn a_json_lines_bulk_file_yields_the_same_rows() {
        let jsonl = concat!(
            r#"{"id":"00000000-0000-0000-0000-000000000001","illustration_id":"00000000-0000-0000-0000-0000000000aa","image_uris":{"thumb":"https://cards.scryfall.io/thumb/front/0/0/1.webp?1"}}"#,
            "\n",
            r#"{"id":"00000000-0000-0000-0000-000000000002","card_faces":[{}]}"#,
            "\n",
            r#"{"id":"00000000-0000-0000-0000-000000000003","image_uris":{"thumb":"https://cards.scryfall.io/thumb/front/0/0/3.webp?1"}}"#,
            "\n",
        );
        let rows: Vec<_> = rows_from_bulk(jsonl.as_bytes()).collect::<Result<_, _>>().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].1.as_deref(), Some("00000000-0000-0000-0000-0000000000aa"));
        assert_eq!(rows[1].0, "00000000-0000-0000-0000-000000000003");
        assert_eq!(rows[1].1, None);

        let jobs = collect_jobs(rows.into_iter().map(Ok::<_, ()>), SectionArg::Card).unwrap();
        assert_eq!(jobs.len(), 2);
        assert!(jobs[1].url.ends_with("/3.webp?1"));
    }

    /// A download cut off mid-card must fail the build rather than yield the cards before the
    /// cut, which would build — and publish — a bundle quietly missing the rest.
    #[test]
    fn a_truncated_bulk_file_is_an_error_not_a_short_list() {
        let cut = r#"[{"id":"00000000-0000-0000-0000-000000000001","image_uris":{"thumb":"t"}},{"id":"000"#;
        let result: Result<Vec<_>, _> = rows_from_bulk(cut.as_bytes()).collect();
        assert!(result.is_err());

        let cut_lines = "{\"id\":\"00000000-0000-0000-0000-000000000001\",\"image_uris\":{\"thumb\":\"t\"}}\n{\"id\":";
        let result: Result<Vec<_>, _> = rows_from_bulk(cut_lines.as_bytes()).collect();
        assert!(result.is_err());
    }
}
