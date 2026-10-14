//! **The desktop's half of `deck_pull`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deck_pull::*;

/// The three commands, in a module of their own so the wire names and the crate's names can each
/// read well — [`crate::collection_alloc::commands`]' shape.
///
/// `generate_handler!` takes the **last segment** of the path as the command name, so these
/// register as `deck_pull_plan` and `deck_pull_from_collection` — the names `packages/ui/lib/ipc.ts`
/// invokes — while the crate says [`super::plan`] and [`super::from_collection`], which are
/// module plus verb and do not stutter.
pub mod commands {
    use super::{
        elsewhere as read_elsewhere, from_collection as pull, plan as read_plan, ElsewhereRow,
        Pick, PullOutcome, PullRow,
    };
    use crate::sync::AppState;
    use std::sync::Arc;

    /// [`super::plan`]'s command. **Read-only** connection, and no marketplace: nothing in the
    /// answer is priced, which is why the plan takes none either.
    ///
    /// Cheap enough to re-ask after any write, and the dialog does: this is the read that says
    /// whether the last pull emptied the list.
    #[tauri::command]
    pub async fn deck_pull_plan(
        state: tauri::State<'_, Arc<AppState>>,
        deck_id: i64,
    ) -> Result<Vec<PullRow>, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            read_plan(&crate::sync::lock_db_read(&state), deck_id)
        })
        .await
        .map_err(|e| format!("the pull could not be planned: {e}"))?
    }

    /// [`super::elsewhere`]'s command — where the reader owns the cards this deck is short of,
    /// outside its own group, which colours the editor's missing figure (issue #986).
    /// **Read-only** connection, and no marketplace, for [`deck_pull_plan`]'s reason.
    #[tauri::command]
    pub async fn deck_owned_elsewhere(
        state: tauri::State<'_, Arc<AppState>>,
        deck_id: i64,
    ) -> Result<Vec<ElsewhereRow>, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            read_elsewhere(&crate::sync::lock_db_read(&state), deck_id)
        })
        .await
        .map_err(|e| format!("where else you own these cards could not be read: {e}"))?
    }

    /// **[`crate::collection_source::with_write_owned`] and not bare `with_write`**: this moves
    /// rows between folders and can delete one by folding it, and the facet index's `owned`
    /// dimension is built by counting rows. [`crate::collection_alloc::commands`] carries the
    /// same note, and this is the third write in the crate that owes it.
    #[tauri::command]
    pub async fn deck_pull_from_collection(
        state: tauri::State<'_, Arc<AppState>>,
        deck_id: i64,
        picks: Vec<Pick>,
    ) -> Result<PullOutcome, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::collection_source::with_write_owned(&state, |c| pull(c, deck_id, &picks))
        })
        .await
        .map_err(|e| format!("the cards could not be moved: {e}"))?
    }
}
