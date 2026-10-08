//! **The mute list is `grimoire-core`'s, re-exported here beside its three commands.**
//!
//! `mute`, `unmute` and `list` are in `crates/grimoire-core/src/tags/muted.rs`.

pub use grimoire_core::tags::muted::*;

use crate::sync::AppState;
use std::sync::Arc;

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// Stop offering a tag anywhere.
///
/// A write, so it takes `AppState.db` through the one [`crate::sync::with_write`] and answers
/// [`crate::db::BUSY`] if a sync holds it — never `db_read`, which is the read connection and
/// cannot write.
#[tauri::command]
pub async fn tag_mute(
    state: tauri::State<'_, Arc<AppState>>,
    namespace: String,
    tag_id: String,
    slug: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    let marks = state.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| {
            mute(
                conn,
                &namespace,
                &tag_id,
                &slug,
                grimoire_core::platform::clock::now_secs(),
            )
        })
    })
    .await
    .map_err(|e| format!("the tag could not be muted: {e}"))?;
    // `muted_tags` is `WITHOUT ROWID`, which the update hook never sees — so the other windows
    // hear about a mute from here. See `crate::changes::MARKED_BY_COMMAND`.
    if out.is_ok() {
        marks.changes.mark_table("muted_tags");
    }
    out
}

/// Offer a tag again.
#[tauri::command]
pub async fn tag_unmute(
    state: tauri::State<'_, Arc<AppState>>,
    namespace: String,
    tag_id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    let marks = state.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| unmute(conn, &namespace, &tag_id))
    })
    .await
    .map_err(|e| format!("the tag could not be unmuted: {e}"))?;
    // `tag_mute`'s reason: the hook cannot see `muted_tags`, so the command is the mark.
    if out.is_ok() {
        marks.changes.mark_table("muted_tags");
    }
    out
}

/// Everything the reader has hidden, for the Settings list that gives it back.
#[tauri::command]
pub async fn tags_muted(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<MutedTag>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        list(&conn)
    })
    .await
    .map_err(|e| format!("could not read the muted tags: {e}"))?
}
