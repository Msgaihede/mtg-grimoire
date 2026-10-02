// The I/O step's second part: the card sync and the facet index move to `crates/grimoire-core`.
//
//   node scripts/core-step-5b.mjs [--dry] [--no-fmt]
//
// Where step 4's script moved forty-nine modules whose wrappers already named the desktop and
// whose bodies did not, this one moves four files whose *bodies* name it: `sync.rs` takes a
// `tauri::AppHandle` to emit through and an `Arc<AppState>` to spawn with, and the index's
// lifecycle takes `&AppState`. So it is a move and a rewrite, and the rewrite is a list of exact
// replacements — each has to match the number of times it says, or the run stops with nothing
// written.
//
// What it does, per file:
//
// * `src-tauri/src/sync.rs` → `crates/grimoire-core/src/sync.rs`, item by item
//   (`scripts/lib/rs-items.mjs`). What stays is `AppState`, the lock helpers every desktop
//   module calls, and `status` — it reads the image cache, which moves in the step's third
//   part — as `src-tauri/src/sync/mod.rs` under `pub use grimoire_core::sync::*;`.
// * `src-tauri/src/index/{mod,facets,lifecycle}.rs` → `crates/grimoire-core/src/index/`. The one
//   command, `facet_cards`, stays as `src-tauri/src/index/facets/mod.rs`. The fixture that built
//   a whole `AppState` has a core twin over a `State`, and every test that called it moved, so
//   the desktop's copy goes rather than staying with nothing to call it.
// * `collection_source::with_write_owned` goes home, and its remainder file with it.
//
// It writes nothing outside those files. `State`'s new fields, the desktop's `init_state` and the
// observers are edited by hand in the same commit: they are a handful of sites, not a move.
//
// Run it on a tree where those four files are still in `src-tauri`; on one where they have
// moved it says so and does nothing. **It touches no git state**: every decision is made and
// every replacement checked before the first byte is written, and then it writes files and
// removes files. A rename is what git infers from the contents at commit time.
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
    throw new Error(`expected ${count} of this, found ${found}:\n${a.slice(0, 160)}`);
  }
  return text.split(a).join(b);
}
const swaps = (text, pairs) => pairs.reduce((t, [a, b, n]) => swap(t, a, b, n ?? 1), text);

/** `text` with every `a` replaced by `b`, however many there are. */
function swapAll(text, a, b) {
  if (!text.includes(a)) return text;
  return text.split(a).join(b);
}

/** A regex replaced at least once — for a spelling that recurs a number of times nobody pins. */
function sweep(text, re, to) {
  if (!re.test(text)) throw new Error(`nothing matches ${re}`);
  return text.replace(re, to);
}

if (!existsSync(join(DESK, "sync.rs"))) {
  console.log("src-tauri/src/sync.rs is not there: this step has already run on this tree.");
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// sync.rs
// ══════════════════════════════════════════════════════════════════════════════════════════

/** Top-level items that stay in `src-tauri`, by name. */
const SYNC_STAYS = new Set([
  "AppState",
  "lock_db",
  "lock_conn",
  "lock_plain",
  "lock_db_read",
  "status",
]);
/** One that is neither: the mirror hears of a swap through `State::corpus_replaced` now. */
const SYNC_GONE = new Set(["note_mirror_after_swap"]);
/**
 * Test items that stay — five tests and the helper they share: each builds an `AppState` on a
 * file `split` converted, or asks `status`.
 */
const SYNC_TESTS_STAY = new Set([
  "file_state",
  "status_answers_real_numbers_while_the_write_connection_is_held",
  "a_count_that_cannot_be_read_is_none_and_never_zero",
  "the_skipped_count_is_readable_from_the_status_long_after_the_event",
  "with_write_answers_busy_rather_than_queueing_when_the_connection_is_held",
  "with_write_waiting_outlasts_the_bound_and_runs_once_the_connection_is_free",
]);

{
  const src = read(join(DESK, "sync.rs"));
  const file = split(src);
  const tests = file.items.find((it) => it.kind === "mod" && it.name === "tests");
  if (!tests) throw new Error("sync.rs has no `mod tests`");

  const stay = [];
  const move = [];
  for (const it of file.items) {
    if (it === tests || it.kind === "use") continue;
    if (SYNC_GONE.has(it.name)) continue;
    (SYNC_STAYS.has(it.name) ? stay : move).push(it);
  }
  for (const name of [...SYNC_STAYS, ...SYNC_GONE]) {
    if (!file.items.some((it) => it.name === name))
      throw new Error(`sync.rs has no item \`${name}\``);
  }
  // The two re-exports: the `sync_meta` store goes with the module, `with_write` stays.
  const uses = file.items.filter((it) => it.kind === "use");
  const metaUse = uses.find((it) => it.text.includes("grimoire_core::sync_meta::"));
  const writeUse = uses.find((it) => it.text.includes("grimoire_core::state::{with_write"));
  if (!metaUse || !writeUse) throw new Error("sync.rs's two re-exports");

  // ── the core's half ─────────────────────────────────────────────────────────────────────
  let core = move.map((it) => it.text).join("");
  // The `sync_meta` re-export sat between the progress type and `should_check`.
  core = swap(
    core,
    "\n/// Should this run talk to the API at all?",
    swap(metaUse.text, "pub use grimoire_core::sync_meta::", "pub use crate::sync_meta::") +
      "\n/// Should this run talk to the API at all?",
  );
  core = swaps(core, [
    // Four keys the desktop's `status` still reads, and one its tests do.
    ["const K_BULK_UPDATED_AT: &str", "pub const K_BULK_UPDATED_AT: &str"],
    ["const K_LAST_CHECK_AT: &str", "pub const K_LAST_CHECK_AT: &str"],
    ["const K_LAST_INGEST_SKIPPED: &str", "pub const K_LAST_INGEST_SKIPPED: &str"],
    ["const K_LAST_ERROR: &str", "pub const K_LAST_ERROR: &str"],
    ["pub(crate) fn has_cards(", "pub fn has_cards("],
    ["pub(crate) fn note_database(state: &AppState,", "pub fn note_database(state: &State,"],
    ["pub(crate) fn persist_penalty(state: &AppState)", "pub fn persist_penalty(state: &State)"],

    // The clock.
    [
      `fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}`,
      `fn unix_now() -> u64 {
    u64::try_from(crate::platform::clock::now_secs()).unwrap_or(0)
}`,
    ],

    // Events leave through the state's sink, not through a window.
    [
      `fn emit(app: &tauri::AppHandle, phase: &str, done: u64, total: u64) {
    // A dropped progress event is never worth failing a sync over.
    let _ = app.emit("sync:progress", Progress::new(phase, done, total));
}`,
      `fn emit(state: &State, phase: &str, done: u64, total: u64) {
    // A dropped progress event is never worth failing a sync over.
    crate::events::emit(
        &*state.events,
        "sync:progress",
        &Progress::new(phase, done, total),
    );
}`,
    ],
    [
      `fn emit_done(app: &tauri::AppHandle, card_count: i64, skipped: Option<u64>) {`,
      `fn emit_done(state: &State, card_count: i64, skipped: Option<u64>) {`,
    ],
    [
      `    progress.message = Some(done_message(n, skipped));
    let _ = app.emit("sync:progress", progress);`,
      `    progress.message = Some(done_message(n, skipped));
    crate::events::emit(&*state.events, "sync:progress", &progress);`,
    ],

    // run_sync
    [
      `pub async fn run_sync(
    state: Arc<AppState>,
    app: tauri::AppHandle,
    force: bool,
) -> Result<SyncOutcome, String> {`,
      `pub async fn run_sync(state: Arc<State>, force: bool) -> Result<SyncOutcome, String> {`,
    ],
    [
      "    let result = do_sync(&state, &app, force).await;",
      "    let result = do_sync(&state, force).await;",
    ],
    [
      `            let conn = lock_db(&state);
            let _ = set_meta_opt(&conn, K_LAST_ERROR, Some(e.as_str()));
        }
        let _ = app.emit("sync:progress", Progress::error(e.clone()));`,
      `            let conn = state.lock_db();
            let _ = set_meta_opt(&conn, K_LAST_ERROR, Some(e.as_str()));
        }
        crate::events::emit(&*state.events, "sync:progress", &Progress::error(e.clone()));`,
    ],
    [
      "fn note_scryfall(state: &Arc<AppState>, operation: &str,",
      "fn note_scryfall(state: &State, operation: &str,",
    ],

    // The four that took a window beside the state.
    [
      `async fn finish_unchanged(
    state: &Arc<AppState>,
    app: &tauri::AppHandle,
    now: u64,`,
      `async fn finish_unchanged(
    state: &Arc<State>,
    now: u64,`,
    ],
    [
      "async fn reconcile_ids(state: &Arc<AppState>, app: &tauri::AppHandle) {",
      "async fn reconcile_ids(state: &Arc<State>) {",
    ],
    [
      "async fn reclaim_freed_pages(state: &Arc<AppState>, app: &tauri::AppHandle) {",
      "async fn reclaim_freed_pages(state: &Arc<State>) {",
    ],
    [
      "async fn compact_once(state: &Arc<AppState>, app: &tauri::AppHandle) -> bool {",
      "async fn compact_once(state: &Arc<State>) -> bool {",
    ],
    [
      `async fn do_sync(
    state: &Arc<AppState>,
    app: &tauri::AppHandle,
    force: bool,`,
      `async fn do_sync(
    state: &Arc<State>,
    force: bool,`,
    ],
    [
      "        return finish_unchanged(state, app, now, stored.card_count).await;",
      "        return finish_unchanged(state, now, stored.card_count).await;",
      2,
    ],
    ["    reconcile_ids(state, app).await;", "    reconcile_ids(state).await;", 2],
    ["    if compact_once(state, app).await {", "    if compact_once(state).await {"],
    ["    let _ = compact_once(state, app).await;", "    let _ = compact_once(state).await;"],
    ["    reclaim_freed_pages(state, app).await;", "    reclaim_freed_pages(state).await;"],
    ["    emit_done(app, card_count, None);", "    emit_done(state, card_count, None);"],
    [
      "    emit_done(app, card_count, Some(stats.skipped));",
      "    emit_done(state, card_count, Some(stats.skipped));",
    ],

    // Two closures cloned the window to emit from a blocking thread; the state they already
    // clone carries the sink.
    [
      `        let state = state.clone();
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::maintenance::reclaim_freed_pages(&state.db, &mut |done, total| {
                emit(&app, "reclaiming", done.max(0) as u64, total.max(0) as u64)
            })
        })
        .await`,
      `        let state = state.clone();
        crate::platform::spawn::blocking(move || {
            crate::maintenance::reclaim_freed_pages(&state.db, &mut |done, total| {
                emit(&state, "reclaiming", done.max(0) as u64, total.max(0) as u64)
            })
        })
        .await`,
    ],
    [
      `        let state = state.clone();
        let app = app.clone();
        let gz = gz.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // No lock is taken here any more: the ingest takes it per batch and gives it
            // back, so a collection edit waits one batch rather than one sync.
            ingest::ingest_gz(&state.db, &gz, &mut |n| {
                emit(&app, "ingesting", n, INGEST_TOTAL_ESTIMATE)
            })
        })
        .await`,
      `        let state = state.clone();
        let gz = gz.clone();
        crate::platform::spawn::blocking(move || {
            // No lock is taken here any more: the ingest takes it per batch and gives it
            // back, so a collection edit waits one batch rather than one sync.
            ingest::ingest_gz(&state.db, &gz, &mut |n| {
                emit(&state, "ingesting", n, INGEST_TOTAL_ESTIMATE)
            })
        })
        .await`,
    ],
    [
      `    let applied = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = lock_db(&owned);`,
      `    let applied = crate::platform::spawn::blocking(move || {
        let mut conn = owned.lock_db();`,
    ],
    [
      `    let joined = tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_db(&owned);`,
      `    let joined = crate::platform::spawn::blocking(move || {
        let conn = owned.lock_db();`,
    ],
    [
      `            let _ = app.emit(
                "collection:reconciled",
                serde_json::json!({
                    "repointed": stats.repointed,
                    "folded": stats.folded,
                    "flagged": stats.flagged,
                }),
            );`,
      `            state.events.emit(
                "collection:reconciled",
                serde_json::json!({
                    "repointed": stats.repointed,
                    "folded": stats.folded,
                    "flagged": stats.flagged,
                }),
            );`,
    ],

    // The download's folder.
    [
      `        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;`,
      `        crate::platform::files::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;`,
    ],

    // The mirror, and whoever else a host has listening.
    [
      `    // And the mirror is owed a pass for the same reason, told here rather than at the end of
    // the run so that a failure between here and there — \`/sets\` is the one that reaches the
    // network again — cannot leave the mirrored prices a corpus behind for good.
    note_mirror_after_swap(state);`,
      `    // And whoever renders from the corpus is owed a pass for the same reason — on the desktop
    // that is the plain-text mirror, whose every CSV carries a \`Price\` column. The update hook
    // cannot carry this: \`cards\` maps to no surface on purpose, because a sync rewrites
    // 116 700 rows and a per-row mark would be a hundred thousand hook fires.
    //
    // **Told here, the moment the swap has landed, and it was once told from [\`run_sync\`] on
    // \`Ok\` with \`updated\`** (issue #551). That gate was one step too late: a run that swapped
    // the cards and then failed at \`/sets\` returned \`Err\`, so the mirror was never told — and
    // every later run took the 304 path, which swaps nothing and marks nothing, so the mirrored
    // prices stayed a corpus behind until Scryfall next rotated the bulk file. Marking where
    // the swap lands covers that run and still spends nothing on a throttled or 304 run.
    state.corpus_replaced();`,
    ],
  ]);
  // Every progress event not rewritten above with its closure.
  core = sweep(core, /\bemit\(app, /g, "emit(state, ");
  // The connection, asked of the state rather than through the desktop's helpers.
  core = sweep(core, /\block_db\(state\)/g, "state.lock_db()");
  core = sweep(core, /\block_db_read\(state\)/g, "state.lock_db_read()");
  // What may not have survived, in code: the desktop's state, a window, the free lock helpers
  // (a method call on the state is the spelling now), and a clock or a disk named directly.
  const coreCode = core
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  for (const left of [
    /AppState/,
    /tauri::/,
    /\bapp\b/,
    /(?<!\.)\block_db(_read)?\(/,
    /SystemTime/,
    /std::fs/,
  ]) {
    const at = left.exec(coreCode);
    if (at) {
      const line = coreCode.slice(
        coreCode.lastIndexOf("\n", at.index) + 1,
        coreCode.indexOf("\n", at.index),
      );
      throw new Error(`the core's sync.rs still matches ${left} in code:\n${line}`);
    }
  }

  const header = swaps(file.header, [
    [
      `//!   in short synchronous scopes only. The one long blocking operation, the ingest, runs
//!   on a [\`tauri::async_runtime::spawn_blocking\`] thread and takes the lock itself, one
//!   batch at a time — this module hands it the mutex, never a guard.`,
      `//!   in short synchronous scopes only. The one long blocking operation, the ingest, runs
//!   through [\`crate::platform::spawn::blocking\`] and takes the lock itself, one batch at a
//!   time — this module hands it the mutex, never a guard.`,
    ],
    [
      `//! Failures are also *persisted*, to \`last_error\`. A sync spawned at startup emits its
//! \`sync:progress\` events within milliseconds, before the webview has registered a
//! listener, and Tauri drops events that nobody is listening for — so the event is the
//! fast path, and \`sync_meta\` is the one the UI can still read a minute later.`,
      `//! Failures are also *persisted*, to \`last_error\`. A sync spawned at startup emits its
//! \`sync:progress\` events within milliseconds, before the webview has registered a
//! listener, and Tauri drops events that nobody is listening for — so the event is the
//! fast path, and \`sync_meta\` is the one the UI can still read a minute later.
//!
//! **No function here takes a window.** A run is handed the host's [\`State\`] and says what it
//! is doing through \`state.events\` ([\`crate::events::EventSink\`]) — \`sync:progress\`, and
//! \`collection:reconciled\` when the migration log moved something. The desktop forwards both
//! to every window; a host with no page to tell gives the state a silent sink.
//!
//! **Two things of the old \`sync\` module are still \`src-tauri\`'s**, in its module of this
//! name: the desktop's \`AppState\`, which wraps a [\`State\`], and \`status\`, which reads the
//! image cache's failure count beside the five fields this module's keys answer — it comes
//! home with the cache.`,
    ],
  ]);

  // ── the tests ───────────────────────────────────────────────────────────────────────────
  const body = inner(tests);
  const named = (it) => it.name ?? "";
  const stayTests = body.items.filter((it) => SYNC_TESTS_STAY.has(named(it)));
  const moveTests = body.items.filter((it) => it.kind !== "use" && !SYNC_TESTS_STAY.has(named(it)));
  for (const name of SYNC_TESTS_STAY) {
    if (!body.items.some((it) => it.name === name))
      throw new Error(`sync.rs's tests have no \`${name}\``);
  }
  // A helper both halves call would have to be a fixture; these two are each one side's.
  const calls = (items, name) =>
    items.some((it) => it.name !== name && new RegExp(`\\b${name}\\(`).test(it.text));
  for (const helper of ["db", "set_row"]) {
    if (calls(stayTests, helper))
      throw new Error(`a staying test calls \`${helper}\`, which moves`);
  }
  if (calls(moveTests, "file_state"))
    throw new Error("a moving test calls `file_state`, which stays");

  const coreTests =
    "#[cfg(test)]\nmod tests {\n    use super::*;\n    use rusqlite::Connection;\n\n" +
    moveTests
      .map((it) => it.text)
      .join("")
      .replace(/^\n+/, "") +
    body.tail +
    "}\n" +
    // Declared here, written by hand: `sync/run_tests.rs` is a whole run against a mock
    // Scryfall, which the module could not have while a run took a window.
    "\n/// A whole sync, driven against a mock Scryfall. Its own file: `sync/run_tests.rs`.\n" +
    "#[cfg(test)]\nmod run_tests;\n";

  const coreText =
    header +
    `
use crate::ingest;
use crate::scryfall;
use crate::state::State;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
` +
    core.replace(/\n+$/, "\n") +
    "\n" +
    coreTests;
  put(join(CORE, "sync.rs"), coreText);

  // ── the desktop's half ──────────────────────────────────────────────────────────────────
  let desk = stay.map((it) => it.text).join("");
  // `with_write` sat between `lock_db_read` and `insert_sets`; it goes after the lock helpers.
  desk = swap(
    desk,
    "\n/// Current sync state for the UI.",
    writeUse.text + "\n/// Current sync state for the UI.",
  );
  desk = swaps(desk, [
    [
      `/// Everything a command or a background sync needs. Managed by Tauri as
/// \`Arc<AppState>\` so a spawned sync can own a handle of its own.`,
      `/// Everything a command needs. Managed by Tauri as \`Arc<AppState>\`, so a command's blocking
/// task can own a handle of its own; a sync owns one on the core inside it, \`state.core\`.`,
    ],
    [
      `/// **Not everything below is the desktop's for good.** The two mirror fields and the change
/// mask are; the rest are every host's, and wait here for the type each one holds to move —
/// \`syncing\`, \`client\`, \`images\` and \`index\` with the extraction's I/O step, \`pairing\` with
/// its sync step.
pub struct AppState {
    /// The every-host half, built by [\`State::new\`].
    pub core: State,
    pub syncing: AtomicBool,
    pub client: scryfall::Client,
    /// The image cache.`,
      `/// **Not everything below is the desktop's for good.** The two mirror fields and the change
/// mask are; \`images\` and \`pairing\` are every host's, and wait here for the type each one
/// holds to move — the image cache with the I/O step's third part, the pending pairing with
/// the sync step. \`syncing\`, \`client\` and \`index\` went to [\`State\`] with the card sync and
/// the facet index, and are read here through the deref exactly as they were.
pub struct AppState {
    /// The every-host half, built by [\`State::new\`].
    ///
    /// **An \`Arc\`, because the card sync and the index's build each take one**: both hand the
    /// state to work that outlives the call ([\`grimoire_core::sync::run_sync\`],
    /// \`index::lifecycle::spawn_build\`), and the engine cannot be handed an \`Arc<AppState>\` it
    /// has never heard of. \`state.core.clone()\` is what those two are given.
    pub core: Arc<State>,
    /// The image cache.`,
    ],
    [
      `    pub images: crate::images::Cache,
    /// The in-memory facet index and the generation of the corpus it describes — cold, which
    /// is a supported state and not an error, until the first build lands. Read it through
    /// [\`crate::index::lifecycle::current\`]; everything else about it is that module's.
    ///
    /// \`RwLock\` and not \`Mutex\`: every facet request reads it and only a sync or a collection
    /// write replaces it. The \`Arc\` inside is so a reader clones the handle and lets the lock
    /// go at once — a facet pass must never hold a lock a sync's rebuild is waiting on.
    pub index: std::sync::RwLock<crate::index::lifecycle::IndexSlot>,
`,
      `    pub images: crate::images::Cache,
`,
    ],
    [
      `/// Shared with [\`crate::search\`] so that recovery rule lives in exactly one place — which is
/// [\`State::lock_db\`] now, and this is the name every caller here has always reached it by.
pub(crate) fn lock_db(state: &AppState) -> MutexGuard<'_, Connection> {
    state.core.lock_db()
}`,
      `/// Shared with [\`crate::search\`] so that recovery rule lives in exactly one place — which is
/// [\`State::lock_db\`] now, and this is the name every caller here has always reached it by.
pub(crate) fn lock_db(state: &State) -> MutexGuard<'_, Connection> {
    state.lock_db()
}`,
    ],
    [
      `pub(crate) fn lock_db_read(state: &AppState) -> MutexGuard<'_, Connection> {
    state.core.lock_db_read()
}`,
      `pub(crate) fn lock_db_read(state: &State) -> MutexGuard<'_, Connection> {
    state.lock_db_read()
}`,
    ],
  ]);

  const deskTests =
    "#[cfg(test)]\nmod tests {\n    use super::*;\n    use std::path::PathBuf;\n\n" +
    swaps(
      stayTests
        .map((it) => it.text)
        .join("")
        .replace(/^\n+/, ""),
      [
        [
          `            AppState {
                core: State::new(
                    conn,
                    Some(read),
                    PathBuf::from("D:\\\\app\\\\data"),
                    grimoire_core::events::silent(),
                    crate::mirror::watch::observers(
                        mirror.clone(),
                        changes.clone(),
                        Default::default(),
                    ),
                ),
                syncing: AtomicBool::new(syncing),
                // Never called: these tests stop short of the network.
                client: crate::scryfall::Client::new("http://127.0.0.1:1".into()),
                // Never touched either — a \`Cache\` creates nothing until it is asked for
                // an image, so this directory does not have to exist.
                images: crate::images::Cache::new(PathBuf::from("D:\\\\app\\\\data\\\\images")),
                index: std::sync::RwLock::default(),
`,
          `            AppState {
                // The flag is the core's field now, so it is set on the way in.
                core: Arc::new({
                    let core = State::new(
                        conn,
                        Some(read),
                        PathBuf::from("D:\\\\app\\\\data"),
                        grimoire_core::events::silent(),
                        crate::mirror::watch::observers(
                            mirror.clone(),
                            changes.clone(),
                            Default::default(),
                        ),
                        // Never called: these tests stop short of the network.
                        crate::scryfall::Client::new("http://127.0.0.1:1".into()),
                    );
                    core.syncing.store(syncing, Ordering::SeqCst);
                    core
                }),
                // Never touched either — a \`Cache\` creates nothing until it is asked for
                // an image, so this directory does not have to exist.
                images: crate::images::Cache::new(PathBuf::from("D:\\\\app\\\\data\\\\images")),
`,
        ],
      ],
    ) +
    "}\n";

  const deskText =
    `//! **The card sync is \`grimoire-core\`'s, re-exported here beside the desktop's own state.**
//!
//! \`run_sync\` and everything it drives — the check, the download, the ingest, the set list, the
//! migration log, the reclaim and the one-time compaction — are in
//! \`crates/grimoire-core/src/sync.rs\` since the extraction's I/O step, and a path through this
//! module reaches that crate's item unless this file defines it. What it defines names a
//! window or something only the desktop holds:
//!
//! * [\`AppState\`], which wraps the core's [\`State\`] and adds the mirror's fields, the other
//!   windows' change mask, the image cache and the pending pairing.
//! * [\`lock_db\`], [\`lock_db_read\`], [\`lock_conn\`] and [\`lock_plain\`] — one-line delegates
//!   under the names seventy-odd files here reach a connection by.
//! * [\`status\`], which reads the image cache's failure count beside five \`sync_meta\` rows. It
//!   goes home with the cache.
//!
//! And five tests, with the \`file_state\` they share: each asks [\`status\`], or drives
//! \`with_write\` over an [\`AppState\`] built on a file \`split\` converted.

pub use grimoire_core::sync::*;

use grimoire_core::state::State;
use rusqlite::Connection;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard};
` +
    desk.replace(/\n+$/, "\n") +
    "\n" +
    deskTests;
  put(join(DESK, "sync/mod.rs"), deskText);
  removed.push(join(DESK, "sync.rs"));

  console.log(
    `sync: ${move.length} items and ${moveTests.filter((t) => t.kind === "fn").length} test items move; ` +
      `${stay.length} items and ${stayTests.length} test items stay`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// index/
// ══════════════════════════════════════════════════════════════════════════════════════════

/** The fixture that is rewritten rather than moved: it built the desktop's whole `AppState`. */
const INDEX_FIXTURE_STAYS = "state_with_seeded_cards";

{
  // ── lifecycle.rs: whole ─────────────────────────────────────────────────────────────────
  let life = read(join(DESK, "index/lifecycle.rs"));
  life = swaps(life, [
    ["use crate::sync::AppState;\n", "use crate::state::State;\n"],
    ["/// What [`crate::sync::AppState`] holds:", "/// What [`crate::state::State`] holds:"],
    [
      `/// **It opens a connection of its own**, never \`AppState.db_read\`: this is a full pass over`,
      `/// **It opens a connection of its own**, never the state's read connection: this is a full pass over`,
    ],
    [
      `/// The handle is returned so a test can join it; the three production call sites drop it and
/// let the thread run detached. A failure is logged and nothing else — see the module docs.
pub fn spawn_build(state: &Arc<AppState>) -> std::thread::JoinHandle<()> {
    clear(state);
    let state = state.clone();
    std::thread::spawn(move || {`,
      `/// The handle is returned so a test can join it; the three production call sites drop it and
/// let the build run detached. A failure is logged and nothing else — see the module docs.
///
/// **Off the calling thread where the host has a second one** ([\`crate::platform::spawn\`]). In
/// a browser the build has run by the time this returns, which the guarantee above already
/// covers: cold first, then whatever the build publishes.
pub fn spawn_build(state: &Arc<State>) -> crate::platform::spawn::Background {
    clear(state);
    let state = state.clone();
    crate::platform::spawn::background(move || {`,
    ],
    ["    fn built(state: &AppState) -> CardIndex {", "    fn built(state: &State) -> CardIndex {"],
  ]);
  life = sweep(life, /\(state: &AppState\b/g, "(state: &State");
  if (/AppState/.test(life.replace(/^\s*\/\/.*$/gm, "")))
    throw new Error("lifecycle.rs still names AppState in code");
  put(join(CORE, "index/lifecycle.rs"), life);
  removed.push(join(DESK, "index/lifecycle.rs"));

  // ── facets.rs: everything but the command ───────────────────────────────────────────────
  const facets = split(read(join(DESK, "index/facets.rs")));
  const command = facets.items.find((it) => it.name === "facet_cards");
  const facetTests = facets.items.find((it) => it.kind === "mod" && it.name === "tests");
  if (!command || !command.attrs.some((a) => a.includes("tauri::command")) || !facetTests) {
    throw new Error("facets.rs: the command or the tests are not where they were");
  }
  let facetsCore =
    facets.header +
    facets.items
      .filter((it) => it !== command)
      .map((it) => it.text)
      .join("") +
    facets.tail;
  facetsCore = swaps(facetsCore, [
    ["use crate::sync::{lock_db_read, AppState};\n", "use crate::state::State;\n"],
    // Only the command named it.
    ["use std::collections::BTreeMap;\nuse std::sync::Arc;\n", "use std::collections::BTreeMap;\n"],
    [
      "pub fn run_facets(state: &AppState, req: &SearchRequest) -> Result<FacetResponse, String> {",
      "pub fn run_facets(state: &State, req: &SearchRequest) -> Result<FacetResponse, String> {",
    ],
    ["    let conn = lock_db_read(state);\n", "    let conn = state.lock_db_read();\n"],
    [
      "    fn state(name: &str) -> std::sync::Arc<crate::sync::AppState> {",
      "    fn state(name: &str) -> std::sync::Arc<crate::state::State> {",
    ],
    [
      "    fn tagged_state(name: &str) -> std::sync::Arc<crate::sync::AppState> {",
      "    fn tagged_state(name: &str) -> std::sync::Arc<crate::state::State> {",
    ],
    // The fence reads a test's clock too.
    [
      "                let t = std::time::Instant::now();",
      "                let t = crate::platform::clock::Tick::now();",
    ],
  ]);
  put(join(CORE, "index/facets.rs"), facetsCore);
  removed.push(join(DESK, "index/facets.rs"));
  put(
    join(DESK, "index/facets/mod.rs"),
    `//! **The facet pass is \`grimoire-core\`'s, re-exported here beside its one command.**
//!
//! [\`run_facets\`] and [\`compute\`] are in \`crates/grimoire-core/src/index/facets.rs\`; a
//! \`#[tauri::command]\` names a window's state and a thread to run on, so the wrapper is here.

pub use grimoire_core::index::facets::*;

use crate::search::SearchRequest;
use crate::sync::AppState;
use std::sync::Arc;
${command.text.replace(/\n+$/, "\n")}`,
  );

  // ── mod.rs: the index itself, and the fixtures at the foot ──────────────────────────────
  const mod = split(read(join(DESK, "index/mod.rs")));
  const fixtures = mod.items.find((it) => it.kind === "mod" && it.name === "fixtures");
  const modTests = mod.items.find((it) => it.kind === "mod" && it.name === "tests");
  if (!fixtures || !modTests)
    throw new Error("index/mod.rs: fixtures or tests are not where they were");
  const fx = inner(fixtures);
  const stays = fx.items.find((it) => it.name === INDEX_FIXTURE_STAYS);
  if (!stays) throw new Error(`index fixtures have no \`${INDEX_FIXTURE_STAYS}\``);

  const coreState = `    /// The same four printings on a **file** database, inside the [\`crate::state::State\`] a
    /// host runs on.
    ///
    /// A file and not \`:memory:\`, because [\`super::lifecycle::build_now\`] opens a read-only
    /// connection of its **own** from \`data_dir\`: two in-memory connections are two different
    /// databases, so an in-memory state would build an index over an empty corpus and every
    /// count here would be zero.
    ///
    /// The pair is built at head, as [\`crate::schema::memory_pair\`] builds its two, rather than
    /// converted from a single file and then migrated, which is what this fixture did while it
    /// lived in \`src-tauri\`: that conversion is the desktop's. The two shapes are held equal by
    /// \`schema\`'s own tests of the ladder against the head DDL. No capture triggers and no
    /// launch passes: twenty fixtures never asked for sync's op log.
    ///
    /// The directory is [\`crate::scratch::path\`]'s, private to the calling test and to this
    /// \`cargo test\` process, so \`name\` only labels it.
    pub fn state_with_seeded_cards(name: &str) -> std::sync::Arc<crate::state::State> {
        let dir = crate::scratch::path(&format!("lifecycle-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        crate::schema::build_pair(&conn);
        seed(&conn);
        let read = crate::db::open_read(&dir).unwrap();
        // **Hooked up, so what these fixtures drive runs with the cross-file fence armed.**
        // \`State::new\` installs it and \`state::with_write\`'s \`debug_assert\` reads it.
        std::sync::Arc::new(crate::state::State::new(
            conn,
            Some(read),
            dir,
            crate::events::silent(),
            Vec::new(),
            // Never called: nothing in the lifecycle reaches the network.
            crate::scryfall::Client::new("http://127.0.0.1:1".into()),
        ))
    }
`;
  const fxCore =
    `/// The corpus every test in this module tree counts against.
///
/// Its own module rather than \`tests\`', because [\`facets\`] counts over exactly this fixture
/// and a second copy of it would be a second corpus: the numbers those tests assert (2 in
/// \`lea\`, 1 in \`rav\`, 3 paper) are properties of *these four rows*, so the two files must
/// read the same ones or the assertions stop meaning what they say.
///
/// **At the foot of the file, and behind \`testing\`**: everything below a file's \`mod tests\`
/// is test code to the fence and to the coverage script alike, and another crate's tests can
/// reach these through the feature.
#[cfg(any(test, feature = "testing"))]
pub mod fixtures {
` +
    (fx.items
      .map((it) => (it === stays ? coreState : it.text))
      .join("")
      .replace(/pub\(crate\) fn /g, "pub fn ") +
      fx.tail) +
    "}\n";
  if (!fxCore.includes("fn seeded") || fxCore.includes("split::convert"))
    throw new Error("the core's index fixtures");

  let modCore =
    mod.header +
    mod.items
      .filter((it) => it !== fixtures && it !== modTests)
      .map((it) => it.text)
      .join("");
  modCore = swaps(modCore, [
    ["pub use grimoire_core::index::bitset;\n", "pub mod bitset;\n"],
    [
      "    /// `AppState.db_read` for it would stall every search behind it at launch, which is the",
      "    /// the state's read connection for it would stall every search behind it at launch, which is the",
    ],
  ]);
  const modTestsText = swaps(modTests.text, [
    [
      "        let t = std::time::Instant::now();",
      "        let t = crate::platform::clock::Tick::now();",
    ],
  ]);
  put(
    join(CORE, "index/mod.rs"),
    modCore.replace(/\n+$/, "\n") + modTestsText.replace(/\n+$/, "\n") + "\n" + fxCore,
  );

  // The desktop's file: the re-export and the one module that holds a command. Its fixture is
  // not written back — nothing here calls it once the tests that did have moved.
  put(
    join(DESK, "index/mod.rs"),
    `//! **The facet index is \`grimoire-core\`'s, re-exported here beside its one command.**
//!
//! \`CardIndex\`, its facets and its lifecycle are in \`crates/grimoire-core/src/index/\` since the
//! extraction's I/O step, and a path through this module reaches that crate's item unless this
//! file defines it. It defines one thing: [\`facets\`], which is the core's module of that name
//! plus the \`facet_cards\` command.
//!
//! **No test of the index is here.** Every one moved with the code, onto a fixture the core
//! builds at head; the fixture this file had — an \`AppState\` over a file \`split\` converted —
//! went when its last caller did.

pub use grimoire_core::index::*;

pub mod facets;
`,
  );
  console.log(
    `index: lifecycle whole; facets all but \`facet_cards\`; mod.rs with ${fx.items.length - 1} fixtures, ` +
      `\`${INDEX_FIXTURE_STAYS}\` rebuilt over the core's \`State\``,
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// collection_source::with_write_owned
// ══════════════════════════════════════════════════════════════════════════════════════════

{
  const desk = split(read(join(DESK, "collection_source/mod.rs")));
  const owned = desk.items.find((it) => it.name === "with_write_owned");
  const others = desk.items.filter((it) => it !== owned && it.kind !== "use");
  if (!owned || others.length > 0) {
    throw new Error("collection_source/mod.rs holds something besides `with_write_owned`");
  }
  const moved = swaps(owned.text.replace(/^\n+/, ""), [
    [
      "/// `crate::sync::with_write`, plus the facet index's `owned` rebuild on success.",
      "/// [`crate::state::with_write`], plus the facet index's `owned` rebuild on success.",
    ],
    [
      `pub(crate) fn with_write_owned<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let answer = crate::sync::with_write(state, f);`,
      `pub fn with_write_owned<T>(
    state: &crate::state::State,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let answer = crate::state::with_write(state, f);`,
    ],
  ]);
  let core = read(join(CORE, "collection_source.rs"));
  const at = core.indexOf("\n#[cfg(test)]\nmod tests");
  if (at < 0) throw new Error("the core's collection_source.rs has no test module to put it above");
  core =
    core.slice(0, at).replace(/\n+$/, "\n") + "\n" + moved.replace(/\n+$/, "\n") + core.slice(at);
  put(join(CORE, "collection_source.rs"), core);
  removed.push(join(DESK, "collection_source/mod.rs"));
  console.log(
    "collection_source: `with_write_owned` goes home; the remainder file had nothing else",
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// two tests go home
// ══════════════════════════════════════════════════════════════════════════════════════════

// Step 4 left a test in `src-tauri` wherever it named something still there. These two named
// the index's fixture and nothing else of the desktop's, and the fixture has a core copy now.
const HOMECOMING = [
  {
    module: "collection",
    tests: ["a_write_that_lands_refreshes_the_owned_facet_and_one_that_is_refused_does_not"],
  },
  { module: "deck_tokens", tests: ["the_backstop_reconciles_a_cut_that_files_no_step"] },
];

for (const { module, tests: names } of HOMECOMING) {
  const deskPath = join(DESK, module, "mod.rs");
  const corePath = join(CORE, `${module}.rs`);
  const desk = split(out.get(deskPath) ?? read(deskPath));
  const deskTests = desk.items.find((it) => it.kind === "mod" && it.name === "tests");
  if (!deskTests) throw new Error(`${module}/mod.rs has no \`mod tests\``);
  const body = inner(deskTests);
  const going = names.map((name) => {
    const it = body.items.find((item) => item.name === name);
    if (!it) throw new Error(`${module}/mod.rs's tests have no \`${name}\``);
    return it;
  });
  const left = body.items.filter((it) => !going.includes(it));

  // Into the core's test module, at its foot.
  const core = split(out.get(corePath) ?? read(corePath));
  const coreTests = core.items.find((it) => it.kind === "mod" && it.name === "tests");
  if (!coreTests) throw new Error(`the core's ${module}.rs has no \`mod tests\``);
  const home = inner(coreTests);
  const arriving = going
    .map(
      (it) =>
        "\n" +
        swapAll(
          it.text.replace(/^\n+/, ""),
          "crate::sync::with_write(",
          "crate::state::with_write(",
        ),
    )
    .join("");
  coreTests.text =
    home.before + home.items.map((it) => it.text).join("") + arriving + home.tail + home.after;
  put(corePath, core.header + core.items.map((it) => it.text).join("") + core.tail);

  // And out of the desktop's: the whole module when nothing but its imports is left.
  if (left.some((it) => it.kind !== "use")) {
    deskTests.text = body.before + left.map((it) => it.text).join("") + body.tail + body.after;
  } else {
    desk.items.splice(desk.items.indexOf(deskTests), 1);
  }
  put(
    deskPath,
    (desk.header + desk.items.map((it) => it.text).join("") + desk.tail).replace(/\n+$/, "\n"),
  );
  console.log(
    `${module}: ${names.length} test goes home; ` +
      `${left.filter((it) => it.kind === "fn").length} stay in src-tauri`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// the one frontend test that reads a moved file as text
// ══════════════════════════════════════════════════════════════════════════════════════════

// `ipc.test.ts` holds `ipc.ts` to the Rust it mirrors by reading the Rust. `facets.rs` is two
// files now, and is read as both halves under the name its assertions already use — what step
// 4 did for every module it split.
{
  const path = join(ROOT, "src/lib/ipc.test.ts");
  put(
    path,
    swaps(read(path), [
      [
        `import facetsRs from "../../src-tauri/src/index/facets.rs?raw";\n`,
        `import facetsRsCore from "../../crates/grimoire-core/src/index/facets.rs?raw";\n` +
          `import facetsRsDesktop from "../../src-tauri/src/index/facets/mod.rs?raw";\n`,
      ],
      [
        `const homeRs = homeRsCore + "\\n" + homeRsDesktop;\n`,
        `const facetsRs = facetsRsCore + "\\n" + facetsRsDesktop;\n` +
          `const homeRs = homeRsCore + "\\n" + homeRsDesktop;\n`,
      ],
    ]),
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════

if (DRY) {
  for (const path of removed) console.log("  would remove", path.slice(ROOT.length + 1));
  for (const path of out.keys()) console.log("  would write ", path.slice(ROOT.length + 1));
  process.exit(0);
}

// Files only. Everything above decided what to write and checked every replacement against the
// tree, so a run either reaches here whole or has written nothing. No `git mv`: git infers a
// rename from the contents when the change is committed, and a half-finished sequence of index
// operations is a tree this script's own guard would then call finished.
const rel = (path) =>
  path
    .slice(ROOT.length + 1)
    .split("\\")
    .join("/");
for (const path of removed) {
  rmSync(path);
  // A remainder that was the only file in its folder leaves no folder behind.
  if (readdirSync(dirname(path)).length === 0) rmdirSync(dirname(path));
}
for (const [path, text] of out) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

if (!NO_FMT) {
  const files = [...out.keys()].filter((p) => p.endsWith(".rs")).map(rel);
  execFileSync("rustfmt", ["--edition", "2021", ...files], { cwd: ROOT, stdio: "inherit" });
}
console.log(`wrote ${out.size} files, removed ${removed.length}.`);
