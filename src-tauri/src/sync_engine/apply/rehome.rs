//! What a delete `apply` issues would clear out of the two folder tables, and the re-homing that
//! stops it dropping two rows onto one grain (spec 2026-09-27 §3.3).
//!
//! `collection_entries.folder_id` and `wishlist_entries.folder_id` are `ON DELETE SET NULL`, and
//! both tables carry the folder in their grain. So a folder's `DELETE` moves every row filed in it
//! onto the root's grain at once — and where the root already holds that row, or two doomed rows
//! share one, the index refuses and the whole apply with it. The sender never meets this:
//! `collection_folders::delete_folder` re-files one row at a time through the merge first. This
//! is that merge on the receiving side, for the rows the page does not re-file itself.
//!
//! **Every-target, like the rest of `sync_engine`**: the two merges it borrows,
//! `collection_folders::refile_entry` and `wishlist_folders::refile_wish`, sit on the every-target
//! half of their modules, so the browser build re-homes exactly as the desktop does.

use rusqlite::{Connection, OptionalExtension};

/// Every `ON DELETE CASCADE` key into a folder table, as `(child table, column, parent table)`:
/// the paths [`doomed`] follows. Held to the live schema by
/// `every_cascade_into_a_folder_table_is_one_doomed_follows`.
///
/// **Test-only, because nothing else reads it**: `doomed` spells each path in its own SQL rather
/// than walking this list, so in a build without the fence it is dead code, and `-D warnings`
/// refuses one (measured on the `wasm` leg's clippy). What keeps the list and `doomed` agreeing
/// is the order a change meets them in: the fence fails on a new cascade key until it is written
/// here, and writing it here is the moment to teach `doomed` the path.
#[cfg(test)]
pub(super) const CASCADES_INTO_FOLDERS: [(&str, &str, &str); 3] = [
    ("collection_folders", "deck_id", "decks"),
    ("collection_folders", "parent_id", "collection_folders"),
    ("wishlist_folders", "parent_id", "wishlist_folders"),
];

/// The copies and wishes filed in the folders a delete would take, by id, ascending.
#[derive(Debug, Default)]
pub(super) struct Doomed {
    pub collection: Vec<i64>,
    pub wishlist: Vec<i64>,
}

/// What deleting `table`'s row `uid` would clear: a folder and its sub-tree, or a deck's group
/// folders and theirs. Any other table dooms nothing.
///
/// **`UNION` and never `UNION ALL`**, `collection_folders::delete_folder`'s reason: a `parent_id`
/// cycle that arrived some other way converges on the duplicate-row check instead of looping.
/// `ORDER BY e.id` so the row a merge folds into is decided by the table, as the sender's own
/// re-filing decides it.
pub(super) fn doomed(conn: &Connection, table: &str, uid: &str) -> Result<Doomed, String> {
    let (folders, seed): (&str, &str) = match table {
        "collection_folders" => (
            "collection_folders",
            "SELECT id FROM collection_folders WHERE sync_uid = ?1",
        ),
        "decks" => (
            "collection_folders",
            "SELECT f.id FROM collection_folders f JOIN decks d ON f.deck_id = d.id
              WHERE d.sync_uid = ?1",
        ),
        "wishlist_folders" => (
            "wishlist_folders",
            "SELECT id FROM wishlist_folders WHERE sync_uid = ?1",
        ),
        _ => return Ok(Doomed::default()),
    };
    let entries = if folders == "collection_folders" {
        "collection_entries"
    } else {
        "wishlist_entries"
    };
    let sql = format!(
        "WITH RECURSIVE tree(id) AS ({seed}
                UNION SELECT f.id FROM {folders} f JOIN tree t ON f.parent_id = t.id)
         SELECT e.id FROM {entries} e WHERE e.folder_id IN (SELECT id FROM tree) ORDER BY e.id"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([uid], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<i64>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(if entries == "collection_entries" {
        Doomed {
            collection: ids,
            wishlist: Vec::new(),
        }
    } else {
        Doomed {
            collection: Vec::new(),
            wishlist: ids,
        }
    })
}

/// Whether clearing the doomed rows' folder would drop two rows onto one grain: a doomed row
/// whose root twin exists, or two doomed rows that are each other's twin.
///
/// **Every grain term but the folder is spelled out**, `refile_entry`'s rule: the folder is the
/// one term the `SET NULL` rewrites, so it is read as "the root, or another doomed row", and a
/// probe that dropped any of the other ten would call two different printings one row and hold a
/// delete that collides with nothing.
pub(super) fn collides(conn: &Connection, d: &Doomed) -> Result<bool, String> {
    for &id in &d.collection {
        let hit: Option<i64> = conn
            .query_row(
                "SELECT t.id FROM collection_entries e JOIN collection_entries t
                   ON t.id <> e.id
                  AND t.card_id = e.card_id AND t.finish = e.finish
                  AND t.condition = e.condition AND t.lang = e.lang
                  AND t.altered = e.altered AND t.signed = e.signed
                  AND t.proxy = e.proxy AND t.misprint = e.misprint
                  AND coalesce(t.serial_number, '') = coalesce(e.serial_number, '')
                  AND coalesce(t.grading, '') = coalesce(e.grading, '')
                WHERE e.id = ?1
                  AND (t.folder_id IS NULL OR t.id IN (SELECT value FROM json_each(?2)))
                LIMIT 1",
                rusqlite::params![id, ids_json(&d.collection)],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if hit.is_some() {
            return Ok(true);
        }
    }
    for &id in &d.wishlist {
        let hit: Option<i64> = conn
            .query_row(
                "SELECT t.id FROM wishlist_entries e JOIN wishlist_entries t
                   ON t.id <> e.id
                  AND coalesce(t.oracle_id, '') = coalesce(e.oracle_id, '')
                  AND coalesce(t.card_id, '') = coalesce(e.card_id, '')
                  AND coalesce(t.preferred_finish, '') = coalesce(e.preferred_finish, '')
                WHERE e.id = ?1
                  AND (t.folder_id IS NULL OR t.id IN (SELECT value FROM json_each(?2)))
                LIMIT 1",
                rusqlite::params![id, ids_json(&d.wishlist)],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if hit.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The ids as a JSON array, for `json_each` — one bound value however many rows are doomed,
/// where a list of `?`s would be a statement built per call.
fn ids_json(ids: &[i64]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_owned())
}

/// File every doomed row at the root, one at a time, through the crate's own merge — and where
/// one folded onto a twin, give the survivor the lower of the two uids.
///
/// **Why the lower uid**: a row re-homed here is one the page did not mention, so its own put
/// reaches the sender with its folder gone, the sender writes it without the folder, and
/// `find_row`'s grain match lands it on the same twin, adopting `min`. A nameless side takes the
/// other's uid; two nameless sides keep none (Review Focus 1).
///
/// **One at a time is what answers two doomed rows on one grain**, as it does on the sender: the
/// first to reach the root becomes the row the next one merges into.
pub(super) fn rehome(conn: &Connection, d: &Doomed) -> Result<(), String> {
    for &id in &d.collection {
        let before = uid_of(conn, "collection_entries", id)?;
        let kept = crate::collection_folders::refile_entry(conn, id, None)?.id;
        adopt_lower(conn, "collection_entries", kept, id, before)?;
    }
    for &id in &d.wishlist {
        let before = uid_of(conn, "wishlist_entries", id)?;
        let kept = crate::wishlist_folders::refile_wish(conn, id, None)?.id;
        adopt_lower(conn, "wishlist_entries", kept, id, before)?;
    }
    Ok(())
}

fn uid_of(conn: &Connection, table: &str, id: i64) -> Result<Option<String>, String> {
    conn.query_row(
        &format!("SELECT sync_uid FROM {table} WHERE id = ?1"),
        [id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Give the survivor of a fold the moved row's uid where that one is lower, or where the survivor
/// has none. **After the fold and never before**: the moved row is gone by now, so its uid is free
/// and `idx_{table}_uid` has nothing to refuse.
fn adopt_lower(
    conn: &Connection,
    table: &str,
    kept: i64,
    moved: i64,
    moved_uid: Option<String>,
) -> Result<(), String> {
    if kept == moved {
        return Ok(());
    }
    let Some(moved_uid) = moved_uid else {
        return Ok(());
    };
    let survivor = uid_of(conn, table, kept)?;
    if survivor.as_deref().is_none_or(|s| moved_uid.as_str() < s) {
        conn.execute(
            &format!("UPDATE {table} SET sync_uid = ?1 WHERE id = ?2"),
            rusqlite::params![moved_uid, kept],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
