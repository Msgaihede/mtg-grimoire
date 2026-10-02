//! **The desktop's half of `home`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::home::*;

use crate::sync::AppState;
use std::sync::Arc;

/// The reader's home page, or the default one.
///
/// **Infallible by signature**, [`crate::nav::nav_collapsed`]'s contract and for its reason: the
/// page reads this once at launch to seed a store that already holds a default of its own, and
/// there is nothing it could do with an error that is not just "draw the widgets you already
/// have".
///
/// `#[tauri::command(async)]` rather than a bare sync command, [`crate::nav::nav_collapsed`]'s
/// reason: a sync body runs inline on the IPC thread, and this one takes `db_read`'s mutex, which
/// a search may hold for tens of milliseconds — and this is called while the window is drawing
/// its first frame.
#[tauri::command(async)]
pub fn home_layout(state: tauri::State<'_, Arc<AppState>>) -> HomeLayout {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember the reader's home page. Answers [`crate::db::BUSY`] if a sync holds the write
/// connection — the bound every write command in this crate takes.
///
/// **This refusal is worth surfacing**, [`crate::markcolors::set_mark_color`]'s reading rather
/// than [`crate::nav::set_nav_collapsed`]'s: the reader has just dragged a widget somewhere and
/// is looking at the result, so the page says the arrangement did not save rather than leaving
/// them to find out at the next launch.
#[tauri::command]
pub async fn set_home_layout(
    state: tauri::State<'_, Arc<AppState>>,
    layout: HomeLayout,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &layout))
    })
    .await
    .map_err(|e| format!("the home page could not be saved: {e}"))?
}
