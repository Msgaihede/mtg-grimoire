//! **The desktop's half of `deck_meta`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deck_meta::*;

use crate::sync::{with_write, AppState};
use std::sync::Arc;

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What a write here says when its worker thread died under it — never a user's problem, the
/// write itself answers [`crate::db::BUSY`] when the database is busy.
fn unfinished(e: tauri::Error) -> String {
    format!("the deck's categories, labels or folders could not be written: {e}")
}

/// The category panel. **Read-only connection** — see [`list_categories`]'s doc: it backfills
/// nothing any more, so this never needs to contend for the write mutex.
#[tauri::command]
pub async fn deck_category_list(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    variant: String,
    marketplace: Option<String>,
) -> Result<Vec<DeckCategoryRow>, String> {
    let state = state.inner().clone();
    let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        list_categories(
            &crate::sync::lock_db_read(&state),
            deck_id,
            &variant,
            marketplace,
        )
    })
    .await
    .map_err(|e| format!("the deck's categories could not be read: {e}"))?
}

#[tauri::command]
pub async fn deck_category_create(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    variant: String,
    name: String,
) -> Result<DeckCategoryRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| create_category(c, deck_id, &variant, &name))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_category_rename(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    name: String,
) -> Result<DeckCategoryRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| rename_category(c, id, &name))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_category_set_active(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    is_active: bool,
) -> Result<DeckCategoryRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_category_active(c, id, is_active))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_category_reorder(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    ids: Vec<i64>,
) -> Result<Vec<DeckCategoryRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| reorder_categories(c, deck_id, &ids))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_category_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    move_to_category_id: Option<i64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // **Plain `with_write` even though the cascade arm writes `collection_entries`** —
        // `deck::deck_clear`'s note, and [`crate::deck::release_live_copies`] carries the
        // argument: the release re-files rows between folders, and the facet index's `owned`
        // dimension names no folder.
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| delete_category(c, id, move_to_category_id))
    })
    .await
    .map_err(unfinished)?
}

/// **Read-only** connection, like every list in this module.
#[tauri::command]
pub async fn deck_label_list(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    variant: String,
) -> Result<Vec<DeckLabelRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_labels(&crate::sync::lock_db_read(&state), deck_id, &variant)
    })
    .await
    .map_err(|e| format!("the deck's labels could not be read: {e}"))?
}

/// **`deck_id` is optional, and its absence is the Appearance panel.** A label is one app-wide row
/// and always was; the deck is what the *side effects* need — its `updated_at`, and the history
/// entry the editor's dialog draws. A call from Settings has no deck to name, so it makes the
/// label and writes no history. See the module tests for the trade.
///
/// **Tauri fills a missing `Option` argument with `None`**, so the deck editor's existing calls,
/// which send `deckId`, are unchanged.
#[tauri::command]
pub async fn deck_label_create(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: Option<i64>,
    name: String,
    color: String,
) -> Result<GlobalLabel, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| create_label(c, deck_id, &name, &color))
    })
    .await
    .map_err(unfinished)?
}

/// `deck_id` is where the reader was standing, not what is being changed — see
/// [`update_label`], which is app-wide. Optional, for [`deck_label_create`]'s reason: a rename
/// made from Settings names no deck and records nothing.
#[tauri::command]
pub async fn deck_label_update(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: Option<i64>,
    id: i64,
    name: String,
    color: String,
) -> Result<GlobalLabel, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| update_label(c, deck_id, id, &name, &color))
    })
    .await
    .map_err(unfinished)?
}

/// Deletes the label **everywhere**, and answers nothing. `deck_id` is where the reader was, and
/// is optional for [`deck_label_create`]'s reason — a deckless delete still un-labels every card,
/// and writes no history and no undo step.
#[tauri::command]
pub async fn deck_label_delete(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: Option<i64>,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| delete_label(c, deck_id, id))
    })
    .await
    .map_err(unfinished)?
}

/// Answers how many rows lost the label — see [`remove_label_from_deck`], which leaves the label
/// itself alone.
#[tauri::command]
pub async fn deck_label_remove_from_deck(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    label_id: i64,
    variant: String,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            remove_label_from_deck(c, deck_id, label_id, &variant)
        })
    })
    .await
    .map_err(unfinished)?
}

/// **Read-only**, and the one command in this module with no deck id at all — see
/// [`list_all_labels`]'s doc.
#[tauri::command]
pub async fn deck_label_all(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<GlobalLabel>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_all_labels(&crate::sync::lock_db_read(&state))
    })
    .await
    .map_err(|e| format!("the label list could not be read: {e}"))?
}

#[tauri::command]
pub async fn deck_card_set_label(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    category_id: i64,
    variant: String,
    finish: Option<String>,
    label_id: Option<i64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            set_card_label(
                c,
                deck_id,
                &card_id,
                category_id,
                &variant,
                finish.as_deref(),
                label_id,
            )
        })
    })
    .await
    .map_err(unfinished)?
}

/// **Read-only**, like every list in this module.
#[tauri::command]
pub async fn deck_folder_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<DeckFolderRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_folders(&crate::sync::lock_db_read(&state)))
        .await
        .map_err(|e| format!("the deck folders could not be read: {e}"))?
}

#[tauri::command]
pub async fn deck_folder_create(
    state: tauri::State<'_, Arc<AppState>>,
    parent_id: Option<i64>,
    name: String,
) -> Result<DeckFolderRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| create_folder(c, parent_id, &name))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_folder_rename(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    name: String,
) -> Result<DeckFolderRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| rename_folder(c, id, &name))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_folder_move(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    parent_id: Option<i64>,
) -> Result<DeckFolderRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| move_folder(c, id, parent_id))
    })
    .await
    .map_err(unfinished)?
}

/// The drag's own command — see [`reorder_folders`] for why re-parenting and positioning are one
/// write. It answers the **whole** folder list rather than the rows it moved, like
/// [`deck_category_reorder`]: every sibling's number changed, so a caller handed only the moved
/// rows would have to guess at the rest.
#[tauri::command]
pub async fn deck_folder_reorder(
    state: tauri::State<'_, Arc<AppState>>,
    parent_id: Option<i64>,
    ids: Vec<i64>,
) -> Result<Vec<DeckFolderRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| reorder_folders(c, parent_id, &ids))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_folder_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| delete_folder(c, id)))
        .await
        .map_err(unfinished)?
}
