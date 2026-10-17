//! The table's shared pieces on the wire: a card, its lane and counters, the places a card can be
//! put, a side of the table, the opening hand's mulligan, a token on offer and a seat's mana. The
//! game itself — its view, its actions and what they did — is `playtest/view.rs`, which builds on
//! these. Mirrored by hand in `packages/ui/lib/ipc/table.ts`, held field for field by
//! `ipc.test.ts`.

use serde::{Deserialize, Serialize};

/// A seat's mana by type: the board's mana table, every seat's.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManaTable {
    /// The most of each type the untapped permanents could make right now: every source that can
    /// make the type counts, so a dual land is in two rows and the rows sum to more than
    /// `mana_open`. A source counts its largest single `{T}` ability's output of the type, no more
    /// than its net yield (Sol Ring is 2 colorless; a bounce land 1 of each of its colors).
    pub open: ManaByType,
    /// The mana already in the pool (CR 106.4) — mana made and not yet spent.
    pub floating: ManaByType,
}

/// One count per type of mana, in WUBRG order and then colorless.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManaByType {
    pub white: u32,
    pub blue: u32,
    pub black: u32,
    pub red: u32,
    pub green: u32,
    pub colorless: u32,
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
    /// The permanent this Aura, Equipment or Fortification is attached to (CR 301.5, 303.4), by
    /// its object id — whoever controls it, so an Aura on an opponent's creature names that
    /// creature. `None` for anything unattached, off the battlefield, or attached to a player.
    pub attached_to: Option<u64>,
    /// A card in exile that is foretold (CR 702.143): face down, cast later for its foretell cost.
    /// Only the reader's are in a view; an opponent's are face down, so not shown at all.
    pub foretold: bool,
    /// The rules let the reader foretell it now (CR 702.143a): a hand card with foretell, on their
    /// own turn, with {2} to pay. Set only in a view the reader can act in.
    pub can_foretell: bool,
    /// The rules let the reader cast or play it from where it is now — a foretold card from
    /// exile, a flashback card from the graveyard. Only ever set on a graveyard or exile card,
    /// and only in a view the reader can act in.
    pub castable: bool,
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

/// A side of the table: the reader's, or the opponents' — a stop's side (`PlaytestStop`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Seat {
    You,
    Opponent,
}
