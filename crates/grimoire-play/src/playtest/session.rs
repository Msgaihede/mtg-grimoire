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
//! answered by a set of cards — a scry, a discard, a search, a sacrifice — also carries a `pick`
//! (`pick`): the enumeration offers only a few of its answers. So does the division of an
//! attacker's combat damage among its blockers (`damage`, issue #1448): the engine lists one split
//! of its own, and the reader, as the attacker's controller, makes their own. A question with one
//! answer is not asked at all (`sole_answer`): `advance` takes it, as the reader would have.
//!
//! **The sandbox is a setting** (`setSandbox`): a hand on the table, phase's debug actions — move a
//! card anywhere, tap, counters, tokens, draws, life totals, a card put under any player's control
//! (`control`, issue #1713) — on the reader's own cards and on every card the table shows (never
//! an opponent's hand or library), and a play the rules refuse made unpaid instead: cast without
//! paying, or put down when even that is not legal (`unpaid`).
//! Taken whenever the game waits on the reader to play or to declare (issue #1522): their main
//! phase, a moment to respond (any step they stop at), their declare-attackers and
//! declare-blockers steps (`edit`) — never in the middle of a question, nor before the opening
//! hand is kept. Off from the start against the AI, on against the goldfish; the reader turns it
//! on or off whenever they like.
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
use engine::database::combo_table::ComboTable;
use engine::game::casting::activated_ability_definitions;
use engine::game::combat::AttackTarget;
use engine::game::coverage::card_face_gaps;
use engine::game::dungeon;
use engine::game::effects::create_emblem::grant_emblem;
use engine::game::engine::apply;
use engine::game::mana_sources::{activatable_mana_actions_for_player, max_mana_yield};
use engine::game::printed_cards::intrinsic_etb_counters;
use engine::game::turn_control::authorized_submitters;
use engine::game::visibility::filter_state_for_viewer;
use engine::game::{
    install_card_db, load_and_hydrate_decks, resolve_deck_list, start_game_with_starting_player,
    DeckList, PlayerDeckList,
};
use engine::types::ability::{
    EffectKind, KeywordAction, LibraryPosition, ObjectSelectionCardinality, TargetRef,
};
use engine::types::actions::{DebugAction, DebugTokenRequest, GameAction, MulliganChoice};
use engine::types::events::{ActivatedAbilityKind, GameEvent};
use engine::types::format::FormatConfig;
use engine::types::game_state::{
    CastOfferKind, CombatDamageAssignmentMode, CounterMoveChoice, CounterRemoveChoice, DayNight,
    ManaChoice, MulliganDecisionPhase, PayCostKind, StackEntry, StackEntryKind, WaitingFor,
};
use engine::types::identifiers::ObjectId;
use engine::types::phase::Phase;
use engine::types::player::PlayerCounterKind;
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
use crate::table::{game_card, is_permanent, mana_table, mana_type, place_of};
use crate::tokens::{DeckTokens, TokenFacts};
use crate::view::{CardCounter, GameCard, ManaKind, MulliganView, Place, Seat, TokenOffer};

use super::view::{
    Difficulty, PlaytestAction, PlaytestAttack, PlaytestAttackPair, PlaytestAttacker,
    PlaytestBlock, PlaytestBlockPair, PlaytestBlocker, PlaytestCardRef, PlaytestCause,
    PlaytestCombat, PlaytestCommanderDamage, PlaytestCounterShare, PlaytestCounters,
    PlaytestDamage, PlaytestDamageBlocker, PlaytestDamageShare, PlaytestDayNight,
    PlaytestDesignation, PlaytestDistribute, PlaytestDistributeTarget, PlaytestDungeon,
    PlaytestEmblem, PlaytestFrame, PlaytestHappened, PlaytestOption, PlaytestPhase, PlaytestPick,
    PlaytestPickPurpose, PlaytestPlayer, PlaytestPrompt, PlaytestResults, PlaytestSeat,
    PlaytestShare, PlaytestStackItem, PlaytestStage, PlaytestStep, PlaytestStop, PlaytestStopStep,
    PlaytestView,
};

/// The reader's seat: the person whose app holds the game — the host, in a lobby's game. The
/// opponents are `PlayerId(1)` on, in turn order.
const HOST: PlayerId = PlayerId(0);

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
    /// A person plays this seat, from another app over a lobby (issue #1419), rather than the
    /// AI: the game stops for their decisions as it stops for the reader's.
    pub person: bool,
}

/// How many times one action may pass the reader's priority (or declare no attackers for them)
/// before the session gives up on it. A whole turn cycle is a few dozen; the bound is what stops a
/// loop in the engine, the AI or here from hanging the board, and a game never reaches it.
const STEP_LIMIT: usize = 2000;

/// The most replay frames one action answers with, per opponent. A long AI turn is a few dozen
/// things to show, and one action may play every opponent's turn; past this the rest is the final
/// view, so a runaway loop of triggers cannot make a step huge.
const FRAME_LIMIT: usize = 80;

const NOT_IN_GAME: &str = "That card is no longer where it was.";
const NOT_NOW: &str = "Keep or mulligan the opening hand first.";
const ALREADY_KEPT: &str = "The opening hand has already been kept.";
const OVER: &str = "The game is over. Start a new one from the game menu.";
/// The board's own question about which mana a source makes (`tap_for_mana`).
const MANA_CHOICE: &str = "ManaChoice";
const NO_MANA: &str = "That makes no mana right now.";
const MAIN_ONLY: &str = "That can be done in your main phase, with nothing on the stack.";
const SANDBOX_OFF: &str =
    "That changes the game by hand. Turn the sandbox on in the game menu to do it.";
const HIDDEN: &str = "That card is in a zone you cannot see.";
const NO_SUCH_PLAYER: &str = "There is no such player in this game.";
/// The most mana one sandbox edit adds or takes (`mana`): a pool is set up a few at a time.
const MANA_EDIT_LIMIT: i32 = 99;
const PLAYER_OUT: &str = "That player is out of the game.";
const NOT_A_PERSON: &str = "That seat is not a person's at this table.";
const NOT_YOURS: &str = "Another player is deciding. Wait for your turn to act.";
const NO_UNDO_TOGETHER: &str = "A game with other people at the table cannot be taken back.";
const NO_SANDBOX_TOGETHER: &str = "The sandbox stays off in a game with other people.";
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
/// cards they can foretell, the hand, graveyard and exile cards they can activate an ability of
/// (cycling; unearth, embalm, scavenge), the graveyard and exile cards they can cast or play, and
/// the permanents they can tap for mana.
#[derive(Default)]
struct Offers {
    foretell: HashSet<ObjectId>,
    activate: HashSet<ObjectId>,
    cast: HashSet<ObjectId>,
    mana: HashSet<ObjectId>,
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
    /// The goldfish's seat, in a game against it: it answers every question of its own by doing
    /// nothing (`fish_answer`), and `ai_seats` is empty.
    fish: Option<PlayerId>,
    /// The emblems that keep a goldfish game going; never shown (`emblems`), never counted as
    /// anyone's card.
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
    /// The seat in the chair: the person the session decides for and reads the table as (issue
    /// #1419). The reader's — the host's — at rest; a guest's while their action is made and while
    /// the game plays on to their decision (`sit`). Always the reader's in a game of one person.
    you: PlayerId,
    /// Every person at the table, the reader first, then each opponent a person plays.
    people: Vec<PlayerId>,
    /// Each person's own place in the game while another is in the chair.
    chairs: HashMap<PlayerId, Chair>,
    /// What each guest has been told since their last step (`guest_steps`).
    told: HashMap<PlayerId, Vec<PlaytestHappened>>,
    /// The AI's difficulty, for a person's seat handed to it (`hand_to_ai`).
    level: AiDifficulty,
}

/// The whole of a game an action can change, for undo and redo and for a refusal, which goes
/// back to it whole (issue #1143): the engine's checkpoint, and the session's own place in the
/// game around it — a cast half made, the board's own question, the end told, the turn being
/// ended, the stop last stopped at. The stops the reader set are a setting, not the game, and
/// stay as they are.
struct Moment {
    checkpoint: Checkpoint,
    pending: Option<Pending>,
    choice: Option<BoardChoice>,
    over_told: bool,
    ending: Option<u32>,
    stopped_at: Option<(u32, Phase)>,
    /// The seat in the chair, and every other person's own place, in a lobby's game: a refusal
    /// of a guest's action puts back where each of them was (none in a game of one person).
    you: PlayerId,
    chairs: HashMap<PlayerId, Chair>,
}

/// A person's own place in the game, kept while another person is in the chair (`sit`): what
/// the session holds for the one person deciding — a cast half made, the board's question, the
/// stops, the turn being ended, the stop last stopped at, the mulligans, the deck's tokens.
#[derive(Clone, Default)]
struct Chair {
    pending: Option<Pending>,
    choice: Option<BoardChoice>,
    stops: Vec<PlaytestStop>,
    ending: Option<u32>,
    stopped_at: Option<(u32, Phase)>,
    mulligans: u8,
    tokens: Vec<TokenOffer>,
}

/// One seat's eyes on the table (issue #1419): who the wire's players are from it — `you`, then
/// the others in turn order after it — and what it may not see. The host's are the engine's own
/// numbering, so a game of one person reads exactly as it did before there were lobbies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Eyes {
    you: PlayerId,
    players: u8,
}

impl Eyes {
    pub(super) fn new(you: PlayerId, players: usize) -> Self {
        Eyes {
            you,
            players: (players as u8).max(1),
        }
    }

    /// The host's eyes on a table of `players`.
    #[cfg(test)]
    pub(super) fn host(players: usize) -> Self {
        Eyes::new(HOST, players)
    }

    /// The wire's name for `player`, from this seat. A game never seats more than four, so the
    /// last is a fallback that is never reached.
    pub(super) fn seat(self, player: PlayerId) -> PlaytestPlayer {
        let after =
            (player.0 % self.players + self.players - self.you.0 % self.players) % self.players;
        PlaytestPlayer::ALL
            .get(after as usize)
            .copied()
            .unwrap_or(PlaytestPlayer::Opponent3)
    }

    /// The engine's player the wire's `seat` names, from this seat.
    pub(super) fn player(self, seat: PlaytestPlayer) -> PlayerId {
        PlayerId((self.you.0 + seat.index()) % self.players)
    }

    /// Whether a card's face is hidden from this seat: someone else's face-down card — a morph or
    /// a manifest on the battlefield, a face-down spell, a hideaway or foretold card in exile. A
    /// seat looks at its own (CR 708.5) and at nobody else's. Where a card it may not see is
    /// described — the log, the table, the stack, a prompt — it has no name and no printing.
    pub(super) fn concealed(self, o: &engine::game::GameObject) -> bool {
        o.face_down && o.owner != self.you && o.controller != self.you
    }
}

/// What one action came to, told to each person at the table as they may see it: a line of facts
/// per person, the host's first, each written from that person's seat (`tell` with their
/// `Eyes`). A game against the AI or the goldfish has the one line, the reader's.
struct Log {
    players: usize,
    lines: Vec<(PlayerId, Vec<PlaytestHappened>)>,
}

/// Where each of a [`Log`]'s lines stood, to go back to or read on from.
type Mark = Vec<usize>;

impl Log {
    fn new(people: &[PlayerId], players: usize) -> Self {
        Log {
            players,
            lines: people.iter().map(|&p| (p, Vec::new())).collect(),
        }
    }

    /// A run of the engine's events, told to everyone as they may see it.
    fn tell(&mut self, state: &GameState, events: &[GameEvent]) {
        for (seat, line) in &mut self.lines {
            tell(state, events, Eyes::new(*seat, self.players), line);
        }
    }

    /// A fact of `seat`'s own doing, told to them alone, in their seat's words.
    fn own(&mut self, seat: PlayerId, fact: PlaytestHappened) {
        if let Some((_, line)) = self.lines.iter_mut().find(|(p, _)| *p == seat) {
            line.push(fact);
        }
    }

    /// A fact of the table's, told to everyone in their own seat's words.
    fn all(&mut self, fact: impl Fn(Eyes) -> PlaytestHappened) {
        for (seat, line) in &mut self.lines {
            line.push(fact(Eyes::new(*seat, self.players)));
        }
    }

    /// Each line told `fact` at `at`, unless it already tells one that `told` says is it.
    fn insert_unless(
        &mut self,
        at: &Mark,
        told: impl Fn(&PlaytestHappened) -> bool,
        fact: impl Fn(Eyes) -> PlaytestHappened,
    ) {
        for ((seat, line), &at) in self.lines.iter_mut().zip(at) {
            if !line.iter().any(&told) {
                line.insert(at.min(line.len()), fact(Eyes::new(*seat, self.players)));
            }
        }
    }

    fn mark(&self) -> Mark {
        self.lines.iter().map(|(_, line)| line.len()).collect()
    }

    fn truncate(&mut self, mark: &Mark) {
        for ((_, line), &at) in self.lines.iter_mut().zip(mark) {
            line.truncate(at);
        }
    }

    /// The host's facts since `mark`: what a replay frame, the host's alone, shows.
    fn since(&self, mark: &Mark) -> &[PlaytestHappened] {
        let (_, line) = &self.lines[0];
        &line[mark[0].min(line.len())..]
    }

    /// The host's line, and every other person's by seat.
    fn split(
        self,
    ) -> (
        Vec<PlaytestHappened>,
        Vec<(PlayerId, Vec<PlaytestHappened>)>,
    ) {
        let mut lines = self.lines.into_iter();
        let host = lines.next().map(|(_, line)| line).unwrap_or_default();
        (host, lines.collect())
    }
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
    ///
    /// **An opponent may be a person** (`OpponentDeck::person`, issue #1419): a guest of the
    /// reader's lobby, who decides for their seat from their own app. The game stops for them as
    /// it stops for the reader, and what they are told waits in `guest_steps`. The reader stays
    /// `PlayerId(0)`, the host; nothing is taken back and the sandbox stays off.
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
        let (your_main, your_commander) = piles(you, HOST);
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
        state.debug_permitted.insert(HOST);

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
        // The combo table only feeds phase's bracket estimate, which a game never reads: an
        // empty (unmeasured) one, never phase's generated artifact.
        let payload = resolve_deck_list(&db, &ComboTable::default(), &list);
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

        let deck_names = |of: PlayerId| -> HashSet<&str> {
            by_name
                .keys()
                .filter(|(seat, _)| *seat == of)
                .map(|(_, n)| n.as_str())
                .collect()
        };
        let deck_tokens: HashMap<PlayerId, DeckTokens> =
            std::iter::once((HOST, DeckTokens::new(your_tokens)))
                .chain(
                    opponents
                        .iter()
                        .zip(&seats)
                        .map(|(deck, &seat)| (seat, DeckTokens::new(&deck.tokens))),
                )
                .collect();
        let tokens = deck_tokens[&HOST].offers(&deck_names(HOST));
        // The people at the table: the reader, then each opponent a person plays. Each guest's own
        // place starts with their deck's tokens.
        let guests: Vec<PlayerId> = opponents
            .iter()
            .zip(&seats)
            .filter(|(deck, _)| deck.person)
            .map(|(_, &seat)| seat)
            .collect();
        let chairs: HashMap<PlayerId, Chair> = guests
            .iter()
            .map(|&seat| {
                let tokens = deck_tokens[&seat].offers(&deck_names(seat));
                (
                    seat,
                    Chair {
                        tokens,
                        ..Chair::default()
                    },
                )
            })
            .collect();
        let ai: Vec<PlayerId> = seats
            .iter()
            .copied()
            .filter(|seat| !goldfish && !guests.contains(seat))
            .collect();

        let level = match difficulty {
            Difficulty::VeryEasy => AiDifficulty::VeryEasy,
            Difficulty::Easy => AiDifficulty::Easy,
            Difficulty::Medium => AiDifficulty::Medium,
            Difficulty::Hard => AiDifficulty::Hard,
            Difficulty::VeryHard => AiDifficulty::VeryHard,
        };
        // The goldfish never takes the first turn: a goldfish game counts the reader's turns.
        let started = if goldfish {
            HOST
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
            ai_seats: ai.iter().copied().collect(),
            // phase scales its search down for a table of three or more (its "paranoid" cap).
            ai_configs: ai
                .iter()
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
            you: HOST,
            told: guests.iter().map(|&seat| (seat, Vec::new())).collect(),
            people: std::iter::once(HOST)
                .chain(guests.iter().copied())
                .collect(),
            chairs,
            level,
        };
        game.assign_printings(you, HOST);
        for (deck, &seat) in opponents.iter().zip(&seats) {
            game.assign_printings(&deck.cards, seat);
        }
        start_game_with_starting_player(&mut game.state, started);
        let mut log = game.log();
        game.advance(&mut log)?;
        game.sit(HOST);
        let step = game.settle(log);
        Ok((game, step))
    }

    /// An empty log for one action: a line for each person at the table.
    fn log(&self) -> Log {
        Log::new(&self.people, self.state.players.len())
    }

    /// The step an action answers the reader with, the chair back at the reader's: the view, the
    /// reader's line and the replay frames. Every guest's line waits for `guest_steps`.
    fn settle(&mut self, log: Log) -> PlaytestStep {
        let (happened, guests) = log.split();
        for (seat, line) in guests {
            self.told.entry(seat).or_default().extend(line);
        }
        PlaytestStep {
            view: self.view(),
            happened,
            frames: std::mem::take(&mut self.frames),
        }
    }

    /// The seats a person plays besides the reader's: a lobby's guests, in turn order. Empty
    /// in a game against the AI or the goldfish.
    pub fn guests(&self) -> Vec<u8> {
        self.people.iter().skip(1).map(|p| p.0).collect()
    }

    /// Each guest's step since their last (issue #1419): the view from their own seat and what
    /// they have been told since, in their seat's words. Never a replay frame — a guest's board
    /// is sent its settled view alone.
    pub fn guest_steps(&mut self) -> Vec<(u8, PlaytestStep)> {
        let guests: Vec<PlayerId> = self.people.iter().skip(1).copied().collect();
        guests
            .into_iter()
            .map(|seat| {
                let happened = self
                    .told
                    .get_mut(&seat)
                    .map(std::mem::take)
                    .unwrap_or_default();
                let view = self.view_from(seat);
                (
                    seat.0,
                    PlaytestStep {
                        view,
                        happened,
                        frames: Vec::new(),
                    },
                )
            })
            .collect()
    }

    /// The view from `seat`'s own place at the table: the reader's, or a guest's.
    pub fn view_of(&mut self, seat: u8) -> Result<PlaytestView, String> {
        let seat = PlayerId(seat);
        if !self.people.contains(&seat) {
            return Err(NOT_A_PERSON.into());
        }
        Ok(self.view_from(seat))
    }

    fn view_from(&mut self, seat: PlayerId) -> PlaytestView {
        let chair = self.you;
        self.sit(seat);
        let view = self.view();
        self.sit(chair);
        view
    }

    /// Put `seat` in the chair: the person in it now keeps their own place (`Chair`) until they
    /// sit again, and `seat`'s comes out. Nothing of the game changes.
    fn sit(&mut self, seat: PlayerId) {
        if seat == self.you {
            return;
        }
        let up = Chair {
            pending: self.pending.take(),
            choice: self.choice.take(),
            stops: std::mem::take(&mut self.stops),
            ending: self.ending.take(),
            stopped_at: self.stopped_at.take(),
            mulligans: self.mulligans,
            tokens: std::mem::take(&mut self.tokens),
        };
        self.chairs.insert(self.you, up);
        let down = self.chairs.remove(&seat).unwrap_or_default();
        self.pending = down.pending;
        self.choice = down.choice;
        self.stops = down.stops;
        self.ending = down.ending;
        self.stopped_at = down.stopped_at;
        self.mulligans = down.mulligans;
        self.tokens = down.tokens;
        self.you = seat;
    }

    /// The table from the chair's seat.
    fn eyes(&self) -> Eyes {
        Eyes::new(self.you, self.state.players.len())
    }

    /// The wire's name for `player`, from the chair's seat.
    fn seat_of(&self, player: PlayerId) -> PlaytestPlayer {
        self.eyes().seat(player)
    }

    /// Whether a card's face is hidden from the chair's seat.
    fn concealed(&self, o: &engine::game::GameObject) -> bool {
        self.eyes().concealed(o)
    }

    /// The other seats, from the chair's: in turn order after it.
    fn others(&self) -> Vec<PlayerId> {
        let players = self.state.players.len() as u8;
        (1..players)
            .map(|n| PlayerId((self.you.0 + n) % players))
            .collect()
    }

    /// A game with other people at the table.
    fn together(&self) -> bool {
        self.people.len() > 1
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
                .is_some_and(|o| card_name(names, face_name(o)) == p.name);
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
            let name = card_name(names, face_name(o)).to_string();
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
        let offers = self.offers(watching);
        let sight = self.sight();
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
                            AttackTarget::Player(p) => Some(self.seat_of(p)),
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
            } if *player == self.you && !watching => {
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
                                    AttackTarget::Player(p) => Some(self.seat_of(*p)),
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
            } if *player == self.you && !watching => Some(PlaytestBlock {
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
            WaitingFor::GameOver { winner } => winner.map(|w| self.seat_of(w)),
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
            active: self.seat_of(s.active_player),
            started: self.seat_of(self.started),
            phase: phase_of(s.phase),
            step: stop_step(s.phase),
            mulligan: self.mulligan(),
            you: self.seat(self.you, &offers, &sight),
            // The reader's offers on every seat: an opponent's card in a graveyard or exile is
            // castable when the rules let the reader cast it (issue #1713) — Hostage Taker's
            // hostage, Dire Fleet Daredevil's instant, a spell "from any graveyard".
            opponents: self
                .others()
                .into_iter()
                .map(|p| self.seat(p, &offers, &sight))
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
                    let (targets, target_players) = stack_targets(s, entry, self.eyes());
                    Some(PlaytestStackItem {
                        id: entry.id.0,
                        // A face-down spell of an opponent's has no name to them (CR 708.4).
                        name: if self.concealed(source) {
                            String::new()
                        } else {
                            face_name(source).to_string()
                        },
                        card_id: self.printing_of(shown),
                        seat: self.seat_of(entry.controller),
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
            commander_damage_lethal: s.format_config.commander_damage_threshold.map(u32::from),
            // A replay frame is a moment inside an action, never one to go back to.
            can_undo: !watching && self.history.can_undo(),
            can_redo: !watching && self.history.can_redo(),
            lobby: self.together(),
            deciding: (stage == PlaytestStage::Waiting)
                .then(|| self.deciding().map(|p| self.seat_of(p)))
                .flatten(),
            day_night: s.day_night.map(|d| match d {
                DayNight::Day => PlaytestDayNight::Day,
                DayNight::Night => PlaytestDayNight::Night,
            }),
            lands_left: (s.active_player == self.you).then(|| {
                u32::from(s.max_lands_per_turn).saturating_sub(u32::from(s.lands_played_this_turn))
            }),
        }
    }

    /// What phase's own projection for the reader's seat lets them see (`filter_state_for_viewer`,
    /// the one its own board draws from): every hidden card the rules show them — a library's top
    /// they may look at or that is revealed (CR 401.5), an opponent's hand card revealed or known
    /// to them, a face-down card in exile they may look at or play. The board never decides that
    /// for itself. Positions are read off the game, never off the projection, which reorders a
    /// library's hidden cards.
    fn sight(&self) -> Sight {
        let projected = filter_state_for_viewer(&self.state, self.you);
        Sight {
            seen: projected
                .objects
                .iter()
                .filter(|(_, o)| o.display_visible_to_viewer)
                .map(|(id, _)| *id)
                .collect(),
        }
    }

    /// The person the rules wait on now, when it is not the chair's seat: a guest's decision
    /// while the reader looks, or the reader's while a guest does.
    fn deciding(&self) -> Option<PlayerId> {
        authorized_submitters(&self.state)
            .into_iter()
            .find(|p| *p != self.you && self.people.contains(p))
    }

    /// What the rules offer the reader beyond a hand card's play: foretelling a hand card,
    /// activating one of a hand card's abilities (cycling, issue #1431) or a graveyard card's
    /// (unearth, issue #1714), casting a card from the graveyard or exile, and tapping a
    /// permanent for mana. Nothing in a replay frame, or while the reader does not have priority.
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
                ref play if is_play(play) => offers.cast.extend(play.source_object()),
                ref ability if is_ability(ability) => {
                    offers.activate.extend(ability.source_object())
                }
                _ => {}
            }
        }
        offers.mana = self.mana_ways().iter().filter_map(mana_source).collect();
        offers
    }

    fn seat(&self, seat: PlayerId, offers: &Offers, sight: &Sight) -> PlaytestSeat {
        let s = &self.state;
        let player = &s.players[seat.0 as usize];
        let reader = seat == self.you;
        let mine = |id: &&ObjectId| s.objects.get(id).is_some_and(|o| o.owner == seat);
        let cards = |ids: &mut dyn Iterator<Item = &ObjectId>| -> Vec<GameCard> {
            ids.filter_map(|id| self.card(*id))
                .map(|mut c| {
                    let id = ObjectId(c.id);
                    c.castable = offers.cast.contains(&id);
                    // Cycling and ninjutsu from the hand, unearth from the graveyard (issue
                    // #1714), plot from the library's top, a permanent's own abilities.
                    c.can_activate = offers.activate.contains(&id);
                    match s.objects.get(&id).map(|o| o.zone) {
                        Some(Zone::Hand) => c.can_foretell = offers.foretell.contains(&id),
                        Some(Zone::Battlefield) => c.can_tap_for_mana = offers.mana.contains(&id),
                        _ => {}
                    }
                    c
                })
                .collect()
        };
        // A hidden card in exile — face down, and not one the reader may look at (another
        // player's foretold or hideaway card, the reader's own Necropotence exile): its back, so
        // the pile counts it, never its name or printing.
        let exiled = |id: &ObjectId| -> Option<GameCard> {
            if sight.seen.contains(id) {
                return cards(&mut std::iter::once(id)).pop();
            }
            game_card(s, *id, None, false, Vec::new()).map(hidden)
        };
        let library = s.library_of(seat);
        let top = library.front().filter(|id| sight.seen.contains(id));
        PlaytestSeat {
            player: self.seat_of(seat),
            out: player.is_eliminated,
            life: player.life,
            poison: player.poison_counters,
            // An opponent's hand: only the cards the reader may see, revealed or known.
            hand: if reader {
                cards(&mut player.hand.iter())
            } else {
                cards(&mut player.hand.iter().filter(|id| sight.seen.contains(id)))
            },
            hand_count: player.hand.len() as u32,
            battlefield: cards(
                &mut s
                    .battlefield
                    .iter()
                    .filter(|id| s.objects.get(id).is_some_and(|o| o.controller == seat)),
            ),
            graveyard: cards(&mut player.graveyard.iter()),
            exile: s.exile.iter().filter(mine).filter_map(exiled).collect(),
            command: cards(&mut s.command_zone.iter().filter(|id| {
                s.objects
                    .get(id)
                    .is_some_and(|o| o.owner == seat && !o.is_emblem)
            })),
            emblems: self.emblems(seat),
            library: player.library.len() as u32,
            // phase's library is a vector whose **front is the top** (`DrawCards` takes from it).
            library_cards: if reader {
                cards(&mut player.library.iter())
            } else {
                Vec::new()
            },
            library_top: top.and_then(|id| cards(&mut std::iter::once(id)).pop()),
            library_top_revealed: top.is_some_and(|id| s.revealed_cards.contains(id)),
            mana_open: s
                .battlefield
                .iter()
                .map(|id| max_mana_yield(s, *id, seat))
                .sum(),
            mana: mana_table(s, seat),
            // Public, wherever the commander is now; only a face-down one is told without its name.
            commander_damage: s
                .commander_damage
                .iter()
                .filter(|e| e.player == seat)
                .filter_map(|e| {
                    let o = s.objects.get(&e.commander)?;
                    Some(PlaytestCommanderDamage {
                        id: e.commander.0,
                        name: if self.concealed(o) {
                            String::new()
                        } else {
                            o.name.clone()
                        },
                        card_id: self.printing_of(e.commander),
                        player: self.seat_of(o.owner),
                        damage: e.damage,
                    })
                })
                .collect(),
            dead_on: if Some(seat) == self.fish {
                self.dead_on
            } else {
                None
            },
            energy: player.energy,
            experience: player.player_counter(&PlayerCounterKind::Experience),
            rad: player.player_counter(&PlayerCounterKind::Rad),
            tickets: player.player_counter(&PlayerCounterKind::Ticket),
            speed: player.speed,
            monarch: s.monarch == Some(seat),
            initiative: s.initiative == Some(seat),
            city_blessing: s.city_blessing.contains(&seat),
            ring: s.ring_level.get(&seat).copied().unwrap_or(0),
            dungeon: s.dungeon_progress.get(&seat).and_then(|d| {
                let id = d.current_dungeon?;
                Some(PlaytestDungeon {
                    name: dungeon::get_definition(id).name.to_string(),
                    room: dungeon::room_name(id, d.current_room).to_string(),
                    room_text: dungeon::room_text(id, d.current_room).to_string(),
                })
            }),
            enchanted_by: s
                .battlefield
                .iter()
                .filter(|id| {
                    s.objects
                        .get(id)
                        .is_some_and(|o| o.attached_to.and_then(|t| t.as_player()) == Some(seat))
                })
                .map(|id| id.0)
                .collect(),
        }
    }

    /// `seat`'s emblems, oldest first: every one in the command zone it controls (CR 114.2),
    /// but the session's own — the goldfish's `rules` and the sandbox's `free` — which are the
    /// board's machinery and not the game's.
    fn emblems(&self, seat: PlayerId) -> Vec<PlaytestEmblem> {
        let s = &self.state;
        let mut ids: Vec<ObjectId> = s
            .command_zone
            .iter()
            .copied()
            .filter(|id| !self.rules.contains(id) && self.free != Some(*id))
            .filter(|id| {
                s.objects
                    .get(id)
                    .is_some_and(|o| o.is_emblem && o.controller == seat)
            })
            .collect();
        ids.sort();
        ids.into_iter()
            .map(|id| {
                let o = &s.objects[&id];
                // An emblem's abilities are its own, never changed by an effect (CR 114.4).
                let text = o
                    .base_static_definitions
                    .iter()
                    .filter_map(|d| d.description.clone())
                    .chain(
                        o.base_trigger_definitions
                            .iter()
                            .filter_map(|d| d.description.clone()),
                    )
                    .chain(
                        o.base_abilities
                            .iter()
                            .filter_map(|d| d.description.clone()),
                    )
                    .filter(|t| !t.is_empty())
                    .collect();
                PlaytestEmblem {
                    id: id.0,
                    source: o.emblem_source.as_ref().map(|e| e.name.clone()),
                    card_id: self.printing_of(id),
                    text,
                }
            })
            .collect()
    }

    fn card(&self, id: ObjectId) -> Option<GameCard> {
        let o = self.state.objects.get(&id)?;
        if self.concealed(o) {
            // An opponent's face-down permanent (a morph, a manifest): only what the effect that
            // turned it face down gives it (CR 708.2a), never the card's name, picture or gaps.
            return game_card(&self.state, id, None, false, Vec::new()).map(|c| GameCard {
                name: String::new(),
                ..c
            });
        }
        // The reader's own face-down card is the card underneath to them (CR 708.5).
        let name = face_name(o);
        let is_commander = !o.is_token && self.is_commander(o.owner, name);
        // A token is phase's preset, never a face of the deck's: its maker's gaps are the maker's.
        let gaps = if o.is_token {
            Vec::new()
        } else {
            self.gaps.get(name).cloned().unwrap_or_default()
        };
        game_card(&self.state, id, self.printing_of(id), is_commander, gaps).map(|c| GameCard {
            name: name.to_string(),
            ..c
        })
    }

    /// The printing to draw a card by; none for a card the reader may not see the face of.
    fn printing_of(&self, id: ObjectId) -> Option<String> {
        let o = self.state.objects.get(&id).filter(|o| !self.concealed(o))?;
        if o.is_emblem {
            // The deck's own emblem for its source: its owner's deck first, as a token's — the
            // owner is whoever got it, who may have controlled another player's card.
            let source = &o.emblem_source.as_ref()?.name;
            return self
                .deck_tokens
                .get(&o.owner)
                .and_then(|t| t.emblem_of(source))
                .or_else(|| {
                    let mut seats: Vec<&PlayerId> = self.deck_tokens.keys().collect();
                    seats.sort();
                    seats
                        .into_iter()
                        .find_map(|seat| self.deck_tokens[seat].emblem_of(source))
                });
        }
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
                let name = card_name(&self.card_names, face_name(o));
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
            name: if self.concealed(o) {
                String::new()
            } else {
                face_name(o).to_string()
            },
            card_id: self.printing_of(id),
            text: None,
            cause: None,
        })
    }

    /// Whether the reader may see a card: their own anywhere, anyone's in a public zone.
    fn visible(&self, id: ObjectId) -> bool {
        self.state.objects.get(&id).is_some_and(|o| {
            o.owner == self.you
                || o.controller == self.you
                || !matches!(o.zone, Zone::Hand | Zone::Library)
        })
    }

    /// A card's name, when the reader may see the card and what it is: not in an opponent's
    /// hand or library, and not an opponent's face-down card.
    fn shown_name(&self, id: ObjectId) -> Option<String> {
        self.state
            .objects
            .get(&id)
            .filter(|o| self.visible(id) && !self.concealed(o))
            .map(|o| face_name(o).to_string())
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
                collect_refs(value, self.eyes(), &mut ids, &mut players);
            }
            if !ids.is_empty() {
                break;
            }
        }
        // The card's controller when the event names a card; else the player the event names.
        let controller = ids
            .first()
            .and_then(|id| self.state.objects.get(id))
            .map(|o| self.seat_of(o.controller));
        let player = controller.or(players.first().copied()).or_else(|| {
            ["player_id", "controller", "player", "defending_player"]
                .iter()
                .find_map(|key| field(key)?.as_u64())
                .map(|p| self.seat_of(PlayerId(p as u8)))
        });
        let (id, name) = match ids.first() {
            Some(&id) if self.state.objects.contains_key(&id) => {
                if self.visible(id) {
                    (Some(id.0), self.shown_name(id))
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
        // Another person decides now, and the chair's seat does not: it waits for them.
        let theirs = !matches!(self.state.waiting_for, WaitingFor::GameOver { .. })
            && !authorized_submitters(&self.state).contains(&self.you)
            && self.deciding().is_some();
        if theirs {
            return PlaytestStage::Waiting;
        }
        match &self.state.waiting_for {
            WaitingFor::GameOver { .. } => PlaytestStage::Over,
            WaitingFor::MulliganDecision { .. } | WaitingFor::OpeningHandBottomCards { .. } => {
                PlaytestStage::Mulligan
            }
            WaitingFor::Priority { player } if *player == self.you => {
                if self.at_home() {
                    PlaytestStage::Main
                } else {
                    PlaytestStage::Respond
                }
            }
            WaitingFor::DeclareAttackers { player, .. } if *player == self.you => {
                PlaytestStage::Attack
            }
            WaitingFor::DeclareBlockers { player, .. } if *player == self.you => {
                PlaytestStage::Block
            }
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
        let entry = pending.iter().find(|e| e.player == self.you)?;
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
                    .map(|(i, a)| self.option_of(i, a, &[], &Value::Null))
                    .collect(),
                cancellable: true,
                pick: None,
                keyword: None,
                damage: None,
                shown: Vec::new(),
                distribute: None,
                name_entry: false,
                counters: None,
                triggers: None,
                results: None,
            };
        }
        // The question's own data names its ability when it is about one — a trigger's targets —
        // by `source_id`, `description` and the trigger's events: read by those fields, as
        // `abilities` reads a list, rather than matched kind by kind. The top of the stack is the
        // fallback, and it is not always the trigger being asked about.
        let json = serde_json::to_value(&self.state.waiting_for).unwrap_or(Value::Null);
        let data = json.get("data");
        let question = data.cloned().unwrap_or(Value::Null);
        let field = |key: &str| data.and_then(|d| d.get(key));
        let named = field("source_id")
            .and_then(Value::as_u64)
            .and_then(|id| self.shown_name(ObjectId(id)));
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
                .map(|(i, a)| self.option_of(i, a, &abilities, &question))
                .collect(),
            cancellable: self.pending.is_some(),
            pick: self.pick().map(|(pick, _)| pick),
            keyword: self.keyword(),
            damage: self.damage(),
            shown: self.shown(&question),
            distribute: self.distribute(),
            name_entry: self.name_entry(),
            counters: self.counters(),
            triggers: self.triggers(),
            results: self.results(),
        }
    }

    /// Counters to remove from a card, or to move from it onto other permanents, as the reader
    /// chooses (`RemoveCountersChoice`, `MoveCountersDistribution`; CR 107.1c, 122.5). The
    /// engine lists only none and all, so without this the reader could not take some.
    fn counters(&self) -> Option<PlaytestCounters> {
        let (source_id, available, destinations, max_total) = match &self.state.waiting_for {
            WaitingFor::MoveCountersDistribution {
                player,
                source_id,
                available,
                destinations,
                ..
            } if *player == self.you => (source_id, available, destinations.as_slice(), None),
            WaitingFor::RemoveCountersChoice {
                player,
                source_id,
                available,
                max_total,
                ..
            } if *player == self.you => (source_id, available, &[][..], *max_total),
            _ => return None,
        };
        Some(PlaytestCounters {
            source: self.card_ref(*source_id),
            kinds: available
                .iter()
                .filter(|(_, n)| *n > 0)
                .map(|(kind, n)| CardCounter {
                    kind: kind.display_phrase().into_owned(),
                    count: *n,
                })
                .collect(),
            destinations: destinations
                .iter()
                .filter_map(|id| self.card_ref(*id))
                .collect(),
            max_total,
        })
    }

    /// The reader's counters taken (`MoveCounters`) as the engine takes them, or the sentence that
    /// says why not: each share of a kind the card has, onto a listed destination for a move, no
    /// kind past what there is and no more in all than the most.
    fn counters_answer(&self, shares: &[PlaytestCounterShare]) -> Result<GameAction, String> {
        let counters = self
            .counters()
            .ok_or("This question is not which counters to take.")?;
        let (available, moving) = match &self.state.waiting_for {
            WaitingFor::MoveCountersDistribution { available, .. } => (available, true),
            WaitingFor::RemoveCountersChoice { available, .. } => (available, false),
            _ => return Err(NO_PROMPT.into()),
        };
        let mut taken: Vec<(usize, Option<u64>, u32)> = Vec::new();
        for share in shares.iter().filter(|s| s.count > 0) {
            let kind = available
                .iter()
                .position(|(k, n)| *n > 0 && k.display_phrase() == share.kind)
                .ok_or_else(|| format!("The card has no {} counters.", share.kind))?;
            let listed = match share.to {
                Some(id) => moving && counters.destinations.iter().any(|d| d.id == id),
                None => !moving,
            };
            if !listed || taken.iter().any(|(k, to, _)| *k == kind && *to == share.to) {
                return Err(NOT_IN_GAME.into());
            }
            taken.push((kind, share.to, share.count));
        }
        for (i, (_, n)) in available.iter().enumerate() {
            let asked: u32 = taken.iter().filter(|t| t.0 == i).map(|t| t.2).sum();
            if asked > *n {
                return Err(format!(
                    "The card has {n} {} counter{}.",
                    available[i].0.display_phrase(),
                    if *n == 1 { "" } else { "s" }
                ));
            }
        }
        let total: u32 = taken.iter().map(|t| t.2).sum();
        if let Some(most) = counters.max_total.filter(|m| total > *m) {
            return Err(format!("Take at most {most} counters in all."));
        }
        Ok(if moving {
            GameAction::ChooseCounterMoveDistribution {
                selections: taken
                    .into_iter()
                    .map(|(kind, to, count)| CounterMoveChoice {
                        destination_id: ObjectId(to.unwrap_or_default()),
                        counter_type: available[kind].0.clone(),
                        count,
                    })
                    .collect(),
            }
        } else {
            GameAction::ChooseCountersToRemove {
                selections: taken
                    .into_iter()
                    .map(|(kind, _, count)| CounterRemoveChoice {
                        counter_type: available[kind].0.clone(),
                        count,
                    })
                    .collect(),
            }
        })
    }

    /// The reader's triggers to put in order, when the engine lists only some orders of them:
    /// every order of up to four (24 answers), only as they are and reversed past that
    /// (`OrderTriggers`, CR 603.3b). The abilities as `abilities` names them.
    fn triggers(&self) -> Option<Vec<PlaytestCardRef>> {
        match &self.state.waiting_for {
            WaitingFor::OrderTriggers { player, triggers }
                if *player == self.you && triggers.len() > ORDERS_LISTED =>
            {
                let abilities = self.abilities();
                (abilities.len() == triggers.len()).then_some(abilities)
            }
            _ => None,
        }
    }

    /// Coin flips to keep or die rolls to ignore (`CoinFlipKeepChoice`, CR 705.1 — Krark's
    /// Thumb; `DieKeepChoice`, CR 706.6), with the results shown. The engine lists one answer a
    /// coin kept, and none when more than one is.
    fn results(&self) -> Option<PlaytestResults> {
        let index = |i: usize| i as u32;
        match &self.state.waiting_for {
            WaitingFor::CoinFlipKeepChoice {
                player,
                results,
                keep_count,
            } if *player == self.you => Some(PlaytestResults {
                dice: false,
                results: results.iter().map(|r| u32::from(*r)).collect(),
                eligible: (0..results.len()).map(index).collect(),
                count: (*keep_count).min(results.len()) as u32,
            }),
            WaitingFor::DieKeepChoice {
                player,
                results,
                ignorable_indices,
                ignore_count,
            } if *player == self.you => Some(PlaytestResults {
                dice: true,
                results: results.iter().map(|r| u32::from(*r)).collect(),
                eligible: ignorable_indices.iter().copied().map(index).collect(),
                count: (*ignore_count).min(ignorable_indices.len()) as u32,
            }),
            _ => None,
        }
    }

    /// The reader's kept results (`KeepResults`) as the engine takes them: exactly `count`
    /// distinct indices, each one it may name.
    fn results_answer(&self, indices: &[u32]) -> Result<GameAction, String> {
        let results = self
            .results()
            .ok_or("This question is not which flips or rolls to keep.")?;
        if indices.len() != results.count as usize {
            return Err(format!(
                "{} {} {}.",
                if results.dice { "Ignore" } else { "Keep" },
                results.count,
                match (results.dice, results.count == 1) {
                    (true, true) => "roll",
                    (true, false) => "rolls",
                    (false, true) => "flip",
                    (false, false) => "flips",
                }
            ));
        }
        let mut seen = HashSet::new();
        if indices
            .iter()
            .any(|i| !results.eligible.contains(i) || !seen.insert(*i))
        {
            return Err(NOT_IN_GAME.into());
        }
        let picked: Vec<usize> = indices.iter().map(|i| *i as usize).collect();
        Ok(if results.dice {
            GameAction::SelectDieRolls {
                ignore_indices: picked,
            }
        } else {
            GameAction::SelectCoinFlips {
                keep_indices: picked,
            }
        })
    }

    /// The cards the question shows the reader without asking them to pick: the cards they are
    /// privately looking at as it is asked (phase's `private_look_ids`, "look at the top card;
    /// you may reveal it"), and the card a cast offer names (a cascade's or a discover's
    /// `hit_card`), read by that field wherever the question's data has it.
    fn shown(&self, question: &Value) -> Vec<PlaytestCardRef> {
        let s = &self.state;
        let mut ids: Vec<ObjectId> = if s.private_look_player == Some(self.you) {
            s.private_look_ids.clone()
        } else {
            Vec::new()
        };
        fn hits(v: &Value, depth: u8, out: &mut Vec<ObjectId>) {
            if depth == 0 {
                return;
            }
            if let Value::Object(fields) = v {
                for (key, value) in fields {
                    match (key.as_str(), value.as_u64()) {
                        ("hit_card", Some(id)) => out.push(ObjectId(id)),
                        _ => hits(value, depth - 1, out),
                    }
                }
            }
        }
        hits(question, 4, &mut ids);
        let mut seen = HashSet::new();
        ids.retain(|id| seen.insert(*id));
        ids.into_iter().filter_map(|id| self.card_ref(id)).collect()
    }

    /// An amount the reader divides among targets as they choose (`DistributeAmong`, CR 601.2d):
    /// a spell's damage among its targets as it is cast, or counters among creatures as it
    /// resolves. The engine lists only an even split and a lethal-first one, so without this
    /// the reader could not choose the division (issue #1448's reason, outside combat).
    fn distribute(&self) -> Option<PlaytestDistribute> {
        // A blocker's combat damage among the attackers it blocks, divided by the active player
        // against banding (CR 510.1d, 702.22k): any division of all of it, none at the least.
        // The engine lists one, all of it to the first attacker.
        if let WaitingFor::AssignBlockerDamage {
            player,
            total_damage,
            attackers,
            ..
        } = &self.state.waiting_for
        {
            return (*player == self.you).then(|| PlaytestDistribute {
                total: *total_damage,
                unit: "Damage".into(),
                targets: attackers
                    .iter()
                    .map(|id| PlaytestDistributeTarget {
                        card: self.card_ref(*id),
                        player: None,
                        min: 0,
                    })
                    .collect(),
            });
        }
        let WaitingFor::DistributeAmong {
            player,
            total,
            targets,
            unit,
            scope,
        } = &self.state.waiting_for
        else {
            return None;
        };
        if *player != self.you {
            return None;
        }
        // CR 601.2d: each target announced is given at least one; as it resolves, a candidate
        // left at none is not chosen.
        let min = u32::from(scope.is_announced_targets());
        Some(PlaytestDistribute {
            total: *total,
            unit: serde_json::to_value(unit)
                .ok()
                .as_ref()
                .and_then(tag_of)
                .unwrap_or_default(),
            targets: targets
                .iter()
                .map(|t| match t {
                    TargetRef::Object(id) => PlaytestDistributeTarget {
                        card: self.card_ref(*id),
                        player: None,
                        min,
                    },
                    TargetRef::Player(p) => PlaytestDistributeTarget {
                        card: None,
                        player: Some(self.seat_of(*p)),
                        min,
                    },
                })
                .collect(),
        })
    }

    /// The question takes a word of the reader's own as well as its listed options: a card's
    /// name, a creature type (phase's `free_entry`).
    fn name_entry(&self) -> bool {
        matches!(
            &self.state.waiting_for,
            WaitingFor::NamedChoice { player, choice_type, .. }
                if *player == self.you && choice_type.free_entry().is_some()
        )
    }

    /// The reader's attacker's combat damage to divide among its blockers (CR 510.1c), and with
    /// trample past them (CR 702.19b) — the engine's `AssignCombatDamage`, asked of the
    /// attacker's controller (or of the defender, against banding: CR 702.22j). `legal_actions`
    /// lists one split only, the engine's greedy one, so without this the reader would never
    /// choose which blocker dies (issue #1448).
    fn damage(&self) -> Option<PlaytestDamage> {
        let WaitingFor::AssignCombatDamage {
            player,
            attacker_id,
            total_damage,
            blockers,
            trample,
            defending_player,
            attack_target,
            ..
        } = &self.state.waiting_for
        else {
            return None;
        };
        if *player != self.you {
            return None;
        }
        Some(PlaytestDamage {
            attacker: self.card_ref(*attacker_id)?,
            total: *total_damage,
            blockers: blockers
                .iter()
                .filter_map(|slot| {
                    Some(PlaytestDamageBlocker {
                        card: self.card_ref(slot.blocker_id)?,
                        lethal: slot.lethal_minimum,
                    })
                })
                .collect(),
            trample: trample.is_some(),
            defender: self.seat_of(*defending_player),
            target: target_id(attack_target).and_then(|id| self.card_ref(ObjectId(id))),
        })
    }

    /// The reader's division of combat damage (`AssignDamage`) as the engine takes it, or the
    /// sentence that says why it is not one. Trample past a planeswalker onto its controller
    /// (CR 702.19c) gives the planeswalker its loyalty first and the controller the rest.
    fn damage_answer(
        &self,
        shares: &[PlaytestDamageShare],
        excess: u32,
    ) -> Result<GameAction, String> {
        let damage = self
            .damage()
            .ok_or("This question is not how to divide combat damage.")?;
        let WaitingFor::AssignCombatDamage {
            pw_loyalty,
            trample,
            attack_target,
            ..
        } = &self.state.waiting_for
        else {
            return Err(NO_PROMPT.into());
        };
        let mut seen = HashSet::new();
        for share in shares {
            if !damage.blockers.iter().any(|b| b.card.id == share.blocker)
                || !seen.insert(share.blocker)
            {
                return Err("That creature is not blocking the attacker.".into());
            }
        }
        let assigned: u32 = shares.iter().map(|s| s.amount).sum::<u32>() + excess;
        if assigned != damage.total {
            return Err(format!(
                "Assign all {} damage: {assigned} {} assigned.",
                damage.total,
                if assigned == 1 { "is" } else { "are" }
            ));
        }
        if excess > 0 {
            if !damage.trample {
                return Err(
                    "Only a creature with trample assigns damage past its blockers.".into(),
                );
            }
            let short = damage.blockers.iter().find(|b| {
                let given = shares
                    .iter()
                    .find(|s| s.blocker == b.card.id)
                    .map_or(0, |s| s.amount);
                given < b.lethal
            });
            if let Some(b) = short {
                return Err(format!(
                    "Assign lethal damage to {} ({}) before any goes past the blockers.",
                    b.card.name, b.lethal
                ));
            }
        }
        let over_planeswalker = *trample
            == Some(engine::game::combat::TrampleKind::OverPlaneswalkers)
            && matches!(attack_target, AttackTarget::Planeswalker(_));
        let (trample_damage, controller_damage) = if over_planeswalker {
            let to_pw = excess.min(pw_loyalty.unwrap_or(0));
            (to_pw, excess - to_pw)
        } else {
            (excess, 0)
        };
        Ok(GameAction::AssignCombatDamage {
            mode: CombatDamageAssignmentMode::Normal,
            assignments: shares
                .iter()
                .map(|s| (ObjectId(s.blocker), s.amount))
                .collect(),
            trample_damage,
            controller_damage,
        })
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
            WaitingFor::ScryChoice { player, cards } if *player == self.you => (
                PlaytestPickPurpose::Scry,
                all(cards),
                all(cards),
                0,
                cards.len(),
                true,
                PickAnswer::Cards,
            ),
            WaitingFor::SurveilChoice { player, cards } if *player == self.you => (
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
            } if *player == self.you => (
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
            } if *player == self.you => (
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
            } if *player == self.you => (
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
                kept_destination,
                ..
            } if *player == self.you => {
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
                    // Kept back on the library (Sensei's Divining Top, "in any order"): the order
                    // picked is the order they go.
                    *kept_destination == Some(Zone::Library),
                    PickAnswer::Cards,
                )
            }
            // "Put the rest on the bottom in any order": every card, in the order picked.
            WaitingFor::DigBottomOrder { player, cards, .. }
            | WaitingFor::RevealUntilBottomOrder { player, cards, .. }
            | WaitingFor::RippleBottomOrder { player, cards, .. }
                if *player == self.you =>
            {
                (
                    PlaytestPickPurpose::Order,
                    all(cards),
                    all(cards),
                    cards.len(),
                    cards.len(),
                    true,
                    PickAnswer::Cards,
                )
            }
            // "Put N on top and the rest on the bottom, in any order" (Telling Time): every card,
            // the first `top_count` picked on top. A split already made, whose order alone is
            // the owner's (`OrderOnly`), keeps its one generic answer.
            WaitingFor::DigRestSplitChoice {
                player,
                cards,
                scope,
                ..
            } if *player == self.you && scope.partition_is_open() => (
                PlaytestPickPurpose::Order,
                all(cards),
                all(cards),
                cards.len(),
                cards.len(),
                true,
                PickAnswer::Cards,
            ),
            // A cost paid with cards: sacrifice two creatures, discard a card, exile five other
            // cards from the graveyard (escape), return a land. The engine lists only some sets.
            WaitingFor::PayCost {
                player,
                kind,
                choices,
                count,
                min_count,
                ..
            } if *player == self.you && pays_with_cards(kind) => {
                let most = (*count).min(choices.len());
                (
                    PlaytestPickPurpose::Pay,
                    all(choices),
                    all(choices),
                    if *min_count > 0 {
                        (*min_count).min(most)
                    } else {
                        most
                    },
                    most,
                    false,
                    PickAnswer::Cards,
                )
            }
            // Proliferate (CR 701.34) and time travel: any of them, while every one is a
            // permanent — a player among them is a question the generic options answer.
            WaitingFor::ProliferateChoice { player, eligible }
            | WaitingFor::TimeTravelChoice {
                player, eligible, ..
            } if *player == self.you
                && eligible.iter().all(|t| matches!(t, TargetRef::Object(_))) =>
            {
                let ids: Vec<u64> = eligible
                    .iter()
                    .filter_map(|t| match t {
                        TargetRef::Object(id) => Some(id.0),
                        TargetRef::Player(_) => None,
                    })
                    .collect();
                (
                    PlaytestPickPurpose::Choose,
                    ids.clone(),
                    ids.clone(),
                    0,
                    ids.len(),
                    false,
                    PickAnswer::Targets,
                )
            }
            // Separate into two piles (CR 700.3, Fact or Fiction): the picked cards are one pile.
            WaitingFor::SeparatePilesPartition {
                player, eligible, ..
            } if *player == self.you => {
                let ids: Vec<u64> = eligible.iter().map(|id| id.0).collect();
                (
                    PlaytestPickPurpose::Pile,
                    ids.clone(),
                    ids.clone(),
                    0,
                    ids.len(),
                    false,
                    PickAnswer::PileA,
                )
            }
            // Untap up to so many of a group in the untap step (Winter Orb, Smoke).
            WaitingFor::ChooseUntapSubset {
                player, group, max, ..
            } if *player == self.you => (
                PlaytestPickPurpose::Choose,
                all(group),
                all(group),
                0,
                (*max).min(group.len()),
                false,
                PickAnswer::Cards,
            ),
            WaitingFor::ChooseFromZoneChoice {
                player,
                cards,
                count,
                up_to,
                ..
            } if *player == self.you => (
                PlaytestPickPurpose::Choose,
                all(cards),
                all(cards),
                if *up_to { 0 } else { (*count).min(cards.len()) },
                *count,
                false,
                PickAnswer::Cards,
            ),
            // Reveal one card, so many, or any number (Metalworker).
            WaitingFor::RevealChoice {
                player,
                cards,
                optional,
                cardinality,
                ..
            } if *player == self.you => {
                let (least, most) = match cardinality {
                    ObjectSelectionCardinality::Exactly { count } => {
                        let n = (*count as usize).min(cards.len());
                        (if *optional { 0 } else { n }, n)
                    }
                    ObjectSelectionCardinality::AnyNumber => (0, cards.len()),
                };
                (
                    PlaytestPickPurpose::Reveal,
                    all(cards),
                    all(cards),
                    least,
                    most,
                    false,
                    PickAnswer::Cards,
                )
            }
            WaitingFor::MultiTargetSelection {
                player,
                legal_targets,
                min_targets,
                max_targets,
                ..
            } if *player == self.you => (
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
            } if *player == self.you
                && eligible.iter().all(|t| matches!(t, TargetRef::Object(_))) =>
            {
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
            } if *player == self.you => (
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
            } if *player == self.you => (
                PlaytestPickPurpose::Keep,
                all(eligible),
                all(eligible),
                *required_count,
                *required_count,
                false,
                PickAnswer::KeptPermanents,
            ),
            // "Choose N of these" as an effect resolves, whatever it does with them: "each player
            // sacrifices six creatures" (issue #1416), "you may cast a spell from among them"
            // (issue #1329), a put onto the battlefield or into a library. The effect's kind is
            // only what the picked cards are for; a library they go to in turn takes them in
            // the order picked.
            WaitingFor::EffectZoneChoice {
                player,
                cards,
                count,
                min_count,
                up_to,
                effect_kind,
                library_position,
                mass_library_order,
                ..
            } if *player == self.you => (
                match effect_kind {
                    EffectKind::Sacrifice => PlaytestPickPurpose::Sacrifice,
                    EffectKind::CastFromZone => PlaytestPickPurpose::Cast,
                    EffectKind::Discard => PlaytestPickPurpose::Discard,
                    _ => PlaytestPickPurpose::Choose,
                },
                all(cards),
                all(cards),
                if *up_to {
                    (*min_count).min(cards.len())
                } else {
                    (*count).min(cards.len())
                },
                (*count).min(cards.len()),
                library_position.is_some() || mass_library_order.is_some(),
                PickAnswer::Cards,
            ),
            // A free-cast window — Invoke Calamity's graveyard and hand, or the cards exiled
            // "from among them": one card cast at a time, or none to close it. The engine
            // offers the window again after each cast while casts are left.
            WaitingFor::CastOffer {
                player,
                kind: CastOfferKind::FreeCastWindow { candidates, .. },
            } if *player == self.you => (
                PlaytestPickPurpose::Cast,
                all(candidates),
                all(candidates),
                0,
                1,
                false,
                PickAnswer::FreeCast,
            ),
            // Tap creatures with total power N or more to crew a Vehicle or saddle a Mount
            // (CR 702.122a, 702.171a): any of them, so long as their power reaches `power_min`,
            // each counted as the engine counts it (`contributions`). The engine lists only some
            // of the sets.
            WaitingFor::CrewVehicle {
                player,
                vehicle_id,
                eligible_creatures,
                ..
            } if *player == self.you => (
                PlaytestPickPurpose::Crew,
                all(eligible_creatures),
                all(eligible_creatures),
                0,
                eligible_creatures.len(),
                false,
                PickAnswer::Crew(*vehicle_id),
            ),
            WaitingFor::SaddleMount {
                player,
                mount_id,
                eligible_creatures,
                ..
            } if *player == self.you => (
                PlaytestPickPurpose::Saddle,
                all(eligible_creatures),
                all(eligible_creatures),
                0,
                eligible_creatures.len(),
                false,
                PickAnswer::Saddle(*mount_id),
            ),
            _ => return None,
        };
        let power_cap = match &self.state.waiting_for {
            WaitingFor::KeepWithinTotalPowerChoice { cap, .. } => Some(*cap),
            _ => None,
        };
        let (power_min, contributions) = match &self.state.waiting_for {
            WaitingFor::CrewVehicle {
                crew_power: least,
                eligible_creatures,
                contributions,
                ..
            }
            | WaitingFor::SaddleMount {
                saddle_power: least,
                eligible_creatures,
                contributions,
                ..
            } => (
                Some(i32::try_from(*least).unwrap_or(i32::MAX)),
                // The engine's own reckoning when it gives one for every creature; each one's
                // power when not (an older wire without the field).
                if contributions.len() == eligible_creatures.len() {
                    contributions.clone()
                } else {
                    eligible_creatures
                        .iter()
                        .map(|id| {
                            self.state
                                .objects
                                .get(id)
                                .and_then(|o| o.power)
                                .unwrap_or(0)
                        })
                        .collect()
                },
            ),
            _ => (None, Vec::new()),
        };
        let split = match &self.state.waiting_for {
            WaitingFor::DigRestSplitChoice { top_count, .. }
                if purpose == PlaytestPickPurpose::Order =>
            {
                Some(*top_count as u32)
            }
            _ => None,
        };
        // Where the cards lie, when they all lie in one place: a cast from the graveyard is
        // offered as one.
        let mut zones = shown
            .iter()
            .filter_map(|id| self.state.objects.get(&ObjectId(*id)))
            .map(|o| o.zone);
        let first = zones.next();
        let zone = first
            .filter(|z| zones.all(|other| other == *z))
            .and_then(place_of);
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
                power_min,
                contributions,
                zone,
                split,
            },
            answer,
        ))
    }

    /// A division the reader made (`Distribute`), checked against the question: every share to
    /// one of its targets, at least each target's least, all of the total and no more.
    fn distribute_answer(&self, shares: &[PlaytestShare]) -> Result<GameAction, String> {
        let distribute = self
            .distribute()
            .ok_or("This question is not a division of an amount.")?;
        let mut given: Vec<(TargetRef, u32)> = Vec::new();
        let eyes = self.eyes();
        for share in shares {
            let target = match (share.id, share.player) {
                (Some(id), None) => TargetRef::Object(ObjectId(id)),
                (None, Some(p)) => TargetRef::Player(eyes.player(p)),
                _ => return Err(NOT_IN_GAME.into()),
            };
            let listed = distribute.targets.iter().any(|t| match &target {
                TargetRef::Object(id) => t.card.as_ref().is_some_and(|c| c.id == id.0),
                TargetRef::Player(p) => t.player == Some(eyes.seat(*p)),
            });
            if !listed || given.iter().any(|(t, _)| *t == target) {
                return Err(NOT_IN_GAME.into());
            }
            given.push((target, share.amount));
        }
        let sum: u32 = given.iter().map(|(_, n)| n).sum();
        if sum != distribute.total {
            return Err(format!(
                "Divide all {} — {} {} given.",
                distribute.total,
                sum,
                if sum == 1 { "is" } else { "are" }
            ));
        }
        let least = distribute.targets.first().map_or(0, |t| t.min);
        if least > 0
            && (given.len() < distribute.targets.len() || given.iter().any(|(_, n)| *n < least))
        {
            return Err(format!("Each target is given at least {least}."));
        }
        given.retain(|(_, n)| *n > 0);
        if matches!(
            self.state.waiting_for,
            WaitingFor::AssignBlockerDamage { .. }
        ) {
            return given
                .into_iter()
                .map(|(t, n)| match t {
                    TargetRef::Object(id) => Ok((id, n)),
                    TargetRef::Player(_) => Err(NOT_IN_GAME.to_string()),
                })
                .collect::<Result<Vec<_>, _>>()
                .map(|assignments| GameAction::AssignBlockerDamage { assignments });
        }
        Ok(GameAction::DistributeAmong {
            distribution: given,
        })
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
        // The engine lists one division of combat damage, its own; the reader has more whenever
        // two creatures block, or trample could carry damage past one (issue #1448).
        if let Some(damage) = self.damage() {
            if damage.blockers.len() > 1 || damage.trample {
                return None;
            }
        }
        // The engine lists an even split and a lethal-first one; the reader has more.
        if self.distribute().is_some_and(|d| d.targets.len() > 1) {
            return None;
        }
        // Counters to take: none is always an answer, and so is any other while there are any.
        if self.counters().is_some_and(|c| !c.kinds.is_empty()) {
            return None;
        }
        if self.triggers().is_some() {
            return None;
        }
        // Flips or rolls: one answer only when every index that may be named must be.
        if let Some(results) = self.results() {
            if results.eligible.len() == results.count as usize {
                return self.results_answer(&results.eligible).ok();
            }
            return None;
        }
        if let Some((pick, answer)) = self.pick() {
            // Crew or saddle with one creature that may: tapping it is the one answer.
            if let Some(least) = pick.power_min {
                let one = pick.eligible.len() == 1 && pick.contributions.first() >= Some(&least);
                return one.then(|| pick_answer(pick.eligible, answer));
            }
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
    /// `question` is the question's own data (`WaitingFor`'s `data`), which names what an index
    /// counts into: a cast's `options`, a modal spell's `mode_descriptions`, a pile's cards, the
    /// faces of a modal card — read by those field names, never by the kind of question.
    fn option_of(
        &self,
        index: usize,
        action: &GameAction,
        abilities: &[PlaytestCardRef],
        question: &Value,
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
        let phrases = phrases(question);
        let phrase = |v: &Value| v.as_u64().and_then(|i| phrases.get(i as usize)).cloned();
        let player = |v: &Value, players: &mut Vec<PlaytestPlayer>| {
            if let Some(p) = v.as_u64() {
                players.push(self.seat_of(PlayerId(p as u8)));
            }
        };
        if let Value::Object(fields) = &data {
            for (key, value) in fields {
                match key.as_str() {
                    // A mana ability's row: the type of mana it makes (`Green`, `Colorless`).
                    "selection" if value.get("mana_type").is_some() => {
                        label = value.get("mana_type").and_then(tag_of);
                    }
                    // Cards, by id or list of ids. A retarget's `new_targets` is one entry per
                    // target of the spell, `null` for each left as it is (issue #1520).
                    "object_id" | "source_id" | "keep" | "target_id" | "equipment_id"
                    | "vehicle_id" | "cards" | "creature_ids" | "targets" | "target" | "kept"
                    | "new_targets" | "selection" | "creature_to_return" | "creature_id"
                    | "hand_object" | "ninjutsu_object_id" | "partner" | "partner_id"
                    | "source" | "spacecraft_id" | "mount_id" => {
                        collect_refs(value, self.eyes(), &mut ids, &mut players);
                    }
                    // A player the answer names by number: an opponent to choose, a gift's
                    // recipient, a battle's protector.
                    "opponent" | "player" | "player_id" | "protector" | "recipient" => {
                        player(value, &mut players)
                    }
                    "order" if !abilities.is_empty() => {
                        named = value
                            .as_array()
                            .map(|v| v.iter().filter_map(ability).collect())
                            .unwrap_or_default();
                    }
                    "index" if !abilities.is_empty() => named.extend(ability(value)),
                    // An index into the question's own list of options (a cast's variants, a
                    // branch, a mode): the option's words.
                    "index" => {
                        number = value.as_i64();
                        label = value
                            .as_u64()
                            .and_then(|i| question.get("options")?.get(i as usize))
                            .and_then(option_word)
                            .or_else(|| phrase(value));
                    }
                    "value" | "ability_index" | "room_index" | "option_index"
                    | "candidate_index" | "amount" | "generic" => number = value.as_i64(),
                    // A modal spell's modes: each chosen mode's words, joined.
                    "indices" => {
                        number = value
                            .as_array()
                            .and_then(|v| v.first())
                            .and_then(Value::as_i64);
                        let words: Vec<String> = value
                            .as_array()
                            .map(|v| v.iter().filter_map(phrase).collect())
                            .unwrap_or_default();
                        if !words.is_empty() {
                            label = Some(words.join(" + "));
                        }
                    }
                    "accept" | "pay" | "top" | "exert" | "untap" | "creature" | "play_first" => {
                        yes = value.as_bool()
                    }
                    // A modal double-faced card's face (a Pathway): the face's name.
                    "back_face" => {
                        let card = question
                            .get("object_id")
                            .and_then(Value::as_u64)
                            .and_then(|id| self.state.objects.get(&ObjectId(id)));
                        label = match (card, value.as_bool()) {
                            (Some(o), Some(true)) => o.back_face.as_ref().map(|b| b.name.clone()),
                            (Some(o), Some(false)) => Some(o.name.clone()),
                            _ => None,
                        };
                        yes = value.as_bool();
                    }
                    // A pile (Fact or Fiction's): its name, and the cards in it.
                    "pile" => {
                        label = tag_of(value);
                        let key = match label.as_deref() {
                            Some("A") => "pile_a",
                            _ => "pile_b",
                        };
                        if let Some(cards) = question.get("current").and_then(|c| c.get(key)) {
                            collect_refs(cards, self.eyes(), &mut ids, &mut players);
                        }
                    }
                    // A word the answer names: a door and what is done to it, a dungeon, a side,
                    // a color, a mana type.
                    "door" | "op" | "dungeon" | "side" | "color" | "mana_type" | "slot" => {
                        let word = tag_of(value);
                        label = match (label.take(), word) {
                            (Some(a), Some(b)) => Some(format!("{a} {b}")),
                            (a, b) => a.or(b),
                        };
                    }
                    // A word, or one of phase's tagged choices: `{ "type": "Alternative" }`. A
                    // mana color's answer is told by its mana (issue #1363): `SingleColor`'s
                    // `Black`, or `Combination`'s types in order, a space between.
                    "choice" => label = mana_of(value).or_else(|| tag_of(value)),
                    _ => {}
                }
            }
        }
        // `CastSpell` names its own card first; the targets after it are what the reader picks.
        if kind == "CastSpell" && ids.len() > 1 {
            ids.remove(0);
        }
        // An optional cost (kicker, gift, bargain): the first answer pays it, the second declines.
        if kind == "DecideOptionalCost" {
            let cost = question.get("cost").and_then(tag_of);
            if matches!(cost.as_deref(), Some("Optional" | "Kicker")) {
                yes = number.map(|n| n == 0);
                number = None;
            }
        }
        // A permanent's ability by its number: the ability's own words, on its card.
        let text = match action {
            GameAction::ActivateAbility {
                source_id,
                ability_index,
                ..
            } => activated_ability_definitions(&self.state, *source_id)
                .into_iter()
                .find(|(i, _)| i == ability_index)
                .and_then(|(_, d)| d.description)
                .filter(|t| !t.is_empty()),
            _ => None,
        };
        let mut cards: Vec<PlaytestCardRef> = ids
            .into_iter()
            .filter_map(|id| self.card_ref(id))
            .chain(named)
            .collect();
        if let (Some(text), [card]) = (text, cards.as_mut_slice()) {
            card.text = Some(text);
        }
        PlaytestOption {
            index: index as u32,
            kind,
            cards,
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
        self.act_by(HOST.0, action)
    }

    /// One action of the person at `seat` — the reader's (`0`), or a guest's from their own app
    /// over the lobby (issue #1419) — and everything after it until a person next decides.
    /// Answers the reader's step; each guest's waits in `guest_steps`. A guest acts only on their
    /// own decision (the stops are a setting, set at any time), and in a game with other people
    /// nothing is taken back and the sandbox stays off. A refusal changes nothing, for anyone.
    pub fn act_by(&mut self, seat: u8, action: PlaytestAction) -> Result<PlaytestStep, String> {
        let seat = PlayerId(seat);
        if !self.people.contains(&seat) {
            return Err(NOT_A_PERSON.into());
        }
        if self.together() {
            match action {
                PlaytestAction::Undo | PlaytestAction::Redo => return Err(NO_UNDO_TOGETHER.into()),
                PlaytestAction::SetSandbox { on: true } => return Err(NO_SANDBOX_TOGETHER.into()),
                _ => {}
            }
        }
        match action {
            PlaytestAction::Undo => return self.travel(true),
            PlaytestAction::Redo => return self.travel(false),
            _ => {}
        }
        let remembered = !self.together()
            && !matches!(
                action,
                PlaytestAction::SetStops { .. } | PlaytestAction::SetSandbox { .. }
            );
        // The whole moment, not the checkpoint alone: a refusal puts back the session's own place
        // in the game too — the board's question, a cast half made, the turn being ended — and,
        // in a lobby's game, every person's.
        let before = self.moment();
        self.sit(seat);
        let mut log = self.log();
        let choice = self.choice.take();
        self.frames.clear();
        match self
            .run(action, choice, &mut log)
            .and_then(|()| self.end_free())
        {
            Ok(()) => {
                if remembered {
                    self.history.record(before);
                }
                self.follow_printings();
                self.mark_dead();
                self.sit(HOST);
                Ok(self.settle(log))
            }
            Err(e) => {
                self.frames.clear();
                self.go_to(before);
                Err(e)
            }
        }
    }

    /// A person's seat handed to the AI at the game's difficulty — a guest who left the lobby, or
    /// whom the host let go — and the game played on to the next person's decision. Answers the
    /// reader's step, as `act` does. The reader's own seat is never handed over.
    pub fn hand_to_ai(&mut self, seat: u8) -> Result<PlaytestStep, String> {
        let seat = PlayerId(seat);
        if seat == HOST || !self.people.contains(&seat) {
            return Err(NOT_A_PERSON.into());
        }
        let before = self.moment();
        let people = self.people.clone();
        let chairs = self.chairs.clone();
        self.people.retain(|p| *p != seat);
        self.chairs.remove(&seat);
        self.ai_seats.insert(seat);
        let players = self.state.players.len() as u8;
        self.ai_configs.insert(
            seat,
            create_config_for_players(self.level, Platform::Native, players),
        );
        let told = self.told.remove(&seat);
        let mut log = self.log();
        self.frames.clear();
        match self.advance(&mut log) {
            Ok(()) => {
                self.follow_printings();
                self.sit(HOST);
                Ok(self.settle(log))
            }
            Err(e) => {
                self.frames.clear();
                self.go_to(before);
                self.people = people;
                self.chairs = chairs;
                self.ai_seats.remove(&seat);
                self.ai_configs.remove(&seat);
                if let Some(told) = told {
                    self.told.insert(seat, told);
                }
                Err(e)
            }
        }
    }

    fn run(
        &mut self,
        action: PlaytestAction,
        choice: Option<BoardChoice>,
        out: &mut Log,
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
        if stage == PlaytestStage::Waiting {
            return Err(NOT_YOURS.into());
        }
        if is_sandbox(&action) && !self.sandbox {
            return Err(SANDBOX_OFF.into());
        }
        match action {
            PlaytestAction::Mulligan => {
                if stage != PlaytestStage::Mulligan {
                    return Err(ALREADY_KEPT.into());
                }
                self.apply(
                    self.you,
                    GameAction::MulliganDecision {
                        choice: MulliganChoice::Mulligan,
                    },
                    out,
                )?;
                self.mulligans = self.mulligans.saturating_add(1);
                out.own(
                    self.you,
                    PlaytestHappened::Mulliganed {
                        mulligans: self.mulligans,
                    },
                );
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
                let hand: HashSet<u64> = self.player(self.you).hand.iter().map(|id| id.0).collect();
                if bottom.iter().any(|id| !hand.contains(id)) {
                    return Err(NOT_IN_GAME.into());
                }
                self.apply(
                    self.you,
                    GameAction::MulliganDecision {
                        choice: MulliganChoice::Keep,
                    },
                    out,
                )?;
                if owed > 0 {
                    let cards = bottom.iter().map(|id| ObjectId(*id)).collect();
                    self.apply(self.you, GameAction::SelectCards { cards }, out)?;
                }
                out.own(
                    self.you,
                    PlaytestHappened::Kept {
                        size: self.player(self.you).hand.len() as u32,
                        bottomed: owed as u32,
                    },
                );
                let kept_at = out.mark();
                self.advance(out)?;
                // The first turn began inside `start_game`, before the hands were kept, and its
                // event went nowhere: it is told here, once the game is past the opening hands —
                // every person's, in a lobby's game.
                let first =
                    |h: &PlaytestHappened| matches!(h, PlaytestHappened::TurnBegan { turn: 1, .. });
                let opening = matches!(
                    self.state.waiting_for,
                    WaitingFor::MulliganDecision { .. } | WaitingFor::OpeningHandBottomCards { .. }
                );
                if !opening {
                    let started = self.started;
                    out.insert_unless(&kept_at, first, |eyes| PlaytestHappened::TurnBegan {
                        turn: 1,
                        seat: eyes.seat(started),
                    });
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
                    .ok_or("That answer is no longer on offer.")?;
                match choice {
                    Some(c) if c.kind == MANA_CHOICE => {
                        return self.make_mana(c.source, answer, out)
                    }
                    Some(c) => self.begin(c.source),
                    None => {}
                }
                self.apply(self.you, answer, out)?;
                self.advance(out)
            }
            PlaytestAction::Auto => {
                if stage != PlaytestStage::Prompt {
                    return Err(NO_PROMPT.into());
                }
                let (what, answer) = match choice {
                    // The board's own "which mana": the first, as the engine lists them.
                    Some(c) if c.kind == MANA_CHOICE => {
                        out.own(
                            self.you,
                            PlaytestHappened::Chose {
                                what: c.kind.into(),
                            },
                        );
                        let answer = c.actions.into_iter().next().ok_or(NO_MANA)?;
                        return self.make_mana(c.source, answer, out);
                    }
                    // The board's own "which way": the first, as the engine lists them.
                    Some(c) => {
                        self.begin(c.source);
                        (c.kind.to_string(), c.actions.into_iter().next())
                    }
                    None => (
                        self.state.waiting_for.variant_name().to_string(),
                        phase_ai::choose_action(&self.state, self.you, &self.helper, &mut self.rng),
                    ),
                };
                let answer = answer.ok_or("The rules engine has no answer to offer here.")?;
                out.own(self.you, PlaytestHappened::Chose { what });
                self.apply(self.you, answer, out)?;
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
                if let Some(least) = pick.power_min {
                    let total: i32 = ids
                        .iter()
                        .filter_map(|id| pick.eligible.iter().position(|e| e == id))
                        .filter_map(|i| pick.contributions.get(i))
                        .sum();
                    if total < least {
                        return Err(format!(
                            "The tapped creatures' total power is {total}; it must be at least {least}."
                        ));
                    }
                }
                self.apply(self.you, pick_answer(ids, answer), out)?;
                self.advance(out)
            }
            PlaytestAction::AssignDamage { blockers, excess } => {
                if stage != PlaytestStage::Prompt || choice.is_some() {
                    return Err(NO_PROMPT.into());
                }
                let answer = self.damage_answer(&blockers, excess)?;
                self.apply(self.you, answer, out)?;
                self.advance(out)
            }
            PlaytestAction::Distribute { shares } => {
                if stage != PlaytestStage::Prompt || choice.is_some() {
                    return Err(NO_PROMPT.into());
                }
                let answer = self.distribute_answer(&shares)?;
                self.apply(self.you, answer, out)?;
                self.advance(out)
            }
            PlaytestAction::MoveCounters { shares } => {
                if stage != PlaytestStage::Prompt || choice.is_some() {
                    return Err(NO_PROMPT.into());
                }
                let answer = self.counters_answer(&shares)?;
                self.apply(self.you, answer, out)?;
                self.advance(out)
            }
            PlaytestAction::OrderTriggers { order } => {
                if stage != PlaytestStage::Prompt || choice.is_some() {
                    return Err(NO_PROMPT.into());
                }
                let triggers = self
                    .triggers()
                    .ok_or("This question is not the order of triggers.")?;
                let mut seen = HashSet::new();
                if order.len() != triggers.len()
                    || order
                        .iter()
                        .any(|i| *i as usize >= triggers.len() || !seen.insert(*i))
                {
                    return Err("Put every trigger in the order once.".into());
                }
                let order = order.into_iter().map(|i| i as usize).collect();
                self.apply(self.you, GameAction::OrderTriggers { order }, out)?;
                self.advance(out)
            }
            PlaytestAction::KeepResults { indices } => {
                if stage != PlaytestStage::Prompt || choice.is_some() {
                    return Err(NO_PROMPT.into());
                }
                let answer = self.results_answer(&indices)?;
                self.apply(self.you, answer, out)?;
                self.advance(out)
            }
            PlaytestAction::Name { text } => {
                if stage != PlaytestStage::Prompt || choice.is_some() || !self.name_entry() {
                    return Err(NO_PROMPT.into());
                }
                let text = text.trim().to_string();
                let accepted = match &self.state.waiting_for {
                    WaitingFor::NamedChoice { choice_type, .. } => {
                        choice_type.accepts_free_entry_answer(&text)
                    }
                    _ => None,
                };
                if accepted != Some(true) {
                    return Err(format!("“{text}” can't be named here."));
                }
                self.apply(self.you, GameAction::ChooseOption { choice: text }, out)?;
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
            // The board's own question stays open, as it was: `act` puts it back on a refusal.
            _ if stage == PlaytestStage::Prompt => {
                Err("Answer the question first, or cancel it.".into())
            }
            // A hand on the table, wherever else the reader decides: the main phase, a
            // response, the declare steps (issue #1522).
            edit if is_sandbox(&edit) => self.edit(edit, stage, out),

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
                            .find(|t| matches!(t, AttackTarget::Player(p) if self.seat_of(*p) == player))
                            .copied()
                            .ok_or("That creature can't attack that player.")?,
                        (None, None) => open
                            .iter()
                            .find(|t| matches!(t, AttackTarget::Player(_)))
                            .copied()
                            .unwrap_or(AttackTarget::Player(self.others()[0])),
                        (Some(id), _) => open
                            .iter()
                            .find(|t| target_id(t) == Some(id))
                            .copied()
                            .ok_or("That creature can't attack that.")?,
                    };
                    declared.push((attacker, at));
                }
                self.apply(
                    self.you,
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
                self.apply(self.you, GameAction::DeclareBlockers { assignments }, out)?;
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
            PlaytestAction::TapForMana { id } => self.tap_for_mana(ObjectId(id), out),
            PlaytestAction::Pass => {
                self.apply(self.you, GameAction::PassPriority, out)?;
                self.advance(out)
            }
            PlaytestAction::EndTurn => {
                self.ending = Some(self.state.turn_number);
                self.apply(self.you, GameAction::PassPriority, out)?;
                self.advance(out)
            }
            _ => Err(MAIN_ONLY.into()),
        }
    }

    /// A sandbox action, at a decision of the reader's (`run` has checked it is one, and that the
    /// sandbox is on). phase takes its debug actions whatever it waits for, and re-reads the
    /// declare steps' attackers and blockers after one (`refresh_combat_declaration_waiting_for`)
    /// — but not a question's answers, so a question is answered first. In the main phase the
    /// game plays on as after any play (a trigger of the edit's resolves, and the reader is home
    /// again); anywhere else the reader is kept at the decision they edited at (`held`) — a
    /// response's window or a step they stopped at is not passed over because the table changed.
    /// An edit can end a declaration, though: with no creature left that could attack (or block),
    /// the empty declaration is the only one and phase makes it itself (CR 508.1a). That decision
    /// is gone, so the game plays on from there as after any action.
    fn edit(
        &mut self,
        action: PlaytestAction,
        stage: PlaytestStage,
        out: &mut Log,
    ) -> Result<(), String> {
        self.sandbox(action, out)?;
        let held = match stage {
            PlaytestStage::Main => false,
            PlaytestStage::Respond => true,
            _ => self.stage() == stage,
        };
        self.play_on(held, out)
    }

    /// The rules first: the one way to play it, or a question about which way. When the rules
    /// offer none, the sandbox puts it down unpaid (`unpaid`), and without the sandbox it is a
    /// refusal that says why. A card elsewhere than the hand or the command zone is cast when the
    /// rules let it be cast from there (a foretold card in exile, a flashback card in the
    /// graveyard); else it is activated rather than played — or, in the sandbox, put onto the
    /// battlefield when it has nothing to activate and is not there already (a double-click on a
    /// graveyard's creature).
    ///
    /// A card the reader neither owns nor controls is played only by the rules, and only when
    /// they offer it (issue #1713): an opponent's card in a graveyard or exile that an effect lets
    /// the reader cast — Hostage Taker's, Dire Fleet Daredevil's, a spell "from any graveyard".
    /// The sandbox's ways are for the reader's own cards.
    fn play(&mut self, id: ObjectId, out: &mut Log) -> Result<(), String> {
        let ways = self.plays_of(id);
        if self.own(id).is_err() && !ways.is_empty() {
            let name = self.editable(id)?.name.clone();
            return self.take_one(ways, "CastChoice", name, out, String::new);
        }
        let obj = self.own(id)?;
        let name = obj.name.clone();
        let zone = obj.zone;
        let by_hand = self.sandbox;
        if !matches!(zone, Zone::Hand | Zone::Command) {
            if !ways.is_empty() {
                return self.take_one(ways, "CastChoice", name, out, String::new);
            }
            if by_hand && zone != Zone::Battlefield && self.abilities_of(id).is_empty() {
                return self.put(id, Place::Battlefield, out);
            }
            return self.activate(id, out);
        }
        // A command-zone card the rules offer no cast of but an ability (commander ninjutsu).
        if ways.is_empty() && zone == Zone::Command && !self.abilities_of(id).is_empty() {
            return self.activate(id, out);
        }
        if ways.is_empty() && by_hand {
            return self.unpaid(id, out);
        }
        // With the sandbox on, a play the rules refuse was made unpaid above.
        self.take_one(ways, "CastChoice", name.clone(), out, || {
            format!(
                "{name} can't be played right now: no land drop left, too little mana, or nothing \
                 it could target. Turn the sandbox on to put it down by hand."
            )
        })
    }

    /// A card the rules will not play, played unpaid — the goldfish's escape hatch, the
    /// sandbox's now. Cast without paying its mana cost first (`cast_free`), so it is a spell
    /// cast from where it was and what it does when cast or as it enters happens: "if you cast it
    /// from your hand" (Wakening Sun's Avatar, issue #1075) as much as any other. Only when even
    /// that is not legal (a land past the land drop, nothing to target) is it put where it would
    /// have gone: a permanent onto the battlefield, an instant or sorcery into the graveyard (it
    /// was "cast" and is done). The log says "not paid for" (`Put`).
    fn unpaid(&mut self, id: ObjectId, out: &mut Log) -> Result<(), String> {
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
    fn cast_free(&mut self, id: ObjectId, out: &mut Log) -> Result<bool, String> {
        let before = self.checkpoint();
        self.free = Some(grant_emblem(
            &mut self.state,
            self.you,
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

    /// Every legal play or cast of `id`, from wherever it is (`is_play`).
    fn plays_of(&self, id: ObjectId) -> Vec<GameAction> {
        self.answers()
            .into_iter()
            .filter(|a| is_play(a) && a.source_object() == Some(id))
            .collect()
    }

    /// The rules only: foretell a hand card (CR 702.143a), paying {2} as phase pays a special
    /// action's cost, or a refusal that says why.
    fn foretell(&mut self, id: ObjectId, out: &mut Log) -> Result<(), String> {
        let obj = self.own(id)?;
        let name = obj.name.clone();
        let zone = obj.zone;
        let ways: Vec<GameAction> = self
            .answers()
            .into_iter()
            .filter(|a| matches!(a, GameAction::Foretell { object_id, .. } if *object_id == id))
            .collect();
        let yours = self.state.active_player == self.you;
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

    /// The rules only: a card's one activated ability, a question about which, or a refusal. A
    /// card the reader neither owns nor controls is activated only when the rules offer it — an
    /// opponent's permanent "any player may activate" (Oft-Nabbed Goat), as `play` takes an
    /// opponent's card the rules let the reader cast.
    fn activate(&mut self, id: ObjectId, out: &mut Log) -> Result<(), String> {
        let ways = self.abilities_of(id);
        let name = if self.own(id).is_err() && !ways.is_empty() {
            self.editable(id)?.name.clone()
        } else {
            self.own(id)?.name.clone()
        };
        self.take_one(ways, "AbilityChoice", name.clone(), out, || {
            format!("{name} has no ability you can activate right now.")
        })
    }

    /// The rules only, sandbox or not: one of the reader's permanents tapped for mana by its own
    /// mana ability (CR 605.3a), so the reader picks the sources a cast is paid from rather than
    /// phase's `Auto`. The mana floats in their pool, which a cast spends first, until the step or
    /// phase ends and the rules empty it (CR 500.4). One way is taken; several (a dual land's two
    /// colors, a creature's two mana abilities) are the board's `ManaChoice`; none is a refusal.
    fn tap_for_mana(&mut self, id: ObjectId, out: &mut Log) -> Result<(), String> {
        let name = self.own(id)?.name.clone();
        let mut ways: Vec<GameAction> = self
            .mana_ways()
            .into_iter()
            .filter(|a| mana_source(a) == Some(id))
            .collect();
        match ways.len() {
            0 => Err(format!("{name} can't make mana right now.")),
            1 => self.make_mana(name, ways.remove(0), out),
            _ => {
                self.choice = Some(BoardChoice {
                    kind: MANA_CHOICE,
                    source: name,
                    actions: ways,
                });
                Ok(())
            }
        }
    }

    /// Every mana ability the reader could activate now: phase's own list for a board to offer
    /// (`activatable_mana_actions_for_player`, which its land-tap reducer checks against) — a
    /// land's `TapLandForMana` for each kind of mana it makes, any other permanent's mana
    /// `ActivateAbility`. Mana abilities are not in `legal_actions` (they are no decision to
    /// auto-pass over), so `answers` never lists them.
    fn mana_ways(&self) -> Vec<GameAction> {
        if !matches!(self.state.waiting_for, WaitingFor::Priority { player } if player == self.you)
        {
            return Vec::new();
        }
        activatable_mana_actions_for_player(&self.state, self.you)
    }

    /// A mana ability activated: told as the reader's tap, its mana in their pool. Nothing plays
    /// on and the reader keeps priority where they were, since `advance` would pass a stop they
    /// were already stopped at. Only a question the ability itself asks (a cost to choose) is
    /// played on to, and can be cancelled back to before the tap, as a cast can.
    fn make_mana(&mut self, name: String, action: GameAction, out: &mut Log) -> Result<(), String> {
        self.begin(name.clone());
        out.own(
            self.you,
            PlaytestHappened::Tapped {
                seat: PlaytestPlayer::You,
                name,
                count: 1,
                tapped: true,
            },
        );
        self.apply(self.you, action, out)?;
        if matches!(self.state.waiting_for, WaitingFor::Priority { player } if player == self.you) {
            self.pending = None;
            return Ok(());
        }
        self.advance(out)
    }

    /// Every legal action `id` is the source of, but a play or a cast of it: its abilities, equip,
    /// crew and the like (`names_source`).
    fn abilities_of(&self, id: ObjectId) -> Vec<GameAction> {
        self.answers()
            .into_iter()
            .filter(|a| is_ability(a) && names_source(a, id))
            .collect()
    }

    /// One way: taken. Several: the board asks which. None: `refusal`.
    fn take_one(
        &mut self,
        mut ways: Vec<GameAction>,
        kind: &'static str,
        source: String,
        out: &mut Log,
        refusal: impl FnOnce() -> String,
    ) -> Result<(), String> {
        match ways.len() {
            0 => Err(refusal()),
            1 => {
                self.begin(source);
                self.apply(self.you, ways.remove(0), out)?;
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
    fn sandbox(&mut self, action: PlaytestAction, out: &mut Log) -> Result<(), String> {
        match action {
            PlaytestAction::Move { id, to } => self.put(ObjectId(id), to, out),
            PlaytestAction::Control { id, seat } => self.control(ObjectId(id), seat, out),
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
                    seat = self.seat_of(obj.controller);
                    self.debug(DebugAction::SetTapped {
                        object_id: id,
                        tapped,
                    })?;
                    count += 1;
                }
                if count > 0 {
                    out.own(
                        self.you,
                        PlaytestHappened::Tapped {
                            seat,
                            name,
                            count,
                            tapped,
                        },
                    );
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
                            .is_some_and(|o| o.controller == self.you && o.tapped)
                    })
                    .collect();
                for id in tapped {
                    self.debug(DebugAction::SetTapped {
                        object_id: id,
                        tapped: false,
                    })?;
                }
                out.own(self.you, PlaytestHappened::UntappedAll);
                Ok(())
            }
            PlaytestAction::Counters { id, kind, delta } => {
                let id = ObjectId(id);
                let obj = self.editable(id)?;
                let name = obj.name.clone();
                let seat = self.seat_of(obj.controller);
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
                out.own(
                    self.you,
                    PlaytestHappened::Counters {
                        seat,
                        name,
                        kind: counter_type.display_phrase().into_owned(),
                        count,
                    },
                );
                Ok(())
            }
            PlaytestAction::TokenCopy { id } => {
                // A copy of anyone's card is the reader's own token.
                let id = ObjectId(id);
                let name = self.editable(id)?.name.clone();
                self.debug(DebugAction::CreateTokenCopy {
                    source_id: id,
                    owner: self.you,
                    count: 1,
                    nonlegendary: false,
                })?;
                out.own(
                    self.you,
                    PlaytestHappened::TokensCreated {
                        seat: PlaytestPlayer::You,
                        name,
                        count: 1,
                    },
                );
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
                        owner: self.you,
                        power_override: None,
                        toughness_override: None,
                        enter_with_counters: Vec::new(),
                    },
                    count,
                    run_etb: true,
                })?;
                out.own(
                    self.you,
                    PlaytestHappened::TokensCreated {
                        seat: PlaytestPlayer::You,
                        name: offer.name,
                        count,
                    },
                );
                Ok(())
            }
            PlaytestAction::Draw { count } => {
                let before = self.player(self.you).hand.clone();
                self.debug(DebugAction::DrawCards {
                    player_id: self.you,
                    count: count.clamp(1, 99),
                })?;
                for id in self.player(self.you).hand.iter() {
                    if !before.contains(id) {
                        let name = self.state.objects.get(id).map(|o| o.name.clone());
                        out.own(
                            self.you,
                            PlaytestHappened::Drew {
                                seat: PlaytestPlayer::You,
                                name,
                            },
                        );
                    }
                }
                Ok(())
            }
            PlaytestAction::Mill { count } => {
                let before = self.player(self.you).graveyard.clone();
                self.debug(DebugAction::Mill {
                    player_id: self.you,
                    count: count.clamp(1, 99),
                })?;
                for id in self.player(self.you).graveyard.iter() {
                    if !before.contains(id) {
                        if let Some(o) = self.state.objects.get(id) {
                            out.own(
                                self.you,
                                PlaytestHappened::Moved {
                                    seat: PlaytestPlayer::You,
                                    name: Some(o.name.clone()),
                                    from: Place::LibraryTop,
                                    to: Place::Graveyard,
                                },
                            );
                        }
                    }
                }
                Ok(())
            }
            PlaytestAction::Shuffle => {
                self.debug(DebugAction::ShuffleLibrary {
                    player_id: self.you,
                })?;
                out.own(self.you, PlaytestHappened::Shuffled);
                Ok(())
            }
            PlaytestAction::SetLife { seat, life } => {
                let player = self.eyes().player(seat);
                if player.0 as usize >= self.state.players.len() {
                    return Err(NO_SUCH_PLAYER.into());
                }
                let was = self.player(player).life;
                let life = life.clamp(-999, 9999);
                self.debug(DebugAction::SetLife {
                    player_id: player,
                    life,
                })?;
                out.own(self.you, PlaytestHappened::LifeSet { seat, life, was });
                Ok(())
            }
            PlaytestAction::Mana { kind, delta } => self.mana(kind, delta, out),
            _ => Err(MAIN_ONLY.into()),
        }
    }

    /// Mana of `kind` added to the reader's pool by hand, or taken from it (issue #1723): the
    /// mana a card the engine does not play would have made, or a pool set up to try a line.
    /// Added through phase's own `AddMana`, which stamps each unit as produced mana is, so a
    /// cast spends it like any other; taken by the pool's own `spend`, since phase has no debug
    /// action that takes mana away. Only the reader's pool — an opponent's mana is theirs to
    /// make. It floats until a cast spends it or the rules empty the pool (CR 500.4). Taking
    /// more than is floating takes what there is; taking from none is a refusal.
    fn mana(&mut self, kind: ManaKind, delta: i32, out: &mut Log) -> Result<(), String> {
        let mana = mana_type(kind);
        let was = self.player(self.you).mana_pool.count_color(mana) as u32;
        let delta = delta.clamp(-MANA_EDIT_LIMIT, MANA_EDIT_LIMIT);
        if delta > 0 {
            self.debug(DebugAction::AddMana {
                player_id: self.you,
                mana: vec![mana; delta.unsigned_abs() as usize],
            })?;
        } else if delta < 0 {
            if was == 0 {
                let name = format!("{kind:?}").to_lowercase();
                return Err(format!(
                    "There is no {name} mana in your pool to take away."
                ));
            }
            let pool = &mut self.state.players[self.you.0 as usize].mana_pool;
            for _ in 0..delta.unsigned_abs().min(was) {
                pool.spend(mana);
            }
        } else {
            return Ok(());
        }
        let floating = self.player(self.you).mana_pool.count_color(mana) as u32;
        out.own(
            self.you,
            PlaytestHappened::ManaChanged {
                kind,
                delta: floating as i32 - was as i32,
                floating,
            },
        );
        Ok(())
    }

    /// Put a card somewhere by hand: no cost, no trigger, no replacement. Its owner's zone — an
    /// opponent's card goes to their hand, their graveyard, their library.
    fn put(&mut self, id: ObjectId, to: Place, out: &mut Log) -> Result<(), String> {
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
            if to == Place::Battlefield {
                self.enter_with_counters(id)?;
            }
        }
        out.own(
            self.you,
            PlaytestHappened::Put {
                seat: self.seat_of(owner),
                name,
                from,
                to,
            },
        );
        Ok(())
    }

    /// CR 306.5b + CR 310.4b: a planeswalker put onto the battlefield by hand enters with its
    /// loyalty, and a battle with its defense — phase's own intrinsic counters
    /// (`intrinsic_etb_counters`), which its inert debug move leaves off. Without them a
    /// planeswalker put down could never pay for a loyalty ability, its emblem's among them
    /// (issue #1333). Counters only, as the rules' entry gives them: a put still fires no trigger.
    fn enter_with_counters(&mut self, id: ObjectId) -> Result<(), String> {
        let Some(o) = self
            .state
            .objects
            .get(&id)
            .filter(|o| o.zone == Zone::Battlefield)
        else {
            return Ok(());
        };
        let missing: Vec<_> = intrinsic_etb_counters(o, None)
            .into_iter()
            .filter(|(kind, n)| *n > 0 && o.counters.get(kind).copied().unwrap_or(0) == 0)
            .collect();
        for (counter_type, n) in missing {
            self.debug(DebugAction::ModifyCounters {
                object_id: id,
                counter_type,
                delta: n as i32,
            })?;
        }
        Ok(())
    }

    /// Put a card under `seat`'s control by hand (issue #1713): no cost, no trigger, no
    /// replacement. A permanent changes controller where it lies (phase's `SetController`, which
    /// writes Layer 2's base, so the next layers pass keeps it); a card the table shows anywhere
    /// else is put onto the battlefield first, as `put` puts it, then given — "onto the
    /// battlefield under your control". It stays its owner's card: it goes to its owner's zones
    /// when it leaves.
    ///
    /// CR 302.6: either way it is summoning sick for its new controller, as phase's own control
    /// change makes it (its layers re-apply sickness on a change they see, and a debug change
    /// writes the controller before they look). CR 506.4 would take a permanent that changes
    /// control out of combat, which no debug action does, so one in combat is refused rather
    /// than left attacking or blocking for the other side.
    fn control(&mut self, id: ObjectId, seat: PlaytestPlayer, out: &mut Log) -> Result<(), String> {
        let player = self.eyes().player(seat);
        if player.0 as usize >= self.state.players.len() {
            return Err(NO_SUCH_PLAYER.into());
        }
        if self.player(player).is_eliminated {
            return Err(PLAYER_OUT.into());
        }
        let obj = self.editable(id)?;
        let from = place_of(obj.zone).ok_or(NOT_IN_GAME)?;
        let name = obj.name.clone();
        let owner = obj.owner;
        if from == Place::Battlefield {
            if obj.controller == player {
                return Ok(());
            }
            if self.in_combat(id) {
                return Err(format!(
                    "{name} is in combat. Change who controls it before attackers are declared \
                     or once combat is over."
                ));
            }
        } else if !is_permanent(obj) {
            return Err(format!(
                "{name} is not a permanent card, so nothing can control it on the battlefield."
            ));
        } else {
            self.debug(DebugAction::MoveToZone {
                object_id: id,
                to_zone: Zone::Battlefield,
                library_position: None,
                simulate: false,
            })?;
            self.enter_with_counters(id)?;
        }
        self.debug(DebugAction::SetController {
            object_id: id,
            controller: player,
        })?;
        self.debug(DebugAction::SetSummoningSickness {
            object_id: id,
            sick: true,
        })?;
        out.own(
            self.you,
            PlaytestHappened::Controlled {
                seat: self.seat_of(owner),
                name,
                from,
                controller: seat,
            },
        );
        Ok(())
    }

    /// Whether a permanent is attacking or blocking.
    fn in_combat(&self, id: ObjectId) -> bool {
        self.state.combat.as_ref().is_some_and(|c| {
            c.attackers.iter().any(|a| a.object_id == id) || c.blocker_to_attacker.contains_key(&id)
        })
    }

    // ── Playing on ────────────────────────────────────────────────────────────────────────

    /// Play on until the reader next decides: the AI takes every decision of its own, the
    /// goldfish answers each of its own by doing nothing (`fish_answer`), and the reader's
    /// priority is passed for them except where `stops_here` says otherwise. While the reader ends
    /// a turn (`ending`), their main phases are passed and they declare no attackers.
    fn advance(&mut self, out: &mut Log) -> Result<(), String> {
        self.play_on(false, out)
    }

    /// `advance`, but `held`: the reader has just changed the table by hand (`edit`) at a
    /// decision of theirs that is not their main phase, and stays at it — the first time the game
    /// comes back to their priority or their declaration they are stopped there, whatever
    /// `stops_here` would say now. A question the edit raised is still asked (or taken, when it
    /// has one answer) on the way.
    fn play_on(&mut self, held: bool, out: &mut Log) -> Result<(), String> {
        for _ in 0..STEP_LIMIT {
            self.tell_out(out);
            self.mark_dead();
            // The reader lost a game the others play on (CR 800.4a) — every person at the table,
            // in a lobby's game: it is over for them, and the AIs' game among themselves is not
            // played out.
            if self.people_out() {
                self.pending = None;
                return Ok(());
            }
            if let WaitingFor::GameOver { winner } = &self.state.waiting_for {
                if !self.over_told {
                    self.over_told = true;
                    let winner = *winner;
                    out.all(|eyes| PlaytestHappened::GameOver {
                        winner: winner.map(|w| eyes.seat(w)),
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
            if !actors.contains(&self.you) {
                // Another person's decision, in a lobby's game: the game plays on in their chair,
                // their priority passed by their own stops, until it needs them.
                let Some(&person) = actors.iter().find(|p| self.people.contains(p)) else {
                    return Err(format!(
                        "The rules engine is stuck at {}. Start a new game.",
                        self.state.waiting_for.variant_name()
                    ));
                };
                self.sit(person);
            }
            let ending = self.ending == Some(self.state.turn_number);
            let from = out.mark();
            match &self.state.waiting_for {
                WaitingFor::MulliganDecision { .. } | WaitingFor::OpeningHandBottomCards { .. } => {
                    return Ok(());
                }
                WaitingFor::Priority { .. } => {
                    // A cast is made once its spell is on the stack and the reader has priority
                    // again: whether they stop here or pass, it can no longer be taken back.
                    self.pending = None;
                    self.end_free()?;
                    if held || (!ending && self.stops_here()) {
                        return Ok(());
                    }
                    self.apply(self.you, GameAction::PassPriority, out)?;
                }
                WaitingFor::DeclareAttackers {
                    valid_attacker_ids, ..
                } => {
                    if held || !(ending || valid_attacker_ids.is_empty()) {
                        return Ok(());
                    }
                    self.apply(
                        self.you,
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
                    if held || !valid_blocker_ids.is_empty() {
                        return Ok(());
                    }
                    self.apply(
                        self.you,
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
                    out.own(
                        self.you,
                        PlaytestHappened::Chose {
                            what: self.state.waiting_for.variant_name().to_string(),
                        },
                    );
                    if self.apply(self.you, answer, out).is_err() {
                        // The engine refused its own one answer: the question is asked after all.
                        self.state = asked;
                        out.truncate(&from);
                        return Ok(());
                    }
                }
            }
            self.frame(&from, out);
        }
        Err("The rules engine did not come back to you. Start a new game.".into())
    }

    /// Each player who has left a game of more than two since the last look, as `Eliminated` —
    /// read off the players rather than phase's events, so a life total set by hand counts too. A
    /// duel's loser is told by `GameOver` alone.
    fn tell_out(&mut self, out: &mut Log) {
        if self.state.players.len() <= 2 {
            return;
        }
        for player in &self.state.players {
            if player.is_eliminated && self.out_told.insert(player.id) {
                let id = player.id;
                out.all(|eyes| PlaytestHappened::Eliminated {
                    seat: eyes.seat(id),
                });
            }
        }
    }

    /// The chair's person has lost and left a game of more than two, which the others would play
    /// on.
    fn reader_out(&self) -> bool {
        self.player(self.you).is_eliminated
            && !matches!(self.state.waiting_for, WaitingFor::GameOver { .. })
    }

    /// Every person at the table has lost and left a game the AIs would play on: the reader
    /// alone, in a game of one person.
    fn people_out(&self) -> bool {
        self.people.iter().all(|&p| self.player(p).is_eliminated)
            && !matches!(self.state.waiting_for, WaitingFor::GameOver { .. })
    }

    /// The reader's own main phase with an empty stack: where the board waits for them.
    fn at_home(&self) -> bool {
        self.state.stack.is_empty()
            && self.state.active_player == self.you
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
                    seat: self.seat_of(s.active_player).side(),
                    step,
                })
            });
            if asked && self.stopped_at != Some(here) {
                self.stopped_at = Some(here);
                return true;
            }
        }
        let theirs = s.stack.last().is_some_and(|top| top.controller != self.you);
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

    /// The goldfish's `dead_on`, kept up with what would have lost it the game: the reader's turn
    /// its life first reached 0 or less, or one commander's damage to it the lethal amount
    /// (CR 704.6c), and nothing once neither holds.
    fn mark_dead(&mut self) {
        let Some(fish) = self.fish else {
            return;
        };
        let s = &self.state;
        let lethal = s.format_config.commander_damage_threshold.map(u32::from);
        let commanded = lethal.is_some_and(|lethal| {
            s.commander_damage
                .iter()
                .any(|e| e.player == fish && e.damage >= lethal)
        });
        if self.player(fish).life > 0 && !commanded {
            self.dead_on = None;
        } else if self.dead_on.is_none() {
            self.dead_on = Some(self.player(HOST).turns_taken.max(1));
        }
    }

    /// A replay frame of the table now, with the facts since `from`, when there are any.
    /// Always the reader's: the view from their seat and their own line, whoever is in the chair.
    fn frame(&mut self, from: &Mark, out: &Log) {
        self.mark_dead();
        let happened = out.since(from);
        if !happened.is_empty() && self.frames.len() < self.frame_limit {
            let chair = self.you;
            self.sit(HOST);
            let view = self.view_as(true);
            self.sit(chair);
            self.frames.push(PlaytestFrame {
                view,
                happened: happened.to_vec(),
            });
        }
    }

    /// Every decision the AI can take now, in one batch: how many it took.
    fn run_ai(&mut self, out: &mut Log) -> Result<usize, String> {
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
            let from = out.mark();
            out.tell(&result.state, &result.events);
            if !out.since(&from).is_empty() && self.frames.len() < self.frame_limit {
                // The table as it was right after this decision: its state is swapped in for the
                // view and straight back out (both are persistent, so a swap is two pointers).
                std::mem::swap(&mut self.state, &mut result.state);
                self.frame(&from, out);
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

    /// One of the reader's own objects — the ones the board activates, and plays by every way it
    /// has (`play` takes an opponent's card only when the rules offer it).
    fn own(&self, id: ObjectId) -> Result<&engine::game::GameObject, String> {
        self.state
            .objects
            .get(&id)
            .filter(|o| !o.is_emblem && (o.owner == self.you || o.controller == self.you))
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
        if o.owner == self.you || o.controller == self.you {
            return Ok(o);
        }
        match o.zone {
            Zone::Battlefield | Zone::Graveyard | Zone::Exile | Zone::Command => Ok(o),
            Zone::Hand | Zone::Library => Err(HIDDEN.into()),
            Zone::Stack => Err(NOT_IN_GAME.into()),
        }
    }

    /// One action by `actor`, its events told as what happened.
    fn apply(&mut self, actor: PlayerId, action: GameAction, out: &mut Log) -> Result<(), String> {
        let result = apply(&mut self.state, actor, action).map_err(|e| e.to_string())?;
        out.tell(&self.state, &result.events);
        Ok(())
    }

    /// A sandbox action. Its events are not told: the action's own fact says what the reader did.
    fn debug(&mut self, action: DebugAction) -> Result<(), String> {
        apply(&mut self.state, self.you, GameAction::Debug(action))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Tests only: the emblems in the game, the goldfish's own among them — so a test can see a
    /// free cast's is gone.
    #[cfg(test)]
    pub(super) fn emblems_for_test(&self) -> usize {
        self.state.objects.values().filter(|o| o.is_emblem).count()
    }

    /// Tests only: the engine's game itself, for a test that sets up what no deck can be told to
    /// do — an opponent's spell on the stack, a question the engine parks on.
    #[cfg(test)]
    pub(super) fn state_for_test(&mut self) -> &mut GameState {
        &mut self.state
    }

    /// Tests only: put a card of `seat`'s from its library onto the battlefield, as if it had
    /// been played — the AI cannot be told what to cast.
    #[cfg(test)]
    pub(super) fn put_for_test(&mut self, seat: PlaytestPlayer, name: &str) {
        let player = self.eyes().player(seat);
        let id = self.state.players[player.0 as usize]
            .library
            .iter()
            .copied()
            .find(|id| self.state.objects[id].name == name)
            .expect("the card is in the library");
        apply(
            &mut self.state,
            self.you,
            GameAction::Debug(DebugAction::MoveToZone {
                object_id: id,
                to_zone: Zone::Battlefield,
                library_position: None,
                simulate: false,
            }),
        )
        .expect("the engine moves it");
    }

    /// Tests only: turn `seat`'s permanent `name` face down, as a morph or a manifest is — the
    /// flag alone, so a test sees the session hide the card whatever phase leaves on it.
    #[cfg(test)]
    pub(super) fn face_down_for_test(&mut self, seat: PlaytestPlayer, name: &str) -> u64 {
        let player = self.eyes().player(seat);
        let id = self
            .state
            .battlefield
            .iter()
            .copied()
            .find(|id| {
                let o = &self.state.objects[id];
                o.controller == player && o.name == name
            })
            .expect("the permanent is on the battlefield");
        self.state
            .objects
            .get_mut(&id)
            .expect("on the battlefield")
            .face_down = true;
        id.0
    }

    /// Undo (`back`) or redo: the game as it was before the last action, or before the last undo.
    fn travel(&mut self, back: bool) -> Result<PlaytestStep, String> {
        let now = self.moment();
        let then = if back {
            self.history.undo(now).ok_or(NOTHING_TO_UNDO)?
        } else {
            self.history.redo(now).ok_or(NOTHING_TO_REDO)?
        };
        self.go_to(then);
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
            you: self.you,
            chairs: self.chairs.clone(),
        }
    }

    /// Back to `then`, whole: for undo and redo, and for a refusal. The chair goes back to the
    /// seat it was in, with that seat's stops and tokens as they are now (settings, not the game),
    /// and every other person's place to where it was.
    fn go_to(&mut self, then: Moment) {
        self.sit(then.you);
        self.chairs = then.chairs;
        self.restore(then.checkpoint);
        self.pending = then.pending;
        self.choice = then.choice;
        self.over_told = then.over_told;
        self.ending = then.ending;
        self.stopped_at = then.stopped_at;
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
            | PlaytestAction::Control { .. }
            | PlaytestAction::Tap { .. }
            | PlaytestAction::UntapAll
            | PlaytestAction::Counters { .. }
            | PlaytestAction::TokenCopy { .. }
            | PlaytestAction::CreateToken { .. }
            | PlaytestAction::Draw { .. }
            | PlaytestAction::Mill { .. }
            | PlaytestAction::Shuffle
            | PlaytestAction::SetLife { .. }
            | PlaytestAction::Mana { .. }
    )
}

/// The name of the card an object is: a face-down card's is the card underneath (`back_face`,
/// as phase writes it for whoever may look, CR 708.5) — the session decides who that is.
fn face_name(o: &engine::game::GameObject) -> &str {
    match (&o.back_face, o.face_down) {
        (Some(back), true) => &back.name,
        _ => &o.name,
    }
}

/// A card the reader may not look at: its back alone, with no name, printing or gaps.
fn hidden(c: GameCard) -> GameCard {
    GameCard {
        name: String::new(),
        card_id: None,
        type_line: String::new(),
        face_down: true,
        counters: Vec::new(),
        effects: Vec::new(),
        chosen: Vec::new(),
        gaps: Vec::new(),
        ..c
    }
}

/// What the reader's seat may see of the hidden cards (`Playtest::sight`).
struct Sight {
    seen: HashSet<ObjectId>,
}

/// The card an object of this name is a face of (`Playtest::card_names`): the card's own name
/// for a back face, `name` itself otherwise.
fn card_name<'a>(card_names: &'a HashMap<String, String>, name: &'a str) -> &'a str {
    card_names.get(name).map_or(name, String::as_str)
}

/// What a stack entry targets, for the board's arrows: the cards the table shows and the players,
/// each once, in the order chosen — the spell's or ability's own targets and its follow-on
/// abilities' ("… and another target creature"), and an equip's creature. A card in a hand or a
/// library is not shown, so it is not told.
pub(super) fn stack_targets(
    state: &GameState,
    entry: &StackEntry,
    eyes: Eyes,
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
                let p = eyes.seat(p);
                if !players.contains(&p) {
                    players.push(p);
                }
            }
        }
    }
    (cards, players)
}

/// The most triggers whose every order phase's `legal_actions` lists (its
/// `order_triggers_candidates`); past it, it lists only two orders, and `triggers` asks.
const ORDERS_LISTED: usize = 4;

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
    /// `FreeCastWindowChoice`: the one card cast, or none to close the window.
    FreeCast,
    /// `SubmitPilePartition`: the cards of the first pile.
    PileA,
    /// `CrewVehicle`: the creatures tapped to crew this Vehicle.
    Crew(ObjectId),
    /// `SaddleMount`: the creatures tapped to saddle this Mount.
    Saddle(ObjectId),
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
        PickAnswer::FreeCast => GameAction::FreeCastWindowChoice {
            selection: ids.first().copied().map(ObjectId),
        },
        PickAnswer::PileA => GameAction::SubmitPilePartition { pile_a: objects() },
        PickAnswer::Crew(vehicle_id) => GameAction::CrewVehicle {
            vehicle_id,
            creature_ids: objects(),
        },
        PickAnswer::Saddle(mount_id) => GameAction::SaddleMount {
            mount_id,
            creature_ids: objects(),
        },
    }
}

/// A cost whose payment is a set of the cards it lists (`PayCost`'s `choices`), which a pick
/// answers: sacrificed, discarded, exiled, returned or revealed. A cost counted otherwise — a
/// total of power to tap, counters to remove, mana — keeps its generic answers.
fn pays_with_cards(kind: &PayCostKind) -> bool {
    matches!(
        kind,
        PayCostKind::Discard
            | PayCostKind::Sacrifice
            | PayCostKind::ReturnToHand
            | PayCostKind::ExileFromZone { .. }
            | PayCostKind::ExilePermanent { .. }
            | PayCostKind::Reveal {
                shared_quality: None
            }
    )
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
fn collect_refs(
    value: &Value,
    eyes: Eyes,
    ids: &mut Vec<ObjectId>,
    players: &mut Vec<PlaytestPlayer>,
) {
    match value {
        Value::Number(n) => {
            if let Some(id) = n.as_u64() {
                ids.push(ObjectId(id));
            }
        }
        Value::Array(items) => items
            .iter()
            .for_each(|v| collect_refs(v, eyes, ids, players)),
        Value::Object(map) => {
            if let Some(id) = map.get("Object").and_then(Value::as_u64) {
                ids.push(ObjectId(id));
            }
            if let Some(p) = map.get("Player").and_then(Value::as_u64) {
                players.push(eyes.seat(PlayerId(p as u8)));
            }
        }
        _ => {}
    }
}

/// The permanent a mana action of `mana_ways` taps or activates.
fn mana_source(action: &GameAction) -> Option<ObjectId> {
    match action {
        GameAction::TapLandForMana { selection } => Some(selection.source.object_id),
        GameAction::ActivateAbility { source_id, .. } => Some(*source_id),
        _ => None,
    }
}

/// The phrases a question lists for its options, by phase's naming: its first list of words
/// under a key ending `_descriptions` — a modal spell's `mode_descriptions`, a branch's
/// `branch_descriptions` — searched two levels into its data.
fn phrases(question: &Value) -> Vec<String> {
    fn find(v: &Value, depth: u8) -> Option<Vec<String>> {
        let Value::Object(fields) = v else {
            return None;
        };
        let words = fields
            .iter()
            .filter(|(key, _)| key.ends_with("_descriptions"))
            .find_map(|(_, value)| {
                let items = value.as_array()?;
                let words: Vec<String> = items
                    .iter()
                    .filter_map(|w| w.as_str().map(str::to_string))
                    .collect();
                (!words.is_empty() && words.len() == items.len()).then_some(words)
            });
        if words.is_some() || depth == 0 {
            return words;
        }
        fields.values().find_map(|value| find(value, depth - 1))
    }
    find(question, 2).unwrap_or_default()
}

/// One of a question's `options`, in words: a cast's variant and the face it casts (`Omen`,
/// `Normal Back`), a named option's name, or a plain word.
fn option_word(option: &Value) -> Option<String> {
    if let Some(variant) = option.get("variant").and_then(tag_of) {
        let face = option.get("face").and_then(tag_of);
        return Some(match face.as_deref() {
            None | Some("Current" | "Front") => variant,
            Some(face) => format!("{variant} {face}"),
        });
    }
    option
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| tag_of(option))
}

/// A word on the wire: a string, or the tag of one of phase's `#[serde(tag = "type")]` enums.
fn tag_of(value: &Value) -> Option<String> {
    value
        .as_str()
        .or_else(|| value.get("type")?.as_str())
        .map(str::to_string)
}

/// The mana a `ManaChoice` answer makes: `{ "type": "SingleColor", "data": "Black" }` is
/// `Black`, `{ "type": "Combination", "data": ["White", "Blue"] }` is `White Blue`. Any other
/// choice is `None`.
fn mana_of(value: &Value) -> Option<String> {
    serde_json::from_value::<ManaChoice>(value.clone()).ok()?;
    match value.get("data")? {
        Value::String(one) => Some(one.clone()),
        Value::Array(types) => Some(
            types
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    }
}

/// Whether a legal action plays or casts its card — phase's own play-or-cast family, as its
/// board's `isPlayOrCastAction` reads it: a land, a cast, a free cast (Zaffai), a miracle, madness,
/// a sneak or web-slinging cast, a face-down cast (morph, disguise).
fn is_play(action: &GameAction) -> bool {
    matches!(
        action,
        GameAction::PlayLand { .. }
            | GameAction::CastSpell { .. }
            | GameAction::CastSpellForFree { .. }
            | GameAction::CastSpellAsMiracle { .. }
            | GameAction::CastSpellAsMadness { .. }
            | GameAction::CastSpellAsSneak { .. }
            | GameAction::CastSpellAsWebSlinging { .. }
            | GameAction::PlayFaceDown { .. }
    )
}

/// Whether a legal action is an activation (`abilities_of`): anything of one object's (phase's
/// `source_object`) but a play, a cast or a foretelling, which the board offers rows of their own.
fn is_ability(action: &GameAction) -> bool {
    action.source_object().is_some()
        && !is_play(action)
        && !matches!(action, GameAction::Foretell { .. })
}

/// Whether an action is something `id` does — phase's own `source_object`, which classifies every
/// answer: the source, the equipment, the vehicle, the ninjutsu card, the object acted on.
fn names_source(action: &GameAction, id: ObjectId) -> bool {
    action.source_object() == Some(id)
}

/// What a run of the engine's events comes to, as the log's facts. `state` is the game after
/// them, which names the objects they point at. An opponent's draws are told without the card,
/// and so is anything of theirs face down.
pub(super) fn tell(
    state: &GameState,
    events: &[GameEvent],
    eyes: Eyes,
    out: &mut Vec<PlaytestHappened>,
) {
    let secret = |id: &ObjectId| state.objects.get(id).is_some_and(|o| eyes.concealed(o));
    let name = |id: &ObjectId| {
        state
            .objects
            .get(id)
            .filter(|o| !eyes.concealed(o))
            .map(|o| o.name.clone())
    };
    let seat = |id: &ObjectId| state.objects.get(id).map(|o| eyes.seat(o.controller));
    // The emblems these events made, oldest first: the newest in the command zone, one for each
    // emblem made (`create_emblem::resolve`). Read off the emblem, not the effect's source — a
    // planeswalker whose last loyalty paid for it is gone by now.
    let made = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                GameEvent::EffectResolved {
                    kind: EffectKind::CreateEmblem,
                    ..
                }
            )
        })
        .count();
    let mut emblems: Vec<ObjectId> = state
        .command_zone
        .iter()
        .copied()
        .filter(|id| state.objects.get(id).is_some_and(|o| o.is_emblem))
        .collect();
    emblems.sort();
    let mut emblems = emblems
        .split_off(emblems.len().saturating_sub(made))
        .into_iter();
    let lands: BTreeSet<ObjectId> = events
        .iter()
        .filter_map(|e| match e {
            GameEvent::LandPlayed { object_id, .. } => Some(*object_id),
            _ => None,
        })
        .collect();
    // A card that goes from a library to a hand is a draw only when it was drawn (CR 121.1); a
    // tutor's find is told as a move, and named only to its owner or once it was revealed.
    let drawn: BTreeSet<ObjectId> = events
        .iter()
        .filter_map(|e| match e {
            GameEvent::CardDrawn { object_id, .. } => Some(*object_id),
            _ => None,
        })
        .collect();
    let revealed: BTreeSet<&str> = events
        .iter()
        .flat_map(|e| match e {
            GameEvent::CardsRevealed { card_names, .. } => card_names.as_slice(),
            _ => &[],
        })
        .map(String::as_str)
        .collect();
    // A foretold card's move to exile is told as its foretelling, which hides an opponent's card.
    let foretold: BTreeSet<ObjectId> = events
        .iter()
        .filter_map(|e| match e {
            GameEvent::Foretold { object_id, .. } => Some(*object_id),
            _ => None,
        })
        .collect();
    for (at, event) in events.iter().enumerate() {
        match event {
            GameEvent::TurnStarted {
                player_id,
                turn_number,
            } => out.push(PlaytestHappened::TurnBegan {
                turn: *turn_number,
                seat: eyes.seat(*player_id),
            }),
            GameEvent::LandPlayed {
                object_id,
                player_id,
                ..
            } => {
                if let Some(name) = name(object_id) {
                    out.push(PlaytestHappened::Played {
                        seat: eyes.seat(*player_id),
                        name,
                    });
                }
            }
            GameEvent::SpellCast {
                object_id,
                controller,
                ..
            } => {
                if secret(object_id) {
                    out.push(PlaytestHappened::Cast {
                        seat: eyes.seat(*controller),
                        name: None,
                    });
                } else if let Some(name) = name(object_id) {
                    out.push(PlaytestHappened::Cast {
                        seat: eyes.seat(*controller),
                        name: Some(name),
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
                if matches!(kind, ActivatedAbilityKind::Mana) || secret(source_id) {
                    continue;
                }
                let source = name(source_id)
                    .or_else(|| departed_source_lki.as_ref().map(|l| l.name.clone()));
                if let Some(name) = source {
                    out.push(PlaytestHappened::Activated {
                        seat: eyes.seat(*player_id),
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
                let whose = eyes.seat(owner);
                let hidden = whose != PlaytestPlayer::You;
                match (from, to) {
                    (Zone::Library, Zone::Hand) if drawn.contains(object_id) => {
                        out.push(PlaytestHappened::Drew {
                            seat: whose,
                            name: (!hidden).then(|| record.name.clone()),
                        })
                    }
                    (Zone::Library, Zone::Hand) => out.push(PlaytestHappened::Moved {
                        seat: whose,
                        name: (!hidden || revealed.contains(record.name.as_str()))
                            .then(|| record.name.clone()),
                        from: from_place,
                        to: to_place,
                    }),
                    // A card going back to a hidden zone the reader cannot follow.
                    (Zone::Hand, Zone::Library) if hidden => {}
                    (Zone::Library, Zone::Library) => {}
                    // An opponent's card that is face down where it went (a hideaway card, a
                    // manifest) is theirs to know.
                    _ => out.push(PlaytestHappened::Moved {
                        seat: whose,
                        name: (!secret(object_id)).then(|| record.name.clone()),
                        from: from_place,
                        to: to_place,
                    }),
                }
            }
            GameEvent::Foretold {
                player_id,
                object_id,
            } => {
                let whose = eyes.seat(*player_id);
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
            GameEvent::CombatDamageDealtToPlayer {
                player_id,
                source_amounts,
                ..
            } => {
                for (source_id, amount) in source_amounts {
                    // The engine's own count is the authority on which sources are commanders.
                    let Some(total) = state
                        .commander_damage
                        .iter()
                        .find(|e| e.player == *player_id && e.commander == *source_id)
                        .map(|e| e.damage)
                    else {
                        continue;
                    };
                    let Some(source) = name(source_id).filter(|_| *amount > 0) else {
                        continue;
                    };
                    // The count is the one after the whole batch: a double striker's first-strike
                    // hit is told with what it had reached before its second.
                    let later: u32 = events[at + 1..]
                        .iter()
                        .filter_map(|e| match e {
                            GameEvent::CombatDamageDealtToPlayer {
                                player_id: p,
                                source_amounts,
                                ..
                            } if p == player_id => Some(
                                source_amounts
                                    .iter()
                                    .filter(|(id, _)| id == source_id)
                                    .map(|(_, n)| n)
                                    .sum::<u32>(),
                            ),
                            _ => None,
                        })
                        .sum();
                    out.push(PlaytestHappened::CommanderDamage {
                        source,
                        source_id: source_id.0,
                        seat: eyes.seat(*player_id),
                        amount: *amount,
                        total: total.saturating_sub(later),
                    });
                }
            }
            GameEvent::LifeChanged {
                player_id,
                amount,
                new_total,
            } => out.push(PlaytestHappened::Life {
                seat: eyes.seat(*player_id),
                amount: *amount,
                // phase reports the total with the change when it can; the life after the
                // action is the fallback, the same unless one action changed it twice.
                total: new_total
                    .0
                    .unwrap_or(state.players[player_id.0 as usize].life),
            }),
            GameEvent::EffectResolved {
                kind: EffectKind::CreateEmblem,
                ..
            } => {
                if let Some(o) = emblems.next().and_then(|id| state.objects.get(&id)) {
                    out.push(PlaytestHappened::Emblem {
                        seat: eyes.seat(o.controller),
                        source: o.emblem_source.as_ref().map(|e| e.name.clone()),
                    });
                }
            }
            GameEvent::CardsRevealed {
                player, card_names, ..
            } if !card_names.is_empty() => out.push(PlaytestHappened::Revealed {
                seat: eyes.seat(*player),
                names: card_names.clone(),
            }),
            GameEvent::SpellCountered {
                object_id,
                countered_by,
                ..
            } => {
                let o = state.objects.get(object_id);
                out.push(PlaytestHappened::Countered {
                    seat: o.map_or(PlaytestPlayer::Opponent, |o| eyes.seat(o.owner)),
                    name: name(object_id),
                    by: name(countered_by),
                });
            }
            GameEvent::CoinFlipped { player_id, won } => out.push(PlaytestHappened::Flipped {
                seat: eyes.seat(*player_id),
                won: *won,
            }),
            GameEvent::DieRolled {
                player_id,
                sides,
                result,
                ..
            } => out.push(PlaytestHappened::Rolled {
                seat: eyes.seat(*player_id),
                sides: u32::from(*sides),
                result: result.map(u32::from),
            }),
            GameEvent::CardNamed {
                player_id, name, ..
            } => out.push(PlaytestHappened::Named {
                seat: eyes.seat(*player_id),
                name: name.clone(),
            }),
            GameEvent::MonarchChanged { player_id } => out.push(PlaytestHappened::Became {
                seat: eyes.seat(*player_id),
                what: PlaytestDesignation::Monarch,
            }),
            GameEvent::InitiativeTaken { player_id } => out.push(PlaytestHappened::Became {
                seat: eyes.seat(*player_id),
                what: PlaytestDesignation::Initiative,
            }),
            GameEvent::CityBlessingGained { player_id } => out.push(PlaytestHappened::Became {
                seat: eyes.seat(*player_id),
                what: PlaytestDesignation::CityBlessing,
            }),
            GameEvent::RingTemptsYou { player_id, .. } => out.push(PlaytestHappened::Became {
                seat: eyes.seat(*player_id),
                what: PlaytestDesignation::RingTempted,
            }),
            GameEvent::DayNightChanged { .. } => {
                if let Some(now) = state.day_night {
                    out.push(PlaytestHappened::DayNight {
                        now: match now {
                            DayNight::Day => PlaytestDayNight::Day,
                            DayNight::Night => PlaytestDayNight::Night,
                        },
                    });
                }
            }
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
