//! **The desktop's half of `zoom`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::zoom::*;

use crate::sync::AppState;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Every wall's remembered zoom, as section name → multiplier.
///
/// **Infallible by signature**, [`crate::marketplace::get_marketplace`]'s contract and for its
/// reason: the frontend reads this once at launch to seed a store that has already been built out
/// of its own defaults, and there is nothing a wall of cards could do with an error here that is
/// not just "keep the size you already have" — so this does that instead of making the caller do
/// it.
///
/// `#[tauri::command(async)]` rather than a bare sync command: a sync body runs inline on the IPC
/// thread, and this one takes `db_read`'s mutex, which a search may hold for tens of milliseconds
/// — and this is called while the window is drawing its first frame.
#[tauri::command(async)]
pub fn card_zoom(state: tauri::State<'_, Arc<AppState>>) -> BTreeMap<String, f64> {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember one section's zoom. Rejects a blank section and an out-of-range multiplier, and
/// answers [`crate::db::BUSY`] if a sync holds the write connection — the bound every write
/// command in this crate takes.
///
/// **A refusal here is not worth surfacing**, which is a fact about the caller rather than about
/// this function: the frontend writes on a trailing timer after a gesture has stopped, so a BUSY
/// during a first-run sync costs the reader nothing they can see this session and only the next
/// launch's starting size. Nothing on screen would be improved by saying so.
#[tauri::command]
pub async fn set_card_zoom(
    state: tauri::State<'_, Arc<AppState>>,
    section: String,
    zoom: f64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &section, zoom))
    })
    .await
    .map_err(|e| format!("the card zoom could not be saved: {e}"))?
}
