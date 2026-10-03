// The extraction's seventh step: the scanner's session glue moves to `crates/grimoire-core`.
//
//   node scripts/core-step-7.mjs [--dry] [--no-fmt]
//
// `src-tauri/src/scanner.rs` splits in two (`scripts/lib/rs-items.mjs` cuts it into its items,
// and `inner` cuts its tests module the same way):
//
// * **To the core**, as `crates/grimoire-core/src/scanner.rs`: the session state and its lazy
//   load, the one-window lease, the assets' load order, the reader's prefs and review tray, the
//   tray's commit and the capture writer — and every test of them.
// * **Stays**, as `src-tauri/src/scanner/mod.rs` under `pub use grimoire_core::scanner::*;`:
//   what names this host — the assets `build.rs` embeds (`include_bytes!`, one directory deeper
//   now), the three request headers and the two functions that read a raw request body, the
//   `#[tauri::command]`s, and the eight tests of the request body.
//
// Rewritten as it moves, each replacement exact and counted (rule 15): `Instant` onto
// `platform::clock::Tick`; `std::fs` and a path's `.is_file()` onto `platform::files`; the
// capture's clock onto `platform::clock`; `TitleReader::load`, which reads its two files with
// `std::fs` inside the crate, onto `files::read` and `TitleReader::from_bytes` with its sentences
// kept word for word; and the session's embedded assets, which the load read through
// `Embedded::compiled()`, onto `ScannerState::carry` — the host says once what its binary
// carries. The commands reach the state through `AppState` (`state.scanner`), because the scanner
// is a field of the core's `State` now and no longer managed beside it.
//
// By hand in the same commit, as a handful of sites rather than a move: `State`'s field, both
// module maps, `desktop.rs`'s start, both manifests, the CI router, `ipc.test.ts`'s `?raw` import,
// and the two module docs.
//
// **It touches no git state**, `core-step-6b.mjs`'s rule: every replacement is checked before the
// first byte is written; then it writes, and only then removes the file that moved.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Stop if `text`'s shipped code still matches any of `patterns`. */
function mustNotName(what, text, patterns) {
  const cut = text.search(/^#\[cfg\(test\)\]\nmod tests/m);
  const shipped = code(cut < 0 ? text : text.slice(0, cut));
  for (const re of patterns) {
    const at = re.exec(shipped);
    if (!at) continue;
    const line = shipped.slice(shipped.lastIndexOf("\n", at.index) + 1, shipped.indexOf("\n", at.index));
    throw new Error(`${what} still matches ${re} in shipped code:\n${line}`);
  }
}

/** Write a block of Rust `use` lines. (Not `use…`: eslint reads that name as a React hook.) */
const importLines = (lines) => lines.map((l) => `${l}\n`).join("");

const source = read(join(DESK, "scanner.rs"));
const file = split(source);

// ---------------------------------------------------------------------------------------
// Which item goes where
// ---------------------------------------------------------------------------------------

/** What names this host and stays, besides the commands. */
const STAYS = new Set([
  "OPTIONS_HEADER",
  "CAPTURE_HEADER",
  "DETAIL_HEADER",
  "EMBEDDED_BUNDLE",
  "EMBEDDED_DETECTION",
  "EMBEDDED_RECOGNITION",
  "FramePayload",
  "frame_payload",
  "split_detail",
  "capture_payload",
]);
/** The tests of a raw request body, which name `tauri::ipc::InvokeBody` and `HeaderMap`. */
const TESTS_STAY = new Set([
  "a_raw_body_with_no_header_uses_the_default_options",
  "a_raw_body_reads_its_options_from_the_header",
  "a_detail_header_splits_the_body_into_the_frame_and_the_detail",
  "a_detail_length_that_cannot_split_the_body_is_a_sentence",
  "a_json_body_is_a_sentence_not_a_panic",
  "a_raw_capture_reads_its_sidecar_from_the_header",
  "an_escaped_card_name_comes_back_with_its_accent",
  "a_capture_header_that_is_not_visible_ascii_is_a_sentence",
]);

const isCommand = (it) => (it.attrs ?? []).some((a) => a.includes("tauri::command"));
const stays = (it) => isCommand(it) || STAYS.has(it.name);

const tests = file.items.find((it) => it.kind === "mod" && it.name === "tests");
const embeddedImpl = file.items.find((it) => it.kind === "impl" && it.name === "Embedded");
if (!tests || !embeddedImpl) throw new Error("no tests module, or no `impl Embedded`");

const coreItems = [];
const deskItems = [];
for (const it of file.items) {
  if (it.kind === "use" || it === tests) continue;
  if (it === embeddedImpl) {
    coreItems.push({ text: CORE_EMBEDDED_IMPL() });
    deskItems.push({ text: DESK_COMPILED() });
    continue;
  }
  (stays(it) ? deskItems : coreItems).push(it);
}
for (const name of STAYS) {
  if (!deskItems.some((it) => it.name === name)) throw new Error(`no item named ${name}`);
}

// The tests module, cut by test.
const body = inner(tests);
const testUses = body.items.filter((it) => it.kind === "use");
if (testUses.length !== 4) throw new Error(`expected four uses in the tests, found ${testUses.length}`);
const coreTests = body.items.filter((it) => it.kind !== "use" && !TESTS_STAY.has(it.name));
const deskTests = body.items.filter((it) => TESTS_STAY.has(it.name));
if (deskTests.length !== TESTS_STAY.size) throw new Error("a test named in TESTS_STAY is missing");

const testModule = (uses, items) =>
  body.before + importLines(uses.map((u) => `    ${u}`)) + items.map((it) => it.text).join("") + body.tail + body.after;

// ---------------------------------------------------------------------------------------
// The core's half
// ---------------------------------------------------------------------------------------

/** `impl Embedded`, less `compiled()`: what the binary carries is the host's to say. */
function CORE_EMBEDDED_IMPL() {
  return `
impl Embedded {
    /// Nothing embedded — a host that carries no assets, a desktop build without
    /// \`src-tauri/scanner-assets/\`, and every test that is about files.
    pub fn none() -> Embedded {
        Embedded {
            bundle: None,
            models: None,
        }
    }
}
`;
}

/** The two arms of \`compiled()\`, as free functions of the desktop's module. */
function DESK_COMPILED() {
  return `
/// What this build carries, for the core's [\`ScannerState::carry\`]. \`build.rs\` sets
/// \`cfg(scanner_assets)\` only when all three files are present, so a bundle is never embedded
/// without its models or the reverse.
#[cfg(scanner_assets)]
pub fn compiled() -> Embedded {
    Embedded {
        bundle: Some(EMBEDDED_BUNDLE),
        models: Some((EMBEDDED_DETECTION, EMBEDDED_RECOGNITION)),
    }
}

/// What this build carries: nothing, because \`src-tauri/scanner-assets/\` was not filled.
#[cfg(not(scanner_assets))]
pub fn compiled() -> Embedded {
    Embedded::none()
}
`;
}

const CORE_USES = importLines([
  "use std::borrow::Cow;",
  "use std::path::{Path, PathBuf};",
  "use std::sync::{Mutex, MutexGuard, OnceLock};",
  "use std::time::Duration;",
  "",
  "use card_scanner::filters::ScanFilters;",
  "use card_scanner::index::Bundle;",
  "use card_scanner::ocr::TitleReader;",
  "use card_scanner::reference::Reference;",
  "use card_scanner::session::{ScanMode, Session};",
  "use rusqlite::Connection;",
  "",
  "use crate::platform::clock::Tick;",
  "use crate::platform::files;",
]);

/** The model pair, read through `files` — `TitleReader::load`'s own reads and sentences. */
const READ_MODELS = `
/// The model pair at \`detection\` and \`recognition\`, read through [\`files\`] — what
/// \`TitleReader::load\` does with \`std::fs\` inside the crate, and with its sentences kept word
/// for word, so an asset's error names its files exactly as it always has.
fn read_models(detection: &Path, recognition: &Path) -> Result<TitleReader, String> {
    let read = |what: &str, path: &Path| {
        files::read(path).map_err(|e| format!("{what} model {}: {e}", path.display()))
    };
    let (d, r) = (
        read("detection", detection)?,
        read("recognition", recognition)?,
    );
    TitleReader::from_bytes(&d, &r).map_err(|e| {
        format!(
            "{e} ({} and {})",
            detection.display(),
            recognition.display()
        )
    })
}
`;

let core = file.header + "\n" + CORE_USES + coreItems.map((it) => it.text).join("");
core = swaps(core, [
  // The lease's clock.
  ["Instant::now()", "Tick::now()", 3],
  [": Instant", ": Tick", 4],
  // What the binary carries is said once by the host.
  [
    "    owner: Mutex<Option<Lease>>,\n}\n",
    "    owner: Mutex<Option<Lease>>,\n    /// What the host's binary carries — [`ScannerState::carry`]'s word, and [`Embedded::none`]\n    /// until it is said.\n    embedded: OnceLock<Embedded>,\n}\n",
  ],
  [
    "            owner: Mutex::new(None),\n        }\n    }\n",
    "            owner: Mutex::new(None),\n            embedded: OnceLock::new(),\n        }\n    }\n\n    /// Say what this host's binary carries — once, before any command asks for the session. A\n    /// second word is ignored: the session may already have loaded from the first, and a status\n    /// that no longer described the loaded session would be worse than none.\n    pub fn carry(&self, embedded: Embedded) {\n        let _ = self.embedded.set(embedded);\n    }\n",
  ],
  ["                Embedded::compiled(),", "                self.embedded.get().copied().unwrap_or_default(),"],
  // The desktop's commands reach both.
  ["    fn dir(&self) -> PathBuf {", "    pub fn dir(&self) -> PathBuf {"],
  [
    "    fn ensure(&self) -> Result<MutexGuard<'_, Option<Loaded>>, String> {",
    "    pub fn ensure(&self) -> Result<MutexGuard<'_, Option<Loaded>>, String> {",
  ],
  // Files, through `platform`.
  ["    let present = path.is_file();", "    let present = files::is_file(path);"],
  ["            std::fs::read(&bundle_path)", "            files::read(&bundle_path)"],
  ["                if corpus.is_file() {", "                if files::is_file(corpus) {"],
  ["        Some(TitleReader::load(&det_path, &rec_path))", "        Some(read_models(&det_path, &rec_path))"],
  [
    "            scans_dir: dir.join(\"scans\").display().to_string(),\n        },\n    }\n}\n",
    "            scans_dir: dir.join(\"scans\").display().to_string(),\n        },\n    }\n}\n" + READ_MODELS,
  ],
  ["    std::fs::create_dir_all(scans).map_err(", "    files::create_dir_all(scans).map_err("],
  [
    "    let stamp = std::time::SystemTime::now()\n        .duration_since(std::time::UNIX_EPOCH)\n        .map(|d| d.as_secs())\n        .unwrap_or(0);\n",
    "    let stamp = u64::try_from(crate::platform::clock::now_secs()).unwrap_or(0);\n",
  ],
  ["    std::fs::write(&jpg, jpeg)", "    files::write(&jpg, jpeg)"],
  [
    "    std::fs::write(&side, serde_json::to_vec_pretty(&json).unwrap_or_default())",
    "    files::write(&side, &serde_json::to_vec_pretty(&json).unwrap_or_default())",
  ],
]);
// A link to a command or a header that stayed would point at nothing from here.
core = core.replace(
  /\[`((?:set_)?scanner_\w+|frame_payload|capture_payload|OPTIONS_HEADER|CAPTURE_HEADER|DETAIL_HEADER)`\]/g,
  "`$1`",
);
let coreTestText = testModule(["use super::*;", "use crate::app_meta::set_app_meta;"], coreTests);
coreTestText = swaps(coreTestText, [
  ["Instant::now()", "Tick::now()", 9],
  ["at: Instant)", "at: Tick)", 1],
]);
core += coreTestText + file.tail;
mustNotName("scanner.rs (core)", core, [
  /\btauri\b/,
  /\bAppState\b/,
  /\bInstant\b/,
  /std::fs\b/,
  /\.is_file\(\)/,
  /SystemTime|UNIX_EPOCH/,
  /grimoire_core::/,
  /Embedded::compiled/,
]);

// ---------------------------------------------------------------------------------------
// The desktop's half
// ---------------------------------------------------------------------------------------

const DESK_HEADER = `//! The desktop's scanner commands, over a glob re-export of the core's \`scanner\` — the session
//! glue, the one-window lease, the reader's prefs and the review tray are
//! \`crates/grimoire-core/src/scanner.rs\`, and the state is the core's \`State.scanner\`.
//!
//! **What is still here names this host.** The assets \`build.rs\` embeds, under
//! \`cfg(scanner_assets)\`, which [\`compiled\`] hands the core's \`ScannerState::carry\` as the app
//! starts. The raw request body a frame and a capture arrive in: the JPEG is the body and its JSON
//! rides in a header — [\`OPTIONS_HEADER\`] for a frame, [\`CAPTURE_HEADER\`] for a capture — and
//! [\`frame_payload\`] and \`capture_payload\` read the two and refuse a JSON body in words. A frame
//! may carry a second JPEG behind the first, the same video frame at the camera's own resolution
//! for the title and collector reads, and [\`DETAIL_HEADER\`] says where the first one ends. And the
//! \`#[tauri::command]\`s, each of which admits the calling webview's label on the core's lease —
//! see \`LEASE\` and \`OPEN_ELSEWHERE\` there for which commands take it and why.
`;

const DESK_USES = importLines([
  "pub use grimoire_core::scanner::*;",
  "",
  "use std::sync::Arc;",
  "",
  "use card_scanner::filters::ScanFilters;",
  "use card_scanner::session::{FrameOptions, Verdict};",
  "use tauri::http::HeaderMap;",
  "use tauri::ipc::InvokeBody;",
  "",
  "use crate::sync::AppState;",
]);

let desk = DESK_HEADER + "\n" + DESK_USES + deskItems.map((it) => it.text).join("");
desk = swaps(desk, [
  ['include_bytes!("../scanner-assets/', 'include_bytes!("../../scanner-assets/', 3],
  // The scanner is a field of the core's state, reached through `AppState`.
  ["state: tauri::State<'_, Arc<ScannerState>>,", "state: tauri::State<'_, Arc<AppState>>,", 7],
  ["    scanner: tauri::State<'_, Arc<ScannerState>>,\n", "", 3],
  ["let _lease = scanner.admit(webview.label())?;", "let _lease = state.scanner.admit(webview.label())?;", 3],
  ["let _lease = state.admit(webview.label())?;", "let _lease = state.scanner.admit(webview.label())?;", 4],
  ["let _settled = state.admit(webview.label())?;", "let _settled = state.scanner.admit(webview.label())?;"],
  ["state.elsewhere(webview.label())", "state.scanner.elsewhere(webview.label())"],
  ["state.ensure()?", "state.scanner.ensure()?", 4],
  ['let scans = state.dir().join("scans");', 'let scans = state.scanner.dir().join("scans");'],
]);
desk += testModule(["use super::*;", "use tauri::http::HeaderMap;", "use tauri::ipc::InvokeBody;"], deskTests) + file.tail;
mustNotName("scanner/mod.rs (desktop)", desk, [/ScannerState>/, /\bInstant\b/]);

// ---------------------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------------------

const out = new Map([
  [join(CORE, "scanner.rs"), core],
  [join(DESK, "scanner/mod.rs"), desk],
]);
if (DRY) {
  console.log(`core: ${coreItems.length} items, ${coreTests.length} test items`);
  console.log(`desk: ${deskItems.length} items, ${deskTests.length} tests`);
  process.exit(0);
}
for (const [path, text] of out) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log("wrote", path.slice(ROOT.length + 1));
}
rmSync(join(DESK, "scanner.rs"));
console.log("removed src-tauri/src/scanner.rs");
if (!NO_FMT) {
  execFileSync("cargo", ["fmt", "-p", "grimoire-core", "-p", "mtg-grimoire"], { stdio: "inherit" });
}
