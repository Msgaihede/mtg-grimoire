//! **The desktop's half of `value_history`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::value_history::*;

use crate::sorting::Marketplace;
use crate::sync::AppState;
use std::sync::Arc;

/// The Collection value graph's read. **Read-only** connection, blocking pool, and the
/// marketplace taken as `price_movers` takes it — an absent or unknown id is TCGplayer, never a
/// refusal. The split is refused in words when it is not one of the four.
#[tauri::command]
pub async fn collection_value_history(
    state: tauri::State<'_, Arc<AppState>>,
    split: String,
    marketplace: Option<Marketplace>,
) -> Result<ValueHistory, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        history(
            &crate::sync::lock_db_read(&state),
            &split,
            marketplace.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| format!("the collection's value history could not be read: {e}"))?
}
