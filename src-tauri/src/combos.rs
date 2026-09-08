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
//! * **Nothing here may break a launch.** A database that has never fetched this file is still a
//!   supported state — every command answers it and the bracket estimate simply reads three
//!   signals instead of four — but it is no longer a state a launch leaves alone.
//!   [`refresh_if_due`] goes and gets the file uninvited, on the same weekly schedule and for
//!   the same reason `tags::{oracle,art}::refresh_if_due` do; a failure there is silent, leaves
//!   whatever combos were already stored, and is retried at the next launch.
//! * **Everything is `Option` on the way in and nothing is `deny_unknown_fields`.** This is
//!   somebody else's catalogue, it grows keys without notice, and a variant missing a field is a
//!   variant to skip rather than a reason to abandon the rest.
//!
//! # What survives the reduction
//!
//! Per variant: its id, its `bracketTag`, its colour identity, its popularity, how many
//! `requires[]` templates it also needs, its `produces[]` feature names joined with `\n`, and
//! **four prose fields** — `description`, `easyPrerequisites`, `notablePrerequisites` and
//! `manaNeeded`. Per `uses[]` entry: an oracle id, a name, a quantity and whether the card must
//! be the commander. Everything else is read and dropped.
//!
//! **The four prose fields are stored for [`card_combos`] and for nothing else.** The bracket
//! estimate never reads them and [`match_combos`] does not select them: they are what a reader
//! looking at *one card's* combos needs in order to be told how the combo is actually played,
//! and a panel that could only say "Infinite mana" over two card names is a panel that sends
//! them to Spellbook's website to find out how. `description` is the numbered steps,
//! `\n`-separated; the other three are one line each. **All four are commonly `""` in the file
//! itself** — Spellbook writes an empty string rather than null — so `""` is a *value* here and
//! never a reason to skip a variant.
//!
//! **Deliberately not stored**, though the wire carries them: `notes` (Spellbook's editorial
//! remarks to itself), `manaValueNeeded` (derivable from `manaNeeded` and read by nothing),
//! `of` / `includes` / `variantCount` (the feed's own graph of which variants generalise which,
//! which this app draws no conclusion from), `spoiler`, `prices` (this app has two price feeds
//! of its own and neither is Spellbook's), and the per-`uses` `zoneLocations` and `*CardState`
//! strings — "on the battlefield, tapped" is a fact about *playing* the combo that the
//! description already spells out in prose.

use crate::sync::AppState;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::Path;
#[cfg(not(target_family = "wasm"))]
use std::path::PathBuf;
#[cfg(not(target_family = "wasm"))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
#[cfg(not(target_family = "wasm"))]
use std::sync::{Arc, OnceLock};
// `SystemTime::now()` **panics** on `wasm32-unknown-unknown`. Gating the import rather
// than only its callers is the fence: on the web target the name is not in scope, so a
// clock cannot be reached for by accident from a module the map says compiles there.
#[cfg(not(target_family = "wasm"))]
use std::time::{Duration, SystemTime, UNIX_EPOCH};
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// The longest gap between two chunks of the body before the connection is called dead.
/// Deliberately *not* an overall timeout: 27.5 MB legitimately runs for a minute on a slow
/// line, and a `timeout()` would kill it partway every time — [`crate::scryfall`]'s rule.
#[cfg(not(target_family = "wasm"))]
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Rows per transaction on the way into staging.
///
/// The write is chunked for [`crate::tags::ingest_gz`]'s reason and not
/// [`crate::marketplace_feed::store`]'s: these rows go to tables no reader can see, so a commit
/// partway costs nobody a half-swapped view, and `db` is the shared write connection — holding
/// it for the length of the insert is what turns a reader's edit into a frozen button.
const BATCH: usize = 2_000;

/// Let a waiting writer see the connection is free. **Call it with no guard in scope.**
#[cfg(not(target_family = "wasm"))]
const YIELD_BETWEEN_BATCHES: Duration = Duration::from_millis(5);

#[cfg(not(target_family = "wasm"))]
fn stand_aside() {
    std::thread::sleep(YIELD_BETWEEN_BATCHES);
}

/// **Nothing to stand aside for.** The web target runs the whole database in one dedicated
/// Worker, so there is no second thread that could be holding a button down waiting for this
/// connection — and `std::thread::sleep` has no meaning on `wasm32-unknown-unknown` anyway.
/// [`store`] goes on calling this every batch, so the batching itself is one code path on
/// both targets and only the pause between batches differs.
#[cfg(target_family = "wasm")]
fn stand_aside() {}

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

/// One `variants[]` entry, narrowed to the thirteen keys that matter.
///
/// `#[serde(rename_all = "camelCase")]` because the file is camelCase throughout —
/// `bracketTag`, `oracleId`, `mustBeCommander`. Every field is `Option` or defaulted and none
/// of the structs here is `deny_unknown_fields`: see the module header.
///
/// **The four prose fields are `Option<String>` on the way in and `String` on the way out**,
/// which is this module's rule read against a field the file writes as `""` rather than as
/// null. `None` (the key is absent) and `Some("")` (the key is there and empty) are two
/// different documents and exactly one storable answer — [`reduce`] flattens both to `""`,
/// because "the combo has no stated mana cost" is what each of them means and a panel with two
/// spellings of *nothing* is a panel with two empty states.
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
    /// The numbered steps, `\n`-separated. Read the module header for why this and the three
    /// below are the only prose the reduction keeps.
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    easy_prerequisites: Option<String>,
    #[serde(default)]
    notable_prerequisites: Option<String>,
    /// What the combo costs to run, in Scryfall's mana-symbol spelling — `{6}`, `{2}{U}`.
    #[serde(default)]
    mana_needed: Option<String>,
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
    /// How the combo is actually played: the numbered steps, `\n`-separated.
    ///
    /// **`""` is a value and not a skip reason**, for all four of these. The file writes an
    /// empty string where a variant has no prose, so a missing description is the ordinary
    /// state of thousands of published combos and refusing one would throw away a combo whose
    /// *cards* are perfectly storable.
    pub description: String,
    /// Setup the combo needs that any deck can arrange — "all permanents are untapped".
    pub easy_prerequisites: String,
    /// Setup worth calling out — "you have infinite mana available".
    pub notable_prerequisites: String,
    /// What it costs to run, the feed's own mana-symbol spelling: `{6}`.
    pub mana_needed: String,
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
        // **Verbatim, and untrimmed.** These are the only fields here whose *formatting* is
        // part of the value: `description`'s newlines are the numbered steps, and a trim would
        // be this crate concluding something about prose it is only carrying. `unwrap_or_default`
        // is what collapses an absent key and an empty string into the one storable answer —
        // see [`RawVariant`]. **None of the four may ever return `None` from this function**: a
        // combo with no prose is a combo, and skipping it would take its cards with it.
        description: raw.description.unwrap_or_default(),
        easy_prerequisites: raw.easy_prerequisites.unwrap_or_default(),
        notable_prerequisites: raw.notable_prerequisites.unwrap_or_default(),
        mana_needed: raw.mana_needed.unwrap_or_default(),
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

/// Reading the `variants` array as an object the caller pushes into.
///
/// [`read_stream`]'s `Iterator` is the desktop shape; this is the shape a browser can
/// drive, for [`crate::ingest::StreamIngest`]'s reason — an awaited `Stream` has no
/// blocking `next()` to hand an iterator.
///
/// Peak memory is one element plus the reduced list, and [`StreamRead::peak_buffer`] is how
/// a caller checks that claim. That is not diagnostics: the spike's first framer found
/// **63 elements in 610 MB** and grew its buffer to 609.82 MB without erroring, and a row
/// count cannot see that.
pub struct StreamRead {
    file: ComboFile,
    decoder: crate::feed::frame::Decoder,
    elements: crate::feed::frame::Elements,
    decoded: Vec<u8>,
    /// The document's own `timestamp` sits before `variants`, so it is scraped from the
    /// head rather than parsed structurally - the framer deliberately does not model the
    /// enclosing object.
    head: Vec<u8>,
}

impl StreamRead {
    pub fn new() -> Self {
        StreamRead {
            file: ComboFile::default(),
            decoder: crate::feed::frame::Decoder::new(),
            elements: crate::feed::frame::Elements::new(),
            decoded: Vec::new(),
            head: Vec::new(),
        }
    }

    /// The largest the element framer's buffer has ever been, in bytes.
    ///
    /// Measured at **2.01 MB against the real 610.2 MB document**, on both a desktop and a
    /// OnePlus 12. Anything approaching the document's own size means the framer has
    /// desynchronised and is silently accumulating rather than draining.
    pub fn peak_buffer(&self) -> usize {
        self.elements.peak_buffer()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<(), ComboError> {
        self.decoded.clear();
        self.decoder.push(chunk, &mut self.decoded)?;
        crate::feed::frame::take_head(&mut self.head, &self.decoded);
        let file = &mut self.file;
        // The framer's own refusal, lifted through `io::Error` into the `Io` variant this
        // enum already has: a buffer past `feed::frame::MAX_ELEMENT_BYTES` is the
        // desynchronisation `peak_buffer` can only report on afterwards.
        self.elements
            .push(&self.decoded, |el| take_element(file, el))
            .map_err(std::io::Error::from)?;
        Ok(())
    }

    pub fn finish(mut self) -> Result<ComboFile, ComboError> {
        self.decoded.clear();
        self.decoder.finish(&mut self.decoded)?;
        crate::feed::frame::take_head(&mut self.head, &self.decoded);
        {
            let file = &mut self.file;
            self.elements
                .push(&self.decoded, |el| take_element(file, el))
                .map_err(std::io::Error::from)?;
        }
        self.file.stamp = stamp_from_head(&self.head);
        Ok(self.file)
    }
}

impl Default for StreamRead {
    fn default() -> Self {
        Self::new()
    }
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
    let mut sink = StreamRead::new();
    for chunk in chunks {
        sink.push(&chunk?)?;
    }
    sink.finish()
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

/// Pull the document's `"timestamp"` out of its first bytes.
///
/// A scrape and not a parse, because the enclosing object is never modelled: the framer
/// starts at the first `[`. `None` for a document that omits the key, which is what
/// [`read_file`] also produces - `ComboFile::stamp` is `Option<String>` precisely because
/// a file without one is a real state rather than an error.
///
/// **The scraper itself lives in [`crate::feed::frame`]**, because `marketplace_feed` wants
/// exactly this for Card Kingdom's `meta.created_at` and two copies of a five-line parser
/// are two chances to fix one of them.
fn stamp_from_head(head: &[u8]) -> Option<String> {
    crate::feed::frame::scrape_string(head, "timestamp")
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
            // **Every column named, and that is the whole of the defence.** The four prose
            // columns were added to `combos` and `combos_staging` after this statement was
            // first written, and `INSERT INTO t VALUES (…)` binds by *position* — so a column
            // list is what makes the schema's order and this statement's order two separate
            // facts rather than one silent dependency. `TEXT NOT NULL DEFAULT ''` on the
            // schema side and a named column here means a rung that inserts one of them
            // somewhere else in the table cannot quietly file a description under `identity`.
            let mut combo = tx.prepare_cached(
                "INSERT INTO combos_staging
                    (id, bracket_tag, card_count, template_count, identity, produces,
                     popularity, description, easy_prerequisites, notable_prerequisites,
                     mana_needed)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
                    c.popularity,
                    c.description,
                    c.easy_prerequisites,
                    c.notable_prerequisites,
                    c.mana_needed
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

/// Throw away every combo this database holds, watermark included.
///
/// **The `combo_meta` row is deleted rather than blanked.** No row is the never-ingested state
/// this whole module is already written against, and it is the state every reader of that table
/// already handles: [`read_status`] answers it with two zeros, three nulls and `stale: true`,
/// [`due_at_startup`] reads it as due, and [`mark_checked`] deliberately writes nothing over it.
/// A row with its columns nulled would be a fourth state, indistinguishable at a glance from the
/// three and handled by none of them.
///
/// **`combo_cards` is emptied by its own statement even though `combo_id` CASCADEs**, and the
/// child goes first. `PRAGMA foreign_keys` is per-connection and nothing about this signature
/// says who set it on the connection handed in — so leaning on the cascade would be a clear that
/// works or leaves a table of orphans depending on a setting made somewhere else entirely.
/// Spelled this way the order is right whichever way that pragma happens to be.
///
/// One transaction, because a clear that emptied `combos` and then failed would leave a
/// watermark describing rows that are gone. That is precisely the state [`conditional_etag`]
/// exists to survive, and there is no reason to manufacture it here.
///
/// **What makes the clear honest is [`conditional_etag`], not this function.** The stored ETag
/// is gone with the row, but even if it were not, that helper asks whether there are *rows*
/// before replaying one — so a cleared database really re-downloads rather than being told 304
/// into staying empty. The caller is expected to follow this with a forced refresh.
///
/// Takes a `&Connection` and not an [`AppState`], so the rule can be asserted against
/// [`crate::schema::memory_pair`] with no app handle — the split every other helper here uses.
pub fn clear_combos(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM combo_cards", [])?;
    tx.execute("DELETE FROM combos", [])?;
    tx.execute("DELETE FROM combo_meta", [])?;
    tx.commit()
}

/// Clear the combos and answer what is left, on a connection the caller already holds.
///
/// **The shape both targets call**, so neither holds a second copy of what "clear the combos"
/// means: `web::route` hands it to `crate::sync::with_write`, and [`combos_clear`] runs it on
/// the blocking pool under the same lock. The work is [`clear_combos`] above; what this adds is
/// the answer.
///
/// It answers a [`ComboStatus`] rather than nothing because the page that pressed this would
/// otherwise have to ask a second time to learn what it did — and the answer is always
/// [`status_of`]'s never-ingested one: two zeros, three nulls and `stale: true`.
///
/// **Its clock comes off the connection**, [`status_of`]'s reason exactly: `SystemTime::now()`
/// *panics* on `wasm32-unknown-unknown` rather than failing, and this function is on the
/// Worker's path.
pub fn clear(conn: &Connection) -> Result<ComboStatus, String> {
    clear_combos(conn).map_err(|e| format!("could not clear the combos: {e}"))?;
    let now = conn
        .query_row("SELECT unixepoch()", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0);
    Ok(read_status(conn, now))
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
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
pub async fn download(
    url: &str,
    dest: &Path,
    if_none_match: Option<&str>,
    progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<Fetch, ComboError> {
    download_capped(url, dest, if_none_match, MAX_FEED_BYTES, progress).await
}

/// [`download`] with the bound handed in, which is the seam the size-guard tests drive.
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
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

/// **Ungated, and its clock comes off the connection.** `web::route` answers `combos_status`
/// with this, and `SystemTime::now()` — which [`unix_now`] below uses — *panics* on
/// `wasm32-unknown-unknown` rather than failing, so calling that here would take the Worker
/// down instead of returning an error. `crate::tags::now_from` reached the same conclusion on
/// the same day, for the same command shape.
pub(crate) fn status_of(state: &AppState) -> ComboStatus {
    let conn = crate::sync::lock_db_read(state);
    let now = conn
        .query_row("SELECT unixepoch()", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0);
    read_status(&conn, now)
}

/// Seconds since the Unix epoch. A clock before 1970 reads as 0, which makes the combo
/// database stale — [`crate::sync`]'s choice, for its reason.
#[cfg(not(target_family = "wasm"))]
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
// One card's combos
// ---------------------------------------------------------------------------------------

/// The largest page [`card_combos`] will hand back, however much was asked for.
///
/// **A ceiling on one answer, not a ceiling on the question** — [`CardCombosPage::total`] says
/// how many there really are and the caller pages through them. 100 because the dialog asks for
/// 25 and a bound that is not comfortably above what the only caller wants is a bound that will
/// be raised by the next feature rather than thought about; and because the expensive part of
/// this call is the two passes over the hit set rather than the page, so a page four times too
/// big costs a fraction of what the counts already cost. The worst card in the catalogue —
/// Ashnod's Altar, 6 044 combos — is 61 pages of 100 and 242 of 25.
pub const MAX_PAGE: i64 = 100;

/// One card a combo names, with everything a panel needs to draw it.
///
/// Serialised `camelCase` to the shape `src/lib/ipc.ts` mirrors by hand.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComboPiece {
    pub oracle_id: String,
    /// **`combo_cards.name` — the feed's spelling, and deliberately not the corpus's.** A
    /// combo can name a card this database has never synced (a brand-new set, a
    /// language-limited corpus, a card Scryfall renamed), and the row that answers *which* card
    /// has to stay readable when the id stops resolving. That is the same argument every user
    /// table in this schema makes for denormalising a printing's name.
    pub name: String,
    pub quantity: i64,
    pub must_be_commander: bool,
    /// The printing this app draws the card as: **[`crate::deck_tokens`]' tie-break, verbatim.**
    ///
    /// `None` when no `cards` row carries this oracle id, which is a supported state and not an
    /// error — see [`Self::name`]. A piece in that state still carries its name, its quantity
    /// and its [`owned`](Self::owned) count, because none of those came from `cards`.
    pub card_id: Option<String>,
    /// The front face's picture for that printing, per variant. `None` alongside a `None`
    /// [`card_id`](Self::card_id), and also for a printing the corpus has no fetchable image
    /// for — [`crate::image_uri::front_face_map`]'s rule, not one respelled here.
    pub image_uris: Option<BTreeMap<String, String>>,
    /// Copies of this card the reader owns, across **every printing and every finish**.
    ///
    /// `0` is an answer rather than a gap: this panel exists to tell a reader which of a
    /// combo's pieces they are missing, and a blank where the zero belongs is the same
    /// rendering as "we did not look".
    pub owned: i64,
}

/// One combo that names the card being asked about.
///
/// **Not [`DeckCombo`], and the difference is the question.** That one answers *which combos
/// does this deck completely hold* and carries the card **names** because that is all a
/// one-line bracket advisory needs. This answers *which combos name this card at all*, makes
/// no claim about the other pieces, and therefore has to say what each of them is and whether
/// the reader has it.
///
/// Serialised `camelCase` to the shape `src/lib/ipc.ts` mirrors by hand.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardCombo {
    pub id: String,
    /// One of [`BRACKET_TAGS`].
    pub bracket_tag: String,
    /// Distinct oracle ids the combo names — the same stored count the size filter matches on.
    pub card_count: i64,
    /// Templates it also needs ("a creature with flying"), which this app cannot resolve to a
    /// card and therefore never counts as held. `0` is a combo whose every piece is nameable.
    pub template_count: i64,
    pub identity: String,
    /// What it does — feature names, one per line.
    pub produces: String,
    /// How it is played — the numbered steps, `\n`-separated. `""` where the feed carries none.
    pub description: String,
    /// `""` where the feed carries none, which is the common case for all three of these.
    pub easy_prerequisites: String,
    pub notable_prerequisites: String,
    /// What it costs to run, the feed's mana-symbol spelling. `""` where the feed carries none.
    pub mana_needed: String,
    pub popularity: Option<i64>,
    /// Every card the combo names, **in the feed's order** — `combo_cards` rowid order, which
    /// is what [`match_combos`] reads its names in and what a reader comparing this against
    /// Spellbook's own page needs.
    pub pieces: Vec<ComboPiece>,
}

/// How many of this card's combos need exactly `cards` cards.
///
/// **Over the searched set and over neither facet**, so the size chips can say what each one
/// would show without a round trip per chip — and so a chip whose count is zero can be left off
/// the row entirely rather than offered and then answering nothing. It read *unfiltered* until
/// the search box landed, and the difference is [`CardCombosPage`]'s subject-versus-facet rule:
/// a chip counted over a set the search has already left behind offers a number pressing it
/// cannot produce.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComboCountBucket {
    pub cards: i64,
    pub combos: i64,
}

/// One page of one card's combos, with the three counts the panel's chrome is drawn from.
///
/// **Three counts and not one, because they answer three questions and a panel that conflated
/// any two of them would lie about the other.** `total` is what the card is *in*; `matching` is
/// what the narrowings left; `owned_total` is how many of the set the reader could actually
/// assemble today — which is the number the "you own every piece of N of these" line is drawn
/// from, and it deliberately ignores the **size** filter so that narrowing to two-card combos
/// does not make that line change its meaning underneath the reader.
///
/// **The search is not one of those filters, and that is why it moves three of these four
/// numbers where the size chip moves one.** A needle is the reader changing the *subject* —
/// "only the combos with Thassa's Oracle in them" — and the chips and the owned toggle are
/// facets *of* a subject; a facet has to count what pressing it would yield. So `by_card_count`
/// and `owned_total` are taken over the searched set, and `total` alone stays the card's own
/// census, because "this card is in 6 044 combos" is a fact the search does not touch and the
/// one thing the panel can still say over a list of four. [`card_combos`] has the table.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardCombosPage {
    /// Combos naming this oracle card. **No filters and no search** — the only number here
    /// a needle leaves alone.
    pub total: i64,
    /// After the search **and** `card_count` **and** `owned_only`.
    pub matching: i64,
    /// Of the **searched** set, those the reader owns every piece of — **no size filter**.
    pub owned_total: i64,
    /// Over the searched set, ascending, and only the sizes that occur.
    pub by_card_count: Vec<ComboCountBucket>,
    /// This page, `limit` long at most.
    pub combos: Vec<CardCombo>,
}

/// Every combo naming one oracle card, once each.
///
/// **Start from `combo_cards`, never from `combos`** — [`MATCH_SQL`]'s rule read the other way
/// round, and its reason: `idx_combo_cards_oracle` turns one oracle id into a point lookup,
/// where asking `combos` "does this one name the card" is a scan of the whole catalogue every
/// time the dialog opens.
///
/// **`DISTINCT`, and it costs about 3 ms of the 6 044 rows Ashnod's Altar produces.** A combo
/// may name the same card twice — a copy in the command zone and one in the library — so
/// without it that combo would be counted twice by the histogram and listed twice on the page.
/// Only the histogram's `GROUP BY` would have collapsed it anyway; spending the three
/// milliseconds is what keeps *one* definition of the hit set instead of one that is safe here
/// and a trap one statement over.
///
/// **This is the card's own census and nothing narrows it** — [`SEL_CTE`] is where a search
/// lands, and [`total_sql`] is the one statement that still counts *this*. Keeping the two
/// apart is what lets [`CardCombosPage::total`] go on answering "this card is in 6 044 combos"
/// while every other number on the page describes what the reader asked for.
///
/// **`?1` and not a bare `?`**, since [`SEL_CTE`] introduced a second parameter that has to
/// keep one index across four composed statements — see [`page_sql`].
const HIT_CTE: &str =
    "hit(combo_id) AS (SELECT DISTINCT combo_id FROM combo_cards WHERE oracle_id = ?1)";

/// The hit set narrowed by the reader's search: **the one place "which combos are we talking
/// about" is decided**, and what [`GRP_CTE`], [`counts_sql`] and [`page_sql`] all read.
///
/// A sibling of [`HIT_CTE`] rather than a clause inside it, because those two are different
/// questions and exactly one of them may narrow: `hit` is the card's census and `sel` is the
/// subject. Bolting the predicate onto the three statements separately was the other option
/// and is how a histogram, a page and an owned count come to disagree about a set nobody
/// changed.
///
/// # Any piece's name, the asked-about card included
///
/// The `EXISTS` walks **every** `combo_cards` row of the combo, so typing the asked-about
/// card's own name matches all of its combos. That is the rule that needs no explaining in the
/// UI: a reader looking at Ashnod's Altar and typing "ashnod" is not shown an empty list.
///
/// # `instr`, and why the wildcards cannot come off the wire
///
/// **`instr(lower(name), lower(?2)) > 0` rather than `LIKE`, and the reason is the fence rather
/// than the speed.** A `LIKE` needle has three metacharacters to neutralise — `%`, `_` and
/// whatever `ESCAPE` character is chosen to neutralise them — and getting that wrong is
/// *silent*: a reader typing `%` would match every combo and a reader typing `_` would match
/// every one-character difference, with nothing anywhere to say the search had stopped meaning
/// what they typed. `instr` has no pattern language at all, so there is nothing to escape and
/// no escaping to get wrong. This is `{holes}`' rule in [`pieces_sql`] read one layer up: the
/// safety comes from the shape of the statement, never from a sanitiser.
///
/// It costs nothing to prefer it. `LIKE '%x%'` cannot use an index either — the search is a
/// scan of the hit set's names whichever operator spells it — and SQLite's built-in `LIKE` is
/// ASCII-only for case folding, exactly as `lower()` is.
///
/// **Both sides are folded by the *same* function**, which is why the needle is lowered in SQL
/// and not in Rust: `str::to_lowercase` is Unicode-aware and SQLite's `lower()` is ASCII-only,
/// so folding the needle in Rust would make `Æ` and `æ` two different searches over a column
/// that holds neither folded. Measured at no cost — 58.3 ms against 59.2 ms for a needle
/// pre-lowered in Rust, median of 15 over the real corpus.
///
/// # `?2 = ''` is *no search*
///
/// [`card_combos`] trims the needle and binds `''` for `None`, for a blank and for a string
/// that trims to one, so those three cases are one bound value and one code path rather than
/// three. The comparison short-circuits the `EXISTS` for every combo, which is what keeps an
/// unsearched read at the cost it had before this constant existed: [`counts_sql`] for Ashnod's
/// Altar measures **59.2 ms with `sel` in it and 59.0 ms without**, the two statements
/// interleaved in one run, median of 15.
const SEL_CTE: &str = "sel(combo_id) AS (
        SELECT h.combo_id
          FROM hit h
         WHERE ?2 = ''
            OR EXISTS (SELECT 1 FROM combo_cards s
                        WHERE s.combo_id = h.combo_id
                          AND instr(lower(s.name), lower(?2)) > 0))";

/// Which oracle cards the reader owns at least one copy of.
///
/// **The set form of [`crate::collection_source::copies_of_oracle`] under
/// [`Availability::Everything`](crate::collection_source::Availability::Everything)**, and it
/// is a fourth statement naming `collection_entries` by hand — the three that module's header
/// lists, plus this. It earns that the way they do, by asking a question no fragment there
/// answers: not *how many copies of this card*, correlated per row, but *the whole set of
/// cards the reader owns any of*, materialised once. The naive shape is the fragment in a
/// `NOT EXISTS` per candidate combo — ~21 000 correlated probes for the worst card, measured
/// at 1.3–2.5 s where this is 7 ms.
///
/// **`CROSS JOIN` rather than `JOIN`, and it is worth 65 ms.** Written as a plain join, SQLite
/// drove it from `cards` — a full scan of `idx_cards_collapse`, 117 606 rows, probing
/// `collection_entries` for each — and took 72.7 ms against a 276-row collection. `CROSS JOIN`
/// is SQLite's documented way to pin the outer loop, and pinning it to the *small* table takes
/// the same answer to 7.1 ms.
///
/// **`k.oracle_id IS NOT NULL` is a correctness fence and not tidiness.** The column is
/// nullable; one NULL in this set makes `p.oracle_id IN (SELECT …)` return NULL for every
/// unowned piece, and SQLite's `min()` *skips* NULLs — so a combo with one owned piece and one
/// unowned would answer `all_owned = 1`, reporting a combo the reader cannot assemble as one
/// they can. It is the empty-set trap this repo has already paid for once, one operator over.
///
/// **`e.quantity > 0` is redundant against a healthy database and is here anyway**, which is the
/// one guard in this statement that is *not* load-bearing today. A collection row cannot hold
/// zero copies: `set_quantity(id, 0)` deletes the row, the user ladder's v24 rung deleted every
/// stored zero, and the importer's `set` mode does the same — so `EXISTS` and `sum(quantity) > 0`
/// are the same question, which is exactly why `collection_source::owns_printing` is allowed to
/// be an `EXISTS` at all (`collection-folders.md`, *Zero quantity deletes the row*).
///
/// It is here because of what the *disagreement* looks like if that invariant is ever broken
/// somewhere else. `ComboPiece::owned` is `copies_of_oracle`, which sums; this decides the
/// `all_owned` the filter reads. Without the clause those two answer differently for a zero row,
/// and the panel prints *Not owned* on a piece line inside a combo it is simultaneously offering
/// under **I own every piece** — one screen contradicting itself about one card, with no error
/// anywhere. The Storybook fake reached that state on the first try, off a fixture written before
/// the zero-row rule changed. A guard that costs nothing on 276 rows is cheaper than an invariant
/// two modules have to keep agreeing about.
const OWNED_CTE: &str = "owned(oracle_id) AS (
        SELECT DISTINCT k.oracle_id
          FROM collection_entries e CROSS JOIN cards k ON k.id = e.card_id
         WHERE k.oracle_id IS NOT NULL AND e.quantity > 0)";

/// One row per **searched** combo, saying whether the reader owns **every** card it names.
///
/// `min()` over a 0/1 per piece is *all of them*, in one pass over the subject's cards, where
/// a `NOT EXISTS` per combo is a correlated probe per candidate. Requires [`OWNED_CTE`]'s
/// NULL fence to mean what it says — see there.
///
/// **It joins [`SEL_CTE`] and not [`HIT_CTE`], which is what makes `owned_total` narrow with
/// the search.** That is the design decision this whole shape turns on: the owned toggle and
/// the size chips are *facets of a subject*, and a facet's count has to predict what pressing
/// it yields — so once a reader has typed, "you own every piece of N of these" has to be N of
/// the ones they can see. `total` is the one number that stays put, because it answers a
/// different question that the search does not change.
///
/// **Ownership here is presence and not quantity**, which is [`match_combos`]' rule: that one
/// asks whether a deck *lists* each named card and never how many copies, and a combo needing
/// two Altars is not a combo the reader half-owns. `ComboPiece::owned` carries the count for a
/// reader who wants to judge that themselves.
const GRP_CTE: &str = "grp(combo_id, all_owned) AS (
        SELECT p.combo_id, min(p.oracle_id IN (SELECT oracle_id FROM owned))
          FROM combo_cards p JOIN sel h ON h.combo_id = p.combo_id
         GROUP BY p.combo_id)";

/// How many combos name this card at all — [`CardCombosPage::total`], and nothing else.
///
/// **A statement of its own, because it is the one number the search does not narrow.** It
/// used to be the sum of [`counts_sql`]'s rows, which was free while the histogram was over
/// the whole hit set; now that the histogram describes the *searched* set, a sum over it
/// answers a different question, and a search that matched nothing would have no rows to sum
/// at all — the case where the panel most needs to be able to say "this card is in 6 044
/// combos, none of them matching".
///
/// **It counts [`HIT_CTE`] rather than re-spelling it**, so "combos naming this card" is
/// written down once and this is literally the size of that set. A hand-typed
/// `count(DISTINCT combo_id) …` beside it would be a second definition to keep in step.
///
/// **What it costs, measured against the real corpus** (107 016 combos, 378 197 `combo_cards`
/// rows; `node:sqlite` over the dev pair, median of 15, warm): **0.02 ms** for an ordinary card
/// — 52 combos — and **11.1 ms** for Ashnod's Altar, the worst card in the catalogue at 6 044.
/// The whole of that is `idx_combo_cards_oracle` not being a covering index: the same count
/// without the `DISTINCT` is 0.14 ms, so what the 11 ms buys is 6 044 row lookups to fetch a
/// `combo_id` the index does not carry. A `(oracle_id, combo_id)` index would take it back to
/// nothing and would speed [`HIT_CTE`] up in every statement here; that is a `COMBO_INDEXES_SQL`
/// change, deliberately not made under a feature branch that only reads.
fn total_sql() -> String {
    format!("WITH {HIT_CTE} SELECT count(*) FROM hit")
}

/// The one pass that touches every combo in the **searched** set — and therefore the one that
/// answers three of [`CardCombosPage`]'s five numbers.
///
/// `by_card_count` is the rows; `owned_total` is the sum of the third column; and `matching` is
/// the same sums taken over the buckets the two facets keep. Splitting those into three
/// statements would be three scans of 6 044 rows to answer questions one scan already has in
/// hand, and — worse — three chances for the panel's chrome to disagree with itself about a set
/// that has not changed. **The page is the only other pass over the subject**, because it is the
/// only thing here that needs the rows rather than counts of them; [`total_sql`] is a fourth
/// statement over a *different* set, which is exactly why it is not folded in here.
///
/// **Every row of it moved under the search on the day the box was added**, and that is the
/// decision rather than a side effect. A text search is the reader changing the *subject* —
/// "I only care about combos with Thassa's Oracle in them" — where the size chips and the owned
/// toggle are facets *of* that subject. A facet's count has to predict what pressing it yields,
/// so the census has to be taken over the searched set or every chip on the row is a lie from
/// the first keystroke.
fn counts_sql() -> String {
    format!(
        "WITH {HIT_CTE},
              {SEL_CTE},
              {OWNED_CTE},
              {GRP_CTE}
         SELECT c.card_count, count(*), sum(g.all_owned)
           FROM grp g JOIN combos c ON c.id = g.combo_id
          GROUP BY c.card_count
          ORDER BY c.card_count"
    )
}

/// One page of combos, ordered and narrowed in SQL.
///
/// **`LIMIT`/`OFFSET` in the statement, never in Rust.** A dialog handed 6 044 rows — every
/// one of them carrying a description, a produces list and its own card rows — is the failure
/// this whole shape exists to avoid, and a `.take(25)` after the fact would have paid for all
/// of it first.
///
/// **The order is [`match_combos`]' own, one term different.** That one leads with
/// `template_count` because a deck asking *what have I got* wants the combos it can be sure of;
/// this leads with `card_count` because a reader asking *what does this card do* wants the
/// two-card combos before the five-card ones. Then `popularity DESC`, then the id so two runs
/// over one card cannot answer in two different orders. SQLite sorts NULLs first, so
/// `popularity DESC` already puts an unranked combo last — the same sentence [`match_combos`]
/// writes, and the reason neither needs a `NULLS LAST`.
///
/// **The size filter is `coalesce(?3, c.card_count)` rather than a clause that comes and goes.**
/// One SQL text, one bound parameter in one position, whichever way the caller asked: a filter
/// spliced in by a `format!` is a filter whose parameter index moves, and every `?` after it
/// moves with it.
///
/// **Every index is written out since the search landed, and that is that rule enforced rather
/// than restated.** `?2` lives inside [`SEL_CTE`], which is *ahead* of these `?`s in the text
/// and absent from neither branch — with bare `?`s, SQLite would number what follows by
/// position and the two branches would only agree by luck. Spelled `?1` oracle id, `?2` needle,
/// `?3` size, `?4` limit, `?5` offset, both branches and [`counts_sql`] bind the same list
/// prefix and a reordered `WITH` cannot silently renumber anything.
fn page_sql(owned_only: bool) -> String {
    // The columns, in the order `card_combos` reads them back by index.
    const COLUMNS: &str = "SELECT c.id, c.bracket_tag, c.card_count, c.template_count,
                                  c.identity, c.produces, c.description, c.easy_prerequisites,
                                  c.notable_prerequisites, c.mana_needed, c.popularity";
    const TAIL: &str = "ORDER BY c.card_count, c.popularity DESC, c.id LIMIT ?4 OFFSET ?5";
    if owned_only {
        // `grp` is already one row per searched combo, so it stands in for `sel` here rather
        // than being joined beside it.
        format!(
            "WITH {HIT_CTE},
                  {SEL_CTE},
                  {OWNED_CTE},
                  {GRP_CTE}
             {COLUMNS}
               FROM grp g JOIN combos c ON c.id = g.combo_id
              WHERE g.all_owned = 1 AND c.card_count = coalesce(?3, c.card_count)
              {TAIL}"
        )
    } else {
        // **`sel` and not `hit`.** The page is a window onto the same subject the counts
        // describe, so a page still reading the unsearched hit set would list combos the
        // histogram above it had already stopped counting.
        format!(
            "WITH {HIT_CTE},
                  {SEL_CTE}
             {COLUMNS}
               FROM sel h JOIN combos c ON c.id = h.combo_id
              WHERE c.card_count = coalesce(?3, c.card_count)
              {TAIL}"
        )
    }
}

/// Where [`pieces_sql`]'s image expressions start — one past `card_id`, the last named column.
///
/// Named rather than inlined for [`crate::deck_tokens`]' reason, and it carries that module's
/// failure too: the pair is (top-level, face) and `for_face` prefers the face, so a read one
/// column out still answers a perfectly real URL — the right picture from the wrong slot. It
/// moves with every column added to the list above it.
const PIECE_IMAGE_COL: usize = 7;

/// Every card of every combo on one page, in one statement.
///
/// **One statement over the page's ids, and the pieces are matched back to their combos by
/// id.** A statement per combo is 68 µs each — fine for 25 and 410 ms if anyone ever ran it
/// over a whole hit set — and matching back by *position* would quietly mis-file every piece
/// the moment a combo on the page turned out to have no rows at all.
///
/// **`ORDER BY p.rowid` is the feed's order**, [`store`]'s contract: `combo_cards` carries no
/// ordinal column, the ingest inserts in the order the file listed, and the staging swap is a
/// rename, which keeps rowids.
///
/// Two reads join the corpus to this, and neither is spelled twice:
///
/// * **The default printing is [`crate::deck_tokens`]' `newest_printing`, verbatim** —
///   `released_at DESC, set_code ASC, collector_number ASC, id ASC` over `cards` for the oracle
///   id. Verbatim on purpose: the art in this panel and the art of a token derived from the
///   same oracle card must not disagree about which printing *is* that card, and two orderings
///   that mean to be the same are two orderings that will not be. A `LEFT JOIN`, so a piece the
///   corpus has never synced answers `NULL` for the id and for all four picture columns rather
///   than dropping the piece.
/// * **The owned count is [`crate::collection_source::copies_of_oracle`]** under
///   [`Availability::Everything`](crate::collection_source::Availability::Everything), which is
///   this crate's single definition of *copies of an oracle card*. **`Everything` and not
///   `ForDeck`, deliberately**: a locked folder is a drawer the app stops *offering* from, and
///   this panel is telling the reader a fact about their collection rather than offering to
///   move anything out of it. Narrowing here would report a card they own, and can see on the
///   Collection page, as one they do not.
///
/// `{holes}` is a placeholder per combo id. **Never interpolated values** — the ids come off
/// the wire, and `p` / `d` / `n` are the only aliases free to use: `copies_of_oracle` binds `e`
/// and `k` inside itself.
fn pieces_sql(conn: &Connection, holes: &str) -> String {
    format!(
        "SELECT p.combo_id, p.oracle_id, p.name, p.quantity, p.must_be_commander,
                {owned}, d.id, {images}
           FROM combo_cards p
           LEFT JOIN cards d
             ON d.id = (SELECT n.id FROM cards n WHERE n.oracle_id = p.oracle_id
                         ORDER BY n.released_at DESC, n.set_code ASC,
                                  n.collector_number ASC, n.id ASC
                         LIMIT 1)
          WHERE p.combo_id IN ({holes})
          ORDER BY p.rowid",
        owned = crate::collection_source::copies_of_oracle(
            conn,
            "p.oracle_id",
            crate::collection_source::Availability::Everything,
        ),
        images = crate::image_uri::front_face_selects("d").join(", "),
    )
}

/// Every combo that **names** one card, paged.
///
/// **The opposite question to [`match_combos`], and a second statement rather than a parameter
/// on the first.** That one asks *which combos does this deck completely hold* and answers only
/// the ones it does; this asks *which combos name this card at all* and makes no claim about
/// the rest of the pieces — which is the only question a reader looking at a single card can
/// be asking. Folding the two into one query would mean a `have = card_count` that is sometimes
/// applied and sometimes not, which is two queries wearing one name.
///
/// Four statements, in this order and for these reasons:
///
/// 1. [`total_sql`] — how many combos name the card at all, over [`HIT_CTE`] and no filters.
/// 2. [`counts_sql`] — the histogram over the *searched* set, and with it `owned_total` and
///    `matching`.
/// 3. [`page_sql`] — the rows, narrowed and ordered and `LIMIT`ed in SQL.
/// 4. [`pieces_sql`] — every card of the combos on that page, in one statement, folded back
///    per combo **by id**.
///
/// The last is skipped when the page is empty, because `IN ()` is not SQL. The first three run
/// unconditionally: an unknown oracle id costs one index probe that finds nothing, and deciding
/// to skip the page from a count derived by the statement before it is exactly the shape that
/// hides the bug where those two disagree. **The first runs even when there is no search**, for
/// that same reason: `total` computed one way with a needle and another way without it is two
/// definitions of one number, and the cheap path would be the one nothing exercises.
///
/// # What the search narrows, and what it does not
///
/// | field | over what set |
/// | --- | --- |
/// | `total` | combos naming this card, **no filters at all** |
/// | `by_card_count` | the search-filtered set |
/// | `owned_total` | the search-filtered set |
/// | `matching` | after the search **and** `card_count` **and** `owned_only` |
///
/// A text search is the reader changing the **subject** — "I only care about combos with
/// Thassa's Oracle in them" — where the size chips and the owned toggle are **facets** of that
/// subject. A facet's count has to predict what pressing it yields, so the census behind the
/// chips and behind "you own every piece of N of these" is taken over the searched set or both
/// are lies the moment anybody types. `total` stays the card's own census because it answers a
/// question the search does not change, and it is what lets the panel go on saying *this card
/// is in 6 044 combos* over a list showing four of them.
///
/// The needle is matched case-insensitively against **any** piece's `combo_cards.name`,
/// the asked-about card's own row included — see [`SEL_CTE`] for that rule, for why the
/// wildcards cannot come off the wire, and for what a blank one means.
///
/// **An unknown oracle id and a database that has never ingested answer the same empty page**,
/// which is [`match_combos`]' documented rule and holds here for its reason: the caller tells
/// those two apart from [`ComboStatus::fetched_at`], and a reader shown "this card is in no
/// combos" when the truth is "we have no combos at all" has been told something false.
pub fn card_combos(
    conn: &Connection,
    oracle_id: &str,
    search: Option<&str>,
    card_count: Option<i64>,
    owned_only: bool,
    limit: i64,
    offset: i64,
) -> Result<CardCombosPage, String> {
    let oracle_id = oracle_id.trim();
    // **`None`, `Some("")` and a `Some` that trims to empty are one value and one code path.**
    // A text box that has been typed into and cleared sends a string the reader means nothing
    // by, and a caller that has no box at all sends nothing — folding both to `""` here is what
    // makes [`SEL_CTE`]'s `?2 = ''` the single spelling of *no search*, rather than a branch
    // that has to be taken identically in three composed statements.
    let needle = search
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    // Clamped rather than refused: every one of these is a number a page composed and none is
    // a reader's answer to anything, so a bound this app can meet quietly is worth more than a
    // sentence nobody will read. `limit` is clamped *up* as well — a `0` asked for by a page
    // that has not finished setting itself up is an empty list forever otherwise.
    let limit = limit.clamp(1, MAX_PAGE);
    let offset = offset.max(0);

    // **Before the histogram, and unfiltered by anything.** See the table above: this is the
    // only number the search leaves alone, and the only one a search that matched nothing still
    // has to be able to answer.
    let total: i64 = conn
        .prepare_cached(&total_sql())
        .and_then(|mut s| s.query_row(params![oracle_id], |r| r.get(0)))
        .map_err(|e| format!("could not look for this card's combos: {e}"))?;

    let mut counts = conn
        .prepare_cached(&counts_sql())
        .map_err(|e| format!("could not look for this card's combos: {e}"))?;
    let buckets: Vec<(i64, i64, i64)> = counts
        .query_map(params![oracle_id, needle], |r| {
            // `sum()` over a group is never NULL here — every group has a row and `all_owned`
            // is a 0 or a 1 — but a count read as an `Option` costs nothing and cannot panic a
            // reader's window over an arithmetic surprise.
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            ))
        })
        .and_then(|rows| rows.collect())
        .map_err(|e| format!("could not look for this card's combos: {e}"))?;

    let owned_total: i64 = buckets.iter().map(|(_, _, owned)| owned).sum();
    // **The two facets, applied to the buckets rather than asked of the database again.** They
    // are the same two predicates the page statement carries, over a set the statement above has
    // already partitioned by exactly the column one of them tests — so another pass over 6 044
    // rows would spend 60 ms to arrive at a sum this loop takes in nanoseconds. The search is
    // *not* one of them and cannot be applied here: it is already in the set these buckets
    // describe.
    let matching: i64 = buckets
        .iter()
        .filter(|(cards, _, _)| card_count.is_none_or(|want| *cards == want))
        .map(|(_, n, owned)| if owned_only { owned } else { n })
        .sum();
    let by_card_count = buckets
        .iter()
        .map(|(cards, combos, _)| ComboCountBucket {
            cards: *cards,
            combos: *combos,
        })
        .collect();

    let mut page = conn
        .prepare_cached(&page_sql(owned_only))
        .map_err(|e| format!("could not look for this card's combos: {e}"))?;
    let mut combos: Vec<CardCombo> = page
        .query_map(params![oracle_id, needle, card_count, limit, offset], |r| {
            Ok(CardCombo {
                id: r.get(0)?,
                bracket_tag: r.get(1)?,
                card_count: r.get(2)?,
                template_count: r.get(3)?,
                identity: r.get(4)?,
                produces: r.get(5)?,
                description: r.get(6)?,
                easy_prerequisites: r.get(7)?,
                notable_prerequisites: r.get(8)?,
                mana_needed: r.get(9)?,
                popularity: r.get(10)?,
                pieces: Vec::new(),
            })
        })
        .and_then(|rows| rows.collect())
        .map_err(|e| format!("could not look for this card's combos: {e}"))?;

    if !combos.is_empty() {
        // **By id, never by position.** The statement returns the page's cards in rowid order,
        // which is neither the page's order nor one row per combo, and a combo whose cards this
        // database somehow has none of contributes no rows at all — so anything that walked the
        // two lists in step would file the next combo's pieces under it.
        //
        // The index is keyed off `ids` rather than off `combos` for a plain borrow reason: the
        // fold below takes `combos` mutably, and a map holding `&str` into it could not still
        // be alive by then.
        let ids: Vec<String> = combos.iter().map(|c| c.id.clone()).collect();
        let where_to: HashMap<&str, usize> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id.as_str(), i))
            .collect();
        let holes = vec!["?"; ids.len()].join(",");
        let mut stmt = conn
            .prepare_cached(&pieces_sql(conn, &holes))
            .map_err(|e| format!("could not read a combo's cards: {e}"))?;
        let rows: Vec<(String, ComboPiece)> = stmt
            .query_map(params_from_iter(ids.iter()), |r| {
                Ok((
                    r.get(0)?,
                    ComboPiece {
                        oracle_id: r.get(1)?,
                        name: r.get(2)?,
                        quantity: r.get(3)?,
                        must_be_commander: r.get(4)?,
                        owned: r.get(5)?,
                        card_id: r.get(6)?,
                        image_uris: crate::image_uri::front_face_map(|i| {
                            r.get::<_, Option<String>>(PIECE_IMAGE_COL + i)
                        })?,
                    },
                ))
            })
            .and_then(|rows| rows.collect())
            .map_err(|e| format!("could not read a combo's cards: {e}"))?;
        for (combo_id, piece) in rows {
            if let Some(i) = where_to.get(combo_id.as_str()) {
                combos[*i].pieces.push(piece);
            }
        }
    }

    Ok(CardCombosPage {
        total,
        matching,
        owned_total,
        by_card_count,
        combos,
    })
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
#[cfg(not(target_family = "wasm"))]
static REFRESHING: AtomicBool = AtomicBool::new(false);

/// Clears the claim however the refresh ends — an early return, an error, a dropped future.
/// `sync::SyncingGuard`'s shape, for its reason: a latched flag locks the reader out until they
/// restart the app.
#[cfg(not(target_family = "wasm"))]
struct RefreshGuard;

#[cfg(not(target_family = "wasm"))]
impl RefreshGuard {
    /// Claim the refresh, or `None` if one is already running.
    fn claim() -> Option<RefreshGuard> {
        REFRESHING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| RefreshGuard)
    }
}

#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
fn conditional_etag(etag: Option<&str>, populated: bool) -> Option<&str> {
    etag.filter(|_| populated)
}

/// Should a launch go and refresh this? See [`refresh_if_due`] for the reasoning; this is the
/// arithmetic of it, split out so it can be asserted directly, with no network and no database.
///
/// **Staleness and nothing else** — `tags::{oracle,art}::refresh_if_due`'s question, asked of
/// this feed's watermark. [`is_stale`] already reads a missing `checked_at` as stale, so a
/// database that has never asked is due by definition and the never-ingested case needs no arm
/// of its own. It had two of them until combos joined the tag datasets in fetching uninvited:
/// one for no `combo_meta` row and one for a row with no `fetched_at`, both answering `false`,
/// which together meant a database that had never fetched the file never would.
///
/// The function survives the collapse to a single expression because the rule is worth being
/// able to assert on its own; that is the split every other helper in this module uses.
#[cfg(not(target_family = "wasm"))]
fn due_at_startup(meta: Option<&ComboMeta>, now: i64) -> bool {
    is_stale(meta.and_then(|m| m.checked_at), now)
}

/// Note that Spellbook has been asked, on a run that found nothing to ingest.
///
/// Best-effort and skipped rather than waited for if the connection is busy: the worst a lost
/// stamp costs is one more conditional request a week from now. **Nothing is written when there
/// is no row**, which is the never-ingested state: a watermark with no rows behind it is exactly
/// what would make the next run 304 past an empty database.
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
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

/// Refresh the combo database at startup if it is due.
///
/// **It fetches uninvited, which is a reversal.** This used to return early on a database whose
/// `fetched_at` was NULL, so nothing downloaded until a reader pressed Refresh in Settings, on
/// the grounds that the tag files are what a deck add is categorised by while combos are only
/// the *fourth* bracket signal and a database without them simply reads three. The argument does
/// not survive contact with the reader: a bracket readout that silently reads three signals
/// instead of four — for as long as it takes somebody to find a button they have no reason to
/// look for — is a worse failure than 27.5 MB spent on a schedule this app already spends
/// ~18 MB on for the two tagger files. So combos join [`crate::tags::oracle::refresh_if_due`]
/// and [`crate::tags::art::refresh_if_due`] rather than
/// [`crate::marketplace_feed::refresh_selected_if_due`], where a marketplace nobody picked is
/// still never downloaded because nobody has asked to be shown its prices.
/// [`due_at_startup`] is the whole of the new rule: stale, where never asked is stale.
///
/// **[`REFRESH_INTERVAL_SECS`] is untouched by any of that.** The week is a statement about how
/// often to *ask*, and its reason — a bracket readout that changes between two sessions on one
/// afternoon, for a reason the reader cannot see — reads the same whether the first ask was a
/// launch's or a press's.
///
/// **Silent, best-effort and never blocking.** It runs before there is a window to complain in,
/// a failure is already in `error_log`, and the honest fallback is the combos already on disk —
/// or, on a first run that fails, the three signals the estimate had before this feed existed.
/// A failed first fetch leaves no watermark at all, because [`mark_checked`] updates a row that
/// is not there, so it is retried at the next launch rather than throttled out for a week.
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
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

/// Throw away every stored combo and the watermark with it.
///
/// **A debugging affordance rather than something the ordinary reader needs.** Nothing about a
/// bracket estimate is improved by an empty combo table; what this is for is proving the ingest
/// still works end to end from a cold database, which is otherwise reachable only by deleting
/// `corpus.db` and paying for a whole resync to test one feed. **The caller is expected to
/// follow it with a forced [`combos_refresh`]** — and that refresh really downloads, because
/// [`clear_combos`] takes the rows out from under the stored ETag and [`conditional_etag`]
/// therefore replays nothing.
///
/// It answers the post-clear [`ComboStatus`], which is [`status_of`]'s never-ingested answer:
/// two zeros, three nulls and `stale: true`. Answering the status rather than nothing means the
/// page that pressed this has no second round trip to make to find out what it did.
///
/// `async`, and answered on the blocking pool, for [`combos_status`]'s reason: a sync command
/// body runs inline on the IPC thread, and this one takes the write lock. The body itself is
/// [`clear`], which is also what `web::route` hands to `crate::sync::with_write` — this is that
/// same function on a pool thread, and not a second answer to the same question.
///
/// **A lock it could not have is reported rather than swallowed**, which is the difference
/// between this and [`mark_checked`]. That one is a best-effort watermark nobody is waiting on;
/// this is a press somebody is watching, and a clear that quietly did nothing would read as a
/// database that refuses to empty.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn combos_clear(state: tauri::State<'_, Arc<AppState>>) -> Result<ComboStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) else {
            return Err(crate::db::BUSY.to_owned());
        };
        clear(&conn)
    })
    .await
    .map_err(|e| format!("could not clear the combos: {e}"))?
}

/// Every combo the given printings can make between them.
///
/// One round trip for a whole deck, and the ids are `cards.id` — a printing id, which is what
/// every deck row, drag source and resolved import line already holds. At most
/// [`MAX_CARD_IDS`] of them; see [`match_combos`] for why the list length is a real bound.
///
/// `async`, and answered on the blocking pool, for [`combos_status`]'s reason.
#[cfg(not(target_family = "wasm"))]
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

/// Every combo that names one card, a page at a time.
///
/// **The card is named by `oracle_id` and not by a printing id**, which is the one place this
/// command's wire shape differs from [`combos_for_cards`]' and is not an oversight: a combo is
/// a fact about a *card*, `combo_cards` is keyed on the oracle id, and asking about a printing
/// would mean resolving it to its oracle card first only to answer identically for all of them.
/// Every surface that opens this panel is looking at a card rather than at a deck row.
///
/// `search` is a case-insensitive substring over **any** piece's name, the asked-about card's
/// own included; `card_count` is an exact size — `Some(2)` is *two-card combos*, `None` is every
/// size — and `owned_only` narrows to the combos the reader owns every piece of. `limit` is
/// clamped to [`MAX_PAGE`] and `offset` to zero; neither is refused, because both are a page's
/// own numbers rather than a reader's.
///
/// **`search` is `Option<String>` for `card_count`'s reason and answers to the same three
/// spellings of nothing.** An absent key, a `null` and a box the reader cleared are one state
/// and [`card_combos`] flattens them into it; what the three of them mean — *no search*, an
/// answer identical to the one this command gave before the box existed — is that function's
/// contract and not this wrapper's.
///
/// `async`, and answered on the blocking pool, for [`combos_status`]'s reason: a sync command
/// body runs inline on the IPC thread and this one takes `db_read`'s mutex. The body is
/// [`card_combos`], which is also what the web target's router calls — one answer to the
/// question, reached two ways.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn combos_for_card(
    state: tauri::State<'_, Arc<AppState>>,
    oracle_id: String,
    search: Option<String>,
    card_count: Option<i64>,
    owned_only: bool,
    limit: i64,
    offset: i64,
) -> Result<CardCombosPage, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        card_combos(
            &conn,
            &oracle_id,
            search.as_deref(),
            card_count,
            owned_only,
            limit,
            offset,
        )
    })
    .await
    .map_err(|e| format!("could not look for this card's combos: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ---- fixtures ---------------------------------------------------------------------

    fn mem_db() -> Mutex<Connection> {
        let conn = crate::schema::memory_pair();
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
                // The fixture carries a `description` and no other prose, so this is also the
                // assertion that an **absent** key lands as `""` rather than as anything else.
                description: "Long prose.".into(),
                easy_prerequisites: String::new(),
                notable_prerequisites: String::new(),
                mana_needed: String::new(),
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
        //
        // **`notes` is the prose canary now that `description` is kept.** The fixture carries
        // both, and the difference between them is the whole of what "read and dropped" means
        // after the four prose fields landed: one is what a reader is told how to play the
        // combo with, and the other is Spellbook's editorial remarks to itself.
        let rendered = format!("{:?}", file.combos);
        assert!(!rendered.contains("scryfall.io"), "{rendered}");
        assert!(!rendered.contains("More prose"), "{rendered}");
        assert!(!rendered.contains("tcgplayer"), "{rendered}");
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

    /// **The four prose fields, in the three states the file actually sends them in**, all the
    /// way from the wire to a row read back out of the database.
    ///
    /// The three are *different inputs*: a key carrying text, a key carrying `""` — which is
    /// what Spellbook writes for a variant with no prose, rather than null — and a key that is
    /// not in the document at all. Two of them must land as the same stored value and the
    /// third must not, so a reduction that dropped one field, or that read one field into
    /// another's column, cannot pass. The `INSERT` names its columns for exactly the second of
    /// those failures.
    #[test]
    fn the_four_prose_fields_survive_the_wire_the_reduction_and_the_write() {
        let full = r#"{"id":"full","status":"OK","bracketTag":"P","identity":"C",
            "legalities":{"commander":true},
            "uses":[{"card":{"name":"Altar","oracleId":"o-altar"}}],"requires":[],
            "produces":[{"feature":{"name":"Infinite mana"}}],
            "description":"Activate Marneus by paying {6}.\nRepeat.",
            "easyPrerequisites":"All permanents are untapped.",
            "notablePrerequisites":"Marneus is on the battlefield.",
            "manaNeeded":"{6}",
            "notes":"Editorial remarks.","manaValueNeeded":6,"variantCount":3}"#;
        let empty = r#"{"id":"empty","status":"OK","bracketTag":"P","identity":"C",
            "legalities":{"commander":true},
            "uses":[{"card":{"name":"Altar","oracleId":"o-altar"}}],"requires":[],
            "produces":[],
            "description":"","easyPrerequisites":"","notablePrerequisites":"","manaNeeded":""}"#;
        let absent = r#"{"id":"absent","status":"OK","bracketTag":"P","identity":"C",
            "legalities":{"commander":true},
            "uses":[{"card":{"name":"Altar","oracleId":"o-altar"}}],"requires":[],
            "produces":[]}"#;

        let file = parse(&document(&[
            full.to_owned(),
            empty.to_owned(),
            absent.to_owned(),
        ]));

        // **All three are kept.** `""` in every prose field is not a reason to skip a variant:
        // it is the ordinary state of thousands of published combos, and dropping them would
        // take their cards with them.
        assert_eq!(file.skipped, 0, "no prose is not a reason to skip");
        assert_eq!(file.combos.len(), 3);
        let by_id = |id: &str| file.combos.iter().find(|c| c.id == id).unwrap();
        assert_eq!(
            by_id("full").description,
            "Activate Marneus by paying {6}.\nRepeat.",
            "the newlines are the numbered steps and are part of the value"
        );
        assert_eq!(
            by_id("full").easy_prerequisites,
            "All permanents are untapped."
        );
        assert_eq!(
            by_id("full").notable_prerequisites,
            "Marneus is on the battlefield."
        );
        assert_eq!(by_id("full").mana_needed, "{6}");
        for id in ["empty", "absent"] {
            let c = by_id(id);
            assert_eq!(
                (
                    c.description.as_str(),
                    c.easy_prerequisites.as_str(),
                    c.notable_prerequisites.as_str(),
                    c.mana_needed.as_str()
                ),
                ("", "", "", ""),
                "`{id}`: an empty key and an absent one are two documents and one value"
            );
        }
        // And the fields beside them are still dropped, which is what makes this an assertion
        // about *which four* rather than about prose in general.
        let rendered = format!("{:?}", file.combos);
        assert!(!rendered.contains("Editorial remarks"), "{rendered}");

        // Through `store` and back out, per column and by name — the half a parse test cannot
        // reach, and the one a column list left out of the `INSERT` breaks.
        let db = mem_db();
        store(&db, &file, None, 1_800_000_000, &mut |_, _| {}).unwrap();
        let conn = crate::db::lock_blocking(&db);
        let row: (String, String, String, String) = conn
            .query_row(
                "SELECT description, easy_prerequisites, notable_prerequisites, mana_needed
                   FROM combos WHERE id = 'full'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            (
                "Activate Marneus by paying {6}.\nRepeat.".to_owned(),
                "All permanents are untapped.".to_owned(),
                "Marneus is on the battlefield.".to_owned(),
                "{6}".to_owned(),
            ),
            "each field in its own column, and not one shifted into the next"
        );
        let blanks: i64 = conn
            .query_row(
                "SELECT count(*) FROM combos
                  WHERE description = '' AND easy_prerequisites = ''
                    AND notable_prerequisites = '' AND mana_needed = ''",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(blanks, 2, "`empty` and `absent`, stored the same way");
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

    /// **A launch fetches the combos, including on a database that has never asked for them.**
    /// This test used to pin the opposite rule, and its name was that rule's whole argument:
    /// combos were the fourth bracket signal, so a first run left them alone. What replaced it
    /// is `tags::{oracle,art}`'s rule — a readout that silently reads three signals instead of
    /// four, until somebody finds a button they have no reason to look for, is the worse
    /// failure. Staleness is the only question left, and never-asked is stale by definition.
    #[test]
    fn a_launch_fetches_the_combos_even_when_it_has_never_asked_for_them() {
        assert!(
            due_at_startup(None, 1_800_000_000),
            "no watermark at all: never asked, and due"
        );

        let asked_but_never_ingested = ComboMeta {
            etag: None,
            stamp: None,
            fetched_at: None,
            checked_at: Some(1_000),
        };
        assert!(
            due_at_startup(Some(&asked_but_never_ingested), 1_800_000_000),
            "a watermark with no fetch behind it goes stale like any other, rather than \
             exempting the database forever"
        );

        let ingested = ComboMeta {
            etag: Some("W/\"v1\"".into()),
            stamp: None,
            fetched_at: Some(1_800_000_000),
            checked_at: Some(1_800_000_000),
        };
        assert!(
            !due_at_startup(Some(&ingested), 1_800_000_060),
            "checked a minute ago: fetching uninvited is not fetching every launch"
        );
        assert!(
            due_at_startup(Some(&ingested), 1_800_000_000 + 7 * 86_400),
            "a week on, the file has earned another look"
        );
        assert!(
            due_at_startup(Some(&ingested), 1_799_000_000),
            "checked in the future — the clock moved — and stale is the safe reading"
        );
    }

    /// **A clear is a clear: the combos, the cards they name and the watermark.** What is left
    /// is exactly the never-ingested state the rest of the module is written against, which is
    /// why the `combo_meta` row is deleted rather than having its columns blanked.
    #[test]
    fn clearing_the_combos_leaves_a_never_ingested_database() {
        let db = mem_db();
        let file = parse(&document(&[ok_variant(
            "c1",
            "P",
            &[("A", "oa"), ("B", "ob")],
        )]));
        store(&db, &file, Some("W/\"v1\""), 1_800_000_000, &mut |_, _| {}).unwrap();

        let conn = crate::db::lock_blocking(&db);
        assert!(read_meta(&conn).is_some(), "a watermark to clear");
        assert_eq!(read_status(&conn, 1_800_000_060).combos, 1);

        clear_combos(&conn).unwrap();

        assert_eq!(
            read_meta(&conn),
            None,
            "the watermark row is gone, not blanked"
        );
        assert_eq!(
            read_status(&conn, 1_800_000_060),
            ComboStatus {
                combos: 0,
                cards: 0,
                stamp: None,
                fetched_at: None,
                checked_at: None,
                stale: true,
            },
            "which is the answer a database that never ingested gives"
        );
        let combos: i64 = conn
            .query_row("SELECT count(*) FROM combos", [], |r| r.get(0))
            .unwrap();
        let cards: i64 = conn
            .query_row("SELECT count(*) FROM combo_cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!((combos, cards), (0, 0), "both tables, not just the parent");

        // And the half both targets actually call answers that same status, rather than
        // leaving the page to ask a second time what the press did.
        assert_eq!(
            clear(&conn).unwrap(),
            read_status(&conn, 1_800_000_060),
            "`clear` is `clear_combos` plus the answer, and clearing twice is not an error"
        );
    }

    /// **The child table is emptied by its own statement and not by a cascade.**
    /// `combo_cards.combo_id` is `ON DELETE CASCADE`, but `PRAGMA foreign_keys` is
    /// per-connection and nothing about [`clear_combos`]' signature says who set it — so this
    /// runs on a connection with it off, which is the one where a clear leaning on the cascade
    /// leaves a table full of rows whose combos are gone.
    #[test]
    fn a_clear_empties_the_card_table_with_foreign_keys_off() {
        let db = mem_db();
        seed_one(&db, "c1", "oa");
        let conn = crate::db::lock_blocking(&db);
        conn.pragma_update(None, "foreign_keys", false).unwrap();

        clear_combos(&conn).unwrap();

        let cards: i64 = conn
            .query_row("SELECT count(*) FROM combo_cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cards, 0, "no orphans, whatever the pragma says");
    }

    /// **A cleared database really re-downloads, and that is what makes the clear honest.**
    /// The stored ETag describes a *file*: replayed over empty tables it earns a 304 that no
    /// amount of refreshing gets past. [`conditional_etag`] asks whether there are rows rather
    /// than whether there is a watermark, so a clear cannot leave a database that is told
    /// nothing has changed while holding nothing at all — the round trip below is that
    /// promise, from a stored ETag to an unconditional fetch.
    #[test]
    fn after_a_clear_the_stored_etag_is_not_replayed() {
        let db = mem_db();
        let file = parse(&document(&[ok_variant("c1", "P", &[("A", "oa")])]));
        store(&db, &file, Some("W/\"v1\""), 1_800_000_000, &mut |_, _| {}).unwrap();

        let conn = crate::db::lock_blocking(&db);
        let stored = read_meta(&conn).unwrap().etag;
        assert_eq!(stored.as_deref(), Some("W/\"v1\""));
        assert_eq!(
            conditional_etag(stored.as_deref(), is_populated(&conn)),
            Some("W/\"v1\""),
            "with rows behind it, the ETag is worth replaying"
        );

        clear_combos(&conn).unwrap();

        assert!(!is_populated(&conn), "nothing behind it any more");
        assert_eq!(
            conditional_etag(stored.as_deref(), is_populated(&conn)),
            None,
            "so the next fetch is unconditional, whatever a watermark ever said"
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

    // ---- one card's combos ------------------------------------------------------------

    /// A `cards` row carrying everything the default-printing tie-break sorts on **and** a
    /// picture in both variants, so an assertion about which printing was named is also an
    /// assertion about whose art came back with it.
    fn seed_printing(
        conn: &Connection,
        id: &str,
        oracle: &str,
        name: &str,
        set_code: &str,
        collector_number: &str,
        released_at: &str,
    ) {
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                                released_at, image_uris, raw)
             VALUES (?1, ?2, ?3, ?4, ?5, 'en', 'normal', ?6,
                     json_object(
                       'display',
                       'https://cards.scryfall.io/display/front/0/0/' || ?1 || '.webp?1',
                       'art',
                       'https://cards.scryfall.io/art/front/0/0/' || ?1 || '.webp?1'),
                     '{}')",
            params![id, oracle, name, set_code, collector_number, released_at],
        )
        .unwrap();
    }

    /// Copies of one printing in the reader's collection.
    ///
    /// `finish` and `folder` are two of the eleven grain terms, so two calls differing only in
    /// either are two rows rather than a UNIQUE violation — which is what lets one card be
    /// owned in two finishes across two printings and in two places at once.
    fn own(conn: &Connection, card_id: &str, finish: &str, quantity: i64, folder: Option<i64>) {
        conn.execute(
            "INSERT INTO collection_entries (card_id, set_code, collector_number, lang, finish,
                                             condition, quantity, folder_id, created_at,
                                             updated_at)
                  VALUES (?1, 'tst', '1', 'en', ?2, 'NM', ?3, ?4, 0, 0)",
            params![card_id, finish, quantity, folder],
        )
        .unwrap();
    }

    /// [`ok_variant`] with the one field every ordering assertion below turns on. `None` is the
    /// unranked combo the wire really sends, which SQLite sorts first and `DESC` puts last.
    fn ranked_variant(id: &str, popularity: Option<i64>, cards: &[(&str, &str)]) -> String {
        let pop = popularity.map_or("null".to_owned(), |p| p.to_string());
        let uses: Vec<String> = cards.iter().map(|(n, o)| uses(n, o)).collect();
        format!(
            r#"{{"id":"{id}","status":"OK","bracketTag":"P","identity":"C",
                 "popularity":{pop},"legalities":{{"commander":true}},
                 "uses":[{}],"requires":[],
                 "produces":[{{"feature":{{"name":"Infinite mana"}}}}],
                 "manaNeeded":"{{6}}"}}"#,
            uses.join(",")
        )
    }

    /// Six combos naming `o-altar`, one that does not, and a reader who owns two of the four
    /// cards involved.
    ///
    /// **Every list here disagrees with every list asserted against it.** The variants are
    /// stored in an order that is neither the expected answer nor its reverse nor sorted by id,
    /// because a fixture already in the right order is green against an implementation that
    /// does no sorting at all; the pieces of `c3b` are stored with the *unsynced* card in the
    /// middle, so a `LEFT JOIN` turned into a `JOIN` shifts the two around it rather than
    /// merely losing one off the end; and two printings of one card differ on release date
    /// while two others differ only on set code, so each half of the tie-break is measured on
    /// its own.
    ///
    /// | combo | cards | popularity | every piece owned |
    /// | --- | --- | --- | --- |
    /// | `c2a` | Altar, Basalt | 10 | yes |
    /// | `c2z` | Altar, Basalt | 10 | yes |
    /// | `c2b` | Altar, Curio | 90 | no |
    /// | `c3a` | Altar, Basalt, Curio | 50 | no |
    /// | `c3b` | Altar, Chaos Orb, Basalt | — | no |
    /// | `c4` | Altar, Basalt, Curio, Sword | 20 | no |
    /// | `cnone` | Basalt, Curio | 99 | — (does not name the Altar) |
    fn card_combo_db() -> Mutex<Connection> {
        let db = mem_db();
        {
            let conn = crate::db::lock_blocking(&db);
            seed_printing(
                &conn,
                "p-altar",
                "o-altar",
                "Ashnod's Altar",
                "atq",
                "12",
                "1994-03-04",
            );
            // Two printings a decade apart: `released_at DESC` is what picks between them.
            seed_printing(
                &conn,
                "p-basalt-old",
                "o-basalt",
                "Basalt Monolith",
                "zzz",
                "1",
                "2000-01-01",
            );
            seed_printing(
                &conn,
                "p-basalt-new",
                "o-basalt",
                "Basalt Monolith",
                "aaa",
                "9",
                "2020-01-01",
            );
            // Two printings released the same day: only `set_code ASC` can separate them.
            seed_printing(
                &conn,
                "p-curio-b",
                "o-curio",
                "Cloudstone Curio",
                "bbb",
                "5",
                "2010-01-01",
            );
            seed_printing(
                &conn,
                "p-curio-a",
                "o-curio",
                "Cloudstone Curio",
                "aaa",
                "5",
                "2010-01-01",
            );
            // A locked display case, and the Altar sleeved into it.
            conn.execute(
                "INSERT INTO collection_folders (id, name, kind, sort_order, created_at,
                                                 updated_at, locked)
                      VALUES (7, 'Display case', 'user', 0, 0, 0, 1)",
                [],
            )
            .unwrap();
            own(&conn, "p-altar", "nonfoil", 2, Some(7));
            own(&conn, "p-basalt-old", "nonfoil", 3, None);
            own(&conn, "p-basalt-new", "foil", 1, None);
        }

        let altar = ("Ashnod's Altar", "o-altar");
        let basalt = ("Basalt Monolith", "o-basalt");
        let curio = ("Cloudstone Curio", "o-curio");
        let orb = ("Chaos Orb", "o-nothing");
        let sword = ("Sword of Nothing", "o-unsynced");
        let variants = vec![
            ranked_variant("c3b", None, &[altar, orb, basalt]),
            ranked_variant("c4", Some(20), &[altar, basalt, curio, sword]),
            ranked_variant("c2z", Some(10), &[altar, basalt]),
            ranked_variant("c2a", Some(10), &[altar, basalt]),
            ranked_variant("c3a", Some(50), &[altar, basalt, curio]),
            ranked_variant("c2b", Some(90), &[altar, curio]),
            ranked_variant("cnone", Some(99), &[basalt, curio]),
        ];
        let file = parse(&document(&variants));
        assert_eq!(file.combos.len(), 7, "the fixture itself must have stored");
        store(&db, &file, None, 1_800_000_000, &mut |_, _| {}).unwrap();
        db
    }

    fn ids(page: &CardCombosPage) -> Vec<&str> {
        page.combos.iter().map(|c| c.id.as_str()).collect()
    }

    /// **Smallest first, then most played, then the id** — and the combo the card is not in
    /// never appears at all.
    ///
    /// The fixture stores them in a sixth order on purpose: with the rows already sorted, this
    /// assertion is green against a statement with no `ORDER BY` in it. Each of the three
    /// terms is separable — two sizes, two combos of one size on different popularities, and
    /// two on the *same* popularity that only the id can split.
    #[test]
    fn card_combos_orders_by_size_then_popularity_then_id() {
        let db = card_combo_db();
        let conn = crate::db::lock_blocking(&db);

        let page = card_combos(&conn, "o-altar", None, None, false, 25, 0).unwrap();

        assert_eq!(
            ids(&page),
            vec!["c2b", "c2a", "c2z", "c3a", "c3b", "c4"],
            "size ascending; within a size popularity descending; `c2a` before `c2z` on the id"
        );
        assert_eq!(
            page.combos[4].popularity, None,
            "and an unranked combo sorts last inside its own size, not first"
        );
        assert!(
            !ids(&page).contains(&"cnone"),
            "a combo that does not name the card is not this card's combo"
        );
    }

    /// **Three numbers, three questions, three different values on one call.** `total` is what
    /// the card is in; `matching` is what the filters left; `owned_total` is how much of the
    /// whole set the reader could assemble — and it deliberately ignores the size filter, so
    /// narrowing to two-card combos must not move it.
    ///
    /// 6, 3 and 2 rather than any two of them being equal: a wiring that answered `matching`
    /// with `total`, or `owned_total` with `matching`, passes a fixture where they coincide.
    #[test]
    fn card_combos_counts_total_matching_and_owned_total_as_three_different_numbers() {
        let db = card_combo_db();
        let conn = crate::db::lock_blocking(&db);

        let page = card_combos(&conn, "o-altar", None, Some(2), false, 25, 0).unwrap();

        assert_eq!(page.total, 6, "every combo naming the Altar, unfiltered");
        assert_eq!(page.matching, 3, "the three two-card ones");
        assert_eq!(
            page.owned_total, 2,
            "`c2a` and `c2z`, and the size filter must not touch this"
        );
        assert_eq!(page.combos.len(), 3, "and the page is the matching ones");
        assert_eq!(ids(&page), vec!["c2b", "c2a", "c2z"]);
    }

    /// The histogram is over the set **neither facet has touched**, ascending, and names only
    /// the sizes that occur — a chip row cannot offer a size that would answer nothing.
    ///
    /// A *search* does narrow it, which is the one narrowing that is not a facet;
    /// `a_search_narrows_the_histogram_the_owned_count_and_matching_but_never_total` is that
    /// half and this call passes no needle.
    #[test]
    fn by_card_count_is_ascending_and_names_only_the_sizes_that_occur() {
        let db = card_combo_db();
        let conn = crate::db::lock_blocking(&db);

        // Asked with a filter on, deliberately: the histogram describes the whole set whatever
        // the page is showing, or the chips would empty themselves as soon as one was pressed.
        let page = card_combos(&conn, "o-altar", None, Some(4), true, 25, 0).unwrap();

        assert_eq!(
            page.by_card_count,
            vec![
                ComboCountBucket {
                    cards: 2,
                    combos: 3
                },
                ComboCountBucket {
                    cards: 3,
                    combos: 2
                },
                ComboCountBucket {
                    cards: 4,
                    combos: 1
                },
            ],
            "ascending, and there is no bucket for a size no combo has"
        );
        assert_eq!(page.total, 6);
        assert_eq!(page.matching, 0, "no four-card combo is fully owned");
        assert!(page.combos.is_empty());
    }

    /// The two filters, alone and together, against the page **and** against `matching` —
    /// which have to agree, because one is derived from the histogram and the other is a
    /// `WHERE` clause in a different statement.
    #[test]
    fn the_size_and_owned_filters_narrow_the_page_and_the_matching_count_together() {
        let db = card_combo_db();
        let conn = crate::db::lock_blocking(&db);
        let ask = |cards: Option<i64>, owned: bool| {
            let page = card_combos(&conn, "o-altar", None, cards, owned, 25, 0).unwrap();
            assert_eq!(
                page.matching as usize,
                page.combos.len(),
                "the count and the page disagree for {cards:?}/{owned}"
            );
            ids(&page).iter().map(|s| s.to_string()).collect::<Vec<_>>()
        };

        assert_eq!(ask(None, false).len(), 6);
        assert_eq!(ask(Some(3), false), vec!["c3a", "c3b"]);
        assert_eq!(
            ask(None, true),
            vec!["c2a", "c2z"],
            "the Curio and the two cards with no printing keep the rest out"
        );
        assert_eq!(ask(Some(2), true), vec!["c2a", "c2z"]);
        assert_eq!(ask(Some(3), true), Vec::<String>::new());
        assert_eq!(
            ask(Some(9), false),
            Vec::<String>::new(),
            "a size nothing has"
        );
    }

    /// **Paging walks the one order with no gap and no repeat**, and the limit is clamped
    /// rather than obeyed.
    ///
    /// Three pages of two are concatenated and compared against the whole list, so an `OFFSET`
    /// that was dropped shows up as the first page repeated and a mis-ordered statement shows
    /// up as a set that does not reassemble.
    #[test]
    fn paging_walks_the_order_with_no_gap_and_no_repeat_and_clamps_the_limit() {
        let db = card_combo_db();
        let conn = crate::db::lock_blocking(&db);
        let all = card_combos(&conn, "o-altar", None, None, false, 25, 0).unwrap();
        let whole: Vec<String> = ids(&all).iter().map(|s| s.to_string()).collect();

        let mut walked: Vec<String> = Vec::new();
        for offset in [0, 2, 4, 6] {
            let page = card_combos(&conn, "o-altar", None, None, false, 2, offset).unwrap();
            assert_eq!(page.total, 6, "the counts do not move as the page does");
            assert!(page.combos.len() <= 2, "the limit is a limit");
            walked.extend(ids(&page).iter().map(|s| s.to_string()));
        }
        assert_eq!(walked, whole, "no gap and no repeat");

        // The clamp, from both ends. SQLite reads a negative `LIMIT` as *no limit* and a `0`
        // as *nothing*, so an unclamped `limit` fails loudly in one direction and silently in
        // the other; `MAX_PAGE + 50` is the ceiling the caller does not get to raise.
        assert_eq!(
            card_combos(&conn, "o-altar", None, None, false, 0, 0)
                .unwrap()
                .combos
                .len(),
            1,
            "a zero is clamped up to one row, not down to none"
        );
        assert_eq!(
            card_combos(&conn, "o-altar", None, None, false, -1, 0)
                .unwrap()
                .combos
                .len(),
            1
        );
        assert_eq!(
            card_combos(&conn, "o-altar", None, None, false, MAX_PAGE + 50, 0)
                .unwrap()
                .combos
                .len(),
            6,
            "and a page larger than the answer is the answer"
        );
    }

    /// **A combo can name a card this corpus has never synced**, and that is a supported state
    /// rather than a reason to drop the piece: the name and the owned count did not come from
    /// `cards`, so they are still answerable.
    ///
    /// `c3b` stores that card **between** two the corpus does have, so a `LEFT JOIN` written as
    /// a `JOIN` reorders the pieces around it instead of merely shortening the list.
    #[test]
    fn a_piece_the_corpus_has_never_synced_keeps_its_name_and_its_owned_count() {
        let db = card_combo_db();
        let conn = crate::db::lock_blocking(&db);

        let page = card_combos(&conn, "o-altar", None, Some(3), false, 25, 0).unwrap();
        let c3b = page.combos.iter().find(|c| c.id == "c3b").unwrap();

        assert_eq!(
            c3b.pieces
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Ashnod's Altar", "Chaos Orb", "Basalt Monolith"],
            "three pieces, the unsynced one still in the middle where the feed put it"
        );
        let orb = &c3b.pieces[1];
        assert_eq!(orb.oracle_id, "o-nothing");
        assert_eq!(orb.card_id, None, "no `cards` row to name a printing from");
        assert_eq!(orb.image_uris, None, "and therefore no picture");
        assert_eq!(orb.owned, 0, "which is an answer, not a gap");
        assert_eq!(orb.quantity, 1);
    }

    /// **The default printing is [`crate::deck_tokens`]' tie-break, and both halves of it are
    /// measured.** The Basalt pair differ on release date; the Curio pair were released the
    /// same day and can only be split by set code. The art comes off the row that won, so this
    /// is also the assertion that the picture and the id describe the same printing.
    #[test]
    fn a_pieces_default_printing_is_the_token_resolvers_tie_break() {
        let db = card_combo_db();
        let conn = crate::db::lock_blocking(&db);

        let page = card_combos(&conn, "o-altar", None, Some(4), false, 25, 0).unwrap();
        let pieces = &page.combos[0].pieces;
        let by_oracle = |o: &str| pieces.iter().find(|p| p.oracle_id == o).unwrap();

        assert_eq!(
            by_oracle("o-basalt").card_id.as_deref(),
            Some("p-basalt-new"),
            "the newest release, not the lowest set code"
        );
        assert_eq!(
            by_oracle("o-curio").card_id.as_deref(),
            Some("p-curio-a"),
            "released the same day, so the lowest set code wins"
        );
        assert_eq!(
            by_oracle("o-basalt").image_uris.as_ref().unwrap()["display"],
            "https://cards.scryfall.io/display/front/0/0/p-basalt-new.webp?1",
            "the art belongs to the printing that was named"
        );
        assert!(
            by_oracle("o-basalt")
                .image_uris
                .as_ref()
                .unwrap()
                .contains_key("art"),
            "both list variants, folded up by `front_face_map`"
        );
    }

    /// **The pieces come back in the feed's order, under their own combo.**
    ///
    /// Two combos on one page whose card lists start with the same card and then diverge, so a
    /// fold that matched pieces to combos by *position* rather than by id files the wrong three
    /// under one of them and still returns the right total number of pieces.
    #[test]
    fn the_pieces_come_back_in_the_feeds_order_under_their_own_combo() {
        let db = card_combo_db();
        let conn = crate::db::lock_blocking(&db);

        let page = card_combos(&conn, "o-altar", None, Some(3), false, 25, 0).unwrap();

        assert_eq!(ids(&page), vec!["c3a", "c3b"]);
        assert_eq!(
            page.combos[0]
                .pieces
                .iter()
                .map(|p| p.oracle_id.as_str())
                .collect::<Vec<_>>(),
            vec!["o-altar", "o-basalt", "o-curio"],
        );
        assert_eq!(
            page.combos[1]
                .pieces
                .iter()
                .map(|p| p.oracle_id.as_str())
                .collect::<Vec<_>>(),
            vec!["o-altar", "o-nothing", "o-basalt"],
            "the feed's order for this combo, which is not the alphabet's and not the other's"
        );
        assert!(
            !page.combos[0].pieces[0].must_be_commander,
            "and the per-piece facts came across with it"
        );
        assert_eq!(page.combos[0].pieces[0].quantity, 1);
    }

    /// **The owned count crosses printings and finishes, and counts a locked binder.**
    ///
    /// Basalt is held as 3 nonfoil of one printing and 1 foil of another — four copies of one
    /// card. The Altar's two copies are sleeved into a locked display case, which is exactly
    /// the row [`Availability::ForDeck`](crate::collection_source::Availability::ForDeck) drops:
    /// a locked folder is a drawer the app stops *offering* from, and this panel is reporting
    /// what the reader owns rather than offering to move any of it.
    #[test]
    fn an_owned_count_crosses_printings_and_finishes_and_counts_a_locked_binder() {
        let db = card_combo_db();
        let conn = crate::db::lock_blocking(&db);

        let page = card_combos(&conn, "o-altar", None, Some(2), false, 25, 0).unwrap();
        let c3 = page.combos.iter().find(|c| c.id == "c3a");
        assert!(c3.is_none(), "the size filter is on");
        let pieces = &page.combos.iter().find(|c| c.id == "c2a").unwrap().pieces;

        assert_eq!(
            pieces
                .iter()
                .map(|p| (p.oracle_id.as_str(), p.owned))
                .collect::<Vec<_>>(),
            vec![("o-altar", 2), ("o-basalt", 4)],
            "two in a locked case, and four across two printings and two finishes"
        );
        let curio = card_combos(&conn, "o-altar", None, Some(3), false, 25, 0)
            .unwrap()
            .combos[0]
            .pieces
            .iter()
            .find(|p| p.oracle_id == "o-curio")
            .unwrap()
            .owned;
        assert_eq!(curio, 0, "a printing with a `cards` row and no copies is 0");
    }

    /// **A card the reader owns whose printing carries no `oracle_id` cannot make a combo look
    /// owned.**
    ///
    /// The column is nullable, and one NULL in the owned set turns `piece IN (owned)` into NULL
    /// for every *unowned* piece — which `min()` then skips, reporting a combo the reader
    /// cannot assemble as one they can. This is the empty-set trap this repo has paid for
    /// before, one operator over, and the fence is `k.oracle_id IS NOT NULL`.
    #[test]
    fn an_owned_printing_with_no_oracle_id_cannot_make_a_combo_read_as_owned() {
        let db = card_combo_db();
        let conn = crate::db::lock_blocking(&db);
        assert_eq!(
            card_combos(&conn, "o-altar", None, None, false, 25, 0)
                .unwrap()
                .owned_total,
            2,
            "before: `c2a` and `c2z`"
        );

        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
                  VALUES ('p-nameless', 'A Token', 'tst', '1', 'en', 'token', '{}')",
            [],
        )
        .unwrap();
        own(&conn, "p-nameless", "nonfoil", 1, None);

        assert_eq!(
            card_combos(&conn, "o-altar", None, None, false, 25, 0)
                .unwrap()
                .owned_total,
            2,
            "a NULL oracle id in the collection owns nothing and hides nothing"
        );
        assert_eq!(
            ids(&card_combos(&conn, "o-altar", None, None, true, 25, 0).unwrap()),
            vec!["c2a", "c2z"],
            "and the owned page is the same two it was"
        );
    }

    /// **A combo naming the asked-about card twice is one combo, counted once and listed
    /// once.** `combo_cards` really does carry two rows for it — that is what `card_count`
    /// being a distinct count is for — so the hit set has to be a `DISTINCT` one or the
    /// histogram double-counts and the page repeats.
    #[test]
    fn a_combo_naming_the_asked_card_twice_is_counted_and_listed_once() {
        let db = mem_db();
        let twice = r#"{"id":"twice","status":"OK","bracketTag":"S","identity":"R",
            "popularity":5,"legalities":{"commander":true},
            "uses":[{"card":{"name":"Kiki-Jiki","oracleId":"o-kiki"},"quantity":1},
                    {"card":{"name":"Kiki-Jiki","oracleId":"o-kiki"},"quantity":1}],
            "requires":[],"produces":[]}"#;
        let file = parse(&document(&[twice.to_owned()]));
        assert_eq!(file.combos[0].card_count, 1);
        store(&db, &file, None, 1_800_000_000, &mut |_, _| {}).unwrap();

        let conn = crate::db::lock_blocking(&db);
        let page = card_combos(&conn, "o-kiki", None, None, false, 25, 0).unwrap();

        assert_eq!(page.total, 1);
        assert_eq!(ids(&page), vec!["twice"]);
        assert_eq!(
            page.by_card_count,
            vec![ComboCountBucket {
                cards: 1,
                combos: 1
            }]
        );
        assert_eq!(
            page.combos[0].pieces.len(),
            2,
            "and both rows are still named to the reader"
        );
    }

    /// **An unknown card and a database that has never ingested answer the same empty page,
    /// and neither is an error.** Telling those two apart is `ComboStatus::fetchedAt`'s job —
    /// [`match_combos`]' documented rule, and it holds here for its reason: a reader told
    /// "this card is in no combos" when the truth is "we hold no combos" has been told
    /// something false.
    #[test]
    fn an_unknown_card_and_a_database_with_no_combos_both_answer_an_empty_page() {
        let empty = CardCombosPage {
            total: 0,
            matching: 0,
            owned_total: 0,
            by_card_count: Vec::new(),
            combos: Vec::new(),
        };

        let never = crate::schema::memory_pair();
        assert_eq!(
            card_combos(&never, "o-altar", None, None, false, 25, 0).unwrap(),
            empty,
            "never ingested"
        );

        let db = card_combo_db();
        let conn = crate::db::lock_blocking(&db);
        assert_eq!(
            card_combos(&conn, "o-who", None, None, false, 25, 0).unwrap(),
            empty,
            "a card no combo names"
        );
        assert_eq!(
            card_combos(&conn, "  ", None, None, false, 25, 0).unwrap(),
            empty,
            "and a blank is a card nothing names, rather than a match on everything"
        );
    }

    // ---- one card's combos: the search ------------------------------------------------

    /// Seven combos naming `o-altar`, one that does not, and six pieces chosen so that **every
    /// number the search touches moves by a different amount**.
    ///
    /// | combo | pop | cards | size | names Basalt | every piece owned |
    /// | --- | --- | --- | --- | --- | --- |
    /// | `s2a` | 90 | Altar, `_____ Goblin` | 2 | no | yes |
    /// | `s2b` | 80 | Altar, Basalt Monolith | 2 | **yes** | yes |
    /// | `s3a` | 70 | Altar, Basalt Monolith, Cloudstone Curio | 3 | **yes** | no |
    /// | `s3e` | 70 | Altar, Basalt Monolith, Chaos Orb | 3 | **yes** | no |
    /// | `s3b` | 60 | Altar, `_____ Goblin`, `Discount 50% Off` | 3 | no | yes |
    /// | `s3c` | 50 | Altar, Cloudstone Curio, Chaos Orb | 3 | no | no |
    /// | `s4a` | 40 | Altar, Basalt Monolith, `_____ Goblin`, `Discount 50% Off` | 4 | **yes** | yes |
    /// | `snone` | 30 | Basalt Monolith, Cloudstone Curio | — | — | — |
    ///
    /// Searching `basalt` leaves `total` at **7**, the histogram summing to **4**,
    /// `owned_total` at **2** and — with the two-card chip pressed — `matching` at **1**. Four
    /// numbers, four values, and each one strictly below what the same call answers with no
    /// search (7, 7, 4, 2): a wiring that read any of them off the wrong set lands on a number
    /// that is in this table and is not the one asserted.
    ///
    /// **Two of the six card names are here for the wildcard fence.** `_____ Goblin` is a real
    /// Magic card and the live corpus holds eleven `combo_cards` rows whose names carry an
    /// underscore; nothing in it carries a `%` at all, measured, so `Discount 50% Off` is an
    /// invention against a name Spellbook has not published yet. Under an unescaped
    /// `LIKE '%_%'` or `LIKE '%%%'` both needles match every one of the seven, which is why the
    /// fixture also holds `s3c`, whose names contain neither.
    ///
    /// **`s3a` and `s3e` share a popularity on purpose**, so the searched order is one only the
    /// id can finish and the paging walk below is a real walk.
    fn search_combo_db() -> Mutex<Connection> {
        let db = mem_db();
        {
            let conn = crate::db::lock_blocking(&db);
            for (id, oracle, name) in [
                ("p-altar", "o-altar", "Ashnod's Altar"),
                ("p-basalt", "o-basalt", "Basalt Monolith"),
                ("p-goblin", "o-goblin", "_____ Goblin"),
                ("p-off", "o-off", "Discount 50% Off"),
                ("p-curio", "o-curio", "Cloudstone Curio"),
                ("p-orb", "o-orb", "Chaos Orb"),
            ] {
                seed_printing(&conn, id, oracle, name, "tst", "1", "2020-01-01");
            }
            // Four of the six. The Curio and the Orb are what keep `s3a`, `s3e` and `s3c` out
            // of `owned_total`, and they are in different combos so the owned count and the
            // search narrow along different lines.
            for printing in ["p-altar", "p-basalt", "p-goblin", "p-off"] {
                own(&conn, printing, "nonfoil", 1, None);
            }
        }

        let altar = ("Ashnod's Altar", "o-altar");
        let basalt = ("Basalt Monolith", "o-basalt");
        let goblin = ("_____ Goblin", "o-goblin");
        let off = ("Discount 50% Off", "o-off");
        let curio = ("Cloudstone Curio", "o-curio");
        let orb = ("Chaos Orb", "o-orb");
        let variants = vec![
            // Stored in an order that is neither the answer nor its reverse, for
            // `card_combo_db`'s reason.
            ranked_variant("s3c", Some(50), &[altar, curio, orb]),
            ranked_variant("s4a", Some(40), &[altar, basalt, goblin, off]),
            ranked_variant("s2a", Some(90), &[altar, goblin]),
            ranked_variant("s3e", Some(70), &[altar, basalt, orb]),
            ranked_variant("snone", Some(30), &[basalt, curio]),
            ranked_variant("s2b", Some(80), &[altar, basalt]),
            ranked_variant("s3a", Some(70), &[altar, basalt, curio]),
            ranked_variant("s3b", Some(60), &[altar, goblin, off]),
        ];
        let file = parse(&document(&variants));
        assert_eq!(file.combos.len(), 8, "the fixture itself must have stored");
        store(&db, &file, None, 1_800_000_000, &mut |_, _| {}).unwrap();
        db
    }

    /// [`card_combos`] over [`search_combo_db`] with the three narrowings named.
    ///
    /// **`None, None` at a call site is the positional trap `deck::IMAGE_COL` warns about, read
    /// one module over**: `search` and `card_count` are adjacent and both `Option`, so the one
    /// spelling that swaps them silently is exactly the one every default call uses. Every
    /// assertion below goes through this, and the compiler checks the order once.
    fn ask(
        conn: &Connection,
        search: Option<&str>,
        cards: Option<i64>,
        owned_only: bool,
    ) -> CardCombosPage {
        card_combos(conn, "o-altar", search, cards, owned_only, 25, 0).unwrap()
    }

    fn bucket_sum(page: &CardCombosPage) -> i64 {
        page.by_card_count.iter().map(|b| b.combos).sum()
    }

    /// **The whole design decision, in four numbers that cannot be confused for one another.**
    ///
    /// A search is the reader changing the *subject*, so the histogram and the owned count —
    /// which are facets *of* that subject and have to predict what pressing them yields — move
    /// with it, while `total` goes on answering the question the card page asks ("this card is
    /// in seven combos") whatever is typed.
    ///
    /// 7, 4, 2 and 1, and each is strictly below the 7, 7, 4 and 2 the same call answers with
    /// no search at all — so a field read off the wrong set lands on a number this test is
    /// already asserting somewhere else.
    #[test]
    fn a_search_narrows_the_histogram_the_owned_count_and_matching_but_never_total() {
        let db = search_combo_db();
        let conn = crate::db::lock_blocking(&db);

        let wide = ask(&conn, None, Some(2), false);
        assert_eq!(wide.total, 7, "every combo naming the Altar");
        assert_eq!(bucket_sum(&wide), 7, "the histogram, unsearched");
        assert_eq!(wide.owned_total, 4, "s2a, s2b, s3b and s4a");
        assert_eq!(wide.matching, 2, "the two two-card ones");

        let narrow = ask(&conn, Some("basalt"), Some(2), false);
        assert_eq!(
            narrow.total, 7,
            "`total` is the card's own census and a search does not change the question it \
             answers"
        );
        assert_eq!(
            narrow.by_card_count,
            vec![
                ComboCountBucket {
                    cards: 2,
                    combos: 1
                },
                ComboCountBucket {
                    cards: 3,
                    combos: 2
                },
                ComboCountBucket {
                    cards: 4,
                    combos: 1
                },
            ],
            "the chips count the searched set, or every one of them is a lie once somebody types"
        );
        assert_eq!(bucket_sum(&narrow), 4);
        assert_eq!(
            narrow.owned_total, 2,
            "s2b and s4a — `s2a` and `s3b` are owned and name no Basalt"
        );
        assert_eq!(narrow.matching, 1, "s2b alone is a searched two-card combo");
        assert_eq!(ids(&narrow), vec!["s2b"]);
    }

    /// **No search, an empty search and a whitespace-only search are one answer.**
    ///
    /// Compared as whole pages rather than field by field, so a difference anywhere in the
    /// shape is a failure — including in the combos and their pieces.
    #[test]
    fn a_missing_a_blank_and_a_whitespace_only_search_all_answer_what_no_search_answers() {
        let db = search_combo_db();
        let conn = crate::db::lock_blocking(&db);

        let none = ask(&conn, None, None, false);
        assert_eq!(
            none.total, 7,
            "the fixture, so the comparisons below mean something"
        );
        assert_eq!(ids(&none).len(), 7);

        assert_eq!(ask(&conn, Some(""), None, false), none, "an empty box");
        assert_eq!(
            ask(&conn, Some("   "), None, false),
            none,
            "and one holding only spaces — this is what the trim is for, and without it the \
             needle would be three literal spaces and match nothing"
        );
        assert_eq!(
            ask(&conn, Some("  basalt  "), None, false),
            ask(&conn, Some("basalt"), None, false),
            "the trim is on both ends of a real needle too"
        );
    }

    /// **Case-insensitive in both directions, which is two halves of one expression.**
    ///
    /// Dropping `lower(?2)` fails the shouted needle; dropping `lower(s.name)` fails the
    /// whispered one. Neither half can be removed and leave this green.
    #[test]
    fn a_search_is_case_insensitive_in_both_directions() {
        let db = search_combo_db();
        let conn = crate::db::lock_blocking(&db);

        let want = vec!["s2b", "s3a", "s3e", "s4a"];
        assert_eq!(ids(&ask(&conn, Some("basalt"), None, false)), want);
        assert_eq!(
            ids(&ask(&conn, Some("BASALT"), None, false)),
            want,
            "an upper-case needle against a mixed-case name"
        );
        assert_eq!(
            ids(&ask(&conn, Some("basalt monolith"), None, false)),
            want,
            "and a lower-case needle against the same name's capitals"
        );
    }

    /// **The asked-about card's own name matches every one of its combos**, which is the rule
    /// that needs no explaining in the UI: a reader looking at Ashnod's Altar and typing
    /// "ashnod" is not shown an empty list.
    ///
    /// An `EXISTS` that excluded the subject's own `combo_cards` row — `AND s.oracle_id <> ?1`,
    /// which is a perfectly reasonable-looking line — answers nothing here and passes every
    /// other test in this file.
    #[test]
    fn searching_for_the_asked_about_cards_own_name_matches_all_of_its_combos() {
        let db = search_combo_db();
        let conn = crate::db::lock_blocking(&db);

        assert_eq!(
            ask(&conn, Some("ashnod"), None, false),
            ask(&conn, None, None, false),
            "the card's own name is a search that narrows nothing"
        );
        assert_eq!(
            ids(&ask(&conn, Some("Altar"), None, false)).len(),
            7,
            "and so is any part of it"
        );
    }

    /// **A `%` and a `_` are searched for as characters, never as patterns.**
    ///
    /// This is the whole reason the predicate is `instr` and not `LIKE`: `LIKE '%' || ?2 || '%'`
    /// with either of these needles matches **all seven** combos, and does it silently — the
    /// reader gets a full list back and no error anywhere says the search stopped meaning what
    /// they typed. Three counts, none of them seven, and `s3c`'s names carry neither character
    /// so the broken answer is always strictly larger than the right one.
    ///
    /// There is no third case to write, and that is the argument for `instr` rather than for a
    /// careful escape: `LIKE` needs `%`, `_` **and** whatever `ESCAPE` character neutralises
    /// them, where `instr` has no pattern language and therefore no character to get wrong.
    #[test]
    fn a_percent_and_an_underscore_in_a_search_are_matched_literally() {
        let db = search_combo_db();
        let conn = crate::db::lock_blocking(&db);

        let underscore = ask(&conn, Some("_"), None, false);
        assert_eq!(
            ids(&underscore),
            vec!["s2a", "s3b", "s4a"],
            "the three naming `_____ Goblin`, not the seven a single-character wildcard reaches"
        );
        assert_eq!(underscore.total, 7, "and the census is still the census");

        assert_eq!(
            ids(&ask(&conn, Some("%"), None, false)),
            vec!["s3b", "s4a"],
            "the two naming `Discount 50% Off`"
        );
        assert_eq!(
            ids(&ask(&conn, Some("50% Off"), None, false)),
            vec!["s3b", "s4a"],
            "and a needle carrying one inside a longer string still means the character"
        );
        assert_eq!(
            ids(&ask(&conn, Some("_____ Gob"), None, false)),
            vec!["s2a", "s3b", "s4a"],
            "five of them in a row are five characters"
        );
    }

    /// **The search composes with the size chip and the owned toggle rather than replacing
    /// either**, and `matching` agrees with the page on every one of the eight combinations —
    /// which it has to, because one is summed off the histogram in Rust and the other is a
    /// `WHERE` clause in a different statement.
    ///
    /// The `?2` this feature added sits *ahead* of the size, limit and offset parameters in the
    /// composed text, so a `TAIL` left holding bare `?`s renumbers all three: the size filter
    /// would read the needle, and `LIMIT`/`OFFSET` would read the size and the limit. Every row
    /// below is wrong in that world.
    #[test]
    fn the_search_composes_with_the_size_filter_and_the_owned_toggle() {
        let db = search_combo_db();
        let conn = crate::db::lock_blocking(&db);
        let check = |search: Option<&str>, cards: Option<i64>, owned: bool| {
            let page = ask(&conn, search, cards, owned);
            assert_eq!(
                page.matching as usize,
                page.combos.len(),
                "the count and the page disagree for {search:?}/{cards:?}/{owned}"
            );
            assert_eq!(page.total, 7, "and `total` never moves");
            ids(&page).iter().map(|s| s.to_string()).collect::<Vec<_>>()
        };

        assert_eq!(check(None, None, false).len(), 7);
        assert_eq!(
            check(Some("basalt"), None, false),
            vec!["s2b", "s3a", "s3e", "s4a"]
        );
        assert_eq!(check(Some("basalt"), Some(3), false), vec!["s3a", "s3e"]);
        assert_eq!(check(Some("basalt"), None, true), vec!["s2b", "s4a"]);
        assert_eq!(check(Some("basalt"), Some(2), true), vec!["s2b"]);
        assert_eq!(check(Some("basalt"), Some(4), true), vec!["s4a"]);
        assert_eq!(
            check(None, Some(3), true),
            vec!["s3b"],
            "the owned three-card combo the search would have removed"
        );
        assert_eq!(
            check(Some("curio"), None, true),
            Vec::<String>::new(),
            "searched but owned by nobody, which is a narrowing rather than a fallback to all"
        );
        assert_eq!(
            check(Some("zzz"), None, false),
            Vec::<String>::new(),
            "and a needle nothing carries is an empty list, not the whole one"
        );
    }

    /// **Paging walks the *searched* order with no gap and no repeat**, and the counts do not
    /// move as the page does.
    ///
    /// The one mutation only this catches: a page statement still reading `hit` where the
    /// counts read `sel`. Its first page would be `s2a`, `s2b` — the head of the *unsearched*
    /// list — which is why `s2a` is asserted absent by name as well as by the concatenation.
    #[test]
    fn paging_walks_the_searched_order_with_no_gap_and_no_repeat() {
        let db = search_combo_db();
        let conn = crate::db::lock_blocking(&db);

        let whole: Vec<String> = ids(&ask(&conn, Some("basalt"), None, false))
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(whole, vec!["s2b", "s3a", "s3e", "s4a"]);

        let mut walked: Vec<String> = Vec::new();
        for offset in [0, 2, 4] {
            let page =
                card_combos(&conn, "o-altar", Some("basalt"), None, false, 2, offset).unwrap();
            assert_eq!(page.total, 7, "the counts do not move as the page does");
            assert_eq!(page.matching, 4);
            assert!(page.combos.len() <= 2, "the limit is a limit");
            walked.extend(ids(&page).iter().map(|s| s.to_string()));
        }
        assert_eq!(walked, whole, "no gap and no repeat");
        assert!(
            !walked.contains(&"s2a".to_owned()),
            "`s2a` is the head of the unsearched order and names no Basalt; a page reading the \
             hit set instead of the searched one puts it first"
        );
    }

    /// The wire shapes this panel is drawn from, mirrored by hand on the other side of the IPC
    /// boundary. A field renamed on either side is a page reading `undefined`, which no type
    /// checker on either side would catch.
    #[test]
    fn the_card_combo_dtos_use_the_camel_case_names_the_frontend_expects() {
        let page = CardCombosPage {
            total: 6_044,
            matching: 61,
            owned_total: 3,
            by_card_count: vec![ComboCountBucket {
                cards: 2,
                combos: 61,
            }],
            combos: vec![CardCombo {
                id: "628-2034--5".into(),
                bracket_tag: "S".into(),
                card_count: 2,
                template_count: 1,
                identity: "B".into(),
                produces: "Infinite colorless mana".into(),
                description: "Sacrifice a token.\nRepeat.".into(),
                easy_prerequisites: "All permanents are untapped.".into(),
                notable_prerequisites: String::new(),
                mana_needed: "{6}".into(),
                popularity: None,
                pieces: vec![ComboPiece {
                    oracle_id: "o-altar".into(),
                    name: "Ashnod's Altar".into(),
                    quantity: 1,
                    must_be_commander: false,
                    card_id: Some("p-altar".into()),
                    image_uris: Some(BTreeMap::from([(
                        "art".to_owned(),
                        "https://cards.scryfall.io/art/front/0/0/p-altar.webp?1".to_owned(),
                    )])),
                    owned: 2,
                }],
            }],
        };

        assert_eq!(
            serde_json::to_value(page).unwrap(),
            serde_json::json!({
                "total": 6_044,
                "matching": 61,
                "ownedTotal": 3,
                "byCardCount": [{"cards": 2, "combos": 61}],
                "combos": [{
                    "id": "628-2034--5",
                    "bracketTag": "S",
                    "cardCount": 2,
                    "templateCount": 1,
                    "identity": "B",
                    "produces": "Infinite colorless mana",
                    "description": "Sacrifice a token.\nRepeat.",
                    "easyPrerequisites": "All permanents are untapped.",
                    "notablePrerequisites": "",
                    "manaNeeded": "{6}",
                    "popularity": null,
                    "pieces": [{
                        "oracleId": "o-altar",
                        "name": "Ashnod's Altar",
                        "quantity": 1,
                        "mustBeCommander": false,
                        "cardId": "p-altar",
                        "imageUris": {
                            "art": "https://cards.scryfall.io/art/front/0/0/p-altar.webp?1"
                        },
                        "owned": 2,
                    }],
                }],
            })
        );
    }

    // ---- status -----------------------------------------------------------------------

    /// **Never fetched is its own state**, and it is the one the settings panel has to be able
    /// to say out loud: nothing ingested is not the same as "this deck has no combos".
    #[test]
    fn a_never_ingested_database_reports_itself_as_never_and_stale() {
        let conn = crate::schema::memory_pair();

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
        crate::split::convert(&dir).unwrap();
        let db_path = dir.join(crate::db::CORPUS_DB);
        let db = Mutex::new(crate::db::open_write(&dir).unwrap());

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

    /// The sink and `read_stream` must reduce a document identically — same counts, same
    /// stamp, same combos in the same order.
    ///
    /// **What this can and cannot catch.** `read_stream` *is* `StreamRead` now, so both sides
    /// run the same drain and a bug in it leaves them agreeing — both were run as mutations
    /// and this test stayed green for each. What went red was `read_stream_matches_read_file`
    /// and `read_stream_accepts_plain_and_gzipped_alike`, which compare this parser against
    /// `read_file`'s independent serde implementation; those are the real cross-check. This
    /// one pins the driver loop and the public shape of `new`/`push`/`finish`.
    #[test]
    fn the_combo_sink_and_read_stream_agree() {
        let doc = many_variants(120);
        let bytes = doc.clone().into_bytes();

        let from_iter = read_stream(bytes.chunks(97).map(|c| Ok(c.to_vec()))).unwrap();

        let mut sink = StreamRead::new();
        for chunk in bytes.chunks(97) {
            sink.push(chunk).unwrap();
        }
        let from_sink = sink.finish().unwrap();

        assert_eq!(from_iter.seen, from_sink.seen);
        assert_eq!(from_iter.skipped, from_sink.skipped);
        assert_eq!(from_iter.stamp, from_sink.stamp);
        assert_eq!(from_iter.combos.len(), from_sink.combos.len());
        for (a, b) in from_iter.combos.iter().zip(from_sink.combos.iter()) {
            assert_eq!(a.id, b.id);
        }
    }

    /// The regression the spike paid for: a framer that stops draining still returns rows
    /// for a while and then quietly holds the whole document. The row count cannot see it;
    /// `peak_buffer` can, and the browser is where the real 610 MB document lives, so the
    /// sink has to expose it.
    #[test]
    fn the_combo_sink_exposes_a_peak_buffer_that_stays_small() {
        let doc = many_variants(2000);
        let bytes = doc.into_bytes();
        assert!(
            bytes.len() > 200_000,
            "the fixture must be big enough to matter"
        );

        let mut sink = StreamRead::new();
        for chunk in bytes.chunks(64) {
            sink.push(chunk).unwrap();
        }
        let peak = sink.peak_buffer();
        let file = sink.finish().unwrap();

        assert_eq!(file.seen, 2000);
        assert!(
            peak < 16 * 1024,
            "peak buffer was {peak} bytes against a {} byte document; the framer is not draining",
            bytes.len()
        );
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
