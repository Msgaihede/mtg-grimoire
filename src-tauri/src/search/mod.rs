//! **The desktop's half of `search`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::search::*;

use crate::sync::{lock_db_read, AppState};
use std::sync::Arc;

/// [`run_search_marks`] over the read connection, for [`search_cards`]' reasons.
#[tauri::command]
pub async fn search_marks(
    state: tauri::State<'_, Arc<AppState>>,
    req: MarksRequest,
) -> Result<Vec<CardMarks>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_search_marks(&lock_db_read(&state), &req))
        .await
        .map_err(|e| format!("search marks could not be read: {e}"))?
}

/// Search the card database.
///
/// Runs on the **read-only** connection, which is the whole reason there is one: the
/// writer's longest job is the ingest, ~80 s of a 92–99 s sync, and a search sharing its
/// mutex would queue behind it — the app would stop answering searches once a day for the
/// length of a sync. Chunking the ingest bounded that wait to one 2 000-row batch, but a
/// search must not wait for a batch either: 20 timed searches across a live sync, every
/// one correct, none stalled. Under WAL a reader sees the last committed snapshot
/// without blocking, so it
/// answers immediately with the pre-swap card data, which is exactly right.
///
/// `async` + `spawn_blocking`, not a plain sync command: a sync command body runs inline
/// on the IPC thread, and SQLite work is blocking. `lock_db_read` is shared with `sync`
/// so poison recovery has one definition.
#[tauri::command]
pub async fn search_cards(
    state: tauri::State<'_, Arc<AppState>>,
    req: SearchRequest,
) -> Result<SearchResponse, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_search(&lock_db_read(&state), &req))
        .await
        .map_err(|e| format!("search could not be run: {e}"))?
}

/// The set list, for the search filter. Read-only connection, blocking pool — as
/// [`search_cards`] is, and for the same reason.
#[tauri::command]
pub async fn list_sets(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<SetSummary>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_list_sets(&lock_db_read(&state)))
        .await
        .map_err(|e| format!("set list could not be read: {e}"))?
}
