//! **The playtest board's commands**: one game of a deck against another, the opponent's seat
//! played by phase.rs's AI, on the same rules engine as the goldfish board (`crates/grimoire-play`).
//! This host's alone — `command_table`'s `DESKTOP_ONLY` says why, and
//! `docs/reference/playtest.md` has the design.
//!
//! **The goldfish's arrangement, for its reasons** (`goldfish/mod.rs`): one game at a time in a
//! slot of its own, taken out onto the engine's 16 MiB stack for each call and put back after, so
//! a second call while one runs is told so rather than waiting. A playtest call can be long — it
//! returns only once the AI has played everything up to the reader's next decision, a whole turn
//! of it at a time — and it runs on `spawn_blocking`, so the window stays responsive meanwhile.

use std::sync::{Arc, Mutex};

use grimoire_play::{
    on_engine_stack, CardFacts, Difficulty, Playtest, PlaytestAction, PlaytestStep, TokenFacts,
};

use crate::goldfish::{facts, token_facts};
use crate::sync::AppState;

/// The one game, or none. `Busy` while a call has it on the engine's stack.
#[derive(Default)]
pub struct PlaytestSlot(Mutex<Slot>);

#[derive(Default)]
enum Slot {
    #[default]
    Empty,
    Busy,
    Game(Box<Playtest>),
}

const NO_GAME: &str = "There is no game on the board. Start one from the Playtesting page.";
const BUSY: &str = "The opponent is still thinking.";

/// A new game: `deck_id` as it stands in `variant` (`live` or `theory`) for the reader, against
/// `opponent_deck_id` in `opponent_variant`, the opponent played at `difficulty`. `seed` is the
/// shuffle and the coin flip; a page sends a fresh one per game. Answers at the reader's first
/// decision, the opening hand. Each deck's tokens are drawn in the printings the reader set for
/// them (issue #991).
///
/// Flat parameters, as every command's, because Tauri maps each camelCase key to one; the two
/// states are Tauri's, the six the page's.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn playtest_start(
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, PlaytestSlot>,
    deck_id: i64,
    variant: String,
    opponent_deck_id: i64,
    opponent_variant: String,
    difficulty: Difficulty,
    seed: u64,
) -> Result<PlaytestStep, String> {
    let app = state.inner().clone();
    let (yours, theirs, your_tokens, their_tokens) =
        tauri::async_runtime::spawn_blocking(move || {
            let conn = crate::sync::lock_db_read(&app);
            let yours = grimoire_core::play::deck_cards(&conn, deck_id, &variant)?;
            let theirs =
                grimoire_core::play::deck_cards(&conn, opponent_deck_id, &opponent_variant)?;
            let your_tokens = grimoire_core::play::deck_tokens(&conn, deck_id, &variant)?;
            let their_tokens =
                grimoire_core::play::deck_tokens(&conn, opponent_deck_id, &opponent_variant)?;
            Ok::<_, String>((yours, theirs, your_tokens, their_tokens))
        })
        .await
        .map_err(|e| format!("the decks could not be read: {e}"))??;
    let yours: Vec<CardFacts> = yours.into_iter().map(facts).collect();
    let theirs: Vec<CardFacts> = theirs.into_iter().map(facts).collect();
    let your_tokens: Vec<TokenFacts> = your_tokens.into_iter().map(token_facts).collect();
    let their_tokens: Vec<TokenFacts> = their_tokens.into_iter().map(token_facts).collect();
    if yours.iter().all(|c| c.commander) {
        return Err("Your deck has no cards to play with yet.".into());
    }
    if theirs.iter().all(|c| c.commander) {
        return Err("The opponent's deck has no cards to play with yet.".into());
    }
    let (game, step) = tauri::async_runtime::spawn_blocking(move || {
        on_engine_stack(move || {
            Playtest::new(
                &yours,
                &your_tokens,
                &theirs,
                &their_tokens,
                seed,
                difficulty,
            )
        })
    })
    .await
    .map_err(|e| e.to_string())???;
    *slot.0.lock().map_err(|_| NO_GAME)? = Slot::Game(Box::new(game));
    Ok(step)
}

/// One action, and everything the opponent does after it until the reader next decides. A
/// refusal is one sentence and leaves the game as it was.
#[tauri::command]
pub async fn playtest_act(
    slot: tauri::State<'_, PlaytestSlot>,
    action: PlaytestAction,
) -> Result<PlaytestStep, String> {
    let mut game = {
        let mut held = slot.0.lock().map_err(|_| NO_GAME)?;
        match std::mem::replace(&mut *held, Slot::Busy) {
            Slot::Game(game) => game,
            Slot::Busy => return Err(BUSY.into()),
            Slot::Empty => {
                *held = Slot::Empty;
                return Err(NO_GAME.into());
            }
        }
    };
    let answer = tauri::async_runtime::spawn_blocking(move || {
        on_engine_stack(move || {
            let step = game.act(action);
            (game, step)
        })
    })
    .await
    .map_err(|e| e.to_string());
    let mut held = slot.0.lock().map_err(|_| NO_GAME)?;
    match answer {
        Ok(Ok((game, step))) => {
            *held = Slot::Game(game);
            step
        }
        // The engine (or the AI) panicked, and took the game with it: the board starts again.
        Ok(Err(e)) | Err(e) => {
            *held = Slot::Empty;
            Err(e)
        }
    }
}

/// Put the game away. Leaving the board calls it; a refusal here is never shown.
#[tauri::command]
pub fn playtest_end(slot: tauri::State<'_, PlaytestSlot>) {
    if let Ok(mut held) = slot.0.lock() {
        if !matches!(*held, Slot::Busy) {
            *held = Slot::Empty;
        }
    }
}
