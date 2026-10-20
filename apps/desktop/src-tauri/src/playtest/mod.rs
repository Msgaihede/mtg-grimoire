//! **The game board's commands**: one game of a deck against the goldfish — an opponent that does
//! nothing and never loses — or against one other deck or three, each opponent's seat played by
//! phase.rs's AI, on phase.rs's rules engine (`crates/grimoire-play`). Goldfishing and
//! playtesting are this one game; the deck editor's goldfish button and the Playtesting page both
//! start it here. This host's alone — `command_table`'s `DESKTOP_ONLY` says why, and
//! `docs/reference/playtest.md` has the design.
//!
//! **One game at a time, held here.** A game is a reader on one board, and the board is a view of
//! the one window: `playtest_start` replaces whatever game there was, `playtest_end` drops it.
//! What the game is lives in the engine's `GameState`, which is never sent whole — 385 KB of JSON
//! for a two-player Commander game at turn 3 (measured on the spike) — but as the view a board
//! draws, a few kilobytes.
//!
//! **Each game is named by the page** (`game`, a fresh number per deal), and every call names the
//! game it is for, so a board that has gone never touches the one that replaced it (issue #1141):
//! an old board's `playtest_end` leaves a newer game be, its late action is refused, and an action
//! that was on the engine when its game was ended or replaced drops the game it took rather than
//! putting it back.
//!
//! **Every call runs on the engine's own stack** (`grimoire_play::on_engine_stack`, 16 MiB), never
//! on the tokio worker a command arrives on: phase's recursion overflowed at 1 MiB, and an
//! overflow is an abort of the app. The game is taken out of its slot for the call and put back
//! after, so a second call while one runs finds the slot `Busy` and is told so rather than
//! waiting on the engine. A start or an end while it runs does not wait either: it takes the
//! slot, and the game the call took is dropped when it comes back. A call can be long — it
//! returns only once the AI has played everything up to the reader's next decision, a whole turn
//! of it at a time — and it runs on `spawn_blocking`, so the window stays responsive meanwhile.

use std::sync::{Arc, Mutex};

use grimoire_play::playtest::session::MAX_OPPONENTS;
use grimoire_play::{
    deck_support, on_engine_stack, CardFacts, DeckSupport, Difficulty, FaceFacts, OpponentDeck,
    Playtest, PlaytestAction, PlaytestStep, SupportCache, TokenFacts,
};

use crate::sync::AppState;

/// The one game, or none. `Busy` while a call has it on the engine's stack.
#[derive(Default)]
pub struct PlaytestSlot(Mutex<Slot<Playtest>>);

/// What the slot holds, each state but `Empty` with the page's name for its game. Generic over
/// the game so its moves are tested without dealing one.
#[derive(Default)]
enum Slot<G> {
    #[default]
    Empty,
    /// `playtest_start` is reading the decks and dealing this game.
    Dealing(u64),
    /// An action has this game on the engine's stack.
    Busy(u64),
    Game(u64, Box<G>),
}

impl<G> Slot<G> {
    fn game(&self) -> Option<u64> {
        match self {
            Self::Empty => None,
            Self::Dealing(game) | Self::Busy(game) | Self::Game(game, _) => Some(*game),
        }
    }

    /// A start claims the slot for `game` at once, before it deals: whatever was here is
    /// dropped, and an action still running on it will not put it back.
    fn claim(&mut self, game: u64) {
        *self = Self::Dealing(game);
    }

    /// `game` is dealt: it is the game on the board, unless an end or a newer start took the
    /// slot meanwhile — then it is dropped, and so told.
    fn dealt(&mut self, game: u64, dealt: G) -> Result<(), String> {
        if !matches!(self, Self::Dealing(g) if *g == game) {
            return Err(REPLACED.into());
        }
        *self = Self::Game(game, Box::new(dealt));
        Ok(())
    }

    /// Take `game` onto the engine's stack, leaving the slot `Busy` with its name.
    fn take(&mut self, game: u64) -> Result<Box<G>, String> {
        match std::mem::take(self) {
            Self::Game(g, held) if g == game => {
                *self = Self::Busy(game);
                Ok(held)
            }
            other => {
                let refusal = match other.game() {
                    None => NO_GAME,
                    Some(g) if g != game => REPLACED,
                    Some(_) => BUSY,
                };
                *self = other;
                Err(refusal.into())
            }
        }
    }

    /// The engine is done with `game`: back in the slot, unless it was ended or replaced while
    /// it was out, in which case it is dropped. `None` is a panic that took it with it.
    fn put_back(&mut self, game: u64, held: Option<Box<G>>) {
        if matches!(self, Self::Busy(g) if *g == game) {
            *self = held.map_or(Self::Empty, |held| Self::Game(game, held));
        }
    }

    /// Put `game` away, whatever it is doing; a newer game is not this call's to end.
    fn end(&mut self, game: u64) {
        if self.game() == Some(game) {
            *self = Self::Empty;
        }
    }
}

const NO_GAME: &str =
    "There is no game on the board. Start one from a deck or from the Playtesting page.";
const BUSY: &str = "The opponent is still thinking.";
const REPLACED: &str = "This game was put away: another one has been started since.";

/// One opponent's deck, as the page names it: a deck and its variant (`live` or `theory`).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestOpponent {
    pub deck_id: i64,
    pub variant: String,
}

/// A new game: `deck_id` as it stands in `variant` (`live` or `theory`) for the reader, against
/// each of `opponents` — one for a duel, three for a four-player game (issue #994) — each played
/// by the AI at `difficulty`; or, with **no opponents, against the goldfish** (the deck editor's
/// goldfish button, or the setup page's Goldfish table; `difficulty` is then unused). `seed` is
/// the shuffle and the coin flip; a page sends a fresh one per game. Answers at the reader's
/// first decision, the opening hand. Each deck's tokens are drawn in the printings the reader set
/// for them (issue #991). `game` is the page's name for it, which every later call carries: the
/// slot is this game's from the moment the call arrives, so the game it replaces is gone at once
/// and a deal an end or a newer start overtook is dropped, not put on the board.
///
/// Flat parameters, as every command's, because Tauri maps each camelCase key to one; the two
/// states are Tauri's, the six the page's.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn playtest_start(
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, PlaytestSlot>,
    game: u64,
    deck_id: i64,
    variant: String,
    opponents: Vec<PlaytestOpponent>,
    difficulty: Difficulty,
    seed: u64,
) -> Result<PlaytestStep, String> {
    slot.0.lock().map_err(|_| NO_GAME)?.claim(game);
    let dealt = deal(
        state.inner().clone(),
        deck_id,
        variant,
        opponents,
        difficulty,
        seed,
    )
    .await;
    let mut held = slot.0.lock().map_err(|_| NO_GAME)?;
    match dealt {
        Ok((dealt, step)) => held.dealt(game, dealt).map(|()| step),
        Err(e) => {
            held.end(game);
            Err(e)
        }
    }
}

/// Read every deck and deal `playtest_start`'s game, on the engine's stack.
async fn deal(
    app: Arc<AppState>,
    deck_id: i64,
    variant: String,
    opponents: Vec<PlaytestOpponent>,
    difficulty: Difficulty,
    seed: u64,
) -> Result<(Playtest, PlaytestStep), String> {
    if opponents.len() > MAX_OPPONENTS {
        return Err(format!(
            "A game has from one to {MAX_OPPONENTS} opponents, not {}.",
            opponents.len()
        ));
    }
    let (yours, your_tokens, theirs) = tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&app);
        let yours = grimoire_core::play::deck_cards(&conn, deck_id, &variant)?;
        let your_tokens = grimoire_core::play::deck_tokens(&conn, deck_id, &variant)?;
        let theirs = opponents
            .iter()
            .map(|o| {
                Ok::<_, String>((
                    grimoire_core::play::deck_cards(&conn, o.deck_id, &o.variant)?,
                    grimoire_core::play::deck_tokens(&conn, o.deck_id, &o.variant)?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok::<_, String>((yours, your_tokens, theirs))
    })
    .await
    .map_err(|e| format!("the decks could not be read: {e}"))??;
    let yours: Vec<CardFacts> = yours.into_iter().map(facts).collect();
    let your_tokens: Vec<TokenFacts> = your_tokens.into_iter().map(token_facts).collect();
    let duel = theirs.len() == 1;
    let theirs: Vec<OpponentDeck> = theirs
        .into_iter()
        .map(|(cards, tokens)| OpponentDeck {
            cards: cards.into_iter().map(facts).collect(),
            tokens: tokens.into_iter().map(token_facts).collect(),
        })
        .collect();
    if yours.iter().all(|c| c.commander) {
        return Err(if theirs.is_empty() {
            "This deck has no cards to play with yet.".into()
        } else {
            "Your deck has no cards to play with yet.".into()
        });
    }
    if let Some(n) = theirs
        .iter()
        .position(|o| o.cards.iter().all(|c| c.commander))
    {
        return Err(if duel {
            "The opponent's deck has no cards to play with yet.".into()
        } else {
            format!("Opponent {}'s deck has no cards to play with yet.", n + 1)
        });
    }
    tauri::async_runtime::spawn_blocking(move || {
        on_engine_stack(move || Playtest::new(&yours, &your_tokens, &theirs, seed, difficulty))
    })
    .await
    .map_err(|e| e.to_string())??
}

/// One action on `game`, and everything the opponents do after it until the reader next decides.
/// A refusal is one sentence and leaves the game as it was; an action on a game that has since
/// been replaced is refused.
#[tauri::command]
pub async fn playtest_act(
    slot: tauri::State<'_, PlaytestSlot>,
    game: u64,
    action: PlaytestAction,
) -> Result<PlaytestStep, String> {
    let mut held = slot.0.lock().map_err(|_| NO_GAME)?.take(game)?;
    let answer = tauri::async_runtime::spawn_blocking(move || {
        on_engine_stack(move || {
            let step = held.act(action);
            (held, step)
        })
    })
    .await
    .map_err(|e| e.to_string());
    let mut slot = slot.0.lock().map_err(|_| NO_GAME)?;
    match answer {
        Ok(Ok((held, step))) => {
            slot.put_back(game, Some(held));
            step
        }
        // The engine (or the AI) panicked, and took the game with it: the board starts again.
        Ok(Err(e)) | Err(e) => {
            slot.put_back(game, None);
            Err(e)
        }
    }
}

/// Put `game` away — at once, even while an action has it on the engine, whose answer then
/// drops it. Leaving the board calls it; a refusal here is never shown.
#[tauri::command]
pub fn playtest_end(slot: tauri::State<'_, PlaytestSlot>, game: u64) {
    if let Ok(mut held) = slot.0.lock() {
        held.end(game);
    }
}

/// The core's token as the engine crate takes it.
fn token_facts(token: grimoire_core::play::PlayToken) -> TokenFacts {
    TokenFacts {
        oracle_id: token.oracle_id,
        name: token.name,
        card_id: token.card_id,
        sources: token.sources,
    }
}

/// The core's row as the engine crate takes it. `faces` is Scryfall's `card_faces` verbatim, read
/// leniently: a blob that does not parse is a card of one face, which the engine still plays.
fn facts(card: grimoire_core::play::PlayCard) -> CardFacts {
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

/// What the engine has said of each card it was asked about, for the window's life
/// (`grimoire_play::support`): the setup screen asks about every deck, and decks share cards.
/// One question at a time holds it, so a burst of them parses each shared card once.
#[derive(Default)]
pub struct PlaytestSupport(Arc<Mutex<SupportCache>>);

/// What the rules engine plays of `deck_id` as it stands in `variant` (issue #1078): its
/// different cards, and those phase.rs's parser reads only in part, each with phase's labels for
/// what it leaves out. The Playtesting setup marks a deck and its cards by it before a game.
#[tauri::command]
pub async fn playtest_support(
    state: tauri::State<'_, Arc<AppState>>,
    support: tauri::State<'_, PlaytestSupport>,
    deck_id: i64,
    variant: String,
) -> Result<DeckSupport, String> {
    let app = state.inner().clone();
    let cards = tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&app);
        grimoire_core::play::deck_cards(&conn, deck_id, &variant)
    })
    .await
    .map_err(|e| format!("the deck could not be read: {e}"))??;
    let cards: Vec<CardFacts> = cards.into_iter().map(facts).collect();
    let known = support.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        on_engine_stack(move || {
            // A panic on an earlier question leaves answers that are still true.
            let mut known = known
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            deck_support(&cards, &mut known)
        })
    })
    .await
    .map_err(|e| e.to_string())??
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A slot holding `game`, a word standing in for the engine's game.
    fn holding(game: u64) -> Slot<&'static str> {
        let mut slot = Slot::default();
        slot.claim(game);
        slot.dealt(game, "dealt").unwrap();
        slot
    }

    fn held(slot: &Slot<&'static str>) -> Option<(u64, &'static str)> {
        match slot {
            Slot::Game(game, held) => Some((*game, **held)),
            _ => None,
        }
    }

    #[test]
    fn an_action_puts_its_game_back_and_names_a_second_call_busy() {
        let mut slot = holding(1);
        let taken = slot.take(1).unwrap();
        assert_eq!(slot.take(1).unwrap_err(), BUSY);
        slot.put_back(1, Some(taken));
        assert_eq!(held(&slot), Some((1, "dealt")));
    }

    /// Issue #1141: the old board's action finishes after a new board's deal.
    #[test]
    fn an_action_that_returns_after_a_newer_start_does_not_put_its_game_back() {
        let mut slot = holding(1);
        let taken = slot.take(1).unwrap();
        slot.claim(2);
        slot.dealt(2, "newer").unwrap();
        slot.put_back(1, Some(taken));
        assert_eq!(held(&slot), Some((2, "newer")));
    }

    #[test]
    fn an_action_that_returns_while_a_newer_game_is_dealt_leaves_the_deal_alone() {
        let mut slot = holding(1);
        let taken = slot.take(1).unwrap();
        slot.claim(2);
        slot.put_back(1, Some(taken));
        slot.dealt(2, "newer").unwrap();
        assert_eq!(held(&slot), Some((2, "newer")));
    }

    #[test]
    fn ending_a_game_while_an_action_has_it_drops_it_when_the_action_returns() {
        let mut slot = holding(1);
        let taken = slot.take(1).unwrap();
        slot.end(1);
        slot.put_back(1, Some(taken));
        assert!(matches!(slot, Slot::Empty));
    }

    #[test]
    fn an_old_board_neither_ends_nor_acts_on_the_game_that_replaced_its_own() {
        let mut slot = holding(1);
        slot.claim(2);
        slot.dealt(2, "newer").unwrap();
        slot.end(1);
        assert_eq!(slot.take(1).unwrap_err(), REPLACED);
        assert_eq!(held(&slot), Some((2, "newer")));
    }

    #[test]
    fn a_deal_overtaken_by_an_end_or_a_newer_start_is_dropped() {
        let mut slot = Slot::default();
        slot.claim(1);
        slot.end(1);
        assert_eq!(slot.dealt(1, "late").unwrap_err(), REPLACED);
        assert!(matches!(slot, Slot::Empty));

        slot.claim(1);
        slot.claim(2);
        slot.dealt(2, "newer").unwrap();
        assert_eq!(slot.dealt(1, "late").unwrap_err(), REPLACED);
        assert_eq!(held(&slot), Some((2, "newer")));
    }

    #[test]
    fn a_panic_empties_the_slot_only_if_its_game_is_still_there() {
        let mut slot = holding(1);
        slot.take(1).unwrap();
        slot.put_back(1, None);
        assert!(matches!(slot, Slot::Empty));
        assert_eq!(slot.take(1).unwrap_err(), NO_GAME);

        let mut slot = holding(1);
        slot.take(1).unwrap();
        slot.claim(2);
        slot.put_back(1, None);
        assert!(matches!(slot, Slot::Dealing(2)));
    }
}
