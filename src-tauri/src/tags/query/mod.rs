//! **The tag search is `grimoire-core`'s, re-exported here beside its three commands.**
//!
//! `run_tag_search`, `run_tag_children` and `run_tag_resolve` are in
//! `crates/grimoire-core/src/tags/query.rs`.

pub use grimoire_core::tags::query::*;

use crate::sync::AppState;
use std::sync::Arc;

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// Type-ahead over both tag taxonomies.
///
/// `async` and answered on the blocking pool, like every other read in this crate: a sync
/// command body runs inline on the IPC thread and this takes `db_read`'s mutex.
#[tauri::command]
pub async fn tag_search(
    state: tauri::State<'_, Arc<AppState>>,
    text: String,
    namespace: String,
    limit: u32,
) -> Result<Vec<TagHit>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        run_tag_search(&conn, &text, &namespace, limit)
    })
    .await
    .map_err(|e| format!("could not search the tags: {e}"))?
}

/// One level of the tag tree: the children of `slug`, or the roots when it is absent.
#[tauri::command]
pub async fn tag_children(
    state: tauri::State<'_, Arc<AppState>>,
    namespace: String,
    slug: Option<String>,
) -> Result<Vec<TagHit>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        run_tag_children(&conn, &namespace, slug.as_deref())
    })
    .await
    .map_err(|e| format!("could not read the tag tree: {e}"))?
}

/// Turn the tag names typed into a card-search box into the slugs the filters match on.
///
/// One answer per ask, in order, `null` where there is no such tag — see [`run_tag_resolve`]
/// for why the misses ride along rather than being dropped, and for why this is exact where
/// [`tag_search`] is a substring.
#[tauri::command]
pub async fn tag_resolve(
    state: tauri::State<'_, Arc<AppState>>,
    asks: Vec<TagLookup>,
) -> Result<Vec<Option<TagRef>>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        run_tag_resolve(&conn, &asks)
    })
    .await
    .map_err(|e| format!("could not resolve the tags: {e}"))?
}
