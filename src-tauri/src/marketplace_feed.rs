//! The Card Kingdom and Mana Pool price feeds: fetch, parse, and replace.
//!
//! Two public, unauthenticated, bulk price lists, both **keyed by `scryfall_id`** — which is
//! the fact the whole design turns on, because it makes the join exact and the fuzzy
//! name+edition matching an earlier spec assumed unnecessary. Everything below was measured
//! live on 2026-08-12; see
//! `docs/superpowers/research/2026-08-12-card-kingdom-mana-pool-price-feeds.md`.
//!
//! | | Card Kingdom | Mana Pool |
//! | --- | --- | --- |
//! | Endpoint | `api.cardkingdom.com/api/v2/pricelist` | `manapool.com/api/v1/prices/singles` |
//! | Payload | 63.7 MiB | 48.4 MiB |
//! | Rows | 149 989 | 102 321 |
//! | Shape | one row per SKU (printing × finish × variation) | one row per printing, finishes as columns |
//! | Built-at stamp | `meta.created_at` | none |
//!
//! Five rules shape this module, and each of them is a trap that was measured rather than
//! guessed:
//!
//! * **Near Mint from both, or the comparison is a lie.** Card Kingdom's `price_retail` *is*
//!   its NM price (it equals `condition_values.nm_price` on every row inspected). Mana Pool's
//!   bare `price_cents` is the **cheapest copy in any condition** and averages 1.20× below
//!   `price_cents_nm` — so taking each feed's headline number would make Mana Pool look
//!   systematically cheaper than Card Kingdom when it is not. Only the `*_nm*` columns are
//!   read here.
//! * **Neither key is unique, so the pick has to be deterministic.** Card Kingdom has 186
//!   colliding `(scryfall_id, finish)` keys over 1 039 excess rows and Mana Pool 2 819 excess
//!   rows — almost all double-faced tokens, where the shop stocks two physical backs under one
//!   Scryfall id. **Cheapest wins, tie-broken by the feed's own row id** ([`FeedRow::row_id`]),
//!   so a card's price does not flicker between refreshes for a reason no reader can see.
//! * **Absent is not zero.** A finish a feed does not quote gets **no row**. `$0.00` is a price
//!   nobody offered, and the app renders absence as an em dash.
//! * **A failed refresh leaves the previous prices in place** and writes the reason to
//!   `error_log`. Stale prices with an honest as-of line beat an empty table — which is why
//!   the parse finishes *before* the write begins, and why a feed that yields no rows at all
//!   is refused outright ([`FeedError::Empty`], the same reasoning [`crate::ingest`] applies
//!   to a bulk file that holds no cards).
//! * **This is not Scryfall.** These hosts have their own client, their own timeouts and no
//!   share of Scryfall's rate-limit budget or its 429 penalty state. A price feed being slow
//!   must never be a reason the card corpus stops syncing, or the reverse.
//!
//! # Adding a third feed
//!
//! Implement [`FeedProvider`] and add the value to [`PROVIDERS`]. Nothing else branches on a
//! marketplace id: the fetch, the dedupe, the replace, the meta row, the status command and
//! the progress event are all written once against the trait.

use crate::sync::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::{DeserializeOwned, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

/// The event a refresh reports itself through — the ribbon's `Activity` line reads it, the
/// way it reads `sync:progress` and `update:progress`.
///
/// **Its own event rather than a new `sync::PHASES` value**, because that list is a closed
/// union on the TypeScript side (`SyncPhase`, plus a total `PHASE_LABEL` map over it) and a
/// phase it does not know renders as `undefined`. A price refresh is also not a sync: it can
/// run while one is in flight, and the two would otherwise fight over one line.
pub const PROGRESS_EVENT: &str = "marketplace:progress";

/// Every value [`FeedProgress::phase`] takes, in the order one refresh produces them.
/// Mirrored by hand on the other side of the IPC boundary.
pub const FEED_PHASES: [&str; 4] = ["downloading", "ingesting", "done", "error"];

/// Bytes of download between progress events. reqwest's chunk callback fires thousands of
/// times over 63.7 MiB, which is far more than a progress bar can use — [`crate::sync`]'s
/// number, for its reason.
const PROGRESS_EMIT_BYTES: u64 = 1_000_000;

/// The largest feed body this process will accept.
///
/// A bound on what a host that is not the one we think it is can make this process spend, not
/// a budget: the two feeds are 63.7 and 48.4 MiB, so 256 MiB is four times the larger one and
/// still a number a wrong answer cannot hide behind. Enforced against the streamed total as
/// well as the declared `Content-Length`, because a chunked response declares nothing.
const MAX_FEED_BYTES: u64 = 256 * 1024 * 1024;

/// A batch size, used only to size the fixture that proves the parse does not depend on
/// holding the whole document — [`crate::ingest`]'s `BATCH` is the number it echoes.
///
/// **There is deliberately no batching in [`store`].** The ingest chunks its transaction
/// because it writes for ~80 s and the write lock is what a user's edit waits on; this one
/// cannot, because a replace that committed in pieces would leave a reader looking at half of
/// yesterday's prices and half of today's, and a failure partway would leave that state
/// permanently. The locking is bought in the other half instead: the parse, which is the slow
/// part, runs with no lock held at all.
#[cfg(test)]
const BATCH: usize = 5_000;

/// How long a fetched feed stays fresh. Card Kingdom's `meta.created_at` shows a daily
/// regeneration and neither endpoint advertises an incremental mode, so once a day per
/// *selected* marketplace is the ceiling worth asking for — and fetching a feed nobody has
/// selected is pure waste.
pub const REFRESH_INTERVAL_SECS: i64 = 86_400;

/// The connect timeout. These are ordinary web hosts, not a CDN this app has measured.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// The longest gap between two chunks of a feed body before the connection is called dead.
/// Deliberately *not* an overall timeout: 63.7 MiB legitimately runs for a minute on a slow
/// line, and a `timeout()` would kill it partway every time — [`crate::scryfall`]'s rule.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

// The three finish names, read by index off the one vocabulary rather than respelled —
// `deck_audit::ADD = schema::AUDIT_KINDS[0]`'s shape. Both feeds file rows under these and
// `marketplace_prices.finish` CHECKs them.
const NONFOIL: &str = crate::schema::FINISHES[0];
const FOIL: &str = crate::schema::FINISHES[1];
const ETCHED: &str = crate::schema::FINISHES[2];

// ---------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------

/// One priced row, after the feed's own shape has been thrown away.
#[derive(Debug, Clone, PartialEq)]
pub struct FeedRow {
    /// A Scryfall id. Rows without one are skipped before they ever become a `FeedRow` —
    /// 832 of Card Kingdom's 149 989 are unjoinable, which is a fact about their catalogue
    /// and not an error.
    pub card_id: String,
    /// One of [`crate::schema::FINISHES`].
    pub finish: &'static str,
    /// Near Mint, in the marketplace's currency (USD for both feeds today).
    pub price: f64,
    /// The tie-break, and the whole of what makes a collision resolve the same way twice.
    ///
    /// The feed's own row id where it publishes one — Card Kingdom's `id` — and the row's
    /// ordinal position in the payload otherwise. Both are stable for a given payload; the
    /// published id is stable across regenerations too, which is why it is preferred.
    pub row_id: i64,
}

impl FeedRow {
    /// Does `self` beat `other` for the same `(card_id, finish)`?
    ///
    /// Cheapest first, then lowest row id. `total_cmp` rather than `partial_cmp`: a NaN price
    /// cannot reach here (the parsers refuse anything not finite and positive), and a total
    /// order means this can never be the thing that panics inside a 150 000-row fold.
    fn beats(&self, other: &FeedRow) -> bool {
        match self.price.total_cmp(&other.price) {
            std::cmp::Ordering::Less => true,
            std::cmp::Ordering::Greater => false,
            std::cmp::Ordering::Equal => self.row_id < other.row_id,
        }
    }
}

/// One feed, parsed, deduplicated, and ready to replace a marketplace's rows.
#[derive(Debug, Clone)]
pub struct Feed {
    pub marketplace: &'static str,
    /// The feed's own build stamp, verbatim — Card Kingdom's `meta.created_at`. `None` for a
    /// feed that publishes none, which is not the same thing as "fetched just now" and must
    /// never be filled in from the clock.
    pub feed_built_at: Option<String>,
    /// The winner per `(card_id, finish)`.
    pub prices: HashMap<(String, &'static str), FeedRow>,
    /// Rows the payload held, including the ones that produced nothing.
    pub rows_seen: u64,
    /// Rows that produced no price at all: no `scryfall_id`, no NM figure, an unparseable
    /// one. Counted rather than fatal — [`crate::ingest`]'s rule, for its reason.
    pub skipped: u64,
    /// Rows that lost a `(card_id, finish)` collision. 1 039 for Card Kingdom, 2 819 for Mana
    /// Pool when measured; a number that suddenly moves is worth seeing.
    pub collisions: u64,
}

impl Feed {
    fn new(marketplace: &'static str) -> Feed {
        Feed {
            marketplace,
            feed_built_at: None,
            prices: HashMap::new(),
            rows_seen: 0,
            skipped: 0,
            collisions: 0,
        }
    }

    /// Fold one candidate in, keeping the better of it and whatever is already under its key.
    fn offer(&mut self, row: FeedRow) {
        let key = (row.card_id.clone(), row.finish);
        match self.prices.get_mut(&key) {
            None => {
                self.prices.insert(key, row);
            }
            Some(held) => {
                self.collisions += 1;
                if row.beats(held) {
                    *held = row;
                }
            }
        }
    }

    /// How many rows a replace will write.
    pub fn row_count(&self) -> usize {
        self.prices.len()
    }
}

// ---------------------------------------------------------------------------------------
// The provider trait
// ---------------------------------------------------------------------------------------

/// One price feed. A third one is a new implementation and one line in [`PROVIDERS`].
pub trait FeedProvider: Send + Sync {
    /// The marketplace id this feed prices — one of [`crate::marketplace::MARKETPLACE_IDS`],
    /// and the value written into `marketplace_prices.marketplace`.
    fn marketplace(&self) -> &'static str;

    /// Where the feed lives.
    fn url(&self) -> &'static str;

    /// Read the whole body in one streaming pass, folding every priced row into `feed`.
    ///
    /// **`Deserializer::from_reader`, never `from_str`.** 63.7 MiB of JSON text expands to
    /// several times that as live `serde_json::Value`s, and none of it is needed at once: the
    /// only thing that outlives a row is the deduplicated map, which is ~100 000 entries of a
    /// key and two numbers.
    fn parse(&self, body: &mut dyn Read, feed: &mut Feed) -> Result<(), FeedError>;
}

/// Every feed this build can fetch. The *only* place a marketplace id is mapped to a feed.
pub const PROVIDERS: [&dyn FeedProvider; 2] = [&CardKingdom, &ManaPool];

/// The provider for a marketplace id, or `None` for one this build cannot price from a feed
/// (TCGplayer and Cardmarket come out of `cards.prices`; Card trader has no bulk download).
pub fn provider_for(marketplace: &str) -> Option<&'static dyn FeedProvider> {
    PROVIDERS
        .iter()
        .copied()
        .find(|p| p.marketplace() == marketplace)
}

/// Is this marketplace priced from a downloaded feed?
pub fn is_feed_backed(marketplace: &str) -> bool {
    provider_for(marketplace).is_some()
}

// ---------------------------------------------------------------------------------------
// Card Kingdom
// ---------------------------------------------------------------------------------------

/// `https://api.cardkingdom.com/api/v2/pricelist` — `{ meta, data }`, one row per SKU.
pub struct CardKingdom;

/// One `data` entry, narrowed to the five fields that matter.
///
/// Everything is `Option` and nothing is `deny_unknown_fields`: this is somebody else's
/// catalogue, it grows keys without notice, and a row missing a field is a row to skip rather
/// than a reason to abandon 149 988 good ones.
#[derive(Debug, Deserialize)]
struct CkRow {
    /// Card Kingdom's own row id — the tie-break, and stable across regenerations in a way
    /// an ordinal is not.
    #[serde(default)]
    id: Option<i64>,
    #[serde(default)]
    scryfall_id: Option<String>,
    /// Free text. Read for **one** test and nothing else: `/etched/i`. Its other values —
    /// `Promo Pack` (5 061), `Prerelease Foil` (3 828), `Extended Art` (3 268), `Showcase`
    /// (1 408), `Borderless` (838), `Retro Frame` (414) — are separate printings in Scryfall
    /// with ids of their own, so parsing them here would invent a distinction the key already
    /// carries.
    #[serde(default)]
    variation: Option<String>,
    /// **The string `"true"`/`"false"`, not a boolean** (87 001 / 62 988 when counted). A
    /// `bool` here deserialises to an error on every row and would file the entire catalogue
    /// as nonfoil. Accepted as either shape so that the day they fix it is not the day every
    /// foil price silently becomes a nonfoil one.
    #[serde(default)]
    is_foil: Option<serde_json::Value>,
    /// A decimal string, and Card Kingdom's Near Mint price: it equals
    /// `condition_values.nm_price` on every row inspected, while `ex`/`vg`/`g` step down from
    /// it. Parsed from the decimal text, never through an intermediate.
    #[serde(default)]
    price_retail: Option<serde_json::Value>,
}

impl FeedProvider for CardKingdom {
    fn marketplace(&self) -> &'static str {
        "cardkingdom"
    }

    fn url(&self) -> &'static str {
        "https://api.cardkingdom.com/api/v2/pricelist"
    }

    fn parse(&self, body: &mut dyn Read, feed: &mut Feed) -> Result<(), FeedError> {
        let mut ordinal: i64 = 0;
        let built_at = read_document::<CkRow>(body, &mut |row| {
            let position = ordinal;
            ordinal += 1;
            feed.rows_seen += 1;

            // 832 of 149 989 carry no Scryfall id. Unjoinable, not an error.
            let Some(card_id) = row.scryfall_id.filter(|id| !id.trim().is_empty()) else {
                feed.skipped += 1;
                return;
            };
            let Some(price) = row.price_retail.as_ref().and_then(decimal) else {
                feed.skipped += 1;
                return;
            };
            feed.offer(FeedRow {
                card_id,
                finish: ck_finish(row.variation.as_deref(), row.is_foil.as_ref()),
                price,
                // Their id where they publish one; the ordinal where they do not.
                row_id: row.id.unwrap_or(position),
            });
        })?;
        feed.feed_built_at = built_at;
        Ok(())
    }
}

/// Card Kingdom's finish rule, which spans two fields:
///
/// ```text
/// etched  if variation matches /etched/i
/// foil    else if is_foil == "true"
/// nonfoil otherwise
/// ```
///
/// Etched lives in the free-text `variation` (1 162 rows match `/etch/i`, of which 703 are
/// exactly `Foil Etched`) and is checked **first**, because those rows are also `is_foil:
/// "true"` — reversing the two would file every etched card as an ordinary foil.
fn ck_finish(variation: Option<&str>, is_foil: Option<&serde_json::Value>) -> &'static str {
    if variation.is_some_and(|v| v.to_ascii_lowercase().contains("etched")) {
        return ETCHED;
    }
    if is_foil.is_some_and(is_true) {
        return FOIL;
    }
    NONFOIL
}

/// `"true"` and `true`, and nothing else. The string is what the feed sends today; the
/// boolean is here so that a future correction on their side is not a silent regression here.
fn is_true(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::String(s) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// A price that arrived as a decimal string (`"0.35"`), or as a number if the feed ever
/// changes its mind. `None` for anything that is not a real, positive amount — a zero, a
/// negative, an infinity, an empty string. **`None` means "no row", never "0.00"**.
fn decimal(value: &serde_json::Value) -> Option<f64> {
    let parsed = match value {
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
        serde_json::Value::Number(n) => n.as_f64(),
        _ => None,
    }?;
    (parsed.is_finite() && parsed > 0.0).then_some(parsed)
}

// ---------------------------------------------------------------------------------------
// Mana Pool
// ---------------------------------------------------------------------------------------

/// `https://manapool.com/api/v1/prices/singles` — `{ data }`, one row per printing with the
/// finishes as columns.
pub struct ManaPool;

/// One `data` entry: an id and the three Near Mint columns.
///
/// **The `_nm` ones and not the bare `price_cents*`.** The bare family is the cheapest copy in
/// *any* condition and averages 1.20× below the NM figure over a 4 000-row sample where both
/// exist — mixing them in would make this marketplace look systematically cheaper than Card
/// Kingdom, which is the exact trap the research doc records. The cost of insisting on NM is
/// 3.1 % of the nonfoil coverage (85 979 NM-priced rows against 88 702 priced at all), and it
/// buys a number comparable with Card Kingdom, TCGplayer and Cardmarket.
#[derive(Debug, Deserialize)]
struct MpRow {
    #[serde(default)]
    scryfall_id: Option<String>,
    /// **Integer cents.** `218` is $2.18. Divided once, here at the edge, and never again.
    #[serde(default)]
    price_cents_nm: Option<i64>,
    #[serde(default)]
    price_cents_nm_foil: Option<i64>,
    /// The finish Cardmarket structurally cannot supply — `eur_etched` does not exist in
    /// Scryfall's data — and Mana Pool prices 1 198 rows of it.
    #[serde(default)]
    price_cents_nm_etched: Option<i64>,
}

impl FeedProvider for ManaPool {
    fn marketplace(&self) -> &'static str {
        "manapool"
    }

    fn url(&self) -> &'static str {
        "https://manapool.com/api/v1/prices/singles"
    }

    fn parse(&self, body: &mut dyn Read, feed: &mut Feed) -> Result<(), FeedError> {
        let mut ordinal: i64 = 0;
        read_document::<MpRow>(body, &mut |row| {
            let position = ordinal;
            ordinal += 1;
            feed.rows_seen += 1;

            let Some(card_id) = row.scryfall_id.filter(|id| !id.trim().is_empty()) else {
                feed.skipped += 1;
                return;
            };
            let quoted = [
                (NONFOIL, row.price_cents_nm),
                (FOIL, row.price_cents_nm_foil),
                (ETCHED, row.price_cents_nm_etched),
            ];
            let mut priced = false;
            for (finish, cents) in quoted {
                // **A null column means that finish is unpriced: no row, never a zero.** One
                // row per printing means this loop runs three times for a card that is only
                // sold in one finish, and two of those must produce nothing at all.
                let Some(price) = cents.and_then(from_cents) else {
                    continue;
                };
                priced = true;
                feed.offer(FeedRow {
                    card_id: card_id.clone(),
                    finish,
                    price,
                    // Mana Pool publishes no per-row id, so the ordinal is the tie-break —
                    // stable for a payload, which is all a collision needs.
                    row_id: position,
                });
            }
            if !priced {
                feed.skipped += 1;
            }
        })?;
        // No `meta.created_at`, and none is invented: `feed_built_at` stays NULL.
        Ok(())
    }
}

/// Integer cents to an amount. `None` for anything that is not a real, positive price — the
/// same rule [`decimal`] applies, so an absent finish and a nonsensical one both write no row.
fn from_cents(cents: i64) -> Option<f64> {
    (cents > 0).then(|| cents as f64 / 100.0)
}

// ---------------------------------------------------------------------------------------
// The streaming reader
// ---------------------------------------------------------------------------------------

/// Read `{ … "data": [ … ] … }` from `body`, handing every element to `sink` as it arrives and
/// returning `meta.created_at` if the document carries one.
///
/// Both feeds are the same document shape, so this is written once. What makes it *streaming*
/// is [`Rows`] below: `next_element` decodes one row, `sink` consumes it, and the row is
/// dropped before the next is read. Nothing but the deduplicated map is alive at the end.
///
/// Keys are walked in whatever order the document uses — Card Kingdom puts `meta` first today,
/// and nothing here depends on it — and unknown keys are skipped with `IgnoredAny`, which
/// still *parses* their values but builds nothing from them.
fn read_document<R: DeserializeOwned>(
    body: &mut dyn Read,
    sink: &mut dyn FnMut(R),
) -> Result<Option<String>, FeedError> {
    let mut de = serde_json::Deserializer::from_reader(std::io::BufReader::new(body));
    Ok(Document {
        sink,
        _row: PhantomData::<R>,
    }
    .deserialize(&mut de)?)
}

struct Document<'a, R> {
    sink: &'a mut dyn FnMut(R),
    _row: PhantomData<R>,
}

impl<'de, R: DeserializeOwned> DeserializeSeed<'de> for Document<'_, R> {
    /// `meta.created_at`, where the feed publishes one.
    type Value = Option<String>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de, R: DeserializeOwned> Visitor<'de> for Document<'_, R> {
    type Value = Option<String>;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a price feed object with a `data` array")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut built_at = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                // Read as a `Value` rather than a struct: `meta` is somebody else's object and
                // a shape this app does not expect must not fail the 63.7 MiB behind it.
                "meta" => {
                    let meta: serde_json::Value = map.next_value()?;
                    built_at = meta
                        .get("created_at")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned);
                }
                // Reborrowed, not moved: this loop may see more keys after `data`.
                "data" => map.next_value_seed(Rows {
                    sink: &mut *self.sink,
                    _row: PhantomData::<R>,
                })?,
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(built_at)
    }
}

/// The array, one element at a time.
struct Rows<'a, R> {
    sink: &'a mut dyn FnMut(R),
    _row: PhantomData<R>,
}

impl<'de, R: DeserializeOwned> DeserializeSeed<'de> for Rows<'_, R> {
    type Value = ();

    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_seq(self)
    }
}

impl<'de, R: DeserializeOwned> Visitor<'de> for Rows<'_, R> {
    type Value = ();

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("an array of price rows")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(row) = seq.next_element::<R>()? {
            (self.sink)(row);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum FeedError {
    #[error("could not reach {host}: {source}")]
    Http {
        host: &'static str,
        #[source]
        source: reqwest::Error,
    },
    #[error("{host} answered {status}")]
    Status { host: &'static str, status: u16 },
    /// The body is longer than [`MAX_FEED_BYTES`], declared or streamed.
    #[error("the price feed from {host} is larger than {MAX_FEED_BYTES} bytes; refusing it")]
    TooLarge { host: &'static str },
    #[error("could not read the downloaded price feed: {0}")]
    Io(#[from] std::io::Error),
    #[error("the price feed could not be read as JSON: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("could not store the prices: {0}")]
    Db(#[from] rusqlite::Error),
    /// The document parsed and held no usable price. A gzipped error page, an empty
    /// `data: []`, a schema change that renamed every field — all land here, and none of them
    /// may be allowed to replace a working price table with nothing. [`crate::ingest`] refuses
    /// an empty bulk file for the same reason.
    #[error("the price feed held no prices ({skipped} rows skipped); keeping the previous ones")]
    Empty { skipped: u64 },
    #[error("{0}")]
    Busy(&'static str),
}

impl FeedError {
    /// How the error log should classify this. The two a reader acts on differently — a dead
    /// connection and a body that is not what it claimed — must never be flattened into
    /// "http".
    pub fn kind(&self) -> crate::errors::Kind {
        use crate::errors::Kind;
        match self {
            FeedError::Http { source, .. } if source.is_timeout() => Kind::Timeout,
            FeedError::Http { .. } => Kind::Http,
            FeedError::Status { .. } => Kind::Http,
            FeedError::TooLarge { .. } => Kind::Http,
            FeedError::Io(_) => Kind::Io,
            FeedError::Db(_) => Kind::Io,
            FeedError::Parse(_) | FeedError::Empty { .. } => Kind::Parse,
            FeedError::Busy(_) => Kind::Other,
        }
    }
}

// ---------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------

/// What a completed refresh did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ingested {
    pub written: usize,
    pub skipped: u64,
    pub collisions: u64,
}

/// Replace one marketplace's prices with `feed`'s, and stamp `marketplace_feed_meta`.
///
/// **One transaction, and that is the contract**: a reader either sees the whole of the old
/// feed or the whole of the new one, never a table half-swapped — and a failure partway leaves
/// yesterday's prices, rather than half of each. This is where this module deliberately parts
/// company with [`crate::ingest`], which chunks its transaction: the bulk load writes into an
/// invisible staging table for ~80 s, so its commits cost a reader nothing, while these rows
/// are the live ones.
///
/// **The write lock is therefore held for the length of the replace**, and that is measured
/// rather than assumed: over a synthetic 149 833-row feed, `DELETE` + insert took **2.20 s in
/// a release build and 3.19 s in a debug one** (2026-08-12, Windows). Both are inside
/// [`crate::db::WRITE_LOCK_WAIT`]'s five seconds, so a collection edit made during a refresh
/// waits rather than being refused — but not by much, which is the number to re-measure if
/// either feed grows. The expensive half is bought elsewhere: the parse (192 ms release /
/// 1.50 s debug over a 15 MiB body, and more over the real 63.7 MiB one) runs with no lock
/// held at all.
///
/// Answers [`FeedError::Busy`] rather than queueing if a sync holds the connection, which is
/// what every user-facing write in this crate does.
pub fn store(db: &Mutex<Connection>, feed: &Feed, fetched_at: i64) -> Result<Ingested, FeedError> {
    if feed.prices.is_empty() {
        return Err(FeedError::Empty {
            skipped: feed.skipped,
        });
    }
    let Some(mut conn) = crate::db::lock_for(db, crate::db::WRITE_LOCK_WAIT) else {
        return Err(FeedError::Busy(crate::db::BUSY));
    };
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM marketplace_prices WHERE marketplace = ?1",
        params![feed.marketplace],
    )?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO marketplace_prices (marketplace, card_id, finish, price)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        // One statement, prepared once and run ~100 000 times: `prepare_cached` is what keeps
        // the planner out of the loop, exactly as the bulk ingest's staging insert does.
        for row in feed.prices.values() {
            stmt.execute(params![
                feed.marketplace,
                row.card_id,
                row.finish,
                row.price
            ])?;
        }
    }
    tx.execute(
        "INSERT INTO marketplace_feed_meta (marketplace, fetched_at, feed_built_at, row_count)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(marketplace) DO UPDATE SET
            fetched_at = excluded.fetched_at,
            feed_built_at = excluded.feed_built_at,
            row_count = excluded.row_count",
        params![
            feed.marketplace,
            fetched_at,
            feed.feed_built_at,
            feed.prices.len() as i64
        ],
    )?;
    tx.commit()?;
    Ok(Ingested {
        written: feed.prices.len(),
        skipped: feed.skipped,
        collisions: feed.collisions,
    })
}

/// Parse a downloaded feed off disk and replace the marketplace's rows with it.
///
/// The blocking half of a refresh, and the reason the two halves are separate functions: the
/// parse is seconds of CPU and the write is a lock this app is careful with, so neither
/// belongs on the async runtime and neither may hold the other's resource.
///
/// A failure here is written to `error_log` and the previous prices are left exactly where
/// they were.
pub fn ingest_file(
    db: &Mutex<Connection>,
    provider: &dyn FeedProvider,
    path: &Path,
    fetched_at: i64,
) -> Result<Ingested, FeedError> {
    let result = (|| {
        let mut file = std::fs::File::open(path)?;
        let mut feed = Feed::new(provider.marketplace());
        provider.parse(&mut file, &mut feed)?;
        store(db, &feed, fetched_at)
    })();
    if let Err(e) = &result {
        note_failure(db, provider, e);
    }
    result
}

/// Write a failed refresh to `error_log`, best-effort.
///
/// **`Source::Database` is the closest source this schema has, and it is not a good fit** —
/// these are HTTP failures against `api.cardkingdom.com` and `manapool.com`, neither of which
/// is this app's own SQLite. A `marketplace_feed` source would need a CHECK rebuild on
/// `error_log`, a variant in [`crate::errors::Source`] and an arm in the frontend's total
/// `SOURCE_LABEL` map, which is a three-file change this module does not own. The `operation`
/// carries the marketplace instead — that field is free text precisely so a new call site can
/// report a failure without a migration first.
fn note_failure(db: &Mutex<Connection>, provider: &dyn FeedProvider, err: &FeedError) {
    // Skipped rather than waited for if the connection is busy: this describes a failure that
    // has already happened, on a path that is already returning an error.
    if let Some(conn) = crate::db::lock_for(db, crate::db::WRITE_LOCK_WAIT) {
        crate::errors::record(
            &conn,
            crate::errors::Source::Database,
            &format!("marketplace_feed:{}", provider.marketplace()),
            err.kind(),
            &err.to_string(),
            Some(provider.url()),
        );
    }
}

// ---------------------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------------------

/// The HTTP client these two hosts are talked to with.
///
/// **Deliberately not [`crate::scryfall::Client`].** That one paces itself against Scryfall's
/// documented per-endpoint intervals and remembers a 429 lockout across restarts; routing a
/// marketplace feed through it would spend Scryfall's budget on a host Scryfall has nothing to
/// do with, and — worse — a marketplace 429 would lock the card corpus out of syncing. The
/// user agent is shared because it is accurate for both: it names this app, its version and
/// its repository, which is what a bulk endpoint is owed.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(crate::scryfall::USER_AGENT)
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .build()
            .unwrap_or_default()
    })
}

/// The host in a URL, for a message a person can act on. Falls back to the whole URL.
fn host_of(url: &'static str) -> &'static str {
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or(url)
}

/// Stream a feed to `dest`, reporting `(done, total)` as it goes.
///
/// To a file and not into memory, for [`crate::sync`]'s reason: the parse wants a `Read` and
/// reqwest only offers an async stream, so the choice is a temp file or 63.7 MiB of `Vec<u8>`
/// held while a second copy of it is decoded. `total` is `0` when the host declares no
/// `Content-Length`, which is a progress bar with no denominator rather than an error.
pub async fn download(
    url: &'static str,
    dest: &Path,
    progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<(), FeedError> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let host = host_of(url);
    let resp = client()
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|source| FeedError::Http { host, source })?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(FeedError::Status { host, status });
    }
    // The cheap check first: a declared length past the bound is refused before a byte of
    // body is read. It is a claim, though, and a chunked response makes none — so the
    // streamed total below is the one that actually holds.
    let total = resp.content_length().unwrap_or(0);
    if total > MAX_FEED_BYTES {
        return Err(FeedError::TooLarge { host });
    }

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut file = tokio::fs::File::create(dest).await?;
    let mut done = 0u64;
    let mut last_emit = 0u64;
    let mut stream = resp.bytes_stream();
    progress(0, total);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|source| FeedError::Http { host, source })?;
        done += chunk.len() as u64;
        if done > MAX_FEED_BYTES {
            return Err(FeedError::TooLarge { host });
        }
        file.write_all(&chunk).await?;
        if done.saturating_sub(last_emit) >= PROGRESS_EMIT_BYTES || done >= total {
            last_emit = done;
            progress(done, total.max(done));
        }
    }
    file.flush().await?;
    Ok(())
}

/// Where a feed is downloaded to. Beside the bulk file's `tmp/`, and deleted either way.
fn temp_path(state: &AppState, provider: &dyn FeedProvider) -> PathBuf {
    state
        .data_dir
        .join("tmp")
        .join(format!("{}-prices.json", provider.marketplace()))
}

// ---------------------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------------------

/// One refresh at a time, per marketplace.
///
/// A module-level registry rather than a field on `AppState`, because it is this module's
/// concern alone and `AppState` is shared with everything else. Two refreshes of the *same*
/// feed would download 63.7 MiB twice to write the same rows; two of *different* feeds are
/// fine and are allowed.
static REFRESHING: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

/// Clears the claim however the refresh ends — an early return, an error, a dropped future.
/// `sync::SyncingGuard`'s shape, for its reason: a latched flag locks the user out until they
/// restart the app.
struct RefreshGuard(&'static str);

impl RefreshGuard {
    /// Claim `marketplace`, or `None` if a refresh of it is already running.
    fn claim(marketplace: &'static str) -> Option<RefreshGuard> {
        let mut held = crate::db::lock_plain(&REFRESHING);
        if held.contains(&marketplace) {
            return None;
        }
        held.push(marketplace);
        Some(RefreshGuard(marketplace))
    }
}

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        crate::db::lock_plain(&REFRESHING).retain(|m| *m != self.0);
    }
}

/// Is a refresh of this marketplace in flight?
fn is_refreshing(marketplace: &str) -> bool {
    crate::db::lock_plain(&REFRESHING).contains(&marketplace)
}

/// Fetch a marketplace's feed and replace its prices.
///
/// `progress` is called with `(phase, done, total)`; the command below turns that into the
/// [`PROGRESS_EVENT`]. Taken as a callback rather than an `AppHandle` for [`crate::ingest`]'s
/// reason — it is what lets the whole path be driven from a test.
///
/// Every failure leaves the previous prices exactly where they were and is written to
/// `error_log`.
pub async fn refresh(
    state: &Arc<AppState>,
    marketplace: &str,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<FeedStatus, String> {
    let Some(provider) = provider_for(marketplace) else {
        return Err(format!(
            "\"{marketplace}\" has no price feed this app can download. Feeds: {}.",
            PROVIDERS
                .iter()
                .map(|p| p.marketplace())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    };
    let Some(_guard) = RefreshGuard::claim(provider.marketplace()) else {
        // Refused rather than queued, exactly as a second concurrent sync is: the run already
        // in flight is the one driving the progress event, and a second would download the
        // same 63.7 MiB to write the same rows.
        return Err(format!(
            "{} prices are already being refreshed.",
            provider.marketplace()
        ));
    };

    let path = temp_path(state, provider);
    progress("downloading", 0, 0);
    if let Err(e) = download(provider.url(), &path, &mut |done, total| {
        progress("downloading", done, total)
    })
    .await
    {
        // The partial is no use to anyone: there is no resume here (neither endpoint offers
        // ranges) and a half-written body would only fail to parse next time.
        let _ = std::fs::remove_file(&path);
        note_failure(&state.db, provider, &e);
        progress("error", 0, 0);
        return Err(e.to_string());
    }

    progress("ingesting", 0, 0);
    let fetched_at = unix_now();
    let joined = {
        let state = state.clone();
        let path = path.clone();
        // Seconds of JSON and ~100 000 inserts: a blocking thread, never the async runtime,
        // and never across an `.await` with a lock in hand.
        tauri::async_runtime::spawn_blocking(move || {
            ingest_file(&state.db, provider, &path, fetched_at)
        })
        .await
    };
    let _ = std::fs::remove_file(&path);

    match joined {
        Ok(Ok(_)) => {
            // The second of the four things that run a full mirror pass (spec §5).
            // `marketplace_prices` maps to no surface on purpose — this refresh rewrites the
            // whole table, and a per-row mark would be ~100 000 hook fires — so the completed
            // refresh is what tells the mirror the `Price` column in every mirrored CSV has
            // moved. One line, at the one place this path succeeds.
            state.mirror.mark_all();
            progress("done", 0, 0);
            Ok(status_of(state, provider))
        }
        Ok(Err(e)) => {
            progress("error", 0, 0);
            Err(e.to_string())
        }
        Err(e) => {
            progress("error", 0, 0);
            Err(format!("the price feed could not be processed: {e}"))
        }
    }
}

// ---------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------

/// What the UI needs to say how stale a price is.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedStatus {
    pub marketplace: String,
    /// Unix seconds. **`None` is "never fetched"** — a different state from a fetch that
    /// failed, and the one that means the price columns are empty rather than stale.
    pub fetched_at: Option<i64>,
    /// The feed's own build stamp, verbatim. `None` where the feed publishes none (Mana Pool)
    /// as well as where nothing has been fetched, which is why it is read beside `fetchedAt`
    /// and never instead of it.
    pub feed_built_at: Option<String>,
    /// Rows stored for this marketplace, as of `fetchedAt`. `None` when never fetched.
    pub row_count: Option<i64>,
    /// Older than [`REFRESH_INTERVAL_SECS`], or never fetched at all.
    pub stale: bool,
    /// A refresh is in flight right now.
    pub refreshing: bool,
}

/// Has this feed earned a refresh? `None` — never fetched — is stale by definition, and a
/// stamp in the future (a clock that moved) counts as stale rather than underflowing.
pub fn is_stale(fetched_at: Option<i64>, now: i64) -> bool {
    match fetched_at {
        None => true,
        Some(at) => at > now || now - at >= REFRESH_INTERVAL_SECS,
    }
}

/// One marketplace's feed state, read through the read-only connection.
fn status_of(state: &AppState, provider: &dyn FeedProvider) -> FeedStatus {
    let conn = crate::sync::lock_db_read(state);
    read_status(&conn, provider, unix_now())
}

/// [`status_of`]'s body, with the connection and the clock handed in.
pub fn read_status(conn: &Connection, provider: &dyn FeedProvider, now: i64) -> FeedStatus {
    let marketplace = provider.marketplace();
    // A row that cannot be read is reported as "never fetched" rather than failing the call:
    // this is the answer a price surface draws its as-of line from, and there is nothing
    // useful it could do with an error that it does not already do with an absence.
    let row: Option<(i64, Option<String>, i64)> = conn
        .query_row(
            "SELECT fetched_at, feed_built_at, row_count
               FROM marketplace_feed_meta WHERE marketplace = ?1",
            params![marketplace],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .ok()
        .flatten();
    FeedStatus {
        marketplace: marketplace.to_owned(),
        fetched_at: row.as_ref().map(|r| r.0),
        feed_built_at: row.as_ref().and_then(|r| r.1.clone()),
        row_count: row.as_ref().map(|r| r.2),
        stale: is_stale(row.as_ref().map(|r| r.0), now),
        refreshing: is_refreshing(marketplace),
    }
}

/// Seconds since the Unix epoch. A clock before 1970 reads as 0, which makes every feed
/// stale — the same choice [`crate::sync`] makes, and for the same reason.
fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// Payload of [`PROGRESS_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedProgress {
    pub marketplace: String,
    /// One of [`FEED_PHASES`].
    pub phase: String,
    pub done: u64,
    pub total: u64,
}

/// Download a marketplace's price feed and replace its prices with it.
///
/// Long-running by nature (63.7 MiB), so it reports itself through [`PROGRESS_EVENT`] for the
/// ribbon's activity line. A failure leaves the previous prices in place, and the reason is in
/// the error log.
#[tauri::command]
pub async fn marketplace_feed_refresh(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    marketplace: String,
) -> Result<FeedStatus, String> {
    let state = state.inner().clone();
    let id = marketplace.clone();
    refresh(&state, &marketplace, &mut |phase, done, total| {
        debug_assert!(FEED_PHASES.contains(&phase), "unknown feed phase `{phase}`");
        // Dropped if nobody is listening, which is Tauri's behaviour and is why
        // `marketplace_feed_status` exists: the event is the fast path, the table is the one
        // a reader can still consult a minute later.
        let _ = app.emit(
            PROGRESS_EVENT,
            FeedProgress {
                marketplace: id.clone(),
                phase: phase.to_owned(),
                done,
                total,
            },
        );
    })
    .await
}

/// Every feed-backed marketplace's state: never fetched, when it was fetched, what the feed
/// itself says it was built at, and how many rows came of it.
///
/// One entry per feed rather than one for the selected marketplace, so Settings can show both
/// without asking twice — and so a marketplace with no feed is simply absent from the answer
/// rather than reported as an empty one.
///
/// `async`, and answered on the blocking pool, because a sync command body runs inline on the
/// IPC thread and this takes `db_read`'s mutex.
#[tauri::command]
pub async fn marketplace_feed_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<FeedStatus>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        let now = unix_now();
        PROVIDERS
            .iter()
            .map(|p| read_status(&conn, *p, now))
            .collect()
    })
    .await
    .map_err(|e| format!("could not read the price feed status: {e}"))
}

/// Refresh the selected marketplace's feed if it is feed-backed and due, at startup.
///
/// **Only the selected one, and only when it is due.** Nobody downloads 63.7 MiB for a
/// marketplace they never picked, and a feed fetched this morning is not fetched again this
/// afternoon. Never fetched counts as due, which is what makes choosing a feed-backed
/// marketplace and restarting enough to get prices.
///
/// Silent and best-effort: this runs before there is a window to complain in, the failure is
/// already in `error_log`, and the honest fallback is the prices already on disk.
pub async fn refresh_selected_if_due(state: &Arc<AppState>, app: &tauri::AppHandle) {
    let (marketplace, fetched_at) = {
        let conn = crate::sync::lock_db_read(state);
        let id = crate::marketplace::stored(&conn);
        let at = provider_for(&id).map(|p| read_status(&conn, p, unix_now()).fetched_at);
        (id, at)
    };
    let Some(fetched_at) = fetched_at else {
        return; // Not a feed-backed marketplace: nothing to download, ever.
    };
    if !is_stale(fetched_at, unix_now()) {
        return;
    }
    let app = app.clone();
    let id = marketplace.clone();
    if let Err(e) = refresh(state, &marketplace, &mut |phase, done, total| {
        let _ = app.emit(
            PROGRESS_EVENT,
            FeedProgress {
                marketplace: id.clone(),
                phase: phase.to_owned(),
                done,
                total,
            },
        );
    })
    .await
    {
        eprintln!("could not refresh {marketplace} prices: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Mutex<Connection> {
        let conn = crate::schema::memory_pair();
        Mutex::new(conn)
    }

    /// Parse a body with a provider, with no database and no network in the way.
    fn collect(provider: &dyn FeedProvider, body: &str) -> Result<Feed, FeedError> {
        let mut feed = Feed::new(provider.marketplace());
        provider.parse(&mut body.as_bytes(), &mut feed)?;
        Ok(feed)
    }

    /// `(card_id, finish) -> price`, sorted, which is what an assertion about a feed actually
    /// wants to read.
    fn priced(feed: &Feed) -> Vec<(String, &'static str, f64)> {
        let mut rows: Vec<_> = feed
            .prices
            .values()
            .map(|r| (r.card_id.clone(), r.finish, r.price))
            .collect();
        rows.sort_by(|a, b| (&a.0, a.1).cmp(&(&b.0, b.1)));
        rows
    }

    fn stored_prices(db: &Mutex<Connection>, marketplace: &str) -> Vec<(String, String, f64)> {
        let conn = crate::db::lock_blocking(db);
        let mut stmt = conn
            .prepare(
                "SELECT card_id, finish, price FROM marketplace_prices
                  WHERE marketplace = ?1 ORDER BY card_id, finish",
            )
            .unwrap();
        let rows = stmt
            .query_map(params![marketplace], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        rows
    }

    // ---- Card Kingdom -----------------------------------------------------------------

    /// **The finish rule, including the fact that `is_foil` is the string `"true"`.** A `bool`
    /// field here would fail to deserialise on every row and file the whole catalogue as
    /// nonfoil; a rule that tested `is_foil` before `variation` would file all 1 162 etched
    /// rows as ordinary foils, because those rows are foil too.
    #[test]
    fn card_kingdom_reads_finish_from_a_string_flag_and_a_free_text_variation() {
        let body = r#"{
          "meta": {"created_at": "2026-08-11 21:07:02"},
          "data": [
            {"id": 1, "scryfall_id": "a", "variation": "", "is_foil": "false", "price_retail": "0.35"},
            {"id": 2, "scryfall_id": "b", "variation": "", "is_foil": "true", "price_retail": "1.50"},
            {"id": 3, "scryfall_id": "c", "variation": "Foil Etched", "is_foil": "true", "price_retail": "9.99"},
            {"id": 4, "scryfall_id": "d", "variation": "ETCHED", "is_foil": "false", "price_retail": "4.00"},
            {"id": 5, "scryfall_id": "e", "variation": "Extended Art", "is_foil": "false", "price_retail": "2.00"},
            {"id": 6, "scryfall_id": "f", "variation": "Promo Pack", "is_foil": "true", "price_retail": "3.00"}
          ]
        }"#;

        let feed = collect(&CardKingdom, body).unwrap();

        assert_eq!(
            priced(&feed),
            vec![
                ("a".into(), "nonfoil", 0.35),
                // The string, and only the string, is what makes this foil.
                ("b".into(), "foil", 1.5),
                // Etched wins over the foil flag, both spellings of it.
                ("c".into(), "etched", 9.99),
                ("d".into(), "etched", 4.0),
                // The other `variation` values are separate Scryfall printings with ids of
                // their own, so they must not become a finish.
                ("e".into(), "nonfoil", 2.0),
                ("f".into(), "foil", 3.0),
            ]
        );
        assert_eq!(
            feed.feed_built_at.as_deref(),
            Some("2026-08-11 21:07:02"),
            "`meta.created_at` is the staleness stamp"
        );
    }

    /// A literal `"true"` is the only thing that reads as foil. `"True"` is accepted (case),
    /// and a real boolean is accepted so that the day they fix the type is not the day every
    /// foil price becomes a nonfoil one — but `1`, `"yes"` and `""` are not foil.
    #[test]
    fn only_a_true_flag_reads_as_foil() {
        use serde_json::json;
        for (flag, want) in [
            (json!("true"), "foil"),
            (json!("True"), "foil"),
            (json!(true), "foil"),
            (json!("false"), "nonfoil"),
            (json!(false), "nonfoil"),
            (json!(1), "nonfoil"),
            (json!("yes"), "nonfoil"),
            (json!(""), "nonfoil"),
            (json!(null), "nonfoil"),
        ] {
            assert_eq!(ck_finish(Some(""), Some(&flag)), want, "flag {flag}");
        }
        assert_eq!(ck_finish(None, None), "nonfoil");
    }

    /// **832 of Card Kingdom's 149 989 rows carry no `scryfall_id`.** They are unjoinable, so
    /// they are counted and stepped over — never guessed at from the name, and never a reason
    /// to abandon the 149 157 rows that are fine.
    #[test]
    fn a_row_with_no_scryfall_id_is_skipped_rather_than_fatal() {
        let body = r#"{"data": [
            {"id": 1, "scryfall_id": "a", "is_foil": "false", "price_retail": "0.35"},
            {"id": 2, "name": "Some Sealed Product", "is_foil": "false", "price_retail": "99.99"},
            {"id": 3, "scryfall_id": "", "is_foil": "false", "price_retail": "5.00"},
            {"id": 4, "scryfall_id": null, "is_foil": "false", "price_retail": "5.00"},
            {"id": 5, "scryfall_id": "b", "is_foil": "false", "price_retail": "0.75"}
        ]}"#;

        let feed = collect(&CardKingdom, body).unwrap();

        assert_eq!(
            priced(&feed),
            vec![("a".into(), "nonfoil", 0.35), ("b".into(), "nonfoil", 0.75)]
        );
        assert_eq!(feed.rows_seen, 5);
        assert_eq!(feed.skipped, 3, "counted, not silently dropped");
        // No `meta` in this document, and none is invented.
        assert_eq!(feed.feed_built_at, None);
    }

    /// A price that is not a real, positive amount is an absent price, and absent is no row —
    /// never `$0.00`, which is a figure nobody quoted.
    #[test]
    fn a_price_that_is_not_a_positive_amount_writes_no_row() {
        let body = r#"{"data": [
            {"id": 1, "scryfall_id": "a", "is_foil": "false", "price_retail": "0.00"},
            {"id": 2, "scryfall_id": "b", "is_foil": "false", "price_retail": ""},
            {"id": 3, "scryfall_id": "c", "is_foil": "false", "price_retail": null},
            {"id": 4, "scryfall_id": "d", "is_foil": "false"},
            {"id": 5, "scryfall_id": "e", "is_foil": "false", "price_retail": "-1.00"},
            {"id": 6, "scryfall_id": "f", "is_foil": "false", "price_retail": "0.35"}
        ]}"#;

        let feed = collect(&CardKingdom, body).unwrap();

        assert_eq!(priced(&feed), vec![("f".into(), "nonfoil", 0.35)]);
        assert_eq!(feed.skipped, 5);
    }

    // ---- Mana Pool --------------------------------------------------------------------

    /// **Integer cents, divided once at the edge**, and the NM columns rather than the bare
    /// ones — which are the cheapest copy in *any* condition and average 1.20× lower, so
    /// mixing them in would make this marketplace look systematically cheaper than Card
    /// Kingdom when it is not.
    #[test]
    fn mana_pool_reads_near_mint_integer_cents() {
        let body = r#"{"data": [
            {"scryfall_id": "a",
             "price_cents": 180, "price_cents_nm": 218,
             "price_cents_foil": 900, "price_cents_nm_foil": 1050,
             "price_cents_etched": 4000, "price_cents_nm_etched": 4250}
        ]}"#;

        let feed = collect(&ManaPool, body).unwrap();

        assert_eq!(
            priced(&feed),
            vec![
                // 218 is $2.18 — not $218, and not the $1.80 the bare column offers.
                ("a".into(), "etched", 42.5),
                ("a".into(), "foil", 10.5),
                ("a".into(), "nonfoil", 2.18),
            ]
        );
        assert_eq!(
            feed.feed_built_at, None,
            "this feed publishes no build stamp, and none may be invented"
        );
    }

    /// A Mana Pool row quoting all three finishes files them under exactly
    /// [`crate::schema::FINISHES`] and nothing else.
    ///
    /// `ck_finish` needs no such test — indexing off the constant binds it at compile time. This
    /// tuple cannot be built that way, because it pairs each finish with a *different column* of
    /// the feed's row, so a test is what holds it to the vocabulary.
    #[test]
    fn a_mana_pool_row_quoting_every_finish_files_all_three_under_the_schema_names() {
        let body = r#"{"data": [
            {"scryfall_id": "a",
             "price_cents_nm": 100, "price_cents_nm_foil": 200, "price_cents_nm_etched": 300}
        ]}"#;

        let feed = collect(&ManaPool, body).unwrap();

        // `priced` sorts, so compare as sets — the order the tuple lists its three columns in is
        // this test's business only insofar as all three arrive.
        let mut written: Vec<&str> = priced(&feed)
            .into_iter()
            .map(|(_, finish, _)| finish)
            .collect();
        written.sort_unstable();
        let mut expected = crate::schema::FINISHES.to_vec();
        expected.sort_unstable();
        assert_eq!(
            written, expected,
            "every finish the feed quotes must be filed under the one vocabulary"
        );
    }

    /// **A null NM column means that finish is unpriced: no row, never a zero.** One row per
    /// printing means this is the common case — 88 702 rows are priced nonfoil, 63 251 foil,
    /// 1 198 etched — so a loop that wrote three rows regardless would fill the table with
    /// prices nobody offered.
    #[test]
    fn a_null_near_mint_column_writes_no_row() {
        let body = r#"{"data": [
            {"scryfall_id": "a", "price_cents_nm": 218, "price_cents_nm_foil": null,
             "price_cents_nm_etched": null},
            {"scryfall_id": "b", "price_cents_nm_foil": 1050},
            {"scryfall_id": "c", "price_cents": 500, "price_cents_nm": null,
             "price_cents_nm_foil": null, "price_cents_nm_etched": null},
            {"scryfall_id": "d", "price_cents_nm": 0}
        ]}"#;

        let feed = collect(&ManaPool, body).unwrap();

        assert_eq!(
            priced(&feed),
            vec![("a".into(), "nonfoil", 2.18), ("b".into(), "foil", 10.5)]
        );
        // `c` has a cheapest-condition price and no NM one — that is the 3.1 % of nonfoil
        // coverage insisting on Near Mint costs, and it reads as unpriced, not as $5.00.
        assert_eq!(feed.skipped, 2, "`c` and `d` produced nothing");
    }

    // ---- Collisions -------------------------------------------------------------------

    /// **The token collision, and the whole reason the pick has to be deterministic.** 186
    /// Card Kingdom keys collide over 1 039 excess rows, almost all double-faced tokens where
    /// the shop stocks two physical backs under one Scryfall id. Cheapest wins; a tie goes to
    /// the lower row id. Parsed twice from bodies whose rows are in *different orders*,
    /// because a fold that depended on arrival order would pass a single-run test and make the
    /// price flicker between refreshes in the field.
    #[test]
    fn a_token_collision_resolves_to_the_cheapest_row_and_does_so_identically_twice() {
        let forwards = r#"{"data": [
            {"id": 11, "scryfall_id": "tok", "is_foil": "false", "price_retail": "0.35"},
            {"id": 12, "scryfall_id": "tok", "is_foil": "false", "price_retail": "0.25"},
            {"id": 13, "scryfall_id": "tok", "is_foil": "false", "price_retail": "0.25"},
            {"id": 14, "scryfall_id": "tok", "is_foil": "true",  "price_retail": "2.00"}
        ]}"#;
        // The same four rows, reordered — which is what a regenerated feed can do.
        let backwards = r#"{"data": [
            {"id": 13, "scryfall_id": "tok", "is_foil": "false", "price_retail": "0.25"},
            {"id": 14, "scryfall_id": "tok", "is_foil": "true",  "price_retail": "2.00"},
            {"id": 11, "scryfall_id": "tok", "is_foil": "false", "price_retail": "0.35"},
            {"id": 12, "scryfall_id": "tok", "is_foil": "false", "price_retail": "0.25"}
        ]}"#;

        let first = collect(&CardKingdom, forwards).unwrap();
        let second = collect(&CardKingdom, backwards).unwrap();

        let want = vec![("tok".into(), "foil", 2.0), ("tok".into(), "nonfoil", 0.25)];
        assert_eq!(priced(&first), want, "cheapest wins");
        assert_eq!(priced(&second), want, "and wins again, whatever the order");
        // The tie between 12 and 13 goes to the lower id, both times.
        assert_eq!(first.prices[&("tok".to_owned(), "nonfoil")].row_id, 12);
        assert_eq!(second.prices[&("tok".to_owned(), "nonfoil")].row_id, 12);
        assert_eq!(first.collisions, 2);

        // And the same holds through the database: two stores of the two orderings leave the
        // table byte for byte identical.
        let db = mem_db();
        store(&db, &first, 1_800_000_000).unwrap();
        let after_first = stored_prices(&db, "cardkingdom");
        store(&db, &second, 1_800_000_060).unwrap();
        assert_eq!(after_first, stored_prices(&db, "cardkingdom"));
        assert_eq!(
            after_first,
            vec![
                ("tok".to_owned(), "foil".to_owned(), 2.0),
                ("tok".to_owned(), "nonfoil".to_owned(), 0.25),
            ]
        );
    }

    /// Mana Pool's collisions are the same shape, and its tie-break is the ordinal because the
    /// feed publishes no row id: the cheapest of two rows sharing an id still wins.
    #[test]
    fn mana_pool_collisions_resolve_to_the_cheapest_row() {
        let body = r#"{"data": [
            {"scryfall_id": "tok", "price_cents_nm": 40},
            {"scryfall_id": "tok", "price_cents_nm": 25},
            {"scryfall_id": "tok", "price_cents_nm": 25, "price_cents_nm_foil": 300}
        ]}"#;

        let feed = collect(&ManaPool, body).unwrap();

        assert_eq!(
            priced(&feed),
            vec![("tok".into(), "foil", 3.0), ("tok".into(), "nonfoil", 0.25)]
        );
        assert_eq!(feed.prices[&("tok".to_owned(), "nonfoil")].row_id, 1);
    }

    // ---- Storage ----------------------------------------------------------------------

    /// A replace is a replace: rows the new feed no longer carries are gone, and the meta row
    /// is stamped with what actually landed.
    #[test]
    fn a_refresh_replaces_the_marketplaces_rows_and_stamps_the_meta() {
        let db = mem_db();
        let first = collect(
            &CardKingdom,
            r#"{"meta":{"created_at":"2026-08-10 21:00:00"},"data":[
                {"id":1,"scryfall_id":"a","is_foil":"false","price_retail":"0.35"},
                {"id":2,"scryfall_id":"gone","is_foil":"false","price_retail":"1.00"}
            ]}"#,
        )
        .unwrap();
        store(&db, &first, 1_800_000_000).unwrap();

        let second = collect(
            &CardKingdom,
            r#"{"meta":{"created_at":"2026-08-11 21:07:02"},"data":[
                {"id":1,"scryfall_id":"a","is_foil":"false","price_retail":"0.40"}
            ]}"#,
        )
        .unwrap();
        let done = store(&db, &second, 1_800_086_400).unwrap();

        assert_eq!(done.written, 1);
        assert_eq!(
            stored_prices(&db, "cardkingdom"),
            vec![("a".to_owned(), "nonfoil".to_owned(), 0.40)],
            "a card the new feed dropped must not linger at yesterday's price"
        );
        let conn = crate::db::lock_blocking(&db);
        let (at, built, rows): (i64, Option<String>, i64) = conn
            .query_row(
                "SELECT fetched_at, feed_built_at, row_count FROM marketplace_feed_meta
                  WHERE marketplace='cardkingdom'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(at, 1_800_086_400);
        assert_eq!(built.as_deref(), Some("2026-08-11 21:07:02"));
        assert_eq!(rows, 1);
    }

    /// One marketplace's refresh must not touch another's. They are separate downloads on
    /// separate days and the `DELETE` is keyed accordingly.
    #[test]
    fn a_refresh_leaves_the_other_marketplaces_prices_alone() {
        let db = mem_db();
        store(
            &db,
            &collect(
                &ManaPool,
                r#"{"data":[{"scryfall_id":"a","price_cents_nm":218}]}"#,
            )
            .unwrap(),
            1_800_000_000,
        )
        .unwrap();
        store(
            &db,
            &collect(
                &CardKingdom,
                r#"{"data":[{"id":1,"scryfall_id":"a","is_foil":"false","price_retail":"0.35"}]}"#,
            )
            .unwrap(),
            1_800_000_000,
        )
        .unwrap();

        assert_eq!(
            stored_prices(&db, "manapool"),
            vec![("a".to_owned(), "nonfoil".to_owned(), 2.18)]
        );
        assert_eq!(
            stored_prices(&db, "cardkingdom"),
            vec![("a".to_owned(), "nonfoil".to_owned(), 0.35)]
        );
    }

    /// **A failed fetch leaves the previous prices in place**, and says why in `error_log`.
    /// Stale prices with an honest as-of line beat an empty table — so the parse has to fail
    /// before the `DELETE`, not after it.
    ///
    /// Four ways to fail, one outcome: an HTML error page, a truncated body, a document whose
    /// `data` is empty, and one whose rows are all unusable.
    #[test]
    fn a_failed_refresh_leaves_the_previous_prices_intact() {
        let db = mem_db();
        let good = collect(
            &CardKingdom,
            r#"{"meta":{"created_at":"2026-08-11 21:07:02"},"data":[
                {"id":1,"scryfall_id":"a","is_foil":"false","price_retail":"0.35"}
            ]}"#,
        )
        .unwrap();
        store(&db, &good, 1_800_000_000).unwrap();
        let before = stored_prices(&db, "cardkingdom");

        let dir = std::env::temp_dir().join("mtgtest-marketplace-feed-failures");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        for (name, body) in [
            ("html", "<html>503 Service Unavailable</html>"),
            ("truncated", r#"{"data":[{"id":1,"scryfall_id":"a","#),
            ("empty", r#"{"meta":{"created_at":"x"},"data":[]}"#),
            (
                "unusable",
                r#"{"data":[{"id":1,"name":"Sealed"},{"id":2,"name":"Also sealed"}]}"#,
            ),
        ] {
            let path = dir.join(format!("{name}.json"));
            std::fs::write(&path, body).unwrap();
            let err = ingest_file(&db, &CardKingdom, &path, 1_800_086_400)
                .expect_err("`{name}` must not be allowed to replace a working price table");
            assert_eq!(
                stored_prices(&db, "cardkingdom"),
                before,
                "`{name}` ({err}) must leave yesterday's prices exactly where they were"
            );
        }

        // The meta row is untouched too: an as-of line that moved forward while the prices
        // did not is the one lie this whole rule exists to prevent.
        {
            let conn = crate::db::lock_blocking(&db);
            let at: i64 = conn
                .query_row(
                    "SELECT fetched_at FROM marketplace_feed_meta WHERE marketplace='cardkingdom'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(at, 1_800_000_000);

            // And every failure said so, folded by the error log's grain into one row per
            // distinct message rather than four copies of one.
            let logged = crate::errors::list(&conn, 50).unwrap();
            assert!(!logged.is_empty(), "a failed refresh must be logged");
            assert!(
                logged
                    .iter()
                    .all(|e| e.operation == "marketplace_feed:cardkingdom"),
                "the operation names the feed: {logged:?}"
            );
            assert!(
                logged
                    .iter()
                    .any(|e| e.detail.as_deref() == Some(CardKingdom.url())),
                "and the detail names the endpoint: {logged:?}"
            );
        }

        // A good file still lands afterwards: none of those failures left the connection or
        // the table in a state a retry cannot use.
        let path = dir.join("good.json");
        std::fs::write(
            &path,
            r#"{"data":[{"id":1,"scryfall_id":"a","is_foil":"false","price_retail":"0.99"}]}"#,
        )
        .unwrap();
        ingest_file(&db, &CardKingdom, &path, 1_800_086_400).unwrap();
        assert_eq!(
            stored_prices(&db, "cardkingdom"),
            vec![("a".to_owned(), "nonfoil".to_owned(), 0.99)]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- Providers and status ---------------------------------------------------------

    /// Every provider prices a marketplace the *setting* knows, or the feed could never be
    /// selected — and both halves of the id are matched verbatim, so a typo is a feed nothing
    /// can reach.
    #[test]
    fn every_provider_is_a_marketplace_the_setting_knows() {
        for p in PROVIDERS {
            assert!(
                crate::marketplace::is_known(p.marketplace()),
                "`{}` is not in MARKETPLACE_IDS",
                p.marketplace()
            );
            assert!(p.url().starts_with("https://"), "{}", p.url());
            assert_eq!(
                provider_for(p.marketplace()).map(|q| q.url()),
                Some(p.url())
            );
        }
        assert_eq!(PROVIDERS.len(), 2);
        // The three that are not feed-backed: two read out of `cards.prices`, and Card trader
        // needs a per-user JWT and publishes no bulk download at all.
        for id in ["tcgplayer", "cardmarket", "cardtrader"] {
            assert!(provider_for(id).is_none(), "{id} must have no feed");
            assert!(!is_feed_backed(id));
        }
    }

    /// A marketplace with no feed cannot be refreshed, and the refusal names what can be.
    #[tokio::test]
    async fn refreshing_a_marketplace_with_no_feed_is_refused_by_name() {
        let (state, dir) = test_state();
        let err = refresh(&state, "tcgplayer", &mut |_, _, _| {})
            .await
            .unwrap_err();
        assert!(err.contains("tcgplayer"), "{err}");
        assert!(err.contains("cardkingdom"), "{err}");
        assert!(err.contains("manapool"), "{err}");
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Never fetched is its own state, and it is the one that means "the price columns are
    /// empty" rather than "these prices are old".
    #[test]
    fn a_never_fetched_feed_reports_itself_as_never_fetched_and_stale() {
        let conn = crate::schema::memory_pair();

        let status = read_status(&conn, &CardKingdom, 1_800_000_000);
        assert_eq!(
            status,
            FeedStatus {
                marketplace: "cardkingdom".to_owned(),
                fetched_at: None,
                feed_built_at: None,
                row_count: None,
                stale: true,
                refreshing: false,
            }
        );
    }

    /// The stamp the UI draws its as-of line from, and the staleness rule around it. A clock
    /// that moved backwards counts as stale rather than underflowing or throttling until the
    /// wall clock catches up — [`crate::sync::should_check`]'s rule.
    #[test]
    fn a_fetched_feed_reports_both_stamps_and_goes_stale_after_a_day() {
        let db = mem_db();
        store(
            &db,
            &collect(
                &CardKingdom,
                r#"{"meta":{"created_at":"2026-08-11 21:07:02"},
                    "data":[{"id":1,"scryfall_id":"a","is_foil":"false","price_retail":"0.35"}]}"#,
            )
            .unwrap(),
            1_800_000_000,
        )
        .unwrap();

        let conn = crate::db::lock_blocking(&db);
        let fresh = read_status(&conn, &CardKingdom, 1_800_000_000 + 60);
        assert_eq!(fresh.fetched_at, Some(1_800_000_000));
        assert_eq!(fresh.feed_built_at.as_deref(), Some("2026-08-11 21:07:02"));
        assert_eq!(fresh.row_count, Some(1));
        assert!(!fresh.stale);

        let old = read_status(&conn, &CardKingdom, 1_800_000_000 + 86_400);
        assert!(old.stale, "a day old is due for a refresh");

        assert!(is_stale(None, 1_800_000_000), "never fetched is due");
        assert!(
            is_stale(Some(1_900_000_000), 1_800_000_000),
            "a stamp in the future is due, not a throttle until the clock catches up"
        );
    }

    /// Mana Pool publishes no build stamp, and a NULL `feed_built_at` has to survive the round
    /// trip as NULL — filling it in from the clock would state a fact nobody published.
    #[test]
    fn a_feed_with_no_build_stamp_stores_null_rather_than_the_fetch_time() {
        let db = mem_db();
        store(
            &db,
            &collect(
                &ManaPool,
                r#"{"data":[{"scryfall_id":"a","price_cents_nm":218}]}"#,
            )
            .unwrap(),
            1_800_000_000,
        )
        .unwrap();

        let conn = crate::db::lock_blocking(&db);
        let status = read_status(&conn, &ManaPool, 1_800_000_000);
        assert_eq!(status.fetched_at, Some(1_800_000_000));
        assert_eq!(status.feed_built_at, None);
    }

    /// The wire shape the frontend mirrors by hand.
    #[test]
    fn the_status_dto_uses_the_camel_case_names_the_frontend_expects() {
        let json = serde_json::to_value(FeedStatus {
            marketplace: "cardkingdom".into(),
            fetched_at: Some(1_800_000_000),
            feed_built_at: Some("2026-08-11 21:07:02".into()),
            row_count: Some(97_239),
            stale: false,
            refreshing: true,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "marketplace": "cardkingdom",
                "fetchedAt": 1_800_000_000i64,
                "feedBuiltAt": "2026-08-11 21:07:02",
                "rowCount": 97_239,
                "stale": false,
                "refreshing": true,
            })
        );

        let progress = serde_json::to_value(FeedProgress {
            marketplace: "manapool".into(),
            phase: "downloading".into(),
            done: 5,
            total: 10,
        })
        .unwrap();
        assert_eq!(
            progress,
            serde_json::json!({
                "marketplace": "manapool", "phase": "downloading", "done": 5, "total": 10
            })
        );
    }

    /// One refresh per marketplace at a time, and the claim clears however it ends — a latched
    /// flag would lock the user out of refreshing until they restarted the app.
    #[test]
    fn a_second_refresh_of_the_same_feed_is_refused_and_the_claim_always_clears() {
        {
            let held = RefreshGuard::claim("cardkingdom").expect("first claim");
            assert!(RefreshGuard::claim("cardkingdom").is_none(), "no second");
            assert!(is_refreshing("cardkingdom"));
            // A different feed is a different download and is allowed to run alongside.
            let other = RefreshGuard::claim("manapool").expect("a different feed may run");
            drop(other);
            drop(held);
        }
        assert!(!is_refreshing("cardkingdom"));
        assert!(!is_refreshing("manapool"));
        assert!(RefreshGuard::claim("cardkingdom").is_some(), "and again");
    }

    // ---- The network ------------------------------------------------------------------

    /// An `AppState` pointed at a scratch directory and a database of its own.
    fn test_state() -> (Arc<AppState>, PathBuf) {
        use std::sync::atomic::AtomicBool;
        let dir = std::env::temp_dir().join(format!(
            "mtgtest-feed-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::schema::prepare_data_dir(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        crate::schema::prepare_database(&conn).unwrap();
        let read = crate::db::open_read(&dir).unwrap();
        (
            Arc::new(AppState {
                db: Mutex::new(conn),
                db_read: Mutex::new(read),
                data_dir: dir.clone(),
                syncing: AtomicBool::new(false),
                client: crate::scryfall::Client::new("http://127.0.0.1:1".into()),
                images: crate::images::Cache::new(dir.join("images")),
                index: std::sync::RwLock::default(),
                // The mirror is never started in these tests; a clean mask and an empty record are
                // what an `AppState` looks like before the first pass.
                mirror: std::sync::Arc::new(crate::mirror::watch::Mask::default()),
                mirror_status: std::sync::Mutex::new(crate::mirror::watch::LastPass::default()),
            }),
            dir,
        )
    }

    /// The download, end to end over HTTP: the body reaches disk and progress is reported
    /// against the declared length.
    #[tokio::test]
    async fn a_feed_downloads_to_disk_and_reports_progress() {
        let server = httpmock::MockServer::start_async().await;
        let body =
            r#"{"data":[{"id":1,"scryfall_id":"a","is_foil":"false","price_retail":"0.35"}]}"#;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/pricelist");
                then.status(200)
                    .header("content-type", "application/json")
                    .body(body);
            })
            .await;
        let url: &'static str = Box::leak(server.url("/pricelist").into_boxed_str());

        let dir = std::env::temp_dir().join("mtgtest-feed-download");
        let _ = std::fs::remove_dir_all(&dir);
        let dest = dir.join("tmp").join("cardkingdom-prices.json");
        let mut seen: Vec<(u64, u64)> = Vec::new();

        download(url, &dest, &mut |done, total| seen.push((done, total)))
            .await
            .unwrap();

        assert_eq!(std::fs::read_to_string(&dest).unwrap(), body);
        assert_eq!(seen.first(), Some(&(0, body.len() as u64)));
        assert_eq!(seen.last(), Some(&(body.len() as u64, body.len() as u64)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **A refused fetch never reaches the database.** The status is an answer, not a body, so
    /// it fails before a byte is written — and the previous prices are still there afterwards.
    #[tokio::test]
    async fn a_refused_fetch_fails_before_anything_is_written() {
        let server = httpmock::MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/pricelist");
                then.status(503).body("Service Unavailable");
            })
            .await;
        let url: &'static str = Box::leak(server.url("/pricelist").into_boxed_str());

        let dir = std::env::temp_dir().join("mtgtest-feed-refused");
        let _ = std::fs::remove_dir_all(&dir);
        let dest = dir.join("tmp").join("cardkingdom-prices.json");

        let err = download(url, &dest, &mut |_, _| {}).await.unwrap_err();

        assert!(
            matches!(err, FeedError::Status { status: 503, .. }),
            "{err}"
        );
        assert_eq!(err.kind(), crate::errors::Kind::Http);
        assert!(!dest.exists(), "nothing may be written on a refusal");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole path, from HTTP to stored prices, against a mock that serves a real-shaped
    /// Card Kingdom document — the one test that proves the pieces are wired to each other.
    #[tokio::test]
    async fn a_refresh_fetches_parses_and_stores() {
        let server = httpmock::MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/pricelist");
                then.status(200).body(
                    r#"{"meta":{"created_at":"2026-08-11 21:07:02"},"data":[
                        {"id":1,"scryfall_id":"a","variation":"","is_foil":"false","price_retail":"0.35"},
                        {"id":2,"scryfall_id":"a","variation":"Foil Etched","is_foil":"true","price_retail":"9.99"},
                        {"id":3,"name":"Sealed"}
                    ]}"#,
                );
            })
            .await;
        let url: &'static str = Box::leak(server.url("/pricelist").into_boxed_str());
        let (state, dir) = test_state();

        // The provider's own URL points at the live host, so the fetch is driven by hand here
        // and the parse+store half is the module's. `refresh` itself is covered by the refusal
        // test above; what this one proves is that a real document reaches the table.
        let path = temp_path(&state, &CardKingdom);
        download(url, &path, &mut |_, _| {}).await.unwrap();
        let done = ingest_file(&state.db, &CardKingdom, &path, 1_800_000_000).unwrap();

        assert_eq!(done.written, 2);
        assert_eq!(done.skipped, 1);
        assert_eq!(
            stored_prices(&state.db, "cardkingdom"),
            vec![
                ("a".to_owned(), "etched".to_owned(), 9.99),
                ("a".to_owned(), "nonfoil".to_owned(), 0.35),
            ]
        );
        let conn = crate::sync::lock_db_read(&state);
        let status = read_status(&conn, &CardKingdom, 1_800_000_060);
        assert_eq!(status.row_count, Some(2));
        assert_eq!(status.feed_built_at.as_deref(), Some("2026-08-11 21:07:02"));
        drop(conn);
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The parse is genuinely streaming: a document far larger than any batch is read without
    /// the rows being collected first, and every one of them lands.
    #[test]
    fn a_document_larger_than_a_batch_streams_through() {
        let rows: Vec<String> = (0..(BATCH + 137))
            .map(|i| {
                format!(
                    r#"{{"id":{i},"scryfall_id":"c{i}","is_foil":"false","price_retail":"0.{:02}"}}"#,
                    i % 100 + 1
                )
            })
            .collect();
        let body = format!(r#"{{"data":[{}]}}"#, rows.join(","));

        let feed = collect(&CardKingdom, &body).unwrap();

        assert_eq!(feed.rows_seen as usize, BATCH + 137);
        assert_eq!(feed.row_count(), BATCH + 137);
        assert_eq!(feed.skipped, 0);

        let db = mem_db();
        assert_eq!(
            store(&db, &feed, 1_800_000_000).unwrap().written,
            BATCH + 137
        );
        assert_eq!(stored_prices(&db, "cardkingdom").len(), BATCH + 137);
    }

    /// Keys this app has never heard of are stepped over, not choked on. Both feeds grow
    /// fields without notice, and a new one must not cost the user their prices.
    #[test]
    fn unknown_keys_anywhere_in_the_document_are_ignored() {
        let body = r#"{
          "version": 2,
          "meta": {"created_at": "2026-08-11 21:07:02", "base_url": "https://…", "next": null},
          "data": [{"id": 1, "scryfall_id": "a", "is_foil": "false", "price_retail": "0.35",
                    "condition_values": {"nm_price": "0.35", "ex_price": "0.28"},
                    "qty_retail": 24, "something_new": {"deeply": ["nested"]}}],
          "trailing": {"after": "data"}
        }"#;

        let feed = collect(&CardKingdom, body).unwrap();

        assert_eq!(priced(&feed), vec![("a".into(), "nonfoil", 0.35)]);
        assert_eq!(feed.feed_built_at.as_deref(), Some("2026-08-11 21:07:02"));
    }

    /// The phases the frontend mirrors, and the event they arrive on.
    #[test]
    fn the_progress_phases_are_the_ones_the_frontend_mirrors() {
        assert_eq!(FEED_PHASES, ["downloading", "ingesting", "done", "error"]);
        assert_eq!(PROGRESS_EVENT, "marketplace:progress");
    }
}
