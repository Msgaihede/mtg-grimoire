//! **The desktop's half of `marketplace`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.
//!
//! [`set_marketplace_now`] is here for good: it tells the plain-text mirror, which is the
//! desktop's.

pub use grimoire_core::marketplace::*;

use crate::sync::AppState;
use std::sync::Arc;

/// The selected marketplace, as a raw id.
///
/// **Infallible by signature**, which is the contract and not an accident: the frontend reads
/// this before it can draw a single price, and there is no sensible thing for a price surface
/// to do with an error here that is not just "assume the default" — so this does that instead
/// of making every caller do it.
///
/// `#[tauri::command(async)]` rather than a bare sync command: a sync body runs inline on the
/// IPC thread, and this one takes `db_read`'s mutex, which a search may hold for tens of
/// milliseconds. It is not an `async fn` because Tauri requires a `Result` from one that
/// borrows `State`, and a `Result` here would be a failure mode this call does not have.
#[tauri::command(async)]
pub fn get_marketplace(state: tauri::State<'_, Arc<AppState>>) -> String {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Choose a marketplace. Rejects an unknown id, and answers [`crate::db::BUSY`] if a
/// sync holds the write connection — the bound every write command in this crate takes.
#[tauri::command]
pub async fn set_marketplace(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || set_marketplace_now(&state, &id))
        .await
        .map_err(|e| format!("the marketplace could not be saved: {e}"))?
}

/// [`set_marketplace`]'s body, with the `AppState` handed in.
///
/// Split out so the mark below can be tested: a `#[tauri::command]` taking `tauri::State`
/// cannot be entered from a test, and one line that only matters to another subsystem is
/// exactly the kind that gets dropped and never noticed.
///
/// **Every price the plain-text mirror has written just changed meaning**, so the mirror is told
/// explicitly. It cannot learn this any other way: the setting is an `app_meta` row, and that
/// table maps to no surface on purpose — a sync writes it, and the update hook has to stay quiet
/// through 116 700 rows. A live pass found every mirrored CSV still carrying the previous
/// marketplace's prices until `Rebuild now` was pressed, which moved one row from 8.25 to 5.99.
///
/// Only on success, and only where [`store`] accepted the id: a refusal changed nothing on disk
/// and must not cost a full render. This is the shape
/// [`crate::mirror::settings::set_root_now`] already has.
pub fn set_marketplace_now(state: &AppState, id: &str) -> Result<(), String> {
    let saved = crate::sync::with_write(state, |conn| store(conn, id));
    if saved.is_ok() {
        state.mirror.mark_all();
    }
    saved
}
