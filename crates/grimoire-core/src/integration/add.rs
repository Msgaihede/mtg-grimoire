//! **What an `add` member writes, and what every device takes from one** — the Discord spec's
//! §14 (PR 4). The bot is paired as [`roster::ADD`]: it reads the group like any device and may
//! add cards to the collection and the wishlist, after a reader's *Confirm* in Discord, and do
//! nothing else.
//!
//! Three halves, one rule each:
//!
//! * **The allow-list** ([`allowed`]), stateless and frozen: what an `add` member's envelope may
//!   carry at all. `client::open_checked` runs it over every op of every such envelope, and one
//!   op off it refuses the whole envelope (`WireError::NotAnAdd`). **Widening it is a new
//!   capability word and a new gate** (§7), never an edit here: a device that already holds this
//!   list refuses whatever a wider one lets through, and the group diverges.
//! * **The guards and the rank** (`sync_engine::apply`, `sync_engine::merge::Ranks`), stateful:
//!   a collection add files only into one of the reader's own folders; a create on a known row,
//!   and a grain match, takes only the counter; and a restricted op loses every last-writer and
//!   add-wins contest against a full device's, whatever the stamps.
//! * **The emitter** ([`emit`], and `client::push_restricted` behind it): the one op the bot
//!   writes per add, into its own outbox, applied here through the same guarded path a receiver
//!   uses — so what the bot reads back is what every other device will hold.
//!
//! # The bot's capture stays off, and [`emit`] gets past it
//!
//! The bot's host switches capture off with a `TEMP` trigger on its connection
//! (`crates/grimoire-bot`'s `bot_capture_off`, `BEFORE INSERT ON main.sync_ops`,
//! `RAISE(IGNORE)`): its engine's own writes — a device name, a baseline's bookkeeping, a token
//! reconcile — must never become ops (the spec's F6/F7). **[`emit`] is the only thing that ever
//! puts an op in its outbox**, and it says so for the length of one `INSERT`: it sets the
//! `sync_state` key [`EMITTING`] in its own savepoint, inserts, and deletes it again before
//! anything else runs, so nothing committed ever carries it. The trigger lets a row through only
//! while the key is there — [`CAPTURE_OFF`], which [`capture_off`] installs, is that trigger
//! exactly. An outbox that refused the insert anyway (an older trigger with no `WHEN`) is
//! [`CAPTURE_REFUSED`], and nothing is applied or sent.

use crate::sync_engine::apply;
use crate::sync_engine::capture;
use crate::sync_engine::emission;
use crate::sync_engine::merge::{Kind, Op};
use crate::sync_pair::{crypto, roster};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The collection folder an add goes to when the reader names none — made by the desktop when
/// the integration is switched on ([`ensure_added_folder`]), found by [`default_folder`].
pub const ADDED_FROM_DISCORD: &str = "Added from Discord";

/// The most copies one add carries, and the allow-list's bound on `quantity`.
pub const MAX_QUANTITY: i64 = 99;

/// The most ops one `add` member's envelope may carry. The allow-list refuses a larger one whole,
/// and `client::push_restricted` never seals one.
pub const ADD_OPS_PER_ENVELOPE: usize = 25;

/// The three finishes a printing is made in — `collection_entries.finish`'s `CHECK`.
pub const FINISHES: [&str; 3] = ["nonfoil", "foil", "etched"];

/// A collection add's identity fields — the only fields its op may carry.
pub const COLLECTION_FIELDS: [&str; 5] =
    ["card_id", "set_code", "collector_number", "lang", "finish"];

/// A wishlist add's identity fields — the only fields its op may carry.
pub const WISHLIST_FIELDS: [&str; 7] = [
    "oracle_id",
    "card_id",
    "set_code",
    "collector_number",
    "lang",
    "name",
    "preferred_finish",
];

/// The `sync_state` key [`emit`] holds for the length of its one outbox `INSERT`, and the only
/// thing [`CAPTURE_OFF`]'s trigger lets a row through for. Never committed.
pub const EMITTING: &str = "integration_emitting";

/// **The bot's capture-off trigger, as [`emit`] needs it**: every insert into `sync_ops` ignored,
/// except while [`EMITTING`] is set. A `TEMP` trigger may read the main schema's tables, so the
/// key is read where `emit` writes it. Dropped and made again, so an older one without the `WHEN`
/// never survives.
pub const CAPTURE_OFF: &str = "DROP TRIGGER IF EXISTS temp.bot_capture_off;
     CREATE TEMP TRIGGER bot_capture_off BEFORE INSERT ON main.sync_ops
     WHEN NOT EXISTS (SELECT 1 FROM main.sync_state WHERE key = 'integration_emitting')
     BEGIN SELECT RAISE(IGNORE); END;";

/// Install [`CAPTURE_OFF`] on `conn` — for the bot's host, which owns when capture is off. It
/// empties nothing: what is in `sync_ops` on a bot is its adds, pushed or still to push.
pub fn capture_off(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(CAPTURE_OFF)
}

/// A card for the collection: one printing, in one finish, into one of the reader's folders.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionAdd {
    /// Scryfall's printing id.
    pub card_id: String,
    pub set_code: String,
    pub collector_number: String,
    pub lang: String,
    /// `nonfoil`, `foil` or `etched`.
    pub finish: String,
    /// `1..=`[`MAX_QUANTITY`].
    pub quantity: i64,
    /// A `kind = 'user'` collection folder's `sync_uid`.
    pub folder_uid: String,
}

/// A card for the wishlist: any printing of an oracle card, or one printing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistAdd {
    pub oracle_id: String,
    pub name: String,
    /// `None` is any printing.
    pub printing: Option<WishlistPrinting>,
    pub preferred_finish: Option<String>,
    pub quantity: i64,
    /// A wishlist folder's `sync_uid`; `None` is the wishlist's root.
    pub folder_uid: Option<String>,
}

/// The one printing a wishlist add names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistPrinting {
    pub card_id: String,
    pub set_code: String,
    pub collector_number: String,
    pub lang: String,
}

/// One add, as the bot's proposal keeps it and [`emit`] takes it: `{"table": "collection", …}`
/// or `{"table": "wishlist", …}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "table", rename_all = "camelCase")]
pub enum Add {
    Collection(CollectionAdd),
    Wishlist(WishlistAdd),
}

// ---------------------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------------------

/// **The stateless allow-list** (the spec's §14.2), over every op of one `add` member's envelope:
/// `Ok` only when every op is an add and there are at most [`ADD_OPS_PER_ENVELOPE`] of them, and
/// otherwise the first reason, as a clause `WireError::NotAnAdd` carries.
///
/// Each op:
/// * is a `Put`, stamped by `sender`, with no `baseline`, no `horizon` and no `emission`;
/// * is about `collection_entries` or `wishlist_entries`;
/// * has `counters` exactly `{"quantity": n}`, `1 ≤ n ≤` [`MAX_QUANTITY`];
/// * has `fields` drawn from that table's identity fields alone ([`COLLECTION_FIELDS`],
///   [`WISHLIST_FIELDS`]) — none at all is an increment — each a non-empty string, `finish` one
///   of [`FINISHES`], and `preferred_finish` one of them or `null`;
/// * has `parents` exactly `{"folder": …}` — a folder's uid for a collection add, a folder's uid
///   or `null` (the root) for a wishlist add.
///
/// Whether the folder is one the reader owns is not this list's to say — it cannot know — and is
/// `apply`'s stateful guard.
pub fn allowed(sender: &str, ops: &[Op]) -> Result<(), String> {
    if ops.is_empty() {
        return Err("a batch with no changes in it".to_owned());
    }
    if ops.len() > ADD_OPS_PER_ENVELOPE {
        return Err(format!(
            "{} changes in one batch, where at most {ADD_OPS_PER_ENVELOPE} are taken",
            ops.len()
        ));
    }
    ops.iter().try_for_each(|op| allowed_op(sender, op))
}

fn allowed_op(sender: &str, op: &Op) -> Result<(), String> {
    if op.kind != Kind::Put {
        return Err("a delete".to_owned());
    }
    if op.baseline || op.horizon.is_some() || op.emission.is_some() {
        return Err("a baseline".to_owned());
    }
    if op.at.device != sender {
        return Err("a change stamped by another device".to_owned());
    }
    if op.uid.is_empty() {
        return Err("a change to a row with no name".to_owned());
    }
    let (identity, root_allowed): (&[&str], bool) = match op.table.as_str() {
        "collection_entries" => (&COLLECTION_FIELDS, false),
        "wishlist_entries" => (&WISHLIST_FIELDS, true),
        other => return Err(format!("a change to {other}")),
    };
    match (op.counters.len(), op.counters.get("quantity")) {
        (1, Some(n)) if (1..=MAX_QUANTITY).contains(n) => {}
        _ => return Err(format!("a count other than 1 to {MAX_QUANTITY} copies")),
    }
    for (key, value) in &op.fields {
        if !identity.contains(&key.as_str()) {
            return Err(format!("a change to {key}"));
        }
        let fine = match (key.as_str(), value) {
            ("finish", serde_json::Value::String(f)) => FINISHES.contains(&f.as_str()),
            ("preferred_finish", serde_json::Value::Null) => true,
            ("preferred_finish", serde_json::Value::String(f)) => FINISHES.contains(&f.as_str()),
            ("finish" | "preferred_finish", _) => false,
            (_, serde_json::Value::String(s)) => !s.is_empty(),
            _ => false,
        };
        if !fine {
            return Err(format!("a {key} that is not a card's"));
        }
    }
    match (op.parents.len(), op.parents.get("folder")) {
        (1, Some(Some(uid))) if !uid.is_empty() => Ok(()),
        (1, Some(None)) if root_allowed => Ok(()),
        _ => Err("a change filed somewhere other than a folder".to_owned()),
    }
}

// ---------------------------------------------------------------------------------------
// The emitter
// ---------------------------------------------------------------------------------------

/// [`emit`] on a device that is not an `add` member.
pub const NOT_AN_ADD_MEMBER: &str = "This device may not add cards to its group.";
/// [`emit`] given a count off the allow-list.
pub const BAD_QUANTITY: &str = "A card is added 1 to 99 copies at a time.";
/// [`emit`] given a finish that is not a printing's.
pub const BAD_FINISH: &str = "A card's finish is nonfoil, foil or etched.";
/// [`emit`] given a printing or a card it cannot name.
pub const BAD_CARD: &str = "That card could not be named well enough to add.";
/// [`emit`] given a collection folder that is not here, or not one of the reader's own.
pub const NOT_YOUR_FOLDER: &str =
    "That folder is not one of yours any more, so nothing can be added to it.";
/// [`emit`] given a wishlist folder that is not here.
pub const NO_SUCH_WISHLIST_FOLDER: &str = "That wishlist folder is not here any more.";
/// The outbox refused [`emit`]'s insert: the capture-off trigger has no [`EMITTING`] exception
/// ([`CAPTURE_OFF`]), or this device is in no group.
pub const CAPTURE_REFUSED: &str =
    "This device's outbox did not take the add, so it was not made. Nothing was sent.";
/// [`emit`]'s op went through the guarded path and wrote nothing here.
pub const NOT_APPLIED: &str = "The add could not be applied on this device, so it was not made.";

/// **Make one add**: build the one `Put` the allow-list accepts, write it to this device's
/// outbox, and apply it here through the receivers' guarded path (`apply::apply_own`) — so the
/// bot's own reads agree with every other device's. Answers the `sync_uid` of the row it landed
/// on. Inside one savepoint: a refusal anywhere leaves the outbox and the tables as they were.
///
/// **Refused, in one sentence**, unless this device's own capability is [`roster::ADD`]
/// ([`NOT_AN_ADD_MEMBER`]), the add is one the allow-list takes ([`BAD_QUANTITY`],
/// [`BAD_FINISH`], [`BAD_CARD`]), and its folder is one the guards accept — for the collection,
/// a `kind = 'user'` folder here ([`NOT_YOUR_FOLDER`]); for the wishlist, a folder here or the
/// root ([`NO_SUCH_WISHLIST_FOLDER`]).
///
/// # Which row it names
///
/// **A row this device already holds at the add's grain is named by its own uid**, and the op
/// is an increment: no fields, the counter and the folder. Otherwise the op is a create under a
/// fresh uid, carrying the card's identity. The grain is the table's with every term an add does
/// not carry at its column's default — the grain the row the add would build sits on, and the
/// one every receiver matches it on (`apply`'s `restricted_grain`). **The increment is the
/// convergent shape**: an add to a row a reader deletes concurrently is then a contest on one
/// uid, which the reader's delete wins on every device (`merge::Ranks`), where a fresh uid that
/// met the row on some devices and not on others would leave the group holding two answers.
///
/// # The stamp
///
/// The op is stamped as capture stamps — `max(sync_clock, wall)` and the counter after it, by the
/// same SQL (`capture::STAMP_MS`, `capture::STAMP_CTR`) — and `sync_ops_clock` moves the clock
/// on, so the next add stamps after it.
pub fn emit(conn: &Connection, add: &Add) -> Result<String, String> {
    let cap = roster::self_capability(conn).map_err(|e| e.to_string())?;
    if cap.as_deref() != Some(roster::ADD) {
        return Err(NOT_AN_ADD_MEMBER.to_owned());
    }
    let me: String = conn
        .query_row(
            "SELECT device_id FROM sync_identity WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let (table, fields, quantity, folder) = shape(conn, add)?;
    let existing = held_at_the_grain(conn, add)?;
    let (uid, fields) = match existing {
        Some(uid) => (uid, BTreeMap::new()),
        None => (fresh_uid(), fields),
    };
    let mut op = Op {
        table: table.to_owned(),
        uid,
        kind: Kind::Put,
        fields,
        counters: BTreeMap::from([("quantity".to_owned(), quantity)]),
        parents: BTreeMap::from([("folder".to_owned(), folder)]),
        at: crate::sync_engine::hlc::Hlc {
            ms: 0,
            ctr: 0,
            device: me.clone(),
        },
        baseline: false,
        horizon: None,
        schema: None,
        emission: None,
    };
    allowed(&me, std::slice::from_ref(&op)).map_err(|_| BAD_CARD.to_owned())?;

    crate::db::in_savepoint(conn, "integration_add_emit", || {
        let json = |v: serde_json::Value| v.to_string();
        conn.execute(
            "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?1, '1')",
            [EMITTING],
        )
        .map_err(|e| e.to_string())?;
        let inserted = conn
            .execute(
                &format!(
                    "INSERT INTO sync_ops
                         (tbl, uid, kind, fields, counters, parents, hlc_ms, hlc_ctr, device_id)
                     SELECT ?1, ?2, 'put', ?3, ?4, ?5, {}, {}, i.device_id
                       FROM sync_clock c, sync_identity i, sync_group g",
                    capture::STAMP_MS,
                    capture::STAMP_CTR
                ),
                params![
                    op.table,
                    op.uid,
                    json(serde_json::to_value(&op.fields).map_err(|e| e.to_string())?),
                    json(serde_json::to_value(&op.counters).map_err(|e| e.to_string())?),
                    json(serde_json::to_value(&op.parents).map_err(|e| e.to_string())?),
                ],
            )
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM sync_state WHERE key = ?1", [EMITTING])
            .map_err(|e| e.to_string())?;
        if inserted != 1 {
            return Err(CAPTURE_REFUSED.to_owned());
        }
        let seq = conn.last_insert_rowid();
        op.at = conn
            .query_row(
                &format!("{} WHERE seq = ?1", capture::OPS_SELECT),
                [seq],
                capture::op_from_row,
            )
            .map_err(|e| e.to_string())?
            .1
            .at;
        let report = apply::apply_own(conn, &op)?;
        if report.applied == 0 {
            return Err(NOT_APPLIED.to_owned());
        }
        landed_on(conn, &op)
    })
}

/// The table, the identity fields, the count and the folder of `add` — after every check that
/// needs no other row but the folder's.
type Shape = (
    &'static str,
    BTreeMap<String, serde_json::Value>,
    i64,
    Option<String>,
);

fn shape(conn: &Connection, add: &Add) -> Result<Shape, String> {
    let text = |s: &str| serde_json::Value::String(s.to_owned());
    match add {
        Add::Collection(c) => {
            check_quantity(c.quantity)?;
            if !FINISHES.contains(&c.finish.as_str()) {
                return Err(BAD_FINISH.to_owned());
            }
            let kind: Option<String> = conn
                .query_row(
                    "SELECT kind FROM collection_folders WHERE sync_uid = ?1",
                    [&c.folder_uid],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if kind.as_deref() != Some(crate::collection_folders::USER_KIND) {
                return Err(NOT_YOUR_FOLDER.to_owned());
            }
            let fields = BTreeMap::from([
                ("card_id".to_owned(), text(&c.card_id)),
                ("set_code".to_owned(), text(&c.set_code)),
                ("collector_number".to_owned(), text(&c.collector_number)),
                ("lang".to_owned(), text(&c.lang)),
                ("finish".to_owned(), text(&c.finish)),
            ]);
            Ok((
                "collection_entries",
                fields,
                c.quantity,
                Some(c.folder_uid.clone()),
            ))
        }
        Add::Wishlist(w) => {
            check_quantity(w.quantity)?;
            if w.preferred_finish
                .as_deref()
                .is_some_and(|f| !FINISHES.contains(&f))
            {
                return Err(BAD_FINISH.to_owned());
            }
            if let Some(folder) = &w.folder_uid {
                let here: Option<i64> = conn
                    .query_row(
                        "SELECT id FROM wishlist_folders WHERE sync_uid = ?1",
                        [folder],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                if here.is_none() {
                    return Err(NO_SUCH_WISHLIST_FOLDER.to_owned());
                }
            }
            let mut fields = BTreeMap::from([
                ("oracle_id".to_owned(), text(&w.oracle_id)),
                ("name".to_owned(), text(&w.name)),
            ]);
            if let Some(p) = &w.printing {
                fields.insert("card_id".to_owned(), text(&p.card_id));
                fields.insert("set_code".to_owned(), text(&p.set_code));
                fields.insert("collector_number".to_owned(), text(&p.collector_number));
                fields.insert("lang".to_owned(), text(&p.lang));
            }
            if let Some(f) = &w.preferred_finish {
                fields.insert("preferred_finish".to_owned(), text(f));
            }
            Ok(("wishlist_entries", fields, w.quantity, w.folder_uid.clone()))
        }
    }
}

fn check_quantity(n: i64) -> Result<(), String> {
    if (1..=MAX_QUANTITY).contains(&n) {
        Ok(())
    } else {
        Err(BAD_QUANTITY.to_owned())
    }
}

/// The uid of the row this device holds at `add`'s grain, every term an add does not carry at
/// its column's default — `apply`'s collection and wishlist grains, spelt with those defaults.
fn held_at_the_grain(conn: &Connection, add: &Add) -> Result<Option<String>, String> {
    match add {
        Add::Collection(c) => conn
            .query_row(
                "SELECT sync_uid FROM collection_entries
                  WHERE card_id = ?1 AND finish = ?2 AND condition = 'NONE' AND lang = ?3
                    AND altered = 0 AND signed = 0 AND proxy = 0 AND misprint = 0
                    AND coalesce(serial_number, '') = '' AND coalesce(grading, '') = ''
                    AND coalesce(folder_id, 0) = coalesce(
                        (SELECT id FROM collection_folders WHERE sync_uid = ?4), 0)
                    AND sync_uid IS NOT NULL",
                params![c.card_id, c.finish, c.lang, c.folder_uid],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string()),
        Add::Wishlist(w) => conn
            .query_row(
                "SELECT sync_uid FROM wishlist_entries
                  WHERE coalesce(oracle_id, '') = coalesce(?1, '')
                    AND coalesce(card_id, '') = coalesce(?2, '')
                    AND coalesce(preferred_finish, '') = coalesce(?3, '')
                    AND coalesce(folder_id, 0) = coalesce(
                        (SELECT id FROM wishlist_folders WHERE sync_uid = ?4), 0)
                    AND sync_uid IS NOT NULL",
                params![
                    w.oracle_id,
                    w.printing.as_ref().map(|p| p.card_id.as_str()),
                    w.preferred_finish,
                    w.folder_uid
                ],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string()),
    }
}

/// A new row's name, as the capture trigger mints one: 32 lowercase hex characters.
fn fresh_uid() -> String {
    crypto::random_bytes::<16>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The uid the row an applied `op` landed on wears: its own, or the one a grain match merged it
/// into.
fn landed_on(conn: &Connection, op: &Op) -> Result<String, String> {
    let here: Option<String> = conn
        .query_row(
            &format!("SELECT sync_uid FROM {} WHERE sync_uid = ?1", op.table),
            [&op.uid],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match here {
        Some(uid) => Ok(uid),
        None => emission::survivor(conn, &op.table, &op.uid)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| NOT_APPLIED.to_owned()),
    }
}

// ---------------------------------------------------------------------------------------
// The folder
// ---------------------------------------------------------------------------------------

/// The `sync_uid` of the folder a collection add goes to when none is named: the top-level
/// `kind = 'user'` collection folder named [`ADDED_FROM_DISCORD`] — case-insensitively, so a
/// reader's rename to *added from discord* keeps it — the oldest if several.
pub fn default_folder(conn: &Connection) -> rusqlite::Result<Option<String>> {
    Ok(conn
        .query_row(
            &format!("SELECT sync_uid {ADDED_FOLDER}"),
            [ADDED_FROM_DISCORD],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// **Make [`ADDED_FROM_DISCORD`] if it is absent** — the desktop's call on enable, inside its
/// write and before the enroll, so the bot has a folder to add to from its first command. A full
/// device's write, so **capture is on**: the folder reaches every device, the bot included, as
/// any folder a reader makes does (`collection_folders::create_folder`, a top-level `user`
/// folder). Answers its local id — the existing one's when there is one ([`default_folder`]'s
/// rule).
pub fn ensure_added_folder(conn: &Connection) -> rusqlite::Result<i64> {
    let held: Option<i64> = conn
        .query_row(
            &format!("SELECT id {ADDED_FOLDER}"),
            [ADDED_FROM_DISCORD],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = held {
        return Ok(id);
    }
    crate::collection_folders::create_folder(conn, None, ADDED_FROM_DISCORD)
        .map(|folder| folder.id)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))
}

/// The `FROM … WHERE … ORDER BY` both of the above read the folder with.
const ADDED_FOLDER: &str = "FROM collection_folders
     WHERE parent_id IS NULL AND kind = 'user' AND name = ?1 COLLATE NOCASE
     ORDER BY created_at, id LIMIT 1";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::hlc::Hlc;
    use crate::sync_pair::identity;
    use serde_json::json;

    fn add_op(table: &str, fields: serde_json::Value, quantity: i64) -> Op {
        Op {
            table: table.to_owned(),
            uid: "u1".to_owned(),
            kind: Kind::Put,
            fields: fields
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            counters: BTreeMap::from([("quantity".to_owned(), quantity)]),
            parents: BTreeMap::from([("folder".to_owned(), Some("f1".to_owned()))]),
            at: Hlc {
                ms: 1,
                ctr: 0,
                device: "bot".to_owned(),
            },
            baseline: false,
            horizon: None,
            schema: None,
            emission: None,
        }
    }

    fn collection_create() -> Op {
        add_op(
            "collection_entries",
            json!({"card_id": "c", "set_code": "lea", "collector_number": "1",
                   "lang": "en", "finish": "foil"}),
            2,
        )
    }

    #[test]
    fn the_allow_list_takes_a_create_and_an_increment() {
        assert_eq!(allowed("bot", &[collection_create()]), Ok(()));
        let increment = add_op("collection_entries", json!({}), 1);
        assert_eq!(allowed("bot", &[increment]), Ok(()));
        let mut wish = add_op(
            "wishlist_entries",
            json!({"oracle_id": "o", "name": "Bolt", "preferred_finish": null}),
            99,
        );
        wish.parents.insert("folder".into(), None);
        assert_eq!(allowed("bot", &[wish]), Ok(()));
    }

    /// ⚠ **Every shape off the list is refused** — and one such op refuses the whole batch.
    #[test]
    fn the_allow_list_refuses_everything_else() {
        type Bend = fn(&mut Op);
        let cases: [(&str, Bend); 16] = [
            ("delete", |op| op.kind = Kind::Del),
            ("baseline", |op| op.baseline = true),
            ("horizon", |op| op.horizon = Some(Default::default())),
            ("foreign stamp", |op| op.at.device = "desk".into()),
            ("table", |op| op.table = "decks".into()),
            ("zero", |op| {
                op.counters.insert("quantity".into(), 0);
            }),
            ("hundred", |op| {
                op.counters.insert("quantity".into(), 100);
            }),
            ("negative", |op| {
                op.counters.insert("quantity".into(), -1);
            }),
            ("second counter", |op| {
                op.counters.insert("tradelist_quantity".into(), 1);
            }),
            ("no counter", |op| op.counters.clear()),
            ("notes", |op| {
                op.fields.insert("notes".into(), json!("mine now"));
            }),
            ("condition", |op| {
                op.fields.insert("condition".into(), json!("NM"));
            }),
            ("finish", |op| {
                op.fields.insert("finish".into(), json!("gold"));
            }),
            ("root", |op| {
                op.parents.insert("folder".into(), None);
            }),
            ("second parent", |op| {
                op.parents.insert("deck".into(), Some("d".into()));
            }),
            ("no parent", |op| op.parents.clear()),
        ];
        for (what, bend) in cases {
            let mut op = collection_create();
            bend(&mut op);
            assert!(allowed("bot", &[op.clone()]).is_err(), "{what}");
            assert!(
                allowed("bot", &[collection_create(), op]).is_err(),
                "{what}: one op off the list refuses the batch"
            );
        }
        let too_many: Vec<Op> = (0..=ADD_OPS_PER_ENVELOPE)
            .map(|_| collection_create())
            .collect();
        assert!(allowed("bot", &too_many).is_err());
        assert!(allowed("bot", &too_many[..ADD_OPS_PER_ENVELOPE]).is_ok());
        assert!(allowed("bot", &[]).is_err());
    }

    /// The JSON shape the bot's proposal keeps: a `table` tag beside camelCase fields.
    #[test]
    fn an_add_is_tagged_by_its_table() {
        let add = Add::Wishlist(WishlistAdd {
            oracle_id: "o".into(),
            name: "Lightning Bolt".into(),
            printing: None,
            preferred_finish: None,
            quantity: 1,
            folder_uid: None,
        });
        let text = serde_json::to_value(&add).unwrap();
        assert_eq!(text["table"], json!("wishlist"));
        assert_eq!(text["oracleId"], json!("o"));
        assert_eq!(serde_json::from_value::<Add>(text).unwrap(), add);
    }

    /// A database with capture installed, as every opened one has: its inserts mint uids.
    fn db() -> Connection {
        let conn = crate::schema::memory_pair();
        capture::install(&conn).unwrap();
        conn
    }

    #[test]
    fn the_added_folder_is_made_once_and_found_case_insensitively() {
        let conn = db();
        assert_eq!(default_folder(&conn).unwrap(), None);
        let id = ensure_added_folder(&conn).unwrap();
        assert_eq!(ensure_added_folder(&conn).unwrap(), id);
        let uid: String = conn
            .query_row(
                "SELECT sync_uid FROM collection_folders WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(default_folder(&conn).unwrap(), Some(uid.clone()));
        conn.execute(
            "UPDATE collection_folders SET name = 'added FROM discord' WHERE id = ?1",
            [id],
        )
        .unwrap();
        assert_eq!(default_folder(&conn).unwrap(), Some(uid));
        assert_eq!(ensure_added_folder(&conn).unwrap(), id);
    }

    /// A folder of that name inside another, or one the app owns, is not the default.
    #[test]
    fn only_a_top_level_user_folder_is_the_default() {
        let conn = db();
        let outer = crate::collection_folders::create_folder(&conn, None, "Binders").unwrap();
        crate::collection_folders::create_folder(&conn, Some(outer.id), ADDED_FROM_DISCORD)
            .unwrap();
        assert_eq!(default_folder(&conn).unwrap(), None);
    }

    /// ⚠ **Only an `add` member emits**: a full device, and a `read` one, are refused before
    /// anything is written.
    #[test]
    fn emit_refuses_a_device_that_may_not_add() {
        let conn = db();
        let me = identity::ensure(&conn).unwrap();
        identity::create_group(&conn, &me).unwrap();
        let folder = ensure_added_folder(&conn).unwrap();
        let folder_uid: String = conn
            .query_row(
                "SELECT sync_uid FROM collection_folders WHERE id = ?1",
                [folder],
                |r| r.get(0),
            )
            .unwrap();
        let add = Add::Collection(CollectionAdd {
            card_id: "c".into(),
            set_code: "lea".into(),
            collector_number: "1".into(),
            lang: "en".into(),
            finish: "nonfoil".into(),
            quantity: 1,
            folder_uid,
        });
        let before: i64 = conn
            .query_row("SELECT count(*) FROM sync_ops", [], |r| r.get(0))
            .unwrap();
        assert_eq!(emit(&conn, &add), Err(NOT_AN_ADD_MEMBER.to_owned()));
        roster::restrict(&conn, &me.device_id, roster::READ).unwrap();
        assert_eq!(emit(&conn, &add), Err(NOT_AN_ADD_MEMBER.to_owned()));
        let after: i64 = conn
            .query_row("SELECT count(*) FROM sync_ops", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);
    }
}
