//! Probe 2: OPFS capacity, the second load, and the single-connection ceiling.
//!
//! Runs inside a DEDICATED WORKER — `opfs-sahpool` holds exclusive SyncAccessHandles and is
//! documented as Worker-only. That constraint is itself part of the finding rather than a
//! detail of the harness: the whole database is reachable from exactly one place, so every
//! read and write in the app has to queue through it.
//!
//! The corpus here is synthetic but the BYTES are not. Rows are sized against the live
//! measurement of `cards` once `raw` is dropped (264.6 MB over 116 843 rows), and the file is
//! grown to Tier A's measured 526 MB. SQLite stores text verbatim, so what a row *says* does
//! not change what it costs on disk — only how long it is.

use rusqlite::Connection;
use wasm_bindgen::prelude::*;

const VFS_NAME: &str = "opfs-sahpool";
const DB: &str = "probe2.db";

/// Tier A, measured by `dbstat` on the live 751 MB database: everything except the
/// `cards.raw` column, which is 224.7 MB of it.
const TARGET_BYTES: u64 = 526 * 1024 * 1024;

fn now() -> f64 {
    js_sys::Date::now()
}

fn push(out: &mut String, s: &str) {
    out.push_str(s);
    out.push('\n');
}

async fn install_vfs() -> Result<(), String> {
    let cfg = sqlite_wasm_vfs::sahpool::OpfsSAHPoolCfgBuilder::new()
        .vfs_name(VFS_NAME)
        .directory("probe2")
        // The pool preallocates FILES, not bytes: one database, its journal, and headroom.
        .initial_capacity(8)
        .build();
    sqlite_wasm_vfs::sahpool::install::<rusqlite::ffi::WasmOsCallback>(&cfg, true)
        .await
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

fn open() -> Result<Connection, String> {
    Connection::open(DB).map_err(|e| format!("{e:?}"))
}

fn file_bytes(conn: &Connection) -> Result<u64, String> {
    let pages: i64 = conn
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .map_err(|e| format!("{e:?}"))?;
    let size: i64 = conn
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .map_err(|e| format!("{e:?}"))?;
    Ok((pages * size) as u64)
}

async fn storage_line() -> String {
    let scope: web_sys::WorkerGlobalScope = js_sys::global().unchecked_into();
    let storage = scope.navigator().storage();
    match storage.estimate() {
        Ok(p) => match wasm_bindgen_futures::JsFuture::from(p).await {
            Ok(v) => {
                let get = |k: &str| {
                    js_sys::Reflect::get(&v, &JsValue::from_str(k))
                        .ok()
                        .and_then(|x| x.as_f64())
                        .unwrap_or(-1.0)
                };
                format!(
                    "usage {:.1} MB / quota {:.1} MB",
                    get("usage") / 1048576.0,
                    get("quota") / 1048576.0
                )
            }
            Err(e) => format!("estimate() rejected: {e:?}"),
        },
        Err(e) => format!("estimate() unavailable: {e:?}"),
    }
}

async fn persisted_line() -> String {
    let scope: web_sys::WorkerGlobalScope = js_sys::global().unchecked_into();
    let storage = scope.navigator().storage();
    match storage.persisted() {
        Ok(p) => match wasm_bindgen_futures::JsFuture::from(p).await {
            Ok(v) => format!("navigator.storage.persisted() = {:?}", v.as_bool()),
            Err(e) => format!("persisted() rejected: {e:?}"),
        },
        Err(e) => format!("persisted() unavailable in worker: {e:?}"),
    }
}

/// Build the corpus. Grows the OPFS file to [`TARGET_BYTES`] and reports throughput.
#[wasm_bindgen]
pub async fn fill() -> String {
    console_error_panic_hook::set_once();
    let mut out = String::new();

    let t_install = now();
    if let Err(e) = install_vfs().await {
        push(&mut out, &format!("FAIL vfs/install  |  {e}"));
        return out;
    }
    push(
        &mut out,
        &format!(
            "PASS vfs/install  |  {} in {:.0} ms",
            VFS_NAME,
            now() - t_install
        ),
    );

    let conn = match open() {
        Ok(c) => c,
        Err(e) => {
            push(&mut out, &format!("FAIL db/open  |  {e}"));
            return out;
        }
    };
    push(&mut out, "PASS db/open  |  opened on the OPFS pool");

    // WAL is what the desktop runs. Whether a single-connection VFS accepts it at all is worth
    // knowing, because the answer changes the durability story and not only the speed.
    let journal: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
        .unwrap_or_else(|e| format!("error: {e:?}"));
    push(&mut out, &format!("INFO pragma/journal_mode  |  {journal}"));

    if let Err(e) = conn.execute_batch(
        "DROP TABLE IF EXISTS corpus;
         CREATE TABLE corpus (
            id TEXT PRIMARY KEY, oracle_id TEXT, name TEXT, set_code TEXT,
            type_line TEXT, oracle_text TEXT, legalities TEXT, prices TEXT,
            image_uris TEXT, search_text TEXT
         );",
    ) {
        push(&mut out, &format!("FAIL schema/create  |  {e:?}"));
        return out;
    }

    // ~2.26 KB a row, the live per-row cost of `cards` once `raw` is gone.
    let filler = "x".repeat(300);
    let t0 = now();
    let mut rows: u64 = 0;
    let mut bytes = file_bytes(&conn).unwrap_or(0);

    while bytes < TARGET_BYTES {
        let tx = match conn.unchecked_transaction() {
            Ok(t) => t,
            Err(e) => {
                push(&mut out, &format!("FAIL tx/begin at {rows} rows  |  {e:?}"));
                return out;
            }
        };
        {
            let mut stmt =
                match tx.prepare_cached("INSERT INTO corpus VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)")
                {
                    Ok(s) => s,
                    Err(e) => {
                        push(&mut out, &format!("FAIL stmt/prepare  |  {e:?}"));
                        return out;
                    }
                };
            for _ in 0..5000 {
                rows += 1;
                if let Err(e) = stmt.execute(rusqlite::params![
                    format!("id-{rows:012}"),
                    format!("oracle-{}", rows % 38626),
                    format!("Card Name {rows}"),
                    format!("set{}", rows % 1048),
                    "Legendary Creature - Human Wizard",
                    filler,
                    filler,
                    filler,
                    filler,
                    filler,
                ]) {
                    push(&mut out, &format!("FAIL insert at row {rows}  |  {e:?}"));
                    push(&mut out, &format!("     file was {} MB", bytes / 1048576));
                    return out;
                }
            }
        }
        if let Err(e) = tx.commit() {
            push(&mut out, &format!("FAIL tx/commit at {rows} rows  |  {e:?}"));
            push(&mut out, &format!("     file was {} MB", bytes / 1048576));
            return out;
        }
        bytes = match file_bytes(&conn) {
            Ok(b) => b,
            Err(e) => {
                push(&mut out, &format!("FAIL page_count  |  {e}"));
                return out;
            }
        };
    }

    let secs = (now() - t0) / 1000.0;
    push(
        &mut out,
        &format!(
            "PASS write/grow  |  {} rows, {:.1} MB, {:.1} s, {:.1} MB/s",
            rows,
            bytes as f64 / 1048576.0,
            secs,
            (bytes as f64 / 1048576.0) / secs
        ),
    );
    push(
        &mut out,
        &format!("INFO storage/estimate  |  {}", storage_line().await),
    );
    push(
        &mut out,
        &format!("INFO storage/persisted  |  {}", persisted_line().await),
    );
    out
}

/// The SECOND load: reopen what a previous page left in OPFS and query it.
#[wasm_bindgen]
pub async fn verify() -> String {
    console_error_panic_hook::set_once();
    let mut out = String::new();

    let t_install = now();
    if let Err(e) = install_vfs().await {
        push(&mut out, &format!("FAIL vfs/install  |  {e}"));
        return out;
    }
    push(
        &mut out,
        &format!(
            "PASS vfs/install  |  reattached in {:.0} ms",
            now() - t_install
        ),
    );

    let conn = match open() {
        Ok(c) => c,
        Err(e) => {
            push(&mut out, &format!("FAIL db/reopen  |  {e}"));
            return out;
        }
    };

    let bytes = file_bytes(&conn).unwrap_or(0);
    push(
        &mut out,
        &format!(
            "PASS db/reopen  |  file is {:.1} MB",
            bytes as f64 / 1048576.0
        ),
    );

    let t = now();
    let count: i64 = match conn.query_row("SELECT count(*) FROM corpus", [], |r| r.get(0)) {
        Ok(n) => n,
        Err(e) => {
            push(&mut out, &format!("FAIL query/count  |  {e:?}"));
            return out;
        }
    };
    push(
        &mut out,
        &format!(
            "PASS query/count  |  {count} rows survived the reload, {:.1} ms",
            now() - t
        ),
    );

    // A point lookup on the primary key and a full-scan aggregate: two ends of the range.
    let t = now();
    let one: Result<String, _> = conn.query_row(
        "SELECT name FROM corpus WHERE id = ?1",
        ["id-000000050000"],
        |r| r.get(0),
    );
    push(
        &mut out,
        &format!("INFO query/pk-lookup  |  {:?} in {:.2} ms", one.ok(), now() - t),
    );

    let t = now();
    let grouped: Result<i64, _> =
        conn.query_row("SELECT count(DISTINCT oracle_id) FROM corpus", [], |r| {
            r.get(0)
        });
    push(
        &mut out,
        &format!(
            "INFO query/distinct-scan  |  {:?} in {:.0} ms",
            grouped.ok(),
            now() - t
        ),
    );

    push(
        &mut out,
        &format!("INFO storage/estimate  |  {}", storage_line().await),
    );
    out
}
