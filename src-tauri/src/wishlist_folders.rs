//! Wishlist folders: the deck gallery's filing cabinet, ported to a shopping list.
//!
//! Shaped like [`crate::deck_meta`]'s folder half, which it is a port of — pure functions over
//! a `Connection`, testable without a Tauri app, wrapped in `async` commands that run on the
//! blocking pool. Writes take `AppState.db` and answer [`crate::db::BUSY`] rather than waiting;
//! the two reads take `db_read` like every read in the app.
//!
//! **A folder is a filing decision the reader makes about a wish**, not a tag, not a status and
//! not a second list. A wish is in exactly one place, the same way a deck is in exactly one
//! folder, and `NULL` **is** the root: nothing has to be created for the list to work, and a
//! reader who never makes a folder sees the list they saw before schema v23.
//!
//! Two cascade rules, and they pull in opposite directions on purpose (schema v23):
//!
//! * `wishlist_folders.parent_id` is `ON DELETE CASCADE` **onto its own table**, so deleting a
//!   cabinet takes the drawers inside it in one press.
//! * `wishlist_entries.folder_id` is `ON DELETE SET NULL`, so the same press leaves the *wishes*
//!   standing at the root. A folder is where a wish was kept; the wish is the thing the reader
//!   wanted, and no filing decision may throw one away. **That one is a backstop and not the
//!   mechanism**: `folder_id` is the fourth term of [`crate::schema::WISHLIST_GRAIN`], so
//!   [`delete_folder`] re-files the sub-tree by hand, with the merge, before the row goes — see
//!   there for the two collisions the cascade on its own answered with
//!   `UNIQUE constraint failed`.
//!
//! **Nothing here writes history.** `deck_meta::delete_folder` is the one folder write in that
//! module that records an audit row, because `decks` has a `deck_audit` to file it under and a
//! deck being re-filed is a fact about that deck. The wishlist has no audit log at all, so the
//! asymmetry is the schema's rather than a gap left open here.
//!
//! **Two of the seven commands are this list's own** and have no counterpart in the gallery:
//! [`set_wish_folder`], which is the "move to" — and merges rather than failing, because the
//! folder is the fourth term of [`crate::schema::WISHLIST_GRAIN`] — and [`folder_summary`],
//! which is what a folder tile is drawn from.

use crate::collection::EntryChange;
// The two sentences this module refuses with, taken from the module it is a port of rather
// than re-spelled. A reader who has met "That folder is not there any more." in the deck
// gallery must meet the same sentence here: it is the same fact about the same kind of thing,
// and `deck_meta::CATEGORY_WRONG_DECK`'s doc is the standing rule — a second copy of a refusal
// is a second thing to drift. `crate::deck::set_folder` already reaches across for
// `FOLDER_GONE` for exactly this reason, so this is the crate's habit and not a new one.
use crate::deck_meta::{FOLDER_CYCLE, FOLDER_GONE};
use crate::sorting::Marketplace;
use crate::sync::{lock_db_read, with_write, AppState};
use crate::wishlist::WISH_PREFERRED_FINISH;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::sync::Arc;

/// What a write says when the wish it names is not there — [`crate::wishlist`]'s own sentence,
/// which `set_wish_quantity` and `set_wish_printing` both answer with. One mistake, one wording.
const WISH_GONE: &str = "That wishlist entry is not there any more.";

/// How far [`move_folder`]'s cycle walk will climb before it calls the chain a cycle.
///
/// [`crate::deck_meta`]'s `MAX_FOLDER_DEPTH`, which is private there, kept at the same number
/// for the same reason: deep enough that no filing anyone does by hand reaches it. See
/// [`move_folder`] for what the budget is actually guarding against, which is not depth.
const MAX_FOLDER_DEPTH: usize = 64;

/// One folder. Flat rows; the tree is the reader's to build from `parent_id`, the way
/// `wishlist_folders` itself has no notion of depth. `src/lib/folderTree.ts` is the reader.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistFolder {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub sort_order: i64,
}

/// What one folder tile is drawn from — the four numbers, per folder, in one round trip.
///
/// **Direct per folder, never recursive**, and that is the load-bearing decision. The tree
/// builder on the TypeScript side (`src/lib/folderTree.ts`) already sums a node's children for
/// the deck gallery and does it here for the same reason: SQL that walked the tree would be a
/// second implementation of arithmetic that is already written, tested and drawn from.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistFolderSummary {
    pub folder_id: i64,
    /// Wishes filed **directly** in this folder. The tree sums it; SQL does not.
    pub wishes: i64,
    /// Copies still to find here — `sum(max(0, quantity - owned))`, the page's `missingOf`.
    pub missing: i64,
    /// What those copies cost at the named marketplace. Unpriced rows are left out, never
    /// quoted at another marketplace's rate.
    pub cost: f64,
    /// How many wishes here the marketplace could not price. The page header's own note.
    pub unpriced: i64,
}

/// A name good enough for a folder — trimmed, non-empty. [`crate::deck_meta`]'s `valid_name`,
/// which is private there, in the one shape this module needs it: a blank string would end up
/// on a tile no one can read, and the refusal is the same sentence the gallery gives.
fn valid_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    (!name.is_empty())
        .then_some(name)
        .ok_or_else(|| "A folder needs a name.".to_owned())
}

fn folder_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<WishlistFolder> {
    Ok(WishlistFolder {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        name: r.get(2)?,
        sort_order: r.get(3)?,
    })
}

fn read_folder(conn: &Connection, id: i64) -> Result<Option<WishlistFolder>, String> {
    conn.query_row(
        "SELECT id, parent_id, name, sort_order FROM wishlist_folders WHERE id = ?1",
        params![id],
        folder_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every folder there is, flat, `ORDER BY sort_order, id`. No scoping of any kind — a folder
/// belongs to no wish, it files them.
pub fn list_folders(conn: &Connection) -> Result<Vec<WishlistFolder>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, parent_id, name, sort_order
               FROM wishlist_folders ORDER BY sort_order, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], folder_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Make a new folder under `parentId` (root, if `None`). No uniqueness rule on the name —
/// `wishlist_folders` carries no grain constant and no unique index on `(parent_id, name)`, so
/// two sibling folders may share one, exactly as two sibling `deck_folders` may.
///
/// **The `id` is SQLite's and is never supplied.** `INTEGER PRIMARY KEY` is what makes
/// [`crate::schema::WISHLIST_GRAIN`]'s fourth term — `coalesce(folder_id, 0)` — safe, and the
/// guarantee is narrower than it looks: SQLite never *auto-assigns* rowid 0, but it will
/// happily store an explicit one. A folder numbered 0 would be indistinguishable from the root
/// on the grain, so every wish in it would collide with the reader's root wish for the same
/// card. Letting the database assign is the whole of the fence.
pub fn create_folder(
    conn: &Connection,
    parent_id: Option<i64>,
    name: &str,
) -> Result<WishlistFolder, String> {
    let name = valid_name(name)?;
    // `IS`, not `=`: `parent_id` is nullable (root), and `=` never matches a bound NULL.
    let next_order: i64 = conn
        .query_row(
            "SELECT coalesce(max(sort_order), -1) + 1 FROM wishlist_folders WHERE parent_id IS ?1",
            params![parent_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let id: i64 = conn
        .query_row(
            "INSERT INTO wishlist_folders (parent_id, name, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![parent_id, name, next_order],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    read_folder(conn, id)?.ok_or_else(|| FOLDER_GONE.to_owned())
}

pub fn rename_folder(conn: &Connection, id: i64, name: &str) -> Result<WishlistFolder, String> {
    let name = valid_name(name)?;
    let changed = conn
        .execute(
            "UPDATE wishlist_folders SET name = ?2, updated_at = unixepoch() WHERE id = ?1",
            params![id, name],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(FOLDER_GONE.to_owned());
    }
    read_folder(conn, id)?.ok_or_else(|| FOLDER_GONE.to_owned())
}

/// The destination fence, in one place because [`move_folder`] and [`reorder_folders`] both owe
/// it — the sentence, not the foreign key, for the reason [`move_folder`]'s doc gives at length.
fn require_folder(conn: &Connection, id: i64) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM wishlist_folders WHERE id = ?1)",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    exists.then_some(()).ok_or_else(|| FOLDER_GONE.to_owned())
}

/// The cycle walk itself, in one place for [`require_folder`]'s reason: a refusal written twice
/// is a refusal that comes to disagree with itself. `start` is an id rather than an `Option`,
/// because the root is nobody's descendant and a move there has nothing to climb.
/// [`move_folder`] is where the reasoning is written down — what the walk guards, and why the
/// hop budget is not about depth.
fn refuse_cycle(conn: &Connection, id: i64, start: i64) -> Result<(), String> {
    let mut cursor = Some(start);
    let mut hops = 0usize;
    while let Some(candidate) = cursor {
        if candidate == id {
            return Err(FOLDER_CYCLE.to_owned());
        }
        hops += 1;
        if hops > MAX_FOLDER_DEPTH {
            return Err(FOLDER_CYCLE.to_owned());
        }
        cursor = conn
            .query_row(
                "SELECT parent_id FROM wishlist_folders WHERE id = ?1",
                params![candidate],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
    }
    Ok(())
}

/// Move a folder under a new parent (root, if `None`). **Refuses a cycle**: walks `parent_id`
/// upward from the *proposed* parent, and if that walk ever meets `id` — immediately, if
/// `parentId` names `id` itself — refuses rather than writing a loop `parent_id`'s own
/// `ON DELETE CASCADE` would otherwise walk forever the day one of them is deleted.
///
/// **The proposed parent is fenced in words first, and the cycle walk cannot stand in for
/// it.** `wishlist_folders.parent_id REFERENCES wishlist_folders(id)` is a real foreign key
/// between two user tables, so the `UPDATE` below does refuse a parent that is gone — with
/// `FOREIGN KEY constraint failed`, which names the constraint rather than the mistake, and
/// only while `PRAGMA foreign_keys` happens to be on. The walk reaches the same id and reads it
/// as the root: `optional()?.flatten()` folds "no such folder" and "that folder is at the root"
/// into one `None`, the climb ends on the first hop and the id sails through. So the check is
/// its own statement, answering [`FOLDER_GONE`] the way [`create_folder`]'s parent and
/// [`set_wish_folder`]'s destination already do — after this the three folder-taking writes in
/// the feature all say the same sentence. **`deck_meta`'s `move_folder` has the identical hole
/// and is deliberately left with it**: fixing one side of a ported pair is a difference somebody
/// later reads as intentional, and the deck gallery is out of this branch's scope.
///
/// **The walk has a hop budget, and the budget is not about depth.** This walk is what *keeps*
/// the tree acyclic, so it cannot assume it already is — a `parent_id` cycle that arrived some
/// other way (a hand-edited database, a restored backup) would send the `candidate == id` arm
/// past every folder in the loop for ever, because none of them is the folder being moved. The
/// visited chain is bounded instead of remembered, which is [`crate::deck_meta`]'s answer and
/// costs no allocation. It matters here as much as it does there: this runs inside
/// `spawn_blocking` **while holding the app-wide write lock**, so an unbounded climb would not
/// hang this one command — it would deadlock every write in the app for the life of the
/// process. Exceeding the budget is answered as a cycle, which is the only thing a chain that
/// long can be.
pub fn move_folder(
    conn: &Connection,
    id: i64,
    parent_id: Option<i64>,
) -> Result<WishlistFolder, String> {
    if let Some(start) = parent_id {
        require_folder(conn, start)?;
        refuse_cycle(conn, id, start)?;
    }
    let changed = conn
        .execute(
            "UPDATE wishlist_folders SET parent_id = ?2, updated_at = unixepoch() WHERE id = ?1",
            params![id, parent_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(FOLDER_GONE.to_owned());
    }
    read_folder(conn, id)?.ok_or_else(|| FOLDER_GONE.to_owned())
}

/// File a whole row of siblings at once: every `id` in `ids` gets `parent_id` as its parent and
/// its **position in the slice** as its `sort_order`. `ids` is that parent's complete child list
/// in the order the reader just dropped it into; `None` is the root, as everywhere in this
/// module.
///
/// **One command doing both jobs, deliberately.** A drag re-parents and positions in one
/// gesture, and the two as separate writes are a moment when the folder is under its new parent
/// at its old number — a state the reader can see and nobody chose. One transaction is what
/// makes that moment unreachable.
///
/// **Nothing writes `sort_order` from a position anywhere else.** [`create_folder`] hands out
/// `max + 1` and [`move_folder`] leaves the column alone, so a folder's number was whatever it
/// was given at birth until this landed.
///
/// **Both ends are fenced the way [`move_folder`] fences them, through the same two helpers**:
/// the destination once ([`require_folder`]), then every id against it ([`refuse_cycle`]). An id
/// that *is* `parent_id`, or an ancestor of it, is exactly as fatal here as it is there, because
/// it is the same `ON DELETE CASCADE` onto the same table that would then walk forever.
///
/// **An id that is not there is [`FOLDER_GONE`]**, which is [`move_folder`]'s answer to the same
/// mistake: a stale id means the tree on screen is not the tree in the database, and the whole
/// row of siblings this was asked to file is therefore not the row that exists.
///
/// **No `kind` fence, because `wishlist_folders` has no `kind` column.** Only
/// [`crate::collection_folders`] can have a folder the app owns, so only its `reorder_folders`
/// refuses one; the asymmetry is the schema's rather than an omission here.
///
/// **Nothing here touches a wish.** `folder_id` is the fourth term of
/// [`crate::schema::WISHLIST_GRAIN`], which is why [`delete_folder`] has to re-file by hand — but
/// this write moves no wish between folders, only folders between folders, so no grain moves and
/// there is nothing to merge.
pub fn reorder_folders(
    conn: &Connection,
    parent_id: Option<i64>,
    ids: &[i64],
) -> Result<Vec<WishlistFolder>, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if let Some(start) = parent_id {
        require_folder(&tx, start)?;
        for id in ids {
            refuse_cycle(&tx, *id, start)?;
        }
    }
    for (order, id) in ids.iter().enumerate() {
        let changed = tx
            .execute(
                "UPDATE wishlist_folders
                    SET parent_id = ?2, sort_order = ?3, updated_at = unixepoch()
                  WHERE id = ?1",
                params![id, parent_id, order as i64],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(FOLDER_GONE.to_owned());
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    list_folders(conn)
}

/// Delete a folder. **Does not delete the wishes in it** — they surface at the root, filed
/// nowhere, still exactly as they were. Sub-folders go with it. Like
/// [`crate::deck_meta::delete_folder`] and [`crate::deck::delete_deck`], an id that resolves to
/// nothing is a success: the caller wanted that folder gone, and it is gone.
///
/// # Why the un-filing is written out and not left to the cascade
///
/// `wishlist_entries.folder_id` is `ON DELETE SET NULL` (schema v23), and for one press it
/// looks like the whole answer: one `DELETE`, every wish in the sub-tree re-filed at the root.
/// It is not, because **that cascade rewrites the fourth term of
/// [`crate::schema::WISHLIST_GRAIN`]** on every one of those rows, and a write that changes a
/// wish's grain has to say what it will land on. Every other write in the crate does —
/// [`crate::wishlist::add_wish`] through `ON CONFLICT`, [`set_wish_folder`] and
/// [`crate::wishlist::set_wish_printing`] through the merge below,
/// `reconcile::fold_wish_into_existing` through its own — and this one used to be the exception
/// that let `idx_wishlist_grain` decide. Two shapes reached the reader as
/// `UNIQUE constraint failed: index 'idx_wishlist_grain'`, with the folder still standing and
/// nothing moved:
///
/// * a wish in the sub-tree and a **root** wish for the same card, which is the state spec §1
///   accepts on purpose — `deck_missing_to_wishlist`, `deck_theory_missing_to_wishlist` and
///   `wishlist_import_commit` all add at the root and cannot name a folder, so a card the
///   reader has filed acquires a second root row and `WishRow.elsewhere` exists to advertise
///   it. The duplicate the design tolerates was the one that bricked the delete.
/// * **two sub-tree wishes colliding with each other**, needing no root row at all: `Top/A` and
///   `Top/B` each holding the same card land on one grain the moment both reach the root.
///
/// So the sub-tree's wishes are collected and re-filed one at a time through [`refile_wish`],
/// with [`set_wish_folder`]'s merge rule and not a third copy of it, **before** the folder row
/// goes. By the time the `DELETE` runs every wish beneath it is already at the root, so the
/// `SET NULL` has nothing left to rewrite and nothing left to collide on. One at a time is what
/// answers the second shape as well as the first: the first wish to reach the root becomes the
/// row the next one merges into.
///
/// `parent_id`'s `ON DELETE CASCADE` onto its own table is still the DDL's work and still done
/// by one statement — a folder inside a deleted folder has nowhere else to be, and no grain is
/// involved. **It therefore still depends on `PRAGMA foreign_keys` being ON**, which is
/// per-connection. [`crate::db::open`] sets it for every connection the app hands out, so the
/// app path is covered; a test that opens its own connection has to say so itself, and the
/// `conn()` helper below does.
///
/// One transaction, which this function did not need while it was one statement: mid-delete the
/// wishes are all re-filed and the folder is gone, or none of it happened.
pub fn delete_folder(conn: &Connection, id: i64) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // The sub-tree, in the database rather than in a Rust walk, because the cascade this
    // stands in front of is itself recursive and the two must agree about which folders are
    // doomed. **`UNION` and never `UNION ALL`**: a `parent_id` cycle that arrived some other
    // way — a hand-edited database, a restored backup — is what [`move_folder`]'s hop budget
    // exists for, and here the duplicate-row check is what makes the same corruption converge
    // instead of looping. `ORDER BY w.id` so the row a merge folds into is decided by the
    // table and not by the planner.
    let filed: Vec<i64> = {
        let mut stmt = tx
            .prepare(
                "WITH RECURSIVE doomed(id) AS (
                     SELECT ?1
                     UNION
                     SELECT f.id FROM wishlist_folders f JOIN doomed d ON f.parent_id = d.id
                 )
                 SELECT w.id FROM wishlist_entries w
                  WHERE w.folder_id IN (SELECT id FROM doomed)
                  ORDER BY w.id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    };
    // A merge only ever deletes the row it was *given*, so no id in this list can go before its
    // turn and [`refile_wish`]'s [`WISH_GONE`] is unreachable from here. It is propagated rather
    // than skipped anyway: if it ever did fire, something is deleting wishes underneath this
    // transaction, and rolling the whole press back is the only honest answer to that.
    for wish in filed {
        refile_wish(&tx, wish, None)?;
    }
    tx.execute("DELETE FROM wishlist_folders WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Move one wish into a folder, or — with `None` — back to the **root of the list**.
///
/// `None` is a real destination rather than an omission, [`crate::deck::set_folder`]'s point
/// one table over: the root is where every wish starts and is the only place an unfiled wish
/// can be, so there is nothing else `None` could mean here.
///
/// **A command of its own, because filing is not adding.** `folder_id` is the fourth term of
/// [`crate::schema::WISHLIST_GRAIN`] (schema v23), which is what makes "Add to Ordered" an
/// *add*: the same card at the root and in `Ordered` is two wishes, so an add can never
/// silently move a row the reader filed last week. The cost of that guarantee is exactly this
/// command — moving between folders has to be something the reader says out loud.
///
/// # The merge
///
/// The rule is [`crate::wishlist::set_wish_printing`]'s, written down in full there and not
/// repeated here: **a write that lands on a taken grain merges, it does not fail.** Moving a
/// wish into a folder that already holds the same `(oracle_id, card_id, preferred_finish)`
/// violates `idx_wishlist_grain`, and a `UNIQUE constraint failed` reaching the reader would be
/// the app telling them off for filing a card twice. So the two quantities sum into the row
/// that was already there, the source row is deleted, and the answer names the
/// **destination** — including `removed: false`, because the field means "the wish is gone" and
/// the wish is emphatically still on the list.
///
/// One transaction, for the reason every fold in this crate is one: mid-merge the copies are in
/// both rows or in neither.
pub fn set_wish_folder(
    conn: &Connection,
    id: i64,
    folder_id: Option<i64>,
) -> Result<EntryChange, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Validated in words rather than left to the foreign key, [`crate::deck::set_folder`]'s
    // reasoning verbatim: `wishlist_entries.folder_id` does declare
    // `REFERENCES wishlist_folders(id)`, but `PRAGMA foreign_keys` is a per-connection setting
    // and a constraint failure names the table rather than the mistake.
    if let Some(folder) = folder_id {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM wishlist_folders WHERE id = ?1)",
                params![folder],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err(FOLDER_GONE.to_owned());
        }
    }
    refile_wish(&tx, id, folder_id).and_then(|change| {
        tx.commit().map_err(|e| e.to_string())?;
        Ok(change)
    })
}

/// The filing write itself, with no fence and no transaction of its own: move wish `id` onto
/// `folder_id`, folding it into whatever already holds that grain.
///
/// **Factored out because [`delete_folder`] needs the very same rule**, and the merge had
/// already been written three times in this crate before it did — a fourth copy in the un-filing
/// path is how the two would come to disagree about what a duplicate wish is. It takes a
/// `&Connection` rather than a `&Transaction` so either caller's `unchecked_transaction` handle
/// fits, and it commits nothing: whoever opened the transaction owns it, which is what lets the
/// delete run this once per wish in a sub-tree and still be one press.
///
/// [`set_wish_folder`] is where the rule is argued; the paragraph above it is the one to read.
fn refile_wish(tx: &Connection, id: i64, folder_id: Option<i64>) -> Result<EntryChange, String> {
    // The three grain terms this write does *not* touch, plus the quantity the merge moves.
    // Read before anything is decided, because "is that wish still there?" is answered by the
    // same statement — an `UPDATE` that changed no rows cannot tell a missing row apart from a
    // grain collision, and the two want opposite answers.
    let (oracle_id, card_id, preferred_finish, quantity): (
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
    ) = tx
        .query_row(
            "SELECT oracle_id, card_id, preferred_finish, quantity
               FROM wishlist_entries WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| WISH_GONE.to_owned())?;

    // The grain the write is *about to land on*, spelled out rather than interpolated from
    // [`crate::schema::WISHLIST_GRAIN`] for the reason `reconcile::collision_target` gives and
    // `set_wish_printing` repeats: that constant is a list of expressions over **one row**, and
    // this compares the same list against four bound values. Every term is here — a fold that
    // matched on three of the four would merge a wish into a row in another folder, which is
    // exactly the bug the fourth term exists to make impossible.
    let target: Option<(i64, i64)> = tx
        .query_row(
            "SELECT id, quantity FROM wishlist_entries
              WHERE id <> ?1
                AND coalesce(oracle_id,'') = coalesce(?2,'')
                AND coalesce(card_id,'') = coalesce(?3,'')
                AND coalesce(preferred_finish,'') = coalesce(?4,'')
                AND coalesce(folder_id,0) = coalesce(?5,0)",
            params![id, oracle_id, card_id, preferred_finish, folder_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some((target, held)) = target {
        tx.execute(
            "UPDATE wishlist_entries SET
                quantity = quantity + ?2,
                notes = coalesce(notes, (SELECT notes FROM wishlist_entries WHERE id = ?3)),
                updated_at = unixepoch()
              WHERE id = ?1",
            params![target, quantity, id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM wishlist_entries WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        return Ok(EntryChange {
            id: target,
            quantity: held + quantity,
            removed: false,
        });
    }

    // NULL is a value here rather than an omission, for the reason `set_wish_printing` gives
    // about its four printing columns: `coalesce(?n, column)` — `DeckPatch`'s convention for
    // "leave it" — would make "back to the root" unexpressible, which is half of what this
    // command is for.
    tx.execute(
        "UPDATE wishlist_entries SET folder_id = ?2, updated_at = unixepoch() WHERE id = ?1",
        params![id, folder_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// The four numbers each folder tile draws, one row per folder that holds at least one wish.
///
/// **Every figure is [`crate::wishlist`]'s own arithmetic rather than a second spelling of it.**
/// `missing` is `max(0, quantity - owned)` over [`crate::wishlist::OWNED_SQL`] — which is why
/// that constant is `pub(crate)`, and why the wishlist table is aliased `w` here: the alias is
/// part of its contract. The unit price is [`crate::sorting::row_price_expr`] over
/// [`crate::wishlist::WISH_PREFERRED_FINISH`], the same expression `list_wishes` puts in its
/// `unit_price` column. A folder's subtotal and the page header's total have to be one piece of
/// arithmetic; two implementations of one figure disagree the first time either changes.
///
/// The join is `list_wishes`' join, verbatim in shape: the card a wish is *about* is its pinned
/// printing, or the **cheapest** printing of its oracle card at the marketplace being summed, and
/// it is a `LEFT JOIN` because a wish outlives the printing it was made from.
///
/// **The join has to agree as exactly as the price does**, and for the same reason. An
/// any-printing wish is drawn, quoted and summed as one printing; a tile that totalled the newest
/// printing over rows quoting the cheapest would be a subtotal that does not add up to the list
/// under it, and nothing on screen would say which of the two figures to believe.
///
/// **`WHERE folder_id IS NOT NULL`**: the root is not a folder and has no tile to draw. What is
/// at the root is what the unfiltered list already shows.
///
/// `unpriced` counts a row only when it has copies **still to buy** and no price. A wish the
/// binder already satisfies costs nothing whether the marketplace can quote it or not, and
/// counting it would put a "could not price" note on a folder with nothing left to buy.
pub fn folder_summary(
    conn: &Connection,
    marketplace: Marketplace,
) -> Result<Vec<WishlistFolderSummary>, String> {
    // Both expressions are evaluated once per row in an inner SELECT and aggregated by name in
    // the outer one. `OWNED_SQL` is a correlated subquery and the price can be another; spelling
    // either of them three times in the aggregate list would run it three times per row for one
    // answer.
    //
    // **Shared with `wishlist::list` rather than respelled here**, because a folder's subtotal and
    // the page header's total have to be the same arithmetic.
    let owned = crate::wishlist::OWNED_SQL;
    let sql = format!(
        "SELECT folder_id,
                count(*) AS wishes,
                sum(missing) AS missing,
                sum(CASE WHEN unit_price IS NULL THEN 0.0 ELSE missing * unit_price END) AS cost,
                sum(CASE WHEN unit_price IS NULL AND missing > 0 THEN 1 ELSE 0 END) AS unpriced
           FROM (SELECT w.folder_id AS folder_id,
                        max(0, w.quantity - {owned}) AS missing,
                        {price} AS unit_price
                   FROM wishlist_entries w
                   LEFT JOIN cards c
                     ON c.id = coalesce(w.card_id,
                            (SELECT c.id FROM cards c
                              WHERE c.oracle_id = w.oracle_id
                              ORDER BY ({price}) ASC NULLS LAST, c.released_at DESC, c.id ASC
                              LIMIT 1))
                  WHERE w.folder_id IS NOT NULL)
          GROUP BY folder_id
          ORDER BY folder_id",
        price = crate::sorting::row_price_expr(marketplace, WISH_PREFERRED_FINISH)
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(WishlistFolderSummary {
                folder_id: r.get(0)?,
                wishes: r.get(1)?,
                missing: r.get(2)?,
                cost: r.get(3)?,
                unpriced: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What a write here says when its worker thread died under it — never a user's problem, the
/// write itself answers [`crate::db::BUSY`] when the database is busy.
/// [`crate::deck_meta`]'s helper of the same name, named for this list instead.
fn unfinished(e: tauri::Error) -> String {
    format!("the wishlist's folders could not be written: {e}")
}

/// **Read-only** connection, like every list in the app.
#[tauri::command]
pub async fn wishlist_folder_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<WishlistFolder>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_folders(&lock_db_read(&state)))
        .await
        .map_err(|e| format!("the wishlist folders could not be read: {e}"))?
}

#[tauri::command]
pub async fn wishlist_folder_create(
    state: tauri::State<'_, Arc<AppState>>,
    parent_id: Option<i64>,
    name: String,
) -> Result<WishlistFolder, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| create_folder(c, parent_id, &name))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn wishlist_folder_rename(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    name: String,
) -> Result<WishlistFolder, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| rename_folder(c, id, &name))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn wishlist_folder_move(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    parent_id: Option<i64>,
) -> Result<WishlistFolder, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| move_folder(c, id, parent_id))
    })
    .await
    .map_err(unfinished)?
}

/// The drag's own command — see [`reorder_folders`] for why re-parenting and positioning are one
/// write. It answers the **whole** folder list rather than the rows it moved, like
/// [`crate::deck_meta::deck_category_reorder`]: every sibling's number changed, so a caller
/// handed only the moved rows would have to guess at the rest.
#[tauri::command]
pub async fn wishlist_folder_reorder(
    state: tauri::State<'_, Arc<AppState>>,
    parent_id: Option<i64>,
    ids: Vec<i64>,
) -> Result<Vec<WishlistFolder>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| reorder_folders(c, parent_id, &ids))
    })
    .await
    .map_err(unfinished)?
}

/// The wishes inside surface at the root and the sub-folders go too — see [`delete_folder`],
/// where the sub-folders are the DDL's work and the wishes are emphatically not.
#[tauri::command]
pub async fn wishlist_folder_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| delete_folder(c, id)))
        .await
        .map_err(unfinished)?
}

/// "Move to …", and "Move to the wishlist" — see [`set_wish_folder`] for the merge, which is
/// why this answers an [`EntryChange`] whose `id` is not always the `id` it was given.
#[tauri::command]
pub async fn wishlist_set_folder(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    folder_id: Option<i64>,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_wish_folder(c, id, folder_id))
    })
    .await
    .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

/// **Read-only**, and priced at the marketplace the caller names — anything the app does not
/// know is TCGplayer, [`crate::sorting::Marketplace::from_opt`]'s rule for every list query.
#[tauri::command]
pub async fn wishlist_folder_summary(
    state: tauri::State<'_, Arc<AppState>>,
    marketplace: Option<String>,
) -> Result<Vec<WishlistFolderSummary>, String> {
    let state = state.inner().clone();
    let marketplace = Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || folder_summary(&lock_db_read(&state), marketplace))
        .await
        .map_err(|e| format!("the wishlist folder totals could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **`foreign_keys` is ON, and here that is not ceremony**: the two cascade rules
    /// [`delete_folder`] leans on are per-connection settings, and an in-memory connection
    /// starts with them off. Without this line that test would report a folder deleted and
    /// its sub-tree left standing — a green suite over a broken feature.
    /// [`crate::db::open`] sets the same pragma for every connection the app hands out.
    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    /// The marketplace the price tests read through. TCGplayer, because it is the one whose
    /// prices live in `cards.prices` as `$.usd` and [`priced_card`] writes that key.
    const ANY_MARKET: Marketplace = Marketplace::Tcgplayer;

    /// A `cards` row carrying a nonfoil `usd` price — [`crate::schema::tests::seed_card`] sets
    /// no `prices`, and the summary tests need printings that have one.
    fn priced_card(conn: &Connection, id: &str, oracle_id: &str, usd: &str) {
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                                prices, raw)
             VALUES (?1, ?2, 'Lightning Bolt', 'lea', '161', 'en', 'normal', ?3, '{}')",
            params![id, oracle_id, format!(r#"{{"usd":"{usd}"}}"#)],
        )
        .unwrap();
    }

    /// One wish for an oracle card, written straight into the table: [`crate::wishlist::add_wish`]
    /// is the command that makes one, and these tests need nothing from it but a row to file.
    fn wish(conn: &Connection, oracle_id: &str, quantity: i64, folder_id: Option<i64>) -> i64 {
        conn.query_row(
            "INSERT INTO wishlist_entries
                (oracle_id, name, quantity, folder_id, created_at, updated_at)
             VALUES (?1, 'Lightning Bolt', ?2, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![oracle_id, quantity, folder_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One nonfoil NM copy in the binder, so [`folder_summary`]'s `missing` has something to
    /// subtract.
    fn own(conn: &Connection, card_id: &str, quantity: i64) {
        conn.execute(
            "INSERT INTO collection_entries
                (card_id, set_code, collector_number, lang, finish, condition, quantity,
                 created_at, updated_at)
             VALUES (?1, 'lea', '161', 'en', 'nonfoil', 'NM', ?2, unixepoch(), unixepoch())",
            params![card_id, quantity],
        )
        .unwrap();
    }

    /// Where a wish is filed, straight from the column.
    fn folder_of(conn: &Connection, id: i64) -> Option<i64> {
        conn.query_row(
            "SELECT folder_id FROM wishlist_entries WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn create_folder_puts_a_folder_at_the_root_and_inside_another() {
        let conn = conn();
        let ordered = create_folder(&conn, None, "Ordered").unwrap();
        let expensive = create_folder(&conn, None, "Expensive").unwrap();
        let someday = create_folder(&conn, Some(ordered.id), "Someday").unwrap();
        let later = create_folder(&conn, Some(ordered.id), "Later").unwrap();

        assert_eq!(ordered.parent_id, None, "None is the root");
        assert_eq!(someday.parent_id, Some(ordered.id), "and it round-trips");
        assert_eq!(
            read_folder(&conn, someday.id).unwrap().unwrap().parent_id,
            Some(ordered.id),
            "from the table, not just from the answer"
        );

        // `max + 1` **among siblings**, which is why the first child starts at 0 again rather
        // than continuing the root's numbering.
        assert_eq!((ordered.sort_order, expensive.sort_order), (0, 1));
        assert_eq!((someday.sort_order, later.sort_order), (0, 1));

        // Never an explicit id: `WISHLIST_GRAIN`'s `coalesce(folder_id, 0)` is only safe while
        // no folder can be 0, and SQLite guarantees that only for ids it assigns itself.
        assert!(ordered.id > 0, "SQLite assigned it, and never 0");
    }

    #[test]
    fn create_folder_refuses_a_blank_name() {
        let conn = conn();
        let err = create_folder(&conn, None, "   ").unwrap_err();
        assert_eq!(
            err, "A folder needs a name.",
            "the refusal names the problem"
        );
        assert!(
            list_folders(&conn).unwrap().is_empty(),
            "and the refused create wrote nothing"
        );
    }

    #[test]
    fn rename_folder_writes_the_new_name() {
        let conn = conn();
        let folder = create_folder(&conn, None, "Ordered").unwrap();

        let returned = rename_folder(&conn, folder.id, "  Ordered and paid  ").unwrap();
        assert_eq!(
            returned.name, "Ordered and paid",
            "trimmed, like the create"
        );
        let stored: String = conn
            .query_row(
                "SELECT name FROM wishlist_folders WHERE id = ?1",
                params![folder.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, "Ordered and paid");

        let err = rename_folder(&conn, folder.id, " ").unwrap_err();
        assert_eq!(err, "A folder needs a name.");
        let unchanged: String = conn
            .query_row(
                "SELECT name FROM wishlist_folders WHERE id = ?1",
                params![folder.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            unchanged, "Ordered and paid",
            "the refused rename wrote nothing"
        );
    }

    #[test]
    fn move_folder_moves_to_a_new_parent_and_then_back_to_root() {
        let conn = conn();
        let ordered = create_folder(&conn, None, "Ordered").unwrap();
        let someday = create_folder(&conn, None, "Someday").unwrap();

        let moved = move_folder(&conn, someday.id, Some(ordered.id)).unwrap();
        assert_eq!(moved.parent_id, Some(ordered.id));

        // `None` is a destination, not an omission — the root is a real place.
        let home = move_folder(&conn, someday.id, None).unwrap();
        assert_eq!(home.parent_id, None);
        assert_eq!(
            read_folder(&conn, someday.id).unwrap().unwrap().parent_id,
            None
        );
    }

    #[test]
    fn move_folder_refuses_a_cycle() {
        let conn = conn();
        let a = create_folder(&conn, None, "A").unwrap();
        let b = create_folder(&conn, None, "B").unwrap();
        move_folder(&conn, a.id, Some(b.id)).unwrap();

        let err = move_folder(&conn, b.id, Some(a.id)).unwrap_err();
        assert_eq!(err, FOLDER_CYCLE);

        let unchanged = read_folder(&conn, b.id).unwrap().unwrap();
        assert_eq!(
            unchanged.parent_id, None,
            "the refused move must write nothing"
        );
    }

    /// The destination, which the cycle walk cannot check and does not.
    /// `optional()?.flatten()` folds "no such folder" into the same `None` as "that folder is
    /// at the root", so the climb ends on the first hop and an id nothing answers to sails
    /// through to the `UPDATE` — which refuses it as `FOREIGN KEY constraint failed`, a
    /// sentence about a constraint, and only while `PRAGMA foreign_keys` is on. `create_folder`
    /// and `set_wish_folder` both answer [`FOLDER_GONE`] over the same column and this now does
    /// too; `.storybook/fake/db.ts` has always answered it, and the fake being kinder than the
    /// app is the drift that makes a story document a lie.
    #[test]
    fn move_folder_refuses_a_parent_that_is_not_there() {
        let conn = conn();
        let ordered = create_folder(&conn, None, "Ordered").unwrap();
        let someday = create_folder(&conn, Some(ordered.id), "Someday").unwrap();

        let err = move_folder(&conn, someday.id, Some(404)).unwrap_err();

        assert_eq!(err, FOLDER_GONE);
        assert_eq!(
            read_folder(&conn, someday.id).unwrap().unwrap().parent_id,
            Some(ordered.id),
            "and the refused move wrote nothing"
        );
        // `None` is the root and is always a destination -- the one parent there is no row to
        // look up, so the fence must not reach it.
        move_folder(&conn, someday.id, None).unwrap();
        assert_eq!(
            read_folder(&conn, someday.id).unwrap().unwrap().parent_id,
            None
        );
    }

    #[test]
    fn move_folder_refuses_moving_a_folder_into_itself_directly() {
        let conn = conn();
        let ordered = create_folder(&conn, None, "Ordered").unwrap();
        let err = move_folder(&conn, ordered.id, Some(ordered.id)).unwrap_err();
        assert_eq!(err, FOLDER_CYCLE);
    }

    /// The walk that *keeps* the tree acyclic cannot assume it is, and this is the case that
    /// proves the hop budget rather than the `candidate == id` arm: a cycle written straight
    /// into the table, between two folders neither of which is the one being moved. The walk
    /// from the proposed parent therefore never meets `id` and would climb for ever — inside
    /// `spawn_blocking`, holding the app-wide write lock, so it is every write in the app that
    /// stops rather than this one command.
    #[test]
    fn move_folder_gives_up_on_a_cycle_it_did_not_write() {
        let conn = conn();
        let a = create_folder(&conn, None, "A").unwrap();
        let b = create_folder(&conn, Some(a.id), "B").unwrap();
        let moving = create_folder(&conn, None, "C").unwrap();
        // Corruption this module cannot produce: a hand-edited database, a restored backup.
        conn.execute(
            "UPDATE wishlist_folders SET parent_id = ?2 WHERE id = ?1",
            params![a.id, b.id],
        )
        .unwrap();

        let err = move_folder(&conn, moving.id, Some(a.id)).unwrap_err();

        assert_eq!(err, FOLDER_CYCLE, "a sentence, not a hang");
        assert_eq!(
            read_folder(&conn, moving.id).unwrap().unwrap().parent_id,
            None,
            "and the refused move wrote nothing"
        );
    }

    #[test]
    fn delete_folder_keeps_its_wishes_and_cascades_its_subfolders() {
        let conn = conn();
        let ordered = create_folder(&conn, None, "Ordered").unwrap();
        let someday = create_folder(&conn, Some(ordered.id), "Someday").unwrap();
        let elsewhere = create_folder(&conn, None, "Expensive").unwrap();
        let top = wish(&conn, "o1", 2, Some(ordered.id));
        let deep = wish(&conn, "o2", 1, Some(someday.id));
        let untouched = wish(&conn, "o3", 4, Some(elsewhere.id));

        delete_folder(&conn, ordered.id).unwrap();

        let left: Vec<i64> = list_folders(&conn).unwrap().iter().map(|f| f.id).collect();
        assert_eq!(left, vec![elsewhere.id], "the sub-folder cascaded with it");
        // The wishes are the reader's shopping list and no filing decision throws one away.
        assert_eq!(folder_of(&conn, top), None, "surfaced at the root");
        assert_eq!(folder_of(&conn, deep), None, "and so did the sub-folder's");
        assert_eq!(folder_of(&conn, untouched), Some(elsewhere.id));
        let wishes: i64 = conn
            .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(wishes, 3, "all three wishes are still on the list");
    }

    /// **Shape (a) of the collision the un-filing exists for**: a wish at the root, and the same
    /// card filed in the folder being deleted. Not contrived — it is the feature's own
    /// documented state. Spec §1 accepts that `deck_missing_to_wishlist`,
    /// `deck_theory_missing_to_wishlist` and `wishlist_import_commit` all add at the **root**
    /// and cannot name a folder, so a card the reader has filed acquires a second root row and
    /// `WishRow.elsewhere` exists to advertise it. That exact duplicate is the one that used to
    /// brick the delete: with the re-filing left to `ON DELETE SET NULL`, this answered
    /// `Err("UNIQUE constraint failed: index 'idx_wishlist_grain'")`, nothing moved and the
    /// folder was still there.
    ///
    /// The notes are here rather than in a test of their own because they are what proves the
    /// merge is [`set_wish_folder`]'s and not a second rule: `coalesce(notes, …)` keeps the
    /// destination's and falls back to the source's, so a root row with none ends up wearing
    /// the filed row's.
    #[test]
    fn delete_folder_merges_a_filed_wish_into_the_root_wish_for_the_same_card() {
        let conn = conn();
        let ordered = create_folder(&conn, None, "Ordered").unwrap();
        conn.execute_batch(
            "INSERT INTO wishlist_entries
                (id, oracle_id, name, quantity, notes, folder_id, created_at, updated_at)
             VALUES (1, 'o1', 'Bolt', 1, NULL, NULL, 0, 0),
                    (2, 'o1', 'Bolt', 2, 'ordered on Tuesday', 1, 0, 0);",
        )
        .unwrap();

        delete_folder(&conn, ordered.id).unwrap();

        assert!(
            list_folders(&conn).unwrap().is_empty(),
            "the folder really went -- the collision used to leave it standing"
        );
        let rows: Vec<(i64, Option<i64>, i64, Option<String>)> = conn
            .prepare("SELECT id, folder_id, quantity, notes FROM wishlist_entries ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![(1, None, 3, Some("ordered on Tuesday".to_owned()))],
            "one wish at the root for all three copies, wearing the filed row's note"
        );
    }

    /// **Shape (b), which needs no root row at all**: `Top/A` and `Top/B` each holding the same
    /// card. Neither collides with anything while the folders stand; both land on the *root*
    /// grain the moment the cabinet goes, so they collide with **each other**. That is why the
    /// un-filing is one wish at a time through [`refile_wish`] rather than one `UPDATE` over the
    /// sub-tree — the first to arrive becomes the row the second merges into, and `ORDER BY id`
    /// is what makes which one that is a fact about the table rather than about the planner.
    ///
    /// It also drives the recursive walk two levels deep, which the single-level sub-tree of
    /// [`delete_folder_keeps_its_wishes_and_cascades_its_subfolders`] cannot: nothing is filed
    /// in `Top` itself.
    #[test]
    fn delete_folder_merges_two_subtree_wishes_that_collide_with_each_other() {
        let conn = conn();
        let top = create_folder(&conn, None, "Top").unwrap();
        let a = create_folder(&conn, Some(top.id), "A").unwrap();
        let b = create_folder(&conn, Some(top.id), "B").unwrap();
        let first = wish(&conn, "o1", 2, Some(a.id));
        let second = wish(&conn, "o1", 5, Some(b.id));
        // A card only one of them holds, so the merge is shown to be about the grain and not
        // about "everything in a deleted folder becomes one row".
        let other = wish(&conn, "o2", 1, Some(b.id));

        delete_folder(&conn, top.id).unwrap();

        assert!(
            list_folders(&conn).unwrap().is_empty(),
            "all three cascaded"
        );
        let rows: Vec<(i64, Option<i64>, i64)> = conn
            .prepare("SELECT id, folder_id, quantity FROM wishlist_entries ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![(first, None, 7), (other, None, 1)],
            "the lower id survives and holds both lots of copies; `second` is gone, not zeroed"
        );
        assert_ne!(
            first, second,
            "two rows went in -- the fixture is not vacuous"
        );
    }

    #[test]
    fn delete_folder_is_a_success_for_an_id_that_is_not_there() {
        let conn = conn();
        assert_eq!(delete_folder(&conn, 404), Ok(()));
    }

    #[test]
    fn list_folders_reads_the_tree_shape_and_order() {
        let conn = conn();
        let a = create_folder(&conn, None, "A").unwrap();
        let b = create_folder(&conn, None, "B").unwrap();
        let child = create_folder(&conn, Some(a.id), "A's drawer").unwrap();
        // `B` reordered ahead of `A`, so the order proves `sort_order` rather than the ids
        // happening to agree with it.
        conn.execute(
            "UPDATE wishlist_folders SET sort_order = -1 WHERE id = ?1",
            params![b.id],
        )
        .unwrap();

        let rows = list_folders(&conn).unwrap();

        let order: Vec<i64> = rows.iter().map(|f| f.id).collect();
        assert_eq!(
            order,
            vec![b.id, a.id, child.id],
            "sort_order first, then id -- `A` and its child tie at 0"
        );
        // Flat rows: the nesting is a column, and building the tree is the reader's job.
        assert_eq!(rows[2].parent_id, Some(a.id));
        assert_eq!(rows[1].parent_id, None);
    }

    #[test]
    fn set_wish_folder_moves_a_wish_and_back_to_the_root() {
        let conn = conn();
        let ordered = create_folder(&conn, None, "Ordered").unwrap();
        let id = wish(&conn, "o1", 2, None);

        let moved = set_wish_folder(&conn, id, Some(ordered.id)).unwrap();
        assert_eq!((moved.id, moved.quantity, moved.removed), (id, 2, false));
        assert_eq!(folder_of(&conn, id), Some(ordered.id));

        // `None` is the root and is a real destination.
        let home = set_wish_folder(&conn, id, None).unwrap();
        assert_eq!((home.id, home.quantity, home.removed), (id, 2, false));
        assert_eq!(folder_of(&conn, id), None);
    }

    /// A folder id nothing answers to is refused in words rather than left to the foreign key,
    /// which would name the table and not the mistake — [`crate::deck::set_folder`]'s fence.
    #[test]
    fn set_wish_folder_refuses_a_folder_that_is_not_there() {
        let conn = conn();
        let id = wish(&conn, "o1", 2, None);
        let err = set_wish_folder(&conn, id, Some(404)).unwrap_err();
        assert_eq!(err, FOLDER_GONE);
        assert_eq!(folder_of(&conn, id), None, "and it wrote nothing");
    }

    #[test]
    fn set_wish_folder_merges_onto_a_wish_the_destination_already_holds() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO wishlist_folders (id, parent_id, name, sort_order, created_at, updated_at)
             VALUES (1, NULL, 'Ordered', 0, 0, 0);
             -- The same card, twice: two copies at the root, five already in Ordered.
             INSERT INTO wishlist_entries
                (id, oracle_id, name, quantity, folder_id, created_at, updated_at)
             VALUES (10, 'o1', 'Bolt', 2, NULL, 0, 0),
                    (11, 'o1', 'Bolt', 5, 1,    0, 0);",
        )
        .unwrap();

        let change = set_wish_folder(&conn, 10, Some(1)).unwrap();

        // The destination's id and its summed quantity -- not the source's.
        assert_eq!(change.id, 11);
        assert_eq!(change.quantity, 7);
        assert!(!change.removed);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "the source row is gone, not left at zero");
    }

    #[test]
    fn folder_summary_counts_only_what_is_filed_directly_in_each_folder() {
        let conn = conn();
        priced_card(&conn, "bolt-lea", "o1", "5.00");
        priced_card(&conn, "bear-lea", "o2", "0.25");
        let ordered = create_folder(&conn, None, "Ordered").unwrap();
        let someday = create_folder(&conn, Some(ordered.id), "Someday").unwrap();
        wish(&conn, "o1", 3, Some(ordered.id));
        wish(&conn, "o2", 4, Some(someday.id));
        wish(&conn, "o1", 9, None);
        // One copy already in the binder, so `missing` is not just the quantity: this is
        // `wishlist::OWNED_SQL` doing the subtraction, which is the arithmetic the page header
        // uses too.
        own(&conn, "bolt-lea", 1);

        let rows = folder_summary(&conn, ANY_MARKET).unwrap();

        assert_eq!(rows.len(), 2, "the root is not a folder and draws no tile");
        let (top, inner) = (&rows[0], &rows[1]);
        assert_eq!(top.folder_id, ordered.id);
        assert_eq!(top.wishes, 1, "the sub-folder's wish is the sub-folder's");
        assert_eq!(top.missing, 2, "3 wanted, 1 owned");
        assert!(
            (top.cost - 10.0).abs() < 1e-9,
            "2 x $5.00, got {}",
            top.cost
        );
        assert_eq!(top.unpriced, 0);

        assert_eq!(inner.folder_id, someday.id);
        assert_eq!((inner.wishes, inner.missing), (1, 4));
        assert!((inner.cost - 1.0).abs() < 1e-9, "4 x $0.25");
    }

    /// Two things, because one fixture answers both: what an unpriced wish does to the cost
    /// and to the header's note, and — through the fourth wish — that `missing` is clamped
    /// **per row** rather than after the sum.
    #[test]
    fn folder_summary_leaves_an_unpriced_wish_out_of_the_cost_and_counts_it() {
        let conn = conn();
        priced_card(&conn, "bolt-lea", "o1", "5.00");
        // A printing the marketplace does not quote: `cards.prices` has no `usd` key, which is
        // the shape a card with no TCGplayer listing takes.
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                                prices, raw)
             VALUES ('plain', 'o3', 'Forest', 'lea', '162', 'en', 'normal', '{}', '{}')",
            [],
        )
        .unwrap();
        let ordered = create_folder(&conn, None, "Ordered").unwrap();
        wish(&conn, "o1", 2, Some(ordered.id));
        // A wish for an oracle card no printing answers to — the join finds nothing, so there
        // is no price and three copies still to buy.
        wish(&conn, "ghost", 3, Some(ordered.id));
        // Unpriced too, but the binder already satisfies it. Nothing left to buy is not
        // something the header's "could not price" note is about.
        wish(&conn, "o3", 1, Some(ordered.id));
        own(&conn, "plain", 1);
        // **Over-covered**, and it is the row that tells `sum(max(0, q - owned))` apart from
        // `max(0, sum(q - owned))`. Every other wish in this suite is either short or exactly
        // covered, and on those two formulas agree row for row — so without this one the
        // clamp's *position* is unpinned. Here the reader wants one copy and the binder holds
        // four. Clamped per row it contributes 0 and the folder still needs 5; summed first,
        // its -3 pays for three of the Bolts and the tile reads 2 — a folder claiming there is
        // almost nothing left to buy while three copies are still to find, and a figure that
        // contradicts the page header, which clamps per row. That divergence is exactly what
        // the "one piece of arithmetic" rule exists to prevent.
        priced_card(&conn, "bear-lea", "o4", "0.25");
        wish(&conn, "o4", 1, Some(ordered.id));
        own(&conn, "bear-lea", 4);

        let rows = folder_summary(&conn, ANY_MARKET).unwrap();

        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.wishes, 4);
        assert_eq!(
            row.missing, 5,
            "2 + 3 + 0 + 0 -- clamped per row, never summed first"
        );
        assert!(
            (row.cost - 10.0).abs() < 1e-9,
            "only the priced wish with copies still to find is in the cost, got {}",
            row.cost
        );
        assert_eq!(
            row.unpriced, 1,
            "the ghost, and neither of the two wishes the binder already covers"
        );
    }

    /// A folder's subtotal prices an **any-printing** wish at the cheapest printing, which is
    /// the printing the list above it draws and quotes.
    ///
    /// The two are one join and one price expression on purpose. Before the wishlist took the
    /// cheapest printing both sides said "the newest" and agreed by accident; a change to one
    /// of them alone is exactly how a tile comes to disagree with the rows it is a total of.
    /// The fixture is built so the old rule and the new one differ: `released_at` is NULL on
    /// both printings, so the old clause fell to its `id ASC` tiebreak and took `bolt-a-dear`.
    #[test]
    fn folder_summary_prices_an_any_printing_wish_at_the_cheapest_printing() {
        let conn = conn();
        priced_card(&conn, "bolt-a-dear", "o1", "40.00");
        priced_card(&conn, "bolt-b-cheap", "o1", "2.00");
        let ordered = create_folder(&conn, None, "Ordered").unwrap();
        wish(&conn, "o1", 3, Some(ordered.id));

        let rows = folder_summary(&conn, ANY_MARKET).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].missing, 3);
        assert_eq!(
            rows[0].cost, 6.00,
            "3 × the $2 printing, not 3 × the $40 one the old join reached first"
        );
    }

    /// Every marketplace's price SQL prepares, over a folder that has a row to answer with.
    ///
    /// [`folder_summary`] builds its SQL with `format!`, and [`crate::sorting::price_expr`]
    /// emits a **structurally different** expression per marketplace: a `json_extract` for
    /// TCGplayer, a nested `CASE` for Cardmarket (which has no `eur_etched` key to quote), and
    /// a correlated subquery over `marketplace_prices` referencing `c.id` and the finish for
    /// the two feed-backed ones. A wrong alias in any of those is a run-time `prepare` failure
    /// rather than a compile error, which is why [`crate::wishlist`] guards its own price SQL
    /// the same way — `every_sort_key_prepares_at_every_marketplace`, one module over.
    ///
    /// **Enumerated through [`crate::marketplace::MARKETPLACE_IDS`] rather than hand-listed**,
    /// so a marketplace this test has never seen cannot be added. A `Marketplace` variant that
    /// no id in that list maps to is a variant `Marketplace::from_id` can never produce and no
    /// command can ever be asked for, so the picker's list is the complete one. `cardtrader`
    /// riding along as a second TCGplayer is what using it costs, and it is worth the price:
    /// the sibling modules each keep a hand-written `[Marketplace; 4]`, which is a list
    /// somebody has to remember to extend.
    #[test]
    fn folder_summary_prepares_at_every_marketplace() {
        let conn = conn();
        priced_card(&conn, "bolt-lea", "o1", "5.00");
        let ordered = create_folder(&conn, None, "Ordered").unwrap();
        wish(&conn, "o1", 3, Some(ordered.id));

        for id in crate::marketplace::MARKETPLACE_IDS {
            let rows = folder_summary(&conn, Marketplace::from_id(id))
                .unwrap_or_else(|e| panic!("{id} could not be summed: {e}"));
            // Not merely `is_ok`: an empty answer passes that and proves nothing about the SQL
            // having run over a row. `wishes` and `missing` carry no price, so they are the
            // same two figures whichever marketplace was asked.
            assert_eq!(
                (rows.len(), rows[0].wishes, rows[0].missing),
                (1, 1, 3),
                "at {id}"
            );
        }
    }

    // -- wishlist_folder_reorder --------------------------------------------------------------

    /// Where a folder ended up, out of the answer [`reorder_folders`] gives — which is a fresh
    /// [`list_folders`] over the table, so this is the stored row and not a returned copy of the
    /// request.
    fn placed(rows: &[WishlistFolder], id: i64) -> (Option<i64>, i64) {
        let row = rows
            .iter()
            .find(|r| r.id == id)
            .expect("list_folders answers every folder there is");
        (row.parent_id, row.sort_order)
    }

    /// The whole of what makes this one command rather than two: a drag that re-parents *and*
    /// positions. Both halves are asserted for every id, so writing only the order or only the
    /// parent fails.
    #[test]
    fn wishlist_folder_reorder_writes_the_parent_and_the_position_together() {
        let conn = conn();
        let ordered = create_folder(&conn, None, "Ordered").unwrap();
        let watching = create_folder(&conn, None, "Watching").unwrap();
        let shopping = create_folder(&conn, None, "Shopping").unwrap();
        let soon = create_folder(&conn, Some(shopping.id), "Soon").unwrap();

        let rows = reorder_folders(
            &conn,
            Some(shopping.id),
            &[watching.id, soon.id, ordered.id],
        )
        .unwrap();

        assert_eq!(placed(&rows, watching.id), (Some(shopping.id), 0));
        assert_eq!(placed(&rows, soon.id), (Some(shopping.id), 1));
        assert_eq!(placed(&rows, ordered.id), (Some(shopping.id), 2));
        assert_eq!(
            placed(&rows, shopping.id),
            (None, 2),
            "a folder nobody named is left where it was"
        );
        assert_eq!(rows.len(), 4, "and the answer is the whole cabinet");
    }

    /// Root is `None` and is a destination like any other — the one that cannot cycle.
    #[test]
    fn wishlist_folder_reorder_files_to_the_root() {
        let conn = conn();
        let shopping = create_folder(&conn, None, "Shopping").unwrap();
        let soon = create_folder(&conn, Some(shopping.id), "Soon").unwrap();

        let rows = reorder_folders(&conn, None, &[soon.id, shopping.id]).unwrap();

        assert_eq!(placed(&rows, soon.id), (None, 0));
        assert_eq!(placed(&rows, shopping.id), (None, 1));
    }

    /// `parent_id` CASCADEs onto this same table, so a loop written here is [`move_folder`]'s
    /// disaster exactly — and the fences run before the first `UPDATE`, which is what the
    /// untouched sibling proves.
    #[test]
    fn wishlist_folder_reorder_refuses_a_cycle_and_writes_nothing() {
        let conn = conn();
        let shopping = create_folder(&conn, None, "Shopping").unwrap();
        let soon = create_folder(&conn, Some(shopping.id), "Soon").unwrap();
        let today = create_folder(&conn, Some(soon.id), "Today").unwrap();
        let watching = create_folder(&conn, None, "Watching").unwrap();

        let err = reorder_folders(&conn, Some(today.id), &[watching.id, shopping.id]).unwrap_err();

        assert_eq!(err, FOLDER_CYCLE);
        let unchanged = read_folder(&conn, watching.id).unwrap().unwrap();
        assert_eq!(
            (unchanged.parent_id, unchanged.sort_order),
            (None, 1),
            "the id ahead of the offender in the list must not have been written"
        );
    }

    #[test]
    fn wishlist_folder_reorder_refuses_filing_a_folder_inside_itself() {
        let conn = conn();
        let shopping = create_folder(&conn, None, "Shopping").unwrap();
        let err = reorder_folders(&conn, Some(shopping.id), &[shopping.id]).unwrap_err();
        assert_eq!(err, FOLDER_CYCLE);
    }

    /// [`move_folder`]'s answer to the same mistake, and the transaction is what makes the
    /// already-written half of the list go back.
    #[test]
    fn wishlist_folder_reorder_refuses_an_id_that_is_gone_and_writes_nothing() {
        let conn = conn();
        let shopping = create_folder(&conn, None, "Shopping").unwrap();
        let watching = create_folder(&conn, None, "Watching").unwrap();

        let err = reorder_folders(&conn, None, &[watching.id, 999_999, shopping.id]).unwrap_err();

        assert_eq!(err, FOLDER_GONE);
        let unchanged = read_folder(&conn, watching.id).unwrap().unwrap();
        assert_eq!(
            unchanged.sort_order, 1,
            "the row written before the stale id must have rolled back"
        );
    }

    /// The destination fence [`move_folder`] makes and `deck_meta`'s deliberately does not —
    /// [`require_folder`], the same sentence.
    #[test]
    fn wishlist_folder_reorder_refuses_a_destination_that_is_gone() {
        let conn = conn();
        let shopping = create_folder(&conn, None, "Shopping").unwrap();
        let err = reorder_folders(&conn, Some(999_999), &[shopping.id]).unwrap_err();
        assert_eq!(err, FOLDER_GONE);
    }
}
