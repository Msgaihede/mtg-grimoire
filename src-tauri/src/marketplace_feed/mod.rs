//! **The price feeds are `grimoire-core`'s, re-exported here beside their two commands.**
//!
//! Both providers, the parse, the store and the refresh are in
//! `crates/grimoire-core/src/marketplace_feed.rs` since the extraction's I/O step; a path
//! through this module reaches that crate's item unless this file defines it. What it defines
//! is the two `#[tauri::command]` wrappers.
//!
//! A refresh takes no window and names no mirror: it says what it is doing through the state's
//! event sink, and a finished one tells the state's observers the corpus moved — which is how
//! this app's plain-text mirror hears that every `Price` it wrote is a refresh old.

pub use grimoire_core::marketplace_feed::*;

use crate::sync::AppState;
use std::sync::Arc;

/// Download a marketplace's price feed and replace its prices with it.
///
/// Long-running by nature (63.7 MiB), so it reports itself through [`PROGRESS_EVENT`] for the
/// ribbon's activity line. A failure leaves the previous prices in place, and the reason is in
/// the error log.
#[tauri::command]
pub async fn marketplace_feed_refresh(
    state: tauri::State<'_, Arc<AppState>>,
    marketplace: String,
) -> Result<FeedStatus, String> {
    let state = state.inner().clone();
    refresh(&state.core, &marketplace, &mut |phase, done, total| {
        emit(&state, &marketplace, phase, done, total)
    })
    .await
}

/// Every feed-backed marketplace's state: never fetched, when it was fetched, what the feed
/// itself says it was built at, and how many rows came of it.
///
/// One entry per feed rather than one for the selected marketplace, so Settings can show both
/// without asking twice — and so a marketplace with no feed is simply absent from the answer
/// rather than reported as an empty one.
///
/// `async`, and answered on the blocking pool, because a sync command body runs inline on the
/// IPC thread and this takes `db_read`'s mutex.
#[tauri::command]
pub async fn marketplace_feed_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<FeedStatus>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        let now = grimoire_core::platform::clock::now_secs();
        PROVIDERS
            .iter()
            .map(|p| read_status(&conn, *p, now))
            .collect()
    })
    .await
    .map_err(|e| format!("could not read the price feed status: {e}"))
}
