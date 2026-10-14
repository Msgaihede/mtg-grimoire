//! What the goldfish board is told: the game as the reader sees it, and what an action did.
//!
//! **Facts, not sentences.** The page writes the log (`features/playtesting/goldfish/log.ts`):
//! "Drew Forest", "Cast Sol Ring", "The opponent took 7, down to 12" are presentation, and the
//! engine's part is which card went where and how. Mirrored by hand in
//! `packages/ui/lib/ipc/goldfish.ts`, held field for field by `ipc.test.ts`.

use serde::{Deserialize, Serialize};

/// The whole board after an action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldfishView {
    /// Whose decision the game is waiting on, in the board's terms.
    pub stage: Stage,
    /// The reader's own turns, from 1 — the goldfish's turns in between are not counted, so this
    /// is the number a reader means by "turn 9". 0 while the opening hand is being decided.
    pub turn: u32,
    /// Present while the opening hand is being decided.
    pub mulligan: Option<MulliganView>,
    /// How many cards of the hand the reader has to discard before the turn can end (CR 514.1,
    /// the cleanup step's discard to the maximum hand size). 0 at every stage but
    /// [`Stage::Discard`].
    pub discard: u32,
    pub life: i32,
    pub opponent_life: i32,
    pub hand: Vec<GameCard>,
    pub battlefield: Vec<GameCard>,
    /// Oldest first: the last is the top of the graveyard.
    pub graveyard: Vec<GameCard>,
    /// Oldest first.
    pub exile: Vec<GameCard>,
    /// The reader's commanders while they are in the command zone, and nothing else there.
    pub command: Vec<GameCard>,
    /// How many cards the library holds.
    pub library: u32,
    /// The library itself, **top first**. Face down on the table: the board shows it only when the
    /// reader asks to look (the library menu's scry, surveil, look and search), which is the
    /// reader's own hand doing what a card told it to — a goldfish has no opponent to hide it from.
    pub library_cards: Vec<GameCard>,
    /// How many of those are lands — the opening hand's "In the library" figure.
    pub library_lands: u32,
    /// The mana the reader's untapped permanents could make right now: each one's largest
    /// single `{T}` mana ability, net of its own cost (phase's `max_mana_yield`). A summoning-sick
    /// creature makes none.
    pub mana_open: u32,
    /// The tokens this deck's cards make, for the game menu's "Create a token".
    pub tokens: Vec<TokenOffer>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    /// The opening hand: keep it, or mulligan.
    Mulligan,
    /// The reader's main phase, with priority and nothing on the stack — where every action
    /// starts from and ends at.
    Playing,
    /// The reader's cleanup step, with more cards in hand than their maximum hand size: the turn
    /// was passed (`GoldfishAction::NextTurn`) and waits here until the reader says which cards
    /// go (`GoldfishAction::Discard`). Everything else is refused meanwhile.
    Discard,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MulliganView {
    /// Mulligans taken so far.
    pub mulligans: u8,
    /// How many cards keeping this hand puts on the bottom (CR 103.5, the London mulligan): the
    /// mulligans taken, less one when the first is free.
    pub bottom: u8,
    /// Whether this game's first mulligan is free (the Commander rule, CR 103.5c).
    pub free_first: bool,
}

/// One card the reader can see, wherever it is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCard {
    /// The engine's object id. **Changes when a card changes zone** (CR 400.7: it is a new
    /// object), so a page holds it only as long as the view it came from.
    pub id: u64,
    /// The printing's Scryfall id, to draw it by. A token's is its preset's printing when the
    /// engine knows one; `None` draws a token tile from the name and P/T.
    pub card_id: Option<String>,
    pub name: String,
    pub type_line: String,
    /// Which row of the battlefield it sits in. Meaningful on the battlefield; given everywhere.
    pub lane: Lane,
    pub mana_value: u32,
    pub is_land: bool,
    pub is_token: bool,
    pub is_commander: bool,
    pub tapped: bool,
    pub counters: Vec<CardCounter>,
    /// The engine's current P/T — counters, statics and all (CR 613). `None` for a non-creature.
    pub power: Option<i32>,
    pub toughness: Option<i32>,
    /// What casting it from the command zone costs on top of its mana cost, in generic mana
    /// (CR 903.8). 0 for anything but a commander.
    pub tax: u32,
}

/// Where a permanent sits: creatures toward the opponent; behind them lands on the left and
/// every other permanent on the right — the artboard's table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Lane {
    Creature,
    Land,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardCounter {
    /// The counter as a reader names it: `+1/+1`, `-1/-1`, `loyalty`, `charge`.
    pub kind: String,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenOffer {
    /// phase's token preset id, which `createToken` takes back.
    pub preset: String,
    pub name: String,
    /// The deck's card that makes it, or empty for a token the reader added to the deck by hand.
    pub source: String,
    /// The printing the reader set for the token in the deck, or else phase's preset's.
    pub card_id: Option<String>,
}

/// Where a card can be put. The library is two places, its top and its bottom.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Place {
    Hand,
    Battlefield,
    Graveyard,
    Exile,
    Command,
    LibraryTop,
    LibraryBottom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Seat {
    You,
    Opponent,
}

/// Everything the board can ask of a game.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GoldfishAction {
    /// Shuffle the hand away and draw a new one.
    Mulligan,
    /// Keep this hand, putting `bottom` on the bottom of the library (as many as
    /// `MulliganView::bottom` says, no more and no fewer).
    Keep {
        bottom: Vec<u64>,
    },
    /// A card from the hand or the command zone, played the way the rules play it when they can:
    /// a land by its land drop, a spell cast and paid for from untapped mana. When the rules
    /// cannot — no land drop left, too little mana, a choice the board does not ask — it is put
    /// where it would have gone, unpaid, and `Happened::Put` says so.
    Play {
        id: u64,
    },
    /// Put a card anywhere, as a hand on a table would: no cost, no trigger.
    Move {
        id: u64,
        to: Place,
    },
    Tap {
        ids: Vec<u64>,
        tapped: bool,
    },
    UntapAll,
    /// Add (`delta` > 0) or remove counters of a kind a reader names (`+1/+1`, `charge`).
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
    /// End this turn and play to the reader's next main phase: the goldfish's turn passes doing
    /// nothing, the reader's untap, upkeep and draw happen as the rules have them. With more
    /// cards in hand than the maximum hand size it stops at the cleanup step instead
    /// (`Stage::Discard`), for the reader to choose what is discarded.
    NextTurn,
    /// The cleanup step's discard: `ids` from the hand, as many as `GoldfishView::discard` says,
    /// no more and no fewer. The turn then passes on to the reader's next main phase.
    Discard {
        ids: Vec<u64>,
    },
}

/// What an action did, one fact a row, for the log — the reader's doing, the rules', and the
/// goldfish's own turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Happened {
    Mulliganed {
        mulligans: u8,
    },
    Kept {
        size: u32,
        bottomed: u32,
    },
    /// A land played by the turn's land drop.
    Played {
        name: String,
    },
    /// A spell cast and paid for, from the hand or the command zone.
    Cast {
        name: String,
        from: Place,
    },
    /// A card put somewhere by the reader's hand rather than by the rules.
    Put {
        name: String,
        from: Place,
        to: Place,
    },
    /// A card the engine moved by itself: a draw, a resolving spell, a trigger, a discard.
    Moved {
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
    TokensCreated {
        name: String,
        count: u32,
    },
    Shuffled,
    LifeSet {
        seat: Seat,
        life: i32,
        was: i32,
    },
    TurnBegan {
        turn: u32,
    },
    /// A life total the rules changed — a drain, a gain, a spell's damage to a player — as
    /// against one the reader set (`LifeSet`). `total` is the life after it.
    Life {
        seat: Seat,
        amount: i32,
        total: i32,
    },
    /// The goldfish's turn, which it plays by itself: it draws, plays nothing and, with more than
    /// seven cards, discards. One fact for the whole turn, told as it ends.
    OpponentTurn {
        drew: u32,
        discarded: u32,
    },
    /// The engine needed a decision the board does not ask, and took its first choice.
    Chose {
        what: String,
    },
}

/// An action's answer: the board after it, and what it did.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldfishStep {
    pub view: GoldfishView,
    pub happened: Vec<Happened>,
}
