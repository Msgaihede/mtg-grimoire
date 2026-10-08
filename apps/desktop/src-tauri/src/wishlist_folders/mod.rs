//! **The desktop's half of `wishlist_folders`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::wishlist_folders::*;

use crate::collection::EntryChange;
use crate::sorting::Marketplace;
use crate::sync::{lock_db_read, with_write, AppState};
use std::sync::Arc;

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
/// [`wishlist_folder_delete_with_wishes`] is the sibling press that takes the wishes as well.
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

/// Empty one drawer of the wishes filed directly in it, and answer how many went — see
/// [`clear_folder`] for why its sub-folders are untouched and why a drawer that has gone is a
/// refusal rather than a zero.
#[tauri::command]
pub async fn wishlist_folder_clear(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| clear_folder(c, id)))
        .await
        .map_err(unfinished)?
}

/// Delete a drawer, its sub-tree and every wish in it, and answer how many wishes went — see
/// [`delete_folder_and_wishes`]. [`wishlist_folder_delete`] is the press that keeps them.
#[tauri::command]
pub async fn wishlist_folder_delete_with_wishes(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| delete_folder_and_wishes(c, id))
    })
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
