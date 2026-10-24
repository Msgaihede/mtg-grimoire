//! **The desktop's half of `scansounds`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole; what is below names the
//! desktop's `AppState`: the two `#[tauri::command]` wrappers.

pub use grimoire_core::scansounds::*;

use crate::sync::AppState;
use std::sync::Arc;

/// Whether the scanner beeps, and the four prices its louder sounds start at. **Infallible by
/// signature**, `startview::start_view`'s contract: a row that cannot be read is the defaults.
///
/// `#[tauri::command(async)]` for `start_view`'s reason: a sync body runs on the IPC thread, and
/// this takes `db_read`'s mutex.
#[tauri::command(async)]
pub fn scan_sounds(state: tauri::State<'_, Arc<AppState>>) -> ScanSounds {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember the scan sounds. Refuses a ladder that does not climb ([`TIERS_MUST_CLIMB`]), and
/// answers [`crate::db::BUSY`] if a sync holds the write connection.
///
/// **Not the scanner's lease**: unlike `set_scanner_prefs`, this is written from Settings, which
/// holds no scanner, and nothing about a camera or a tray rides in it.
#[tauri::command]
pub async fn set_scan_sounds(
    state: tauri::State<'_, Arc<AppState>>,
    sounds: ScanSounds,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &sounds))
    })
    .await
    .map_err(|e| format!("the scan sounds could not be saved: {e}"))?
}
