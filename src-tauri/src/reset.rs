//! The four things Settings can throw away: the collection, the wishlist, the decks, and
//! the downloaded cache.
//!
//! **A module of its own because these are the only writes in the crate with no subject.**
//! Every other write names a row — an entry, a wish, a deck, a card in a pile — and lives
//! beside the reads of that table. These name a *table*, they are reachable from exactly one
//! screen, and the thing they have in common is not the data they touch but the question the
//! UI has to ask before calling them. Filing `collection_clear` in `collection.rs` beside
//! `remove_entry` would put a command that empties the collection next to the one that is
//! documented as *the only way a collection row is ever deleted*, which is the sentence it
//! contradicts.
//!
//! ## The three destructive ones lean on cascades already declared
//!
//! `foreign_keys` is ON for every connection [`crate::db::open`] hands out, so the `DELETE`s
//! here are one statement each and the schema does the rest. What each one takes with it is
//! written at its own site, because *what a wipe takes with it is the whole of what the
//! confirmation has to promise* — a reader who is told "your decks" and loses their folders
//! was mis-sold, and the sentence in the webview is checked against these notes rather than
//! against the DDL.
//!
//! **Nothing here is undoable and nothing here writes history.** `deck_audit` is per-deck and
//! CASCADEs away with the decks it describes, so recording a wipe into it would be recording
//! into rows the same statement deletes. `deck_undo` goes the same way for the same reason.
//! This is the one family of writes in the app where the typed confirmation *is* the safety,
//! which is why it is the webview's job and stated as such in `DangerZonePanel`.
//!
//! ## The fourth is not destructive, and the difference is the point
//!
//! [`cache_clear`] deletes only bytes the app can fetch again with no user action:
//! `data/images/`, the picture cache, and `data/tmp/`, where the three bulk downloads land.
//! It never touches `data/covers/` — a deck cover is a picture the *reader* chose, and the
//! file beside the database is the only record that they chose it — and it never touches a
//! table other than `image_cache`, whose rows are bookkeeping for exactly the files it swept.
//! The marketplace and Oracle Tag tables stay: those re-download on a *button*, not on demand,
//! so emptying them would leave every price an em dash until the reader noticed and pressed
//! something. That is a different promise from "self-healing" and is not this button's.

use rusqlite::Connection;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::sync::{with_write, AppState};

/// What emptying the collection took with it.
///
/// `allocations` is the number a reader would not have predicted and is why this is a struct
/// rather than a count: `deck_allocations.collection_entry_id` is
/// `REFERENCES collection_entries(id) ON DELETE CASCADE`, so every deck's reservations against
/// owned copies go with the collection. The decks themselves are untouched — a deck is a list
/// of cards, not a list of *your* cards — but every "owned" mark in the app is now false, and
/// the panel says so with this number.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCleared {
    pub entries: i64,
    pub allocations: i64,
}

/// What emptying the decks took with it.
///
/// `folders` is separate because the schema keeps it separate: `decks.folder_id` is
/// `ON DELETE SET NULL`, so deleting every deck leaves the whole folder tree standing and
/// empty. Clearing them is a second statement, deliberately taken (see [`decks_clear`]).
///
/// `covers` is files, not rows — the `<deckId>.webp` pictures beside the database, which no
/// `DELETE` can reach.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecksCleared {
    pub decks: i64,
    pub folders: i64,
    pub covers: u64,
}

/// What the cache sweep freed.
///
/// `failed` is not an error and is reported rather than raised: a file another thread has open
/// cannot be deleted on Windows, and the honest answer to "I could not delete 3 of 5 540
/// pictures" is 5 537 pictures freed and a number, not a refusal that leaves the reader with
/// no way to tell whether anything happened.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheCleared {
    /// Files actually removed, across `images/` and `tmp/`.
    pub files: u64,
    /// Their total size, as the filesystem reported it before each was removed.
    pub bytes: u64,
    /// `image_cache` rows dropped — the bookkeeping that vouched for those pictures.
    pub rows: i64,
    /// Files that would not go. See the type's own note.
    pub failed: u64,
}

/// What a directory sweep did, accumulated across a walk.
#[derive(Debug, Clone, Copy, Default)]
struct Swept {
    files: u64,
    bytes: u64,
    failed: u64,
}

/// Empty a directory of its contents, leaving the directory itself.
///
/// **The root survives on purpose and the children do not need to.** Every writer under these
/// two roots — [`crate::images::Cache::fetch_and_store`], the corpus download, the Oracle Tag
/// download, the price-feed download — `create_dir_all`s its own parent before writing, so a
/// shard directory that goes here is rebuilt by the first fetch that wants it. Leaving the
/// root is what keeps the *reported* data directory a directory that exists, which the
/// Settings page prints.
///
/// Depth is three (`images/<variant>/<shard>/`) and one (`tmp/`), so the recursion is bounded
/// by the layout rather than by a counter. A directory that cannot be read is skipped whole:
/// the caller's promise is "the cache is disposable", and a cache that is partly still there
/// costs a re-fetch rather than correctness — [`crate::images::Cache::get`] treats a row
/// whose file is gone as a miss, and so does every bulk download.
fn sweep_dir(root: &Path, out: &mut Swept) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // `DirEntry::file_type` does not follow symlinks, so a link into the user's pictures
        // folder is treated as the file it is and unlinked — never walked into.
        match entry.file_type() {
            Ok(t) if t.is_dir() => {
                sweep_dir(&path, out);
                // Best-effort: a directory that still holds a file we could not remove is
                // simply left, and that file is already counted in `failed`.
                let _ = fs::remove_dir(&path);
            }
            Ok(_) => {
                let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                if fs::remove_file(&path).is_ok() {
                    out.files += 1;
                    out.bytes += bytes;
                } else {
                    out.failed += 1;
                }
            }
            Err(_) => out.failed += 1,
        }
    }
}

/// Empty the collection.
///
/// One statement plus one count. The count is taken **first and inside the transaction**,
/// because after the `DELETE` there is nothing left to count: the cascade has already run and
/// `deck_allocations` is empty whether it held ten rows or none.
pub fn clear_collection(conn: &Connection) -> Result<CollectionCleared, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let allocations: i64 = tx
        .query_row("SELECT count(*) FROM deck_allocations", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let entries = tx
        .execute("DELETE FROM collection_entries", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(CollectionCleared {
        entries: entries as i64,
        allocations,
    })
}

/// Empty the wishlist, and the folders that filed it.
///
/// **Two statements, because the schema will not do it in one** — [`clear_decks`]'s situation
/// one table over, and for the same reason. `wishlist_entries.folder_id` is
/// `ON DELETE SET NULL` (schema v23), so deleting a wish leaves its folder standing and a wipe
/// that stopped at the entries would hand the reader an empty filing cabinet they now have to
/// take apart one drawer at a time. The order is entries first: `wishlist_folders.parent_id`
/// CASCADEs onto itself, and clearing the folders first would be a second cascade running
/// under the statement that matters.
///
/// **The number answered stays the count of *wishes*** and never counts a folder, because that
/// is what the Settings sentence promises: "N wishes removed" is about the shopping list, and a
/// folder is where a wish was kept rather than a thing the reader wished for.
///
/// The old note here read "Nothing references it, so nothing else moves", which stopped being
/// true the day the folders landed.
pub fn clear_wishlist(conn: &Connection) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let entries = tx
        .execute("DELETE FROM wishlist_entries", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM wishlist_folders", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(entries as i64)
}

/// Empty the decks, the folders that filed them, and the cover pictures beside the database.
///
/// **`deck_folders` is a second statement because the schema will not do it.** Deleting a deck
/// leaves its folder standing (`decks.folder_id` is `ON DELETE SET NULL` — the gallery's own
/// "delete folder" confirmation says so out loud), so a wipe that stopped at `decks` would hand
/// the reader an empty tree of folders they now have to delete one at a time. It is ordered
/// after, not before: `deck_folders.parent_id` CASCADEs onto itself, and clearing folders first
/// would be a second cascade running under the statement that matters.
///
/// The `DELETE FROM decks` is most of the rest — `deck_cards`, `deck_categories`,
/// `deck_audit`, `deck_undo` and `deck_allocations` all carry `deck_id … ON DELETE CASCADE`.
///
/// **`deck_tags` is the exception and is swept by name.** It lost its `deck_id` in schema v21
/// and is not a deck's any more, so no cascade reaches it — see the statement's own comment for
/// why "every deck" is the one case where clearing them is right.
///
/// **Covers are swept whole rather than removed one id at a time.** [`crate::deck::delete_deck`]
/// removes exactly `<id>.webp` because the decks beside it still need theirs; here there are no
/// decks left when the sweep runs, so every file in that directory is an orphan by construction
/// — including any left behind by the one seam `set_cover_image` documents, a commit that failed
/// after the bytes landed. Nothing but `write_cover` ever puts a file there.
///
/// `covers` is `None` when the directory could not be resolved at all, which is the app still
/// starting; the rows still go, and the pictures they pointed at are inert.
pub fn clear_decks(conn: &Connection, covers: Option<&Path>) -> Result<DecksCleared, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let decks = tx
        .execute("DELETE FROM decks", [])
        .map_err(|e| e.to_string())?;
    let folders = tx
        .execute("DELETE FROM deck_folders", [])
        .map_err(|e| e.to_string())?;
    // **The labels, by hand, because since schema v21 nothing else takes them.** `deck_tags`
    // carried `deck_id … ON DELETE CASCADE` and rode out on the statement above; it belongs to
    // the app now and outlives the deck it was made in, deliberately. That is right for *one*
    // deck and wrong for all of them: a reader who has just deleted every deck they own would
    // otherwise open the Tags dialog onto forty labels attached to nothing, with no deck left
    // to reach them from. Nothing else in the app can hold a tag, so this is exact rather than
    // a guess — a tag is only ever worn by a `deck_cards` row, and there are none left.
    tx.execute("DELETE FROM deck_tags", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    // Outside the transaction, and after the commit: a file removed for a row that then rolled
    // back would be a deck whose cover vanished for nothing. The other order costs an orphan,
    // which is inert, and this order costs a broken tile.
    let mut swept = Swept::default();
    if let Some(covers) = covers {
        sweep_dir(covers, &mut swept);
    }
    Ok(DecksCleared {
        decks: decks as i64,
        folders: folders as i64,
        covers: swept.files,
    })
}

/// Sweep the two disposable directories and drop the rows that vouched for them.
///
/// **Order is load-bearing, and it is: rows, then files, then the owed queue.**
///
/// * The rows go first, under the write connection this is handed. A row that outlived its file
///   is already a supported state — [`crate::images::Cache::get`] reads "cached" from the row,
///   fails to read the file, and treats it as a miss — so the window between the two statements
///   is a window in which the cache is merely slow.
/// * The files go second, unlocked, because a 5 500-file walk is not something to hold the
///   app-wide write mutex across.
/// * [`crate::images::Cache::forget_pending`] goes **last**, and it is the half a first draft
///   gets wrong. That queue holds `image_cache` rows *owed* for bytes already on disk, waiting
///   for a write connection; every one of them describes a file this sweep just deleted, and
///   the next served image flushes the queue. Draining it before the sweep would let a fetch
///   landing mid-walk re-queue, and the row would then outlive the file with no reader ever
///   noticing.
///
/// An image fetched *after* this returns writes its own file and its own row together and is
/// consistent on both counts, which is why nothing here needs to stop the world.
pub fn clear_cache(
    conn: &Connection,
    images: &Path,
    tmp: &Path,
    cache: &crate::images::Cache,
) -> Result<CacheCleared, String> {
    let rows = conn
        .execute("DELETE FROM image_cache", [])
        .map_err(|e| e.to_string())?;
    let mut swept = Swept::default();
    sweep_dir(images, &mut swept);
    sweep_dir(tmp, &mut swept);
    cache.forget_pending();
    Ok(CacheCleared {
        files: swept.files,
        bytes: swept.bytes,
        rows: rows as i64,
        failed: swept.failed,
    })
}

/// Refused when a sync is in flight, in the reader's words.
const SYNCING: &str = "a card update is running — clear the cache once it has finished";

#[tauri::command]
pub async fn collection_clear(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<CollectionCleared, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // `with_write_owned` and not bare `with_write`. The facet index's `owned` bitset is
        // built by `collection_source::owned_rowids`, so this wipe moves it — and a skipped
        // rebuild would leave the search sidebar offering an Owned facet over a collection
        // that no longer exists.
        crate::collection_source::with_write_owned(&state, clear_collection)
    })
    .await
    .map_err(|e| format!("the collection could not be cleared: {e}"))?
}

#[tauri::command]
pub async fn wishlist_clear(state: tauri::State<'_, Arc<AppState>>) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, clear_wishlist))
        .await
        .map_err(|e| format!("the wishlist could not be cleared: {e}"))?
}

/// Empty every deck.
#[tauri::command]
pub async fn decks_clear(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<DecksCleared, String> {
    let state = state.inner().clone();
    // Resolved before the blocking task for `deck_delete`'s reason: `covers_dir` wants the
    // `AppHandle`, which is not `Send` across the spawn.
    let covers = crate::paths::covers_dir(&app).ok();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| clear_decks(c, covers.as_deref()))
    })
    .await
    .map_err(|e| format!("the decks could not be cleared: {e}"))?
}

/// Empty the picture cache and the download scratch directory.
///
/// **Refused outright while a sync is running**, which is the one guard this command needs and
/// the reason it is checked here rather than inside [`clear_cache`]. `data/tmp/` is where the
/// corpus download puts `default-cards.jsonl.gz` — 77 MB that an ingest then reads back — so a
/// sweep landing between the write and the read fails a 90-second job the reader is watching a
/// progress bar for. A refusal they can retry in a minute is the better trade, and it is the
/// only state in which this command can do harm.
///
/// The price-feed and Oracle Tag downloads use the same directory and are *not* fenced: each is
/// a single button the reader pressed, each re-downloads on the next press, and neither has a
/// second phase that reads the file back after closing it.
#[tauri::command]
pub async fn cache_clear(state: tauri::State<'_, Arc<AppState>>) -> Result<CacheCleared, String> {
    let state = state.inner().clone();
    if state.syncing.load(Ordering::Relaxed) {
        return Err(SYNCING.to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let images = state.images.dir().to_path_buf();
        let tmp = state.data_dir.join("tmp");
        with_write(&state, |c| clear_cache(c, &images, &tmp, &state.images))
    })
    .await
    .map_err(|e| format!("the cache could not be cleared: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        schema::migrate(&conn).unwrap();
        conn
    }

    /// One owned card, one deck holding it, one allocation between them.
    ///
    /// Written out rather than taken from a fixture module because the *shape* is what every
    /// test below asserts against — which table each row lands in is the thing under test.
    fn seed(conn: &Connection) {
        conn.execute(
            "INSERT INTO collection_entries
                (id, card_id, set_code, collector_number, lang, finish, condition, quantity,
                 created_at, updated_at)
             VALUES (1, 'a', 'lea', '1', 'en', 'nonfoil', 'NM', 4, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries (id, oracle_id, name, quantity, created_at, updated_at)
             VALUES (1, 'o', 'Black Lotus', 1, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deck_folders (id, name, sort_order, created_at, updated_at)
             VALUES (1, 'Cube', 0, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO decks (id, name, folder_id, created_at, updated_at)
             VALUES (1, 'Mono Red', 1, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deck_allocations
                (deck_id, collection_entry_id, quantity, created_at, updated_at)
             VALUES (1, 1, 2, 0, 0)",
            [],
        )
        .unwrap();
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// The number the confirmation promises. `allocations` is counted *before* the delete, and
    /// the delete is what makes it uncountable — so a version of this that counted afterwards
    /// would report 0 and be wrong in exactly the case the reader cares about.
    #[test]
    fn clearing_the_collection_reports_the_allocations_the_cascade_took() {
        let conn = db();
        seed(&conn);

        let out = clear_collection(&conn).unwrap();

        assert_eq!(out.entries, 1);
        assert_eq!(out.allocations, 1);
        assert_eq!(count(&conn, "collection_entries"), 0);
        assert_eq!(count(&conn, "deck_allocations"), 0);
    }

    /// The half of the promise that is about what *survives*. A deck is a list of cards, not a
    /// list of the reader's cards, so emptying the collection must leave every deck standing —
    /// and the wishlist has nothing to do with either.
    #[test]
    fn clearing_the_collection_leaves_the_decks_and_the_wishlist_alone() {
        let conn = db();
        seed(&conn);

        clear_collection(&conn).unwrap();

        assert_eq!(count(&conn, "decks"), 1);
        assert_eq!(count(&conn, "wishlist_entries"), 1);
    }

    #[test]
    fn clearing_the_wishlist_touches_nothing_else() {
        let conn = db();
        seed(&conn);

        assert_eq!(clear_wishlist(&conn).unwrap(), 1);

        assert_eq!(count(&conn, "wishlist_entries"), 0);
        assert_eq!(count(&conn, "collection_entries"), 1);
        assert_eq!(count(&conn, "decks"), 1);
    }

    /// The sibling the folders needed. Emptying the wishlist takes the filing cabinet it was
    /// filed in, stops there, and still answers the number of **wishes**.
    ///
    /// `deck_folders` is the row that makes the third assertion mean something: the two
    /// tables are the same shape under two names, so a `DELETE` written against the wrong
    /// one — or a wipe that decided "folders" meant all of them — passes every assertion
    /// about `wishlist_folders` alone.
    ///
    /// **The wish is seeded *inside* the folder so the returned count is not a vacuous pass.**
    /// With one wish and no folder — which is what the sibling test above seeds — `1` is the
    /// answer whether the number counts entries or entries plus folders, so an edit to
    /// `Ok((entries + folders) as i64)` would keep every test green and make the Settings
    /// sentence tell a reader with one wish in one folder that it removed two wishes. One
    /// wish and one folder is the cheapest seed where the two answers differ.
    #[test]
    fn clearing_the_wishlist_takes_its_folders_and_leaves_the_decks_alone() {
        let conn = db();
        conn.execute_batch(
            "INSERT INTO wishlist_folders (id, parent_id, name, sort_order, created_at, updated_at)
             VALUES (1, NULL, 'Ordered', 0, 0, 0);
             INSERT INTO wishlist_entries
                (oracle_id, name, quantity, folder_id, created_at, updated_at)
             VALUES ('o1', 'Black Lotus', 1, 1, 0, 0);
             INSERT INTO deck_folders (id, parent_id, name, sort_order, created_at, updated_at)
             VALUES (1, NULL, 'Standard', 0, 0, 0);",
        )
        .unwrap();

        assert_eq!(
            clear_wishlist(&conn).unwrap(),
            1,
            "the number is wishes removed, and the folder is not one"
        );

        assert_eq!(count(&conn, "wishlist_entries"), 0);
        assert_eq!(count(&conn, "wishlist_folders"), 0);
        assert_eq!(count(&conn, "deck_folders"), 1);
    }

    /// Every table that hangs off `decks`, in one assertion each, because the cascade is the
    /// implementation: if a future migration adds a deck-shaped table without
    /// `ON DELETE CASCADE`, this is the test that says so.
    #[test]
    fn clearing_the_decks_takes_the_cascade_and_the_folders_with_it() {
        let conn = db();
        seed(&conn);
        // One row in each table that hangs off `decks`, so that every assertion below is a
        // statement about a cascade rather than about an empty table.
        conn.execute(
            "INSERT INTO deck_categories (id, deck_id, name, kind, sort_order, created_at, updated_at)
             VALUES (1, 1, 'Main', 'main', 0, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deck_tags (id, name, name_key, color, created_at, updated_at)
             VALUES (1, 'Ramp', 'ramp', 'green', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deck_cards
                (id, deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                 name, quantity, created_at, updated_at)
             VALUES (1, 1, 1, 'live', 'a', 'lea', '1', 'en', 'Shock', 1, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deck_audit (id, deck_id, at, kind, payload) VALUES (1, 1, 0, 'add', '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deck_undo (audit_id, deck_id, step) VALUES (1, 1, '{\"undo\":[]}')",
            [],
        )
        .unwrap();

        let out = clear_decks(&conn, None).unwrap();

        assert_eq!(out.decks, 1);
        assert_eq!(out.folders, 1);
        for table in [
            "decks",
            "deck_folders",
            "deck_cards",
            "deck_categories",
            // Not by cascade any more — see `clear_decks`. Asserted in the same list all the
            // same: what the reader is promised is an empty deck surface, however it is got.
            "deck_tags",
            "deck_audit",
            "deck_undo",
            "deck_allocations",
        ] {
            assert_eq!(count(&conn, table), 0, "{table} should have been cleared");
        }
    }

    /// The collection is not a deck's to take. The allocation goes — it names a deck — and the
    /// owned row it pointed at stays, because the reader still owns the card.
    #[test]
    fn clearing_the_decks_leaves_the_collection_owning_its_cards() {
        let conn = db();
        seed(&conn);

        clear_decks(&conn, None).unwrap();

        assert_eq!(count(&conn, "collection_entries"), 1);
        assert_eq!(count(&conn, "deck_allocations"), 0);
        let quantity: i64 = conn
            .query_row(
                "SELECT quantity FROM collection_entries WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(quantity, 4, "an allocation is a reservation, not a debit");
    }

    #[test]
    fn clearing_the_decks_sweeps_the_cover_pictures() {
        let dir = tempfile::tempdir().unwrap();
        let covers = dir.path();
        crate::images::write_cover(covers, 1, b"pretend webp").unwrap();
        crate::images::write_cover(covers, 7, b"an orphan").unwrap();
        let conn = db();
        seed(&conn);

        let out = clear_decks(&conn, Some(covers)).unwrap();

        assert_eq!(out.covers, 2, "the orphan goes too — no deck can claim it");
        assert!(!crate::images::cover_file(covers, 1).exists());
        assert!(covers.is_dir(), "the directory itself must survive");
    }

    /// The sweep walks `images/<variant>/<shard>/` and empties `tmp/` beside it, and leaves the
    /// two roots standing.
    #[test]
    fn the_cache_sweep_empties_both_trees_and_keeps_their_roots() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        let tmp = dir.path().join("tmp");
        let shard = images.join("thumb").join("ab");
        fs::create_dir_all(&shard).unwrap();
        fs::create_dir_all(&tmp).unwrap();
        fs::write(shard.join("abcd-0.webp"), b"1234567890").unwrap();
        fs::write(shard.join("abcd-1.webp"), b"12345").unwrap();
        fs::write(tmp.join("default-cards.jsonl.gz"), b"gz").unwrap();
        let conn = db();
        conn.execute(
            "INSERT INTO image_cache (card_id, face, variant, source_uri, bytes, fetched_at)
             VALUES ('abcd', 0, 'thumb', 'https://cards.scryfall.io/x.webp?1', 10, 0)",
            [],
        )
        .unwrap();
        let cache = crate::images::Cache::new(images.clone());

        let out = clear_cache(&conn, &images, &tmp, &cache).unwrap();

        assert_eq!(out.files, 3);
        assert_eq!(out.bytes, 17);
        assert_eq!(out.rows, 1);
        assert_eq!(out.failed, 0);
        assert_eq!(count(&conn, "image_cache"), 0);
        assert!(images.is_dir() && tmp.is_dir());
        assert!(!shard.exists(), "an emptied shard directory goes with it");
    }

    /// The queue that would otherwise re-assert rows for the files just deleted. Drained last,
    /// and this is the assertion that it is drained at all.
    #[test]
    fn the_cache_sweep_drops_the_rows_still_owed_for_the_files_it_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        let tmp = dir.path().join("tmp");
        fs::create_dir_all(&images).unwrap();
        fs::create_dir_all(&tmp).unwrap();
        let cache = crate::images::Cache::new(images.clone());
        cache.queue_record_for_test(
            "3f2c9a1e-0000-4000-8000-000000000001",
            "https://cards.scryfall.io/x.webp?1",
            10,
        );
        assert_eq!(cache.pending_records(), 1);
        let conn = db();

        clear_cache(&conn, &images, &tmp, &cache).unwrap();

        assert_eq!(cache.pending_records(), 0);
    }

    /// A directory that is not there is not an error: a fresh install has fetched no picture
    /// and downloaded no bulk file, and pressing the button on that install must still answer.
    #[test]
    fn the_cache_sweep_answers_zero_when_there_is_nothing_to_sweep() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        let tmp = dir.path().join("tmp");
        let cache = crate::images::Cache::new(images.clone());
        let conn = db();

        let out = clear_cache(&conn, &images, &tmp, &cache).unwrap();

        assert_eq!(out.files, 0);
        assert_eq!(out.bytes, 0);
        assert_eq!(out.failed, 0);
    }

    /// The one directory this command must never reach into, asserted from the outside: the
    /// covers folder is a sibling of `images/` and `tmp/`, and a sweep given the data directory
    /// by mistake would take it.
    #[test]
    fn the_cache_sweep_never_touches_the_deck_covers() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        let tmp = dir.path().join("tmp");
        let covers = dir.path().join("covers");
        fs::create_dir_all(&images).unwrap();
        fs::create_dir_all(&tmp).unwrap();
        fs::create_dir_all(&covers).unwrap();
        crate::images::write_cover(&covers, 3, b"the reader's own picture").unwrap();
        let cache = crate::images::Cache::new(images.clone());
        let conn = db();

        clear_cache(&conn, &images, &tmp, &cache).unwrap();

        assert!(crate::images::cover_file(&covers, 3).exists());
    }

    /// A symlink is unlinked, never followed. The sweep would otherwise walk into whatever a
    /// link in the data directory points at — which on a portable install beside the reader's
    /// own folders is not a theoretical target.
    #[cfg(windows)]
    #[test]
    fn the_cache_sweep_unlinks_rather_than_follows() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&images).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let kept = outside.join("precious.txt");
        fs::write(&kept, b"not the cache's").unwrap();
        // Creating a symlink needs Developer Mode or an elevated shell; where it is refused
        // there is nothing to assert and the guarantee is the OS's rather than ours.
        if std::os::windows::fs::symlink_file(&kept, images.join("link.txt")).is_err() {
            return;
        }
        let cache = crate::images::Cache::new(images.clone());
        let conn = db();

        clear_cache(&conn, &images, &dir.path().join("tmp"), &cache).unwrap();

        assert!(kept.exists(), "the link's target must survive");
        assert!(!images.join("link.txt").exists(), "the link itself must go");
    }
}
