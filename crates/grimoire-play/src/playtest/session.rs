//! One playtest game: the reader's deck against another, the opponent's seat played by phase.rs's
//! AI (`phase-ai`) on the same `GameState` the engine plays.
//!
//! **The rules decide, and the reader decides only what a player at a table would** — the owner's
//! choices of 2026-10-13. After every action the session plays on by itself (`advance`): the AI
//! takes each of its decisions, and the reader's priority is passed for them, Arena-style, until
//! the game next needs the reader (`PlaytestStage`): the opening hand, their main phase with an
//! empty stack, their declare-attackers and declare-blockers steps, a question the engine asks
//! them, and — `stops_here`'s smart stops and toggles — a moment to respond: the opponent's spell
//! on the stack or combat after blocks when they could answer it, or a step they asked to stop
//! at. Everything else — most of the AI's turn, a spell resolving, combat damage — happens inside
//! the one call, and comes back as what happened and as replay frames (`PlaytestFrame`), the
//! table after each thing worth showing.
//!
//! **A prompt is the engine's question as its legal answers.** phase has well over a hundred kinds
//! of question, so no board draws each one: the view lists `legal_actions` with the facts in each
//! (`option_of`), and `auto` answers any of them with the AI's choice for the reader. A question
//! answered by a set of cards — a scry, a discard, a search — also carries a `pick` (`pick`): the
//! enumeration offers only a few of its answers. A question with one answer is not asked at all
//! (`sole_answer`): `advance` takes it, as the reader would have.
//!
//! **The goldfish's sandbox stays, on the reader's own cards.** Moving a card by hand, tapping,
//! counters, tokens, draws and life totals are phase's debug actions, as on the goldfish board: the
//! escape hatch for a card the parser does not play. They are taken in the reader's main phase
//! only, where nothing is half-done.
//!
//! **A refused action changes nothing**, and **a cast can be taken back until it is on the
//! stack**: `act` restores its checkpoint on any `Err`, and a `Play` or `Activate` keeps one
//! (`Pending`) for as long as the engine is asking the reader how to make it — `cancel` puts it
//! back. The moment priority is passed with the spell on the stack, it is cast.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use engine::ai_support::{has_meaningful_priority_action, legal_actions};
use engine::game::combat::AttackTarget;
use engine::game::engine::apply;
use engine::game::mana_sources::max_mana_yield;
use engine::game::turn_control::authorized_submitters;
use engine::game::{
    install_card_db, load_and_hydrate_decks, resolve_deck_list, start_game_with_starting_player,
    DeckList, PlayerDeckList,
};
use engine::types::ability::{LibraryPosition, TargetRef};
use engine::types::actions::{DebugAction, DebugTokenRequest, GameAction, MulliganChoice};
use engine::types::events::{ActivatedAbilityKind, GameEvent};
use engine::types::format::FormatConfig;
use engine::types::game_state::{MulliganDecisionPhase, StackEntryKind, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::types::phase::Phase;
use engine::types::zones::Zone;
use engine::types::{parse_counter_type, GameState, PlayerId};
use phase_ai::auto_play::{run_ai_actions, AiActionsStop};
use phase_ai::{create_config_for_players, AiConfig, AiDifficulty, AiSession, Platform};
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use serde_json::Value;

use crate::cards::{self, CardFacts};
use crate::session::{game_card, mana_table, place_of};
use crate::tokens::{DeckTokens, TokenFacts};
use crate::view::{GameCard, MulliganView, Place, Seat, TokenOffer};

use super::view::{
    Difficulty, PlaytestAction, PlaytestAttack, PlaytestAttackPair, PlaytestAttacker,
    PlaytestBlock, PlaytestBlockPair, PlaytestBlocker, PlaytestCardRef, PlaytestCombat,
    PlaytestFrame, PlaytestHappened, PlaytestOption, PlaytestPhase, PlaytestPick,
    PlaytestPickPurpose, PlaytestPrompt, PlaytestSeat, PlaytestStackItem, PlaytestStage,
    PlaytestStep, PlaytestStop, PlaytestStopStep, PlaytestView,
};

const YOU: PlayerId = PlayerId(0);
const AI: PlayerId = PlayerId(1);

/// How many times one action may pass the reader's priority (or declare no attackers for them)
/// before the session gives up on it. A whole turn cycle is a few dozen; the bound is what stops a
/// loop in the engine, the AI or here from hanging the board, and a game never reaches it.
const STEP_LIMIT: usize = 2000;

/// The most replay frames one action answers with. A long AI turn is a few dozen things to show;
/// past this the rest is the final view, so a runaway loop of triggers cannot make a step huge.
const FRAME_LIMIT: usize = 80;

const NOT_IN_GAME: &str = "That card is no longer where it was. The board has been refreshed.";
const NOT_NOW: &str = "Keep or mulligan the opening hand first.";
const ALREADY_KEPT: &str = "The opening hand has already been kept.";
const OVER: &str = "The game is over. Start a new one from the game menu.";
const MAIN_ONLY: &str = "That can be done in your main phase, with nothing on the stack.";
const NO_PROMPT: &str = "The game is not asking you anything right now.";

/// The game as it was, to go back to: a refused action, or a cast the reader takes back.
#[derive(Clone)]
struct Checkpoint {
    state: GameState,
    printings: HashMap<ObjectId, Printing>,
    mulligans: u8,
    rng: ChaCha8Rng,
}

/// The printing an object is drawn by, with whose and what it was — so a printing can follow
/// its card into a new zone after the object it was on is gone.
#[derive(Debug, Clone)]
struct Printing {
    owner: PlayerId,
    name: String,
    card_id: String,
}

/// A cast or an activation the engine is still asking the reader about, which `cancel` takes
/// back to `checkpoint`.
struct Pending {
    checkpoint: Checkpoint,
    source: String,
}

/// The board's own question: a card that can be cast (or a permanent activated) in more than
/// one way. Nothing has happened yet; an answer is one of `actions`.
struct BoardChoice {
    kind: &'static str,
    source: String,
    actions: Vec<GameAction>,
}

pub struct Playtest {
    state: GameState,
    printings: HashMap<ObjectId, Printing>,
    /// The printing a card is drawn by when its object has none of its own (a copy, a card the
    /// engine made): the deck's first printing of that name, per seat.
    by_name: HashMap<(PlayerId, String), String>,
    commanders: HashSet<(PlayerId, String)>,
    mulligans: u8,
    tokens: Vec<TokenOffer>,
    /// Each seat's deck's tokens in the printings the reader set, which a token is drawn by.
    deck_tokens: HashMap<PlayerId, DeckTokens>,
    started: PlayerId,
    ai_seats: HashSet<PlayerId>,
    ai_configs: HashMap<PlayerId, AiConfig>,
    /// The config `auto` answers the reader's questions with.
    helper: AiConfig,
    /// phase-ai's per-game analysis of both decks, made the first time the AI decides.
    ai_session: Option<Arc<AiSession>>,
    /// The AI's dice, seeded from the game's seed: the same seed and decks play the same game.
    rng: ChaCha8Rng,
    pending: Option<Pending>,
    choice: Option<BoardChoice>,
    /// The game's end has been put in the log.
    over_told: bool,
    /// The steps the reader asked to stop at (`setStops`).
    stops: Vec<PlaytestStop>,
    /// The turn the reader is ending (`endTurn`): until it changes, nothing but a block or a
    /// question stops the game.
    ending: Option<u32>,
    /// The last step a stop of `stops` stopped at, so passing there does not stop there again.
    stopped_at: Option<(u32, Phase)>,
    /// The current action's replay frames, taken by `act`.
    frames: Vec<PlaytestFrame>,
}

impl Playtest {
    /// A new game of `you` (the reader's deck as it stands) against `opponent`, played by the AI
    /// at `difficulty`. `seed` is the shuffle, the coin flip for who plays first (its lowest bit:
    /// even, the reader), and the AI's dice. `your_tokens` and `their_tokens` are each deck's
    /// tokens in the printings the reader set, which a token is offered and drawn by. Answers with
    /// the game at the reader's opening hand.
    pub fn new(
        you: &[CardFacts],
        your_tokens: &[TokenFacts],
        opponent: &[CardFacts],
        their_tokens: &[TokenFacts],
        seed: u64,
        difficulty: Difficulty,
    ) -> Result<(Self, PlaytestStep), String> {
        let all: Vec<CardFacts> = you.iter().chain(opponent).cloned().collect();
        let db = Arc::new(cards::database(&all, &[])?);

        let mut by_name = HashMap::new();
        let mut commanders = HashSet::new();
        let mut piles = |deck: &[CardFacts], seat: PlayerId| {
            let mut main = Vec::new();
            let mut commander = Vec::new();
            for card in deck {
                let name = cards::engine_name(card);
                if db.get_face_by_name(&name).is_none() {
                    continue;
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
        let (their_main, their_commander) = piles(opponent, AI);
        if your_main.is_empty() {
            return Err("Your deck has no cards to shuffle into a library.".into());
        }
        if their_main.is_empty() {
            return Err("The opponent's deck has no cards to shuffle into a library.".into());
        }

        // A commander on either side makes it a Commander game: 40 life, the command zone, tax.
        let format = if your_commander.is_empty() && their_commander.is_empty() {
            FormatConfig::freeform()
        } else {
            FormatConfig::commander()
        };
        let mut state = GameState::new(format, 2, seed);
        // The sandbox is phase's debug actions, which the engine refuses unless the game allows
        // them and the player is on the list — the reader is, the AI is not.
        state.debug_mode = true;
        state.debug_permitted.insert(YOU);

        let list = DeckList {
            player: PlayerDeckList {
                main_deck: your_main,
                commander: your_commander,
                ..PlayerDeckList::default()
            },
            opponent: PlayerDeckList {
                main_deck: their_main,
                commander: their_commander,
                ..PlayerDeckList::default()
            },
            ..DeckList::default()
        };
        let payload = resolve_deck_list(&db, &list);
        load_and_hydrate_decks(&mut state, &payload, Some(&db));
        state.all_card_names = db.card_names().into();
        install_card_db(&mut state, Arc::clone(&db));

        let deck_names: HashSet<&str> = by_name
            .keys()
            .filter(|(seat, _)| *seat == YOU)
            .map(|(_, n)| n.as_str())
            .collect();
        let deck_tokens = HashMap::from([
            (YOU, DeckTokens::new(your_tokens)),
            (AI, DeckTokens::new(their_tokens)),
        ]);
        let tokens = deck_tokens[&YOU].offers(&deck_names);

        let level = match difficulty {
            Difficulty::VeryEasy => AiDifficulty::VeryEasy,
            Difficulty::Easy => AiDifficulty::Easy,
            Difficulty::Medium => AiDifficulty::Medium,
            Difficulty::Hard => AiDifficulty::Hard,
            Difficulty::VeryHard => AiDifficulty::VeryHard,
        };
        let started = if seed & 1 == 0 { YOU } else { AI };
        let mut game = Playtest {
            state,
            printings: HashMap::new(),
            by_name,
            commanders,
            mulligans: 0,
            tokens,
            deck_tokens,
            started,
            ai_seats: HashSet::from([AI]),
            ai_configs: HashMap::from([(
                AI,
                create_config_for_players(level, Platform::Native, 2),
            )]),
            helper: create_config_for_players(AiDifficulty::Medium, Platform::Native, 2),
            ai_session: None,
            // Not the shuffle's own stream: the AI's choices must not shift when the engine
            // draws one more random number of its own.
            rng: ChaCha8Rng::seed_from_u64(seed ^ 0x5eed_a1a1_5eed_a1a1),
            pending: None,
            choice: None,
            over_told: false,
            stops: Vec::new(),
            ending: None,
            stopped_at: None,
            frames: Vec::new(),
        };
        game.assign_printings(you, YOU);
        game.assign_printings(opponent, AI);
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
            let name = self.state.objects[&id].name.clone();
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
    /// the same seat and name that has none (CR 400.7 — a card that changed zones may be a new
    /// object), so a card keeps its art wherever it goes.
    fn follow_printings(&mut self) {
        let objects = &self.state.objects;
        let mut orphans: HashMap<(PlayerId, String), Vec<String>> = HashMap::new();
        self.printings.retain(|id, p| {
            let alive = objects.get(id).is_some_and(|o| o.name == p.name);
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
            if let Some(card_id) = orphans
                .get_mut(&(o.owner, o.name.clone()))
                .and_then(Vec::pop)
            {
                self.printings.insert(
                    id,
                    Printing {
                        owner: o.owner,
                        name: o.name.clone(),
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
                            player: targets.iter().any(|t| matches!(t, AttackTarget::Player(_))),
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
            you: self.seat(YOU),
            opponent: self.seat(AI),
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
                    Some(PlaytestStackItem {
                        id: entry.id.0,
                        name: source.name.clone(),
                        card_id: self.printing_of(shown),
                        seat: seat_of(entry.controller),
                        ability: !matches!(entry.kind, StackEntryKind::Spell { .. }),
                    })
                })
                .collect(),
            winner,
            tokens: self.tokens.clone(),
            stops: self.stops.clone(),
            ending_turn: self.ending == Some(s.turn_number),
        }
    }

    fn seat(&self, seat: PlayerId) -> PlaytestSeat {
        let s = &self.state;
        let player = &s.players[seat.0 as usize];
        let mine = |id: &&ObjectId| s.objects.get(id).is_some_and(|o| o.owner == seat);
        let cards = |ids: &mut dyn Iterator<Item = &ObjectId>| -> Vec<GameCard> {
            ids.filter_map(|id| self.card(*id)).collect()
        };
        let reader = seat == YOU;
        PlaytestSeat {
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
        }
    }

    fn card(&self, id: ObjectId) -> Option<GameCard> {
        let o = self.state.objects.get(&id)?;
        let is_commander = !o.is_token && self.commanders.contains(&(o.owner, o.name.clone()));
        game_card(&self.state, id, self.printing_of(id), is_commander)
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
            .or_else(|| self.by_name.get(&(o.owner, o.name.clone())).cloned())
    }

    fn card_ref(&self, id: ObjectId) -> Option<PlaytestCardRef> {
        let o = self.state.objects.get(&id)?;
        Some(PlaytestCardRef {
            id: id.0,
            name: o.name.clone(),
            card_id: self.printing_of(id),
            text: None,
        })
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
            });
            Some(PlaytestCardRef {
                text: Some(text),
                ..card
            })
        };
        fields
            .values()
            .filter_map(Value::as_array)
            .find(|items| !items.is_empty() && items.iter().all(|v| ability(v).is_some()))
            .map(|items| items.iter().filter_map(ability).collect())
            .unwrap_or_default()
    }

    fn stage(&self) -> PlaytestStage {
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
                options: choice
                    .actions
                    .iter()
                    .enumerate()
                    .map(|(i, a)| self.option_of(i, a, &[]))
                    .collect(),
                cancellable: true,
                pick: None,
            };
        }
        let source = self.pending.as_ref().map(|p| p.source.clone()).or_else(|| {
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
            options: self
                .answers()
                .iter()
                .enumerate()
                .map(|(i, a)| self.option_of(i, a, &abilities))
                .collect(),
            cancellable: self.pending.is_some(),
            pick: self.pick().map(|(pick, _)| pick),
        }
    }

    /// The question's answer as a set of cards, for the few kinds of question whose answers
    /// `legal_actions` cannot list (it offers none, all and each one alone — a scry of three has
    /// sixteen answers). Each kind's fields say which cards, how many and whether order counts;
    /// the answer is `SelectCards`, or `SelectTargets` for `ChooseObjectsSelection`. The second
    /// value says which.
    fn pick(&self) -> Option<(PlaytestPick, bool)> {
        let all = |ids: &[ObjectId]| ids.iter().map(|id| id.0).collect::<Vec<u64>>();
        let (purpose, shown, eligible, min, max, ordered, targets) = match &self.state.waiting_for {
            WaitingFor::ScryChoice { player, cards } if *player == YOU => (
                PlaytestPickPurpose::Scry,
                all(cards),
                all(cards),
                0,
                cards.len(),
                true,
                false,
            ),
            WaitingFor::SurveilChoice { player, cards } if *player == YOU => (
                PlaytestPickPurpose::Surveil,
                all(cards),
                all(cards),
                0,
                cards.len(),
                true,
                false,
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
                false,
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
                false,
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
                false,
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
                    false,
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
                false,
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
                false,
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
                false,
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
                    true,
                )
            }
            _ => return None,
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
            },
            targets,
        ))
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
        if let Some((pick, targets)) = self.pick() {
            let all = pick.min == pick.max && pick.eligible.len() == pick.min as usize;
            return (all && (!pick.ordered || pick.min <= 1))
                .then(|| pick_answer(pick.eligible, targets));
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
        let mut players: Vec<Seat> = Vec::new();
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
                    | "vehicle_id" | "cards" | "creature_ids" | "targets" | "target" => {
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
                    "choice" => label = value.as_str().map(str::to_string),
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
    pub fn act(&mut self, action: PlaytestAction) -> Result<PlaytestStep, String> {
        let checkpoint = self.checkpoint();
        let mut happened = Vec::new();
        let choice = self.choice.take();
        self.frames.clear();
        match self.run(action, choice, &mut happened) {
            Ok(()) => {
                self.follow_printings();
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
        if stage == PlaytestStage::Over {
            return Err(OVER.into());
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
                let (pick, targets) = self
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
                self.apply(YOU, pick_answer(ids, targets), out)?;
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
                    let at = match pair.target {
                        None => open
                            .iter()
                            .find(|t| matches!(t, AttackTarget::Player(_)))
                            .copied()
                            .unwrap_or(AttackTarget::Player(AI)),
                        Some(id) => open
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

    /// The rules only: the one way to play it, a question about which way, or a refusal.
    fn play(&mut self, id: ObjectId, out: &mut Vec<PlaytestHappened>) -> Result<(), String> {
        let obj = self.own(id)?;
        if !matches!(obj.zone, Zone::Hand | Zone::Command) {
            return self.activate(id, out);
        }
        let name = obj.name.clone();
        let ways: Vec<GameAction> = self
            .answers()
            .into_iter()
            .filter(|a| match a {
                GameAction::PlayLand { object_id, .. }
                | GameAction::CastSpell { object_id, .. } => *object_id == id,
                _ => false,
            })
            .collect();
        self.take_one(ways, "CastChoice", name.clone(), out, || {
            format!(
                "{name} can't be played right now: no land drop left, too little mana, or nothing \
                 it could target. Right-click it to put it down by hand."
            )
        })
    }

    /// The rules only: a permanent's one activated ability, a question about which, or a
    /// refusal.
    fn activate(&mut self, id: ObjectId, out: &mut Vec<PlaytestHappened>) -> Result<(), String> {
        let name = self.own(id)?.name.clone();
        let ways: Vec<GameAction> = self
            .answers()
            .into_iter()
            .filter(|a| {
                !matches!(
                    a,
                    GameAction::PassPriority
                        | GameAction::PlayLand { .. }
                        | GameAction::CastSpell { .. }
                ) && names_source(a, id)
            })
            .collect();
        self.take_one(ways, "AbilityChoice", name.clone(), out, || {
            format!("{name} has no ability you can activate right now.")
        })
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

    /// The goldfish's hand on a table, on the reader's own cards: no cost, no trigger.
    fn sandbox(
        &mut self,
        action: PlaytestAction,
        out: &mut Vec<PlaytestHappened>,
    ) -> Result<(), String> {
        match action {
            PlaytestAction::Move { id, to } => self.put(ObjectId(id), to, out),
            PlaytestAction::Tap { ids, tapped } => {
                let mut name = String::new();
                let mut count = 0;
                for id in ids {
                    let id = ObjectId(id);
                    let obj = self.own(id)?;
                    if obj.tapped == tapped {
                        continue;
                    }
                    name = obj.name.clone();
                    self.debug(DebugAction::SetTapped {
                        object_id: id,
                        tapped,
                    })?;
                    count += 1;
                }
                if count > 0 {
                    out.push(PlaytestHappened::Tapped {
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
                let name = self.own(id)?.name.clone();
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
                    name,
                    kind: counter_type.display_phrase().into_owned(),
                    count,
                });
                Ok(())
            }
            PlaytestAction::TokenCopy { id } => {
                let id = ObjectId(id);
                let name = self.own(id)?.name.clone();
                self.debug(DebugAction::CreateTokenCopy {
                    source_id: id,
                    owner: YOU,
                    count: 1,
                    nonlegendary: false,
                })?;
                out.push(PlaytestHappened::TokensCreated {
                    seat: Seat::You,
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
                    seat: Seat::You,
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
                            seat: Seat::You,
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
                                seat: Seat::You,
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
                let player = match seat {
                    Seat::You => YOU,
                    Seat::Opponent => AI,
                };
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

    /// Put one of the reader's cards somewhere by hand: no cost, no trigger, no replacement.
    fn put(
        &mut self,
        id: ObjectId,
        to: Place,
        out: &mut Vec<PlaytestHappened>,
    ) -> Result<(), String> {
        let obj = self.own(id)?;
        let from = place_of(obj.zone).ok_or(NOT_IN_GAME)?;
        if from == to && !matches!(to, Place::LibraryTop | Place::LibraryBottom) {
            return Ok(());
        }
        let name = obj.name.clone();
        let is_token = obj.is_token;
        if to == Place::Command && !self.commanders.contains(&(YOU, name.clone())) {
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
        out.push(PlaytestHappened::Put { name, from, to });
        Ok(())
    }

    // ── Playing on ────────────────────────────────────────────────────────────────────────

    /// Play on until the reader next decides: the AI takes every decision of its own, and the
    /// reader's priority is passed for them except where `stops_here` says otherwise. While the
    /// reader ends a turn (`ending`), their main phases are passed and they declare no attackers.
    fn advance(&mut self, out: &mut Vec<PlaytestHappened>) -> Result<(), String> {
        for _ in 0..STEP_LIMIT {
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
                    seat: seat_of(s.active_player),
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

    /// A replay frame of the table now, with the facts since `from`, when there are any.
    fn frame(&mut self, from: usize, out: &[PlaytestHappened]) {
        if out.len() > from && self.frames.len() < FRAME_LIMIT {
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
            if out.len() > from && self.frames.len() < FRAME_LIMIT {
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

    /// One of the reader's own objects — the only ones the board acts on.
    fn own(&self, id: ObjectId) -> Result<&engine::game::GameObject, String> {
        self.state
            .objects
            .get(&id)
            .filter(|o| o.owner == YOU || o.controller == YOU)
            .ok_or_else(|| NOT_IN_GAME.to_string())
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

    /// Tests only: put a card of `seat`'s from its library onto the battlefield, as if it had
    /// been played — the AI cannot be told what to cast.
    #[cfg(test)]
    pub(super) fn put_for_test(&mut self, seat: Seat, name: &str) {
        let player = if seat == Seat::You { YOU } else { AI };
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

    fn checkpoint(&self) -> Checkpoint {
        Checkpoint {
            state: self.state.clone(),
            printings: self.printings.clone(),
            mulligans: self.mulligans,
            rng: self.rng.clone(),
        }
    }

    fn restore(&mut self, checkpoint: Checkpoint) {
        self.state = checkpoint.state;
        self.printings = checkpoint.printings;
        self.mulligans = checkpoint.mulligans;
        self.rng = checkpoint.rng;
    }
}

fn seat_of(player: PlayerId) -> Seat {
    if player == YOU {
        Seat::You
    } else {
        Seat::Opponent
    }
}

/// A pick's answer: the cards, as `SelectTargets` when the question takes targets (`pick`'s
/// second value), else `SelectCards`.
fn pick_answer(ids: Vec<u64>, targets: bool) -> GameAction {
    if targets {
        GameAction::SelectTargets {
            targets: ids
                .into_iter()
                .map(|id| TargetRef::Object(ObjectId(id)))
                .collect(),
        }
    } else {
        GameAction::SelectCards {
            cards: ids.into_iter().map(ObjectId).collect(),
        }
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
fn collect_refs(value: &Value, ids: &mut Vec<ObjectId>, players: &mut Vec<Seat>) {
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
/// them, which names the objects they point at. The opponent's draws are told without the card.
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
                if from_place == to_place || (*from == Zone::Hand && lands.contains(object_id)) {
                    continue;
                }
                let owner = state
                    .objects
                    .get(object_id)
                    .map_or(record.controller, |o| o.owner);
                let whose = seat_of(owner);
                let hidden = whose == Seat::Opponent;
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
            GameEvent::AttackersDeclared { attacker_ids, .. } => {
                let names: Vec<String> = attacker_ids.iter().filter_map(name).collect();
                if let (Some(first), false) = (attacker_ids.first(), names.is_empty()) {
                    out.push(PlaytestHappened::Attacked {
                        seat: seat(first).unwrap_or(Seat::Opponent),
                        names,
                    });
                }
            }
            GameEvent::BlockersDeclared { assignments } => {
                for (blocker, attacker) in assignments {
                    if let (Some(b), Some(a)) = (name(blocker), name(attacker)) {
                        out.push(PlaytestHappened::Blocked {
                            seat: seat(blocker).unwrap_or(Seat::You),
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
                let whose = seat(object_id).unwrap_or(Seat::You);
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
