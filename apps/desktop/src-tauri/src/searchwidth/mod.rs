//! **The desktop's half of `searchwidth`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::searchwidth::*;

use crate::sync::AppState;
use std::sync::Arc;

/// The width the reader last dragged one deck's card search column to, or `None`. **Infallible
/// by signature**, `hidden_stacks`' contract: an editor that cannot read the row draws the column
/// at its default, which is what it does for a deck nobody has dragged anyway. `(async)` for
/// `hidden_stacks`' reason — it takes `db_read`'s mutex while the editor may be drawing its first
/// frame.
#[tauri::command(async)]
pub fn deck_search_width(state: tauri::State<'_, Arc<AppState>>, deck_id: i64) -> Option<u32> {
    stored(&crate::sync::lock_db_read(state.inner()), deck_id)
}

/// Remember one deck's card search column width. Refuses an id that is not positive and a width
/// outside the storage band, and answers [`crate::db::BUSY`] while a sync holds the write
/// connection — a refusal the frontend swallows, `set_stack_hidden`'s trade: the column keeps the
/// reader's width for this session either way.
#[tauri::command]
pub async fn set_deck_search_width(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    width: u32,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, deck_id, width))
    })
    .await
    .map_err(|e| format!("the card search width could not be saved: {e}"))?
}
