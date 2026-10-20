//! One game: the reader's deck against **the goldfish** — an opponent that does nothing and never
//! loses — or against another deck, or three in a four-player game (issue #994), each opponent's
//! seat played by phase.rs's AI (`phase-ai`) on the same `GameState` the engine plays.
//! Goldfishing and playtesting are this one game (the owner's decision of 2026-10-17): a goldfish
//! game is a playtest whose opponent takes no actions, with the sandbox on.
//!
//! **The rules decide, and the reader decides only what a player at a table would** — the owner's
//! choices of 2026-10-13. After every action the session plays on by itself (`advance`): the AI
//! takes each of its decisions, the goldfish answers each of its own by doing nothing
//! (`fish_answer`), and the reader's priority is passed for them, Arena-style, until the game next
//! needs the reader (`PlaytestStage`): the opening hand, their main phase with an empty stack,
//! their declare-attackers and declare-blockers steps, a question the engine asks them, and —
//! `stops_here`'s smart stops and toggles — a moment to respond: the opponent's spell on the stack
//! or combat after blocks when they could answer it, or a step they asked to stop at. Everything
//! else — most of the AI's turn, a spell resolving, combat damage — happens inside the one call,
//! and comes back as what happened and as replay frames (`PlaytestFrame`), the table after each
//! thing worth showing.
//!
//! **A prompt is the engine's question as its legal answers.** phase has well over a hundred kinds
//! of question, so no board draws each one: the view lists `legal_actions` with the facts in each
//! (`option_of`), and `auto` answers any of them with the AI's choice for the reader. A question
//! answered by a set of cards — a scry, a discard, a search — also carries a `pick` (`pick`): the
//! enumeration offers only a few of its answers. A question with one answer is not asked at all
//! (`sole_answer`): `advance` takes it, as the reader would have.
//!
//! **The sandbox is a setting** (`setSandbox`): a hand on the table, phase's debug actions — move a
//! card anywhere, tap, counters, tokens, draws, life totals — on the reader's own cards and on
//! every card the table shows (never an opponent's hand or library), and a play the rules refuse
//! made unpaid instead: cast without paying, or put down when even that is not legal (`unpaid`).
//! Taken in the reader's main phase only, where nothing is half-done. Off from the start against
//! the AI, on against the goldfish; the reader turns it on or off whenever they like.
//!
//! **The goldfish never loses, and neither does the reader**: in a goldfish game a command-zone
//! emblem with "you can't lose the game" (CR 104.3b, no `affected` — every player) is granted at
//! the start, so a life total at 0 is a number on the board and not the end of the game; the
//! goldfish's seat says on which of the reader's turns it would have died (`dead_on`). A second
//! emblem gives the goldfish no maximum hand size (CR 402.2), so it keeps every card it draws and
//! its turn puts nothing in its graveyard. Its library is `FISH_LIBRARY` lands that do nothing.
//!
//! **A refused action changes nothing**, and **a cast can be taken back until it is on the
//! stack**: `act` restores its checkpoint on any `Err`, and a `Play` or `Activate` keeps one
//! (`Pending`) for as long as the engine is asking the reader how to make it — `cancel` puts it
//! back. The moment priority is passed with the spell on the stack, it is cast.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use engine::ai_support::{has_meaningful_priority_action, legal_actions};
use engine::game::combat::AttackTarget;
use engine::game::coverage::card_face_gaps;
use engine::game::effects::create_emblem::grant_emblem;
use engine::game::engine::apply;
use engine::game::mana_sources::max_mana_yield;
use engine::game::turn_control::authorized_submitters;
use engine::game::{
    install_card_db, load_and_hydrate_decks, resolve_deck_list, start_game_with_starting_player,
    DeckList, PlayerDeckList,
};
use engine::types::ability::{KeywordAction, LibraryPosition, TargetRef};
use engine::types::actions::{DebugAction, DebugTokenRequest, GameAction, MulliganChoice};
use engine::types::events::{ActivatedAbilityKind, GameEvent};
use engine::types::format::FormatConfig;
use engine::types::game_state::{MulliganDecisionPhase, StackEntry, StackEntryKind, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::types::phase::Phase;
use engine::types::statics::{CastFreeOrigin, CastFrequency, StaticMode};
use engine::types::zones::Zone;
use engine::types::{
    parse_counter_type, ControllerRef, GameState, PlayerId, StaticDefinition, TargetFilter,
    TypedFilter,
};
use phase_ai::auto_play::{run_ai_actions, AiActionsStop};
use phase_ai::{create_config_for_players, AiConfig, AiDifficulty, AiSession, Platform};
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use serde_json::Value;

use crate::cards::{self, CardFacts};
use crate::history::{History, NOTHING_TO_REDO, NOTHING_TO_UNDO};
use crate::table::{game_card, is_permanent, mana_table, place_of};
use crate::tokens::{DeckTokens, TokenFacts};
use crate::view::{GameCard, MulliganView, Place, Seat, TokenOffer};

use super::view::{
    Difficulty, PlaytestAction, PlaytestAttack, PlaytestAttackPair, PlaytestAttacker,
    PlaytestBlock, PlaytestBlockPair, PlaytestBlocker, PlaytestCardRef, PlaytestCause,
    PlaytestCombat, PlaytestFrame, PlaytestHappened, PlaytestOption, PlaytestPhase, PlaytestPick,
    PlaytestPickPurpose, PlaytestPlayer, PlaytestPrompt, PlaytestSeat, PlaytestStackItem,
    PlaytestStage, PlaytestStep, PlaytestStop, PlaytestStopStep, PlaytestView,
};

/// The reader's seat. The opponents are `PlayerId(1)` on, in turn order.
const YOU: PlayerId = PlayerId(0);

/// The most opponents a game seats: a four-player Commander table.
pub const MAX_OPPONENTS: usize = 3;

/// The goldfish's library: a card that does nothing, enough of them that it never runs out in a
/// game anyone plays (it draws one a turn and never plays one). The emblem would keep it in the
/// game with an empty library too; a library is what a mill or a "target player draws" has to act
/// on.
const FISH_CARD: &str = "Goldfish Scale";
const FISH_LIBRARY: usize = 200;

/// One opponent's deck: its cards as they stand, and its tokens in the printings the reader set.
#[derive(Debug, Clone, Default)]
pub struct OpponentDeck {
    pub cards: Vec<CardFacts>,
    pub tokens: Vec<TokenFacts>,
}

/// How many times one action may pass the reader's priority (or declare no attackers for them)
/// before the session gives up on it. A whole turn cycle is a few dozen; the bound is what stops a
/// loop in the engine, the AI or here from hanging the board, and a game never reaches it.
const STEP_LIMIT: usize = 2000;

/// The most replay frames one action answers with, per opponent. A long AI turn is a few dozen
/// things to show, and one action may play every opponent's turn; past this the rest is the final
/// view, so a runaway loop of triggers cannot make a step huge.
const FRAME_LIMIT: usize = 80;

const NOT_IN_GAME: &str = "That card is no longer where it was. The board has been refreshed.";
const NOT_NOW: &str = "Keep or mulligan the opening hand first.";
const ALREADY_KEPT: &str = "The opening hand has already been kept.";
const OVER: &str = "The game is over. Start a new one from the game menu.";
const MAIN_ONLY: &str = "That can be done in your main phase, with nothing on the stack.";
const SANDBOX_OFF: &str =
    "That changes the game by hand. Turn the sandbox on in the game menu to do it.";
const HIDDEN: &str = "That card is in a zone you cannot see.";
const NO_PROMPT: &str = "The game is not asking you anything right now.";

/// The game as it was, to go back to: a refused action, or a cast the reader takes back.
#[derive(Clone)]
struct Checkpoint {
    state: GameState,
    printings: HashMap<ObjectId, Printing>,
    mulligans: u8,
    rng: ChaCha8Rng,
    out_told: HashSet<PlayerId>,
    /// The goldfish's `dead_on` (`PlaytestSeat::dead_on`).
    dead_on: Option<u32>,
    /// The sandbox's free cast's emblem (`Playtest::free`).
    free: Option<ObjectId>,
}

/// The printing an object is drawn by, with whose and what it was — so a printing can follow
/// its card into a new zone after the object it was on is gone. `name` is the card's
/// (`engine_name`), never a face's: the object may be on its back face.
#[derive(Debug, Clone)]
struct Printing {
    owner: PlayerId,
    name: String,
    card_id: String,
}

/// The reader's cards the rules offer more than a hand card's play for (`offers`): the hand
/// cards they can foretell, and the graveyard and exile cards they can cast or play.
#[derive(Default)]
struct Offers {
    foretell: HashSet<ObjectId>,
    cast: HashSet<ObjectId>,
}

/// A cast or an activation the engine is still asking the reader about, which `cancel` takes
/// back to `checkpoint`.
#[derive(Clone)]
struct Pending {
    checkpoint: Checkpoint,
    source: String,
}

/// The board's own question: a card that can be cast (or a permanent activated) in more than
/// one way. Nothing has happened yet; an answer is one of `actions`.
#[derive(Clone)]
struct BoardChoice {
    kind: &'static str,
    source: String,
    actions: Vec<GameAction>,
}

pub struct Playtest {
    state: GameState,
    printings: HashMap<ObjectId, Printing>,
    /// The printing a card is drawn by when its object has none of its own (a copy, a card the
    /// engine made): the deck's first printing of that name, per seat. Keyed, like `commanders`,
    /// by the card's name (`engine_name`); an object's name is read through `card_names` first.
    by_name: HashMap<(PlayerId, String), String>,
    commanders: HashSet<(PlayerId, String)>,
    /// Each face's name of a card of several faces → the card's name (`engine_name`), so an
    /// object on its back face (a Pathway played as its other land, a transformed commander) is
    /// still its card (issue #1144). Fixed for the game, so not in a `Moment`.
    card_names: HashMap<String, String>,
    /// What the engine does not play of each face in the game, by the face's name — phase's own
    /// `card_face_gaps`, as `support.rs` asks it before a game (issue #1093). Only the faces with
    /// a gap; fixed for the game, so not in a `Moment`.
    gaps: HashMap<String, Vec<String>>,
    mulligans: u8,
    tokens: Vec<TokenOffer>,
    /// Each seat's deck's tokens in the printings the reader set, which a token is drawn by.
    deck_tokens: HashMap<PlayerId, DeckTokens>,
    started: PlayerId,
    /// The opponents' seats, in turn order: `PlayerId(1)` on.
    opponents: Vec<PlayerId>,
    /// The goldfish's seat, in a game against it: it answers every question of its own by doing
    /// nothing (`fish_answer`), and `ai_seats` is empty.
    fish: Option<PlayerId>,
    /// The emblems that keep a goldfish game going; never shown, never counted as anyone's card.
    rules: Vec<ObjectId>,
    /// The emblem a sandbox cast is made without paying under (`cast_free`), while it is being
    /// made: gone when nothing is pending and the board asks nothing (`end_free`).
    free: Option<ObjectId>,
    /// The reader's hand may change the game (`setSandbox`).
    sandbox: bool,
    ai_seats: HashSet<PlayerId>,
    ai_configs: HashMap<PlayerId, AiConfig>,
    /// The config `auto` answers the reader's questions with.
    helper: AiConfig,
    /// phase-ai's per-game analysis of every deck, made the first time the AI decides.
    ai_session: Option<Arc<AiSession>>,
    /// The AI's dice, seeded from the game's seed: the same seed and decks play the same game.
    rng: ChaCha8Rng,
    pending: Option<Pending>,
    choice: Option<BoardChoice>,
    /// The game's end has been put in the log.
    over_told: bool,
    /// The players whose leaving the game has been put in the log (`Eliminated`).
    out_told: HashSet<PlayerId>,
    /// The reader's turn on which the goldfish's life first reached 0 or less, while it is still
    /// there (`PlaytestSeat::dead_on`).
    dead_on: Option<u32>,
    /// The steps the reader asked to stop at (`setStops`).
    stops: Vec<PlaytestStop>,
    /// The turn the reader is ending (`endTurn`): until it changes, nothing but a block or a
    /// question stops the game.
    ending: Option<u32>,
    /// The last step a stop of `stops` stopped at, so passing there does not stop there again.
    stopped_at: Option<(u32, Phase)>,
    /// The current action's replay frames, taken by `act`.
    frames: Vec<PlaytestFrame>,
    /// How many frames one action may answer with: `FRAME_LIMIT` an opponent.
    frame_limit: usize,
    /// The game before each of the reader's actions, for undo and redo (`crate::history`).
    history: History<Moment>,
}

/// The whole of a game an action can change, for undo and redo: the checkpoint a refusal goes
/// back to, and the session's own place in the game around it — a cast half made, the board's
/// own question, the end told, the turn being ended, the stop last stopped at. The stops the
/// reader set are a setting, not the game, and stay as they are.
struct Moment {
    checkpoint: Checkpoint,
    pending: Option<Pending>,
    choice: Option<BoardChoice>,
    over_told: bool,
    ending: Option<u32>,
    stopped_at: Option<(u32, Phase)>,
}

impl Playtest {
    /// A new game of `you` (the reader's deck as it stands) against each of `opponents` — one for
    /// a duel, up to three for a four-player game — each played by the AI at `difficulty`; or,
    /// with **no opponents, against the goldfish**, the reader on the play and the sandbox on
    /// (`difficulty` is then unused). `seed` is the shuffle, the coin flip for who plays first
    /// against the AI (the seed modulo the player count: 0 is the reader, so in a duel an even
    /// seed), and the AI's dice. `your_tokens` and each opponent's `tokens` are the deck's tokens
    /// in the printings the reader set, which a token is offered and drawn by. Answers with the
    /// game at the reader's opening hand.
    pub fn new(
        you: &[CardFacts],
        your_tokens: &[TokenFacts],
        opponents: &[OpponentDeck],
        seed: u64,
        difficulty: Difficulty,
    ) -> Result<(Self, PlaytestStep), String> {
        if opponents.len() > MAX_OPPONENTS {
            return Err(format!(
                "A game has from one to {MAX_OPPONENTS} opponents, not {}.",
                opponents.len()
            ));
        }
        let goldfish = opponents.is_empty();
        // The goldfish is one seat, with no deck of the reader's in it.
        let players = 1 + opponents.len().max(1);
        let all: Vec<CardFacts> = you
            .iter()
            .chain(opponents.iter().flat_map(|o| &o.cards))
            .cloned()
            .collect();
        let fish_card = goldfish.then(|| cards::synthetic(FISH_CARD, "Land", ""));
        let db = Arc::new(cards::database(&all, fish_card.as_slice())?);
        let gaps: HashMap<String, Vec<String>> = db
            .face_iter()
            .filter_map(|(_, face)| {
                let gaps = card_face_gaps(face);
                (!gaps.is_empty()).then(|| (face.name.clone(), gaps))
            })
            .collect();

        let mut by_name = HashMap::new();
        let mut commanders = HashSet::new();
        let mut card_names = HashMap::new();
        let mut piles = |deck: &[CardFacts], seat: PlayerId| {
            let mut main = Vec::new();
            let mut commander = Vec::new();
            for card in deck {
                let name = cards::engine_name(card);
                if db.get_face_by_name(&name).is_none() {
                    continue;
                }
                for face in cards::face_names(card) {
                    if face != name {
                        card_names.insert(face, name.clone());
                    }
                }
                by_name
                    .entry((seat, name.clone()))
                    .or_insert_with(|| card.card_id.clone());
                if card.commander {
                    commanders.insert((seat, name.clone()));
                    commander.extend(std::iter::repeat_n(name, card.quantity as usize));
                } else {
                    main.extend(std::iter::repeat_n(name, card.quantity as usize));
                }
            }
            (main, commander)
        };
        let (your_main, your_commander) = piles(you, YOU);
        if your_main.is_empty() {
            return Err("Your deck has no cards to shuffle into a library.".into());
        }
        let seats: Vec<PlayerId> = (1..players).map(|n| PlayerId(n as u8)).collect();
        let mut theirs = Vec::with_capacity(seats.len());
        if goldfish {
            theirs.push(PlayerDeckList {
                main_deck: vec![FISH_CARD.to_string(); FISH_LIBRARY],
                ..PlayerDeckList::default()
            });
        }
        for (deck, &seat) in opponents.iter().zip(&seats) {
            let (main, commander) = piles(&deck.cards, seat);
            if main.is_empty() {
                return Err(if opponents.len() == 1 {
                    "The opponent's deck has no cards to shuffle into a library.".into()
                } else {
                    format!(
                        "Opponent {}'s deck has no cards to shuffle into a library.",
                        seat.0
                    )
                });
            }
            theirs.push(PlayerDeckList {
                main_deck: main,
                commander,
                ..PlayerDeckList::default()
            });
        }

        // A commander on any side makes it a Commander game: 40 life, the command zone, tax.
        let format = if your_commander.is_empty() && theirs.iter().all(|d| d.commander.is_empty()) {
            FormatConfig::freeform()
        } else {
            FormatConfig::commander()
        };
        let mut state = GameState::new(format, players as u8, seed);
        // The sandbox is phase's debug actions, which the engine refuses unless the game allows
        // them and the player is on the list — the reader is, the AI is not. Whether the reader
        // may use them right now is the session's `sandbox`.
        state.debug_mode = true;
        state.debug_permitted.insert(YOU);

        // phase seats the first opponent as `opponent` and the rest as `ai_decks`, from
        // `PlayerId(2)` on.
        let mut theirs = theirs.into_iter();
        let list = DeckList {
            player: PlayerDeckList {
                main_deck: your_main,
                commander: your_commander,
                ..PlayerDeckList::default()
            },
            opponent: theirs.next().unwrap_or_default(),
            ai_decks: theirs.collect(),
            ..DeckList::default()
        };
        let payload = resolve_deck_list(&db, &list);
        load_and_hydrate_decks(&mut state, &payload, Some(&db));
        state.all_card_names = db.card_names().into();
        install_card_db(&mut state, Arc::clone(&db));

        let mut rules = Vec::new();
        if goldfish {
            let fish = seats[0];
            // CR 104.3b: no `affected`, so it reaches every player (`sba::static_affects_player`)
            // — the reader too, whose life at 0 is a number on the board as well.
            rules.push(grant_emblem(
                &mut state,
                fish,
                vec![StaticDefinition::new(StaticMode::CantLoseTheGame)],
                Vec::new(),
                Vec::new(),
            ));
            // CR 402.2, the goldfish's alone: it keeps every card it draws, so its turn discards
            // nothing and the log and its graveyard stay quiet.
            rules.push(grant_emblem(
                &mut state,
                fish,
                vec![
                    StaticDefinition::new(StaticMode::NoMaximumHandSize).affected(
                        TargetFilter::Typed(TypedFilter::default().controller(ControllerRef::You)),
                    ),
                ],
                Vec::new(),
                Vec::new(),
            ));
        }

        let deck_names: HashSet<&str> = by_name
            .keys()
            .filter(|(seat, _)| *seat == YOU)
            .map(|(_, n)| n.as_str())
            .collect();
        let deck_tokens: HashMap<PlayerId, DeckTokens> =
            std::iter::once((YOU, DeckTokens::new(your_tokens)))
                .chain(
                    opponents
                        .iter()
                        .zip(&seats)
                        .map(|(deck, &seat)| (seat, DeckTokens::new(&deck.tokens))),
                )
                .collect();
        let tokens = deck_tokens[&YOU].offers(&deck_names);

        let level = match difficulty {
            Difficulty::VeryEasy => AiDifficulty::VeryEasy,
            Difficulty::Easy => AiDifficulty::Easy,
            Difficulty::Medium => AiDifficulty::Medium,
            Difficulty::Hard => AiDifficulty::Hard,
            Difficulty::VeryHard => AiDifficulty::VeryHard,
        };
        // The goldfish never takes the first turn: a goldfish game counts the reader's turns.
        let started = if goldfish {
            YOU
        } else {
            PlayerId((seed % players as u64) as u8)
        };
        let mut game = Playtest {
            state,
            printings: HashMap::new(),
            by_name,
            commanders,
            card_names,
            gaps,
            mulligans: 0,
            tokens,
            deck_tokens,
            started,
            fish: goldfish.then(|| seats[0]),
            rules,
            sandbox: goldfish,
            ai_seats: seats.iter().copied().filter(|_| !goldfish).collect(),
            // phase scales its search down for a table of three or more (its "paranoid" cap).
            ai_configs: seats
                .iter()
                .filter(|_| !goldfish)
                .map(|&seat| {
                    (
                        seat,
                        create_config_for_players(level, Platform::Native, players as u8),
                    )
                })
                .collect(),
            helper: create_config_for_players(
                AiDifficulty::Medium,
                Platform::Native,
                players as u8,
            ),
            opponents: seats.clone(),
            ai_session: None,
            // Not the shuffle's own stream: the AI's choices must not shift when the engine
            // draws one more random number of its own.
            rng: ChaCha8Rng::seed_from_u64(seed ^ 0x5eed_a1a1_5eed_a1a1),
            pending: None,
            choice: None,
            free: None,
            over_told: false,
            out_told: HashSet::new(),
            dead_on: None,
            stops: Vec::new(),
            ending: None,
            stopped_at: None,
            frames: Vec::new(),
            frame_limit: FRAME_LIMIT * seats.len(),
            history: History::default(),
        };
        game.assign_printings(you, YOU);
        for (deck, &seat) in opponents.iter().zip(&seats) {
            game.assign_printings(&deck.cards, seat);
        }
        start_game_with_starting_player(&mut game.state, started);
        let mut happened = Vec::new();
        game.advance(&mut happened)?;
        let view = game.view();
        let frames = std::mem::take(&mut game.frames);
        Ok((
            game,
            PlaytestStep {
                view,
                happened,
                frames,
            },
        ))
    }

    /// Each of a seat's objects gets a printing: the deck's entries handed out by name, so a deck
    /// of two Forest arts shows both.
    fn assign_printings(&mut self, deck: &[CardFacts], seat: PlayerId) {
        let mut queue: HashMap<String, Vec<String>> = HashMap::new();
        for card in deck {
            queue
                .entry(cards::engine_name(card))
                .or_default()
                .extend(std::iter::repeat_n(
                    card.card_id.clone(),
                    card.quantity as usize,
                ));
        }
        let mut ids: Vec<ObjectId> = self
            .state
            .objects
            .iter()
            .filter(|(_, o)| o.owner == seat)
            .map(|(id, _)| *id)
            .collect();
        ids.sort();
        for id in ids {
            let name = card_name(&self.card_names, &self.state.objects[&id].name).to_string();
            if let Some(card_id) = queue.get_mut(&name).and_then(Vec::pop) {
                self.printings.insert(
                    id,
                    Printing {
                        owner: seat,
                        name,
                        card_id,
                    },
                );
            }
        }
    }

    /// After the engine has moved things: a printing whose object is gone goes to an object of
    /// the same seat and card that has none (CR 400.7 — a card that changed zones may be a new
    /// object), so a card keeps its art wherever it goes, on either face.
    fn follow_printings(&mut self) {
        let objects = &self.state.objects;
        let names = &self.card_names;
        let mut orphans: HashMap<(PlayerId, String), Vec<String>> = HashMap::new();
        self.printings.retain(|id, p| {
            let alive = objects
                .get(id)
                .is_some_and(|o| card_name(names, &o.name) == p.name);
            if !alive {
                orphans
                    .entry((p.owner, p.name.clone()))
                    .or_default()
                    .push(p.card_id.clone());
            }
            alive
        });
        if orphans.is_empty() {
            return;
        }
        let mut bare: Vec<ObjectId> = objects
            .iter()
            .filter(|(id, o)| !o.is_token && !self.printings.contains_key(*id))
            .map(|(id, _)| *id)
            .collect();
        bare.sort();
        for id in bare.into_iter().rev() {
            let o = &objects[&id];
            let name = card_name(names, &o.name).to_string();
            if let Some(card_id) = orphans.get_mut(&(o.owner, name.clone())).and_then(Vec::pop) {
                self.printings.insert(
                    id,
                    Printing {
                        owner: o.owner,
                        name,
                        card_id,
                    },
                );
            }
        }
    }

    // ── The view ──────────────────────────────────────────────────────────────────────────

    pub fn view(&self) -> PlaytestView {
        self.view_as(false)
    }

    /// The view; `watching`, a replay frame's: the stage is `Watching` and no question, attack or
    /// block is offered — the board only shows the moment, and whose question it was stays hidden.
    fn view_as(&self, watching: bool) -> PlaytestView {
        let s = &self.state;
        let stage = if watching {
            PlaytestStage::Watching
        } else {
            self.stage()
        };
        let combat = s.combat.as_ref().map(|c| {
            let mut blocks: Vec<PlaytestBlockPair> = c
                .blocker_to_attacker
                .iter()
                .flat_map(|(blocker, attackers)| {
                    attackers.iter().map(|attacker| PlaytestBlockPair {
                        blocker: blocker.0,
                        attacker: attacker.0,
                    })
                })
                .collect();
            blocks.sort_by_key(|b| (b.attacker, b.blocker));
            PlaytestCombat {
                attacks: c
                    .attackers
                    .iter()
                    .map(|a| PlaytestAttackPair {
                        attacker: a.object_id.0,
                        target: target_id(&a.attack_target),
                        player: match a.attack_target {
                            AttackTarget::Player(p) => Some(seat_of(p)),
                            _ => None,
                        },
                    })
                    .collect(),
                blocks,
            }
        });
        let attack = match &s.waiting_for {
            WaitingFor::DeclareAttackers {
                player,
                valid_attacker_ids,
                valid_attack_targets,
                valid_attack_targets_by_attacker,
                ..
            } if *player == YOU && !watching => {
                let mut named: Vec<u64> = Vec::new();
                let attackers = valid_attacker_ids
                    .iter()
                    .map(|id| {
                        // phase's per-attacker map is the authority; a state without it falls
                        // back to the step's aggregate list, as phase's own client does.
                        let targets = valid_attack_targets_by_attacker
                            .as_ref()
                            .map_or(valid_attack_targets.as_slice(), |m| {
                                m.get(id).map_or(&[][..], Vec::as_slice)
                            });
                        let ids: Vec<u64> = targets.iter().filter_map(target_id).collect();
                        named.extend(ids.iter().copied());
                        PlaytestAttacker {
                            id: id.0,
                            players: targets
                                .iter()
                                .filter_map(|t| match t {
                                    AttackTarget::Player(p) => Some(seat_of(*p)),
                                    _ => None,
                                })
                                .collect(),
                            targets: ids,
                        }
                    })
                    .collect();
                named.sort();
                named.dedup();
                Some(PlaytestAttack {
                    attackers,
                    targets: named
                        .into_iter()
                        .filter_map(|id| self.card_ref(ObjectId(id)))
                        .collect(),
                })
            }
            _ => None,
        };
        let block = match &s.waiting_for {
            WaitingFor::DeclareBlockers {
                player,
                valid_blocker_ids,
                valid_block_targets,
                ..
            } if *player == YOU && !watching => Some(PlaytestBlock {
                blockers: valid_blocker_ids
                    .iter()
                    .map(|id| {
                        let mut attackers: Vec<u64> = valid_block_targets
                            .get(id)
                            .map(|a| a.iter().map(|x| x.0).collect())
                            .unwrap_or_default();
                        attackers.sort();
                        PlaytestBlocker {
                            id: id.0,
                            attackers,
                        }
                    })
                    .collect(),
            }),
            _ => None,
        };
        let winner = match &s.waiting_for {
            WaitingFor::GameOver { winner } => winner.map(seat_of),
            _ => None,
        };
        PlaytestView {
            stage,
            // phase counts the game's first turn from the deal; the board's opening hands are
            // before any turn.
            turn: if stage == PlaytestStage::Mulligan {
                0
            } else {
                s.turn_number
            },
            active: seat_of(s.active_player),
            started: seat_of(self.started),
            phase: phase_of(s.phase),
            step: stop_step(s.phase),
            mulligan: self.mulligan(),
            you: self.seat(YOU, &self.offers(watching)),
            opponents: self
                .opponents
                .iter()
                .map(|&p| self.seat(p, &Offers::default()))
                .collect(),
            combat,
            attack,
            block,
            prompt: (stage == PlaytestStage::Prompt).then(|| self.prompt()),
            stack: s
                .stack
                .iter()
                .rev()
                .filter_map(|entry| {
                    let source = s
                        .objects
                        .get(&entry.id)
                        .or_else(|| s.objects.get(&entry.source_id))?;
                    let shown = if s.objects.contains_key(&entry.id) {
                        entry.id
                    } else {
                        entry.source_id
                    };
                    let (text, event) = match &entry.kind {
                        StackEntryKind::Spell { .. } => (None, None),
                        StackEntryKind::ActivatedAbility { ability, .. } => {
                            (ability.description.clone(), None)
                        }
                        StackEntryKind::TriggeredAbility {
                            ability,
                            description,
                            trigger_event,
                            ..
                        } => (
                            description.clone().or_else(|| ability.description.clone()),
                            trigger_event.as_ref(),
                        ),
                        _ => (None, None),
                    };
                    // A batch's first event is its cause, as phase's own stack tooltip reads it.
                    let event = s
                        .stack_trigger_event_batches
                        .get(&entry.id)
                        .and_then(|batch| batch.first())
                        .or(event);
                    let (targets, target_players) = stack_targets(s, entry);
                    Some(PlaytestStackItem {
                        id: entry.id.0,
                        name: source.name.clone(),
                        card_id: self.printing_of(shown),
                        seat: seat_of(entry.controller),
                        ability: !matches!(entry.kind, StackEntryKind::Spell { .. }),
                        text: text.filter(|t| !t.is_empty()),
                        cause: event.and_then(|e| self.cause(&serde_json::to_value(e).ok()?)),
                        targets,
                        target_players,
                    })
                })
                .collect(),
            winner,
            tokens: self.tokens.clone(),
            stops: self.stops.clone(),
            ending_turn: self.ending == Some(s.turn_number),
            sandbox: self.sandbox,
            goldfish: self.fish.is_some(),
            // A replay frame is a moment inside an action, never one to go back to.
            can_undo: !watching && self.history.can_undo(),
            can_redo: !watching && self.history.can_redo(),
        }
    }

    /// What the rules offer the reader beyond a hand card's play: foretelling a hand card, and
    /// casting a card from the graveyard or exile. Nothing in a replay frame, or while the reader
    /// does not have priority.
    fn offers(&self, watching: bool) -> Offers {
        let mut offers = Offers::default();
        if watching || !matches!(self.stage(), PlaytestStage::Main | PlaytestStage::Respond) {
            return offers;
        }
        for action in self.answers() {
            match action {
                GameAction::Foretell { object_id, .. } => {
                    offers.foretell.insert(object_id);
                }
                GameAction::CastSpell { object_id, .. }
                | GameAction::PlayLand { object_id, .. } => {
                    offers.cast.insert(object_id);
                }
                _ => {}
            }
        }
        offers
    }

    fn seat(&self, seat: PlayerId, offers: &Offers) -> PlaytestSeat {
        let s = &self.state;
        let player = &s.players[seat.0 as usize];
        let reader = seat == YOU;
        // An opponent's face-down exiled cards (a foretold card) are theirs alone to look at.
        let mine = |id: &&ObjectId| {
            s.objects
                .get(id)
                .is_some_and(|o| o.owner == seat && (reader || !o.face_down))
        };
        let cards = |ids: &mut dyn Iterator<Item = &ObjectId>| -> Vec<GameCard> {
            ids.filter_map(|id| self.card(*id))
                .map(|mut c| {
                    let id = ObjectId(c.id);
                    match s.objects.get(&id).map(|o| o.zone) {
                        Some(Zone::Hand) => c.can_foretell = offers.foretell.contains(&id),
                        Some(Zone::Graveyard | Zone::Exile) => {
                            c.castable = offers.cast.contains(&id);
                        }
                        _ => {}
                    }
                    c
                })
                .collect()
        };
        PlaytestSeat {
            player: seat_of(seat),
            out: player.is_eliminated,
            life: player.life,
            poison: player.poison_counters,
            hand: if reader {
                cards(&mut player.hand.iter())
            } else {
                Vec::new()
            },
            hand_count: player.hand.len() as u32,
            battlefield: cards(
                &mut s
                    .battlefield
                    .iter()
                    .filter(|id| s.objects.get(id).is_some_and(|o| o.controller == seat)),
            ),
            graveyard: cards(&mut player.graveyard.iter()),
            exile: cards(&mut s.exile.iter().filter(mine)),
            command: cards(&mut s.command_zone.iter().filter(|id| {
                s.objects
                    .get(id)
                    .is_some_and(|o| o.owner == seat && !o.is_emblem)
            })),
            library: player.library.len() as u32,
            // phase's library is a vector whose **front is the top** (`DrawCards` takes from it).
            library_cards: if reader {
                cards(&mut player.library.iter())
            } else {
                Vec::new()
            },
            mana_open: s
                .battlefield
                .iter()
                .map(|id| max_mana_yield(s, *id, seat))
                .sum(),
            mana: mana_table(s, seat),
            dead_on: if Some(seat) == self.fish {
                self.dead_on
            } else {
                None
            },
        }
    }

    fn card(&self, id: ObjectId) -> Option<GameCard> {
        let o = self.state.objects.get(&id)?;
        let is_commander = !o.is_token && self.is_commander(o.owner, &o.name);
        // A token is phase's preset, never a face of the deck's: its maker's gaps are the maker's.
        let gaps = if o.is_token {
            Vec::new()
        } else {
            self.gaps.get(&o.name).cloned().unwrap_or_default()
        };
        game_card(&self.state, id, self.printing_of(id), is_commander, gaps)
    }

    fn printing_of(&self, id: ObjectId) -> Option<String> {
        let o = self.state.objects.get(&id)?;
        self.printings
            .get(&id)
            .map(|p| p.card_id.clone())
            .or_else(|| {
                o.is_token
                    .then(|| self.deck_tokens.get(&o.owner))
                    .flatten()
                    .and_then(|t| t.printing_of(o.token_image_ref.as_ref(), &o.name))
            })
            .or_else(|| o.token_image_ref.as_ref().map(|r| r.scryfall_id.clone()))
            .or_else(|| {
                let name = card_name(&self.card_names, &o.name);
                self.by_name.get(&(o.owner, name.to_string())).cloned()
            })
    }

    /// Whether `name`, on any of its faces, is one of `owner`'s commanders.
    fn is_commander(&self, owner: PlayerId, name: &str) -> bool {
        let name = card_name(&self.card_names, name);
        self.commanders.contains(&(owner, name.to_string()))
    }

    fn card_ref(&self, id: ObjectId) -> Option<PlaytestCardRef> {
        let o = self.state.objects.get(&id)?;
        Some(PlaytestCardRef {
            id: id.0,
            name: o.name.clone(),
            card_id: self.printing_of(id),
            text: None,
            cause: None,
        })
    }

    /// Whether the reader may see a card: their own anywhere, anyone's in a public zone.
    fn visible(&self, id: ObjectId) -> bool {
        self.state.objects.get(&id).is_some_and(|o| {
            o.owner == YOU || o.controller == YOU || !matches!(o.zone, Zone::Hand | Zone::Library)
        })
    }

    /// What set a trigger off, read from the event that did — phase's `{ "type": …, "data": { …
    /// } }` on the wire — by the handful of field names its events name their subject with,
    /// rather than matched event by event (`option_of` reads an answer the same way). The card is
    /// the event's subject: the one that entered, was cast, was dealt damage, attacked. A card
    /// the reader may not see is left out, and one gone from the game is named as it was. The
    /// player is the card's controller, or the player the event names when it names no card.
    fn cause(&self, event: &Value) -> Option<PlaytestCause> {
        let kind = event.get("type")?.as_str()?.to_string();
        let data = event.get("data");
        let field = |key: &str| data.and_then(|d| d.get(key));
        let mut ids: Vec<ObjectId> = Vec::new();
        let mut players: Vec<PlaytestPlayer> = Vec::new();
        for key in [
            "object_id",
            "target",
            "attacker",
            "attacker_ids",
            "merged_id",
            "vehicle_id",
            "card_ids",
            "source_id",
        ] {
            if let Some(value) = field(key) {
                collect_refs(value, &mut ids, &mut players);
            }
            if !ids.is_empty() {
                break;
            }
        }
        // The card's controller when the event names a card; else the player the event names.
        let controller = ids
            .first()
            .and_then(|id| self.state.objects.get(id))
            .map(|o| seat_of(o.controller));
        let player = controller.or(players.first().copied()).or_else(|| {
            ["player_id", "controller", "player", "defending_player"]
                .iter()
                .find_map(|key| field(key)?.as_u64())
                .map(|p| seat_of(PlayerId(p as u8)))
        });
        let (id, name) = match ids.first() {
            Some(&id) if self.state.objects.contains_key(&id) => {
                if self.visible(id) {
                    (
                        Some(id.0),
                        self.state.objects.get(&id).map(|o| o.name.clone()),
                    )
                } else {
                    (None, None)
                }
            }
            // Gone from the game (a token that died): the event's own record of it.
            Some(&id) => {
                let name = field("record")
                    .and_then(|r| r.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                (name.is_some().then_some(id.0), name)
            }
            None => (None, None),
        };
        (id.is_some() || player.is_some()).then_some(PlaytestCause {
            event: kind,
            id,
            name,
            player,
        })
    }

    /// The causes of the triggers being put in order, in the question's order: each one's first
    /// event, from phase's own record of the group it asks about. Empty when the record and the
    /// question do not match one for one.
    fn trigger_causes(&self, abilities: &[PlaytestCardRef]) -> Vec<Option<PlaytestCause>> {
        let Some(group) = self
            .state
            .pending_trigger_order
            .as_ref()
            .and_then(|order| order.groups.iter().find(|g| !g.ordered))
        else {
            return Vec::new();
        };
        let matches = group.triggers.len() == abilities.len()
            && group
                .triggers
                .iter()
                .zip(abilities)
                .all(|(t, a)| t.pending.source_id.0 == a.id);
        if !matches {
            return Vec::new();
        }
        group
            .triggers
            .iter()
            .map(|t| {
                let event = t
                    .trigger_events
                    .first()
                    .or(t.pending.trigger_event.as_ref())?;
                self.cause(&serde_json::to_value(event).ok()?)
            })
            .collect()
    }

    /// The abilities the question is about, when it lists them: the triggers to put in order,
    /// the replacement effects to choose among. phase sends each as `{ source_id, source_name,
    /// description }`, read from the question's data by those fields — as `option_of` reads an
    /// answer — rather than matched kind by kind. An answer's `order` and a replacement's
    /// `index` count into this list.
    fn abilities(&self) -> Vec<PlaytestCardRef> {
        let json = serde_json::to_value(&self.state.waiting_for).unwrap_or(Value::Null);
        let Some(Value::Object(fields)) = json.get("data") else {
            return Vec::new();
        };
        let ability = |v: &Value| -> Option<PlaytestCardRef> {
            let id = ObjectId(v.get("source_id")?.as_u64()?);
            let text = v.get("description")?.as_str()?.to_string();
            let name = v.get("source_name")?.as_str()?.to_string();
            // The source as it lies when it still exists; its name and the words alone when not.
            let card = self.card_ref(id).unwrap_or(PlaytestCardRef {
                id: id.0,
                name,
                card_id: None,
                text: None,
                cause: None,
            });
            Some(PlaytestCardRef {
                text: Some(text),
                ..card
            })
        };
        let mut refs: Vec<PlaytestCardRef> = fields
            .values()
            .filter_map(Value::as_array)
            .find(|items| !items.is_empty() && items.iter().all(|v| ability(v).is_some()))
            .map(|items| items.iter().filter_map(ability).collect())
            .unwrap_or_default();
        // Triggers to put in order carry what set each off: one ability's two triggers differ
        // by that alone.
        let causes = self.trigger_causes(&refs);
        for (r, cause) in refs.iter_mut().zip(causes) {
            r.cause = cause;
        }
        refs
    }

    fn stage(&self) -> PlaytestStage {
        // Out of a game the others play on: the reader's game is over.
        if self.reader_out() {
            return PlaytestStage::Over;
        }
        if self.choice.is_some() {
            return PlaytestStage::Prompt;
        }
        match &self.state.waiting_for {
            WaitingFor::GameOver { .. } => PlaytestStage::Over,
            WaitingFor::MulliganDecision { .. } | WaitingFor::OpeningHandBottomCards { .. } => {
                PlaytestStage::Mulligan
            }
            WaitingFor::Priority { player } if *player == YOU => {
                if self.at_home() {
                    PlaytestStage::Main
                } else {
                    PlaytestStage::Respond
                }
            }
            WaitingFor::DeclareAttackers { player, .. } if *player == YOU => PlaytestStage::Attack,
            WaitingFor::DeclareBlockers { player, .. } if *player == YOU => PlaytestStage::Block,
            _ => PlaytestStage::Prompt,
        }
    }

    fn mulligan(&self) -> Option<MulliganView> {
        let WaitingFor::MulliganDecision {
            pending,
            free_first_mulligan,
            ..
        } = &self.state.waiting_for
        else {
            return None;
        };
        let entry = pending.iter().find(|e| e.player == YOU)?;
        let bottom = match entry.phase {
            MulliganDecisionPhase::BottomCards { count, .. } => count,
            MulliganDecisionPhase::Declare => {
                let owed = entry.mulligan_count;
                if *free_first_mulligan {
                    owed.saturating_sub(1)
                } else {
                    owed
                }
            }
        };
        Some(MulliganView {
            mulligans: entry.mulligan_count,
            bottom,
            free_first: *free_first_mulligan,
        })
    }

    fn prompt(&self) -> PlaytestPrompt {
        if let Some(choice) = &self.choice {
            return PlaytestPrompt {
                kind: choice.kind.into(),
                source: Some(choice.source.clone()),
                source_text: None,
                cause: None,
                options: choice
                    .actions
                    .iter()
                    .enumerate()
                    .map(|(i, a)| self.option_of(i, a, &[]))
                    .collect(),
                cancellable: true,
                pick: None,
                keyword: None,
            };
        }
        // The question's own data names its ability when it is about one — a trigger's targets —
        // by `source_id`, `description` and the trigger's events: read by those fields, as
        // `abilities` reads a list, rather than matched kind by kind. The top of the stack is the
        // fallback, and it is not always the trigger being asked about.
        let json = serde_json::to_value(&self.state.waiting_for).unwrap_or(Value::Null);
        let data = json.get("data");
        let field = |key: &str| data.and_then(|d| d.get(key));
        let named = field("source_id")
            .and_then(Value::as_u64)
            .map(ObjectId)
            .filter(|id| self.visible(*id))
            .and_then(|id| self.state.objects.get(&id))
            .map(|o| o.name.clone());
        let source_text = field("description")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_string);
        let cause = field("trigger_events")
            .and_then(Value::as_array)
            .and_then(|events| events.first())
            .or_else(|| field("trigger_event").filter(|e| !e.is_null()))
            .and_then(|e| self.cause(e));
        let source = self
            .pending
            .as_ref()
            .map(|p| p.source.clone())
            .or(named)
            .or_else(|| {
                let top = self.state.stack.last()?;
                let o = self
                    .state
                    .objects
                    .get(&top.id)
                    .or_else(|| self.state.objects.get(&top.source_id))?;
                Some(o.name.clone())
            });
        let abilities = self.abilities();
        PlaytestPrompt {
            kind: self.state.waiting_for.variant_name().into(),
            source,
            source_text,
            cause,
            options: self
                .answers()
                .iter()
                .enumerate()
                .map(|(i, a)| self.option_of(i, a, &abilities))
                .collect(),
            cancellable: self.pending.is_some(),
            pick: self.pick().map(|(pick, _)| pick),
            keyword: self.keyword(),
        }
    }

    /// The keyword the question is about, when its data names one — the alternative cost a
    /// cast is offered (`Overload`, `Evoke`, `Bestow`…; issue #1072). Read from the question's
    /// own fields, as `option_of` reads an answer's.
    fn keyword(&self) -> Option<String> {
        let json = serde_json::to_value(&self.state.waiting_for).ok()?;
        json.get("data")?.get("keyword").and_then(tag_of)
    }

    /// The question's answer as a set of cards, for the few kinds of question whose answers
    /// `legal_actions` cannot list (it offers none, all and each one alone — a scry of three has
    /// sixteen answers). Each kind's fields say which cards, how many and whether order counts;
    /// the answer is `SelectCards`, `SelectTargets` for `ChooseObjectsSelection`, or the kept
    /// set for a keep-and-sacrifice-the-rest (issue #1079). The second value says which.
    fn pick(&self) -> Option<(PlaytestPick, PickAnswer)> {
        let all = |ids: &[ObjectId]| ids.iter().map(|id| id.0).collect::<Vec<u64>>();
        let (purpose, shown, eligible, min, max, ordered, answer) = match &self.state.waiting_for {
            WaitingFor::ScryChoice { player, cards } if *player == YOU => (
                PlaytestPickPurpose::Scry,
                all(cards),
                all(cards),
                0,
                cards.len(),
                true,
                PickAnswer::Cards,
            ),
            WaitingFor::SurveilChoice { player, cards } if *player == YOU => (
                PlaytestPickPurpose::Surveil,
                all(cards),
                all(cards),
                0,
                cards.len(),
                true,
                PickAnswer::Cards,
            ),
            WaitingFor::DiscardChoice {
                player,
                count,
                cards,
                up_to,
                ..
            } if *player == YOU => (
                PlaytestPickPurpose::Discard,
                all(cards),
                all(cards),
                if *up_to { 0 } else { *count },
                *count,
                false,
                PickAnswer::Cards,
            ),
            WaitingFor::DiscardToHandSize {
                player,
                count,
                cards,
            } if *player == YOU => (
                PlaytestPickPurpose::Discard,
                all(cards),
                all(cards),
                *count,
                *count,
                false,
                PickAnswer::Cards,
            ),
            WaitingFor::SearchChoice {
                player,
                cards,
                count,
                up_to,
                allows_partial_find,
                ..
            } if *player == YOU => (
                PlaytestPickPurpose::Search,
                all(cards),
                all(cards),
                if *up_to || *allows_partial_find {
                    0
                } else {
                    (*count).min(cards.len())
                },
                *count,
                false,
                PickAnswer::Cards,
            ),
            WaitingFor::DigChoice {
                player,
                cards,
                keep_count,
                up_to,
                selectable_cards,
                ..
            } if *player == YOU => {
                let eligible = if selectable_cards.is_empty() {
                    all(cards)
                } else {
                    all(selectable_cards)
                };
                let most = (*keep_count).min(eligible.len());
                (
                    PlaytestPickPurpose::Dig,
                    all(cards),
                    eligible,
                    if *up_to { 0 } else { most },
                    most,
                    false,
                    PickAnswer::Cards,
                )
            }
            WaitingFor::ChooseFromZoneChoice {
                player,
                cards,
                count,
                up_to,
                ..
            } if *player == YOU => (
                PlaytestPickPurpose::Choose,
                all(cards),
                all(cards),
                if *up_to { 0 } else { (*count).min(cards.len()) },
                *count,
                false,
                PickAnswer::Cards,
            ),
            WaitingFor::RevealChoice {
                player,
                cards,
                optional,
                ..
            } if *player == YOU => (
                PlaytestPickPurpose::Reveal,
                all(cards),
                all(cards),
                usize::from(!*optional),
                1,
                false,
                PickAnswer::Cards,
            ),
            WaitingFor::MultiTargetSelection {
                player,
                legal_targets,
                min_targets,
                max_targets,
                ..
            } if *player == YOU => (
                PlaytestPickPurpose::Targets,
                all(legal_targets),
                all(legal_targets),
                *min_targets,
                *max_targets,
                false,
                PickAnswer::Cards,
            ),
            // Only while every eligible choice is a card: a player among them is a question the
            // generic options answer.
            WaitingFor::ChooseObjectsSelection {
                player,
                eligible,
                min,
                max,
                ..
            } if *player == YOU && eligible.iter().all(|t| matches!(t, TargetRef::Object(_))) => {
                let ids: Vec<u64> = eligible
                    .iter()
                    .filter_map(|t| match t {
                        TargetRef::Object(id) => Some(id.0),
                        TargetRef::Player(_) => None,
                    })
                    .collect();
                let most = max.map_or(ids.len(), |m| m as usize);
                (
                    PlaytestPickPurpose::Choose,
                    ids.clone(),
                    ids,
                    *min as usize,
                    most,
                    false,
                    PickAnswer::Targets,
                )
            }
            // Keep some creatures within a total power, sacrifice the rest (Slaughter the
            // Strong, Destined Confrontation — issue #1079). Any number may be kept; the cap is
            // `power_cap`, and the engine is asked only once keeping them all would pass it.
            WaitingFor::KeepWithinTotalPowerChoice {
                player, eligible, ..
            } if *player == YOU => (
                PlaytestPickPurpose::Keep,
                all(eligible),
                all(eligible),
                0,
                eligible.len(),
                false,
                PickAnswer::KeptCreatures,
            ),
            // Keep exactly so many permanents, sacrifice the rest. `required_count` is already
            // capped to what is eligible.
            WaitingFor::KeepExactPermanentsChoice {
                player,
                eligible,
                required_count,
                ..
            } if *player == YOU => (
                PlaytestPickPurpose::Keep,
                all(eligible),
                all(eligible),
                *required_count,
                *required_count,
                false,
                PickAnswer::KeptPermanents,
            ),
            _ => return None,
        };
        let power_cap = match &self.state.waiting_for {
            WaitingFor::KeepWithinTotalPowerChoice { cap, .. } => Some(*cap),
            _ => None,
        };
        Some((
            PlaytestPick {
                purpose,
                cards: shown
                    .iter()
                    .filter_map(|id| self.card_ref(ObjectId(*id)))
                    .collect(),
                eligible,
                min: min as u32,
                max: max as u32,
                ordered,
                power_cap,
            },
            answer,
        ))
    }

    /// The picked cards' power added up, each its current power (CR 208.3) as the engine counts
    /// a total-power keep.
    fn total_power(&self, ids: &[u64]) -> i32 {
        ids.iter()
            .filter_map(|id| self.state.objects.get(&ObjectId(*id)))
            .map(|o| o.power.unwrap_or(0))
            .sum()
    }

    /// The answers the engine accepts to the question it is asking the reader.
    fn answers(&self) -> Vec<GameAction> {
        legal_actions(&self.state)
    }

    /// The question's answer when it has only one, which `advance` takes without asking (issue
    /// #999): a target slot with one card left, a payment with nothing to choose, a sole mana
    /// source. phase itself fills in a cast whose targets have one combination. Taking a cast back
    /// (`CancelCast`, `BackToManaPayment`) is not an answer to it — the board's `cancel` is there
    /// for that. A pick has one answer when every eligible card must be picked, in no order that
    /// matters.
    fn sole_answer(&self) -> Option<GameAction> {
        if let Some((pick, answer)) = self.pick() {
            let all = pick.min == pick.max && pick.eligible.len() == pick.min as usize;
            return (all && (!pick.ordered || pick.min <= 1))
                .then(|| pick_answer(pick.eligible, answer));
        }
        let mut answers = self
            .answers()
            .into_iter()
            .filter(|a| !matches!(a, GameAction::CancelCast | GameAction::BackToManaPayment));
        let only = answers.next()?;
        answers.next().is_none().then_some(only)
    }

    /// One answer, by the facts in it. phase's actions are `{ "type": …, "data": { … } }` on the
    /// wire, and the data names its cards and players by a handful of field names across every
    /// kind of answer — read from there rather than matched variant by variant, so an answer of a
    /// kind this board has never seen still shows what it points at.
    ///
    /// `abilities` is the question's own list (`abilities`): an answer that counts into it —
    /// `order`, a permutation of it; `index`, one of it — names those abilities, each its source
    /// card with the ability's words, rather than bare numbers.
    fn option_of(
        &self,
        index: usize,
        action: &GameAction,
        abilities: &[PlaytestCardRef],
    ) -> PlaytestOption {
        let json = serde_json::to_value(action).unwrap_or(Value::Null);
        let kind = json
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("Answer")
            .to_string();
        let data = json.get("data").cloned().unwrap_or(Value::Null);
        let mut ids: Vec<ObjectId> = Vec::new();
        let mut players: Vec<PlaytestPlayer> = Vec::new();
        let mut number = None;
        let mut yes = None;
        let mut label = None;
        let mut named: Vec<PlaytestCardRef> = Vec::new();
        let ability = |v: &Value| v.as_u64().and_then(|i| abilities.get(i as usize)).cloned();
        if let Value::Object(fields) = &data {
            for (key, value) in fields {
                match key.as_str() {
                    // Cards, by id or list of ids.
                    "object_id" | "source_id" | "keep" | "target_id" | "equipment_id"
                    | "vehicle_id" | "cards" | "creature_ids" | "targets" | "target" | "kept" => {
                        collect_refs(value, &mut ids, &mut players);
                    }
                    "order" if !abilities.is_empty() => {
                        named = value
                            .as_array()
                            .map(|v| v.iter().filter_map(ability).collect())
                            .unwrap_or_default();
                    }
                    "index" if !abilities.is_empty() => named.extend(ability(value)),
                    "value" | "index" | "ability_index" => number = value.as_i64(),
                    "indices" => {
                        number = value
                            .as_array()
                            .and_then(|v| v.first())
                            .and_then(Value::as_i64)
                    }
                    "accept" | "pay" | "top" => yes = value.as_bool(),
                    // A word, or one of phase's tagged choices: `{ "type": "Alternative" }`.
                    "choice" => label = tag_of(value),
                    _ => {}
                }
            }
        }
        // `CastSpell` names its own card first; the targets after it are what the reader picks.
        if kind == "CastSpell" && ids.len() > 1 {
            ids.remove(0);
        }
        PlaytestOption {
            index: index as u32,
            kind,
            cards: ids
                .into_iter()
                .filter_map(|id| self.card_ref(id))
                .chain(named)
                .collect(),
            players,
            number,
            yes,
            label,
        }
    }

    // ── Actions ───────────────────────────────────────────────────────────────────────────

    /// Do what the board asked, play on until the reader next decides, and answer with the
    /// table then. A refusal is one sentence and leaves the game exactly as it was.
    ///
    /// Every action taken but `setStops` and `setSandbox` (settings) can be undone, and with it
    /// everything the AI did after it up to the reader's next decision: undo goes back to the
    /// reader's last decision, never into the middle of the opponent's turn. Undo and redo happen
    /// nothing and play nothing back — taken at any stage, a finished game's included.
    pub fn act(&mut self, action: PlaytestAction) -> Result<PlaytestStep, String> {
        match action {
            PlaytestAction::Undo => return self.travel(true),
            PlaytestAction::Redo => return self.travel(false),
            _ => {}
        }
        let remembered = !matches!(
            action,
            PlaytestAction::SetStops { .. } | PlaytestAction::SetSandbox { .. }
        );
        let before = remembered.then(|| self.moment());
        let checkpoint = self.checkpoint();
        let mut happened = Vec::new();
        let choice = self.choice.take();
        self.frames.clear();
        match self
            .run(action, choice, &mut happened)
            .and_then(|()| self.end_free())
        {
            Ok(()) => {
                if let Some(before) = before {
                    self.history.record(before);
                }
                self.follow_printings();
                self.mark_dead();
                Ok(PlaytestStep {
                    view: self.view(),
                    happened,
                    frames: std::mem::take(&mut self.frames),
                })
            }
            Err(e) => {
                self.frames.clear();
                self.restore(checkpoint);
                Err(e)
            }
        }
    }

    fn run(
        &mut self,
        action: PlaytestAction,
        choice: Option<BoardChoice>,
        out: &mut Vec<PlaytestHappened>,
    ) -> Result<(), String> {
        let stage = if choice.is_some() {
            PlaytestStage::Prompt
        } else {
            self.stage()
        };
        if let PlaytestAction::SetStops { stops } = action {
            // A setting, not a move: taken at any stage, and nothing plays on after it.
            self.choice = choice;
            let mut stops = stops;
            stops.sort_by_key(|s| (s.seat == Seat::Opponent, s.step as u8));
            stops.dedup();
            self.stops = stops;
            return Ok(());
        }
        if let PlaytestAction::SetSandbox { on } = action {
            // A setting too: the game is as it was, only what the reader's hand may do changes.
            self.choice = choice;
            self.sandbox = on;
            return Ok(());
        }
        if stage == PlaytestStage::Over {
            return Err(OVER.into());
        }
        if is_sandbox(&action) && !self.sandbox {
            self.choice = choice;
            return Err(SANDBOX_OFF.into());
        }
        match action {
            PlaytestAction::Mulligan => {
                if stage != PlaytestStage::Mulligan {
                    return Err(ALREADY_KEPT.into());
                }
                self.apply(
                    YOU,
                    GameAction::MulliganDecision {
                        choice: MulliganChoice::Mulligan,
                    },
                    out,
                )?;
                self.mulligans = self.mulligans.saturating_add(1);
                out.push(PlaytestHappened::Mulliganed {
                    mulligans: self.mulligans,
                });
                self.advance(out)
            }
            PlaytestAction::Keep { bottom } => {
                if stage != PlaytestStage::Mulligan {
                    return Err(ALREADY_KEPT.into());
                }
                let owed = self.mulligan().map_or(0, |m| m.bottom) as usize;
                if bottom.len() != owed {
                    return Err(format!(
                        "Pick {owed} card{} to put on the bottom first.",
                        if owed == 1 { "" } else { "s" }
                    ));
                }
                let hand: HashSet<u64> = self.player(YOU).hand.iter().map(|id| id.0).collect();
                if bottom.iter().any(|id| !hand.contains(id)) {
                    return Err(NOT_IN_GAME.into());
                }
                self.apply(
                    YOU,
                    GameAction::MulliganDecision {
                        choice: MulliganChoice::Keep,
                    },
                    out,
                )?;
                if owed > 0 {
                    let cards = bottom.iter().map(|id| ObjectId(*id)).collect();
                    self.apply(YOU, GameAction::SelectCards { cards }, out)?;
                }
                out.push(PlaytestHappened::Kept {
                    size: self.player(YOU).hand.len() as u32,
                    bottomed: owed as u32,
                });
                let kept_at = out.len();
                self.advance(out)?;
                // The first turn began inside `start_game`, before the hands were kept, and its
                // event went nowhere: it is told here, once the game is past the opening hands.
                let first =
                    |h: &PlaytestHappened| matches!(h, PlaytestHappened::TurnBegan { turn: 1, .. });
                if self.stage() != PlaytestStage::Mulligan && !out.iter().any(first) {
                    out.insert(
                        kept_at,
                        PlaytestHappened::TurnBegan {
                            turn: 1,
                            seat: seat_of(self.started),
                        },
                    );
                }
                Ok(())
            }
            _ if stage == PlaytestStage::Mulligan => Err(NOT_NOW.into()),

            PlaytestAction::Choose { index } => {
                if stage != PlaytestStage::Prompt {
                    return Err(NO_PROMPT.into());
                }
                let answers = match &choice {
                    Some(c) => c.actions.clone(),
                    None => self.answers(),
                };
                let answer = answers
                    .into_iter()
                    .nth(index as usize)
                    .ok_or("That answer is no longer on offer. The board has been refreshed.")?;
                if let Some(c) = choice {
                    self.begin(c.source);
                }
                self.apply(YOU, answer, out)?;
                self.advance(out)
            }
            PlaytestAction::Auto => {
                if stage != PlaytestStage::Prompt {
                    return Err(NO_PROMPT.into());
                }
                let (what, answer) = match choice {
                    // The board's own "which way": the first, as the engine lists them.
                    Some(c) => {
                        self.begin(c.source);
                        (c.kind.to_string(), c.actions.into_iter().next())
                    }
                    None => (
                        self.state.waiting_for.variant_name().to_string(),
                        phase_ai::choose_action(&self.state, YOU, &self.helper, &mut self.rng),
                    ),
                };
                let answer = answer.ok_or("The rules engine has no answer to offer here.")?;
                out.push(PlaytestHappened::Chose { what });
                self.apply(YOU, answer, out)?;
                self.advance(out)
            }
            PlaytestAction::PickCards { ids } => {
                if stage != PlaytestStage::Prompt || choice.is_some() {
                    return Err(NO_PROMPT.into());
                }
                let (pick, answer) = self
                    .pick()
                    .ok_or("This question is not answered with a set of cards.")?;
                let count = ids.len() as u32;
                if count < pick.min || count > pick.max {
                    return Err(if pick.min == pick.max {
                        format!(
                            "Pick {} card{}.",
                            pick.min,
                            if pick.min == 1 { "" } else { "s" }
                        )
                    } else {
                        format!("Pick from {} to {} cards.", pick.min, pick.max)
                    });
                }
                let mut seen = HashSet::new();
                if ids
                    .iter()
                    .any(|id| !pick.eligible.contains(id) || !seen.insert(*id))
                {
                    return Err(NOT_IN_GAME.into());
                }
                if let Some(cap) = pick.power_cap {
                    let total = self.total_power(&ids);
                    if total > cap {
                        return Err(format!(
                            "The kept creatures' total power is {total}; it may be at most {cap}."
                        ));
                    }
                }
                self.apply(YOU, pick_answer(ids, answer), out)?;
                self.advance(out)
            }
            PlaytestAction::Cancel => {
                if choice.is_some() {
                    return Ok(());
                }
                let pending = self
                    .pending
                    .take()
                    .ok_or("There is nothing to take back.")?;
                self.restore(pending.checkpoint);
                Ok(())
            }
            _ if stage == PlaytestStage::Prompt => {
                // The board's own question is put back: an action that is not an answer leaves
                // it open, as it was.
                self.choice = choice;
                Err("Answer the question first, or cancel it.".into())
            }

            PlaytestAction::Attack { attacks } => {
                let WaitingFor::DeclareAttackers {
                    valid_attacker_ids,
                    valid_attack_targets,
                    valid_attack_targets_by_attacker,
                    ..
                } = &self.state.waiting_for
                else {
                    return Err("It is not your declare-attackers step.".into());
                };
                let mut declared = Vec::with_capacity(attacks.len());
                for pair in attacks {
                    let attacker = ObjectId(pair.attacker);
                    if !valid_attacker_ids.contains(&attacker) {
                        return Err(NOT_IN_GAME.into());
                    }
                    let open = valid_attack_targets_by_attacker
                        .as_ref()
                        .map_or(valid_attack_targets.as_slice(), |m| {
                            m.get(&attacker).map_or(&[][..], Vec::as_slice)
                        });
                    let at = match (pair.target, pair.player) {
                        (None, Some(player)) => open
                            .iter()
                            .find(|t| matches!(t, AttackTarget::Player(p) if seat_of(*p) == player))
                            .copied()
                            .ok_or("That creature can't attack that player.")?,
                        (None, None) => open
                            .iter()
                            .find(|t| matches!(t, AttackTarget::Player(_)))
                            .copied()
                            .unwrap_or(AttackTarget::Player(self.opponents[0])),
                        (Some(id), _) => open
                            .iter()
                            .find(|t| target_id(t) == Some(id))
                            .copied()
                            .ok_or("That creature can't attack that.")?,
                    };
                    declared.push((attacker, at));
                }
                self.apply(
                    YOU,
                    GameAction::DeclareAttackers {
                        attacks: declared,
                        bands: Vec::new(),
                    },
                    out,
                )?;
                self.advance(out)
            }
            PlaytestAction::Block { blocks } => {
                if stage != PlaytestStage::Block {
                    return Err("You are not declaring blockers.".into());
                }
                let assignments = blocks
                    .into_iter()
                    .map(|b| (ObjectId(b.blocker), ObjectId(b.attacker)))
                    .collect();
                self.apply(YOU, GameAction::DeclareBlockers { assignments }, out)?;
                self.advance(out)
            }
            _ if !matches!(stage, PlaytestStage::Main | PlaytestStage::Respond) => {
                Err(match stage {
                    PlaytestStage::Attack => "Declare your attackers first.".to_string(),
                    PlaytestStage::Block => "Declare your blockers first.".to_string(),
                    _ => MAIN_ONLY.to_string(),
                })
            }

            // With priority: the main phase's, or a response's.
            PlaytestAction::Play { id } => self.play(ObjectId(id), out),
            PlaytestAction::Activate { id } => self.activate(ObjectId(id), out),
            PlaytestAction::Foretell { id } => self.foretell(ObjectId(id), out),
            PlaytestAction::Pass => {
                self.apply(YOU, GameAction::PassPriority, out)?;
                self.advance(out)
            }
            PlaytestAction::EndTurn => {
                self.ending = Some(self.state.turn_number);
                self.apply(YOU, GameAction::PassPriority, out)?;
                self.advance(out)
            }
            _ if stage == PlaytestStage::Respond => Err(MAIN_ONLY.into()),
            sandbox => {
                self.sandbox(sandbox, out)?;
                self.advance(out)
            }
        }
    }

    /// The rules first: the one way to play it, or a question about which way. When the rules
    /// offer none, the sandbox puts it down unpaid (`unpaid`), and without the sandbox it is a
    /// refusal that says why. A card elsewhere than the hand or the command zone is cast when the
    /// rules let it be cast from there (a foretold card in exile, a flashback card in the
    /// graveyard); else it is activated rather than played — or, in the sandbox, put onto the
    /// battlefield when it has nothing to activate and is not there already (a double-click on a
    /// graveyard's creature).
    fn play(&mut self, id: ObjectId, out: &mut Vec<PlaytestHappened>) -> Result<(), String> {
        let obj = self.own(id)?;
        let name = obj.name.clone();
        let zone = obj.zone;
        let by_hand = self.sandbox && self.stage() == PlaytestStage::Main;
        let ways = self.plays_of(id);
        if !matches!(zone, Zone::Hand | Zone::Command) {
            if !ways.is_empty() {
                return self.take_one(ways, "CastChoice", name, out, String::new);
            }
            if by_hand && zone != Zone::Battlefield && self.abilities_of(id).is_empty() {
                return self.put(id, Place::Battlefield, out);
            }
            return self.activate(id, out);
        }
        if ways.is_empty() && by_hand {
            return self.unpaid(id, out);
        }
        let sandbox = self.sandbox;
        self.take_one(ways, "CastChoice", name.clone(), out, || {
            let why = format!(
                "{name} can't be played right now: no land drop left, too little mana, or nothing \
                 it could target."
            );
            if sandbox {
                format!("{why} It can be put down by hand in your main phase.")
            } else {
                format!("{why} Turn the sandbox on to put it down by hand.")
            }
        })
    }

    /// A card the rules will not play, played unpaid — the goldfish's escape hatch, the
    /// sandbox's now. Cast without paying its mana cost first (`cast_free`), so it is a spell
    /// cast from where it was and what it does when cast or as it enters happens: "if you cast it
    /// from your hand" (Wakening Sun's Avatar, issue #1075) as much as any other. Only when even
    /// that is not legal (a land past the land drop, nothing to target) is it put where it would
    /// have gone: a permanent onto the battlefield, an instant or sorcery into the graveyard (it
    /// was "cast" and is done). The log says "not paid for" (`Put`).
    fn unpaid(&mut self, id: ObjectId, out: &mut Vec<PlaytestHappened>) -> Result<(), String> {
        if self.cast_free(id, out)? {
            return Ok(());
        }
        let obj = self.own(id)?;
        let from = place_of(obj.zone).ok_or(NOT_IN_GAME)?;
        let to = if is_permanent(obj) {
            Place::Battlefield
        } else {
            Place::Graveyard
        };
        if from == Place::Command && to == Place::Battlefield {
            // CR 903.8: the commander was cast, paid or not — the next cast costs {2} more.
            engine::game::commander::record_commander_cast(&mut self.state, id);
        }
        self.put(id, to, out)
    }

    /// CR 118.9: cast `id` without paying its mana cost, under an emblem of the reader's that lets
    /// them (phase's `CastFromHandFree`, Omniscience's). It touches nothing else: its permission is
    /// the reader's alone (phase reads it for its controller), its `affected` is this one object,
    /// and it is kept only while the cast is made (`free`, `end_free`). One way is cast, several
    /// are asked about, as a paid cast is. False, and the game as it was, when even a free cast
    /// offers no way.
    fn cast_free(&mut self, id: ObjectId, out: &mut Vec<PlaytestHappened>) -> Result<bool, String> {
        let before = self.checkpoint();
        self.free = Some(grant_emblem(
            &mut self.state,
            YOU,
            vec![StaticDefinition::new(StaticMode::CastFromHandFree {
                frequency: CastFrequency::Unlimited,
                origin: CastFreeOrigin::DefaultCastPermission,
            })
            .affected(TargetFilter::SpecificObject { id })],
            Vec::new(),
            Vec::new(),
        ));
        let ways = self.plays_of(id);
        if ways.is_empty() {
            self.restore(before);
            return Ok(false);
        }
        let name = self.own(id)?.name.clone();
        self.take_one(ways, "CastChoice", name, out, String::new)?;
        Ok(true)
    }

    /// The free cast's emblem goes once its cast is made or taken back: nothing is pending and
    /// the board asks nothing. Checked the moment the spell is on the stack (`advance`) and after
    /// every action, so nothing the spell or its triggers do is cast under it.
    fn end_free(&mut self) -> Result<(), String> {
        if self.pending.is_some() || self.choice.is_some() {
            return Ok(());
        }
        match self.free.take() {
            Some(emblem) => self.debug(DebugAction::RemoveObject { object_id: emblem }),
            None => Ok(()),
        }
    }

    /// Every legal play or cast of `id`, from wherever it is.
    fn plays_of(&self, id: ObjectId) -> Vec<GameAction> {
        self.answers()
            .into_iter()
            .filter(|a| match a {
                GameAction::PlayLand { object_id, .. }
                | GameAction::CastSpell { object_id, .. } => *object_id == id,
                _ => false,
            })
            .collect()
    }

    /// The rules only: foretell a hand card (CR 702.143a), paying {2} as phase pays a special
    /// action's cost, or a refusal that says why.
    fn foretell(&mut self, id: ObjectId, out: &mut Vec<PlaytestHappened>) -> Result<(), String> {
        let obj = self.own(id)?;
        let name = obj.name.clone();
        let zone = obj.zone;
        let ways: Vec<GameAction> = self
            .answers()
            .into_iter()
            .filter(|a| matches!(a, GameAction::Foretell { object_id, .. } if *object_id == id))
            .collect();
        let yours = self.state.active_player == YOU;
        self.take_one(ways, "CastChoice", name.clone(), out, || {
            if zone != Zone::Hand {
                format!("Only a card in your hand can be foretold, and {name} is not.")
            } else if !yours {
                format!("{name} can be foretold only during your own turn.")
            } else {
                format!("{name} can't be foretold right now: it has no foretell, or {{2}} can't be paid.")
            }
        })
    }

    /// The rules only: a permanent's one activated ability, a question about which, or a
    /// refusal.
    fn activate(&mut self, id: ObjectId, out: &mut Vec<PlaytestHappened>) -> Result<(), String> {
        let name = self.own(id)?.name.clone();
        let ways = self.abilities_of(id);
        self.take_one(ways, "AbilityChoice", name.clone(), out, || {
            format!("{name} has no ability you can activate right now.")
        })
    }

    /// Every legal action `id` is the source of, but a play or a cast of it: its abilities, equip,
    /// crew and the like (`names_source`).
    fn abilities_of(&self, id: ObjectId) -> Vec<GameAction> {
        self.answers()
            .into_iter()
            .filter(|a| {
                !matches!(
                    a,
                    GameAction::PassPriority
                        | GameAction::PlayLand { .. }
                        | GameAction::CastSpell { .. }
                        | GameAction::Foretell { .. }
                ) && names_source(a, id)
            })
            .collect()
    }

    /// One way: taken. Several: the board asks which. None: `refusal`.
    fn take_one(
        &mut self,
        mut ways: Vec<GameAction>,
        kind: &'static str,
        source: String,
        out: &mut Vec<PlaytestHappened>,
        refusal: impl FnOnce() -> String,
    ) -> Result<(), String> {
        match ways.len() {
            0 => Err(refusal()),
            1 => {
                self.begin(source);
                self.apply(YOU, ways.remove(0), out)?;
                self.advance(out)
            }
            _ => {
                self.choice = Some(BoardChoice {
                    kind,
                    source,
                    actions: ways,
                });
                Ok(())
            }
        }
    }

    /// The reader starts making a cast or an activation: what to go back to if they cancel it.
    fn begin(&mut self, source: String) {
        self.pending = Some(Pending {
            checkpoint: self.checkpoint(),
            source,
        });
    }

    /// The sandbox: a hand on the table, on the reader's cards and on any card the table shows —
    /// no cost, no trigger. `run` has checked that it is on.
    fn sandbox(
        &mut self,
        action: PlaytestAction,
        out: &mut Vec<PlaytestHappened>,
    ) -> Result<(), String> {
        match action {
            PlaytestAction::Move { id, to } => self.put(ObjectId(id), to, out),
            PlaytestAction::Tap { ids, tapped } => {
                let mut name = String::new();
                let mut seat = PlaytestPlayer::You;
                let mut count = 0;
                for id in ids {
                    let id = ObjectId(id);
                    let obj = self.editable(id)?;
                    if obj.zone != Zone::Battlefield {
                        return Err(NOT_IN_GAME.into());
                    }
                    if obj.tapped == tapped {
                        continue;
                    }
                    name = obj.name.clone();
                    seat = seat_of(obj.controller);
                    self.debug(DebugAction::SetTapped {
                        object_id: id,
                        tapped,
                    })?;
                    count += 1;
                }
                if count > 0 {
                    out.push(PlaytestHappened::Tapped {
                        seat,
                        name,
                        count,
                        tapped,
                    });
                }
                Ok(())
            }
            PlaytestAction::UntapAll => {
                let tapped: Vec<ObjectId> = self
                    .state
                    .battlefield
                    .iter()
                    .copied()
                    .filter(|id| {
                        self.state
                            .objects
                            .get(id)
                            .is_some_and(|o| o.controller == YOU && o.tapped)
                    })
                    .collect();
                for id in tapped {
                    self.debug(DebugAction::SetTapped {
                        object_id: id,
                        tapped: false,
                    })?;
                }
                out.push(PlaytestHappened::UntappedAll);
                Ok(())
            }
            PlaytestAction::Counters { id, kind, delta } => {
                let id = ObjectId(id);
                let obj = self.editable(id)?;
                let name = obj.name.clone();
                let seat = seat_of(obj.controller);
                let counter_type = parse_counter_type(&kind);
                self.debug(DebugAction::ModifyCounters {
                    object_id: id,
                    counter_type: counter_type.clone(),
                    delta,
                })?;
                let count = self
                    .state
                    .objects
                    .get(&id)
                    .and_then(|o| o.counters.get(&counter_type).copied())
                    .unwrap_or(0);
                out.push(PlaytestHappened::Counters {
                    seat,
                    name,
                    kind: counter_type.display_phrase().into_owned(),
                    count,
                });
                Ok(())
            }
            PlaytestAction::TokenCopy { id } => {
                // A copy of anyone's card is the reader's own token.
                let id = ObjectId(id);
                let name = self.editable(id)?.name.clone();
                self.debug(DebugAction::CreateTokenCopy {
                    source_id: id,
                    owner: YOU,
                    count: 1,
                    nonlegendary: false,
                })?;
                out.push(PlaytestHappened::TokensCreated {
                    seat: PlaytestPlayer::You,
                    name,
                    count: 1,
                });
                Ok(())
            }
            PlaytestAction::CreateToken { preset, count } => {
                let offer = self
                    .tokens
                    .iter()
                    .find(|t| t.preset == preset)
                    .ok_or("Your deck makes no such token.")?
                    .clone();
                let count = count.clamp(1, 99);
                self.debug(DebugAction::CreateToken {
                    request: DebugTokenRequest::Preset {
                        preset_id: preset,
                        owner: YOU,
                        power_override: None,
                        toughness_override: None,
                        enter_with_counters: Vec::new(),
                    },
                    count,
                    run_etb: true,
                })?;
                out.push(PlaytestHappened::TokensCreated {
                    seat: PlaytestPlayer::You,
                    name: offer.name,
                    count,
                });
                Ok(())
            }
            PlaytestAction::Draw { count } => {
                let before = self.player(YOU).hand.clone();
                self.debug(DebugAction::DrawCards {
                    player_id: YOU,
                    count: count.clamp(1, 99),
                })?;
                for id in self.player(YOU).hand.iter() {
                    if !before.contains(id) {
                        let name = self.state.objects.get(id).map(|o| o.name.clone());
                        out.push(PlaytestHappened::Drew {
                            seat: PlaytestPlayer::You,
                            name,
                        });
                    }
                }
                Ok(())
            }
            PlaytestAction::Mill { count } => {
                let before = self.player(YOU).graveyard.clone();
                self.debug(DebugAction::Mill {
                    player_id: YOU,
                    count: count.clamp(1, 99),
                })?;
                for id in self.player(YOU).graveyard.iter() {
                    if !before.contains(id) {
                        if let Some(o) = self.state.objects.get(id) {
                            out.push(PlaytestHappened::Moved {
                                seat: PlaytestPlayer::You,
                                name: o.name.clone(),
                                from: Place::LibraryTop,
                                to: Place::Graveyard,
                            });
                        }
                    }
                }
                Ok(())
            }
            PlaytestAction::Shuffle => {
                self.debug(DebugAction::ShuffleLibrary { player_id: YOU })?;
                out.push(PlaytestHappened::Shuffled);
                Ok(())
            }
            PlaytestAction::SetLife { seat, life } => {
                let player = PlayerId(seat.index());
                if player.0 as usize >= self.state.players.len() {
                    return Err("There is no such player in this game.".into());
                }
                let was = self.player(player).life;
                let life = life.clamp(-999, 9999);
                self.debug(DebugAction::SetLife {
                    player_id: player,
                    life,
                })?;
                out.push(PlaytestHappened::LifeSet { seat, life, was });
                Ok(())
            }
            _ => Err(MAIN_ONLY.into()),
        }
    }

    /// Put a card somewhere by hand: no cost, no trigger, no replacement. Its owner's zone — an
    /// opponent's card goes to their hand, their graveyard, their library.
    fn put(
        &mut self,
        id: ObjectId,
        to: Place,
        out: &mut Vec<PlaytestHappened>,
    ) -> Result<(), String> {
        let obj = self.editable(id)?;
        let from = place_of(obj.zone).ok_or(NOT_IN_GAME)?;
        if from == to && !matches!(to, Place::LibraryTop | Place::LibraryBottom) {
            return Ok(());
        }
        let name = obj.name.clone();
        let is_token = obj.is_token;
        let owner = obj.owner;
        if to == Place::Command && !self.is_commander(owner, &name) {
            return Err(format!(
                "Only a commander goes to the command zone, and {name} is not one."
            ));
        }
        let (zone, position) = match to {
            Place::Hand => (Zone::Hand, None),
            Place::Battlefield => (Zone::Battlefield, None),
            Place::Graveyard => (Zone::Graveyard, None),
            Place::Exile => (Zone::Exile, None),
            Place::Command => (Zone::Command, None),
            Place::LibraryTop => (Zone::Library, Some(LibraryPosition::Top)),
            Place::LibraryBottom => (Zone::Library, Some(LibraryPosition::Bottom)),
        };
        if is_token && to != Place::Battlefield {
            // CR 111.7: a token that leaves the battlefield ceases to exist.
            self.debug(DebugAction::RemoveObject { object_id: id })?;
        } else {
            self.debug(DebugAction::MoveToZone {
                object_id: id,
                to_zone: zone,
                library_position: position,
                simulate: false,
            })?;
        }
        out.push(PlaytestHappened::Put {
            seat: seat_of(owner),
            name,
            from,
            to,
        });
        Ok(())
    }

    // ── Playing on ────────────────────────────────────────────────────────────────────────

    /// Play on until the reader next decides: the AI takes every decision of its own, the
    /// goldfish answers each of its own by doing nothing (`fish_answer`), and the reader's
    /// priority is passed for them except where `stops_here` says otherwise. While the reader ends
    /// a turn (`ending`), their main phases are passed and they declare no attackers.
    fn advance(&mut self, out: &mut Vec<PlaytestHappened>) -> Result<(), String> {
        for _ in 0..STEP_LIMIT {
            self.tell_out(out);
            self.mark_dead();
            // The reader lost a game the others play on (CR 800.4a): it is over for them, and the
            // AIs' game among themselves is not played out.
            if self.reader_out() {
                self.pending = None;
                return Ok(());
            }
            if let WaitingFor::GameOver { winner } = &self.state.waiting_for {
                if !self.over_told {
                    self.over_told = true;
                    out.push(PlaytestHappened::GameOver {
                        winner: winner.map(seat_of),
                    });
                }
                self.pending = None;
                return Ok(());
            }
            if self
                .ending
                .is_some_and(|turn| turn != self.state.turn_number)
            {
                self.ending = None;
            }
            let actors = authorized_submitters(&self.state);
            if actors.iter().any(|p| self.ai_seats.contains(p)) && self.run_ai(out)? > 0 {
                continue;
            }
            // The goldfish's every decision, one at a time and never a replay frame of its own:
            // it does nothing worth watching, and what it does say (a draw) rides with the next.
            if let Some(fish) = self.fish.filter(|f| actors.contains(f)) {
                let answer = self.fish_answer()?;
                self.apply(fish, answer, out)?;
                continue;
            }
            if !actors.contains(&YOU) {
                return Err(format!(
                    "The rules engine is stuck at {}. Start a new game.",
                    self.state.waiting_for.variant_name()
                ));
            }
            let ending = self.ending == Some(self.state.turn_number);
            let from = out.len();
            match &self.state.waiting_for {
                WaitingFor::MulliganDecision { .. } | WaitingFor::OpeningHandBottomCards { .. } => {
                    return Ok(());
                }
                WaitingFor::Priority { .. } => {
                    // A cast is made once its spell is on the stack and the reader has priority
                    // again: whether they stop here or pass, it can no longer be taken back.
                    self.pending = None;
                    self.end_free()?;
                    if !ending && self.stops_here() {
                        return Ok(());
                    }
                    self.apply(YOU, GameAction::PassPriority, out)?;
                }
                WaitingFor::DeclareAttackers {
                    valid_attacker_ids, ..
                } => {
                    if !(ending || valid_attacker_ids.is_empty()) {
                        return Ok(());
                    }
                    self.apply(
                        YOU,
                        GameAction::DeclareAttackers {
                            attacks: Vec::new(),
                            bands: Vec::new(),
                        },
                        out,
                    )?;
                }
                WaitingFor::DeclareBlockers {
                    valid_blocker_ids, ..
                } => {
                    if !valid_blocker_ids.is_empty() {
                        return Ok(());
                    }
                    self.apply(
                        YOU,
                        GameAction::DeclareBlockers {
                            assignments: Vec::new(),
                        },
                        out,
                    )?;
                }
                // A question for the reader — asked only when there is something to decide.
                _ => {
                    let Some(answer) = self.sole_answer() else {
                        return Ok(());
                    };
                    let asked = self.state.clone();
                    out.push(PlaytestHappened::Chose {
                        what: self.state.waiting_for.variant_name().to_string(),
                    });
                    if self.apply(YOU, answer, out).is_err() {
                        // The engine refused its own one answer: the question is asked after all.
                        self.state = asked;
                        out.truncate(from);
                        return Ok(());
                    }
                }
            }
            self.frame(from, out);
        }
        Err("The rules engine did not come back to you. Start a new game.".into())
    }

    /// Each player who has left a game of more than two since the last look, as `Eliminated` —
    /// read off the players rather than phase's events, so a life total set by hand counts too. A
    /// duel's loser is told by `GameOver` alone.
    fn tell_out(&mut self, out: &mut Vec<PlaytestHappened>) {
        if self.state.players.len() <= 2 {
            return;
        }
        for player in &self.state.players {
            if player.is_eliminated && self.out_told.insert(player.id) {
                out.push(PlaytestHappened::Eliminated {
                    seat: seat_of(player.id),
                });
            }
        }
    }

    /// The reader has lost and left a game of more than two, which the others would play on.
    fn reader_out(&self) -> bool {
        self.player(YOU).is_eliminated
            && !matches!(self.state.waiting_for, WaitingFor::GameOver { .. })
    }

    /// The reader's own main phase with an empty stack: where the board waits for them.
    fn at_home(&self) -> bool {
        self.state.stack.is_empty()
            && self.state.active_player == YOU
            && matches!(
                self.state.phase,
                Phase::PreCombatMain | Phase::PostCombatMain
            )
    }

    /// Whether the reader, with priority, is stopped here rather than passed for — the owner's
    /// "smart stops and toggles" (2026-10-13):
    ///
    /// - always in their own main phase with an empty stack;
    /// - at a step they asked to stop at (`setStops`), once per step, the stack empty;
    /// - and, when they have something they could do (phase's `has_meaningful_priority_action`:
    ///   an instant, an ability, not a mana ability), whenever the opponent's spell or ability
    ///   is on top of the stack, and in combat once blockers are declared — the combat trick's
    ///   moment.
    ///
    /// Their own spell on top never stops them: it resolves, as Arena has it.
    fn stops_here(&mut self) -> bool {
        if self.at_home() {
            return true;
        }
        let s = &self.state;
        if s.stack.is_empty() {
            let here = (s.turn_number, s.phase);
            let asked = stop_step(s.phase).is_some_and(|step| {
                self.stops.contains(&PlaytestStop {
                    seat: seat_of(s.active_player).side(),
                    step,
                })
            });
            if asked && self.stopped_at != Some(here) {
                self.stopped_at = Some(here);
                return true;
            }
        }
        let theirs = s.stack.last().is_some_and(|top| top.controller != YOU);
        let after_blocks = s.stack.is_empty()
            && s.phase == Phase::DeclareBlockers
            && s.combat.as_ref().is_some_and(|c| !c.attackers.is_empty());
        (theirs || after_blocks) && has_meaningful_priority_action(s, &legal_actions(s))
    }

    /// What the goldfish does with whatever it is asked: nothing. It keeps its hand, passes every
    /// priority, declares no attackers and no blockers; anything else (a question a card of the
    /// reader's puts to it) takes the engine's first legal answer.
    fn fish_answer(&self) -> Result<GameAction, String> {
        Ok(match &self.state.waiting_for {
            WaitingFor::Priority { .. } => GameAction::PassPriority,
            WaitingFor::DeclareAttackers { .. } => GameAction::DeclareAttackers {
                attacks: Vec::new(),
                bands: Vec::new(),
            },
            WaitingFor::DeclareBlockers { .. } => GameAction::DeclareBlockers {
                assignments: Vec::new(),
            },
            WaitingFor::MulliganDecision { .. } => GameAction::MulliganDecision {
                choice: MulliganChoice::Keep,
            },
            other => legal_actions(&self.state)
                .into_iter()
                .next()
                .ok_or_else(|| {
                    format!(
                        "The rules engine is stuck at {}. Start a new game.",
                        other.variant_name()
                    )
                })?,
        })
    }

    /// The goldfish's `dead_on`, kept up with its life: the reader's turn it first reached 0 or
    /// less, and nothing once it is back above 0.
    fn mark_dead(&mut self) {
        let Some(fish) = self.fish else {
            return;
        };
        if self.player(fish).life > 0 {
            self.dead_on = None;
        } else if self.dead_on.is_none() {
            self.dead_on = Some(self.player(YOU).turns_taken.max(1));
        }
    }

    /// A replay frame of the table now, with the facts since `from`, when there are any.
    fn frame(&mut self, from: usize, out: &[PlaytestHappened]) {
        self.mark_dead();
        if out.len() > from && self.frames.len() < self.frame_limit {
            self.frames.push(PlaytestFrame {
                view: self.view_as(true),
                happened: out[from..].to_vec(),
            });
        }
    }

    /// Every decision the AI can take now, in one batch: how many it took.
    fn run_ai(&mut self, out: &mut Vec<PlaytestHappened>) -> Result<usize, String> {
        let session = Arc::clone(
            self.ai_session
                .get_or_insert_with(|| AiSession::arc_from_game(&self.state)),
        );
        let run = run_ai_actions(
            &mut self.state,
            &self.ai_seats,
            &self.ai_configs,
            &mut self.rng,
            &session,
        );
        let taken = run.results.len();
        for mut result in run.results {
            let from = out.len();
            tell(&result.state, &result.events, out);
            if out.len() > from && self.frames.len() < self.frame_limit {
                // The table as it was right after this decision: its state is swapped in for the
                // view and straight back out (both are persistent, so a swap is two pointers).
                std::mem::swap(&mut self.state, &mut result.state);
                self.frame(from, out);
                std::mem::swap(&mut self.state, &mut result.state);
            }
        }
        match run.stop {
            AiActionsStop::ChooseActionNone { .. } => {
                Err("The AI opponent found nothing to do and stopped. Start a new game.".into())
            }
            AiActionsStop::ApplyFailed { error, .. } => Err(format!(
                "The AI opponent's move was refused by the rules engine ({error}). Start a new game."
            )),
            AiActionsStop::MissingAiConfig { .. } => {
                Err("The AI opponent is not set up. Start a new game.".into())
            }
            _ => Ok(taken),
        }
    }

    // ── Plumbing ──────────────────────────────────────────────────────────────────────────

    fn player(&self, seat: PlayerId) -> &engine::types::player::Player {
        &self.state.players[seat.0 as usize]
    }

    /// One of the reader's own objects — the only ones the rules let the board play or activate.
    fn own(&self, id: ObjectId) -> Result<&engine::game::GameObject, String> {
        self.state
            .objects
            .get(&id)
            .filter(|o| !o.is_emblem && (o.owner == YOU || o.controller == YOU))
            .ok_or_else(|| NOT_IN_GAME.to_string())
    }

    /// An object the sandbox may act on: one of the reader's own, or anyone's that the table
    /// shows — on the battlefield, in a graveyard, in exile or in the command zone. An opponent's
    /// hand and library are what the reader may not see, and stay out of reach.
    fn editable(&self, id: ObjectId) -> Result<&engine::game::GameObject, String> {
        let o = self
            .state
            .objects
            .get(&id)
            .filter(|o| !o.is_emblem && !self.rules.contains(&id))
            .ok_or_else(|| NOT_IN_GAME.to_string())?;
        if o.owner == YOU || o.controller == YOU {
            return Ok(o);
        }
        match o.zone {
            Zone::Battlefield | Zone::Graveyard | Zone::Exile | Zone::Command => Ok(o),
            Zone::Hand | Zone::Library => Err(HIDDEN.into()),
            Zone::Stack => Err(NOT_IN_GAME.into()),
        }
    }

    /// One action by `actor`, its events told as what happened.
    fn apply(
        &mut self,
        actor: PlayerId,
        action: GameAction,
        out: &mut Vec<PlaytestHappened>,
    ) -> Result<(), String> {
        let result = apply(&mut self.state, actor, action).map_err(|e| e.to_string())?;
        tell(&self.state, &result.events, out);
        Ok(())
    }

    /// A sandbox action. Its events are not told: the action's own fact says what the reader did.
    fn debug(&mut self, action: DebugAction) -> Result<(), String> {
        apply(&mut self.state, YOU, GameAction::Debug(action))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Tests only: the emblems in the game, the goldfish's own among them — so a test can see a
    /// free cast's is gone.
    #[cfg(test)]
    pub(super) fn emblems_for_test(&self) -> usize {
        self.state.objects.values().filter(|o| o.is_emblem).count()
    }

    /// Tests only: put a card of `seat`'s from its library onto the battlefield, as if it had
    /// been played — the AI cannot be told what to cast.
    #[cfg(test)]
    pub(super) fn put_for_test(&mut self, seat: PlaytestPlayer, name: &str) {
        let player = PlayerId(seat.index());
        let id = self.state.players[player.0 as usize]
            .library
            .iter()
            .copied()
            .find(|id| self.state.objects[id].name == name)
            .expect("the card is in the library");
        apply(
            &mut self.state,
            YOU,
            GameAction::Debug(DebugAction::MoveToZone {
                object_id: id,
                to_zone: Zone::Battlefield,
                library_position: None,
                simulate: false,
            }),
        )
        .expect("the engine moves it");
    }

    /// Undo (`back`) or redo: the game as it was before the last action, or before the last undo.
    fn travel(&mut self, back: bool) -> Result<PlaytestStep, String> {
        let now = self.moment();
        let then = if back {
            self.history.undo(now).ok_or(NOTHING_TO_UNDO)?
        } else {
            self.history.redo(now).ok_or(NOTHING_TO_REDO)?
        };
        self.restore(then.checkpoint);
        self.pending = then.pending;
        self.choice = then.choice;
        self.over_told = then.over_told;
        self.ending = then.ending;
        self.stopped_at = then.stopped_at;
        self.frames.clear();
        Ok(PlaytestStep {
            view: self.view(),
            happened: Vec::new(),
            frames: Vec::new(),
        })
    }

    fn moment(&self) -> Moment {
        Moment {
            checkpoint: self.checkpoint(),
            pending: self.pending.clone(),
            choice: self.choice.clone(),
            over_told: self.over_told,
            ending: self.ending,
            stopped_at: self.stopped_at,
        }
    }

    fn checkpoint(&self) -> Checkpoint {
        Checkpoint {
            state: self.state.clone(),
            printings: self.printings.clone(),
            mulligans: self.mulligans,
            rng: self.rng.clone(),
            out_told: self.out_told.clone(),
            dead_on: self.dead_on,
            free: self.free,
        }
    }

    fn restore(&mut self, checkpoint: Checkpoint) {
        self.state = checkpoint.state;
        self.printings = checkpoint.printings;
        self.mulligans = checkpoint.mulligans;
        self.rng = checkpoint.rng;
        self.out_told = checkpoint.out_told;
        self.dead_on = checkpoint.dead_on;
        self.free = checkpoint.free;
    }
}

/// A hand on the table rather than the rules: the actions the sandbox takes, refused while it is
/// off.
fn is_sandbox(action: &PlaytestAction) -> bool {
    matches!(
        action,
        PlaytestAction::Move { .. }
            | PlaytestAction::Tap { .. }
            | PlaytestAction::UntapAll
            | PlaytestAction::Counters { .. }
            | PlaytestAction::TokenCopy { .. }
            | PlaytestAction::CreateToken { .. }
            | PlaytestAction::Draw { .. }
            | PlaytestAction::Mill { .. }
            | PlaytestAction::Shuffle
            | PlaytestAction::SetLife { .. }
    )
}

/// The card an object of this name is a face of (`Playtest::card_names`): the card's own name
/// for a back face, `name` itself otherwise.
fn card_name<'a>(card_names: &'a HashMap<String, String>, name: &'a str) -> &'a str {
    card_names.get(name).map_or(name, String::as_str)
}

/// The wire's name for a player: `PlayerId(n)` is `PlaytestPlayer::ALL[n]`. A game never seats
/// more than four, so the last is a fallback that is never reached.
fn seat_of(player: PlayerId) -> PlaytestPlayer {
    PlaytestPlayer::ALL
        .get(player.0 as usize)
        .copied()
        .unwrap_or(PlaytestPlayer::Opponent3)
}

/// What a stack entry targets, for the board's arrows: the cards the table shows and the players,
/// each once, in the order chosen — the spell's or ability's own targets and its follow-on
/// abilities' ("… and another target creature"), and an equip's creature. A card in a hand or a
/// library is not shown, so it is not told.
pub(super) fn stack_targets(
    state: &GameState,
    entry: &StackEntry,
) -> (Vec<u64>, Vec<PlaytestPlayer>) {
    let mut refs: Vec<TargetRef> = Vec::new();
    let mut next = entry.ability();
    while let Some(ability) = next {
        refs.extend_from_slice(&ability.targets);
        if let Some(branch) = ability.else_ability.as_deref() {
            refs.extend_from_slice(&branch.targets);
        }
        next = ability.sub_ability.as_deref();
    }
    if let StackEntryKind::KeywordAction {
        action: KeywordAction::Equip {
            target_creature_id, ..
        },
    } = &entry.kind
    {
        refs.push(TargetRef::Object(*target_creature_id));
    }
    let mut cards = Vec::new();
    let mut players = Vec::new();
    for r in refs {
        match r {
            TargetRef::Object(id) => {
                let shown = state
                    .objects
                    .get(&id)
                    .is_some_and(|o| !matches!(o.zone, Zone::Hand | Zone::Library));
                if shown && id != entry.id && !cards.contains(&id.0) {
                    cards.push(id.0);
                }
            }
            TargetRef::Player(p) => {
                let p = seat_of(p);
                if !players.contains(&p) {
                    players.push(p);
                }
            }
        }
    }
    (cards, players)
}

/// Which of the engine's answers a pick's cards are sent as (`pick`'s second value).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PickAnswer {
    /// `SelectCards`.
    Cards,
    /// `SelectTargets`, for a question that takes targets.
    Targets,
    /// `ChooseKeptCreatures`: the creatures kept within a total power, the rest sacrificed.
    KeptCreatures,
    /// `ChooseKeptPermanents`: the permanents kept, the rest sacrificed.
    KeptPermanents,
}

/// A pick's answer: the cards, as the question takes them.
fn pick_answer(ids: Vec<u64>, answer: PickAnswer) -> GameAction {
    let objects = || ids.iter().copied().map(ObjectId).collect();
    match answer {
        PickAnswer::Cards => GameAction::SelectCards { cards: objects() },
        PickAnswer::Targets => GameAction::SelectTargets {
            targets: ids
                .iter()
                .map(|id| TargetRef::Object(ObjectId(*id)))
                .collect(),
        },
        PickAnswer::KeptCreatures => GameAction::ChooseKeptCreatures { kept: objects() },
        PickAnswer::KeptPermanents => GameAction::ChooseKeptPermanents { kept: objects() },
    }
}

/// What an attack is at, by id: a planeswalker's or a battle's, `None` for a player.
fn target_id(target: &AttackTarget) -> Option<u64> {
    match target {
        AttackTarget::Player(_) => None,
        AttackTarget::Planeswalker(id) | AttackTarget::Battle(id) => Some(id.0),
    }
}

/// The step a stop names, for the steps a player gets priority in.
fn stop_step(phase: Phase) -> Option<PlaytestStopStep> {
    Some(match phase {
        Phase::Upkeep => PlaytestStopStep::Upkeep,
        Phase::Draw => PlaytestStopStep::Draw,
        Phase::PreCombatMain => PlaytestStopStep::Main1,
        Phase::BeginCombat => PlaytestStopStep::BeginCombat,
        Phase::DeclareAttackers => PlaytestStopStep::Attackers,
        Phase::DeclareBlockers => PlaytestStopStep::Blockers,
        Phase::CombatDamage => PlaytestStopStep::Damage,
        Phase::PostCombatMain => PlaytestStopStep::Main2,
        Phase::End => PlaytestStopStep::End,
        _ => return None,
    })
}

fn phase_of(phase: Phase) -> PlaytestPhase {
    match phase {
        Phase::Untap | Phase::Upkeep | Phase::Draw => PlaytestPhase::Beginning,
        Phase::PreCombatMain => PlaytestPhase::Main1,
        Phase::PostCombatMain => PlaytestPhase::Main2,
        Phase::End | Phase::Cleanup => PlaytestPhase::Ending,
        _ => PlaytestPhase::Combat,
    }
}

/// The ids and players a JSON value names: an id is a number, a target is `{"Object": id}` or
/// `{"Player": id}`, and a list is each of its items.
fn collect_refs(value: &Value, ids: &mut Vec<ObjectId>, players: &mut Vec<PlaytestPlayer>) {
    match value {
        Value::Number(n) => {
            if let Some(id) = n.as_u64() {
                ids.push(ObjectId(id));
            }
        }
        Value::Array(items) => items.iter().for_each(|v| collect_refs(v, ids, players)),
        Value::Object(map) => {
            if let Some(id) = map.get("Object").and_then(Value::as_u64) {
                ids.push(ObjectId(id));
            }
            if let Some(p) = map.get("Player").and_then(Value::as_u64) {
                players.push(seat_of(PlayerId(p as u8)));
            }
        }
        _ => {}
    }
}

/// A word on the wire: a string, or the tag of one of phase's `#[serde(tag = "type")]` enums.
fn tag_of(value: &Value) -> Option<String> {
    value
        .as_str()
        .or_else(|| value.get("type")?.as_str())
        .map(str::to_string)
}

/// Whether an action is something `id` does: its data names `id` as the source, the equipment,
/// the vehicle or the object acted on.
fn names_source(action: &GameAction, id: ObjectId) -> bool {
    let Ok(json) = serde_json::to_value(action) else {
        return false;
    };
    let Some(Value::Object(data)) = json.get("data") else {
        return false;
    };
    [
        "source_id",
        "equipment_id",
        "vehicle_id",
        "spacecraft_id",
        "mount_id",
        "object_id",
    ]
    .iter()
    .any(|key| data.get(*key).and_then(Value::as_u64) == Some(id.0))
}

/// What a run of the engine's events comes to, as the log's facts. `state` is the game after
/// them, which names the objects they point at. An opponent's draws are told without the card.
fn tell(state: &GameState, events: &[GameEvent], out: &mut Vec<PlaytestHappened>) {
    let name = |id: &ObjectId| state.objects.get(id).map(|o| o.name.clone());
    let seat = |id: &ObjectId| state.objects.get(id).map(|o| seat_of(o.controller));
    let lands: BTreeSet<ObjectId> = events
        .iter()
        .filter_map(|e| match e {
            GameEvent::LandPlayed { object_id, .. } => Some(*object_id),
            _ => None,
        })
        .collect();
    // A foretold card's move to exile is told as its foretelling, which hides an opponent's card.
    let foretold: BTreeSet<ObjectId> = events
        .iter()
        .filter_map(|e| match e {
            GameEvent::Foretold { object_id, .. } => Some(*object_id),
            _ => None,
        })
        .collect();
    for event in events {
        match event {
            GameEvent::TurnStarted {
                player_id,
                turn_number,
            } => out.push(PlaytestHappened::TurnBegan {
                turn: *turn_number,
                seat: seat_of(*player_id),
            }),
            GameEvent::LandPlayed {
                object_id,
                player_id,
                ..
            } => {
                if let Some(name) = name(object_id) {
                    out.push(PlaytestHappened::Played {
                        seat: seat_of(*player_id),
                        name,
                    });
                }
            }
            GameEvent::SpellCast {
                object_id,
                controller,
                ..
            } => {
                if let Some(name) = name(object_id) {
                    out.push(PlaytestHappened::Cast {
                        seat: seat_of(*controller),
                        name,
                    });
                }
            }
            GameEvent::AbilityActivated {
                player_id,
                source_id,
                kind,
                departed_source_lki,
                ..
            } => {
                if matches!(kind, ActivatedAbilityKind::Mana) {
                    continue;
                }
                let source = name(source_id)
                    .or_else(|| departed_source_lki.as_ref().map(|l| l.name.clone()));
                if let Some(name) = source {
                    out.push(PlaytestHappened::Activated {
                        seat: seat_of(*player_id),
                        name,
                    });
                }
            }
            GameEvent::ZoneChanged {
                object_id,
                from,
                to,
                record,
            } => {
                let Some(from) = from else { continue };
                let (Some(from_place), Some(to_place)) = (place_of(*from), place_of(*to)) else {
                    // The stack: a cast and its resolving are told as the cast.
                    continue;
                };
                if from_place == to_place
                    || (*from == Zone::Hand
                        && (lands.contains(object_id) || foretold.contains(object_id)))
                {
                    continue;
                }
                let owner = state
                    .objects
                    .get(object_id)
                    .map_or(record.controller, |o| o.owner);
                let whose = seat_of(owner);
                let hidden = whose != PlaytestPlayer::You;
                match (from, to) {
                    (Zone::Library, Zone::Hand) => out.push(PlaytestHappened::Drew {
                        seat: whose,
                        name: (!hidden).then(|| record.name.clone()),
                    }),
                    // A card going back to a hidden zone the reader cannot follow.
                    (Zone::Hand, Zone::Library) if hidden => {}
                    (Zone::Library, Zone::Library) => {}
                    _ => out.push(PlaytestHappened::Moved {
                        seat: whose,
                        name: record.name.clone(),
                        from: from_place,
                        to: to_place,
                    }),
                }
            }
            GameEvent::Foretold {
                player_id,
                object_id,
            } => {
                let whose = seat_of(*player_id);
                out.push(PlaytestHappened::Foretold {
                    seat: whose,
                    name: if whose == PlaytestPlayer::You {
                        name(object_id)
                    } else {
                        None
                    },
                });
            }
            GameEvent::AttackersDeclared { attacker_ids, .. } => {
                let names: Vec<String> = attacker_ids.iter().filter_map(name).collect();
                if let (Some(first), false) = (attacker_ids.first(), names.is_empty()) {
                    out.push(PlaytestHappened::Attacked {
                        seat: seat(first).unwrap_or(PlaytestPlayer::Opponent),
                        names,
                    });
                }
            }
            GameEvent::BlockersDeclared { assignments } => {
                for (blocker, attacker) in assignments {
                    if let (Some(b), Some(a)) = (name(blocker), name(attacker)) {
                        out.push(PlaytestHappened::Blocked {
                            seat: seat(blocker).unwrap_or(PlaytestPlayer::You),
                            blocker: b,
                            attacker: a,
                        });
                    }
                }
            }
            GameEvent::DamageDealt {
                source_id,
                target: TargetRef::Object(target),
                amount,
                ..
            } => {
                if let (Some(source), Some(name_of), Some(whose)) =
                    (name(source_id), name(target), seat(target))
                {
                    out.push(PlaytestHappened::Dealt {
                        source,
                        target: name_of,
                        target_id: target.0,
                        seat: whose,
                        amount: *amount,
                    });
                }
            }
            GameEvent::LifeChanged {
                player_id,
                amount,
                new_total,
            } => out.push(PlaytestHappened::Life {
                seat: seat_of(*player_id),
                amount: *amount,
                // phase reports the total with the change when it can; the life after the
                // action is the fallback, the same unless one action changed it twice.
                total: new_total
                    .0
                    .unwrap_or(state.players[player_id.0 as usize].life),
            }),
            GameEvent::TokenCreated {
                object_id, name, ..
            } => {
                let whose = seat(object_id).unwrap_or(PlaytestPlayer::You);
                match out.last_mut() {
                    Some(PlaytestHappened::TokensCreated {
                        seat,
                        name: last,
                        count,
                    }) if *seat == whose && last == name => *count += 1,
                    _ => out.push(PlaytestHappened::TokensCreated {
                        seat: whose,
                        name: name.clone(),
                        count: 1,
                    }),
                }
            }
            _ => {}
        }
    }
}
