//! One printing in full, and every printing of the same oracle card.
//!
//! Shaped exactly like [`crate::search`]: pure functions over a `Connection` so they are
//! testable without a Tauri app, wrapped in `async` commands that run on the blocking
//! pool against the **read-only** connection.
//!
//! What is deliberately *not* computed here: grouping printings by `illustration_id`, and
//! turning the `prices` blob into a per-finish figure. Both are domain logic, and
//! CLAUDE.md puts domain logic in TypeScript where the tests are fast — Rust hands over
//! the JSON and the frontend decides what it means.

use crate::sync::{lock_db_read, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::sync::Arc;

/// Printings returned for one oracle card. A bound on a pane, not a pager.
///
/// Measured against the live database (116 k rows): exactly five oracle cards exceed it,
/// and they are the five basic lands — Forest at 946, the rest between 907 and 925. Seven
/// cards in the whole library have more than 100 printings. So this truncates the newest
/// 400 out of a list nobody scrolls, and never touches a real card. Ordered newest-first
/// *before* the cap, so what a truncated list drops is the oldest printings, not an
/// arbitrary slice.
const MAX_PRINTINGS: usize = 400;

/// `artist` has no column of its own — it is one string, and a v3 migration for it would
/// cost more than reading it back out of the JSON already stored. The face fallback
/// matters: on a reversible card there is no top-level artist.
const ARTIST_SQL: &str =
    "coalesce(json_extract(raw, '$.artist'), json_extract(faces, '$[0].artist'))";

/// One physical side of a card, for the flip control and the credit line.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFace {
    pub name: String,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub mana_cost: Option<String>,
    /// Per face: a double-faced card's two sides are not always the same illustrator.
    pub artist: Option<String>,
}

/// Everything the detail pane renders about the printing in front of the reader.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDetail {
    pub id: String,
    pub oracle_id: Option<String>,
    pub name: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub rarity: Option<String>,
    pub layout: String,
    pub lang: String,
    pub mana_cost: Option<String>,
    pub cmc: Option<f64>,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub illustration_id: Option<String>,
    /// Required by Scryfall's image policy wherever art is shown.
    pub artist: Option<String>,
    pub released_at: Option<String>,
    /// JSON, verbatim. 23 keys today and the set grows — the day this becomes columns is
    /// the day a new format needs a migration.
    pub legalities: Option<String>,
    /// JSON, verbatim. Six keys, decimal **strings**; a finish price is a lookup in here,
    /// never `price_usd` (which is a display fallback chain and would price a nonfoil at
    /// foil rates).
    pub prices: Option<String>,
    pub finishes: Option<String>,
    pub image_status: Option<String>,
    /// Empty for a single-faced card.
    pub faces: Vec<CardFace>,
}

/// One row of the printings list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Printing {
    pub id: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub released_at: Option<String>,
    pub rarity: Option<String>,
    /// What "alternate art" is actually keyed on: two printings differ in art iff this
    /// differs. `variation` is true on 0.09% of cards and is no help at all.
    pub illustration_id: Option<String>,
    pub artist: Option<String>,
    pub lang: String,
    pub finishes: Option<String>,
    pub prices: Option<String>,
    pub promo: bool,
    pub full_art: bool,
    pub frame_effects: Option<String>,
    pub border_color: Option<String>,
    pub layout: String,
}

/// One printing by id, or `None` if there is no such row.
pub fn get_card(conn: &Connection, id: &str) -> Result<Option<CardDetail>, String> {
    let sql = format!(
        "SELECT id, oracle_id, name, set_code, set_name, collector_number, rarity, layout, lang,
                mana_cost, cmc, type_line, oracle_text, illustration_id, {ARTIST_SQL},
                released_at, legalities, prices, finishes, image_status, faces
         FROM cards WHERE id = ?1"
    );
    conn.query_row(&sql, params![id], |r| {
        let faces: Option<String> = r.get(20)?;
        Ok(CardDetail {
            id: r.get(0)?,
            oracle_id: r.get(1)?,
            name: r.get(2)?,
            set_code: r.get(3)?,
            set_name: r.get(4)?,
            collector_number: r.get(5)?,
            rarity: r.get(6)?,
            layout: r.get(7)?,
            lang: r.get(8)?,
            mana_cost: r.get(9)?,
            cmc: r.get(10)?,
            type_line: r.get(11)?,
            oracle_text: r.get(12)?,
            illustration_id: r.get(13)?,
            artist: r.get(14)?,
            released_at: r.get(15)?,
            legalities: r.get(16)?,
            prices: r.get(17)?,
            finishes: r.get(18)?,
            image_status: r.get(19)?,
            faces: parse_faces(faces.as_deref()),
        })
    })
    .optional()
    .map_err(|e| e.to_string())
}

/// `card_faces` as the pane needs it. A blob that will not parse yields no faces rather
/// than an error: a card with unreadable face data is still a card worth showing.
fn parse_faces(json: Option<&str>) -> Vec<CardFace> {
    let Some(value) = json.and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok()) else {
        return Vec::new();
    };
    value
        .as_array()
        .map(|faces| {
            faces
                .iter()
                .filter_map(|f| {
                    Some(CardFace {
                        name: f.get("name")?.as_str()?.to_owned(),
                        type_line: str_field(f, "type_line"),
                        oracle_text: str_field(f, "oracle_text"),
                        // Present but empty on a transform's back, which is not the same
                        // as absent and should not render as a cost of `{}`.
                        mana_cost: str_field(f, "mana_cost").filter(|s| !s.is_empty()),
                        artist: str_field(f, "artist"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_owned)
}

/// Every printing of one oracle card, newest first.
///
/// A blank `oracle_id` returns nothing rather than matching: `oracle_id` is NULLABLE
/// (reversible cards have none), and a query that let `''` through would be one `IS NULL`
/// away from returning every such card in the database as a "printing" of each other.
pub fn list_printings(conn: &Connection, oracle_id: &str) -> Result<Vec<Printing>, String> {
    if oracle_id.trim().is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT id, set_code, set_name, collector_number, released_at, rarity, illustration_id,
                {ARTIST_SQL}, lang, finishes, prices, promo, full_art, frame_effects,
                border_color, layout
         FROM cards WHERE oracle_id = ?1
         ORDER BY released_at DESC, set_code ASC, collector_number ASC, id ASC
         LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![oracle_id, MAX_PRINTINGS as i64], |r| {
            Ok(Printing {
                id: r.get(0)?,
                set_code: r.get(1)?,
                set_name: r.get(2)?,
                collector_number: r.get(3)?,
                released_at: r.get(4)?,
                rarity: r.get(5)?,
                illustration_id: r.get(6)?,
                artist: r.get(7)?,
                lang: r.get(8)?,
                finishes: r.get(9)?,
                prices: r.get(10)?,
                promo: r.get(11)?,
                full_art: r.get(12)?,
                frame_effects: r.get(13)?,
                border_color: r.get(14)?,
                layout: r.get(15)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// One printing in full. Read-only connection, blocking pool — see [`crate::search::search_cards`].
#[tauri::command]
pub async fn card_detail(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Option<CardDetail>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_card(&lock_db_read(&state), &id))
        .await
        .map_err(|e| format!("card could not be read: {e}"))?
}

/// Every printing of one oracle card. Read-only connection, blocking pool.
#[tauri::command]
pub async fn card_printings(
    state: tauri::State<'_, Arc<AppState>>,
    oracle_id: String,
) -> Result<Vec<Printing>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_printings(&lock_db_read(&state), &oracle_id))
        .await
        .map_err(|e| format!("printings could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Three printings of one oracle card — two sharing an illustration, one with its own
    /// — plus a double-faced card, which is the shape `faces` has to survive.
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let rows = [
            ("p1", "o1", "lea", "161", "1993-08-05", "art-a"),
            ("p2", "o1", "2ed", "162", "1993-12-01", "art-a"),
            ("p3", "o1", "m10", "146", "2009-07-17", "art-b"),
        ];
        for (id, oracle, set, cn, released, illus) in rows {
            conn.execute(
                "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                    released_at, illustration_id, rarity, type_line, oracle_text, mana_cost,
                    legalities, finishes, prices, search_text, raw)
                 VALUES (?1, ?2, 'Lightning Bolt', ?3, ?4, 'en', 'normal', ?5, ?6, 'common',
                    'Instant', 'Lightning Bolt deals 3 damage to any target.', '{R}',
                    '{\"modern\":\"legal\",\"vintage\":\"restricted\",\"standard\":\"not_legal\"}',
                    '[\"nonfoil\",\"foil\"]',
                    '{\"usd\":\"5.00\",\"usd_foil\":\"40.00\",\"usd_etched\":null,\"eur\":\"4.20\",\"eur_foil\":\"35.00\",\"tix\":\"0.03\"}',
                    'Lightning Bolt', json_object('artist','Christopher Rush'))",
                rusqlite::params![id, oracle, set, cn, released, illus],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                faces, search_text, raw)
             VALUES ('dfc','o2','Delver of Secrets // Insectile Aberration','isd','51','en',
                'transform',
                json_array(
                  json_object('name','Delver of Secrets','type_line','Creature — Human Wizard',
                              'oracle_text','At the beginning of your upkeep…',
                              'mana_cost','{U}','artist','Nils Hamm'),
                  json_object('name','Insectile Aberration','type_line','Creature — Human Insect',
                              'oracle_text','Flying','mana_cost','','artist','Nils Hamm')),
                'Delver', '{}')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn a_card_comes_back_with_the_blobs_the_ui_parses() {
        let conn = seeded();
        let c = get_card(&conn, "p1").unwrap().unwrap();

        assert_eq!(c.name, "Lightning Bolt");
        assert_eq!(c.set_code, "lea");
        assert_eq!(c.oracle_id.as_deref(), Some("o1"));
        // Blobs, not fields: legalities has 23 keys and grows, prices are decimal strings.
        assert!(c.legalities.as_deref().unwrap().contains("\"vintage\""));
        assert!(c.prices.as_deref().unwrap().contains("usd_foil"));
        // No column for it; the image policy needs it on this pane.
        assert_eq!(c.artist.as_deref(), Some("Christopher Rush"));
        assert!(c.faces.is_empty(), "a single-faced card has no faces");
    }

    /// The faces a flip control needs, in order, with the artist per face — `card_faces`
    /// carries its own artist and a DFC's two sides are not always the same illustrator.
    #[test]
    fn a_double_faced_card_carries_both_faces_in_order() {
        let conn = seeded();
        let c = get_card(&conn, "dfc").unwrap().unwrap();

        assert_eq!(c.faces.len(), 2);
        assert_eq!(c.faces[0].name, "Delver of Secrets");
        assert_eq!(c.faces[1].name, "Insectile Aberration");
        assert_eq!(c.faces[1].artist.as_deref(), Some("Nils Hamm"));
        // Scryfall gives a transform's back face `"mana_cost": ""`, which is not the same
        // as having a cost of nothing to render — a `Some("")` here is a cost pill on the
        // back of every DFC in the game.
        assert_eq!(c.faces[0].mana_cost.as_deref(), Some("{U}"));
        assert!(c.faces[1].mana_cost.is_none(), "an empty cost is no cost");
    }

    #[test]
    fn an_unknown_id_is_none_not_an_error() {
        let conn = seeded();
        assert!(get_card(&conn, "nope").unwrap().is_none());
    }

    /// Every printing of the oracle card, newest first — the order a "which printing do I
    /// own" list wants, and the one that puts the reprint someone just opened at the top.
    #[test]
    fn printings_come_back_newest_first_with_their_art_identity() {
        let conn = seeded();
        let all = list_printings(&conn, "o1").unwrap();

        assert_eq!(all.len(), 3);
        assert_eq!(all[0].set_code, "m10", "newest first");
        assert_eq!(all[2].set_code, "lea");
        // Grouping by illustration is the frontend's job, but the field it groups on has
        // to arrive — two of these share an illustration and one does not.
        assert_eq!(all[0].illustration_id.as_deref(), Some("art-b"));
        assert_eq!(all[1].illustration_id.as_deref(), Some("art-a"));
        // Per-finish pricing reads the blob, never `price_usd`.
        assert!(all[0].prices.as_deref().unwrap().contains("usd_etched"));
        assert!(all[0].finishes.as_deref().unwrap().contains("foil"));
    }

    /// `oracle_id` is NULLABLE — reversible cards have none at all. An empty list, not a
    /// query that matches every row whose oracle_id is also null.
    #[test]
    fn an_unknown_oracle_id_returns_nothing() {
        let conn = seeded();
        assert!(list_printings(&conn, "").unwrap().is_empty());
        assert!(list_printings(&conn, "o-none").unwrap().is_empty());
    }
}
