//! **The desktop's half of `set_completion`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::set_completion::*;

use crate::sync::AppState;
use std::sync::Arc;

/// The Set completion widget's read. **Read-only** connection, blocking pool — as every read in
/// this app is, so the home page never queues behind a sync.
///
/// **No arguments**, and the page sends none: an argument object sent to a command that declares
/// only the managed state is a deserialisation error (`packages/ui/lib/ipc.test.ts` pins it).
#[tauri::command]
pub async fn set_completion(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<SetCompletion>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        set_completion_of(&crate::sync::lock_db_read(&state))
    })
    .await
    .map_err(|e| format!("set completion could not be read: {e}"))?
}
