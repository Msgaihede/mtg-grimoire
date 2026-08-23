//! Collection folders: the binder's own filing cabinet, one table over from the wishlist's.
//!
//! A port of [`crate::wishlist_folders`], which is itself [`crate::deck_meta`]'s folder half —
//! pure functions over a `Connection`, testable without a Tauri app, wrapped in `async`
//! commands that run on the blocking pool. Writes take `AppState.db` and answer
//! [`crate::db::BUSY`] rather than waiting; the two reads take `db_read` like every read in the
//! app.
//!
//! **A folder is a filing decision the reader makes about copies they own**, not a tag, not a
//! condition and not a second collection. A row is in exactly one place, the same way a deck is
//! in exactly one folder, and `NULL` **is** the root: nothing has to be created for the
//! collection to work, and a reader who never makes a folder sees the table they saw before
//! schema v24.
//!
//! Two cascade rules, and they pull in opposite directions on purpose (schema v24):
//!
//! * `collection_folders.parent_id` is `ON DELETE CASCADE` **onto its own table**, so deleting a
//!   cabinet takes the drawers inside it in one press.
//! * `collection_entries.folder_id` is `ON DELETE SET NULL`, so the same press leaves the
//!   *cards* standing at the root. A folder is where a card was kept; the card is the reader's
//!   property, and no filing decision may throw one away. **That one is a backstop and not the
//!   mechanism**: `folder_id` is the eleventh term of [`crate::schema::COLLECTION_GRAIN`], so
//!   [`delete_folder`] re-files the sub-tree by hand, with the merge, before the row goes — see
//!   there for the two collisions the cascade on its own answered with
//!   `UNIQUE constraint failed`.
//!
//! # What this cabinet has that the wishlist's does not
//!
//! **A folder here can belong to the app rather than to the reader.** `collection_folders.kind`
//! is one of [`crate::schema::COLLECTION_FOLDER_KINDS`]: `user` is a folder the reader made and
//! named, `deck` is the one folder that stands for a deck and carries `deck_id`, and `removed`
//! is the single folder cards go to when they leave the collection without leaving the
//! database. Nothing in *this* module makes either of the latter two — that is the next PR's —
//! but every write here already refuses to touch one, in words, through [`FOLDER_NOT_YOURS`].
//! A fence written after the thing it fences is a fence somebody has to remember to add.
//!
//! **Nothing here writes history.** `deck_meta::delete_folder` is the one folder write in that
//! module that records an audit row, because `decks` has a `deck_audit` to file it under. The
//! collection has no audit log at all, so the asymmetry is the schema's rather than a gap left
//! open here.
//!
//! **[`folder_summary`] names `collection_entries` in its own `FROM`**, which
//! [`crate::collection_source`]'s module doc lists as something only three statements in the
//! crate do. It is a fourth, for the same reason [`crate::collection`]'s `from_sql` is one: it
//! reads the entries as its rows rather than asking a question about them, and there is no
//! fragment there that aggregates. That doc is worth a line the day this file lands.

use crate::collection::{EntryChange, ENTRY_FINISH, GONE};
// The two sentences this module refuses with, taken from the module it is a port of rather
// than re-spelled. A reader who has met "That folder is not there any more." in the deck
// gallery and on the wishlist must meet the same sentence here: it is the same fact about the
// same kind of thing, and `deck_meta::CATEGORY_WRONG_DECK`'s doc is the standing rule — a
// second copy of a refusal is a second thing to drift.
use crate::deck_meta::{FOLDER_CYCLE, FOLDER_GONE};
use crate::sorting::Marketplace;
use crate::sync::{lock_db_read, with_write, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::sync::Arc;

/// What every write here says about a folder that is the **app's** rather than the reader's —
/// the one folder standing for a deck, or the single `removed` folder.
///
/// Local rather than borrowed, because it is a fact this cabinet has and the other two do not:
/// `deck_folders` and `wishlist_folders` carry no `kind` column at all, so there is no sentence
/// in either module to reach for.
///
/// **Said in words rather than left to the schema, and the schema could not say it anyway.**
/// `collection_folders` CHECKs that a `deck` folder names a deck and that the kind is one of
/// three; nothing in the DDL says who may *edit* a row, and a CHECK that could would fire as
/// `CHECK constraint failed: collection_folders`, which names the table and not the mistake.
pub const FOLDER_NOT_YOURS: &str = "That folder is the app's own and is not yours to change.";

/// The kind a folder the reader made and named carries — [`crate::schema::COLLECTION_FOLDER_KINDS`]
/// `[0]`, which is what every write in this module demands and what [`create_folder`] writes.
///
/// `pub(crate)` for one reader outside the module: `collection::folder_named`, the fence on the
/// `folder_id` an *add* names. That write is not this module's, but the question it asks is —
/// and answering it with a second `"user"` literal is how the two would come to disagree the day
/// a fourth kind exists.
pub(crate) const USER_KIND: &str = "user";

/// How far [`move_folder`]'s cycle walk will climb before it calls the chain a cycle.
///
/// [`crate::deck_meta`]'s `MAX_FOLDER_DEPTH`, which is private there, kept at the same number
/// for the same reason: deep enough that no filing anyone does by hand reaches it. See
/// [`move_folder`] for what the budget is actually guarding against, which is not depth.
const MAX_FOLDER_DEPTH: usize = 64;

/// One folder. Flat rows; the tree is the reader's to build from `parent_id`, the way
/// `collection_folders` itself has no notion of depth. `src/lib/folderTree.ts` is the reader.
///
/// `kind` and `deck_id` are on the wire because the **page** has to draw a deck's folder and the
/// removed-cards folder differently from a binder the reader named — and because a row it may
/// not rename is a row whose menu should say so before the refusal does.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionFolder {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub kind: String,
    pub deck_id: Option<i64>,
    pub sort_order: i64,
}

/// What one folder tile is drawn from — the two numbers, per folder, in one round trip.
///
/// **Direct per folder, never recursive**, and that is the load-bearing decision. The tree
/// builder on the TypeScript side (`src/lib/folderTree.ts`) already sums a node's children for
/// the deck gallery and the wishlist, and does it here for the same reason: SQL that walked the
/// tree would be a second implementation of arithmetic that is already written, tested and drawn
/// from, and two implementations of one figure disagree the first time either changes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionFolderSummary {
    pub folder_id: i64,
    /// **Copies** filed directly in this folder, not rows — `sum(quantity)`, which is
    /// [`crate::collection::CollectionSummary::total_cards`]' arithmetic and its reason: a row
    /// stepped to zero is a real row here, so a tile counting rows would be wrong the first time
    /// somebody trades a playset away. The tree sums it across children; SQL does not.
    pub cards: i64,
    /// What those copies are worth at the named marketplace, `sum(quantity * unit_price)` over
    /// [`crate::sorting::price_expr`] — the collection header's own expression, so a tile and
    /// the header can never quote one folder at two prices.
    ///
    /// **`None` rather than `0.0` when the marketplace prices nothing in the folder**, which is
    /// where this parts company with the header's `coalesce(…, 0.0)`. A tile is a small number
    /// beside a name and has no room for the header's "n unpriced" note, so a folder of cards
    /// the feed has never heard of would otherwise read as a folder worth nothing. `None` draws
    /// an em dash, which is this app's answer for a price it does not have.
    pub value: Option<f64>,
}

/// A name good enough for a folder — trimmed, non-empty. [`crate::wishlist_folders`]'s
/// `valid_name`, which is private there, in the one shape this module needs it: a blank string
/// would end up on a tile no one can read, and the refusal is the same sentence the gallery and
/// the wishlist give.
fn valid_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    (!name.is_empty())
        .then_some(name)
        .ok_or_else(|| "A folder needs a name.".to_owned())
}

fn folder_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CollectionFolder> {
    Ok(CollectionFolder {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        name: r.get(2)?,
        kind: r.get(3)?,
        deck_id: r.get(4)?,
        sort_order: r.get(5)?,
    })
}

fn read_folder(conn: &Connection, id: i64) -> Result<Option<CollectionFolder>, String> {
    conn.query_row(
        "SELECT id, parent_id, name, kind, deck_id, sort_order
           FROM collection_folders WHERE id = ?1",
        params![id],
        folder_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The folder `id` names, refused in words unless it is one the **reader** owns.
///
/// One helper for both halves of every write, because the two questions are always asked
/// together and always in this order: a folder that is not there cannot be the app's, and an id
/// nothing answers to is [`FOLDER_GONE`] whichever side of a move it was on.
///
/// **Every fence in this module is a statement of its own rather than a constraint failure**,
/// which is [`crate::deck::set_folder`]'s reasoning twice over. `collection_entries.folder_id`
/// and `collection_folders.parent_id` are real foreign keys between user tables, so a write
/// naming a folder that is gone *does* fail — with `FOREIGN KEY constraint failed`, a sentence
/// about a constraint, and only while `PRAGMA foreign_keys` happens to be on, which is a
/// per-connection setting. Nothing in the DDL refuses the *kind* at all.
fn user_folder(conn: &Connection, id: i64) -> Result<CollectionFolder, String> {
    let folder = read_folder(conn, id)?.ok_or_else(|| FOLDER_GONE.to_owned())?;
    if folder.kind != USER_KIND {
        return Err(FOLDER_NOT_YOURS.to_owned());
    }
    Ok(folder)
}

/// Every folder there is, flat, `ORDER BY sort_order, id`. No scoping of any kind — a folder
/// belongs to no card, it files them — and **no filtering by kind**: a deck's folder and the
/// removed-cards folder are places cards are, so a page that could not see them would draw a
/// tree the collection does not have.
pub fn list_folders(conn: &Connection) -> Result<Vec<CollectionFolder>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, parent_id, name, kind, deck_id, sort_order
               FROM collection_folders ORDER BY sort_order, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], folder_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Make a new folder under `parentId` (root, if `None`). No uniqueness rule on the name —
/// `collection_folders` carries no grain constant and no unique index on `(parent_id, name)`, so
/// two sibling folders may share one, exactly as two sibling `deck_folders` may.
///
/// **The new folder is always a `user` one, and the kind is written rather than defaulted.**
/// The column's `DEFAULT 'user'` would do it; `deck_categories.origin`'s rule is that each
/// writer spells its own answer, because a default is a decision nobody can see at the call
/// site. Nothing in this PR creates a `deck` or a `removed` folder.
///
/// **The parent is fenced in words**, [`user_folder`]'s two refusals: a parent that is gone is
/// [`FOLDER_GONE`], and nothing may be filed *inside* a folder the app owns — a drawer in the
/// removed-cards folder is a place the app would have to have an opinion about, and it has
/// none. (`wishlist_folders::create_folder` leans on its foreign key here and is left with that
/// hole, for the reason its `move_folder` gives: fixing one side of a ported pair is a
/// difference somebody later reads as intentional. This side needs the row anyway, for the
/// kind.)
///
/// **The `id` is SQLite's and is never supplied.** `INTEGER PRIMARY KEY` is what makes
/// [`crate::schema::COLLECTION_GRAIN`]'s eleventh term — `coalesce(folder_id, 0)` — safe, and
/// the guarantee is narrower than it looks: SQLite never *auto-assigns* rowid 0, but it will
/// happily store an explicit one. A folder numbered 0 would be indistinguishable from the root
/// on the grain, so every card in it would collide with the reader's unfiled copies of the same
/// printing. Letting the database assign is the whole of the fence.
pub fn create_folder(
    conn: &Connection,
    parent_id: Option<i64>,
    name: &str,
) -> Result<CollectionFolder, String> {
    let name = valid_name(name)?;
    if let Some(parent) = parent_id {
        user_folder(conn, parent)?;
    }
    // `IS`, not `=`: `parent_id` is nullable (root), and `=` never matches a bound NULL.
    let next_order: i64 = conn
        .query_row(
            "SELECT coalesce(max(sort_order), -1) + 1 FROM collection_folders WHERE parent_id IS ?1",
            params![parent_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let id: i64 = conn
        .query_row(
            "INSERT INTO collection_folders
                (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, ?4, unixepoch(), unixepoch())
             RETURNING id",
            params![parent_id, name, USER_KIND, next_order],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    read_folder(conn, id)?.ok_or_else(|| FOLDER_GONE.to_owned())
}

/// Rename a folder the reader made. A deck's folder is named after its deck and the
/// removed-cards folder after what it is for, so neither is [`FOLDER_NOT_YOURS`] by accident.
pub fn rename_folder(conn: &Connection, id: i64, name: &str) -> Result<CollectionFolder, String> {
    let name = valid_name(name)?;
    user_folder(conn, id)?;
    conn.execute(
        "UPDATE collection_folders SET name = ?2, updated_at = unixepoch() WHERE id = ?1",
        params![id, name],
    )
    .map_err(|e| e.to_string())?;
    read_folder(conn, id)?.ok_or_else(|| FOLDER_GONE.to_owned())
}

/// Move a folder under a new parent (root, if `None`). **Refuses a cycle**: walks `parent_id`
/// upward from the *proposed* parent, and if that walk ever meets `id` — immediately, if
/// `parentId` names `id` itself — refuses rather than writing a loop `parent_id`'s own
/// `ON DELETE CASCADE` would otherwise walk forever the day one of them is deleted.
///
/// **Both ends are fenced in words before anything is walked**, and the order differs from
/// `wishlist_folders::move_folder`'s on purpose: that one checks the destination first and lets
/// a subject that is gone fall out of `changed == 0`, which cannot answer [`FOLDER_NOT_YOURS`]
/// because it never reads the row. Here the subject is read first — a folder the app owns is
/// refused whether or not the parent it was aimed at exists — and the destination second, where
/// [`user_folder`] refuses filing a drawer inside the app's own cabinet as well as a parent that
/// is not there. The cycle walk cannot stand in for either check: `optional()?.flatten()` folds
/// "no such folder" and "that folder is at the root" into one `None`, so the climb ends on the
/// first hop and an id nothing answers to would sail through.
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
) -> Result<CollectionFolder, String> {
    user_folder(conn, id)?;
    if let Some(start) = parent_id {
        user_folder(conn, start)?;
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
                    "SELECT parent_id FROM collection_folders WHERE id = ?1",
                    params![candidate],
                    |r| r.get::<_, Option<i64>>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .flatten();
        }
    }
    conn.execute(
        "UPDATE collection_folders SET parent_id = ?2, updated_at = unixepoch() WHERE id = ?1",
        params![id, parent_id],
    )
    .map_err(|e| e.to_string())?;
    read_folder(conn, id)?.ok_or_else(|| FOLDER_GONE.to_owned())
}

/// Delete a folder. **Does not delete the cards in it** — they surface at the root, filed
/// nowhere, still exactly as they were. Sub-folders go with it. Like
/// [`crate::deck_meta::delete_folder`] and [`crate::deck::delete_deck`], an id that resolves to
/// nothing is a success: the caller wanted that folder gone, and it is gone. A folder the **app**
/// owns is the one id that is not — [`FOLDER_NOT_YOURS`], because a deck's folder disappears
/// when its deck does and the removed-cards folder is the app's own drawer.
///
/// # Why the un-filing is written out and not left to the cascade
///
/// `collection_entries.folder_id` is `ON DELETE SET NULL` (schema v24), and for one press it
/// looks like the whole answer: one `DELETE`, every card in the sub-tree re-filed at the root.
/// It is not, because **that cascade rewrites the eleventh term of
/// [`crate::schema::COLLECTION_GRAIN`]** on every one of those rows, and a write that changes an
/// entry's grain has to say what it will land on. Every other write in the crate does —
/// [`crate::collection::add_entry`] through `ON CONFLICT`, [`set_entry_folder`] through the merge
/// below, `reconcile::fold_into_existing` through its own — and leaving this one to
/// `idx_collection_grain` reaches the reader as `UNIQUE constraint failed`, with the folder still
/// standing and nothing moved, in two shapes:
///
/// * a card in the sub-tree and an **unfiled** row for the same printing at the same grain,
///   which is the state every writer that cannot name a folder produces — a quick add from the
///   search, an import, the reconciler's fold.
/// * **two sub-tree rows colliding with each other**, needing no root row at all: `Binder/A` and
///   `Binder/B` each holding the same printing land on one grain the moment both reach the root.
///
/// So the sub-tree's entries are collected and re-filed one at a time through [`refile_entry`],
/// with [`set_entry_folder`]'s merge rule and not a second copy of it, **before** the folder row
/// goes. By the time the `DELETE` runs every card beneath it is already at the root, so the
/// `SET NULL` has nothing left to rewrite and nothing left to collide on. One at a time is what
/// answers the second shape as well as the first: the first row to reach the root becomes the
/// row the next one merges into.
///
/// `parent_id`'s `ON DELETE CASCADE` onto its own table is still the DDL's work and still done
/// by one statement — a folder inside a deleted folder has nowhere else to be, and no grain is
/// involved. **It therefore still depends on `PRAGMA foreign_keys` being ON**, which is
/// per-connection. [`crate::db::open`] sets it for every connection the app hands out, so the
/// app path is covered; a test that opens its own connection has to say so itself, and the
/// `open()` helper below does.
///
/// One transaction throughout: mid-delete the cards are all re-filed and the folder is gone, or
/// none of it happened.
pub fn delete_folder(conn: &Connection, id: i64) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Not [`user_folder`]: an id that is not there is a **success** here, so the two halves of
    // that helper come apart. Only a folder that exists and is the app's is refused.
    if let Some(folder) = read_folder(&tx, id)? {
        if folder.kind != USER_KIND {
            return Err(FOLDER_NOT_YOURS.to_owned());
        }
    }
    // The sub-tree, in the database rather than in a Rust walk, because the cascade this stands
    // in front of is itself recursive and the two must agree about which folders are doomed —
    // **including any the app owns**, which is why nothing here filters on `kind`: the CASCADE
    // does not, so a walk that did would leave those folders' cards to `SET NULL` and the very
    // collision this function exists to answer.
    // **`UNION` and never `UNION ALL`**: a `parent_id` cycle that arrived some other way — a
    // hand-edited database, a restored backup — is what [`move_folder`]'s hop budget exists for,
    // and here the duplicate-row check is what makes the same corruption converge instead of
    // looping. `ORDER BY e.id` so the row a merge folds into is decided by the table and not by
    // the planner.
    let filed: Vec<i64> = {
        let mut stmt = tx
            .prepare(
                "WITH RECURSIVE doomed(id) AS (
                     SELECT ?1
                     UNION
                     SELECT f.id FROM collection_folders f JOIN doomed d ON f.parent_id = d.id
                 )
                 SELECT e.id FROM collection_entries e
                  WHERE e.folder_id IN (SELECT id FROM doomed)
                  ORDER BY e.id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    };
    // A merge only ever deletes the row it was *given*, so no id in this list can go before its
    // turn and [`refile_entry`]'s [`GONE`] is unreachable from here. It is propagated rather
    // than skipped anyway: if it ever did fire, something is deleting entries underneath this
    // transaction, and rolling the whole press back is the only honest answer to that.
    for entry in filed {
        refile_entry(&tx, entry, None)?;
    }
    tx.execute("DELETE FROM collection_folders WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Move one entry into a folder, or — with `None` — back to the **root of the collection**.
///
/// `None` is a real destination rather than an omission, [`crate::deck::set_folder`]'s point one
/// table over: the root is where every card starts and is the only place an unfiled row can be,
/// so there is nothing else `None` could mean here.
///
/// **A command of its own, because filing is not adding.** `folder_id` is the eleventh term of
/// [`crate::schema::COLLECTION_GRAIN`] (schema v24), which is what makes "Add to \<binder\>" an
/// *add*: the same printing filed in two places is two rows, so an add can never silently move a
/// row the reader filed last week. The cost of that guarantee is exactly this command — moving
/// between folders has to be something the reader says out loud.
///
/// **The destination is fenced in words, and the kind half of that fence is this cabinet's
/// own**: nothing may be filed into a `deck` folder or the `removed` one by hand. Those two say
/// something the app is responsible for — that a deck holds these copies, that these copies have
/// left the collection — and a reader dragging a card into one would be asserting it without any
/// of the writes that make it true. [`refile_entry`] carries no such fence, which is what lets
/// the next PR's deck-driven writes file into exactly those folders.
pub fn set_entry_folder(
    conn: &Connection,
    id: i64,
    folder_id: Option<i64>,
) -> Result<EntryChange, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if let Some(folder) = folder_id {
        user_folder(&tx, folder)?;
    }
    refile_entry(&tx, id, folder_id).and_then(|change| {
        tx.commit().map_err(|e| e.to_string())?;
        Ok(change)
    })
}

/// The ten grain columns [`refile_entry`] does **not** touch, plus the quantity the merge moves.
///
/// A struct where `wishlist_folders::refile_wish` uses a tuple, and only because the wishlist's
/// grain is four terms and this one is eleven: a `(String, String, String, String, i64, i64,
/// i64, i64, Option<String>, Option<String>, i64)` in a `let` binding is a shape nobody can
/// check against the `SELECT` above it by eye, which is the one thing this read has to get right.
///
/// The four booleans are read as `i64` rather than `bool`. They are `INTEGER NOT NULL DEFAULT 0`
/// with no CHECK, so a hand-edited database can hold a 2 — and the point of this struct is to
/// hand the same value back to the probe, not to interpret it.
struct EntryGrain {
    card_id: String,
    finish: String,
    condition: String,
    lang: String,
    altered: i64,
    signed: i64,
    proxy: i64,
    misprint: i64,
    serial_number: Option<String>,
    grading: Option<String>,
    quantity: i64,
}

/// The filing write itself, with no fence and no transaction of its own: move entry `id` onto
/// `folder_id`, folding it into whatever already holds that grain.
///
/// **Factored out because [`delete_folder`] needs the very same rule**, and the collection's
/// merge had already been written twice in this crate before it did — a third copy in the
/// un-filing path is how they would come to disagree about what a duplicate row is. It takes a
/// `&Connection` rather than a `&Transaction` so either caller's `unchecked_transaction` handle
/// fits, and it commits nothing: whoever opened the transaction owns it, which is what lets the
/// delete run this once per entry in a sub-tree and still be one press.
///
/// **`pub(crate)` because the deck-driven writes are the next PR's caller.** They file into the
/// two folders [`set_entry_folder`] refuses, which is exactly the difference between the
/// command's fence and this function's absence of one.
///
/// [`set_entry_folder`] is where the rule is argued; the paragraph above it is the one to read.
pub(crate) fn refile_entry(
    tx: &Connection,
    id: i64,
    folder_id: Option<i64>,
) -> Result<EntryChange, String> {
    // Read before anything is decided, because "is that entry still there?" is answered by the
    // same statement — an `UPDATE` that changed no rows cannot tell a missing row apart from a
    // grain collision, and the two want opposite answers.
    let source = tx
        .query_row(
            "SELECT card_id, finish, condition, lang, altered, signed, proxy, misprint,
                    serial_number, grading, quantity
               FROM collection_entries WHERE id = ?1",
            params![id],
            |r| {
                Ok(EntryGrain {
                    card_id: r.get(0)?,
                    finish: r.get(1)?,
                    condition: r.get(2)?,
                    lang: r.get(3)?,
                    altered: r.get(4)?,
                    signed: r.get(5)?,
                    proxy: r.get(6)?,
                    misprint: r.get(7)?,
                    serial_number: r.get(8)?,
                    grading: r.get(9)?,
                    quantity: r.get(10)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| GONE.to_owned())?;

    // The grain the write is *about to land on*, spelled out rather than interpolated from
    // [`crate::schema::COLLECTION_GRAIN`] for the reason `reconcile::collision_target` gives:
    // that constant is a list of expressions over **one row**, and this compares the same list
    // against eleven bound values.
    //
    // **Every term is here, and the eleventh is the one that matters.** A fold that matched on
    // ten of them would merge this row into a row *in another folder* — copies leaving the
    // binder the reader put them in, silently, on a press that was supposed to move them
    // somewhere else. That is not hypothetical: `reconcile::collision_target` shipped with ten
    // for exactly as long as v24 took to widen the grain, and folded across folders until it
    // was corrected in this same release. **So the rule is: every writer that probes for a
    // collided collection row spells all eleven terms**, and each one is pinned by a test of
    // its own — `a_refile_matching_ten_of_the_eleven_terms_does_not_merge` here, and
    // `reconcile::tests::a_repointed_entry_folds_only_onto_an_entry_in_its_own_folder` there.
    //
    // At most one row can match, because these eleven terms *are* `idx_collection_grain`.
    let target: Option<(i64, i64)> = tx
        .query_row(
            "SELECT id, quantity FROM collection_entries
              WHERE id <> ?1
                AND card_id = ?2
                AND finish = ?3
                AND condition = ?4
                AND lang = ?5
                AND altered = ?6
                AND signed = ?7
                AND proxy = ?8
                AND misprint = ?9
                AND coalesce(serial_number,'') = coalesce(?10,'')
                AND coalesce(grading,'') = coalesce(?11,'')
                AND coalesce(folder_id,0) = coalesce(?12,0)",
            params![
                id,
                source.card_id,
                source.finish,
                source.condition,
                source.lang,
                source.altered,
                source.signed,
                source.proxy,
                source.misprint,
                source.serial_number,
                source.grading,
                folder_id
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some((target, held)) = target {
        merge_entry(tx, target, id)?;
        return Ok(EntryChange {
            id: target,
            quantity: held + source.quantity,
            removed: false,
        });
    }

    // NULL is a value here rather than an omission, for the reason
    // [`crate::collection::update_entry`]'s `coalesce(?n, column)` convention gives: "leave it"
    // is what that spelling means everywhere else in the crate, and using it here would make
    // "back to the root" unexpressible — which is half of what this function is for.
    tx.execute(
        "UPDATE collection_entries SET folder_id = ?2, updated_at = unixepoch() WHERE id = ?1",
        params![id, folder_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity: source.quantity,
        removed: false,
    })
}

/// Fold `source` into `target` and delete it — this module's name for
/// [`crate::collection::fold_entry`], which is the crate's **one** answer to "one collection row
/// becomes another" and where every rule about what moves is argued.
///
/// **It was a second copy of those five statements until fan-in.** Two implementations of one
/// rule disagree the first time either changes, and this one guards a built deck's claims:
/// `deck_allocations.collection_entry_id` is `ON DELETE CASCADE`, so a fold that deleted the
/// source row outright would silently unbuild whatever deck had reserved from it. That is not a
/// rule to hold in two places.
///
/// The wrapper stays because this module's callers are `Result<_, String>` throughout while
/// `fold_entry` answers `rusqlite::Result` for the reconciler's sake — one `map_err` here rather
/// than one per call site, and one name for the folder tree's own vocabulary.
fn merge_entry(tx: &Connection, target: i64, source: i64) -> Result<(), String> {
    crate::collection::fold_entry(tx, target, source).map_err(|e| e.to_string())
}

/// The two numbers each folder tile draws, one row per folder that holds at least one entry.
///
/// **Every figure is [`crate::collection`]'s own arithmetic rather than a second spelling of
/// it.** The unit price is [`crate::sorting::price_expr`] over
/// [`crate::collection::ENTRY_FINISH`] — the entry's own finish, which is why the table is
/// aliased `e` and `cards` is aliased `c`: both aliases are part of that constant's contract.
/// A folder's subtotal and the page header's total have to be one piece of arithmetic; two
/// implementations of one figure disagree the first time either changes.
///
/// The join is `collection::from_sql`'s, verbatim in shape and a `LEFT JOIN` for its reason: an
/// entry whose printing is gone is exactly what the denormalised columns exist for, and an inner
/// join would drop those rows out of the tile that most needs them. It is spelled out here
/// rather than shared because that function is private to its module.
///
/// **`WHERE folder_id IS NOT NULL`**: the root is not a folder and has no tile to draw. What is
/// at the root is what the unfiltered table already shows.
///
/// **An empty folder produces no row at all**, which is the shape rule a caller has to know: a
/// page cannot build its tree from this command. [`list_folders`] is the census, and this is a
/// lookup layered onto it.
pub fn folder_summary(
    conn: &Connection,
    marketplace: Marketplace,
) -> Result<Vec<CollectionFolderSummary>, String> {
    let sql = format!(
        "SELECT e.folder_id,
                coalesce(sum(e.quantity), 0) AS cards,
                sum(e.quantity * {price}) AS value
           FROM collection_entries e
           LEFT JOIN cards c ON c.id = e.card_id
          WHERE e.folder_id IS NOT NULL
          GROUP BY e.folder_id
          ORDER BY e.folder_id",
        price = crate::sorting::price_expr(marketplace, ENTRY_FINISH)
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CollectionFolderSummary {
                folder_id: r.get(0)?,
                cards: r.get(1)?,
                value: r.get(2)?,
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
/// [`crate::wishlist_folders`]'s helper of the same name, named for this table instead.
fn unfinished(e: tauri::Error) -> String {
    format!("the collection's folders could not be written: {e}")
}

/// **Read-only** connection, like every list in the app.
#[tauri::command]
pub async fn collection_folder_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<CollectionFolder>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_folders(&lock_db_read(&state)))
        .await
        .map_err(|e| format!("the collection folders could not be read: {e}"))?
}

#[tauri::command]
pub async fn collection_folder_create(
    state: tauri::State<'_, Arc<AppState>>,
    parent_id: Option<i64>,
    name: String,
) -> Result<CollectionFolder, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| create_folder(c, parent_id, &name))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn collection_folder_rename(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    name: String,
) -> Result<CollectionFolder, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| rename_folder(c, id, &name))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn collection_folder_move(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    parent_id: Option<i64>,
) -> Result<CollectionFolder, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| move_folder(c, id, parent_id))
    })
    .await
    .map_err(unfinished)?
}

/// The cards inside surface at the root and the sub-folders go too — see [`delete_folder`],
/// where the sub-folders are the DDL's work and the cards are emphatically not.
///
/// **`with_write` and not `with_write_owned`**, unlike the command below it: every entry this
/// touches keeps its `card_id`, and a merge deletes a row whose printing the survivor also
/// names, so the set of *cards* the reader owns cannot move. The facet index's `owned` dimension
/// is one rowid per owned card ([`crate::collection_source::owned_rowids`]), and rebuilding it
/// here would be a full copy to arrive at the answer it already holds.
#[tauri::command]
pub async fn collection_folder_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| delete_folder(c, id)))
        .await
        .map_err(unfinished)?
}

/// "Move to …", and "Move to the collection" — see [`set_entry_folder`] for the merge, which is
/// why this answers an [`EntryChange`] whose `id` is not always the `id` it was given.
///
/// **[`crate::collection_source::with_write_owned`], where the four folder writes above take
/// `sync::with_write`**: filing a row changes which rows exist — a merge deletes one — and the
/// facet index's `owned` dimension is built by counting them.
#[tauri::command]
pub async fn collection_set_folder(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    folder_id: Option<i64>,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |c| set_entry_folder(c, id, folder_id))
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

/// **Read-only**, and priced at the marketplace the caller names — anything the app does not
/// know is TCGplayer, [`crate::sorting::Marketplace::from_opt`]'s rule for every list query.
#[tauri::command]
pub async fn collection_folder_summary(
    state: tauri::State<'_, Arc<AppState>>,
    marketplace: Option<String>,
) -> Result<Vec<CollectionFolderSummary>, String> {
    let state = state.inner().clone();
    let marketplace = Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || folder_summary(&lock_db_read(&state), marketplace))
        .await
        .map_err(|e| format!("the collection folder totals could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **`foreign_keys` is ON, and here that is not ceremony**: the two cascade rules
    /// [`delete_folder`] leans on are per-connection settings, and an in-memory connection
    /// starts with them off. Without this line the delete tests would report a folder deleted
    /// and its sub-tree left standing — a green suite over a broken feature.
    /// [`crate::db::open`] sets the same pragma for every connection the app hands out.
    fn open() -> Connection {
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
    fn priced_card(conn: &Connection, id: &str, usd: &str) {
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                                prices, raw)
             VALUES (?1, 'o1', 'Lightning Bolt', 'lea', '161', 'en', 'normal', ?2, '{}')",
            params![id, format!(r#"{{"usd":"{usd}"}}"#)],
        )
        .unwrap();
    }

    /// One owned row, written straight into the table: [`crate::collection::add_entry`] is the
    /// command that makes one, and these tests need nothing from it but a row to file. Every
    /// column outside `card_id` and `folder_id` is held constant, so those two **are** the
    /// grain as far as this suite is concerned.
    fn insert_entry(
        conn: &Connection,
        card_id: &str,
        folder_id: Option<i64>,
        quantity: i64,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                (card_id, set_code, collector_number, lang, finish, condition, quantity,
                 folder_id, created_at, updated_at)
             VALUES (?1, 'lea', '161', 'en', 'nonfoil', 'NM', ?2, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![card_id, quantity, folder_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A folder the **app** owns, written straight into the table because no command in this PR
    /// makes one — the deck-driven writes that do are the next PR's. `deck` needs a deck to
    /// name: `collection_folders` CHECKs `(kind = 'deck') = (deck_id IS NOT NULL)`, so the two
    /// cannot be seeded apart.
    fn insert_system_folder(conn: &Connection, kind: &str, name: &str) -> i64 {
        let deck_id: Option<i64> = (kind == "deck").then(|| {
            conn.query_row(
                "INSERT INTO decks (name, created_at, updated_at)
                 VALUES ('A deck', unixepoch(), unixepoch()) RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        conn.query_row(
            "INSERT INTO collection_folders
                (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
             VALUES (NULL, ?1, ?2, ?3, 0, unixepoch(), unixepoch())
             RETURNING id",
            params![name, kind, deck_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Where an entry is filed, straight from the column.
    fn folder_of(conn: &Connection, id: i64) -> Option<i64> {
        conn.query_row(
            "SELECT folder_id FROM collection_entries WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn create_folder_puts_a_folder_at_the_root_and_inside_another() {
        let conn = open();
        let binder = create_folder(&conn, None, "Binder").unwrap();
        let trades = create_folder(&conn, None, "Trades").unwrap();
        let rares = create_folder(&conn, Some(binder.id), "Rares").unwrap();
        let lands = create_folder(&conn, Some(binder.id), "Lands").unwrap();

        assert_eq!(binder.parent_id, None, "None is the root");
        assert_eq!(rares.parent_id, Some(binder.id), "and it round-trips");
        assert_eq!(
            read_folder(&conn, rares.id).unwrap().unwrap().parent_id,
            Some(binder.id),
            "from the table, not just from the answer"
        );

        // The kind is written, not defaulted, and a folder the reader made is never a deck's.
        assert_eq!((binder.kind.as_str(), binder.deck_id), ("user", None));

        // `max + 1` **among siblings**, which is why the first child starts at 0 again rather
        // than continuing the root's numbering.
        assert_eq!((binder.sort_order, trades.sort_order), (0, 1));
        assert_eq!((rares.sort_order, lands.sort_order), (0, 1));

        // Never an explicit id: `COLLECTION_GRAIN`'s `coalesce(folder_id, 0)` is only safe while
        // no folder can be 0, and SQLite guarantees that only for ids it assigns itself.
        assert!(binder.id > 0, "SQLite assigned it, and never 0");
    }

    #[test]
    fn create_folder_refuses_a_blank_name() {
        let conn = open();
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

    /// Both halves of the parent fence, which `wishlist_folders::create_folder` leaves to its
    /// foreign key: an id nothing answers to, and a folder the app owns.
    #[test]
    fn create_folder_refuses_a_parent_that_is_gone_or_the_apps() {
        let conn = open();
        assert_eq!(
            create_folder(&conn, Some(404), "Rares").unwrap_err(),
            FOLDER_GONE
        );
        let sys = insert_system_folder(&conn, "removed", "Recently removed");
        assert_eq!(
            create_folder(&conn, Some(sys), "Rares").unwrap_err(),
            FOLDER_NOT_YOURS
        );
        assert_eq!(
            list_folders(&conn).unwrap().len(),
            1,
            "neither refused create wrote a folder"
        );
    }

    #[test]
    fn rename_folder_writes_the_new_name() {
        let conn = open();
        let folder = create_folder(&conn, None, "Binder").unwrap();

        let returned = rename_folder(&conn, folder.id, "  Trade binder  ").unwrap();
        assert_eq!(returned.name, "Trade binder", "trimmed, like the create");
        let stored: String = conn
            .query_row(
                "SELECT name FROM collection_folders WHERE id = ?1",
                params![folder.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, "Trade binder");

        let err = rename_folder(&conn, folder.id, " ").unwrap_err();
        assert_eq!(err, "A folder needs a name.");
        assert_eq!(
            rename_folder(&conn, 404, "Anything").unwrap_err(),
            FOLDER_GONE
        );
        let unchanged: String = conn
            .query_row(
                "SELECT name FROM collection_folders WHERE id = ?1",
                params![folder.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            unchanged, "Trade binder",
            "the refused rename wrote nothing"
        );
    }

    #[test]
    fn move_folder_moves_to_a_new_parent_and_then_back_to_root() {
        let conn = open();
        let binder = create_folder(&conn, None, "Binder").unwrap();
        let rares = create_folder(&conn, None, "Rares").unwrap();

        let moved = move_folder(&conn, rares.id, Some(binder.id)).unwrap();
        assert_eq!(moved.parent_id, Some(binder.id));

        // `None` is a destination, not an omission — the root is a real place.
        let home = move_folder(&conn, rares.id, None).unwrap();
        assert_eq!(home.parent_id, None);
        assert_eq!(
            read_folder(&conn, rares.id).unwrap().unwrap().parent_id,
            None
        );
    }

    /// The required case, and the shape the wishlist's own cycle test does not cover: `B` is
    /// already inside `A`, so the walk from the *proposed* parent meets `id` on its second hop
    /// rather than its first.
    #[test]
    fn a_move_that_would_write_a_loop_is_refused_in_words() {
        let conn = open();
        let a = create_folder(&conn, None, "A").unwrap();
        let b = create_folder(&conn, Some(a.id), "B").unwrap();
        let err = move_folder(&conn, a.id, Some(b.id)).unwrap_err();
        assert_eq!(err, FOLDER_CYCLE);
    }

    #[test]
    fn move_folder_refuses_moving_a_folder_into_itself_directly() {
        let conn = open();
        let binder = create_folder(&conn, None, "Binder").unwrap();
        let err = move_folder(&conn, binder.id, Some(binder.id)).unwrap_err();
        assert_eq!(err, FOLDER_CYCLE);
    }

    /// The destination, which the cycle walk cannot check and does not.
    /// `optional()?.flatten()` folds "no such folder" into the same `None` as "that folder is at
    /// the root", so the climb ends on the first hop and an id nothing answers to would sail
    /// through to the `UPDATE` — which refuses it as `FOREIGN KEY constraint failed`, a sentence
    /// about a constraint, and only while `PRAGMA foreign_keys` is on.
    #[test]
    fn move_folder_refuses_a_parent_that_is_not_there() {
        let conn = open();
        let binder = create_folder(&conn, None, "Binder").unwrap();
        let rares = create_folder(&conn, Some(binder.id), "Rares").unwrap();

        let err = move_folder(&conn, rares.id, Some(404)).unwrap_err();

        assert_eq!(err, FOLDER_GONE);
        assert_eq!(
            read_folder(&conn, rares.id).unwrap().unwrap().parent_id,
            Some(binder.id),
            "and the refused move wrote nothing"
        );
        // `None` is the root and is always a destination -- the one parent there is no row to
        // look up, so the fence must not reach it.
        move_folder(&conn, rares.id, None).unwrap();
        assert_eq!(
            read_folder(&conn, rares.id).unwrap().unwrap().parent_id,
            None
        );
    }

    /// The walk that *keeps* the tree acyclic cannot assume it is, and this is the case that
    /// proves the hop budget rather than the `candidate == id` arm: a cycle written straight
    /// into the table, between two folders neither of which is the one being moved. The walk
    /// from the proposed parent therefore never meets `id` and would climb for ever — inside
    /// `spawn_blocking`, holding the app-wide write lock, so it is every write in the app that
    /// stops rather than this one command.
    #[test]
    fn move_folder_gives_up_on_a_cycle_it_did_not_write() {
        let conn = open();
        let a = create_folder(&conn, None, "A").unwrap();
        let b = create_folder(&conn, Some(a.id), "B").unwrap();
        let moving = create_folder(&conn, None, "C").unwrap();
        // Corruption this module cannot produce: a hand-edited database, a restored backup.
        conn.execute(
            "UPDATE collection_folders SET parent_id = ?2 WHERE id = ?1",
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
    fn list_folders_reads_the_tree_shape_and_order() {
        let conn = open();
        let a = create_folder(&conn, None, "A").unwrap();
        let b = create_folder(&conn, None, "B").unwrap();
        let child = create_folder(&conn, Some(a.id), "A's drawer").unwrap();
        // `B` reordered ahead of `A`, so the order proves `sort_order` rather than the ids
        // happening to agree with it.
        conn.execute(
            "UPDATE collection_folders SET sort_order = -1 WHERE id = ?1",
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

    /// A deck's folder and the removed-cards folder are on the census like any other — a page
    /// that could not see them would draw a tree the collection does not have.
    #[test]
    fn list_folders_answers_the_folders_the_app_owns_too() {
        let conn = open();
        create_folder(&conn, None, "Binder").unwrap();
        insert_system_folder(&conn, "removed", "Recently removed");
        let deck_folder = insert_system_folder(&conn, "deck", "Mono red");

        let kinds: Vec<&str> = list_folders(&conn)
            .unwrap()
            .iter()
            .map(|f| match f.kind.as_str() {
                "user" => "user",
                "deck" => "deck",
                _ => "removed",
            })
            .collect();
        assert_eq!(kinds, vec!["user", "removed", "deck"]);
        assert!(
            list_folders(&conn)
                .unwrap()
                .iter()
                .any(|f| f.id == deck_folder && f.deck_id.is_some()),
            "a deck's folder carries the deck it stands for"
        );
    }

    #[test]
    fn delete_folder_keeps_its_cards_and_cascades_its_subfolders() {
        let conn = open();
        let binder = open_binder(&conn);
        let rares = create_folder(&conn, Some(binder), "Rares").unwrap().id;
        let elsewhere = create_folder(&conn, None, "Trades").unwrap().id;
        let top = insert_entry(&conn, "bolt", Some(binder), 2);
        let deep = insert_entry(&conn, "bear", Some(rares), 1);
        let untouched = insert_entry(&conn, "forest", Some(elsewhere), 4);

        delete_folder(&conn, binder).unwrap();

        let left: Vec<i64> = list_folders(&conn).unwrap().iter().map(|f| f.id).collect();
        assert_eq!(left, vec![elsewhere], "the sub-folder cascaded with it");
        // The cards are the reader's property and no filing decision throws one away.
        assert_eq!(folder_of(&conn, top), None, "surfaced at the root");
        assert_eq!(folder_of(&conn, deep), None, "and so did the sub-folder's");
        assert_eq!(folder_of(&conn, untouched), Some(elsewhere));
        let entries: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(entries, 3, "all three rows are still in the collection");
    }

    /// One folder, so the tests that only need somewhere to file read as one line.
    fn open_binder(conn: &Connection) -> i64 {
        create_folder(conn, None, "Binder").unwrap().id
    }

    /// **Two rows in the doomed sub-tree that collide WITH EACH OTHER at the root**, needing no
    /// unfiled row at all: `Outer` and `Outer/Inner` each holding the same printing land on one
    /// grain the moment both reach the root. One at a time through [`refile_entry`] is what
    /// makes them merge instead of raising `UNIQUE constraint failed: index
    /// 'idx_collection_grain'` — the first to arrive becomes the row the second folds into, and
    /// `ORDER BY e.id` is what makes which one that is a fact about the table rather than about
    /// the planner.
    #[test]
    fn deleting_a_folder_refiles_its_cards_to_the_root_one_at_a_time() {
        let conn = open();
        let outer = create_folder(&conn, None, "Outer").unwrap();
        let inner = create_folder(&conn, Some(outer.id), "Inner").unwrap();
        insert_entry(&conn, "bolt", Some(outer.id), 1);
        insert_entry(&conn, "bolt", Some(inner.id), 1);
        delete_folder(&conn, outer.id).unwrap();
        let (rows, qty): (i64, i64) = conn
            .query_row(
                "SELECT count(*), coalesce(sum(quantity), 0) FROM collection_entries
                  WHERE card_id = 'bolt' AND folder_id IS NULL",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(rows, 1, "two collided into one row");
        assert_eq!(qty, 2, "holding both lots of copies");
        assert!(
            list_folders(&conn).unwrap().is_empty(),
            "and the folder really went -- the collision used to leave it standing"
        );
    }

    /// The other shape: a filed row and an **unfiled** one for the same printing, which is what
    /// every writer that cannot name a folder produces — a quick add from the search, an import,
    /// the reconciler's fold. The notes are asserted here rather than in a test of their own
    /// because they are what proves the merge is [`crate::collection::add_entry`]'s rule and not
    /// a second one: `coalesce` keeps the survivor's and falls back to the folded row's.
    #[test]
    fn delete_folder_merges_a_filed_card_into_the_unfiled_row_for_the_same_printing() {
        let conn = open();
        let binder = open_binder(&conn);
        let root = insert_entry(&conn, "bolt", None, 1);
        let filed = insert_entry(&conn, "bolt", Some(binder), 2);
        conn.execute(
            "UPDATE collection_entries SET notes = 'bought at the prerelease' WHERE id = ?1",
            params![filed],
        )
        .unwrap();

        delete_folder(&conn, binder).unwrap();

        let rows: Vec<(i64, Option<i64>, i64, Option<String>)> = conn
            .prepare("SELECT id, folder_id, quantity, notes FROM collection_entries ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![(root, None, 3, Some("bought at the prerelease".to_owned()))],
            "one row at the root for all three copies, wearing the folded row's note"
        );
    }

    #[test]
    fn delete_folder_is_a_success_for_an_id_that_is_not_there() {
        let conn = open();
        assert_eq!(delete_folder(&conn, 404), Ok(()));
    }

    #[test]
    fn a_refile_onto_a_taken_grain_merges_and_answers_the_destination() {
        let conn = open();
        let binder = create_folder(&conn, None, "Binder").unwrap();
        let root = insert_entry(&conn, "bolt", None, 3);
        let filed = insert_entry(&conn, "bolt", Some(binder.id), 2);
        let change = refile_entry(&conn, root, Some(binder.id)).unwrap();
        assert_eq!(
            change.id, filed,
            "the answer names the DESTINATION, not the id handed in"
        );
        assert_eq!(change.quantity, 5, "the quantities sum");
        assert!(!change.removed, "the cards are emphatically still owned");
        let rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM collection_entries WHERE card_id = 'bolt'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1, "the source row is gone");
    }

    /// **The eleventh term, on its own.** Every other column is identical between these two
    /// rows, so a probe spelling only the ten terms `COLLECTION_GRAIN` had before v24 would find
    /// the row in `Sold` and fold this one into it — copies leaving the reader's collection on a
    /// press that was supposed to file them in `Binder`.
    #[test]
    fn a_refile_matching_ten_of_the_eleven_terms_does_not_merge() {
        let conn = open();
        let binder = create_folder(&conn, None, "Binder").unwrap();
        let sold = create_folder(&conn, None, "Sold").unwrap();
        let root = insert_entry(&conn, "bolt", None, 3);
        let elsewhere = insert_entry(&conn, "bolt", Some(sold.id), 2);

        let change = refile_entry(&conn, root, Some(binder.id)).unwrap();

        assert_eq!(
            change.id, root,
            "nothing was folded, so nothing was renamed"
        );
        assert_eq!(change.quantity, 3, "and no quantity moved");
        assert_eq!(folder_of(&conn, root), Some(binder.id));
        assert_eq!(
            folder_of(&conn, elsewhere),
            Some(sold.id),
            "the row in the other folder is untouched"
        );
    }

    /// **`deck_allocations.collection_entry_id` is `ON DELETE CASCADE`**, so a merge that simply
    /// deleted the source row would take a built deck's reservations with it — copies that still
    /// exist, in a deck that still wants them, unbuilt by a filing press. This is
    /// `reconcile::fold_into_existing`'s guarantee, which the merge borrows its statements from.
    #[test]
    fn a_refile_carries_a_decks_claim_onto_the_row_it_merged_into() {
        let conn = open();
        let binder = create_folder(&conn, None, "Binder").unwrap();
        let root = insert_entry(&conn, "bolt", None, 3);
        let filed = insert_entry(&conn, "bolt", Some(binder.id), 2);
        let deck: i64 = conn
            .query_row(
                "INSERT INTO decks (name, created_at, updated_at)
                 VALUES ('Mono red', unixepoch(), unixepoch()) RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO deck_allocations (deck_id, collection_entry_id, quantity,
                                           created_at, updated_at)
             VALUES (?1, ?2, 3, unixepoch(), unixepoch())",
            params![deck, root],
        )
        .unwrap();

        refile_entry(&conn, root, Some(binder.id)).unwrap();

        let claims: Vec<(i64, i64)> = conn
            .prepare("SELECT collection_entry_id, quantity FROM deck_allocations")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            claims,
            vec![(filed, 3)],
            "the claim moved to the survivor rather than cascading away"
        );
    }

    /// Both claims fold into one, because `deck_allocations`' grain is one row per
    /// `(deck, entry)` — the same shape as the entries' own, and the reason the merge needs
    /// three statements rather than one repoint.
    #[test]
    fn a_refile_folds_two_claims_the_same_deck_held_on_both_rows() {
        let conn = open();
        let binder = create_folder(&conn, None, "Binder").unwrap();
        let root = insert_entry(&conn, "bolt", None, 3);
        let filed = insert_entry(&conn, "bolt", Some(binder.id), 2);
        let deck: i64 = conn
            .query_row(
                "INSERT INTO decks (name, created_at, updated_at)
                 VALUES ('Mono red', unixepoch(), unixepoch()) RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO deck_allocations (deck_id, collection_entry_id, quantity,
                                           created_at, updated_at)
             VALUES (?1, ?2, 3, unixepoch(), unixepoch()),
                    (?1, ?3, 2, unixepoch(), unixepoch())",
            params![deck, root, filed],
        )
        .unwrap();

        refile_entry(&conn, root, Some(binder.id)).unwrap();

        let claims: Vec<(i64, i64)> = conn
            .prepare("SELECT collection_entry_id, quantity FROM deck_allocations")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(claims, vec![(filed, 5)], "one claim for all five copies");
    }

    /// An `UPDATE` changing 0 rows cannot tell a missing row from a collision, which is why the
    /// grain read comes first and answers this.
    #[test]
    fn a_refile_of_an_entry_that_is_not_there_says_so() {
        let conn = open();
        let binder = create_folder(&conn, None, "Binder").unwrap();
        assert_eq!(refile_entry(&conn, 404, Some(binder.id)).unwrap_err(), GONE);
        assert_eq!(set_entry_folder(&conn, 404, None).unwrap_err(), GONE);
    }

    #[test]
    fn set_entry_folder_moves_a_card_and_back_to_the_root() {
        let conn = open();
        let binder = create_folder(&conn, None, "Binder").unwrap();
        let id = insert_entry(&conn, "bolt", None, 2);

        let moved = set_entry_folder(&conn, id, Some(binder.id)).unwrap();
        assert_eq!((moved.id, moved.quantity, moved.removed), (id, 2, false));
        assert_eq!(folder_of(&conn, id), Some(binder.id));

        // `None` is the root and is a real destination.
        let home = set_entry_folder(&conn, id, None).unwrap();
        assert_eq!((home.id, home.quantity, home.removed), (id, 2, false));
        assert_eq!(folder_of(&conn, id), None);
    }

    /// A folder id nothing answers to is refused in words rather than left to the foreign key,
    /// which would name the table and not the mistake — [`crate::deck::set_folder`]'s fence.
    #[test]
    fn set_entry_folder_refuses_a_folder_that_is_not_there() {
        let conn = open();
        let id = insert_entry(&conn, "bolt", None, 2);
        let err = set_entry_folder(&conn, id, Some(404)).unwrap_err();
        assert_eq!(err, FOLDER_GONE);
        assert_eq!(folder_of(&conn, id), None, "and it wrote nothing");
    }

    #[test]
    fn a_deck_or_removed_folder_refuses_to_be_renamed_moved_or_deleted_by_hand() {
        let conn = open();
        let sys = insert_system_folder(&conn, "removed", "Recently removed");
        assert_eq!(
            rename_folder(&conn, sys, "Junk").unwrap_err(),
            FOLDER_NOT_YOURS
        );
        assert_eq!(move_folder(&conn, sys, None).unwrap_err(), FOLDER_NOT_YOURS);
        assert_eq!(delete_folder(&conn, sys).unwrap_err(), FOLDER_NOT_YOURS);
    }

    /// The same three refusals for the other kind, plus the fourth site: nothing may be filed
    /// **into** a folder the app owns, by hand. A card dragged into a deck's folder would assert
    /// that the deck holds those copies without any of the writes that make it true.
    #[test]
    fn nothing_can_be_filed_into_a_folder_the_app_owns() {
        let conn = open();
        let sys = insert_system_folder(&conn, "deck", "Mono red");
        let binder = create_folder(&conn, None, "Binder").unwrap();
        let id = insert_entry(&conn, "bolt", None, 2);

        assert_eq!(
            rename_folder(&conn, sys, "Junk").unwrap_err(),
            FOLDER_NOT_YOURS
        );
        assert_eq!(
            move_folder(&conn, binder.id, Some(sys)).unwrap_err(),
            FOLDER_NOT_YOURS,
            "no drawer inside the app's own cabinet"
        );
        assert_eq!(
            set_entry_folder(&conn, id, Some(sys)).unwrap_err(),
            FOLDER_NOT_YOURS
        );
        assert_eq!(folder_of(&conn, id), None, "and the refusal wrote nothing");

        // The fence is the *command's*, not the write's: the deck-driven writes the next PR adds
        // reach the same folder through `refile_entry` and are not refused.
        refile_entry(&conn, id, Some(sys)).unwrap();
        assert_eq!(folder_of(&conn, id), Some(sys));
    }

    #[test]
    fn folder_summary_counts_only_what_is_filed_directly_in_each_folder() {
        let conn = open();
        priced_card(&conn, "bolt-lea", "5.00");
        priced_card(&conn, "bear-lea", "0.25");
        let binder = create_folder(&conn, None, "Binder").unwrap();
        let rares = create_folder(&conn, Some(binder.id), "Rares").unwrap();
        insert_entry(&conn, "bolt-lea", Some(binder.id), 3);
        insert_entry(&conn, "bear-lea", Some(rares.id), 4);
        insert_entry(&conn, "bolt-lea", None, 9);

        let rows = folder_summary(&conn, ANY_MARKET).unwrap();

        assert_eq!(rows.len(), 2, "the root is not a folder and draws no tile");
        let (top, inner) = (&rows[0], &rows[1]);
        assert_eq!(top.folder_id, binder.id);
        assert_eq!(
            top.cards, 3,
            "copies, and the sub-folder's are the sub-folder's"
        );
        assert!(
            (top.value.unwrap() - 15.0).abs() < 1e-9,
            "3 x $5.00, got {:?}",
            top.value
        );

        assert_eq!(inner.folder_id, rares.id);
        assert_eq!(inner.cards, 4);
        assert!((inner.value.unwrap() - 1.0).abs() < 1e-9, "4 x $0.25");
    }

    /// Two things one fixture answers: a folder the marketplace can price nothing in has **no
    /// value at all** rather than a value of zero, and a folder it can price only half of
    /// answers for that half. A tile has no room for the header's "n unpriced" note, so
    /// `Some(0.0)` there would read as a folder worth nothing.
    #[test]
    fn folder_summary_leaves_an_unpriced_folder_without_a_value() {
        let conn = open();
        priced_card(&conn, "bolt-lea", "5.00");
        let mixed = create_folder(&conn, None, "Mixed").unwrap();
        let unknown = create_folder(&conn, None, "Unknown").unwrap();
        insert_entry(&conn, "bolt-lea", Some(mixed.id), 2);
        // A card id no printing answers to: the LEFT JOIN finds nothing, so there is no price.
        insert_entry(&conn, "ghost", Some(mixed.id), 7);
        insert_entry(&conn, "ghost", Some(unknown.id), 4);

        let rows = folder_summary(&conn, ANY_MARKET).unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].cards, 9, "an unpriced card is still a card in here");
        assert!(
            (rows[0].value.unwrap() - 10.0).abs() < 1e-9,
            "only the priced copies are in the value, got {:?}",
            rows[0].value
        );
        assert_eq!(rows[1].cards, 4);
        assert_eq!(rows[1].value, None, "an em dash, never $0.00");
    }

    /// An empty folder produces no row at all, which is the shape rule that makes
    /// [`list_folders`] the census and this a lookup layered onto it.
    #[test]
    fn folder_summary_says_nothing_at_all_about_an_empty_folder() {
        let conn = open();
        create_folder(&conn, None, "Empty").unwrap();
        assert!(folder_summary(&conn, ANY_MARKET).unwrap().is_empty());
    }

    /// Every marketplace's price SQL prepares, over a folder that has a row to answer with.
    ///
    /// [`folder_summary`] builds its SQL with `format!`, and [`crate::sorting::price_expr`]
    /// emits a **structurally different** expression per marketplace: a `json_extract` for
    /// TCGplayer, a nested `CASE` for Cardmarket (which has no `eur_etched` key to quote), and
    /// a correlated subquery over `marketplace_prices` referencing `c.id` and the finish for the
    /// two feed-backed ones. A wrong alias in any of those is a run-time `prepare` failure
    /// rather than a compile error.
    ///
    /// **Enumerated through [`crate::marketplace::MARKETPLACE_IDS`] rather than hand-listed**,
    /// so a marketplace this test has never seen cannot be added.
    #[test]
    fn folder_summary_prepares_at_every_marketplace() {
        let conn = open();
        priced_card(&conn, "bolt-lea", "5.00");
        let binder = create_folder(&conn, None, "Binder").unwrap();
        insert_entry(&conn, "bolt-lea", Some(binder.id), 3);

        for id in crate::marketplace::MARKETPLACE_IDS {
            let rows = folder_summary(&conn, Marketplace::from_id(id))
                .unwrap_or_else(|e| panic!("{id} could not be summed: {e}"));
            // Not merely `is_ok`: an empty answer passes that and proves nothing about the SQL
            // having run over a row. `cards` carries no price, so it is the same figure
            // whichever marketplace was asked.
            assert_eq!((rows.len(), rows[0].cards), (1, 3), "at {id}");
        }
    }
}
