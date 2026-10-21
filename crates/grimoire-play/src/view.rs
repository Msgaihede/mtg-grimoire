//! The table's shared pieces on the wire: a card, its lane, counters and effects, the places a card can be
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
    /// The continuous effects changing it now (CR 613), one per source and kind: what changed
    /// and which card it is from — the board's chips beside the counters (issue #1327).
    pub effects: Vec<CardEffect>,
    /// The engine's current P/T — counters, statics and all (CR 613). `None` for a non-creature.
    pub power: Option<i32>,
    pub toughness: Option<i32>,
    /// The printed (copiable) P/T, before counters and effects (CR 208.4b, 707.2) — what the board
    /// measures `power` and `toughness` against to mark a change. `None` for a non-creature, and
    /// for a creature with no printed P/T (an animated land).
    pub base_power: Option<i32>,
    pub base_toughness: Option<i32>,
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
    /// The rules let the reader tap it for mana now (CR 605.3a): one of their permanents with a
    /// mana ability they can activate, a land's `{T}` above all. Only ever set on a battlefield
    /// card, and only in a view the reader can act in.
    pub can_tap_for_mana: bool,
    /// What the engine does not play of the face it shows: phase's coverage labels
    /// (`card_face_gaps`, as `support.rs` sends them), empty for a face played in full and for a
    /// token. A card with any is still played, but the parts named do nothing, so the board marks
    /// it (issue #1093).
    pub gaps: Vec<String>,
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

/// One source's continuous effect on a card, in one of CR 613's layers: Clavileño making an
/// attacking Vampire a Demon is a `Type` effect with `gained: ["Demon"]`, and the dies trigger it
/// grants is an `Ability` effect with that trigger's text in `abilities` (issue #1327).
///
/// Read off phase's own attribution (`GameState::attribution`), which records each modification
/// the layers applied to the object. A permanent's own static abilities on itself are its printed
/// self (CR 113.3c) and are left out; a resolved spell's or ability's effect is kept whoever's it
/// is, the card's own included.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardEffect {
    pub kind: EffectKind,
    /// The card the effect is from, by name: a static ability's permanent, or the spell or
    /// ability's source as the engine noted it when the effect began (it may since have moved).
    pub source: String,
    /// What it gives, as the engine names it: types, subtypes and supertypes; colors; keywords;
    /// the basic land type it makes a land.
    pub gained: Vec<String>,
    /// What it takes away, named the same way.
    pub lost: Vec<String>,
    /// It takes away all the card's abilities (CR 613.1f — Humility, Turn to Frog).
    pub loses_abilities: bool,
    /// The rules text of each ability it grants that is not a keyword, as phase writes it — `~`
    /// for the card itself: "When ~ dies, draw a card." Empty when the engine has no text for it.
    pub abilities: Vec<String>,
    /// `ModifyPt`: what it adds to power and toughness (+3/+3 is 3 and 3). `SetPt`: what it sets
    /// them to. `None` for an axis it leaves alone or works out as the game goes (+X/+X).
    pub power: Option<i32>,
    pub toughness: Option<i32>,
}

/// Which of a card's characteristics an effect changes: CR 613.1's layers, with layer 7's P/T
/// effects told apart by what they do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EffectKind {
    /// Layer 1: it is a copy of something (CR 707).
    Copy,
    /// Layer 2: someone else controls it.
    Control,
    /// Layer 3: its text is changed.
    Text,
    /// Layer 4: its card types, subtypes or supertypes.
    Type,
    /// Layer 5: its colors.
    Color,
    /// Layer 6: abilities it gains or loses.
    Ability,
    /// Layer 7a–b: its power and toughness are set.
    SetPt,
    /// Layer 7c: its power and toughness are raised or lowered.
    ModifyPt,
    /// Layer 7d: its power and toughness are switched.
    SwitchPt,
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
