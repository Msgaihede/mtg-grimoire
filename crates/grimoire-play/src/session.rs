//! One goldfish game: the reader's deck against a seat that does nothing.
//!
//! **The engine owns the game; the board owns the table.** Everything here is phase.rs's
//! `GameState`, moved by phase's own actions — the rules ones (`PlayLand`, `CastSpell`,
//! `MulliganDecision`, priority) where a goldfish board plays by the rules, and its sandbox ones
//! (`DebugAction`: move to any zone, tap, counters, tokens, life) where a hand on a table would
//! just do the thing. Which is which is the owner's choice of 2026-10-12, the *hybrid* model:
//!
//! - **By the rules**: the opening hand (the London mulligan and Commander's free first one),
//!   playing a land, casting a spell from untapped mana, commander tax, the turn (untap, upkeep,
//!   draw, and the cleanup step's discard to hand size, which the reader chooses), every card's
//!   P/T with its counters, and the mana a board has open.
//! - **By hand**: a drag to any zone, a tap, a counter, a token, a life total, a draw or mill
//!   outside the draw step — and a play the rules refuse. A card the reader double-clicks when it
//!   cannot be paid for, or that would ask a question the board has no prompt for (a target, a
//!   "may", a mode), is put where it would have gone, unpaid, and says so (`Happened::Put`).
//!
//! **The checkpoint is what makes the fallback honest.** `GameState` is persistent (`im`), so a
//! clone is cheap: a rules play runs on the real state and, the moment the engine asks the reader
//! anything but "pass?", the state is put back as it was and the card is placed by hand instead —
//! the game never holds half a cast.
//!
//! **The goldfish never loses, and neither does the reader**: a command-zone emblem with "you
//! can't lose the game" (CR 104.3b, no `affected` — every player) is granted at the start, so a
//! life total the reader sets to 0 is a number on the board and not the end of the game. The
//! board says "dead on turn N"; the game goes on until the reader starts another.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use engine::ai_support::legal_actions;
use engine::game::commander::commander_tax;
use engine::game::effects::create_emblem::grant_emblem;
use engine::game::engine::apply;
use engine::game::mana_sources::max_mana_yield;
use engine::game::token_presets::known_token_presets;
use engine::game::turn_control::authorized_submitters;
use engine::game::{
    install_card_db, load_and_hydrate_decks, resolve_deck_list, start_game_with_starting_player,
    DeckList, PlayerDeckList,
};
use engine::types::ability::LibraryPosition;
use engine::types::actions::{DebugAction, DebugTokenRequest, GameAction, MulliganChoice};
use engine::types::card_type::CoreType;
use engine::types::format::FormatConfig;
use engine::types::game_state::{MulliganDecisionPhase, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::types::phase::Phase;
use engine::types::statics::StaticMode;
use engine::types::zones::Zone;
use engine::types::StaticDefinition;
use engine::types::{parse_counter_type, GameState, PlayerId};

use crate::cards::{self, CardFacts};
use crate::view::{
    CardCounter, GameCard, GoldfishAction, GoldfishStep, GoldfishView, Happened, Lane,
    MulliganView, Place, Seat, Stage, TokenOffer,
};

const YOU: PlayerId = PlayerId(0);
const FISH: PlayerId = PlayerId(1);

/// The goldfish's library: a card that does nothing, enough of them that it never runs out in
/// a game anyone plays (it draws one a turn and never plays one).
const FISH_CARD: &str = "Goldfish Scale";
const FISH_LIBRARY: usize = 200;

/// How many engine steps one action may take before the session gives up on it. A step is one
/// action applied (a pass, a declaration); a whole turn cycle — the reader's end step, the
/// goldfish's turn, the reader's untap to main phase — is a few dozen. The bound is what stops a
/// loop in the engine (or here) from hanging the board, and is never reached by a game.
const STEP_LIMIT: usize = 2000;

/// What the board cannot do with a game: one sentence each, shown as it is.
const NOT_IN_GAME: &str = "That card is no longer where it was. The board has been refreshed.";
const NOT_NOW: &str = "Keep or mulligan the opening hand first.";
const ALREADY_KEPT: &str = "The opening hand has already been kept.";
const DISCARD_FIRST: &str = "Discard down to your hand size first.";
const NOTHING_TO_DISCARD: &str = "There is nothing to discard.";

pub struct Goldfish {
    state: GameState,
    /// The printing each of the reader's cards is drawn by. Kept per object and carried across
    /// a zone change by name, since a moved card is a new object (CR 400.7).
    printings: HashMap<ObjectId, String>,
    /// The printing a card name is drawn by when an object has none of its own (a copy, a card
    /// the engine made): the deck's first printing of that name.
    by_name: HashMap<String, String>,
    commanders: HashSet<String>,
    /// The emblem that keeps the game going at 0 life; never shown.
    rule: Option<ObjectId>,
    turn: u32,
    mulligans: u8,
    tokens: Vec<TokenOffer>,
}

impl Goldfish {
    /// A new game of `cards` (the deck as it stands), with the opening hand drawn. `seed` is the
    /// shuffle: the same seed and deck give the same game.
    pub fn new(cards: &[CardFacts], seed: u64) -> Result<Self, String> {
        let fish = cards::synthetic(FISH_CARD, "Land", "");
        let db = Arc::new(cards::database(cards, &[fish])?);

        let mut main = Vec::new();
        let mut commander = Vec::new();
        let mut by_name = HashMap::new();
        let mut commanders = HashSet::new();
        for card in cards {
            let name = cards::engine_name(card);
            if db.get_face_by_name(&name).is_none() {
                continue;
            }
            by_name
                .entry(name.clone())
                .or_insert_with(|| card.card_id.clone());
            let pile = if card.commander {
                &mut commander
            } else {
                &mut main
            };
            if card.commander {
                commanders.insert(name.clone());
            }
            pile.extend(std::iter::repeat_n(name, card.quantity as usize));
        }
        if main.is_empty() {
            return Err("This deck has no cards to shuffle into a library.".into());
        }

        let format = if commander.is_empty() {
            FormatConfig::freeform()
        } else {
            FormatConfig::commander()
        };
        let mut state = GameState::new(format, 2, seed);
        // The sandbox half of the board is phase's debug actions, which the engine refuses
        // unless the game allows them and the player is on the list (engine-wasm does the same).
        state.debug_mode = true;
        state.debug_permitted.insert(YOU);

        let list = DeckList {
            player: PlayerDeckList {
                main_deck: main,
                commander,
                ..PlayerDeckList::default()
            },
            opponent: PlayerDeckList {
                main_deck: vec![FISH_CARD.to_string(); FISH_LIBRARY],
                ..PlayerDeckList::default()
            },
            ..DeckList::default()
        };
        let payload = resolve_deck_list(&db, &list);
        load_and_hydrate_decks(&mut state, &payload, Some(&db));
        state.all_card_names = db.card_names().into();
        install_card_db(&mut state, Arc::clone(&db));

        // CR 104.3b: no `affected`, so it reaches every player (`sba::static_affects_player`).
        let rule = grant_emblem(
            &mut state,
            FISH,
            vec![StaticDefinition::new(StaticMode::CantLoseTheGame)],
            Vec::new(),
            Vec::new(),
        );

        let deck_names: HashSet<&str> = by_name.keys().map(String::as_str).collect();
        let mut tokens: Vec<TokenOffer> = known_token_presets()
            .iter()
            .filter_map(|preset| {
                let source = preset
                    .source_card_names
                    .iter()
                    .find(|n| deck_names.contains(n.as_str()))?;
                Some(TokenOffer {
                    preset: preset.id.clone(),
                    name: preset.body.display_name.clone(),
                    source: source.clone(),
                    card_id: preset
                        .token_image_ref
                        .as_ref()
                        .map(|r| r.scryfall_id.clone()),
                })
            })
            .collect();
        tokens.sort_by(|a, b| a.name.cmp(&b.name).then(a.source.cmp(&b.source)));
        tokens.dedup_by(|a, b| a.name == b.name && a.source == b.source);

        let mut game = Goldfish {
            state,
            printings: HashMap::new(),
            by_name,
            commanders,
            rule: Some(rule),
            turn: 0,
            mulligans: 0,
            tokens,
        };
        game.assign_printings(cards);
        start_game_with_starting_player(&mut game.state, YOU);
        game.settle(&mut Vec::new())?;
        Ok(game)
    }

    /// Each of the reader's objects gets a printing: the deck's entries handed out by name, so
    /// a deck of two Forest arts shows both.
    fn assign_printings(&mut self, cards: &[CardFacts]) {
        let mut queue: HashMap<String, Vec<String>> = HashMap::new();
        for card in cards {
            let name = cards::engine_name(card);
            let ids = queue.entry(name).or_default();
            ids.extend(std::iter::repeat_n(
                card.card_id.clone(),
                card.quantity as usize,
            ));
        }
        let mut ids: Vec<ObjectId> = self
            .state
            .objects
            .iter()
            .filter(|(_, o)| o.owner == YOU)
            .map(|(id, _)| *id)
            .collect();
        ids.sort();
        for id in ids {
            let name = self.state.objects[&id].name.clone();
            if let Some(list) = queue.get_mut(&name) {
                if let Some(printing) = list.pop() {
                    self.printings.insert(id, printing);
                }
            }
        }
    }

    // ── The view ──────────────────────────────────────────────────────────────────────────

    pub fn view(&self) -> GoldfishView {
        let s = &self.state;
        let you = &s.players[YOU.0 as usize];
        let fish = &s.players[FISH.0 as usize];
        let cards = |ids: &mut dyn Iterator<Item = &ObjectId>| -> Vec<GameCard> {
            ids.filter_map(|id| self.card(*id)).collect()
        };
        let battlefield: Vec<GameCard> = cards(
            &mut s
                .battlefield
                .iter()
                .filter(|id| s.objects.get(id).is_some_and(|o| o.controller == YOU)),
        );
        let mana_open = s
            .battlefield
            .iter()
            .map(|id| max_mana_yield(s, *id, YOU))
            .sum();
        let library_lands = you
            .library
            .iter()
            .filter(|id| {
                s.objects
                    .get(id)
                    .is_some_and(|o| o.card_types.core_types.contains(&CoreType::Land))
            })
            .count() as u32;
        GoldfishView {
            stage: self.stage(),
            turn: self.turn,
            mulligan: self.mulligan(),
            discard: self.discard_owed() as u32,
            life: you.life,
            opponent_life: fish.life,
            hand: cards(&mut you.hand.iter()),
            battlefield,
            graveyard: cards(&mut you.graveyard.iter()),
            exile: cards(
                &mut s
                    .exile
                    .iter()
                    .filter(|id| s.objects.get(id).is_some_and(|o| o.owner == YOU)),
            ),
            command: cards(&mut s.command_zone.iter().filter(|id| {
                Some(**id) != self.rule
                    && s.objects
                        .get(id)
                        .is_some_and(|o| o.owner == YOU && !o.is_emblem)
            })),
            library: you.library.len() as u32,
            // phase's library is a vector whose **front is the top** (`DrawCards` takes from it).
            library_cards: cards(&mut you.library.iter()),
            library_lands,
            mana_open,
            tokens: self.tokens.clone(),
        }
    }

    fn stage(&self) -> Stage {
        match self.state.waiting_for {
            WaitingFor::MulliganDecision { .. } | WaitingFor::OpeningHandBottomCards { .. } => {
                Stage::Mulligan
            }
            WaitingFor::DiscardToHandSize { player, .. } if player == YOU => Stage::Discard,
            _ => Stage::Playing,
        }
    }

    /// How many cards the reader's cleanup step is waiting for them to discard; 0 when it is not.
    fn discard_owed(&self) -> usize {
        match self.state.waiting_for {
            WaitingFor::DiscardToHandSize { player, count, .. } if player == YOU => count,
            _ => 0,
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

    fn card(&self, id: ObjectId) -> Option<GameCard> {
        let o = self.state.objects.get(&id)?;
        let core = &o.card_types.core_types;
        let is_creature = core.contains(&CoreType::Creature);
        let is_land = core.contains(&CoreType::Land);
        let lane = if is_creature {
            Lane::Creature
        } else if is_land {
            Lane::Land
        } else {
            Lane::Other
        };
        let card_id = self
            .printings
            .get(&id)
            .cloned()
            .or_else(|| o.token_image_ref.as_ref().map(|r| r.scryfall_id.clone()))
            .or_else(|| self.by_name.get(&o.name).cloned());
        let mut counters: Vec<CardCounter> = o
            .counters
            .iter()
            .filter(|(_, n)| **n > 0)
            .map(|(kind, n)| CardCounter {
                kind: kind.display_phrase().into_owned(),
                count: *n,
            })
            .collect();
        counters.sort_by(|a, b| a.kind.cmp(&b.kind));
        let is_commander = self.commanders.contains(&o.name) && !o.is_token;
        Some(GameCard {
            id: id.0,
            card_id,
            name: o.name.clone(),
            type_line: type_line(o),
            lane,
            mana_value: o.mana_cost.mana_value(),
            is_land,
            is_token: o.is_token,
            is_commander,
            tapped: o.tapped,
            counters,
            power: if is_creature { o.power } else { None },
            toughness: if is_creature { o.toughness } else { None },
            tax: if is_commander {
                commander_tax(&self.state, id)
            } else {
                0
            },
        })
    }

    // ── Actions ───────────────────────────────────────────────────────────────────────────

    /// Do what the board asked, and answer with the board after it. A refusal is one sentence
    /// and leaves the game exactly as it was.
    pub fn act(&mut self, action: GoldfishAction) -> Result<GoldfishStep, String> {
        let checkpoint = self.clone_state();
        let mut happened = Vec::new();
        match self.run(action, &mut happened) {
            Ok(()) => Ok(GoldfishStep {
                view: self.view(),
                happened,
            }),
            Err(e) => {
                self.restore(checkpoint);
                Err(e)
            }
        }
    }

    fn run(&mut self, action: GoldfishAction, out: &mut Vec<Happened>) -> Result<(), String> {
        let mulliganing = self.stage() == Stage::Mulligan;
        match action {
            GoldfishAction::Mulligan => {
                if !mulliganing {
                    return Err(ALREADY_KEPT.into());
                }
                self.apply(
                    YOU,
                    GameAction::MulliganDecision {
                        choice: MulliganChoice::Mulligan,
                    },
                )?;
                self.mulligans = self.mulligans.saturating_add(1);
                self.settle_mulligan()?;
                out.push(Happened::Mulliganed {
                    mulligans: self.mulligans,
                });
            }
            GoldfishAction::Keep { bottom } => {
                if !mulliganing {
                    return Err(ALREADY_KEPT.into());
                }
                let owed = self.mulligan().map_or(0, |m| m.bottom) as usize;
                if bottom.len() != owed {
                    return Err(format!(
                        "Pick {owed} card{} to put on the bottom first.",
                        if owed == 1 { "" } else { "s" }
                    ));
                }
                let hand: HashSet<u64> = self.you().hand.iter().map(|id| id.0).collect();
                if bottom.iter().any(|id| !hand.contains(id)) {
                    return Err(NOT_IN_GAME.into());
                }
                self.apply(
                    YOU,
                    GameAction::MulliganDecision {
                        choice: MulliganChoice::Keep,
                    },
                )?;
                if owed > 0 {
                    let cards = bottom.iter().map(|id| ObjectId(*id)).collect();
                    self.apply(YOU, GameAction::SelectCards { cards })?;
                }
                let size = self.you().hand.len() as u32;
                self.settle(out)?;
                out.insert(
                    0,
                    Happened::Kept {
                        size,
                        bottomed: owed as u32,
                    },
                );
            }
            _ if mulliganing => return Err(NOT_NOW.into()),
            GoldfishAction::Discard { ids } => self.discard(ids, out)?,
            _ if self.stage() == Stage::Discard => return Err(DISCARD_FIRST.into()),
            GoldfishAction::Play { id } => self.play(ObjectId(id), out)?,
            GoldfishAction::Move { id, to } => self.put(ObjectId(id), to, out)?,
            GoldfishAction::Tap { ids, tapped } => {
                let mut name = String::new();
                let mut count = 0;
                for id in ids {
                    let id = ObjectId(id);
                    let obj = self.object(id)?;
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
                    out.push(Happened::Tapped {
                        name,
                        count,
                        tapped,
                    });
                }
            }
            GoldfishAction::UntapAll => {
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
                out.push(Happened::UntappedAll);
            }
            GoldfishAction::Counters { id, kind, delta } => {
                let id = ObjectId(id);
                let name = self.object(id)?.name.clone();
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
                out.push(Happened::Counters {
                    name,
                    kind: counter_type.display_phrase().into_owned(),
                    count,
                });
                self.settle(out)?;
            }
            GoldfishAction::TokenCopy { id } => {
                let id = ObjectId(id);
                let name = self.object(id)?.name.clone();
                self.debug(DebugAction::CreateTokenCopy {
                    source_id: id,
                    owner: YOU,
                    count: 1,
                    nonlegendary: false,
                })?;
                out.push(Happened::TokensCreated { name, count: 1 });
                self.settle(out)?;
            }
            GoldfishAction::CreateToken { preset, count } => {
                let offer = self
                    .tokens
                    .iter()
                    .find(|t| t.preset == preset)
                    .ok_or("This deck makes no such token.")?
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
                out.push(Happened::TokensCreated {
                    name: offer.name,
                    count,
                });
                self.settle(out)?;
            }
            GoldfishAction::Draw { count } => {
                let before = self.zones();
                self.debug(DebugAction::DrawCards {
                    player_id: YOU,
                    count: count.clamp(1, 99),
                })?;
                self.report_moves(&before, None, out);
            }
            GoldfishAction::Mill { count } => {
                let before = self.zones();
                self.debug(DebugAction::Mill {
                    player_id: YOU,
                    count: count.clamp(1, 99),
                })?;
                self.report_moves(&before, None, out);
            }
            GoldfishAction::Shuffle => {
                self.debug(DebugAction::ShuffleLibrary { player_id: YOU })?;
                out.push(Happened::Shuffled);
            }
            GoldfishAction::SetLife { seat, life } => {
                let player = match seat {
                    Seat::You => YOU,
                    Seat::Opponent => FISH,
                };
                let was = self.state.players[player.0 as usize].life;
                let life = life.clamp(-999, 9999);
                self.debug(DebugAction::SetLife {
                    player_id: player,
                    life,
                })?;
                out.push(Happened::LifeSet { seat, life, was });
            }
            GoldfishAction::NextTurn => self.next_turn(out)?,
        }
        Ok(())
    }

    /// The rules first: a land drop or a paid cast. Then by hand.
    fn play(&mut self, id: ObjectId, out: &mut Vec<Happened>) -> Result<(), String> {
        let obj = self.object(id)?;
        let from = place_of(obj.zone).ok_or(NOT_IN_GAME)?;
        if !matches!(from, Place::Hand | Place::Command) {
            return self.put(id, Place::Battlefield, out);
        }
        let name = obj.name.clone();
        let is_land = obj.card_types.core_types.contains(&CoreType::Land);
        let is_permanent = is_permanent(obj);

        // phase lists a cast once per way to make it — one row a target, a mode. One row is a
        // play with nothing to decide; two or more are a choice the board has no prompt for, and
        // taking the first would be choosing for the reader, so it is placed by hand instead.
        let mut ways = legal_actions(&self.state).into_iter().filter(|a| match a {
            GameAction::PlayLand { object_id, .. } => *object_id == id,
            GameAction::CastSpell { object_id, .. } => *object_id == id,
            _ => false,
        });
        let legal = match (ways.next(), ways.next()) {
            (Some(only), None) => Some(only),
            _ => None,
        };
        if let Some(action) = legal {
            let checkpoint = self.clone_state();
            let printing = self.printings.get(&id).cloned();
            let before = self.zones();
            let land = matches!(action, GameAction::PlayLand { .. });
            if self.apply(YOU, action).is_ok() && self.resolve_stack().is_ok() {
                if let Some(printing) = printing {
                    self.carry_printing(&name, printing);
                }
                out.push(if land {
                    Happened::Played { name: name.clone() }
                } else {
                    Happened::Cast {
                        name: name.clone(),
                        from,
                    }
                });
                self.report_moves(&before, Some(&name), out);
                return Ok(());
            }
            self.restore(checkpoint);
        }
        // By hand: a permanent to the battlefield, an instant or sorcery straight to the
        // graveyard (it was "cast" and is done). A land that was not the turn's land drop is a
        // land put onto the battlefield, which is what the reader did.
        let to = if is_permanent || is_land {
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

    /// Put a card somewhere by hand: no cost, no trigger, no replacement (`simulate: false`).
    fn put(&mut self, id: ObjectId, to: Place, out: &mut Vec<Happened>) -> Result<(), String> {
        let obj = self.object(id)?;
        let from = place_of(obj.zone).ok_or(NOT_IN_GAME)?;
        if from == to && !matches!(to, Place::LibraryTop | Place::LibraryBottom) {
            return Ok(());
        }
        let name = obj.name.clone();
        let is_token = obj.is_token;
        let printing = self.printings.get(&id).cloned();
        let (zone, position) = match to {
            Place::Hand => (Zone::Hand, None),
            Place::Battlefield => (Zone::Battlefield, None),
            Place::Graveyard => (Zone::Graveyard, None),
            Place::Exile => (Zone::Exile, None),
            Place::Command => (Zone::Command, None),
            Place::LibraryTop => (Zone::Library, Some(LibraryPosition::Top)),
            Place::LibraryBottom => (Zone::Library, Some(LibraryPosition::Bottom)),
        };
        if to == Place::Command && !self.commanders.contains(&name) {
            return Err(format!(
                "Only a commander goes to the command zone, and {name} is not one."
            ));
        }
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
            if let Some(printing) = printing {
                self.carry_printing(&name, printing);
            }
        }
        out.push(Happened::Put { name, from, to });
        Ok(())
    }

    /// CR 400.7: a card that changed zone is a new object. The printing it was drawn with goes
    /// with it — found as the one object of its name that has none.
    fn carry_printing(&mut self, name: &str, printing: String) {
        self.printings
            .retain(|id, _| self.state.objects.contains_key(id));
        let orphan = self
            .state
            .objects
            .iter()
            .filter(|(id, o)| o.owner == YOU && o.name == name && !self.printings.contains_key(*id))
            .map(|(id, _)| *id)
            .max();
        if let Some(id) = orphan {
            self.printings.insert(id, printing);
        }
    }

    /// The cleanup step's discard, the reader's choice of it, and then on to their next turn.
    fn discard(&mut self, ids: Vec<u64>, out: &mut Vec<Happened>) -> Result<(), String> {
        let owed = self.discard_owed();
        if owed == 0 {
            return Err(NOTHING_TO_DISCARD.into());
        }
        let picked: HashSet<u64> = ids.iter().copied().collect();
        if picked.len() != owed || ids.len() != owed {
            return Err(format!(
                "Pick {owed} card{} to discard first.",
                if owed == 1 { "" } else { "s" }
            ));
        }
        let hand: HashSet<u64> = self.you().hand.iter().map(|id| id.0).collect();
        if !picked.is_subset(&hand) {
            return Err(NOT_IN_GAME.into());
        }
        let cards: Vec<ObjectId> = ids.into_iter().map(ObjectId).collect();
        let printings: Vec<(String, String)> = cards
            .iter()
            .filter_map(|id| {
                let name = self.state.objects.get(id)?.name.clone();
                Some((name, self.printings.get(id)?.clone()))
            })
            .collect();
        let before = self.zones();
        self.apply(YOU, GameAction::SelectCards { cards })?;
        for (name, printing) in printings {
            self.carry_printing(&name, printing);
        }
        // Said before the turn that follows, so the log reads in the order it happened.
        self.report_moves(&before, None, out);
        self.next_turn(out)
    }

    /// The reader's next turn, through the goldfish's: pass until it is the reader's main phase
    /// again, a turn later — or until the reader's cleanup step asks which cards they discard
    /// (`Stage::Discard`), the one question a passing turn stops for. `discard` picks it up from
    /// there: the turn is the same one, so it runs on to the same place.
    fn next_turn(&mut self, out: &mut Vec<Happened>) -> Result<(), String> {
        let before = self.zones();
        let from_turn = self.state.turn_number;
        for _ in 0..STEP_LIMIT {
            if self.stage() == Stage::Discard {
                self.report_moves(&before, None, out);
                return Ok(());
            }
            if self.state.turn_number > from_turn && self.at_home() {
                self.turn += 1;
                out.push(Happened::TurnBegan { turn: self.turn });
                self.report_moves(&before, None, out);
                return Ok(());
            }
            self.step(out)?;
        }
        Err("The rules engine did not reach your next turn. Start a new game.".into())
    }

    /// Answer whatever the game is waiting on, once: the goldfish's every decision, and the
    /// reader's while a turn is being passed.
    fn step(&mut self, out: &mut Vec<Happened>) -> Result<(), String> {
        let actors = authorized_submitters(&self.state);
        let actor = if actors.contains(&FISH) { FISH } else { YOU };
        let action = match &self.state.waiting_for {
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
            WaitingFor::GameOver { .. } => {
                return Err("The game is over. Start a new one from the game menu.".into())
            }
            other => {
                let what = other.variant_name().to_string();
                let first = legal_actions(&self.state)
                    .into_iter()
                    .next()
                    .ok_or_else(|| format!("The rules engine is stuck at {what}."))?;
                if actor == YOU {
                    out.push(Happened::Chose { what });
                }
                first
            }
        };
        self.apply(actor, action)
    }

    /// After a cast: pass priority until the stack is empty, both seats passing. A question the
    /// reader would have to answer is an `Err`, which `play` takes back.
    fn resolve_stack(&mut self) -> Result<(), String> {
        for _ in 0..STEP_LIMIT {
            if self.state.stack.is_empty() && self.reader_has_priority() {
                return Ok(());
            }
            let actors = authorized_submitters(&self.state);
            if actors.contains(&FISH) {
                self.step(&mut Vec::new())?;
                continue;
            }
            match self.state.waiting_for {
                WaitingFor::Priority { .. } => self.apply(YOU, GameAction::PassPriority)?,
                _ => return Err("asks a question".into()),
            }
        }
        Err("did not resolve".into())
    }

    /// From the start of the game, after the keep: on to the reader's first main phase.
    fn settle(&mut self, out: &mut Vec<Happened>) -> Result<(), String> {
        if self.stage() == Stage::Mulligan {
            return self.settle_mulligan();
        }
        if self.turn == 0 {
            for _ in 0..STEP_LIMIT {
                if self.at_home() {
                    self.turn = 1;
                    return Ok(());
                }
                self.step(out)?;
            }
            return Err("The rules engine did not reach your first turn.".into());
        }
        // Mid-turn: something the reader did by hand (a token, a counter) put a trigger on the
        // stack. It resolves as the rules have it; a question it asks takes the engine's first
        // answer and says so (`Happened::Chose`), since the thing that caused it is already done
        // and cannot be taken back the way a cast can.
        for _ in 0..STEP_LIMIT {
            if self.state.stack.is_empty() && self.reader_has_priority() {
                return Ok(());
            }
            self.step(out)?;
        }
        Err("The rules engine did not settle after that. Start a new game.".into())
    }

    /// The goldfish keeps its seven at once, so the opening hand only ever waits on the reader.
    fn settle_mulligan(&mut self) -> Result<(), String> {
        for _ in 0..16 {
            if !authorized_submitters(&self.state).contains(&FISH) {
                return Ok(());
            }
            self.step(&mut Vec::new())?;
        }
        Ok(())
    }

    fn at_home(&self) -> bool {
        self.state.active_player == YOU
            && self.state.phase == Phase::PreCombatMain
            && self.state.stack.is_empty()
            && self.reader_has_priority()
    }

    fn reader_has_priority(&self) -> bool {
        matches!(self.state.waiting_for, WaitingFor::Priority { player } if player == YOU)
    }

    // ── What moved ────────────────────────────────────────────────────────────────────────

    /// Where each of the reader's cards is, by name and zone, to say afterwards what moved.
    fn zones(&self) -> HashMap<ObjectId, (String, Zone)> {
        self.state
            .objects
            .iter()
            .filter(|(id, o)| o.owner == YOU && Some(**id) != self.rule)
            .map(|(id, o)| (*id, (o.name.clone(), o.zone)))
            .collect()
    }

    /// Every card of the reader's that is somewhere new, as `Moved` — what the engine did by
    /// itself. A card leaving a zone is a new object (CR 400.7), so a move is found by name:
    /// one of a name gone from a zone and one of it arrived in another.
    fn report_moves(
        &self,
        before: &HashMap<ObjectId, (String, Zone)>,
        skip: Option<&str>,
        out: &mut Vec<Happened>,
    ) {
        let after = self.zones();
        let mut gone: Vec<(String, Zone)> = before
            .iter()
            .filter(|(id, (_, zone))| after.get(id).is_none_or(|(_, z)| z != zone))
            .map(|(_, v)| v.clone())
            .collect();
        let mut arrived: Vec<(ObjectId, String, Zone)> = after
            .iter()
            .filter(|(id, (_, zone))| before.get(id).is_none_or(|(_, z)| z != zone))
            .map(|(id, (n, z))| (*id, n.clone(), *z))
            .collect();
        arrived.sort_by_key(|(id, _, _)| *id);
        let mut skipped = false;
        for (_, name, to) in arrived {
            let Some(at) = gone.iter().position(|(n, _)| *n == name) else {
                continue;
            };
            let (_, from) = gone.remove(at);
            if !skipped && skip == Some(name.as_str()) {
                skipped = true;
                continue;
            }
            if let (Some(from), Some(to)) = (place_of(from), place_of(to)) {
                if from != to {
                    out.push(Happened::Moved { name, from, to });
                }
            }
        }
    }

    // ── Plumbing ──────────────────────────────────────────────────────────────────────────

    fn you(&self) -> &engine::types::player::Player {
        &self.state.players[YOU.0 as usize]
    }

    fn object(&self, id: ObjectId) -> Result<&engine::game::GameObject, String> {
        self.state
            .objects
            .get(&id)
            .filter(|o| o.owner == YOU || o.controller == YOU)
            .ok_or_else(|| NOT_IN_GAME.to_string())
    }

    fn apply(&mut self, actor: PlayerId, action: GameAction) -> Result<(), String> {
        apply(&mut self.state, actor, action)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn debug(&mut self, action: DebugAction) -> Result<(), String> {
        self.apply(YOU, GameAction::Debug(action))
    }

    fn clone_state(&self) -> (GameState, HashMap<ObjectId, String>, u32) {
        (self.state.clone(), self.printings.clone(), self.turn)
    }

    fn restore(&mut self, (state, printings, turn): (GameState, HashMap<ObjectId, String>, u32)) {
        self.state = state;
        self.printings = printings;
        self.turn = turn;
    }
}

fn place_of(zone: Zone) -> Option<Place> {
    Some(match zone {
        Zone::Hand => Place::Hand,
        Zone::Battlefield => Place::Battlefield,
        Zone::Graveyard => Place::Graveyard,
        Zone::Exile => Place::Exile,
        Zone::Command => Place::Command,
        Zone::Library => Place::LibraryTop,
        Zone::Stack => return None,
    })
}

fn is_permanent(o: &engine::game::GameObject) -> bool {
    o.card_types.core_types.iter().any(|t| {
        matches!(
            t,
            CoreType::Artifact
                | CoreType::Creature
                | CoreType::Enchantment
                | CoreType::Land
                | CoreType::Planeswalker
                | CoreType::Battle
        )
    })
}

/// The type line as printed: `Legendary Creature — Elf Druid`.
fn type_line(o: &engine::game::GameObject) -> String {
    let t = &o.card_types;
    let mut left: Vec<String> = t.supertypes.iter().map(|s| s.to_string()).collect();
    left.extend(t.core_types.iter().map(|c| c.to_string()));
    if o.is_token {
        left.insert(0, "Token".into());
    }
    let left = left.join(" ");
    if t.subtypes.is_empty() {
        left
    } else {
        format!("{left} — {}", t.subtypes.join(" "))
    }
}
