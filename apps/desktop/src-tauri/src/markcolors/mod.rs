//! **The desktop's half of `markcolors`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::markcolors::*;

use crate::sync::AppState;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Every mark's remembered colour, as mark → `#rrggbb`.
///
/// **Infallible by signature**, [`crate::listview::list_view`]'s contract and for its reason: the
/// frontend reads this once at launch to paint over defaults it already holds, and there is
/// nothing a card could do with an error here that is not just "draw the colour you already
/// have".
///
/// `#[tauri::command(async)]` rather than a bare sync command, [`crate::listview::list_view`]'s
/// reason: a sync body runs inline on the IPC thread, and this one takes `db_read`'s mutex, which
/// a search may hold for tens of milliseconds — and this is called while the window is drawing
/// its first frame.
#[tauri::command(async)]
pub fn mark_colors(state: tauri::State<'_, Arc<AppState>>) -> BTreeMap<String, String> {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember one mark's colour, or clear it. Answers [`crate::db::BUSY`] if a sync holds the write
/// connection — the bound every write command in this crate takes. Unlike the rail and the list
/// layout, **this refusal is worth surfacing**: the reader is standing in front of a colour picker
/// watching a swatch, so the panel says the write did not land rather than leaving them to find
/// out at the next launch.
#[tauri::command]
pub async fn set_mark_color(
    state: tauri::State<'_, Arc<AppState>>,
    mark: String,
    color: Option<String>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &mark, color.as_deref()))
    })
    .await
    .map_err(|e| format!("the colour could not be saved: {e}"))?
}
