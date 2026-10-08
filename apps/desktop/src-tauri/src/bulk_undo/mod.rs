//! **The desktop's half of `bulk_undo`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::bulk_undo::*;

use std::sync::Arc;

use crate::sync::AppState;

/// Take back one bulk write — see [`undo`].
///
/// **The wrapper follows the table**, which is why the ticket is asked for its table before the
/// write lock is taken: a collection undo changes which rows exist, and the facet index's `owned`
/// dimension counts them ([`crate::collection_source::with_write_owned`], the wrapper every
/// collection write that inserts or deletes rows takes); a wishlist one is
/// [`crate::sync::with_write`], `wishlist_import_commit`'s own. An id the store does not hold is
/// [`UNDO_GONE`] without touching the database at all.
#[tauri::command]
pub async fn bulk_undo(
    state: tauri::State<'_, Arc<AppState>>,
    undo_id: u64,
) -> Result<BulkUndoOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || match with_store(|s| s.table_of(undo_id)) {
        None => Err(UNDO_GONE.to_owned()),
        Some(Table::Collection) => {
            crate::collection_source::with_write_owned(&state, |c| undo(c, undo_id))
        }
        Some(Table::Wishlist) => crate::sync::with_write(&state, |c| undo(c, undo_id)),
    })
    .await
    .map_err(|e| format!("that could not be undone: {e}"))?
}
