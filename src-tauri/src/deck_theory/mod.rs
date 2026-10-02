//! **The desktop's half of `deck_theory`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deck_theory::*;

use crate::sync::{with_write, AppState};
use std::sync::Arc;

/// What a write here says when its worker thread died under it.
fn unfinished(e: tauri::Error) -> String {
    format!("the deck could not be written: {e}")
}

/// [`theory_slots`]'s command. **Read-only** connection, and no marketplace: nothing here is
/// priced.
#[tauri::command]
pub async fn deck_theory_slots(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<Vec<TheorySlot>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        theory_slots(&crate::sync::lock_db_read(&state), deck_id)
    })
    .await
    .map_err(|e| format!("the theory list could not be read: {e}"))?
}

/// What the plan wants and the deck does not have. **Read-only** connection.
#[tauri::command]
pub async fn deck_theory_diff(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    marketplace: Option<String>,
) -> Result<Vec<TheoryDiffRow>, String> {
    let state = state.inner().clone();
    let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        theory_diff(&crate::sync::lock_db_read(&state), deck_id, marketplace)
    })
    .await
    .map_err(|e| format!("the theory list could not be read: {e}"))?
}

/// The one click: everything the plan is short of, onto the wishlist — or, with `only`, the
/// rows the reader left ticked, as [`group_key`] strings. Absent means the whole difference.
///
/// **`folderId` is where they are filed, and absent is the wishlist's root** — the destination
/// every press had before the dialog could offer one, and the destination a caller that sends
/// nothing still gets. A folder that is not there is refused by name before a single wish is
/// written.
#[tauri::command]
pub async fn deck_theory_missing_to_wishlist(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    only: Option<Vec<String>>,
    folder_id: Option<i64>,
) -> Result<usize, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            missing_to_wishlist(c, deck_id, only.as_deref(), folder_id)
        })
    })
    .await
    .map_err(unfinished)?
}
