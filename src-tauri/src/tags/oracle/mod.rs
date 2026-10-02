//! **Oracle Tags are `grimoire-core`'s, re-exported here beside their four commands.**
//!
//! The binding — the `Dataset`, the two reads a deck add is categorised by, the launch's
//! refresh — is in `crates/grimoire-core/src/tags/oracle.rs`.

pub use grimoire_core::tags::oracle::*;

use crate::sync::AppState;
use std::sync::Arc;

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// Download the Oracle Tags file if it has changed and rebuild the taxonomy from it.
///
/// `force` skips the weekly throttle, not the ETag check.
#[tauri::command]
pub async fn oracle_tags_refresh(
    state: tauri::State<'_, Arc<AppState>>,
    force: bool,
) -> Result<OracleTagStatus, String> {
    let state = state.inner().clone();
    super::refresh(&ORACLE, &state.core, force, &mut |phase, done, total| {
        super::emit(&ORACLE, &state, phase, done, total)
    })
    .await
}

/// Whether there is a taxonomy, which file it came from, and how old it is.
///
/// `async`, and answered on the blocking pool, because a sync command body runs inline on the
/// IPC thread and this takes `db_read`'s mutex.
#[tauri::command]
pub async fn oracle_tags_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<OracleTagStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || super::status_of(&ORACLE, &state))
        .await
        .map_err(|e| format!("could not read the oracle tag status: {e}"))
}

/// Every tag each of `oracle_ids` holds, inherited ones included — one entry per id, in the
/// order asked, empty for a card the taxonomy says nothing about.
///
/// Read through `db_read` like every other read, so a decklist import answers during a sync
/// rather than queueing behind the ingest.
#[tauri::command]
pub async fn oracle_tags_for_cards(
    state: tauri::State<'_, Arc<AppState>>,
    oracle_ids: Vec<String>,
) -> Result<Vec<CardTags>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        read_card_tags(&conn, &oracle_ids).map_err(|e| format!("could not read the tags: {e}"))
    })
    .await
    .map_err(|e| format!("could not read the tags: {e}"))?
}

/// The same answer as [`oracle_tags_for_cards`], asked with **printing** ids — one entry per
/// requested `cards.id`, in the order asked, empty for anything the taxonomy (or the corpus)
/// says nothing about.
///
/// This is the one most of the app wants: a quick add, every drag source and a resolved
/// decklist line all hold a printing id, and `CardSummary` carries no oracle id at all.
#[tauri::command]
pub async fn oracle_tags_for_printings(
    state: tauri::State<'_, Arc<AppState>>,
    card_ids: Vec<String>,
) -> Result<Vec<PrintingTags>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        read_printing_tags(&conn, &card_ids).map_err(|e| format!("could not read the tags: {e}"))
    })
    .await
    .map_err(|e| format!("could not read the tags: {e}"))?
}
