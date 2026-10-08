//! **The desktop's half of `stackhide`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::stackhide::*;

use crate::sync::AppState;
use std::sync::Arc;

/// The category ids hidden in one deck, ascending. **Infallible by signature**, `shelf_folds`'
/// contract: an editor that cannot read the row draws every stack's cards, which is what it does
/// with an empty list anyway. `(async)` for `shelf_folds`' reason — it takes `db_read`'s mutex
/// while the editor may be drawing its first frame.
#[tauri::command(async)]
pub fn hidden_stacks(state: tauri::State<'_, Arc<AppState>>, deck_id: i64) -> Vec<i64> {
    stored(&crate::sync::lock_db_read(state.inner()), deck_id)
}

/// Hide or show one stack. Refuses an id that is not positive, and answers [`crate::db::BUSY`]
/// while a sync holds the write connection — a refusal the frontend swallows, `set_shelf_folds`'
/// trade: the stack stays hidden or shown for this session either way.
#[tauri::command]
pub async fn set_stack_hidden(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    category_id: i64,
    hidden: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, deck_id, category_id, hidden))
    })
    .await
    .map_err(|e| format!("the hidden stacks could not be saved: {e}"))?
}
