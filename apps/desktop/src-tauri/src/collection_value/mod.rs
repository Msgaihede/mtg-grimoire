//! **The desktop's half of `collection_value`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole; what is below names the
//! desktop's `AppState`: the two `#[tauri::command]` wrappers.

pub use grimoire_core::collection_value::*;

use crate::sync::AppState;
use std::sync::Arc;

/// The reader's sell percentage and minimum card value. **Infallible by signature**,
/// `startview::start_view`'s contract: a row that cannot be read is the defaults.
///
/// `#[tauri::command(async)]` for `start_view`'s reason: a sync body runs on the IPC thread, and
/// this takes `db_read`'s mutex.
#[tauri::command(async)]
pub fn collection_value(state: tauri::State<'_, Arc<AppState>>) -> CollectionValue {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember the setting. Refuses a figure out of bounds ([`OUT_OF_BOUNDS`]), and answers
/// [`crate::db::BUSY`] if a sync holds the write connection.
#[tauri::command]
pub async fn set_collection_value(
    state: tauri::State<'_, Arc<AppState>>,
    settings: CollectionValue,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &settings))
    })
    .await
    .map_err(|e| format!("the collection value settings could not be saved: {e}"))?
}
