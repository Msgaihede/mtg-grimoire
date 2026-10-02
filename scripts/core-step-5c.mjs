// The I/O step's third part: the three feeds and the image cache move to `crates/grimoire-core`.
//
//   node scripts/core-step-5c.mjs [--dry] [--no-fmt]
//
// Like part 5b's script, this is a move and a rewrite: each of these files reaches a network, a
// disk or a thread, and names a window to say what it is doing. The rewrite is a list of exact
// replacements — each has to match the number of times it says, or the run stops with nothing
// written.
//
// What it does, per file (`scripts/lib/rs-items.mjs` cuts each into its items):
//
// * `combos.rs`, `marketplace_feed.rs`, `tags/{mod,oracle,art,query,muted}.rs` →
//   `crates/grimoire-core/src/`. What stays of each is its `#[tauri::command]` wrappers, as
//   `src-tauri/src/<module>/mod.rs` under `pub use grimoire_core::<module>::*;`. A feed's client
//   becomes a `platform::http::Client`, its temp file goes through `platform::files`, its ingest
//   through `platform::spawn::blocking`, and its progress through the state's event sink.
// * `images.rs` → `crates/grimoire-core/src/images.rs`. What stays is the `mtgimg://` answer
//   (`serve`, `respond`, `fail`, `not_ready`), the two commands, and the upkeep *thread* — the
//   pass it runs is the core's.
// * What steps 4 and 5b left behind because it named one of those comes home:
//   `deck::bracket_reads`, `reset::clear_cache`, `sync::status`, and the tests beside them.
//
// Beside those it moves one fixture the tags' tests read (`tests/fixtures/art-tags-sample.jsonl`)
// and splits one `?raw` import in `src/lib/ipc.test.ts`, and it writes nothing else. `State`'s
// new field, both module maps and the desktop's `init_state` are edited by hand in the same
// commit: they are a handful of sites, not a move.
//
// Each section runs only where its file is still in `src-tauri`, so a tree where a file has
// moved skips that section. **It touches no git state**: every decision is made and every
// replacement checked before the first byte is written, and then it writes files and removes
// files. A rename is what git infers from the contents at commit time.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { inner, split } from "./lib/rs-items.mjs";

const ROOT = process.cwd();
const DESK = join(ROOT, "src-tauri/src");
const CORE = join(ROOT, "crates/grimoire-core/src");
const DRY = process.argv.includes("--dry");
const NO_FMT = process.argv.includes("--no-fmt");

const read = (path) => {
  const text = readFileSync(path, "utf8");
  if (text.includes("\r\n")) throw new Error(`${path} has CRLF line endings`);
  return text;
};
const out = new Map();
const removed = [];
const put = (path, text) => out.set(path, text);

/** `text` with `a` replaced by `b`, exactly `count` times. */
function swap(text, a, b, count = 1) {
  const found = text.split(a).length - 1;
  if (found !== count) {
    throw new Error(`expected ${count} of this, found ${found}:\n${a.slice(0, 200)}`);
  }
  return text.split(a).join(b);
}
const swaps = (text, pairs) => pairs.reduce((t, [a, b, n]) => swap(t, a, b, n ?? 1), text);

/** `text` with its comment lines blanked: what a "does the code still name this" check reads. */
const code = (text) => text.replace(/^\s*\/\/.*$/gm, "");

/** Stop if `text`'s code still matches any of `patterns` — a rewrite that was not made. */
function mustNotName(what, text, patterns) {
  const read = code(text);
  for (const re of patterns) {
    const at = re.exec(read);
    if (!at) continue;
    const line = read.slice(read.lastIndexOf("\n", at.index) + 1, read.indexOf("\n", at.index));
    throw new Error(`${what} still matches ${re} in code:\n${line}`);
  }
}

/** What no shipped line of a moved feed may still name. */
const DESKTOP_NAMES = [
  /\btauri\b/,
  /\bAppState\b/,
  /\bAppHandle\b/,
  /\breqwest\b/,
  /SystemTime|UNIX_EPOCH/,
  /std::time::Instant/,
  /crate::sync::lock_/,
  /crate::split\b/,
];
/** And what its shipped half may not, which a test may: a file, a thread, the runtime. */
const SHIPPED_ONLY = [/\btokio::/, /std::fs\b/, /std::thread\b/];

/**
 * Cut `file` (a `split`) into what moves and what stays.
 *
 * `stays` names top-level items; every one must be there. The `use` items and the test module
 * are neither — the caller writes each half's imports, and the tests are cut separately.
 */
function cut(what, file, stays) {
  const tests = file.items.find((it) => it.kind === "mod" && it.name === "tests");
  if (!tests) throw new Error(`${what} has no \`mod tests\``);
  for (const name of stays) {
    if (!file.items.some((it) => it.name === name))
      throw new Error(`${what} has no item \`${name}\``);
  }
  const stay = [];
  const move = [];
  // The imports at the head of the file are each half's to write. A `use` further down — a
  // re-export between two items — is part of the module and moves where it stands.
  let inBody = false;
  for (const it of file.items) {
    if (it === tests) continue;
    const declares = it.kind === "mod" && !it.text.includes("{");
    if (it.kind === "use" && !inBody && !/^\s*pub /m.test(code(it.text))) continue;
    if (it.kind !== "use" && !declares) inBody = true;
    (stays.has(it.name) ? stay : move).push(it);
  }
  return { tests, stay, move };
}

/** `stay` must be commands and nothing else. */
function commandsOnly(what, stay) {
  for (const it of stay) {
    if (!it.attrs.some((a) => a.includes("tauri::command")))
      throw new Error(`${what}: \`${it.name}\` is not a command`);
  }
}

/** The items of `list` joined, with the blank lines at the very top taken off. */
const joined = (list) =>
  list
    .map((it) => it.text)
    .join("")
    .replace(/^\n+/, "");

/** A test module's text with `test` added at its foot. */
function withTest(module, test) {
  const text = module.replace(/\n+$/, "\n");
  if (!text.endsWith("\n}\n")) throw new Error("a test module does not end where one should");
  return text.slice(0, -2) + "\n" + test.replace(/^\n+/, "").replace(/\n+$/, "\n") + "}\n";
}

/**
 * What a page hears of a feed's refresh, pinned: the event's name and the keys it reads. Each
 * feed's `emit` took a window until this step and was written out again over the event sink.
 */
const hearsTest = ({ scratch, call, expected }) => `
    /// **What the page hears**: the event's name, and the keys it reads — camelCase, nothing
    /// more. The payload leaves through the host's sink, which is what took a window's place.
    #[test]
    fn a_step_of_a_refresh_reaches_the_sink_as_the_event_the_page_listens_for() {
        let (state, heard, dir) = crate::state::fixtures::listening("${scratch}");

${call}

        assert_eq!(
            heard.taken(),
            vec![
${expected}
            ]
        );
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
`;

// ══════════════════════════════════════════════════════════════════════════════════════════
// combos.rs
// ══════════════════════════════════════════════════════════════════════════════════════════

const COMBO_COMMANDS = new Set([
  "combos_status",
  "combos_refresh",
  "combos_clear",
  "combos_for_cards",
  "combos_for_card",
]);

if (existsSync(join(DESK, "combos.rs"))) {
  const file = split(read(join(DESK, "combos.rs")));
  const { tests, stay, move } = cut("combos.rs", file, COMBO_COMMANDS);
  for (const it of stay) {
    if (!it.attrs.some((a) => a.includes("tauri::command")))
      throw new Error(`combos.rs: \`${it.name}\` is not a command`);
  }

  let core = joined(move);
  core = swaps(core, [
    // ── a sleep between batches
    [
      "fn stand_aside() {\n    std::thread::sleep(YIELD_BETWEEN_BATCHES);\n}",
      "fn stand_aside() {\n    crate::platform::pause(YIELD_BETWEEN_BATCHES);\n}",
    ],
    // ── the error a request fails with
    ["    Http(reqwest::Error),", "    Http(crate::platform::http::Error),"],
    // ── the file the ingest reads back
    [
      "    let mut handle = std::fs::File::open(gz_path)?;",
      "    let mut handle = crate::platform::files::open(gz_path)?;",
    ],
    // ── the client
    [
      `fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(crate::scryfall::USER_AGENT)
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .build()
            .unwrap_or_default()
    })
}`,
      `fn client() -> &'static http::Client {
    static CLIENT: OnceLock<http::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        http::Client::new(&http::Config {
            user_agent: crate::scryfall::USER_AGENT,
            connect_timeout: Some(CONNECT_TIMEOUT),
            read_timeout: Some(READ_TIMEOUT),
        })
    })
}`,
    ],
    // ── the download
    [
      `/// To a file and not into memory, for [\`crate::sync\`]'s reason: the parse wants a \`Read\` and
/// reqwest only offers an async stream, so the choice is a temp file or 27.5 MB of \`Vec<u8>\``,
      `/// To a file and not into memory, for [\`crate::sync\`]'s reason: the parse wants a \`Read\` and
/// a response is only ever an async stream, so the choice is a temp file or 27.5 MB of \`Vec<u8>\``,
    ],
    [
      `    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut req = client().get(url);`,
      `    let mut req = client().get(url);`,
    ],
    [
      `    let status = resp.status().as_u16();
    // The common case once a database has the file, and it costs zero bytes. Checked before the`,
      `    let status = resp.status();
    // The common case once a database has the file, and it costs zero bytes. Checked before the`,
    ],
    [
      `    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);`,
      `    let etag = resp.header("etag").map(str::to_owned);`,
    ],
    [
      `    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut file = tokio::fs::File::create(dest).await?;
    let mut done = 0u64;
    let mut last_emit = 0u64;
    let mut stream = resp.bytes_stream();
    progress(0, total);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(ComboError::Http)?;
        done += chunk.len() as u64;
        if done > max_bytes {
            // Closed before it is removed: Windows refuses to delete a file that is still open.
            drop(file);
            let _ = tokio::fs::remove_file(dest).await;
            return Err(ComboError::TooLarge);
        }`,
      `    if let Some(parent) = dest.parent() {
        aio::create_dir_all(parent).await?;
    }
    let mut file = aio::Writer::create(dest).await?;
    let mut done = 0u64;
    let mut last_emit = 0u64;
    let mut body = resp.into_body();
    progress(0, total);
    while let Some(chunk) = body.chunk().await {
        let chunk = chunk.map_err(ComboError::Http)?;
        done += chunk.len() as u64;
        if done > max_bytes {
            // Closed before it is removed: Windows refuses to delete a file that is still open.
            file.close();
            let _ = aio::remove(dest).await;
            return Err(ComboError::TooLarge);
        }`,
    ],
    // ── the state it is handed
    ["fn temp_path(state: &AppState) -> PathBuf {", "fn temp_path(state: &State) -> PathBuf {"],
    [
      `pub(crate) fn status_of(state: &AppState) -> ComboStatus {
    let conn = crate::sync::lock_db_read(state);`,
      `pub fn status_of(state: &State) -> ComboStatus {
    let conn = state.lock_db_read();`,
    ],
    [
      `fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}`,
      `fn unix_now() -> i64 {
    crate::platform::clock::now_secs()
}`,
    ],
    ["fn mark_checked(state: &Arc<AppState>) {", "fn mark_checked(state: &State) {"],
    // ── the refresh
    [
      `/// \`progress\` is called with \`(phase, done, total)\`; [\`combos_refresh\`] turns that into
/// [\`PROGRESS_EVENT\`]. Taken as a callback rather than an \`AppHandle\` for [\`crate::ingest\`]'s
/// reason — it is what lets the whole path be driven from a test.`,
      `/// \`progress\` is called with \`(phase, done, total)\`; a caller that has somebody to tell hands
/// it [\`emit\`], which says each as [\`PROGRESS_EVENT\`]. Taken as a callback for
/// [\`crate::ingest\`]'s reason — it is what lets the whole path be driven from a test.`,
    ],
    [
      `pub async fn refresh(
    state: &Arc<AppState>,
    force: bool,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<ComboStatus, String> {`,
      `pub async fn refresh(
    state: &Arc<State>,
    force: bool,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<ComboStatus, String> {`,
    ],
    [
      `    let (etag, checked_at, populated) = {
        let conn = crate::sync::lock_db_read(state);`,
      `    let (etag, checked_at, populated) = {
        let conn = state.lock_db_read();`,
    ],
    [
      `            // would only fail to decompress next time. (A size refusal has already removed it.)
            let _ = std::fs::remove_file(&gz);`,
      `            // would only fail to decompress next time. (A size refusal has already removed it.)
            let _ = crate::platform::files::remove(&gz);`,
    ],
    [
      `        // 639 MB of decompressed JSON and hundreds of thousands of inserts: a blocking thread,
        // never the async runtime, and never across an \`.await\` with a lock in hand.
        tauri::async_runtime::spawn_blocking(move || {
            ingest_gz(&state.db, &gz, etag.as_deref(), fetched_at, &mut |_, _| {})
        })
        .await
    };
    let _ = std::fs::remove_file(&gz);`,
      `        // 639 MB of decompressed JSON and hundreds of thousands of inserts: off the async
        // task where the host has somewhere to put it, and never across an \`.await\` with a
        // lock in hand.
        crate::platform::spawn::blocking(move || {
            ingest_gz(&state.db, &gz, etag.as_deref(), fetched_at, &mut |_, _| {})
        })
        .await
    };
    let _ = crate::platform::files::remove(&gz);`,
    ],
    ["fn note_unusable(state: &AppState) {", "fn note_unusable(state: &State) {"],
    // ── the launch
    [
      `pub async fn refresh_if_due(state: &Arc<AppState>, app: &tauri::AppHandle) {
    let due = {
        let conn = crate::sync::lock_db_read(state);
        due_at_launch(&conn, unix_now())
    };
    if !due {
        return;
    }
    let app = app.clone();
    if let Err(e) = refresh(state, false, &mut |phase, done, total| {
        emit(&app, phase, done, total)
    })
    .await`,
      `pub async fn refresh_if_due(state: &Arc<State>) {
    let due = {
        let conn = state.lock_db_read();
        due_at_launch(&conn, unix_now())
    };
    if !due {
        return;
    }
    if let Err(e) = refresh(state, false, &mut |phase, done, total| {
        emit(state, phase, done, total)
    })
    .await`,
    ],
    // ── the event
    [
      `/// Emit one progress event. Dropped if nobody is listening, which is Tauri's behaviour and is
/// why [\`combos_status\`] exists: the event is the fast path, the tables are what a reader can
/// still consult a minute later.
fn emit(app: &tauri::AppHandle, phase: &str, done: u64, total: u64) {
    debug_assert!(PHASES.contains(&phase), "unknown combo phase \`{phase}\`");
    let _ = app.emit(
        PROGRESS_EVENT,
        ComboProgress {
            phase: phase.to_owned(),
            done,
            total,
        },
    );
}`,
      `/// Say one step of a refresh, as [\`PROGRESS_EVENT\`], through the host's event sink
/// ([\`crate::events::EventSink\`]). Dropped if nobody is listening, which is why a status read
/// exists beside it: the event is the fast path, the tables are what a reader can still consult
/// a minute later.
pub fn emit(state: &State, phase: &str, done: u64, total: u64) {
    debug_assert!(PHASES.contains(&phase), "unknown combo phase \`{phase}\`");
    crate::events::emit(
        &*state.events,
        PROGRESS_EVENT,
        &ComboProgress {
            phase: phase.to_owned(),
            done,
            total,
        },
    );
}`,
    ],
  ]);

  // ── prose that named the desktop
  core = swaps(core, [
    [
      "/// [`combos_refresh`]'s `force` is the way past this for anyone who wants today's file.",
      "/// a forced refresh is the way past this for anyone who wants today's file.",
    ],
    [
      "/// Takes a `&Connection` and not an [`AppState`], so the rule can be asserted against\n/// [`crate::schema::memory_pair`] with no app handle — the split every other helper here uses.",
      "/// Takes a `&Connection` and not a [`State`], so the rule can be asserted against\n/// [`crate::schema::memory_pair`] with no state built — the split every other helper here uses.",
    ],
    [
      "/// second dataset here to be refused by. Module-level rather than a field on `AppState` because\n/// it is this module's concern alone.",
      "/// second dataset here to be refused by. Module-level rather than a field on the [`State`]\n/// because it is this module's concern alone.",
    ],
  ]);

  // ── the tests: all of them, one rewritten ───────────────────────────────────────────────
  let coreTests = swaps(tests.text, [
    [
      "    /// cargo test --manifest-path src-tauri/Cargo.toml -- --ignored combos::tests::live_ingest --nocapture",
      "    /// cargo test -p grimoire-core -- --ignored combos::tests::live_ingest --nocapture",
    ],
    [
      `        let started = std::time::Instant::now();
        let fetched = tauri::async_runtime::block_on(download_capped(`,
      `        let started = crate::platform::clock::Tick::now();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let fetched = runtime.block_on(download_capped(`,
    ],
    [
      `        // A **file** database rather than an in-memory one, because one of the figures this
        // test exists to take is what the feed costs a reader on disk.
        crate::split::convert(&dir).unwrap();
        let db_path = dir.join(crate::db::CORPUS_DB);
        let db = Mutex::new(crate::db::open_write(&dir).unwrap());
`,
      `        // A **file** database rather than an in-memory one, because one of the figures this
        // test exists to take is what the feed costs a reader on disk. Built at head, as a
        // fresh install's is.
        let db_path = dir.join(crate::db::CORPUS_DB);
        let db = Mutex::new(crate::db::open_write(&dir).unwrap());
        crate::schema::build_pair(&db.lock().unwrap());
`,
    ],
    [
      "        let parsing = std::time::Instant::now();",
      "        let parsing = crate::platform::clock::Tick::now();",
    ],
    [
      "        let matching = std::time::Instant::now();",
      "        let matching = crate::platform::clock::Tick::now();",
    ],
  ]);

  const header = swaps(file.header, []);
  const coreText =
    header +
    `use crate::platform::files::aio;
use crate::platform::http;
use crate::state::State;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

` +
    core.replace(/\n+$/, "\n") +
    withTest(
      coreTests,
      hearsTest({
        scratch: "combos-heard",
        call: `        emit(&state, "downloading", 3, 10);
        emit(&state, "done", 0, 0);`,
        expected: `                (
                    "combos:progress".to_owned(),
                    serde_json::json!({"phase": "downloading", "done": 3, "total": 10})
                ),
                (
                    "combos:progress".to_owned(),
                    serde_json::json!({"phase": "done", "done": 0, "total": 0})
                ),`,
      }),
    ) +
    file.tail;
  mustNotName("the core's combos.rs", coreText, DESKTOP_NAMES);
  mustNotName(
    "the shipped half of the core's combos.rs",
    coreText.slice(0, coreText.indexOf("\n#[cfg(test)]\nmod tests {")),
    SHIPPED_ONLY,
  );
  put(join(CORE, "combos.rs"), coreText);
  removed.push(join(DESK, "combos.rs"));

  // ── the desktop's half: five commands ───────────────────────────────────────────────────
  let desk = joined(stay);
  desk = swaps(desk, [
    [
      `    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    force: bool,
) -> Result<ComboStatus, String> {
    let state = state.inner().clone();
    refresh(&state, force, &mut |phase, done, total| {
        emit(&app, phase, done, total)
    })
    .await`,
      `    state: tauri::State<'_, Arc<AppState>>,
    force: bool,
) -> Result<ComboStatus, String> {
    let state = state.inner().clone();
    refresh(&state.core, force, &mut |phase, done, total| {
        emit(&state, phase, done, total)
    })
    .await`,
    ],
  ]);
  desk = swaps(desk, [
    [
      "/// [`clear_combos`] takes the rows out from under the stored ETag and [`conditional_etag`]\n/// therefore replays nothing.",
      "/// [`clear_combos`] takes the rows out from under the stored ETag and the core's\n/// `conditional_etag` therefore replays nothing.",
    ],
    [
      "/// between this and [`mark_checked`]. That one is a best-effort watermark nobody is waiting on;",
      "/// between this and the core's `mark_checked`. That one is a best-effort watermark nobody is waiting on;",
    ],
  ]);
  put(
    join(DESK, "combos/mod.rs"),
    `//! **Commander Spellbook's combos are \`grimoire-core\`'s, re-exported here beside their
//! commands.**
//!
//! The feed, the ingest, both match queries and the refresh are in
//! \`crates/grimoire-core/src/combos.rs\` since the extraction's I/O step; a path through this
//! module reaches that crate's item unless this file defines it. What it defines is the five
//! \`#[tauri::command]\` wrappers, each of which names this app's state and a thread to run on.
//!
//! A refresh takes no window: it says what it is doing through the state's event sink, which
//! this app forwards to every window.

pub use grimoire_core::combos::*;

use crate::sync::AppState;
use std::sync::Arc;

` + desk.replace(/\n+$/, "\n"),
  );
  console.log(`combos: ${stay.length} commands stay, ${move.length} items and every test move.`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// marketplace_feed.rs
// ══════════════════════════════════════════════════════════════════════════════════════════

const FEED_COMMANDS = new Set(["marketplace_feed_refresh", "marketplace_feed_status"]);

if (existsSync(join(DESK, "marketplace_feed.rs"))) {
  const file = split(read(join(DESK, "marketplace_feed.rs")));
  const { tests, stay, move } = cut("marketplace_feed.rs", file, FEED_COMMANDS);
  for (const it of stay) {
    if (!it.attrs.some((a) => a.includes("tauri::command")))
      throw new Error(`marketplace_feed.rs: \`${it.name}\` is not a command`);
  }

  let core = joined(move);
  core = swaps(core, [
    // ── the error a request fails with
    [
      "        #[source]\n        source: reqwest::Error,",
      "        #[source]\n        source: crate::platform::http::Error,",
    ],
    // ── the file the ingest reads back
    [
      "        let mut file = std::fs::File::open(path)?;",
      "        let mut file = crate::platform::files::open(path)?;",
    ],
    // ── the client
    [
      `fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(crate::scryfall::USER_AGENT)
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .build()
            .unwrap_or_default()
    })
}`,
      `fn client() -> &'static http::Client {
    static CLIENT: OnceLock<http::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        http::Client::new(&http::Config {
            user_agent: crate::scryfall::USER_AGENT,
            connect_timeout: Some(CONNECT_TIMEOUT),
            read_timeout: Some(READ_TIMEOUT),
        })
    })
}`,
    ],
    // ── the download
    [
      `/// To a file and not into memory, for [\`crate::sync\`]'s reason: the parse wants a \`Read\` and
/// reqwest only offers an async stream, so the choice is a temp file or 63.7 MiB of \`Vec<u8>\``,
      `/// To a file and not into memory, for [\`crate::sync\`]'s reason: the parse wants a \`Read\` and
/// a response is only ever an async stream, so the choice is a temp file or 63.7 MiB of \`Vec<u8>\``,
    ],
    [
      `    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let host = host_of(url);`,
      `    let host = host_of(url);`,
    ],
    [
      `        .map_err(|source| FeedError::Http { host, source })?;
    let status = resp.status().as_u16();`,
      `        .map_err(|source| FeedError::Http { host, source })?;
    let status = resp.status();`,
    ],
    [
      `    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut file = tokio::fs::File::create(dest).await?;
    let mut done = 0u64;
    let mut last_emit = 0u64;
    let mut stream = resp.bytes_stream();
    progress(0, total);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|source| FeedError::Http { host, source })?;`,
      `    if let Some(parent) = dest.parent() {
        aio::create_dir_all(parent).await?;
    }
    let mut file = aio::Writer::create(dest).await?;
    let mut done = 0u64;
    let mut last_emit = 0u64;
    let mut body = resp.into_body();
    progress(0, total);
    while let Some(chunk) = body.chunk().await {
        let chunk = chunk.map_err(|source| FeedError::Http { host, source })?;`,
    ],
    // ── the state it is handed
    [
      "fn temp_path(state: &AppState, provider: &dyn FeedProvider) -> PathBuf {",
      "fn temp_path(state: &State, provider: &dyn FeedProvider) -> PathBuf {",
    ],
    [
      `fn status_of(state: &AppState, provider: &dyn FeedProvider) -> FeedStatus {
    let conn = crate::sync::lock_db_read(state);`,
      `fn status_of(state: &State, provider: &dyn FeedProvider) -> FeedStatus {
    let conn = state.lock_db_read();`,
    ],
    [
      `fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}`,
      `fn unix_now() -> i64 {
    crate::platform::clock::now_secs()
}`,
    ],
    // ── the refresh: the provider's own address is handed in, which is the seam a test drives
    [
      `/// \`progress\` is called with \`(phase, done, total)\`; the command below turns that into the
/// [\`PROGRESS_EVENT\`]. Taken as a callback rather than an \`AppHandle\` for [\`crate::ingest\`]'s
/// reason — it is what lets the whole path be driven from a test.`,
      `/// \`progress\` is called with \`(phase, done, total)\`; a caller that has somebody to tell hands
/// it [\`emit\`], which says each as [\`PROGRESS_EVENT\`]. Taken as a callback for
/// [\`crate::ingest\`]'s reason — it is what lets the whole path be driven from a test.`,
    ],
    [
      `pub async fn refresh(
    state: &Arc<AppState>,
    marketplace: &str,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<FeedStatus, String> {`,
      `pub async fn refresh(
    state: &Arc<State>,
    marketplace: &str,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<FeedStatus, String> {`,
    ],
    [
      `    let Some(_guard) = RefreshGuard::claim(provider.marketplace()) else {`,
      `    refresh_from(state, provider, provider.url(), progress).await
}

/// [\`refresh\`] with the feed's address handed in, which is the seam its test drives: a
/// provider's own address is the live host.
async fn refresh_from(
    state: &Arc<State>,
    provider: &'static dyn FeedProvider,
    url: &'static str,
    progress: &mut (dyn FnMut(&str, u64, u64) + Send),
) -> Result<FeedStatus, String> {
    let Some(_guard) = RefreshGuard::claim(provider.marketplace()) else {`,
    ],
    [
      `    if let Err(e) = download(provider.url(), &path, &mut |done, total| {`,
      `    if let Err(e) = download(url, &path, &mut |done, total| {`,
    ],
    [
      `        // ranges) and a half-written body would only fail to parse next time.
        let _ = std::fs::remove_file(&path);`,
      `        // ranges) and a half-written body would only fail to parse next time.
        let _ = crate::platform::files::remove(&path);`,
    ],
    [
      `        // Seconds of JSON and ~100 000 inserts: a blocking thread, never the async runtime,
        // and never across an \`.await\` with a lock in hand.
        tauri::async_runtime::spawn_blocking(move || {
            ingest_file(&state.db, provider, &path, fetched_at)
        })
        .await
    };
    let _ = std::fs::remove_file(&path);`,
      `        // Seconds of JSON and ~100 000 inserts: off the async task where the host has
        // somewhere to put it, and never across an \`.await\` with a lock in hand.
        crate::platform::spawn::blocking(move || {
            ingest_file(&state.db, provider, &path, fetched_at)
        })
        .await
    };
    let _ = crate::platform::files::remove(&path);`,
    ],
    [
      `            // The second of the four things that run a full mirror pass (spec §5).
            // \`marketplace_prices\` maps to no surface on purpose — this refresh rewrites the
            // whole table, and a per-row mark would be ~100 000 hook fires — so the completed
            // refresh is what tells the mirror the \`Price\` column in every mirrored CSV has
            // moved. One line, at the one place this path succeeds.
            state.mirror.mark_all();`,
      `            // \`marketplace_prices\` is a corpus table and this refresh rewrote the whole of
            // it, which no observer was told row by row — on purpose, at ~100 000 hook fires.
            // So the completed refresh is what tells whoever renders from the corpus that it
            // moved: on the desktop, the plain-text mirror, whose \`Price\` column in every CSV
            // is now a refresh old (the second of the four things that run a full pass, its
            // spec §5). One line, at the one place this path succeeds.
            state.corpus_replaced();`,
    ],
    // ── the launch
    [
      `pub async fn refresh_selected_if_due(state: &Arc<AppState>, app: &tauri::AppHandle) {
    let (marketplace, fetched_at, resting) = {
        let conn = crate::sync::lock_db_read(state);`,
      `pub async fn refresh_selected_if_due(state: &Arc<State>) {
    let (marketplace, fetched_at, resting) = {
        let conn = state.lock_db_read();`,
    ],
    [
      `    let app = app.clone();
    let id = marketplace.clone();
    if let Err(e) = refresh(state, &marketplace, &mut |phase, done, total| {
        let _ = app.emit(
            PROGRESS_EVENT,
            FeedProgress {
                marketplace: id.clone(),
                phase: phase.to_owned(),
                done,
                total,
            },
        );
    })
    .await`,
      `    if let Err(e) = refresh(state, &marketplace, &mut |phase, done, total| {
        emit(state, &marketplace, phase, done, total)
    })
    .await`,
    ],
    // ── the event: one function where there were two closures
    [
      `/// Payload of [\`PROGRESS_EVENT\`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedProgress {
    pub marketplace: String,
    /// One of [\`FEED_PHASES\`].
    pub phase: String,
    pub done: u64,
    pub total: u64,
}`,
      `/// Payload of [\`PROGRESS_EVENT\`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedProgress {
    pub marketplace: String,
    /// One of [\`FEED_PHASES\`].
    pub phase: String,
    pub done: u64,
    pub total: u64,
}

/// Say one step of \`marketplace\`'s refresh, as [\`PROGRESS_EVENT\`], through the host's event
/// sink ([\`crate::events::EventSink\`]). Dropped if nobody is listening, which is why a status
/// read exists beside it: the event is the fast path, the table is the one a reader can still
/// consult a minute later.
pub fn emit(state: &State, marketplace: &str, phase: &str, done: u64, total: u64) {
    debug_assert!(FEED_PHASES.contains(&phase), "unknown feed phase \`{phase}\`");
    crate::events::emit(
        &*state.events,
        PROGRESS_EVENT,
        &FeedProgress {
            marketplace: marketplace.to_owned(),
            phase: phase.to_owned(),
            done,
            total,
        },
    );
}`,
    ],
  ]);

  // ── prose that named the desktop
  core = swaps(core, [
    [
      "/// A module-level registry rather than a field on `AppState`, because it is this module's\n/// concern alone and `AppState` is shared with everything else.",
      "/// A module-level registry rather than a field on the [`State`], because it is this\n/// module's concern alone and the state is shared with everything else.",
    ],
    [
      "/// Its one caller is [`refresh`]. The status *command* does not come through here at all - it\n/// maps [`PROVIDERS`] over [`read_status`] itself.",
      "/// Its one caller is [`refresh_from`]. A host's status command does not come through here at\n/// all - it maps [`PROVIDERS`] over [`read_status`] itself.",
    ],
  ]);

  // ── the tests: all of them, on a core state ─────────────────────────────────────────────
  const body = inner(tests);
  const fixture = body.items.find((it) => it.name === "test_state");
  if (!fixture) throw new Error("marketplace_feed.rs's tests have no `test_state`");
  let coreTests = swap(
    tests.text,
    fixture.text,
    `
    /// A host's [\`State\`] pointed at a scratch directory and a database of its own.
    fn test_state() -> (Arc<State>, PathBuf) {
        crate::state::fixtures::on_files("feed-state", "http://127.0.0.1:1")
    }
`,
  );
  coreTests = swaps(coreTests, [
    [
      "        let conn = crate::sync::lock_db_read(&state);\n        let status = read_status(&conn, &CardKingdom, 1_800_000_060);",
      "        let conn = state.lock_db_read();\n        let status = read_status(&conn, &CardKingdom, 1_800_000_060);",
    ],
    // The refresh end to end, which a window in its signature had kept out of reach.
    [
      `    /// The parse is genuinely streaming: a document far larger than any batch is read without`,
      `    /// **A whole refresh, through the seam that takes the feed's address**: the phases the
    /// caller hears in order, the prices in the table, the temp file gone, the status read
    /// back — and whoever renders from the corpus told **once**, where a refused download
    /// tells nobody.
    #[tokio::test]
    async fn a_whole_refresh_stores_the_prices_and_tells_the_observers_once() {
        use crate::hooks::WriteObserver;
        use std::sync::atomic::{AtomicUsize, Ordering};

        #[derive(Default)]
        struct Swaps(AtomicUsize);
        impl WriteObserver for Swaps {
            fn corpus_replaced(&self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        /// Card Kingdom's document under a name no other test claims: the refresh registry is
        /// process-wide and the tests run in parallel.
        struct OnMock;
        impl FeedProvider for OnMock {
            fn marketplace(&self) -> &'static str {
                "refresh-test"
            }
            fn url(&self) -> &'static str {
                "http://127.0.0.1:1/never-asked"
            }
            fn parse(&self, body: &mut dyn Read, feed: &mut Feed) -> Result<(), FeedError> {
                CardKingdom.parse(body, feed)
            }
        }
        static ON_MOCK: OnMock = OnMock;

        let server = httpmock::MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/pricelist");
                then.status(200).body(
                    r#"{"meta":{"created_at":"2026-08-11 21:07:02"},"data":[
                        {"id":1,"scryfall_id":"a","variation":"","is_foil":"false","price_retail":"0.35"}
                    ]}"#,
                );
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/gone");
                then.status(404);
            })
            .await;
        let good: &'static str = Box::leak(server.url("/pricelist").into_boxed_str());
        let gone: &'static str = Box::leak(server.url("/gone").into_boxed_str());

        let dir = crate::scratch::path("feed-refresh");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        crate::schema::build_pair(&conn);
        let read = crate::db::open_read(&dir).unwrap();
        let swaps = Arc::new(Swaps::default());
        let state = Arc::new(State::new(
            conn,
            Some(read),
            dir.clone(),
            crate::events::silent(),
            vec![swaps.clone()],
            crate::scryfall::Client::new("http://127.0.0.1:1".into()),
            crate::images::Cache::new(dir.join("images")),
        ));

        let mut phases: Vec<String> = Vec::new();
        let err = refresh_from(&state, &ON_MOCK, gone, &mut |phase, _, _| {
            phases.push(phase.to_owned())
        })
        .await
        .unwrap_err();
        assert!(err.contains("404"), "{err}");
        assert_eq!(phases.first().map(String::as_str), Some("downloading"));
        assert_eq!(phases.last().map(String::as_str), Some("error"));
        assert_eq!(
            swaps.0.load(Ordering::SeqCst),
            0,
            "nothing swapped, nobody told"
        );
        assert!(!is_refreshing("refresh-test"), "a failure gives the claim back");

        let mut phases: Vec<String> = Vec::new();
        let status = refresh_from(&state, &ON_MOCK, good, &mut |phase, _, _| {
            phases.push(phase.to_owned())
        })
        .await
        .unwrap();
        phases.dedup();
        assert_eq!(phases, ["downloading", "ingesting", "done"]);
        assert_eq!(status.marketplace, "refresh-test");
        assert_eq!(status.row_count, Some(1));
        assert_eq!(
            stored_prices(&state.db, "refresh-test"),
            vec![("a".to_owned(), "nonfoil".to_owned(), 0.35)]
        );
        assert!(
            !temp_path(&state, &ON_MOCK).exists(),
            "the download is not kept"
        );
        assert_eq!(swaps.0.load(Ordering::SeqCst), 1);
        assert!(!is_refreshing("refresh-test"), "and so does a success");

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The parse is genuinely streaming: a document far larger than any batch is read without`,
    ],
  ]);

  const coreText =
    file.header +
    `use crate::platform::files::aio;
use crate::platform::http;
use crate::state::State;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::{DeserializeOwned, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::marker::PhantomData;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

` +
    core.replace(/\n+$/, "\n") +
    withTest(
      coreTests,
      hearsTest({
        scratch: "feed-heard",
        call: `        emit(&state, "manapool", "ingesting", 0, 0);`,
        expected: `                (
                    "marketplace:progress".to_owned(),
                    serde_json::json!({
                        "marketplace": "manapool",
                        "phase": "ingesting",
                        "done": 0,
                        "total": 0
                    })
                ),`,
      }),
    ) +
    file.tail;
  mustNotName("the core's marketplace_feed.rs", coreText, [...DESKTOP_NAMES, /\bmirror\b/]);
  mustNotName(
    "the shipped half of the core's marketplace_feed.rs",
    coreText.slice(0, coreText.indexOf("\n#[cfg(test)]\nmod tests {")),
    SHIPPED_ONLY,
  );
  put(join(CORE, "marketplace_feed.rs"), coreText);
  removed.push(join(DESK, "marketplace_feed.rs"));

  // ── the desktop's half: two commands ────────────────────────────────────────────────────
  let desk = joined(stay);
  desk = swaps(desk, [
    [
      `    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    marketplace: String,
) -> Result<FeedStatus, String> {
    let state = state.inner().clone();
    let id = marketplace.clone();
    refresh(&state, &marketplace, &mut |phase, done, total| {
        debug_assert!(FEED_PHASES.contains(&phase), "unknown feed phase \`{phase}\`");
        // Dropped if nobody is listening, which is Tauri's behaviour and is why
        // \`marketplace_feed_status\` exists: the event is the fast path, the table is the one
        // a reader can still consult a minute later.
        let _ = app.emit(
            PROGRESS_EVENT,
            FeedProgress {
                marketplace: id.clone(),
                phase: phase.to_owned(),
                done,
                total,
            },
        );
    })
    .await`,
      `    state: tauri::State<'_, Arc<AppState>>,
    marketplace: String,
) -> Result<FeedStatus, String> {
    let state = state.inner().clone();
    refresh(&state.core, &marketplace, &mut |phase, done, total| {
        emit(&state, &marketplace, phase, done, total)
    })
    .await`,
    ],
    // The feed's own clock is private to it; this is the one it reads.
    [
      "        let now = unix_now();\n        PROVIDERS",
      "        let now = grimoire_core::platform::clock::now_secs();\n        PROVIDERS",
    ],
  ]);
  put(
    join(DESK, "marketplace_feed/mod.rs"),
    `//! **The price feeds are \`grimoire-core\`'s, re-exported here beside their two commands.**
//!
//! Both providers, the parse, the store and the refresh are in
//! \`crates/grimoire-core/src/marketplace_feed.rs\` since the extraction's I/O step; a path
//! through this module reaches that crate's item unless this file defines it. What it defines
//! is the two \`#[tauri::command]\` wrappers.
//!
//! A refresh takes no window and names no mirror: it says what it is doing through the state's
//! event sink, and a finished one tells the state's observers the corpus moved — which is how
//! this app's plain-text mirror hears that every \`Price\` it wrote is a refresh old.

pub use grimoire_core::marketplace_feed::*;

use crate::sync::AppState;
use std::sync::Arc;

` + desk.replace(/\n+$/, "\n"),
  );
  console.log(
    `marketplace_feed: ${stay.length} commands stay, ${move.length} items and every test move.`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// tags/
// ══════════════════════════════════════════════════════════════════════════════════════════

/** A database on files, built at head where `split::convert` built it. */
const SPLIT_TO_PAIR = [
  `        crate::split::convert(&dir).unwrap();
        let db = Mutex::new(crate::db::open_write(&dir).unwrap());
`,
  `        let db = Mutex::new(crate::db::open_write(&dir).unwrap());
        crate::schema::build_pair(&db.lock().unwrap());
`,
];

/** A tag module whose commands stay: `name`, its commands, its imports and its rewrites. */
function moveTagFile({ name, commands, coreUses, coreSwaps, testSwaps, deskDoc, deskSwaps }) {
  const src = join(DESK, `tags/${name}.rs`);
  const file = split(read(src));
  const { tests, stay, move } = cut(`tags/${name}.rs`, file, new Set(commands));
  commandsOnly(`tags/${name}.rs`, stay);

  const coreText =
    file.header +
    coreUses +
    "\n" +
    swaps(joined(move), coreSwaps).replace(/\n+$/, "\n") +
    swaps(tests.text, testSwaps).replace(/\n+$/, "\n") +
    file.tail;
  mustNotName(`the core's tags/${name}.rs`, coreText, [...DESKTOP_NAMES, /\bmirror\b/]);
  mustNotName(
    `the shipped half of the core's tags/${name}.rs`,
    coreText.slice(0, coreText.indexOf("\n#[cfg(test)]\nmod tests {")),
    SHIPPED_ONLY,
  );
  put(join(CORE, `tags/${name}.rs`), coreText);
  removed.push(src);
  put(
    join(DESK, `tags/${name}/mod.rs`),
    deskDoc +
      `
pub use grimoire_core::tags::${name}::*;

use crate::sync::AppState;
use std::sync::Arc;

` +
      swaps(joined(stay), deskSwaps).replace(/\n+$/, "\n"),
  );
  console.log(`tags/${name}: ${stay.length} commands stay, ${move.length} items move.`);
}

/** A binding's refresh command, with the window taken out of it. */
const tagRefreshCommand = (ds, status) => [
  `    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    force: bool,
) -> Result<${status}, String> {
    let state = state.inner().clone();
    super::refresh(&${ds}, &state, force, &mut |phase, done, total| {
        super::emit(&${ds}, &app, phase, done, total)
    })
    .await`,
  `    state: tauri::State<'_, Arc<AppState>>,
    force: bool,
) -> Result<${status}, String> {
    let state = state.inner().clone();
    super::refresh(&${ds}, &state.core, force, &mut |phase, done, total| {
        super::emit(&${ds}, &state, phase, done, total)
    })
    .await`,
];
/** A binding's launch refresh, likewise. */
const tagRefreshIfDue = (ds) => [
  `pub async fn refresh_if_due(state: &Arc<AppState>, app: &tauri::AppHandle) {
    super::refresh_if_due(&${ds}, state, app).await
}`,
  `pub async fn refresh_if_due(state: &Arc<State>) {
    super::refresh_if_due(&${ds}, state).await
}`,
];

if (existsSync(join(DESK, "tags/oracle.rs"))) {
  // ── mod.rs: the engine, whole ───────────────────────────────────────────────────────────
  const file = split(read(join(DESK, "tags/mod.rs")));
  const { tests, stay, move } = cut("tags/mod.rs", file, new Set());
  if (stay.length) throw new Error("tags/mod.rs: nothing stays");

  let core = joined(move);
  core = swaps(core, [
    [
      "fn stand_aside() {\n    std::thread::sleep(YIELD_BETWEEN_BATCHES);\n}",
      "fn stand_aside() {\n    crate::platform::pause(YIELD_BETWEEN_BATCHES);\n}",
    ],
    [
      "    let mut file = std::fs::File::open(gz_path)?;\n    let mut sink = StreamTags::begin(ds, db)?;",
      "    let mut file = crate::platform::files::open(gz_path)?;\n    let mut sink = StreamTags::begin(ds, db)?;",
    ],
    [
      `pub(crate) fn status_of(ds: &Dataset, state: &AppState) -> TagStatus {
    let conn = crate::sync::lock_db_read(state);`,
      `pub fn status_of(ds: &Dataset, state: &State) -> TagStatus {
    let conn = state.lock_db_read();`,
    ],
    [
      `fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}`,
      `fn unix_now() -> i64 {
    crate::platform::clock::now_secs()
}`,
    ],
    [
      "fn temp_path(ds: &Dataset, state: &AppState) -> PathBuf {",
      "fn temp_path(ds: &Dataset, state: &State) -> PathBuf {",
    ],
    [
      "fn mark_checked(ds: &Dataset, state: &Arc<AppState>, etag: Option<Option<&str>>) {",
      "fn mark_checked(ds: &Dataset, state: &State, etag: Option<Option<&str>>) {",
    ],
    [
      `/// \`progress\` is called with \`(phase, done, total)\`; a binding's command turns that into its
/// [\`Dataset::progress_event\`]. Taken as a callback rather than an \`AppHandle\` for
/// [\`crate::ingest\`]'s reason — it is what lets the whole path be driven from a test.`,
      `/// \`progress\` is called with \`(phase, done, total)\`; a caller that has somebody to tell hands
/// it [\`emit\`], which says each as the binding's [\`Dataset::progress_event\`]. Taken as a
/// callback for [\`crate::ingest\`]'s reason — it is what lets the whole path be driven from a
/// test.`,
    ],
    [
      "    ds: &'static Dataset,\n    state: &Arc<AppState>,\n    force: bool,",
      "    ds: &'static Dataset,\n    state: &Arc<State>,\n    force: bool,",
      2,
    ],
    [
      "        let conn = crate::sync::lock_db_read(state);\n        let meta = read_meta(ds, &conn);",
      "        let conn = state.lock_db_read();\n        let meta = read_meta(ds, &conn);",
    ],
    [
      "        if let Err(e) = std::fs::create_dir_all(parent) {",
      "        if let Err(e) = crate::platform::files::create_dir_all(parent) {",
    ],
    [
      `        // Seconds of gzip and hundreds of thousands of inserts: a blocking thread, never the
        // async runtime, and never across an \`.await\` with a lock in hand.
        tauri::async_runtime::spawn_blocking(move || {`,
      `        // Seconds of gzip and hundreds of thousands of inserts: off the async task where the
        // host has somewhere to put it, and never across an \`.await\` with a lock in hand.
        crate::platform::spawn::blocking(move || {`,
    ],
    [
      `pub async fn refresh_if_due(ds: &'static Dataset, state: &Arc<AppState>, app: &tauri::AppHandle) {
    if !due_at_launch(ds, state, unix_now()) {
        return;
    }
    let app = app.clone();
    if let Err(e) = refresh(ds, state, false, &mut |phase, done, total| {
        emit(ds, &app, phase, done, total)
    })`,
      `pub async fn refresh_if_due(ds: &'static Dataset, state: &Arc<State>) {
    if !due_at_launch(ds, state, unix_now()) {
        return;
    }
    if let Err(e) = refresh(ds, state, false, &mut |phase, done, total| {
        emit(ds, state, phase, done, total)
    })`,
    ],
    [
      `fn due_at_launch(ds: &Dataset, state: &AppState, now: i64) -> bool {
    let conn = crate::sync::lock_db_read(state);`,
      `fn due_at_launch(ds: &Dataset, state: &State, now: i64) -> bool {
    let conn = state.lock_db_read();`,
    ],
    [
      `/// Emit one progress event. Dropped if nobody is listening, which is Tauri's behaviour and is
/// why each binding also has a status command: the event is the fast path, the watermark table
/// is the one a reader can still consult a minute later.
fn emit(ds: &Dataset, app: &tauri::AppHandle, phase: &str, done: u64, total: u64) {
    debug_assert!(
        PHASES.contains(&phase),
        "unknown {} phase \`{phase}\`",
        ds.bulk_name
    );
    let _ = app.emit(
        ds.progress_event,
        TagProgress {
            phase: phase.to_owned(),
            done,
            total,
        },
    );
}`,
      `/// Say one step of \`ds\`'s refresh, as its [\`Dataset::progress_event\`], through the host's
/// event sink ([\`crate::events::EventSink\`]). Dropped if nobody is listening, which is why each
/// binding also has a status read: the event is the fast path, the watermark table is the one
/// a reader can still consult a minute later.
pub fn emit(ds: &Dataset, state: &State, phase: &str, done: u64, total: u64) {
    debug_assert!(
        PHASES.contains(&phase),
        "unknown {} phase \`{phase}\`",
        ds.bulk_name
    );
    crate::events::emit(
        &*state.events,
        ds.progress_event,
        &TagProgress {
            phase: phase.to_owned(),
            done,
            total,
        },
    );
}`,
    ],
  ]);

  // ── prose that named the desktop
  core = swaps(core, [
    [
      "/// one happened to be running, and the two share nothing but a rate limiter. Module-level\n/// rather than a field on `AppState` because it is this module's concern alone.",
      "/// one happened to be running, and the two share nothing but a rate limiter. Module-level\n/// rather than a field on the [`State`] because it is this module's concern alone.",
    ],
    [
      "    /// One line of `src-tauri/tests/fixtures/{name}` per element, ready for [`gz_fixture`].",
      "    /// One line of this crate's `tests/fixtures/{name}` per element, ready for [`gz_fixture`].",
    ],
  ]);

  const coreTests = swaps(tests.text, [
    [
      "        use std::time::{Duration, Instant};\n",
      "        use crate::platform::clock::Tick;\n        use std::time::Duration;\n",
    ],
    SPLIT_TO_PAIR,
    [
      "            let overlap_began = Instant::now();",
      "            let overlap_began = Tick::now();",
    ],
    ["                let asked = Instant::now();", "                let asked = Tick::now();"],
  ]);

  const coreText =
    file.header +
    `use crate::state::State;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

` +
    core.replace(/\n+$/, "\n") +
    withTest(
      coreTests,
      hearsTest({
        scratch: "tags-heard",
        call: `        emit(&oracle::ORACLE, &state, "downloading", 5, 9);
        emit(&art::ART, &state, "ingesting", 0, 0);`,
        expected: `                (
                    "oracle-tags:progress".to_owned(),
                    serde_json::json!({"phase": "downloading", "done": 5, "total": 9})
                ),
                (
                    "art-tags:progress".to_owned(),
                    serde_json::json!({"phase": "ingesting", "done": 0, "total": 0})
                ),`,
      }),
    ) +
    file.tail;
  mustNotName("the core's tags/mod.rs", coreText, [...DESKTOP_NAMES, /\bmirror\b/]);
  mustNotName(
    "the shipped half of the core's tags/mod.rs",
    coreText.slice(0, coreText.indexOf("\n#[cfg(test)]\npub(crate) mod testing {")),
    SHIPPED_ONLY,
  );
  put(join(CORE, "tags/mod.rs"), coreText);
  // The same path as the file it replaces: `tags/mod.rs` was already a folder's.
  put(
    join(DESK, "tags/mod.rs"),
    `//! **Scryfall's two Tagger taxonomies are \`grimoire-core\`'s, re-exported here beside their
//! commands.**
//!
//! The engine — the fetch, the parse, the graph walk, the staged write and the swap — and both
//! bindings, the search and the mute list are in \`crates/grimoire-core/src/tags/\` since the
//! extraction's I/O step. A path through this module reaches that crate's item unless a file
//! here defines it, and what the four files here define is the twelve \`#[tauri::command]\`
//! wrappers: each of them is the core's module of its name, and the commands below it.
//!
//! A refresh takes no window: it says what it is doing through the state's event sink, which
//! this app forwards to every window.

pub use grimoire_core::tags::*;

pub mod art;
pub mod muted;
pub mod oracle;
pub mod query;
`,
  );
  // The art binding's tests read a sample of the real file, by a path under the crate that
  // compiles them. Bytes, not text: it is a fixture and nothing here reads it.
  const sample = "tests/fixtures/art-tags-sample.jsonl";
  put(join(ROOT, "crates/grimoire-core", sample), readFileSync(join(ROOT, "src-tauri", sample)));
  removed.push(join(ROOT, "src-tauri", sample));
  console.log(`tags/mod: ${move.length} items and every test move, and the art sample.`);

  // ── oracle.rs ───────────────────────────────────────────────────────────────────────────
  {
    const src = read(join(DESK, "tags/oracle.rs"));
    const body = inner(split(src).items.find((it) => it.kind === "mod" && it.name === "tests"));
    const fixture = body.items.find((it) => it.name === "test_state");
    if (!fixture) throw new Error("tags/oracle.rs's tests have no `test_state`");
    moveTagFile({
      name: "oracle",
      commands: [
        "oracle_tags_refresh",
        "oracle_tags_status",
        "oracle_tags_for_cards",
        "oracle_tags_for_printings",
      ],
      coreUses: `use super::{read_tags_keyed, Dataset, TagStatus};
use crate::state::State;
use rusqlite::Connection;
use serde::Serialize;
use std::sync::Arc;
`,
      coreSwaps: [
        tagRefreshIfDue("ORACLE"),
        [
          "/// [`oracle_tags_refresh`]'s `force` is the way past this for anyone who wants today's file.",
          "/// a forced refresh is the way past this for anyone who wants today's file.",
        ],
      ],
      testSwaps: [
        SPLIT_TO_PAIR,
        [
          fixture.text,
          `
    /// A host's [\`State\`] pointed at a scratch directory, a database of its own, and a Scryfall
    /// that is really a mock server — which is what lets the whole refresh be driven here.
    fn test_state(base_url: String) -> (Arc<State>, std::path::PathBuf) {
        crate::state::fixtures::on_files("tags-state", &base_url)
    }
`,
        ],
      ],
      deskDoc: `//! **Oracle Tags are \`grimoire-core\`'s, re-exported here beside their four commands.**
//!
//! The binding — the \`Dataset\`, the two reads a deck add is categorised by, the launch's
//! refresh — is in \`crates/grimoire-core/src/tags/oracle.rs\`.
`,
      deskSwaps: [tagRefreshCommand("ORACLE", "OracleTagStatus")],
    });
  }

  // ── art.rs ──────────────────────────────────────────────────────────────────────────────
  moveTagFile({
    name: "art",
    commands: ["art_tags_refresh", "art_tags_status"],
    coreUses: `use super::{Dataset, TagStatus};
use crate::state::State;
use std::sync::Arc;
`,
    coreSwaps: [
      tagRefreshIfDue("ART"),
      [
        "/// [`art_tags_refresh`]'s `force` is the way past this for anyone who wants today's file.",
        "/// a forced refresh is the way past this for anyone who wants today's file.",
      ],
    ],
    testSwaps: [
      [
        "    /// `src-tauri/tests/fixtures/art-tags-sample.jsonl`, gzipped the way the bulk origin",
        "    /// This crate's `tests/fixtures/art-tags-sample.jsonl`, gzipped the way the bulk origin",
      ],
    ],
    deskDoc: `//! **Art Tags are \`grimoire-core\`'s, re-exported here beside their two commands.**
//!
//! The binding — the \`Dataset\` and the launch's refresh — is in
//! \`crates/grimoire-core/src/tags/art.rs\`.
`,
    deskSwaps: [tagRefreshCommand("ART", "ArtTagStatus")],
  });

  // ── query.rs ────────────────────────────────────────────────────────────────────────────
  moveTagFile({
    name: "query",
    commands: ["tag_search", "tag_children", "tag_resolve"],
    coreUses: `use super::{normalize, Dataset};
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
`,
    coreSwaps: [],
    testSwaps: [],
    deskDoc: `//! **The tag search is \`grimoire-core\`'s, re-exported here beside its three commands.**
//!
//! \`run_tag_search\`, \`run_tag_children\` and \`run_tag_resolve\` are in
//! \`crates/grimoire-core/src/tags/query.rs\`.
`,
    deskSwaps: [],
  });

  // ── muted.rs ────────────────────────────────────────────────────────────────────────────
  moveTagFile({
    name: "muted",
    commands: ["tag_mute", "tag_unmute", "tags_muted"],
    coreUses: `use rusqlite::{params, Connection};
use serde::Serialize;
`,
    coreSwaps: [],
    testSwaps: [],
    deskDoc: `//! **The mute list is \`grimoire-core\`'s, re-exported here beside its three commands.**
//!
//! \`mute\`, \`unmute\` and \`list\` are in \`crates/grimoire-core/src/tags/muted.rs\`.
`,
    // The engine's own clock is private to it; this is the one it reads.
    deskSwaps: [["super::unix_now()", "grimoire_core::platform::clock::now_secs()"]],
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// images.rs
// ══════════════════════════════════════════════════════════════════════════════════════════

/** What stays: the `mtgimg://` answer, the two commands, and the thread the upkeep runs on. */
const IMAGE_STAYS = new Set([
  "IMAGE_MAX_AGE",
  "respond",
  "fail",
  "not_ready",
  "serve",
  "prefetch_images",
  "prewarm_collection",
  "spawn_upkeep",
]);
/** One that is neither: `platform::files::listing` answers a missing folder itself. */
const IMAGE_GONE = "read_dir_if_present";
/** Tests that stay with the answer they assert, and the helper they share. */
const IMAGE_TESTS_STAY = new Set([
  "header",
  "a_served_image_is_a_200_the_webview_may_cache_for_a_day",
  "a_placeholder_is_a_200_the_webview_may_not_keep",
  "the_shipped_csp_is_untouched",
  "an_unknown_card_is_an_uncacheable_404",
  "a_rate_limit_is_a_503_carrying_the_wait_the_fetcher_will_honour",
  "every_other_failure_is_a_502_that_says_what_broke",
  "a_request_before_the_app_has_its_state_is_a_503_worth_retrying_at_once",
]);

if (existsSync(join(DESK, "images.rs"))) {
  const file = split(read(join(DESK, "images.rs")));
  const { tests, stay, move } = cut("images.rs", file, IMAGE_STAYS);
  const upkeep = stay.find((it) => it.name === "spawn_upkeep");
  const gone = move.find((it) => it.name === IMAGE_GONE);
  if (!gone) throw new Error(`images.rs has no \`${IMAGE_GONE}\``);

  let core = joined(move.filter((it) => it !== gone));
  // Two helpers `sync` only ever forwarded to `db`, which is where the cache reaches them now.
  core = core.split("crate::sync::lock_plain(").join("crate::db::lock_plain(");
  core = core.split("crate::sync::lock_conn(").join("crate::db::lock_blocking(");
  core = swaps(core, [
    // ── the cache's own concurrency: permits, a deadline, a lock per key
    ["    permits: tokio::sync::Semaphore,", "    permits: Semaphore,"],
    [
      `    /// An instant in the past — the gate open — for the whole of a normal session: since the
    /// pacing interval went, this carries a penalty and nothing else.
    gate: tokio::sync::Mutex<tokio::time::Instant>,`,
      `    /// \`None\` — the gate open — for the whole of a normal session: since the pacing interval
    /// went, this carries a penalty and nothing else. A penalty is the moment it was charged
    /// and how long it runs: a [\`Tick\`] can be asked how long ago it was and cannot be moved
    /// forward, so the deadline is the pair.
    gate: Mutex<Option<(Tick, Duration)>>,`,
    ],
    [
      "    /// A `Mutex<HashMap<ImageKey, Arc<tokio::sync::Mutex<()>>>>` rather than the shared",
      "    /// A `Mutex<HashMap<ImageKey, Arc<Lock>>>` rather than the shared",
    ],
    [
      "    inflight: Mutex<HashMap<ImageKey, Arc<tokio::sync::Mutex<()>>>>,",
      "    inflight: Mutex<HashMap<ImageKey, Arc<Lock>>>,",
    ],
    [
      `            permits: tokio::sync::Semaphore::new(MAX_CONCURRENT_FETCHES),
            gate: tokio::sync::Mutex::new(tokio::time::Instant::now()),`,
      `            permits: Semaphore::new(MAX_CONCURRENT_FETCHES),
            gate: Mutex::new(None),`,
    ],
    [
      "    fn key_lock(&self, key: &ImageKey) -> Arc<tokio::sync::Mutex<()>> {",
      "    fn key_lock(&self, key: &ImageKey) -> Arc<Lock> {",
    ],
    [
      "                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),",
      "                .or_insert_with(|| Arc::new(Lock::new())),",
    ],
    [
      `        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|e| ImageError::Fetch(e.to_string()))?;
        {
            let next = self.gate.lock().await;
            let remaining = next.saturating_duration_since(tokio::time::Instant::now());
            if !remaining.is_zero() {
                return Err(ImageError::RateLimited {
                    retry_after_secs: secs_rounded_up(remaining),
                });
            }
        }
`,
      `        let _permit = self.permits.acquire().await;
        if let Some(remaining) = self.lockout_remaining() {
            return Err(ImageError::RateLimited {
                retry_after_secs: secs_rounded_up(remaining),
            });
        }
`,
    ],
    ["                self.penalise(penalty).await;", "                self.penalise(penalty);"],
    [
      `    async fn penalise(&self, penalty: Duration) {
        let mut next = self.gate.lock().await;
        *next = (*next).max(tokio::time::Instant::now() + penalty);
    }`,
      `    fn penalise(&self, penalty: Duration) {
        let mut gate = crate::db::lock_plain(&self.gate);
        let left = gate.map_or(Duration::ZERO, |(charged, runs)| {
            runs.saturating_sub(charged.elapsed())
        });
        if penalty > left {
            *gate = Some((Tick::now(), penalty));
        }
    }

    /// What is left of a rate limit's lockout, or \`None\` while the gate is open.
    fn lockout_remaining(&self) -> Option<Duration> {
        let (charged, runs) = (*crate::db::lock_plain(&self.gate))?;
        let left = runs.saturating_sub(charged.elapsed());
        (!left.is_zero()).then_some(left)
    }`,
    ],
    // ── the files
    [
      "            if let Ok(bytes) = tokio::fs::read(&path).await {",
      "            if let Ok(bytes) = aio::read(&path).await {",
    ],
    [
      "            if let Ok(bytes) = tokio::fs::read(path).await {",
      "            if let Ok(bytes) = aio::read(path).await {",
    ],
    [
      `    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = path.with_extension(format!("{}.tmp", WRITE_SEQ.fetch_add(1, Ordering::Relaxed)));
    tokio::fs::write(&tmp, bytes).await?;
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        // Nothing will ever look for this name again, so a failed swap must not leave it.
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }`,
      `    if let Some(parent) = path.parent() {
        aio::create_dir_all(parent).await?;
    }
    let tmp = path.with_extension(format!("{}.tmp", WRITE_SEQ.fetch_add(1, Ordering::Relaxed)));
    aio::write(&tmp, bytes).await?;
    if let Err(e) = aio::rename(&tmp, path).await {
        // Nothing will ever look for this name again, so a failed swap must not leave it.
        let _ = aio::remove(&tmp).await;
        return Err(e);
    }`,
    ],
    // ── the used-stamp: a moment that can be written to a file
    [
      "    pub fn flush_touches(&self, now: SystemTime) -> usize {",
      "    pub fn flush_touches(&self, now: Wall) -> usize {",
    ],
    ["    used: Option<SystemTime>,", "    used: Option<Wall>,"],
    [
      `/// \`write(true)\` and **never** \`create(true)\`: a key whose file is gone must stay gone. See
/// [\`Cache::flush_touches\`] for what an empty file there would cost.
fn stamp_used(path: &Path, when: SystemTime) -> std::io::Result<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)?
        .set_modified(when)
}`,
      `/// **It never creates the file**, which is [\`files::set_modified\`]'s own promise: a key whose
/// file is gone must stay gone. See [\`Cache::flush_touches\`] for what an empty file there
/// would cost.
fn stamp_used(path: &Path, when: Wall) -> std::io::Result<()> {
    files::set_modified(path, when)
}`,
    ],
    // ── the walk, over a listing
    [
      `/// **On Windows it is one directory listing per shard and no call per file**: \`DirEntry\`'s
/// metadata there comes out of the listing itself (the standard library documents it as making
/// no extra system call), which is where both the size and the stamp are read from.
fn walk(images_dir: &Path) -> std::io::Result<Vec<OnDisk>> {
    use std::io::ErrorKind::NotFound;

    let mut found = Vec::new();
    for variant in Variant::ALL {
        let Some(shards) = read_dir_if_present(&images_dir.join(variant.key()))? else {
            continue;
        };
        for shard in shards {
            let shard = shard?;
            match shard.file_type() {
                Ok(kind) if kind.is_dir() => {}
                Ok(_) => continue,
                Err(e) if e.kind() == NotFound => continue,
                Err(e) => return Err(e),
            }
            let Some(files) = read_dir_if_present(&shard.path())? else {
                continue;
            };
            for file in files {
                let file = file?;
                match file.file_type() {
                    Ok(kind) if kind.is_file() => {}
                    Ok(_) => continue,
                    Err(e) if e.kind() == NotFound => continue,
                    Err(e) => return Err(e),
                }
                let Some(key) = file
                    .file_name()
                    .to_str()
                    .and_then(|name| parse_cache_file_name(name, variant))
                else {
                    continue;
                };
                if cache_path(images_dir, &key).as_deref() != Some(file.path().as_path()) {
                    continue;
                }
                // Found, even when it cannot be measured: a file that is there keeps its row.
                let meta = file.metadata().ok();
                found.push(OnDisk {
                    key,
                    bytes: meta.as_ref().map_or(0, |m| m.len()),
                    used: meta.and_then(|m| m.modified().ok()),
                });
            }
        }
    }
    Ok(found)
}`,
      `/// **On Windows it is one directory listing per shard and no call per file**: \`DirEntry\`'s
/// metadata there comes out of the listing itself (the standard library documents it as making
/// no extra system call), which is where both the size and the stamp are read from.
///
/// **A folder that is not there is an empty one** — no picture of that variant was ever
/// stored, or [\`crate::reset::clear_cache\`] is mid-sweep — and that is [\`files::listing\`]'s
/// \`None\`. Anything else (a permission, an I/O error, on a folder or on one entry of it) is
/// returned, and [\`evict\`] then does nothing at all: a partial walk would read every file it
/// missed as gone and reap the rows that vouch for them.
fn walk(images_dir: &Path) -> std::io::Result<Vec<OnDisk>> {
    let mut found = Vec::new();
    for variant in Variant::ALL {
        let Some(shards) = files::listing(&images_dir.join(variant.key()))? else {
            continue;
        };
        for shard in shards.iter().filter(|e| e.kind == files::Kind::Dir) {
            let Some(pictures) = files::listing(&shard.path)? else {
                continue;
            };
            for file in pictures.into_iter().filter(|e| e.kind == files::Kind::File) {
                let Some(key) = parse_cache_file_name(&file.name, variant) else {
                    continue;
                };
                if cache_path(images_dir, &key).as_deref() != Some(file.path.as_path()) {
                    continue;
                }
                // Found, even when it cannot be measured: a file that is there keeps its row.
                found.push(OnDisk {
                    key,
                    bytes: file.len.unwrap_or(0),
                    used: file.modified,
                });
            }
        }
    }
    Ok(found)
}`,
    ],
    // ── the choice and the pass
    [
      "    budget: Budget,\n    now: SystemTime,\n) -> Vec<usize> {",
      "    budget: Budget,\n    now: Wall,\n) -> Vec<usize> {",
    ],
    [
      "    let mut oldest_first: Vec<(SystemTime, usize)> = unspared",
      "    let mut oldest_first: Vec<(Wall, usize)> = unspared",
    ],
    [
      "/// **A walk that fails deletes nothing**, for [`read_dir_if_present`]'s reason.",
      "/// **A walk that fails deletes nothing**, for the reason [`walk`] gives.",
    ],
    [
      "    budget: Budget,\n    now: SystemTime,\n) -> Result<Upkeep, String> {",
      "    budget: Budget,\n    now: Wall,\n) -> Result<Upkeep, String> {",
    ],
    [
      `    let started = now
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX));`,
      `    let started = now.as_secs().max(0);`,
    ],
    ["        match std::fs::remove_file(&path) {", "        match files::remove(&path) {"],
    // ── what the desktop's half still calls
    ["async fn warm(\n", "pub async fn warm(\n"],
    ["const UPKEEP_TICK: Duration = ", "pub const UPKEEP_TICK: Duration = "],
  ]);

  // ── prose that named the desktop
  core = swaps(core, [
    [
      "/// writes it through `AppState.db` — the read handle is opened `SQLITE_OPEN_READ_ONLY`",
      "/// writes it through the state's write connection — the read handle is opened `SQLITE_OPEN_READ_ONLY`",
    ],
    [
      "    /// and the set is drained every [`UPKEEP_TICK`] — the webview keeps what it was served for\n    /// a day ([`IMAGE_MAX_AGE`]), so a minute of distinct hits is a few screenfuls, never\n    /// thousands.",
      "    /// and the set is drained every [`UPKEEP_TICK`] — the desktop's webview keeps what it was\n    /// served for a day (its `IMAGE_MAX_AGE`), so a minute of distinct hits is a few screenfuls,\n    /// never thousands.",
    ],
    [
      "    /// served tile pays for neither: [`spawn_upkeep`]'s thread calls this once a tick, and",
      "    /// served tile pays for neither: [`upkeep_tick`] calls this once a tick, and",
    ],
    [
      "/// Split out of [`prefetch_images`] because that command needs a `tauri::State` and a\n/// running app, and the abandon-on-429 rule is exactly the part worth a test.",
      "/// Split out of the desktop's `prefetch_images` command, which needs a running app, because\n/// the abandon-on-429 rule is exactly the part worth a test.",
    ],
    [
      "/// Many times the stamp's own resolution, which is about a day: the webview keeps what it was\n/// served for [`IMAGE_MAX_AGE`], so a picture on screen every day reaches [`Cache::get`] — and is\n/// touched — about once a day.",
      "/// Many times the stamp's own resolution, which is about a day: the desktop's webview keeps\n/// what it was served for a day (its `IMAGE_MAX_AGE`), so a picture on screen every day reaches\n/// [`Cache::get`] — and is touched — about once a day.",
    ],
  ]);

  // ── one wake of the upkeep loop: the body of the thread, cut where it sleeps ────────────
  const tick = swaps(upkeep.text, [
    [
      `/// Start the \`image-upkeep\` thread: the one caller of [\`evict\`] and of [\`Cache::flush_touches\`].
///
/// It wakes every [\`UPKEEP_TICK\`]. The first wake runs a pass`,
      `/// One wake of a host's upkeep loop: the one caller of [\`evict\`] and of
/// [\`Cache::flush_touches\`].
///
/// **The pass is here and the loop is the host's.** The desktop calls this from its
/// \`image-upkeep\` thread, which sleeps [\`UPKEEP_TICK\`] between calls (\`spawn_upkeep\`, in
/// \`src-tauri\`); a host with no thread to sleep on has no files to evict either.
/// \`stores_at_last_pass\` is the loop's one piece of memory, and starts \`None\`.
///
/// The first wake runs a pass`,
    ],
    [
      `/// Detached, like [\`crate::index::lifecycle::spawn_build\`]: nothing waits on it, and a process
/// that exits mid-pass leaves the interruption [\`evict\`]'s order was chosen for.
pub fn spawn_upkeep(state: &Arc<crate::sync::AppState>) {
    let state = Arc::clone(state);
    let spawned = std::thread::Builder::new()
        .name("image-upkeep".into())
        .spawn(move || {
            let mut stores_at_last_pass: Option<u64> = None;
            loop {
                std::thread::sleep(UPKEEP_TICK);
                let stores = state.images.stores();`,
      `/// Nothing waits on it, and a process that exits mid-pass leaves the interruption [\`evict\`]'s
/// order was chosen for.
pub fn upkeep_tick(state: &State, stores_at_last_pass: &mut Option<u64>) {
    {
        {
            {
                let stores = state.images.stores();`,
    ],
    [
      `                    state.images.flush_touches(SystemTime::now());
                    continue;
                }
                stores_at_last_pass = Some(stores);`,
      `                    state.images.flush_touches(Wall::now());
                    return;
                }
                *stores_at_last_pass = Some(stores);`,
    ],
    [
      "                    SystemTime::now(),\n                ) {",
      "                    Wall::now(),\n                ) {",
    ],
    [
      `            }
        });
    if let Err(e) = spawned {
        eprintln!("image cache: could not start the upkeep thread, so nothing is evicted: {e}");
    }
}`,
      `            }
        }
    }
}`,
    ],
  ]);
  if (!tick.includes("pub fn upkeep_tick(") || /thread|spawned/.test(code(tick)))
    throw new Error("the upkeep tick was not cut cleanly out of the thread");
  // The three braces the cut left are the loop's, the closure's and the builder's: taken off
  // as text, so the body sits where a function's does and rustfmt has nothing odd to keep.
  const tickText = swaps(tick, [
    [
      "pub fn upkeep_tick(state: &State, stores_at_last_pass: &mut Option<u64>) {\n    {\n        {\n            {\n",
      "pub fn upkeep_tick(state: &State, stores_at_last_pass: &mut Option<u64>) {\n",
    ],
    ["            }\n        }\n    }\n}", "}"],
  ]);
  // After `evict`, which is where the thread that called it stood.
  core = swap(
    core,
    "\n/// A wait in whole seconds, rounded **up**.",
    tickText.replace(/\n+$/, "\n") + "\n/// A wait in whole seconds, rounded **up**.",
  );

  // ── the tests ───────────────────────────────────────────────────────────────────────────
  const body = inner(tests);
  for (const name of IMAGE_TESTS_STAY) {
    if (!body.items.some((it) => it.name === name))
      throw new Error(`images.rs's tests have no \`${name}\``);
  }
  const stayTests = body.items.filter((it) => IMAGE_TESTS_STAY.has(it.name));
  const moveTests = body.items.filter((it) => !IMAGE_TESTS_STAY.has(it.name));
  let coreTests = joined(moveTests);
  coreTests = coreTests.split("SystemTime::now()").join("Wall::now()");
  coreTests = coreTests.split("UNIX_EPOCH + ").join("Wall::EPOCH + ");
  coreTests = swaps(coreTests, [
    // A database on files, built at head where `split::convert` built it.
    [
      `            crate::split::convert(&dir).unwrap();
            let write = crate::db::open_write(&dir).unwrap();`,
      `            let write = crate::db::open_write(&dir).unwrap();
            crate::schema::build_pair(&write);`,
    ],
    // The gate, asked what is left of it.
    [
      `        let ahead = f
            .cache
            .gate
            .lock()
            .await
            .saturating_duration_since(tokio::time::Instant::now());`,
      `        let ahead = f.cache.lockout_remaining().unwrap_or_default();`,
      2,
    ],
    [
      `        let ahead = cache
            .gate
            .lock()
            .await
            .saturating_duration_since(tokio::time::Instant::now());`,
      `        let ahead = cache.lockout_remaining().unwrap_or_default();`,
    ],
    [
      `        let remaining = cache
            .gate
            .lock()
            .await
            .saturating_duration_since(tokio::time::Instant::now());`,
      `        let remaining = cache.lockout_remaining().unwrap_or_default();`,
    ],
    [
      `            cache.gate.lock().await.elapsed() >= Duration::ZERO,
            "a fresh gate must already be open"`,
      `            cache.lockout_remaining().is_none(),
            "a fresh gate must already be open"`,
    ],
    [
      "        cache.penalise(Duration::from_secs(300)).await;",
      "        cache.penalise(Duration::from_secs(300));",
    ],
    [
      "        cache.penalise(Duration::from_secs(30)).await;",
      "        cache.penalise(Duration::from_secs(30));",
    ],
    [
      "        cache.penalise(Duration::from_secs(120)).await;",
      "        cache.penalise(Duration::from_secs(120));",
    ],
    // The fence reads a test's clock too.
    ["        let started = std::time::Instant::now();", "        let started = Tick::now();", 2],
    // `schema`'s fixtures are their own module in the core; its `tests` only re-exports them.
    ["crate::schema::tests::category(", "crate::schema::fixtures::category("],
    [
      `    fn epoch_secs(t: SystemTime) -> i64 {
        t.duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
    }`,
      `    fn epoch_secs(t: Wall) -> i64 {
        t.as_secs()
    }`,
    ],
  ]);
  coreTests = coreTests.split("SystemTime").join("Wall");
  // The gate's two halves were only ever tested against each other, and never past the end
  // of a penalty — which is the half the rewrite changed the arithmetic of.
  coreTests = swap(
    coreTests,
    "    /// The gate is still there, and it is still what a 429 is charged to: what changed is",
    `    /// **A lockout ends.** The gate is a moment and how long the penalty runs from it, so what
    /// is left shrinks as time passes and is nothing once the penalty has — and a penalty
    /// charged after that starts a new one rather than being measured against the old.
    #[test]
    fn a_lockout_runs_out_and_a_later_penalty_starts_a_new_one() {
        let cache = Cache::new(PathBuf::from("D:\\\\app\\\\data\\\\images"));

        cache.penalise(Duration::from_millis(40));
        let left = cache.lockout_remaining().expect("just charged");
        assert!(left <= Duration::from_millis(40), "{left:?}");

        assert!(crate::platform::pause(Duration::from_millis(80)));
        assert_eq!(
            cache.lockout_remaining(),
            None,
            "the penalty has run its course"
        );

        cache.penalise(Duration::from_secs(60));
        let left = cache.lockout_remaining().expect("charged again");
        assert!(
            left > Duration::from_secs(55),
            "a new penalty runs from when it was charged: {left:?}"
        );
    }

    /// The gate is still there, and it is still what a 429 is charged to: what changed is`,
  );

  const coreText =
    file.header +
    `// \`rate_limit_penalty\` is the *API* client's clamp, imported rather than copied: the API's
// lockout and this cache's are separate deadlines over separate hosts, but they are one
// rule, and a second copy of a clamp is a second place for it to drift.
use crate::scryfall::{self, rate_limit_penalty, ScryfallError};
// The host allowlist and the resolution rule live in [\`crate::image_uri\`]; this module is the
// cache that reads them. IMAGE_HOST is imported rather than
// re-spelled because the stderr line below names it.
use crate::image_uri::IMAGE_HOST;
use crate::platform::clock::{Tick, Wall};
use crate::platform::files::{self, aio};
use crate::platform::sync::{Lock, Semaphore};
use crate::state::State;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

` +
    core.replace(/\n+$/, "\n") +
    "\n#[cfg(test)]\nmod tests {\n" +
    coreTests.replace(/\n+$/, "\n") +
    body.tail +
    "}\n" +
    file.tail;
  mustNotName("the core's images.rs", coreText, DESKTOP_NAMES);
  mustNotName(
    "the shipped half of the core's images.rs",
    coreText.slice(0, coreText.indexOf("\n#[cfg(test)]\nmod tests {")),
    SHIPPED_ONLY,
  );
  put(join(CORE, "images.rs"), coreText);
  removed.push(join(DESK, "images.rs"));

  // ── the desktop's half ──────────────────────────────────────────────────────────────────
  const desk = swaps(joined(stay.filter((it) => it !== upkeep)), []);
  const deskTests = swaps(joined(stayTests), [
    [
      `            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();`,
      `            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();`,
    ],
  ]);
  put(
    join(DESK, "images/mod.rs"),
    `//! **The image cache is \`grimoire-core\`'s, re-exported here beside what names this app.**
//!
//! The cache, the resolution rule, the pre-warm's keys and the eviction pass are in
//! \`crates/grimoire-core/src/images.rs\` since the extraction's I/O step; a path through this
//! module reaches that crate's item unless this file defines it. Three things are defined here:
//!
//! * **the \`mtgimg://\` answer** — [\`serve\`] and the pure [\`respond\`] behind it, which turn a
//!   cache result into the HTTP response this app's webview is handed;
//! * **the two commands** that warm the cache, which name this app's state and a task to run on;
//! * **the upkeep thread**, [\`spawn_upkeep\`]. The *pass* it runs is the core's
//!   \`upkeep_tick\`; what is a host's is when to wake up for one.

pub use grimoire_core::images::*;

use std::sync::Arc;

` +
      desk.replace(/\n+$/, "\n") +
      `
/// Start the \`image-upkeep\` thread, which wakes every [\`UPKEEP_TICK\`] and runs one
/// [\`upkeep_tick\`] — the core's, where the pass, what makes one owed and what it spares are
/// written down. The first wake is a minute after launch, so the window, the facet index and
/// the first page of tiles are not competing with a directory walk.
///
/// Detached, like [\`crate::index::lifecycle::spawn_build\`]: nothing waits on it, and a process
/// that exits mid-pass leaves the interruption the pass's order was chosen for.
pub fn spawn_upkeep(state: &Arc<crate::sync::AppState>) {
    let state = Arc::clone(&state.core);
    let spawned = std::thread::Builder::new()
        .name("image-upkeep".into())
        .spawn(move || {
            let mut stores_at_last_pass: Option<u64> = None;
            loop {
                std::thread::sleep(UPKEEP_TICK);
                upkeep_tick(&state, &mut stores_at_last_pass);
            }
        });
    if let Err(e) = spawned {
        eprintln!("image cache: could not start the upkeep thread, so nothing is evicted: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

` +
      deskTests.replace(/\n+$/, "\n") +
      "}\n",
  );
  console.log(
    `images: ${stay.length} items and ${stayTests.length - 1} tests stay, ` +
      `${move.length - 1} items and ${moveTests.filter((it) => /#\[(tokio::)?test/.test(it.text)).length} tests move.`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// what earlier steps left behind
// ══════════════════════════════════════════════════════════════════════════════════════════

/** `text` with everything from `from` to the end of `to` replaced by `by`. */
function span(text, from, to, by) {
  const i = text.indexOf(from);
  const j = text.indexOf(to, i);
  if (i < 0 || j < 0 || text.indexOf(from, i + 1) >= 0) {
    throw new Error(`this span is not there once:\n${from.slice(0, 120)}`);
  }
  return text.slice(0, i) + by + text.slice(j + to.length);
}

/**
 * Bring `items` and `tests` of `src-tauri/src/<module>/mod.rs` home to the core's file.
 *
 * Shipped items land above the core's `mod tests`, tests at its foot. The desktop's test
 * module goes when nothing but its imports is left in it. `tests: "all"` takes every item of
 * the desktop's test module that is not an import.
 */
function comeHome({
  module,
  items = [],
  tests = [],
  drop = [],
  itemSwaps = [],
  testSwaps = [],
  deskSwaps = [],
  testRewrite = (t) => t,
  stayRewrite = (t) => t,
}) {
  const deskPath = join(DESK, module, "mod.rs");
  const corePath = join(CORE, `${module}.rs`);
  const desk = split(out.get(deskPath) ?? read(deskPath));
  const core = split(out.get(corePath) ?? read(corePath));
  const coreTests = core.items.find((it) => it.kind === "mod" && it.name === "tests");
  if (!coreTests) throw new Error(`the core's ${module}.rs has no \`mod tests\``);

  // ── the shipped items
  const going = items.map((name) => {
    const it = desk.items.find((item) => item.name === name);
    if (!it) throw new Error(`${module}/mod.rs has no item \`${name}\``);
    return it;
  });
  const arriving = swaps(going.map((it) => it.text).join(""), itemSwaps);
  for (const it of going) desk.items.splice(desk.items.indexOf(it), 1);
  // And what nothing here calls once those have gone.
  for (const name of drop) {
    const at = desk.items.findIndex((item) => item.name === name);
    if (at < 0) throw new Error(`${module}/mod.rs has no item \`${name}\``);
    desk.items.splice(at, 1);
  }

  // ── the tests
  const deskTests = desk.items.find((it) => it.kind === "mod" && it.name === "tests");
  let moved = 0;
  if (tests === "all" || tests.length) {
    if (!deskTests) throw new Error(`${module}/mod.rs has no \`mod tests\``);
    const body = inner(deskTests);
    const leaving =
      tests === "all"
        ? body.items.filter((it) => it.kind !== "use")
        : tests.map((name) => {
            const it = body.items.find((item) => item.name === name);
            if (!it) throw new Error(`${module}/mod.rs's tests have no \`${name}\``);
            return it;
          });
    moved = leaving.filter((it) => /#\[(tokio::)?test/.test(it.text)).length;
    const left = body.items.filter((it) => !leaving.includes(it));
    const home = inner(coreTests);
    const text = swaps(
      testRewrite(leaving.map((it) => "\n" + it.text.replace(/^\n+/, "")).join("")),
      testSwaps,
    );
    coreTests.text =
      home.before + home.items.map((it) => it.text).join("") + text + home.tail + home.after;
    if (left.some((it) => it.kind !== "use")) {
      deskTests.text =
        body.before + stayRewrite(left.map((it) => it.text).join("")) + body.tail + body.after;
    } else {
      desk.items.splice(desk.items.indexOf(deskTests), 1);
    }
  }

  const at = core.items.indexOf(coreTests);
  const before = core.items
    .slice(0, at)
    .map((it) => it.text)
    .join("");
  const after = core.items
    .slice(at)
    .map((it) => it.text)
    .join("");
  put(corePath, core.header + before + arriving + after + core.tail);
  put(
    deskPath,
    swaps(
      (desk.header + desk.items.map((it) => it.text).join("") + desk.tail).replace(/\n+$/, "\n"),
      deskSwaps,
    ),
  );
  console.log(`${module}: ${going.length} items and ${moved} tests go home.`);
}

if (existsSync(join(DESK, "images.rs")) || process.argv.includes("--home")) {
  // ── reset: the cache clear, which named the image cache and the three feeds ─────────────
  comeHome({
    module: "reset",
    items: [
      "Swept",
      "sweep_dir",
      "clear_cache",
      "forget_image_rows",
      "SYNCING",
      "DOWNLOADING",
      "cache_clear_refusal",
    ],
    // Seven of the eight. `the_cache_sweep_unlinks_rather_than_follows` makes a symlink with a
    // Windows call behind `#[cfg(windows)]`, and the core's fence keeps a platform gate out of
    // every file but `platform/`'s — tests included. It stays, over the core's `clear_cache`.
    tests: [
      "the_cache_sweep_empties_both_trees_and_keeps_their_roots",
      "the_cache_rows_go_before_the_sweep_and_the_sweep_waits_for_them",
      "a_busy_row_delete_leaves_the_cache_exactly_as_it_was",
      "the_cache_clear_is_refused_while_a_feed_is_downloading",
      "the_cache_sweep_drops_the_rows_still_owed_for_the_files_it_deleted",
      "the_cache_sweep_answers_zero_when_there_is_nothing_to_sweep",
      "the_cache_sweep_reaches_no_sibling_of_the_two_roots",
    ],
    itemSwaps: [
      [
        `/// Depth is three (\`images/<variant>/<shard>/\`) and one (\`tmp/\`), so the recursion is bounded
/// by the layout rather than by a counter. A directory that cannot be read is skipped whole:`,
        `/// Depth is three (\`images/<variant>/<shard>/\`) and one (\`tmp/\`), so the recursion is bounded
/// by the layout rather than by a counter. A directory that cannot be read — or one entry of
/// which cannot, since a listing is whole or it is an error — is skipped whole and counted
/// once in \`failed\`:`,
      ],
      [
        `fn sweep_dir(root: &Path, out: &mut Swept) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // \`DirEntry::file_type\` does not follow symlinks, so a link into the user's pictures
        // folder is treated as the file it is and unlinked — never walked into.
        match entry.file_type() {
            Ok(t) if t.is_dir() => {
                sweep_dir(&path, out);
                // Best-effort: a directory that still holds a file we could not remove is
                // simply left, and that file is already counted in \`failed\`.
                let _ = fs::remove_dir(&path);
            }
            Ok(_) => {
                let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                if fs::remove_file(&path).is_ok() {
                    out.files += 1;
                    out.bytes += bytes;
                } else {
                    out.failed += 1;
                }
            }
            Err(_) => out.failed += 1,
        }
    }
}`,
        `fn sweep_dir(root: &Path, out: &mut Swept) {
    let entries = match files::listing(root) {
        Ok(Some(entries)) => entries,
        // Not there: nothing was ever put in it.
        Ok(None) => return,
        // There, and it would not be read. Counted, so a sweep that left a whole directory
        // behind cannot answer as if it had left nothing.
        Err(_) => {
            out.failed += 1;
            return;
        }
    };
    for entry in entries {
        // A listing says what an entry is without following it, so a link into the user's
        // pictures folder is treated as the file it is and unlinked — never walked into.
        match entry.kind {
            files::Kind::Dir => {
                sweep_dir(&entry.path, out);
                // Best-effort: a directory that still holds a file we could not remove is
                // simply left, and that file is already counted in \`failed\`.
                let _ = files::remove_dir(&entry.path);
            }
            files::Kind::File | files::Kind::Other => {
                if files::remove(&entry.path).is_ok() {
                    out.files += 1;
                    out.bytes += entry.len.unwrap_or(0);
                } else {
                    out.failed += 1;
                }
            }
        }
    }
}`,
      ],
      [
        "fn forget_image_rows(conn: &Connection) -> Result<i64, String> {",
        "pub fn forget_image_rows(conn: &Connection) -> Result<i64, String> {",
      ],
      [
        "fn cache_clear_refusal(syncing: bool) -> Option<&'static str> {",
        "pub fn cache_clear_refusal(syncing: bool) -> Option<&'static str> {",
      ],
    ],
    // The desktop's file imported `std::fs` at its head; a test here names it where it is used.
    testRewrite: (t) => t.replace(/(?<![:\w])fs::/g, "std::fs::"),
    stayRewrite: (t) => t.replace(/(?<![:\w])fs::/g, "std::fs::"),
    deskSwaps: [
      [
        `/// The tests of \`reset\` that name something this crate still holds. Each goes home when what it
/// names does.`,
        `/// The one test of the cache sweep that could not go home with it: it makes a symlink with a
/// Windows call, behind a platform gate, and the core keeps those under \`platform/\` — in its
/// tests too. It drives the core's \`clear_cache\`.`,
      ],
      [
        `//!
//! [\`clear_cache\`] and what only it calls are here for a different reason: they name
//! \`images::Cache\` and the three feeds, which move with the extraction's I/O step.
`,
        ``,
      ],
      [
        `use rusqlite::Connection;
use std::fs;
use std::path::Path;
use std::sync::atomic::Ordering;`,
        `use std::sync::atomic::Ordering;`,
      ],
    ],
  });
  // The core's file names a path and the platform's files for the first time.
  {
    const path = join(CORE, "reset.rs");
    put(
      path,
      swaps(out.get(path), [
        [
          "use rusqlite::{params, Connection, OptionalExtension};\nuse serde::Serialize;\n",
          "use crate::platform::files;\nuse rusqlite::{params, Connection, OptionalExtension};\nuse serde::Serialize;\nuse std::path::Path;\n",
        ],
      ]),
    );
  }

  // ── deck: the bracket read, which named the combo matcher ───────────────────────────────
  comeHome({
    module: "deck",
    items: ["DeckBracketRead", "BRACKET_CARDS_SQL", "BRACKET_IDS_SQL", "bracket_reads"],
    tests: "all",
    deskSwaps: [
      [
        `//!
//! [\`bracket_reads\`] and [\`DeckBracketRead\`] are here for a different reason: they name \`combos\`,
//! a feed, which moves with the extraction's I/O step. They go home with it.
`,
        ``,
      ],
      // Only the bracket read named them.
      ["use rusqlite::{params, Connection};\nuse serde::Serialize;\n", ""],
    ],
  });

  // ── sync: the status, which read the image cache ────────────────────────────────────────
  comeHome({
    module: "sync",
    items: ["status"],
    // The image cache was its one caller here, and the cache reaches `db`'s own now.
    drop: ["lock_conn"],
    tests: "all",
    itemSwaps: [
      [
        "pub fn status(state: &AppState) -> SyncStatus {\n    let conn = lock_db_read(state);",
        "pub fn status(state: &State) -> SyncStatus {\n    let conn = state.lock_db_read();",
      ],
    ],
    testRewrite: (t) =>
      span(
        t,
        "    fn file_state(name: &str, syncing: bool) -> (AppState, std::path::PathBuf) {",
        "            dir,\n        )\n    }\n",
        `    fn file_state(name: &str, syncing: bool) -> (State, std::path::PathBuf) {
        let dir = crate::scratch::path(&format!("sync-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        crate::schema::build_pair(&conn);
        let read = crate::db::open_read(&dir).unwrap();
        let state = State::new(
            conn,
            Some(read),
            // Not where the files are: what the status reports is the directory it was told.
            std::path::PathBuf::from("D:\\\\app\\\\data"),
            crate::events::silent(),
            Vec::new(),
            // Never called: these tests stop short of the network.
            crate::scryfall::Client::new("http://127.0.0.1:1".into()),
            // Never touched either — a \`Cache\` creates nothing until it is asked for an
            // image, so this directory does not have to exist.
            crate::images::Cache::new(std::path::PathBuf::from("D:\\\\app\\\\data\\\\images")),
        );
        state.syncing.store(syncing, Ordering::SeqCst);
        (state, dir)
    }
`,
      )
        .replace(/\block_db\(&state\)/g, "state.lock_db()")
        .replace(/\block_db\(&fresh\)/g, "fresh.lock_db()")
        // The fence reads a test's clock too.
        .replace(/std::time::Instant::now\(\)/g, "crate::platform::clock::Tick::now()")
        .replace(/(?<![:\w])with_write(_waiting)?\(&state/g, "crate::state::with_write$1(&state"),
    deskSwaps: [
      [
        `//! * [\`status\`], which reads the image cache's failure count beside five \`sync_meta\` rows. It
//!   goes home with the cache.
//!
//! And five tests, with the \`file_state\` they share: each asks [\`status\`], or drives
//! \`with_write\` over an [\`AppState\`] built on a file \`split\` converted.
`,
        `//!
//! \`status\` went home with the image cache, whose failure count it reads, and the five tests
//! that built an \`AppState\` to ask it went with it, onto the core's \`State\`.
`,
      ],
      [
        "use rusqlite::Connection;\nuse std::sync::atomic::Ordering;\n",
        "use rusqlite::Connection;\n",
      ],
      [
        "//! * [`lock_db`], [`lock_db_read`], [`lock_conn`] and [`lock_plain`] — one-line delegates",
        "//! * [`lock_db`], [`lock_db_read`] and [`lock_plain`] — one-line delegates",
      ],
      [
        `/// Lock any std mutex, recovering from poisoning — the same rule as [\`lock_conn\`], for the
/// maps and counters that are not connections ([\`crate::images::Cache\`]'s single-flight
/// map is the one caller today).
///
/// A one-line delegate for the same reason [\`lock_conn\`] is one: the recovery rule has`,
        `/// Lock any std mutex, recovering from poisoning — the rule [\`lock_db\`] applies, for what
/// is not a connection (the mirror's record of its last pass is the caller today).
///
/// A one-line delegate on purpose: the recovery rule has`,
      ],
    ],
  });

  // ── card: one test, which named the cache's resolution rule ─────────────────────────────
  comeHome({ module: "card", tests: "all" });

  // ── schema: one test, which named the tag search ────────────────────────────────────────
  comeHome({
    module: "schema",
    tests: ["the_oracle_tag_search_answers_over_a_database_that_predates_the_normalised_slug"],
  });

  // ── search: one test, which built an \`AppState\` whole to hold a write connection ────────
  comeHome({
    module: "search",
    tests: "all",
    testRewrite: (t) =>
      swaps(
        span(
          t,
          "        use crate::sync::lock_db_read;\n",
          "            changes,\n        });\n",
          `        let (state, dir) =
            crate::state::fixtures::on_files("search-concurrent", "http://127.0.0.1:1");
        state.lock_db().execute("INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw) VALUES ('1','Lightning Bolt','lea','161','en','normal',1,'{}')", []).unwrap();
        state
            .syncing
            .store(true, std::sync::atomic::Ordering::SeqCst);
`,
        ),
        [
          [
            "                let _ = tx.send(run_search(&lock_db_read(&state), &req));",
            "                let _ = tx.send(run_search(&state.lock_db_read(), &req));",
          ],
        ],
      ),
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// the one frontend test that reads a moved file as text
// ══════════════════════════════════════════════════════════════════════════════════════════

// \`ipc.test.ts\` holds \`ipc.ts\` to the Rust it mirrors by reading the Rust. \`combos.rs\` is two
// files now, and is read as both halves under the name its assertions already use.
if (existsSync(join(DESK, "combos.rs"))) {
  const path = join(ROOT, "src/lib/ipc.test.ts");
  put(
    path,
    swaps(read(path), [
      [
        `import combosRs from "../../src-tauri/src/combos.rs?raw";\n`,
        `import combosRsCore from "../../crates/grimoire-core/src/combos.rs?raw";\n` +
          `import combosRsDesktop from "../../src-tauri/src/combos/mod.rs?raw";\n`,
      ],
      [
        `const collectionRs = collectionRsCore + "\\n" + collectionRsDesktop;\n`,
        `const collectionRs = collectionRsCore + "\\n" + collectionRsDesktop;\n` +
          `const combosRs = combosRsCore + "\\n" + combosRsDesktop;\n`,
      ],
    ]),
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Writing
// ══════════════════════════════════════════════════════════════════════════════════════════

if (out.size === 0 && removed.length === 0) {
  console.log("nothing to move: this step has already run on this tree.");
  process.exit(0);
}
if (DRY) {
  for (const path of removed) console.log("  would remove", path.slice(ROOT.length + 1));
  for (const path of out.keys()) console.log("  would write ", path.slice(ROOT.length + 1));
  process.exit(0);
}

// Files only. Everything above decided what to write and checked every replacement against the
// tree, so a run either reaches here whole or has written nothing. **Written before anything is
// removed**: a write that fails then leaves every source where it was, and the tree is the old
// one with some new files beside it rather than half of each.
const rel = (path) =>
  path
    .slice(ROOT.length + 1)
    .split("\\")
    .join("/");
for (const [path, text] of out) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
for (const path of removed) {
  // Unless this run wrote the same path: `tags/mod.rs` is replaced where it stands.
  if (out.has(path)) continue;
  rmSync(path);
  // A file that was the only one in its folder leaves no folder behind, nor an empty one
  // above it.
  for (let dir = dirname(path); readdirSync(dir).length === 0; dir = dirname(dir)) rmdirSync(dir);
}

if (!NO_FMT) {
  const files = [...out.keys()].filter((p) => p.endsWith(".rs")).map(rel);
  try {
    execFileSync("rustfmt", ["--edition", "2021", ...files], { cwd: ROOT, stdio: "inherit" });
  } catch {
    // The move is done and a second run would find nothing to move, so say how to finish.
    console.error("rustfmt failed. The files are written; format them with:");
    console.error("  cargo fmt -p grimoire-core -p mtg-grimoire");
    process.exit(1);
  }
}
console.log(`wrote ${out.size} files, removed ${removed.length}.`);
