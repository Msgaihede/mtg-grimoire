//! **The desktop's half of `deck_quick_add`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deck_quick_add::*;

/// The two commands, in a module of their own so the wire names and the crate's names can each
/// read well — [`crate::deck_pull::commands`]' shape.
///
/// `generate_handler!` takes the **last segment** of the path as the command name, so these
/// register as `deck_quick_add_wishes` and `deck_quick_add_to_collection` — the names
/// `src/lib/ipc.ts` invokes — while the crate says [`super::wishes`] and [`super::quick_add`],
/// which are module plus verb and do not stutter.
pub mod commands {
    use super::{card_wishes as read_wishes, quick_add as add, QuickAddOutcome, QuickAddWish};
    use crate::sync::AppState;
    use std::sync::Arc;

    /// [`super::card_wishes`]' command — every wish for the card, any printing and any finish,
    /// since issue #511. **Read-only** connection, and no marketplace: nothing in the answer is
    /// priced.
    ///
    /// Fetched imperatively at the press rather than by a hook, so a right-click fires nothing —
    /// the menu is drawn from the deck row the reader clicked and this read happens only if they
    /// choose the second row.
    ///
    /// **There is deliberately no [`crate::deck::VIRTUAL_HOLDS_NOTHING`] fence here, and this is
    /// where a reader looks for the missing one.** Every other entry point in this crate that
    /// touches the collection or the wishlist on a deck's behalf refuses a virtual deck by name
    /// (issue #401); this one takes **no deck id at all**. It is a pure read of
    /// `wishlist_entries` for a printing and a finish — it names no deck, writes nothing, and
    /// could not ask the question without inventing a parameter for the sole purpose of refusing
    /// on it. What keeps it off a virtual deck is the caller: the menu row that leads here is not
    /// offered on one, and the write it leads *to*
    /// ([`deck_quick_add_to_collection`]) refuses on its own account. A fence added here would be
    /// a second answer to a question this command cannot be asked.
    #[tauri::command]
    pub async fn deck_quick_add_wishes(
        state: tauri::State<'_, Arc<AppState>>,
        card_id: String,
        finish: Option<String>,
    ) -> Result<Vec<QuickAddWish>, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            read_wishes(
                &crate::sync::lock_db_read(&state),
                &card_id,
                finish.as_deref(),
            )
        })
        .await
        .map_err(|e| format!("the wishlist could not be read: {e}"))?
    }

    /// **[`crate::collection_source::with_write_owned`] and not bare `with_write`**, and this is
    /// the write in the crate that owes it most: the facet index's `owned` dimension is built by
    /// counting `collection_entries` rows, and this is the only deck-boundary write that
    /// *creates* one. [`crate::collection_alloc::commands`] and [`crate::deck_pull::commands`]
    /// carry the same note about moving them.
    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn deck_quick_add_to_collection(
        state: tauri::State<'_, Arc<AppState>>,
        deck_id: i64,
        card_id: String,
        finish: Option<String>,
        condition: Option<String>,
        quantity: i64,
        wish_id: Option<i64>,
    ) -> Result<QuickAddOutcome, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::collection_source::with_write_owned(&state, |c| {
                add(
                    c,
                    deck_id,
                    &card_id,
                    finish.as_deref(),
                    condition.as_deref(),
                    quantity,
                    wish_id,
                )
            })
        })
        .await
        .map_err(|e| format!("the copies could not be recorded: {e}"))?
    }
}
