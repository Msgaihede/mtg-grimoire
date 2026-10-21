//! The table as every board draws it: a card from the engine's object and the effects on it, the
//! place a zone is, a seat's mana by type. Kept apart from the game (`playtest/session.rs`) because they read the
//! engine's state and nothing of a session's — a card looks the same whoever's it is.

use engine::game::commander::commander_tax;
use engine::game::game_object::GameObject;
use engine::game::mana_sources::{activatable_mana_options, max_mana_yield};
use engine::types::ability::ContinuousModification;
use engine::types::card_type::CoreType;
use engine::types::identifiers::ObjectId;
use engine::types::mana::ManaType;
use engine::types::zones::Zone;
use engine::types::{EffectRef, GameState, Layer, PlayerId};

use crate::view::{
    CardCounter, CardEffect, EffectKind, GameCard, Lane, ManaByType, ManaTable, Place,
};

/// One object as a board draws it. `card_id` is the printing to draw it by, which only the
/// session knows (it follows a card across zones by name); `is_commander` and `gaps` likewise.
pub(crate) fn game_card(
    state: &GameState,
    id: ObjectId,
    card_id: Option<String>,
    is_commander: bool,
    gaps: Vec<String>,
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
        effects: effects_on(state, id),
        power: if is_creature { o.power } else { None },
        toughness: if is_creature { o.toughness } else { None },
        base_power: if is_creature { base_pt(o).0 } else { None },
        base_toughness: if is_creature { base_pt(o).1 } else { None },
        tax: if is_commander {
            commander_tax(state, id)
        } else {
            0
        },
        attached_to: o
            .attached_to
            .and_then(|host| host.as_object())
            .filter(|host| o.zone == Zone::Battlefield && state.battlefield.contains(host))
            .map(|host| host.0),
        foretold: o.zone == Zone::Exile && o.foretold,
        // What the rules offer is the session's to say: it knows whose view this is.
        can_foretell: false,
        castable: false,
        gaps,
    })
}

/// The continuous effects on an object, one per source and kind, in layer order (issue #1327).
///
/// Read off phase's attribution — the modifications its last layers pass applied to the object,
/// each by the static ability or the resolved effect it came from — so a card shows exactly what
/// the rules did to it, never what this crate guesses. A permanent's own statics on itself are
/// its printed self (CR 113.3c) and are skipped, as phase's own board skips them. An effect whose
/// source can no longer be read (gone between the pass and this view) is skipped too.
fn effects_on(state: &GameState, id: ObjectId) -> Vec<CardEffect> {
    let Some(attribution) = state.attribution.get(&id) else {
        return Vec::new();
    };
    let mut effects: Vec<CardEffect> = Vec::new();
    for (layer, refs) in &attribution.by_layer {
        let kind = kind_of(*layer);
        for effect in refs {
            let Some((source, modification)) = resolve(state, id, effect) else {
                continue;
            };
            let at = match effects
                .iter()
                .position(|e| e.kind == kind && e.source == source)
            {
                Some(at) => at,
                None => {
                    // A raise starts at +0/+0 and adds up; a set names nothing until it sets.
                    let zero = (kind == EffectKind::ModifyPt).then_some(0);
                    effects.push(CardEffect {
                        kind,
                        source,
                        gained: Vec::new(),
                        lost: Vec::new(),
                        loses_abilities: false,
                        abilities: Vec::new(),
                        power: zero,
                        toughness: zero,
                    });
                    effects.len() - 1
                }
            };
            describe(&mut effects[at], modification);
        }
    }
    effects
}

/// The source's name and the modification an attribution entry names, or `None` for the
/// object's own static (its printed self) or an entry that no longer resolves.
fn resolve<'s>(
    state: &'s GameState,
    id: ObjectId,
    effect: &EffectRef,
) -> Option<(String, &'s ContinuousModification)> {
    match *effect {
        EffectRef::Transient {
            id: effect,
            mod_index,
        } => {
            let tce = state
                .transient_continuous_effects
                .iter()
                .find(|t| t.id == effect)?;
            let name = if tce.source_name.is_empty() {
                state.objects.get(&tce.source_id)?.name.clone()
            } else {
                tce.source_name.clone()
            };
            Some((name, tce.modifications.get(mod_index)?))
        }
        EffectRef::Static {
            source,
            def_index,
            mod_index,
        } => {
            if source == id {
                return None;
            }
            let o = state.objects.get(&source)?;
            let def = o.static_definitions.get(def_index)?;
            // An emblem is named as Scryfall names it, `<source> Emblem` — its object is only
            // "Emblem" (issue #1333).
            let name = match (&o.emblem_source, o.is_emblem) {
                (Some(made_by), true) => format!("{} Emblem", made_by.name),
                _ => o.name.clone(),
            };
            Some((name, def.modifications.get(mod_index)?))
        }
    }
}

fn kind_of(layer: Layer) -> EffectKind {
    match layer {
        Layer::Copy => EffectKind::Copy,
        Layer::Control => EffectKind::Control,
        Layer::Text => EffectKind::Text,
        Layer::Type => EffectKind::Type,
        Layer::Color => EffectKind::Color,
        Layer::Ability => EffectKind::Ability,
        Layer::CharDef | Layer::SetPT => EffectKind::SetPt,
        Layer::ModifyPT | Layer::CounterPT => EffectKind::ModifyPt,
        Layer::SwitchPT => EffectKind::SwitchPt,
    }
}

/// What one modification adds to its effect's facts. A modification with nothing a reader names
/// (a chosen type, a copy's values, a rule like "can't be blocked") adds nothing: the effect's
/// kind and source still say what happened and from where.
fn describe(effect: &mut CardEffect, modification: &ContinuousModification) {
    use ContinuousModification as M;
    fn add(list: &mut Vec<String>, word: String) {
        if !list.contains(&word) {
            list.push(word);
        }
    }
    match modification {
        M::AddType { core_type } => add(&mut effect.gained, core_type.to_string()),
        M::RemoveType { core_type } => add(&mut effect.lost, core_type.to_string()),
        M::SetCardTypes { core_types } => {
            for t in core_types {
                add(&mut effect.gained, t.to_string());
            }
        }
        M::AddSubtype { subtype } => add(&mut effect.gained, subtype.clone()),
        M::RemoveSubtype { subtype } => add(&mut effect.lost, subtype.clone()),
        M::AddSupertype { supertype } => add(&mut effect.gained, supertype.to_string()),
        M::RemoveSupertype { supertype } => add(&mut effect.lost, supertype.to_string()),
        M::SetBasicLandType { land_type } => add(&mut effect.gained, format!("{land_type:?}")),
        M::AddColor { color } => add(&mut effect.gained, format!("{color:?}")),
        M::SetColor { colors } => {
            for c in colors {
                add(&mut effect.gained, format!("{c:?}"));
            }
        }
        M::AddKeyword { keyword } => add(&mut effect.gained, keyword.to_string()),
        M::RemoveKeyword { keyword } => add(&mut effect.lost, keyword.to_string()),
        M::RemoveAllAbilities => effect.loses_abilities = true,
        M::GrantAbility { definition } => {
            if let Some(text) = &definition.description {
                add(&mut effect.abilities, text.clone());
            }
        }
        M::GrantTrigger { trigger } => {
            if let Some(text) = &trigger.description {
                add(&mut effect.abilities, text.clone());
            }
        }
        M::GrantStaticAbility { definition } => {
            if let Some(text) = &definition.description {
                add(&mut effect.abilities, text.clone());
            }
        }
        M::GrantReplacement { replacement } => {
            if let Some(text) = &replacement.description {
                add(&mut effect.abilities, text.clone());
            }
        }
        M::AddPower { value } => effect.power = effect.power.map(|p| p + value),
        M::AddToughness { value } => effect.toughness = effect.toughness.map(|t| t + value),
        M::SetPower { value } => effect.power = Some(*value),
        M::SetToughness { value } => effect.toughness = Some(*value),
        // Worked out as the game goes (+X/+X, "equal to the number of …"): no number to send.
        M::AddDynamicPower { .. } | M::SetDynamicPower { .. } | M::SetPowerDynamic { .. } => {
            effect.power = None
        }
        M::AddDynamicToughness { .. }
        | M::SetDynamicToughness { .. }
        | M::SetToughnessDynamic { .. } => effect.toughness = None,
        _ => {}
    }
}

/// The P/T a board measures a creature's current P/T against (issue #1332): its printed P/T
/// (CR 208.4b) — or, for a card whose P/T a characteristic-defining ability sets (CR 604.3, a
/// `*/*` such as Tarmogoyf, which phase prints as 0), what that ability makes it (layer 7a, CR
/// 613.4a), so a creature at its own count reads as unchanged. Reading the statics ungated is
/// classification, which is what `iter_unchecked` is for.
fn base_pt(o: &GameObject) -> (Option<i32>, Option<i32>) {
    let defined = o.static_definitions.iter_unchecked().any(|s| {
        s.characteristic_defining && s.modifications.iter().any(|m| m.layer() == Layer::CharDef)
    });
    if defined {
        (o.layer_base_power, o.layer_base_toughness)
    } else {
        (o.base_power, o.base_toughness)
    }
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
