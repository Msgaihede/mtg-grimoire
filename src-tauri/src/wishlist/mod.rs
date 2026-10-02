//! **The desktop's half of `wishlist`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::wishlist::*;

use crate::collection::{EntryChange, ShelfCount};
use crate::sync::{with_write, AppState};
use std::sync::Arc;

#[tauri::command]
pub async fn wishlist_add(
    state: tauri::State<'_, Arc<AppState>>,
    wish: WishInput,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| add_wish(c, &wish)))
        .await
        .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

#[tauri::command]
pub async fn wishlist_set_quantity(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_wish_quantity(c, id, quantity))
    })
    .await
    .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

#[tauri::command]
pub async fn wishlist_remove(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| remove_wish(c, id)))
        .await
        .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

/// "Use this printing", and "Any printing" — see [`set_wish_printing`] for the merge, which
/// is why this answers an [`EntryChange`] whose `id` is not always the `id` it was given.
#[tauri::command]
pub async fn wishlist_set_printing(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    card_id: Option<String>,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_wish_printing(c, id, card_id))
    })
    .await
    .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

/// One transaction for a whole imported file — see [`commit_import`] for the `set` arm's route
/// through [`add_wish`] and why `removed` is counted rather than derived.
#[tauri::command]
pub async fn wishlist_import_commit(
    state: tauri::State<'_, Arc<AppState>>,
    items: Vec<WishlistImportItem>,
    mode: String,
) -> Result<crate::collection::ImportCommitOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| commit_import(c, &items, &mode))
    })
    .await
    .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

/// The wishlist. **Read-only** connection, blocking pool — as every read in this app is.
#[tauri::command]
pub async fn wishlist_list(
    state: tauri::State<'_, Arc<AppState>>,
    query: WishlistQuery,
) -> Result<WishlistPage, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_wishes(&crate::sync::lock_db_read(&state), &query)
    })
    .await
    .map_err(|e| format!("the wishlist could not be read: {e}"))?
}

/// The Shelves wall's per-shelf figures for the wishlist — and, summed, its header's Total cost.
/// **Read-only** connection, blocking pool.
#[tauri::command]
pub async fn wishlist_shelf_counts(
    state: tauri::State<'_, Arc<AppState>>,
    query: WishlistQuery,
) -> Result<Vec<ShelfCount>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        shelf_counts(&crate::sync::lock_db_read(&state), &query)
    })
    .await
    .map_err(|e| format!("the wishlist could not be read: {e}"))?
}

/// The wishlist's header figures. **Read-only** connection, blocking pool — as every read in
/// this app is.
#[tauri::command]
pub async fn wishlist_summary(
    state: tauri::State<'_, Arc<AppState>>,
    marketplace: crate::sorting::Marketplace,
) -> Result<WishlistSummary, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        summarise_wishlist(&crate::sync::lock_db_read(&state), marketplace)
    })
    .await
    .map_err(|e| format!("the wishlist could not be read: {e}"))?
}

/// The same money, one dimension at a time. **Read-only**, like its neighbour.
#[tauri::command]
pub async fn wishlist_breakdown(
    state: tauri::State<'_, Arc<AppState>>,
    dimension: String,
    marketplace: crate::sorting::Marketplace,
) -> Result<Vec<crate::collection::BreakdownRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        breakdown(&crate::sync::lock_db_read(&state), &dimension, marketplace)
    })
    .await
    .map_err(|e| format!("the wishlist could not be read: {e}"))?
}
