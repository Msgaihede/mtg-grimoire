//! What the page is told of a draft, and what it hands over to start one.
//!
//! Mirrored by hand in `packages/ui/lib/ipc/draft.ts`, held field for field by `ipc.test.ts`.
//! **The page makes the boosters** (`features/draft/booster/`) and hands them over as printing
//! ids (`DraftSetup::packs`); a card in a pack or a pool is a `DraftCard` whose `instance_id` is
//! `"{card_id}#{seat}.{round}.{index}"`, so any app — a guest's too — finds the printing in its own
//! corpus.

use serde::{Deserialize, Serialize};

use crate::Difficulty;

/// Which kind of draft: boosters from sets with bots (`quick`), six boosters straight into the
/// pool (`sealed`), boosters dealt from a cube list with bots (`cube`), people from a lobby with
/// bots in the empty seats (`pod`, in its [`PodFormat`]), a Commander draft — two cards a pick, a
/// 60-card deck with a commander — with bots (`commander`), or a Winston draft against a bot
/// (`winston`): one shared face-down stack dealt into three piles, each taken or declined.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DraftMode {
    Quick,
    Sealed,
    Cube,
    Pod,
    Commander,
    Winston,
}

/// What a pod drafts: boosters passed round the table (`booster`), a Commander draft
/// (`commander`), or a Winston draft (`winston`). Read only when the mode is `pod`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PodFormat {
    #[default]
    Booster,
    Commander,
    Winston,
}

/// Picking, or done picking and building. Everything phase's reducer has past drafting is
/// `Deckbuilding` here: the deck is built in the app's own editor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DraftStatus {
    Drafting,
    Deckbuilding,
}

/// A new draft, as the page sets it up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSetup {
    pub mode: DraftMode,
    /// How the bots pick, and how "Pick for me" picks for a person.
    pub difficulty: Difficulty,
    /// The bots' dice.
    pub seed: u32,
    /// "Reality Fracture · Lorwyn Eclipsed · The Hobbit" — what *Draft in progress* calls it.
    pub label: String,
    /// In table order; seat 0 is this reader.
    pub seats: Vec<DraftSeatSetup>,
    /// `[seat][round]` → printing ids, in the booster's order.
    pub packs: Vec<Vec<Vec<String>>>,
    /// Per round, the set code to show (`""` for a cube).
    pub pack_sets: Vec<String>,
    /// The deck the pool is built into: 40 for Limited, 60 for a Commander draft.
    pub min_deck_size: u32,
    /// What a pod drafts; `booster` for every other mode.
    #[serde(default)]
    pub pod_format: PodFormat,
}

impl DraftSetup {
    /// Every distinct printing id the boosters name, in first-appearance order: the facts the
    /// host loads before `Draft::new`.
    pub fn card_ids(&self) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        self.packs
            .iter()
            .flatten()
            .flatten()
            .filter(|id| seen.insert(id.as_str()))
            .cloned()
            .collect()
    }
}

/// One seat at the table: a person (this reader, or a lobby's peer) or a bot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSeatSetup {
    pub name: String,
    pub bot: bool,
    /// The lobby peer who sits here, in a pod.
    pub peer: Option<String>,
}

/// One card in a pack or a pool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftCard {
    pub instance_id: String,
    /// The printing's Scryfall id — what the page draws the card by.
    pub card_id: String,
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub rarity: String,
    /// Single letters, `["G", "W"]`.
    pub colors: Vec<String>,
    pub cmc: u8,
    pub type_line: String,
}

/// One seat as everyone at the table may see it: never its pack or its pool, only a count.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSeatView {
    pub name: String,
    pub bot: bool,
    /// A person's app is on the line; a bot always is.
    pub connected: bool,
    /// Has picked this step.
    pub picked: bool,
    pub pool_count: u32,
}

/// The draft from one seat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftView {
    pub mode: DraftMode,
    pub status: DraftStatus,
    pub label: String,
    pub seat: u8,
    /// 0-based round.
    pub pack_number: u8,
    pub pack_count: u8,
    /// 0-based pick within the round.
    pub pick_number: u8,
    /// Cards the current round's booster held when it was opened.
    pub pack_size: u8,
    pub pass_left: bool,
    /// Empty while waiting or once the draft is over.
    pub pack: Vec<DraftCard>,
    /// Picked this step; waiting on the table.
    pub waiting: bool,
    pub pool: Vec<DraftCard>,
    pub seats: Vec<DraftSeatView>,
    pub pack_sets: Vec<String>,
    pub min_deck_size: u32,
    pub pod_format: PodFormat,
    /// Cards a pick takes: 2 in a Commander draft, else 1.
    pub picks_per_step: u8,
    /// Commanders the deck designates: 1 in a Commander draft, else 0.
    pub commanders: u8,
    /// A Winston draft's table; `None` for every other.
    pub stack: Option<WinstonView>,
}

/// A Winston draft's table from one seat: the face-down stack's count, the three piles, and whose
/// turn it is. A pile's cards are told only to the seat whose turn it is, for the pile it is
/// looking at — everyone else, and every other pile, is a count.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinstonView {
    pub main_count: u32,
    pub piles: Vec<WinstonPile>,
    pub turn_seat: u8,
    pub your_turn: bool,
    /// The pile the turn is deciding on, 0-based.
    pub active_pile: Option<u8>,
}

/// One of a Winston draft's piles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinstonPile {
    pub count: u32,
    /// Its cards, for the seat deciding on it; empty for everyone else.
    pub cards: Vec<DraftCard>,
    pub active: bool,
}

/// The solo draft left off, for *Draft in progress*.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSaved {
    pub label: String,
    pub mode: DraftMode,
    pub status: DraftStatus,
    pub pack_number: u8,
    pub pack_count: u8,
    pub pick_number: u8,
    /// Milliseconds.
    pub updated_at: i64,
}
