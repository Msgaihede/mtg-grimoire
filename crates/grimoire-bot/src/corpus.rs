//! **The slim corpus**: only the printings the group's rows reference, fetched from Scryfall's
//! `/cards/collection` as the rows arrive.
//!
//! A device of the app downloads Scryfall's whole bulk file — ~117 000 printings, hundreds of
//! megabytes — which a Durable Object has neither the memory nor the CPU to ingest. The bot needs a
//! name, a set, a picture and a price for the cards the reader actually has, so it asks for those
//! and nothing else, 75 identifiers a request (Scryfall's cap), paced.
//!
//! **The rows go into the core's own `cards` table**, so the queries join `collection_entries`,
//! `wishlist_entries` and `deck_cards` to it exactly as the app's do. Each is parsed by the core's
//! own `CardRow::from_json_line` — every NOT NULL column filled, and the derived ones
//! (`produced_mana`, `keywords`, `print_facts`) filled too, so no launch pass ever decides a row is
//! from before a migration and reaches for `raw`. `raw` itself is `{}`: the card's JSON is not
//! kept. One key is added that a bulk ingest does not store: Scryfall's JPEG `normal` image,
//! merged into `image_uris` (and into each face's entry of `face_image_uris`) beside the four WEBP
//! variants — the picture a Discord embed shows.
//!
//! **What was asked is remembered** in `corpus.bot_fetched` — `id:<scryfall id>` or
//! `name:<name>` (a wish for any printing names no printing, so it is asked by name), when, and
//! whether Scryfall knew it. An id Scryfall does not know is not asked again; a printing it does
//! is asked again after [`REFRESH_SECS`], which is how a price moves.

use grimoire_core::card_row::CardRow;
use grimoire_core::platform::http;
use grimoire_core::state::Store;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

/// Scryfall's API.
pub const SCRYFALL_API: &str = grimoire_core::launch::SCRYFALL_API;

/// Scryfall's cap on identifiers in one `/cards/collection` request.
pub const BATCH: usize = 75;

/// How long between two requests — Scryfall asks for no more than two a second on its card
/// endpoints, and this is half of that.
pub const PACE_MS: u64 = 1_000;

/// How old a fetched printing may get before it is asked for again, for its price.
pub const REFRESH_SECS: i64 = 7 * 24 * 60 * 60;

/// The bot's own table, in the corpus file beside `cards` — so a corpus thrown away takes it too.
const FETCHED_DDL: &str = "CREATE TABLE IF NOT EXISTS corpus.bot_fetched (
        key TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        found INTEGER NOT NULL
    ) WITHOUT ROWID";

/// What Scryfall is asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wanted {
    Id(String),
    Name(String),
}

impl Wanted {
    fn key(&self) -> String {
        match self {
            Wanted::Id(id) => format!("id:{id}"),
            Wanted::Name(name) => format!("name:{}", name.to_lowercase()),
        }
    }

    fn identifier(&self) -> Value {
        match self {
            Wanted::Id(id) => json!({ "id": id }),
            Wanted::Name(name) => json!({ "name": name }),
        }
    }
}

/// How a fill went.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Filled {
    /// Requests made.
    pub requests: usize,
    /// Printings written.
    pub stored: usize,
    /// Identifiers Scryfall did not know.
    pub unknown: usize,
    /// Whether more is wanted than this fill asked for.
    pub more: bool,
    /// Whether Scryfall said to slow down (429), which ends the fill.
    pub throttled: bool,
}

fn err(e: rusqlite::Error) -> String {
    format!("the bot's card list could not be read or written: {e}")
}

/// Make the bot's table, if it is not there.
pub fn prepare(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(FETCHED_DDL).map_err(err)
}

/// **Up to `limit` things to ask Scryfall for**, in this order: printings the rows reference that
/// the corpus lacks; wishes for any printing whose name the corpus has no printing of; printings
/// fetched longer than [`REFRESH_SECS`] ago that a row still references.
pub fn wanted(conn: &Connection, now_secs: i64, limit: usize) -> Result<Vec<Wanted>, String> {
    prepare(conn)?;
    let mut out = Vec::new();
    let limit = limit as i64;
    let referenced = "SELECT card_id AS id FROM collection_entries
                      UNION SELECT card_id FROM wishlist_entries WHERE card_id IS NOT NULL
                      UNION SELECT card_id FROM deck_cards";
    let missing = format!(
        "SELECT r.id FROM ({referenced}) r
          WHERE r.id IS NOT NULL AND r.id <> ''
            AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.id = r.id)
            AND NOT EXISTS (SELECT 1 FROM corpus.bot_fetched f WHERE f.key = 'id:' || r.id)
          ORDER BY r.id LIMIT ?1"
    );
    let mut stmt = conn.prepare(&missing).map_err(err)?;
    for id in stmt
        .query_map([limit], |r| r.get::<_, String>(0))
        .map_err(err)?
    {
        out.push(Wanted::Id(id.map_err(err)?));
    }
    let room = limit - out.len() as i64;
    if room > 0 {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT w.name FROM wishlist_entries w
                  WHERE w.card_id IS NULL
                    AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.name = w.name)
                    AND NOT EXISTS (SELECT 1 FROM corpus.bot_fetched f
                                     WHERE f.key = 'name:' || lower(w.name))
                  ORDER BY w.name LIMIT ?1",
            )
            .map_err(err)?;
        for name in stmt
            .query_map([room], |r| r.get::<_, String>(0))
            .map_err(err)?
        {
            out.push(Wanted::Name(name.map_err(err)?));
        }
    }
    let room = limit - out.len() as i64;
    if room > 0 {
        let stale = format!(
            "SELECT r.id FROM ({referenced}) r
               JOIN corpus.bot_fetched f ON f.key = 'id:' || r.id
              WHERE f.found = 1 AND f.at < ?1
              ORDER BY f.at, r.id LIMIT ?2"
        );
        let mut stmt = conn.prepare(&stale).map_err(err)?;
        for id in stmt
            .query_map(params![now_secs - REFRESH_SECS, room], |r| {
                r.get::<_, String>(0)
            })
            .map_err(err)?
        {
            out.push(Wanted::Id(id.map_err(err)?));
        }
    }
    Ok(out)
}

/// The `normal` JPEG of an `image_uris` object.
fn normal(images: Option<&Value>) -> Option<String> {
    images?.get("normal")?.as_str().map(str::to_owned)
}

/// A JSON object column with `normal` merged in, or the column as it was.
fn with_normal(column: Option<String>, normal: Option<String>) -> Option<String> {
    let Some(normal) = normal else {
        return column;
    };
    let mut object = column
        .and_then(|c| serde_json::from_str::<Value>(&c).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    object["normal"] = Value::String(normal);
    Some(object.to_string())
}

/// `face_image_uris` with each face's `normal` merged in.
fn faces_with_normal(column: Option<String>, card: &Value) -> Option<String> {
    let faces = card.get("card_faces").and_then(Value::as_array)?;
    let normals: Vec<Option<String>> = faces.iter().map(|f| normal(f.get("image_uris"))).collect();
    if normals.iter().all(Option::is_none) {
        return column;
    }
    let mut stored: Vec<Value> = column
        .and_then(|c| serde_json::from_str::<Vec<Value>>(&c).ok())
        .unwrap_or_default();
    stored.resize(faces.len(), Value::Null);
    for (entry, normal) in stored.iter_mut().zip(normals) {
        if let Some(normal) = normal {
            if !entry.is_object() {
                *entry = json!({});
            }
            entry["normal"] = Value::String(normal);
        }
    }
    Some(Value::Array(stored).to_string())
}

/// Write one Scryfall card into `cards`. `false` when it is not a card object.
pub fn store_card(conn: &Connection, card: &Value) -> Result<bool, String> {
    let Some(row) = CardRow::from_json_line(card, "{}") else {
        return Ok(false);
    };
    let image_uris = with_normal(row.image_uris.clone(), normal(card.get("image_uris")));
    let face_image_uris = faces_with_normal(row.face_image_uris.clone(), card);
    conn.execute(
        "INSERT OR REPLACE INTO cards
             (id, oracle_id, name, lang, released_at, set_code, set_name, collector_number,
              rarity, layout, mana_cost, cmc, type_line, oracle_text, colors, color_identity,
              legalities, legal_mask, type_mask, games, finishes, prices, price_usd, price_eur,
              full_art, promo, digital, is_paper, image_uris, face_image_uris, artist, power,
              toughness, search_text, raw, produced_mana, keywords, print_facts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
                 ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34,
                 '{}', ?35, ?36, ?37)",
        params![
            row.id,
            row.oracle_id,
            row.name,
            row.lang,
            row.released_at,
            row.set_code,
            row.set_name,
            row.collector_number,
            row.rarity,
            row.layout,
            row.mana_cost,
            row.cmc,
            row.type_line,
            row.oracle_text,
            row.colors,
            row.color_identity,
            row.legalities,
            row.legal_mask as i64,
            grimoire_core::cardtypes::type_mask(row.type_line.as_deref().unwrap_or("")) as i64,
            row.games,
            row.finishes,
            row.prices,
            row.price_usd,
            row.price_eur,
            row.full_art,
            row.promo,
            row.digital,
            row.is_paper,
            image_uris,
            face_image_uris,
            row.artist,
            row.power,
            row.toughness,
            row.search_text,
            row.produced_mana,
            row.keywords,
            row.print_facts,
        ],
    )
    .map_err(err)?;
    Ok(true)
}

/// Record what was asked and what came back, in one stretch.
fn record(
    conn: &Connection,
    asked: &[Wanted],
    cards: &[Value],
    unknown: &[Value],
    now_secs: i64,
) -> Result<usize, String> {
    prepare(conn)?;
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut stored = 0;
    for card in cards {
        if store_card(&tx, card)? {
            stored += 1;
        }
    }
    let unknown_keys: Vec<String> = unknown
        .iter()
        .filter_map(|i| {
            if let Some(id) = i.get("id").and_then(Value::as_str) {
                Some(Wanted::Id(id.to_owned()).key())
            } else {
                i.get("name")
                    .and_then(Value::as_str)
                    .map(|n| Wanted::Name(n.to_owned()).key())
            }
        })
        .collect();
    for want in asked {
        let key = want.key();
        let found = !unknown_keys.contains(&key);
        tx.execute(
            "INSERT OR REPLACE INTO corpus.bot_fetched (key, at, found) VALUES (?1, ?2, ?3)",
            params![key, now_secs, found],
        )
        .map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(stored)
}

/// The client every fill uses: the app's `User-Agent` (which workerd lets a script set, unlike a
/// browser), and a deadline, since `fetch` has no connect or read bound of its own.
pub fn client() -> http::Client {
    http::Client::new(&http::Config {
        user_agent: grimoire_core::scryfall::USER_AGENT,
        connect_timeout: Some(std::time::Duration::from_secs(10)),
        read_timeout: Some(std::time::Duration::from_secs(30)),
        https_only: false,
    })
    .deadline(std::time::Duration::from_secs(30))
}

/// **Fill the corpus**, at most `batches` requests of [`BATCH`] — a Durable Object's alarm has a
/// CPU budget, and a group's first materialisation can reference thousands of printings, so a
/// fill is cut into pieces and [`Filled::more`] asks for another alarm.
///
/// `base` is Scryfall's API ([`SCRYFALL_API`]), or a test's server. `now_secs` is the clock the
/// records are stamped with. A request that fails ends the fill with what it had done; a 429 ends
/// it as [`Filled::throttled`].
pub async fn fill(
    db: &impl Store,
    client: &http::Client,
    base: &str,
    batches: usize,
    now_secs: i64,
) -> Result<Filled, String> {
    let mut filled = Filled::default();
    for n in 0..batches {
        let asked = db.with(|conn| wanted(conn, now_secs, BATCH))?;
        if asked.is_empty() {
            return Ok(filled);
        }
        if n > 0 {
            grimoire_core::platform::timer::sleep(std::time::Duration::from_millis(PACE_MS)).await;
        }
        let body =
            json!({ "identifiers": asked.iter().map(Wanted::identifier).collect::<Vec<_>>() });
        let response = client
            .post(&format!("{base}/cards/collection"))
            .header("user-agent", grimoire_core::scryfall::USER_AGENT)
            .header("accept", "application/json;q=0.9,*/*;q=0.8")
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("Scryfall could not be reached for card details: {e}"))?;
        filled.requests += 1;
        let status = response.status();
        if status == 429 {
            filled.throttled = true;
            filled.more = true;
            return Ok(filled);
        }
        if !(200..300).contains(&status) {
            return Err(format!(
                "Scryfall answered {status} to a request for card details"
            ));
        }
        let text = response
            .text()
            .await
            .map_err(|e| format!("Scryfall's card details could not be read: {e}"))?;
        let answer: Value = serde_json::from_str(&text)
            .map_err(|e| format!("Scryfall's card details were not JSON: {e}"))?;
        let cards = answer
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let unknown = answer
            .get("not_found")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        filled.unknown += unknown.len();
        filled.stored += db.with(|conn| record(conn, &asked, &cards, &unknown, now_secs))?;
    }
    filled.more = !db.with(|conn| wanted(conn, now_secs, 1))?.is_empty();
    Ok(filled)
}

#[cfg(test)]
pub(crate) mod tests;
