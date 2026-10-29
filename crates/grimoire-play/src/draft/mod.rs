//! One draft, over phase.rs's `draft-core`: boosters passed around a table of people and bots,
//! picked one card at a time (two in a Commander draft), three rounds; six boosters straight into
//! a sealed pool; or a Winston draft, every booster shuffled into one face-down stack dealt into
//! three piles that each turn takes or declines.
//!
//! **The page makes the boosters** (`packages/ui/features/draft/booster/`, the one collation for
//! Packs and Draft) and hands them over as printing ids (`DraftSetup::packs`). `SetupPacks`, our
//! own `PackSource`, hands phase's reducer exactly those: a card instance's id is
//! `"{card_id}#{seat}.{round}.{index}"`, so any app — a guest's in a pod too — finds the printing
//! in its own corpus. phase's reducer is the authority on passing, rounds and what a pick may
//! name; this module seats the table, lets the bots pick, and reads the view off the session.
//!
//! Modes → phase's kinds: `quick` and `cube` are `DraftKind::Quick` (a set source, or a cube
//! source when a round names no set); `sealed` is `DraftKind::Sealed` (every booster into its
//! seat's pool, deckbuilding at once); `commander` is `DraftKind::CommanderDraft` (two cards a
//! pick, a 60-card deck with one commander); `winston` is `DraftKind::Winston` (phase's
//! `SharedStackPiles { pile_count: 3 }`: three boosters a seat, shuffled by phase's reducer into
//! one stack); `pod` is its `PodFormat`'s kind — `booster` `DraftKind::Premier`, `commander`
//! `CommanderDraft`, `winston` `Winston` — with `DraftSeat::Bot` in the seats no person took.
//! phase's procedure table bounds the table: a draft from sets seats 2 to 8, a cube 1 or more,
//! sealed 1 to 8 — phase's Sealed needs two seats, so a sealed pool of one is seated beside a
//! hidden bot with six empty boosters, which no view shows — a Commander draft 3 to 8, and a
//! Winston draft 2 to 4.
//!
//! **A Winston turn** is `winston(seat, pile, take)`, phase's `SharedStackDecision`. Its view
//! (`DraftView::stack`) is read off draft-core's own projection (`view::filter_for_player`): the
//! seat whose turn it is sees the cards of the pile it is deciding on, and nobody sees any other
//! pile's cards or the stack's — only counts. A Winston view has no pack (`pack` empty,
//! `pack_number`, `pick_number` and `pack_size` 0, `pass_left` false), `waiting` is "not your
//! turn", and a seat's `picked` is "not the seat the table waits on".
//!
//! **Bots pick as phase's own do** (`bots.rs`, ported from `draft-wasm`), after every call that
//! could hand one a pack, until no bot holds a pack it has not picked from — a completed round
//! deals the next boosters, so it is a loop. Their dice are seeded from the setup's seed and the
//! cards picked so far, so a restored draft picks as the original would have. In a Winston draft
//! every bot whose turn it is decides (`bots::winston_decision`, phase's, from its own
//! projection and no dice), turn after turn, until it is a person's turn or the draft is over.
//!
//! **Every call runs on `on_engine_stack`**, `new` and `restore` above all: the evaluating bots
//! (`Medium` and up) read a `CardDatabase` of the draft's own cards, parsed by phase's oracle
//! parser as `cards.rs` parses a deck's, and the scoring reads those faces. Tests go through it
//! too (`tests.rs`' `engine`).
//!
//! **A refused call changes nothing**: the session is kept before a pick or a replacement and put
//! back on any `Err`, the bots' picks after it included.

mod bots;
pub mod view;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};

use draft_core::pack_source::PackSource;
use draft_core::pick_pass::required_pick_count;
use draft_core::session::apply;
use draft_core::types::{
    self as dc, DeckAddableCards, DraftAction, DraftCardInstance, DraftConfig, DraftError,
    DraftKind, DraftPack, DraftSeat, DraftSession, DraftSource, PackDistribution, PassDirection,
    PodPolicy, SetLayout, SharedStackPileDecision, SharedStackRefusal, SpectatorVisibility,
    TournamentFormat, MAX_PACK_COUNT, SEALED_PACK_COUNT,
};
use draft_core::view::filter_for_player;
use engine::database::CardDatabase;
use engine::types::player::PlayerId;
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};

use crate::cards::{database, CardFacts};

pub use view::{
    DraftCard, DraftMode, DraftSaved, DraftSeatSetup, DraftSeatView, DraftSetup, DraftStatus,
    DraftView, PodFormat, WinstonPile, WinstonView,
};

const NOT_WINSTON: &str = "Only a Winston draft takes or declines a pile.";
const NO_PICK_IN_WINSTON: &str = "A Winston draft takes or declines a pile; there is no card to pick.";
const NOT_YOUR_TURN: &str = "It is not that seat's turn.";
const OVER: &str = "The draft is over.";

/// What the host knows of one printing a booster names: the card's facts, as a deck row's, and
/// the printing's own set, number and rarity, which a deck row does not carry. Rarity is what
/// the `Easy` bots pick by and a prior for the others; a `CardFacts` alone converts with all
/// three empty (the set is then the round's from `DraftSetup::pack_sets`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DraftCardFacts {
    pub card: CardFacts,
    pub set_code: String,
    pub collector_number: String,
    /// Scryfall's word: `common`, `uncommon`, `rare`, `mythic`.
    pub rarity: String,
}

impl From<CardFacts> for DraftCardFacts {
    fn from(card: CardFacts) -> Self {
        DraftCardFacts {
            card,
            ..DraftCardFacts::default()
        }
    }
}

/// The snapshot's shape. Bumped when a field changes meaning; `restore` refuses another. A
/// snapshot from before Commander and Winston drafts is still version 1: its setup has no
/// `pod_format` (serde's default, `booster`) and phase's session the same shape.
const SNAPSHOT_VERSION: u32 = 1;

/// What `snapshot` writes: the setup (its boosters dropped — the session holds every card) and
/// phase's whole session.
#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    setup: DraftSetup,
    session: DraftSession,
}

/// One draft: phase's session, the setup it was started from, and the bots' card database.
pub struct Draft {
    /// As the page sent it, less `packs`.
    setup: DraftSetup,
    session: DraftSession,
    /// The draft's own cards, parsed — only for bots that evaluate (`bots::reads_faces`), and
    /// `None` when parsing failed: the bots then fall back to colour, rarity and curve.
    db: Option<CardDatabase>,
}

impl Draft {
    /// Start a draft: `facts` holds one entry per distinct printing `setup.packs` names
    /// (`DraftSetup::card_ids`). A booster card with no facts is refused, as is a table phase's
    /// procedure cannot seat. The bots make their first picks before this answers.
    pub fn new<F: Into<DraftCardFacts>>(
        mut setup: DraftSetup,
        facts: Vec<F>,
    ) -> Result<Draft, String> {
        let facts: HashMap<String, DraftCardFacts> = facts
            .into_iter()
            .map(Into::into)
            .map(|f| (f.card.card_id.clone(), f))
            .collect();
        let seat_count = setup.seats.len();
        if seat_count == 0 {
            return Err("A draft needs at least one seat.".into());
        }
        if setup.packs.len() != seat_count {
            return Err("Every seat at the table needs its boosters.".into());
        }
        let pack_count = setup.packs[0].len();
        if pack_count == 0 || pack_count > usize::from(MAX_PACK_COUNT) {
            return Err(format!(
                "A draft opens between 1 and {MAX_PACK_COUNT} boosters a seat."
            ));
        }
        if setup.packs.iter().any(|seat| seat.len() != pack_count) {
            return Err("Every seat must open the same number of boosters.".into());
        }
        if setup
            .packs
            .iter()
            .flatten()
            .any(|booster| booster.is_empty() || booster.len() > usize::from(u8::MAX))
        {
            return Err("A booster must hold between 1 and 255 cards.".into());
        }
        if let Some(missing) = setup
            .card_ids()
            .into_iter()
            .find(|id| !facts.contains_key(id))
        {
            return Err(format!(
                "A booster names a card this app has no facts for ({missing})."
            ));
        }

        if setup.mode != DraftMode::Pod {
            setup.pod_format = PodFormat::Booster;
        }
        let kind = kind_of(setup.mode, setup.pod_format);
        let procedure = kind.procedure();
        match procedure.distribution {
            PackDistribution::AllAtOnce if pack_count != usize::from(SEALED_PACK_COUNT) => {
                return Err(format!("A sealed pool opens {SEALED_PACK_COUNT} boosters."));
            }
            PackDistribution::SharedStackPiles { .. }
                if pack_count != usize::from(procedure.packs_per_player) =>
            {
                return Err(format!(
                    "A Winston draft opens {} boosters a seat.",
                    procedure.packs_per_player
                ));
            }
            _ => {}
        }
        let source = source(&setup, kind);

        let mut seats: Vec<DraftSeat> = setup
            .seats
            .iter()
            .enumerate()
            .map(|(i, seat)| {
                if seat.bot {
                    DraftSeat::Bot {
                        name: seat.name.clone(),
                    }
                } else {
                    DraftSeat::Human {
                        player_id: PlayerId(i as u8),
                        display_name: seat.name.clone(),
                    }
                }
            })
            .collect();
        // phase's Sealed seats two at the least; the second is a bot with empty boosters.
        while kind == DraftKind::Sealed && seats.len() < usize::from(procedure.min_pod_size) {
            seats.push(DraftSeat::Bot {
                name: String::new(),
            });
        }
        let cube = matches!(source, DraftSource::Cube { .. });
        let (fewest, most) = if cube {
            (
                procedure.local_cube_min_pod_size,
                procedure.local_cube_max_pod_size,
            )
        } else {
            (procedure.min_pod_size, procedure.max_pod_size)
        };
        if seats.len() < usize::from(fewest) || seats.len() > usize::from(most) {
            return Err(format!(
                "This draft seats between {fewest} and {most}, not {seat_count}."
            ));
        }

        let config = DraftConfig {
            set_code: source.set_code(),
            source,
            kind,
            pod_size: seats.len() as u8,
            cards_per_pack: setup.packs[0][0].len() as u8,
            pack_count: pack_count as u8,
            min_deck_size: procedure.min_deck_size,
            addable_cards: DeckAddableCards::standard_basics(),
            rng_seed: u64::from(setup.seed),
            tournament_format: TournamentFormat::Swiss,
            pod_policy: if setup.mode == DraftMode::Pod {
                PodPolicy::Casual
            } else {
                PodPolicy::Competitive
            },
            spectator_visibility: SpectatorVisibility::default(),
        };
        let mut session = DraftSession::new(config, seats, "grimoire".into());
        let packs = SetupPacks {
            packs: &setup.packs,
            facts: &facts,
            pack_sets: &setup.pack_sets,
        };
        apply(&mut session, DraftAction::StartDraft, Some(&packs)).map_err(refusal)?;

        setup.packs = Vec::new();
        let cards: Vec<CardFacts> = facts.into_values().map(|f| f.card).collect();
        let db = card_database(setup.difficulty, &cards);
        let mut draft = Draft { setup, session, db };
        draft.bots_act()?;
        Ok(draft)
    }

    /// The draft from `seat`: its own pack and pool, and every seat's count.
    pub fn view(&self, seat: u8) -> DraftView {
        let session = &self.session;
        let status = self.status();
        let drafting = status == DraftStatus::Drafting;
        let winston = self.is_winston();
        let pack_count = session.config.pack_count;
        let pack_number = if winston {
            0
        } else {
            session
                .current_pack_number
                .min(pack_count.saturating_sub(1))
        };
        let waiting = drafting
            && if winston {
                !self.winston_turn(seat)
            } else {
                !self.owes_pick(seat)
            };
        let pack = if drafting && !waiting && !winston {
            self.current_pack(seat)
                .iter()
                .map(|c| self.card(c))
                .collect()
        } else {
            Vec::new()
        };
        let seats = self
            .setup
            .seats
            .iter()
            .enumerate()
            .map(|(i, setup)| {
                let i = i as u8;
                let bot = self.is_bot(i);
                DraftSeatView {
                    name: setup.name.clone(),
                    bot,
                    connected: bot || session.connected_seats.get_or(i, true),
                    picked: drafting
                        && if winston {
                            !self.winston_turn(i)
                        } else {
                            session.seats_picked_this_round.get(i)
                        },
                    pool_count: self.pool_cards(i).len() as u32,
                }
            })
            .collect();
        DraftView {
            mode: self.setup.mode,
            status,
            label: self.setup.label.clone(),
            seat,
            pack_number,
            pack_count,
            pick_number: if winston { 0 } else { session.pick_number },
            pack_size: if winston {
                0
            } else {
                session.cards_in_pack(pack_number)
            },
            pass_left: !winston && session.pass_direction == PassDirection::Left,
            pack,
            waiting,
            pool: self.pool_cards(seat).iter().map(|c| self.card(c)).collect(),
            seats,
            pack_sets: self.setup.pack_sets.clone(),
            min_deck_size: self.setup.min_deck_size,
            pod_format: self.setup.pod_format,
            picks_per_step: session.kind.procedure().cards_per_pick,
            commanders: session.kind.commanders_required(),
            stack: winston.then(|| self.winston_view(seat)),
        }
    }

    /// A Winston draft's table from `seat`, off draft-core's own projection: the pile the turn is
    /// on shows its cards to the seat whose turn it is (draft-core's `revealed`, the prefix that
    /// seat has looked at — the whole pile), and every other pile, and every pile to everyone
    /// else, is a count. Once the draft is over there is no turn: counts, no active pile.
    fn winston_view(&self, seat: u8) -> WinstonView {
        let live = (usize::from(seat) < self.session.seats.len())
            .then(|| filter_for_player(&self.session, seat).shared_stack)
            .flatten();
        if let Some(live) = live {
            let your_turn = live.active_seat == seat;
            return WinstonView {
                main_count: live.main_stack_remaining as u32,
                piles: live
                    .piles
                    .iter()
                    .map(|pile| {
                        let active = pile.index == live.active_pile;
                        WinstonPile {
                            count: pile.total as u32,
                            cards: if your_turn && active {
                                pile.revealed.iter().map(|c| self.card(c)).collect()
                            } else {
                                Vec::new()
                            },
                            active,
                        }
                    })
                    .collect(),
                turn_seat: live.active_seat,
                your_turn,
                active_pile: Some(live.active_pile),
            };
        }
        let state = self.session.shared_stack.as_ref();
        let drafting = self.session.status == dc::DraftStatus::Drafting;
        WinstonView {
            main_count: state.map_or(0, |s| s.main_stack.len() as u32),
            piles: state
                .map(|s| {
                    s.piles
                        .iter()
                        .enumerate()
                        .map(|(i, pile)| WinstonPile {
                            count: pile.len() as u32,
                            cards: Vec::new(),
                            active: drafting && i == usize::from(s.cursor),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            turn_seat: state.map_or(0, |s| s.active_seat),
            your_turn: false,
            active_pile: state.filter(|_| drafting).map(|s| s.cursor),
        }
    }

    /// A person at `seat` picks `ids` (one card, two in a Commander draft — the view's
    /// `picks_per_step`, fewer only when the pack holds fewer) from their pack; then the bots pick
    /// until none holds a pack it has not picked from. Refused — and nothing changed — for a bot's
    /// seat, a seat that has picked this step, a card not in the pack, the wrong number of cards,
    /// a Winston draft, or a draft that is over.
    pub fn pick(&mut self, seat: u8, ids: Vec<String>) -> Result<(), String> {
        self.person(seat)?;
        if self.is_winston() {
            return Err(NO_PICK_IN_WINSTON.into());
        }
        self.keeping(|draft| {
            apply(
                &mut draft.session,
                DraftAction::Pick {
                    seat,
                    card_instance_ids: ids,
                },
                None,
            )
            .map_err(refusal)?;
            draft.bots_act()
        })
    }

    /// The bots' pick for a person — "Pick for me" — at the draft's difficulty; then the bots
    /// pick, as after `pick`. In a Winston draft, the bot's decision for that seat's turn.
    pub fn auto_pick(&mut self, seat: u8) -> Result<(), String> {
        self.person(seat)?;
        if self.status() != DraftStatus::Drafting {
            return Err(OVER.into());
        }
        if self.is_winston() {
            if !self.winston_turn(seat) {
                return Err(NOT_YOUR_TURN.into());
            }
            let (pile, decision) = self
                .winston_choice(seat)
                .ok_or("There is no pile that seat may take or decline.")?;
            return self.winston(seat, pile, decision == SharedStackPileDecision::Take);
        }
        if !self.owes_pick(seat) {
            return Err("That seat has picked; the table is catching up.".into());
        }
        let ids = self.choose(seat);
        self.pick(seat, ids)
    }

    /// A person at `seat` takes (`take`) or declines the Winston pile `pile` (0-based — the pile
    /// the turn is on; another is refused, so a repeated press never decides the next pile);
    /// then every bot whose turn it is decides, until it is a person's turn or the draft is over.
    /// Refused — and nothing changed — for a bot's seat, a seat whose turn it is not, a pile not
    /// in play, an empty pile, a decline that would leave the seat no card, or a draft that is not
    /// a Winston draft or is over.
    pub fn winston(&mut self, seat: u8, pile: u8, take: bool) -> Result<(), String> {
        self.person(seat)?;
        if !self.is_winston() {
            return Err(NOT_WINSTON.into());
        }
        if self.session.status != dc::DraftStatus::Drafting {
            return Err(OVER.into());
        }
        if !self.winston_turn(seat) {
            return Err(NOT_YOUR_TURN.into());
        }
        let decision = if take {
            SharedStackPileDecision::Take
        } else {
            SharedStackPileDecision::Decline
        };
        self.keeping(|draft| {
            apply(
                &mut draft.session,
                DraftAction::SharedStackDecision {
                    seat,
                    pile,
                    decision,
                },
                None,
            )
            .map_err(refusal)?;
            draft.bots_act()
        })
    }

    /// Whether a person's app is on the line, for the seats' view. A bot's seat, or one out of
    /// range, is left as it is.
    pub fn set_connected(&mut self, seat: u8, connected: bool) {
        if self.person(seat).is_ok() {
            // Refused only for a bot or a seat out of range, both ruled out above.
            let _ = apply(
                &mut self.session,
                DraftAction::SetSeatConnected { seat, connected },
                None,
            );
        }
    }

    /// A bot takes over a person's seat — a guest who left a pod — keeping its name and pool,
    /// and picks at once if the table was waiting on it.
    pub fn replace_with_bot(&mut self, seat: u8) -> Result<(), String> {
        self.person(seat)?;
        let name = self.setup.seats[usize::from(seat)].name.clone();
        self.keeping(|draft| {
            apply(
                &mut draft.session,
                DraftAction::ReplaceSeatWithBot {
                    seat,
                    name: Some(name),
                },
                None,
            )
            .map_err(refusal)?;
            draft.bots_act()
        })
    }

    /// The printing ids in `seat`'s pool, in the order picked.
    pub fn pool(&self, seat: u8) -> Vec<String> {
        self.pool_cards(seat)
            .iter()
            .map(|c| card_id(&c.instance_id).to_string())
            .collect()
    }

    /// The table as the setup set it, a replaced seat still marked a person: which seat is which
    /// lobby peer.
    pub fn seats(&self) -> &[DraftSeatSetup] {
        &self.setup.seats
    }

    /// Picking, or done: anything phase's reducer has past drafting is deckbuilding.
    pub fn status(&self) -> DraftStatus {
        match self.session.status {
            dc::DraftStatus::Lobby | dc::DraftStatus::Drafting | dc::DraftStatus::Paused => {
                DraftStatus::Drafting
            }
            _ => DraftStatus::Deckbuilding,
        }
    }

    pub fn label(&self) -> &str {
        &self.setup.label
    }

    pub fn mode(&self) -> DraftMode {
        self.setup.mode
    }

    /// The draft left off, for *Draft in progress*; `updated_at` in milliseconds.
    pub fn saved(&self, updated_at: i64) -> DraftSaved {
        let view = self.view(0);
        DraftSaved {
            label: self.setup.label.clone(),
            mode: self.setup.mode,
            status: view.status,
            pack_number: view.pack_number,
            pack_count: view.pack_count,
            pick_number: view.pick_number,
            updated_at,
        }
    }

    /// Everything the draft is, as JSON: what `restore` takes back.
    pub fn snapshot(&self) -> String {
        serde_json::to_string(&Snapshot {
            version: SNAPSHOT_VERSION,
            setup: self.setup.clone(),
            session: self.session.clone(),
        })
        .expect("a draft is plain data")
    }

    /// The printing ids a snapshot's cards name, distinct: the facts the host loads before
    /// `restore`.
    pub fn card_ids(snapshot: &str) -> Result<Vec<String>, String> {
        let saved = read_snapshot(snapshot)?;
        let session = &saved.session;
        let mut seen = HashSet::new();
        Ok(session
            .current_pack
            .iter()
            .flatten()
            .chain(session.packs_by_seat.iter().flatten())
            .flat_map(|pack| pack.0.iter())
            .chain(session.pools.iter().flatten())
            .chain(
                session
                    .shared_stack
                    .iter()
                    .flat_map(|s| s.main_stack.iter().chain(s.piles.iter().flatten())),
            )
            .map(|c| card_id(&c.instance_id))
            .filter(|id| seen.insert(*id))
            .map(str::to_string)
            .collect())
    }

    /// A draft from its `snapshot`, its cards' `facts` re-read for the bots (`card_ids`).
    pub fn restore(json: &str, facts: Vec<CardFacts>) -> Result<Draft, String> {
        let Snapshot { setup, session, .. } = read_snapshot(json)?;
        if session.seats.len() < setup.seats.len() || session.pools.len() != session.seats.len() {
            return Err("That saved draft is damaged and cannot be resumed.".into());
        }
        let db = card_database(setup.difficulty, &facts);
        let mut draft = Draft { setup, session, db };
        draft.bots_act()?;
        Ok(draft)
    }

    /// Run `change`, and put the session back as it was if it is refused.
    fn keeping(
        &mut self,
        change: impl FnOnce(&mut Draft) -> Result<(), String>,
    ) -> Result<(), String> {
        let before = self.session.clone();
        let result = change(self);
        if result.is_err() {
            self.session = before;
        }
        result
    }

    /// Every bot that holds a pack it has not picked from picks, again and again: a round the
    /// last pick completes deals the next boosters.
    fn bots_act(&mut self) -> Result<(), String> {
        loop {
            let mut acted = false;
            for seat in 0..self.session.seats.len() as u8 {
                if !self.is_bot(seat) || !self.owes_pick(seat) {
                    continue;
                }
                let ids = self.choose(seat);
                apply(
                    &mut self.session,
                    DraftAction::Pick {
                        seat,
                        card_instance_ids: ids,
                    },
                    None,
                )
                .map_err(|e| format!("A bot could not pick: {e}."))?;
                acted = true;
            }
            if !acted {
                return self.winston_bots_act();
            }
        }
    }

    /// Every Winston turn that is a bot's, one decision after another — a turn is up to three,
    /// and bots may sit next to each other — until it is a person's turn or the draft is over.
    /// Bounded as phase's driver is (`resolve_shared_stack_bot_turns`): every decision moves a
    /// card or the cursor, so more than the undrafted cards times the piles and one is a defect,
    /// and is said, never spun on.
    fn winston_bots_act(&mut self) -> Result<(), String> {
        let Some(state) = self.session.shared_stack.as_ref() else {
            return Ok(());
        };
        let undrafted = state.main_stack.len() + state.piles.iter().map(Vec::len).sum::<usize>();
        let bound = undrafted
            .saturating_mul(state.piles.len() + 1)
            .saturating_add(1);
        let mut applied = 0usize;
        while self.session.status == dc::DraftStatus::Drafting {
            let Some(state) = self.session.shared_stack.as_ref() else {
                break;
            };
            let seat = state.active_seat;
            if !self.is_bot(seat) {
                break;
            }
            applied += 1;
            if applied > bound {
                return Err("A bot could not finish its Winston turn.".into());
            }
            let (pile, decision) = self
                .winston_choice(seat)
                .ok_or("A bot found no pile it may take or decline.")?;
            apply(
                &mut self.session,
                DraftAction::SharedStackDecision {
                    seat,
                    pile,
                    decision,
                },
                None,
            )
            .map_err(|e| format!("A bot could not decide: {e}."))?;
        }
        Ok(())
    }

    /// The Winston bot's decision for `seat`'s turn, from that seat's own projection alone.
    fn winston_choice(&self, seat: u8) -> Option<(u8, SharedStackPileDecision)> {
        bots::winston_decision(
            &filter_for_player(&self.session, seat),
            bots::level(self.setup.difficulty),
            self.db.as_ref(),
        )
    }

    /// A shared-stack draft: phase's Winston.
    fn is_winston(&self) -> bool {
        matches!(
            self.session.kind.procedure().distribution,
            PackDistribution::SharedStackPiles { .. }
        )
    }

    /// Whether it is `seat`'s Winston turn.
    fn winston_turn(&self, seat: u8) -> bool {
        self.session.status == dc::DraftStatus::Drafting
            && self
                .session
                .shared_stack
                .as_ref()
                .is_some_and(|s| s.active_seat == seat)
    }

    /// The bots' choice for `seat`'s pick step, as instance ids.
    fn choose(&self, seat: u8) -> Vec<String> {
        let pack = self.current_pack(seat);
        let count = required_pick_count(&self.session, seat);
        let mut rng = self.dice(seat);
        bots::bot_picks(
            pack,
            count,
            bots::level(self.setup.difficulty),
            self.pool_cards(seat),
            self.db.as_ref(),
            &mut rng,
        )
        .into_iter()
        .map(|i| pack[i].instance_id.clone())
        .collect()
    }

    /// A bot's dice for one pick: the seed, the cards picked so far at the table and the seat —
    /// nothing kept between calls, so a restored draft rolls as the original would have.
    fn dice(&self, seat: u8) -> ChaCha8Rng {
        let picked: u64 = self.session.pools.iter().map(|p| p.len() as u64).sum();
        ChaCha8Rng::seed_from_u64(
            (u64::from(self.setup.seed) << 32) ^ (picked << 8) ^ u64::from(seat),
        )
    }

    /// Whether `seat` holds a pack it has not picked from this step.
    fn owes_pick(&self, seat: u8) -> bool {
        self.session.status == dc::DraftStatus::Drafting
            && !self.current_pack(seat).is_empty()
            && !self.session.seats_picked_this_round.get(seat)
    }

    fn is_bot(&self, seat: u8) -> bool {
        matches!(
            self.session.seats.get(usize::from(seat)),
            Some(DraftSeat::Bot { .. })
        )
    }

    /// `Ok` for a person's seat of the table the setup set.
    fn person(&self, seat: u8) -> Result<(), String> {
        if usize::from(seat) >= self.setup.seats.len() {
            return Err("There is no such seat at this table.".into());
        }
        if self.is_bot(seat) {
            return Err("A bot sits in that seat.".into());
        }
        Ok(())
    }

    fn current_pack(&self, seat: u8) -> &[DraftCardInstance] {
        self.session
            .current_pack
            .get(usize::from(seat))
            .and_then(Option::as_ref)
            .map_or(&[], |pack| pack.0.as_slice())
    }

    fn pool_cards(&self, seat: u8) -> &[DraftCardInstance] {
        self.session
            .pools
            .get(usize::from(seat))
            .map_or(&[], Vec::as_slice)
    }

    fn card(&self, card: &DraftCardInstance) -> DraftCard {
        DraftCard {
            instance_id: card.instance_id.clone(),
            card_id: card_id(&card.instance_id).to_string(),
            name: card.name.clone(),
            set_code: card.set_code.clone(),
            collector_number: card.collector_number.clone(),
            rarity: card.rarity.clone(),
            colors: card.colors.clone(),
            cmc: card.cmc,
            type_line: card.type_line.clone(),
        }
    }
}

/// The boosters the page made, as phase's reducer asks for them: seat by seat, round by round,
/// exactly as `DraftSetup::packs` has them. A seat past the setup's (sealed's hidden bot) opens
/// empty boosters.
struct SetupPacks<'a> {
    packs: &'a [Vec<Vec<String>>],
    facts: &'a HashMap<String, DraftCardFacts>,
    pack_sets: &'a [String],
}

impl SetupPacks<'_> {
    fn booster(&self, seat: u8, round: u8) -> DraftPack {
        let ids = self
            .packs
            .get(usize::from(seat))
            .and_then(|rounds| rounds.get(usize::from(round)))
            .map_or(&[][..], Vec::as_slice);
        let round_set = self
            .pack_sets
            .get(usize::from(round))
            .map_or("", String::as_str);
        DraftPack(
            ids.iter()
                .enumerate()
                .filter_map(|(index, id)| {
                    let facts = self.facts.get(id)?;
                    Some(instance(id, seat, round, index, facts, round_set))
                })
                .collect(),
        )
    }
}

impl PackSource for SetupPacks<'_> {
    fn generate_pack(&self, _rng: &mut dyn rand::RngCore, seat: u8, pack_number: u8) -> DraftPack {
        self.booster(seat, pack_number)
    }

    /// The boosters as they are: no dice, no collation of phase's.
    fn generate_packs(
        &self,
        _rng: &mut dyn rand::RngCore,
        config: &DraftConfig,
        seat_count: u8,
    ) -> Result<Vec<Vec<DraftPack>>, DraftError> {
        Ok((0..seat_count)
            .map(|seat| {
                (0..config.pack_count)
                    .map(|round| self.booster(seat, round))
                    .collect()
            })
            .collect())
    }
}

/// One card of a booster, as phase's reducer and bots read it.
fn instance(
    id: &str,
    seat: u8,
    round: u8,
    index: usize,
    facts: &DraftCardFacts,
    round_set: &str,
) -> DraftCardInstance {
    let card = &facts.card;
    DraftCardInstance {
        instance_id: format!("{id}#{seat}.{round}.{index}"),
        name: card.name.clone(),
        set_code: if facts.set_code.is_empty() {
            round_set.to_string()
        } else {
            facts.set_code.clone()
        },
        collector_number: facts.collector_number.clone(),
        rarity: facts.rarity.clone(),
        colors: colors(card),
        cmc: card.cmc.unwrap_or(0.0).round().clamp(0.0, 255.0) as u8,
        type_line: card.type_line.clone().unwrap_or_default(),
        draft_effect: None,
    }
}

/// A card's colours as letters: its own, or — for a card of several faces whose colours Scryfall
/// keeps on the faces — every face's, in WUBRG order.
fn colors(card: &CardFacts) -> Vec<String> {
    if !card.colors.is_empty() || card.faces.is_empty() {
        return card.colors.clone();
    }
    let faces: HashSet<&str> = card
        .faces
        .iter()
        .flat_map(|f| f.colors.iter().flatten())
        .map(String::as_str)
        .collect();
    ["W", "U", "B", "R", "G"]
        .into_iter()
        .filter(|c| faces.contains(c))
        .map(str::to_string)
        .collect()
}

/// phase's kind for a mode (and, for a pod, what it drafts).
fn kind_of(mode: DraftMode, pod_format: PodFormat) -> DraftKind {
    match mode {
        DraftMode::Quick | DraftMode::Cube => DraftKind::Quick,
        DraftMode::Sealed => DraftKind::Sealed,
        DraftMode::Commander => DraftKind::CommanderDraft,
        DraftMode::Winston => DraftKind::Winston,
        DraftMode::Pod => match pod_format {
            PodFormat::Booster => DraftKind::Premier,
            PodFormat::Commander => DraftKind::CommanderDraft,
            PodFormat::Winston => DraftKind::Winston,
        },
    }
}

/// The source phase's reducer is told of: the rounds' sets, or a cube when a round names none.
/// Sealed is always a set source (phase's rule), a cube's rounds spelled `cube`.
fn source(setup: &DraftSetup, kind: DraftKind) -> DraftSource {
    let unnamed = setup.pack_sets.is_empty() || setup.pack_sets.iter().any(String::is_empty);
    if kind == DraftKind::Sealed || !(setup.mode == DraftMode::Cube || unnamed) {
        let codes = if setup.pack_sets.is_empty() {
            vec!["cube".to_string()]
        } else {
            setup
                .pack_sets
                .iter()
                .map(|c| {
                    if c.is_empty() {
                        "cube".into()
                    } else {
                        c.clone()
                    }
                })
                .collect()
        };
        DraftSource::Set {
            layout: SetLayout::UniformByRound { codes },
        }
    } else {
        DraftSource::Cube {
            id: "cube".into(),
            name: setup.label.clone(),
        }
    }
}

/// The bots' card database, for the presets that read faces; `None` otherwise or when the cards
/// cannot be parsed (the bots then pick without it).
fn card_database(difficulty: crate::Difficulty, facts: &[CardFacts]) -> Option<CardDatabase> {
    if !bots::reads_faces(difficulty) {
        return None;
    }
    database(facts, &[]).ok()
}

fn read_snapshot(json: &str) -> Result<Snapshot, String> {
    let saved: Snapshot = serde_json::from_str(json)
        .map_err(|_| "That saved draft could not be read.".to_string())?;
    if saved.version != SNAPSHOT_VERSION {
        return Err("That saved draft is from another version of the app.".into());
    }
    Ok(saved)
}

/// The printing id an instance id names: everything before the `#`.
fn card_id(instance_id: &str) -> &str {
    instance_id
        .rsplit_once('#')
        .map_or(instance_id, |(id, _)| id)
}

/// phase's refusal, as one sentence.
fn refusal(error: DraftError) -> String {
    match error {
        DraftError::CardNotInPack { .. } => "That card is not in the pack.".into(),
        DraftError::DuplicatePickCardId { .. } => "That card was picked twice.".into(),
        DraftError::WrongPickCardCount { expected, .. } => format!(
            "Pick {expected} card{} from the pack.",
            if expected == 1 { "" } else { "s" }
        ),
        DraftError::SeatAlreadyPickedThisRound { .. } => {
            "That seat has picked; the table is catching up.".into()
        }
        DraftError::NoPendingPack { .. } => "That seat has no pack to pick from.".into(),
        DraftError::InvalidTransition { .. } => "The draft is not picking now.".into(),
        DraftError::SeatOutOfRange { .. } => "There is no such seat at this table.".into(),
        DraftError::SeatIsBot { .. } => "A bot sits in that seat.".into(),
        DraftError::SharedStackDecisionRefused { reason, .. } => match reason {
            SharedStackRefusal::PileNotActive => "That is not the pile in play.".into(),
            SharedStackRefusal::PileEmpty => "That pile is empty.".into(),
            SharedStackRefusal::NoGuaranteedCard => {
                "That pile must be taken: declining it would leave no card to take.".into()
            }
        },
        other => format!("The draft could not do that: {other}."),
    }
}
