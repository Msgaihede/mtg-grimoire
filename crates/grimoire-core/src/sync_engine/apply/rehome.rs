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
//! **Every delete that would clear a row waits, and not only one that would collide** (§3.3 as
//! amended at Task B's review). Whether a delete collides depends on what has landed yet, and a
//! page taken parents first has not landed the sender's own rows: a sender that made a root copy
//! and then deleted a binder whose copy folded into it sends a delete that collides with nothing on
//! the peer, and re-homing then put the binder's copy on the root's grain where the new copy's
//! insert met it and added its count on top. So what [`doomed`] finds is the whole question —
//! anything, and the delete waits — and **the decision is taken on a `Clear` pass**, the delete
//! arm's and the moot arm's alike: the retry pass that follows a deciding pass on which nothing
//! landed, by which time the page's re-filing has taken what it moves — into a folder the page
//! makes late, or a deck's group the deciding pass itself lands — and left only the rows it never
//! mentioned for [`rehome`] (§3.3, as amended at the final review).

use crate::sync_engine::emission;
use rusqlite::Connection;

/// Every `ON DELETE CASCADE` key into a folder table, as `(child table, column, parent table)`:
/// the paths [`doomed`] follows. Held to the live schema by
/// `every_cascade_into_a_folder_table_is_one_doomed_follows`.
///
/// **Test-only, because nothing else reads it**: `doomed` spells each path in its own SQL rather
/// than walking this list, so in a build without the fence it is dead code, and `-D warnings`
/// refuses one. What keeps the list and `doomed` agreeing
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

impl Doomed {
    /// Whether the delete would clear no row at all — the one kind that need not wait for a
    /// `Clear` pass, because its `SET NULL` has nothing to act on.
    pub(super) fn is_empty(&self) -> bool {
        self.collection.is_empty() && self.wishlist.is_empty()
    }
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

/// File every doomed row at the root, one at a time, through the crate's own merge — and where
/// one folded onto a twin, give the survivor the lower of the two uids. Called on a `Clear` pass
/// where anything is doomed, so what is left doomed by then is what the page did not re-file.
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
        rehome_one(conn, "collection_entries", id)?;
    }
    for &id in &d.wishlist {
        rehome_one(conn, "wishlist_entries", id)?;
    }
    Ok(())
}

/// One row of [`rehome`]: file `table`'s row `id` at the root, and answer the id of the row that
/// holds it afterwards — its own, or the twin it folded onto. On its own because the moot arm
/// takes the rows one at a time, to write down beside each what the move did to it
/// ([`super::orphans`]).
pub(super) fn rehome_one(conn: &Connection, table: &str, id: i64) -> Result<i64, String> {
    let before = uid_of(conn, table, id)?;
    let kept = match table {
        "collection_entries" => crate::collection_folders::refile_entry(conn, id, None)?.id,
        _ => crate::wishlist_folders::refile_wish(conn, id, None)?.id,
    };
    adopt_lower(conn, table, kept, id, before)?;
    Ok(kept)
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
///
/// **Whichever uid the survivor does not wear is retired** ([`emission::retire`], design
/// 2026-10-03 §6) — the survivor's own where it adopts the moved one, the moved one where it keeps
/// its own, and neither where the uid involved is absent. Its copies are the survivor's now, so a
/// later claim naming it must never build it again. Inside the caller's savepoint, so a delete
/// rolled back leaves no mark.
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
    let retired = match survivor {
        Some(own) if own.as_str() <= moved_uid.as_str() => Some((moved_uid, own)),
        own => {
            conn.execute(
                &format!("UPDATE {table} SET sync_uid = ?1 WHERE id = ?2"),
                rusqlite::params![moved_uid, kept],
            )
            .map_err(|e| e.to_string())?;
            // Whatever the ledger of orphans has folded into the survivor follows its new name.
            if let Some(own) = &own {
                super::orphans::renamed(conn, table, own, &moved_uid)?;
            }
            own.map(|own| (own, moved_uid))
        }
    };
    match retired {
        Some((uid, into)) => emission::retire(conn, table, &uid, &into).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}
