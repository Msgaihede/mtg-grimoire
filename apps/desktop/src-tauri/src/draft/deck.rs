//! **The deck a drafted pool becomes** — `grimoire_core::draft_deck`'s commands: a virtual
//! Limited deck holding the pool, an unsaved draft deck (`decks.draft`) until the reader saves or
//! discards it, and the five basics the editor's draft bar adds. Every write goes through
//! `with_write`, as every other deck write does, so the other windows hear of it — and saving
//! needs the write connection anyway, since it announces the deck to the sync group.

use std::sync::Arc;

use grimoire_core::deck::DeckRow;
use grimoire_core::draft_deck::{self, BasicLand};

use crate::sync::{lock_db_read, with_write, AppState};

/// The pool as a virtual Limited deck named `name`, an unsaved draft deck. A repeated id is that
/// many copies. With `commander` — a Commander draft's pool — the deck is Casual and has an empty
/// Commander pile beside Deck and Pool.
#[tauri::command]
pub async fn draft_deck_create(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    card_ids: Vec<String>,
    commander: bool,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |conn| {
            draft_deck::create(conn, &name, &card_ids, commander)
        })
    })
    .await
    .map_err(|e| format!("The draft deck could not be made: {e}"))?
}

/// The unsaved draft decks, oldest first, as the rows `deck_list` leaves out.
#[tauri::command(async)]
pub fn draft_deck_list(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<DeckRow>, String> {
    draft_deck::list(&lock_db_read(state.inner()))
}

/// Save: the deck is a deck like any other — listed, and sent to the sync group whole.
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

/// Discard: the draft deck is deleted, never having left this device. Refused for a deck that is
/// not an unsaved draft deck.
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
