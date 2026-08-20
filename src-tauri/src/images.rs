//! The permanent, disposable image cache and the resolution rule behind it.
//!
//! Three rules run through everything here:
//!
//! * **Per face, never per card.** 3.7% of printings carry no top-level `image_uris` at
//!   all — `transform`, `modal_dfc`, `double_faced_token`, `art_series` and
//!   `reversible_card` put them on the faces instead — so a lookup is a
//!   `(card, face, variant)` triple and the front/back distinction is physical.
//! * **The URI is the version.** Scryfall's `?<epoch>` cache-buster equals
//!   `image_updated_at`, so "are these bytes current" is a string comparison against the
//!   URI they came from. No clock, no mtime, nothing a FAT32 stick can round away.
//!   The corollary is a rule in its own right: a URI with *no* cache-buster is one this
//!   cache must never hold, because bytes stored under it would answer "current" for the
//!   life of the installation ([`is_fetchable`]).
//! * **The cache is disposable.** `image_cache` records what was fetched; deleting
//!   `data/images` is always safe and costs only re-downloads (spec §8).

// `rate_limit_penalty` is the *API* client's clamp, imported rather than copied: the API's
// lockout and this cache's are separate deadlines over separate hosts, but they are one
// rule, and a second copy of a clamp is a second place for it to drift.
use crate::scryfall::{self, rate_limit_penalty, ScryfallError};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Images in flight at once — and the whole of the pacing, because there is deliberately
/// no interval between fetch *starts* any more.
///
/// `cards.scryfall.io` is documented as having **no** rate limit. The ≤10/s figure is
/// `api.scryfall.com`'s rule for "all other methods", and [`is_fetchable`] guarantees an
/// image can be fetched from nowhere but the CDN — so the 100 ms gate that used to sit here
/// was charging one origin's limit to another, and it was most of what made a cold grid
/// slow: six sequential images that owed the network almost nothing measured **554 ms**
/// under it, and 6 ms without.
///
/// What this number bounds is therefore *this machine* — sockets, worker threads, and the
/// memory of that many ~60 KB bodies in flight — rather than Scryfall's patience. Sixteen is
/// about two screenfuls of tiles arriving together. The 429 handling below is untouched and
/// is what still makes this safe if that assumption ever stops holding.
const MAX_CONCURRENT_FETCHES: usize = 16;

pub const WEBP: &str = "image/webp";
pub const SVG: &str = "image/svg+xml";

/// The image sizes this app stores. WEBP only — the JPG/PNG family Scryfall's own docs
/// mark as *replaced* is never fetched, and `png` alone would be 161 GB across the
/// library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Variant {
    Thumb,
    Grid,
    Display,
    Art,
}

impl Variant {
    /// The only way a string becomes a `Variant`.
    ///
    /// A security boundary as much as a policy one: the variant becomes a directory name
    /// under the data folder, and an unvalidated segment out of a URL is how `..` reaches
    /// a filesystem. Four literals in, nothing else out.
    pub fn parse(s: &str) -> Option<Variant> {
        match s {
            "thumb" => Some(Variant::Thumb),
            "grid" => Some(Variant::Grid),
            "display" => Some(Variant::Display),
            "art" => Some(Variant::Art),
            _ => None,
        }
    }

    /// The `image_uris` key, which is also the cache directory name.
    pub fn key(self) -> &'static str {
        match self {
            Variant::Thumb => "thumb",
            Variant::Grid => "grid",
            Variant::Display => "display",
            Variant::Art => "art",
        }
    }

    /// Documented pixel dimensions, so a placeholder occupies exactly the space the real
    /// image would have.
    pub fn dimensions(self) -> (u32, u32) {
        match self {
            Variant::Thumb => (146, 204),
            Variant::Grid => (488, 680),
            Variant::Display => (672, 936),
            Variant::Art => (626, 457),
        }
    }
}

/// One cacheable image: a printing, a physical face, a size.
///
/// `Hash`/`Eq` because it is also the key of [`Cache`]'s single-flight map: "the same
/// image" and "the same map entry" have to be the same question.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ImageKey {
    pub card_id: String,
    /// 0 = front. A face beyond what the card physically has resolves to a card back.
    pub face: u8,
    pub variant: Variant,
}

/// A Scryfall id: 36 characters of hex and dashes. Deliberately a charset check rather
/// than a UUID parse — the point is that no `/`, `\`, `.` or `%` can survive it, which is
/// a stronger and simpler claim than "is well-formed".
pub fn is_card_id(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// `images/<variant>/<id[0..2]>/<id>-<face>.webp`, exactly as spec §5 fixes it — or
/// `None` for an id that cannot be a Scryfall id.
///
/// `ImageKey` is built from a URL by the protocol handler, and both of its string-shaped
/// parts end up as path segments. `Variant` is four literals and cannot be anything else;
/// the id is checked here, so *there is no way to obtain a path* for `..` or an absolute
/// path — the refusal is in the return type rather than in a comment asking callers to be
/// careful.
pub fn cache_path(images_dir: &Path, key: &ImageKey) -> Option<PathBuf> {
    if !is_card_id(&key.card_id) {
        return None;
    }
    let shard: String = key.card_id.chars().take(2).collect();
    Some(
        images_dir
            .join(key.variant.key())
            .join(shard)
            .join(format!("{}-{}.webp", key.card_id, key.face)),
    )
}

/// Faces this app will serve. Every physical Magic card has at most two sides, and the
/// number goes into a file name — an unbounded one is an unbounded directory.
const MAX_FACE: u8 = 1;

/// `/<variant>/<card_id>/<face>` → a key, or `None`.
///
/// The path is attacker-controlled in the sense that matters — it comes out of a URL the
/// renderer builds and ends up as a filesystem path — so this validates rather than
/// sanitises: the variant must be one of four literals, the id must look like a Scryfall
/// UUID (hex and dashes, nothing else, so no separator survives in any encoding), and the
/// face must be a single digit within range. Anything else is refused, not repaired.
///
/// The leading slash is optional because the two platform URL forms differ in *origin*,
/// not in path (`http://mtgimg.localhost/…` on Windows, `mtgimg://localhost/…`
/// elsewhere) — a parser that insisted on one shape would be a parser that broke on the
/// other platform's first run.
pub fn parse_request_path(path: &str) -> Option<ImageKey> {
    let mut parts = path.trim_start_matches('/').split('/');
    let variant = Variant::parse(parts.next()?)?;
    let card_id = parts.next()?;
    let face: u8 = parts.next()?.parse().ok()?;
    // A fourth segment means the URL is not the one this app builds, and guessing at what
    // it meant is how a path traversal gets in.
    if parts.next().is_some() {
        return None;
    }
    if face > MAX_FACE || !is_card_id(card_id) {
        return None;
    }
    Some(ImageKey {
        card_id: card_id.to_owned(),
        face,
        variant,
    })
}

/// What a placeholder is standing in for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placeholder {
    /// Scryfall has no image for this printing — 162 of them in the live data.
    NoImage,
    /// A face this card does not physically have.
    CardBack,
}

/// Where an [`ImageKey`] points.
#[derive(Debug)]
pub enum Resolution {
    Uri(String),
    Missing(Placeholder),
    /// No row with that id. Distinct from `Missing` because it is a caller error rather
    /// than a gap in Scryfall's data, and it deserves a 404 rather than a picture.
    Unknown,
}

/// The only host this app will fetch a card image from.
///
/// The trailing slash is the entire check. `https://cards.scryfall.io.evil.test/…` and
/// `https://cards.scryfall.io@evil.test/…` both fail it, because the byte after the host
/// has to be the path separator — which is what makes a `starts_with` a host comparison
/// rather than a substring search.
const IMAGE_HOST: &str = "https://cards.scryfall.io/";

/// Does `uri` carry the `?<epoch>` cache-buster the whole invalidation rule stands on?
///
/// Digits, not merely a query string: `?<epoch>` is `image_updated_at`, and the point is
/// that it *moves* when Scryfall re-scans the card. A `?` followed by anything else is not
/// a version, it is punctuation.
fn has_cache_buster(uri: &str) -> bool {
    uri.split_once('?')
        .is_some_and(|(_, v)| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
}

/// Is this a URI worth fetching — and, more to the point, worth *keeping*?
///
/// Both halves answer a live defect rather than a hypothesis. Eight printings in the
/// current bulk data (`plst UMA-149`, `mic 55`–`58`, three more) publish
/// `https://errors.scryfall.com/soon.jpg` in all four `image_uris` slots: Scryfall's own
/// error page, as a JPEG, on a host that is not the image CDN, with nothing after it.
/// Fetched, those bytes would be written as `<id>-0.webp` and — because [`is_current`]
/// compares URIs and this URI can never change — served as that card's artwork forever.
/// No re-sync would clear it and no re-scan could, because there is nothing there to
/// re-scan. Deleting `data/images` would not even help: the next request would fetch the
/// same error page again.
///
/// So the version rule is the one that catches today's eight, and the host allowlist is
/// the belt for whatever the next placeholder host turns out to be.
///
/// Scryfall says the same thing in a second place — all eight carry `image_status`
/// `'missing'`, and the column is already on `cards` — but that is a *label* on the data
/// and this is a property of the URI itself: a versionless URI is uncacheable whatever any
/// status field claims, and it is the one of the two that cannot be wrong. `image_status`
/// is the right signal for the other half of spec §5, re-fetching when a picture improves
/// from `lowres`/`placeholder`, which is Plan-3 work.
fn is_fetchable(uri: &str) -> bool {
    // `cfg!` the macro, not the attribute: `is_image_host` stays compiled and directly
    // tested in both configurations rather than being swapped for something weaker. The
    // widening exists because the fetch tests below run against an `httpmock` server on
    // loopback, and it is the only seam in this predicate.
    has_cache_buster(uri) && (is_image_host(uri) || (cfg!(test) && is_loopback(uri)))
}

fn is_image_host(uri: &str) -> bool {
    uri.starts_with(IMAGE_HOST)
}

fn is_loopback(uri: &str) -> bool {
    uri.starts_with("http://127.0.0.1:") || uri.starts_with("http://localhost:")
}

/// The two columns a printing's picture can be in, for one variant and one face.
///
/// `(top_level, face)` — `image_uris` and `card_faces[face].image_uris`, spec §5's pair.
/// `None` for a card that is not in the corpus.
///
/// One function because two readers want the same row and apply **different policies** to it:
/// [`resolve`] falls back from face to top-level only for face 0 and then puts the answer
/// through [`is_fetchable`] and the cache-buster check, while
/// `card::card_image_uri_inner` pins the face to 0 and deliberately skips both fences. That
/// difference is real and stays; what may not differ is which two columns the picture lives
/// in, and this is now the one place that says so.
///
/// **Read-only by contract**, like [`resolve`]: every caller passes `db_read`.
#[allow(clippy::type_complexity)]
pub(crate) fn image_uri_row(
    conn: &Connection,
    card_id: &str,
    variant: &str,
    face: i64,
) -> Result<Option<(Option<String>, Option<String>)>, String> {
    conn.query_row(
        "SELECT json_extract(image_uris, '$.' || ?2),
                json_extract(face_image_uris, '$[' || ?3 || '].' || ?2)
         FROM cards WHERE id = ?1",
        params![card_id, variant, face],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Resolve a key against `cards`, applying spec §5's rule: `image_uris` if present, else
/// `card_faces[i].image_uris`.
///
/// **Read-only by contract.** Every caller passes the `db_read` connection: a card
/// picture must not queue behind an ingest — ~80 s of writing, in 2 000-row batches —
/// and it must never be the handle that takes a write lock.
pub fn resolve(conn: &Connection, key: &ImageKey) -> Result<Resolution, String> {
    let row = image_uri_row(conn, &key.card_id, key.variant.key(), key.face as i64)?;

    let Some((top, face)) = row else {
        return Ok(Resolution::Unknown);
    };
    // Face first for anything past the front: a transform's back exists only on the face,
    // and a `meld` card's top-level image is its front and nothing else. Falling back to
    // the top-level image for face 1 would show the front of the card on its own back.
    if let Some(uri) = face.or_else(|| (key.face == 0).then_some(top).flatten()) {
        // A URI this cache cannot version — or one from a host that does not serve card
        // art — is Scryfall saying "no image" in a shape that looks like a picture. It is
        // answered as the gap it is, here, before any of it reaches the network or the
        // disk. `NoImage` on either face: "Scryfall has no image for this" is exactly what
        // a `soon.jpg` means, and it stays true of a back face that never got scanned.
        return Ok(if is_fetchable(&uri) {
            Resolution::Uri(uri)
        } else {
            // Once per process, not once per tile: a CDN move would make this true of every
            // image in the app, and forty thousand identical lines is not a signal. The
            // version rule is the common case and is silent — a `soon.jpg` is Scryfall
            // saying "no image", which the placeholder already says. An *off-host* URI is
            // different: it means the allowlist and Scryfall's data no longer agree, and
            // the symptom (every card shows "No image") looks nothing like the cause.
            if !(is_image_host(&uri) || (cfg!(test) && is_loopback(&uri))) {
                static WARNED: AtomicBool = AtomicBool::new(false);
                if !WARNED.swap(true, Ordering::Relaxed) {
                    eprintln!(
                        "image cache: refusing an image URI from an unexpected host \
                         (expected {IMAGE_HOST}…): {uri}"
                    );
                }
            }
            Resolution::Missing(Placeholder::NoImage)
        });
    }
    Ok(Resolution::Missing(if key.face > 0 {
        Placeholder::CardBack
    } else {
        Placeholder::NoImage
    }))
}

/// Are the bytes on disk the ones `uri` names?
///
/// Compared against the URI the file was fetched from, cache-buster and all — so a
/// re-scan on Scryfall's side changes the URI and this answers false, with no timestamp
/// anywhere in the decision.
pub fn is_current(conn: &Connection, key: &ImageKey, uri: &str) -> bool {
    conn.query_row(
        "SELECT source_uri FROM image_cache WHERE card_id = ?1 AND face = ?2 AND variant = ?3",
        params![key.card_id, key.face as i64, key.variant.key()],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .is_some_and(|stored| stored == uri)
}

/// Record what was just written to disk. An upsert, because a re-fetch replaces a row.
///
/// **Write connection only.** `image_cache` is the one table this module writes, and it
/// writes it through `AppState.db` — the read handle is opened `SQLITE_OPEN_READ_ONLY`
/// and would refuse this outright.
pub fn record(conn: &Connection, key: &ImageKey, uri: &str, bytes: usize) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO image_cache (card_id, face, variant, source_uri, bytes, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())
         ON CONFLICT(card_id, face, variant) DO UPDATE SET
            source_uri = excluded.source_uri,
            bytes = excluded.bytes,
            fetched_at = excluded.fetched_at",
        params![
            key.card_id,
            key.face as i64,
            key.variant.key(),
            uri,
            bytes as i64
        ],
    )?;
    Ok(())
}

/// A placeholder, drawn rather than shipped.
///
/// SVG for three reasons: no binary asset and no WEBP encoder in the dependency tree, it
/// scales to whatever the tile is, and the colours can be the app's own rather than a
/// grey rectangle that reads as a broken image. It is emphatically *not* a Magic card
/// back — that artwork belongs to Wizards of the Coast, and the image policy is not a
/// thing to be clever about.
pub fn placeholder_svg(kind: Placeholder, variant: Variant) -> String {
    let (w, h) = variant.dimensions();
    let label = match kind {
        Placeholder::NoImage => "No image",
        Placeholder::CardBack => "Card back",
    };
    // Hex equivalents of --color-surface / --color-border / --color-muted, so a
    // placeholder sits in the grid instead of glowing out of it.
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w} {h}\" width=\"{w}\" \
         height=\"{h}\" role=\"img\" aria-label=\"{label}\">\
         <rect width=\"{w}\" height=\"{h}\" rx=\"{r}\" fill=\"#2b2b31\"/>\
         <rect x=\"8\" y=\"8\" width=\"{iw}\" height=\"{ih}\" rx=\"{ir}\" fill=\"none\" \
         stroke=\"#3f3f47\" stroke-width=\"4\"/>\
         <text x=\"50%\" y=\"50%\" fill=\"#8a8a93\" font-family=\"sans-serif\" \
         font-size=\"{fs}\" text-anchor=\"middle\" dominant-baseline=\"middle\">{label}</text>\
         </svg>",
        r = h / 24,
        ir = h / 32,
        iw = w - 16,
        ih = h - 16,
        fs = h / 18,
    )
}

/// What the protocol hands back.
pub struct Served {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

/// Written out rather than derived: a derived `Debug` on a 93 KB WEBP prints all 93 KB of
/// it into whatever log or panic message asked, and the useful facts are the two here.
impl std::fmt::Debug for Served {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Served")
            .field("content_type", &self.content_type)
            .field("bytes", &self.bytes.len())
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ImageError {
    #[error("no card with that id")]
    UnknownCard,
    /// The wait carried here is the *clamped* one (see [`rate_limit_penalty`]), because it
    /// is both what the gate honours and what the protocol puts in its `Retry-After`
    /// header. Telling the caller to come back sooner than the fetcher will let it is how
    /// a UI retries straight into a ban.
    #[error("rate limited by Scryfall; retry after {retry_after_secs}s")]
    RateLimited { retry_after_secs: u64 },
    #[error("could not fetch the image: {0}")]
    Fetch(String),
    /// A cache failure the request cannot be served around. Nothing produces it today —
    /// a fetch whose bytes could not be stored serves those bytes anyway and counts the
    /// failure ([`Cache::store_failures`]) — but it is part of the error surface the
    /// protocol maps, and cache *maintenance* (eviction, a rebuilt index) has nothing to
    /// hand back when the filesystem refuses.
    #[error("could not use the image cache: {0}")]
    Io(String),
    #[error("could not read the card database: {0}")]
    Db(String),
}

/// The on-disk image cache: lazy, permanent, paced.
pub struct Cache {
    dir: PathBuf,
    /// Caps images in flight. A grid that scrolls fast can queue hundreds of tiles.
    permits: tokio::sync::Semaphore,
    /// When the 429 penalty lifts. Scryfall's rate limit is per application, so a limit one
    /// request earns has to be paid by every request, not just that one.
    ///
    /// An instant in the past — the gate open — for the whole of a normal session: since the
    /// pacing interval went, this carries a penalty and nothing else.
    gate: tokio::sync::Mutex<tokio::time::Instant>,
    /// Images fetched but not stored. A read-only data directory or a full disk costs the
    /// user a slower grid rather than a blank one, which is right — but it is also
    /// invisible, and a number that only ever climbs is what makes it findable.
    store_failures: AtomicU64,
    /// One lock per key, so two callers who want the same image do not both fetch it.
    ///
    /// A `Mutex<HashMap<ImageKey, Arc<tokio::sync::Mutex<()>>>>` rather than the shared
    /// *future* the carryover sketched: a `Shared<BoxFuture<…>>` has to be `'static`, which
    /// would mean an `Arc<Cache>` plus owned clones of the client and both connections
    /// threaded through the protocol handler. The second caller here waits on the key,
    /// then re-reads the disk — a 2 ms read instead of a shared buffer, for a fraction of
    /// the surface, and the network saving is identical.
    inflight: Mutex<HashMap<ImageKey, Arc<tokio::sync::Mutex<()>>>>,
    /// Rows owed to `image_cache`: bytes that are **on disk** but that no row vouches for
    /// yet, because the write connection was busy at the moment they landed.
    ///
    /// This queue is what makes "store it once, load it from disk from then on" true. The
    /// bookkeeping row used to be written under a single `try_lock` and simply dropped when
    /// that failed — and it was never retried, so the file sat on disk unread and *every*
    /// later request for that key fetched it again, for the life of the installation. An
    /// ingest holds the write connection for all but the gaps between its 2 000-row batches,
    /// so the window is wide and a pre-warm running beside a sync lands squarely in it.
    ///
    /// Keyed by [`ImageKey`], so a key queued twice collapses to the newer URI rather than
    /// growing the map.
    pending: Mutex<HashMap<ImageKey, PendingRecord>>,
    /// Rows dropped because [`MAX_PENDING_RECORDS`] was already full. Same reasoning as
    /// [`Cache::store_failures`]: the cost is a re-fetch, and a number that only climbs is
    /// what makes an invisible degradation findable.
    dropped_records: AtomicU64,
}

/// What [`record`] needs, held until the write connection can take it.
#[derive(Debug, Clone)]
struct PendingRecord {
    uri: String,
    bytes: usize,
}

/// How many owed rows are held before the oldest are abandoned.
///
/// A bound rather than a budget: each entry is a key and a URI, so 4 096 of them is well
/// under a megabyte, and the queue only grows while the write connection is held — a
/// window measured in the gaps of one sync. If it ever fills, the app has a much larger
/// problem than a re-fetch, and dropping is still better than growing without limit.
const MAX_PENDING_RECORDS: usize = 4_096;

/// How long an image failure waits for the write connection before giving up on being
/// logged.
///
/// Short, because this runs on an async worker holding one of
/// [`MAX_CONCURRENT_FETCHES`]'s permits, and because the thing being recorded has already
/// happened. Long enough to ride out an ordinary write rather than losing the row to a
/// single unlucky microsecond — and the grain folds repeats, so a screenful of the same
/// failure needs only one of them to land.
const NOTE_LOCK_WAIT: Duration = Duration::from_millis(200);

impl Cache {
    pub fn new(images_dir: PathBuf) -> Cache {
        Cache {
            dir: images_dir,
            permits: tokio::sync::Semaphore::new(MAX_CONCURRENT_FETCHES),
            gate: tokio::sync::Mutex::new(tokio::time::Instant::now()),
            store_failures: AtomicU64::new(0),
            inflight: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            dropped_records: AtomicU64::new(0),
        }
    }

    /// Hold a row until the write connection is free.
    fn queue_record(&self, key: &ImageKey, uri: &str, bytes: usize) {
        let mut pending = crate::sync::lock_plain(&self.pending);
        if pending.len() >= MAX_PENDING_RECORDS && !pending.contains_key(key) {
            self.dropped_records.fetch_add(1, Ordering::Relaxed);
            return;
        }
        pending.insert(
            key.clone(),
            PendingRecord {
                uri: uri.to_owned(),
                bytes,
            },
        );
    }

    /// Write every owed row, if the write connection can be had within `wait`.
    ///
    /// Returns how many landed. Cheap to call speculatively: it takes the pending mutex,
    /// sees an empty map, and returns without going near the database — which is what lets
    /// every served image try to pay off the queue without any of them paying for the
    /// attempt.
    ///
    /// A row that fails to write individually is dropped rather than re-queued: the failure
    /// is then the database refusing this exact statement, which retrying will not fix.
    pub fn flush_records(&self, write: &Mutex<Connection>, wait: Duration) -> usize {
        if crate::sync::lock_plain(&self.pending).is_empty() {
            return 0;
        }
        let Some(conn) = crate::db::lock_for(write, wait) else {
            return 0;
        };
        // Drained only once the connection is in hand, so a failed lock leaves the queue
        // exactly as it was rather than losing it to a lock that never came.
        let owed: Vec<(ImageKey, PendingRecord)> =
            crate::sync::lock_plain(&self.pending).drain().collect();
        let mut written = 0usize;
        for (key, row) in owed {
            if record(&conn, &key, &row.uri, row.bytes).is_ok() {
                written += 1;
            }
        }
        written
    }

    /// How many owed rows are waiting for the write connection.
    pub fn pending_records(&self) -> usize {
        crate::sync::lock_plain(&self.pending).len()
    }

    /// How many owed rows were abandoned because the queue was full.
    pub fn dropped_records(&self) -> u64 {
        self.dropped_records.load(Ordering::Relaxed)
    }

    /// Write an image failure to the error log.
    ///
    /// Bounded and best-effort: this describes a failure on a path that is already returning
    /// an error, and a grid that could not *log* a dead host must not also stop drawing.
    /// A skipped row costs nothing — the grain folds repeats, and a host that is down will
    /// be back within a screenful.
    fn note(
        &self,
        write: &Mutex<Connection>,
        source: crate::errors::Source,
        operation: &str,
        err: &ImageError,
        detail: &str,
    ) {
        let kind = match err {
            ImageError::RateLimited { .. } => crate::errors::Kind::RateLimited,
            ImageError::Io(_) => crate::errors::Kind::Io,
            ImageError::Db(_) => crate::errors::Kind::Io,
            ImageError::UnknownCard => crate::errors::Kind::Other,
            // The fetch arm carries a `ScryfallError`'s message, and a timeout is the one
            // worth telling apart: it is what a dead or throttled host looks like from here,
            // and it is what the reader is trying to diagnose.
            ImageError::Fetch(m) if m.contains("timed out") => crate::errors::Kind::Timeout,
            ImageError::Fetch(_) => crate::errors::Kind::Http,
        };
        if let Some(conn) = crate::db::lock_for(write, NOTE_LOCK_WAIT) {
            crate::errors::record(
                &conn,
                source,
                operation,
                kind,
                &err.to_string(),
                Some(detail),
            );
        }
    }

    /// The lock for one key, created if this is the first caller to ask.
    fn key_lock(&self, key: &ImageKey) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = crate::sync::lock_plain(&self.inflight);
        Arc::clone(
            map.entry(key.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    /// Drop the entry once nobody is holding it. Without this the map is a leak with a
    /// pleasant name: one entry per image the app has ever served.
    ///
    /// Called only after this caller's own `Arc` has gone — a count of one then means the
    /// map is the last owner, and any caller still waiting on the key is holding a clone
    /// that keeps the entry (and therefore the coalescing) alive.
    fn release_key(&self, key: &ImageKey) {
        let mut map = crate::sync::lock_plain(&self.inflight);
        if map.get(key).is_some_and(|l| Arc::strong_count(l) == 1) {
            map.remove(key);
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// How many fetched images could not be written to the cache this session.
    pub fn store_failures(&self) -> u64 {
        self.store_failures.load(Ordering::Relaxed)
    }

    /// Bytes for `key`: from disk when they are current, else fetched, stored and served.
    ///
    /// `read` does all the reading; `write` is taken only for the bookkeeping row, only
    /// with a bound, and not at all on a cache hit.
    pub async fn get(
        &self,
        client: &scryfall::Client,
        read: &Mutex<Connection>,
        write: &Mutex<Connection>,
        key: &ImageKey,
    ) -> Result<Served, ImageError> {
        // First, before the database is even asked: an id that cannot be a Scryfall id
        // becomes a file name further down, and `..` is not something to look up.
        if !is_card_id(&key.card_id) {
            return Err(ImageError::UnknownCard);
        }

        let (uri, cached) = {
            // A short synchronous scope, closed before the first `.await` below: a
            // `MutexGuard` held across one would make this future `!Send` (the protocol
            // spawns it) and would hold the read connection open for a network fetch.
            let conn = crate::sync::lock_conn(read);
            match resolve(&conn, key).map_err(ImageError::Db)? {
                Resolution::Unknown => return Err(ImageError::UnknownCard),
                Resolution::Missing(kind) => {
                    return Ok(Served {
                        bytes: placeholder_svg(kind, key.variant).into_bytes(),
                        content_type: SVG,
                    })
                }
                Resolution::Uri(uri) => {
                    let current = is_current(&conn, key, &uri);
                    (uri, current)
                }
            }
        };

        // The guard above is what makes this infallible; the `Option` is the type system
        // carrying that guarantee instead of a comment claiming it.
        let Some(path) = cache_path(&self.dir, key) else {
            return Err(ImageError::UnknownCard);
        };
        if cached {
            // The row says these bytes are current; the *file* is the thing that can have
            // been deleted under us, and that is allowed — the cache is disposable, so a
            // missing file is a miss rather than an error.
            if let Ok(bytes) = tokio::fs::read(&path).await {
                // A hit is the likeliest moment for the write connection to be free, so it
                // is the best moment to pay off any rows owed from a busier one. Costs one
                // uncontended mutex when nothing is owed, which is almost always.
                self.flush_records(write, Duration::ZERO);
                return Ok(Served {
                    bytes,
                    content_type: WEBP,
                });
            }
        }

        // Single flight from here on: a tile and its own prefetch, or two prefetch loops
        // from two pages that landed together, ask for one key at the same instant. One of
        // them does the round trip and the others read what it wrote — when it managed to
        // write. See [`Cache::fetch_and_store`] for the two states in which it did not.
        let served = {
            let lock = self.key_lock(key);
            let _held = lock.lock().await;
            self.fetch_and_store(client, read, write, key, &uri, &path)
                .await
        };
        // After the block, never inside it: `lock` and its guard are both dropped at the
        // closing brace above, so a strong count of one here really does mean nobody else
        // is holding the key. Releasing while this caller still held its own `Arc` would
        // leave the entry in the map forever — the exact leak `release_key` exists to stop.
        self.release_key(key);
        served
    }

    /// The miss path, run under the key's lock: re-check, fetch, store, record.
    ///
    /// Everything that makes the *next* caller's re-check succeed happens in here — the
    /// bytes on disk and the row that vouches for them. Releasing the key after the fetch
    /// but before the store would wake the waiter into a cache that is still empty, which
    /// is the duplicate round trip this whole mechanism is for.
    ///
    /// **What "one fetch per key" is conditional on.** The waiter does not receive the
    /// winner's bytes; it re-reads the cache, and the cache is the pair (file, row). So the
    /// guarantee holds exactly when the winner leaves both behind.
    ///
    /// It used to fail in the common case, and permanently. The row was written under a
    /// single `try_lock` with [`Duration::ZERO`] and **dropped** when the write connection
    /// was busy — which during an ingest it is, for all but the gaps between its 2 000-row
    /// batches. That was justified here as costing "one extra request", and that was wrong:
    /// nothing ever retried the row, so the bytes sat on disk that `is_current` would never
    /// vouch for, and every later request for that key fetched it again for the life of the
    /// installation. A pre-warm running beside a sync landed squarely in that window.
    ///
    /// Now the row is *owed*: queued in [`Cache::pending`] and paid off by whichever later
    /// call finds the connection free. The zero-wait attempt is unchanged — parking a worker
    /// thread per image through an ingest is still the wrong trade — but losing the race no
    /// longer loses the row.
    ///
    /// One state still degrades to a second fetch, and honestly: the **store failed** — a
    /// read-only data directory, a full disk. Nothing is on disk to re-read and nothing may
    /// be recorded, so the waiter necessarily fetches. That is a storage problem wearing a
    /// network cost, it is counted in [`Cache::store_failures`], and it is now also written
    /// to the error log where somebody can see it.
    async fn fetch_and_store(
        &self,
        client: &scryfall::Client,
        read: &Mutex<Connection>,
        write: &Mutex<Connection>,
        key: &ImageKey,
        uri: &str,
        path: &Path,
    ) -> Result<Served, ImageError> {
        // Someone may have fetched exactly these bytes while this call was waiting for the
        // key. Asking the disk again is cheaper than asking Scryfall, and it is the whole
        // payoff of having waited — when there is a row to find. A miss here is not a bug:
        // it is a winner whose bookkeeping lost the race for the write connection, or whose
        // store failed, and the honest answer to both is to fetch.
        let fresh = {
            let conn = crate::sync::lock_conn(read);
            is_current(&conn, key, uri)
        };
        if fresh {
            if let Ok(bytes) = tokio::fs::read(path).await {
                return Ok(Served {
                    bytes,
                    content_type: WEBP,
                });
            }
        }

        let bytes = match self.fetch(client, uri).await {
            Ok(bytes) => bytes,
            Err(e) => {
                // Every one of these used to be invisible: an `<img>` fired `error`, the tile
                // drew its fallback, and nothing anywhere said why. The grain folds them, so
                // a host that is down is one row counting up rather than one row per tile —
                // which is the shape the path-MTU incident actually had.
                self.note(
                    write,
                    crate::errors::Source::ScryfallImage,
                    "image_fetch",
                    &e,
                    uri,
                );
                return Err(e);
            }
        };

        match store(path, &bytes).await {
            // Bookkeeping last, and **owed rather than optional**. The row is what
            // `is_current` reads, so bytes on disk with no row are bytes nothing will ever
            // serve: the file is re-fetched on every later request, forever. Queue it, then
            // try to pay the whole queue off without waiting — a contended write connection
            // means an ingest, and parking a worker thread per image through one is still
            // the wrong trade. What changed is that losing the race no longer loses the row.
            Ok(()) => {
                self.queue_record(key, uri, bytes.len());
                self.flush_records(write, Duration::ZERO);
            }
            // A cache that cannot be written is still a cache that can serve *this*
            // request: the bytes are already in hand, and refusing them because the data
            // directory is read-only or the disk is full would turn a storage problem into
            // a blank grid. Counted and printed, never returned — and emphatically not
            // recorded, because a row here would vouch for bytes that are not there.
            Err(e) => {
                self.store_failures.fetch_add(1, Ordering::Relaxed);
                eprintln!("image cache: could not store {}: {e}", path.display());
                // A read-only data folder or a full disk. The images still *display* — the
                // bytes are in hand — so the only symptom is a grid that re-downloads itself
                // forever, which is precisely the kind of thing that needs somewhere to be
                // said out loud.
                self.note(
                    write,
                    crate::errors::Source::ImageStore,
                    "image_store",
                    &ImageError::Io(e.to_string()),
                    &path.display().to_string(),
                );
            }
        }
        Ok(Served {
            bytes,
            content_type: WEBP,
        })
    }

    /// One fetch: a permit, a glance at the penalty gate, then the request.
    ///
    /// The gate is a **deadline, not a queue**, and it holds nothing at all unless some
    /// other tile has earned a 429 — the routine pacing that used to share it is gone with
    /// [`MAX_CONCURRENT_FETCHES`]'s note. Standing in line for a penalty would be wrong
    /// twice over: the request would occupy a worker thread and a permit for up to five
    /// minutes, and a *second* rate limit could not even report itself until the first
    /// sleeper woke. So a penalty is answered rather than waited on — "not now, in N
    /// seconds" is a complete answer, and the protocol turns it into a 503 with a
    /// `Retry-After` the UI can act on.
    async fn fetch(&self, client: &scryfall::Client, uri: &str) -> Result<Vec<u8>, ImageError> {
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|e| ImageError::Fetch(e.to_string()))?;
        {
            let next = self.gate.lock().await;
            let remaining = next.saturating_duration_since(tokio::time::Instant::now());
            if !remaining.is_zero() {
                return Err(ImageError::RateLimited {
                    retry_after_secs: secs_rounded_up(remaining),
                });
            }
        }

        match client.fetch_image(uri).await {
            Ok(bytes) => Ok(bytes),
            Err(ScryfallError::RateLimited { retry_after_secs }) => {
                // The penalty is per application, so it applies to everyone: push the
                // gate out so no other tile even starts until the window has passed.
                let penalty = rate_limit_penalty(retry_after_secs);
                self.penalise(penalty).await;
                Err(ImageError::RateLimited {
                    retry_after_secs: penalty.as_secs(),
                })
            }
            // A 404 for a URI Scryfall itself published. Nothing to retry, but nothing
            // worth caching either — it is rare enough to simply report.
            Err(ScryfallError::NotFound) => Err(ImageError::Fetch("image not found".into())),
            Err(e) => Err(ImageError::Fetch(e.to_string())),
        }
    }

    /// Charge a rate limit to the gate every later fetch has to pass.
    ///
    /// `max`, never assignment: two tiles hitting the same 429 window can come back with
    /// different `Retry-After` values, and the shorter one arriving second must not
    /// release the app from the longer lockout that is already in force.
    async fn penalise(&self, penalty: Duration) {
        let mut next = self.gate.lock().await;
        *next = (*next).max(tokio::time::Instant::now() + penalty);
    }
}

/// How long the webview may keep an image it has been given.
///
/// A day, not a year: the URL is stable across Scryfall re-scanning a card, so an
/// immutable cache would pin a superseded picture inside the webview until the app is
/// reinstalled. A day of staleness after a re-scan is invisible; being asked again for
/// every tile that scrolls past is not.
const IMAGE_MAX_AGE: &str = "max-age=86400";

/// The HTTP answer for one resolved request.
///
/// Separated from [`serve`] because this is the whole contract with the renderer and it is
/// pure — `serve` itself needs a running Tauri app, and a contract that can only be
/// exercised by launching one is a contract nothing checks.
///
/// The distinction that matters is permanent-versus-retryable. A printing Scryfall has no
/// art for is a **200** with a placeholder, because there is nothing to retry; a failed
/// fetch is a **502**, and a rate limit a **503** carrying the wait, so the `<img>` can
/// report an error and the grid can heal itself. Serving a placeholder for a network
/// failure would quietly turn a temporary outage into a permanently artless collection.
fn respond(result: Result<Served, ImageError>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};

    match result {
        Ok(served) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, served.content_type)
            // A placeholder is the one 200 whose content is *meant* to change. It stands in
            // for a picture the next sync may well supply — Scryfall scans a card and the
            // `soon.jpg` becomes real art — and there is no URI change to notice it by,
            // because the placeholder was never fetched from a URI at all. Real bytes keep
            // their day: their URI *is* their version, so their staleness is bounded by the
            // re-scan that ended it.
            .header(
                header::CACHE_CONTROL,
                if served.content_type == SVG {
                    "no-store"
                } else {
                    IMAGE_MAX_AGE
                },
            )
            .body(served.bytes)
            .expect("image response"),
        Err(ImageError::UnknownCard) => fail(StatusCode::NOT_FOUND, "no such card", None),
        Err(ImageError::RateLimited { retry_after_secs }) => fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "rate limited by Scryfall",
            Some(retry_after_secs),
        ),
        Err(e) => fail(StatusCode::BAD_GATEWAY, &e.to_string(), None),
    }
}

/// A failure, as the webview sees it.
///
/// `no-store` on every one of them. A 404 is *heuristically* cacheable, and the card
/// behind one can arrive in the next sync — a cached 404 would outlive the thing it was
/// true about, with no way to invalidate it short of restarting the app. The same applies
/// to a 503 the whole design expects to be retried.
fn fail(
    status: tauri::http::StatusCode,
    message: &str,
    retry_after: Option<u64>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response};

    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain;charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store");
    if let Some(secs) = retry_after {
        builder = builder.header(header::RETRY_AFTER, secs.to_string());
    }
    builder
        .body(message.as_bytes().to_vec())
        .expect("static response")
}

/// The answer for a request that arrives before `setup` has managed the state.
///
/// The webview and the app's own startup genuinely race at launch, so this is a real
/// state rather than a defensive impossibility — and a retryable one, in about the time
/// it takes to read the header.
fn not_ready() -> tauri::http::Response<Vec<u8>> {
    fail(
        tauri::http::StatusCode::SERVICE_UNAVAILABLE,
        "app is still starting",
        Some(1),
    )
}

/// Answer one `mtgimg://` request.
///
/// Only the *path* is ever read: on Windows the origin is `http://mtgimg.localhost/…` and
/// elsewhere `mtgimg://localhost/…`, so a handler that looked at the host would be a
/// handler that worked on exactly one platform.
///
/// **Two routes**, and the cover one is tried first because it is the narrower shape: a card
/// image is `/<variant>/<card id>/<face>` over the four [`Variant`] words, a deck cover is
/// `/cover/<deck id>`, and `cover` is not a variant so the two can never both match.
pub async fn serve(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::Manager;

    if let Some(deck_id) = parse_cover_path(path) {
        return serve_cover(app, deck_id).await;
    }
    let Some(key) = parse_request_path(path) else {
        return fail(
            tauri::http::StatusCode::NOT_FOUND,
            "not an image request",
            None,
        );
    };
    let Some(state) = app.try_state::<std::sync::Arc<crate::sync::AppState>>() else {
        return not_ready();
    };

    respond(
        state
            .images
            .get(&state.client, &state.db_read, &state.db, &key)
            .await,
    )
}

// ---------------------------------------------------------------------------------------
// Deck covers
// ---------------------------------------------------------------------------------------

/// The first path segment of the fifth route, beside the four [`crate::schema::IMAGE_VARIANTS`].
///
/// A **path** on the origin the app already has, not an origin of its own, and that is the
/// whole design: `app.security.csp` names `mtgimg:` and `http://mtgimg.localhost` and needs no
/// edit to carry this — see `the_shipped_csp_is_untouched`. A cover served from any other
/// scheme would be a new CSP source, and a new CSP source is the one change in this app that
/// nothing else can fail to notice.
///
/// It cannot collide with a variant: [`Variant::parse`] answers `None` for `"cover"`, so a
/// request is one route or the other and never ambiguous.
pub const COVER_ROUTE: &str = "cover";

/// The shape a custom cover is stored at, and why it is that shape.
///
/// [`Variant::Art`] is Scryfall's **art crop** — 626×457, the picture without the printed frame
/// — which is what every deck tile in the app already draws for a card cover. Storing a custom
/// cover at the same dimensions is what makes the two interchangeable: one tile, one aspect
/// ratio, no layout that shifts depending on which kind of cover a deck happens to have.
pub const COVER_VARIANT: Variant = Variant::Art;

/// `/cover/<deckId>` → the deck id, or `None` for anything else.
///
/// Validated rather than sanitised, exactly as [`parse_request_path`] is and for the same
/// reason: the id becomes a **file name** under the data directory. Parsing it as an `i64` is
/// the whole fence — no `.`, no `/`, no `%2e` survives `str::parse`, so there is no way to
/// obtain a path for `..` or for an absolute path. `decks.id` is `INTEGER PRIMARY KEY`, so a
/// non-positive id names no deck and is refused here rather than reaching the filesystem as
/// `-1.webp`.
pub fn parse_cover_path(path: &str) -> Option<i64> {
    let mut parts = path.trim_start_matches('/').split('/');
    if parts.next()? != COVER_ROUTE {
        return None;
    }
    let deck_id: i64 = parts.next()?.parse().ok()?;
    // A third segment means the URL is not the one this app builds, and guessing at what it
    // meant is how a path traversal gets in.
    if parts.next().is_some() {
        return None;
    }
    (deck_id > 0).then_some(deck_id)
}

/// Where one deck's cover lives, whether or not anything is there.
pub fn cover_file(covers: &std::path::Path, deck_id: i64) -> PathBuf {
    covers.join(format!("{deck_id}.webp"))
}

/// The HTTP answer for a cover request. Separated from [`serve_cover`] for [`respond`]'s
/// reason: this is the whole contract with the renderer and it is pure, while `serve_cover`
/// needs a running Tauri app.
///
/// **`no-store`, and it is the one image in this app that has to be.** Every other 200 here is
/// bytes whose URI *is* their version — Scryfall's `?<epoch>` cache-buster moves when the art
/// is re-scanned, so a day of caching is bounded by the thing that ended it. A cover has a
/// stable URL by construction (`/cover/<deckId>` is the deck, not the picture) and its bytes
/// are *meant* to change under it: the user picks a new file and the same URL must answer with
/// it. Anything cacheable here is a deck showing its old cover until the app is restarted.
///
/// **A missing file is a 404, never a placeholder.** A deck with no custom cover falls back to
/// its card art in the webview, and a placeholder served here would hide that fallback behind
/// a grey rectangle — the picture the deck *does* have would never be drawn.
pub fn cover_response(bytes: Option<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};

    match bytes {
        Some(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, WEBP)
            .header(header::CACHE_CONTROL, "no-store")
            .body(bytes)
            .expect("cover response"),
        None => fail(StatusCode::NOT_FOUND, "no cover image", None),
    }
}

/// Read one deck's cover off disk and answer it.
///
/// A covers directory that cannot even be resolved is the same answer as an empty one: there
/// is no cover, and the deck draws its card art. That is a deliberate flattening — the two
/// causes (no data directory yet, no file) differ to nobody looking at a tile, and the honest
/// alternative would be a 502 that makes a deck with no custom cover look broken.
async fn serve_cover(app: &tauri::AppHandle, deck_id: i64) -> tauri::http::Response<Vec<u8>> {
    let bytes = match crate::paths::covers_dir(app) {
        Ok(covers) => tokio::fs::read(cover_file(&covers, deck_id)).await.ok(),
        Err(_) => None,
    };
    cover_response(bytes)
}

/// Largest source image a cover may be decoded from, **in total pixels**.
///
/// Not a policy about photographs — it is the memory bound, and it has to be a *product*
/// rather than a per-side cap. `image` allocates the whole decoded buffer, at least four bytes
/// a pixel, before anything is resized, and this limit used to be twenty thousand *a side*:
/// 20 000 × 20 000 was inside it, which is the 1.6 GB allocation the comment named as the
/// cliff it meant to stay short of. A portable app that OOMs because someone picked a scanned
/// poster is an app that lost their session.
///
/// A hundred megapixels is **400 MB** decoded at 8-bit RGBA — past every consumer camera made,
/// the 100 MP medium-format backs included, and a quarter of that cliff. A phone's 200 MP mode
/// is refused in a sentence, which is what a user is owed instead.
///
/// **It is checked against the file's own header before a pixel is decoded**, because that is
/// the only strict fence there is: `image` documents `max_image_width`/`max_image_height` as
/// strict and `max_alloc` as "non-strict by default and some decoders may ignore it", so a
/// budget expressed only through `Limits` would be advice. `max_alloc` is set from the same
/// number anyway, as the second fence for a header that lied.
pub(crate) const MAX_COVER_SOURCE_PIXELS: u64 = 100_000_000;

/// Decode whatever the user picked and re-encode it as this app's cover shape.
///
/// **The format is guessed from the file's own bytes, never from its extension** — a `.png`
/// that is really a JPEG is a thing that happens to real files, and an extension is not
/// evidence. `with_guessed_format` reads the magic number.
///
/// `resize_to_fill` rather than `resize`: a cover fills a tile, so the picture is scaled to
/// cover 626×457 and centre-cropped rather than letterboxed into it. Lanczos3 because this
/// runs once per cover and the result is looked at for as long as the deck exists.
///
/// Converted to RGBA8 before encoding, which is not a detail: `image-webp`'s encoder takes
/// 8-bit RGB or RGBA and nothing else, so a 16-bit PNG — which is what half the art sites
/// serve — would otherwise fail at the last step with an "unsupported color type" a user could
/// do nothing about. Alpha is **kept** rather than flattened, because dropping the channel
/// composites a transparent pixel onto whatever its RGB happened to be, which is usually black.
///
/// The encoding is lossless (that is the whole of `image-webp`'s encoder), so a photographic
/// cover lands larger than a lossy WEBP of the same picture would. It is one file per deck at
/// a fixed 626×457, which is a few hundred kilobytes — the trade is a pure-Rust encoder in a
/// portable app against a native `libwebp` build, and the file count here is the number of
/// decks a person has.
pub fn encode_cover(source: &std::path::Path) -> Result<Vec<u8>, String> {
    let (width, height) = COVER_VARIANT.dimensions();
    let open = || {
        image::ImageReader::open(source)
            .map_err(|e| format!("could not open {}: {e}", source.display()))?
            .with_guessed_format()
            .map_err(|e| format!("could not read {}: {e}", source.display()))
    };
    // The header on a pass of its own, before anything is decoded. `into_dimensions` consumes
    // the reader, hence the second open — two header reads of a local file against the one
    // strict way to bound [`MAX_COVER_SOURCE_PIXELS`] as a product.
    let (w, h) = open()?.into_dimensions().map_err(|e| {
        format!(
            "{} is not an image this app can read: {e}",
            source.display()
        )
    })?;
    if u64::from(w) * u64::from(h) > MAX_COVER_SOURCE_PIXELS {
        return Err(format!(
            "{} is {w} × {h}, which is too large a picture to make a deck cover from.",
            source.display()
        ));
    }
    let mut reader = open()?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_COVER_SOURCE_PIXELS * 4);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|e| {
        format!(
            "{} is not an image this app can read: {e}",
            source.display()
        )
    })?;
    let filled = decoded
        .resize_to_fill(width, height, image::imageops::FilterType::Lanczos3)
        .to_rgba8();
    let mut out = Vec::new();
    filled
        .write_to(
            &mut std::io::Cursor::new(&mut out),
            image::ImageFormat::WebP,
        )
        .map_err(|e| format!("could not encode the cover image: {e}"))?;
    Ok(out)
}

/// Write one deck's cover, replacing whatever was there.
pub fn write_cover(covers: &std::path::Path, deck_id: i64, bytes: &[u8]) -> Result<(), String> {
    let path = cover_file(covers, deck_id);
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Delete one deck's cover. **Best-effort**: a file that is not there is a success, and a
/// failure is the caller's to log rather than to fail on — a deck the user deleted is deleted
/// whatever the disk says about a picture of it.
pub fn remove_cover(covers: &std::path::Path, deck_id: i64) -> std::io::Result<()> {
    match std::fs::remove_file(cover_file(covers, deck_id)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Give one deck a copy of another's cover file.
///
/// **A missing source is an error here, unlike in [`remove_cover`]**, and the asymmetry is the
/// point: a delete that finds nothing already has what it wanted, while a copy that finds
/// nothing has produced nothing — and its caller ([`crate::deck::duplicate_deck`]) has to know,
/// because the copy is carrying a `cover_kind` of `custom` that only this file can honour.
pub fn copy_cover(covers: &std::path::Path, from: i64, to: i64) -> std::io::Result<()> {
    std::fs::copy(cover_file(covers, from), cover_file(covers, to)).map(|_| ())
}

/// Images **one** prefetch call will warm — two pages of results.
///
/// A bound on the call, not on the app: nothing stops several of these loops running at
/// once, and a fast scroll can start one per page that lands. That is survivable rather
/// than designed — every loop still goes through the same semaphore, so concurrent loops
/// share one budget instead of multiplying it, and [`Cache`]'s single-flight map means two
/// loops that overlap on a key cost one round trip rather than two. What they still cost is
/// *ordering*: a later page's warm-up interleaves with an earlier one's.
const MAX_PREFETCH: usize = 100;

/// The keys a prefetch request turns into, validated exactly as a protocol request is,
/// **in reading order**.
///
/// The order is the whole point, and it turned over when [`Cache`]'s single-flight map
/// landed. This list used to be walked backwards, on the reasoning that the grid mounts the
/// head of a page as tiles the instant it arrives and "nothing dedups a fetch that is
/// already in flight" — so a prefetch starting at index 0 would ask Scryfall for the same
/// bytes a second time, against the tile the reader is staring at.
///
/// That premise is false now: two callers who want one key meet on its lock, and the second
/// re-reads what the first wrote. Colliding at the head is the *good* case — it is a wait on
/// a request already in flight rather than a second round trip. Walking backwards, on the
/// other hand, spends the whole permit budget on cards fifty rows below the fold while the
/// reader waits on the ones in front of them. So: first card first.
pub fn prefetch_keys(card_ids: &[String], variant: Variant) -> Vec<ImageKey> {
    card_ids
        .iter()
        .filter(|id| is_card_id(id))
        // Front faces only: the back of a double-faced card is not on screen until
        // someone opens the detail pane and flips it.
        .map(|id| ImageKey {
            card_id: id.clone(),
            face: 0,
            variant,
        })
        // The head of what was sent — the page the reader is on — never the tail of a long
        // list, which is nowhere near it.
        .take(MAX_PREFETCH)
        .collect()
}

/// Warm the cache for a page of results.
///
/// Returns as soon as the work is queued rather than when it is done: nothing is waiting
/// on the answer, and a command that took the length of 100 downloads to resolve would be
/// a command the UI has to manage. Failures are silent for the same reason — an image
/// that did not prefetch is an image that fetches when it is rendered.
#[tauri::command]
pub async fn prefetch_images(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    card_ids: Vec<String>,
    variant: String,
) -> Result<(), String> {
    let Some(variant) = Variant::parse(&variant) else {
        return Err(format!("unknown image variant: {variant}"));
    };
    let state = state.inner().clone();
    let keys = prefetch_keys(&card_ids, variant);
    tauri::async_runtime::spawn(async move {
        warm(
            &state.images,
            &state.client,
            &state.db_read,
            &state.db,
            keys,
        )
        .await;
    });
    Ok(())
}

/// Images one pre-warm pass will fetch.
///
/// A pass, not a budget: keys already on disk are never selected, so a collection of ten
/// thousand cards warms over several sessions and each one starts where the last stopped.
/// What keeps a pass this size from being felt is [`warm`] being **sequential** — it awaits
/// one key before asking for the next, so it holds one of [`MAX_CONCURRENT_FETCHES`] and
/// leaves the rest to the grid the reader is actually using. That, rather than the pacing
/// interval that used to be here, is the thing not to remove.
pub const MAX_PREWARM: usize = 2_000;

/// The variant the collection and wishlist screens draw, and therefore the one worth
/// pre-warming for them.
///
/// Spec §5 says `thumb` + `grid`; the app has no `thumb` surface yet (the tables show no
/// art), and fetching 9 KB per card for a view that does not exist is a download rather
/// than a pre-warm.
///
/// **`Display` since 2026-08-20, mirroring TypeScript's `WALL_CARD_VARIANT`.** It was `Grid`,
/// which is 488×680 — and the walls zoom while the variant does not, so a 170px tile at the top
/// of `cardZoom`'s ladder is 340 CSS pixels and, on a monitor at 200% scaling, 680 device pixels
/// drawn from a 488px source. That upscale is the blur readers reported. `display`'s 672 covers
/// the worst case; Scryfall's larger `png` is 745×1040 for roughly ten times the bytes and is
/// not stored here at all, because the ingest keeps four of its eleven image keys and drops the
/// JPG/PNG family its own docs mark as replaced (`card_row::webp_uris`).
///
/// It costs about 93 KB a card against `grid`'s ~62 KB, and less than that sum suggests: it is
/// what `CardDetailPane` and `PrintingPreview` already draw, so a card the reader opens is now
/// one cache key instead of two.
pub const COLLECTION_PREWARM: Variant = Variant::Display;

/// The variant a **deck card** is drawn at — the two views that draw one as a picture, which is
/// `CardStack` and `views/GridView`. Mirrored in TypeScript as `cardControl.tsx`'s
/// `DECK_CARD_VARIANT`, and the two have to agree.
///
/// This constant exists because getting it wrong is **invisible**: a pre-warm that fetched the
/// variant no deck surface asks for reports itself as having warmed every deck card, and the
/// builder then fetches every tile cold anyway, because each variant is a different URL on the
/// CDN. That is not hypothetical — it is what this app did. Measured against the live database
/// on 2026-08-11: all 17 deck cards had a `grid` row and only 12 had an `art` row, with an
/// empty collection and wishlist, so the deck arm was the *only* work pre-warming had to do
/// and it warmed a variant no deck surface asked for.
///
/// **It is `Display` now, which is [`COLLECTION_PREWARM`], and the two arms coalescing is the
/// point rather than a coincidence to tidy away.** The deck's stack and grid views draw the whole
/// card instead of the bare art crop, so a card that is both owned and in a deck is one cache key
/// rather than two — half the bytes, and one warm picture serving both screens. They stay two
/// named constants because they answer two questions and a future surface could move one without
/// the other.
///
/// **Both moved from `Grid` together on 2026-08-20**, for [`COLLECTION_PREWARM`]'s reason: the
/// deck views zoom too, and the argument that had kept this at `Grid` — 488px is already a 2×
/// downscale of a 210px stack card — was a measurement taken at 100% zoom on an unscaled display.
/// The same card at 2× on a monitor at 200% scaling is 840 device pixels.
///
/// **Four deck surfaces are deliberately not covered by this and still draw `Art`**: the
/// gallery's deck tiles and its folder strips, `DeckSettingsDialog`'s cover picker and preview —
/// all three of which draw a *cover*, which is 626×457 by construction ([`COVER_VARIANT`], because
/// [`encode_cover`] writes a user's own file at exactly that shape) — and the theory diff, whose
/// picture is a 32×44 decoration in a list that spells the card's name out beside it. Those fetch
/// on demand; a dialog the reader opens deliberately does not need warming, and the gallery warms
/// its own covers in `DecksPage`.
pub const DECK_PREWARM: Variant = Variant::Display;

/// The cards the user owns, wants, or has put in a deck, that have no cached image yet —
/// **each paired with the variant the screen that shows it actually draws**.
///
/// Three arms rather than two since the decks landed, because a user whose cards live only
/// in decks would otherwise have nothing pre-warmed at all. The pairing is the part that
/// has to stay right: `NOT EXISTS` is checked against *that arm's* variant, so a card is warmed
/// once per picture the app will actually ask for.
///
/// Today [`COLLECTION_PREWARM`] and [`DECK_PREWARM`] are the same variant, so a card that is both
/// owned and in a deck collapses to one row rather than two — the `UNION` (never `UNION ALL`) is
/// what makes that automatic. The arms stay separate because the pairing, not the count, is the
/// contract: the day a deck surface wants a different picture again, only its own arm moves.
pub fn prewarm_keys(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<ImageKey>> {
    let mut stmt = conn.prepare(
        "WITH wanted(card_id, variant) AS (
            SELECT card_id, ?1 FROM collection_entries
            UNION
            SELECT card_id, ?1 FROM wishlist_entries WHERE card_id IS NOT NULL
            UNION
            SELECT card_id, ?2 FROM deck_cards)
         SELECT w.card_id, w.variant FROM wanted w
          WHERE NOT EXISTS (
                SELECT 1 FROM image_cache c
                 WHERE c.card_id = w.card_id AND c.variant = w.variant AND c.face = 0)
          LIMIT ?3",
    )?;
    let rows = stmt.query_map(
        params![COLLECTION_PREWARM.key(), DECK_PREWARM.key(), limit as i64],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )?;
    Ok(rows
        .filter_map(Result::ok)
        .filter(|(id, _)| is_card_id(id))
        // Front faces only: the back of a double-faced card is not on screen until someone
        // opens the pane and flips it, and that fetch is one tile's worth.
        .filter_map(|(card_id, variant)| {
            Some(ImageKey {
                card_id,
                face: 0,
                variant: Variant::parse(&variant)?,
            })
        })
        .collect())
}

/// Warm the cache for what the user owns. Returns how many images were queued.
///
/// Fire-and-forget in the same sense as [`prefetch_images`]: it resolves when the work is
/// queued. The loop shares the cache's own semaphore with the live grid, so a pre-warm
/// running behind a browsing session competes for the same budget rather than doubling it,
/// and it abandons the batch on the first rate limit.
#[tauri::command]
pub async fn prewarm_collection(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
) -> Result<usize, String> {
    let state = state.inner().clone();
    let keys = {
        let conn = crate::sync::lock_db_read(&state);
        prewarm_keys(&conn, MAX_PREWARM).map_err(|e| e.to_string())?
    };
    let queued = keys.len();
    tauri::async_runtime::spawn(async move {
        warm(
            &state.images,
            &state.client,
            &state.db_read,
            &state.db,
            keys,
        )
        .await;
    });
    Ok(queued)
}

/// Walk a batch, stopping at the first rate limit. Returns how many keys were attempted.
///
/// Split out of [`prefetch_images`] because that command needs a `tauri::State` and a
/// running app, and the abandon-on-429 rule is exactly the part worth a test.
async fn warm(
    cache: &Cache,
    client: &scryfall::Client,
    read: &Mutex<Connection>,
    write: &Mutex<Connection>,
    keys: Vec<ImageKey>,
) -> usize {
    let mut attempted = 0;
    for key in keys {
        // The cache's own semaphore and interval gate do the pacing; this loop just hands
        // it work.
        attempted += 1;
        // A rate limit is carried by the shared gate, so it is already true of every key
        // left in this batch: continuing would be ~99 round trips through the database and
        // the gate mutex, each failing fast and each contending with the tiles that are
        // actually on screen. Abandon the batch — the next page that lands queues a fresh
        // one, and any tile that needed these asks for itself.
        //
        // Every other outcome is this key's own problem rather than the batch's: a 404 for
        // a URI Scryfall published, an unreadable row, a `soon.jpg` answered with a
        // placeholder. None worth reporting — the tile asks again when it renders.
        if let Err(ImageError::RateLimited { .. }) = cache.get(client, read, write, &key).await {
            break;
        }
    }
    attempted
}

/// A wait in whole seconds, rounded **up**.
///
/// 29.4 s left of a lockout is not a `Retry-After: 29`: that is a retry inside the window
/// we are being punished for, which is what Scryfall escalates to bans over.
fn secs_rounded_up(d: Duration) -> u64 {
    d.as_secs() + u64::from(d.subsec_nanos() > 0)
}

/// Write `bytes` to `path`, creating the shard directory — whole, or not at all.
///
/// Written to a temporary name and renamed into place, because the destination of a
/// *re*-fetch is a file `image_cache` already calls current. A crash between truncating
/// that file and finishing the write would leave a short one that nothing invalidates —
/// [`is_current`] compares URIs, and the URI has not changed — so the torn bytes would be
/// served until Scryfall next re-scans the card, which can be months. `rename` replaces
/// the destination on Windows too (`MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`), so the
/// swap is one operation on either platform.
///
/// The temporary name carries a counter because two writes to one key can genuinely
/// overlap — a fast scroll, or a re-fetch racing a first fetch — and a shared temporary
/// would interleave them into one corrupt file that then gets renamed into place.
async fn store(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = path.with_extension(format!("{}.tmp", WRITE_SEQ.fetch_add(1, Ordering::Relaxed)));
    tokio::fs::write(&tmp, bytes).await?;
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        // Nothing will ever look for this name again, so a failed swap must not leave it.
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use rusqlite::Connection;

    /// A normal card (top-level images), a transform (per-face), one of the 162 printings
    /// that have no image anywhere, and one of the eight that have something worse.
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, image_uris, raw)
             VALUES ('0000419b-0bba-4488-8f7a-6194544ce91d','Bolt','lea','161','en','normal',
                     json_object(
                       'thumb','https://cards.scryfall.io/thumb/front/0/0/x.webp?17',
                       'grid','https://cards.scryfall.io/grid/front/0/0/x.webp?17',
                       'display','https://cards.scryfall.io/display/front/0/0/x.webp?17',
                       'art','https://cards.scryfall.io/art/front/0/0/x.webp?17'), '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, face_image_uris, raw)
             VALUES ('ab000000-0000-0000-0000-000000000001','Delver','isd','51','en','transform',
                     json_array(
                       json_object('grid','https://cards.scryfall.io/grid/front/a/b/y.webp?9'),
                       json_object('grid','https://cards.scryfall.io/grid/back/a/b/y.webp?9')), '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
             VALUES ('cd000000-0000-0000-0000-000000000002','Nameless','sld','1','en','art_series','{}')",
            [],
        )
        .unwrap();
        // Copied byte for byte out of the live database, where eight printings carry it:
        // `plst UMA-149`, `plst BFZ-149`, `plst AKH-150`, `plst E01-49` and `mic 55`–`58`.
        // All four slots, one error page, no `?<epoch>` anywhere in it.
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, image_uris, raw)
             VALUES ('21081971-7cb9-479f-9c3e-cb5b4a40a936','Ghouls'' Night Out','mic','57','en','normal',
                     json_object(
                       'thumb','https://errors.scryfall.com/soon.jpg',
                       'grid','https://errors.scryfall.com/soon.jpg',
                       'display','https://errors.scryfall.com/soon.jpg',
                       'art','https://errors.scryfall.com/soon.jpg'), '{}')",
            [],
        )
        .unwrap();
        conn
    }

    /// The live `mic 57` row: Scryfall's error page in every `image_uris` slot.
    const SOON: &str = "21081971-7cb9-479f-9c3e-cb5b4a40a936";

    fn key(id: &str, face: u8, variant: Variant) -> ImageKey {
        ImageKey {
            card_id: id.to_owned(),
            face,
            variant,
        }
    }

    /// WEBP only, and the rejection is a security boundary as much as a policy one: the
    /// variant becomes a directory name, so anything that is not one of four literals
    /// must never reach the filesystem.
    #[test]
    fn only_the_four_webp_variants_are_accepted() {
        for good in ["thumb", "grid", "display", "art"] {
            assert!(Variant::parse(good).is_some(), "{good}");
        }
        for bad in [
            "png",
            "small",
            "normal",
            "large",
            "art_crop",
            "border_crop",
            "crop",
            "..",
            "",
        ] {
            assert!(Variant::parse(bad).is_none(), "{bad} must be refused");
        }
    }

    /// The variants the schema *stores* and the variants this module *serves* are one
    /// list. A drift between them is either a column nothing can ask for or a request
    /// that can only ever miss, and neither says so out loud.
    #[test]
    fn the_served_variants_are_exactly_the_ones_the_schema_stores() {
        let served: Vec<&str> = crate::schema::IMAGE_VARIANTS
            .iter()
            .map(|k| {
                Variant::parse(k)
                    .unwrap_or_else(|| panic!("`{k}` is stored but cannot be served"))
                    .key()
            })
            .collect();
        assert_eq!(served, crate::schema::IMAGE_VARIANTS.to_vec());
    }

    /// The layout spec §5 fixes. The two-character shard is not decoration: a full
    /// `thumb` cache is ~120 000 files, and one directory holding them is one the user's
    /// own file manager cannot open.
    #[test]
    fn the_cache_path_shards_on_the_first_two_characters() {
        let dir = Path::new("D:\\app\\data\\images");

        assert_eq!(
            cache_path(
                dir,
                &key("0000419b-0bba-4488-8f7a-6194544ce91d", 0, Variant::Grid)
            ),
            Some(
                dir.join("grid")
                    .join("00")
                    .join("0000419b-0bba-4488-8f7a-6194544ce91d-0.webp")
            )
        );
        assert_eq!(
            cache_path(
                dir,
                &key("ab000000-0000-0000-0000-000000000001", 1, Variant::Thumb)
            ),
            Some(
                dir.join("thumb")
                    .join("ab")
                    .join("ab000000-0000-0000-0000-000000000001-1.webp")
            )
        );
    }

    /// The id becomes a directory name and a file name, so a path exists only for
    /// something that could be a Scryfall id. `ImageKey` is built from a URL by the
    /// protocol handler — these are the shapes that turn one cache directory into
    /// "anywhere on this disk", and the `Option` is what makes refusing them structural.
    #[test]
    fn a_path_is_only_built_for_something_that_could_be_a_scryfall_id() {
        let dir = Path::new("D:\\app\\data\\images");
        for bad in [
            "..",
            "../../../windows/system32/config/sam",
            "..\\..\\..\\secrets",
            "C:\\Windows\\System32\\drivers\\etc\\hosts",
            "/etc/passwd",
            "",
            // The dangerous near-misses: the right length, one character that is not hex.
            "0000419b-0bba-4488-8f7a-6194544ce91/",
            "0000419b-0bba-4488-8f7a-6194544ce9%2",
            "0000419b-0bba-4488-8f7a-6194544ce9..",
            // ...and the right charset at the wrong length.
            "0000419b-0bba-4488-8f7a-6194544ce9",
            "0000419b-0bba-4488-8f7a-6194544ce91dd",
        ] {
            assert!(
                cache_path(dir, &key(bad, 0, Variant::Grid)).is_none(),
                "`{bad}` must not become a path"
            );
            assert!(!is_card_id(bad), "`{bad}` must not read as a card id");
        }
    }

    #[test]
    fn a_request_path_parses_into_a_key() {
        let k = parse_request_path("/grid/0000419b-0bba-4488-8f7a-6194544ce91d/0").unwrap();
        assert_eq!(k.card_id, "0000419b-0bba-4488-8f7a-6194544ce91d");
        assert_eq!(k.face, 0);
        assert_eq!(k.variant, Variant::Grid);

        // Same path with no leading slash: the two platform URL forms differ in origin,
        // not in path, but a handler that assumed one of them is a handler that breaks on
        // the other platform's first run.
        let k = parse_request_path("display/ab000000-0000-0000-0000-000000000001/1").unwrap();
        assert_eq!(k.face, 1);
        assert_eq!(k.variant, Variant::Display);
    }

    /// The path becomes a filesystem path, so everything that is not a Scryfall UUID and
    /// one of four variant names has to die here. `..` is the obvious attack; a
    /// percent-encoded separator is the one that gets missed.
    #[test]
    fn a_hostile_or_malformed_path_is_refused() {
        for bad in [
            "/grid/../../../windows/system32/config/sam/0",
            "/grid/%2e%2e%2f%2e%2e%2fsecrets/0",
            "/png/0000419b-0bba-4488-8f7a-6194544ce91d/0",
            "/grid/0000419b-0bba-4488-8f7a-6194544ce91d",
            "/grid/0000419b-0bba-4488-8f7a-6194544ce91d/0/extra",
            "/grid/not a uuid/0",
            "/grid/0000419b-0bba-4488-8f7a-6194544ce91d/nine",
            "/grid/0000419b-0bba-4488-8f7a-6194544ce91d/9",
            "",
            "/",
        ] {
            assert!(parse_request_path(bad).is_none(), "{bad} must be refused");
        }
    }

    /// A page of results is 50 cards, and a prefetch that a fast scroll can queue without
    /// bound is a prefetch that fights the images the reader is actually looking at.
    #[test]
    fn a_prefetch_batch_is_capped() {
        let ids: Vec<String> = (0..500)
            .map(|i| format!("{i:08}-0000-0000-0000-000000000000"))
            .collect();

        let keys = prefetch_keys(&ids, Variant::Grid);

        assert_eq!(keys.len(), MAX_PREFETCH);
        assert_eq!(keys[0].face, 0, "only the front is worth prefetching");
        assert_eq!(keys[0].variant, Variant::Grid);
    }

    #[test]
    fn a_prefetch_batch_drops_ids_that_are_not_card_ids() {
        let keys = prefetch_keys(
            &[
                "0000419b-0bba-4488-8f7a-6194544ce91d".to_owned(),
                "../../etc/passwd".to_owned(),
            ],
            Variant::Thumb,
        );

        assert_eq!(keys.len(), 1);
    }

    /// The batch is walked in reading order, and [`Cache`]'s single-flight map is what makes
    /// that the right answer: the grid mounts the *head* of a page as tiles the moment it
    /// lands, so a prefetch that starts at index 0 asks for keys those tiles are asking for
    /// too — and the second asker now waits on the first's lock instead of spending a second
    /// round trip. Walking backwards would spend the whole permit budget on cards fifty rows
    /// below the fold while the reader waits on the ones in front of them.
    #[test]
    fn a_prefetch_batch_starts_at_the_top_of_the_page() {
        let ids: Vec<String> = (0..50)
            .map(|i| format!("{i:08}-0000-0000-0000-000000000000"))
            .collect();

        let keys = prefetch_keys(&ids, Variant::Grid);

        assert_eq!(keys.len(), 50);
        assert_eq!(
            keys[0].card_id, ids[0],
            "the card the reader is looking at is warmed first"
        );
        assert_eq!(
            keys[49].card_id, ids[49],
            "and the far end of the page last"
        );
    }

    /// The cap keeps the *head* of what was sent — the page the reader is on — rather than
    /// the tail of a long list, which is nowhere near it.
    #[test]
    fn a_capped_batch_keeps_the_head_of_the_page_in_order() {
        let ids: Vec<String> = (0..500)
            .map(|i| format!("{i:08}-0000-0000-0000-000000000000"))
            .collect();

        let keys = prefetch_keys(&ids, Variant::Grid);

        assert_eq!(keys.len(), MAX_PREFETCH);
        assert_eq!(keys[0].card_id, ids[0]);
        assert_eq!(keys[MAX_PREFETCH - 1].card_id, ids[MAX_PREFETCH - 1]);
    }

    #[test]
    fn a_top_level_image_resolves_for_face_zero() {
        let conn = seeded();
        let r = resolve(
            &conn,
            &key("0000419b-0bba-4488-8f7a-6194544ce91d", 0, Variant::Display),
        )
        .unwrap();
        assert!(
            matches!(r, Resolution::Uri(ref u)
                     if u == "https://cards.scryfall.io/display/front/0/0/x.webp?17"),
            "{r:?}"
        );
    }

    /// The resolution rule from the other side: a transform has no top-level images and
    /// each physical side has its own.
    #[test]
    fn a_transform_resolves_per_face() {
        let conn = seeded();
        let front = resolve(
            &conn,
            &key("ab000000-0000-0000-0000-000000000001", 0, Variant::Grid),
        )
        .unwrap();
        let back = resolve(
            &conn,
            &key("ab000000-0000-0000-0000-000000000001", 1, Variant::Grid),
        )
        .unwrap();
        assert!(
            matches!(front, Resolution::Uri(ref u) if u.contains("/front/")),
            "{front:?}"
        );
        assert!(
            matches!(back, Resolution::Uri(ref u) if u.contains("/back/")),
            "{back:?}"
        );
    }

    /// Face 1 of a card with one physical side. Not an error, and emphatically not the
    /// front image — every normal Magic card has a back, and showing the front twice is
    /// how a flip animation ends up lying about the card.
    #[test]
    fn the_back_of_a_single_faced_card_is_a_card_back() {
        let conn = seeded();
        let r = resolve(
            &conn,
            &key("0000419b-0bba-4488-8f7a-6194544ce91d", 1, Variant::Grid),
        )
        .unwrap();
        assert!(
            matches!(r, Resolution::Missing(Placeholder::CardBack)),
            "{r:?}"
        );
    }

    /// 162 printings in the live data have no image anywhere. A placeholder, never a
    /// failure: there is nothing to retry and nothing the user can do.
    #[test]
    fn a_printing_with_no_art_resolves_to_a_placeholder() {
        let conn = seeded();
        let r = resolve(
            &conn,
            &key("cd000000-0000-0000-0000-000000000002", 0, Variant::Grid),
        )
        .unwrap();
        assert!(
            matches!(r, Resolution::Missing(Placeholder::NoImage)),
            "{r:?}"
        );
    }

    /// `soon.jpg` — the live poisoning, in the shape it actually ships in.
    ///
    /// Eight printings publish Scryfall's error page as their artwork. Nothing downstream
    /// could have recovered from taking it at face value: the bytes are a JPEG that would
    /// be written as `<id>-0.webp`, and since [`is_current`] compares URIs and *this* URI
    /// has no version to move, the row would call them current for as long as the app is
    /// installed. Not a fetch to retry — a picture that has to be refused at resolution.
    #[test]
    fn a_versionless_uri_resolves_to_a_placeholder_rather_than_bytes_to_cache() {
        let conn = seeded();
        for variant in [
            Variant::Thumb,
            Variant::Grid,
            Variant::Display,
            Variant::Art,
        ] {
            let r = resolve(&conn, &key(SOON, 0, variant)).unwrap();
            assert!(
                matches!(r, Resolution::Missing(Placeholder::NoImage)),
                "{variant:?} must not resolve to an error page: {r:?}"
            );
        }
    }

    /// The one row both readers take. `card::card_image_uri_inner` and [`resolve`] each apply
    /// their own policy to it — the card pane deliberately skips the host fence — but they must
    /// never disagree about *which two columns* a printing's picture is in.
    #[test]
    fn image_uri_row_answers_both_columns_and_none_for_an_unknown_card() {
        let conn = seeded();

        // The plain printing: a top-level image for every variant, no per-face ones.
        let (top, face) = image_uri_row(&conn, "0000419b-0bba-4488-8f7a-6194544ce91d", "grid", 0)
            .unwrap()
            .expect("a card that is in the corpus answers a row");
        assert_eq!(
            top.as_deref(),
            Some("https://cards.scryfall.io/grid/front/0/0/x.webp?17")
        );
        assert_eq!(face, None, "a normal printing carries no per-face images");

        // The transform: per-face images and no top-level one, and face 1 is its own picture.
        // Which of the two a caller then *uses* is the caller's policy, not this function's.
        let (top, face) = image_uri_row(&conn, "ab000000-0000-0000-0000-000000000001", "grid", 1)
            .unwrap()
            .unwrap();
        assert_eq!(top, None, "a transform carries no top-level image");
        assert_eq!(
            face.as_deref(),
            Some("https://cards.scryfall.io/grid/back/a/b/y.webp?9")
        );

        assert!(
            image_uri_row(&conn, "not-a-card", "grid", 0)
                .unwrap()
                .is_none(),
            "an unknown card is None, not an error"
        );
    }

    /// The two halves of [`is_fetchable`], separately, because they fail for different
    /// reasons and only one of them is a security boundary.
    ///
    /// The host check is a `starts_with` and that is only a host comparison because of the
    /// trailing slash — the near-misses below are the ones that would make it a substring
    /// search instead, and they are exactly the shapes an attacker-supplied `image_uris`
    /// would take if the bulk file were ever tampered with in transit.
    #[test]
    fn only_a_versioned_uri_on_the_image_host_is_worth_fetching() {
        for good in [
            "https://cards.scryfall.io/grid/front/0/0/x.webp?1699999999",
            "https://cards.scryfall.io/art/back/a/b/y.webp?0",
        ] {
            assert!(has_cache_buster(good), "{good}");
            assert!(is_image_host(good), "{good}");
            assert!(is_fetchable(good), "{good}");
        }

        // No version: nothing here can ever be invalidated, whoever serves it.
        for versionless in [
            "https://errors.scryfall.com/soon.jpg",
            "https://cards.scryfall.io/grid/front/0/0/x.webp",
            "https://cards.scryfall.io/grid/front/0/0/x.webp?",
            "https://cards.scryfall.io/grid/front/0/0/x.webp?v=17",
            "https://cards.scryfall.io/grid/front/0/0/x.webp?latest",
            "",
        ] {
            assert!(!has_cache_buster(versionless), "{versionless}");
            assert!(!is_fetchable(versionless), "{versionless}");
        }

        // Right shape, wrong host — including the two that a substring check would wave
        // through, where the real host is the *prefix* of a hostile one or its userinfo.
        for off_host in [
            "https://errors.scryfall.com/soon.jpg?17",
            "https://cards.scryfall.io.evil.test/grid/x.webp?17",
            "https://cards.scryfall.io@evil.test/grid/x.webp?17",
            "https://evil.test/https://cards.scryfall.io/grid/x.webp?17",
            "http://cards.scryfall.io/grid/x.webp?17",
        ] {
            assert!(has_cache_buster(off_host), "{off_host}");
            assert!(
                !is_image_host(off_host),
                "{off_host} must not read as the CDN"
            );
        }
    }

    #[test]
    fn an_unknown_card_is_not_a_placeholder() {
        let conn = seeded();
        let r = resolve(
            &conn,
            &key("ff000000-0000-0000-0000-0000000000ff", 0, Variant::Grid),
        )
        .unwrap();
        assert!(matches!(r, Resolution::Unknown), "{r:?}");
    }

    /// The invalidation rule. Scryfall's `?<epoch>` cache-buster equals
    /// `image_updated_at`, so a stored URI that no longer matches the resolved one *is*
    /// the re-scan signal — with no clock, mtime or filesystem timestamp anywhere in the
    /// decision (a FAT32 stick rounds mtimes to two seconds).
    #[test]
    fn a_changed_image_version_invalidates_the_cached_bytes() {
        let conn = seeded();
        let k = key("0000419b-0bba-4488-8f7a-6194544ce91d", 0, Variant::Grid);
        let old = "https://cards.scryfall.io/grid/front/0/0/x.webp?17";
        let new = "https://cards.scryfall.io/grid/front/0/0/x.webp?99";

        assert!(!is_current(&conn, &k, old), "nothing is cached yet");
        record(&conn, &k, old, 62_000).unwrap();
        assert!(is_current(&conn, &k, old));
        assert!(!is_current(&conn, &k, new), "a bumped version must miss");

        record(&conn, &k, new, 62_100).unwrap();
        assert!(is_current(&conn, &k, new), "re-recording replaces the row");
    }

    #[test]
    fn placeholders_are_svg_at_the_variant_dimensions() {
        let grid = placeholder_svg(Placeholder::NoImage, Variant::Grid);
        assert!(grid.starts_with("<svg"), "{grid}");
        assert!(grid.contains("viewBox=\"0 0 488 680\""), "{grid}");
        assert!(grid.contains("No image"), "{grid}");

        // The art variant is landscape. A portrait placeholder there would be a stretched
        // frame — which for a real card image the Scryfall policy forbids outright, and
        // which for ours just looks broken.
        let art = placeholder_svg(Placeholder::CardBack, Variant::Art);
        assert!(art.contains("viewBox=\"0 0 626 457\""), "{art}");
        assert!(art.contains("Card back"), "{art}");
    }

    // The clamp this cache charges a 429 with now lives in `scryfall`, and so does its
    // test (`the_rate_limit_penalty_is_clamped_at_both_ends`) — one rule over two hosts,
    // one place it is asserted.

    /// A real file database and a real cache directory: the connection discipline is part
    /// of what these exercise. `read` is opened `SQLITE_OPEN_READ_ONLY`, so bookkeeping
    /// that went through the wrong handle would fail rather than quietly work.
    struct Fixture {
        read: Mutex<Connection>,
        write: Mutex<Connection>,
        cache: Cache,
    }

    impl Fixture {
        fn new(name: &str) -> Fixture {
            // Wiped on the way in rather than out: these tests hold the database open, and
            // Windows will not delete a file that is.
            let dir = std::env::temp_dir().join(format!("mtgtest-images-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();

            let db = dir.join("mtg.db");
            let write = crate::db::open(&db).unwrap();
            crate::schema::migrate(&write).unwrap();
            let read = crate::db::open_read_only(&db).unwrap();

            Fixture {
                cache: Cache::new(dir.join("images")),
                read: Mutex::new(read),
                write: Mutex::new(write),
            }
        }

        /// One printing whose `grid` image lives at `uri`.
        fn card(&self, id: &str, uri: &str) {
            self.write
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO cards
                        (id, name, set_code, collector_number, lang, layout, image_uris, raw)
                     VALUES (?1,'Bolt','lea','161','en','normal', json_object('grid', ?2), '{}')
                     ON CONFLICT(id) DO UPDATE SET image_uris = excluded.image_uris",
                    params![id, uri],
                )
                .unwrap();
        }

        /// A printing Scryfall has no art for at all.
        fn artless(&self, id: &str) {
            self.write
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
                     VALUES (?1,'Nameless','sld','1','en','art_series','{}')",
                    params![id],
                )
                .unwrap();
        }

        async fn get(
            &self,
            client: &scryfall::Client,
            key: &ImageKey,
        ) -> Result<Served, ImageError> {
            self.cache.get(client, &self.read, &self.write, key).await
        }

        fn cached_row(&self, id: &str) -> Option<(String, i64)> {
            self.write
                .lock()
                .unwrap()
                .query_row(
                    "SELECT source_uri, bytes FROM image_cache WHERE card_id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .unwrap()
        }
    }

    const BOLT: &str = "0000419b-0bba-4488-8f7a-6194544ce91d";

    /// The whole fetch-on-miss flow, and then the hit that must not repeat it: bytes to
    /// disk at the sharded path, a bookkeeping row through the *write* connection, and a
    /// second request that never reaches the network.
    #[tokio::test]
    async fn a_miss_fetches_and_stores_and_the_next_request_reads_the_disk() {
        let f = Fixture::new("miss");
        let server = MockServer::start();
        let body = vec![0x52u8, 0x49, 0x46, 0x46, 1, 2, 3, 4];
        let mock = server.mock(|when, then| {
            when.method(GET).path("/grid/v17.webp");
            then.status(200).body(body.clone());
        });
        let uri = format!("{}/grid/v17.webp?17", server.base_url());
        f.card(BOLT, &uri);
        let client = scryfall::Client::new(server.base_url());
        let k = key(BOLT, 0, Variant::Grid);

        let served = f.get(&client, &k).await.unwrap();

        assert_eq!(served.bytes, body, "bytes are passed through untouched");
        assert_eq!(served.content_type, WEBP);
        assert_eq!(mock.calls(), 1);
        assert_eq!(
            std::fs::read(cache_path(f.cache.dir(), &k).unwrap()).unwrap(),
            body,
            "the bytes must be on disk at the sharded path"
        );
        assert_eq!(
            f.cached_row(BOLT),
            Some((uri, body.len() as i64)),
            "the bookkeeping row has to go through the write connection"
        );

        let again = f.get(&client, &k).await.unwrap();

        assert_eq!(again.bytes, body);
        assert_eq!(mock.calls(), 1, "a cache hit must not touch the network");
    }

    /// Spec §8: deleting `data/images` is always safe. The row outlives the file, so the
    /// file's absence has to read as a miss rather than as an error.
    #[tokio::test]
    async fn a_deleted_file_is_a_miss_and_never_an_error() {
        let f = Fixture::new("deleted");
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(GET).path("/grid/v17.webp");
            then.status(200).body(vec![7u8; 16]);
        });
        f.card(BOLT, &format!("{}/grid/v17.webp?17", server.base_url()));
        let client = scryfall::Client::new(server.base_url());
        let k = key(BOLT, 0, Variant::Grid);

        f.get(&client, &k).await.unwrap();
        std::fs::remove_file(cache_path(f.cache.dir(), &k).unwrap()).unwrap();
        let served = f.get(&client, &k).await.unwrap();

        assert_eq!(served.bytes, vec![7u8; 16]);
        assert_eq!(mock.calls(), 2, "the file is the cache, the row is a note");
    }

    /// End to end, the invalidation rule: Scryfall re-scans a card, the sync stores a URI
    /// with a new `?<epoch>`, and the next request must fetch rather than serve the
    /// picture that is already sitting on disk under exactly that filename.
    #[tokio::test]
    async fn a_rescanned_image_is_re_fetched_over_the_stale_bytes() {
        let f = Fixture::new("rescan");
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/grid/v17.webp");
            then.status(200).body(vec![1u8; 8]);
        });
        let fresh = server.mock(|when, then| {
            when.method(GET).path("/grid/v99.webp");
            then.status(200).body(vec![2u8; 8]);
        });
        let client = scryfall::Client::new(server.base_url());
        let k = key(BOLT, 0, Variant::Grid);

        f.card(BOLT, &format!("{}/grid/v17.webp?17", server.base_url()));
        assert_eq!(f.get(&client, &k).await.unwrap().bytes, vec![1u8; 8]);

        let new_uri = format!("{}/grid/v99.webp?99", server.base_url());
        f.card(BOLT, &new_uri);
        let served = f.get(&client, &k).await.unwrap();

        assert_eq!(served.bytes, vec![2u8; 8], "a bumped version must not hit");
        assert_eq!(fresh.calls(), 1);
        assert_eq!(
            std::fs::read(cache_path(f.cache.dir(), &k).unwrap()).unwrap(),
            vec![2u8; 8],
            "the stale bytes must be replaced, not left beside the new ones"
        );
        assert_eq!(f.cached_row(BOLT), Some((new_uri, 8)));
    }

    /// A printing with no art is a picture, not a failure — and not a request either.
    /// There is nothing at the other end to ask for.
    #[tokio::test]
    async fn a_missing_image_is_served_as_a_placeholder_without_a_request() {
        let f = Fixture::new("placeholder");
        let server = MockServer::start();
        let anything = server.mock(|when, then| {
            when.method(GET);
            then.status(200).body("should never be asked for");
        });
        f.artless(BOLT);
        let client = scryfall::Client::new(server.base_url());

        let served = f.get(&client, &key(BOLT, 0, Variant::Grid)).await.unwrap();

        assert_eq!(served.content_type, SVG);
        assert!(String::from_utf8(served.bytes)
            .unwrap()
            .contains("No image"));
        assert_eq!(anything.calls(), 0);
        assert!(
            !f.cache.dir().exists(),
            "a placeholder must not create cache directories"
        );
    }

    /// The same refusal through the whole cache, which is where it has to hold: nothing
    /// leaves the process, nothing lands on the disk, and no row is written that would
    /// vouch for an error page as a card's artwork until the app is reinstalled.
    #[tokio::test]
    async fn a_versionless_uri_is_never_fetched_stored_or_recorded() {
        let f = Fixture::new("soon");
        let server = MockServer::start();
        let anything = server.mock(|when, then| {
            when.method(GET);
            then.status(200).body("a JPEG error page, 8.5 KB of it");
        });
        f.card(BOLT, "https://errors.scryfall.com/soon.jpg");
        let client = scryfall::Client::new(server.base_url());
        let k = key(BOLT, 0, Variant::Grid);

        let served = f.get(&client, &k).await.unwrap();

        assert_eq!(served.content_type, SVG);
        assert!(String::from_utf8(served.bytes)
            .unwrap()
            .contains("No image"));
        assert_eq!(anything.calls(), 0, "an error page is not worth a request");
        assert_eq!(
            f.cached_row(BOLT),
            None,
            "a row here would outlive every sync that could have fixed it"
        );
        assert!(
            !cache_path(f.cache.dir(), &k).unwrap().exists(),
            "and the bytes must not be sitting there under a .webp name"
        );
    }

    /// An id that resolves to nothing is a caller error, and the protocol turns it into a
    /// 404. Answering with a placeholder would make a broken link indistinguishable from
    /// a card Scryfall has no art for.
    #[tokio::test]
    async fn an_unknown_card_is_an_error_rather_than_a_picture() {
        let f = Fixture::new("unknown");
        let client = scryfall::Client::new("http://127.0.0.1:1".into());

        let err = f
            .get(
                &client,
                &key("ff000000-0000-0000-0000-0000000000ff", 0, Variant::Grid),
            )
            .await
            .unwrap_err();

        assert!(matches!(err, ImageError::UnknownCard), "{err:?}");
    }

    /// `ImageKey` is a public struct with public fields, built by the protocol handler out
    /// of a URL. An id that could not be a Scryfall id is refused before the database is
    /// asked and long before a path exists — the id is a directory name and a file name.
    #[tokio::test]
    async fn a_hostile_card_id_never_reaches_the_database_or_the_filesystem() {
        let f = Fixture::new("hostile-id");
        let client = scryfall::Client::new("http://127.0.0.1:1".into());

        for bad in ["../../../windows/system32/config/sam", "..", ""] {
            let err = f
                .get(&client, &key(bad, 0, Variant::Grid))
                .await
                .unwrap_err();
            assert!(matches!(err, ImageError::UnknownCard), "`{bad}`: {err:?}");
        }
        assert!(!f.cache.dir().exists());
    }

    /// The 429 penalty is per application, so it is charged to the gate every other tile
    /// has to pass — and the `Retry-After` that sets it is clamped up to Scryfall's
    /// documented 30 s lockout on the way in.
    #[tokio::test]
    async fn a_rate_limit_pushes_the_shared_gate_past_scryfalls_lockout() {
        let f = Fixture::new("ratelimited");
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/grid/v17.webp");
            // A `Retry-After: 0` is exactly the header that would otherwise have us
            // retrying inside the window we are being punished for.
            then.status(429).header("retry-after", "0");
        });
        f.card(BOLT, &format!("{}/grid/v17.webp?17", server.base_url()));
        let client = scryfall::Client::new(server.base_url());

        let err = f
            .get(&client, &key(BOLT, 0, Variant::Grid))
            .await
            .unwrap_err();

        assert!(
            matches!(
                err,
                ImageError::RateLimited {
                    retry_after_secs: 30
                }
            ),
            "the wait the caller is told to take must be the one we will honour: {err:?}"
        );
        let ahead = f
            .cache
            .gate
            .lock()
            .await
            .saturating_duration_since(tokio::time::Instant::now());
        assert!(
            ahead > Duration::from_secs(25),
            "every tile waits out a 429, not just the one that earned it: {ahead:?}"
        );
    }

    /// A prefetch batch is abandoned at the first rate limit rather than walked to the end.
    ///
    /// The gate carries a 429 for the whole application, so once one key has earned one it
    /// is already true of every key left in the batch: the rest would be ~99 round trips
    /// through the read connection and the gate mutex, every one of them failing fast, and
    /// every one contending with the tiles the reader is actually looking at.
    #[tokio::test]
    async fn a_rate_limited_prefetch_batch_is_abandoned_rather_than_walked_to_the_end() {
        let f = Fixture::new("prefetch-429");
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(GET).path("/grid/v17.webp");
            then.status(429).header("retry-after", "30");
        });
        let uri = format!("{}/grid/v17.webp?17", server.base_url());
        // Ten real cards, all uncached, all pointing at the endpoint that says no.
        let ids: Vec<String> = (0..10)
            .map(|i| format!("{i:08}-0000-0000-0000-000000000000"))
            .collect();
        for id in &ids {
            f.card(id, &uri);
        }
        let client = scryfall::Client::new(server.base_url());

        let attempted = warm(
            &f.cache,
            &client,
            &f.read,
            &f.write,
            prefetch_keys(&ids, Variant::Grid),
        )
        .await;

        assert_eq!(attempted, 1, "the batch stops at the key that was refused");
        // One request left the process, not ten: the nine after it never even reached the
        // gate, let alone the network.
        mock.assert_calls(1);
        assert_eq!(
            f.cached_row(&ids[9]),
            None,
            "nothing a refused batch touched is recorded as cached"
        );
    }

    /// The other end of the same clamp: a header that would park the image cache for a
    /// year buys itself five minutes.
    #[tokio::test]
    async fn a_hostile_retry_after_cannot_park_the_fetcher_for_years() {
        let f = Fixture::new("hostile");
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/grid/v17.webp");
            then.status(429).header("retry-after", "31536000");
        });
        f.card(BOLT, &format!("{}/grid/v17.webp?17", server.base_url()));
        let client = scryfall::Client::new(server.base_url());

        let err = f
            .get(&client, &key(BOLT, 0, Variant::Grid))
            .await
            .unwrap_err();

        assert!(
            matches!(
                err,
                ImageError::RateLimited {
                    retry_after_secs: 300
                }
            ),
            "{err:?}"
        );
        let ahead = f
            .cache
            .gate
            .lock()
            .await
            .saturating_duration_since(tokio::time::Instant::now());
        assert!(
            ahead <= Duration::from_secs(300),
            "a year of lockout is not something a header gets to ask for: {ahead:?}"
        );
    }

    /// A lockout is a deadline to report, not a queue to stand in. The tile that arrives
    /// during someone else's 429 must be told when to come back — in the time it takes to
    /// read a clock — rather than occupying a worker thread and a permit until the window
    /// closes. (Waiting it out would also mean a *second* rate limit could not report
    /// itself until the first sleeper woke, because the gate mutex was held across the
    /// sleep.)
    #[tokio::test]
    async fn a_request_during_a_penalty_is_refused_at_once_with_the_time_remaining() {
        let f = Fixture::new("penalty");
        let server = MockServer::start();
        let limited = server.mock(|when, then| {
            when.method(GET).path("/grid/v17.webp");
            then.status(429).header("retry-after", "60");
        });
        f.card(BOLT, &format!("{}/grid/v17.webp?17", server.base_url()));
        let client = scryfall::Client::new(server.base_url());
        let k = key(BOLT, 0, Variant::Grid);

        f.get(&client, &k).await.unwrap_err(); // earns the 60 s lockout

        let started = std::time::Instant::now();
        let err = tokio::time::timeout(Duration::from_secs(5), f.get(&client, &k))
            .await
            .expect("a request must not wait out a penalty it did not earn")
            .unwrap_err();

        assert!(
            started.elapsed() < Duration::from_secs(1),
            "answering took {:?}",
            started.elapsed()
        );
        assert!(
            matches!(err, ImageError::RateLimited { retry_after_secs }
                     if (55..=60).contains(&retry_after_secs)),
            "the wait reported must be what is left of the window: {err:?}"
        );
        assert_eq!(
            limited.calls(),
            1,
            "and it must not spend a request finding out"
        );
    }

    /// Two tiles can hit the same 429 window and come back with different `Retry-After`
    /// values. The shorter one arriving second must not release the app from the longer
    /// lockout that is already in force.
    #[tokio::test]
    async fn a_later_penalty_never_shortens_a_lockout_already_in_force() {
        let cache = Cache::new(PathBuf::from("D:\\app\\data\\images"));

        cache.penalise(Duration::from_secs(300)).await;
        cache.penalise(Duration::from_secs(30)).await;

        let ahead = cache
            .gate
            .lock()
            .await
            .saturating_duration_since(tokio::time::Instant::now());
        assert!(
            ahead > Duration::from_secs(290),
            "a 30 s penalty must not end a 300 s lockout: {ahead:?}"
        );
    }

    /// The bytes land whole or not at all. A re-fetch overwrites a file `image_cache`
    /// already calls current, so a half-written one is not a miss — it is torn bytes with
    /// a row that vouches for them, and nothing re-checks until Scryfall re-scans the
    /// card, which can be months away.
    #[tokio::test]
    async fn a_store_replaces_the_file_in_one_step_and_leaves_no_temporary_behind() {
        let dir = std::env::temp_dir().join("mtgtest-images-store");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("grid").join("00").join("bolt-0.webp");
        let left = |dir: &Path| -> Vec<String> {
            std::fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|n| !n.ends_with(".webp"))
                .collect()
        };

        store(&path, &[1u8; 64]).await.unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            vec![1u8; 64],
            "the shard directory is created on the way"
        );

        // Over an existing, longer file: `rename` replaces on Windows too, and a shorter
        // new image must not leave the tail of the old one behind it.
        store(&path, &[2u8; 8]).await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), vec![2u8; 8]);
        assert!(
            left(path.parent().unwrap()).is_empty(),
            "a temporary must not survive a store: {:?}",
            left(path.parent().unwrap())
        );

        // And the failure branch: a swap that cannot happen (here, a *directory* sitting
        // where the image goes) must clean up after itself rather than leave a `.tmp`
        // nothing will ever look for again.
        let blocked = dir.join("grid").join("00").join("blocked-0.webp");
        std::fs::create_dir_all(&blocked).unwrap();
        assert!(store(&blocked, &[3u8; 8]).await.is_err());
        assert!(
            left(blocked.parent().unwrap()).is_empty(),
            "a failed store must leave nothing behind: {:?}",
            left(blocked.parent().unwrap())
        );
    }

    /// A cache that cannot be written is still a cache that can serve the request in
    /// hand. A read-only data directory (a USB stick with the switch flipped, a locked-
    /// down Program Files) should cost the user a slower grid, never a blank one — and
    /// must never leave a row claiming bytes that are not there.
    #[tokio::test]
    async fn bytes_are_served_even_when_they_cannot_be_cached() {
        let f = Fixture::new("unwritable");
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/grid/v17.webp");
            then.status(200).body(vec![7u8; 16]);
        });
        f.card(BOLT, &format!("{}/grid/v17.webp?17", server.base_url()));
        let client = scryfall::Client::new(server.base_url());
        // A *file* where the variant directory has to go: `create_dir_all` cannot win
        // against that on any platform, and it needs no permission games to arrange.
        std::fs::create_dir_all(f.cache.dir()).unwrap();
        std::fs::write(f.cache.dir().join("grid"), b"not a directory").unwrap();

        let served = f.get(&client, &key(BOLT, 0, Variant::Grid)).await.unwrap();

        assert_eq!(served.bytes, vec![7u8; 16]);
        assert_eq!(served.content_type, WEBP);
        assert_eq!(
            f.cache.store_failures(),
            1,
            "the failure has to be findable"
        );
        assert_eq!(
            f.cached_row(BOLT),
            None,
            "a row must not vouch for bytes that were never stored"
        );
    }

    /// Nothing artificial stands between a screenful of tiles and their bytes.
    ///
    /// The gate this used to assert against was `api.scryfall.com`'s ≤10/s rule applied to
    /// `cards.scryfall.io`, which Scryfall documents as having **no** rate limit — and
    /// [`is_fetchable`] guarantees an image can come from nowhere else. It cost every cold
    /// screenful a 100 ms slot per tile, which is most of what "images load slowly" was.
    #[tokio::test]
    async fn consecutive_fetches_are_not_paced_apart() {
        const N: usize = 20;
        let f = Fixture::new("unpaced");
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET);
            then.status(200).body(vec![7u8; 4]);
        });
        let ids: Vec<String> = (0..N)
            .map(|i| format!("{i:08}-0000-0000-0000-000000000000"))
            .collect();
        for (i, id) in ids.iter().enumerate() {
            f.card(id, &format!("{}/grid/{i}.webp?1", server.base_url()));
        }
        let client = scryfall::Client::new(server.base_url());

        let started = std::time::Instant::now();
        for id in &ids {
            f.get(&client, &key(id, 0, Variant::Grid)).await.unwrap();
        }

        // The old gate forced an interval between fetch *starts*, so it costs (N-1) × 100 ms on
        // exactly this sequence whatever the origin does — **1 900 ms** here. Any bound under
        // that catches it coming back.
        //
        // **N is the margin, not the bound, and that is the correction of 2026-08-17.** This was
        // six fetches against 400 ms, on the stated reasoning that 400 was far enough above what
        // it measures to survive a busy CI runner. It was not: `rust (windows-latest)` read
        // **472 ms** and took `ci-ok` red on a pull request whose diff contained no Rust at all,
        // while the Linux half of the same matrix passed. At N = 6 the whole gap between healthy
        // and the defect is 500 ms, so there was nowhere left to raise the bound *to* — the dial
        // was wrong.
        //
        // **Which dial is right follows from where the time goes, measured here rather than
        // assumed** (2026-08-17, debug, this machine): N = 6 → 24.3 ms, N = 20 → 47.6 ms,
        // N = 40 → 77.4 ms, i.e. **≈ 15 ms fixed + ≈ 1.56 ms per fetch**. The fixed term is
        // `Fixture::new` and `MockServer::start` — a temp directory and a socket, exactly the
        // work that stalls on a loaded Windows runner, and the only plausible home for that
        // 472 ms (as a per-fetch cost it would be 76 ms, a 49× per-fetch slowdown on an
        // in-process mock). So the noise is essentially **fixed** and the defect is **per
        // fetch**: raising N moves the thing being detected and leaves the noise where it is.
        //
        // At N = 20 that buys both margins at once — healthy **47.6 ms**, defect **≈ 1 950 ms**,
        // and a 1 000 ms bound sits ~950 ms above healthy (more than twice the worst stall CI has
        // actually produced) and ~950 ms below the defect. Twenty sequential fetches against a
        // local mock cost nothing: the whole test runs in 0.08 s.
        assert!(
            started.elapsed() < Duration::from_millis(1_000),
            "{N} sequential fetches took {:?} — something is pacing them apart again",
            started.elapsed()
        );
    }

    /// The gate is still there, and it is still what a 429 is charged to: what changed is
    /// that it holds a *penalty* deadline and never a routine one. A cache that has earned
    /// nothing must let a fetch straight through.
    #[tokio::test]
    async fn an_unpenalised_gate_holds_nothing_back() {
        let cache = Cache::new(std::env::temp_dir().join("mtg-grimoire-test-gate"));

        assert!(
            cache.gate.lock().await.elapsed() >= Duration::ZERO,
            "a fresh gate must already be open"
        );

        cache.penalise(Duration::from_secs(120)).await;

        let remaining = cache
            .gate
            .lock()
            .await
            .saturating_duration_since(tokio::time::Instant::now());
        assert!(
            remaining > Duration::from_secs(115),
            "a penalty must still shut the gate: {remaining:?}"
        );
    }

    /// Task 6 spawns this future onto the async runtime, and whether that compiles comes
    /// down to whether a `!Send` `MutexGuard` is still alive at an `.await`. A
    /// compile-time assertion: reaching the end of the test means it held.
    #[test]
    fn the_get_future_is_send_so_the_protocol_can_spawn_it() {
        fn assert_send<T: Send>(_: &T) {}
        let cache = Cache::new(PathBuf::from("D:\\app\\data\\images"));
        let client = scryfall::Client::new("http://127.0.0.1:1".into());
        let read = Mutex::new(Connection::open_in_memory().unwrap());
        let write = Mutex::new(Connection::open_in_memory().unwrap());

        assert_send(&cache.get(&client, &read, &write, &key(BOLT, 0, Variant::Grid)));
    }

    fn header<'a>(r: &'a tauri::http::Response<Vec<u8>>, name: &str) -> Option<&'a str> {
        r.headers().get(name).and_then(|v| v.to_str().ok())
    }

    /// An empty scratch directory under `%TEMP%`, named for **this process** as well as for the
    /// test.
    ///
    /// The pid is a precaution, not a fix for anything measured. Every one of these tests
    /// removes its directory and recreates it a moment later, and on Windows a directory in the
    /// pending-delete state and a file an indexer or scanner has just opened both surface as
    /// `Access is denied` — so two `cargo test` processes sharing a fixed name (a rerun started
    /// before the last one's cleanup landed, an editor running the suite alongside a terminal)
    /// have a window in which one can fail the other. One red run of this suite has been seen
    /// and never reproduced in twenty-four more; **this does not diagnose it**, it removes a
    /// failure mode that could have caused it.
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mtgtest-covers-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Bytes, and permission to keep them for a day — not forever. The URL is stable
    /// across Scryfall re-scanning a card, so an immutable cache would pin a superseded
    /// picture inside the webview until the app is reinstalled.
    #[test]
    fn a_served_image_is_a_200_the_webview_may_cache_for_a_day() {
        let r = respond(Ok(Served {
            bytes: vec![0x52, 0x49, 0x46, 0x46],
            content_type: WEBP,
        }));

        assert_eq!(r.status(), tauri::http::StatusCode::OK);
        assert_eq!(header(&r, "content-type"), Some(WEBP));
        assert_eq!(header(&r, "cache-control"), Some("max-age=86400"));
        assert_eq!(r.body(), &vec![0x52u8, 0x49, 0x46, 0x46]);
    }

    /// A printing Scryfall has no art for is a **200**: there is nothing to retry, and a
    /// failure status would put a broken-image icon where the app has a considered answer.
    ///
    /// But it is the one 200 the webview may not keep. Every other image carries its own
    /// version in its URL, so a day of caching is bounded by the re-scan that ended it; a
    /// placeholder was never fetched from a URL at all, and the thing that replaces it —
    /// a sync that fills in the art, or a `soon.jpg` that finally becomes a picture —
    /// changes nothing the webview could notice. `no-store` is what makes the next look at
    /// that card ask again.
    #[test]
    fn a_placeholder_is_a_200_the_webview_may_not_keep() {
        let svg = placeholder_svg(Placeholder::NoImage, Variant::Grid);
        let r = respond(Ok(Served {
            bytes: svg.clone().into_bytes(),
            content_type: SVG,
        }));

        assert_eq!(r.status(), tauri::http::StatusCode::OK);
        assert_eq!(header(&r, "content-type"), Some(SVG));
        assert_eq!(header(&r, "cache-control"), Some("no-store"));
        assert_eq!(r.body(), &svg.into_bytes());
    }

    /// The fifth route, both answers. A cover that is there is bytes the webview may **not**
    /// keep — a cover's URL is the deck, not the picture, so the same URL has to answer with a
    /// new file the moment the user picks one. A cover that is not there is a **404 and never a
    /// placeholder**: the deck falls back to its card art in the webview, and a grey rectangle
    /// served from here would hide the picture the deck actually has.
    #[test]
    fn a_cover_route_serves_the_file_and_404s_when_there_is_none() {
        let dir = scratch("route");
        std::fs::write(cover_file(&dir, 7), b"webp-bytes").unwrap();

        let served = cover_response(std::fs::read(cover_file(&dir, 7)).ok());
        let missing = cover_response(std::fs::read(cover_file(&dir, 8)).ok());
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(served.status(), tauri::http::StatusCode::OK);
        assert_eq!(header(&served, "content-type"), Some(WEBP));
        assert_eq!(
            header(&served, "cache-control"),
            Some("no-store"),
            "a cover's bytes are meant to change under a stable URL"
        );
        assert_eq!(served.body(), b"webp-bytes");

        assert_eq!(missing.status(), tauri::http::StatusCode::NOT_FOUND);
        assert_eq!(header(&missing, "cache-control"), Some("no-store"));
    }

    /// The route is a **path**, and the id becomes a file name — so it is validated the way
    /// [`parse_request_path`] validates a card id, not sanitised. Parsing as an `i64` is the
    /// whole fence: nothing with a separator in it, in any encoding, survives it.
    #[test]
    fn a_cover_path_is_parsed_or_refused_and_never_repaired() {
        assert_eq!(parse_cover_path("/cover/7"), Some(7));
        assert_eq!(
            parse_cover_path("cover/7"),
            Some(7),
            "the leading slash is optional"
        );

        for refused in [
            "/cover",
            "/cover/",
            "/cover/7/8",
            "/cover/../../mtg.db",
            "/cover/..%2fmtg.db",
            "/cover/7.webp",
            "/cover/abc",
            "/cover/0",
            "/cover/-1",
            "/grid/7",
        ] {
            assert_eq!(
                parse_cover_path(refused),
                None,
                "`{refused}` must be refused"
            );
        }

        // And the two routes cannot both match: `cover` is not one of the four variants, so a
        // card request is never read as a cover and a cover request is never read as a card.
        assert!(Variant::parse(COVER_ROUTE).is_none());
        assert!(parse_cover_path("/art/0000419b-0bba-4488-8f7a-6194544ce91d/0").is_none());
    }

    /// **The cover route needs no CSP change, and that is why it is a route on this origin.**
    ///
    /// `app.security.csp` is configuration, so nothing else in the build can fail when it is
    /// loosened — `lib.rs`'s `the_shipped_csp_allows_ipc_and_images_and_nothing_wild` is the
    /// standing guard, and this is the claim *this* feature makes against it. A cover is an
    /// `<img>`, so `img-src` is the one directive it could have touched, and it is pinned here
    /// **whole**: a source added to it fails this test by name. Serving a cover from `file:`,
    /// `asset:` or a `blob:` would each have been exactly that, and a new source is the one
    /// change in this app that nothing else notices.
    ///
    /// `data:` is on the list already and is not the cover route's doing — it is the inline
    /// SVG placeholder's, which predates this by two plans.
    #[test]
    fn the_shipped_csp_is_untouched() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();

        let img_src = csp
            .split(';')
            .map(str::trim)
            .find(|d| d.starts_with("img-src"))
            .expect("the CSP must name img-src");
        assert_eq!(
            img_src, "img-src 'self' data: mtgimg: http://mtgimg.localhost",
            "a deck cover is a path on `mtgimg:`, so img-src must not have grown"
        );
        assert!(
            !csp.contains(COVER_ROUTE),
            "the route is a path, not a source: {csp}"
        );
    }

    /// A cover is stored at the **art crop's** dimensions, whatever shape the source was, so a
    /// custom cover and a card's art are interchangeable in every tile — one aspect ratio, no
    /// layout that shifts depending on which kind of cover a deck happens to have.
    ///
    /// Driven through a real PNG rather than a fixture file, so the whole pipeline runs:
    /// format guessed from the bytes, decoded, resampled to fill, re-encoded as WEBP. The
    /// source is deliberately the wrong aspect ratio *and* 16-bit-adjacent RGBA, which is what
    /// the `to_rgba8` conversion is for.
    #[test]
    fn a_cover_is_re_encoded_to_the_art_crops_shape() {
        let dir = scratch("encode");
        let source = dir.join("source.png");
        // Tall and narrow, so `resize_to_fill` has to crop rather than merely scale.
        let mut png = image::RgbaImage::new(64, 256);
        for (x, y, pixel) in png.enumerate_pixels_mut() {
            *pixel = image::Rgba([x as u8, y as u8, 128, 255]);
        }
        png.save(&source).unwrap();

        let encoded = encode_cover(&source).unwrap();

        let decoded = image::load_from_memory(&encoded).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            (decoded.width(), decoded.height()),
            COVER_VARIANT.dimensions(),
            "626x457, the `art` crop"
        );
        assert_eq!(COVER_VARIANT.dimensions(), (626, 457));
    }

    /// A file that is not an image is refused in words naming the file, rather than by a panic
    /// or by a cover written from nonsense — the user picked it out of a file dialog, and the
    /// thing they need told is which file.
    #[test]
    fn a_source_that_is_not_an_image_is_refused_by_name() {
        let dir = scratch("refuse");
        let source = dir.join("notes.txt");
        std::fs::write(&source, b"this is not a picture").unwrap();

        let refused = encode_cover(&source).unwrap_err();
        let absent = encode_cover(&dir.join("gone.png")).unwrap_err();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(refused.contains("notes.txt"), "{refused}");
        assert!(absent.contains("gone.png"), "{absent}");
    }

    /// [`MAX_COVER_SOURCE_PIXELS`] bounds the **product**, and it is read off the header before
    /// a pixel is decoded. Both halves are what this test is for, and the fixture proves them
    /// together: a PNG that is nothing but a valid `IHDR` claiming 20 000 × 20 000, with no
    /// image data at all behind it. 20 000 a side was *inside* the old per-side cap; 400
    /// megapixels is four times the new one; and since there is nothing to decode, a refusal
    /// that arrives at all is a refusal that arrived from the header.
    ///
    /// Written by hand rather than encoded, because encoding a source over the limit means
    /// allocating the 400 MB this constant exists to refuse.
    #[test]
    fn a_source_too_large_to_decode_is_refused_from_its_header_alone() {
        /// The one thing a hand-built PNG chunk needs that cannot be typed out: `png` validates
        /// every chunk's CRC-32 and stops at a bad one, which would refuse this file for the
        /// wrong reason.
        fn crc32(bytes: &[u8]) -> u32 {
            let mut crc = 0xFFFF_FFFF_u32;
            for &byte in bytes {
                crc ^= u32::from(byte);
                for _ in 0..8 {
                    crc = if crc & 1 == 1 {
                        (crc >> 1) ^ 0xEDB8_8320
                    } else {
                        crc >> 1
                    };
                }
            }
            !crc
        }

        /// `<length><type><data><crc>`, the shape every PNG chunk has.
        fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
            let mut body = Vec::from(*kind);
            body.extend_from_slice(data);
            let mut out = Vec::new();
            out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_be_bytes());
            out.extend_from_slice(&body);
            out.extend_from_slice(&crc32(&body).to_be_bytes());
            out
        }

        let dir = scratch("oversize");
        let source = dir.join("poster.png");
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&20_000_u32.to_be_bytes());
        ihdr.extend_from_slice(&20_000_u32.to_be_bytes());
        // 8-bit, colour type 6 (RGBA), deflate, adaptive filtering, no interlace.
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut png = Vec::from([0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        png.extend_from_slice(&chunk(b"IHDR", &ihdr));
        // An empty `IDAT` is where the header ends and the picture would begin. There are 400
        // million pixels' worth of nothing behind it, which is the point.
        png.extend_from_slice(&chunk(b"IDAT", &[]));
        png.extend_from_slice(&chunk(b"IEND", &[]));
        std::fs::write(&source, &png).unwrap();

        let refused = encode_cover(&source).unwrap_err();

        let _ = std::fs::remove_dir_all(&dir);
        assert!(refused.contains("poster.png"), "{refused}");
        assert!(
            refused.contains("20000 × 20000"),
            "the refusal says how big the picture was: {refused}"
        );
        assert_eq!(
            20_000_u64 * 20_000,
            400_000_000,
            "which is four times the budget, and was inside the old per-side cap"
        );
    }

    /// An id nothing resolves to is a caller error. A 404 rather than a placeholder,
    /// because a broken link must not be indistinguishable from a card with no art — and
    /// `no-store`, because the card can arrive in the very next sync and a heuristically
    /// cached 404 would outlive it.
    #[test]
    fn an_unknown_card_is_an_uncacheable_404() {
        let r = respond(Err(ImageError::UnknownCard));

        assert_eq!(r.status(), tauri::http::StatusCode::NOT_FOUND);
        assert_eq!(header(&r, "content-type"), Some("text/plain;charset=utf-8"));
        assert_eq!(header(&r, "cache-control"), Some("no-store"));
        assert!(header(&r, "retry-after").is_none());
    }

    /// The one case the grid can heal from on its own, so it is the one case that carries
    /// instructions: a **503** with the wait in seconds. The number is the *clamped* one
    /// the fetcher will actually honour — telling the UI to come back sooner than the gate
    /// opens is how a retry loop walks straight into a Scryfall ban.
    #[test]
    fn a_rate_limit_is_a_503_carrying_the_wait_the_fetcher_will_honour() {
        let r = respond(Err(ImageError::RateLimited {
            retry_after_secs: 30,
        }));

        assert_eq!(r.status(), tauri::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            header(&r, "retry-after"),
            Some("30"),
            "the header is what the grid schedules its retry from"
        );
        assert_eq!(header(&r, "cache-control"), Some("no-store"));
    }

    /// Everything else is a **502**: the app reached its own cache fine and the far end is
    /// what failed. Emphatically not a 200 with a placeholder — that would turn a
    /// five-second outage into a collection that is permanently artless, with no signal
    /// anywhere that a retry would fix it.
    #[test]
    fn every_other_failure_is_a_502_that_says_what_broke() {
        for e in [
            ImageError::Fetch("connection reset".into()),
            ImageError::Io("the disk is full".into()),
            ImageError::Db("database is locked".into()),
        ] {
            let expected = e.to_string();
            let r = respond(Err(e));
            assert_eq!(r.status(), tauri::http::StatusCode::BAD_GATEWAY);
            assert_eq!(header(&r, "cache-control"), Some("no-store"));
            assert_eq!(String::from_utf8(r.body().clone()).unwrap(), expected);
        }
    }

    /// A request that arrives before `setup` has managed the state — the webview and the
    /// first sync race at launch. Retryable, and the shortest honest wait, because the
    /// state appears within milliseconds.
    #[test]
    fn a_request_before_the_app_has_its_state_is_a_503_worth_retrying_at_once() {
        let r = not_ready();

        assert_eq!(r.status(), tauri::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(header(&r, "retry-after"), Some("1"));
    }

    /// Carryover item 3, ledgered twice: nothing deduplicated two requests for the same
    /// key in flight at once, so a tile and its own prefetch — or two prefetch loops from
    /// two pages that landed together — could each spend a permit and a round trip on the
    /// same bytes. One fetch per key, and the second caller reads what
    /// the first one wrote.
    #[tokio::test]
    async fn two_requests_for_one_image_make_one_round_trip() {
        const CARD: &str = "0000419b-0bba-4488-8f7a-6194544ce91d";
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(GET).path("/grid/front/0/0/x.webp");
            then.status(200)
                .header("content-type", "image/webp")
                .body(b"webp-bytes");
        });
        let f = Fixture::new("single-flight");
        f.card(
            CARD,
            &format!("{}/grid/front/0/0/x.webp?17", server.base_url()),
        );
        let client = scryfall::Client::new(server.base_url());
        let key = ImageKey {
            card_id: CARD.into(),
            face: 0,
            variant: Variant::Grid,
        };

        // Both start before either can have finished, which is the race a tile and its own
        // prefetch run every time a page lands.
        let (a, b) = tokio::join!(
            f.cache.get(&client, &f.read, &f.write, &key),
            f.cache.get(&client, &f.read, &f.write, &key),
        );

        assert_eq!(a.unwrap().bytes, b"webp-bytes");
        assert_eq!(
            b.unwrap().bytes,
            b"webp-bytes",
            "the waiter reads what the fetcher wrote"
        );
        mock.assert_calls(1);
    }

    /// One connection that *claims* a body of `declared` bytes and sends 32, then hangs up.
    ///
    /// Hand-written rather than an `httpmock` route because `httpmock` cannot be made to
    /// lie: hyper panics rather than write a response whose `Content-Length` disagrees with
    /// its body, and the lie is the whole point — a caller that read the body instead of
    /// refusing on the declared length gets 32 bytes and a broken-connection error, never
    /// "too large". That is what makes the assertion below about *ordering* and not merely
    /// about the cap.
    fn a_host_that_overstates_its_body(declared: u64) -> String {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            // The request, read and discarded: closing a socket with unread bytes still
            // waiting on it is how a clean hang-up becomes an RST the client reports
            // instead of the headers.
            let _ = stream.read(&mut [0u8; 2048]);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: image/webp\r\n\
                     content-length: {declared}\r\nconnection: close\r\n\r\n"
                )
                .as_bytes(),
            );
            let _ = stream.write_all(&[0u8; 32]);
            let _ = stream.flush();
        });
        base
    }

    /// Carryover item 7: `fetch_image` now has a production caller and points at a host
    /// that can serve whatever it likes. The largest variant this app stores is ~93 KB;
    /// a body that claims to be gigabytes is refused before it is read, not after.
    #[tokio::test]
    async fn an_oversized_image_body_is_refused_before_it_is_read() {
        let base = a_host_that_overstates_its_body(crate::scryfall::MAX_IMAGE_BYTES + 1);
        let client = crate::scryfall::Client::new(base.clone());

        let err = client
            .fetch_image(&format!("{base}/huge.webp?17"))
            .await
            .unwrap_err();

        assert!(err.to_string().contains("too large"), "{err}");
    }

    /// A host that declares no length at all, and keeps sending.
    ///
    /// `stop_after` is a safety net rather than the response's length: this host means to
    /// stream forever, and a client that read it to the end would run out of memory before
    /// it ran out of chunks. `sent` counts what actually left the socket, so the test can
    /// show the stream was *cut* rather than drained.
    fn a_host_that_streams_forever(stop_after: u64) -> (String, Arc<AtomicU64>) {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let sent = Arc::new(AtomicU64::new(0));
        let counter = Arc::clone(&sent);
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let _ = stream.read(&mut [0u8; 2048]);
            // No `content-length`, which is the whole point: chunked transfer is the shape
            // the cheap header check cannot see.
            if stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: image/webp\r\n\
                      transfer-encoding: chunked\r\n\r\n",
                )
                .is_err()
            {
                return;
            }
            let chunk = vec![0u8; 64 * 1024];
            let size = format!("{:x}\r\n", chunk.len());
            while counter.load(Ordering::Relaxed) < stop_after {
                if stream.write_all(size.as_bytes()).is_err()
                    || stream.write_all(&chunk).is_err()
                    || stream.write_all(b"\r\n").is_err()
                {
                    // The client hung up mid-stream, which is exactly the behaviour under
                    // test. Never send the terminating `0\r\n\r\n`: a client that got one
                    // would have a complete body rather than an abandoned one.
                    return;
                }
                counter.fetch_add(chunk.len() as u64, Ordering::Relaxed);
            }
        });
        (base, sent)
    }

    /// The half of the cap the `Content-Length` check cannot cover.
    ///
    /// A chunked response declares no length, so the header check waves it through and the
    /// only thing between this process and an unbounded body is that the body is read as a
    /// stream against a running total. Buffering first and measuring afterwards would be a
    /// report, not a cap — it would read every byte the host cared to send before deciding
    /// it was too many.
    #[tokio::test]
    async fn a_body_with_no_declared_length_is_cut_off_rather_than_drained() {
        // Eight times the cap: far more than any socket buffer can absorb, so reaching it
        // would mean the whole body really was read.
        let ceiling = crate::scryfall::MAX_IMAGE_BYTES * 8;
        let (base, sent) = a_host_that_streams_forever(ceiling);
        let client = crate::scryfall::Client::new(base.clone());

        let err = tokio::time::timeout(
            Duration::from_secs(20),
            client.fetch_image(&format!("{base}/endless.webp?17")),
        )
        .await
        .expect("a stream with no end must be cut off, not followed")
        .unwrap_err();

        assert!(err.to_string().contains("too large"), "{err}");
        assert!(
            sent.load(Ordering::Relaxed) < ceiling,
            "the host got to send all {ceiling} bytes, so nothing was reading with a bound"
        );
    }

    /// Spec §5's pre-warm, scoped to what the user owns rather than to the database — 116 k
    /// `grid` images would be ~7 GB. Resumable by construction: a key already in
    /// `image_cache` is not selected, so the next pass picks up where this one stopped.
    ///
    /// Three arms, because a card on screen is a card on screen: the collection, the
    /// wishlist, and — since the decks landed — every deck card. A user whose cards live
    /// only in decks would otherwise browse a gallery of cold tiles.
    #[test]
    fn the_prewarm_selects_owned_cards_that_are_not_cached_yet() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES ('0000419b-0bba-4488-8f7a-6194544ce91d','lea','161','en','nonfoil','NM',1,
                     unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,name,quantity,created_at,updated_at)
             VALUES ('o1','11111111-1111-4111-8111-111111111111','Wanted',1,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO decks (name, created_at, updated_at)
             VALUES ('Burn', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let deck = conn.last_insert_rowid();
        // A deck card is filed under a category since schema v8, and `category_id` is
        // `NOT NULL` — so the pile has to exist before anything can be in it.
        let main = crate::schema::tests::category(&conn, deck, "main", "Main deck");
        conn.execute(
            "INSERT INTO deck_cards
                (deck_id,category_id,card_id,set_code,collector_number,lang,name,quantity,
                 created_at,updated_at)
             VALUES (?1,?2,'ab000000-0000-0000-0000-000000000001','isd','51','en','Delver',
                     4,unixepoch(),unixepoch())",
            [deck, main],
        )
        .unwrap();

        let keys = prewarm_keys(&conn, 100).unwrap();
        assert_eq!(keys.len(), 3, "owned, wished and decked, front faces only");
        assert!(keys.iter().all(|k| k.face == 0));

        // **The pairing this whole function exists to get right**: each arm is warmed at the
        // variant the screen showing it actually draws. All three are [`Variant::Display`] today —
        // the collection and the wishlist draw whole cards, and so do the deck's stack and grid
        // views since they stopped drawing the bare art crop.
        //
        // Read off the constants rather than written out, because the *pairing* is the contract
        // and the two constants agreeing is a fact about today. Spelling `Grid` three times here
        // would make this test pass on the day one arm was pointed at the wrong picture — which
        // is the failure this function exists to prevent, and it is invisible in the app: the
        // pre-warm reports having warmed every card while the screen fetches every tile cold,
        // each variant being a different URL on the CDN.
        let variant_of = |id: &str| {
            keys.iter()
                .find(|k| k.card_id == id)
                .map(|k| k.variant)
                .unwrap()
        };
        assert_eq!(
            variant_of("0000419b-0bba-4488-8f7a-6194544ce91d"),
            COLLECTION_PREWARM,
            "an owned card is warmed at the variant the collection draws"
        );
        assert_eq!(
            variant_of("11111111-1111-4111-8111-111111111111"),
            COLLECTION_PREWARM,
            "a wished card is warmed at the variant the wishlist draws"
        );
        assert_eq!(
            variant_of("ab000000-0000-0000-0000-000000000001"),
            DECK_PREWARM,
            "a deck card is warmed at the variant the deck's card views draw"
        );

        // A card that is both owned and in a deck is **one** image while the two arms want the
        // same picture, and the `UNION` (never `UNION ALL`) is what makes that automatic rather
        // than something this function has to notice. It was two when the deck builder drew the
        // art crop — half the bytes for a collection that is mostly sleeved into decks.
        conn.execute(
            "INSERT INTO deck_cards
                (deck_id,category_id,card_id,set_code,collector_number,lang,name,quantity,
                 created_at,updated_at)
             VALUES (?1,?2,'0000419b-0bba-4488-8f7a-6194544ce91d','lea','161','en',
                     'Lightning Bolt',4,unixepoch(),unixepoch())",
            [deck, main],
        )
        .unwrap();
        assert_eq!(
            prewarm_keys(&conn, 100).unwrap().len(),
            3,
            "owned and decked is one key per picture the app will ask for, and that is one"
        );

        // Once the bytes are on disk the key is not selected again — which is the whole of
        // "resumable", and it costs no bookkeeping of its own.
        //
        // **Per variant**, which is the half worth driving even though nothing pairs two variants
        // today: a cached picture of a *different* shape must not mark a wanted one as done. So
        // cache the crop nobody asked for first and check the card is still wanted.
        conn.execute(
            "INSERT INTO image_cache (card_id, face, variant, source_uri, bytes, fetched_at)
             VALUES ('0000419b-0bba-4488-8f7a-6194544ce91d',0,'art','https://x?1',10,unixepoch())",
            [],
        )
        .unwrap();
        let after_art = prewarm_keys(&conn, 100).unwrap();
        assert_eq!(after_art.len(), 3);
        assert!(
            after_art
                .iter()
                .any(|k| k.card_id == "0000419b-0bba-4488-8f7a-6194544ce91d"
                    && k.variant == COLLECTION_PREWARM),
            "a cached `art` must not stand in for the whole card the screens draw"
        );

        // And the picture that *was* asked for retires it. Bound from the constant rather than
        // spelled, for the reason the assertions above are: the word here has to be whatever the
        // screens draw, and a literal would quietly stop meaning that the day one arm moved.
        conn.execute(
            "INSERT INTO image_cache (card_id, face, variant, source_uri, bytes, fetched_at)
             VALUES ('0000419b-0bba-4488-8f7a-6194544ce91d',0,?1,'https://x?1',10,unixepoch())",
            [COLLECTION_PREWARM.key()],
        )
        .unwrap();
        assert_eq!(prewarm_keys(&conn, 100).unwrap().len(), 2);
    }

    /// The bytes are on disk; the row that vouches for them is what a busy write connection
    /// used to lose — and it was never retried, so the file sat unread and every later
    /// request fetched it again for the life of the installation.
    #[test]
    fn a_record_owed_while_the_write_connection_is_busy_is_paid_off_later() {
        let dir = std::env::temp_dir().join("mtg-grimoire-test-pending");
        let cache = Cache::new(dir);
        let conn = seeded();
        let key = ImageKey {
            card_id: "0000419b-0bba-4488-8f7a-6194544ce91d".into(),
            face: 0,
            variant: Variant::Grid,
        };
        let uri = "https://cards.scryfall.io/grid/front/0/0/x.webp?17";
        let write = Mutex::new(conn);

        // The connection is held, exactly as an ingest holds it between batches.
        let held = write.lock().unwrap();
        cache.queue_record(&key, uri, 1234);
        assert_eq!(cache.pending_records(), 1, "the row is owed, not dropped");
        assert_eq!(
            cache.flush_records(&write, Duration::ZERO),
            0,
            "nothing can be written while the connection is held"
        );
        assert_eq!(
            cache.pending_records(),
            1,
            "a failed flush must leave the queue intact, not lose it"
        );
        drop(held);

        assert_eq!(cache.flush_records(&write, Duration::ZERO), 1);
        assert_eq!(cache.pending_records(), 0);

        let conn = write.lock().unwrap();
        assert!(
            is_current(&conn, &key, uri),
            "the row landed, so the bytes on disk are served from now on"
        );
        // And the freshness rule is unchanged: a re-scanned card carries a new cache-buster,
        // and that — not a clock, not an mtime — is what makes these bytes stale.
        assert!(
            !is_current(
                &conn,
                &key,
                "https://cards.scryfall.io/grid/front/0/0/x.webp?99"
            ),
            "a newer cache-buster is a different image and must be fetched"
        );
    }

    /// The queue is bounded. Overflow is counted rather than grown without limit — the cost
    /// is a re-fetch, and an app in this state has a larger problem than that.
    #[test]
    fn the_owed_record_queue_is_bounded_and_counts_what_it_drops() {
        let cache = Cache::new(std::env::temp_dir().join("mtg-grimoire-test-pending-cap"));
        for i in 0..MAX_PENDING_RECORDS + 5 {
            cache.queue_record(
                &ImageKey {
                    // Distinct, and still shaped like a Scryfall id.
                    card_id: format!("{i:08x}-0bba-4488-8f7a-6194544ce91d"),
                    face: 0,
                    variant: Variant::Grid,
                },
                "https://cards.scryfall.io/grid/front/0/0/x.webp?17",
                10,
            );
        }
        assert_eq!(cache.pending_records(), MAX_PENDING_RECORDS);
        assert_eq!(cache.dropped_records(), 5);
    }
}
