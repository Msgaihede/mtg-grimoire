//! **The desktop's half of `deck_query`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deck_query::*;

use crate::filters::CardFilters;
use crate::sync::AppState;
use std::sync::Arc;

/// [`query_cards`]'s command. **Read-only** connection and no marketplace: nothing here is
/// priced.
#[tauri::command]
pub async fn deck_query_cards(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    filters: CardFilters,
) -> Result<Vec<String>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        query_cards(&crate::sync::lock_db_read(&state), deck_id, &filters)
    })
    .await
    .map_err(|e| format!("the deck could not be searched: {e}"))?
}
