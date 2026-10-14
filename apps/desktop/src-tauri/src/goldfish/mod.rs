//! **The goldfish board's commands**: one game of a deck against a target that does nothing, on
//! phase.rs's rules engine (`crates/grimoire-play`). This host's alone — `command_table`'s
//! `DESKTOP_ONLY` says why, and `docs/reference/goldfish.md` has the design.
//!
//! **One game at a time, held here.** A game is a reader on one board, and the board is a view of
//! the one window: `goldfish_start` replaces whatever game there was, `goldfish_end` drops it.
//! What the game is lives in the engine's `GameState`, which is never sent whole — 385 KB of JSON
//! for a two-player Commander game at turn 3 (measured on the spike) — but as the view a board
//! draws, a few kilobytes.
//!
//! **Every call runs on the engine's own stack** (`grimoire_play::on_engine_stack`, 16 MiB), never
//! on the tokio worker a command arrives on: phase's recursion overflowed at 1 MiB, and an
//! overflow is an abort of the app. The game is taken out of its slot for the call and put back
//! after, so a second call while one runs finds the slot empty and is told so rather than
//! waiting on the engine.

use std::sync::Mutex;

use grimoire_play::{
    on_engine_stack, CardFacts, FaceFacts, Goldfish, GoldfishAction, GoldfishStep, GoldfishView,
    TokenFacts,
};
use std::sync::Arc;

use crate::sync::AppState;

/// The one game, or none. `Busy` while a call has it on the engine's stack.
#[derive(Default)]
pub struct GoldfishSlot(Mutex<Slot>);

#[derive(Default)]
enum Slot {
    #[default]
    Empty,
    Busy,
    Game(Box<Goldfish>),
}

const NO_GAME: &str = "There is no game on the board. Start one from a deck.";
const BUSY: &str = "The rules engine is still working on the last action.";

/// A new game of the deck as it stands in `variant` (`live` or `theory`), with the opening hand
/// drawn, its tokens in the printings the reader set for them (issue #991). `seed` shuffles it; a
/// page sends a fresh one per game.
#[tauri::command]
pub async fn goldfish_start(
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, GoldfishSlot>,
    deck_id: i64,
    variant: String,
    seed: u64,
) -> Result<GoldfishView, String> {
    let app = state.inner().clone();
    let (cards, deck_tokens) = tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&app);
        let cards = grimoire_core::play::deck_cards(&conn, deck_id, &variant)?;
        let deck_tokens = grimoire_core::play::deck_tokens(&conn, deck_id, &variant)?;
        Ok::<_, String>((cards, deck_tokens))
    })
    .await
    .map_err(|e| format!("the deck could not be read: {e}"))??;
    let facts: Vec<CardFacts> = cards.into_iter().map(facts).collect();
    let deck_tokens: Vec<TokenFacts> = deck_tokens.into_iter().map(token_facts).collect();
    if facts.iter().all(|c| c.commander) {
        return Err("This deck has no cards to play with yet.".into());
    }
    let game = tauri::async_runtime::spawn_blocking(move || {
        on_engine_stack(move || {
            let game = Goldfish::new(&facts, &deck_tokens, seed)?;
            let view = game.view();
            Ok::<_, String>((game, view))
        })
    })
    .await
    .map_err(|e| e.to_string())???;
    let (game, view) = game;
    *slot.0.lock().map_err(|_| NO_GAME)? = Slot::Game(Box::new(game));
    Ok(view)
}

/// Do one thing on the board. A refusal is one sentence and leaves the game as it was.
#[tauri::command]
pub async fn goldfish_act(
    slot: tauri::State<'_, GoldfishSlot>,
    action: GoldfishAction,
) -> Result<GoldfishStep, String> {
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
        // The engine panicked, and took the game with it: the board starts again.
        Ok(Err(e)) | Err(e) => {
            *held = Slot::Empty;
            Err(e)
        }
    }
}

/// Put the game away. Leaving the board calls it; a game left behind costs memory and nothing
/// else, so a refusal here is never shown.
#[tauri::command]
pub fn goldfish_end(slot: tauri::State<'_, GoldfishSlot>) {
    if let Ok(mut held) = slot.0.lock() {
        if !matches!(*held, Slot::Busy) {
            *held = Slot::Empty;
        }
    }
}

/// The core's token as the engine crate takes it. The playtest board's are read through it too.
pub(crate) fn token_facts(token: grimoire_core::play::PlayToken) -> TokenFacts {
    TokenFacts {
        oracle_id: token.oracle_id,
        name: token.name,
        card_id: token.card_id,
        sources: token.sources,
    }
}

/// The core's row as the engine crate takes it. `faces` is Scryfall's `card_faces` verbatim, read
/// leniently: a blob that does not parse is a card of one face, which the engine still plays.
/// The playtest board's decks are read through it too (`playtest/mod.rs`).
pub(crate) fn facts(card: grimoire_core::play::PlayCard) -> CardFacts {
    let faces = card
        .faces
        .as_deref()
        .and_then(|f| serde_json::from_str::<Vec<serde_json::Value>>(f).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|f| {
            let text = |k: &str| f.get(k).and_then(|v| v.as_str()).map(str::to_string);
            FaceFacts {
                name: text("name").unwrap_or_default(),
                mana_cost: text("mana_cost"),
                type_line: text("type_line"),
                oracle_text: text("oracle_text"),
                power: text("power"),
                toughness: text("toughness"),
                loyalty: text("loyalty"),
                defense: text("defense"),
                colors: f
                    .get("colors")
                    .and_then(|c| serde_json::from_value(c.clone()).ok()),
            }
        })
        .collect();
    CardFacts {
        card_id: card.card_id,
        name: card.name,
        quantity: card.quantity,
        commander: card.commander,
        oracle_id: card.oracle_id,
        mana_cost: card.mana_cost,
        type_line: card.type_line,
        oracle_text: card.oracle_text,
        power: card.power,
        toughness: card.toughness,
        loyalty: card.loyalty,
        defense: card.defense,
        cmc: card.cmc,
        layout: card.layout,
        colors: card.colors,
        color_identity: card.color_identity,
        keywords: card.keywords,
        faces,
    }
}
