//! **The desktop's half of `collection`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::collection::*;

use crate::sync::AppState;
use std::sync::Arc;

#[tauri::command]
pub async fn collection_add(
    state: tauri::State<'_, Arc<AppState>>,
    entry: EntryInput,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |c| add_entry(c, &entry))
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

#[tauri::command]
pub async fn collection_set_quantity(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |c| set_quantity(c, id, quantity))
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

#[tauri::command]
pub async fn collection_update(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    patch: EntryPatch,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |c| update_entry(c, id, &patch))
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

/// "Use this printing" on a collection entry — see [`set_entry_printing`] for the fold, which is
/// why this answers an [`EntryChange`] whose `id` is not always the `id` it was given.
///
/// **`with_write_owned` and not plain `sync::with_write`**, which is where it parts from
/// `wishlist_set_printing`: the facet index's `owned` dimension is keyed by printing, so moving
/// copies from one printing to another changes what it counts, where a wish changes nothing the
/// index knows about. It is `collection_update`'s wrapper for `collection_update`'s reason.
#[tauri::command]
pub async fn collection_set_printing(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    card_id: String,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |c| set_entry_printing(c, id, &card_id))
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

#[tauri::command]
pub async fn collection_remove(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |c| remove_entry(c, id))
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

/// One transaction for a whole imported file — see [`commit_import`], and [`walk_import`] for how
/// each line is counted and what a `set` at the root does with copies filed elsewhere.
///
/// **`folder_id` is absent for every import but one.** A file describes cards, not filing, so the
/// collection's own import step sends nothing and its rows land at the root. The deck arm of the
/// import dialog sends the group of the deck it just wrote a list into, so the list and the
/// copies backing it agree the moment the dialog closes — see [`DECK_WRITE_FOLDERS`], which is the
/// only place in the crate that fence is wider than the reader's own drawers.
#[tauri::command]
pub async fn collection_import_commit(
    state: tauri::State<'_, Arc<AppState>>,
    items: Vec<CollectionImportItem>,
    mode: String,
    folder_id: Option<i64>,
) -> Result<ImportCommitOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |c| {
            commit_import(c, &items, &mode, folder_id)
        })
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

/// What [`collection_import_commit`] would answer for the same three arguments, without writing —
/// see [`preview_import`]. **A read, on `db_read`**, like every read in the app: it takes no write
/// lock, so it never answers `BUSY` behind a sync, and it cannot fire the write connection's
/// update hook.
#[tauri::command]
pub async fn collection_import_preview(
    state: tauri::State<'_, Arc<AppState>>,
    items: Vec<CollectionImportItem>,
    mode: String,
    folder_id: Option<i64>,
) -> Result<ImportCommitOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        preview_import(&crate::sync::lock_db_read(&state), &items, &mode, folder_id)
    })
    .await
    .map_err(|e| format!("the collection could not be read: {e}"))?
}

/// `Remove from collection` over several entries — see [`remove_entries`]. `with_write_owned`,
/// because deleting rows changes what the facet index's `owned` dimension counts.
#[tauri::command]
pub async fn collection_remove_many(
    state: tauri::State<'_, Arc<AppState>>,
    ids: Vec<i64>,
) -> Result<BulkRemoveOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |c| remove_entries(c, &ids))
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

/// The collection list. **Read-only** connection, blocking pool — as every read in this
/// app is, so a list never queues behind a sync.
#[tauri::command]
pub async fn collection_list(
    state: tauri::State<'_, Arc<AppState>>,
    query: CollectionQuery,
) -> Result<CollectionPage, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_entries(&crate::sync::lock_db_read(&state), &query)
    })
    .await
    .map_err(|e| format!("the collection could not be read: {e}"))?
}

#[tauri::command]
pub async fn collection_summary(
    state: tauri::State<'_, Arc<AppState>>,
    query: CollectionQuery,
) -> Result<CollectionSummary, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        summarise(&crate::sync::lock_db_read(&state), &query)
    })
    .await
    .map_err(|e| format!("the collection could not be read: {e}"))?
}

/// The Shelves wall's per-shelf figures. **Read-only** connection, blocking pool, like
/// [`collection_list`] beside it.
#[tauri::command]
pub async fn collection_shelf_counts(
    state: tauri::State<'_, Arc<AppState>>,
    query: CollectionQuery,
) -> Result<Vec<ShelfCount>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        shelf_counts(&crate::sync::lock_db_read(&state), &query)
    })
    .await
    .map_err(|e| format!("the collection could not be read: {e}"))?
}

/// **Read-only** connection, like every list in the app.
///
/// `Option<String>` for the marketplace rather than the enum, which is
/// [`crate::collection_folders::collection_folder_summary`]'s spelling for the same argument:
/// an id this build does not know lands on TCGplayer through
/// [`crate::sorting::Marketplace::from_opt`] rather than failing the whole request.
#[tauri::command]
pub async fn collection_breakdown(
    state: tauri::State<'_, Arc<AppState>>,
    dimension: String,
    marketplace: Option<String>,
) -> Result<Vec<BreakdownRow>, String> {
    let state = state.inner().clone();
    let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        breakdown(&crate::sync::lock_db_read(&state), &dimension, marketplace)
    })
    .await
    .map_err(|e| format!("the collection could not be read: {e}"))?
}
