//! **The desktop's half of `shelffolds`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::shelffolds::*;

use crate::sync::AppState;
use std::collections::HashMap;
use std::sync::Arc;

/// Every page's folded-shelf overrides. **Infallible by signature**, `search_open`'s contract: a
/// wall that cannot read the row draws every shelf at its default, which is what the frontend
/// does with an empty map anyway. `(async)` for `search_open`'s reason — it takes `db_read`'s
/// mutex while a window may be drawing its first frame.
#[tauri::command(async)]
pub fn shelf_folds(state: tauri::State<'_, Arc<AppState>>) -> ShelfFolds {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Set or remove folded-shelf overrides on one page. Refuses an unknown page and a key that is not
/// a folder id, and answers [`crate::db::BUSY`] while a sync holds the write connection — a refusal
/// the frontend swallows, `set_search_open`'s trade: the fold holds for this session either way.
#[tauri::command]
pub async fn set_shelf_folds(
    state: tauri::State<'_, Arc<AppState>>,
    page: String,
    changes: HashMap<String, Option<bool>>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &page, &changes))
    })
    .await
    .map_err(|e| format!("the folded shelves could not be saved: {e}"))?
}
