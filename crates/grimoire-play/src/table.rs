//! The table as every board draws it: a card from the engine's object, the place a zone is, a
//! seat's mana by type. Kept apart from the game (`playtest/session.rs`) because they read the
//! engine's state and nothing of a session's — a card looks the same whoever's it is.

use engine::game::commander::commander_tax;
use engine::game::mana_sources::{activatable_mana_options, max_mana_yield};
use engine::types::card_type::CoreType;
use engine::types::identifiers::ObjectId;
use engine::types::mana::ManaType;
use engine::types::zones::Zone;
use engine::types::{GameState, PlayerId};

use crate::view::{CardCounter, GameCard, Lane, ManaByType, ManaTable, Place};

/// One object as a board draws it. `card_id` is the printing to draw it by, which only the
/// session knows (it follows a card across zones by name); `is_commander` likewise.
pub(crate) fn game_card(
    state: &GameState,
    id: ObjectId,
    card_id: Option<String>,
    is_commander: bool,
) -> Option<GameCard> {
    let o = state.objects.get(&id)?;
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
            commander_tax(state, id)
        } else {
            0
        },
    })
}

pub(crate) fn place_of(zone: Zone) -> Option<Place> {
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

/// A seat's mana table: what its untapped permanents could make, by type, and its pool.
///
/// Each source counts once per type it can make: the most of that type any one of its activatable
/// `{T}` mana abilities adds (phase's `activatable_mana_options`, one row per production), no more
/// than its net yield (`max_mana_yield`). A row that makes several mana at once (Sol Ring's
/// `{C}{C}`, a bounce land's `{W}{U}`) counts each type as many times as it holds it; a single
/// row ("any color", "{G} for each creature") counts its source's whole yield.
pub(crate) fn mana_table(state: &GameState, seat: PlayerId) -> ManaTable {
    let mut open = ManaByType::default();
    for id in state.battlefield.iter() {
        let yields = max_mana_yield(state, *id, seat);
        if yields == 0 {
            continue;
        }
        let mut best = ManaByType::default();
        for option in activatable_mana_options(state, *id, seat) {
            match &option.atomic_combination {
                Some(types) => {
                    for kind in KINDS {
                        let n = types.iter().filter(|t| **t == kind).count() as u32;
                        let cell = best.cell(kind);
                        *cell = (*cell).max(n.min(yields));
                    }
                }
                None => {
                    let cell = best.cell(option.mana_type);
                    *cell = (*cell).max(yields);
                }
            }
        }
        for kind in KINDS {
            *open.cell(kind) += *best.cell(kind);
        }
    }
    let pool = &state.players[seat.0 as usize].mana_pool;
    let mut floating = ManaByType::default();
    for kind in KINDS {
        *floating.cell(kind) = pool.count_color(kind) as u32;
    }
    ManaTable { open, floating }
}

const KINDS: [ManaType; 6] = [
    ManaType::White,
    ManaType::Blue,
    ManaType::Black,
    ManaType::Red,
    ManaType::Green,
    ManaType::Colorless,
];

impl ManaByType {
    fn cell(&mut self, kind: ManaType) -> &mut u32 {
        match kind {
            ManaType::White => &mut self.white,
            ManaType::Blue => &mut self.blue,
            ManaType::Black => &mut self.black,
            ManaType::Red => &mut self.red,
            ManaType::Green => &mut self.green,
            ManaType::Colorless => &mut self.colorless,
        }
    }
}

pub(crate) fn is_permanent(o: &engine::game::GameObject) -> bool {
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
