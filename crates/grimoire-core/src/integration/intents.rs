//! **Intents: what an integration may propose, and what this device does about it** (issue #1396,
//! plan `2026-10-29-integrations-intents.md`; the spec's §6.2).
//!
//! An integration never writes into sync. It writes an **intent** — a typed proposal, `{ id,
//! source, kind, payload, … }` — into its group's inbox on the integrations store, and a device of
//! the group reads it, checks it, applies it as an ordinary local write and acks it. The write is
//! then this device's own: the capture triggers record it, and it reaches every other device as
//! this device's op on its next push. The store can only propose.
//!
//! **The allow-list is this device's, and it is asked whatever the Worker let through** ([`check`]):
//! the Worker schema-checks an intent on write, and a store that was compromised, or a Worker that
//! drifted, could still hand a device anything. So the device holds every intent to the plan's §3.1
//! itself — the two kinds, the payload's keys exactly, the bounds, a card its own card data names, a
//! folder of the reader's own — and **never a change, a move or a removal**: there is no kind for
//! one, and a kind this device does not know is refused. This is the Discord branch's §14.2 list,
//! moved out of sync's apply path and onto the intent.
//!
//! **A claim before an apply** ([`store::claim_intent`]): an add is a quantity, so two devices that
//! both applied one intent would add the card twice. A device applies only what it holds a lease
//! on, and the apply and the ack it then owes are one savepoint ([`OWED`]), so an ack a crash
//! interrupted is sent the next round, before the inbox is read again. A refusal needs no claim:
//! every device refuses one intent for one reason.
//!
//! **The policy is this device's too** ([`automatic`]): which `(source, kind)` it applies
//! unasked, kept in `app_meta` (local, never synced, never the store's — a compromised store must
//! not decide what a device applies). Discord's two adds are automatic and fixed: the reader
//! pressed Confirm in Discord. Every other pair parks — stays pending in the store — until the
//! reader switches it on (`review::set_automatic`), or applies one by hand from the review list.
//!
//! **The applier is the reader's own add** — `collection::add_entry` and `wishlist::add_wish`,
//! through the lane's write connection — so a feed row says what happened and the capture triggers
//! record the op, exactly as a press in the app would.

use super::store::{self, Ack, Acked, Claim, Door};

/// `collection_folders.kind` of the reader's own folders — the one kind an add may file into.
const USER_KIND: &str = crate::schema::COLLECTION_FOLDER_KINDS[0];
use crate::collection::EntryInput;
use crate::errors::{self, Kind, Source};
use crate::state::Store;
use crate::sync_pair::identity;
use crate::wishlist::WishInput;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// The two kinds of v1 (plan §3.1) — the closed list. `trade.apply` joins it with trade rooms
/// (the issue's PR 6), and a kind added here is a kind added to [`check`].
pub const COLLECTION_ADD: &str = "collection.add";
pub const WISHLIST_ADD: &str = "wishlist.add";
pub const KINDS: [&str; 2] = [COLLECTION_ADD, WISHLIST_ADD];

/// Who may propose: the integration a token was minted for, or a trade room (PR 6).
pub const SOURCES: [&str; 3] = ["discord", "mcp", "trade"];

/// The sources whose kinds the review list draws a switch for — those a reader can hold a token
/// for in v1. A trade's intents are PR 6's, and its own design decides how they are approved.
pub const REVIEWED_SOURCES: [&str; 2] = ["discord", "mcp"];

/// An add's bounds: at least one copy, at most ninety-nine — the Worker's, and the Discord
/// branch's, numbers.
pub const MAX_QUANTITY: i64 = 99;

/// The longest id a payload may name — a Scryfall id is 36, an oracle id 36, a `sync_uid` 32.
pub const MAX_ID_CHARS: usize = 64;

/// The longest display hint (`name`, `set`, `cn`). Hints are drawn by the store's overlay and are
/// never read here as a fact.
pub const MAX_HINT_CHARS: usize = 200;

/// The finishes an add may name — the collection's own three.
const FINISHES: [&str; 3] = ["nonfoil", "foil", "etched"];

// ---------------------------------------------------------------------------------------
// The sentences an integration shows — an intent's refusal, acked with it
// ---------------------------------------------------------------------------------------

/// A kind this device does not apply — anything but the two adds, a removal above all — or a
/// source it does not know.
pub const NOT_ALLOWED: &str = "That kind of change is not allowed.";
/// A payload whose keys or types are not the kind's.
pub const BAD_PAYLOAD: &str = "That change does not have the shape your devices accept.";
pub const BAD_QUANTITY: &str = "The quantity must be between 1 and 99.";
pub const BAD_FINISH: &str = "The finish must be nonfoil, foil or etched.";
/// A card this device's card data does not name, from card data that is current — a printing
/// that does not exist, or has left Scryfall.
pub const UNKNOWN_CARD: &str = "That card is not in your card data.";
pub const NO_FOLDER: &str = "That folder no longer exists.";
pub const NOT_A_USER_FOLDER: &str = "That folder is not one of your own folders.";
pub const MANAGED_FOLDER: &str = "That wishlist folder is kept by a deck, and cannot be added to.";
/// An intent addressed to another sync group's inbox — never this device's to apply.
pub const WRONG_GROUP: &str = "That change was meant for another sync group.";
/// The reader pressed Decline in the review list.
pub const DECLINED: &str = "Declined in the app.";

/// The `app_meta` row holding the acks this device owes — a JSON object, intent id to [`Ack`].
/// Written in the apply's own savepoint; cleared when the store has the ack.
pub const OWED: &str = "integrations_owed_acks";

/// The `app_meta` row holding the `(source, kind)` pairs this device applies unasked beyond the
/// fixed ones — a JSON array of `"source kind"` strings.
pub const AUTOMATIC: &str = "integrations_automatic";

/// The refusal [`set_automatic`] gives a pair that is fixed on.
pub const FIXED: &str = "Adds you confirm in Discord are always applied.";

// ---------------------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------------------

/// One intent as the inbox hands it (plan §3.1). **The payload is kept as JSON**: it is [`check`]
/// that reads it, key by key, so a payload with a key too many is a refusal with a reason rather
/// than a parse failure nobody is told about.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    pub id: String,
    #[serde(default)]
    pub group: Option<String>,
    pub source: String,
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
    /// Unix milliseconds, the Worker's clock.
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub confirmed_by: Option<String>,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub reason: Option<String>,
}

impl Intent {
    /// A payload hint, when it is a string — for drawing, never for deciding.
    pub fn hint(&self, key: &str) -> Option<String> {
        self.payload
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
    }
}

// ---------------------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------------------

/// What one intent comes to on this device.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// It passes, and this is the write.
    Apply(Plan),
    /// It never will, here or on any device of the group: ack it refused, with this sentence.
    Refuse(&'static str),
    /// Not yet: it names a card this device's card data does not hold, and that data is not
    /// current — another device, or this one after its next download, may know it.
    Wait,
}

/// The write an intent that passed comes to — the reader's own add, built only from what this
/// device read for itself.
#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    Collection {
        card_id: String,
        finish: String,
        quantity: i64,
        folder_id: i64,
    },
    Wishlist {
        card_id: Option<String>,
        oracle_id: Option<String>,
        finish: Option<String>,
        quantity: i64,
        folder_id: Option<i64>,
    },
}

/// The payload's keys, exactly: these, all present…
const COLLECTION_REQUIRED: [&str; 4] = ["scryfallId", "finish", "quantity", "folderUid"];
const WISHLIST_REQUIRED: [&str; 6] = [
    "scryfallId",
    "oracleId",
    "finish",
    "quantity",
    "folderUid",
    "name",
];
/// …and these, the display hints, when present.
const COLLECTION_HINTS: [&str; 3] = ["name", "set", "cn"];
const WISHLIST_HINTS: [&str; 2] = ["set", "cn"];

/// The payload as an object holding every required key, and no key that is neither required nor
/// a hint.
fn shaped<'a>(
    payload: &'a Value,
    required: &[&str],
    hints: &[&str],
) -> Option<&'a Map<String, Value>> {
    let object = payload.as_object()?;
    let every = required.iter().all(|key| object.contains_key(*key));
    let nothing_else = object
        .keys()
        .all(|key| required.contains(&key.as_str()) || hints.contains(&key.as_str()));
    (every && nothing_else).then_some(object)
}

/// A string of 1..=`max` characters.
fn bounded_str(value: &Value, max: usize) -> Option<&str> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.chars().count() <= max)
}

/// `null`, or a string of 1..=`max` characters. `Err` for anything else.
fn optional_str(value: &Value, max: usize) -> Result<Option<&str>, ()> {
    if value.is_null() {
        return Ok(None);
    }
    bounded_str(value, max).map(Some).ok_or(())
}

/// The quantity: a JSON integer — never `1.0`, never `"1"` — from 1 to [`MAX_QUANTITY`].
fn quantity(value: &Value) -> Option<i64> {
    if !(value.is_i64() || value.is_u64()) {
        return None;
    }
    value.as_i64().filter(|n| (1..=MAX_QUANTITY).contains(n))
}

/// Every hint present is a string of 1..=[`MAX_HINT_CHARS`].
fn hints_ok(object: &Map<String, Value>, hints: &[&str]) -> bool {
    hints
        .iter()
        .filter_map(|key| object.get(*key))
        .all(|value| bounded_str(value, MAX_HINT_CHARS).is_some())
}

/// Is this printing in this device's card data?
fn card_known(conn: &Connection, card_id: &str) -> Result<bool, String> {
    conn.query_row("SELECT 1 FROM cards WHERE id = ?1", [card_id], |_| Ok(()))
        .optional()
        .map(|found| found.is_some())
        .map_err(|e| e.to_string())
}

/// Is any printing of this oracle card in this device's card data?
fn oracle_known(conn: &Connection, oracle_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM cards WHERE oracle_id = ?1 LIMIT 1",
        [oracle_id],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(|e| e.to_string())
}

/// A card this device does not hold: wait for card data that may — unless this device's is current,
/// when no device of the group will know it either (`readable::corpus_current`'s rule, applied to
/// an intent).
fn unknown_card(corpus_current: bool) -> Verdict {
    if corpus_current {
        Verdict::Refuse(UNKNOWN_CARD)
    } else {
        Verdict::Wait
    }
}

/// **The device's allow-list** (plan §4): whether `intent` may be applied here, and as what.
/// Asked of every intent, whatever the Worker said of it, and asked again inside the write that
/// applies it.
///
/// `corpus_current` is `readable::corpus_current`'s answer: a card this device's card data does
/// not name is [`Verdict::Wait`] from card data that may be behind, and refused from data that is
/// not. **A folder this device does not hold is refused**, never waited for: the half runs after a
/// sync trip that pulled every folder the group has.
///
/// `Err` is a database that could not be read — nothing to ack, and the next round asks again.
pub fn check(conn: &Connection, intent: &Intent, corpus_current: bool) -> Result<Verdict, String> {
    if !SOURCES.contains(&intent.source.as_str()) || !KINDS.contains(&intent.kind.as_str()) {
        return Ok(Verdict::Refuse(NOT_ALLOWED));
    }
    if let Some(group) = intent.group.as_deref() {
        let ours = identity::group(conn)
            .map_err(|e| e.to_string())?
            .map(|g| g.group_id);
        if ours.as_deref() != Some(group) {
            return Ok(Verdict::Refuse(WRONG_GROUP));
        }
    }
    if intent.kind == COLLECTION_ADD {
        check_collection(conn, &intent.payload, corpus_current)
    } else {
        check_wishlist(conn, &intent.payload, corpus_current)
    }
}

/// `collection.add`: a printing this device knows, one of the three finishes, 1–99 copies, and a
/// `kind = 'user'` collection folder named by its `sync_uid` — never the root, never a deck's
/// folder or the removed drawer (the Discord branch's §14.2: an add files into the reader's own).
fn check_collection(
    conn: &Connection,
    payload: &Value,
    corpus_current: bool,
) -> Result<Verdict, String> {
    let Some(object) = shaped(payload, &COLLECTION_REQUIRED, &COLLECTION_HINTS) else {
        return Ok(Verdict::Refuse(BAD_PAYLOAD));
    };
    if !hints_ok(object, &COLLECTION_HINTS) {
        return Ok(Verdict::Refuse(BAD_PAYLOAD));
    }
    let (Some(card_id), Some(folder_uid)) = (
        bounded_str(&object["scryfallId"], MAX_ID_CHARS),
        bounded_str(&object["folderUid"], MAX_ID_CHARS),
    ) else {
        return Ok(Verdict::Refuse(BAD_PAYLOAD));
    };
    let Some(quantity) = quantity(&object["quantity"]) else {
        return Ok(Verdict::Refuse(BAD_QUANTITY));
    };
    let Some(finish) = object["finish"].as_str().filter(|f| FINISHES.contains(f)) else {
        return Ok(Verdict::Refuse(BAD_FINISH));
    };
    let folder: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, kind FROM collection_folders WHERE sync_uid = ?1",
            [folder_uid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((folder_id, kind)) = folder else {
        return Ok(Verdict::Refuse(NO_FOLDER));
    };
    if kind != USER_KIND {
        return Ok(Verdict::Refuse(NOT_A_USER_FOLDER));
    }
    if !card_known(conn, card_id)? {
        return Ok(unknown_card(corpus_current));
    }
    Ok(Verdict::Apply(Plan::Collection {
        card_id: card_id.to_owned(),
        finish: finish.to_owned(),
        quantity,
        folder_id,
    }))
}

/// `wishlist.add`: a printing or an oracle card this device knows (not neither), a finish of the
/// three or none, 1–99 copies, and a wishlist folder no deck manages — or `null`, the root. The
/// `name` is required for the store's overlay and **not read here**: the wish is named from this
/// device's card data, as a press in the app names it.
fn check_wishlist(
    conn: &Connection,
    payload: &Value,
    corpus_current: bool,
) -> Result<Verdict, String> {
    let Some(object) = shaped(payload, &WISHLIST_REQUIRED, &WISHLIST_HINTS) else {
        return Ok(Verdict::Refuse(BAD_PAYLOAD));
    };
    if !hints_ok(object, &WISHLIST_HINTS) || bounded_str(&object["name"], MAX_HINT_CHARS).is_none()
    {
        return Ok(Verdict::Refuse(BAD_PAYLOAD));
    }
    let (Ok(card_id), Ok(oracle_id), Ok(folder_uid)) = (
        optional_str(&object["scryfallId"], MAX_ID_CHARS),
        optional_str(&object["oracleId"], MAX_ID_CHARS),
        optional_str(&object["folderUid"], MAX_ID_CHARS),
    ) else {
        return Ok(Verdict::Refuse(BAD_PAYLOAD));
    };
    if card_id.is_none() && oracle_id.is_none() {
        return Ok(Verdict::Refuse(BAD_PAYLOAD));
    }
    let Some(quantity) = quantity(&object["quantity"]) else {
        return Ok(Verdict::Refuse(BAD_QUANTITY));
    };
    let finish = match &object["finish"] {
        Value::Null => None,
        value => match value.as_str().filter(|f| FINISHES.contains(f)) {
            Some(f) => Some(f.to_owned()),
            None => return Ok(Verdict::Refuse(BAD_FINISH)),
        },
    };
    let folder_id = match folder_uid {
        None => None,
        Some(uid) => {
            let folder: Option<(i64, Option<i64>)> = conn
                .query_row(
                    "SELECT id, managed_deck_id FROM wishlist_folders WHERE sync_uid = ?1",
                    [uid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match folder {
                None => return Ok(Verdict::Refuse(NO_FOLDER)),
                Some((_, Some(_))) => return Ok(Verdict::Refuse(MANAGED_FOLDER)),
                Some((id, None)) => Some(id),
            }
        }
    };
    let known = match (card_id, oracle_id) {
        (Some(card), _) => card_known(conn, card)?,
        (None, Some(oracle)) => oracle_known(conn, oracle)?,
        (None, None) => false,
    };
    if !known {
        return Ok(unknown_card(corpus_current));
    }
    Ok(Verdict::Apply(Plan::Wishlist {
        card_id: card_id.map(str::to_owned),
        // With a printing, the oracle card is read off it: a payload naming both cannot make
        // them disagree.
        oracle_id: if card_id.is_some() {
            None
        } else {
            oracle_id.map(str::to_owned)
        },
        finish,
        quantity,
        folder_id,
    }))
}

/// **The write**: `collection::add_entry` or `wishlist::add_wish`, the reader's own adds — a feed
/// row, and an op the capture triggers record as this device's. Inside the caller's savepoint.
pub fn apply(conn: &Connection, plan: &Plan) -> Result<(), String> {
    match plan {
        Plan::Collection {
            card_id,
            finish,
            quantity,
            folder_id,
        } => crate::collection::add_entry(
            conn,
            &EntryInput {
                card_id: card_id.clone(),
                finish: finish.clone(),
                quantity: *quantity,
                folder_id: Some(*folder_id),
                ..EntryInput::default()
            },
        )
        .map(|_| ()),
        Plan::Wishlist {
            card_id,
            oracle_id,
            finish,
            quantity,
            folder_id,
        } => crate::wishlist::add_wish(
            conn,
            &WishInput {
                card_id: card_id.clone(),
                oracle_id: oracle_id.clone(),
                // Never the payload's `name`: the wish is named from this device's card data,
                // which `add_wish` reads when it is sent none.
                name: None,
                quantity: *quantity,
                preferred_finish: finish.clone(),
                notes: None,
                folder_id: *folder_id,
            },
        )
        .map(|_| ()),
    }
}

// ---------------------------------------------------------------------------------------
// The policy — this device's, in `app_meta`
// ---------------------------------------------------------------------------------------

/// Fixed on: Discord's two adds. The reader confirmed each in Discord before it was written.
pub fn fixed(source: &str, kind: &str) -> bool {
    source == "discord" && KINDS.contains(&kind)
}

/// The pairs switched on beyond the fixed ones, as stored. An unreadable row is none.
fn switched_on(conn: &Connection) -> Vec<String> {
    crate::app_meta::get_app_meta(conn, AUTOMATIC)
        .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
        .unwrap_or_default()
}

fn pair(source: &str, kind: &str) -> String {
    format!("{source} {kind}")
}

/// Whether this device applies `(source, kind)` without the reader's press.
pub fn automatic(conn: &Connection, source: &str, kind: &str) -> bool {
    fixed(source, kind) || switched_on(conn).contains(&pair(source, kind))
}

/// Switch a pair on or off. **Refused for a fixed pair** ([`FIXED`]) and for a pair the review
/// list draws no switch for ([`NOT_ALLOWED`]).
pub fn set_automatic(conn: &Connection, source: &str, kind: &str, on: bool) -> Result<(), String> {
    if fixed(source, kind) {
        return Err(FIXED.to_owned());
    }
    if !REVIEWED_SOURCES.contains(&source) || !KINDS.contains(&kind) {
        return Err(NOT_ALLOWED.to_owned());
    }
    let mut pairs = switched_on(conn);
    let named = pair(source, kind);
    pairs.retain(|p| p != &named);
    if on {
        pairs.push(named);
    }
    pairs.sort();
    let json = serde_json::to_string(&pairs).map_err(|e| e.to_string())?;
    crate::app_meta::set_app_meta(conn, AUTOMATIC, &json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------
// Owed acks
// ---------------------------------------------------------------------------------------

/// The acks this device owes, by intent id. An unreadable row is none — the store keeps the
/// intent claimed until the lease runs out, and its next reader acks it.
pub fn owed(conn: &Connection) -> BTreeMap<String, Ack> {
    crate::app_meta::get_app_meta(conn, OWED)
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn write_owed(conn: &Connection, owed: &BTreeMap<String, Ack>) -> Result<(), String> {
    if owed.is_empty() {
        return conn
            .execute("DELETE FROM app_meta WHERE key = ?1", params![OWED])
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    let json = serde_json::to_string(owed).map_err(|e| e.to_string())?;
    crate::app_meta::set_app_meta(conn, OWED, &json).map_err(|e| e.to_string())
}

/// Remember an ack this device owes. Inside the apply's savepoint.
fn owe(conn: &Connection, id: &str, ack: &Ack) -> Result<(), String> {
    let mut all = owed(conn);
    all.insert(id.to_owned(), ack.clone());
    write_owed(conn, &all)
}

/// The store has the ack, or will never want it.
fn settle(conn: &Connection, id: &str) -> Result<(), String> {
    let mut all = owed(conn);
    if all.remove(id).is_some() {
        write_owed(conn, &all)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// One intent, and the round's half
// ---------------------------------------------------------------------------------------

/// What [`take`] did with one intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Applied here, and acked (or owed).
    Applied,
    /// Refused by the allow-list, with the sentence the ack carried.
    Refused(&'static str),
    /// Not yet — a card this device's card data does not hold.
    Waiting,
    /// Another device holds it.
    Taken,
    /// Already settled, or gone from the inbox.
    Settled,
}

/// One error-log row for the inbox — `Source::Relay`, as the store's own requests are.
fn note(db: &impl Store, kind: Kind, message: &str) {
    let _ = db.with(|conn| {
        errors::record(
            conn,
            Source::Relay,
            "integrations_intents",
            kind,
            message,
            None,
        );
        Ok(())
    });
}

/// Send one ack and settle the owed row on any answer that ends the matter. `Err` is a request
/// that did not come back: the ack stays owed.
async fn send_ack(db: &impl Store, door: &Door, id: &str, ack: &Ack) -> Result<Acked, String> {
    let answer = store::ack_intent(db, door, id, ack).await?;
    if answer == Acked::Taken {
        // Applied here, and the lease ran out and was taken before the ack landed: the other
        // device may apply it too. Nothing this device can undo; said once, and let go.
        note(
            db,
            Kind::Other,
            &format!("intent {id} was claimed by another device before this device's ack landed"),
        );
    }
    db.with(|conn| settle(conn, id))?;
    Ok(answer)
}

/// **One intent, whatever the policy says** — the round calls it for what the policy applies, the
/// review list's Apply for what the reader chose. The allow-list on the read connection first: a
/// refusal is acked with no claim, a wait is left. Then the claim, then the allow-list again and
/// the write **with the ack it owes, in one savepoint on the lane's write connection** — so the
/// capture triggers record the add and a crash cannot apply it without remembering the ack — then
/// the ack.
///
/// `Err` is a request or a database that failed, already a row: nothing was applied unless an ack
/// is owed for it.
pub async fn take(
    db: &impl Store,
    door: &Door,
    intent: &Intent,
    corpus_current: bool,
) -> Result<Outcome, String> {
    let first = db.reading(|conn| check(conn, intent, corpus_current))?;
    match first {
        Verdict::Refuse(reason) => return refuse(db, door, intent, reason, None).await,
        Verdict::Wait => return Ok(Outcome::Waiting),
        Verdict::Apply(_) => {}
    }
    let lease = match store::claim_intent(db, door, &intent.id).await? {
        Claim::Held { lease } => lease,
        Claim::Taken => return Ok(Outcome::Taken),
        Claim::Acked | Claim::Gone => return Ok(Outcome::Settled),
    };
    let written = db.with(|conn| {
        crate::db::in_savepoint(conn, "integration_intent", || {
            // Asked again where the write is: a folder deleted, or a card data download, since the
            // read above.
            match check(conn, intent, corpus_current)? {
                Verdict::Apply(plan) => {
                    apply(conn, &plan)?;
                    let clock = store::watermark(conn)?;
                    let ack = Ack {
                        state: "applied".to_owned(),
                        reason: None,
                        lease: Some(lease.clone()),
                        hlc_ms: Some(clock.ms),
                        hlc_ctr: Some(clock.ctr),
                    };
                    owe(conn, &intent.id, &ack)?;
                    Ok(Ok(ack))
                }
                other => Ok(Err(other)),
            }
        })
    });
    match written {
        Ok(Ok(ack)) => {
            send_ack(db, door, &intent.id, &ack).await?;
            Ok(Outcome::Applied)
        }
        Ok(Err(Verdict::Refuse(reason))) => refuse(db, door, intent, reason, Some(lease)).await,
        // A card that left between the two reads: the lease runs out and the next round asks.
        Ok(Err(_)) => Ok(Outcome::Waiting),
        Err(e) => {
            note(db, Kind::Other, &e);
            Err(e)
        }
    }
}

/// Ack `intent` refused with `reason`.
async fn refuse(
    db: &impl Store,
    door: &Door,
    intent: &Intent,
    reason: &'static str,
    lease: Option<String>,
) -> Result<Outcome, String> {
    let ack = Ack {
        state: "refused".to_owned(),
        reason: Some(reason.to_owned()),
        lease,
        hlc_ms: None,
        hlc_ctr: None,
    };
    Ok(match store::ack_intent(db, door, &intent.id, &ack).await? {
        Acked::Done => Outcome::Refused(reason),
        Acked::Taken => Outcome::Taken,
        Acked::Settled | Acked::Gone => Outcome::Settled,
    })
}

/// Ack `id` refused with `reason`, holding no lease — the review list's Decline.
pub async fn decline(
    db: &impl Store,
    door: &Door,
    id: &str,
    reason: &str,
) -> Result<Acked, String> {
    let ack = Ack {
        state: "refused".to_owned(),
        reason: Some(reason.to_owned()),
        lease: None,
        hlc_ms: None,
        hlc_ctr: None,
    };
    store::ack_intent(db, door, id, &ack).await
}

/// The inbox's pending intents as this device reads them. One it cannot read at all — not even an
/// id — is one row and skipped; the Worker wrote it, and the next Worker may not.
pub async fn pending(db: &impl Store, door: &Door) -> Result<Option<Vec<Intent>>, String> {
    let Some(inbox) = store::pending_intents(db, door).await? else {
        return Ok(None);
    };
    let mut intents = Vec::with_capacity(inbox.intents.len());
    for value in inbox.intents {
        match serde_json::from_value::<Intent>(value) {
            Ok(intent) if intent.state == "pending" || intent.state.is_empty() => {
                intents.push(intent);
            }
            Ok(_) => {}
            Err(e) => note(
                db,
                Kind::Parse,
                &format!("an intent this device cannot read: {e}"),
            ),
        }
    }
    Ok(Some(intents))
}

/// What the intents half of a round did — for a test; the panel reads nothing of it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IntentsReport {
    /// Whether the half ran: the store answered and the inbox was read.
    pub ran: bool,
    /// Owed acks the store took this round.
    pub acked: Vec<String>,
    pub applied: Vec<String>,
    pub refused: Vec<String>,
    /// Pending, and this device's policy leaves them for the reader.
    pub parked: Vec<String>,
    pub waiting: Vec<String>,
    pub taken: Vec<String>,
    /// The half's failure — already a row.
    pub error: Option<String>,
}

/// **The round's intents half** (plan §4): the acks this device owes, first; then the inbox — each
/// intent the policy applies is [`take`]n, each it parks is left pending for the reader or another
/// device. A request that does not come back ends the half, the next round goes on.
///
/// `db` is the lane, and its `with` the write connection: the adds are this device's writes.
pub async fn half(db: &impl Store, door: &Door, corpus_current: bool) -> IntentsReport {
    let mut report = IntentsReport::default();
    let owed = db.reading(|conn| Ok(owed(conn))).unwrap_or_default();
    for (id, ack) in &owed {
        match send_ack(db, door, id, ack).await {
            Ok(_) => report.acked.push(id.clone()),
            Err(e) => {
                report.error = Some(e);
                return report;
            }
        }
    }
    let intents = match pending(db, door).await {
        Ok(Some(intents)) => intents,
        Ok(None) => return report,
        Err(e) => {
            report.error = Some(e);
            return report;
        }
    };
    report.ran = true;
    for intent in &intents {
        let auto = db
            .reading(|conn| Ok(automatic(conn, &intent.source, &intent.kind)))
            .unwrap_or(false);
        // A kind or a source this device does not know is refused, not parked: no reader's press
        // could make it applicable, and a refusal tells the integration so.
        let known =
            SOURCES.contains(&intent.source.as_str()) && KINDS.contains(&intent.kind.as_str());
        if !auto && known {
            report.parked.push(intent.id.clone());
            continue;
        }
        match take(db, door, intent, corpus_current).await {
            Ok(Outcome::Applied) => report.applied.push(intent.id.clone()),
            Ok(Outcome::Refused(_)) => report.refused.push(intent.id.clone()),
            Ok(Outcome::Waiting) => report.waiting.push(intent.id.clone()),
            Ok(Outcome::Taken) => report.taken.push(intent.id.clone()),
            Ok(Outcome::Settled) => {}
            Err(e) => {
                report.error = Some(e);
                return report;
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::{client, entitlement};
    use serde_json::json;

    /// A device in group `g1` with capture installed — so an apply's op lands in `sync_ops` as
    /// this device's — whose store is at `base`, holding a token fresh enough that nothing asks
    /// the relay, with one card (`c-bolt`) in card data downloaded just now.
    fn device(base: &str) -> Connection {
        let conn = crate::schema::memory_pair();
        crate::sync_engine::capture::install(&conn).unwrap();
        conn.execute(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, 'dev-a', x'00', x'01', 'dev-a', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
             VALUES (1, 'g1', 0, zeroblob(32), 0)",
            [],
        )
        .unwrap();
        crate::schema::fixtures::seed_card(&conn, "c-bolt", "lea", "161");
        current_corpus(&conn, 0);
        client::set_state(&conn, store::INTEGRATIONS_URL, base).unwrap();
        client::set_state(&conn, entitlement::ACCESS_TOKEN, "bearer").unwrap();
        client::set_state(&conn, entitlement::ACCESS_EXPIRES, &i64::MAX.to_string()).unwrap();
        client::set_state(&conn, entitlement::SUPPORTER_STATUS, "active").unwrap();
        conn
    }

    /// This device's bulk file, as downloaded `hours` ago.
    fn current_corpus(conn: &Connection, hours: i64) {
        conn.execute(
            "INSERT OR REPLACE INTO sync_meta (key, value)
             VALUES (?1, strftime('%Y-%m-%dT%H:%M:%S.000+00:00', 'now', ?2))",
            params![crate::sync::K_BULK_UPDATED_AT, format!("-{hours} hours")],
        )
        .unwrap();
    }

    /// A collection folder of `kind`, with its `sync_uid` (capture would mint one; a fixed one is
    /// what a payload names).
    fn collection_folder(conn: &Connection, uid: &str, kind: &str) -> i64 {
        // A deck's folder names its deck; no other kind may.
        let deck =
            (kind == "deck").then(|| crate::schema::fixtures::deck(conn, &format!("Deck {uid}")));
        let id: i64 = conn
            .query_row(
                "INSERT INTO collection_folders
                   (parent_id, name, kind, sort_order, created_at, updated_at, locked, deck_id)
                 VALUES (NULL, ?1, ?2, 0, 0, 0, 0, ?3) RETURNING id",
                params![format!("Folder {uid}"), kind, deck],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "UPDATE collection_folders SET sync_uid = ?1 WHERE id = ?2",
            params![uid, id],
        )
        .unwrap();
        id
    }

    fn wishlist_folder(conn: &Connection, uid: &str, managed: Option<i64>) -> i64 {
        let id: i64 = conn
            .query_row(
                "INSERT INTO wishlist_folders (parent_id, name, sort_order, created_at, updated_at)
                 VALUES (NULL, ?1, 0, 0, 0) RETURNING id",
                [format!("Wishes {uid}")],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "UPDATE wishlist_folders SET sync_uid = ?1, managed_deck_id = ?2 WHERE id = ?3",
            params![uid, managed, id],
        )
        .unwrap();
        id
    }

    fn intent(kind: &str, source: &str, payload: Value) -> Intent {
        Intent {
            id: "i".repeat(22),
            group: Some("g1".to_owned()),
            source: source.to_owned(),
            kind: kind.to_owned(),
            payload,
            created_at: 1_793_000_000_000,
            confirmed_by: Some("discord:1".to_owned()),
            state: "pending".to_owned(),
            reason: None,
        }
    }

    fn add(payload: Value) -> Intent {
        intent(COLLECTION_ADD, "discord", payload)
    }

    fn bolt_into(folder: &str) -> Value {
        json!({ "scryfallId": "c-bolt", "finish": "foil", "quantity": 2, "folderUid": folder,
                "name": "Lightning Bolt", "set": "lea", "cn": "161" })
    }

    fn wish(payload: Value) -> Intent {
        intent(WISHLIST_ADD, "discord", payload)
    }

    fn verdict(conn: &Connection, intent: &Intent) -> Verdict {
        check(conn, intent, true).unwrap()
    }

    /// **The fence (plan §5): an intent off the allow-list is refused on the device even though
    /// the Worker took it.** Each of these is a payload the Worker might have let through — a
    /// drifted Worker, a store dump written back — and each is refused here with its sentence.
    #[test]
    fn an_intent_off_the_allow_list_is_refused_whatever_the_worker_took() {
        let conn = device("http://127.0.0.1:1");
        collection_folder(&conn, "f-user", "user");
        collection_folder(&conn, "f-deck", "deck");
        // The removed drawer is one per database, made with it.
        conn.execute(
            "UPDATE collection_folders SET sync_uid = 'f-removed' WHERE kind = 'removed'",
            [],
        )
        .unwrap();
        let deck = crate::schema::fixtures::deck(&conn, "Burn");
        wishlist_folder(&conn, "w-managed", Some(deck));

        let mut extra = bolt_into("f-user");
        extra["purchasePrice"] = json!(3.5);
        let mut zero = bolt_into("f-user");
        zero["quantity"] = json!(0);
        let mut hundred = bolt_into("f-user");
        hundred["quantity"] = json!(100);
        let mut fractional = bolt_into("f-user");
        fractional["quantity"] = json!(1.5);
        let mut stringly = bolt_into("f-user");
        stringly["quantity"] = json!("2");
        let mut shiny = bolt_into("f-user");
        shiny["finish"] = json!("glossy");
        let mut rootward = bolt_into("f-user");
        rootward["folderUid"] = json!(null);
        let mut missing = bolt_into("f-user");
        missing.as_object_mut().unwrap().remove("finish");

        let cases: Vec<(Intent, &str)> = vec![
            (add(extra), BAD_PAYLOAD),
            (add(zero), BAD_QUANTITY),
            (add(hundred), BAD_QUANTITY),
            (add(fractional), BAD_QUANTITY),
            (add(stringly), BAD_QUANTITY),
            (add(shiny), BAD_FINISH),
            (add(rootward), BAD_PAYLOAD),
            (add(missing), BAD_PAYLOAD),
            (add(bolt_into("f-deck")), NOT_A_USER_FOLDER),
            (add(bolt_into("f-removed")), NOT_A_USER_FOLDER),
            (add(bolt_into("someone-elses-folder")), NO_FOLDER),
            (
                intent("collection.remove", "discord", bolt_into("f-user")),
                NOT_ALLOWED,
            ),
            (
                intent("collection.set_quantity", "discord", bolt_into("f-user")),
                NOT_ALLOWED,
            ),
            (
                intent(COLLECTION_ADD, "webhook", bolt_into("f-user")),
                NOT_ALLOWED,
            ),
            (
                wish(
                    json!({ "scryfallId": "c-bolt", "oracleId": null, "finish": null,
                             "quantity": 1, "folderUid": "w-managed", "name": "Lightning Bolt" }),
                ),
                MANAGED_FOLDER,
            ),
            (
                wish(
                    json!({ "scryfallId": null, "oracleId": null, "finish": null,
                             "quantity": 1, "folderUid": null, "name": "Nothing" }),
                ),
                BAD_PAYLOAD,
            ),
            (
                wish(
                    json!({ "scryfallId": "c-bolt", "oracleId": null, "finish": null,
                             "quantity": 1, "folderUid": null }),
                ),
                BAD_PAYLOAD,
            ),
        ];
        for (intent, reason) in cases {
            assert_eq!(
                verdict(&conn, &intent),
                Verdict::Refuse(reason),
                "{}: {}",
                intent.kind,
                intent.payload
            );
        }
        let mut elsewhere = add(bolt_into("f-user"));
        elsewhere.group = Some("g2".to_owned());
        assert_eq!(verdict(&conn, &elsewhere), Verdict::Refuse(WRONG_GROUP));
    }

    /// A card this device does not hold waits for card data that may be behind, and is refused by
    /// card data that is current.
    #[test]
    fn an_unknown_card_waits_unless_the_card_data_is_current() {
        let conn = device("http://127.0.0.1:1");
        collection_folder(&conn, "f-user", "user");
        let mut unknown = bolt_into("f-user");
        unknown["scryfallId"] = json!("c-new");
        assert_eq!(
            check(&conn, &add(unknown.clone()), false).unwrap(),
            Verdict::Wait
        );
        assert_eq!(
            check(&conn, &add(unknown), true).unwrap(),
            Verdict::Refuse(UNKNOWN_CARD)
        );
    }

    /// What passes is built from what this device read: the folder's local id, the printing named,
    /// and for a wish the oracle card read off the printing rather than taken from the payload.
    #[test]
    fn a_passing_add_is_planned_from_this_devices_own_rows() {
        let conn = device("http://127.0.0.1:1");
        let folder = collection_folder(&conn, "f-user", "user");
        assert_eq!(
            verdict(&conn, &add(bolt_into("f-user"))),
            Verdict::Apply(Plan::Collection {
                card_id: "c-bolt".to_owned(),
                finish: "foil".to_owned(),
                quantity: 2,
                folder_id: folder,
            })
        );
        let wishes = wishlist_folder(&conn, "w-user", None);
        assert_eq!(
            verdict(
                &conn,
                &wish(
                    json!({ "scryfallId": "c-bolt", "oracleId": "o-other", "finish": "etched",
                              "quantity": 3, "folderUid": "w-user", "name": "Lightning Bolt" })
                )
            ),
            Verdict::Apply(Plan::Wishlist {
                card_id: Some("c-bolt".to_owned()),
                oracle_id: None,
                finish: Some("etched".to_owned()),
                quantity: 3,
                folder_id: Some(wishes),
            })
        );
        // Any printing, at the root.
        assert_eq!(
            verdict(
                &conn,
                &wish(
                    json!({ "scryfallId": null, "oracleId": "o-c-bolt", "finish": null,
                              "quantity": 1, "folderUid": null, "name": "Lightning Bolt" })
                )
            ),
            Verdict::Apply(Plan::Wishlist {
                card_id: None,
                oracle_id: Some("o-c-bolt".to_owned()),
                finish: None,
                quantity: 1,
                folder_id: None,
            })
        );
    }

    /// **Discord's two adds are automatic and fixed; every other pair parks until switched on**,
    /// on this device, and a fixed pair cannot be switched.
    #[test]
    fn the_policy_applies_discord_and_parks_the_rest_until_switched_on() {
        let conn = crate::schema::memory_pair();
        assert!(automatic(&conn, "discord", COLLECTION_ADD));
        assert!(automatic(&conn, "discord", WISHLIST_ADD));
        assert!(!automatic(&conn, "mcp", COLLECTION_ADD));
        assert!(!automatic(&conn, "trade", COLLECTION_ADD));
        set_automatic(&conn, "mcp", COLLECTION_ADD, true).unwrap();
        assert!(automatic(&conn, "mcp", COLLECTION_ADD));
        assert!(!automatic(&conn, "mcp", WISHLIST_ADD));
        set_automatic(&conn, "mcp", COLLECTION_ADD, false).unwrap();
        assert!(!automatic(&conn, "mcp", COLLECTION_ADD));
        assert_eq!(
            set_automatic(&conn, "discord", WISHLIST_ADD, false).unwrap_err(),
            FIXED
        );
        assert_eq!(
            set_automatic(&conn, "mcp", "collection.remove", true).unwrap_err(),
            NOT_ALLOWED
        );
        assert_eq!(
            set_automatic(&conn, "trade", COLLECTION_ADD, true).unwrap_err(),
            NOT_ALLOWED
        );
    }

    fn door(server: &httpmock::MockServer) -> Door {
        store::Door::for_tests(&server.base_url(), "bearer", "g1")
    }

    fn intent_json(intent: &Intent) -> Value {
        json!({
            "id": intent.id, "group": intent.group, "source": intent.source, "kind": intent.kind,
            "payload": intent.payload, "createdAt": intent.created_at,
            "confirmedBy": intent.confirmed_by, "state": "pending", "reason": null,
        })
    }

    async fn inbox<'a>(
        server: &'a httpmock::MockServer,
        intents: &[&Intent],
    ) -> httpmock::Mock<'a> {
        let body = json!({
            "intents": intents.iter().map(|i| intent_json(i)).collect::<Vec<_>>(),
            "more": false,
        })
        .to_string();
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/g/g1/intents");
                then.status(200).body(body);
            })
            .await
    }

    async fn claims<'a>(server: &'a httpmock::MockServer, id: &str) -> httpmock::Mock<'a> {
        let path = format!("/g/g1/intents/{id}/claim");
        let body = json!({ "id": id, "lease": "L".repeat(22), "leaseUntil": 1 }).to_string();
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::POST).path(path);
                then.status(200).body(body);
            })
            .await
    }

    async fn acks<'a>(server: &'a httpmock::MockServer, id: &str) -> httpmock::Mock<'a> {
        let path = format!("/g/g1/intents/{id}/ack");
        let body = json!({ "id": id, "state": "applied" }).to_string();
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::POST).path(path);
                then.status(200).body(body);
            })
            .await
    }

    fn ops(conn: &Connection, table: &str) -> Vec<(String, String)> {
        let mut stmt = conn
            .prepare("SELECT kind, device_id FROM sync_ops WHERE tbl = ?1")
            .unwrap();
        stmt.query_map([table], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    /// **A Discord add is claimed, lands in the folder it names as this device's op, and is acked
    /// applied with the lease and this device's clock after the write.**
    #[tokio::test]
    async fn an_automatic_add_is_claimed_applied_as_this_devices_op_and_acked() {
        let server = httpmock::MockServer::start_async().await;
        let conn = device(&server.base_url());
        let folder = collection_folder(&conn, "f-user", "user");
        let bolt = add(bolt_into("f-user"));
        inbox(&server, &[&bolt]).await;
        let claim = claims(&server, &bolt.id).await;
        let lease = "L".repeat(22);
        let path = format!("/g/g1/intents/{}/ack", bolt.id);
        let ack = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::POST)
                    .path(path)
                    .json_body_includes(json!({ "state": "applied", "lease": lease }).to_string());
                then.status(200).body("{}");
            })
            .await;

        let report = half(&conn, &door(&server), true).await;
        assert_eq!(report.applied, vec![bolt.id.clone()], "{report:?}");
        claim.assert_calls_async(1).await;
        ack.assert_calls_async(1).await;
        let (quantity, finish): (i64, String) = conn
            .query_row(
                "SELECT quantity, finish FROM collection_entries WHERE card_id = 'c-bolt' AND folder_id = ?1",
                [folder],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((quantity, finish.as_str()), (2, "foil"));
        assert_eq!(
            ops(&conn, "collection_entries"),
            vec![("put".to_owned(), "dev-a".to_owned())],
            "the add is this device's op"
        );
        assert!(owed(&conn).is_empty(), "the ack was taken");
        // The watermark the ack carried is the clock after the write, which the capture moved.
        assert!(store::watermark(&conn).unwrap().ms > 0);
    }

    /// **A parked intent is not claimed**, and nothing is written for it: an MCP add waits for the
    /// reader's press, or for a device whose policy applies it.
    #[tokio::test]
    async fn a_parked_intent_is_not_claimed() {
        let server = httpmock::MockServer::start_async().await;
        let conn = device(&server.base_url());
        collection_folder(&conn, "f-user", "user");
        let from_mcp = intent(COLLECTION_ADD, "mcp", bolt_into("f-user"));
        inbox(&server, &[&from_mcp]).await;
        let claim = claims(&server, &from_mcp.id).await;
        let report = half(&conn, &door(&server), true).await;
        assert_eq!(report.parked, vec![from_mcp.id.clone()]);
        claim.assert_calls_async(0).await;
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    /// **A refusal needs no claim**: an add into a deck's folder is acked refused, with the
    /// sentence and no lease, and nothing is written.
    #[tokio::test]
    async fn a_refusal_is_acked_without_a_claim() {
        let server = httpmock::MockServer::start_async().await;
        let conn = device(&server.base_url());
        collection_folder(&conn, "f-deck", "deck");
        let into_a_deck = add(bolt_into("f-deck"));
        inbox(&server, &[&into_a_deck]).await;
        let claim = claims(&server, &into_a_deck.id).await;
        let path = format!("/g/g1/intents/{}/ack", into_a_deck.id);
        let ack = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::POST)
                    .path(path)
                    .json_body(json!({
                        "state": "refused", "reason": NOT_A_USER_FOLDER, "lease": null,
                        "hlcMs": null, "hlcCtr": null,
                    }));
                then.status(200).body("{}");
            })
            .await;
        let report = half(&conn, &door(&server), true).await;
        assert_eq!(report.refused, vec![into_a_deck.id.clone()]);
        claim.assert_calls_async(0).await;
        ack.assert_calls_async(1).await;
    }

    /// **Another device's live lease is left alone**: nothing is written, and the intent is that
    /// device's to ack.
    #[tokio::test]
    async fn an_intent_another_device_holds_is_left_to_it() {
        let server = httpmock::MockServer::start_async().await;
        let conn = device(&server.base_url());
        collection_folder(&conn, "f-user", "user");
        let bolt = add(bolt_into("f-user"));
        inbox(&server, &[&bolt]).await;
        let path = format!("/g/g1/intents/{}/claim", bolt.id);
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::POST).path(path);
                then.status(409)
                    .body(r#"{"error":"another device is applying that change","code":"claimed"}"#);
            })
            .await;
        let report = half(&conn, &door(&server), true).await;
        assert_eq!(report.taken, vec![bolt.id.clone()]);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    /// **An owed ack is sent before the inbox is read** — the apply it is for happened in a round a
    /// crash cut short — and settled once the store has it.
    #[tokio::test]
    async fn owed_acks_are_sent_before_the_inbox_is_read() {
        let server = httpmock::MockServer::start_async().await;
        let conn = device(&server.base_url());
        let owed_ack = Ack {
            state: "applied".to_owned(),
            reason: None,
            lease: Some("L".repeat(22)),
            hlc_ms: Some(9),
            hlc_ctr: Some(1),
        };
        owe(&conn, &"o".repeat(22), &owed_ack).unwrap();
        let ack = acks(&server, &"o".repeat(22)).await;
        // The inbox answers 500: had it been read first, the half would have ended before the ack.
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/g/g1/intents");
                then.status(500).body("{}");
            })
            .await;
        let report = half(&conn, &door(&server), true).await;
        ack.assert_calls_async(1).await;
        assert_eq!(report.acked, vec!["o".repeat(22)]);
        assert!(owed(&conn).is_empty());
        assert!(report.error.is_some(), "and then the inbox was asked");
    }

    /// **An apply whose ack did not come back is owed**, in the apply's own savepoint: the add is
    /// in the collection and the ack is in `app_meta`, together.
    #[tokio::test]
    async fn an_ack_that_does_not_come_back_is_owed_beside_the_add() {
        let server = httpmock::MockServer::start_async().await;
        let conn = device(&server.base_url());
        collection_folder(&conn, "f-user", "user");
        let bolt = add(bolt_into("f-user"));
        inbox(&server, &[&bolt]).await;
        claims(&server, &bolt.id).await;
        let path = format!("/g/g1/intents/{}/ack", bolt.id);
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::POST).path(path);
                then.status(503).body("unavailable");
            })
            .await;
        let report = half(&conn, &door(&server), true).await;
        assert!(report.error.is_some());
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
        let all = owed(&conn);
        assert_eq!(all[&bolt.id].state, "applied");
        assert_eq!(
            all[&bolt.id].lease.as_deref(),
            Some("L".repeat(22).as_str())
        );
    }

    /// A wish lands at the root it names, through the wishlist's own add, as this device's op.
    #[tokio::test]
    async fn a_wish_lands_as_this_devices_op() {
        let server = httpmock::MockServer::start_async().await;
        let conn = device(&server.base_url());
        let any = wish(
            json!({ "scryfallId": null, "oracleId": "o-c-bolt", "finish": null,
                               "quantity": 1, "folderUid": null, "name": "Lightning Bolt" }),
        );
        inbox(&server, &[&any]).await;
        claims(&server, &any.id).await;
        acks(&server, &any.id).await;
        let report = half(&conn, &door(&server), true).await;
        assert_eq!(report.applied, vec![any.id.clone()], "{report:?}");
        let (oracle, name): (String, String) = conn
            .query_row(
                "SELECT oracle_id, name FROM wishlist_entries WHERE folder_id IS NULL",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (oracle.as_str(), name.as_str()),
            ("o-c-bolt", "Lightning Bolt")
        );
        assert_eq!(ops(&conn, "wishlist_entries").len(), 1);
    }
}
