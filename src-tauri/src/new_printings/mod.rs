//! **The desktop's half of `new_printings`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::new_printings::*;

use crate::sync::AppState;
use std::sync::Arc;

/// The New printings widget's read. **Read-only** connection, blocking pool — as every read in
/// this app is, so the home page never queues behind a sync.
///
/// **Every argument is the widget's `config` narrowed on the way out of TypeScript**, and every
/// one is narrowed again here: `days` into `1..=MAX_DAYS`, `limit` into
/// `0..=`[`NEW_PRINTINGS_READ`], an unknown `scope` into `all`, and `langs` to codes of the right
/// shape, capped at `MAX_LANGS`. A hand-edited row cannot ask for the whole corpus.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn new_printings(
    state: tauri::State<'_, Arc<AppState>>,
    scope: String,
    deck_ids: Vec<i64>,
    days: i64,
    langs: Vec<String>,
    include_virtual: bool,
    include_theory: bool,
    include_basics: bool,
    limit: Option<i64>,
) -> Result<NewPrintings, String> {
    let state = state.inner().clone();
    let ask = Ask {
        scope,
        deck_ids,
        days,
        langs,
        include_virtual,
        include_theory,
        include_basics,
        limit,
    };
    tauri::async_runtime::spawn_blocking(move || feed(&crate::sync::lock_db_read(&state), &ask))
        .await
        .map_err(|e| format!("the new printings could not be read: {e}"))?
}

/// Move the *seen* cursor to `at`, which is the caller's clock.
///
/// Answers [`crate::db::BUSY`] if a sync holds the write connection, like every write command
/// here. **The caller ignores a refusal**: a cursor that did not move costs a row of gold dots
/// the reader has already looked at, and a widget that raised an error over it would be worse.
#[tauri::command]
pub async fn mark_new_printings_seen(
    state: tauri::State<'_, Arc<AppState>>,
    at: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| mark_seen(conn, at))
    })
    .await
    .map_err(|e| format!("the new printings you have seen could not be recorded: {e}"))?
}
