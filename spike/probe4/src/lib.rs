//! Probe 4: Commander Spellbook's combo feed, in a browser.
//!
//! 26.3 MB gzipped over ~639 MB of JSON — the largest parse in the app, and the one thing
//! probes 1–3 did not exercise. It is also the one feed that is **not** line-delimited: a
//! single JSON object whose `variants` key holds one enormous array.
//!
//! # Why this cannot reuse the desktop parser
//!
//! `src-tauri/src/combos.rs` streams with `serde_json::Deserializer::from_reader` plus a
//! `DeserializeSeed` over the array. That is a **pull** parser: it calls `read()` whenever it
//! wants more, and blocks until it gets it. A wasm stream is push and async — there is no
//! thread to block, so `from_reader` cannot be driven from it at all. That is a real port
//! problem rather than a detail of this harness, and the I/O-layer PR has to answer it.
//!
//! The answer used here, and the one I would carry forward: **frame the array elements by
//! hand, then parse each one whole.** Depth-count braces over the decompressed bytes, tracking
//! string and escape state so a `{` inside a card name is not counted, and hand each complete
//! element to `serde_json::from_slice`. Peak memory is one element plus one batch. It keeps
//! serde for the part serde is good at and replaces only the part that needed a blocking read.
//!
//! # The other port problem: who unzips
//!
//! Spellbook serves `variants.json.gz` with **`Content-Encoding: gzip`** — and keeps doing so
//! even when the client asks for `identity`. Scryfall serves its `.jsonl.gz` as
//! `Content-Type: application/gzip` with **no** `Content-Encoding` at all. That difference
//! decides who decompresses:
//!
//! * In a browser, `fetch` transparently decodes any `Content-Encoding: gzip` response and
//!   there is **no way to opt out**, so `bytes_stream()` here already yields plain JSON.
//!   Gunzipping it again fails with `invalid gzip header`, which is how this was found.
//! * On the desktop, reqwest without its `gzip` feature does not decode, so `combos.rs`
//!   gunzips explicitly and is correct.
//!
//! So the same code cannot assume either way. This sniffs the two-byte gzip magic (`1f 8b`)
//! off the first chunk and decides from the bytes — which is right on both platforms and does
//! not depend on a header, a feature flag or a file extension.
//!
//! **A note for the desktop while we are here:** the absent `gzip` feature is load-bearing for
//! the combo feed specifically, and for a different reason than `Cargo.toml` gives. The comment
//! there explains it in terms of Scryfall, which sends no `Content-Encoding` and so would be
//! unaffected either way. Spellbook does send one — so enabling that feature would break the
//! combo ingest with exactly the error above, while leaving Scryfall's working.

use futures_util::StreamExt as _;
use rusqlite::Connection;
use serde::de::IgnoredAny;
use std::io::Write as _;
use wasm_bindgen::prelude::*;

const VFS_NAME: &str = "opfs-sahpool";
const DB: &str = "probe4.db";
const FEED_URL: &str = "https://json.commanderspellbook.com/variants.json.gz";
const BATCH: usize = 1000;

fn now() -> f64 {
    js_sys::Date::now()
}

fn push(out: &mut String, s: &str) {
    out.push_str(s);
    out.push('\n');
}

// The same field set `combos.rs` keeps, so the parse costs what the real one costs.
#[derive(serde::Deserialize)]
struct RawVariant {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    bracket_tag: Option<String>,
    #[serde(default)]
    identity: Option<String>,
    #[serde(default)]
    popularity: Option<i64>,
    #[serde(default)]
    legalities: Option<RawLegalities>,
    #[serde(default)]
    uses: Vec<RawUse>,
    /// Counted, never held — exactly as the desktop does it.
    #[serde(default)]
    requires: Vec<IgnoredAny>,
}

#[derive(serde::Deserialize)]
struct RawLegalities {
    #[serde(default)]
    commander: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawUse {
    #[serde(default)]
    card: Option<RawCard>,
    #[serde(default)]
    quantity: Option<i64>,
    #[serde(default)]
    must_be_commander: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCard {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    oracle_id: Option<String>,
}

/// Frames complete top-level elements of the `variants` array out of a byte stream.
///
/// Depth counting has to respect JSON strings, or a `{` inside a card name desynchronises the
/// whole file — and a `"` preceded by a backslash is not a string terminator. Both are handled
/// rather than assumed away, because either one failing looks identical: a parse that runs to
/// the end of the file producing nothing.
#[derive(Default)]
struct Framer {
    entered: bool,
    depth: i32,
    in_string: bool,
    escaped: bool,
    start: Option<usize>,
}

impl Framer {
    /// Scans `buf` from `from`, calling `emit` with the byte range of each complete element.
    /// Returns how many bytes of `buf` are now consumed and may be discarded.
    fn scan(&mut self, buf: &[u8], from: usize, mut emit: impl FnMut(&[u8])) -> usize {
        let mut consumed = 0usize;
        let mut i = from;
        while i < buf.len() {
            let b = buf[i];
            if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if b == b'\\' {
                    self.escaped = true;
                } else if b == b'"' {
                    self.in_string = false;
                }
                i += 1;
                continue;
            }
            match b {
                b'"' => self.in_string = true,
                b'[' if !self.entered => {
                    // The first `[` after the top-level object opens is `variants`. The feed has
                    // no other array before it; if that ever changes this is where it breaks.
                    self.entered = true;
                }
                b'{' if self.entered => {
                    if self.depth == 0 {
                        self.start = Some(i);
                    }
                    self.depth += 1;
                }
                b'}' if self.entered => {
                    self.depth -= 1;
                    if self.depth == 0 {
                        if let Some(s) = self.start.take() {
                            emit(&buf[s..=i]);
                            consumed = i + 1;
                        }
                    }
                }
                _ => {}
            }
            i += 1;
        }
        consumed
    }

    /// Reset the per-element state after the caller drains a completed prefix.
    ///
    /// **Not cosmetic — this is the bug that made the first run find 63 elements in 610 MB.**
    /// The caller drains up to `consumed`, which is always the byte just past a closing `}`,
    /// then rescans what is left from index 0. Without this reset the framer is still carrying
    /// the depth and start offset of the partial element it had begun, so the rescan counts
    /// those same braces a second time, depth never returns to 0, and no further element is
    /// ever emitted. It fails silently: the buffer just grows to the size of the whole file.
    fn resync(&mut self) {
        self.depth = 0;
        self.start = None;
        self.in_string = false;
        self.escaped = false;
    }
}

async fn install_vfs() -> Result<(), String> {
    let cfg = sqlite_wasm_vfs::sahpool::OpfsSAHPoolCfgBuilder::new()
        .vfs_name(VFS_NAME)
        .directory("probe4")
        .initial_capacity(8)
        .build();
    sqlite_wasm_vfs::sahpool::install::<rusqlite::ffi::WasmOsCallback>(&cfg, true)
        .await
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

struct Combo {
    id: String,
    bracket_tag: String,
    identity: Option<String>,
    popularity: Option<i64>,
    template_count: i64,
    cards: Vec<(String, String, i64, bool)>,
}

/// The desktop's `reduce`, in outline: skip anything not OK, not Commander-legal, or with no id.
fn reduce(raw: RawVariant) -> Option<Combo> {
    let id = raw.id?;
    if raw.status.as_deref() != Some("OK") {
        return None;
    }
    if raw.legalities.and_then(|l| l.commander) != Some(true) {
        return None;
    }
    let mut cards = Vec::new();
    for u in raw.uses {
        if let Some(c) = u.card {
            if let (Some(name), Some(oracle)) = (c.name, c.oracle_id) {
                cards.push((
                    oracle,
                    name,
                    u.quantity.unwrap_or(1),
                    u.must_be_commander.unwrap_or(false),
                ));
            }
        }
    }
    if cards.is_empty() {
        return None;
    }
    Some(Combo {
        id,
        bracket_tag: raw.bracket_tag.unwrap_or_default(),
        identity: raw.identity,
        popularity: raw.popularity,
        template_count: raw.requires.len() as i64,
        cards,
    })
}

fn write_batch(conn: &Connection, batch: &mut Vec<Combo>) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| format!("{e:?}"))?;
    {
        let mut c1 = tx
            .prepare_cached("INSERT OR REPLACE INTO combos VALUES (?1,?2,?3,?4,?5,?6)")
            .map_err(|e| format!("{e:?}"))?;
        let mut c2 = tx
            .prepare_cached("INSERT OR REPLACE INTO combo_cards VALUES (?1,?2,?3,?4,?5)")
            .map_err(|e| format!("{e:?}"))?;
        for c in batch.iter() {
            c1.execute(rusqlite::params![
                c.id,
                c.bracket_tag,
                c.cards.len() as i64,
                c.template_count,
                c.identity,
                c.popularity,
            ])
            .map_err(|e| format!("{e:?}"))?;
            for (oracle, name, qty, cmd) in &c.cards {
                c2.execute(rusqlite::params![c.id, oracle, name, qty, cmd])
                    .map_err(|e| format!("{e:?}"))?;
            }
        }
    }
    tx.commit().map_err(|e| format!("{e:?}"))?;
    batch.clear();
    Ok(())
}

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
        "DROP TABLE IF EXISTS combos; DROP TABLE IF EXISTS combo_cards;
         CREATE TABLE combos (
            id TEXT PRIMARY KEY, bracket_tag TEXT NOT NULL, card_count INTEGER NOT NULL,
            template_count INTEGER NOT NULL, identity TEXT, popularity INTEGER
         );
         CREATE TABLE combo_cards (
            combo_id TEXT NOT NULL, oracle_id TEXT NOT NULL, name TEXT NOT NULL,
            quantity INTEGER NOT NULL, must_be_commander INTEGER NOT NULL,
            PRIMARY KEY (combo_id, oracle_id)
         );",
    ) {
        push(&mut out, &format!("FAIL schema/create  |  {e:?}"));
        return out;
    }
    push(&mut out, "PASS setup  |  OPFS pool + empty combos/combo_cards");

    let t_stream = now();
    let client = reqwest::Client::new();
    let resp = match client.get(FEED_URL).send().await {
        Ok(r) => r,
        Err(e) => {
            push(&mut out, &format!("FAIL feed/download  |  {e}"));
            return out;
        }
    };
    let mut stream = resp.bytes_stream();

    let mut dec = flate2::write::GzDecoder::new(Vec::<u8>::new());
    let mut tail: Vec<u8> = Vec::new();
    // Whether THIS response actually needs gunzipping, decided from the bytes rather than
    // from the URL or the Content-Type. See the note on the ingest function.
    let mut gzipped: Option<bool> = None;
    let mut scanned_to = 0usize;
    let mut framer = Framer::default();
    let mut batch: Vec<Combo> = Vec::with_capacity(BATCH);

    let mut down_bytes: u64 = 0;
    let mut raw_bytes: u64 = 0;
    let mut elements: u64 = 0;
    let mut kept: u64 = 0;
    let mut skipped: u64 = 0;
    let mut unparsable: u64 = 0;
    let mut t_parse = 0.0f64;
    let mut t_insert = 0.0f64;
    let mut peak_tail = 0usize;

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                push(
                    &mut out,
                    &format!("FAIL stream/chunk at {down_bytes} bytes  |  {e}"),
                );
                return out;
            }
        };
        down_bytes += chunk.len() as u64;
        if gzipped.is_none() && chunk.len() >= 2 {
            gzipped = Some(chunk[0] == 0x1f && chunk[1] == 0x8b);
        }
        if gzipped == Some(true) {
            if let Err(e) = dec.write_all(&chunk) {
                push(&mut out, &format!("FAIL gunzip/write  |  {e}"));
                return out;
            }
            let sink = dec.get_mut();
            raw_bytes += sink.len() as u64;
            tail.append(sink);
        } else {
            raw_bytes += chunk.len() as u64;
            tail.extend_from_slice(&chunk);
        }
        if tail.len() > peak_tail {
            peak_tail = tail.len();
        }

        let tp = now();
        let mut local: Vec<Combo> = Vec::new();
        let consumed = framer.scan(&tail, scanned_to, |elem| {
            elements += 1;
            match serde_json::from_slice::<RawVariant>(elem) {
                Ok(raw) => match reduce(raw) {
                    Some(c) => local.push(c),
                    None => skipped += 1,
                },
                Err(_) => unparsable += 1,
            }
        });
        t_parse += now() - tp;
        kept += local.len() as u64;
        batch.append(&mut local);

        if consumed > 0 {
            tail.drain(..consumed);
            framer.resync();
            scanned_to = 0;
        } else {
            scanned_to = tail.len();
        }

        if batch.len() >= BATCH {
            let ti = now();
            if let Err(e) = write_batch(&conn, &mut batch) {
                push(&mut out, &format!("FAIL insert at {kept} combos  |  {e}"));
                return out;
            }
            t_insert += now() - ti;
        }
    }

    if gzipped == Some(true) {
        if let Err(e) = dec.try_finish() {
            push(&mut out, &format!("FAIL gunzip/finish  |  {e}"));
            return out;
        }
    }
    if !batch.is_empty() {
        let ti = now();
        if let Err(e) = write_batch(&conn, &mut batch) {
            push(&mut out, &format!("FAIL insert/tail  |  {e}"));
            return out;
        }
        t_insert += now() - ti;
    }

    let secs = (now() - t_stream) / 1000.0;
    push(
        &mut out,
        &format!(
            "PASS feed/stream  |  {:.1} MB gz in, {:.1} MB json out, {} variants seen",
            down_bytes as f64 / 1048576.0,
            raw_bytes as f64 / 1048576.0,
            elements
        ),
    );
    push(
        &mut out,
        &format!(
            "PASS feed/reduce  |  {kept} kept, {skipped} skipped by the OK/commander rule, {unparsable} unparsable"
        ),
    );
    push(
        &mut out,
        &format!(
            "PASS feed/time  |  {:.1} s  (parse {:.1} s, insert {:.1} s, net+gunzip {:.1} s)",
            secs,
            t_parse / 1000.0,
            t_insert / 1000.0,
            secs - (t_parse + t_insert) / 1000.0
        ),
    );
    push(
        &mut out,
        &format!(
            "INFO memory/peak-frame-buffer  |  {:.2} MB — the whole point of framing by hand",
            peak_tail as f64 / 1048576.0
        ),
    );

    let t_idx = now();
    match conn.execute_batch("CREATE INDEX idx_combo_cards_oracle ON combo_cards(oracle_id);") {
        Ok(()) => push(
            &mut out,
            &format!("PASS feed/index  |  {:.1} s", (now() - t_idx) / 1000.0),
        ),
        Err(e) => push(&mut out, &format!("FAIL feed/index  |  {e:?}")),
    }

    let pages: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap_or(0);
    let psize: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap_or(0);
    push(
        &mut out,
        &format!(
            "PASS feed/total  |  {:.1} s wall clock, database {:.1} MB",
            (now() - t_all) / 1000.0,
            (pages * psize) as f64 / 1048576.0
        ),
    );

    let t = now();
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM combo_cards", [], |r| r.get(0))
        .unwrap_or(-1);
    push(
        &mut out,
        &format!("INFO query/combo_cards  |  {rows} rows in {:.1} ms", now() - t),
    );

    out
}
