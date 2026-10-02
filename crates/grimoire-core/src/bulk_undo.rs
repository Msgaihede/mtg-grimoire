//! Taking back one bulk write — a collection or wishlist import, a bulk `Remove from collection`,
//! a bulk `Move to` (issue #555).
//!
//! **A ticket is the rows, not the gesture.** Each of those writes can be described in words
//! ("imported 40 cards"), but none of them can be *reversed* from a description: an import folds
//! onto rows that already existed, a `set` file deletes some and lowers others, a move merges one
//! row into another and deletes the source. So a write that offers an undo snapshots the rows it
//! could touch **inside its own transaction**, before and after, and keeps exactly the rows that
//! differ — their image before (for what it changed or deleted) and after (for what it changed or
//! inserted). Undoing is putting the before-images back, and nothing else: no rule about imports or
//! folders is re-run in reverse, so no rule can be reversed wrongly.
//!
//! **A row image is every column, by name, as `rusqlite` reads it** — `SELECT *` and the
//! statement's own column list, never a hand-written list. A column added to either table next
//! year is carried by a ticket the day it exists; a list here would be a second schema, silently
//! dropping whatever it forgot on the way back.
//!
//! # Refused rather than applied blindly
//!
//! Before anything is written, every after-image must still match the database. A row the reader
//! edited since, a copy a sync brought in, a folder deleted under it — each makes the ticket
//! describe a collection that no longer exists, and putting its before-images back would silently
//! undo that later change too. [`UNDO_STALE`] refuses instead. The comparison skips
//! [`IGNORED`] — bookkeeping the app writes by itself — and nothing else.
//!
//! **Either refusal retires the ticket**, [`UNDO_STALE`] and [`UNDO_GONE`] alike: a stale ticket
//! can only grow staler, and a button that answers the same refusal on every press is worse than
//! one that goes away. An *error* that is not a refusal (a full disk) keeps it.
//!
//! # Held in memory, for the session
//!
//! No table, deliberately. An undo is an offer about the press the reader just made, and a ticket
//! that survived a restart would be an offer about a collection the app has since re-read, synced
//! and re-indexed — exactly the ticket [`UNDO_STALE`] exists to refuse, only later. The store keeps
//! the newest [`CAPACITY`] tickets and evicts the oldest; ids only ever grow, so an evicted id is
//! never handed back to a different write.
//!
//! # A re-inserted row gets a new sync identity
//!
//! A row the write deleted is inserted again with its old `id` where that id is still free, and
//! **with `sync_uid` left NULL**, so `sync_engine::capture`'s insert trigger mints a fresh one. The
//! old uid is already a `del` op in this device's log and may be on the relay: a `put` under the
//! same uid after its own `del` is what `apply` reads as a *resurrection* — add-wins against a
//! delete, flagged for review on the far device with `RESURRECTED`'s sentence about another device
//! deleting it. A new uid is simply a new row, which is what an undone delete is to every other
//! device: they received the delete, and now receive a put that lands on the same grain.

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, ErrorCode, OptionalExtension};
use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};

/// What an undo says about a ticket it does not hold — never issued, taken back already, retired
/// by a refusal, evicted by [`CAPACITY`] newer ones, or lost to a restart.
pub const UNDO_GONE: &str = "That can no longer be undone.";

/// What an undo says when a row the write left has changed since — see the module doc.
pub const UNDO_STALE: &str =
    "Some of those cards have changed since, so this can no longer be undone.";

/// How many tickets the session keeps. The page offers one per list (`src/lib/bulkUndo.ts`), so
/// ten is room for every surface's newest with margin, and small enough that the row images of a
/// few large imports cannot pile up for the length of a session.
pub const CAPACITY: usize = 10;

/// Columns the stale check does not compare and a restore does not write back.
///
/// * `updated_at` moves on every write, including the no-op re-save of a row nobody changed.
/// * `sync_uid` is minted by the capture trigger and **re-pointed by `apply`** when a peer's row
///   lands on this one's grain — bookkeeping about the row's name, not its content.
/// * `needs_review` is written by the reconciler after an ingest (`reconcile::sweep_orphans`) and
///   by `apply`'s resurrection sentence — the app's note about a row, which an undo neither
///   reverts nor may be refused over.
pub const IGNORED: [&str; 3] = ["updated_at", "sync_uid", "needs_review"];

/// The two tables a ticket can be about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Table {
    Collection,
    Wishlist,
}

impl Table {
    fn name(self) -> &'static str {
        match self {
            Table::Collection => "collection_entries",
            Table::Wishlist => "wishlist_entries",
        }
    }

    /// The [`crate::activity`] scope, and the word [`BulkUndoOutcome::scope`] answers — one
    /// vocabulary, so the page's `UndoScope` and the feed's scope cannot disagree.
    fn scope(self) -> &'static str {
        match self {
            Table::Collection => crate::activity::COLLECTION,
            Table::Wishlist => crate::activity::WISHLIST,
        }
    }
}

/// One row, every column in the table's own order.
type Image = Vec<Value>;

/// Rows by id, with the column names they were read under.
struct Rows {
    columns: Vec<String>,
    rows: BTreeMap<i64, Image>,
}

fn read_rows(
    conn: &Connection,
    table: Table,
    filter: &str,
    args: &[Value],
) -> Result<Rows, String> {
    let sql = format!("SELECT * FROM {} WHERE {filter}", table.name());
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
    let id_at = columns
        .iter()
        .position(|c| c == "id")
        .ok_or_else(|| format!("{} has no id column", table.name()))?;
    let mut rows = BTreeMap::new();
    let mut query = stmt
        .query(params_from_iter(args.iter()))
        .map_err(|e| e.to_string())?;
    while let Some(r) = query.next().map_err(|e| e.to_string())? {
        let image: Image = (0..columns.len())
            .map(|i| r.get::<_, Value>(i))
            .collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?;
        let Value::Integer(id) = image[id_at] else {
            return Err(format!("a {} row has no integer id", table.name()));
        };
        rows.insert(id, image);
    }
    Ok(Rows { columns, rows })
}

/// Two images of one row agree on everything but [`IGNORED`].
fn same(columns: &[String], a: &[Value], b: &[Value]) -> bool {
    columns
        .iter()
        .zip(a.iter().zip(b))
        .all(|(c, (x, y))| IGNORED.contains(&c.as_str()) || x == y)
}

/// A list handed to SQL as **one** JSON parameter, for a filter to read through `json_each` —
/// `card_id IN (SELECT value FROM json_each(?1))`. One bound value however long the list, because
/// an import of a large file names more cards than a statement may carry parameters.
pub(crate) fn json_list<T: Serialize>(values: &[T]) -> Value {
    Value::Text(serde_json::to_string(values).unwrap_or_else(|_| "[]".to_owned()))
}

/// The rows a write *could* touch, read before it — the first half of a ticket.
///
/// `filter` is a `WHERE` clause over the table and `args` its parameters, and **the same clause is
/// read again by [`Capture::finish`]**, so it must name every row the write can land on *before*
/// the write runs: a card id list for an import (every row it can fold into or insert is a row of
/// one of its cards), the ids plus their cards' other rows for a move (the merge targets). A row
/// the write reaches that the clause does not name is a row the undo cannot put back.
pub(crate) struct Capture {
    table: Table,
    filter: String,
    args: Vec<Value>,
    before: Rows,
}

impl Capture {
    /// Read the scope. Call it inside the write's transaction, before the first statement.
    pub(crate) fn begin(
        conn: &Connection,
        table: Table,
        filter: &str,
        args: Vec<Value>,
    ) -> Result<Self, String> {
        let before = read_rows(conn, table, filter, &args)?;
        Ok(Capture {
            table,
            filter: filter.to_owned(),
            args,
            before,
        })
    }

    /// Read the scope again, after the last statement and **before the commit**, and keep only
    /// what differs: only-before is a row the write deleted, only-after one it inserted, both but
    /// different one it changed. A row the write re-saved without changing anything outside
    /// [`IGNORED`] is dropped, so an undo never "restores" a row to what it already is.
    pub(crate) fn finish(self, conn: &Connection) -> Result<Changes, String> {
        let after = read_rows(conn, self.table, &self.filter, &self.args)?;
        let columns = self.before.columns;
        if columns != after.columns {
            return Err("the table changed shape during the write".to_owned());
        }
        let differs = |was: Option<&Image>, now: Option<&Image>| match (was, now) {
            (Some(was), Some(now)) => !same(&columns, was, now),
            _ => true,
        };
        let left: BTreeMap<i64, Image> = after
            .rows
            .iter()
            .filter(|(id, now)| differs(self.before.rows.get(id), Some(now)))
            .map(|(id, now)| (*id, now.clone()))
            .collect();
        let before: BTreeMap<i64, Image> = self
            .before
            .rows
            .iter()
            .filter(|(id, was)| differs(Some(was), after.rows.get(id)))
            .map(|(id, was)| (*id, was.clone()))
            .collect();
        Ok(Changes {
            table: self.table,
            columns,
            before,
            after: left,
        })
    }
}

/// What one write changed — the rows a ticket puts back.
pub(crate) struct Changes {
    table: Table,
    columns: Vec<String>,
    /// Rows the write changed or deleted, as they were before it.
    before: BTreeMap<i64, Image>,
    /// Rows the write changed or inserted, as it left them.
    after: BTreeMap<i64, Image>,
}

impl Changes {
    fn is_empty(&self) -> bool {
        self.before.is_empty() && self.after.is_empty()
    }
}

/// The one [`crate::activity`] row a bulk write records, **kept on the ticket** so its undo can
/// record the same line back: the original kind, the original payload plus `"undo": true`, and the
/// delta reversed.
///
/// A struct rather than seven arguments because the write site builds it once and hands it to
/// both halves — [`Feed::record`] inside its transaction and [`register`] after the commit — so
/// the line the feed shows and the line the undo reverses are one value, not two spellings.
pub(crate) struct Feed {
    pub(crate) kind: &'static str,
    pub(crate) card_id: Option<String>,
    pub(crate) card_name: Option<String>,
    pub(crate) payload: serde_json::Value,
    pub(crate) delta: i64,
}

impl Feed {
    /// Record this line, inside the caller's transaction ([`crate::activity::record`]'s rule).
    pub(crate) fn record(&self, conn: &Connection, table: Table) -> Result<(), String> {
        crate::activity::record(
            conn,
            table.scope(),
            self.kind,
            self.card_id.as_deref(),
            self.card_name.as_deref(),
            &self.payload,
            self.delta,
        )
        .map_err(|e| e.to_string())
    }
}

struct Ticket {
    changes: Changes,
    feed: Feed,
}

/// The session's tickets, oldest first.
pub struct Store {
    next: u64,
    tickets: VecDeque<(u64, Ticket)>,
}

impl Store {
    const fn new() -> Self {
        Store {
            next: 1,
            tickets: VecDeque::new(),
        }
    }

    fn push(&mut self, ticket: Ticket) -> u64 {
        let id = self.next;
        self.next += 1;
        self.tickets.push_back((id, ticket));
        self.trim();
        id
    }

    fn trim(&mut self) {
        while self.tickets.len() > CAPACITY {
            self.tickets.pop_front();
        }
    }

    fn take(&mut self, id: u64) -> Option<Ticket> {
        let at = self.tickets.iter().position(|(t, _)| *t == id)?;
        self.tickets.remove(at).map(|(_, t)| t)
    }

    pub fn table_of(&self, id: u64) -> Option<Table> {
        self.tickets
            .iter()
            .find(|(t, _)| *t == id)
            .map(|(_, t)| t.changes.table)
    }

    /// Hand back a ticket an undo took and could not finish for a reason that is not a refusal,
    /// in its place by id — so it is evicted when it would have been, not later.
    fn put_back(&mut self, id: u64, ticket: Ticket) {
        let at = self
            .tickets
            .iter()
            .position(|(t, _)| *t > id)
            .unwrap_or(self.tickets.len());
        self.tickets.insert(at, (id, ticket));
        self.trim();
    }
}

/// The store, behind the one lock the app shares.
///
/// **A thread's own store under `cfg(test)`, and the store's logic is the same either way.** The
/// test harness runs every test on a thread of its own and every import test registers a ticket,
/// so one process-wide store would let a neighbouring test's writes evict the ticket a test is
/// about to undo — a suite that fails by scheduling. The capacity, the ids and the eviction are
/// [`Store`]'s and are exercised identically; only *whose* store it is differs.
#[cfg(not(any(test, feature = "testing")))]
pub fn with_store<R>(f: impl FnOnce(&mut Store) -> R) -> R {
    static STORE: std::sync::Mutex<Store> = std::sync::Mutex::new(Store::new());
    f(&mut crate::db::lock_plain(&STORE))
}

#[cfg(any(test, feature = "testing"))]
pub fn with_store<R>(f: impl FnOnce(&mut Store) -> R) -> R {
    thread_local! {
        static STORE: std::cell::RefCell<Store> = const { std::cell::RefCell::new(Store::new()) };
    }
    STORE.with_borrow_mut(f)
}

/// Keep a committed write's changes as a ticket, and answer its id — or `None` when the write
/// changed nothing, which is the outcome's `undoId: null`.
///
/// **Call it only after the write's transaction has committed.** A ticket registered for a write
/// that then rolled back would put back rows that were never taken away — and delete, as
/// "inserted", rows the reader had all along.
pub(crate) fn register(changes: Changes, feed: Feed) -> Option<u64> {
    if changes.is_empty() {
        return None;
    }
    Some(with_store(|s| s.push(Ticket { changes, feed })))
}

/// How many tickets the store holds — for the tests that assert a rolled-back write left none.
#[cfg(test)]
pub(crate) fn tickets_held() -> usize {
    with_store(|s| s.tickets.len())
}

/// Every row of `table` in id order, every column but [`IGNORED`] — what "the undo put back the
/// exact rows" is compared on in every module's tests.
#[cfg(test)]
pub(crate) fn table_image(conn: &Connection, table: &str) -> Vec<Vec<Value>> {
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {table} ORDER BY id"))
        .unwrap();
    let keep: Vec<usize> = stmt
        .column_names()
        .iter()
        .enumerate()
        .filter(|(_, c)| !IGNORED.contains(c))
        .map(|(i, _)| i)
        .collect();
    stmt.query_map([], |r| keep.iter().map(|&i| r.get::<_, Value>(i)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// What an undo did.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkUndoOutcome {
    /// `collection` or `wishlist` — which list's queries the page refetches.
    pub scope: &'static str,
    /// Rows written back: inserted rows deleted again, changed rows restored, deleted rows
    /// re-inserted.
    pub restored: i64,
}

enum Refusal {
    Stale,
    Failed(String),
}

fn failed(e: impl ToString) -> Refusal {
    Refusal::Failed(e.to_string())
}

/// A constraint the restore ran into is the collection having moved on — a grain someone filled
/// again, a folder that is gone — and is [`UNDO_STALE`]; anything else is an error.
fn stale_or_failed(e: rusqlite::Error) -> Refusal {
    if e.sqlite_error_code() == Some(ErrorCode::ConstraintViolation) {
        Refusal::Stale
    } else {
        failed(e)
    }
}

/// Undo ticket `undo_id` on `conn`, in one transaction — see the module doc for what is refused.
///
/// **The order is delete, restore, re-insert**, so each step frees the grain the next may need:
/// a row the write inserted can sit on the grain a row it deleted is about to come back to, and a
/// changed row is put back before the deleted rows that may once have been folded into it return
/// beside it.
pub fn undo(conn: &Connection, undo_id: u64) -> Result<BulkUndoOutcome, String> {
    let ticket = with_store(|s| s.take(undo_id)).ok_or_else(|| UNDO_GONE.to_owned())?;
    match apply(conn, &ticket) {
        Ok(restored) => Ok(BulkUndoOutcome {
            scope: ticket.changes.table.scope(),
            restored,
        }),
        Err(Refusal::Stale) => Err(UNDO_STALE.to_owned()),
        Err(Refusal::Failed(e)) => {
            with_store(|s| s.put_back(undo_id, ticket));
            Err(e)
        }
    }
}

fn apply(conn: &Connection, ticket: &Ticket) -> Result<i64, Refusal> {
    let Changes {
        table,
        columns,
        before,
        after,
    } = &ticket.changes;
    let name = table.name();
    let tx = conn.unchecked_transaction().map_err(failed)?;

    // 1. Every row the write left must still be what it left — before a single statement runs.
    let one = format!("SELECT * FROM {name} WHERE id = ?1");
    for (id, left) in after {
        let now: Option<Image> = tx
            .query_row(&one, params![id], |r| {
                (0..columns.len()).map(|i| r.get::<_, Value>(i)).collect()
            })
            .optional()
            .map_err(failed)?;
        match now {
            Some(now) if now.len() == left.len() && same(columns, &now, left) => {}
            _ => return Err(Refusal::Stale),
        }
    }

    // 2. What the write inserted goes.
    let mut restored = 0i64;
    for id in after.keys().filter(|id| !before.contains_key(id)) {
        tx.execute(&format!("DELETE FROM {name} WHERE id = ?1"), params![id])
            .map_err(stale_or_failed)?;
        restored += 1;
    }

    // 3. What it changed takes back every column but the row's name and the app's bookkeeping.
    //    Every name quoted, because they come from the table rather than from this file.
    let restorable: Vec<usize> = (0..columns.len())
        .filter(|&i| {
            let c = columns[i].as_str();
            c != "id" && !IGNORED.contains(&c)
        })
        .collect();
    let sets: Vec<String> = restorable
        .iter()
        .enumerate()
        .map(|(n, &i)| format!("\"{}\" = ?{}", columns[i], n + 2))
        .collect();
    let update = format!(
        "UPDATE {name} SET {}, updated_at = unixepoch() WHERE id = ?1",
        sets.join(", ")
    );
    for (id, was) in before.iter().filter(|(id, _)| after.contains_key(id)) {
        let mut args: Vec<&Value> = Vec::with_capacity(restorable.len() + 1);
        let key = Value::Integer(*id);
        args.push(&key);
        args.extend(restorable.iter().map(|&i| &was[i]));
        tx.execute(&update, params_from_iter(args))
            .map_err(stale_or_failed)?;
        restored += 1;
    }

    // 4. What it deleted comes back — under its old id where nothing has taken it, and always
    //    under a fresh `sync_uid` (the module doc says why).
    for (id, was) in before.iter().filter(|(id, _)| !after.contains_key(id)) {
        let taken: bool = tx
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {name} WHERE id = ?1)"),
                params![id],
                |r| r.get(0),
            )
            .map_err(failed)?;
        let keep: Vec<usize> = (0..columns.len())
            .filter(|&i| {
                let c = columns[i].as_str();
                c != "sync_uid" && c != "updated_at" && !(taken && c == "id")
            })
            .collect();
        let cols: Vec<String> = keep
            .iter()
            .map(|&i| format!("\"{}\"", columns[i]))
            .collect();
        let holes: Vec<String> = (1..=keep.len()).map(|n| format!("?{n}")).collect();
        let insert = format!(
            "INSERT INTO {name} ({}, updated_at) VALUES ({}, unixepoch())",
            cols.join(", "),
            holes.join(", ")
        );
        tx.execute(&insert, params_from_iter(keep.iter().map(|&i| &was[i])))
            .map_err(stale_or_failed)?;
        restored += 1;
    }

    // 5. One line saying the press was taken back — its own kind and payload, marked, and the
    //    copies it moved going the other way.
    let feed = &ticket.feed;
    let mut payload = feed.payload.clone();
    if let serde_json::Value::Object(map) = &mut payload {
        map.insert("undo".to_owned(), serde_json::Value::Bool(true));
    }
    Feed {
        kind: feed.kind,
        card_id: feed.card_id.clone(),
        card_name: feed.card_name.clone(),
        payload,
        delta: -feed.delta,
    }
    .record(&tx, *table)
    .map_err(Refusal::Failed)?;
    tx.commit().map_err(failed)?;
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                                rarity,finishes,prices,raw)
             VALUES ('c1','o1','Card One','tst','1','en','normal','common',
                     '[\"nonfoil\"]','{}','{}');",
        )
        .unwrap();
        conn
    }

    fn row(conn: &Connection, quantity: i64, condition: &str) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                (card_id, set_code, collector_number, lang, finish, condition, quantity,
                 created_at, updated_at)
             VALUES ('c1','tst','1','en','nonfoil',?2,?1,0,0) RETURNING id",
            params![quantity, condition],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn quantities(conn: &Connection) -> Vec<(i64, i64)> {
        conn.prepare("SELECT id, quantity FROM collection_entries ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn feed(kind: &'static str) -> Feed {
        Feed {
            kind,
            card_id: None,
            card_name: None,
            payload: serde_json::json!({ "entries": 2 }),
            delta: 3,
        }
    }

    /// One write captured the way the commands do it: every row of `c1`, a change, a delete and
    /// an insert, committed, then registered.
    fn captured_write(conn: &Connection) -> (i64, i64, u64) {
        let keep = row(conn, 2, "NM");
        let gone = row(conn, 1, "LP");
        let tx = conn.unchecked_transaction().unwrap();
        let capture = Capture::begin(
            &tx,
            Table::Collection,
            "card_id IN (SELECT value FROM json_each(?1))",
            vec![json_list(&["c1"])],
        )
        .unwrap();
        tx.execute(
            "UPDATE collection_entries SET quantity = 5, updated_at = 99 WHERE id = ?1",
            params![keep],
        )
        .unwrap();
        // Inserted before the delete, so it cannot take the deleted row's id — a reused id is a
        // *change* to the diff, which `an_id_the_write_reused_is_restored_as_a_change` covers.
        row(&tx, 7, "HP");
        tx.execute(
            "DELETE FROM collection_entries WHERE id = ?1",
            params![gone],
        )
        .unwrap();
        let changes = capture.finish(&tx).unwrap();
        tx.commit().unwrap();
        let id = register(changes, feed(crate::activity::IMPORT)).unwrap();
        (keep, gone, id)
    }

    #[test]
    fn an_undo_puts_back_the_changed_the_deleted_and_removes_the_inserted() {
        let conn = conn();
        let (keep, gone, id) = captured_write(&conn);

        let out = undo(&conn, id).unwrap();

        assert_eq!(out.scope, "collection");
        assert_eq!(
            out.restored, 3,
            "one deleted again, one restored, one re-inserted"
        );
        assert_eq!(quantities(&conn), vec![(keep, 2), (gone, 1)]);
        let line = crate::activity::recent(&conn, 10).unwrap();
        assert_eq!(line.len(), 1);
        assert_eq!(line[0].kind, crate::activity::IMPORT);
        assert_eq!(line[0].delta, -3, "the original delta, reversed");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&line[0].payload).unwrap(),
            serde_json::json!({ "entries": 2, "undo": true })
        );
        assert_eq!(
            undo(&conn, id).unwrap_err(),
            UNDO_GONE,
            "a ticket is consumed by its undo"
        );
    }

    /// SQLite hands a deleted row's id to the next insert when it was the highest, so one write
    /// can delete a row and make another under the same id. The diff reads that as one row
    /// *changed*, and putting every column back restores the deleted row exactly.
    #[test]
    fn an_id_the_write_reused_is_restored_as_a_change() {
        let conn = conn();
        row(&conn, 2, "NM");
        let gone = row(&conn, 1, "LP");
        let found = table_image(&conn, "collection_entries");
        let tx = conn.unchecked_transaction().unwrap();
        let capture = Capture::begin(&tx, Table::Collection, "1", vec![]).unwrap();
        tx.execute(
            "DELETE FROM collection_entries WHERE id = ?1",
            params![gone],
        )
        .unwrap();
        assert_eq!(row(&tx, 7, "HP"), gone, "the id came round again");
        let changes = capture.finish(&tx).unwrap();
        tx.commit().unwrap();
        let id = register(changes, feed(crate::activity::IMPORT)).unwrap();

        assert_eq!(undo(&conn, id).unwrap().restored, 1);
        assert_eq!(table_image(&conn, "collection_entries"), found);
    }

    /// **A re-inserted row comes back under a new sync name** — the old one is a `del` op in this
    /// device's log, and a `put` under it would read on another device as a resurrection.
    #[test]
    fn a_re_inserted_row_is_minted_a_fresh_sync_uid() {
        let conn = conn();
        crate::sync_engine::capture::install(&conn).unwrap();
        let gone = row(&conn, 1, "LP");
        let uid = |c: &Connection| -> Option<String> {
            c.query_row(
                "SELECT sync_uid FROM collection_entries WHERE id = ?1",
                params![gone],
                |r| r.get(0),
            )
            .unwrap()
        };
        let named = uid(&conn).expect("the insert trigger names every row");
        let tx = conn.unchecked_transaction().unwrap();
        let capture = Capture::begin(&tx, Table::Collection, "1", vec![]).unwrap();
        tx.execute(
            "DELETE FROM collection_entries WHERE id = ?1",
            params![gone],
        )
        .unwrap();
        let changes = capture.finish(&tx).unwrap();
        tx.commit().unwrap();
        let id = register(changes, feed(crate::activity::REMOVE)).unwrap();

        undo(&conn, id).unwrap();

        let renamed = uid(&conn).expect("and names the row that came back");
        assert_ne!(renamed, named);
    }

    /// A row the reader changed after the write makes the ticket describe a collection that is
    /// not there any more — refused, nothing written, and the ticket retired.
    #[test]
    fn a_row_changed_since_refuses_the_undo_and_retires_the_ticket() {
        let conn = conn();
        let (keep, _, id) = captured_write(&conn);
        conn.execute(
            "UPDATE collection_entries SET quantity = 6 WHERE id = ?1",
            params![keep],
        )
        .unwrap();
        let before = quantities(&conn);

        assert_eq!(undo(&conn, id).unwrap_err(), UNDO_STALE);
        assert_eq!(quantities(&conn), before, "nothing was written");
        assert!(crate::activity::recent(&conn, 10).unwrap().is_empty());
        assert_eq!(
            undo(&conn, id).unwrap_err(),
            UNDO_GONE,
            "and the ticket went"
        );
    }

    /// The bookkeeping columns move by themselves and must not make an honest ticket stale.
    #[test]
    fn bookkeeping_columns_do_not_make_a_ticket_stale() {
        let conn = conn();
        let (keep, _, id) = captured_write(&conn);
        conn.execute(
            "UPDATE collection_entries
                SET updated_at = 12345, sync_uid = 'renamed', needs_review = 'look'
              WHERE id = ?1",
            params![keep],
        )
        .unwrap();

        undo(&conn, id).unwrap();

        let (quantity, review): (i64, Option<String>) = conn
            .query_row(
                "SELECT quantity, needs_review FROM collection_entries WHERE id = ?1",
                params![keep],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(quantity, 2);
        assert_eq!(
            review.as_deref(),
            Some("look"),
            "the app's own note is left alone"
        );
    }

    /// A grain the reader filled again since the delete cannot take the old row back.
    #[test]
    fn a_grain_taken_again_since_refuses_the_re_insert() {
        let conn = conn();
        let (_, _, id) = captured_write(&conn);
        row(&conn, 4, "LP");

        assert_eq!(undo(&conn, id).unwrap_err(), UNDO_STALE);
        assert_eq!(tickets_held(), 0);
    }

    /// A write that changed nothing is offered no undo.
    #[test]
    fn a_write_that_changed_nothing_registers_no_ticket() {
        let conn = conn();
        row(&conn, 2, "NM");
        let tx = conn.unchecked_transaction().unwrap();
        let capture = Capture::begin(&tx, Table::Collection, "1", vec![]).unwrap();
        tx.execute("UPDATE collection_entries SET updated_at = 42", [])
            .unwrap();
        let changes = capture.finish(&tx).unwrap();
        tx.commit().unwrap();
        assert!(register(changes, feed(crate::activity::MOVE)).is_none());
        assert_eq!(tickets_held(), 0);
    }

    /// The store keeps the newest [`CAPACITY`], evicts the oldest, and never reuses an id.
    #[test]
    fn the_store_keeps_the_newest_tickets_and_never_reuses_an_id() {
        let conn = conn();
        let first = captured_write(&conn).2;
        conn.execute("DELETE FROM collection_entries", []).unwrap();
        let mut last = first;
        for _ in 0..CAPACITY {
            last = captured_write(&conn).2;
            conn.execute("DELETE FROM collection_entries", []).unwrap();
        }
        assert_eq!(last, first + CAPACITY as u64, "ids only grow");
        assert_eq!(tickets_held(), CAPACITY);
        assert_eq!(
            undo(&conn, first).unwrap_err(),
            UNDO_GONE,
            "the oldest was evicted"
        );
        assert_eq!(
            undo(&conn, 0).unwrap_err(),
            UNDO_GONE,
            "and an id never issued is gone"
        );
    }

    /// An error that is not a refusal keeps the ticket, so the reader can press again.
    #[test]
    fn an_error_that_is_not_a_refusal_keeps_the_ticket() {
        let conn = conn();
        let (_, _, id) = captured_write(&conn);
        conn.execute_batch(
            "CREATE TEMP TRIGGER refuse_activity BEFORE INSERT ON main.activity
             BEGIN SELECT RAISE(FAIL, 'activity refused'); END;",
        )
        .unwrap();
        let before = quantities(&conn);

        assert!(undo(&conn, id).unwrap_err().contains("activity refused"));
        assert_eq!(quantities(&conn), before, "rolled back whole");
        assert_eq!(tickets_held(), 1, "and the ticket is still there");

        conn.execute_batch("DROP TRIGGER temp.refuse_activity")
            .unwrap();
        undo(&conn, id).unwrap();
    }
}
