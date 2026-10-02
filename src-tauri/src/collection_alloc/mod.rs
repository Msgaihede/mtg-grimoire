//! **The desktop's half of `collection_alloc`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::collection_alloc::*;

/// The two commands, in a module of their own so the wire names and the function names can be
/// the same word.
///
/// `generate_handler!` takes the last segment of the path as the command name, so these
/// register as `collection_to_deck` and `deck_to_collection` — the names the webview invokes —
/// while [`super::collection_to_deck`] and [`super::deck_to_collection`] keep those names for
/// the crate. The alternative was the `add_entry`/`collection_add` split every other cabinet
/// uses, which would have meant two words for one write in a module that has only two.
pub mod commands {
    use super::{
        collection_to_deck as to_deck, deck_to_collection as to_collection, MoveOutcome, Pile,
    };
    use crate::sync::AppState;
    use std::sync::Arc;

    /// **[`crate::collection_source::with_write_owned`] and not bare `with_write`**: this moves
    /// a row between folders and can delete one by folding it, and the facet index's `owned`
    /// dimension is built by counting rows. Every deck command in the crate carries a comment
    /// saying this pair would be the exception.
    ///
    /// **`category_id` and `category_name` are alternatives and exactly one must arrive** —
    /// [`Pile::from_args`] is the whole of that rule and the only place it can be asked, because
    /// [`Pile`] cannot hold both. Two nullable wire fields rather than one tagged value so that
    /// a caller sending `categoryId` alone — every caller written before the name arm existed —
    /// is unchanged: an absent field deserialises to `None`.
    #[tauri::command]
    pub async fn collection_to_deck(
        state: tauri::State<'_, Arc<AppState>>,
        entry_id: i64,
        deck_id: i64,
        category_id: Option<i64>,
        category_name: Option<String>,
        quantity: i64,
    ) -> Result<MoveOutcome, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            // Before the lock is taken: a caller bug is not worth waiting on a busy database for.
            let pile = Pile::from_args(category_id, category_name.as_deref())?;
            crate::collection_source::with_write_owned(&state, |c| {
                to_deck(c, entry_id, deck_id, pile, quantity)
            })
        })
        .await
        .map_err(|e| format!("the cards could not be moved: {e}"))?
    }

    /// [`collection_to_deck`]'s wrapper, for [`collection_to_deck`]'s reason.
    #[tauri::command]
    pub async fn deck_to_collection(
        state: tauri::State<'_, Arc<AppState>>,
        deck_card_id: i64,
        quantity: i64,
    ) -> Result<MoveOutcome, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::collection_source::with_write_owned(&state, |c| {
                to_collection(c, deck_card_id, quantity)
            })
        })
        .await
        .map_err(|e| format!("the cards could not be moved: {e}"))?
    }
}
