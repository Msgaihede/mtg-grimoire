//! **The desktop's half of `entry_tags`** — the reader's own tags on one collection row or one
//! wish (user schema v67, issue #1398), a namespace apart from deck tags.
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole; what is below is the
//! three `#[tauri::command]` wrappers, each the table entry of the same name with Tauri's state
//! unpacked. The update hook marks `collection_entries` / `wishlist_entries` in
//! `AppState.changes` on its own — both are rowid tables written with a `WHERE` — so the other
//! windows refetch with nothing marked by hand.

pub use grimoire_core::entry_tags::*;

use crate::sync::{with_write, AppState};
use std::sync::Arc;

/// Every entry tag in use across the collection and the wishlist, by exact spelling — the
/// suggestions an entry-tag field offers. See
/// [`grimoire_core::entry_tags::entry_tags_in_use`].
#[tauri::command]
pub async fn entry_tags_in_use(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<EntryTagUse>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        grimoire_core::entry_tags::entry_tags_in_use(&crate::sync::lock_db_read(&state))
    })
    .await
    .map_err(|e| format!("the tags could not be read: {e}"))?
}

/// Replace one collection row's entry tags; answers the list as stored. Plain `with_write`: a
/// tag is no grain term and moves nothing the reader owns.
#[tauri::command]
pub async fn collection_set_tags(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    tags: Vec<String>,
) -> Result<Vec<String>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_collection_tags(c, id, &tags))
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

/// Replace one wish's entry tags; answers the list as stored.
#[tauri::command]
pub async fn wishlist_set_tags(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    tags: Vec<String>,
) -> Result<Vec<String>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_wish_tags(c, id, &tags))
    })
    .await
    .map_err(|e| format!("the wishlist could not be written: {e}"))?
}
