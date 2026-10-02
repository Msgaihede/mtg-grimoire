//! **The desktop's half of `deck_undo`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deck_undo::*;

use std::sync::Arc;

#[tauri::command]
pub async fn deck_undo_state(
    state: tauri::State<'_, Arc<crate::sync::AppState>>,
    deck_id: i64,
    redo_id: Option<i64>,
) -> Result<DeckUndoState, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        undo_state(&crate::sync::lock_db_read(&state), deck_id, redo_id)
    })
    .await
    .map_err(|e| format!("the deck's undo state could not be read: {e}"))?
}

/// Undo the named change. The id is the cursor's or the call is refused in words.
#[tauri::command]
pub async fn deck_undo_apply(
    state: tauri::State<'_, Arc<crate::sync::AppState>>,
    deck_id: i64,
    audit_id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        crate::sync::with_write(&state, |conn| apply_reversal(conn, deck_id, audit_id, true))
    })
    .await
    .map_err(|e| format!("the change could not be undone: {e}"))?
}

/// Put back a change that was undone.
#[tauri::command]
pub async fn deck_redo_apply(
    state: tauri::State<'_, Arc<crate::sync::AppState>>,
    deck_id: i64,
    audit_id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        crate::sync::with_write(&state, |conn| {
            apply_reversal(conn, deck_id, audit_id, false)
        })
    })
    .await
    .map_err(|e| format!("the change could not be redone: {e}"))?
}
