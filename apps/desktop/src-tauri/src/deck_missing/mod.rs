//! **The desktop's half of `deck_missing`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deck_missing::*;

/// The two commands, in a module of their own so the wire names and the crate's names can each
/// read well — [`crate::deck_pull::commands`]' shape.
///
/// `generate_handler!` takes the **last segment** of the path as the command name, so these
/// register as `deck_missing_plan` and `deck_missing_to_collection` — the names `packages/ui/lib/ipc.ts`
/// invokes — while the crate says [`super::plan`] and [`super::to_collection`], which are module
/// plus verb and do not stutter. The pair reads as a set with `deck_missing_to_wishlist`, which
/// lives in [`crate::deck`] and is a different module's command about the same shortfall.
pub mod commands {
    use super::{
        plan as read_plan, to_collection as record, MissingOutcome, MissingPick, MissingRow,
    };
    use crate::sync::AppState;
    use std::sync::Arc;

    /// [`super::plan`]'s command. **Read-only** connection, and no marketplace: nothing in the
    /// answer is priced, which is why the plan takes none either.
    ///
    /// Cheap enough to re-ask after any write, and the editor does: this is the read that says
    /// whether the last press emptied the list.
    #[tauri::command]
    pub async fn deck_missing_plan(
        state: tauri::State<'_, Arc<AppState>>,
        deck_id: i64,
    ) -> Result<Vec<MissingRow>, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            read_plan(&crate::sync::lock_db_read(&state), deck_id)
        })
        .await
        .map_err(|e| format!("the plan could not be read: {e}"))?
    }

    /// **[`crate::collection_source::with_write_owned`] and not bare `with_write`**, and it owes
    /// that more plainly than any of the four writes before it: the facet index's `owned`
    /// dimension is built by counting `collection_entries` rows, the three movers can at most fold
    /// one away, [`crate::deck_quick_add`] makes one — and this makes several in a single press.
    #[tauri::command]
    pub async fn deck_missing_to_collection(
        state: tauri::State<'_, Arc<AppState>>,
        deck_id: i64,
        picks: Vec<MissingPick>,
        clear_wishes: bool,
    ) -> Result<MissingOutcome, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::collection_source::with_write_owned(&state, |c| {
                record(c, deck_id, &picks, clear_wishes)
            })
        })
        .await
        .map_err(|e| format!("the copies could not be recorded: {e}"))?
    }
}
