//! **The desktop's half of `deck_audit`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deck_audit::*;

use crate::sync::AppState;
use std::sync::Arc;

/// One deck's history. **Read-only** connection, blocking pool — as every read in this app is,
/// so opening the history drawer never queues behind a sync.
#[tauri::command]
pub async fn deck_audit_list(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    limit: i64,
) -> Result<Vec<DeckAuditEntry>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list(&crate::sync::lock_db_read(&state), deck_id, limit)
    })
    .await
    .map_err(|e| format!("the deck history could not be read: {e}"))?
}
