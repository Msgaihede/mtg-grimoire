//! **One set's boosters, as MTGJSON describes them, joined to the corpus** — the Draft & Packs
//! page's facts (`docs/superpowers/specs/2026-10-29-draft-and-packs-design.md` §2).
//!
//! **Pure.** No request and no file: the desktop host fetches MTGJSON's per-set file
//! (`https://mtgjson.com/api/v5/{CODE}.json.gz`, gunzipped) and hands the text here. A set's
//! sheets may name another set's cards (HOB's box topper is HOC's), so the host asks
//! [`source_set_codes`] of the main file first, fetches each code it answers, and then calls
//! [`booster_set`] with the main text and those texts. A source file that could not be had is
//! simply left out: the cards only it maps are dropped from their sheets like any other card
//! with no Scryfall id.
//!
//! **What is kept** (the spec's rules): a sheet card whose `uuid` maps to no Scryfall id is
//! dropped and the sheet's total recomputed from what is left; a sheet left empty is dropped, a
//! variant naming a dropped sheet with it, and a product left with no variant too. A sealed
//! product is kept only when it holds a booster of this set, directly or through what it holds;
//! `deck`, `other` and `variable` contents are not read. A pack of another set's product, and a
//! sealed product of another set, are not followed — this set's file does not describe them.
//!
//! **Facts only**: no price (the page asks `printing_prices`), and nothing about how a booster is
//! opened — that is `features/draft/booster/`'s.
use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Deserializer, Serialize};

/// What a set whose file holds no booster this corpus can draw says.
pub const NO_BOOSTERS: &str = "MTGJSON lists no boosters for that set.";

/// One set's boosters and sealed products, and every card they can hold.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoosterSet {
    /// Lower-case, as the corpus spells a set code.
    pub code: String,
    pub name: String,
    pub release_date: Option<String>,
    pub products: Vec<BoosterProduct>,
    pub sealed: Vec<SealedProduct>,
    /// Every card any sheet or sealed product names, once.
    pub cards: Vec<BoosterCard>,
    /// Milliseconds: when the file was fetched.
    pub fetched_at: i64,
}

/// One kind of booster: MTGJSON's `play`, `draft`, `collector`, …
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoosterProduct {
    pub key: String,
    pub name: String,
    /// The sum of the kept variants' weights.
    pub total_weight: u64,
    pub variants: Vec<BoosterVariant>,
    pub sheets: Vec<BoosterSheet>,
}

/// One way a booster of the product is put together, and how often.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoosterVariant {
    pub weight: u64,
    pub slots: Vec<BoosterSlot>,
}

/// `count` cards from the sheet named `sheet`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoosterSlot {
    pub sheet: String,
    pub count: u32,
}

/// A print sheet: cards and their weights.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoosterSheet {
    pub name: String,
    pub foil: bool,
    pub fixed: bool,
    pub allow_duplicates: bool,
    pub balance_colors: bool,
    /// Recomputed from the kept cards, never MTGJSON's figure.
    pub total_weight: u64,
    pub cards: Vec<SheetCard>,
}

/// A printing on a sheet, by Scryfall id.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetCard {
    pub card_id: String,
    pub weight: u64,
}

/// A box, a case, a bundle: something sealed that holds boosters.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedProduct {
    pub uuid: String,
    pub name: String,
    pub category: Option<String>,
    pub subtype: Option<String>,
    pub packs: Vec<SealedPack>,
    pub sealed: Vec<SealedInner>,
    pub cards: Vec<SealedCard>,
}

/// `count` boosters of `product` (a [`BoosterProduct::key`]) of `set`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedPack {
    pub set: String,
    pub product: String,
    pub count: u32,
}

/// `count` of another kept sealed product, by its uuid.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedInner {
    pub uuid: String,
    pub set: String,
    pub count: u32,
}

/// A card a sealed product always holds.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedCard {
    pub card_id: String,
    pub foil: bool,
}

/// What the page draws for a card it may open.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoosterCard {
    pub card_id: String,
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub rarity: Option<String>,
    pub type_line: Option<String>,
    pub mana_cost: Option<String>,
    pub cmc: Option<f64>,
    /// Letters, `"WU"`, as the corpus stores them.
    pub colors: Option<String>,
    /// `false`: the facts are MTGJSON's alone — this corpus has no such printing.
    pub in_corpus: bool,
}

// ---------------------------------------------------------------------------------------
// MTGJSON's shapes — only the fields read; everything else is skipped by serde.
// ---------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct File {
    data: SetData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetData {
    code: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    release_date: Option<String>,
    #[serde(default)]
    booster: BTreeMap<String, MjProduct>,
    #[serde(default)]
    sealed_product: Vec<MjSealed>,
    #[serde(default)]
    cards: Vec<MjCard>,
    #[serde(default)]
    tokens: Vec<MjCard>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MjProduct {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    boosters: Vec<MjVariant>,
    #[serde(default)]
    sheets: BTreeMap<String, MjSheet>,
}

#[derive(Deserialize)]
struct MjVariant {
    #[serde(default)]
    contents: BTreeMap<String, u32>,
    #[serde(default, deserialize_with = "weight")]
    weight: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MjSheet {
    #[serde(default)]
    cards: BTreeMap<String, Weight>,
    #[serde(default)]
    foil: bool,
    #[serde(default)]
    fixed: bool,
    #[serde(default)]
    allow_duplicates: bool,
    #[serde(default)]
    balance_colors: bool,
}

#[derive(Deserialize)]
struct Weight(#[serde(deserialize_with = "weight")] u64);

#[derive(Deserialize)]
struct MjSealed {
    #[serde(default)]
    uuid: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    contents: Option<MjContents>,
}

#[derive(Deserialize)]
struct MjContents {
    #[serde(default)]
    pack: Vec<MjPack>,
    #[serde(default)]
    sealed: Vec<MjInner>,
    #[serde(default)]
    card: Vec<MjSealedCard>,
}

#[derive(Deserialize)]
struct MjPack {
    #[serde(default)]
    code: String,
    #[serde(default)]
    set: String,
}

#[derive(Deserialize)]
struct MjInner {
    #[serde(default)]
    uuid: String,
    #[serde(default)]
    set: String,
    #[serde(default)]
    count: Option<u32>,
}

#[derive(Deserialize)]
struct MjSealedCard {
    #[serde(default)]
    uuid: String,
    #[serde(default)]
    foil: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MjCard {
    uuid: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    set_code: String,
    #[serde(default)]
    number: String,
    #[serde(default)]
    rarity: Option<String>,
    #[serde(default, rename = "type")]
    type_line: Option<String>,
    #[serde(default)]
    mana_cost: Option<String>,
    #[serde(default)]
    mana_value: Option<f64>,
    #[serde(default)]
    colors: Option<Vec<String>>,
    #[serde(default)]
    identifiers: Identifiers,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Identifiers {
    #[serde(default)]
    scryfall_id: Option<String>,
}

/// A weight as MTGJSON writes it — an integer, read whole; a fractional or negative one (never
/// seen) is rounded and floored at zero rather than refusing the whole set.
fn weight<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let n = serde_json::Number::deserialize(d)?;
    Ok(n.as_u64()
        .unwrap_or_else(|| n.as_f64().map_or(0, |f| f.max(0.0).round() as u64)))
}

/// Only what [`source_set_codes`] needs, so the cards are skipped rather than built.
#[derive(Deserialize)]
struct SourcesFile {
    data: SourcesData,
}

#[derive(Deserialize)]
struct SourcesData {
    code: String,
    #[serde(default)]
    booster: BTreeMap<String, SourcesProduct>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourcesProduct {
    #[serde(default)]
    source_set_codes: Vec<String>,
}

fn unreadable(e: serde_json::Error) -> String {
    format!("MTGJSON's set file could not be read: {e}.")
}

// ---------------------------------------------------------------------------------------
// The two calls
// ---------------------------------------------------------------------------------------

/// The other sets whose files [`booster_set`] needs beside `main_json`: every product's
/// `sourceSetCodes` less the set itself, upper-cased (MTGJSON's spelling, and its file names),
/// sorted, once each.
pub fn source_set_codes(main_json: &str) -> Result<Vec<String>, String> {
    let file: SourcesFile = serde_json::from_str(main_json).map_err(unreadable)?;
    let own = file.data.code.to_uppercase();
    let mut codes: Vec<String> = file
        .data
        .booster
        .into_values()
        .flat_map(|p| p.source_set_codes)
        .map(|c| c.to_uppercase())
        .filter(|c| *c != own && !c.is_empty())
        .collect();
    codes.sort();
    codes.dedup();
    Ok(codes)
}

/// The set in `main_json`, its sheets' MTGJSON uuids mapped to Scryfall ids through its own
/// cards and tokens and those of `source_jsons` (the files [`source_set_codes`] named), and every
/// card it names read from `cards` in one pass. Refused with [`NO_BOOSTERS`] when no product
/// survives the rules in the module doc.
pub fn booster_set(
    conn: &Connection,
    main_json: &str,
    source_jsons: &[&str],
    fetched_at: i64,
) -> Result<BoosterSet, String> {
    let main: File = serde_json::from_str(main_json).map_err(unreadable)?;
    let mut sources = Vec::with_capacity(source_jsons.len());
    for text in source_jsons {
        let file: File = serde_json::from_str(text).map_err(unreadable)?;
        sources.push(file.data);
    }
    let set = main.data;
    let code = set.code.to_lowercase();

    // uuid → Scryfall id, and the first MTGJSON record of each Scryfall id for a card the corpus
    // lacks (a double-faced card is two records, one id).
    let mut scryfall: HashMap<String, String> = HashMap::new();
    let mut records: HashMap<String, &MjCard> = HashMap::new();
    for card in std::iter::once(&set)
        .chain(sources.iter())
        .flat_map(|s| s.cards.iter().chain(s.tokens.iter()))
    {
        let Some(id) = card
            .identifiers
            .scryfall_id
            .as_deref()
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        scryfall.insert(card.uuid.clone(), id.to_owned());
        records.entry(id.to_owned()).or_insert(card);
    }

    let products: Vec<BoosterProduct> = set
        .booster
        .iter()
        .filter_map(|(key, p)| product(key, p, &scryfall))
        .collect();
    if products.is_empty() {
        return Err(NO_BOOSTERS.to_owned());
    }
    let sealed = sealed_products(&set.sealed_product, &code, &products, &scryfall);

    let mut ids: Vec<String> = products
        .iter()
        .flat_map(|p| p.sheets.iter())
        .flat_map(|s| s.cards.iter().map(|c| c.card_id.clone()))
        .chain(
            sealed
                .iter()
                .flat_map(|s| s.cards.iter().map(|c| c.card_id.clone())),
        )
        .collect();
    ids.sort();
    ids.dedup();
    let cards = card_facts(conn, &ids, &records)?;

    Ok(BoosterSet {
        code,
        name: set.name.clone(),
        release_date: set.release_date.clone(),
        products,
        sealed,
        cards,
        fetched_at,
    })
}

/// One product under the rules: unmapped cards out, empty sheets out, variants naming them out.
fn product(key: &str, p: &MjProduct, scryfall: &HashMap<String, String>) -> Option<BoosterProduct> {
    let sheets: Vec<BoosterSheet> = p
        .sheets
        .iter()
        .filter_map(|(name, s)| {
            // Summed per Scryfall id: two uuids of one printing are one card on the sheet.
            let mut cards: BTreeMap<&str, u64> = BTreeMap::new();
            for (uuid, w) in &s.cards {
                if let Some(id) = scryfall.get(uuid) {
                    *cards.entry(id.as_str()).or_default() += w.0;
                }
            }
            if cards.is_empty() {
                return None;
            }
            Some(BoosterSheet {
                name: name.clone(),
                foil: s.foil,
                fixed: s.fixed,
                allow_duplicates: s.allow_duplicates,
                balance_colors: s.balance_colors,
                total_weight: cards.values().sum(),
                cards: cards
                    .into_iter()
                    .map(|(id, weight)| SheetCard {
                        card_id: id.to_owned(),
                        weight,
                    })
                    .collect(),
            })
        })
        .collect();
    let kept: HashSet<&str> = sheets.iter().map(|s| s.name.as_str()).collect();
    let variants: Vec<BoosterVariant> = p
        .boosters
        .iter()
        .filter(|v| v.contents.keys().all(|s| kept.contains(s.as_str())))
        .map(|v| BoosterVariant {
            weight: v.weight,
            slots: v
                .contents
                .iter()
                .filter(|(_, n)| **n > 0)
                .map(|(sheet, count)| BoosterSlot {
                    sheet: sheet.clone(),
                    count: *count,
                })
                .collect(),
        })
        .filter(|v| !v.slots.is_empty())
        .collect();
    if variants.is_empty() {
        return None;
    }
    // A sheet no kept variant draws from is weight the page would carry for nothing.
    let drawn: HashSet<&str> = variants
        .iter()
        .flat_map(|v| v.slots.iter().map(|s| s.sheet.as_str()))
        .collect();
    let sheets = sheets
        .iter()
        .filter(|s| drawn.contains(s.name.as_str()))
        .cloned()
        .collect();
    Some(BoosterProduct {
        key: key.to_owned(),
        name: p.name.clone().unwrap_or_else(|| key.to_owned()),
        total_weight: variants.iter().map(|v| v.weight).sum(),
        variants,
        sheets,
    })
}

/// The set's sealed products that hold one of `products`, directly or through another kept
/// sealed product of this set — found by fixed point, so a master case → case → box → pack chain
/// is kept whatever order the file lists them in.
fn sealed_products(
    all: &[MjSealed],
    code: &str,
    products: &[BoosterProduct],
    scryfall: &HashMap<String, String>,
) -> Vec<SealedProduct> {
    let keys: HashSet<&str> = products.iter().map(|p| p.key.as_str()).collect();
    fn contents(s: &MjSealed) -> &MjContents {
        static EMPTY: MjContents = MjContents {
            pack: Vec::new(),
            sealed: Vec::new(),
            card: Vec::new(),
        };
        s.contents.as_ref().unwrap_or(&EMPTY)
    }
    let packs_of = |s: &MjSealed| -> Vec<SealedPack> {
        let mut counted: BTreeMap<&str, u32> = BTreeMap::new();
        for pack in &contents(s).pack {
            if pack.set.eq_ignore_ascii_case(code) && keys.contains(pack.code.as_str()) {
                *counted.entry(pack.code.as_str()).or_default() += 1;
            }
        }
        counted
            .into_iter()
            .map(|(product, count)| SealedPack {
                set: code.to_owned(),
                product: product.to_owned(),
                count,
            })
            .collect()
    };

    let mut holds: HashSet<&str> = all
        .iter()
        .filter(|s| !packs_of(s).is_empty())
        .map(|s| s.uuid.as_str())
        .collect();
    loop {
        let before = holds.len();
        for s in all {
            if !holds.contains(s.uuid.as_str())
                && contents(s)
                    .sealed
                    .iter()
                    .any(|i| holds.contains(i.uuid.as_str()))
            {
                holds.insert(s.uuid.as_str());
            }
        }
        if holds.len() == before {
            break;
        }
    }

    all.iter()
        .filter(|s| holds.contains(s.uuid.as_str()))
        .map(|s| {
            let c = contents(s);
            SealedProduct {
                uuid: s.uuid.clone(),
                name: s.name.clone(),
                category: s.category.clone(),
                subtype: s.subtype.clone(),
                packs: packs_of(s),
                sealed: c
                    .sealed
                    .iter()
                    .filter(|i| holds.contains(i.uuid.as_str()))
                    .map(|i| SealedInner {
                        uuid: i.uuid.clone(),
                        set: i.set.to_lowercase(),
                        count: i.count.unwrap_or(1),
                    })
                    .collect(),
                cards: c
                    .card
                    .iter()
                    .filter_map(|card| {
                        Some(SealedCard {
                            card_id: scryfall.get(&card.uuid)?.clone(),
                            foil: card.foil,
                        })
                    })
                    .collect(),
            }
        })
        .collect()
}

/// How many ids one `IN (…)` binds — well under SQLite's 32 766 host parameters.
const CHUNK: usize = 500;

/// Each id's facts from `cards`, in `ids`' order; an id the corpus lacks from its MTGJSON record.
fn card_facts(
    conn: &Connection,
    ids: &[String],
    records: &HashMap<String, &MjCard>,
) -> Result<Vec<BoosterCard>, String> {
    let mut found: HashMap<String, BoosterCard> = HashMap::with_capacity(ids.len());
    for chunk in ids.chunks(CHUNK) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT id, name, set_code, collector_number, rarity, type_line, mana_cost, cmc,
                    colors
               FROM cards WHERE id IN ({marks})"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(chunk.iter()), |r| {
                Ok(BoosterCard {
                    card_id: r.get(0)?,
                    name: r.get(1)?,
                    set_code: r.get(2)?,
                    collector_number: r.get(3)?,
                    rarity: r.get(4)?,
                    type_line: r.get(5)?,
                    mana_cost: r.get(6)?,
                    cmc: r.get(7)?,
                    colors: r.get(8)?,
                    in_corpus: true,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let card = row.map_err(|e| e.to_string())?;
            found.insert(card.card_id.clone(), card);
        }
    }
    Ok(ids
        .iter()
        .map(|id| {
            found.remove(id).unwrap_or_else(|| {
                let r = records.get(id);
                BoosterCard {
                    card_id: id.clone(),
                    name: r.map(|r| r.name.clone()).unwrap_or_default(),
                    set_code: r.map(|r| r.set_code.to_lowercase()).unwrap_or_default(),
                    collector_number: r.map(|r| r.number.clone()).unwrap_or_default(),
                    rarity: r.and_then(|r| r.rarity.clone()),
                    type_line: r.and_then(|r| r.type_line.clone()),
                    mana_cost: r.and_then(|r| r.mana_cost.clone()),
                    cmc: r.and_then(|r| r.mana_value),
                    colors: r.and_then(|r| r.colors.as_ref().map(|c| c.concat())),
                    in_corpus: false,
                }
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small set, `TST`, with each rule's case: `play` has a fixed sheet, a sheet that allows
    /// duplicates and an unmapped uuid (`u-ghost`); `collector` draws a box topper from `SRC`;
    /// `empty` names only the ghost and is dropped. Sealed: a pack, a box of packs, a case of
    /// boxes, a bundle (the pack through `sealed`, a fixed foil card) and a kit with no booster.
    const MAIN: &str = r#"{"meta":{"version":"5"},"data":{
      "code":"TST","name":"Test Set","releaseDate":"2026-01-02","type":"expansion",
      "booster":{
        "play":{"name":"Test Play Booster","boostersTotalWeight":4,"sourceSetCodes":["TST"],
          "boosters":[
            {"contents":{"common":2,"land":1},"weight":3},
            {"contents":{"common":2,"land":1,"ghostly":1},"weight":1}],
          "sheets":{
            "common":{"allowDuplicates":true,"balanceColors":true,"foil":false,"totalWeight":7,
              "cards":{"u-bolt":3,"u-angel":2,"u-ghost":2}},
            "land":{"fixed":true,"foil":false,"totalWeight":1,"cards":{"u-plains":1}},
            "ghostly":{"foil":false,"totalWeight":1,"cards":{"u-ghost":1}}}},
        "collector":{"name":"Test Collector Booster","boostersTotalWeight":1,
          "sourceSetCodes":["TST","SRC"],
          "boosters":[{"contents":{"topper":1},"weight":1}],
          "sheets":{"topper":{"foil":true,"totalWeight":5,"cards":{"u-src":5}}}},
        "empty":{"name":"Nothing","boosters":[{"contents":{"ghostly":1},"weight":1}],
          "sourceSetCodes":["TST","XYZ"],
          "sheets":{"ghostly":{"foil":false,"totalWeight":1,"cards":{"u-ghost":1}}}}
      },
      "sealedProduct":[
        {"uuid":"s-case","name":"Test Box Case","category":"booster_case","subtype":"play",
          "contents":{"sealed":[{"uuid":"s-box","set":"tst","count":6,"name":"Test Box"}]}},
        {"uuid":"s-box","name":"Test Box","category":"booster_box","subtype":"play",
          "contents":{"pack":[{"code":"play","set":"tst"},{"code":"play","set":"tst"}]}},
        {"uuid":"s-pack","name":"Test Pack","category":"booster_pack",
          "contents":{"pack":[{"code":"play","set":"tst"}]}},
        {"uuid":"s-bundle","name":"Test Bundle","category":"bundle",
          "contents":{"sealed":[{"uuid":"s-pack","set":"tst","count":9}],
            "card":[{"uuid":"u-angel","set":"tst","foil":true,"name":"Angel"}],
            "other":[{"name":"Spindown die"}],"variable":[{"configs":[]}]}},
        {"uuid":"s-kit","name":"Test Kit","category":"kit","contents":null},
        {"uuid":"s-decks","name":"Test Deck","category":"deck",
          "contents":{"deck":[{"name":"A deck","set":"tst"}],
            "pack":[{"code":"play","set":"other"}]}}
      ],
      "cards":[
        {"uuid":"u-bolt","name":"Lightning Bolt","setCode":"TST","number":"1","rarity":"common",
          "foreignData":[{"language":"German","name":"Blitzschlag"}],
          "identifiers":{"scryfallId":"bolt-tst"}},
        {"uuid":"u-angel","name":"Serra Angel","setCode":"TST","number":"2","rarity":"uncommon",
          "identifiers":{"scryfallId":"angel-tst"}},
        {"uuid":"u-ghost","name":"Ghost","setCode":"TST","number":"3","identifiers":{}}
      ],
      "tokens":[
        {"uuid":"u-plains","name":"Plains","setCode":"TST","number":"4","rarity":"common",
          "type":"Basic Land — Plains","colors":[],"manaValue":0.0,
          "identifiers":{"scryfallId":"plains-tst"}}
      ]}}"#;

    const SOURCE: &str = r#"{"data":{"code":"SRC","name":"Source","cards":[
        {"uuid":"u-src","name":"Topper","setCode":"SRC","number":"9","rarity":"mythic",
          "type":"Legendary Creature — Hobbit","manaCost":"{1}{G}","manaValue":2.0,
          "colors":["G","W"],"identifiers":{"scryfallId":"topper-src"}}]}}"#;

    /// The corpus knows two of the four printings: the bolt and the angel.
    fn corpus() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            "INSERT INTO cards (id,name,lang,set_code,collector_number,rarity,layout,mana_cost,
                                cmc,type_line,colors,raw)
             VALUES ('bolt-tst','Lightning Bolt','en','tst','1','common','normal','{R}',1.0,
                     'Instant','R','{}'),
                    ('angel-tst','Serra Angel','en','tst','2','uncommon','normal','{3}{W}{W}',
                     5.0,'Creature — Angel','W','{}');",
        )
        .unwrap();
        conn
    }

    fn set() -> BoosterSet {
        booster_set(&corpus(), MAIN, &[SOURCE], 1234).unwrap()
    }

    #[test]
    fn the_sources_are_the_other_sets_upper_cased_once() {
        assert_eq!(
            source_set_codes(MAIN).unwrap(),
            vec!["SRC".to_string(), "XYZ".to_string()]
        );
    }

    #[test]
    fn the_set_is_lower_case_with_its_name_date_and_stamp() {
        let s = set();
        assert_eq!(s.code, "tst");
        assert_eq!(s.name, "Test Set");
        assert_eq!(s.release_date.as_deref(), Some("2026-01-02"));
        assert_eq!(s.fetched_at, 1234);
    }

    #[test]
    fn an_unmapped_card_leaves_its_sheet_and_its_weight() {
        let s = set();
        let play = s.products.iter().find(|p| p.key == "play").unwrap();
        let common = play.sheets.iter().find(|s| s.name == "common").unwrap();
        assert_eq!(common.total_weight, 5, "7 less the ghost's 2");
        let ids: Vec<&str> = common.cards.iter().map(|c| c.card_id.as_str()).collect();
        assert_eq!(ids, vec!["angel-tst", "bolt-tst"]);
        assert!(common.allow_duplicates && common.balance_colors && !common.fixed);
        let land = play.sheets.iter().find(|s| s.name == "land").unwrap();
        assert!(land.fixed && !land.allow_duplicates);
        assert_eq!(
            land.cards[0].card_id, "plains-tst",
            "a token's uuid maps too"
        );
    }

    #[test]
    fn a_variant_naming_an_emptied_sheet_goes_and_the_total_follows() {
        let s = set();
        let play = s.products.iter().find(|p| p.key == "play").unwrap();
        assert_eq!(play.variants.len(), 1);
        assert_eq!(play.total_weight, 3);
        assert!(play.sheets.iter().all(|s| s.name != "ghostly"));
        assert_eq!(play.name, "Test Play Booster");
    }

    #[test]
    fn a_product_with_nothing_left_is_dropped_and_a_source_card_is_kept() {
        let s = set();
        let keys: Vec<&str> = s.products.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(keys, vec!["collector", "play"]);
        let collector = &s.products[0];
        assert!(collector.sheets[0].foil);
        assert_eq!(collector.sheets[0].cards[0].card_id, "topper-src");
    }

    #[test]
    fn without_its_source_file_a_sheet_of_another_sets_cards_is_dropped() {
        let s = booster_set(&corpus(), MAIN, &[], 0).unwrap();
        let keys: Vec<&str> = s.products.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(keys, vec!["play"]);
    }

    #[test]
    fn sealed_products_are_kept_only_when_they_hold_a_booster() {
        let s = set();
        let uuids: Vec<&str> = s.sealed.iter().map(|p| p.uuid.as_str()).collect();
        assert_eq!(uuids, vec!["s-case", "s-box", "s-pack", "s-bundle"]);

        let case = &s.sealed[0];
        assert!(case.packs.is_empty());
        assert_eq!(case.sealed.len(), 1);
        assert_eq!(
            (case.sealed[0].uuid.as_str(), case.sealed[0].count),
            ("s-box", 6)
        );

        let r#box = &s.sealed[1];
        assert_eq!(
            r#box.packs.len(),
            1,
            "two lines of one product are one count"
        );
        assert_eq!(
            (r#box.packs[0].product.as_str(), r#box.packs[0].count),
            ("play", 2)
        );
        assert_eq!(r#box.packs[0].set, "tst");

        let bundle = &s.sealed[3];
        assert_eq!(bundle.sealed[0].count, 9);
        assert_eq!(bundle.cards.len(), 1);
        assert_eq!(bundle.cards[0].card_id, "angel-tst");
        assert!(bundle.cards[0].foil);
        assert_eq!(bundle.category.as_deref(), Some("bundle"));
    }

    #[test]
    fn every_card_once_from_the_corpus_or_else_from_mtgjson() {
        let s = set();
        let ids: Vec<&str> = s.cards.iter().map(|c| c.card_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["angel-tst", "bolt-tst", "plains-tst", "topper-src"]
        );
        let bolt = &s.cards[1];
        assert!(bolt.in_corpus);
        assert_eq!(bolt.mana_cost.as_deref(), Some("{R}"));
        assert_eq!(bolt.colors.as_deref(), Some("R"));
        let topper = &s.cards[3];
        assert!(!topper.in_corpus);
        assert_eq!(topper.set_code, "src");
        assert_eq!(topper.collector_number, "9");
        assert_eq!(topper.colors.as_deref(), Some("GW"));
        assert_eq!(topper.cmc, Some(2.0));
        assert_eq!(
            topper.type_line.as_deref(),
            Some("Legendary Creature — Hobbit")
        );
        assert_eq!(s.cards[2].colors.as_deref(), Some(""), "[] is colourless");
    }

    #[test]
    fn a_set_with_no_booster_left_is_refused_in_one_sentence() {
        let none = r#"{"data":{"code":"NIL","name":"Nil","cards":[]}}"#;
        assert_eq!(
            booster_set(&corpus(), none, &[], 0).unwrap_err(),
            NO_BOOSTERS
        );
        assert!(booster_set(&corpus(), "not json", &[], 0).is_err());
    }

    #[test]
    fn the_wire_is_camel_case() {
        let json = serde_json::to_value(set()).unwrap();
        assert!(json.get("releaseDate").is_some());
        assert!(json.get("fetchedAt").is_some());
        let sheet = &json["products"][1]["sheets"][0];
        assert!(sheet.get("allowDuplicates").is_some());
        assert!(sheet.get("balanceColors").is_some());
        assert!(sheet.get("totalWeight").is_some());
        assert!(json["cards"][0].get("inCorpus").is_some());
    }
}
