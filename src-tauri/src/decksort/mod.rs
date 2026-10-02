//! **The desktop's half of `decksort`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::decksort::*;

use crate::sync::AppState;
use std::sync::Arc;

/// How the reader has the deck gallery ordered.
///
/// **Infallible by signature**, [`crate::listview::list_view`]'s contract and for its reason:
/// the frontend reads this once while the gallery is drawing its first frame, to seed a store
/// already built out of its own default, and there is nothing a wall of decks could do with an
/// error here that is not just "open on the order you already have".
///
/// `#[tauri::command(async)]` rather than a bare sync command, also [`crate::listview`]'s: a
/// sync body runs inline on the IPC thread, and this one takes `db_read`'s mutex, which a search
/// may hold for tens of milliseconds.
#[tauri::command(async)]
pub fn deck_sort(state: tauri::State<'_, Arc<AppState>>) -> String {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember how the gallery is ordered. Refuses a blank, and answers [`crate::db::BUSY`] if a
/// sync holds the write connection — the bound every write command in this crate takes.
///
/// **A refusal here is not worth surfacing**, [`crate::listview::set_list_view`]'s note and for
/// its reason: the frontend writes optimistically and keeps the reader's choice for the session
/// either way, so a BUSY during a first-run sync costs them nothing they can see now and only
/// the next launch's starting order.
#[tauri::command]
pub async fn set_deck_sort(
    state: tauri::State<'_, Arc<AppState>>,
    sort: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &sort))
    })
    .await
    .map_err(|e| format!("the deck order could not be saved: {e}"))?
}
