//! **The desktop's half of `deckpane`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deckpane::*;

use crate::sync::AppState;
use std::sync::Arc;

/// The decks page's folder tree as this database remembers it.
///
/// **Infallible by signature**, [`crate::nav::nav_collapsed`]'s contract and for its reason: the
/// frontend reads this once to seed a store that already has defaults of its own, and there is
/// nothing the decks page could do with an error here that is not just "draw the tree the way you
/// already would have".
///
/// `#[tauri::command(async)]` rather than a bare sync command: a sync body runs inline on the IPC
/// thread, and this one takes `db_read`'s mutex, which a search may hold for tens of milliseconds
/// — and this is called while the window is drawing its first frame. It is not an `async fn`
/// because Tauri requires a `Result` from one that borrows `State`, and a `Result` here would be a
/// failure mode this call does not have.
#[tauri::command(async)]
pub fn deck_folder_pane(state: tauri::State<'_, Arc<AppState>>) -> DeckFolderPane {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember the folder tree's width and collapse. Rejects a width outside
/// [`MIN_PANE_WIDTH`]..=[`MAX_PANE_WIDTH`], and answers [`crate::db::BUSY`] if a sync holds the
/// write connection — the bound every write command in this crate takes.
///
/// **A refusal here is deliberately not surfaced**, [`crate::nav::set_nav_collapsed`]'s note and
/// for its reason: the frontend writes optimistically and keeps the reader's choice for the
/// session either way, so a BUSY during a first-run sync costs them nothing they can see now and
/// only the next launch's starting width. Nothing on screen would be improved by saying so.
#[tauri::command]
pub async fn set_deck_folder_pane(
    state: tauri::State<'_, Arc<AppState>>,
    width: u32,
    collapsed: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, width, collapsed))
    })
    .await
    .map_err(|e| format!("the folder tree width could not be saved: {e}"))?
}
