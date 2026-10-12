//! **The desktop's half of `panelwidth`** — `searchopen`'s pair with a width where the `bool` is.
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole; what is below names the
//! desktop's `AppState`: the `#[tauri::command]` wrappers.

pub use grimoire_core::panelwidth::*;

use crate::sync::AppState;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Every panel's remembered width, as section name → pixels. **Infallible by signature**, and
/// `(async)` for [`crate::searchopen::search_open`]'s reason: it takes `db_read`'s mutex.
#[tauri::command(async)]
pub fn panel_width(state: tauri::State<'_, Arc<AppState>>) -> BTreeMap<String, u32> {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember one panel's width. Rejects a blank section or a width out of bounds, and answers
/// [`crate::db::BUSY`] if a sync holds the write connection — a refusal the frontend swallows,
/// [`crate::searchopen::set_search_open`]'s trade.
#[tauri::command]
pub async fn set_panel_width(
    state: tauri::State<'_, Arc<AppState>>,
    section: String,
    width: u32,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &section, width))
    })
    .await
    .map_err(|e| format!("the panel width could not be saved: {e}"))?
}
