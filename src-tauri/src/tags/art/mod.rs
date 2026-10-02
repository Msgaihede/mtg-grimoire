//! **Art Tags are `grimoire-core`'s, re-exported here beside their two commands.**
//!
//! The binding — the `Dataset` and the launch's refresh — is in
//! `crates/grimoire-core/src/tags/art.rs`.

pub use grimoire_core::tags::art::*;

use crate::sync::AppState;
use std::sync::Arc;

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// Download the Art Tags file if it has changed and rebuild the taxonomy from it.
///
/// `force` skips the weekly throttle, not the ETag check.
#[tauri::command]
pub async fn art_tags_refresh(
    state: tauri::State<'_, Arc<AppState>>,
    force: bool,
) -> Result<ArtTagStatus, String> {
    let state = state.inner().clone();
    super::refresh(&ART, &state.core, force, &mut |phase, done, total| {
        super::emit(&ART, &state, phase, done, total)
    })
    .await
}

/// Whether there is an art taxonomy, which file it came from, and how old it is.
///
/// `async`, and answered on the blocking pool, because a sync command body runs inline on the
/// IPC thread and this takes `db_read`'s mutex.
#[tauri::command]
pub async fn art_tags_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ArtTagStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || super::status_of(&ART, &state))
        .await
        .map_err(|e| format!("could not read the art tag status: {e}"))
}
