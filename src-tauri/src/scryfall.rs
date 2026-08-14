//! Async HTTP client for the two Scryfall hosts this app talks to.
//!
//! Five operations, each with a rule that is easy to get wrong:
//!
//! * **Update check** — `GET /bulk-data/default_cards` with the stored weak ETag in
//!   `If-None-Match`. A 304 is the common case and costs zero bytes, which is the
//!   whole point: the alternative is re-downloading 77 MB to learn nothing changed.
//! * **Download** — the bulk file is a real `.gz` *file*, not a `Content-Encoding`.
//!   reqwest's `gzip` feature is deliberately absent from `Cargo.toml`; enabling it
//!   would transparently decompress the body and hand the ingest a file that is
//!   neither valid gzip nor the size the API promised.
//! * **Sets** — `GET /sets`, following `has_more`/`next_page`, bounded by
//!   [`MAX_SET_PAGES`]: a `next_page` chain that cycles A→B→A defeats the
//!   self-reference guard and would otherwise page forever.
//! * **Migrations** — `GET /migrations`, the log of ids Scryfall merged or discarded,
//!   paged and bounded the same way by [`MAX_MIGRATION_PAGES`]. Bulk files are additive
//!   snapshots, so this endpoint is the *only* notice that a card the user owns has been
//!   renamed out from under them; [`crate::reconcile`] is what acts on it.
//! * **Images** — one card image from the `cards.scryfall.io` file origin. A 404 there
//!   is permanent, so it gets its own variant rather than looking like a transient
//!   failure a caller would retry.
//!
//! Every request to `api.scryfall.com` must carry a real `User-Agent` *and* an
//! `Accept` header; Cloudflare answers 403 without them, so the UA is pinned on the
//! client itself and [`Client::api_get`] is the only way this module builds an API
//! request. The API host is rate limited (a 429 locks the caller out for 30 seconds,
//! and Scryfall bans repeat offenders), so 429 gets its own error variant carrying the
//! duration the caller must wait — a bare marker leaves it guessing. The file origins
//! under `*.scryfall.io` are explicitly unlimited.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Sent on every request. Scryfall requires an accurate, app-specific UA and says
/// plainly: "Do not allow HTTP libraries to choose the header for you."
///
/// The version comes from Cargo rather than a literal, because a hand-written one goes
/// stale silently and this one had: it still said `0.1` at 0.2.0. "Accurate" is the whole
/// requirement, so the two halves that can drift — version and repository — are the two
/// this line does not spell out by hand.
pub const USER_AGENT: &str = concat!(
    "MTGGrimoire/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/Msgaihede/mtg-grimoire)"
);

/// The `Accept` value Scryfall's own documentation offers as an example.
const ACCEPT: &str = "application/json;q=0.9,*/*;q=0.8";

/// Longest gap this app will wait between two bytes of a response body.
///
/// Generous on purpose: it is a liveness check on the connection, not a bandwidth
/// requirement, and the bulk origin does occasionally pause mid-stream. Sixty seconds of
/// complete silence, though, is a connection that is not coming back.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// The whole of how long one card image may take.
///
/// The "no overall request timeout" rule above is about the **bulk download**, which
/// legitimately runs for minutes. An image is not that: the largest variant this app stores
/// is ~93 KB and a cold one measures ~127 ms, so ten seconds is 6 KB/s — slower than dial-up
/// — and nothing that misses it was going to arrive.
///
/// It exists because the two timeouts above between them do not bound a host that accepts
/// the connection and then goes silent. `connect_timeout` is already spent, the connection
/// *was* made; `READ_TIMEOUT` is the backstop, and sixty seconds of a blank frame is not a
/// backstop the reader can tell apart from a broken app. **Every failure affordance the app
/// has is behind the `<img>`'s `error` event** — the card pane's "No image yet", `CardArt`'s
/// "No image", `useImageRetry`'s two automatic retries — and none of them can fire until
/// this call returns. While it does not, the request also holds one of
/// `images::MAX_CONCURRENT_FETCHES`'s sixteen permits.
///
/// Not a hypothesis: measured 2026-08-11 against a path-MTU black hole between one machine
/// and `cards.scryfall.io`. The TCP connect succeeded in **51 ms** and the TLS handshake
/// never completed, because the path carried ~1 468 bytes and dropped the ICMP that says so,
/// so the server's certificate flight vanished. Every card image in the app hung; the API
/// host, on a different path, answered in 96 ms throughout. [`Client::fetch_image`] against
/// that same stalled URL now answers `Timeout(10s)` in **10.011 s**.
const IMAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// What Scryfall says a 429 costs: "your access being limited for 30 seconds". The floor
/// when the response carries no `Retry-After` of its own.
pub const RATE_LIMIT_BACKOFF_SECS: u64 = 30;

/// The longest lockout this app will hold itself to.
///
/// A `Retry-After` is a number from someone else's server, and an absurd one — a day, a
/// year, a typo — must not brick an app whose whole job is local. Five minutes is far past
/// Scryfall's documented thirty seconds and still a length a person can wait out.
pub const MAX_RATE_LIMIT_BACKOFF_SECS: u64 = 300;

/// The gap this app leaves between two requests to the **cards** family.
///
/// Transcribed from <https://scryfall.com/docs/api/rate-limits>, read live 2026-08-11:
/// "`/cards/search` — 2/second (500ms)", and the same for `/cards/named`, `/cards/random`
/// and `/cards/collection`.
pub const INTERVAL_CARDS: std::time::Duration = std::time::Duration::from_millis(500);

/// The gap for `/cards/manifest` — "10/minute (10,000ms)", by far the strictest.
pub const INTERVAL_MANIFEST: std::time::Duration = std::time::Duration::from_millis(10_000);

/// The gap for everything else — "All other methods — 10/second (100ms)".
///
/// This is the only one the app uses today: `/bulk-data/default_cards`, `/sets` and
/// `/migrations` are all "other methods". The other two are written down anyway, and
/// pinned by a test, because the failure they prevent is a future call site quietly taking
/// five times the budget its endpoint is allowed.
pub const INTERVAL_DEFAULT: std::time::Duration = std::time::Duration::from_millis(100);

/// How many times one API request is attempted before giving up.
///
/// Three, and only for the failures that are *nobody's answer*: a 5xx, a timeout, a
/// connection that never came up. A 429 is never retried — Scryfall's own words are "It is
/// not acceptable to ignore HTTP 429 responses… have your application retry the requests
/// until you power through them" — and neither is a 404, which is an answer.
const MAX_ATTEMPTS: u32 = 3;

/// The first backoff between two attempts; each later one doubles it.
///
/// 250 ms → 500 ms, so three attempts add at most 750 ms plus jitter to a failing call.
/// Small against [`READ_TIMEOUT`] on purpose: a retry must not outlive the sync that
/// spawned it.
const RETRY_BASE_BACKOFF: std::time::Duration = std::time::Duration::from_millis(250);

/// The largest image body this app will read into memory.
///
/// The biggest variant it stores is `display` at ~93 KB, so this is two orders of magnitude
/// of headroom — it is not a budget, it is a refusal to let a host that is not the one we
/// think it is hand this process an arbitrary number of bytes. `fetch_image` has a
/// production caller now (every tile in the app), so "the CDN would not do that" is no
/// longer the only thing standing between here and a memory exhaustion.
///
/// Enforced twice, and the second time is the one that counts. A declared `Content-Length`
/// past this is refused before the body is read at all, which is free; but that header is a
/// claim, and a chunked or HTTP/2 response makes no claim at all — so the body is *streamed*
/// against a running total and abandoned the moment it crosses. The bound is therefore on
/// what this process will hold, not on what a host says it will send: peak memory is at most
/// this plus one chunk, whatever the response headers do or do not say.
pub const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

/// Pages `fetch_sets` will follow before it stops. ~1 050 sets arrive in a handful of
/// pages; a `next_page` chain that cycles A→B→A slips past the `next == url` guard and
/// would otherwise run until the process is killed.
pub const MAX_SET_PAGES: usize = 20;

/// Pages `fetch_migrations` will follow. The cap is the same guard [`MAX_SET_PAGES`]
/// carries against a `next_page` chain that cycles — but unlike the set list, this one has
/// headroom worth watching.
///
/// **350 is the page size, not the log.** The figure this comment used to carry ("~350
/// migrations exist in total") was one page mistaken for the whole endpoint. Measured
/// 2026-08-05: `GET /migrations` answers 350 entries with `has_more: true`, and the live
/// `card_migrations` table holds **2 569** — eight pages.
///
/// **Why 20 and not the 10 this was.** The log only grows (415 entries in 2022, 1 270 in
/// 2023, 761 in 2024, and 123 across 2025–26 to date), and at the fastest year on record —
/// call it ~1 000 a year — a cap of 10 ceilinged at 3 500 entries, which is 931 spare: two
/// or three pages, about one year. Reaching it truncates the *oldest* migrations, because
/// Scryfall serves the log newest first, and those are exactly the rows a long-standing
/// collection is likeliest to still be parked on.
///
/// The truncation is silent by construction. Its only notice is the `eprintln!` in
/// [`Client::fetch_migrations`], and a release build has no console to print to, so nobody
/// would learn of it from the app — headroom is the whole defence. Unused pages cost
/// nothing: the loop breaks on `has_more` long before the cap, so the eleventh page is only
/// ever requested in the world where it exists. 20 is therefore ~7 000 entries and ~4 spare
/// years at that fastest rate (many more at the recent one), bought for nothing.
pub const MAX_MIGRATION_PAGES: usize = 20;

#[derive(Debug, thiserror::Error)]
pub enum ScryfallError {
    #[error("http request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("failed to write download: {0}")]
    Io(#[from] std::io::Error),
    /// The download finished but is not the size the API promised. A truncated file
    /// can still be valid gzip, so this check is the only thing standing between a
    /// short download and a half-ingested card database.
    #[error("downloaded {actual} bytes, expected {expected}")]
    SizeMismatch { expected: u64, actual: u64 },
    /// HTTP 429. Scryfall limits access for 30 seconds and escalates to bans, so the
    /// caller must back off — and needs the number to back off *by*, which is why this
    /// carries one instead of being a bare marker.
    #[error("rate limited by Scryfall; retry after {retry_after_secs}s")]
    RateLimited { retry_after_secs: u64 },
    /// HTTP 404 from a file origin: the resource is not coming, now or later. Separated
    /// from `Unexpected` so a caller can stop retrying instead of hammering a URI that
    /// will never answer.
    #[error("not found")]
    NotFound,
    /// The deadline passed with the response unfinished. Its own variant rather than an
    /// [`Unexpected`](ScryfallError::Unexpected), because that one is *an* answer this app
    /// did not expect and this is **no answer at all** — a distinction the caller acts on
    /// (retryable, and worth naming in the log) and a reader needs to debug a silent host.
    #[error("timed out after {0:?}")]
    Timeout(std::time::Duration),
    #[error("unexpected response from Scryfall: {0}")]
    Unexpected(String),
}

/// Result of an `If-None-Match` check against the bulk-data endpoint.
#[derive(Debug)]
pub enum BulkCheck {
    /// The stored ETag still matches: nothing to download.
    NotModified,
    Available(BulkInfo),
}

/// The card corpus: ~116 k printings, 77 MB gzipped. [`crate::ingest`] reads it.
pub const BULK_DEFAULT_CARDS: &str = "default_cards";

/// Scryfall's Oracle Tags: 4 521 tag objects, ~5.85 MB gzipped, each carrying its own
/// `taggings` array of `oracle_id`s. [`crate::oracle_tags`] reads it.
///
/// Same document shape as [`BULK_DEFAULT_CARDS`] in the one way that matters here — it
/// publishes `jsonl_download_uri` and `compressed_size` and neither of the pre-2026-07-20
/// `download_uri`/`size` fields — which is why one [`BulkInfo`] describes both.
pub const BULK_ORACLE_TAGS: &str = "oracle_tags";

/// The bits of a `bulk_data` object this app needs. Note `jsonl_download_uri` and
/// `compressed_size`: the pre-2026-07-20 `download_uri`/`size` fields are gone and
/// the legacy `.json` URLs return 404.
#[derive(Debug, Clone)]
pub struct BulkInfo {
    pub jsonl_download_uri: String,
    pub updated_at: String,
    pub compressed_size: u64,
    /// Weak ETag from the response, to be stored and replayed as `If-None-Match`.
    pub etag: Option<String>,
}

/// One row of `GET /sets`, shaped to match the `sets` table.
#[derive(Debug, Clone)]
pub struct SetRow {
    pub code: String,
    pub name: String,
    pub arena_code: Option<String>,
    pub mtgo_code: Option<String>,
    pub set_type: Option<String>,
    pub released_at: Option<String>,
    pub icon_svg_uri: Option<String>,
}

/// One entry of Scryfall's id-migration log.
///
/// The reason a collection tracker cares: bulk files are *additive snapshots*, so a card
/// whose id was merged or discarded simply stops appearing in them, and a user row keyed on
/// that id is orphaned with no event to explain it. This log is the event.
#[derive(Debug, Clone)]
pub struct Migration {
    pub id: String,
    pub performed_at: Option<String>,
    /// `merge` or `delete`. Anything else is a strategy this app does not know, and the
    /// reconciler skips it rather than guessing at what it means.
    pub strategy: String,
    pub old_card_id: String,
    /// `None` for `delete`, which is the whole difference between the two.
    pub new_card_id: Option<String>,
    pub note: Option<String>,
}

/// Scryfall API client. `base_url` is injectable so the tests can point it at a
/// local mock server; production passes `"https://api.scryfall.com"`.
#[derive(Debug, Clone)]
pub struct Client {
    http: reqwest::Client,
    base_url: String,
    /// The deadline one image gets. A field rather than a straight read of
    /// [`IMAGE_TIMEOUT`] for the same reason `base_url` is one: the behaviour worth testing
    /// is "the deadline is what ends the call", and a test that had to sit out the
    /// production number to prove it would be a ten-second test.
    image_timeout: std::time::Duration,
    /// The pacing gate: the earliest instant the next `api.scryfall.com` request may go
    /// out. Shared through an `Arc` so a cloned `Client` paces against the same budget —
    /// two clones with two gates would be two applications as far as Scryfall can tell.
    next_api_slot: Arc<tokio::sync::Mutex<tokio::time::Instant>>,
    /// Unix seconds until which the API has locked this application out, `0` for none.
    ///
    /// Wall-clock rather than a [`tokio::time::Instant`] because it has to outlive the
    /// process — see [`Client::penalty_until_unix`]. A `std` mutex, not a `tokio` one,
    /// because every access is one integer read or write with no `.await` inside it.
    penalty_until: Arc<Mutex<u64>>,
}

impl Client {
    pub fn new(base_url: String) -> Client {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            // Bounds a dead host, not a slow one. Deliberately *not* an overall request
            // timeout: a 77 MB bulk download legitimately runs for minutes, and a
            // `timeout()` here would kill it partway every time.
            .connect_timeout(std::time::Duration::from_secs(30))
            // Bounds each *read* instead — the gap between two chunks, not the length of
            // the download — so the "no overall timeout" rule above still holds while a
            // connection that stops delivering can no longer hang forever. That is not a
            // theoretical case: a half-open TCP connection (laptop suspended, VPN
            // dropped, NAT entry expired) leaves the streaming loop awaiting a chunk that
            // will never arrive, `syncing` latched true for the life of the process, and
            // both the header's Refresh and the first-run Retry disabled behind it — an
            // unrecoverable UI that only a restart clears.
            .read_timeout(READ_TIMEOUT)
            .build()
            .expect("client");
        Client {
            // Trailing slash trimmed so joining a path can never produce `//`.
            base_url: base_url.trim_end_matches('/').to_owned(),
            http,
            image_timeout: IMAGE_TIMEOUT,
            // In the past, so the first request of a session goes out immediately: the
            // gate spaces requests apart, it does not charge an entry fee.
            next_api_slot: Arc::new(tokio::sync::Mutex::new(tokio::time::Instant::now())),
            penalty_until: Arc::new(Mutex::new(0)),
        }
    }

    /// The lockout this application is currently under, in unix seconds, or `0`.
    ///
    /// Read at shutdown-ish moments and persisted to `app_meta`, because a 429 outlives the
    /// process that earned it: Scryfall limits the *application*, and restarting the app is
    /// otherwise a way to walk straight back into a live lockout. That is precisely the
    /// behaviour the docs escalate to a ban.
    pub fn penalty_until_unix(&self) -> u64 {
        *crate::db::lock_plain(&self.penalty_until)
    }

    /// Re-enter a lockout persisted by an earlier run.
    ///
    /// Clamped to [`MAX_RATE_LIMIT_BACKOFF_SECS`] past *now*, so neither a clock that moved
    /// nor a hand-edited row can lock the app out for longer than this module would ever
    /// impose itself.
    pub fn restore_penalty(&self, until_unix: u64, now: u64) {
        let ceiling = now.saturating_add(MAX_RATE_LIMIT_BACKOFF_SECS);
        let mut guard = crate::db::lock_plain(&self.penalty_until);
        *guard = until_unix.min(ceiling);
    }

    /// Seconds left on the lockout, or `None` if the gate is open.
    pub fn penalty_remaining(&self, now: u64) -> Option<u64> {
        let until = *crate::db::lock_plain(&self.penalty_until);
        until.checked_sub(now).filter(|remaining| *remaining > 0)
    }

    /// Charge a 429 to the gate every later API request has to pass.
    ///
    /// `max`, never assignment — the same rule [`crate::images::Cache::penalise`] follows,
    /// and for the same reason: two calls meeting the same 429 window can come back with
    /// different `Retry-After` values, and the shorter one arriving second must not release
    /// the app from the longer lockout already in force.
    fn charge_penalty(&self, retry_after_secs: u64, now: u64) -> u64 {
        let penalty = rate_limit_penalty(retry_after_secs);
        let mut guard = crate::db::lock_plain(&self.penalty_until);
        *guard = (*guard).max(now.saturating_add(penalty.as_secs()));
        penalty.as_secs()
    }

    /// The same client with a different image deadline. See the field.
    #[cfg(test)]
    pub fn with_image_timeout(mut self, timeout: std::time::Duration) -> Client {
        self.image_timeout = timeout;
        self
    }

    /// The only way this module issues an API request.
    ///
    /// One choke point, doing four things no call site may be trusted to remember:
    ///
    /// 1. **Refuses inside a lockout**, without sending a byte. A 429 means "your access is
    ///    limited for 30 seconds"; sending anyway is the one behaviour the docs single out
    ///    as unacceptable, and repeat offenders are banned.
    /// 2. **Paces** to the endpoint's documented interval ([`min_interval`]).
    /// 3. **Adds the mandatory `Accept`** — Cloudflare answers 403 without it. (The
    ///    `User-Agent` is pinned on the client itself, so it rides along on downloads too.)
    /// 4. **Retries what is nobody's answer** — a 5xx, a timeout, a connection that never
    ///    came up — up to [`MAX_ATTEMPTS`], and never a 429 or a 404.
    ///
    /// The pacing is a *sleep* and the lockout is a *refusal*, which is the same split
    /// [`crate::images::Cache::fetch`] makes: a sub-second wait is invisible and worth
    /// taking, while parking a worker thread for up to five minutes is not — and a second
    /// caller could not even report its own rate limit until the first sleeper woke.
    ///
    /// Non-5xx statuses come back untouched, so callers keep reading 304, 404 and 200 for
    /// themselves.
    async fn api_send(
        &self,
        url: &str,
        headers: &[(&str, &str)],
    ) -> Result<reqwest::Response, ScryfallError> {
        let mut attempt: u32 = 0;
        loop {
            if let Some(remaining) = self.penalty_remaining(unix_now()) {
                return Err(ScryfallError::RateLimited {
                    retry_after_secs: remaining,
                });
            }
            self.await_slot(url).await;

            let mut req = self.http.get(url).header("Accept", ACCEPT);
            for (name, value) in headers {
                req = req.header(*name, *value);
            }

            // Whatever this attempt earned, if it is worth another go.
            let pending = match req.send().await {
                Ok(resp) if resp.status().as_u16() == 429 => {
                    let asked = retry_after_secs(&resp);
                    return Err(ScryfallError::RateLimited {
                        retry_after_secs: self.charge_penalty(asked, unix_now()),
                    });
                }
                Ok(resp) if resp.status().is_server_error() => {
                    ScryfallError::Unexpected(format!("status {}", resp.status().as_u16()))
                }
                Ok(resp) => return Ok(resp),
                Err(e) if e.is_timeout() => ScryfallError::Timeout(READ_TIMEOUT),
                Err(e) if e.is_connect() || e.is_request() => ScryfallError::Http(e),
                Err(e) => return Err(ScryfallError::Http(e)),
            };

            attempt += 1;
            if attempt >= MAX_ATTEMPTS {
                return Err(pending);
            }
            tokio::time::sleep(retry_backoff(attempt)).await;
        }
    }

    /// Wait for this request's turn on the pacing gate, then claim the next slot.
    ///
    /// The lock is held across the sleep deliberately: it is what serialises concurrent
    /// callers into a queue rather than letting them all read the same "next" instant and
    /// leave together. The waits are the documented intervals — 100 ms for everything this
    /// app calls — so a queue of them is bounded by the number of requests in flight, which
    /// for this app is one.
    async fn await_slot(&self, url: &str) {
        let interval = min_interval(url);
        let mut next = self.next_api_slot.lock().await;
        let now = tokio::time::Instant::now();
        if *next > now {
            tokio::time::sleep_until(*next).await;
        }
        *next = tokio::time::Instant::now() + interval;
    }

    /// GET `uri`, optionally resuming from byte `from`. File origins, not the API, so
    /// no `Accept` — only the `User-Agent` the client itself carries.
    async fn get_from(
        &self,
        uri: &str,
        from: Option<u64>,
    ) -> Result<reqwest::Response, ScryfallError> {
        let mut req = self.http.get(uri);
        if let Some(n) = from {
            req = req.header("Range", format!("bytes={n}-"));
        }
        Ok(req.send().await?)
    }

    /// Ask whether the `default_cards` bulk file has changed since `etag`.
    ///
    /// The card corpus's own name for [`check_bulk_dataset`](Client::check_bulk_dataset),
    /// which is what every other dataset goes through. Kept as a call of its own because
    /// the sync is the one caller that must never accidentally be pointed elsewhere: the
    /// file it names is what `cards` is rebuilt from.
    pub async fn check_bulk_update(&self, etag: Option<&str>) -> Result<BulkCheck, ScryfallError> {
        self.check_bulk_dataset(BULK_DEFAULT_CARDS, etag).await
    }

    /// Ask whether one bulk dataset has changed since `etag`.
    ///
    /// Uses the per-type endpoint (`/bulk-data/<dataset>`) rather than the `/bulk-data`
    /// collection, whose ETag flips whenever any of the seven files rotate — which for a
    /// caller that only wants one of them means a 200 (and a re-download decision) every
    /// time any of the others is regenerated.
    ///
    /// `dataset` is one of the [`BULK_DEFAULT_CARDS`]/[`BULK_ORACLE_TAGS`] constants. It goes
    /// through [`api_send`](Client::api_send) like every other API call, so a second dataset
    /// shares the one pacing gate and the one 429 lockout: two datasets are still one
    /// application as far as Scryfall is concerned, and a second client would be two.
    pub async fn check_bulk_dataset(
        &self,
        dataset: &str,
        etag: Option<&str>,
    ) -> Result<BulkCheck, ScryfallError> {
        let url = format!("{}/bulk-data/{dataset}", self.base_url);
        let headers: Vec<(&str, &str)> =
            etag.map(|e| vec![("If-None-Match", e)]).unwrap_or_default();
        let resp = self.api_send(&url, &headers).await?;
        match resp.status().as_u16() {
            304 => Ok(BulkCheck::NotModified),
            200 => {
                let etag = resp
                    .headers()
                    .get("etag")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                let v = json_body(resp).await?;
                Ok(BulkCheck::Available(BulkInfo {
                    // The one field with no sane default: without a download URI there
                    // is nothing to sync, so a missing one is an error rather than "".
                    jsonl_download_uri: v["jsonl_download_uri"]
                        .as_str()
                        .ok_or_else(|| ScryfallError::Unexpected("no jsonl_download_uri".into()))?
                        .to_owned(),
                    updated_at: v["updated_at"].as_str().unwrap_or_default().to_owned(),
                    compressed_size: v["compressed_size"].as_u64().unwrap_or(0),
                    etag,
                }))
            }
            s => Err(ScryfallError::Unexpected(format!("status {s}"))),
        }
    }

    /// Download `uri` to `dest`, resuming a partial file via HTTP `Range`, and verify
    /// the result is exactly `expected_size` bytes.
    ///
    /// `progress` is called after every chunk with `(bytes_on_disk, expected_size)` —
    /// the first value is absolute, counting bytes already present from an earlier
    /// attempt, not just those fetched by this call.
    ///
    /// Resume rules: a `dest` smaller than `expected_size` sends `Range: bytes=N-`,
    /// and a 206 appends *after* its `Content-Range` is confirmed to start at exactly
    /// the byte the file ends on — a server that resumed from somewhere else would
    /// otherwise produce a file of the right length with garbage in the middle, and the
    /// first sign of it would be a gzip CRC failure deep inside the ingest. A 200
    /// (server ignored the range, or nothing to resume) restarts the file from zero,
    /// and a 416 — the partial is longer than the resource, so that range can never be
    /// satisfied — is retried once without a range, which discards the stale partial.
    /// Any other status returns *before* `dest` is opened, so a 5xx or a 429 can never
    /// truncate a partial download.
    ///
    /// The size check is the load-bearing part. A truncated bulk file is still valid
    /// gzip and would ingest as a plausible-looking partial card database, so the byte
    /// count from the API is the only reliable signal that the file is whole. On
    /// mismatch this returns [`ScryfallError::SizeMismatch`] and **leaves `dest` in
    /// place**: a short file is exactly what a later `Range` resume needs, and a long
    /// one is restarted from scratch by the rule above. Callers must not hand a file
    /// to the ingest after this returns an error.
    ///
    /// `progress` is `Send` so that the returned future is: a download has to be
    /// spawnable (`tokio::spawn`, or an `async` Tauri command) rather than tied to the
    /// task that built it.
    pub async fn download(
        &self,
        uri: &str,
        dest: &Path,
        expected_size: u64,
        progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> Result<(), ScryfallError> {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;

        let existing = tokio::fs::metadata(dest)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        // A file at or past the expected size is not resumable — it is either finished
        // or wrong. Either way the fix is to fetch it again from byte zero.
        let mut resuming = existing > 0 && existing < expected_size;
        let mut resp = self.get_from(uri, resuming.then_some(existing)).await?;

        // 416 Range Not Satisfiable: the partial on disk is longer than the resource the
        // server is offering — a rotated file, a truncated re-upload. That range can
        // never be satisfied, and re-sending it on every future attempt would wedge the
        // sync forever, so drop the range and take the whole file instead. The 200 arm
        // below then truncates the stale partial away.
        if resp.status().as_u16() == 416 && resuming {
            resuming = false;
            resp = self.get_from(uri, None).await?;
        }

        let (mut file, mut done) = match resp.status().as_u16() {
            206 if resuming => {
                // Trusting the offset is exactly what would make a wrong one silent.
                let start = resp
                    .headers()
                    .get("content-range")
                    .and_then(|v| v.to_str().ok())
                    .and_then(content_range_start);
                if start != Some(existing) {
                    return Err(ScryfallError::Unexpected(format!(
                        "206 resumed at {start:?}, expected byte {existing}"
                    )));
                }
                (
                    tokio::fs::OpenOptions::new()
                        .append(true)
                        .open(dest)
                        .await?,
                    existing,
                )
            }
            200 => (tokio::fs::File::create(dest).await?, 0),
            429 => {
                return Err(ScryfallError::RateLimited {
                    retry_after_secs: retry_after_secs(&resp),
                })
            }
            s => return Err(ScryfallError::Unexpected(format!("status {s}"))),
        };

        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            file.write_all(&chunk).await?;
            done += chunk.len() as u64;
            progress(done, expected_size);
        }
        file.flush().await?;
        // Durable before it is verified: the whole point of keeping a partial file is
        // that it survives a crash and can be resumed.
        file.sync_all().await?;
        drop(file);

        let actual = tokio::fs::metadata(dest).await?.len();
        if actual != expected_size {
            return Err(ScryfallError::SizeMismatch {
                expected: expected_size,
                actual,
            });
        }
        Ok(())
    }

    /// All sets, following `has_more`/`next_page` to the end — or to
    /// [`MAX_SET_PAGES`], whichever comes first.
    pub async fn fetch_sets(&self) -> Result<Vec<SetRow>, ScryfallError> {
        let mut url = format!("{}/sets", self.base_url);
        let mut out = Vec::new();
        // Set by every way out of the loop *except* running out of pages, so that stopping
        // at the cap — the one exit that silently returns a partial answer — can say so.
        let mut followed_the_chain = false;
        for _ in 0..MAX_SET_PAGES {
            let resp = self.api_send(&url, &[]).await?;
            match resp.status().as_u16() {
                200 => {}
                s => return Err(ScryfallError::Unexpected(format!("status {s}"))),
            }
            let v = json_body(resp).await?;
            for s in v["data"].as_array().into_iter().flatten() {
                out.push(SetRow {
                    code: s["code"].as_str().unwrap_or_default().to_owned(),
                    name: s["name"].as_str().unwrap_or_default().to_owned(),
                    arena_code: s["arena_code"].as_str().map(str::to_owned),
                    mtgo_code: s["mtgo_code"].as_str().map(str::to_owned),
                    set_type: s["set_type"].as_str().map(str::to_owned),
                    released_at: s["released_at"].as_str().map(str::to_owned),
                    icon_svg_uri: s["icon_svg_uri"].as_str().map(str::to_owned),
                });
            }
            if v["has_more"].as_bool() != Some(true) {
                followed_the_chain = true;
                break;
            }
            let next = v["next_page"].as_str().unwrap_or_default().to_owned();
            // A missing or self-referential `next_page` would otherwise spin forever
            // against the same URL.
            if next.is_empty() || next == url {
                followed_the_chain = true;
                break;
            }
            url = next;
        }
        if !followed_the_chain {
            eprintln!(
                "Scryfall's set list did not end within {MAX_SET_PAGES} pages; \
                 kept the first {} sets and stopped",
                out.len()
            );
        }
        Ok(out)
    }

    /// The id-migration log, newest page first, bounded by [`MAX_MIGRATION_PAGES`].
    pub async fn fetch_migrations(&self) -> Result<Vec<Migration>, ScryfallError> {
        let mut url = format!("{}/migrations", self.base_url);
        let mut out = Vec::new();
        // See `fetch_sets`. It matters more here: the log is served newest first, so a
        // truncation drops the *oldest* migrations — the rows most likely to be the ones a
        // long-standing collection is still parked on.
        let mut followed_the_chain = false;
        for _ in 0..MAX_MIGRATION_PAGES {
            let resp = self.api_send(&url, &[]).await?;
            match resp.status().as_u16() {
                200 => {}
                s => return Err(ScryfallError::Unexpected(format!("status {s}"))),
            }
            let v = json_body(resp).await?;
            for m in v["data"].as_array().into_iter().flatten() {
                // A row with no id or no old id describes nothing this app can act on —
                // and the id is the primary key of the bookkeeping that makes a re-poll a
                // no-op, so a blank one would be a row every later migration folds into.
                let (Some(id), Some(old)) = (m["id"].as_str(), m["old_scryfall_id"].as_str())
                else {
                    continue;
                };
                out.push(Migration {
                    id: id.to_owned(),
                    performed_at: m["performed_at"].as_str().map(str::to_owned),
                    strategy: m["migration_strategy"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    old_card_id: old.to_owned(),
                    new_card_id: m["new_scryfall_id"].as_str().map(str::to_owned),
                    note: m["note"].as_str().map(str::to_owned),
                });
            }
            if v["has_more"].as_bool() != Some(true) {
                followed_the_chain = true;
                break;
            }
            let next = v["next_page"].as_str().unwrap_or_default().to_owned();
            // Same guard as `fetch_sets`, for the same reason: a missing or
            // self-referential `next_page` would spin forever against one URL, and the
            // page cap above is what catches the cycles this cannot see.
            if next.is_empty() || next == url {
                followed_the_chain = true;
                break;
            }
            url = next;
        }
        if !followed_the_chain {
            eprintln!(
                "Scryfall's id-migration log did not end within {MAX_MIGRATION_PAGES} pages; \
                 applied the newest {} entries and did not read the older ones. \
                 Raise MAX_MIGRATION_PAGES.",
                out.len()
            );
        }
        Ok(out)
    }

    /// The bytes of one card image from `cards.scryfall.io`.
    ///
    /// A file origin, not the API: no `Accept` header (the `User-Agent` pinned on the
    /// client rides along regardless), and Scryfall documents `*.scryfall.io` as having
    /// no rate limits. The ≤10/s the spec still asks for is paced by `images::Cache`,
    /// which is where the request *rate* is known — this call does exactly one fetch.
    ///
    /// Buffered into memory rather than to a file — the largest variant this app stores is
    /// ~93 KB, and a file that small does not repay the temporary and the rename the 77 MB
    /// bulk download needs. **Read** as a stream all the same, so that "buffered into
    /// memory" is a bounded claim: see [`MAX_IMAGE_BYTES`].
    ///
    /// **Bounded end to end by [`IMAGE_TIMEOUT`]** — the request *and* the body, because a
    /// host can go silent at either. The deadline is the whole call rather than a per-read
    /// one for the same reason it is short: this is 93 KB from a CDN, not the 77 MB bulk
    /// file, so there is no legitimate reason for one of these to be slow and every reason
    /// for the `<img>` waiting on it to be told quickly when it is.
    pub async fn fetch_image(&self, uri: &str) -> Result<Vec<u8>, ScryfallError> {
        tokio::time::timeout(self.image_timeout, self.image_bytes(uri))
            .await
            .unwrap_or_else(|_| Err(ScryfallError::Timeout(self.image_timeout)))
    }

    /// The fetch itself, with no deadline of its own — [`fetch_image`](Client::fetch_image)
    /// owns that, so there is exactly one place the bound is applied and no way to reach
    /// this without it.
    async fn image_bytes(&self, uri: &str) -> Result<Vec<u8>, ScryfallError> {
        use futures_util::StreamExt;

        let resp = self.get_from(uri, None).await?;
        match resp.status().as_u16() {
            200 => {
                // The declared length first: refusing before a byte of the body is read is
                // the only check that costs nothing.
                if let Some(len) = resp.content_length() {
                    if len > MAX_IMAGE_BYTES {
                        return Err(image_too_large(len));
                    }
                }
                // Then the body itself, chunk by chunk, against a running total.
                //
                // `Content-Length` is a *claim*, and a chunked or HTTP/2 response makes no
                // claim at all — so a `resp.bytes()` here would read an unbounded body into
                // memory and check its size after the fact, which is not a cap, it is a
                // report. The header check above is the cheap path; this is the one that
                // actually holds, and it holds against a host that simply omits the header.
                let mut stream = resp.bytes_stream();
                let mut body: Vec<u8> = Vec::new();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk?;
                    let total = body.len() as u64 + chunk.len() as u64;
                    if total > MAX_IMAGE_BYTES {
                        // Before the copy, so the refusal costs one chunk of headroom and
                        // not a second buffer the size of the first.
                        return Err(image_too_large(total));
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(body)
            }
            404 => Err(ScryfallError::NotFound),
            429 => Err(ScryfallError::RateLimited {
                retry_after_secs: retry_after_secs(&resp),
            }),
            s => Err(ScryfallError::Unexpected(format!("status {s}"))),
        }
    }
}

/// The refusal both halves of the image size cap answer with — one message, so a caller
/// (and a test) does not have to know which check caught it.
fn image_too_large(bytes: u64) -> ScryfallError {
    ScryfallError::Unexpected(format!("image is too large: {bytes} bytes"))
}

/// First byte of a `Content-Range: bytes 400-999/1000` header.
///
/// `None` for anything that is not a satisfied byte range — including the
/// unsatisfied form `bytes */1000`, which must never be read as "resume at 0".
fn content_range_start(value: &str) -> Option<u64> {
    let range = value.trim().strip_prefix("bytes")?.trim_start();
    range.split('-').next()?.trim().parse().ok()
}

/// Seconds since the Unix epoch. A clock before 1970 reads as 0, which leaves every gate
/// open rather than panicking over a wall clock this module does not control.
pub(crate) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// How long a 429 stops this application, given the `Retry-After` it came with.
///
/// Clamped at both ends because neither end is ours to trust. Below
/// [`RATE_LIMIT_BACKOFF_SECS`] we would be retrying inside Scryfall's documented lockout —
/// the behaviour it escalates to bans over — and a `Retry-After: 0` is exactly the header a
/// proxy or a bug produces. Above [`MAX_RATE_LIMIT_BACKOFF_SECS`] a single header would take
/// the app out for the rest of the session.
///
/// **One definition, two gates.** The API's lockout ([`Client::charge_penalty`]) and the
/// image cache's ([`crate::images::Cache::penalise`]) are separate deadlines over separate
/// hosts, but they are the same *rule*, and a second copy of a clamp is a second place for
/// it to drift.
pub fn rate_limit_penalty(retry_after_secs: u64) -> Duration {
    Duration::from_secs(
        retry_after_secs.clamp(RATE_LIMIT_BACKOFF_SECS, MAX_RATE_LIMIT_BACKOFF_SECS),
    )
}

/// The path of a URL, with no query string and no dependency on a URL crate.
///
/// Written against the *path* rather than the whole URL because Scryfall hands back its own
/// absolute `next_page` links, and a page 2 of `/sets` has to be classified exactly as the
/// page 1 this app built for itself.
fn url_path(url: &str) -> &str {
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let from_root = match after_scheme.find('/') {
        Some(i) => &after_scheme[i..],
        None => "/",
    };
    from_root
        .split(['?', '#'])
        .next()
        .unwrap_or("/")
        .trim_end_matches('/')
}

/// The documented minimum gap before another request may be sent to this endpoint.
///
/// Transcribed from <https://scryfall.com/docs/api/rate-limits>, read live 2026-08-11. The
/// app only ever hits the default arm today; the other two are here so that adding a call
/// to the cards family cannot silently take five times the budget it is allowed.
fn min_interval(url: &str) -> Duration {
    match url_path(url) {
        "/cards/search" | "/cards/named" | "/cards/random" | "/cards/collection" => INTERVAL_CARDS,
        "/cards/manifest" => INTERVAL_MANIFEST,
        _ => INTERVAL_DEFAULT,
    }
}

/// How long to wait before attempt `attempt + 1`: exponential, with jitter.
///
/// The jitter is derived from the wall clock's sub-second digits rather than from a random
/// number generator, because this crate has no `rand` dependency and does not need one for
/// what jitter is *for* — keeping two clients that failed at the same instant from retrying
/// at the same instant. It is a spreading function, not a source of secrets.
fn retry_backoff(attempt: u32) -> Duration {
    let base = RETRY_BASE_BACKOFF * 2u32.saturating_pow(attempt.saturating_sub(1));
    let spread = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::from(d.subsec_millis()))
        .unwrap_or(0)
        % 100;
    base + Duration::from_millis(spread)
}

/// The backoff a 429 asks for: `Retry-After` when it is a plain seconds count, and
/// Scryfall's documented 30 s otherwise.
fn retry_after_secs(resp: &reqwest::Response) -> u64 {
    resp.headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(RATE_LIMIT_BACKOFF_SECS)
}

/// Parse a response body as JSON.
///
/// reqwest is built without its `json` feature (it would only duplicate `serde_json`,
/// which this crate already depends on), so bodies are decoded here.
async fn json_body(resp: reqwest::Response) -> Result<serde_json::Value, ScryfallError> {
    let bytes = resp.bytes().await?;
    serde_json::from_slice(&bytes)
        .map_err(|e| ScryfallError::Unexpected(format!("response was not JSON: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    #[tokio::test]
    async fn etag_match_returns_not_modified() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET)
                .path("/bulk-data/default_cards")
                .header("if-none-match", "W/\"abc\"");
            then.status(304);
        });
        let c = Client::new(server.base_url());
        assert!(matches!(
            c.check_bulk_update(Some("W/\"abc\"")).await.unwrap(),
            BulkCheck::NotModified
        ));
    }

    #[tokio::test]
    async fn fresh_check_parses_bulk_info() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET)
                .path("/bulk-data/default_cards")
                .header("user-agent", USER_AGENT)
                .header_exists("accept");
            then.status(200)
                .header("etag", "W/\"xyz\"")
                .json_body(serde_json::json!({
                    "object":"bulk_data","type":"default_cards",
                    "updated_at":"2026-08-03T21:16:27.869+00:00",
                    "jsonl_download_uri":"https://data.scryfall.io/default-cards/x.jsonl.gz",
                    "compressed_size":77332681u64 }));
        });
        let c = Client::new(server.base_url());
        let BulkCheck::Available(info) = c.check_bulk_update(None).await.unwrap() else {
            panic!()
        };
        assert_eq!(info.compressed_size, 77332681);
        assert_eq!(info.etag.as_deref(), Some("W/\"xyz\""));
    }

    #[tokio::test]
    async fn download_verifies_size_and_reports_progress() {
        let server = MockServer::start();
        let body = vec![7u8; 1000];
        server.mock(|when, then| {
            when.method(GET).path("/file.gz");
            then.status(200).body(body.clone());
        });
        let c = Client::new(server.base_url());
        let dest = std::env::temp_dir().join("mtgtest-dl.gz");
        let _ = std::fs::remove_file(&dest);
        let mut seen = 0u64;
        c.download(
            &format!("{}/file.gz", server.base_url()),
            &dest,
            1000,
            &mut |done, _| seen = done,
        )
        .await
        .unwrap();
        assert_eq!(seen, 1000);
        assert_eq!(std::fs::metadata(&dest).unwrap().len(), 1000);
    }

    #[tokio::test]
    async fn download_size_mismatch_errors() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/f.gz");
            then.status(200).body("short");
        });
        let c = Client::new(server.base_url());
        let dest = std::env::temp_dir().join("mtgtest-dl2.gz");
        let _ = std::fs::remove_file(&dest);
        let err = c
            .download(
                &format!("{}/f.gz", server.base_url()),
                &dest,
                9999,
                &mut |_, _| {},
            )
            .await;
        assert!(matches!(err, Err(ScryfallError::SizeMismatch { .. })));
        // The short file is kept on purpose: it is exactly what a later Range resume
        // needs. What must not happen is the caller mistaking it for a whole file.
        assert_eq!(std::fs::metadata(&dest).unwrap().len(), 5);
    }

    /// The resume path: a partial file must be continued from its current length and
    /// appended to, never re-fetched from zero and never appended to twice.
    #[tokio::test]
    async fn download_resumes_a_partial_file_with_range() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET)
                .path("/resume.gz")
                .header("range", "bytes=400-");
            then.status(206)
                .header("content-range", "bytes 400-999/1000")
                .body(vec![9u8; 600]);
        });
        let c = Client::new(server.base_url());
        let dest = std::env::temp_dir().join("mtgtest-dl-resume.gz");
        std::fs::write(&dest, vec![7u8; 400]).unwrap();

        let mut reports: Vec<(u64, u64)> = Vec::new();
        c.download(
            &format!("{}/resume.gz", server.base_url()),
            &dest,
            1000,
            &mut |done, total| reports.push((done, total)),
        )
        .await
        .unwrap();

        let got = std::fs::read(&dest).unwrap();
        assert_eq!(got.len(), 1000);
        assert_eq!(&got[..400], &[7u8; 400][..], "existing bytes must be kept");
        assert_eq!(&got[400..], &[9u8; 600][..], "new bytes must be appended");
        assert_eq!(reports.last(), Some(&(1000, 1000)));
        assert!(
            reports.iter().all(|&(done, _)| done > 400),
            "progress must be absolute, counting the bytes already on disk: {reports:?}"
        );
    }

    /// A file at or beyond the expected size cannot be resumed — appending to it would
    /// only make it more wrong — so the request goes out without a Range header and
    /// the file is rewritten from zero.
    #[tokio::test]
    async fn download_restarts_when_the_existing_file_is_not_resumable() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/restart.gz").header_missing("range");
            then.status(200).body(vec![1u8; 1000]);
        });
        let c = Client::new(server.base_url());
        let dest = std::env::temp_dir().join("mtgtest-dl-restart.gz");
        std::fs::write(&dest, vec![7u8; 2500]).unwrap();

        c.download(
            &format!("{}/restart.gz", server.base_url()),
            &dest,
            1000,
            &mut |_, _| {},
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), vec![1u8; 1000]);
    }

    /// A failed request must not cost the caller the partial download it already has:
    /// the response status is settled before `dest` is opened, so nothing truncates.
    #[tokio::test]
    async fn a_failed_response_leaves_the_partial_file_intact() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/boom.gz");
            then.status(503);
        });
        let c = Client::new(server.base_url());
        let dest = std::env::temp_dir().join("mtgtest-dl-boom.gz");
        std::fs::write(&dest, vec![7u8; 400]).unwrap();

        let err = c
            .download(
                &format!("{}/boom.gz", server.base_url()),
                &dest,
                1000,
                &mut |_, _| {},
            )
            .await;
        assert!(
            matches!(&err, Err(ScryfallError::Unexpected(m)) if m.contains("503")),
            "expected an unexpected-status error, got {err:?}"
        );
        assert_eq!(std::fs::metadata(&dest).unwrap().len(), 400);
    }

    /// A 206 that starts somewhere other than the end of the local file would splice
    /// two byte ranges together into a file of exactly the right length whose middle is
    /// wrong — a corruption that only surfaces as a gzip CRC error mid-ingest. Reject
    /// it at the source, and leave the partial alone.
    #[tokio::test]
    async fn download_rejects_a_206_that_resumes_at_the_wrong_offset() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/liar.gz");
            then.status(206)
                .header("content-range", "bytes 0-999/1000")
                .body(vec![9u8; 600]);
        });
        let c = Client::new(server.base_url());
        let dest = std::env::temp_dir().join("mtgtest-dl-liar.gz");
        std::fs::write(&dest, vec![7u8; 400]).unwrap();

        let err = c
            .download(
                &format!("{}/liar.gz", server.base_url()),
                &dest,
                1000,
                &mut |_, _| {},
            )
            .await;
        assert!(
            matches!(&err, Err(ScryfallError::Unexpected(m)) if m.contains("expected byte 400")),
            "expected a resume-offset error, got {err:?}"
        );
        assert_eq!(std::fs::metadata(&dest).unwrap().len(), 400);
    }

    /// A partial longer than the resource can never satisfy its own Range, so retrying
    /// it forever would wedge the sync. One rangeless retry takes the whole file.
    #[tokio::test]
    async fn download_restarts_from_zero_after_a_416() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/gone.gz").header_exists("range");
            then.status(416);
        });
        server.mock(|when, then| {
            when.method(GET).path("/gone.gz").header_missing("range");
            then.status(200).body(vec![1u8; 1000]);
        });
        let c = Client::new(server.base_url());
        let dest = std::env::temp_dir().join("mtgtest-dl-416.gz");
        std::fs::write(&dest, vec![7u8; 400]).unwrap();

        c.download(
            &format!("{}/gone.gz", server.base_url()),
            &dest,
            1000,
            &mut |_, _| {},
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read(&dest).unwrap(),
            vec![1u8; 1000],
            "the stale partial must be replaced, not appended to"
        );
    }

    /// Bodies are decoded with serde_json rather than reqwest's `json` feature, so the
    /// mapping of a parse failure onto `Unexpected` is this module's own contract.
    #[tokio::test]
    async fn a_malformed_json_body_is_reported_as_unexpected() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/bulk-data/default_cards");
            then.status(200).body("<html>Service Unavailable</html>");
        });
        let c = Client::new(server.base_url());
        let err = c.check_bulk_update(None).await;
        assert!(
            matches!(&err, Err(ScryfallError::Unexpected(m)) if m.contains("not JSON")),
            "expected a JSON parse error, got {err:?}"
        );
    }

    /// Task 8 has to be able to `tokio::spawn` a sync, or run it from an `async` Tauri
    /// command. That needs every future here to be `Send`, which the `progress`
    /// callback — held across every await in the download loop — silently decides.
    /// This is a compile-time assertion; reaching the asserts means it held.
    #[test]
    fn futures_are_send_so_they_can_be_spawned() {
        fn assert_send<T: Send>(_: &T) {}
        let c = Client::new("http://127.0.0.1:1".into());
        let mut progress = |_: u64, _: u64| {};
        assert_send(&c.check_bulk_update(None));
        assert_send(&c.fetch_sets());
        assert_send(&c.fetch_migrations());
        assert_send(&c.download(
            "http://127.0.0.1:1/x.gz",
            Path::new("unused"),
            1,
            &mut progress,
        ));
    }

    #[test]
    fn content_range_start_reads_the_first_byte_offset() {
        assert_eq!(content_range_start("bytes 400-999/1000"), Some(400));
        assert_eq!(content_range_start("bytes 0-9/10"), Some(0));
        // The unsatisfied form carries no start offset and must not read as byte 0.
        assert_eq!(content_range_start("bytes */1000"), None);
        assert_eq!(content_range_start("items 400-999/1000"), None);
    }

    #[tokio::test]
    async fn an_image_comes_back_as_bytes() {
        let server = MockServer::start();
        let body = vec![0x52u8, 0x49, 0x46, 0x46, 7, 7, 7, 7];
        server.mock(|when, then| {
            // The file origin needs no `Accept`, but the User-Agent is not optional
            // anywhere: "Do not allow HTTP libraries to choose the header for you."
            when.method(GET)
                .path("/grid/front/0/0/x.webp")
                .header("user-agent", USER_AGENT);
            then.status(200)
                .header("content-type", "image/webp")
                .body(body.clone());
        });
        let c = Client::new(server.base_url());

        let bytes = c
            .fetch_image(&format!("{}/grid/front/0/0/x.webp", server.base_url()))
            .await
            .unwrap();

        assert_eq!(bytes, body);
    }

    /// 404 from the CDN is permanent — a URI Scryfall gave us for an image it does not
    /// have. Retrying it forever is the failure mode this variant exists to prevent.
    #[tokio::test]
    async fn a_missing_image_is_not_a_retryable_failure() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/gone.webp");
            then.status(404);
        });
        let c = Client::new(server.base_url());

        assert!(matches!(
            c.fetch_image(&format!("{}/gone.webp", server.base_url()))
                .await,
            Err(ScryfallError::NotFound)
        ));
    }

    /// A host that takes the connection and then says nothing is the failure neither
    /// timeout above catches: `connect_timeout` is spent (the connection was made) and
    /// `READ_TIMEOUT` is a minute away. Until this call returns, the `<img>` that asked for
    /// the image has had neither a `load` nor an `error` — so the frame is blank, the card
    /// pane's "No image yet" panel is unreachable, `useImageRetry` schedules nothing, and
    /// one of the image cache's sixteen permits is held the whole time.
    ///
    /// The delay stands in for a stalled response because from this side they are the same
    /// thing: bytes that have not arrived yet.
    #[tokio::test]
    async fn a_stalled_image_gives_up_rather_than_hanging() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/stalled.webp");
            then.status(200)
                .header("content-type", "image/webp")
                .delay(std::time::Duration::from_secs(2))
                .body(vec![0x52u8, 0x49, 0x46, 0x46]);
        });
        let c = Client::new(server.base_url())
            .with_image_timeout(std::time::Duration::from_millis(150));

        let started = std::time::Instant::now();
        let result = c
            .fetch_image(&format!("{}/stalled.webp", server.base_url()))
            .await;
        let waited = started.elapsed();

        assert!(
            matches!(result, Err(ScryfallError::Timeout(_))),
            "a silent host is a timeout, not bytes and not a hang: {result:?}"
        );
        assert!(
            waited < std::time::Duration::from_secs(1),
            "the deadline has to be what ends the call, not the response finally arriving \
             ({waited:?})"
        );
    }

    /// Scryfall limits access for 30 seconds on a 429 and bans repeat offenders, so the
    /// number has to reach the caller — a bare "rate limited" marker is something a
    /// caller can only guess at. `Retry-After` is honoured when sent; 30 s is the
    /// documented floor when it is not.
    ///
    /// **A client per endpoint, and that is the point.** A 429 now shuts a gate the whole
    /// client passes, so four calls on one client would measure the gate rather than the
    /// four responses. The gate has its own test below.
    #[tokio::test]
    async fn rate_limiting_carries_the_backoff_the_caller_must_wait() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/bulk-data/default_cards");
            then.status(429);
        });
        server.mock(|when, then| {
            when.method(GET).path("/sets");
            then.status(429);
        });
        server.mock(|when, then| {
            when.method(GET).path("/migrations");
            then.status(429).header("retry-after", "60");
        });
        server.mock(|when, then| {
            when.method(GET).path("/slow.webp");
            then.status(429).header("retry-after", "45");
        });

        assert!(matches!(
            Client::new(server.base_url()).check_bulk_update(None).await,
            Err(ScryfallError::RateLimited {
                retry_after_secs: 30
            })
        ));
        assert!(matches!(
            Client::new(server.base_url()).fetch_sets().await,
            Err(ScryfallError::RateLimited {
                retry_after_secs: 30
            })
        ));
        // The migration log is polled on every sync, so it is the endpoint most likely to
        // meet a 429 — and the one whose backoff a caller has no other way to learn.
        assert!(matches!(
            Client::new(server.base_url()).fetch_migrations().await,
            Err(ScryfallError::RateLimited {
                retry_after_secs: 60
            })
        ));
        // The image origin is a different host with no documented limit, so it keeps its own
        // gate in `images::Cache` and does not pass through the API governor at all.
        assert!(matches!(
            Client::new(server.base_url())
                .fetch_image(&format!("{}/slow.webp", server.base_url()))
                .await,
            Err(ScryfallError::RateLimited {
                retry_after_secs: 45
            })
        ));
    }

    /// The published limits, transcribed. This test is the reason the two intervals the app
    /// does not use are written down: it is the thing that fails if someone adds a
    /// `/cards/collection` call and leaves it on the 10/s budget.
    ///
    /// Classified by **path**, because Scryfall hands back absolute `next_page` URLs and a
    /// page 2 must take the same budget as the page 1 this app built.
    #[test]
    fn the_paced_intervals_are_the_ones_scryfall_publishes() {
        for path in [
            "/cards/search",
            "/cards/named",
            "/cards/random",
            "/cards/collection",
        ] {
            assert_eq!(
                min_interval(&format!("https://api.scryfall.com{path}")),
                INTERVAL_CARDS,
                "{path} is documented as 2/second"
            );
        }
        assert_eq!(
            min_interval("https://api.scryfall.com/cards/manifest"),
            INTERVAL_MANIFEST,
            "the manifest is 10/minute, by far the strictest"
        );
        for path in ["/sets", "/migrations", "/bulk-data/default_cards"] {
            assert_eq!(
                min_interval(&format!("https://api.scryfall.com{path}")),
                INTERVAL_DEFAULT,
                "{path} is an 'other method' at 10/second"
            );
        }

        // A query string is not part of the path, and neither is a trailing slash.
        assert_eq!(
            min_interval("https://api.scryfall.com/cards/search?q=bolt&page=2"),
            INTERVAL_CARDS
        );
        assert_eq!(url_path("https://api.scryfall.com/sets?page=2"), "/sets");
        assert_eq!(url_path("https://api.scryfall.com/sets/"), "/sets");
        assert_eq!(url_path("https://api.scryfall.com"), "");
    }

    /// The whole point of the governor: requests to one endpoint leave at most as fast as
    /// the published rate, whatever the caller does.
    ///
    /// Three "other method" calls are two intervals apart at minimum — the first goes out
    /// immediately, because the gate spaces requests apart rather than charging an entry fee.
    #[tokio::test]
    async fn requests_are_paced_to_the_published_rate() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/bulk-data/default_cards");
            then.status(304);
        });
        let c = Client::new(server.base_url());

        let started = std::time::Instant::now();
        for _ in 0..3 {
            let _ = c.check_bulk_update(Some("W/\"x\"")).await;
        }
        let elapsed = started.elapsed();

        assert!(
            elapsed >= INTERVAL_DEFAULT * 2,
            "three requests must be at least two intervals apart, took {elapsed:?}"
        );
    }

    /// "It is not acceptable to ignore HTTP 429 responses." So the next request is not
    /// *sent* — the gate answers it, and the mock never sees a second hit.
    #[tokio::test]
    async fn a_rate_limit_stops_the_next_request_before_it_is_sent() {
        let server = MockServer::start();
        let limited = server.mock(|when, then| {
            when.method(GET).path("/sets");
            then.status(429).header("retry-after", "45");
        });
        let c = Client::new(server.base_url());

        assert!(matches!(
            c.fetch_sets().await,
            Err(ScryfallError::RateLimited {
                retry_after_secs: 45
            })
        ));
        let second = c.fetch_sets().await;

        assert!(
            matches!(second, Err(ScryfallError::RateLimited { retry_after_secs }) if retry_after_secs > 0),
            "a call inside the lockout must be refused with the time remaining: {second:?}"
        );
        assert_eq!(
            limited.calls(),
            1,
            "the second call must never reach the network"
        );
    }

    /// The lockout outlives the process, because Scryfall limits the application rather than
    /// the process — restarting must not be a way back in. Clamped on the way in so a clock
    /// that moved, or a hand-edited row, cannot lock the app out for longer than it would
    /// ever choose to.
    #[test]
    fn a_lockout_is_persisted_restored_and_clamped() {
        let now = 1_800_000_000u64;
        let c = Client::new("http://127.0.0.1:1".into());
        assert_eq!(
            c.penalty_until_unix(),
            0,
            "a fresh client is not locked out"
        );
        assert_eq!(c.penalty_remaining(now), None);

        assert_eq!(c.charge_penalty(45, now), 45);
        assert_eq!(c.penalty_until_unix(), now + 45);
        assert_eq!(c.penalty_remaining(now), Some(45));
        assert_eq!(c.penalty_remaining(now + 45), None, "the gate reopens");

        // `max`, never assignment: a shorter penalty arriving second must not release a
        // longer lockout already in force.
        c.charge_penalty(300, now);
        c.charge_penalty(30, now);
        assert_eq!(c.penalty_until_unix(), now + 300);

        // Restored across a restart...
        let restarted = Client::new("http://127.0.0.1:1".into());
        restarted.restore_penalty(now + 45, now);
        assert_eq!(restarted.penalty_remaining(now), Some(45));

        // ...and a deadline past the ceiling is clamped rather than honoured.
        let absurd = Client::new("http://127.0.0.1:1".into());
        absurd.restore_penalty(now + 31_536_000, now);
        assert_eq!(
            absurd.penalty_remaining(now),
            Some(MAX_RATE_LIMIT_BACKOFF_SECS)
        );
    }

    /// The clamp both gates share. A `Retry-After: 0` is not permission to retry inside the
    /// window we are already being punished for, and a broken one must not park the app for
    /// a year.
    #[test]
    fn the_rate_limit_penalty_is_clamped_at_both_ends() {
        assert_eq!(rate_limit_penalty(45), Duration::from_secs(45));
        assert_eq!(rate_limit_penalty(0), Duration::from_secs(30));
        assert_eq!(rate_limit_penalty(1), Duration::from_secs(30));
        assert_eq!(rate_limit_penalty(30), Duration::from_secs(30));
        assert_eq!(rate_limit_penalty(300), Duration::from_secs(300));
        assert_eq!(rate_limit_penalty(3_600), Duration::from_secs(300));
        assert_eq!(rate_limit_penalty(u64::MAX), Duration::from_secs(300));
    }

    /// What is retried and what is not. A 5xx is nobody's answer and gets
    /// [`MAX_ATTEMPTS`]; a 429 and a 404 are answers, and retrying either is a request
    /// Scryfall has already refused.
    #[tokio::test]
    async fn only_failures_that_are_nobodys_answer_are_retried() {
        let server = MockServer::start();
        let flaky = server.mock(|when, then| {
            when.method(GET).path("/sets");
            then.status(503);
        });
        let limited = server.mock(|when, then| {
            when.method(GET).path("/migrations");
            then.status(429);
        });
        let missing = server.mock(|when, then| {
            when.method(GET).path("/bulk-data/default_cards");
            then.status(404);
        });

        let flaky_result = Client::new(server.base_url()).fetch_sets().await;
        assert!(
            matches!(&flaky_result, Err(ScryfallError::Unexpected(m)) if m.contains("503")),
            "three 503s give up and report the last one: {flaky_result:?}"
        );
        assert_eq!(flaky.calls(), MAX_ATTEMPTS as usize, "a 5xx is retried");

        assert!(matches!(
            Client::new(server.base_url()).fetch_migrations().await,
            Err(ScryfallError::RateLimited { .. })
        ));
        assert_eq!(limited.calls(), 1, "a 429 is never retried");

        assert!(Client::new(server.base_url())
            .check_bulk_update(None)
            .await
            .is_err());
        assert_eq!(missing.calls(), 1, "a 404 is an answer, not a blip");
    }

    /// A `next_page` chain that walks A→B→A is not a loop the `next == url` guard can
    /// see. There are ~1 050 sets across a handful of pages, so twenty is an order of
    /// magnitude of headroom and still a bound.
    #[tokio::test]
    async fn set_pagination_stops_at_the_page_cap() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/sets").query_param("page", "2");
            then.status(200).json_body(serde_json::json!({
                "has_more": true,
                "next_page": format!("{}/sets?page=1", server.base_url()),
                "data": [{"code":"b","name":"B"}]}));
        });
        server.mock(|when, then| {
            when.method(GET).path("/sets");
            then.status(200).json_body(serde_json::json!({
                "has_more": true,
                "next_page": format!("{}/sets?page=2", server.base_url()),
                "data": [{"code":"a","name":"A"}]}));
        });
        let c = Client::new(server.base_url());

        let sets = c.fetch_sets().await.unwrap();

        assert_eq!(sets.len(), MAX_SET_PAGES, "the cap, not an infinite loop");
    }

    /// The log the reconciler runs on. Both strategies have to survive the trip: a
    /// `merge` carries a `new_scryfall_id` and a `delete` carries none, and collapsing
    /// the second into the first would repoint every discarded card at nothing.
    #[tokio::test]
    async fn fetch_migrations_reads_both_strategies_across_pages() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET)
                .path("/migrations")
                .query_param("page", "2")
                // The mandatory headers must survive the pagination hop here too.
                .header("user-agent", USER_AGENT)
                .header_exists("accept");
            then.status(200).json_body(serde_json::json!({
            "object": "list", "has_more": false,
            "data": [{
                "id": "mig-2", "object": "migration",
                "performed_at": "2026-07-02",
                "migration_strategy": "delete",
                "old_scryfall_id": "gone-id",
                "note": "Not a real card."
            }]}));
        });
        server.mock(|when, then| {
            when.method(GET)
                .path("/migrations")
                .header("user-agent", USER_AGENT)
                .header_exists("accept");
            then.status(200).json_body(serde_json::json!({
            "object": "list", "has_more": true,
            "next_page": format!("{}/migrations?page=2", server.base_url()),
            "data": [
                {
                    "id": "mig-1", "object": "migration",
                    "performed_at": "2026-07-01",
                    "migration_strategy": "merge",
                    "old_scryfall_id": "old-id",
                    "new_scryfall_id": "new-id"
                },
                // No id and no old id: nothing this app could act on, and acting on
                // it anyway would mean writing a bookkeeping row keyed on "".
                {"object": "migration", "migration_strategy": "merge"}
            ]}));
        });
        let c = Client::new(server.base_url());

        let migrations = c.fetch_migrations().await.unwrap();

        assert_eq!(migrations.len(), 2, "the unusable row is dropped");
        assert_eq!(migrations[0].id, "mig-1");
        assert_eq!(migrations[0].strategy, "merge");
        assert_eq!(migrations[0].old_card_id, "old-id");
        assert_eq!(migrations[0].new_card_id.as_deref(), Some("new-id"));
        assert_eq!(migrations[0].performed_at.as_deref(), Some("2026-07-01"));
        assert_eq!(migrations[1].strategy, "delete");
        assert_eq!(
            migrations[1].new_card_id, None,
            "a delete migrates to nowhere, and must not be read as a merge"
        );
        assert_eq!(migrations[1].note.as_deref(), Some("Not a real card."));
    }

    /// The same A→B→A chain `fetch_sets` is bounded against, on the same reasoning: the
    /// `next == url` guard cannot see a two-page cycle, and this call runs on every sync.
    #[tokio::test]
    async fn migration_pagination_stops_at_the_page_cap() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET)
                .path("/migrations")
                .query_param("page", "2");
            then.status(200).json_body(serde_json::json!({
                "has_more": true,
                "next_page": format!("{}/migrations?page=1", server.base_url()),
                "data": [{"id":"b","migration_strategy":"delete","old_scryfall_id":"b-old"}]}));
        });
        server.mock(|when, then| {
            when.method(GET).path("/migrations");
            then.status(200).json_body(serde_json::json!({
                "has_more": true,
                "next_page": format!("{}/migrations?page=2", server.base_url()),
                "data": [{"id":"a","migration_strategy":"delete","old_scryfall_id":"a-old"}]}));
        });
        let c = Client::new(server.base_url());

        let migrations = c.fetch_migrations().await.unwrap();

        assert_eq!(
            migrations.len(),
            MAX_MIGRATION_PAGES,
            "the cap, not an infinite loop"
        );
    }

    #[tokio::test]
    async fn fetch_sets_follows_pagination() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET)
                .path("/sets")
                .query_param("page", "2")
                // The mandatory headers must survive the pagination hop too: without
                // them this mock stops matching and the assertions below fail.
                .header("user-agent", USER_AGENT)
                .header_exists("accept");
            then.status(200).json_body(serde_json::json!({
                "has_more": false, "data": [{"code":"dom","name":"Dominaria","arena_code":"dar"}]}));
        });
        server.mock(|when, then| {
            when.method(GET)
                .path("/sets")
                .header("user-agent", USER_AGENT)
                .header_exists("accept");
            then.status(200).json_body(serde_json::json!({
                "has_more": true,
                "next_page": format!("{}/sets?page=2", server.base_url()),
                "data": [{"code":"lea","name":"Limited Edition Alpha"}]}));
        });
        let c = Client::new(server.base_url());
        let sets = c.fetch_sets().await.unwrap();
        assert_eq!(sets.len(), 2);
        assert_eq!(sets[1].arena_code.as_deref(), Some("dar"));
    }
}
