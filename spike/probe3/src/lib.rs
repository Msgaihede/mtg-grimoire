//! Probe 3: the ingest, in a browser, end to end.
//!
//! Because every platform builds its own corpus (decision 5), the whole
//! download → decompress → parse → insert path has to run in wasm. This is that path
//! against the real `default_cards` bulk file and a real OPFS database.
//!
//! **It streams throughout and never holds the file.** `reqwest::Response::bytes_stream()`
//! yields compressed chunks; each is pushed into a `flate2::write::GzDecoder` whose sink is
//! a small `Vec`; complete lines are drained out of that sink and the partial tail is
//! carried to the next chunk. Peak memory is one chunk plus one batch, which is the same
//! shape `src-tauri/src/ingest.rs` already has — the difference is only that the desktop
//! reads a file it downloaded and this reads the socket.
//!
//! The row written here is a **20-column subset** of the real 43, chosen as the ones that
//! cost something: the four JSON sub-objects (`legalities`, `prices`, `image_uris`,
//! `card_faces`) are re-serialised and stored exactly as the real ingest stores them, since
//! they dominate both parse time and row width. `raw` is deliberately absent — that is
//! decision 6, and dropping it is the whole reason Tier A is 526 MB rather than 751 MB.
//! Every timing below therefore *understates* the real ingest somewhat, and says so.

use futures_util::StreamExt as _;
use rusqlite::Connection;
use std::io::Write as _;
use wasm_bindgen::prelude::*;

const VFS_NAME: &str = "opfs-sahpool";
const DB: &str = "probe3.db";
const BATCH: usize = 2000;

fn now() -> f64 {
    js_sys::Date::now()
}

fn push(out: &mut String, s: &str) {
    out.push_str(s);
    out.push('\n');
}

/// The fields the ingest actually reads. Borrowed where possible so a line is parsed
/// without copying every string out of it.
#[derive(serde::Deserialize)]
struct Card {
    id: String,
    #[serde(default)]
    oracle_id: Option<String>,
    name: String,
    #[serde(default)]
    lang: Option<String>,
    #[serde(default)]
    released_at: Option<String>,
    #[serde(default)]
    set: Option<String>,
    #[serde(default)]
    set_name: Option<String>,
    #[serde(default)]
    collector_number: Option<String>,
    #[serde(default)]
    rarity: Option<String>,
    #[serde(default)]
    layout: Option<String>,
    #[serde(default)]
    mana_cost: Option<String>,
    #[serde(default)]
    cmc: Option<f64>,
    #[serde(default)]
    type_line: Option<String>,
    #[serde(default)]
    oracle_text: Option<String>,
    #[serde(default)]
    colors: Option<serde_json::Value>,
    #[serde(default)]
    color_identity: Option<serde_json::Value>,
    #[serde(default)]
    legalities: Option<serde_json::Value>,
    #[serde(default)]
    prices: Option<serde_json::Value>,
    #[serde(default)]
    image_uris: Option<serde_json::Value>,
    #[serde(default)]
    card_faces: Option<serde_json::Value>,
}

async fn install_vfs() -> Result<(), String> {
    let cfg = sqlite_wasm_vfs::sahpool::OpfsSAHPoolCfgBuilder::new()
        .vfs_name(VFS_NAME)
        .directory("probe3")
        .initial_capacity(8)
        .build();
    sqlite_wasm_vfs::sahpool::install::<rusqlite::ffi::WasmOsCallback>(&cfg, true)
        .await
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

fn file_bytes(conn: &Connection) -> u64 {
    let pages: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap_or(0);
    let size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap_or(0);
    (pages * size) as u64
}

fn as_text(v: &Option<serde_json::Value>) -> Option<String> {
    v.as_ref().map(|x| x.to_string())
}

fn write_batch(conn: &Connection, batch: &mut Vec<Card>) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| format!("{e:?}"))?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO cards_staging VALUES
                 (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
            )
            .map_err(|e| format!("{e:?}"))?;
        for c in batch.iter() {
            stmt.execute(rusqlite::params![
                c.id,
                c.oracle_id,
                c.name,
                c.lang,
                c.released_at,
                c.set,
                c.set_name,
                c.collector_number,
                c.rarity,
                c.layout,
                c.mana_cost,
                c.cmc,
                c.type_line,
                c.oracle_text,
                as_text(&c.colors),
                as_text(&c.color_identity),
                as_text(&c.legalities),
                as_text(&c.prices),
                as_text(&c.image_uris),
                as_text(&c.card_faces),
            ])
            .map_err(|e| format!("{e:?}"))?;
        }
    }
    tx.commit().map_err(|e| format!("{e:?}"))?;
    batch.clear();
    Ok(())
}

/// Fetch the bulk descriptor, then stream, decompress, parse and insert the whole file.
#[wasm_bindgen]
pub async fn ingest() -> String {
    console_error_panic_hook::set_once();
    let mut out = String::new();
    let t_all = now();

    if let Err(e) = install_vfs().await {
        push(&mut out, &format!("FAIL vfs/install  |  {e}"));
        return out;
    }
    let conn = match Connection::open(DB) {
        Ok(c) => c,
        Err(e) => {
            push(&mut out, &format!("FAIL db/open  |  {e:?}"));
            return out;
        }
    };
    if let Err(e) = conn.execute_batch(
        "DROP TABLE IF EXISTS cards_staging;
         CREATE TABLE cards_staging (
            id TEXT PRIMARY KEY, oracle_id TEXT, name TEXT, lang TEXT, released_at TEXT,
            set_code TEXT, set_name TEXT, collector_number TEXT, rarity TEXT, layout TEXT,
            mana_cost TEXT, cmc REAL, type_line TEXT, oracle_text TEXT, colors TEXT,
            color_identity TEXT, legalities TEXT, prices TEXT, image_uris TEXT, faces TEXT
         );",
    ) {
        push(&mut out, &format!("FAIL schema/create  |  {e:?}"));
        return out;
    }
    push(&mut out, "PASS setup  |  OPFS pool + empty cards_staging");

    // --- the bulk descriptor ---------------------------------------------------------
    // No custom User-Agent: `User-Agent` is a forbidden header for `fetch`, so the browser
    // sends its own. That is a real UA rather than an absent one, which is what Scryfall's
    // rule is actually about — but it is NOT the app-identifying string the desktop sends,
    // and the spec should say so out loud.
    let t = now();
    let client = reqwest::Client::new();
    let desc = match client
        .get("https://api.scryfall.com/bulk-data/default_cards")
        .header("Accept", "application/json")
        .send()
        .await
    {
        // `.text()` then serde rather than `.json()`: the latter needs reqwest's `json`
        // feature, and this probe's whole claim is that it uses src-tauri's feature line
        // unchanged.
        Ok(r) => match r.text().await {
            Ok(t) => match serde_json::from_str::<serde_json::Value>(&t) {
                Ok(v) => v,
                Err(e) => {
                    push(&mut out, &format!("FAIL bulk/parse-descriptor  |  {e}"));
                    return out;
                }
            },
            Err(e) => {
                push(&mut out, &format!("FAIL bulk/read-descriptor  |  {e}"));
                return out;
            }
        },
        Err(e) => {
            push(&mut out, &format!("FAIL bulk/descriptor  |  {e}"));
            return out;
        }
    };
    let uri = desc["jsonl_download_uri"].as_str().unwrap_or("").to_owned();
    let compressed = desc["compressed_size"].as_u64().unwrap_or(0);
    push(
        &mut out,
        &format!(
            "PASS bulk/descriptor  |  {:.1} MB gz, {:.0} ms",
            compressed as f64 / 1048576.0,
            now() - t
        ),
    );

    // --- stream, decompress, parse, insert -------------------------------------------
    let t_stream = now();
    let resp = match client.get(&uri).send().await {
        Ok(r) => r,
        Err(e) => {
            push(&mut out, &format!("FAIL bulk/download  |  {e}"));
            return out;
        }
    };
    let mut stream = resp.bytes_stream();

    let mut dec = flate2::write::GzDecoder::new(Vec::<u8>::new());
    let mut tail: Vec<u8> = Vec::new();
    let mut batch: Vec<Card> = Vec::with_capacity(BATCH);

    let mut down_bytes: u64 = 0;
    let mut raw_bytes: u64 = 0;
    let mut lines: u64 = 0;
    let mut parsed: u64 = 0;
    let mut skipped: u64 = 0;
    let mut t_parse = 0.0f64;
    let mut t_insert = 0.0f64;

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                push(&mut out, &format!("FAIL stream/chunk at {down_bytes} bytes  |  {e}"));
                return out;
            }
        };
        down_bytes += chunk.len() as u64;
        if let Err(e) = dec.write_all(&chunk) {
            push(&mut out, &format!("FAIL gunzip/write  |  {e}"));
            return out;
        }

        // Drain whole lines out of the decompressor's sink; carry the partial tail.
        let sink = dec.get_mut();
        raw_bytes += sink.len() as u64;
        tail.append(sink);
        let mut start = 0usize;
        let tp = now();
        while let Some(nl) = tail[start..].iter().position(|b| *b == b'\n') {
            let line = &tail[start..start + nl];
            start += nl + 1;
            lines += 1;
            // The JSONL file's first and last lines are objects, not array brackets, but a
            // blank line would still be legal and must not be a parse failure.
            if line.is_empty() {
                continue;
            }
            match serde_json::from_slice::<Card>(line) {
                Ok(c) => {
                    parsed += 1;
                    batch.push(c);
                }
                Err(_) => skipped += 1,
            }
        }
        tail.drain(..start);
        t_parse += now() - tp;

        if batch.len() >= BATCH {
            let ti = now();
            if let Err(e) = write_batch(&conn, &mut batch) {
                push(&mut out, &format!("FAIL insert at {parsed} rows  |  {e}"));
                return out;
            }
            t_insert += now() - ti;
        }
    }

    if let Err(e) = dec.try_finish() {
        push(&mut out, &format!("FAIL gunzip/finish  |  {e}"));
        return out;
    }
    if !batch.is_empty() {
        let ti = now();
        if let Err(e) = write_batch(&conn, &mut batch) {
            push(&mut out, &format!("FAIL insert/tail  |  {e}"));
            return out;
        }
        t_insert += now() - ti;
    }

    let stream_secs = (now() - t_stream) / 1000.0;
    push(
        &mut out,
        &format!(
            "PASS ingest/stream  |  {:.1} MB gz in, {:.1} MB json out, {} lines, {} parsed, {} skipped",
            down_bytes as f64 / 1048576.0,
            raw_bytes as f64 / 1048576.0,
            lines,
            parsed,
            skipped
        ),
    );
    push(
        &mut out,
        &format!(
            "PASS ingest/time  |  {:.1} s total  (parse {:.1} s, insert {:.1} s, net+gunzip {:.1} s)",
            stream_secs,
            t_parse / 1000.0,
            t_insert / 1000.0,
            stream_secs - (t_parse + t_insert) / 1000.0
        ),
    );

    // --- the index work a real ingest still owes -------------------------------------
    let t_idx = now();
    let idx = conn.execute_batch(
        "CREATE INDEX idx_s_oracle ON cards_staging(oracle_id);
         CREATE INDEX idx_s_name ON cards_staging(name);
         CREATE INDEX idx_s_set_cn ON cards_staging(set_code, collector_number);",
    );
    match idx {
        Ok(()) => push(
            &mut out,
            &format!("PASS ingest/indexes  |  3 indexes in {:.1} s", (now() - t_idx) / 1000.0),
        ),
        Err(e) => push(&mut out, &format!("FAIL ingest/indexes  |  {e:?}")),
    }

    let t_fts = now();
    let fts = conn.execute_batch(
        "CREATE VIRTUAL TABLE cards_fts USING fts5(
            name, type_line, oracle_text,
            content='cards_staging', tokenize='unicode61 remove_diacritics 2');
         INSERT INTO cards_fts(cards_fts) VALUES('rebuild');",
    );
    match fts {
        Ok(()) => push(
            &mut out,
            &format!("PASS ingest/fts5-rebuild  |  {:.1} s", (now() - t_fts) / 1000.0),
        ),
        Err(e) => push(&mut out, &format!("FAIL ingest/fts5-rebuild  |  {e:?}")),
    }

    push(
        &mut out,
        &format!(
            "PASS ingest/total  |  {:.1} s wall clock, database {:.1} MB",
            (now() - t_all) / 1000.0,
            file_bytes(&conn) as f64 / 1048576.0
        ),
    );

    // --- one real query shape, for the browse comparison ------------------------------
    let t = now();
    let n: i64 = conn
        .query_row("SELECT count(*) FROM cards_staging", [], |r| r.get(0))
        .unwrap_or(-1);
    push(&mut out, &format!("INFO query/count  |  {n} rows in {:.1} ms", now() - t));

    let t = now();
    let hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH ?1",
            ["dragon"],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    push(
        &mut out,
        &format!("INFO query/fts-dragon  |  {hits} matches in {:.1} ms", now() - t),
    );

    let t = now();
    let hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH ?1",
            ["bolt"],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    push(
        &mut out,
        &format!("INFO query/fts-bolt  |  {hits} matches in {:.1} ms", now() - t),
    );

    out
}
