//! The disposable, bounded image cache and the resolution rule behind it.
//!
//! Four rules run through everything here:
//!
//! * **Per face, never per card.** 3.7% of printings carry no top-level `image_uris` at
//!   all — `transform`, `modal_dfc`, `double_faced_token`, `art_series` and
//!   `reversible_card` put them on the faces instead — so a lookup is a
//!   `(card, face, variant)` triple and the front/back distinction is physical.
//! * **The URI is the version.** Scryfall's `?<epoch>` cache-buster equals
//!   `image_updated_at`, so "are these bytes current" is a string comparison against the
//!   URI they came from. No clock, no mtime, nothing a FAT32 stick can round away. (The one
//!   modified time this module reads is [`evict`]'s used-stamp, which puts pictures in an
//!   order and never vouches for one.)
//!   The corollary is a rule in its own right: a URI with *no* cache-buster is one this
//!   cache must never hold, because bytes stored under it would answer "current" for the
//!   life of the installation ([`crate::image_uri::is_fetchable`]).
//! * **The cache is disposable.** `image_cache` records what was fetched; deleting
//!   `data/images` is always safe and costs only re-downloads (spec §8).
//! * **The cache is bounded, and what it spares is what the pre-warm owns.** Spec §8 called it
//!   *permanent*, and until 2026-09-28 nothing ever deleted a picture but the reader. Now
//!   [`evict`] runs on the `image-upkeep` thread: every picture of a card the reader owns, wants
//!   or has in a deck is kept at the variant the pre-warm fetches it at, and everything else is
//!   least-recently-used against [`BUDGET`] — see the "Upkeep" section below.
// `rate_limit_penalty` is the *API* client's clamp, imported rather than copied: the API's
// lockout and this cache's are separate deadlines over separate hosts, but they are one
// rule, and a second copy of a clamp is a second place for it to drift.
use crate::scryfall::{self, rate_limit_penalty, ScryfallError};
// The host allowlist and the resolution rule live in [`crate::image_uri`]; this module is the
// cache that reads them. IMAGE_HOST is imported rather than
// re-spelled because the stderr line below names it.
use crate::image_uri::IMAGE_HOST;
use crate::platform::clock::{Tick, Wall};
use crate::platform::files::{self, aio};
use crate::state::State;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
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
    /// Every variant, in [`crate::schema::IMAGE_VARIANTS`] order — and so every directory
    /// [`evict`]'s walk may enter. It lists these four names rather than reading `images/`,
    /// so a folder it does not know is a folder it never opens.
    pub const ALL: [Variant; 4] = [
        Variant::Thumb,
        Variant::Grid,
        Variant::Display,
        Variant::Art,
    ];

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

/// `<id>-<face>.webp`, found in `variant`'s directory → the key [`cache_path`] wrote it for,
/// or `None` for anything else.
///
/// The walk's half of the path-traversal fence, run in the other direction: the file name is
/// read off the disk rather than out of a URL, but it decides what gets **deleted**, so it is
/// held to [`parse_request_path`]'s standard — a Scryfall id, a face in range, one digit — and
/// [`walk`] then rebuilds the path from the key and keeps the file only if the two agree. A
/// `.tmp` a crashed [`store`] left, a file in the wrong shard or anything a person put there
/// is not a cache file, and nothing here will touch it.
fn parse_cache_file_name(name: &str, variant: Variant) -> Option<ImageKey> {
    let (card_id, face) = name.strip_suffix(".webp")?.rsplit_once('-')?;
    if face.len() != 1 {
        return None;
    }
    let face: u8 = face.parse().ok()?;
    if face > MAX_FACE || !is_card_id(card_id) {
        return None;
    }
    Some(ImageKey {
        card_id: card_id.to_owned(),
        face,
        variant,
    })
}

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

/// Resolve a key against `cards`, applying spec §5's rule: `image_uris` if present, else
/// `card_faces[i].image_uris`.
///
/// **The rule itself is [`crate::image_uri`]'s and this is the cache's reading of it.** Which
/// two columns, the face-first precedence and [`crate::image_uri::is_fetchable`] all live in a
/// module of their own, because `search.rs` needs the same three answers to put a URL on a
/// result row and a second copy of a precedence is exactly the drift this
/// repo's golden fence exists to prevent. What is left here is what the *cache* adds: a
/// placeholder for each way an image can be absent, and one line on stderr when the allowlist
/// and Scryfall's data stop agreeing.
///
/// **Read-only by contract.** Every caller passes the `db_read` connection: a card
/// picture must not queue behind an ingest — ~80 s of writing, in 2 000-row batches —
/// and it must never be the handle that takes a write lock.
pub fn resolve(conn: &Connection, key: &ImageKey) -> Result<Resolution, String> {
    let row = crate::image_uri::row(conn, &key.card_id, key.variant.key(), key.face as i64)?;

    let Some((top, face)) = row else {
        return Ok(Resolution::Unknown);
    };
    // Face first for anything past the front: a transform's back exists only on the face,
    // and a `meld` card's top-level image is its front and nothing else. Falling back to
    // the top-level image for face 1 would show the front of the card on its own back.
    if let Some(uri) = crate::image_uri::for_face(top, face, key.face) {
        // A URI this cache cannot version — or one from a host that does not serve card
        // art — is Scryfall saying "no image" in a shape that looks like a picture. It is
        // answered as the gap it is, here, before any of it reaches the network or the
        // disk. `NoImage` on either face: "Scryfall has no image for this" is exactly what
        // a `soon.jpg` means, and it stays true of a back face that never got scanned.
        return Ok(if crate::image_uri::is_fetchable(&uri) {
            Resolution::Uri(uri)
        } else {
            // Once per process, not once per tile: a CDN move would make this true of every
            // image in the app, and forty thousand identical lines is not a signal. The
            // version rule is the common case and is silent — a `soon.jpg` is Scryfall
            // saying "no image", which the placeholder already says. An *off-host* URI is
            // different: it means the allowlist and Scryfall's data no longer agree, and
            // the symptom (every card shows "No image") looks nothing like the cause.
            if !crate::image_uri::is_allowed_host(&uri) {
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

/// The on-disk image cache: lazy, bounded, paced.
///
/// *Permanent* until 2026-09-28, when [`evict`] arrived — and it is still permanent for every
/// picture the pre-warm owns, which is the part of the old word worth keeping.
pub struct Cache {
    dir: PathBuf,
    /// Caps images in flight. A grid that scrolls fast can queue hundreds of tiles.
    permits: async_lock::Semaphore,
    /// When the 429 penalty lifts. Scryfall's rate limit is per application, so a limit one
    /// request earns has to be paid by every request, not just that one.
    ///
    /// `None` — the gate open — for the whole of a normal session: since the pacing interval
    /// went, this carries a penalty and nothing else. A penalty is the moment it was charged
    /// and how long it runs: a [`Tick`] can be asked how long ago it was and cannot be moved
    /// forward, so the deadline is the pair.
    gate: Mutex<Option<(Tick, Duration)>>,
    /// Images fetched but not stored. A read-only data directory or a full disk costs the
    /// user a slower grid rather than a blank one, which is right — but it is also
    /// invisible, and a number that only ever climbs is what makes it findable.
    store_failures: AtomicU64,
    /// One lock per key, so two callers who want the same image do not both fetch it.
    ///
    /// A `Mutex<HashMap<ImageKey, Arc<async_lock::Mutex<()>>>>` rather than the shared
    /// *future* the carryover sketched: a `Shared<BoxFuture<…>>` has to be `'static`, which
    /// would mean an `Arc<Cache>` plus owned clones of the client and both connections
    /// threaded through the protocol handler. The second caller here waits on the key,
    /// then re-reads the disk — a 2 ms read instead of a shared buffer, for a fraction of
    /// the surface, and the network saving is identical.
    inflight: Mutex<HashMap<ImageKey, Arc<async_lock::Mutex<()>>>>,
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
    /// Pictures served from disk since the upkeep thread last wrote down that they were used.
    ///
    /// **This set is the whole cost a cache hit pays for eviction**: one uncontended mutex and
    /// one hash insert, and no I/O. The stamp itself is the file's modified time, which
    /// [`Cache::flush_touches`] moves forward in a batch on the `image-upkeep` thread — see
    /// [`evict`] for why the stamp lives on the file and not in `image_cache`.
    touched: Mutex<HashSet<ImageKey>>,
    /// Pictures written to disk this session: what the upkeep thread compares against
    /// [`STORES_PER_PASS`] to decide a pass is owed, since a store is the only way the cache
    /// grows.
    stores: AtomicU64,
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

/// How many served pictures [`Cache::touched`] holds between two flushes. The owed-row
/// queue's bound, for its reason: a key is a few dozen bytes, so this is well under a megabyte.
const MAX_TOUCHED: usize = 4_096;

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
            permits: async_lock::Semaphore::new(MAX_CONCURRENT_FETCHES),
            gate: Mutex::new(None),
            store_failures: AtomicU64::new(0),
            inflight: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            dropped_records: AtomicU64::new(0),
            touched: Mutex::new(HashSet::new()),
            stores: AtomicU64::new(0),
        }
    }

    /// Note that `key` was just served from disk. See [`Cache::touched`].
    ///
    /// Bounded like the owed-row queue, and for its reason. A key that does not fit is not
    /// counted: what it loses is that one picture looking older to the next pass than it is,
    /// and the set is drained every [`UPKEEP_TICK`] — the webview keeps what it was served for
    /// a day ([`IMAGE_MAX_AGE`]), so a minute of distinct hits is a few screenfuls, never
    /// thousands.
    fn touch(&self, key: &ImageKey) {
        let mut touched = crate::db::lock_plain(&self.touched);
        if touched.len() < MAX_TOUCHED || touched.contains(key) {
            touched.insert(key.clone());
        }
    }

    /// Write down, on each file, that the pictures served since the last call were used —
    /// by setting its modified time to `now`. Returns how many files took the stamp.
    ///
    /// **Never on the path that served them.** Each is an open and a metadata write, and a
    /// served tile pays for neither: [`spawn_upkeep`]'s thread calls this once a tick, and
    /// [`evict`] calls it first so the pass it runs sees them.
    ///
    /// A file that is gone — swept by [`crate::reset::clear_cache`], evicted, never stored —
    /// is skipped, and **the open never creates one**. That is the property worth the test: an
    /// empty file at a key's path, under a row that vouches for it, would be served as a
    /// zero-byte picture until Scryfall next re-scanned the card.
    pub fn flush_touches(&self, now: Wall) -> usize {
        let owed: Vec<ImageKey> = crate::db::lock_plain(&self.touched).drain().collect();
        owed.iter()
            .filter_map(|key| cache_path(&self.dir, key))
            .filter(|path| stamp_used(path, now).is_ok())
            .count()
    }

    /// How many pictures this session has written to disk.
    pub fn stores(&self) -> u64 {
        self.stores.load(Ordering::Relaxed)
    }

    /// Hold a row until the write connection is free.
    fn queue_record(&self, key: &ImageKey, uri: &str, bytes: usize) {
        let mut pending = crate::db::lock_plain(&self.pending);
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
        if crate::db::lock_plain(&self.pending).is_empty() {
            return 0;
        }
        let Some(conn) = crate::db::lock_for(write, wait) else {
            return 0;
        };
        // Drained only once the connection is in hand, so a failed lock leaves the queue
        // exactly as it was rather than losing it to a lock that never came.
        let owed: Vec<(ImageKey, PendingRecord)> =
            crate::db::lock_plain(&self.pending).drain().collect();
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
        crate::db::lock_plain(&self.pending).len()
    }

    /// Throw the owed rows away, and answer how many went.
    ///
    /// **The one caller is [`crate::reset::clear_cache`], and this exists because that sweep
    /// deletes the files these rows vouch for.** Every entry in the queue says "bytes for this
    /// key are on disk, write the row when the connection frees up" — which stops being true
    /// the moment the sweep passes, and the next served image would flush the queue and assert
    /// it anyway. A row claiming bytes that are gone costs a permanent re-fetch of that key
    /// (`get` reads `cached` from the row, fails the file read, and re-fetches — every time),
    /// which is the exact leak [`Cache::flush_records`] was written to close.
    ///
    /// Dropping rather than flushing, and only ever after the files have gone: what is lost is
    /// bookkeeping for pictures that no longer exist.
    pub fn forget_pending(&self) -> usize {
        let mut pending = crate::db::lock_plain(&self.pending);
        let owed = pending.len();
        pending.clear();
        owed
    }

    /// Put a row in the owed queue without a fetch, for the sweep's test.
    ///
    /// [`Cache::queue_record`] is private and reached only from the store path, which needs a
    /// network round trip to get to. `reset`'s test needs a *populated* queue and nothing else,
    /// so this is the one line of it — `#[cfg(test)]`, so it does not exist in the shipped
    /// binary and cannot become a second way to enqueue.
    #[cfg(test)]
    pub fn queue_record_for_test(&self, card_id: &str, uri: &str, bytes: usize) {
        self.queue_record(
            &ImageKey {
                card_id: card_id.to_owned(),
                face: 0,
                variant: Variant::Thumb,
            },
            uri,
            bytes,
        );
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
    fn key_lock(&self, key: &ImageKey) -> Arc<async_lock::Mutex<()>> {
        let mut map = crate::db::lock_plain(&self.inflight);
        Arc::clone(
            map.entry(key.clone())
                .or_insert_with(|| Arc::new(async_lock::Mutex::new(()))),
        )
    }

    /// Drop the entry once nobody is holding it. Without this the map is a leak with a
    /// pleasant name: one entry per image the app has ever served.
    ///
    /// Called only after this caller's own `Arc` has gone — a count of one then means the
    /// map is the last owner, and any caller still waiting on the key is holding a clone
    /// that keeps the entry (and therefore the coalescing) alive.
    fn release_key(&self, key: &ImageKey) {
        let mut map = crate::db::lock_plain(&self.inflight);
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
            let conn = crate::db::lock_blocking(read);
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
            if let Ok(bytes) = aio::read(&path).await {
                // A hit is the likeliest moment for the write connection to be free, so it
                // is the best moment to pay off any rows owed from a busier one. Costs one
                // uncontended mutex when nothing is owed, which is almost always.
                self.flush_records(write, Duration::ZERO);
                // The one thing eviction asks of a hit, and it is not I/O: the stamp is written
                // on the upkeep thread, never here.
                self.touch(key);
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
            let conn = crate::db::lock_blocking(read);
            is_current(&conn, key, uri)
        };
        if fresh {
            if let Ok(bytes) = aio::read(path).await {
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
                self.stores.fetch_add(1, Ordering::Relaxed);
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
        let _permit = self.permits.acquire().await;
        if let Some(remaining) = self.lockout_remaining() {
            return Err(ImageError::RateLimited {
                retry_after_secs: secs_rounded_up(remaining),
            });
        }

        match client.fetch_image(uri).await {
            Ok(bytes) => Ok(bytes),
            Err(ScryfallError::RateLimited { retry_after_secs }) => {
                // The penalty is per application, so it applies to everyone: push the
                // gate out so no other tile even starts until the window has passed.
                let penalty = rate_limit_penalty(retry_after_secs);
                self.penalise(penalty);
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
    fn penalise(&self, penalty: Duration) {
        let mut gate = crate::db::lock_plain(&self.gate);
        let left = gate.map_or(Duration::ZERO, |(charged, runs)| {
            runs.saturating_sub(charged.elapsed())
        });
        if penalty > left {
            *gate = Some((Tick::now(), penalty));
        }
    }

    /// What is left of a rate limit's lockout, or `None` while the gate is open.
    fn lockout_remaining(&self) -> Option<Duration> {
        let (charged, runs) = (*crate::db::lock_plain(&self.gate))?;
        let left = runs.saturating_sub(charged.elapsed());
        (!left.is_zero()).then_some(left)
    }
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
/// what the open card already draws — `CardModalArt` names `display` outright, as the docked pane
/// and its `PrintingPreview` did before they were deleted on 2026-09-03 — so a card the reader
/// opens is now one cache key instead of two.
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
/// all three of which draw a *cover*, and a cover is [`Variant::Art`] itself since 2026-08-31:
/// `decks.cover_card_id`'s art crop is the only kind there is, so those surfaces are asking for
/// exactly the picture this constant would have warmed at a different size — and the theory diff,
/// whose picture is a 32×44 decoration in a list that spells the card's name out beside it. Those
/// fetch on demand; a dialog the reader opens deliberately does not need warming, and the gallery
/// warms its own covers in `DecksPage`.
pub const DECK_PREWARM: Variant = Variant::Display;

/// Every card the reader owns, wants or has put in a deck, **paired with the variant the screen
/// that shows it draws** — `?1` is [`COLLECTION_PREWARM`] and `?2` [`DECK_PREWARM`].
///
/// **One literal with two readers, and the sharing is the contract.** [`prewarm_keys`] fetches
/// the rows of it that are not on disk; [`spared_keys`] answers the rows [`evict`] may never
/// delete. Two copies would drift, and the drift is the one failure eviction can make that
/// costs more than a re-fetch: a picture the pre-warm wants and the budget evicts is fetched
/// back at the next pre-warm and evicted again at the next pass, for the life of the
/// installation, with nothing anywhere saying so.
const WANTED: &str = "WITH wanted(card_id, variant) AS (
            SELECT card_id, ?1 FROM collection_entries
            UNION
            SELECT card_id, ?1 FROM wishlist_entries WHERE card_id IS NOT NULL
            UNION
            SELECT card_id, ?2 FROM deck_cards)";

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
    let mut stmt = conn.prepare(&format!(
        "{WANTED}
         SELECT w.card_id, w.variant FROM wanted w
          WHERE NOT EXISTS (
                SELECT 1 FROM image_cache c
                 WHERE c.card_id = w.card_id AND c.variant = w.variant AND c.face = 0)
          LIMIT ?3"
    ))?;
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

/// Walk a batch, stopping at the first rate limit. Returns how many keys were attempted.
///
/// Split out of [`prefetch_images`] because that command needs a `tauri::State` and a
/// running app, and the abandon-on-429 rule is exactly the part worth a test.
pub async fn warm(
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

// ── Upkeep: the budget, and the pass that keeps it ─────────────────────────────────────────

/// How many bytes of pictures the reader has **not** made their own this cache keeps —
/// **512 MiB**, about 5,770 `display` images at ~93 KB.
///
/// **A spared picture is outside it, and that is what lets it be this small.** A card in the
/// collection, the wishlist or a deck is kept at the variant the pre-warm fetches it at
/// ([`spared_keys`]) whatever that costs — a 10,000-card collection is ~930 MB of those alone,
/// bounded by what the reader owns, which is spec §5's own scoping argument. What this number
/// bounds is everything else: the search walls, the printings dialog, the backs of double-faced
/// cards, deck covers' `art` crops, the home page's `grid` tiles, and the `grid` files every
/// other surface stopped reading on 2026-08-20.
///
/// The arithmetic, against what this repo has measured:
///
/// * **One pre-warm pass is 186 MB** ([`MAX_PREWARM`] × 93 KB) and this is 2.9× that. The
///   pre-warm's set is spared outright, so the two could not fight at any size; the `const`
///   assertion below holds the line anyway, as a second fence behind the first.
/// * **The largest wall `image-cache.md` records is All tokens, 4,357 tiles** (its 2026-09-28
///   live pass), ~405 MB at `display`. It fits whole, so a reader who scrolls it to the end and
///   back is not evicting the top of it on the way down.
/// * **The whole cache measured on 2026-08-20 was 329.7 MB in 5,540 files**, owned cards
///   included. That reader is under this, which is why [`MAX_IDLE`] exists: a budget alone
///   would never have deleted the `grid` files that asked for eviction in the first place.
const CACHE_BUDGET_BYTES: u64 = 512 * 1024 * 1024;

const _: () = assert!(CACHE_BUDGET_BYTES > MAX_PREWARM as u64 * 93_000);

/// How long an unspared picture may go unread before it goes, budget or no budget — **90 days**.
///
/// A choice rather than a measurement, and what it trades is disk against one re-fetch — ~127 ms
/// cold, from a host with no rate limit — of a card the reader comes back to after a season
/// away. It is the half of eviction that reaches the `grid` files the 2026-08-20 move left: the
/// home page's recently-viewed tiles are the only thing that still draws `grid`, so those stay
/// fresh, and the last of the rest go at the first pass after 2026-11-18 — sooner under the
/// budget.
///
/// Many times the stamp's own resolution, which is about a day: the webview keeps what it was
/// served for [`IMAGE_MAX_AGE`], so a picture on screen every day reaches [`Cache::get`] — and is
/// touched — about once a day.
const MAX_IDLE: Duration = Duration::from_secs(90 * 24 * 60 * 60);

/// [`CACHE_BUDGET_BYTES`] and [`MAX_IDLE`] together, so a test can hand [`evict`] a small cache.
#[derive(Debug, Clone, Copy)]
struct Budget {
    bytes: u64,
    idle: Duration,
}

const BUDGET: Budget = Budget {
    bytes: CACHE_BUDGET_BYTES,
    idle: MAX_IDLE,
};

/// How often the upkeep thread wakes: to stamp what was served since, and to see whether a pass
/// is owed.
pub const UPKEEP_TICK: Duration = Duration::from_secs(60);

/// Pictures stored between two passes — ~46 MB at `display`, so the cache overshoots its budget
/// by at most 9% of it before a pass brings it back. The launch's pass runs one tick in, whatever
/// this says.
const STORES_PER_PASS: u64 = 500;

/// How long a pass waits for the write connection to drop the rows of what it deleted. Short,
/// because a held connection means a sync — and a row left behind is a row outliving its file,
/// the supported state, which the next pass reaps.
const EVICT_LOCK_WAIT: Duration = Duration::from_secs(1);

/// What one [`evict`] pass did: the upkeep thread's log line, and what the tests read.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Upkeep {
    /// Files that took a used-stamp before the walk ([`Cache::flush_touches`]).
    touched: u64,
    /// Cache files deleted.
    files: u64,
    /// Their size, as the walk read it.
    bytes: u64,
    /// Files chosen that would not go — held open without share-delete by something else, on
    /// Windows. Their rows stay, so each is still a consistent pair, and the next pass chooses
    /// it again.
    failed: u64,
    /// `image_cache` rows dropped: the deleted files' and any whose file was already gone.
    rows: u64,
    /// Rows left because the write connection was not had within [`EVICT_LOCK_WAIT`]. Each is a
    /// row outliving its file, and the next pass reaps it.
    rows_owed: u64,
}

/// One picture the walk found.
#[derive(Debug, Clone)]
struct OnDisk {
    key: ImageKey,
    bytes: u64,
    /// When it was last used, as far as this cache has written down: the file's modified time,
    /// which [`store`] sets by writing it and [`Cache::flush_touches`] moves forward. `None`
    /// when the filesystem would not say, and a picture that cannot be dated is never evicted.
    used: Option<Wall>,
}

/// Set `path`'s modified time to `when` — the used-stamp.
///
/// **It never creates the file**, which is [`files::set_modified`]'s own promise: a key whose
/// file is gone must stay gone. See [`Cache::flush_touches`] for what an empty file there
/// would cost.
fn stamp_used(path: &Path, when: Wall) -> std::io::Result<()> {
    files::set_modified(path, when)
}

/// Every cache file under `images_dir`, with its size and its used-stamp.
///
/// **Bounded by the layout rather than by a counter, and blind to everything but the layout.**
/// It enters the four [`Variant::ALL`] directories by name, the shard directories inside them,
/// and the files inside those; it follows no symlink (a `DirEntry`'s type is the link's own);
/// and it keeps a file only when [`parse_cache_file_name`] reads a key out of its name **and**
/// [`cache_path`] rebuilds exactly that path from the key. So the paths [`evict`] deletes are
/// paths this cache writes, and nothing else under `data/` can become one.
///
/// **On Windows it is one directory listing per shard and no call per file**: `DirEntry`'s
/// metadata there comes out of the listing itself (the standard library documents it as making
/// no extra system call), which is where both the size and the stamp are read from.
///
/// **A folder that is not there is an empty one** — no picture of that variant was ever
/// stored, or [`crate::reset::clear_cache`] is mid-sweep — and that is [`files::listing`]'s
/// `None`. Anything else (a permission, an I/O error, on a folder or on one entry of it) is
/// returned, and [`evict`] then does nothing at all: a partial walk would read every file it
/// missed as gone and reap the rows that vouch for them.
fn walk(images_dir: &Path) -> std::io::Result<Vec<OnDisk>> {
    let mut found = Vec::new();
    for variant in Variant::ALL {
        let Some(shards) = files::listing(&images_dir.join(variant.key()))? else {
            continue;
        };
        for shard in shards.iter().filter(|e| e.kind == files::Kind::Dir) {
            let Some(pictures) = files::listing(&shard.path)? else {
                continue;
            };
            for file in pictures.into_iter().filter(|e| e.kind == files::Kind::File) {
                let Some(key) = parse_cache_file_name(&file.name, variant) else {
                    continue;
                };
                if cache_path(images_dir, &key).as_deref() != Some(file.path.as_path()) {
                    continue;
                }
                // Found, even when it cannot be measured: a file that is there keeps its row.
                found.push(OnDisk {
                    key,
                    bytes: file.len.unwrap_or(0),
                    used: file.modified,
                });
            }
        }
    }
    Ok(found)
}

/// The pictures [`evict`] may never delete: **exactly the keys [`prewarm_keys`] would fetch if
/// they were missing** — the same [`WANTED`] rows, face 0, at the variant each is paired with.
///
/// Sparing anything less makes the two fight (see [`WANTED`]); sparing more — every face, every
/// variant of an owned card — would keep the art crops and backs the reader looked at once, and
/// those are what the budget is for. An unreadable row is an error rather than a card left
/// unspared, so a bad read stops the pass instead of deleting part of the collection's pictures.
fn spared_keys(conn: &Connection) -> rusqlite::Result<HashSet<ImageKey>> {
    let mut stmt = conn.prepare(&format!("{WANTED} SELECT card_id, variant FROM wanted"))?;
    let rows = stmt.query_map(params![COLLECTION_PREWARM.key(), DECK_PREWARM.key()], |r| {
        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut spared = HashSet::new();
    for row in rows {
        let (Some(card_id), variant) = row? else {
            continue;
        };
        if let Some(variant) = Variant::parse(&variant) {
            spared.insert(ImageKey {
                card_id,
                face: 0,
                variant,
            });
        }
    }
    Ok(spared)
}

/// Every `image_cache` row, with its `fetched_at`.
fn cached_rows(conn: &Connection) -> rusqlite::Result<Vec<(ImageKey, i64)>> {
    let mut stmt = conn.prepare("SELECT card_id, face, variant, fetched_at FROM image_cache")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (card_id, face, variant, fetched_at) = row?;
        let (Ok(face), Some(variant)) = (u8::try_from(face), Variant::parse(&variant)) else {
            continue;
        };
        out.push((
            ImageKey {
                card_id,
                face,
                variant,
            },
            fetched_at,
        ));
    }
    Ok(out)
}

/// Which of `found` go, as indices into it: **least recently used first**, among the pictures
/// `spared` does not claim.
///
/// A picture goes when the unspared bytes still on disk exceed `budget.bytes`, or when nobody
/// has used it within `budget.idle` of `now`. Both are read off one oldest-first order, so the
/// walk stops at the first picture that is neither — everything after it is newer, and the rest
/// already fits.
///
/// An undated picture is never chosen, and its bytes still count against the budget: they are
/// on the disk whether or not this can put them in order. Ties break on the key, so a pass over
/// the same disk chooses the same files.
fn choose_evictions(
    found: &[OnDisk],
    spared: impl Fn(&ImageKey) -> bool,
    budget: Budget,
    now: Wall,
) -> Vec<usize> {
    let unspared: Vec<usize> = (0..found.len())
        .filter(|&i| !spared(&found[i].key))
        .collect();
    let mut over: u64 = unspared.iter().map(|&i| found[i].bytes).sum();
    let mut oldest_first: Vec<(Wall, usize)> = unspared
        .iter()
        .filter_map(|&i| Some((found[i].used?, i)))
        .collect();
    oldest_first.sort_by(|(a, i), (b, j)| {
        let (x, y) = (&found[*i].key, &found[*j].key);
        a.cmp(b)
            .then_with(|| x.card_id.cmp(&y.card_id))
            .then_with(|| x.face.cmp(&y.face))
            .then_with(|| x.variant.key().cmp(y.variant.key()))
    });
    let idle_before = now.checked_sub(budget.idle);

    let mut chosen = Vec::new();
    for (used, i) in oldest_first {
        let idle = idle_before.is_some_and(|cut| used < cut);
        if !idle && over <= budget.bytes {
            break;
        }
        chosen.push(i);
        over = over.saturating_sub(found[i].bytes);
    }
    chosen
}

/// Drop the rows of `keys`, but only those written before the pass began — one transaction.
///
/// The `fetched_at < ?4` is what makes deleting the file first safe against a fetch landing in
/// the middle of the pass: a key re-fetched after the pass started carries a newer row, which
/// vouches for a newer file, and both are left alone. `started` is whole seconds and so is
/// `unixepoch()`, so a row written in the pass's own second is kept — the safe side of the tie.
fn drop_rows(conn: &Connection, keys: &[ImageKey], started: i64) -> rusqlite::Result<u64> {
    let tx = conn.unchecked_transaction()?;
    let mut dropped = 0u64;
    {
        let mut stmt = tx.prepare(
            "DELETE FROM image_cache
              WHERE card_id = ?1 AND face = ?2 AND variant = ?3 AND fetched_at < ?4",
        )?;
        for key in keys {
            dropped += stmt.execute(params![
                key.card_id,
                key.face as i64,
                key.variant.key(),
                started
            ])? as u64;
        }
    }
    tx.commit()?;
    Ok(dropped)
}

/// One eviction pass: stamp what was served, walk the disk, delete what the budget and the idle
/// horizon choose, and drop the rows that vouched for it. Runs on the `image-upkeep` thread and
/// nowhere near a served picture.
///
/// **The used-stamp is each file's modified time, and not a column — which is why this needed no
/// schema rung.** `image_cache` is on the corpus side, and the corpus is the file this app
/// deletes and rebuilds when it will not open, or when a rung fails (`schema::prepare_database`);
/// the rows go with it and the files do not. An evictor that read the rows could not see those
/// files at all, so the bound it kept would be the one a rebuilt corpus quietly escapes. This
/// walks the disk instead, which it would have to do regardless, and on Windows the walk hands
/// over each file's modified time for free ([`walk`]). **Nothing here waits on the operating
/// system to update a timestamp by itself** — last-access times are off on most Windows volumes
/// and are never read. The stamp is written deliberately: by [`store`] when a picture lands, and
/// by [`Cache::flush_touches`] when one is served. The module header's "no mtime" rule is about
/// *freshness* and is untouched — whether the bytes are current is still the URI comparison; a
/// FAT32 stick rounding a used-stamp to two seconds moves a picture in a queue measured in days.
///
/// **Order: the file, then its row.** Every interruption between the two — a crash, a sync
/// holding the write connection past [`EVICT_LOCK_WAIT`] — leaves a row that outlives its file:
/// [`Cache::get`] reads "cached", fails the read and fetches, which is the supported state
/// [`crate::reset::clear_cache`] leans on too, and the next pass reaps the row. The other order
/// would leave bytes that no row vouches for, which nothing ever serves.
///
/// **Reaping is the pass's second job**: a row whose file the walk did not find is dropped too.
/// Before this, a reader who deleted `data/images` kept every row, and [`prewarm_keys`]'s
/// `NOT EXISTS` read those rows as pictures on disk — so the collection was never warmed again.
///
/// Never deleted: anything [`walk`] did not parse as its own, a [`spared_keys`] picture, one
/// whose row is still owed ([`Cache::pending`] — it has just landed), and one it cannot date.
/// **A walk that fails deletes nothing**, for the reason [`walk`] gives.
fn evict(
    cache: &Cache,
    read: &Mutex<Connection>,
    write: &Mutex<Connection>,
    budget: Budget,
    now: Wall,
) -> Result<Upkeep, String> {
    let mut done = Upkeep {
        touched: cache.flush_touches(now) as u64,
        ..Upkeep::default()
    };
    let started = now.as_secs().max(0);

    let found =
        walk(&cache.dir).map_err(|e| format!("could not read {}: {e}", cache.dir.display()))?;
    let (spared, rows) = {
        let conn = crate::db::lock_blocking(read);
        (
            spared_keys(&conn).map_err(|e| e.to_string())?,
            cached_rows(&conn).map_err(|e| e.to_string())?,
        )
    };
    let owed: HashSet<ImageKey> = crate::db::lock_plain(&cache.pending)
        .keys()
        .cloned()
        .collect();

    let chosen = choose_evictions(
        &found,
        |key| spared.contains(key) || owed.contains(key),
        budget,
        now,
    );
    let mut forget: Vec<ImageKey> = Vec::new();
    for i in chosen {
        let picture = &found[i];
        let Some(path) = cache_path(&cache.dir, &picture.key) else {
            continue;
        };
        match files::remove(&path) {
            Ok(()) => {
                done.files += 1;
                done.bytes += picture.bytes;
                forget.push(picture.key.clone());
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => forget.push(picture.key.clone()),
            Err(_) => done.failed += 1,
        }
    }

    let on_disk: HashSet<&ImageKey> = found.iter().map(|f| &f.key).collect();
    forget.extend(
        rows.into_iter()
            .filter(|(key, fetched_at)| *fetched_at < started && !on_disk.contains(key))
            .map(|(key, _)| key),
    );
    if forget.is_empty() {
        return Ok(done);
    }
    let Some(conn) = crate::db::lock_for(write, EVICT_LOCK_WAIT) else {
        done.rows_owed = forget.len() as u64;
        return Ok(done);
    };
    done.rows = drop_rows(&conn, &forget, started).map_err(|e| e.to_string())?;
    Ok(done)
}

/// One wake of a host's upkeep loop: the one caller of [`evict`] and of
/// [`Cache::flush_touches`].
///
/// **The pass is here and the loop is the host's.** The desktop calls this from its
/// `image-upkeep` thread, which sleeps [`UPKEEP_TICK`] between calls (`spawn_upkeep`, in
/// `src-tauri`); a host with no thread to sleep on has no files to evict either.
/// `stores_at_last_pass` is the loop's one piece of memory, and starts `None`.
///
/// The first wake runs a pass — a minute after launch, so the
/// window, the facet index and the first page of tiles are not competing with a directory walk —
/// and after that a pass is owed once [`STORES_PER_PASS`] pictures have landed since the last,
/// because a store is the only thing that grows the cache. Every other wake just stamps what was
/// served, so the used-stamps lag the reader by a minute at most, and what a quit loses is the
/// last minute's.
///
/// **A pass waits out a sync** rather than running beside one: the ingest holds the write
/// connection for ~80 s, and a pass that could not drop its rows would only leave them for the
/// next. A pass that fails is written to the error log (`image_store`, `image_evict`) and is not
/// retried until the next one is owed, so an unreadable folder costs one row per 500 pictures
/// rather than one a minute.
///
/// Nothing waits on it, and a process that exits mid-pass leaves the interruption [`evict`]'s
/// order was chosen for.
pub fn upkeep_tick(state: &State, stores_at_last_pass: &mut Option<u64>) {
    let stores = state.images.stores();
    let owed = stores_at_last_pass.is_none_or(|at| stores.saturating_sub(at) >= STORES_PER_PASS);
    if !owed || state.syncing.load(Ordering::Relaxed) {
        state.images.flush_touches(Wall::now());
        return;
    }
    *stores_at_last_pass = Some(stores);
    match evict(
        &state.images,
        state.reader(),
        &state.db,
        BUDGET,
        Wall::now(),
    ) {
        Ok(done) if done.files > 0 || done.rows > 0 || done.failed > 0 || done.rows_owed > 0 => {
            eprintln!(
                "image cache: evicted {} files ({} bytes), dropped {} rows; \
                         {} would not go, {} rows owed, {} stamped used",
                done.files, done.bytes, done.rows, done.failed, done.rows_owed, done.touched
            )
        }
        Ok(_) => {}
        Err(e) => {
            eprintln!("image cache: eviction pass skipped: {e}");
            state.images.note(
                &state.db,
                crate::errors::Source::ImageStore,
                "image_evict",
                &ImageError::Io(e),
                &state.images.dir().display().to_string(),
            );
        }
    }
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
        aio::create_dir_all(parent).await?;
    }
    let tmp = path.with_extension(format!("{}.tmp", WRITE_SEQ.fetch_add(1, Ordering::Relaxed)));
    aio::write(&tmp, bytes).await?;
    if let Err(e) = aio::rename(&tmp, path).await {
        // Nothing will ever look for this name again, so a failed swap must not leave it.
        let _ = aio::remove(&tmp).await;
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
        let conn = crate::schema::memory_pair();
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
            let dir = crate::scratch::path(&format!("images-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();

            let write = crate::db::open_write(&dir).unwrap();
            crate::schema::build_pair(&write);
            let read = crate::db::open_read(&dir).unwrap();

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
        let ahead = f.cache.lockout_remaining().unwrap_or_default();
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
        let ahead = f.cache.lockout_remaining().unwrap_or_default();
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

        let started = Tick::now();
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

        cache.penalise(Duration::from_secs(300));
        cache.penalise(Duration::from_secs(30));

        let ahead = cache.lockout_remaining().unwrap_or_default();
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
        let dir = crate::scratch::path("images-store");
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

        let started = Tick::now();
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
            cache.lockout_remaining().is_none(),
            "a fresh gate must already be open"
        );

        cache.penalise(Duration::from_secs(120));

        let remaining = cache.lockout_remaining().unwrap_or_default();
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
        let main = crate::schema::fixtures::category(&conn, deck, "main", "Main deck");
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

    // ── Upkeep ──────────────────────────────────────────────────────────────────────────

    fn days(n: u64) -> Duration {
        Duration::from_secs(n * 24 * 60 * 60)
    }

    fn found(id: &str, variant: Variant, bytes: u64, used: Option<Wall>) -> OnDisk {
        OnDisk {
            key: key(id, 0, variant),
            bytes,
            used,
        }
    }

    fn chosen_ids(found: &[OnDisk], chosen: &[usize]) -> Vec<String> {
        chosen
            .iter()
            .map(|&i| found[i].key.card_id.clone())
            .collect()
    }

    const A: &str = "aa000000-0000-0000-0000-00000000000a";
    const B: &str = "bb000000-0000-0000-0000-00000000000b";
    const C: &str = "cc000000-0000-0000-0000-00000000000c";
    const D: &str = "dd000000-0000-0000-0000-00000000000d";
    const E: &str = "ee000000-0000-0000-0000-00000000000e";

    /// The budget arithmetic: oldest first, and not one picture past the point where the rest
    /// fits. An undated picture is never chosen — nothing can say it is old — but its bytes are
    /// on the disk, so they count.
    #[test]
    fn eviction_takes_the_least_recently_used_first_and_stops_once_the_rest_fits() {
        let now = Wall::EPOCH + days(1_000);
        let disk = [
            found(A, Variant::Display, 100, Some(now - days(5))),
            found(B, Variant::Display, 100, Some(now - days(1))),
            found(C, Variant::Display, 100, Some(now - days(3))),
            found(D, Variant::Display, 100, None),
        ];
        let budget = Budget {
            bytes: 250,
            idle: days(90),
        };

        let chosen = choose_evictions(&disk, |_| false, budget, now);

        // 400 on disk: A (the oldest) brings it to 300, still over; C brings it to 200, which fits.
        assert_eq!(chosen_ids(&disk, &chosen), vec![A, C]);

        let roomy = Budget {
            bytes: 400,
            ..budget
        };
        assert!(
            choose_evictions(&disk, |_| false, roomy, now).is_empty(),
            "a cache inside its budget, with nothing idle, loses nothing"
        );
    }

    /// A picture the pre-warm wants is never chosen, however old or large — and it is outside
    /// the budget, so a collection bigger than the whole budget does not push the reader's
    /// browsing out behind it.
    #[test]
    fn a_picture_the_prewarm_wants_is_never_evicted_and_is_not_charged_to_the_budget() {
        let now = Wall::EPOCH + days(1_000);
        let disk = [
            found(A, Variant::Display, 10_000, Some(now - days(900))),
            found(B, Variant::Display, 100, Some(now - days(1))),
        ];
        let owned = key(A, 0, Variant::Display);
        let budget = Budget {
            bytes: 200,
            idle: days(90),
        };

        let chosen = choose_evictions(&disk, |k| *k == owned, budget, now);

        assert!(
            chosen.is_empty(),
            "the owned picture is spared and the other fits: {:?}",
            chosen_ids(&disk, &chosen)
        );
    }

    /// The case the issue was about. The `grid` files the 2026-08-20 move left behind sit well
    /// inside any budget, so it is the idle horizon — not the size — that takes them: anything
    /// unread for longer than it goes, and nothing younger does.
    #[test]
    fn a_picture_nobody_has_used_within_the_idle_horizon_goes_even_under_the_budget() {
        let now = Wall::EPOCH + days(1_000);
        let disk = [
            found(A, Variant::Grid, 60_000, Some(now - days(91))),
            found(A, Variant::Display, 93_000, Some(now - days(89))),
        ];
        let budget = Budget {
            bytes: u64::MAX,
            idle: days(90),
        };

        let chosen = choose_evictions(&disk, |_| false, budget, now);

        assert_eq!(chosen.len(), 1);
        assert_eq!(disk[chosen[0]].key.variant, Variant::Grid);
    }

    /// Never evicting what the pre-warm needs rests on this: the spared set *is* the pre-warm's
    /// set, read from the one [`WANTED`] literal. Were it narrower, every owned picture outside it
    /// would be fetched back by the next pre-warm and evicted by the next pass, forever.
    #[test]
    fn the_spared_set_is_exactly_what_the_prewarm_would_fetch() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES (?1,'lea','161','en','nonfoil','NM',1,unixepoch(),unixepoch())",
            [BOLT],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,name,quantity,created_at,updated_at)
             VALUES ('o1',?1,'Wanted',1,unixepoch(),unixepoch())",
            [A],
        )
        .unwrap();

        let spared = spared_keys(&conn).unwrap();
        let prewarm: HashSet<ImageKey> = prewarm_keys(&conn, MAX_PREWARM)
            .unwrap()
            .into_iter()
            .collect();

        assert_eq!(spared.len(), 2);
        assert_eq!(spared, prewarm);
    }

    impl Fixture {
        /// A picture on disk and the row that vouches for it: `bytes` long, last used at
        /// `used`, recorded at `fetched_at`.
        fn put(&self, k: &ImageKey, bytes: usize, used: Wall, fetched_at: i64) {
            self.file(k, bytes, used);
            self.write
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO image_cache (card_id, face, variant, source_uri, bytes, fetched_at)
                     VALUES (?1, ?2, ?3, 'https://cards.scryfall.io/x.webp?1', ?4, ?5)",
                    params![k.card_id, k.face as i64, k.variant.key(), bytes as i64, fetched_at],
                )
                .unwrap();
        }

        /// A picture on disk with no row at all.
        fn file(&self, k: &ImageKey, bytes: usize, used: Wall) -> PathBuf {
            let path = cache_path(self.cache.dir(), k).unwrap();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, vec![7u8; bytes]).unwrap();
            stamp_used(&path, used).unwrap();
            path
        }

        fn on_disk(&self, k: &ImageKey) -> bool {
            cache_path(self.cache.dir(), k).unwrap().exists()
        }

        fn rows(&self) -> HashSet<ImageKey> {
            cached_rows(&self.write.lock().unwrap())
                .unwrap()
                .into_iter()
                .map(|(k, _)| k)
                .collect()
        }

        fn own(&self, id: &str) {
            self.write
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO collection_entries
                        (card_id,set_code,collector_number,lang,finish,condition,quantity,
                         created_at,updated_at)
                     VALUES (?1,'lea','161','en','nonfoil','NM',1,unixepoch(),unixepoch())",
                    [id],
                )
                .unwrap();
        }

        fn evict(&self, budget: Budget, now: Wall) -> Upkeep {
            evict(&self.cache, &self.read, &self.write, budget, now).unwrap()
        }
    }

    fn epoch_secs(t: Wall) -> i64 {
        t.as_secs()
    }

    /// The whole pass over a real disk and a real database: what goes is deleted file **and**
    /// row, what the pre-warm owns stays whatever its age, a file whose row is still owed stays,
    /// and a file with no row at all is an ordinary candidate. Afterwards every row has its file
    /// and every file but the owed one has its row.
    #[test]
    fn an_eviction_pass_deletes_file_and_row_together_and_spares_what_the_prewarm_owns() {
        let f = Fixture::new("upkeep-pass");
        let now = Wall::now();
        let before = epoch_secs(now) - 1_000;
        let owned = key(A, 0, COLLECTION_PREWARM);
        let orphan = key(A, 0, Variant::Grid);
        let (b, c, rowless, owed) = (
            key(B, 0, Variant::Display),
            key(C, 0, Variant::Display),
            key(D, 0, Variant::Display),
            key(E, 0, Variant::Display),
        );
        f.own(A);
        f.put(&owned, 1_000, now - days(200), before);
        f.put(&orphan, 1_000, now - days(100), before);
        f.put(&b, 1_000, now - days(10), before);
        f.put(&c, 1_000, now - days(1), before);
        f.file(&rowless, 1_000, now - days(20));
        f.file(&owed, 1_000, now - days(300));
        f.cache
            .queue_record(&owed, "https://cards.scryfall.io/e.webp?1", 1_000);

        let done = f.evict(
            Budget {
                bytes: 1_500,
                idle: days(90),
            },
            now,
        );

        // 4 000 unspared bytes: the idle `grid` orphan goes whatever the budget says, then the
        // rowless file (20 days) and B (10 days) until the 1 000 left fits under 1 500.
        assert!(
            f.on_disk(&owned),
            "the owned picture is 200 days old and stays"
        );
        assert!(!f.on_disk(&orphan), "the grid orphan is idle and goes");
        assert!(!f.on_disk(&rowless));
        assert!(!f.on_disk(&b));
        assert!(f.on_disk(&c), "the most recently used one fits and stays");
        assert!(
            f.on_disk(&owed),
            "a file whose row is still owed has only just landed"
        );
        assert_eq!((done.files, done.bytes, done.failed), (3, 3_000, 0));
        assert_eq!(
            done.rows, 2,
            "the orphan's row and B's; the rowless file had none"
        );

        assert_eq!(
            f.rows(),
            HashSet::from([owned.clone(), c.clone()]),
            "every row left has its file, and every file but the owed one has its row"
        );
    }

    /// A row whose file has gone — a reader who deleted `data/images` — is reaped, and that is
    /// what lets the pre-warm fetch an owned card's picture back: before, the row stood in for
    /// the file in its `NOT EXISTS` forever. A row written after the pass began is left alone,
    /// because it vouches for a file a fetch has just stored.
    #[test]
    fn a_row_whose_file_is_gone_is_reaped_but_one_written_after_the_pass_began_is_kept() {
        let f = Fixture::new("upkeep-reap");
        let now = Wall::now();
        let gone = key(A, 0, COLLECTION_PREWARM);
        let landing = key(B, 0, Variant::Display);
        f.own(A);
        f.put(&gone, 1_000, now, epoch_secs(now) - 100);
        f.put(&landing, 1_000, now, epoch_secs(now) + 100);
        std::fs::remove_dir_all(f.cache.dir()).unwrap();
        let wanted = |f: &Fixture| prewarm_keys(&f.read.lock().unwrap(), MAX_PREWARM).unwrap();
        assert!(
            wanted(&f).is_empty(),
            "the stale row hides the owned card from the pre-warm"
        );

        let done = f.evict(BUDGET, now);

        assert_eq!(done.rows, 1);
        assert_eq!(f.rows(), HashSet::from([landing]));
        assert_eq!(
            wanted(&f),
            vec![gone],
            "and the pre-warm can see the card again"
        );
    }

    /// LRU and not first-in-first-out: a picture served from disk is stamped as used, and so
    /// outlives one that was fetched at the same time and not looked at since.
    #[tokio::test]
    async fn a_served_picture_is_stamped_used_and_outlives_an_older_unread_one() {
        let f = Fixture::new("upkeep-touch");
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET);
            then.status(200).body(vec![7u8; 16]);
        });
        f.card(A, &format!("{}/grid/a.webp?1", server.base_url()));
        f.card(B, &format!("{}/grid/b.webp?1", server.base_url()));
        let client = scryfall::Client::new(server.base_url());
        let (read_again, left_alone) = (key(A, 0, Variant::Grid), key(B, 0, Variant::Grid));
        f.get(&client, &read_again).await.unwrap();
        f.get(&client, &left_alone).await.unwrap();
        let month_ago = Wall::now() - days(30);
        for k in [&read_again, &left_alone] {
            stamp_used(&cache_path(f.cache.dir(), k).unwrap(), month_ago).unwrap();
        }

        f.get(&client, &read_again).await.unwrap(); // a hit: touched, and nothing written yet
        let done = f.evict(
            Budget {
                bytes: 16,
                idle: days(90),
            },
            Wall::now() + Duration::from_secs(5),
        );

        assert_eq!(done.touched, 1);
        assert!(
            f.on_disk(&read_again),
            "the picture read a moment ago stays"
        );
        assert!(!f.on_disk(&left_alone), "the one unread for a month goes");
        assert_eq!(f.rows(), HashSet::from([read_again]));
    }

    /// The stamp opens the file for writing, and a key whose file is gone must stay gone: an
    /// empty file there, under a row that vouches for it, would be served as a zero-byte picture
    /// until Scryfall next re-scanned the card.
    ///
    /// **The shard directory is there and the file is not**, because that is what an eviction
    /// leaves — it deletes files, never directories. With no directory the open fails on the
    /// missing parent whatever its flags say, and this test would pass with `create(true)` in
    /// the stamp; it did, the first time it was written.
    #[test]
    fn stamping_a_picture_whose_file_has_gone_never_creates_one() {
        let dir = crate::scratch::path("images-upkeep-stamp");
        let _ = std::fs::remove_dir_all(&dir);
        let cache = Cache::new(dir.clone());
        let k = key(A, 0, Variant::Display);
        let path = cache_path(&dir, &k).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();

        cache.touch(&k);
        assert_eq!(cache.flush_touches(Wall::now()), 0);

        assert!(
            !path.exists(),
            "an evicted picture must not come back empty"
        );
    }

    /// What a pass deletes is a path this cache writes, rebuilt from a key it parsed — never a
    /// path it merely found. A crashed store's temporary, a file in the wrong shard, a face out
    /// of range, a folder that is not a variant, and anything a person put there all survive a
    /// pass that is told to delete everything it can.
    #[test]
    fn the_walk_never_deletes_a_file_it_did_not_parse_as_its_own() {
        let f = Fixture::new("upkeep-foreign");
        let long_ago = Wall::now() - days(1_000);
        let ours = key(A, 0, Variant::Display);
        f.file(&ours, 10, long_ago);
        let root = f.cache.dir().to_path_buf();
        let foreign = [
            root.join("display").join("aa").join("notes.txt"),
            root.join("display").join("aa").join(format!("{A}-0.7.tmp")),
            root.join("display").join("bb").join(format!("{A}-0.webp")),
            root.join("display").join("aa").join(format!("{A}-2.webp")),
            root.join("display").join("aa").join(format!("{A}-01.webp")),
            root.join("display").join(format!("{A}-0.webp")),
            root.join("png").join("aa").join(format!("{A}-0.webp")),
            root.join(format!("{A}-0.webp")),
        ];
        for path in &foreign {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"not the cache's").unwrap();
            stamp_used(path, long_ago).unwrap();
        }

        let done = f.evict(
            Budget {
                bytes: 0,
                idle: Duration::from_secs(1),
            },
            Wall::now(),
        );

        assert_eq!(done.files, 1);
        assert!(!f.on_disk(&ours));
        for path in &foreign {
            assert!(path.exists(), "{} must survive", path.display());
        }
    }
}
