//! The app's facts about a card, turned into the engine's.
//!
//! The app stores Scryfall's card: a name, a cost, one type line, the rules text, P/T. phase.rs's
//! engine plays MTGJSON's: the type line split into supertypes, types and subtypes, and the rules
//! text run through its oracle parser into abilities, triggers and statics. The bridge is
//! `build_oracle_face`, the function phase's own card-data export is built with — so a card
//! played here is parsed exactly as it is on phase's site, and what its parser does not
//! understand yet it does not understand here either (the card is still a body with a cost and a
//! type, which is all the sandbox needs to put it down by hand).
//!
//! **Only the deck's cards are parsed**, never the corpus: phase's whole export is ~93 MB and
//! would have to be fetched from phase's host. Measured on the spike (2026-10-12): 14 ms for five
//! faces in a release build, 117 ms in a debug one — a Commander deck's hundred is about a second
//! of a debug build, once per game.

use std::collections::BTreeMap;

use engine::database::mtgjson::AtomicCard;
use engine::database::synthesis::{build_oracle_face, build_oracle_face_multi};
use engine::database::CardDatabase;
use engine::types::card::CardFace;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// One card of the deck, as the app stores it: what `deck_get` answers for a row, less what a
/// game has no use for (prices, finishes, categories). Several copies are one entry with a
/// `quantity`; two printings of one card are two entries.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFacts {
    /// The printing's Scryfall id — what the board draws the card's picture by.
    pub card_id: String,
    pub name: String,
    pub quantity: u32,
    /// In the command zone at the start, rather than the library.
    pub commander: bool,
    pub oracle_id: Option<String>,
    pub mana_cost: Option<String>,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub loyalty: Option<String>,
    pub defense: Option<String>,
    pub cmc: Option<f64>,
    pub layout: Option<String>,
    pub colors: Vec<String>,
    pub color_identity: Vec<String>,
    pub keywords: Vec<String>,
    /// Scryfall's `card_faces`, for a card with two or more: a modal double-faced card, a
    /// transforming one, an adventure, a split card. Empty for a card of one face.
    pub faces: Vec<FaceFacts>,
}

/// One face of a card with several, as Scryfall's `card_faces` has it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceFacts {
    pub name: String,
    pub mana_cost: Option<String>,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub loyalty: Option<String>,
    pub defense: Option<String>,
    pub colors: Option<Vec<String>>,
}

/// Every supertype a type line can lead with (CR 205.4a). Scryfall writes them in the same
/// words as the types, so the split is by this list and not by position.
const SUPERTYPES: &[&str] = &[
    "Basic",
    "Legendary",
    "Snow",
    "World",
    "Ongoing",
    "Host",
    "Elite",
];

/// The layouts whose faces are separate entries in phase's export, each with its `face_index`.
/// Scryfall's names for them, which are MTGJSON's too, except the two mapped below.
const MULTI_FACE: &[&str] = &[
    "split",
    "flip",
    "transform",
    "modal_dfc",
    "meld",
    "adventure",
    "prepare",
    "omen",
];

/// A type line in MTGJSON's three lists: `Legendary Creature — Elf Druid` is
/// `(["Legendary"], ["Creature"], ["Elf", "Druid"])`.
fn split_type_line(line: &str) -> (Vec<String>, Vec<String>, Vec<String>) {
    let (left, right) = line
        .split_once('—')
        .map(|(l, r)| (l.trim(), r.trim()))
        .unwrap_or((line.trim(), ""));
    let (supers, types): (Vec<&str>, Vec<&str>) = left
        .split_whitespace()
        .partition(|word| SUPERTYPES.contains(word));
    let own = |words: Vec<&str>| words.into_iter().map(str::to_string).collect();
    (
        own(supers),
        own(types),
        own(right.split_whitespace().collect()),
    )
}

/// The MTGJSON record `build_oracle_face` reads, for one face. `AtomicCard` has no constructor
/// and derives only `Deserialize`, so it is written as the JSON MTGJSON would have shipped.
fn atomic(card: &CardFacts, face: Option<(&FaceFacts, usize)>) -> Result<AtomicCard, String> {
    let type_line = face
        .and_then(|(f, _)| f.type_line.clone())
        .or_else(|| card.type_line.clone())
        .unwrap_or_default();
    // A multi-face card's type line is both faces' (`Instant — Adventure // Creature — Elf`);
    // a face has its own, and a card with none of its own takes the first half.
    let type_line = type_line
        .split(" // ")
        .next()
        .unwrap_or_default()
        .to_string();
    let (supertypes, types, subtypes) = split_type_line(&type_line);
    let commander = supertypes.iter().any(|t| t == "Legendary")
        && types.iter().any(|t| t == "Creature" || t == "Planeswalker");
    let pick = |own: Option<&String>, card: &Option<String>| own.cloned().or_else(|| card.clone());
    let (name, face_name, side, cost, text, power, toughness, loyalty, defense, colors) = match face
    {
        Some((f, index)) => (
            f.name.clone(),
            Some(f.name.clone()),
            Some(((b'a' + index as u8) as char).to_string()),
            f.mana_cost.clone().filter(|c| !c.is_empty()),
            f.oracle_text.clone(),
            f.power.clone(),
            f.toughness.clone(),
            f.loyalty.clone(),
            f.defense.clone(),
            f.colors.clone().unwrap_or_else(|| card.colors.clone()),
        ),
        None => (
            card.name.clone(),
            None,
            None,
            card.mana_cost.clone().filter(|c| !c.is_empty()),
            card.oracle_text.clone(),
            pick(None, &card.power),
            pick(None, &card.toughness),
            pick(None, &card.loyalty),
            pick(None, &card.defense),
            card.colors.clone(),
        ),
    };
    serde_json::from_value(json!({
        "name": name,
        "faceName": face_name,
        "side": side,
        "manaCost": cost,
        "colors": colors,
        "colorIdentity": card.color_identity,
        "power": power,
        "toughness": toughness,
        "loyalty": loyalty,
        "defense": defense,
        "text": text,
        "layout": card.layout.clone().unwrap_or_else(|| "normal".into()),
        "type": type_line,
        "types": types,
        "subtypes": subtypes,
        "supertypes": supertypes,
        "keywords": card.keywords,
        "manaValue": card.cmc.unwrap_or(0.0),
        "leadershipSkills": { "commander": commander, "brawl": commander, "oathbreaker": false },
        "identifiers": { "scryfallOracleId": card.oracle_id },
    }))
    .map_err(|e| format!("The rules engine could not read {}: {e}", card.name))
}

/// What `CardDatabase::from_json_str` reads for one face: the face, flattened, beside its
/// layout and position (`CardExportEntry` in phase's `card_db.rs`, private there).
fn export_entry(face: &CardFace, layout: Option<&str>, index: Option<usize>) -> Value {
    let mut entry = serde_json::to_value(face).unwrap_or(Value::Null);
    if let Value::Object(map) = &mut entry {
        if let Some(layout) = layout {
            map.insert("layout".into(), json!(layout));
        }
        if let Some(index) = index {
            map.insert("face_index".into(), json!(index));
        }
    }
    entry
}

/// The engine's layout name for Scryfall's, where they differ.
fn engine_layout(layout: &str) -> &str {
    match layout {
        // Scryfall's two-faced cards that are not modal, and Battles.
        "double_faced_token" | "battle" => "transform",
        other => other,
    }
}

/// The faces of one card, parsed, each with what the export keys it by.
fn faces_of(card: &CardFacts) -> Result<Vec<(String, Value)>, String> {
    let layout = card.layout.as_deref().unwrap_or("normal");
    let multi = card.faces.len() > 1 && MULTI_FACE.contains(&engine_layout(layout));
    if !multi {
        let a = atomic(card, None)?;
        let face = build_oracle_face(&a, card.oracle_id.clone());
        return Ok(vec![(face.name.clone(), export_entry(&face, None, None))]);
    }
    card.faces
        .iter()
        .enumerate()
        .map(|(index, f)| {
            let a = atomic(card, Some((f, index)))?;
            let face = build_oracle_face_multi(&a, card.oracle_id.clone());
            let entry = export_entry(&face, Some(engine_layout(layout)), Some(index));
            Ok((face.name.clone(), entry))
        })
        .collect()
}

/// The name the engine knows a card by, which is what a deck list must say: a card of several
/// faces is known by its front face (`Bala Ged Recovery`, never `… // Bala Ged Sanctuary`).
pub fn engine_name(card: &CardFacts) -> String {
    let layout = card.layout.as_deref().unwrap_or("normal");
    if card.faces.len() > 1 && MULTI_FACE.contains(&engine_layout(layout)) {
        card.faces[0].name.clone()
    } else {
        card.name.clone()
    }
}

/// The deck's own card database: every face of every card in it, and the extra cards a game
/// needs beside them (`extra`, already in the export's shape — the goldfish's library).
pub fn database(cards: &[CardFacts], extra: &[(String, Value)]) -> Result<CardDatabase, String> {
    let mut entries: BTreeMap<String, Value> = BTreeMap::new();
    for card in cards {
        for (name, entry) in faces_of(card)? {
            entries.entry(name).or_insert(entry);
        }
    }
    for (name, entry) in extra {
        entries.entry(name.clone()).or_insert_with(|| entry.clone());
    }
    let map: Map<String, Value> = entries.into_iter().collect();
    CardDatabase::from_json_str(&Value::Object(map).to_string())
        .map_err(|e| format!("The rules engine could not read this deck's cards: {e}"))
}

/// One face in the export's shape, for a card that is not in any deck — the goldfish's library
/// and the rule that keeps a game going at zero life.
pub fn synthetic(name: &str, type_line: &str, text: &str) -> (String, Value) {
    let card = CardFacts {
        name: name.into(),
        type_line: Some(type_line.into()),
        oracle_text: Some(text.into()),
        layout: Some("normal".into()),
        ..CardFacts::default()
    };
    let face = build_oracle_face(
        &atomic(&card, None).expect("a synthetic card is well formed"),
        None,
    );
    (face.name.clone(), export_entry(&face, None, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_type_line_splits_into_mtgjsons_three_lists() {
        assert_eq!(
            split_type_line("Legendary Creature — Elf Druid"),
            (
                vec!["Legendary".to_string()],
                vec!["Creature".to_string()],
                vec!["Elf".to_string(), "Druid".to_string()]
            )
        );
        assert_eq!(
            split_type_line("Basic Snow Land — Forest"),
            (
                vec!["Basic".to_string(), "Snow".to_string()],
                vec!["Land".to_string()],
                vec!["Forest".to_string()]
            )
        );
        assert_eq!(split_type_line("Instant").1, vec!["Instant".to_string()]);
    }

    #[test]
    fn a_multi_faced_card_is_known_by_its_front_face() {
        let card = CardFacts {
            name: "Bala Ged Recovery // Bala Ged Sanctuary".into(),
            layout: Some("modal_dfc".into()),
            faces: vec![
                FaceFacts {
                    name: "Bala Ged Recovery".into(),
                    ..FaceFacts::default()
                },
                FaceFacts {
                    name: "Bala Ged Sanctuary".into(),
                    ..FaceFacts::default()
                },
            ],
            ..CardFacts::default()
        };
        assert_eq!(engine_name(&card), "Bala Ged Recovery");
        let plain = CardFacts {
            name: "Forest".into(),
            ..CardFacts::default()
        };
        assert_eq!(engine_name(&plain), "Forest");
    }
}
