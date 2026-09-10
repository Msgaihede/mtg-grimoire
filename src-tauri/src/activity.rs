//! What the reader has done to the collection and the wishlist — the log, and the feed over it
//! and [`crate::deck_audit`].
//!
//! **This module is [`crate::deck_audit`] with a _scope_ where that one has a deck**, and it
//! inherits that file's whole design argument rather than restating a version of it. The three
//! decisions below are the ones that go wrong if they are reversed, and each is that module's
//! own:
//!
//! * **[`record`] is called inside the caller's transaction and never opens its own.** An
//!   activity row that committed while the change it describes rolled back is a history that
//!   lies — and it lies in the one direction a reader cannot check, because the row it names is
//!   not there to disagree with it. Every write site records inside the transaction of the
//!   change it describes, which is why this takes `&Connection` rather than `&Transaction`:
//!   `Transaction` derefs to it, so `record(&tx, …)` is the call at every site, exactly as
//!   `deck_audit::record(&tx, …)` is.
//! * **Rust records facts; TypeScript writes the sentence.** That is why [`payload`] is JSON and
//!   why there is no `summary` column: a sentence is domain logic (CLAUDE.md's boundary), it
//!   changes with the wording and with the reader's language, and a table that stored one would
//!   be a table full of the phrasing of whichever release wrote each row.
//!   `src/features/home/activityText.ts` is the **only** reader of `payload`; nothing here parses
//!   one, branches on one, or knows what any key in one means. `payload` is stored verbatim and
//!   handed back verbatim, and `a_payload_is_stored_verbatim_and_this_module_never_reads_it` is
//!   what says so.
//! * **A change that already writes a `deck_audit` row writes no `activity` row.** One event, one
//!   line — which is what keeps `crate::collection_alloc`'s deck-boundary writes out of the feed
//!   twice. The table's own `CHECK (scope IN ('collection','wishlist'))` is that rule made
//!   unbreakable: there is no `'deck'` scope to write, because a deck line **is** a `deck_audit`
//!   row and [`recent`] reads it from there.
//!
//! # Two more rules that are this module's own
//!
//! * **A bulk operation records one row carrying its count in the payload.** An import of 5 000
//!   cards must not write 5 000 lines — that is a feed nobody can read and a table that grows by
//!   a megabyte a session.
//! * **It is pruned** ([`prune`], at launch, from `maintenance.rs`): rows beyond the newest
//!   [`KEEP`] go. `deck_audit` has never needed a pruner because a deck a person has actually
//!   built is hundreds of rows; a collection log is not bounded that way.
//!
//! # It is not synced, and that is an asymmetry rather than an oversight
//!
//! `activity` is **not** in [`crate::schema::SYNCED_TABLES`] and carries no `sync_uid`.
//! `deck_audit` is — so in a paired group the deck lines in the feed arrive from every device and
//! the collection lines are this one's. Teaching the sync capture layer a new table means a
//! `sync_uid`, a capture trigger and a place in the sync spec's §7.3 five rules, and an
//! append-only log is the shape those rules have the least to say about. Recorded as a known
//! consequence and a follow-up; `docs/superpowers/specs/2026-09-10-home-page-design.md` §7 is
//! where it is argued.
//!
//! [`payload`]: ActivityEntry::payload

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::{params, Connection};
use serde::Serialize;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The two scopes an `activity` row can carry, which are the two the table's CHECK admits.
///
/// **There is no `"deck"` here on purpose.** A deck line in the feed is a `deck_audit` row, read
/// through [`recent`]'s `UNION ALL` and wearing the scope `deck` that query supplies — see
/// [`SCOPE_DECK`]. Adding a third word to this array would need the CHECK rebuilt and would put
/// the same event in the feed twice.
pub const SCOPES: [&str; 2] = ["collection", "wishlist"];

/// The reader's binder.
pub const COLLECTION: &str = SCOPES[0];
/// The reader's shopping list.
pub const WISHLIST: &str = SCOPES[1];

/// The scope [`recent`] stamps on a `deck_audit` row, and a word no `activity` row may hold.
///
/// It is spelled in the SQL as well, which is one string in two places and the smallest such
/// pair in this module; `the_deck_scope_constant_is_the_word_the_query_stamps` walks it.
pub const SCOPE_DECK: &str = "deck";

/// The eight kinds, named rather than spelled at every write site.
///
/// The CHECK on `activity.kind` was built from this list, which is why
/// `every_scope_and_kind_this_module_names_is_one_the_table_accepts` drives each of them through
/// a real insert: a word here that drifted from the DDL would be a runtime constraint failure at
/// the first write of that kind rather than a compile error. Wider than `deck_audit`'s nine in
/// one direction (`import`, `clear`) and narrower in another (no `swap`, `label`, `category` or
/// `deck` — those are facts about a deck's list).
///
/// **What each one means to a reader is not decided here.** `activityText.ts` words them, and a
/// kind this build has never heard of is that file's problem to degrade over, never this one's to
/// refuse — the CHECK is a fence against a *refactor*, not a vocabulary about widgets.
pub const KINDS: [&str; 8] = [
    "add", "remove", "quantity", "move", "edit", "folder", "import", "clear",
];

/// Copies came in.
pub const ADD: &str = KINDS[0];
/// Copies went out.
pub const REMOVE: &str = KINDS[1];
/// The count changed without the row coming or going.
pub const QUANTITY: &str = KINDS[2];
/// The row changed folder.
pub const MOVE: &str = KINDS[3];
/// A field on the row changed.
pub const EDIT: &str = KINDS[4];
/// A folder itself was made, renamed, moved or deleted.
pub const FOLDER: &str = KINDS[5];
/// A bulk load — **one row, with its counts in the payload**.
pub const IMPORT: &str = KINDS[6];
/// A bulk wipe — one row, for [`IMPORT`]'s reason.
pub const CLEAR: &str = KINDS[7];

/// Most feed a page will ask for at once, and the ceiling on what it may ask for.
///
/// `deck_audit::MAX_LIMIT`'s twin and the same number, for the same two reasons. A cap rather
/// than a page cursor because the home page shows the most recent day or two — and, at the other
/// end, the clamp is what keeps a `0` from meaning *no limit at all*, which is exactly what
/// SQLite reads a negative `LIMIT` as. [`recent`] clamps to `1..=MAX_LIMIT`.
pub const MAX_LIMIT: u32 = 500;

/// How many `activity` rows survive a [`prune`].
///
/// Five thousand is roughly a year of ordinary use and a few sessions of unusual use. The table
/// is append-only and one row is on the order of a hundred bytes, so what this buys is a file
/// that cannot grow without bound while holding far more history than the page ever draws.
pub const KEEP: usize = 5000;

/// One recorded change, as the home page's feed reads it.
///
/// **Both tables' rows arrive as this shape**, which is what [`recent`]'s `UNION ALL` is for:
/// `deck_id` is `Some` on a `deck_audit` row and `None` on every `activity` one, and `scope` is
/// what tells a reader which it is holding.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    /// The row's id **in its own table**, which is not unique across the feed — see [`recent`].
    pub id: i64,
    /// Unix seconds, from SQLite's own `unixepoch()` — the same clock every `created_at` and
    /// `updated_at` in this schema is written from, so the feed and the rows it describes can be
    /// compared without a timezone in between. Grouping these into *local* calendar days is the
    /// page's job (`auditDays`, reused), and slicing them off an ISO string files a change made
    /// at 23:30 under tomorrow.
    pub at: i64,
    /// One of [`SCOPES`], or [`SCOPE_DECK`] on a row that came from `deck_audit`.
    /// **TypeScript owns the union**; Rust stores strings.
    pub scope: String,
    /// One of [`KINDS`] on an `activity` row, or one of `crate::schema::AUDIT_KINDS` on a deck
    /// one — two vocabularies under one column, told apart by [`Self::scope`].
    pub kind: String,
    /// The deck a `deck_audit` row belongs to. **`None` on every `activity` row**, which is what
    /// [`recent`]'s `NULL AS deck_id` supplies.
    pub deck_id: Option<i64>,
    /// The printing this is about, or `None` — a bulk import is about no one card. Soft, like
    /// every card id in a user table: the printing can leave `cards` and the row still reads.
    pub card_id: Option<String>,
    /// The card's name **as it was at the time**, denormalised for [`Self::card_id`]'s reason at
    /// one remove — a line that can only say `e7f8…` once the id stops resolving is not a line.
    pub card_name: Option<String>,
    /// JSON, and the whole of what happened. **Read it in TypeScript.** Nothing in this module
    /// parses it, and the round trip is byte-for-byte.
    pub payload: String,
    /// Signed copies, for the day header's `+7 / −6` roll-up: `+n` when copies came in, `−n`
    /// when they went out, the difference on a quantity change, and `0` on everything that
    /// changed no count — a move between folders, a field edit, a folder rename. A roll-up that
    /// counted a move would double a card that only ever changed drawer.
    pub delta: i64,
}

/// Write one feed row, inside the transaction the caller already opened.
///
/// **Never opens a transaction of its own**, for the reason at the top of this file, and takes
/// `&Connection` rather than `&Transaction` because `Transaction` derefs to it — so
/// `record(&tx, …)` is the call at every site.
///
/// `at` is `unixepoch()`, the clock every other timestamp in this schema is written from.
///
/// `payload` is written with `serde_json::Value::to_string` and **never inspected**. What shape
/// it should have per kind is a contract between the write site and
/// `src/features/home/activityText.ts`; this function is not a party to it, which is the whole
/// of why a sentence can be reworded without a migration.
///
/// It answers `()`. `deck_audit::record` answers the id of the row it wrote because
/// `deck_undo::record_step` keys its journal on that id; nothing keys on an `activity` row, and
/// an id nobody reads is an invitation to build something that depends on it.
pub fn record(
    conn: &Connection,
    scope: &str,
    kind: &str,
    card_id: Option<&str>,
    card_name: Option<&str>,
    payload: &serde_json::Value,
    delta: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO activity (at, scope, kind, card_id, card_name, payload, delta)
         VALUES (unixepoch(), ?1, ?2, ?3, ?4, ?5, ?6)",
        params![scope, kind, card_id, card_name, payload.to_string(), delta],
    )?;
    Ok(())
}

/// Drop every `activity` row past the newest [`KEEP`], and answer how many went.
///
/// Called at launch from `maintenance.rs`. **It touches `deck_audit` not at all** — that table is
/// per deck, cascades away with the deck it describes, and a deck a person has actually built is
/// hundreds of rows; this one grows with every press for as long as the app is used.
///
/// ⚠️ **`NOT IN` over a set containing NULL is true for nothing, and this is the case where that
/// cannot happen.** `activity.id` is `INTEGER PRIMARY KEY`, so it is the rowid: never NULL, on
/// any row, by the storage engine's own rules. The subquery therefore yields a NULL-free set and
/// the `NOT IN` means what it reads as. The footgun is real elsewhere in this crate — it is
/// written down here precisely so the next reader does not have to re-derive that this site is
/// safe, and so that a future column change that made `id` nullable would meet this paragraph.
///
/// [`KEEP`] is **bound** rather than spelled into the statement, so the number lives in one
/// place; SQLite plans a bound `LIMIT` exactly as it plans a literal one.
pub fn prune(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM activity
          WHERE id NOT IN (SELECT id FROM activity ORDER BY at DESC, id DESC LIMIT ?1)",
        params![KEEP as i64],
    )
}

/// The nine columns an [`ActivityEntry`] is, from both tables, newest first.
///
/// ⚠️ **The `id`s collide across `activity` and `deck_audit`, and that is fine.** Nothing joins
/// on them, nothing looks a row up by one, and the frontend keys a feed row on `scope` **plus**
/// `id` — which is unique, because a row's scope says which table it came from. Do not "fix"
/// this by offsetting one table's ids, hashing them, or adding a synthetic key: every one of
/// those makes the id stop being the row's own id, which is the only thing it is good for.
///
/// `id DESC` after `at DESC` is not decoration: `unixepoch()` has one-second resolution and a
/// single press can write two rows inside it — an import records its row in the same second as
/// the change beside it. Without the tiebreaker the order inside a second is whatever the
/// planner felt like, which is the one ordering a reader would notice and could not explain.
/// `idx_activity_recent` is `(at DESC, id DESC)` and `idx_deck_audit_deck` is
/// `(deck_id, at DESC)`, so neither side is a sort of the whole table.
///
/// `NULL AS deck_id` on the first arm and `'deck' AS scope` on the second are what make the two
/// shapes one shape. A compound `SELECT` takes its result-column names from its **first** arm,
/// which is why the `ORDER BY` below can name `at` and `id` at all.
const FEED_SELECT: &str = "SELECT id, at, scope, kind, NULL AS deck_id, card_id, card_name, payload, delta FROM activity
             UNION ALL
             SELECT id, at, 'deck' AS scope, kind, deck_id, card_id, card_name, payload, delta FROM deck_audit
             ORDER BY at DESC, id DESC LIMIT ?1";

/// One row of [`FEED_SELECT`], in its column order.
fn entry_from_row(r: &rusqlite::Row) -> rusqlite::Result<ActivityEntry> {
    Ok(ActivityEntry {
        id: r.get(0)?,
        at: r.get(1)?,
        scope: r.get(2)?,
        kind: r.get(3)?,
        deck_id: r.get(4)?,
        card_id: r.get(5)?,
        card_name: r.get(6)?,
        payload: r.get(7)?,
        delta: r.get(8)?,
    })
}

/// The feed, newest first — both tables, interleaved by time.
///
/// `limit` is clamped to `1..=`[`MAX_LIMIT`], `deck_audit_list`'s rule and for its reason:
/// **the low end is load-bearing, because SQLite reads a negative `LIMIT` as no limit at all**,
/// and a `0` arriving from a page that had not finished loading its config would otherwise be a
/// full read of every change the reader has ever made.
pub fn recent(conn: &Connection, limit: u32) -> Result<Vec<ActivityEntry>, String> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let mut stmt = conn.prepare(FEED_SELECT).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit], entry_from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The home page's feed. **Read-only** connection, blocking pool — as every read in this app is,
/// so drawing the home page never queues behind a sync.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn activity_recent(
    state: tauri::State<'_, Arc<AppState>>,
    limit: u32,
) -> Result<Vec<ActivityEntry>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || recent(&crate::sync::lock_db_read(&state), limit))
        .await
        .map_err(|e| format!("the activity feed could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A pair with both halves of the feed's tables and one deck for the deck half to hang on.
    ///
    /// `memory_pair` rather than `open_in_memory` plus a hand-written `CREATE TABLE`, for the
    /// reason `schema::memory_pair`'s own doc gives: a test on a hand-built table cannot see a
    /// column the rung actually wrote, and `deck_audit.deck_id` is a real foreign key that
    /// `memory_pair` turns enforcement on for.
    fn conn() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute(
            "INSERT INTO decks (id, name, format_key, created_at, updated_at)
             VALUES (7, 'Burn', 'modern', 0, 0)",
            [],
        )
        .unwrap();
        conn
    }

    /// One `activity` row at an exact second — [`record`] stamps `unixepoch()`, and an ordering
    /// test needs to say when.
    fn activity_at(conn: &Connection, at: i64, kind: &str, name: &str) {
        conn.execute(
            "INSERT INTO activity (at, scope, kind, card_id, card_name, payload, delta)
             VALUES (?1, 'collection', ?2, 'bolt-lea', ?3, '{}', 0)",
            params![at, kind, name],
        )
        .unwrap();
    }

    /// One `deck_audit` row at an exact second, for the same reason.
    fn deck_audit_at(conn: &Connection, at: i64, name: &str) {
        conn.execute(
            "INSERT INTO deck_audit (deck_id, at, variant, kind, card_id, card_name, payload, delta)
             VALUES (7, ?1, 'live', 'add', 'bolt-lea', ?2, '{}', 1)",
            params![at, name],
        )
        .unwrap();
    }

    /// Everything [`record`] was handed comes back, field for field.
    #[test]
    fn a_recorded_row_comes_back_with_its_facts() {
        let conn = conn();
        record(
            &conn,
            COLLECTION,
            ADD,
            Some("bolt-lea"),
            Some("Lightning Bolt"),
            &json!({ "quantity": 3, "folder": "Binder" }),
            3,
        )
        .unwrap();

        let rows = recent(&conn, 10).unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.scope, "collection");
        assert_eq!(row.kind, "add");
        assert_eq!(row.deck_id, None, "an activity row belongs to no deck");
        assert_eq!(row.card_id.as_deref(), Some("bolt-lea"));
        assert_eq!(row.card_name.as_deref(), Some("Lightning Bolt"));
        assert_eq!(row.delta, 3);
        assert!(row.id > 0, "the row keeps its own id");
        assert!(
            row.at > 0,
            "and the clock the rest of the schema is written from"
        );

        // A row about no one card is the other half of the same claim — an import names none.
        record(
            &conn,
            WISHLIST,
            IMPORT,
            None,
            None,
            &json!({ "lines": 105 }),
            0,
        )
        .unwrap();
        let rows = recent(&conn, 10).unwrap();
        let import = rows
            .iter()
            .find(|r| r.kind == "import")
            .expect("the import row is in the feed");
        assert_eq!(import.card_id, None);
        assert_eq!(import.card_name, None);
        assert_eq!(import.scope, "wishlist");
    }

    /// The two tables are one feed, ordered by time and not by which table a row came from.
    ///
    /// Written with alternating seconds precisely so a query that concatenated the two tables
    /// instead of ordering across them would fail: three-then-three passes a `len()` check and
    /// an "are both scopes present" check, and only the strict descent catches it.
    #[test]
    fn the_feed_interleaves_activity_and_deck_audit_newest_first() {
        let conn = conn();
        for (at, name) in [(100, "a1"), (300, "a2"), (500, "a3")] {
            activity_at(&conn, at, ADD, name);
        }
        for (at, name) in [(200, "d1"), (400, "d2"), (600, "d3")] {
            deck_audit_at(&conn, at, name);
        }

        let rows = recent(&conn, 10).unwrap();
        assert_eq!(rows.len(), 6);
        let ats: Vec<i64> = rows.iter().map(|r| r.at).collect();
        assert_eq!(
            ats,
            [600, 500, 400, 300, 200, 100],
            "newest first, across both tables"
        );
        let scopes: Vec<&str> = rows.iter().map(|r| r.scope.as_str()).collect();
        assert_eq!(
            scopes,
            [
                "deck",
                "collection",
                "deck",
                "collection",
                "deck",
                "collection"
            ],
            "and the two tables really do interleave"
        );
    }

    /// `deck_id` is what tells a deck line from a collection one, and the `UNION ALL` supplies
    /// it on one side and a NULL on the other.
    ///
    /// **The colliding ids are asserted here rather than worked around**, because a later reader
    /// who found the collision without this test would be very likely to "fix" it: both tables
    /// start at rowid 1, so a feed of one row from each holds two rows with `id == 1`, and the
    /// page keys on `scope` plus `id`.
    #[test]
    fn a_deck_row_carries_its_deck_id_and_an_activity_row_does_not() {
        let conn = conn();
        activity_at(&conn, 100, ADD, "Lightning Bolt");
        deck_audit_at(&conn, 200, "Lightning Bolt");

        let rows = recent(&conn, 10).unwrap();
        assert_eq!(rows.len(), 2);

        let deck = rows.iter().find(|r| r.scope == "deck").unwrap();
        assert_eq!(deck.deck_id, Some(7), "a deck line names its deck");
        let collection = rows.iter().find(|r| r.scope == "collection").unwrap();
        assert_eq!(
            collection.deck_id, None,
            "and a collection line has no deck to name"
        );

        assert_eq!(
            deck.id, collection.id,
            "the ids collide across the two tables and that is fine: nothing joins on them, \
             and the page keys a row on `scope` plus `id`"
        );
    }

    /// `0` must mean one row, not every row — SQLite reads a negative `LIMIT` as unlimited, and
    /// a clamp that only had a top end would let a `0` through as `LIMIT 0`, which is *no rows*.
    #[test]
    fn the_limit_is_clamped_to_one_through_five_hundred() {
        let conn = conn();
        for at in 1..=600 {
            activity_at(&conn, at, ADD, "Lightning Bolt");
        }

        assert_eq!(recent(&conn, 0).unwrap().len(), 1, "0 means one, never all");
        assert_eq!(recent(&conn, 1).unwrap().len(), 1);
        assert_eq!(recent(&conn, 7).unwrap().len(), 7);
        assert_eq!(
            recent(&conn, 10_000).unwrap().len(),
            MAX_LIMIT as usize,
            "and nothing may ask for more than the cap"
        );
        assert_eq!(recent(&conn, MAX_LIMIT).unwrap().len(), MAX_LIMIT as usize);
    }

    /// The prune keeps exactly the newest [`KEEP`] and leaves the deck log alone.
    #[test]
    fn prune_keeps_the_newest_five_thousand_and_the_deck_log_is_untouched() {
        let conn = conn();
        let tx = conn.unchecked_transaction().unwrap();
        for at in 1..=5_200_i64 {
            activity_at(&tx, at, ADD, "Lightning Bolt");
        }
        for at in 1..=10_i64 {
            deck_audit_at(&tx, at, "Lightning Bolt");
        }
        tx.commit().unwrap();

        let gone = prune(&conn).unwrap();
        assert_eq!(gone, 200, "everything past the newest 5 000");

        let left: i64 = conn
            .query_row("SELECT count(*) FROM activity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, KEEP as i64);
        let oldest: i64 = conn
            .query_row("SELECT min(at) FROM activity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(oldest, 201, "and it is the newest 5 000 that survived");

        let audit: i64 = conn
            .query_row("SELECT count(*) FROM deck_audit", [], |r| r.get(0))
            .unwrap();
        assert_eq!(audit, 10, "the deck log is not this pruner's to touch");

        // Twice is the same as once, and a log under the ceiling loses nothing.
        assert_eq!(prune(&conn).unwrap(), 0);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM activity", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            KEEP as i64
        );
    }

    /// The payload is a string this module carries and does not read.
    ///
    /// Byte-identical, because `activityText.ts` is written against the shapes the write sites
    /// produce and anything this module did to one — reordering keys, dropping a null, folding
    /// a nested object — would be a silent change to a contract it is not a party to.
    #[test]
    fn a_payload_is_stored_verbatim_and_this_module_never_reads_it() {
        let conn = conn();
        let payload = json!({
            "import": { "mode": "merge", "lines": 105, "cards": 117 },
            "folders": ["Binder", "Trade box"],
            "reason": null,
            "nested": { "deep": { "deeper": [1, 2, { "three": true }] } },
            "unicode": "Æther Vial — 100% ✓"
        });
        let want = payload.to_string();

        record(&conn, COLLECTION, IMPORT, None, None, &payload, 117).unwrap();

        let rows = recent(&conn, 10).unwrap();
        assert_eq!(rows[0].payload, want, "byte for byte, out as it went in");

        // And a payload this build has never seen the shape of survives the same way — nothing
        // here validates a key, so a write site may add one without a migration.
        record(
            &conn,
            WISHLIST,
            EDIT,
            None,
            None,
            &json!({ "somethingFromTheFuture": [1, 2, 3] }),
            0,
        )
        .unwrap();
        let rows = recent(&conn, 10).unwrap();
        assert_eq!(rows[0].payload, r#"{"somethingFromTheFuture":[1,2,3]}"#);
    }

    /// Every word this module names is a word the table's CHECK admits.
    ///
    /// `deck_audit::the_kind_constants_are_the_schemas_own`'s job, done through a real insert
    /// rather than against an array: the CHECK lives in the DDL as a literal, so there is no
    /// constant to compare against and the only honest test is to write each word and see. A
    /// misspelling here is otherwise a `CHECK constraint failed: activity` at the first press
    /// that uses that kind, in a command that has nothing to do with the feed.
    #[test]
    fn every_scope_and_kind_this_module_names_is_one_the_table_accepts() {
        let conn = conn();
        for scope in SCOPES {
            for kind in KINDS {
                record(&conn, scope, kind, None, None, &json!({}), 0)
                    .unwrap_or_else(|e| panic!("`{scope}`/`{kind}` must be storable: {e}"));
            }
        }
        assert_eq!(
            recent(&conn, MAX_LIMIT).unwrap().len(),
            SCOPES.len() * KINDS.len()
        );

        // And the one word that must NOT be storable, because a deck line is a `deck_audit` row.
        assert!(
            record(&conn, SCOPE_DECK, ADD, None, None, &json!({}), 0).is_err(),
            "one event, one line: there is no `deck` scope in this table"
        );
    }

    /// The word [`recent`] stamps on a `deck_audit` row is the constant that names it.
    ///
    /// One string in two places — the SQL and [`SCOPE_DECK`] — which is the smallest such pair
    /// in this module and the only one nothing else would catch.
    #[test]
    fn the_deck_scope_constant_is_the_word_the_query_stamps() {
        let conn = conn();
        deck_audit_at(&conn, 100, "Lightning Bolt");
        assert_eq!(recent(&conn, 10).unwrap()[0].scope, SCOPE_DECK);
    }
}
