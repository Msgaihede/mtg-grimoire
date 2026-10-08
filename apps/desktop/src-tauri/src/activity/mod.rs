//! **The desktop's half of `activity`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::activity::*;

use crate::sync::AppState;
use std::sync::Arc;

/// The home page's feed. **Read-only** connection, blocking pool — as every read in this app is,
/// so drawing the home page never queues behind a sync.
#[tauri::command]
pub async fn activity_recent(
    state: tauri::State<'_, Arc<AppState>>,
    limit: u32,
) -> Result<Vec<ActivityEntry>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || recent(&crate::sync::lock_db_read(&state), limit))
        .await
        .map_err(|e| format!("the activity feed could not be read: {e}"))?
}
