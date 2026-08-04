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
//! * **The cache is disposable.** `image_cache` records what was fetched; deleting
//!   `data/images` is always safe and costs only re-downloads (spec §8).

use crate::scryfall::{self, ScryfallError};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// Concurrent fetches. `*.scryfall.io` is documented as having no rate limit, but the
/// spec still asks for ≤10/s sustained, and six ~60 KB requests in flight is comfortably
/// under that on any connection that can render the grid at all.
const MAX_CONCURRENT_FETCHES: usize = 6;

/// Minimum spacing between two fetch *starts* — the ≤10/s ceiling expressed as something
/// a scheduler can enforce.
const MIN_FETCH_INTERVAL: Duration = Duration::from_millis(100);

/// Shortest pause a 429 can buy: what Scryfall documents a rate limit as costing.
/// A `Retry-After: 0` or `: 1` is not permission to retry inside the window we are
/// already being punished for — and Scryfall bans repeat offenders.
const MIN_RATE_LIMIT_PENALTY_SECS: u64 = scryfall::RATE_LIMIT_BACKOFF_SECS;

/// Longest pause a 429 can buy. The header is attacker- (or bug-) controlled and this
/// value stops *every* image in the app, so a broken `Retry-After: 31536000` must not be
/// able to park the fetcher for a year. Five minutes is far past any real lockout.
const MAX_RATE_LIMIT_PENALTY_SECS: u64 = 300;

pub const WEBP: &str = "image/webp";
pub const SVG: &str = "image/svg+xml";

/// The image sizes this app stores. WEBP only — the JPG/PNG family Scryfall's own docs
/// mark as *replaced* is never fetched, and `png` alone would be 161 GB across the
/// library.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
#[derive(Debug, Clone)]
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
/// **Read-only by contract.** Every caller passes the `db_read` connection: a card
/// picture must not queue behind a 44 s ingest, and it must never be the handle that
/// takes a write lock.
pub fn resolve(conn: &Connection, key: &ImageKey) -> Result<Resolution, String> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT json_extract(image_uris, '$.' || ?2),
                    json_extract(face_image_uris, '$[' || ?3 || '].' || ?2)
             FROM cards WHERE id = ?1",
            params![key.card_id, key.variant.key(), key.face as i64],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((top, face)) = row else {
        return Ok(Resolution::Unknown);
    };
    // Face first for anything past the front: a transform's back exists only on the face,
    // and a `meld` card's top-level image is its front and nothing else. Falling back to
    // the top-level image for face 1 would show the front of the card on its own back.
    if let Some(uri) = face.or_else(|| (key.face == 0).then_some(top).flatten()) {
        return Ok(Resolution::Uri(uri));
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

/// How long a 429 stops the *whole* image cache, given the `Retry-After` it came with.
///
/// Clamped at both ends because neither end is ours to trust. Below
/// [`MIN_RATE_LIMIT_PENALTY_SECS`] we would be retrying inside Scryfall's documented
/// lockout — the behaviour it escalates to bans over — and a `Retry-After: 0` is exactly
/// the header a proxy or a bug produces. Above [`MAX_RATE_LIMIT_PENALTY_SECS`] a single
/// header would take every picture in the app out for the rest of the session.
fn rate_limit_penalty(retry_after_secs: u64) -> Duration {
    Duration::from_secs(
        retry_after_secs.clamp(MIN_RATE_LIMIT_PENALTY_SECS, MAX_RATE_LIMIT_PENALTY_SECS),
    )
}

/// The on-disk image cache: lazy, permanent, paced.
pub struct Cache {
    dir: PathBuf,
    /// Caps images in flight. A grid that scrolls fast can queue hundreds of tiles.
    permits: tokio::sync::Semaphore,
    /// Serialises the *start* of each fetch so [`MIN_FETCH_INTERVAL`] is enforced, and
    /// carries the 429 penalty: Scryfall's rate limit is per application, so a limit one
    /// request earns has to be paid by every request, not just that one.
    gate: tokio::sync::Mutex<tokio::time::Instant>,
    /// Images fetched but not stored. A read-only data directory or a full disk costs the
    /// user a slower grid rather than a blank one, which is right — but it is also
    /// invisible, and a number that only ever climbs is what makes it findable.
    store_failures: AtomicU64,
}

impl Cache {
    pub fn new(images_dir: PathBuf) -> Cache {
        Cache {
            dir: images_dir,
            permits: tokio::sync::Semaphore::new(MAX_CONCURRENT_FETCHES),
            gate: tokio::sync::Mutex::new(tokio::time::Instant::now()),
            store_failures: AtomicU64::new(0),
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
            let conn = read.lock().unwrap_or_else(|e| e.into_inner());
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
                return Ok(Served {
                    bytes,
                    content_type: WEBP,
                });
            }
        }

        let bytes = self.fetch(client, &uri).await?;

        match store(&path, &bytes).await {
            // Bookkeeping last, and optional. Losing the row costs one re-fetch from an
            // origin with no rate limit — so this is a single `try_lock`
            // ([`Duration::ZERO`]) rather than a wait: a *contended* write lock means an
            // ingest that will hold it for the next 44 s, and polling for it would park a
            // worker thread on a lock it was never going to win, once per image.
            Ok(()) => {
                if let Some(conn) = crate::db::lock_for(write, Duration::ZERO) {
                    let _ = record(&conn, key, &uri, bytes.len());
                }
            }
            // A cache that cannot be written is still a cache that can serve *this*
            // request: the bytes are already in hand, and refusing them because the data
            // directory is read-only or the disk is full would turn a storage problem into
            // a blank grid. Counted and printed, never returned — and emphatically not
            // recorded, because a row here would vouch for bytes that are not there.
            Err(e) => {
                self.store_failures.fetch_add(1, Ordering::Relaxed);
                eprintln!("image cache: could not store {}: {e}", path.display());
            }
        }
        Ok(Served {
            bytes,
            content_type: WEBP,
        })
    }

    /// One paced fetch: a permit, then the interval gate, then the request.
    ///
    /// The gate is a **deadline, not a queue**. A wait of pacing size (≤
    /// [`MIN_FETCH_INTERVAL`]) is slept out, because that is the ≤10/s ceiling doing its
    /// job. A wait longer than that can only be a 429 penalty some other tile earned, and
    /// standing in line for it would be wrong twice over: the request occupies a worker
    /// thread and a permit for up to five minutes, and a *second* rate limit could not
    /// even report itself until the first sleeper woke. So a penalty is answered rather
    /// than waited on — "not now, in N seconds" is a complete answer, and the protocol
    /// turns it into a 503 with a `Retry-After` the UI can act on.
    async fn fetch(&self, client: &scryfall::Client, uri: &str) -> Result<Vec<u8>, ImageError> {
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|e| ImageError::Fetch(e.to_string()))?;
        {
            let mut next = self.gate.lock().await;
            let remaining = next.saturating_duration_since(tokio::time::Instant::now());
            if remaining > MIN_FETCH_INTERVAL {
                return Err(ImageError::RateLimited {
                    retry_after_secs: secs_rounded_up(remaining),
                });
            }
            tokio::time::sleep_until(*next).await;
            *next = tokio::time::Instant::now() + MIN_FETCH_INTERVAL;
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

    /// A normal card (top-level images), a transform (per-face), and one of the 162
    /// printings that have no image anywhere.
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
        conn
    }

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

    /// A 429 is per *application*, so the number in it decides how long every tile waits
    /// — which makes an unclamped `Retry-After` a header that can either walk us into
    /// Scryfall's 30 s lockout (and from there into a ban) or park the fetcher for a year.
    #[test]
    fn the_rate_limit_penalty_is_clamped_at_both_ends() {
        assert_eq!(rate_limit_penalty(45), Duration::from_secs(45));

        // Below the floor: Scryfall's own documented lockout is 30 s, so a 0 or a 1 must
        // not let us retry *inside* the window we are already being punished for.
        assert_eq!(rate_limit_penalty(0), Duration::from_secs(30));
        assert_eq!(rate_limit_penalty(1), Duration::from_secs(30));
        assert_eq!(rate_limit_penalty(30), Duration::from_secs(30));

        // Above the cap: a hostile or broken header must not be able to stop the app
        // fetching images for the rest of the session.
        assert_eq!(rate_limit_penalty(300), Duration::from_secs(300));
        assert_eq!(rate_limit_penalty(3_600), Duration::from_secs(300));
        assert_eq!(rate_limit_penalty(u64::MAX), Duration::from_secs(300));
    }

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
        let uri = format!("{}/grid/v17.webp", server.base_url());
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
        f.card(BOLT, &format!("{}/grid/v17.webp", server.base_url()));
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

        f.card(BOLT, &format!("{}/grid/v17.webp", server.base_url()));
        assert_eq!(f.get(&client, &k).await.unwrap().bytes, vec![1u8; 8]);

        let new_uri = format!("{}/grid/v99.webp", server.base_url());
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
        f.card(BOLT, &format!("{}/grid/v17.webp", server.base_url()));
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
        f.card(BOLT, &format!("{}/grid/v17.webp", server.base_url()));
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
        f.card(BOLT, &format!("{}/grid/v17.webp", server.base_url()));
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
        f.card(BOLT, &format!("{}/grid/v17.webp", server.base_url()));
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

    /// The ≤10/s ceiling the spec asks for, expressed as something a scheduler can
    /// enforce: two fetch *starts* are at least [`MIN_FETCH_INTERVAL`] apart.
    #[tokio::test]
    async fn consecutive_fetches_are_spaced_by_the_pacing_interval() {
        let f = Fixture::new("pacing");
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET);
            then.status(200).body(vec![7u8; 4]);
        });
        f.card(BOLT, &format!("{}/grid/a.webp", server.base_url()));
        f.card(
            "ab000000-0000-0000-0000-000000000001",
            &format!("{}/grid/b.webp", server.base_url()),
        );
        let client = scryfall::Client::new(server.base_url());

        let started = std::time::Instant::now();
        f.get(&client, &key(BOLT, 0, Variant::Grid)).await.unwrap();
        f.get(
            &client,
            &key("ab000000-0000-0000-0000-000000000001", 0, Variant::Grid),
        )
        .await
        .unwrap();

        assert!(
            started.elapsed() >= MIN_FETCH_INTERVAL,
            "two fetches took {:?}, which is faster than the pacing gate allows",
            started.elapsed()
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
}
