//! **The facet pass is `grimoire-core`'s, re-exported here beside its one command.**
//!
//! [`run_facets`] and [`compute`] are in `crates/grimoire-core/src/index/facets.rs`; a
//! `#[tauri::command]` names a window's state and a thread to run on, so the wrapper is here.

pub use grimoire_core::index::facets::*;

use crate::search::SearchRequest;
use crate::sync::AppState;
use std::sync::Arc;

/// Facet counts for one search.
///
/// A **separate command** from `search_cards` on purpose: facets depend on neither `sort` nor
/// `offset`, so they must not be recomputed per page, and they must never delay page one. The
/// frontend keys them on the filter half of the search key alone.
///
/// `async` + `spawn_blocking` for [`crate::search::search_cards`]' reason: a sync command body
/// runs inline on the IPC thread, and the FTS half of this is blocking SQLite work. It reads
/// through `db_read` like every other read, so a text facet during a sync is not stuck behind
/// the ingest.
#[tauri::command]
pub async fn facet_cards(
    state: tauri::State<'_, Arc<AppState>>,
    req: SearchRequest,
) -> Result<FacetResponse, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_facets(&state, &req))
        .await
        .map_err(|e| format!("facets could not be computed: {e}"))?
}
