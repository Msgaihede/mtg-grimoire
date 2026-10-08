//! **The desktop's half of `deck_todos`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deck_todos::*;

use crate::sync::{with_write, AppState};
use std::sync::Arc;

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What a write here says when its worker thread died under it — never a reader's problem. The
/// write itself answers [`crate::db::BUSY`] when a sync holds the connection.
fn unfinished(e: tauri::Error) -> String {
    format!("the to-do list could not be written: {e}")
}

/// One deck's lists.
///
/// **Fallible, where `sticky_notes`' read is infallible by signature, and deliberately.** The
/// dialog autosaves: a read that failed and answered `[]` would draw a band with no lists, and a
/// reader who pressed New to-do list would be writing beside lists they could no longer see. An
/// error lets the band draw a failure line and no cards at all.
///
/// `#[tauri::command(async)]` on a **sync** `fn`, `sticky_notes`' reason: a bare sync body runs
/// inline on the IPC thread, and this one takes [`crate::sync::lock_db_read`]'s mutex.
/// `generate_handler!` names a command after its last path segment, so this registers as
/// `deck_todo_lists` — the name #672's widget read wore, which is gone with the column it read.
#[tauri::command(async)]
pub fn deck_todo_lists(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<Vec<DeckTodoList>, String> {
    lists_for(&crate::sync::lock_db_read(state.inner()), deck_id)
}

/// Start a list at the end of the deck's — see [`create_list`].
#[tauri::command]
pub async fn deck_todo_list_create(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    title: String,
    body: String,
) -> Result<DeckTodoList, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| create_list(c, deck_id, &title, &body))
    })
    .await
    .map_err(unfinished)?
}

/// Write a list's title and body — see [`update_list`] for `expected` and the three refusals.
#[tauri::command]
pub async fn deck_todo_list_update(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    id: i64,
    title: Option<String>,
    body: Option<String>,
    expected: Option<String>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            update_list(
                c,
                deck_id,
                id,
                title.as_deref(),
                body.as_deref(),
                expected.as_deref(),
            )
        })
    })
    .await
    .map_err(unfinished)?
}

/// Delete a list — see [`delete_list`] for why a list already gone is a success.
#[tauri::command]
pub async fn deck_todo_list_delete(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| delete_list(c, deck_id, id))
    })
    .await
    .map_err(unfinished)?
}

/// Every deck's non-empty lists, for the home widget. Fallible for [`deck_todo_lists`]' reason:
/// the widget ticks through a compare-and-set against the body it read, and an empty answer from
/// a failed read would draw "No to-dos yet" over a reader who has some.
#[tauri::command(async)]
pub fn every_deck_todo_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<DeckTodoListEntry>, String> {
    every_list(&crate::sync::lock_db_read(state.inner()))
}
