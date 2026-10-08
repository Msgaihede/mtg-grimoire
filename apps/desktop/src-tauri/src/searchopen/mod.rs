//! **The desktop's half of `searchopen`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::searchopen::*;

use crate::sync::AppState;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Every column's remembered state, as section name → open.
///
/// **Infallible by signature**, [`crate::listview::list_view`]'s contract and for its reason: the
/// frontend reads this once at launch to seed a store already built out of its own defaults, and
/// there is nothing a page could do with an error here that is not just "draw the column the way
/// you already would have".
///
/// **Read once at launch and not by the panel**, which is a measurement rather than tidiness:
/// asked by the panel instead, the read queues behind the page's own query and lands ~700 ms after
/// the column has already been drawn the other way round — which is how a reader who had shut it
/// watched it thrown open and yanked closed on every deck they opened.
///
/// `#[tauri::command(async)]` rather than a bare sync command, [`crate::listview::list_view`]'s
/// reason: a sync body runs inline on the IPC thread, and this one takes `db_read`'s mutex, which
/// a search may hold for tens of milliseconds — and this is called while the window is drawing its
/// first frame.
#[tauri::command(async)]
pub fn search_open(state: tauri::State<'_, Arc<AppState>>) -> BTreeMap<String, bool> {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember whether one column is open. Rejects a blank section, and answers [`crate::db::BUSY`]
/// if a sync holds the write connection — the bound every write command in this crate takes.
///
/// **A refusal here is not worth surfacing**, [`crate::listview::set_list_view`]'s note and for its
/// reason: the frontend writes optimistically and keeps the reader's choice for the session either
/// way, so a BUSY during a first-run sync costs them nothing they can see now and only the next
/// launch's starting state.
#[tauri::command]
pub async fn set_search_open(
    state: tauri::State<'_, Arc<AppState>>,
    section: String,
    open: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &section, open))
    })
    .await
    .map_err(|e| format!("the search column state could not be saved: {e}"))?
}
