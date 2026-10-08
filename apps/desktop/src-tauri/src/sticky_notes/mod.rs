//! **The desktop's half of `sticky_notes`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::sticky_notes::*;

use crate::sync::{with_write, AppState};
use std::sync::Arc;

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What a write here says when its worker thread died under it — never a reader's problem. The
/// write itself answers [`crate::db::BUSY`] when a sync holds the connection.
fn unfinished(e: tauri::Error) -> String {
    format!("the note could not be written: {e}")
}

/// Every sticky note.
///
/// **Infallible by signature**, [`crate::home::home_layout`]'s contract and for its reason: the
/// widget reads this while the window draws its first frame, and there is nothing it could do
/// with an error that is not "draw the notes you already have".
///
/// `#[tauri::command(async)]` on a **sync** `fn`, the same module's reason: a bare sync body runs
/// inline on the IPC thread, and this one takes [`crate::sync::lock_db_read`]'s mutex, which a
/// search may hold for tens of milliseconds.
///
/// **`generate_handler!` names a command after its last path segment**, so
/// `sticky_notes::sticky_notes` registers as `sticky_notes` — the module and its read wear one
/// name on purpose, exactly as `deck_notes::deck_notes` does, because the wire name is the one
/// `packages/ui/lib/ipc.ts` invokes.
#[tauri::command(async)]
pub fn sticky_notes(state: tauri::State<'_, Arc<AppState>>) -> Vec<StickyNoteRow> {
    list_notes(&crate::sync::lock_db_read(state.inner())).unwrap_or_default()
}

#[tauri::command]
pub async fn sticky_note_create(
    state: tauri::State<'_, Arc<AppState>>,
    title: String,
    body: String,
    color: String,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| create_note(c, &title, &body, &color))
    })
    .await
    .map_err(unfinished)?
}

/// **Every field is optional and an absent one means *leave it*.** See [`update_note`].
#[tauri::command]
pub async fn sticky_note_update(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    title: Option<String>,
    body: Option<String>,
    color: Option<String>,
    pinned: Option<bool>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| update_note(c, id, title, body, color, pinned))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn sticky_note_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| delete_note(c, id)))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn sticky_note_reorder(
    state: tauri::State<'_, Arc<AppState>>,
    ids: Vec<i64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| reorder_notes(c, &ids)))
        .await
        .map_err(unfinished)?
}
