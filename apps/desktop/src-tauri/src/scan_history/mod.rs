//! **The desktop's half of `scan_history`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names the desktop's `AppState`:
//! the `#[tauri::command]` wrappers.
//!
//! Four commands, and each wrapper is its table entry's twin in name, arguments and kind
//! (`grimoire_core::commands`, held to it by `command_table`): two reads on the read connection
//! and two writes through [`with_write`]. The writes that *record* a batch are the scanner's —
//! `scanner_tray_commit` and `scanner_tray_archive` — because a batch is written with the tray.

pub use grimoire_core::scan_history::*;

use crate::sync::{with_write, AppState};
use std::sync::Arc;

/// What a read here says when its worker thread died under it — never a reader's problem.
fn unread(e: tauri::Error) -> String {
    format!("the scan history could not be read: {e}")
}

/// The same for a write. The write itself answers [`crate::db::BUSY`] when a sync holds the
/// connection.
fn unfinished(e: tauri::Error) -> String {
    format!("the scan history could not be written: {e}")
}

/// Every batch the tray filed or archived, newest first. **Read-only** connection, blocking
/// pool — as every read in this app is.
#[tauri::command]
pub async fn scan_history_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ScanBatchSummary>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_batches(&crate::sync::lock_db_read(&state)))
        .await
        .map_err(unread)?
}

/// One batch with its lines, or `None` when it is gone.
#[tauri::command]
pub async fn scan_history_get(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<Option<ScanBatch>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_batch(&crate::sync::lock_db_read(&state), id))
        .await
        .map_err(unread)?
}

/// A blank name is the default back, `Scan N`.
#[tauri::command]
pub async fn scan_history_rename(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    name: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| rename_batch(c, id, &name)))
        .await
        .map_err(unfinished)?
}

/// The batch and its lines. The collection is not touched.
#[tauri::command]
pub async fn scan_history_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| delete_batch(c, id)))
        .await
        .map_err(unfinished)?
}
