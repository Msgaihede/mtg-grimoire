//! **The desktop's half of `collection_folders`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::collection_folders::*;

use crate::collection::EntryChange;
use crate::sorting::Marketplace;
use crate::sync::{lock_db_read, with_write, AppState};
use std::sync::Arc;

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

/// Lock a folder, or unlock it — see [`set_folder_locked`], and [`FOLDER_IS_LOCKED`] for the one
/// press a lock refuses.
///
/// **`with_write` and not `with_write_owned`**, [`collection_folder_reorder`]'s reasoning: this
/// touches no `collection_entries` row at all, so no card moves in or out of the reader's
/// ownership and the facet index's `owned` dimension already holds the answer. A lock changes
/// what the app *offers*, never what the reader has.
#[tauri::command]
pub async fn collection_folder_set_locked(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    locked: bool,
) -> Result<CollectionFolder, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_folder_locked(c, id, locked))
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

/// The drag's own command — see [`reorder_folders`] for why re-parenting and positioning are one
/// write. It answers the **whole** folder list rather than the rows it moved, like
/// [`crate::deck_meta::deck_category_reorder`]: every sibling's number changed, so a caller
/// handed only the moved rows would have to guess at the rest.
///
/// **`with_write` and not `with_write_owned`**, [`collection_folder_delete`]'s reasoning in its
/// simplest form: this touches no `collection_entries` row at all, so no card moves in or out of
/// the reader's ownership and the facet index's `owned` dimension already holds the answer.
#[tauri::command]
pub async fn collection_folder_reorder(
    state: tauri::State<'_, Arc<AppState>>,
    parent_id: Option<i64>,
    ids: Vec<i64>,
) -> Result<Vec<CollectionFolder>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| reorder_folders(c, parent_id, &ids))
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

/// Empty `Recently removed` and answer how many entries went — see [`clear_removed`] for why this
/// is the one press in the cabinet that may lose a card, and why a database with no holding area
/// is a refusal rather than a zero.
///
/// **[`crate::collection_source::with_write_owned`], where [`collection_folder_delete`] takes
/// `sync::with_write`**, and the difference is the one that paragraph draws: a delete re-files
/// and every `card_id` survives, while this takes rows out of the table, and a card whose last
/// copies were in the pile stops being owned. That is [`crate::collection::remove_entry`]'s
/// wrapper's reason, so it is that wrapper's helper.
#[tauri::command]
pub async fn collection_removed_clear(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, clear_removed)
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
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

/// `Move to` over several entries — see [`set_entries_folder`]. `with_write_owned` for
/// [`collection_set_folder`]'s reason: a merge deletes a row, and the facet index counts them.
#[tauri::command]
pub async fn collection_set_folder_many(
    state: tauri::State<'_, Arc<AppState>>,
    ids: Vec<i64>,
    folder_id: Option<i64>,
) -> Result<BulkMoveOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |c| {
            set_entries_folder(c, &ids, folder_id)
        })
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
