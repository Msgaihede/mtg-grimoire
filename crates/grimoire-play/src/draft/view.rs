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
/// pool (`sealed`), boosters dealt from a cube list with bots (`cube`), or people from a lobby
/// with bots in the empty seats (`pod`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DraftMode {
    Quick,
    Sealed,
    Cube,
    Pod,
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
    /// The deck the pool is built into: 40 for Limited.
    pub min_deck_size: u32,
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
