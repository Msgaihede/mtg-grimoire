//! **The desktop's half of `upcoming_sets`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::upcoming_sets::*;

use crate::sync::AppState;
use std::sync::Arc;

/// Coming soon's read. **Read-only** connection, blocking pool. `days` is narrowed here as well as
/// in TypeScript, because it arrives from a `config` a reader can hand-edit.
#[tauri::command]
pub async fn upcoming_sets(
    state: tauri::State<'_, Arc<AppState>>,
    days: i64,
) -> Result<UpcomingSets, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        upcoming_sets_for(&crate::sync::lock_db_read(&state), days)
    })
    .await
    .map_err(|e| format!("the upcoming sets could not be read: {e}"))?
}
