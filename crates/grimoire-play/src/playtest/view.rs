//! What the playtest board is told: the game as the reader sees it from their seat, and what an
//! action (theirs, the opponent's, the engine's) did.
//!
//! **Facts, not sentences**, as the goldfish's wire (`crate::view`): the page writes the log
//! (`features/playtesting/play/log.ts`). Mirrored by hand in `packages/ui/lib/ipc/playtest.ts`,
//! held field for field by `ipc.test.ts`. The card, its lane, its counters, the places a card can
//! be put and the two seats are the goldfish's own types: a card on this table is drawn by the
//! same components as a card on that one.
//!
//! **What the reader may not see is not sent.** The opponent's hand and library are counts, never
//! cards; a card the opponent draws is "drew a card" with no name.

use serde::{Deserialize, Serialize};

use crate::view::{GameCard, ManaTable, MulliganView, Place, Seat, TokenOffer};

/// The whole table after an action, from the reader's seat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestView {
    /// What the game is waiting on the reader for — the board's mode.
    pub stage: PlaytestStage,
    /// The game's turn number, both seats' turns counted, from 1. 0 during the opening hands.
    pub turn: u32,
    /// Whose turn it is.
    pub active: Seat,
    /// Who played first (the seed's coin flip).
    pub started: Seat,
    pub phase: PlaytestPhase,
    /// The step within `phase`, for the steps a player gets priority in (`None` in the untap step,
    /// at the end of combat and in cleanup) — the stops' names for them.
    pub step: Option<PlaytestStopStep>,
    /// Present while the reader's opening hand is being decided.
    pub mulligan: Option<MulliganView>,
    pub you: PlaytestSeat,
    /// The opponent's side. `hand` and `library_cards` are always empty: their counts are what the
    /// reader may know.
    pub opponent: PlaytestSeat,
    /// The creatures in combat right now, both seats', while a combat is on.
    pub combat: Option<PlaytestCombat>,
    /// Present in `Stage::Attack`: which of the reader's creatures may attack.
    pub attack: Option<PlaytestAttack>,
    /// Present in `Stage::Block`: which of the reader's creatures may block, and what each may
    /// block.
    pub block: Option<PlaytestBlock>,
    /// Present in `Stage::Prompt`: the question the engine is asking the reader.
    pub prompt: Option<PlaytestPrompt>,
    /// Spells and abilities waiting to resolve, the top **first**.
    pub stack: Vec<PlaytestStackItem>,
    /// Present in `Stage::Over`: who won, or `None` for a draw.
    pub winner: Option<Seat>,
    /// The tokens the reader's deck makes, for the game menu's "Create a token".
    pub tokens: Vec<TokenOffer>,
    /// The steps the reader asked to be stopped at (the game menu's stops), as `setStops` set
    /// them.
    pub stops: Vec<PlaytestStop>,
    /// The reader is ending the turn (`endTurn`): until it changes, the game stops only to block
    /// or to answer a question.
    pub ending_turn: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaytestStage {
    /// The reader's opening hand: keep it, or mulligan.
    Mulligan,
    /// The reader's main phase with nothing on the stack: play, cast, activate, or pass on.
    Main,
    /// The reader's declare-attackers step.
    Attack,
    /// The reader is the defending player: declare blockers.
    Block,
    /// The reader has priority with something to answer: the opponent's spell or ability on the
    /// stack, combat after blockers, or a step the reader asked to stop at — and an instant or an
    /// ability they could use. Pass, or play something.
    Respond,
    /// The engine asks the reader something: a target, a mode, a "may", a card to discard.
    Prompt,
    /// Only in a replay frame (`PlaytestFrame`): the game is moving on by itself — the
    /// opponent's turn, a spell resolving, combat damage — and the board watches.
    Watching,
    /// The game is over (`winner` says how).
    Over,
}

/// The turn's phase, coarse: the board shows where the turn is, not every step of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaytestPhase {
    /// Untap, upkeep and draw.
    Beginning,
    /// The precombat main phase.
    Main1,
    Combat,
    /// The postcombat main phase.
    Main2,
    /// The end step and cleanup.
    Ending,
}

/// One seat's side of the table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestSeat {
    pub life: i32,
    pub poison: u32,
    /// The reader's hand; empty for the opponent.
    pub hand: Vec<GameCard>,
    pub hand_count: u32,
    pub battlefield: Vec<GameCard>,
    /// Oldest first: the last is the top of the graveyard.
    pub graveyard: Vec<GameCard>,
    pub exile: Vec<GameCard>,
    /// This seat's commanders while they are in the command zone.
    pub command: Vec<GameCard>,
    pub library: u32,
    /// The reader's library, **top first**, for the library menu's look and search; empty for the
    /// opponent.
    pub library_cards: Vec<GameCard>,
    /// What this seat's untapped permanents could make right now (phase's `max_mana_yield`).
    pub mana_open: u32,
    /// The same open mana by type, and what is floating in the pool (`crate::view::ManaTable`).
    pub mana: ManaTable,
}

/// The creatures in combat: each attacker and what it attacks, and each block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestCombat {
    /// Every attacker, whichever seat attacks.
    pub attacks: Vec<PlaytestAttackPair>,
    pub blocks: Vec<PlaytestBlockPair>,
}

/// One attacker and what it attacks: `target` is a planeswalker's or a battle's id, or `None`
/// for the defending player.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestAttackPair {
    pub attacker: u64,
    pub target: Option<u64>,
}

/// One blocker on one attacker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestBlockPair {
    pub blocker: u64,
    pub attacker: u64,
}

/// The reader's declare-attackers step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestAttack {
    /// The reader's creatures that can attack, and what each can attack.
    pub attackers: Vec<PlaytestAttacker>,
    /// The planeswalkers and battles any of them can attack, to name them.
    pub targets: Vec<PlaytestCardRef>,
}

/// One creature that can attack.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestAttacker {
    pub id: u64,
    /// It can attack the opponent.
    pub player: bool,
    /// The planeswalkers and battles it can attack.
    pub targets: Vec<u64>,
}

/// The reader's declare-blockers step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestBlock {
    pub blockers: Vec<PlaytestBlocker>,
}

/// One of the reader's creatures that can block, and the attackers it can block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestBlocker {
    pub id: u64,
    pub attackers: Vec<u64>,
}

/// A question the engine asks the reader, as the choices it would accept.
///
/// **Generic on purpose.** phase's engine has well over a hundred kinds of question, and each
/// one's answers are its legal actions — so a prompt is the kind (phase's `WaitingFor` variant
/// name, which the page puts in words) and its options, each an answer named by the facts in
/// it: the cards and players it points at, a number, a yes or no. When there are none the page
/// can draw, `auto` still answers it: the engine's own AI chooses for the reader.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestPrompt {
    /// phase's name for the question: `TargetSelection`, `ModeChoice`, `DiscardChoice`… — or
    /// `CastChoice` / `AbilityChoice` for the board's own "which way to cast or activate this".
    pub kind: String,
    /// The card the question is about — the spell being cast, the ability's source — when
    /// there is one.
    pub source: Option<String>,
    pub options: Vec<PlaytestOption>,
    /// The question came out of the reader's own cast or activation, which `cancel` takes back.
    pub cancellable: bool,
    /// Present when the answer is a set of cards — scry, surveil, a discard, a search — which
    /// `options` cannot list (the engine offers only a few of the sets). `pickCards` answers it.
    pub pick: Option<PlaytestPick>,
}

/// A question whose answer is some of a set of cards.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestPick {
    pub purpose: PlaytestPickPurpose,
    /// The cards being looked at, in order (a scry's top first).
    pub cards: Vec<PlaytestCardRef>,
    /// The ids among them that may be picked.
    pub eligible: Vec<u64>,
    pub min: u32,
    pub max: u32,
    /// The order of the picked cards counts: a scry's or a surveil's picked cards are the ones
    /// kept on top, first picked on top.
    pub ordered: bool,
}

/// What picking a card does, so the page can say it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaytestPickPurpose {
    /// The picked cards stay on top, in order; the rest go to the bottom.
    Scry,
    /// The picked cards stay on top, in order; the rest go to the graveyard.
    Surveil,
    /// The picked cards are discarded.
    Discard,
    /// The picked cards are the ones found.
    Search,
    /// The picked cards are kept; the rest go where the card says.
    Dig,
    /// The picked cards are revealed.
    Reveal,
    /// The picked cards are the targets.
    Targets,
    /// The picked cards are the ones chosen.
    Choose,
}

/// A step the reader asked the game to stop at, on whose turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestStop {
    pub seat: Seat,
    pub step: PlaytestStopStep,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaytestStopStep {
    Upkeep,
    Draw,
    Main1,
    BeginCombat,
    Attackers,
    Blockers,
    Damage,
    Main2,
    End,
}

/// One answer to a prompt, by the facts in it. Every field but `index` and `kind` may be empty.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestOption {
    /// What `choose` sends back.
    pub index: u32,
    /// phase's name for the answer: `ChooseTarget`, `SelectCards`, `DecideOptionalEffect`,
    /// `CastSpell`, `ActivateAbility`…
    pub kind: String,
    /// The cards the answer names, in order.
    pub cards: Vec<PlaytestCardRef>,
    /// The players the answer names.
    pub players: Vec<Seat>,
    /// A number the answer carries: X, a mode's index, an ability's index.
    pub number: Option<i64>,
    /// A yes or a no: accept the "may", pay the cost, put it on top.
    pub yes: Option<bool>,
    /// A named choice's own word, as the card prints it (a color, a creature type, a mode).
    pub label: Option<String>,
}

/// A card an option names: its id (which the board lights up) and its name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestCardRef {
    pub id: u64,
    pub name: String,
    pub card_id: Option<String>,
    /// Present when the ref stands for one of the card's abilities rather than the card: a
    /// trigger to put in order, a replacement effect to choose — the ability's words, as the
    /// engine gives them.
    pub text: Option<String>,
}

/// One spell or ability on the stack.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestStackItem {
    pub id: u64,
    /// The spell, or the ability's source.
    pub name: String,
    pub card_id: Option<String>,
    pub seat: Seat,
    /// An ability rather than a spell.
    pub ability: bool,
}

/// What the AI opponent plays like: phase's difficulty presets, from random to competitive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Difficulty {
    VeryEasy,
    Easy,
    #[default]
    Medium,
    Hard,
    VeryHard,
}

/// Everything the board can ask of a game.
///
/// The goldfish's sandbox moves are here under the goldfish's names — a hand on the reader's own
/// cards is the escape hatch for a card the rules cannot play — and the rest is the rules:
/// passing, attacking, blocking, and answering the engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PlaytestAction {
    Mulligan,
    Keep {
        bottom: Vec<u64>,
    },
    /// A card from the hand or the command zone, by the rules: a land drop, or a cast paid from
    /// untapped mana. One way to do it is done; several are a `CastChoice` prompt; none is a
    /// refusal that says why (the sandbox's `move` still puts it down).
    Play {
        id: u64,
    },
    /// A permanent's activated ability, by the rules. One is activated; several are an
    /// `AbilityChoice` prompt.
    Activate {
        id: u64,
    },
    /// Pass priority on to the next place the reader decides something: from the first main
    /// phase to combat, from the second to the opponent's turn.
    Pass,
    /// Pass until this turn is over: the rest of the reader's own turn without attacking, or the
    /// rest of the opponent's without stopping to respond. Blocks and questions still stop it.
    EndTurn,
    /// The steps to stop at from now on, replacing the last set. Taken at any stage.
    SetStops {
        stops: Vec<PlaytestStop>,
    },
    /// Declare these attacks. Empty is no attack.
    Attack {
        attacks: Vec<PlaytestAttackPair>,
    },
    /// Declare these blocks. Empty is no blocks.
    Block {
        blocks: Vec<PlaytestBlockPair>,
    },
    /// Answer the prompt with its option `index`.
    Choose {
        index: u32,
    },
    /// Answer the prompt's `pick` with these cards, in order.
    PickCards {
        ids: Vec<u64>,
    },
    /// Let the engine's AI answer the prompt for the reader.
    Auto,
    /// Take back the cast or activation the prompt came out of.
    Cancel,
    // The sandbox, on the reader's own cards — the goldfish's actions.
    Move {
        id: u64,
        to: Place,
    },
    Tap {
        ids: Vec<u64>,
        tapped: bool,
    },
    UntapAll,
    Counters {
        id: u64,
        kind: String,
        delta: i32,
    },
    TokenCopy {
        id: u64,
    },
    CreateToken {
        preset: String,
        count: u32,
    },
    Draw {
        count: u32,
    },
    Mill {
        count: u32,
    },
    Shuffle,
    SetLife {
        seat: Seat,
        life: i32,
    },
}

/// What happened, one fact a row, for the log — the reader's doing, the opponent's, and the
/// rules'. `seat` is whose card or whose doing it was.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PlaytestHappened {
    Mulliganed {
        mulligans: u8,
    },
    Kept {
        size: u32,
        bottomed: u32,
    },
    TurnBegan {
        turn: u32,
        seat: Seat,
    },
    /// A land played by the turn's land drop.
    Played {
        seat: Seat,
        name: String,
    },
    Cast {
        seat: Seat,
        name: String,
    },
    Activated {
        seat: Seat,
        name: String,
    },
    /// A card the rules moved: a resolving spell, a dying creature, a discard, a mill.
    Moved {
        seat: Seat,
        name: String,
        from: Place,
        to: Place,
    },
    /// Cards drawn. `name` is the card for the reader's draw, `None` for the opponent's.
    Drew {
        seat: Seat,
        name: Option<String>,
    },
    Attacked {
        seat: Seat,
        names: Vec<String>,
    },
    Blocked {
        seat: Seat,
        blocker: String,
        attacker: String,
    },
    /// Damage dealt to a permanent (damage to a player is its `Life`). `target_id` and `seat` are
    /// the permanent's id and its controller's, so the board finds the very card that was hit.
    Dealt {
        source: String,
        target: String,
        target_id: u64,
        seat: Seat,
        amount: u32,
    },
    /// A life total changed by the rules: damage, a drain, a gain. `total` is the life after it.
    Life {
        seat: Seat,
        amount: i32,
        total: i32,
    },
    TokensCreated {
        seat: Seat,
        name: String,
        count: u32,
    },
    /// The reader put a card somewhere by hand.
    Put {
        name: String,
        from: Place,
        to: Place,
    },
    Tapped {
        name: String,
        count: u32,
        tapped: bool,
    },
    UntappedAll,
    Counters {
        name: String,
        kind: String,
        count: u32,
    },
    Shuffled,
    /// A life total the reader set by hand.
    LifeSet {
        seat: Seat,
        life: i32,
        was: i32,
    },
    /// The engine's AI answered a question for the reader (`auto`, or one the board does not ask).
    Chose {
        what: String,
    },
    GameOver {
        winner: Option<Seat>,
    },
}

/// An action's answer: the table after it, and everything that happened on the way.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestStep {
    pub view: PlaytestView,
    /// Everything, in order — the frames' facts included.
    pub happened: Vec<PlaytestHappened>,
    /// The table after each thing the board can show happening on the way — an opponent's land,
    /// cast, attack or block, a spell resolving, combat damage — oldest first, for the page to
    /// replay. Empty when nothing happened but the reader's own action. The last is not `view`:
    /// the page settles on `view` after them.
    pub frames: Vec<PlaytestFrame>,
}

/// One frame of a replay: the table at that moment, and the facts that led to it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestFrame {
    pub view: PlaytestView,
    pub happened: Vec<PlaytestHappened>,
}
