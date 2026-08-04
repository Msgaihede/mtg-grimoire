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
/// Measured against the live database (116 k rows), counting **paper only** as
/// [`PRINTINGS_WHERE`] does: exactly five oracle cards exceed this, and they are the five
/// basic lands — Forest at 862, then Mountain 840, Swamp 832, Island 827, Plains 818.
/// Seven cards in the whole library have more than 100 paper printings. So the cap
/// truncates a list nobody scrolls and never touches a real card.
///
/// Two things keep the truncation honest: the `ORDER BY` runs *before* the `LIMIT`, so
/// what is dropped is the oldest printings rather than an arbitrary slice, and
/// [`PrintingsResponse::total`] reports the full count so a capped list can say what it is
/// a truncation of.
const MAX_PRINTINGS: usize = 400;

/// `artist` has no column of its own — it is one string, and a v3 migration for it would
/// cost more than reading it back out of the JSON already stored. The face fallback
/// matters: on a reversible card there is no top-level artist.
const ARTIST_SQL: &str =
    "coalesce(json_extract(raw, '$.artist'), json_extract(faces, '$[0].artist'))";

/// The rows a printings list is about, stated once because the page and the count must
/// agree — a `total` taken over a wider `WHERE` than the page is exactly the lie the
/// `total` was added to prevent.
///
/// **Paper only.** Measured against the live database: 6 533 oracle cards have both paper
/// and digital printings (Lightning Bolt: 62 paper, 9 digital), and the digital ones are
/// MTGO and Arena rows that cannot be owned in paper and carry no paper price. Left in,
/// this pane would offer a reader an Arena printing to record as a copy they own and
/// render its price as `—`. `search` already defaults to paper for the same reason, and
/// the spec tracks a paper collection.
const PRINTINGS_WHERE: &str = "oracle_id = ?1 AND is_paper = 1";

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

/// A printings list and the size of the list it was taken from.
///
/// `total` exists because [`MAX_PRINTINGS`] truncates silently otherwise: Forest has 862
/// paper printings, and a pane that returns 400 of them with no way to say so tells the
/// reader those 400 are all there are. With this it can caption "400 of 862". Mirrors
/// [`crate::search::SearchResponse`], minus its cap flag — see [`list_printings`] for why
/// this count needs no ceiling.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintingsResponse {
    /// Newest first, at most [`MAX_PRINTINGS`] of them.
    pub items: Vec<Printing>,
    /// Every paper printing of this oracle card, counted in full. `items.len() < total`
    /// means the list was truncated.
    pub total: i64,
}

/// One printing by id, or `None` if there is no such row.
///
/// Deliberately **not** filtered to paper, unlike [`list_printings`]: an id asked for by
/// name has to resolve. A digital printing can be reached from a search with `paperOnly`
/// off, and answering `None` for a row that plainly exists would look like a broken
/// database rather than a policy.
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
                .map(|f| CardFace {
                    // Defaulted, never dropped. The flip control addresses faces by
                    // index, so a face skipped here would shift every face after it —
                    // the back of a three-face card rendering as its middle, silently
                    // and only for the malformed rows nobody is looking at. A nameless
                    // face is a broken face, not a missing one.
                    name: str_field(f, "name").unwrap_or_default(),
                    type_line: str_field(f, "type_line"),
                    oracle_text: str_field(f, "oracle_text"),
                    // Present but empty on a transform's back, which is not the same
                    // as absent and should not render as a cost of `{}`.
                    mana_cost: str_field(f, "mana_cost").filter(|s| !s.is_empty()),
                    artist: str_field(f, "artist"),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_owned)
}

/// Every **paper** printing of one oracle card, newest first, plus how many there are.
///
/// A blank `oracle_id` returns nothing rather than matching: `oracle_id` is NULLABLE
/// (reversible cards have none), and a query that let `''` through would be one `IS NULL`
/// away from returning every such card in the database as a "printing" of each other.
///
/// Two statements over one `WHERE`: the page, and an uncapped count so a truncated list
/// can say what it is a truncation *of*. The count is cheap in a way
/// [`crate::search::run_search`]'s is not — `idx_cards_oracle` narrows it to one card's
/// printings (946 rows at the very worst) instead of scanning toward 116 k — so there is
/// nothing here to cap and no `total_is_capped` to report.
pub fn list_printings(conn: &Connection, oracle_id: &str) -> Result<PrintingsResponse, String> {
    if oracle_id.trim().is_empty() {
        return Ok(PrintingsResponse::default());
    }
    let sql = format!(
        "SELECT id, set_code, set_name, collector_number, released_at, rarity, illustration_id,
                {ARTIST_SQL}, lang, finishes, prices, promo, full_art, frame_effects,
                border_color, layout
         FROM cards WHERE {PRINTINGS_WHERE}
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
    let items = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let total = conn
        .query_row(
            &format!("SELECT count(*) FROM cards WHERE {PRINTINGS_WHERE}"),
            params![oracle_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(PrintingsResponse { items, total })
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

/// Every paper printing of one oracle card. Read-only connection, blocking pool.
#[tauri::command]
pub async fn card_printings(
    state: tauri::State<'_, Arc<AppState>>,
    oracle_id: String,
) -> Result<PrintingsResponse, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_printings(&lock_db_read(&state), &oracle_id))
        .await
        .map_err(|e| format!("printings could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Three paper printings of one oracle card — two sharing an illustration, one with
    /// its own — plus an MTGO printing of the same card that must never be offered as a
    /// copy to own, and a double-faced card, which is the shape `faces` has to survive.
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
        // Same oracle card, digital-only: an MTGO printing, dated newest of all so that a
        // query which forgets `is_paper` puts it at the very top of the list rather than
        // somewhere a test might miss it.
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                released_at, illustration_id, rarity, is_paper, digital, search_text, raw)
             VALUES ('p4-mtgo','o1','Lightning Bolt','pmtg1','7','en','normal','2014-06-16',
                'art-a','common', 0, 1, 'Lightning Bolt', '{}')",
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
        // This row has no top-level artist — only faces do — so the card-level credit can
        // only come from the coalesce's face branch. Scryfall's image policy requires the
        // credit line wherever art is shown, and without this the branch could be deleted
        // with every test still green.
        assert_eq!(c.artist.as_deref(), Some("Nils Hamm"));
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
        let all = list_printings(&conn, "o1").unwrap().items;

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
        for absent in ["", "o-none"] {
            let r = list_printings(&conn, absent).unwrap();
            assert!(r.items.is_empty(), "{absent}");
            assert_eq!(r.total, 0, "{absent}");
        }
    }

    /// This pane offers printings as copies to record, so a digital one is an offer to own
    /// something that does not physically exist — and it would price as `—`, because there
    /// is no paper price for an MTGO row. 6 533 oracle cards in the live database have both
    /// kinds, so this is the common case, not an edge.
    #[test]
    fn digital_printings_are_not_offered_as_copies_to_own() {
        let conn = seeded();
        let r = list_printings(&conn, "o1").unwrap();

        assert_eq!(r.items.len(), 3, "the MTGO printing does not belong here");
        assert!(
            !r.items.iter().any(|p| p.id == "p4-mtgo"),
            "a digital printing reached the printings list: {:?}",
            r.items.iter().map(|p| &p.id).collect::<Vec<_>>()
        );
        // It is dated newest of the four, so a missing `is_paper` shows up as the wrong
        // row at the top rather than as a count that happens to match.
        assert_eq!(r.items[0].id, "p3");
        // The count is taken over the same rows as the page: a `total` of 4 here would be
        // the pane reporting a printing it refuses to show.
        assert_eq!(r.total, 3, "the count must agree with the filter");
    }

    /// Asked for by id, a digital printing still resolves — a search with `paperOnly` off
    /// can reach one, and answering `None` for a row that plainly exists reads as a broken
    /// database. The paper rule belongs to the printings list, not to "show me this card".
    #[test]
    fn a_digital_printing_still_opens_when_it_is_asked_for_by_id() {
        let conn = seeded();
        let c = get_card(&conn, "p4-mtgo").unwrap().unwrap();
        assert_eq!(c.set_code, "pmtg1");
    }

    /// The number a truncated list is a truncation *of*. Without it a capped pane says
    /// "400 printings" when there are 946, and nothing on the wire contradicts it.
    #[test]
    fn the_total_counts_past_the_page_so_a_capped_list_can_say_so() {
        let conn = seeded();
        for n in 0..MAX_PRINTINGS + 5 {
            conn.execute(
                "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang,
                    layout, released_at, search_text, raw)
                 VALUES (?1, 'o3', 'Forest', 'set', ?2, 'en', 'normal', '2020-01-01', 'Forest', '{}')",
                rusqlite::params![format!("f{n}"), n.to_string()],
            )
            .unwrap();
        }
        let r = list_printings(&conn, "o3").unwrap();

        assert_eq!(r.items.len(), MAX_PRINTINGS, "the page is capped");
        assert_eq!(r.total, MAX_PRINTINGS as i64 + 5, "the count is not");
    }

    /// A face with no name must not be dropped: the flip control addresses faces by index,
    /// so dropping one silently renumbers every face after it and shows the wrong side.
    #[test]
    fn a_nameless_face_keeps_its_place_rather_than_shifting_the_rest() {
        let faces = parse_faces(Some(
            r#"[{"name":"Front","artist":"A"},{"artist":"B"},{"name":"Back","artist":"C"}]"#,
        ));

        assert_eq!(faces.len(), 3, "no face is dropped");
        assert_eq!(faces[0].name, "Front");
        assert_eq!(faces[1].name, "");
        assert_eq!(faces[2].name, "Back", "still the third face");
        assert_eq!(faces[2].artist.as_deref(), Some("C"));
    }

    /// Unparseable and non-array blobs are no faces rather than an error — a card whose
    /// face data is broken is still a card worth showing.
    #[test]
    fn a_face_blob_that_makes_no_sense_is_no_faces_and_no_error() {
        assert!(parse_faces(None).is_empty());
        assert!(parse_faces(Some("not json")).is_empty());
        assert!(parse_faces(Some(r#"{"name":"an object, not an array"}"#)).is_empty());
    }

    /// `src/lib/ipc.ts` mirrors these names by hand and nothing checks that the two still
    /// agree — a `rename_all` lost in a refactor turns every field of the detail pane into
    /// an `undefined` TypeScript is perfectly happy with, and the pane renders blank
    /// instead of failing. Compared as one whole value, so a field *added* on this side and
    /// never mirrored fails here too; a field-by-field check reads straight past that.
    ///
    /// The nulls are part of the shape. Nothing here carries `skip_serializing_if`, so an
    /// absent `oracleText` arrives as an explicit `null` rather than a missing key — which
    /// is what `string | null` on the TypeScript side promises, and what the difference
    /// between "this card has no rules text" and "the backend forgot to send it" rests on.
    ///
    /// A double-faced card, because it is the only shape that pins [`CardFace`] as well.
    #[test]
    fn card_detail_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(CardDetail {
            id: "dfc".into(),
            oracle_id: Some("o2".into()),
            name: "Delver of Secrets // Insectile Aberration".into(),
            set_code: "isd".into(),
            set_name: Some("Innistrad".into()),
            collector_number: "51".into(),
            rarity: Some("common".into()),
            layout: "transform".into(),
            lang: "en".into(),
            // A transform has no cost of its own; the front face carries it.
            mana_cost: None,
            cmc: Some(1.0),
            type_line: Some("Creature — Human Wizard // Creature — Human Insect".into()),
            oracle_text: None,
            illustration_id: Some("art-c".into()),
            artist: Some("Nils Hamm".into()),
            released_at: Some("2011-09-30".into()),
            legalities: Some(r#"{"modern":"legal"}"#.into()),
            prices: Some(r#"{"usd":"0.35"}"#.into()),
            finishes: Some(r#"["nonfoil","foil"]"#.into()),
            image_status: Some("highres_scan".into()),
            faces: vec![
                CardFace {
                    name: "Delver of Secrets".into(),
                    type_line: Some("Creature — Human Wizard".into()),
                    oracle_text: Some("At the beginning of your upkeep…".into()),
                    mana_cost: Some("{U}".into()),
                    artist: Some("Nils Hamm".into()),
                },
                CardFace {
                    name: "Insectile Aberration".into(),
                    type_line: Some("Creature — Human Insect".into()),
                    oracle_text: Some("Flying".into()),
                    // The back of a transform: no cost to render, and `null` is how the
                    // flip control is told so.
                    mana_cost: None,
                    artist: Some("Nils Hamm".into()),
                },
            ],
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "id": "dfc",
                "oracleId": "o2",
                "name": "Delver of Secrets // Insectile Aberration",
                "setCode": "isd",
                "setName": "Innistrad",
                "collectorNumber": "51",
                "rarity": "common",
                "layout": "transform",
                "lang": "en",
                "manaCost": null,
                // A `1` here would not compare equal: `cmc` is an `f64` on the wire, and
                // the TypeScript `number` covers both.
                "cmc": 1.0,
                "typeLine": "Creature — Human Wizard // Creature — Human Insect",
                "oracleText": null,
                "illustrationId": "art-c",
                "artist": "Nils Hamm",
                "releasedAt": "2011-09-30",
                "legalities": r#"{"modern":"legal"}"#,
                "prices": r#"{"usd":"0.35"}"#,
                "finishes": r#"["nonfoil","foil"]"#,
                "imageStatus": "highres_scan",
                "faces": [
                    {
                        "name": "Delver of Secrets",
                        "typeLine": "Creature — Human Wizard",
                        "oracleText": "At the beginning of your upkeep…",
                        "manaCost": "{U}",
                        "artist": "Nils Hamm"
                    },
                    {
                        "name": "Insectile Aberration",
                        "typeLine": "Creature — Human Insect",
                        "oracleText": "Flying",
                        "manaCost": null,
                        "artist": "Nils Hamm"
                    }
                ]
            })
        );
    }

    /// The list half of the same hand-mirrored contract, pinned whole for the same reason:
    /// `fullArt` and `borderColor` are the names a printings row is *distinguished* by, and
    /// a printing whose art variant renders wrong looks like a data problem rather than a
    /// rename.
    ///
    /// The empty answer is pinned too. [`PrintingsResponse::default()`] is what a blank
    /// `oracle_id` returns, and `items` has to reach a pane that maps over it as `[]` — an
    /// `Option<Vec<_>>` here, or a `skip_serializing_if` on an empty one, would send
    /// `null`/nothing and crash the map instead of rendering an empty list.
    #[test]
    fn printings_response_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(PrintingsResponse {
            items: vec![Printing {
                id: "p1".into(),
                set_code: "lea".into(),
                set_name: Some("Limited Edition Alpha".into()),
                collector_number: "161".into(),
                released_at: Some("1993-08-05".into()),
                rarity: Some("common".into()),
                illustration_id: Some("art-a".into()),
                artist: Some("Christopher Rush".into()),
                lang: "en".into(),
                finishes: Some(r#"["nonfoil"]"#.into()),
                prices: Some(r#"{"usd":"400.50"}"#.into()),
                promo: false,
                full_art: false,
                // Absent, not empty: an Alpha printing has no frame effects at all.
                frame_effects: None,
                border_color: Some("black".into()),
                layout: "normal".into(),
            }],
            // Larger than `items`, which is the whole signal that a list was truncated.
            total: 862,
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "items": [{
                    "id": "p1",
                    "setCode": "lea",
                    "setName": "Limited Edition Alpha",
                    "collectorNumber": "161",
                    "releasedAt": "1993-08-05",
                    "rarity": "common",
                    "illustrationId": "art-a",
                    "artist": "Christopher Rush",
                    "lang": "en",
                    "finishes": r#"["nonfoil"]"#,
                    "prices": r#"{"usd":"400.50"}"#,
                    "promo": false,
                    "fullArt": false,
                    "frameEffects": null,
                    "borderColor": "black",
                    "layout": "normal"
                }],
                "total": 862
            })
        );

        assert_eq!(
            serde_json::to_value(PrintingsResponse::default()).unwrap(),
            serde_json::json!({"items": [], "total": 0})
        );
    }
}
