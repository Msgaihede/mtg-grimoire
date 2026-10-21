//! What the board is told: the game as the reader sees it from their seat, and what an action
//! (theirs, an opponent's, the engine's) did — against the goldfish or against the AI alike.
//!
//! **Facts, not sentences**: the page writes the log (`features/playtesting/play/log.ts`).
//! Mirrored by hand in `packages/ui/lib/ipc/playtest.ts`, held field for field by `ipc.test.ts`.
//! The card, its lane, its counters, the places a card can be put and the stops' two sides are the
//! table's shared types (`crate::view`). A player is a `PlaytestPlayer` rather than a `Seat`: a
//! game may have up to three opponents (issue #994), and a fact says which.
//!
//! **What the reader may not see is not sent.** An opponent's hand and library are counts, never
//! cards; a card an opponent draws is "drew a card" with no name.

use serde::{Deserialize, Serialize};

use crate::view::{GameCard, ManaTable, MulliganView, Place, Seat, TokenOffer};

/// A player at the table, from the reader's seat: the reader, or one of up to three opponents in
/// turn order after them. On the wire `"you"`, `"opponent"`, `"opponent2"` and `"opponent3"`, so a
/// duel's players are spelled as the goldfish's `Seat`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaytestPlayer {
    You,
    Opponent,
    Opponent2,
    Opponent3,
}

impl PlaytestPlayer {
    /// Every player, the reader first: index `n` is the engine's `PlayerId(n)`.
    pub const ALL: [PlaytestPlayer; 4] = [
        PlaytestPlayer::You,
        PlaytestPlayer::Opponent,
        PlaytestPlayer::Opponent2,
        PlaytestPlayer::Opponent3,
    ];

    /// The engine's player number for this player.
    pub fn index(self) -> u8 {
        self as u8
    }

    /// The stops' side: the reader's own turn, or an opponent's.
    pub fn side(self) -> Seat {
        if self == PlaytestPlayer::You {
            Seat::You
        } else {
            Seat::Opponent
        }
    }
}

/// The whole table after an action, from the reader's seat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestView {
    /// What the game is waiting on the reader for — the board's mode.
    pub stage: PlaytestStage,
    /// The game's turn number, both seats' turns counted, from 1. 0 during the opening hands.
    pub turn: u32,
    /// Whose turn it is.
    pub active: PlaytestPlayer,
    /// Who played first (the seed's coin flip).
    pub started: PlaytestPlayer,
    pub phase: PlaytestPhase,
    /// The step within `phase`, for the steps a player gets priority in (`None` in the untap step,
    /// at the end of combat and in cleanup) — the stops' names for them.
    pub step: Option<PlaytestStopStep>,
    /// Present while the reader's opening hand is being decided.
    pub mulligan: Option<MulliganView>,
    pub you: PlaytestSeat,
    /// Each opponent's side, in turn order after the reader: one in a duel, three in a
    /// four-player game. `hand` and `library_cards` are always empty: their counts are what the
    /// reader may know.
    pub opponents: Vec<PlaytestSeat>,
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
    /// Present in `Stage::Over`: who won, or `None` for a draw — and `None` too when the reader is
    /// out of a game the others play on (`you.out`), which the reader has lost.
    pub winner: Option<PlaytestPlayer>,
    /// The tokens the reader's deck makes, for the game menu's "Create a token".
    pub tokens: Vec<TokenOffer>,
    /// The steps the reader asked to be stopped at (the game menu's stops), as `setStops` set
    /// them.
    pub stops: Vec<PlaytestStop>,
    /// The reader is ending the turn (`endTurn`): until it changes, the game stops only to block
    /// or to answer a question.
    pub ending_turn: bool,
    /// The sandbox is on (`setSandbox`): the reader's hand may change the game outside the rules
    /// — move, tap, counters, tokens, draws, life totals — on their own cards and on every card
    /// the table shows, and a card the rules cannot play is put down unpaid. On from the start
    /// against the goldfish, off against the AI.
    pub sandbox: bool,
    /// The opponent is the goldfish: one seat that keeps its hand, passes every priority and
    /// never attacks or blocks, and that — like the reader — cannot lose (its `dead_on` says when
    /// it would have). The game is never `Over`.
    pub goldfish: bool,
    /// A Commander game's commander damage at which a player loses (CR 704.6c): 21. `None` in a
    /// game without a commander, where commander damage is not counted.
    pub commander_damage_lethal: Option<u32>,
    /// The reader's last action can be taken back (`PlaytestAction::Undo`), with all the opponent
    /// did after it. Never in a replay frame.
    pub can_undo: bool,
    /// An undone action can be taken again (`PlaytestAction::Redo`). Never in a replay frame.
    pub can_redo: bool,
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
    /// Whose side it is.
    pub player: PlaytestPlayer,
    /// This player has lost and left the game (CR 800.4a), which the others play on without them.
    pub out: bool,
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
    /// This seat's emblems (CR 114), oldest first: in the command zone for the rest of the game,
    /// and never a card in it. Never the session's own — the goldfish's rules emblems, the
    /// sandbox's free cast's.
    pub emblems: Vec<PlaytestEmblem>,
    pub library: u32,
    /// The reader's library, **top first**, for the library menu's look and search; empty for the
    /// opponent.
    pub library_cards: Vec<GameCard>,
    /// What this seat's untapped permanents could make right now (phase's `max_mana_yield`).
    pub mana_open: u32,
    /// The same open mana by type, and what is floating in the pool (`crate::view::ManaTable`).
    pub mana: ManaTable,
    /// The commander damage this player has been dealt (CR 903.10a): one entry a commander, so a
    /// pair of partners is two, in the order the engine first counted them. Only combat damage
    /// counts, and only once a commander has dealt some; empty outside a Commander game.
    pub commander_damage: Vec<PlaytestCommanderDamage>,
    /// The goldfish's, which cannot lose: the reader's own turn, from 1, on which this player
    /// first would have lost — their life at 0 or less, or one commander's damage to them at the
    /// view's `commander_damage_lethal` — the board's "dead on your turn 5", and `None` again once
    /// neither holds. Always `None` for a player who can lose.
    pub dead_on: Option<u32>,
}

/// An emblem (CR 114): neither a card nor a permanent, it cannot be removed, and its abilities
/// work from the command zone for the rest of the game (CR 114.4). The engine applies them; the
/// board only shows them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestEmblem {
    pub id: u64,
    /// The card that made it — `Sorin, Lord of Innistrad` — as it was when it did. `None` for an
    /// emblem the engine made with no card behind it.
    pub source: Option<String>,
    /// The printing to draw it by: the emblem the deck keeps for its source among its Tokens &
    /// Emblems. `None` when it keeps none, and the board draws its words.
    pub card_id: Option<String>,
    /// Its abilities' words, as the engine gives them, one a row.
    pub text: Vec<String>,
}

/// One commander's combat damage to one player over the game (CR 903.10a). At the view's
/// `commander_damage_lethal` the player loses (CR 704.6c), unless something says they can't.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestCommanderDamage {
    /// The commander's id: the card the table shows wherever it is now.
    pub id: u64,
    pub name: String,
    pub card_id: Option<String>,
    /// Whose commander it is.
    pub player: PlaytestPlayer,
    pub damage: u32,
}

/// The creatures in combat: each attacker and what it attacks, and each block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestCombat {
    /// Every attacker, whichever seat attacks.
    pub attacks: Vec<PlaytestAttackPair>,
    pub blocks: Vec<PlaytestBlockPair>,
}

/// One attacker and what it attacks: `target` is a planeswalker's or a battle's id, or `None` for
/// a player — `player`, the one it attacks. In the view `player` is always given for an attack on
/// a player; from the reader, `None` is the first opponent the creature can attack.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestAttackPair {
    pub attacker: u64,
    pub target: Option<u64>,
    #[serde(default)]
    pub player: Option<PlaytestPlayer>,
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
    /// The players it can attack.
    pub players: Vec<PlaytestPlayer>,
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
    /// The words of the ability the question is about, when the question names one: a trigger
    /// whose targets are being chosen. Two of one card's triggers are told apart by these.
    pub source_text: Option<String>,
    /// What set off the trigger the question is about, when it is one.
    pub cause: Option<PlaytestCause>,
    pub options: Vec<PlaytestOption>,
    /// The question came out of the reader's own cast or activation, which `cancel` takes back.
    pub cancellable: bool,
    /// Present when the answer is a set of cards — scry, surveil, a discard, a search — which
    /// `options` cannot list (the engine offers only a few of the sets). `pickCards` answers it.
    pub pick: Option<PlaytestPick>,
    /// The keyword the question is about, when the engine names one: the alternative cost a cast
    /// may be paid with (`Overload`, `Evoke`, `Bestow`…), whose answers are `Normal` and
    /// `Alternative`.
    pub keyword: Option<String>,
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
    /// The most the picked cards' power may add up to — each a creature's current power, its
    /// `GameCard.power` (Slaughter the Strong's "total power 4 or less", issue #1079). `None` for
    /// a pick bounded by its count alone.
    pub power_cap: Option<i32>,
    /// Where the cards lie, when they all lie in one place — the graveyard a cast is offered
    /// from (issue #1329). `None` for cards from several places, or from the stack.
    pub zone: Option<Place>,
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
    /// The picked permanents are kept; the rest are sacrificed.
    Keep,
    /// The picked card is cast — "you may cast a spell from among them" (issue #1329).
    Cast,
}

/// A step the reader asked the game to stop at, on whose turn: the reader's own, or an
/// opponent's (`Seat::Opponent` stops on every opponent's turn).
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
    pub players: Vec<PlaytestPlayer>,
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
    /// For a trigger: what set it off. Two triggers of one ability are told apart by it — one
    /// Soul Warden's two triggers, for two creatures entering.
    pub cause: Option<PlaytestCause>,
}

/// What set a trigger off, as the event that did names it: the card it is about and the player.
/// A card the reader may not see (in an opponent's hand or library) has neither id nor name.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestCause {
    /// phase's name for the event: `ZoneChanged`, `SpellCast`, `DamageDealt`, `CardDrawn`…
    pub event: String,
    pub id: Option<u64>,
    pub name: Option<String>,
    pub player: Option<PlaytestPlayer>,
}

/// One spell or ability on the stack.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytestStackItem {
    pub id: u64,
    /// The spell, or the ability's source.
    pub name: String,
    pub card_id: Option<String>,
    pub seat: PlaytestPlayer,
    /// An ability rather than a spell.
    pub ability: bool,
    /// An ability's words, as the engine gives them — two abilities of one card's name on the
    /// stack are told apart by these.
    pub text: Option<String>,
    /// A trigger's cause: what set it off.
    pub cause: Option<PlaytestCause>,
    /// The cards it targets that the table shows — a permanent, a card in a graveyard, in exile
    /// or in the command zone, another spell on the stack — in the order it chose them, for the
    /// board's targeting arrows (issue #1071). A target the reader may not see (in a hand or a
    /// library) is left out.
    pub targets: Vec<u64>,
    /// The players it targets.
    pub target_players: Vec<PlaytestPlayer>,
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
/// The rules — passing, attacking, blocking, answering the engine — and the sandbox: a hand on
/// the table that moves, taps and counts whatever it likes, refused while the sandbox is off
/// (`SetSandbox`).
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
    /// Foretell a hand card by the rules (CR 702.143a): the special action that pays {2} and
    /// exiles it face down, to be cast on a later turn for its foretell cost (a `Play` of it in
    /// exile). Only on the reader's turn; refused, saying why, when the rules do not offer it.
    Foretell {
        id: u64,
    },
    /// Tap one of the reader's permanents for mana by the rules (CR 605.3a), sandbox or not: the
    /// reader picks which sources pay rather than the engine. The mana floats in their pool, and
    /// the next cast spends it first, until the step or phase ends (CR 500.4). One way is taken;
    /// several (a dual land's two colors) are a `ManaChoice` prompt; none is a refusal. The
    /// reader keeps priority: nothing plays on after it.
    TapForMana {
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
    /// Turn the sandbox on or off. A setting, as `SetStops`: taken at any stage, never undone,
    /// and nothing plays on after it.
    SetSandbox {
        on: bool,
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
    // The sandbox, refused while it is off, in the reader's main phase only: on any card the
    // reader owns or controls, and on any card the table shows (an opponent's battlefield,
    // graveyard, exile or command zone) — never on an opponent's hand or library.
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
        seat: PlaytestPlayer,
        life: i32,
    },
    /// Take the reader's last action back, and all the opponent did after it: the game as it was
    /// at their last decision, exactly. Happens nothing.
    Undo,
    /// Take the last undone action again: the game as it was before the undo. Happens nothing.
    Redo,
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
        seat: PlaytestPlayer,
    },
    /// A land played by the turn's land drop.
    Played {
        seat: PlaytestPlayer,
        name: String,
    },
    /// A spell cast. `name` is `None` for an opponent's spell cast face down (a morph, CR 708.4),
    /// which only they may look at.
    Cast {
        seat: PlaytestPlayer,
        name: Option<String>,
    },
    Activated {
        seat: PlaytestPlayer,
        name: String,
    },
    /// A card foretold: exiled face down from its owner's hand (CR 702.143a). `name` is the card
    /// for the reader's own, `None` for an opponent's, which only they may look at.
    Foretold {
        seat: PlaytestPlayer,
        name: Option<String>,
    },
    /// A card the rules moved: a resolving spell, a dying creature, a discard, a mill. `name` is
    /// `None` for an opponent's card that is face down where it went (a hideaway card, a
    /// manifest).
    Moved {
        seat: PlaytestPlayer,
        name: Option<String>,
        from: Place,
        to: Place,
    },
    /// Cards drawn. `name` is the card for the reader's draw, `None` for an opponent's.
    Drew {
        seat: PlaytestPlayer,
        name: Option<String>,
    },
    Attacked {
        seat: PlaytestPlayer,
        names: Vec<String>,
    },
    Blocked {
        seat: PlaytestPlayer,
        blocker: String,
        attacker: String,
    },
    /// Damage dealt to a permanent (damage to a player is its `Life`). `target_id` and `seat` are
    /// the permanent's id and its controller's, so the board finds the very card that was hit.
    Dealt {
        source: String,
        target: String,
        target_id: u64,
        seat: PlaytestPlayer,
        amount: u32,
    },
    /// A life total changed by the rules: damage, a drain, a gain. `total` is the life after it.
    Life {
        seat: PlaytestPlayer,
        amount: i32,
        total: i32,
    },
    /// A commander dealt combat damage to a player (CR 903.10a): `seat` is the player dealt it,
    /// `total` all that commander has dealt them this game. At the view's
    /// `commander_damage_lethal` they lose, unless something says they can't.
    CommanderDamage {
        source: String,
        source_id: u64,
        seat: PlaytestPlayer,
        amount: u32,
        total: u32,
    },
    TokensCreated {
        seat: PlaytestPlayer,
        name: String,
        count: u32,
    },
    /// A player got an emblem (CR 114.1); `source` is the card that made it, as `PlaytestEmblem`'s.
    Emblem {
        seat: PlaytestPlayer,
        source: Option<String>,
    },
    /// The reader put a card somewhere by hand; `seat` is whose card it is.
    Put {
        seat: PlaytestPlayer,
        name: String,
        from: Place,
        to: Place,
    },
    Tapped {
        seat: PlaytestPlayer,
        name: String,
        count: u32,
        tapped: bool,
    },
    UntappedAll,
    Counters {
        seat: PlaytestPlayer,
        name: String,
        kind: String,
        count: u32,
    },
    Shuffled,
    /// A life total the reader set by hand.
    LifeSet {
        seat: PlaytestPlayer,
        life: i32,
        was: i32,
    },
    /// The engine's AI answered a question for the reader (`auto`, or one the board does not ask),
    /// or the question had only one answer and the session took it (`sole_answer`).
    Chose {
        what: String,
    },
    /// A player lost and left the game, which the others play on without them (CR 800.4a). The
    /// reader's own is the end of their game; in a duel the loser's is told by `GameOver` alone.
    Eliminated {
        seat: PlaytestPlayer,
    },
    GameOver {
        winner: Option<PlaytestPlayer>,
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
