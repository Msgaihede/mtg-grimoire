//! **The desktop's half of `deck_notes`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deck_notes::*;

use crate::sync::{with_write, AppState};
use std::sync::Arc;

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What a write here says when its worker thread died under it — never a user's problem, the
/// write itself answers [`crate::db::BUSY`] when the database is busy.
fn unfinished(e: tauri::Error) -> String {
    format!("the deck's notes could not be written: {e}")
}

/// The Notes band's own read. **Read-only connection**, like every list in the deck domain.
///
/// **`generate_handler!` names a command after its last path segment**, so
/// `deck_notes::deck_notes` registers as `deck_notes` — the module and the read wear the same
/// name on purpose, exactly as `deck_tokens::deck_tokens` does, because the wire name is the one
/// `src/lib/ipc.ts` invokes and `deck_notes_list` would be a second thing to remember.
#[tauri::command]
pub async fn deck_notes(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<Vec<DeckNoteRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_notes(&crate::sync::lock_db_read(&state), deck_id)
    })
    .await
    .map_err(|e| format!("the deck's notes could not be read: {e}"))?
}

#[tauri::command]
pub async fn deck_note_create(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    title: String,
    body: String,
    oracle_ids: Vec<String>,
) -> Result<DeckNoteRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            create_note(c, deck_id, &title, &body, &oracle_ids)
        })
    })
    .await
    .map_err(unfinished)?
}

/// **Both fields are optional and an absent one means *leave it*.** Tauri fills a missing
/// `Option` argument with `None`, so a page editing only the body sends only the body.
#[tauri::command]
pub async fn deck_note_update(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    id: i64,
    title: Option<String>,
    body: Option<String>,
) -> Result<DeckNoteRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            update_note(c, deck_id, id, title.as_deref(), body.as_deref())
        })
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_note_delete(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| delete_note(c, deck_id, id))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_note_attach(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    note_id: i64,
    oracle_id: String,
) -> Result<DeckNoteRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| attach_card(c, deck_id, note_id, &oracle_id))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_note_detach(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    note_id: i64,
    oracle_id: String,
) -> Result<DeckNoteRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| detach_card(c, deck_id, note_id, &oracle_id))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_note_reorder(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    ids: Vec<i64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| reorder_notes(c, deck_id, &ids))
    })
    .await
    .map_err(unfinished)?
}

/// **Read-only**, and the one command in this module with no deck id at all — see
/// [`notes_for_card`].
#[tauri::command]
pub async fn card_notes(
    state: tauri::State<'_, Arc<AppState>>,
    oracle_id: String,
) -> Result<Vec<CardNoteRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        notes_for_card(&crate::sync::lock_db_read(&state), &oracle_id)
    })
    .await
    .map_err(|e| format!("this card's notes could not be read: {e}"))?
}
