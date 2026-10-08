//! **The desktop's half of `wishlist_optimize`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::wishlist_optimize::*;

use crate::sync::{with_write, AppState};
use crate::wishlist::WishlistQuery;
use std::sync::Arc;

/// The preview. **Read-only** connection, blocking pool — `wishlist_list`'s shape, because it is
/// the same question asked about the same rows.
///
/// `include_managed` is the JS `includeManaged`, and **absent reads as `false`**, so a caller
/// written before issue #598 — the Wishlist page's Optimise button, which sends no such argument
/// — keeps the answer it always had. Only the home page's savings widget sends `true`.
#[tauri::command]
pub async fn wishlist_optimize_plan(
    state: tauri::State<'_, Arc<AppState>>,
    query: WishlistQuery,
    include_managed: Option<bool>,
) -> Result<WishlistOptimizePlan, String> {
    let state = state.inner().clone();
    let include_managed = include_managed.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        plan(&crate::sync::lock_db_read(&state), &query, include_managed)
    })
    .await
    .map_err(|e| format!("the wishlist could not be read: {e}"))?
}

/// The press. `wishlist_set_printing`'s shape — plain [`with_write`], because a wish is
/// something the reader does *not* have and nothing here changes what is owned.
#[tauri::command]
pub async fn wishlist_optimize_apply(
    state: tauri::State<'_, Arc<AppState>>,
    items: Vec<WishOptimizeApplyItem>,
) -> Result<WishlistOptimizeOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| apply(c, &items)))
        .await
        .map_err(|e| format!("the wishlist could not be written: {e}"))?
}
