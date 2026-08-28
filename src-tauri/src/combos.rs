//! Commander Spellbook's combo database: fetch, reduce, and answer three questions.
//!
//! A two-card infinite combo is the one bracket signal that cannot be read out of a card's own
//! text, because it is a fact about an *interaction* rather than about a card. [Commander
//! Spellbook](https://commanderspellbook.com) is the community database of them and publishes a
//! public, unauthenticated bulk file, which is what this module ingests. Everything below was
//! measured live on 2026-08-27; see
//! `docs/superpowers/research/2026-08-27-commander-brackets-and-combos.md`.
//!
//! | | |
//! | --- | --- |
//! | Endpoint | `json.commanderspellbook.com/variants.json.gz` |
//! | Compressed | 27 542 314 bytes |
//! | Uncompressed | 639 585 506 bytes |
//! | Shape | one object: `{ timestamp, version, variants: [ … ] }` |
//! | Rotation | continuous — the file's own `timestamp` was 20 minutes old when fetched |
//!
//! Six rules shape this module, and they are [`crate::marketplace_feed`]'s rules read against a
//! different host — this is its sibling, not the tag family's.
//!
//! * **This is not Scryfall.** Its own [`client`], its own timeouts, no share of Scryfall's
//!   rate-limit budget and no place in its 429 penalty state. A combo feed that is slow must
//!   never be the reason the card corpus stops syncing, or the reverse. Routing this through
//!   [`crate::scryfall::Client`] would spend Scryfall's pacing budget on a host Scryfall has
//!   nothing to do with, and a Spellbook 429 would lock the corpus out.
//! * **Streaming, end to end, because the ratio is the whole problem.** The file expands 23×,
//!   and almost all of that is Scryfall image URLs — every `uses[].card` carries ten `imageUri*`
//!   fields plus a type line, and every variant carries a description, notes and prices. None of
//!   it is wanted. So: byte stream → a temp file under `tmp/` → 64 KB chunks →
//!   [`crate::feed::frame::Decoder`], which sniffs the gzip magic and decompresses →
//!   [`crate::feed::frame::Elements`], which frames one `variants[]` element at a time by
//!   brace depth → `serde_json::from_slice` on that one element. Exactly one variant is live
//!   at a time and every image URL is dropped with the raw variant that carried it.
//!   `from_str` on 639 MB is not available, and neither is `serde_json::Value`.
//!
//!   **The framing is push-shaped on purpose, and that is a change from what shipped.** This
//!   module used to drive `serde_json::Deserializer::from_reader` with a [`DeserializeSeed`]
//!   over the array, which is a *pull* parser: it calls `read()` when it wants more and blocks
//!   until it gets it. A browser stream is push and async with no thread to block, so it could
//!   not be driven from one at all. [`read_file`] and the seed below stay — they are still the
//!   file-shaped entry point the tests use — but [`ingest_gz`] now goes through
//!   [`read_stream`].
//! * **A size guard, against the declared length *and* the streamed total.** [`MAX_FEED_BYTES`]
//!   is a bound on what a host that is not the one we think it is can make this process spend,
//!   not a budget. A chunked response declares nothing, which is why the running total is
//!   checked too and is the one that actually holds.
//! * **A failure leaves the previous combos in place** and writes the reason to `error_log`.
//!   The parse finishes before the write begins; the write goes to staging tables no reader can
//!   see and is promoted by one rename transaction. A file that yields **zero** combos is
//!   refused outright ([`ComboError::Empty`]) rather than swapped in — the same reasoning
//!   [`crate::ingest`] applies to a bulk card file that holds no cards, and the same reasoning
//!   [`crate::tags`] applies to a tag file that tagged nothing.
//! * **Nothing here may break a launch.** A database that has never fetched this file is a
//!   supported state: the three commands all answer it, the bracket estimate simply reads three
//!   signals instead of four, and [`refresh_if_due`] does not go and get it uninvited.
//! * **Everything is `Option` on the way in and nothing is `deny_unknown_fields`.** This is
//!   somebody else's catalogue, it grows keys without notice, and a variant missing a field is a
//!   variant to skip rather than a reason to abandon the rest.
//!
//! # What survives the reduction
//!
//! Per variant: its id, its `bracketTag`, its colour identity, its popularity, how many
//! `requires[]` templates it also needs, and its `produces[]` feature names joined with `\n`.
//! Per `uses[]` entry: an oracle id, a name, a quantity and whether the card must be the
//! commander. Everything else is read and dropped.

use crate::sync::AppState;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

/// Where the combo database lives. Every other filename tried on that host answers 403, so
/// there is exactly one file and no lighter variant of it to prefer.
pub const FEED_URL: &str = "https://json.commanderspellbook.com/variants.json.gz";

/// The event a refresh reports itself through.
///
/// **Its own event rather than a new value on an existing phase union**, which is
/// [`crate::marketplace_feed::PROGRESS_EVENT`]'s reason for its own: `SyncPhase` is a closed
/// union on the TypeScript side with a total label map over it, and a phase it does not know
/// renders as `undefined`. This is also not a sync and not a price refresh — it can run while
/// either is in flight, and three services sharing one line would fight over it.
pub const PROGRESS_EVENT: &str = "combos:progress";

/// Every value [`ComboProgress::phase`] takes, in the order one refresh produces them.
/// Mirrored by hand on the other side of the IPC boundary.
pub const PHASES: [&str; 5] = ["checking", "downloading", "ingesting", "done", "error"];

/// The only `status` a published combo has. The others — `N` New, `D` Draft, `NR` Needs
/// Review, `E` Example, `R` Restore, `NW` Not Working — are Spellbook's editorial pipeline
/// showing through the file, and none of them is a combo to tell a reader about.
const STATUS_OK: &str = "OK";

/// Spellbook's `BracketTagEnum`, verbatim: Ruthless, Spicy, Powerful, Oddball, Core,
/// Exhibition, Banned.
///
/// **A variant wearing anything else is skipped rather than stored**, because the TypeScript
/// side spells this list as a closed union and a letter it has never heard of would reach a
/// total map as `undefined`. If Spellbook ever adds an eighth letter the honest symptom is a
/// jump in `combo_meta.skipped`, and — if it renamed all seven at once — [`ComboError::Empty`],
/// which keeps the rows already stored and says why in `error_log`.
pub const BRACKET_TAGS: [&str; 7] = ["R", "S", "P", "O", "C", "E", "B"];

/// The largest body this process will accept, declared or streamed.
///
/// A bound on what a host that is not the one we think it is can make this process spend, **not
/// a budget**: the file was 27 542 314 bytes when measured, so 128 MiB is a little under five
/// times it — room for the catalogue to grow for years, and still a number a wrong answer
/// cannot hide behind. Enforced against the declared `Content-Length` *and* against the running
/// total, because a chunked response declares nothing and the running total is therefore the
/// one that actually holds.
///
/// The decompressed side needs no bound of its own: the parse holds one variant at a time and
/// what it keeps is a fraction of a percent of what it reads, so a file that expands
/// unreasonably costs CPU on a background thread rather than memory.
const MAX_FEED_BYTES: u64 = 128 * 1024 * 1024;

/// Bytes of download between progress events. reqwest's chunk callback fires thousands of
/// times over 27.5 MB, which is far more than a progress bar can use —
/// [`crate::marketplace_feed`]'s number, for its reason.
const PROGRESS_EMIT_BYTES: u64 = 1_000_000;

/// How long an ingested combo database stays fresh.
///
/// **A week, against a file that rotates continuously**, and the two must not be blurred: the
/// file's own `timestamp` was twenty minutes old when it was fetched, so Spellbook rebuilds it
/// through the day. The week is *this app's* answer to how often to ask, and it is the same
/// answer `tags::{oracle,art}::REFRESH_INTERVAL_SECS` gives for the same reason — the catalogue
/// is hand-curated and moves in increments, while a deck's bracket readout quietly changing
/// between two sessions on the same afternoon, for a reason the reader cannot see, is the
/// failure worth avoiding. 27.5 MB an ask is the other half of it.
///
/// The ETag makes a check that finds nothing cost zero bytes either way, and
/// [`combos_refresh`]'s `force` is the way past this for anyone who wants today's file.
pub const REFRESH_INTERVAL_SECS: i64 = 7 * 86_400;

/// The connect timeout. This is an ordinary web host, not a CDN this app has measured.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// The longest gap between two chunks of the body before the connection is called dead.
/// Deliberately *not* an overall timeout: 27.5 MB legitimately runs for a minute on a slow
/// line, and a `timeout()` would kill it partway every time — [`crate::scryfall`]'s rule.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Rows per transaction on the way into staging.
///
/// The write is chunked for [`crate::tags::ingest_gz`]'s reason and not
/// [`crate::marketplace_feed::store`]'s: these rows go to tables no reader can see, so a commit
/// partway costs nobody a half-swapped view, and `db` is the shared write connection — holding
/// it for the length of the insert is what turns a reader's edit into a frozen button.
const BATCH: usize = 2_000;

/// Let a waiting writer see the connection is free. **Call it with no guard in scope.**
const YIELD_BETWEEN_BATCHES: Duration = Duration::from_millis(5);

fn stand_aside() {
    std::thread::sleep(YIELD_BETWEEN_BATCHES);
}

/// The largest deck a combo check will accept in one call.
///
/// The match query is **one statement** and is deliberately not chunked: `have` is counted per
/// combo across the whole deck, so two halves of a split list would each report a two-card
/// combo as half-matched and neither would answer. That makes the list length a real bound
/// rather than a formality — 1 000 is ten Commander decks' worth of distinct printings, and
/// still far under every `SQLITE_MAX_VARIABLE_NUMBER` SQLite has shipped (32 766 since 3.32).
pub const MAX_CARD_IDS: usize = 1_000;

/// What a caller asking about more than [`MAX_CARD_IDS`] cards is told. A sentence, because a
/// bound that answers `Err(())` is a bound the caller can only guess at.
pub const TOO_MANY_CARDS: &str =
    "That is more cards than one combo check can look at. Ask about 1000 or fewer.";

// ---------------------------------------------------------------------------------------
// The file, as it arrives
// ---------------------------------------------------------------------------------------

/// One `variants[]` entry, narrowed to the nine keys that matter.
///
/// `#[serde(rename_all = "camelCase")]` because the file is camelCase throughout —
/// `bracketTag`, `oracleId`, `mustBeCommander`. Every field is `Option` or defaulted and none
/// of the structs here is `deny_unknown_fields`: see the module header.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawVariant {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    bracket_tag: Option<String>,
    #[serde(default)]
    identity: Option<String>,
    #[serde(default)]
    popularity: Option<i64>,
    #[serde(default)]
    legalities: Option<RawLegalities>,
    #[serde(default)]
    uses: Vec<RawUse>,
    /// **Read for its length and nothing else.** `IgnoredAny` parses each template and builds
    /// nothing from it, and a `Vec` of a zero-sized type allocates nothing — so this counts the
    /// entries without ever holding one.
    #[serde(default)]
    requires: Vec<IgnoredAny>,
    #[serde(default)]
    produces: Vec<RawProduces>,
}

/// Twenty-odd formats arrive here; exactly one is read. A shape this app does not expect must
/// not fail the variant behind it, so the field is an `Option<bool>` rather than a hard `bool`.
#[derive(Debug, Deserialize)]
struct RawLegalities {
    #[serde(default)]
    commander: Option<bool>,
}

/// One card the combo uses. `card` carries ten image URLs and a type line as well; all of them
/// are parsed past and none is allocated into this struct.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawUse {
    #[serde(default)]
    card: Option<RawCard>,
    #[serde(default)]
    quantity: Option<i64>,
    #[serde(default)]
    must_be_commander: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCard {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    oracle_id: Option<String>,
}

/// One `produces[]` entry: `{ feature: { name, … }, quantity }`.
#[derive(Debug, Deserialize)]
struct RawProduces {
    #[serde(default)]
    feature: Option<RawFeature>,
}

#[derive(Debug, Deserialize)]
struct RawFeature {
    #[serde(default)]
    name: Option<String>,
}

// ---------------------------------------------------------------------------------------
// The file, after it has been reduced
// ---------------------------------------------------------------------------------------

/// One card a stored combo names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComboCard {
    /// `cards.oracle_id`, which is what the match query joins on. A `uses[]` entry without one
    /// never becomes a `ComboCard`.
    pub oracle_id: String,
    /// The card's name as the file spells it, kept because `combo_cards` is what
    /// [`combos_for_cards`] reads the names back out of — a join against `cards` would answer
    /// nothing for a combo piece the corpus has not synced yet.
    pub name: String,
    pub quantity: i64,
    pub must_be_commander: bool,
}

/// One combo, reduced to what this app stores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub id: String,
    /// One of [`BRACKET_TAGS`].
    pub bracket_tag: String,
    /// **Distinct oracle ids among [`cards`](Combo::cards)**, because the match query compares
    /// against a `count(DISTINCT cc.oracle_id)`. A combo that names the same card twice — one
    /// copy in the command zone and one in the library, say — is a *one*-card requirement as
    /// far as a deck list is concerned, and counting the rows instead would make it
    /// permanently unmatchable.
    pub card_count: i64,
    /// Requirements this app cannot resolve to a card id, so it can never confirm them.
    ///
    /// **`requires[]` plus any `uses[]` entry with no `oracleId`**, which is the one place this
    /// deliberately reads wider than the field name. `templateCount == 0` is documented on the
    /// wire as "a combo the deck definitely has", and a card the file named but did not
    /// identify is exactly as uncheckable as "a creature with flying" — storing the rest of the
    /// combo and calling it complete would claim a deck holds a combo that it might not.
    /// Nothing in the file measured so far has an unidentified `uses[]` entry; this is the
    /// direction to be wrong in if one ever appears.
    pub template_count: i64,
    pub identity: String,
    /// Feature names, `\n`-joined.
    pub produces: String,
    pub popularity: Option<i64>,
    /// The file's order, which is the order [`combos_for_cards`] answers in.
    pub cards: Vec<ComboCard>,
}

/// One parsed file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ComboFile {
    /// The file's own `timestamp`, verbatim.
    ///
    /// **The honest "what we hold" line**, and the reason `combo_meta` stores it beside
    /// `checked_at`: the file rotates through the day, so the clock at fetch time says when we
    /// asked and this says which build we got.
    pub stamp: Option<String>,
    pub combos: Vec<Combo>,
    /// Variants the file held that produced nothing: not `OK`, not Commander-legal, no id, no
    /// bracket letter this app knows, or not one card it could identify. Counted rather than
    /// fatal — [`crate::ingest`]'s rule, for its reason.
    pub skipped: u64,
    /// Variants the file held, including the ones that produced nothing.
    pub seen: u64,
}

/// Reduce one raw variant, or say why it is not one this app stores.
///
/// Every `None` here is a `combo_meta.skipped`.
fn reduce(raw: RawVariant) -> Option<Combo> {
    // Only `OK` is a published combo; the rest of the enum is Spellbook's editorial pipeline.
    if raw.status.as_deref() != Some(STATUS_OK) {
        return None;
    }
    // The only format this feature is about. `Some(false)`, `None` and a shape that did not
    // deserialise all mean the same thing here: not something to show a Commander deck.
    if raw.legalities.and_then(|l| l.commander) != Some(true) {
        return None;
    }
    let id = raw
        .id
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())?;
    let bracket_tag = raw
        .bracket_tag
        .filter(|t| BRACKET_TAGS.contains(&t.as_str()))?;

    let mut cards: Vec<ComboCard> = Vec::with_capacity(raw.uses.len());
    let mut unidentified: usize = 0;
    for u in raw.uses {
        let oracle_id = u
            .card
            .as_ref()
            .and_then(|c| c.oracle_id.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let Some(oracle_id) = oracle_id else {
            unidentified += 1;
            continue;
        };
        cards.push(ComboCard {
            oracle_id: oracle_id.to_owned(),
            name: u
                .card
                .as_ref()
                .and_then(|c| c.name.clone())
                .unwrap_or_default(),
            // A quantity below one is not a requirement anybody could meet, and the column is
            // read as "how many copies"; the file has never sent one, and clamping is cheaper
            // than a row nothing can satisfy.
            quantity: u.quantity.unwrap_or(1).max(1),
            must_be_commander: u.must_be_commander.unwrap_or(false),
        });
    }
    // Nothing could ever match a combo this app cannot identify a single card of, and a
    // `card_count` of 0 would sit in the table forever without ever reaching the match query's
    // join. Dropped, and counted.
    if cards.is_empty() {
        return None;
    }

    let card_count = cards
        .iter()
        .map(|c| c.oracle_id.as_str())
        .collect::<HashSet<_>>()
        .len() as i64;
    let produces = raw
        .produces
        .into_iter()
        .filter_map(|p| p.feature.and_then(|f| f.name))
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    Some(Combo {
        id,
        bracket_tag,
        card_count,
        template_count: (raw.requires.len() + unidentified) as i64,
        identity: raw.identity.unwrap_or_default(),
        produces,
        popularity: raw.popularity,
        cards,
    })
}

// ---------------------------------------------------------------------------------------
// The streaming reader
// ---------------------------------------------------------------------------------------

/// Read `{ timestamp, version, variants: [ … ] }` from `body`, reducing every variant as it
/// arrives and returning the file's own `timestamp`.
///
/// What makes it *streaming* is [`Variants`] below: `next_element` decodes one variant, [`reduce`]
/// keeps the handful of scalars it wants, and the raw variant — image URLs, description, notes,
/// prices and all — is dropped before the next is read. Nothing but the reduced list is alive
/// at the end.
///
/// Keys are walked in whatever order the document uses, and unknown keys are skipped with
/// `IgnoredAny`, which still *parses* their values but builds nothing from them.
pub fn read_file(body: &mut dyn Read) -> Result<ComboFile, ComboError> {
    let mut file = ComboFile::default();
    let mut de = serde_json::Deserializer::from_reader(std::io::BufReader::new(body));
    file.stamp = Document {
        sink: &mut |raw: RawVariant| {
            file.seen += 1;
            match reduce(raw) {
                Some(combo) => file.combos.push(combo),
                None => file.skipped += 1,
            }
        },
    }
    .deserialize(&mut de)?;
    Ok(file)
}

/// Read `{ timestamp, version, variants: [ … ] }` from a stream of byte chunks.
///
/// **Why this exists beside [`read_file`].** That one streams with
/// `serde_json::Deserializer::from_reader` plus a `DeserializeSeed` - a *pull* parser,
/// which calls `read()` when it wants more and blocks until it gets it. A browser stream
/// is push and async with no thread to block, so `from_reader` cannot be driven from one
/// at all. This frames each element by brace depth and hands it whole to `from_slice`,
/// which keeps serde doing the part serde is good at.
///
/// Peak memory is one element plus the reduced list, the same as `read_file`'s.
pub fn read_stream(
    chunks: impl Iterator<Item = std::io::Result<Vec<u8>>>,
) -> Result<ComboFile, ComboError> {
    let mut file = ComboFile::default();
    let mut decoder = crate::feed::frame::Decoder::new();
    let mut elements = crate::feed::frame::Elements::new();
    let mut decoded: Vec<u8> = Vec::new();
    // The document's own `timestamp` sits before `variants`, so it is scraped from the
    // head rather than parsed structurally - the framer deliberately does not model the
    // enclosing object.
    let mut head: Vec<u8> = Vec::new();

    for chunk in chunks {
        let chunk = chunk?;
        decoded.clear();
        decoder.push(&chunk, &mut decoded)?;
        take_head(&mut head, &decoded);
        elements.push(&decoded, |el| take_element(&mut file, el));
    }
    decoded.clear();
    decoder.finish(&mut decoded)?;
    take_head(&mut head, &decoded);
    elements.push(&decoded, |el| take_element(&mut file, el));

    file.stamp = stamp_from_head(&head);
    Ok(file)
}

/// Keep the first [`HEAD_SCRAPE_BYTES`] of the decoded stream, for [`stamp_from_head`].
fn take_head(head: &mut Vec<u8>, decoded: &[u8]) {
    if head.len() < HEAD_SCRAPE_BYTES {
        let want = HEAD_SCRAPE_BYTES - head.len();
        head.extend_from_slice(&decoded[..decoded.len().min(want)]);
    }
}

/// Reduce one framed element into `file`, counting it either way.
///
/// A variant that will not deserialise is `skipped`, not fatal - [`crate::ingest`]'s rule,
/// for its reason. Note that this is *more* forgiving than [`read_file`], where a variant
/// serde cannot read aborts the whole document with [`ComboError::Parse`].
fn take_element(file: &mut ComboFile, el: &[u8]) {
    file.seen += 1;
    match serde_json::from_slice::<RawVariant>(el) {
        Ok(raw) => match reduce(raw) {
            Some(combo) => file.combos.push(combo),
            None => file.skipped += 1,
        },
        Err(_) => file.skipped += 1,
    }
}

/// How much of the document's head is kept so the `timestamp` can be scraped out of it.
///
/// The key sits within the first few dozen bytes of every file Spellbook has served; this
/// is slack, not a measurement.
const HEAD_SCRAPE_BYTES: usize = 512;

/// Pull the document's `"timestamp"` out of its first bytes.
///
/// A scrape and not a parse, because the enclosing object is never modelled: the framer
/// starts at the first `[`. `None` for a document that omits the key, which is what
/// [`read_file`] also produces - `ComboFile::stamp` is `Option<String>` precisely because
/// a file without one is a real state rather than an error.
fn stamp_from_head(head: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(head);
    let rest = text.split_once("\"timestamp\"").map(|(_, r)| r)?;
    // Past the colon and the opening quote of the value.
    let rest = rest.split_once('"').map(|(_, r)| r)?;
    Some(rest.split('"').next()?.to_owned())
}

struct Document<'a> {
    sink: &'a mut dyn FnMut(RawVariant),
}

impl<'de> DeserializeSeed<'de> for Document<'_> {
    /// The file's own `timestamp`, where it carries one.
    type Value = Option<String>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for Document<'_> {
    type Value = Option<String>;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a combo document with a `variants` array")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut stamp = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "timestamp" => stamp = map.next_value::<Option<String>>()?,
                // Reborrowed, not moved: this loop may see more keys after `variants`.
                "variants" => map.next_value_seed(Variants {
                    sink: &mut *self.sink,
                })?,
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(stamp)
    }
}

/// The array, one element at a time.
struct Variants<'a> {
    sink: &'a mut dyn FnMut(RawVariant),
}

impl<'de> DeserializeSeed<'de> for Variants<'_> {
    type Value = ();

    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for Variants<'_> {
    type Value = ();

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("an array of combo variants")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(raw) = seq.next_element::<RawVariant>()? {
            (self.sink)(raw);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ComboError {
    #[error("could not reach Commander Spellbook: {0}")]
    Http(reqwest::Error),
    #[error("Commander Spellbook answered {status}")]
    Status { status: u16 },
    /// The body is longer than [`MAX_FEED_BYTES`], declared or streamed.
    #[error("the combo file is larger than {MAX_FEED_BYTES} bytes; refusing it")]
    TooLarge,
    #[error("could not read the downloaded combo file: {0}")]
    Io(#[from] std::io::Error),
    #[error("the combo file could not be read as JSON: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("could not store the combos: {0}")]
    Db(#[from] rusqlite::Error),
    /// The document parsed and held no combo this app could store. A gzipped error page, an
    /// empty `variants: []`, a schema change that renamed `status` or `bracketTag` — all land
    /// here, and none of them may replace a working combo table with nothing.
    ///
    /// **Refusing is what self-heals.** A swap here would promote an empty table *and* stamp
    /// the ETag in the same transaction, so the next weekly check would replay that ETag, be
    /// told 304, and keep an empty database forever with nothing in `error_log` to say why.
    #[error(
        "the combo file held no usable combos ({skipped} of {seen} variants skipped); \
         keeping the previous ones"
    )]
    Empty { skipped: u64, seen: u64 },
}

impl ComboError {
    /// How the error log should classify this. A dead connection and a body that is not what it
    /// claimed to be must never be flattened into one word.
    pub fn kind(&self) -> crate::errors::Kind {
        use crate::errors::Kind;
        match self {
            ComboError::Http(e) if e.is_timeout() => Kind::Timeout,
            ComboError::Http(_) => Kind::Http,
            ComboError::Status { .. } => Kind::Http,
            ComboError::TooLarge => Kind::Http,
            ComboError::Io(_) => Kind::Io,
            ComboError::Db(_) => Kind::Io,
            ComboError::Parse(_) | ComboError::Empty { .. } => Kind::Parse,
        }
    }
}

// ---------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------

/// What one completed ingest did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ingested {
    pub combos: usize,
    pub cards: usize,
    pub skipped: u64,
    pub seen: u64,
}

/// Fill `combos_staging` / `combo_cards_staging` from `file` and promote them.
///
/// # A failed run leaves nothing half-built
///
/// Everything is written to the staging twins, which no reader can see, and promoted by one
/// rename transaction at the end — with the `combo_meta` row in that same transaction, which is
/// the contract: a watermark without its rows would 304 past an empty database forever, and
/// rows without their watermark would re-download a file the database already holds. A failure
/// partway leaves the previous combos exactly where they were and a committed staging table
/// that the next run's [`crate::schema::create_combo_staging`] drops before it writes a row.
///
/// # The connection is taken a batch at a time
///
/// [`crate::tags::ingest_gz`]'s discipline, and its reason: `db` is the shared write connection
/// and holding it for the length of an insert is what turns a reader's edit into a frozen
/// button. This is where the module parts company with [`crate::marketplace_feed::store`],
/// which writes the *live* table and therefore cannot commit in pieces.
pub fn store(
    db: &Mutex<Connection>,
    file: &ComboFile,
    etag: Option<&str>,
    fetched_at: i64,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Ingested, ComboError> {
    // Before a single staging table is created, so a refused file costs the database nothing
    // at all — not even a table to drop next time.
    if file.combos.is_empty() {
        return Err(ComboError::Empty {
            skipped: file.skipped,
            seen: file.seen,
        });
    }

    {
        let conn = crate::db::lock_blocking(db);
        crate::schema::create_combo_staging(&conn)?;
    }

    let total = file.combos.len() as u64;
    let mut written = 0u64;
    let mut cards_written = 0usize;
    progress(0, total);

    for chunk in file.combos.chunks(BATCH) {
        let mut conn = crate::db::lock_blocking(db);
        let tx = conn.transaction()?;
        {
            let mut combo = tx.prepare_cached(
                "INSERT INTO combos_staging
                    (id, bracket_tag, card_count, template_count, identity, produces, popularity)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            let mut card = tx.prepare_cached(
                "INSERT INTO combo_cards_staging
                    (combo_id, oracle_id, name, quantity, must_be_commander)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for c in chunk {
                combo.execute(params![
                    c.id,
                    c.bracket_tag,
                    c.card_count,
                    c.template_count,
                    c.identity,
                    c.produces,
                    c.popularity
                ])?;
                // **In the file's order, and that is load-bearing**: `combo_cards` has no
                // ordinal column, so insert order is rowid order and rowid order is what
                // `combos_for_cards` reads the names back in. A rename carries rowids, so the
                // swap preserves it.
                for u in &c.cards {
                    card.execute(params![
                        c.id,
                        u.oracle_id,
                        u.name,
                        u.quantity,
                        u.must_be_commander
                    ])?;
                    cards_written += 1;
                }
            }
        }
        tx.commit()?;
        drop(conn);
        stand_aside();
        written += chunk.len() as u64;
        progress(written, total);
    }

    {
        let mut conn = crate::db::lock_blocking(db);
        let tx = conn.transaction()?;
        crate::schema::swap_combo_staging(&tx)?;
        tx.execute(
            "INSERT INTO combo_meta
                (id, etag, stamp, fetched_at, checked_at, combo_count, skipped)
             VALUES (1, ?1, ?2, ?3, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                etag = excluded.etag,
                stamp = excluded.stamp,
                fetched_at = excluded.fetched_at,
                checked_at = excluded.checked_at,
                combo_count = excluded.combo_count,
                skipped = excluded.skipped",
            // `?3` twice: an ingest is also a check, and the two stamps only come apart when a
            // later run is told 304.
            params![
                etag,
                file.stamp,
                fetched_at,
                file.combos.len() as i64,
                file.skipped as i64
            ],
        )?;
        tx.commit()?;
    }

    Ok(Ingested {
        combos: file.combos.len(),
        cards: cards_written,
        skipped: file.skipped,
        seen: file.seen,
    })
}

/// Decompress a downloaded `variants.json.gz`, reduce it, and replace the stored combos.
///
/// The blocking half of a refresh, and the reason the two halves are separate functions: the
/// parse is seconds of CPU over 639 MB of decompressed JSON and the write is a lock this app is
/// careful with, so neither belongs on the async runtime and neither may hold the other's
/// resource.
pub fn ingest_gz(
    db: &Mutex<Connection>,
    gz_path: &Path,
    etag: Option<&str>,
    fetched_at: i64,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Ingested, ComboError> {
    use std::io::Read as _;

    // Opened before the database is touched: a missing or unreadable path must not cost the
    // caller the staging tables it was about to fill.
    let mut handle = std::fs::File::open(gz_path)?;
    let chunks = std::iter::from_fn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        match handle.read(&mut buf) {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some(Ok(buf))
            }
            Err(e) => Some(Err(e)),
        }
    });
    ingest_stream(db, chunks, etag, fetched_at, progress)
}

/// Ingest the combo feed from a stream of byte chunks.
///
/// **The parse finishes before the write begins.** What it keeps is small - an id, a letter,
/// a colour string, the feature names and two or three card rows per variant - and holding
/// it costs a fraction of what the file would if any of it were read twice.
pub fn ingest_stream(
    db: &Mutex<Connection>,
    chunks: impl Iterator<Item = std::io::Result<Vec<u8>>>,
    etag: Option<&str>,
    fetched_at: i64,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Ingested, ComboError> {
    let file = read_stream(chunks)?;
    store(db, &file, etag, fetched_at, progress)
}

/// Write a failed refresh to `error_log`, best-effort.
///
/// **`Source::Database` is the closest source this schema has, and it is not a good fit** —
/// these are HTTP failures against `json.commanderspellbook.com`, which is not this app's own
/// SQLite. [`crate::marketplace_feed`] borrows the same one for the same reason: a source of
/// its own would need a CHECK rebuild on `error_log`, a variant in [`crate::errors::Source`]
/// and an arm in the frontend's total `SOURCE_LABEL` map. The `operation` carries the feed's
/// name instead — that field is free text precisely so a new call site can report a failure
/// without a migration first.
fn note_failure(db: &Mutex<Connection>, err: &ComboError) {
    // Skipped rather than waited for if the connection is busy: this describes a failure that
    // has already happened, on a path that is already returning an error.
    if let Some(conn) = crate::db::lock_for(db, crate::db::WRITE_LOCK_WAIT) {
        crate::errors::record(
            &conn,
            crate::errors::Source::Database,
            "combos",
            err.kind(),
            &err.to_string(),
            Some(FEED_URL),
        );
    }
}

// ---------------------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------------------

/// The HTTP client Commander Spellbook is talked to with.
///
/// **Deliberately not [`crate::scryfall::Client`]** — see the module header. The user agent is
/// shared because it is accurate here too: it names this app, its version and its repository,
/// which is what a public bulk endpoint is owed.
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

/// What one conditional GET produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fetch {
    /// A 304: the file we already hold is still the current one, and it cost zero bytes.
    NotModified,
    /// A body, on disk at the destination, with whatever ETag came with it.
    Fetched { etag: Option<String> },
}

/// Stream the combo file to `dest`, reporting `(done, total)` as it goes.
///
/// To a file and not into memory, for [`crate::sync`]'s reason: the parse wants a `Read` and
/// reqwest only offers an async stream, so the choice is a temp file or 27.5 MB of `Vec<u8>`
/// held while a second copy of it is decompressed. `total` is `0` when the host declares no
/// `Content-Length`, which is a progress bar with no denominator rather than an error.
///
/// **A refusal leaves nothing at `dest`** — including a size refusal that trips mid-stream,
/// where the partial is deleted before returning. There is no resume here, and a half-written
/// body would only fail to decompress next time.
pub async fn download(
    url: &str,
    dest: &Path,
    if_none_match: Option<&str>,
    progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<Fetch, ComboError> {
    download_capped(url, dest, if_none_match, MAX_FEED_BYTES, progress).await
}

/// [`download`] with the bound handed in, which is the seam the size-guard tests drive.
async fn download_capped(
    url: &str,
    dest: &Path,
    if_none_match: Option<&str>,
    max_bytes: u64,
    progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<Fetch, ComboError> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut req = client().get(url);
    if let Some(etag) = if_none_match {
        req = req.header("If-None-Match", etag);
    }
    let resp = req.send().await.map_err(ComboError::Http)?;
    let status = resp.status().as_u16();
    // The common case once a database has the file, and it costs zero bytes. Checked before the
    // success range, because 304 is not in it.
    if status == 304 {
        return Ok(Fetch::NotModified);
    }
    if !(200..300).contains(&status) {
        return Err(ComboError::Status { status });
    }
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    // The cheap check first: a declared length past the bound is refused before a byte of body
    // is read. It is a claim, though, and a chunked response makes none — so the streamed total
    // below is the one that actually holds.
    let total = resp.content_length().unwrap_or(0);
    if total > max_bytes {
        return Err(ComboError::TooLarge);
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
        let chunk = chunk.map_err(ComboError::Http)?;
        done += chunk.len() as u64;
        if done > max_bytes {
            // Closed before it is removed: Windows refuses to delete a file that is still open.
            drop(file);
            let _ = tokio::fs::remove_file(dest).await;
            return Err(ComboError::TooLarge);
        }
        file.write_all(&chunk).await?;
        if done.saturating_sub(last_emit) >= PROGRESS_EMIT_BYTES || done >= total {
            last_emit = done;
            progress(done, total.max(done));
        }
    }
    file.flush().await?;
    Ok(Fetch::Fetched { etag })
}

/// Where the file is downloaded to. Beside the bulk file's and the price feeds' `tmp/`, and
/// deleted either way.
fn temp_path(state: &AppState) -> PathBuf {
    state
        .data_dir
        .join("tmp")
        .join("spellbook-variants.json.gz")
}

// ---------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------

/// What the UI needs to say whether this app has combo data and how old it is.
///
/// Serialised `camelCase` to the shape `src/lib/ipc.ts` mirrors by hand.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComboStatus {
    /// Combos stored.
    pub combos: i64,
    /// **Distinct cards** those combos name, not card rows: a card in three combos is one card.
    pub cards: i64,
    /// The file's own `timestamp` for the rows we hold, verbatim. `None` on a database that has
    /// never ingested — and, separately, on a file that carried none.
    pub stamp: Option<String>,
    /// Unix seconds when rows last changed. **`None` is "never ingested"**, which is a
    /// different state from a check that found nothing, and the one that means the bracket
    /// estimate is reading three signals instead of four.
    pub fetched_at: Option<i64>,
    /// Unix seconds: when Spellbook was last **asked**. Moves on a 304, where `fetchedAt` does
    /// not — so the two coming apart is the ordinary state of an up-to-date database, not a
    /// fault.
    pub checked_at: Option<i64>,
    /// Checked longer ago than [`REFRESH_INTERVAL_SECS`], or never ingested at all.
    pub stale: bool,
}

/// The stored watermark: which file the rows came from, and when we last asked.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ComboMeta {
    etag: Option<String>,
    stamp: Option<String>,
    fetched_at: Option<i64>,
    checked_at: Option<i64>,
}

fn read_meta(conn: &Connection) -> Option<ComboMeta> {
    conn.query_row(
        "SELECT etag, stamp, fetched_at, checked_at FROM combo_meta WHERE id = 1",
        [],
        |r| {
            Ok(ComboMeta {
                etag: r.get(0)?,
                stamp: r.get(1)?,
                fetched_at: r.get(2)?,
                checked_at: r.get(3)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// Are there combos to read? The second half of the ETag decision.
///
/// `tags::closure_is_populated`'s rule, for its reason: metadata can outlive the rows it
/// describes, and replaying an `If-None-Match` for a file whose rows are gone earns a 304 that
/// no amount of refreshing can get past.
fn is_populated(conn: &Connection) -> bool {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM combos)", [], |r| {
        r.get::<_, i64>(0)
    })
    .map(|n| n == 1)
    .unwrap_or(false)
}

/// Has this file earned another look? **`checked_at`, not `fetched_at`** — a 304 means the rows
/// are current, and asking again tomorrow because they were *built* a week ago would spend a
/// request per launch to learn nothing. Never checked is stale by definition, and a stamp in
/// the future (a clock that moved) counts as stale rather than underflowing.
pub fn is_stale(checked_at: Option<i64>, now: i64) -> bool {
    match checked_at {
        None => true,
        Some(at) => at > now || now - at >= REFRESH_INTERVAL_SECS,
    }
}

/// The combo database's state, read from a connection the caller already holds.
///
/// **Both counts come from the tables and neither from `combo_meta.combo_count`**, deliberately:
/// a watermark can outlive the rows it describes — that is the whole reason [`is_populated`]
/// exists one function up — and a status that read the meta row would report a full database
/// over two empty tables. The cost is an index scan of `combos`' primary key and one of
/// `idx_combo_cards_oracle`; both are answered on the read-only connection, off the IPC thread.
pub fn read_status(conn: &Connection, now: i64) -> ComboStatus {
    let meta = read_meta(conn);
    // A count that cannot be read is reported as zero rather than failing the call: this is the
    // answer a settings panel and a bracket advisory draw their copy from, and there is nothing
    // useful either could do with an error that it does not already do with a zero.
    let combos = conn
        .query_row("SELECT count(*) FROM combos", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0);
    let cards = conn
        .query_row(
            "SELECT count(DISTINCT oracle_id) FROM combo_cards",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0);
    ComboStatus {
        combos,
        cards,
        stamp: meta.as_ref().and_then(|m| m.stamp.clone()),
        fetched_at: meta.as_ref().and_then(|m| m.fetched_at),
        checked_at: meta.as_ref().and_then(|m| m.checked_at),
        stale: is_stale(meta.as_ref().and_then(|m| m.checked_at), now),
    }
}

fn status_of(state: &AppState) -> ComboStatus {
    let conn = crate::sync::lock_db_read(state);
    read_status(&conn, unix_now())
}

/// Seconds since the Unix epoch. A clock before 1970 reads as 0, which makes the combo
/// database stale — [`crate::sync`]'s choice, for its reason.
fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------------------
// The match
// ---------------------------------------------------------------------------------------

/// One combo a deck holds every named card of.
///
/// Serialised `camelCase` to the shape `src/lib/ipc.ts` mirrors by hand.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeckCombo {
    pub id: String,
    /// One of [`BRACKET_TAGS`].
    pub bracket_tag: String,
    /// Card names, the file's order.
    pub cards: Vec<String>,
    /// Templates the combo also needs ("a creature with flying") — unresolvable here. `0` is a
    /// combo the deck definitely has.
    pub template_count: i64,
    /// What it does — feature names, one per line.
    pub produces: String,
    pub popularity: Option<i64>,
}

/// **Start from the deck, never from `combos`.** `idx_combo_cards_oracle` is the index this
/// turns on: the deck's distinct oracle ids are a hundred-odd values, each a point lookup into
/// that index, and `hit` is therefore built out of the few hundred combo rows those cards
/// appear in rather than out of the whole catalogue. Reversing it — scanning `combos` and
/// asking whether the deck holds each — is a scan of every combo Spellbook has ever published,
/// per deck, per keystroke.
///
/// `{holes}` is a placeholder per card id. **Never interpolated values**: the ids come off the
/// wire.
const MATCH_SQL: &str = "
WITH deck(oracle_id) AS (SELECT DISTINCT oracle_id FROM cards
                          WHERE id IN ({holes}) AND oracle_id IS NOT NULL),
     hit AS (SELECT cc.combo_id, count(DISTINCT cc.oracle_id) AS have
               FROM combo_cards cc JOIN deck d ON d.oracle_id = cc.oracle_id
              GROUP BY cc.combo_id)
SELECT c.id, c.bracket_tag, c.template_count, c.produces, c.popularity
  FROM hit h JOIN combos c ON c.id = h.combo_id
 WHERE h.have = c.card_count
 ORDER BY c.template_count, c.popularity DESC, c.id";

/// Every combo whose named cards are all in `card_ids`.
///
/// The `ORDER BY` is this app's and not the query's contract: fully-checkable combos first (a
/// `template_count` of 0 is a combo the deck definitely has), then most-played, then the id so
/// two runs over one deck cannot answer in two different orders. SQLite sorts NULLs first, so
/// `popularity DESC` puts an unranked combo last, which is where it belongs.
///
/// A deck with no combos, and a database that has never ingested, both answer `[]`. The
/// difference between them is [`ComboStatus::fetched_at`]'s to tell, because a caller that
/// cannot tell "no combos" from "no data" will say the wrong one of the two.
pub fn match_combos(conn: &Connection, card_ids: &[String]) -> Result<Vec<DeckCombo>, String> {
    // Trimmed and deduplicated before the cap is applied: a caller sending one card twice has
    // not asked about two cards, and refusing it would be refusing a deck over a list.
    let mut wanted: Vec<&str> = Vec::with_capacity(card_ids.len());
    let mut seen: HashSet<&str> = HashSet::new();
    for id in card_ids {
        let id = id.trim();
        if !id.is_empty() && seen.insert(id) {
            wanted.push(id);
        }
    }
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    if wanted.len() > MAX_CARD_IDS {
        return Err(TOO_MANY_CARDS.to_owned());
    }

    let holes = vec!["?"; wanted.len()].join(",");
    let mut stmt = conn
        .prepare_cached(&MATCH_SQL.replace("{holes}", &holes))
        .map_err(|e| format!("could not look for combos: {e}"))?;
    let matched: Vec<(String, String, i64, String, Option<i64>)> = stmt
        .query_map(params_from_iter(wanted.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .and_then(|rows| rows.collect())
        .map_err(|e| format!("could not look for combos: {e}"))?;

    // The names, per matched combo. A second statement rather than a join, because a join would
    // multiply every combo row by its cards and the caller wants one entry per combo with its
    // names in order — and the number of matched combos is small enough that a prepared lookup
    // per combo over `idx_combo_cards_combo` is cheaper than the fold would be.
    //
    // **`ORDER BY rowid` is the file's order**: `combo_cards` carries no ordinal column, the
    // ingest inserts in the order the file listed, and a staging swap is a rename, which keeps
    // rowids.
    let mut names = conn
        .prepare_cached("SELECT name FROM combo_cards WHERE combo_id = ?1 ORDER BY rowid")
        .map_err(|e| format!("could not look for combos: {e}"))?;
    let mut out = Vec::with_capacity(matched.len());
    for (id, bracket_tag, template_count, produces, popularity) in matched {
        let cards: Vec<String> = names
            .query_map(params![id], |r| r.get::<_, String>(0))
            .and_then(|rows| rows.collect())
            .map_err(|e| format!("could not read a combo's cards: {e}"))?;
        out.push(DeckCombo {
            id,
            bracket_tag,
            cards,
            template_count,
            produces,
            popularity,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------------------

/// One refresh at a time.
///
/// **A flag rather than [`crate::tags`]'s list of names**, because there is one file: that list
/// exists so an art refresh does not refuse because an oracle one is running, and there is no
/// second dataset here to be refused by. Module-level rather than a field on `AppState` because
/// it is this module's concern alone.
static REFRESHING: AtomicBool = AtomicBool::new(false);

/// Clears the claim however the refresh ends — an early return, an error, a dropped future.
/// `sync::SyncingGuard`'s shape, for its reason: a latched flag locks the reader out until they
/// restart the app.
struct RefreshGuard;

impl RefreshGuard {
    /// Claim the refresh, or `None` if one is already running.
    fn claim() -> Option<RefreshGuard> {
        REFRESHING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| RefreshGuard)
    }
}

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        REFRESHING.store(false, Ordering::SeqCst);
    }
}

/// Is a refresh in flight?
///
/// **Test-only, unlike its two siblings**, and the reason is the wire contract:
/// [`ComboStatus`] carries no `refreshing` field where `FeedStatus` and `TagStatus` both do, so
/// nothing in production has a place to put the answer. A page learns a refresh is running from
/// [`PROGRESS_EVENT`], which is the fast path and the only one that can say *how far in* it is.
#[cfg(test)]
fn is_refreshing() -> bool {
    REFRESHING.load(Ordering::SeqCst)
}

/// The ETag to replay, or `None`.
///
/// **The stored ETag describes a *file*, not the state of this database.** Replaying it when the
/// tables are empty earns a 304 for a database that has nothing in it, and no amount of
/// refreshing gets past that — the rows would be gone, the watermark would say they were
/// current, and every weekly check from then on would agree. `tags::refresh` has the same line
/// one family over, and it is there because the version without it shipped.
///
/// Its own function rather than an inline `filter` so the rule can be asserted without a
/// network in the way.
fn conditional_etag(etag: Option<&str>, populated: bool) -> Option<&str> {
    etag.filter(|_| populated)
}

/// Should a launch go and refresh this? See [`refresh_if_due`] for the reasoning; this is the
/// arithmetic of it, split out so it can be asserted directly.
fn due_at_startup(meta: Option<&ComboMeta>, now: i64) -> bool {
    match meta {
        // Never ingested: not a launch's to start.
        None => false,
        Some(meta) if meta.fetched_at.is_none() => false,
        Some(meta) => is_stale(meta.checked_at, now),
    }
}

/// Note that Spellbook has been asked, on a run that found nothing to ingest.
///
/// Best-effort and skipped rather than waited for if the connection is busy: the worst a lost
/// stamp costs is one more conditional request a week from now. **Nothing is written when there
/// is no row**, which is the never-ingested state: a watermark with no rows behind it is exactly
/// what would make the next run 304 past an empty database.
fn mark_checked(state: &Arc<AppState>) {
    let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) else {
        return;
    };
    let _ = conn.execute(
        "UPDATE combo_meta SET checked_at = ?1 WHERE id = 1",
        params![unix_now()],
    );
}

/// Fetch the combo file if it has changed, and replace the stored combos with it.
///
/// `force` skips the [`REFRESH_INTERVAL_SECS`] throttle but **not** the ETag check: a forced
/// refresh that finds the same file answers in well under a second and downloads nothing.
///
/// `progress` is called with `(phase, done, total)`; [`combos_refresh`] turns that into
/// [`PROGRESS_EVENT`]. Taken as a callback rather than an `AppHandle` for [`crate::ingest`]'s
/// reason — it is what lets the whole path be driven from a test.
///
/// Every failure leaves the previous combos exactly where they were and is written to
/// `error_log`.
pub async fn refresh(
    state: &Arc<AppState>,
    force: bool,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<ComboStatus, String> {
    let Some(_guard) = RefreshGuard::claim() else {
        // Refused rather than queued, exactly as a second concurrent sync is: the run already
        // in flight is the one driving the progress event, and a second would download the same
        // 27.5 MB to write the same rows.
        return Err("Combo data is already being refreshed.".to_owned());
    };

    let (etag, checked_at, populated) = {
        let conn = crate::sync::lock_db_read(state);
        let meta = read_meta(&conn);
        (
            meta.as_ref().and_then(|m| m.etag.clone()),
            meta.as_ref().and_then(|m| m.checked_at),
            is_populated(&conn),
        )
    };
    if !force && !is_stale(checked_at, unix_now()) {
        return Ok(status_of(state));
    }

    progress("checking", 0, 0);
    let conditional = conditional_etag(etag.as_deref(), populated);

    let gz = temp_path(state);
    let fetched = download(FEED_URL, &gz, conditional, &mut |done, total| {
        progress("downloading", done, total)
    })
    .await;
    let etag = match fetched {
        Ok(Fetch::NotModified) => {
            // The common case once a database holds the file, and it costs zero bytes. The rows
            // are untouched and only the "when did we last ask" stamp moves — without which an
            // up-to-date database would be due again on the very next launch.
            mark_checked(state);
            progress("done", 0, 0);
            return Ok(status_of(state));
        }
        Ok(Fetch::Fetched { etag }) => etag,
        Err(e) => {
            // The partial is no use to anyone: there is no resume here and a half-written body
            // would only fail to decompress next time. (A size refusal has already removed it.)
            let _ = std::fs::remove_file(&gz);
            note_failure(&state.db, &e);
            progress("error", 0, 0);
            return Err(e.to_string());
        }
    };

    progress("ingesting", 0, 0);
    let fetched_at = unix_now();
    let joined = {
        let state = state.clone();
        let gz = gz.clone();
        // 639 MB of decompressed JSON and hundreds of thousands of inserts: a blocking thread,
        // never the async runtime, and never across an `.await` with a lock in hand.
        tauri::async_runtime::spawn_blocking(move || {
            ingest_gz(&state.db, &gz, etag.as_deref(), fetched_at, &mut |_, _| {})
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
            note_failure(&state.db, &e);
            progress("error", 0, 0);
            Err(e.to_string())
        }
        Err(e) => {
            progress("error", 0, 0);
            Err(format!("the combo file could not be processed: {e}"))
        }
    }
}

/// Refresh the combo database at startup if it is due — **and only if it has ever been
/// fetched**.
///
/// That second condition is the difference between this and `tags::refresh_if_due`, and it is
/// deliberate: the tag files are what the app categorises a deck add by, so a first run fetches
/// them uninvited, while combos are the *fourth* bracket signal and a database without them
/// simply reads three. Nothing downloads until a reader presses Refresh in Settings — which is
/// [`crate::marketplace_feed::refresh_selected_if_due`]'s shape, where a marketplace nobody
/// picked is never downloaded — and once they have, this keeps it current. It is also what lets
/// the Settings panel say "never fetched" and mean it, rather than describing a state a launch
/// quietly walks out of.
///
/// **Silent, best-effort and never blocking.** It runs before there is a window to complain in,
/// a failure is already in `error_log`, and the honest fallback is the combos already on disk.
pub async fn refresh_if_due(state: &Arc<AppState>, app: &tauri::AppHandle) {
    let due = {
        let conn = crate::sync::lock_db_read(state);
        due_at_startup(read_meta(&conn).as_ref(), unix_now())
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
        eprintln!("could not refresh combo data: {e}");
    }
}

// ---------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------

/// Payload of [`PROGRESS_EVENT`].
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComboProgress {
    /// One of [`PHASES`].
    pub phase: String,
    pub done: u64,
    pub total: u64,
}

/// Emit one progress event. Dropped if nobody is listening, which is Tauri's behaviour and is
/// why [`combos_status`] exists: the event is the fast path, the tables are what a reader can
/// still consult a minute later.
fn emit(app: &tauri::AppHandle, phase: &str, done: u64, total: u64) {
    debug_assert!(PHASES.contains(&phase), "unknown combo phase `{phase}`");
    let _ = app.emit(
        PROGRESS_EVENT,
        ComboProgress {
            phase: phase.to_owned(),
            done,
            total,
        },
    );
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What this app knows about combos: how many, over how many cards, from which build of the
/// file, and how old.
///
/// **Safe before the first refresh has ever run** — a database with no `combo_meta` row answers
/// two zeros, three nulls and `stale: true` rather than rejecting, so no caller needs a guard.
///
/// `async`, and answered on the blocking pool, because a sync command body runs inline on the
/// IPC thread and this takes `db_read`'s mutex.
#[tauri::command]
pub async fn combos_status(state: tauri::State<'_, Arc<AppState>>) -> Result<ComboStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || status_of(&state))
        .await
        .map_err(|e| format!("could not read the combo status: {e}"))
}

/// Download Commander Spellbook's combo file if it has changed and rebuild the combo tables
/// from it.
///
/// `force` skips the weekly throttle, not the ETag check. Long-running by nature (27.5 MB), so
/// it reports itself through [`PROGRESS_EVENT`]. A failure leaves the previous combos in place,
/// and the reason is in the error log.
#[tauri::command]
pub async fn combos_refresh(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    force: bool,
) -> Result<ComboStatus, String> {
    let state = state.inner().clone();
    refresh(&state, force, &mut |phase, done, total| {
        emit(&app, phase, done, total)
    })
    .await
}

/// Every combo the given printings can make between them.
///
/// One round trip for a whole deck, and the ids are `cards.id` — a printing id, which is what
/// every deck row, drag source and resolved import line already holds. At most
/// [`MAX_CARD_IDS`] of them; see [`match_combos`] for why the list length is a real bound.
///
/// `async`, and answered on the blocking pool, for [`combos_status`]'s reason.
#[tauri::command]
pub async fn combos_for_cards(
    state: tauri::State<'_, Arc<AppState>>,
    card_ids: Vec<String>,
) -> Result<Vec<DeckCombo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        match_combos(&conn, &card_ids)
    })
    .await
    .map_err(|e| format!("could not look for combos: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ---- fixtures ---------------------------------------------------------------------

    fn mem_db() -> Mutex<Connection> {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate_single_file(&conn).unwrap();
        Mutex::new(conn)
    }

    /// A `uses[]` entry carrying the ten image URLs and the type line the real file does, so
    /// every assertion about what is *kept* is also an assertion about what is dropped.
    fn uses(name: &str, oracle: &str) -> String {
        let images: String = [
            "artCrop",
            "artCropFoil",
            "borderCrop",
            "borderCropFoil",
            "large",
            "largeFoil",
            "normal",
            "normalFoil",
            "small",
            "smallFoil",
        ]
        .iter()
        .map(|k| format!(r#""imageUri{k}":"https://cards.scryfall.io/{k}/{oracle}.jpg","#))
        .collect();
        format!(
            r#"{{"card":{{"name":"{name}","oracleId":"{oracle}",{images}"typeLine":"Creature"}},
                "quantity":1,"mustBeCommander":false,"zoneLocations":["H"]}}"#
        )
    }

    /// A whole document, from raw `variants[]` entries.
    fn document(variants: &[String]) -> String {
        format!(
            r#"{{"timestamp":"2026-08-27T03:12:44Z","version":"v2","variants":[{}]}}"#,
            variants.join(",")
        )
    }

    /// A published, Commander-legal two-card variant.
    fn ok_variant(id: &str, tag: &str, cards: &[(&str, &str)]) -> String {
        let uses: Vec<String> = cards.iter().map(|(n, o)| uses(n, o)).collect();
        format!(
            r#"{{"id":"{id}","status":"OK","bracketTag":"{tag}","identity":"UB",
                 "popularity":4200,"legalities":{{"commander":true,"legacy":true}},
                 "uses":[{}],"requires":[],
                 "produces":[{{"feature":{{"name":"Infinite mana"}},"quantity":1}}],
                 "description":"Long prose.","notes":"More prose.",
                 "prices":{{"tcgplayer":"12.34"}}}}"#,
            uses.join(",")
        )
    }

    fn parse(body: &str) -> ComboFile {
        read_file(&mut body.as_bytes()).unwrap()
    }

    /// Seed the live tables directly, which is how a "the previous rows are still there" test
    /// gets something to stand.
    fn seed_one(db: &Mutex<Connection>, id: &str, oracle: &str) {
        let conn = crate::db::lock_blocking(db);
        conn.execute(
            "INSERT INTO combos (id, bracket_tag, card_count, template_count, identity,
                                 produces, popularity)
             VALUES (?1, 'R', 1, 0, 'B', 'Infinite turns', 9)",
            params![id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO combo_cards (combo_id, oracle_id, name, quantity, must_be_commander)
             VALUES (?1, ?2, 'Seeded Card', 1, 0)",
            params![id, oracle],
        )
        .unwrap();
    }

    /// A card row, so the match query's `deck` CTE has something to resolve.
    fn seed_card(conn: &Connection, id: &str, oracle: &str, name: &str) {
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang,
                                layout, raw)
             VALUES (?1, ?2, ?3, 'tst', '1', 'en', 'normal', '{}')",
            params![id, oracle, name],
        )
        .unwrap();
    }

    fn gz_fixture(body: &str, tag: &str) -> PathBuf {
        use flate2::{write::GzEncoder, Compression};
        let dir = std::env::temp_dir().join("mtgtest-combos");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!(
            "{tag}-{}-{:?}.json.gz",
            std::process::id(),
            std::thread::current().id()
        ));
        let mut enc = GzEncoder::new(std::fs::File::create(&p).unwrap(), Compression::fast());
        enc.write_all(body.as_bytes()).unwrap();
        enc.finish().unwrap();
        p
    }

    // ---- the parse --------------------------------------------------------------------

    /// **What survives the reduction, and what does not.** Every `uses[].card` in the fixture
    /// carries the ten `imageUri*` fields and the type line the real file does, and every
    /// variant carries a description, notes and prices; none of it may appear in the result.
    #[test]
    fn the_parse_keeps_the_fields_that_matter_and_drops_the_image_urls() {
        let file = parse(&document(&[ok_variant(
            "1957-4050-7918--204",
            "R",
            &[
                ("Thassa's Oracle", "o-thassa"),
                ("Demonic Consultation", "o-dc"),
            ],
        )]));

        assert_eq!(file.stamp.as_deref(), Some("2026-08-27T03:12:44Z"));
        assert_eq!(file.seen, 1);
        assert_eq!(file.skipped, 0);
        assert_eq!(
            file.combos,
            vec![Combo {
                id: "1957-4050-7918--204".into(),
                bracket_tag: "R".into(),
                card_count: 2,
                template_count: 0,
                identity: "UB".into(),
                produces: "Infinite mana".into(),
                popularity: Some(4200),
                cards: vec![
                    ComboCard {
                        oracle_id: "o-thassa".into(),
                        name: "Thassa's Oracle".into(),
                        quantity: 1,
                        must_be_commander: false,
                    },
                    ComboCard {
                        oracle_id: "o-dc".into(),
                        name: "Demonic Consultation".into(),
                        quantity: 1,
                        must_be_commander: false,
                    },
                ],
            }]
        );
        // Said again from the other end, because the point of the streaming parse is that
        // 23× of the file never becomes anything: no field of the result may hold a URL.
        let rendered = format!("{:?}", file.combos);
        assert!(!rendered.contains("scryfall.io"), "{rendered}");
        assert!(!rendered.contains("Long prose"), "{rendered}");
    }

    /// The two conditions a variant has to meet, each failed on its own. Everything else in
    /// Spellbook's `status` enum is its editorial pipeline showing through the file, and a
    /// combo that is not Commander-legal is not what this feature is about.
    #[test]
    fn a_variant_that_is_not_ok_or_not_commander_legal_is_skipped_and_counted() {
        let draft = ok_variant("draft", "C", &[("A", "oa"), ("B", "ob")])
            .replace(r#""status":"OK""#, r#""status":"D""#);
        let modern = ok_variant("modern", "C", &[("A", "oa"), ("B", "ob")])
            .replace(r#""commander":true"#, r#""commander":false"#);
        let nothing = ok_variant("nothing", "C", &[("A", "oa"), ("B", "ob")])
            .replace(r#""legalities":{"commander":true,"legacy":true},"#, "");
        let good = ok_variant("good", "C", &[("A", "oa"), ("B", "ob")]);

        let file = parse(&document(&[draft, modern, nothing, good]));

        assert_eq!(file.seen, 4);
        assert_eq!(file.skipped, 3, "three of the four produce nothing");
        assert_eq!(
            file.combos
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            vec!["good"]
        );
    }

    /// A variant no card of which can be identified could never match a deck, and a
    /// `card_count` of 0 would sit in the table forever without reaching the join.
    ///
    /// **And a variant only *some* of whose cards lack an oracle id counts the rest as
    /// templates**, which is the one place this reads wider than `requires[]`: a card the file
    /// named but did not identify is exactly as uncheckable as "a creature with flying", and
    /// storing the remainder as complete would claim a deck holds a combo it might not.
    #[test]
    fn a_variant_whose_cards_have_no_oracle_id_is_skipped_and_a_missing_one_counts_as_a_template() {
        let none = r#"{"id":"none","status":"OK","bracketTag":"C","legalities":{"commander":true},
            "uses":[{"card":{"name":"Mystery"},"quantity":1},
                    {"card":{"name":"Other","oracleId":"  "},"quantity":1}],
            "requires":[],"produces":[]}"#;
        let half = r#"{"id":"half","status":"OK","bracketTag":"C","legalities":{"commander":true},
            "uses":[{"card":{"name":"Known","oracleId":"ok1"},"quantity":1},
                    {"card":{"name":"Mystery"},"quantity":1}],
            "requires":[{"template":{"name":"a creature with flying"}}],"produces":[]}"#;

        let file = parse(&document(&[none.to_owned(), half.to_owned()]));

        assert_eq!(file.skipped, 1, "only `none` is unmatchable");
        assert_eq!(file.combos.len(), 1);
        let kept = &file.combos[0];
        assert_eq!(kept.id, "half");
        assert_eq!(kept.card_count, 1, "one identified card");
        assert_eq!(
            kept.template_count, 2,
            "the `requires[]` entry and the card that could not be identified"
        );
    }

    /// **`card_count` is the distinct oracle id count**, because the match query compares
    /// against a `count(DISTINCT cc.oracle_id)`. A combo naming one card twice — a copy in the
    /// command zone and one in the library — is a one-card requirement as far as a deck list is
    /// concerned, and counting the rows would make it permanently unmatchable.
    #[test]
    fn card_count_is_the_distinct_oracle_id_count() {
        let twice = r#"{"id":"twice","status":"OK","bracketTag":"S","legalities":{"commander":true},
            "uses":[{"card":{"name":"Kiki","oracleId":"o-kiki"},"quantity":1,
                     "mustBeCommander":true},
                    {"card":{"name":"Kiki","oracleId":"o-kiki"},"quantity":1}],
            "requires":[],"produces":[]}"#;

        let file = parse(&document(&[twice.to_owned()]));

        let kept = &file.combos[0];
        assert_eq!(kept.cards.len(), 2, "both rows are stored");
        assert_eq!(kept.card_count, 1, "and they are one card to a deck list");
        assert!(kept.cards[0].must_be_commander);
        assert!(!kept.cards[1].must_be_commander);
    }

    /// A letter this build has never heard of is skipped rather than stored: the TypeScript
    /// side spells the seven as a closed union with a total map over it, and an eighth would
    /// reach that map as `undefined`.
    #[test]
    fn a_bracket_tag_the_app_does_not_know_is_skipped() {
        let unknown = ok_variant("x", "Z", &[("A", "oa"), ("B", "ob")]);
        let absent =
            ok_variant("y", "C", &[("A", "oa"), ("B", "ob")]).replace(r#""bracketTag":"C","#, "");
        let known: Vec<String> = BRACKET_TAGS
            .iter()
            .map(|t| ok_variant(&format!("id-{t}"), t, &[("A", "oa"), ("B", "ob")]))
            .collect();

        let mut all = vec![unknown, absent];
        all.extend(known);
        let file = parse(&document(&all));

        assert_eq!(file.skipped, 2);
        assert_eq!(
            file.combos
                .iter()
                .map(|c| c.bracket_tag.as_str())
                .collect::<Vec<_>>(),
            BRACKET_TAGS,
            "all seven letters are kept and nothing else is"
        );
    }

    /// The feed grows keys without notice, and a new one must not cost the reader their combos.
    #[test]
    fn unknown_keys_anywhere_in_the_document_are_ignored() {
        let body = r#"{
          "version": "v2",
          "variants": [{"id":"a","status":"OK","bracketTag":"P","identity":"R",
                        "legalities":{"commander":true,"pauper":false},
                        "uses":[{"card":{"name":"A","oracleId":"oa","somethingNew":{"deep":[1]}},
                                 "quantity":2,"battlefieldCardState":"tapped"}],
                        "requires":[],"produces":[{"feature":{"name":"Win"},"quantity":1}],
                        "spoiler": false, "variantCount": 3}],
          "timestamp": "2026-08-27T03:12:44Z",
          "trailing": {"after": "variants"}
        }"#;

        let file = parse(body);

        assert_eq!(file.stamp.as_deref(), Some("2026-08-27T03:12:44Z"));
        assert_eq!(file.combos.len(), 1);
        assert_eq!(file.combos[0].produces, "Win");
        assert_eq!(file.combos[0].cards[0].quantity, 2);
    }

    /// Two features come back `\n`-joined, which is what the wire's `produces` is.
    #[test]
    fn produces_is_the_feature_names_one_per_line() {
        let two = r#"{"id":"two","status":"OK","bracketTag":"O","legalities":{"commander":true},
            "uses":[{"card":{"name":"A","oracleId":"oa"}}],"requires":[],
            "produces":[{"feature":{"name":"Infinite mana"}},
                        {"feature":{"name":"Infinite lifegain"}},
                        {"feature":{}},
                        {"quantity":1}]}"#;

        let file = parse(&document(&[two.to_owned()]));

        assert_eq!(
            file.combos[0].produces, "Infinite mana\nInfinite lifegain",
            "a feature with no name contributes no line"
        );
    }

    // ---- the write --------------------------------------------------------------------

    /// The parse is genuinely streaming and the write is genuinely batched: a document far
    /// larger than one batch is read without the variants being collected first, every one of
    /// them lands, and progress is reported more than once.
    #[test]
    fn a_document_larger_than_a_batch_streams_through() {
        let variants: Vec<String> = (0..(BATCH + 137))
            .map(|i| ok_variant(&format!("v{i}"), "C", &[("A", &format!("o{i}"))]))
            .collect();
        let file = parse(&document(&variants));
        assert_eq!(file.seen as usize, BATCH + 137);
        assert_eq!(file.combos.len(), BATCH + 137);

        let db = mem_db();
        let mut ticks: Vec<(u64, u64)> = Vec::new();
        let done = store(&db, &file, Some("W/\"abc\""), 1_800_000_000, &mut |d, t| {
            ticks.push((d, t))
        })
        .unwrap();

        assert_eq!(done.combos, BATCH + 137);
        assert_eq!(done.cards, BATCH + 137);
        assert!(ticks.len() > 2, "more than one batch: {ticks:?}");
        assert_eq!(
            ticks.last(),
            Some(&((BATCH + 137) as u64, (BATCH + 137) as u64))
        );

        let conn = crate::db::lock_blocking(&db);
        let stored: i64 = conn
            .query_row("SELECT count(*) FROM combos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored as usize, BATCH + 137);
        // The staging tables are gone: the swap renamed them over the live ones.
        let staging: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name LIKE 'combo%_staging'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(staging, 0);
    }

    /// **A file that yields nothing is refused, and the previous combos stand.** A swap here
    /// would promote two empty tables *and* stamp the ETag in one transaction, so the next
    /// weekly check would replay it, be told 304, and keep an empty database forever with
    /// nothing in `error_log` to say why.
    #[test]
    fn a_parse_that_yields_zero_combos_is_refused_and_leaves_the_previous_rows_standing() {
        let db = mem_db();
        seed_one(&db, "old", "o-old");

        // Every variant fails a condition: one draft, one not Commander-legal.
        let draft =
            ok_variant("a", "C", &[("A", "oa")]).replace(r#""status":"OK""#, r#""status":"NW""#);
        let illegal = ok_variant("b", "C", &[("B", "ob")])
            .replace(r#""commander":true"#, r#""commander":false"#);
        let file = parse(&document(&[draft, illegal]));
        assert!(file.combos.is_empty());

        let err = store(&db, &file, Some("W/\"new\""), 1_800_000_000, &mut |_, _| {}).unwrap_err();

        assert!(
            matches!(
                err,
                ComboError::Empty {
                    skipped: 2,
                    seen: 2
                }
            ),
            "{err}"
        );
        assert_eq!(err.kind(), crate::errors::Kind::Parse);

        let conn = crate::db::lock_blocking(&db);
        let kept: i64 = conn
            .query_row("SELECT count(*) FROM combos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "the seeded combo is untouched");
        // And no watermark was written, so the next run cannot 304 past this.
        assert_eq!(read_meta(&conn), None);
        // Not even a staging table was created: the refusal happens before the first one.
        let staging: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name LIKE 'combo%_staging'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(staging, 0);
    }

    /// The watermark that a later check reads: the file's own stamp, the ETag to replay, and
    /// how many variants were dropped. Both time columns are written by one ingest, because an
    /// ingest is also a check.
    #[test]
    fn an_ingest_stores_the_file_stamp_the_etag_and_the_skipped_count() {
        let db = mem_db();
        let good = ok_variant("good", "P", &[("A", "oa")]);
        let bad =
            ok_variant("bad", "P", &[("B", "ob")]).replace(r#""status":"OK""#, r#""status":"E""#);
        let file = parse(&document(&[good, bad]));

        store(&db, &file, Some("W/\"v1\""), 1_800_000_000, &mut |_, _| {}).unwrap();

        let conn = crate::db::lock_blocking(&db);
        let meta = read_meta(&conn).unwrap();
        assert_eq!(meta.etag.as_deref(), Some("W/\"v1\""));
        assert_eq!(meta.stamp.as_deref(), Some("2026-08-27T03:12:44Z"));
        assert_eq!(meta.fetched_at, Some(1_800_000_000));
        assert_eq!(meta.checked_at, Some(1_800_000_000));
        let skipped: i64 = conn
            .query_row("SELECT skipped FROM combo_meta WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(skipped, 1);
        assert!(is_populated(&conn), "and the ETag may now be replayed");
        drop(conn);

        // **A second ingest replaces the watermark rather than leaving the first standing.**
        // The row is `CHECK (id = 1)`, so every run after the first lands on a conflict — and
        // a version of this that only inserted would keep re-fetching a file it already held
        // while reporting last week's stamp, with nothing anywhere to say so.
        let later = parse(&document(&[ok_variant("other", "R", &[("C", "oc")])]));
        store(&db, &later, Some("W/\"v2\""), 1_800_000_600, &mut |_, _| {}).unwrap();

        let conn = crate::db::lock_blocking(&db);
        let meta = read_meta(&conn).unwrap();
        assert_eq!(meta.etag.as_deref(), Some("W/\"v2\""));
        assert_eq!(meta.fetched_at, Some(1_800_000_600));
        let count: i64 = conn
            .query_row("SELECT combo_count FROM combo_meta WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    /// **The stored ETag describes a file, not this database.** Replaying it over empty tables
    /// earns a 304 for a database with nothing in it, and no amount of refreshing gets past
    /// that — the rows would be gone, the watermark would insist they were current, and every
    /// weekly check from then on would agree. `tags` shipped that bug once already.
    #[test]
    fn a_stored_etag_is_only_replayed_when_there_are_rows_behind_it() {
        assert_eq!(conditional_etag(Some("W/\"v1\""), true), Some("W/\"v1\""));
        assert_eq!(
            conditional_etag(Some("W/\"v1\""), false),
            None,
            "empty tables mean a full fetch, whatever the watermark says"
        );
        assert_eq!(conditional_etag(None, true), None);
    }

    /// **A launch refreshes what this database already has, and fetches nothing it does not.**
    /// The tag files are what a deck add is categorised by, so a first run goes and gets them;
    /// combos are the fourth bracket signal and a database without them reads three. Nothing
    /// downloads until a reader presses Refresh — which is also what lets the Settings panel
    /// say "never fetched" and have it stay true.
    #[test]
    fn a_launch_refreshes_combos_it_has_and_never_fetches_them_uninvited() {
        assert!(!due_at_startup(None, 1_800_000_000), "never ingested");
        let checked_only = ComboMeta {
            etag: None,
            stamp: None,
            fetched_at: None,
            checked_at: Some(1_000),
        };
        assert!(
            !due_at_startup(Some(&checked_only), 1_800_000_000),
            "asked once, never ingested: still not a launch's to fetch"
        );

        let ingested = ComboMeta {
            etag: Some("W/\"v1\"".into()),
            stamp: None,
            fetched_at: Some(1_800_000_000),
            checked_at: Some(1_800_000_000),
        };
        assert!(!due_at_startup(Some(&ingested), 1_800_000_060), "fresh");
        assert!(
            due_at_startup(Some(&ingested), 1_800_000_000 + 7 * 86_400),
            "a week on, a database that has the file keeps it current"
        );
    }

    /// A gzipped file goes in the front of the ingest and rows come out the other end — the
    /// one test that proves the decompressor, the parse and the write are wired to each other.
    #[test]
    fn a_gzipped_file_ingests_end_to_end() {
        let db = mem_db();
        let path = gz_fixture(
            &document(&[ok_variant("z", "S", &[("A", "oa"), ("B", "ob")])]),
            "endtoend",
        );

        let done = ingest_gz(&db, &path, Some("W/\"gz\""), 1_800_000_000, &mut |_, _| {}).unwrap();

        assert_eq!(done.combos, 1);
        assert_eq!(done.cards, 2);
        let _ = std::fs::remove_file(&path);
    }

    // ---- the match --------------------------------------------------------------------

    /// **Every named card, or no answer.** A combo the deck is one card short of is not a
    /// combo the deck has, and a combo with unresolvable templates still matches on its named
    /// cards — it is reported as *possible*, which is what `templateCount` is for.
    #[test]
    fn a_combo_matches_only_when_every_card_is_present() {
        let db = mem_db();
        {
            let conn = crate::db::lock_blocking(&db);
            seed_card(&conn, "p-thassa", "o-thassa", "Thassa's Oracle");
            seed_card(&conn, "p-dc", "o-dc", "Demonic Consultation");
            seed_card(&conn, "p-kiki", "o-kiki", "Kiki-Jiki");
        }
        let both = ok_variant(
            "both",
            "R",
            &[
                ("Thassa's Oracle", "o-thassa"),
                ("Demonic Consultation", "o-dc"),
            ],
        );
        let missing = ok_variant(
            "missing",
            "P",
            &[("Thassa's Oracle", "o-thassa"), ("Not Owned", "o-nope")],
        );
        let templated = r#"{"id":"templated","status":"OK","bracketTag":"S",
            "legalities":{"commander":true},
            "uses":[{"card":{"name":"Kiki-Jiki","oracleId":"o-kiki"},"quantity":1}],
            "requires":[{"template":{"name":"a creature with a tap ability"}}],
            "produces":[{"feature":{"name":"Infinite tokens"}}]}"#;
        let file = parse(&document(&[both, missing, templated.to_owned()]));
        store(&db, &file, None, 1_800_000_000, &mut |_, _| {}).unwrap();

        let conn = crate::db::lock_blocking(&db);
        let deck = vec![
            "p-thassa".to_owned(),
            "p-dc".to_owned(),
            "p-kiki".to_owned(),
        ];
        let found = match_combos(&conn, &deck).unwrap();

        assert_eq!(
            found.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["both", "templated"],
            "the one card the deck is missing keeps `missing` out"
        );
        assert_eq!(found[0].template_count, 0);
        assert_eq!(
            found[0].cards,
            vec![
                "Thassa's Oracle".to_owned(),
                "Demonic Consultation".to_owned()
            ],
            "the names come back in the file's order"
        );
        assert_eq!(found[0].bracket_tag, "R");
        assert_eq!(found[0].produces, "Infinite mana");
        assert_eq!(
            found[1].template_count, 1,
            "a templated combo matches on its named cards and says it cannot be confirmed"
        );

        // Take one card away and the two-card combo goes with it.
        let shorter = vec!["p-thassa".to_owned(), "p-kiki".to_owned()];
        assert_eq!(
            match_combos(&conn, &shorter)
                .unwrap()
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            vec!["templated"]
        );
    }

    /// **The names come back in the file's order**, which is what the wire promises and what a
    /// reader comparing a combo against Spellbook's own page needs. `combo_cards` carries no
    /// ordinal column, so the whole of the mechanism is: insert in the order the file listed,
    /// read back by `rowid`, and let the swap's rename carry the rowids over.
    ///
    /// Three cards, deliberately in an order that is neither alphabetical nor its reverse — with
    /// two, a sort by name is indistinguishable from the file's order half the time.
    #[test]
    fn the_stored_card_names_come_back_in_the_files_order() {
        let db = mem_db();
        {
            let conn = crate::db::lock_blocking(&db);
            seed_card(&conn, "p-basalt", "o-basalt", "Basalt Monolith");
            seed_card(&conn, "p-ashnod", "o-ashnod", "Ashnod's Altar");
            seed_card(&conn, "p-curio", "o-curio", "Cloudstone Curio");
        }
        let three = ok_variant(
            "three",
            "P",
            &[
                ("Basalt Monolith", "o-basalt"),
                ("Ashnod's Altar", "o-ashnod"),
                ("Cloudstone Curio", "o-curio"),
            ],
        );
        let file = parse(&document(&[three]));
        store(&db, &file, None, 1_800_000_000, &mut |_, _| {}).unwrap();

        let conn = crate::db::lock_blocking(&db);
        let found = match_combos(
            &conn,
            &[
                "p-curio".to_owned(),
                "p-basalt".to_owned(),
                "p-ashnod".to_owned(),
            ],
        )
        .unwrap();

        assert_eq!(
            found[0].cards,
            vec![
                "Basalt Monolith".to_owned(),
                "Ashnod's Altar".to_owned(),
                "Cloudstone Curio".to_owned(),
            ],
            "the file's order, not the deck's and not the alphabet's"
        );
    }

    /// A combo that names the same card twice matches a deck holding one copy of it, which is
    /// the whole reason `card_count` is a distinct count.
    #[test]
    fn a_combo_naming_one_card_twice_matches_a_deck_holding_it_once() {
        let db = mem_db();
        {
            let conn = crate::db::lock_blocking(&db);
            seed_card(&conn, "p-kiki", "o-kiki", "Kiki-Jiki");
        }
        let twice = r#"{"id":"twice","status":"OK","bracketTag":"S","legalities":{"commander":true},
            "uses":[{"card":{"name":"Kiki-Jiki","oracleId":"o-kiki"},"quantity":1},
                    {"card":{"name":"Kiki-Jiki","oracleId":"o-kiki"},"quantity":1}],
            "requires":[],"produces":[]}"#;
        let file = parse(&document(&[twice.to_owned()]));
        store(&db, &file, None, 1_800_000_000, &mut |_, _| {}).unwrap();

        let conn = crate::db::lock_blocking(&db);
        let found = match_combos(&conn, &["p-kiki".to_owned()]).unwrap();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].cards.len(), 2, "both rows are named to the reader");
    }

    /// The bound on the list, and the two things that are not a refusal: an empty list, and a
    /// list that is long only because it repeats itself.
    #[test]
    fn the_card_list_is_capped_with_a_sentence() {
        let db = mem_db();
        let conn = crate::db::lock_blocking(&db);

        assert_eq!(match_combos(&conn, &[]).unwrap(), Vec::new());
        assert_eq!(
            match_combos(&conn, &["   ".to_owned(), String::new()]).unwrap(),
            Vec::new(),
            "blank ids are not cards"
        );

        let repeated = vec!["p-one".to_owned(); MAX_CARD_IDS + 50];
        assert!(
            match_combos(&conn, &repeated).is_ok(),
            "one card asked about many times is one card"
        );

        let too_many: Vec<String> = (0..=MAX_CARD_IDS).map(|i| format!("p{i}")).collect();
        assert_eq!(
            match_combos(&conn, &too_many),
            Err(TOO_MANY_CARDS.to_owned())
        );
    }

    /// A database that has never ingested answers `[]` rather than failing, so
    /// `DeckBracket` needs no guard around the query — only around what it *says* about the
    /// answer, which is `combosStatus`' job.
    #[test]
    fn a_database_with_no_combos_answers_an_empty_list() {
        let db = mem_db();
        let conn = crate::db::lock_blocking(&db);
        seed_card(&conn, "p-a", "o-a", "A Card");

        assert_eq!(
            match_combos(&conn, &["p-a".to_owned()]).unwrap(),
            Vec::new()
        );
    }

    // ---- status -----------------------------------------------------------------------

    /// **Never fetched is its own state**, and it is the one the settings panel has to be able
    /// to say out loud: nothing ingested is not the same as "this deck has no combos".
    #[test]
    fn a_never_ingested_database_reports_itself_as_never_and_stale() {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate_single_file(&conn).unwrap();

        assert_eq!(
            read_status(&conn, 1_800_000_000),
            ComboStatus {
                combos: 0,
                cards: 0,
                stamp: None,
                fetched_at: None,
                checked_at: None,
                stale: true,
            }
        );
    }

    /// The counts a panel draws, and the staleness rule around them. A clock that moved
    /// backwards counts as stale rather than underflowing.
    #[test]
    fn an_ingested_database_counts_combos_and_distinct_cards_and_goes_stale_after_a_week() {
        let db = mem_db();
        let shared = ok_variant("one", "C", &[("A", "oa"), ("B", "ob")]);
        let overlap = ok_variant("two", "P", &[("B", "ob"), ("C", "oc")]);
        let file = parse(&document(&[shared, overlap]));
        store(&db, &file, None, 1_800_000_000, &mut |_, _| {}).unwrap();

        let conn = crate::db::lock_blocking(&db);
        let fresh = read_status(&conn, 1_800_000_000 + 60);
        assert_eq!(fresh.combos, 2);
        assert_eq!(fresh.cards, 3, "four card rows over three distinct cards");
        assert_eq!(fresh.stamp.as_deref(), Some("2026-08-27T03:12:44Z"));
        assert_eq!(fresh.fetched_at, Some(1_800_000_000));
        assert!(!fresh.stale);

        assert!(
            read_status(&conn, 1_800_000_000 + 7 * 86_400).stale,
            "a week old is due for a refresh"
        );
        assert!(is_stale(None, 1_800_000_000), "never checked is due");
        assert!(
            is_stale(Some(1_900_000_000), 1_800_000_000),
            "a stamp in the future is due, not a throttle until the clock catches up"
        );
    }

    /// The wire shapes the frontend mirrors by hand. A field renamed on either side is a page
    /// reading `undefined`, which no type checker on either side would catch.
    #[test]
    fn the_dtos_use_the_camel_case_names_the_frontend_expects() {
        let status = serde_json::to_value(ComboStatus {
            combos: 142_318,
            cards: 61_204,
            stamp: Some("2026-08-27T03:12:44Z".into()),
            fetched_at: Some(1_800_000_000),
            checked_at: Some(1_800_000_060),
            stale: false,
        })
        .unwrap();
        assert_eq!(
            status,
            serde_json::json!({
                "combos": 142_318,
                "cards": 61_204,
                "stamp": "2026-08-27T03:12:44Z",
                "fetchedAt": 1_800_000_000i64,
                "checkedAt": 1_800_000_060i64,
                "stale": false,
            })
        );

        let combo = serde_json::to_value(DeckCombo {
            id: "1957-4050-7918--204".into(),
            bracket_tag: "R".into(),
            cards: vec!["Thassa's Oracle".into(), "Demonic Consultation".into()],
            template_count: 0,
            produces: "Win the game".into(),
            popularity: None,
        })
        .unwrap();
        assert_eq!(
            combo,
            serde_json::json!({
                "id": "1957-4050-7918--204",
                "bracketTag": "R",
                "cards": ["Thassa's Oracle", "Demonic Consultation"],
                "templateCount": 0,
                "produces": "Win the game",
                "popularity": null,
            })
        );

        let progress = serde_json::to_value(ComboProgress {
            phase: "downloading".into(),
            done: 5,
            total: 10,
        })
        .unwrap();
        assert_eq!(
            progress,
            serde_json::json!({"phase": "downloading", "done": 5, "total": 10})
        );
    }

    /// The phases and the event the frontend mirrors.
    #[test]
    fn the_progress_phases_are_the_ones_the_frontend_mirrors() {
        assert_eq!(
            PHASES,
            ["checking", "downloading", "ingesting", "done", "error"]
        );
        assert_eq!(PROGRESS_EVENT, "combos:progress");
    }

    /// One refresh at a time, and the claim clears however it ends — a latched flag would lock
    /// the reader out of refreshing until they restarted the app.
    #[test]
    fn a_second_refresh_is_refused_and_the_claim_always_clears() {
        {
            let held = RefreshGuard::claim().expect("first claim");
            assert!(RefreshGuard::claim().is_none(), "no second");
            assert!(is_refreshing());
            drop(held);
        }
        assert!(!is_refreshing());
        assert!(RefreshGuard::claim().is_some(), "and again");
    }

    // ---- the network ------------------------------------------------------------------

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mtgtest-combos-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// The download, end to end over HTTP: the body reaches disk, the ETag comes back, and
    /// progress is reported against the declared length.
    #[tokio::test]
    async fn a_fetch_writes_the_body_and_reports_the_etag() {
        let server = httpmock::MockServer::start_async().await;
        let body = "{\"variants\":[]}";
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/variants.json.gz");
                then.status(200).header("etag", "W/\"abc\"").body(body);
            })
            .await;

        let dir = scratch("fetch");
        let dest = dir.join("tmp").join("spellbook-variants.json.gz");
        let mut seen: Vec<(u64, u64)> = Vec::new();

        let got = download(
            &server.url("/variants.json.gz"),
            &dest,
            None,
            &mut |done, total| seen.push((done, total)),
        )
        .await
        .unwrap();

        assert_eq!(
            got,
            Fetch::Fetched {
                etag: Some("W/\"abc\"".to_owned())
            }
        );
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), body);
        assert_eq!(seen.first(), Some(&(0, body.len() as u64)));
        assert_eq!(seen.last(), Some(&(body.len() as u64, body.len() as u64)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **A 304 costs zero bytes and writes no file.** This is the ordinary weekly outcome once
    /// a database holds the file, and the reason the ETag is stored at all.
    #[tokio::test]
    async fn a_304_writes_nothing_and_reports_not_modified() {
        let server = httpmock::MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET)
                    .path("/variants.json.gz")
                    .header("If-None-Match", "W/\"abc\"");
                then.status(304);
            })
            .await;

        let dir = scratch("notmodified");
        let dest = dir.join("tmp").join("spellbook-variants.json.gz");

        let got = download(
            &server.url("/variants.json.gz"),
            &dest,
            Some("W/\"abc\""),
            &mut |_, _| {},
        )
        .await
        .unwrap();

        assert_eq!(got, Fetch::NotModified);
        assert!(!dest.exists(), "a 304 has no body to write");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A refusal never reaches the disk, and the status is an answer rather than a body.
    #[tokio::test]
    async fn a_refused_fetch_fails_before_anything_is_written() {
        let server = httpmock::MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/variants.json.gz");
                then.status(503).body("Service Unavailable");
            })
            .await;

        let dir = scratch("refused");
        let dest = dir.join("tmp").join("spellbook-variants.json.gz");

        let err = download(
            &server.url("/variants.json.gz"),
            &dest,
            None,
            &mut |_, _| {},
        )
        .await
        .unwrap_err();

        assert!(matches!(err, ComboError::Status { status: 503 }), "{err}");
        assert_eq!(err.kind(), crate::errors::Kind::Http);
        assert!(!dest.exists(), "nothing may be written on a refusal");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The declared half of the size guard.** A `Content-Length` past the bound is refused
    /// before a byte of body is read, so a host answering with something enormous costs this
    /// process one request and nothing else.
    #[tokio::test]
    async fn the_size_guard_refuses_a_declared_length_past_the_bound() {
        let server = httpmock::MockServer::start_async().await;
        let body = "x".repeat(4_096);
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/variants.json.gz");
                then.status(200).body(body);
            })
            .await;

        let dir = scratch("toolarge");
        let dest = dir.join("tmp").join("spellbook-variants.json.gz");
        let mut seen: Vec<(u64, u64)> = Vec::new();

        let err = download_capped(
            &server.url("/variants.json.gz"),
            &dest,
            None,
            1_024,
            &mut |done, total| seen.push((done, total)),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, ComboError::TooLarge), "{err}");
        assert_eq!(err.kind(), crate::errors::Kind::Http);
        assert!(!dest.exists(), "refused before the file was created");
        // **The declared check and not the streamed one**, which would also have answered
        // `TooLarge` over this body and left the assertions above unable to tell them apart.
        // Progress is first reported once the destination exists, so an empty log is the proof
        // that the refusal happened before a byte of body was read.
        assert!(seen.is_empty(), "{seen:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The streamed half**, which is the one that actually holds: a chunked response declares
    /// no length, so the declared check above passes it and only the running total can stop it.
    /// A hand-written server, because a well-behaved mock always declares a length and would
    /// therefore never reach this branch.
    #[tokio::test]
    async fn the_size_guard_refuses_a_chunked_body_that_runs_past_the_bound() {
        use std::io::{Read as _, Write as _};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let Ok((mut sock, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf);
            let _ = sock.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/gzip\r\n\
                  Transfer-Encoding: chunked\r\n\r\n",
            );
            // 64 KiB in 64-byte chunks, so the bound below is crossed long before the end.
            for _ in 0..1_024 {
                if sock.write_all(b"40\r\n").is_err() {
                    return;
                }
                if sock.write_all(&[b'x'; 64]).is_err() {
                    return;
                }
                if sock.write_all(b"\r\n").is_err() {
                    return;
                }
            }
            let _ = sock.write_all(b"0\r\n\r\n");
        });

        let dir = scratch("chunked");
        let dest = dir.join("tmp").join("spellbook-variants.json.gz");

        let err = download_capped(
            &format!("http://{addr}/variants.json.gz"),
            &dest,
            None,
            1_024,
            &mut |_, _| {},
        )
        .await
        .unwrap_err();

        assert!(matches!(err, ComboError::TooLarge), "{err}");
        assert!(
            !dest.exists(),
            "the partial is deleted, because there is no resume here"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    /// **The live file, end to end** — the one thing no fixture can prove.
    ///
    /// Every other test in this module runs the parse over a document written by hand. That
    /// checks the shape it was written for and nothing about what Commander Spellbook actually
    /// publishes: a key that moved, a `bracketTag` letter this build has never seen, a variant
    /// with no `oracleId` on any card. The measurements in
    /// `docs/reference/commander-brackets.md` come from this test, and it is how they are
    /// re-taken when a figure there looks wrong.
    ///
    /// `#[ignore]` because it downloads 27.5 MB and then decompresses and parses ~640 MB, which
    /// is not a per-commit cost. Run it deliberately:
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml -- --ignored combos::tests::live_ingest --nocapture
    /// ```
    #[test]
    #[ignore]
    fn live_ingest() {
        let dir = scratch("live");
        let gz = dir.join("tmp").join("spellbook-variants.json.gz");
        std::fs::create_dir_all(gz.parent().unwrap()).unwrap();

        let started = std::time::Instant::now();
        let fetched = tauri::async_runtime::block_on(download_capped(
            FEED_URL,
            &gz,
            None,
            MAX_FEED_BYTES,
            &mut |_, _| {},
        ))
        .expect("the feed answered");
        assert!(matches!(fetched, Fetch::Fetched { .. }), "{fetched:?}");
        let on_disk = std::fs::metadata(&gz).unwrap().len();
        println!("downloaded {on_disk} bytes in {:?}", started.elapsed());

        // A **file** database rather than an in-memory one, because one of the figures this
        // test exists to take is what the feed costs a reader on disk.
        let db_path = dir.join("combos.db");
        let db = Mutex::new(Connection::open(&db_path).unwrap());
        crate::schema::migrate_single_file(&db.lock().unwrap()).unwrap();

        let parsing = std::time::Instant::now();
        let ingested =
            ingest_gz(&db, &gz, Some("live"), 1_800_000_000, &mut |_, _| {}).expect("it ingested");
        println!(
            "kept {} combos over {} card rows, skipped {} of {} seen, in {:?}",
            ingested.combos,
            ingested.cards,
            ingested.skipped,
            ingested.seen,
            parsing.elapsed()
        );

        let conn = db.lock().unwrap();
        // The distribution, which is what tells a plausible ingest from one that filed every
        // combo under a single letter because a key moved.
        let rows: Vec<(String, i64)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT bracket_tag, count(*) FROM combos GROUP BY bracket_tag ORDER BY 2 DESC",
                )
                .unwrap();
            let out = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            out
        };
        println!("bracket tags: {rows:?}");

        let two_card: i64 = conn
            .query_row(
                "SELECT count(*) FROM combos WHERE card_count = 2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let templated: i64 = conn
            .query_row(
                "SELECT count(*) FROM combos WHERE template_count > 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let status = read_status(&conn, 1_800_000_000);
        println!(
            "two-card {two_card}, templated {templated}, status {} combos / {} cards",
            status.combos, status.cards
        );

        // **Nothing here pins a figure.** The file rotates through the day, so a test asserting
        // today's count would go red on a morning when nothing was wrong. What it asserts is
        // that the *shape* survived contact: a real corpus, more than one bracket letter, and
        // both of the kinds of combo the estimator sorts on.
        assert!(ingested.combos > 10_000, "only {} combos", ingested.combos);
        assert!(
            rows.len() >= 5,
            "only {} distinct bracket tags: {rows:?}",
            rows.len()
        );
        assert!(two_card > 0, "no two-card combos at all");
        assert!(templated > 0, "no templated combos at all");
        assert!(status.cards > 0 && status.cards < status.combos * 4);

        // **The hot path, at full corpus size.** `combos_for_cards` runs on every deck edit,
        // so the number that matters is not the ingest above but this: a hundred oracle ids
        // against 105 k combos and 374 k card rows. The `cards` rows are invented here — the
        // query resolves printing ids through that table and an in-memory database has none —
        // which is legitimate only because this database is a throwaway.
        let ids: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT DISTINCT oracle_id FROM combo_cards LIMIT 100")
                .unwrap();
            let out = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            out
        };
        let card_ids: Vec<String> = ids
            .iter()
            .enumerate()
            .map(|(i, oracle)| {
                let id = format!("printing-{i}");
                conn.execute(
                    "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang,
                                          layout, raw)
                       VALUES (?1, ?2, ?1, 'tst', ?1, 'en', 'normal', '{}')",
                    rusqlite::params![id, oracle],
                )
                .unwrap();
                id
            })
            .collect();

        let matching = std::time::Instant::now();
        let found = match_combos(&conn, &card_ids).expect("the match ran");
        println!(
            "matched {} combos from {} cards in {:?}",
            found.len(),
            card_ids.len(),
            matching.elapsed()
        );

        drop(conn);
        println!(
            "database {} bytes",
            std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Many distinct variants, built from the module's own helpers.
    fn many_variants(n: usize) -> String {
        let vs: Vec<String> = (0..n)
            .map(|i| {
                ok_variant(
                    &format!("v{i}"),
                    "R",
                    &[("Card A", &format!("o{i}a")), ("Card B", &format!("o{i}b"))],
                )
            })
            .collect();
        document(&vs)
    }

    /// The stream path must reduce a document to exactly what the file path does.
    #[test]
    fn read_stream_matches_read_file() {
        let doc = many_variants(120);
        let bytes = doc.clone().into_bytes();

        let from_file = parse(&doc);
        let chunks = bytes.chunks(97).map(|c| Ok(c.to_vec())).collect::<Vec<_>>();
        let from_stream = read_stream(chunks.into_iter()).unwrap();

        assert_eq!(from_file.seen, from_stream.seen);
        assert_eq!(from_file.skipped, from_stream.skipped);
        assert_eq!(from_file.combos.len(), from_stream.combos.len());
        // `stamp` is Option<String>; both paths must find the document's own timestamp.
        assert_eq!(from_file.stamp, from_stream.stamp);
        assert_eq!(from_stream.stamp.as_deref(), Some("2026-08-27T03:12:44Z"));
        for (a, b) in from_file.combos.iter().zip(from_stream.combos.iter()) {
            assert_eq!(a.id, b.id);
            assert_eq!(a.bracket_tag, b.bracket_tag);
            assert_eq!(a.card_count, b.card_count);
        }
    }

    /// The browser case: already-decompressed bytes must ingest like gzipped ones.
    #[test]
    fn read_stream_accepts_plain_and_gzipped_alike() {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write as _;

        let doc = many_variants(40);
        let plain = doc.into_bytes();
        let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
        enc.write_all(&plain).unwrap();
        let gz = enc.finish().unwrap();

        let a = read_stream(plain.chunks(64).map(|c| Ok(c.to_vec()))).unwrap();
        let b = read_stream(gz.chunks(64).map(|c| Ok(c.to_vec()))).unwrap();
        assert_eq!(a.combos.len(), b.combos.len());
        assert_eq!(a.seen, b.seen);
        assert_eq!(a.stamp, b.stamp);
        assert!(a.seen > 0, "the fixture must actually contain variants");
    }
}
