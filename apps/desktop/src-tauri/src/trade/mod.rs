//! **The desktop's half of `trade`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.
//!
//! Thirteen commands, and each wrapper is its table entry's twin in name, arguments and kind
//! (`grimoire_core::commands`, held to it by `command_table`): two reads on the read connection,
//! ten writes through [`with_write`], and the finish through
//! [`crate::collection_source::with_write_owned`].

pub use grimoire_core::trade::*;

use crate::sync::{with_write, AppState};
use std::sync::Arc;

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What a read here says when its worker thread died under it — never a reader's problem.
fn unread(e: tauri::Error) -> String {
    format!("the trade could not be read: {e}")
}

/// The same for a write. The write itself answers [`crate::db::BUSY`] when a sync holds the
/// connection.
fn unfinished(e: tauri::Error) -> String {
    format!("the trade could not be written: {e}")
}

/// Every trade, newest first. **Read-only** connection, blocking pool — as every read in this
/// app is.
#[tauri::command]
pub async fn trade_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<TradeSummary>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_trades(&crate::sync::lock_db_read(&state)))
        .await
        .map_err(unread)?
}

/// One trade with its lines, or `None` when it is gone.
#[tauri::command]
pub async fn trade_get(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<Option<Trade>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_trade(&crate::sync::lock_db_read(&state), id))
        .await
        .map_err(unread)?
}

#[tauri::command]
pub async fn trade_create(
    state: tauri::State<'_, Arc<AppState>>,
    trade: TradeCreate,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| create_trade(c, &trade)))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn trade_rename(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    name: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| rename_trade(c, id, &name)))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn trade_set_rate(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    side: String,
    rate: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_trade_rate(c, id, &side, rate))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn trade_add_lines(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    side: String,
    lines: Vec<TradeLineInput>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| add_trade_lines(c, id, &side, &lines))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn trade_update_line(
    state: tauri::State<'_, Arc<AppState>>,
    line_id: i64,
    change: TradeLineChange,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| update_trade_line(c, line_id, &change))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn trade_remove_line(
    state: tauri::State<'_, Arc<AppState>>,
    line_id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| remove_trade_line(c, line_id))
    })
    .await
    .map_err(unfinished)?
}

/// Run the chosen collection and wishlist steps and close the trade — see [`finish_trade`].
///
/// **`with_write_owned` and not plain `with_write`**, which is where it parts from the other
/// ten writes: two of the four steps take copies out of the collection and put copies into
/// it, and the facet index's `owned` dimension counts exactly those.
#[tauri::command]
pub async fn trade_finish(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    options: TradeFinishOptions,
) -> Result<TradeOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |c| finish_trade(c, id, &options))
    })
    .await
    .map_err(unfinished)?
}

/// Every line onto the other side. The percentages stay where they were.
#[tauri::command]
pub async fn trade_swap_sides(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| swap_trade_sides(c, id)))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn trade_archive(state: tauri::State<'_, Arc<AppState>>, id: i64) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| archive_trade(c, id)))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn trade_reopen(state: tauri::State<'_, Arc<AppState>>, id: i64) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| reopen_trade(c, id)))
        .await
        .map_err(unfinished)?
}

/// A new open trade with the same lines, percentages and marketplace. Answers its id.
#[tauri::command]
pub async fn trade_duplicate(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| duplicate_trade(c, id)))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn trade_delete(state: tauri::State<'_, Arc<AppState>>, id: i64) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| delete_trade(c, id)))
        .await
        .map_err(unfinished)?
}
