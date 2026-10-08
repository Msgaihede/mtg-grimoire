//! **The desktop's half of `price_history`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::price_history::*;

use crate::sorting::Marketplace;
use crate::sync::AppState;
use std::sync::Arc;

/// The Price movers widget's read. **Read-only** connection, blocking pool.
///
/// `marketplace` is taken as the enum, whose own `Deserialize` never fails — an id this build does
/// not know is TCGplayer, as on every list query — and as an `Option`, so a caller that sends none
/// gets the same default rather than a refusal.
#[tauri::command]
pub async fn price_movers(
    state: tauri::State<'_, Arc<AppState>>,
    window: String,
    direction: String,
    marketplace: Option<Marketplace>,
    limit: i64,
) -> Result<PriceMovers, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        movers(
            &crate::sync::lock_db_read(&state),
            &window,
            &direction,
            marketplace.unwrap_or_default(),
            limit,
        )
    })
    .await
    .map_err(|e| format!("price movers could not be read: {e}"))?
}

/// A mover's detail: one printing's kept history at one marketplace, and its live price.
/// **Read-only** connection, blocking pool, and the marketplace taken as [`price_movers`] takes
/// it — an absent or unknown id is TCGplayer, never a refusal.
#[tauri::command]
pub async fn price_history(
    state: tauri::State<'_, Arc<AppState>>,
    card_id: String,
    finish: String,
    marketplace: Option<Marketplace>,
) -> Result<PriceHistory, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        history(
            &crate::sync::lock_db_read(&state),
            &card_id,
            &finish,
            marketplace.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| format!("price history could not be read: {e}"))?
}
