//! **The desktop's half of `custom_widgets`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names the desktop's `AppState`:
//! the `#[tauri::command]` wrappers, each the command table's entry of the same name with its
//! connection fetched from Tauri's state.

pub use grimoire_core::custom_widgets::*;

use crate::sync::{with_write, AppState};
use std::sync::Arc;

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What a write here says when its worker thread died under it — never a reader's problem. The
/// write itself answers [`crate::db::BUSY`] when a sync holds the connection.
fn unfinished(e: tauri::Error) -> String {
    format!("the widget could not be written: {e}")
}

/// Every stored definition, by name.
///
/// **Fallible, where `sticky_notes`' read is infallible by signature**, `deck_todos`' reason: a
/// read that failed and answered `[]` would draw every placed custom widget as deleted. An error
/// lets the page say so instead.
///
/// `#[tauri::command(async)]` on a **sync** `fn`, `sticky_notes`' reason: a bare sync body runs
/// inline on the IPC thread, and this one takes [`crate::sync::lock_db_read`]'s mutex. The module
/// and its read wear one name on purpose, `sticky_notes::sticky_notes`' arrangement.
#[tauri::command(async)]
pub fn custom_widgets(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<CustomWidget>, String> {
    list(&crate::sync::lock_db_read(state.inner())).map_err(|e| e.to_string())
}

/// Store a new definition — see [`create`] for the shape it is held to.
#[tauri::command]
pub async fn custom_widget_create(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    description: String,
    query: String,
    spec: serde_json::Value,
    w: i64,
    h: i64,
) -> Result<CustomWidget, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            create(c, &name, &description, &query, &spec, w, h)
        })
    })
    .await
    .map_err(unfinished)?
}

/// **Every field is optional and an absent one means *leave it*.** See [`update`].
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn custom_widget_update(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    name: Option<String>,
    description: Option<String>,
    query: Option<String>,
    spec: Option<serde_json::Value>,
    w: Option<i64>,
    h: Option<i64>,
) -> Result<CustomWidget, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            update(c, id, name, description, query, spec, w, h)
        })
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn custom_widget_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| delete(c, id)))
        .await
        .map_err(unfinished)?
}
