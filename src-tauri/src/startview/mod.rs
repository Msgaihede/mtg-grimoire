//! **The desktop's half of `startview`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::startview::*;

use crate::sync::AppState;
use std::sync::Arc;

/// Which view the app opens on.
///
/// **Infallible by signature**, which is [`crate::nav::nav_collapsed`]'s contract and for its
/// reason: the frontend reads this to seed a store that already has a default of its own, and
/// there is nothing the app shell could do with an error here that is not just "open on Home" —
/// so this answers that instead of making the caller spell it out.
///
/// `#[tauri::command(async)]` rather than a bare sync command: a sync body runs inline on the IPC
/// thread, and this one takes `db_read`'s mutex, which a search may hold for tens of milliseconds
/// — and this is called while the window is drawing its first frame. It is not an `async fn`
/// because Tauri requires a `Result` from one that borrows `State`, and a `Result` here would be a
/// failure mode this call does not have.
#[tauri::command(async)]
pub fn start_view(state: tauri::State<'_, Arc<AppState>>) -> String {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember which view the app opens on. Answers [`crate::db::BUSY`] if a sync holds the write
/// connection — the bound every write command in this crate takes.
///
/// **A refusal here is deliberately not surfaced**, which is a fact about the caller rather than
/// about this function: the setting decides what happens at the *next* launch, so a BUSY during a
/// first-run sync costs the reader nothing they can see now, and the row they are looking at
/// already shows the choice they made.
#[tauri::command]
pub async fn set_start_view(
    state: tauri::State<'_, Arc<AppState>>,
    view: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &view))
    })
    .await
    .map_err(|e| format!("the starting view could not be saved: {e}"))?
}
