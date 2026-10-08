//! **The desktop's half of `deck_completion`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deck_completion::*;

use crate::sorting::Marketplace;
use crate::sync::AppState;
use std::sync::Arc;

/// Every answering deck's completion, for the home page. **Read-only** connection, blocking
/// pool, as every read in this app is — [`crate::deck::deck_values`]' shape exactly, marketplace
/// and fallback included: anything this build does not recognise quotes TCGplayer rather than
/// failing, and anything that is not `"theory"` compares against the collection.
#[tauri::command]
pub async fn deck_completion(
    state: tauri::State<'_, Arc<AppState>>,
    marketplace: Option<String>,
    compare: Option<String>,
) -> Result<Vec<DeckCompletion>, String> {
    let state = state.inner().clone();
    let marketplace = Marketplace::from_opt(marketplace.as_deref());
    let compare = Compare::from_opt(compare.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        deck_completion_for(&crate::sync::lock_db_read(&state), marketplace, compare)
    })
    .await
    .map_err(|e| format!("the deck completion could not be read: {e}"))?
}

/// To review's deck-card count. **Read-only** connection, blocking pool.
#[tauri::command]
pub async fn deck_review_count(state: tauri::State<'_, Arc<AppState>>) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || review_count(&crate::sync::lock_db_read(&state)))
        .await
        .map_err(|e| format!("the deck cards to review could not be counted: {e}"))?
}
