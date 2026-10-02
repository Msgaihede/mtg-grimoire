//! **The desktop's half of `recent_cards`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::recent_cards::*;

use crate::sync::AppState;
use std::sync::Arc;

/// The cards this device opened most recently, newest first, at most `limit`.
///
/// **Infallible by signature**, [`crate::home::home_layout`]'s contract and for its reason, and
/// `#[tauri::command(async)]` for that command's reason too: it takes `db_read`'s mutex, which a
/// search may hold, while the home page is drawing.
#[tauri::command(async)]
pub fn recent_cards(state: tauri::State<'_, Arc<AppState>>, limit: u32) -> Vec<RecentCard> {
    recent(&crate::sync::lock_db_read(state.inner()), limit)
}

/// Remember that a card was opened. Answers [`crate::db::BUSY`] if a sync holds the write
/// connection — the bound every write command in this crate takes.
///
/// **The caller ignores a refusal**, [`crate::nav::set_nav_collapsed`]'s reading: a missed entry
/// costs one tile on the home page and nothing the reader is looking at now, and a card modal that
/// raised an error because a sync was running would be a far worse trade.
#[tauri::command]
pub async fn record_recent_card(
    state: tauri::State<'_, Arc<AppState>>,
    card_id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| record_now(conn, &card_id))
    })
    .await
    .map_err(|e| format!("the card you opened could not be remembered: {e}"))?
}
