//! **The desktop's half of `listview`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::listview::*;

use crate::sync::AppState;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Every list's remembered layout, as section name → layout word.
///
/// **Infallible by signature**, [`crate::zoom::card_zoom`]'s contract and for its reason: the
/// frontend reads this once at launch to seed a store already built out of its own defaults, and
/// there is nothing a list could do with an error here that is not just "draw the layout you
/// already have".
///
/// `#[tauri::command(async)]` rather than a bare sync command: a sync body runs inline on the IPC
/// thread, and this one takes `db_read`'s mutex, which a search may hold for tens of milliseconds
/// — and this is called while the window is drawing its first frame.
#[tauri::command(async)]
pub fn list_view(state: tauri::State<'_, Arc<AppState>>) -> BTreeMap<String, String> {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember one list's layout. Rejects a blank section and a word that is not a layout, and
/// answers [`crate::db::BUSY`] if a sync holds the write connection — the bound every write
/// command in this crate takes.
///
/// **A refusal here is not worth surfacing**, [`crate::nav::set_nav_collapsed`]'s note and for its
/// reason: the frontend writes optimistically and keeps the reader's choice for the session either
/// way, so a BUSY during a first-run sync costs them nothing they can see now and only the next
/// launch's starting layout.
#[tauri::command]
pub async fn set_list_view(
    state: tauri::State<'_, Arc<AppState>>,
    section: String,
    view: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &section, &view))
    })
    .await
    .map_err(|e| format!("the list layout could not be saved: {e}"))?
}
