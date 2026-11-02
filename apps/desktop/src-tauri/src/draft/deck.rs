//! **The deck a drafted pool becomes** — `grimoire_core::draft_deck`'s commands: a virtual
//! Limited deck holding the pool, on the unsaved list until the reader saves or discards it, and
//! the five basics the editor's draft bar adds. Every write goes through `with_write`, as every
//! other deck write does, so the other windows and the mirror hear of it.

use std::sync::Arc;

use grimoire_core::deck::DeckRow;
use grimoire_core::draft_deck::{self, BasicLand, DraftDeckCard, DraftDeckRef};

use crate::sync::{lock_db_read, with_write, AppState};

/// The pool as a virtual Limited deck named `name`, on the unsaved list: `card_ids` (the
/// sideboard) in Pool and each of `deck` in the pile the page filed it into (issue #1471). A
/// repeated id is that many copies. With `commander` — a Commander draft's pool — the deck is Casual and has an empty
/// Commander pile beside Deck and Pool.
#[tauri::command]
pub async fn draft_deck_create(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    card_ids: Vec<String>,
    deck: Vec<DraftDeckCard>,
    commander: bool,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |conn| {
            draft_deck::create(conn, &name, &card_ids, &deck, commander)
        })
    })
    .await
    .map_err(|e| format!("The draft deck could not be made: {e}"))?
}

/// The draft decks not saved yet that still exist with the uid they were made with, oldest
/// first — each as its id and `sync_uid`, so the editor can hold the deck it has open to both.
#[tauri::command(async)]
pub fn draft_deck_ids(state: tauri::State<'_, Arc<AppState>>) -> Vec<DraftDeckRef> {
    draft_deck::ids(&lock_db_read(state.inner()))
}

/// Save: the deck leaves the unsaved list and is a deck like any other.
#[tauri::command]
pub async fn draft_deck_keep(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |conn| draft_deck::keep(conn, deck_id))
    })
    .await
    .map_err(|e| format!("The draft deck could not be saved: {e}"))?
}

/// Discard: the draft deck is deleted. Refused for a deck not on the unsaved list.
#[tauri::command]
pub async fn draft_deck_discard(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |conn| draft_deck::discard(conn, deck_id))
    })
    .await
    .map_err(|e| format!("The draft deck could not be discarded: {e}"))?
}

/// The five basics, in a printing of `set_codes` where the corpus has one.
#[tauri::command(async)]
pub fn draft_basic_lands(
    state: tauri::State<'_, Arc<AppState>>,
    set_codes: Vec<String>,
) -> Result<Vec<BasicLand>, String> {
    draft_deck::basic_lands(&lock_db_read(state.inner()), &set_codes)
}
