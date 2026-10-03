// The sync step's second part: the sync client, the entitlement and pairing move to
// `crates/grimoire-core`.
//
//   node scripts/core-step-6b.mjs [--dry] [--no-fmt]
//
// The first part restated them where they were, so this one is a move with a small rewrite: each
// file reaches the relay through `reqwest` and is rewritten onto `platform::http`, `pairing` reads
// the clock and `identity` the machine's name through `platform`, and a test-only seam in the
// client and the entitlement is gated on the `testing` feature so it reaches `src-tauri`'s tests
// as well. Every replacement is exact and has to match the number of times it says, or the run
// stops with nothing written.
//
// What it does (`scripts/lib/rs-items.mjs` cuts each file into its items):
//
// * `sync_engine/{client.rs, client/tests.rs, entitlement.rs, wire.rs, schedule.rs}` and
//   `sync_pair/identity.rs` → `crates/grimoire-core/src/`, whole.
// * `sync_engine/commands.rs` and `sync_pair/pairing.rs` split: what is a `#[tauri::command]`
//   stays, as `src-tauri/src/<module>/mod.rs` under `pub use grimoire_core::<module>::*;`, and
//   everything else — the functions, the DTOs, the tests — moves. A private item a command
//   calls becomes `pub`, because a `pub(crate)` or private item does not cross the glob.
// * `deck_tokens`' one test that named the sync client comes home to the core's `deck_tokens`.
// * Three files that read these by path follow them: `src/lib/ipc.test.ts`'s `?raw` imports, the
//   fence's list of test-only files, and `scripts/core-step-6-census.mjs`.
//
// `State`'s new field, the module maps and `AppState` are edited by hand in the same commit:
// they are a handful of sites, not a move.
//
// **It touches no git state.** Every decision is made and every replacement checked before the
// first byte is written; then it writes files, and only then removes the ones that moved. A
// rename is what git infers at commit time.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { split } from "./lib/rs-items.mjs";

const ROOT = process.cwd();
const DESK = join(ROOT, "src-tauri/src");
const CORE = join(ROOT, "crates/grimoire-core/src");
const DRY = process.argv.includes("--dry");
const NO_FMT = process.argv.includes("--no-fmt");
const B = "`";

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
const SHIPPED_MAY_NOT = [
  /\btauri\b/,
  /\bAppState\b/,
  /\breqwest\b/,
  /\btokio::/,
  /SystemTime|UNIX_EPOCH/,
  /std::env\b/,
  /cfg!\(windows\)/,
  /grimoire_core::/,
];

/** A test reads a file in the repository by a path one directory deeper than it was. */
const deeper = (text, count) =>
  swap(text, 'include_str!("../../../relay/src/', 'include_str!("../../../../relay/src/', count);

/** `src-tauri` reached the core as `grimoire_core::…`; inside the core it is `crate::…`. */
const homeImports = (text) => text.split("grimoire_core::").join("crate::");

/**
 * The HTTP client both network modules keep, onto `platform::http`: memoised in the app and
 * built per call in a test — `testing` as well as `test` now, because a test in `src-tauri` that
 * drives this module is a test too, and the memoised client is the flake the asymmetry exists
 * to end.
 */
const httpClient = (text, { read, deadline, deadlineDoc }) =>
  swaps(text, [
    [
      "#[cfg(not(test))]\nfn http() -> reqwest::Client {\n    use std::sync::OnceLock;\n    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();\n    CLIENT.get_or_init(build_http).clone()\n}",
      '#[cfg(not(any(test, feature = "testing")))]\nfn http() -> http::Client {\n    use std::sync::OnceLock;\n    static CLIENT: OnceLock<http::Client> = OnceLock::new();\n    CLIENT.get_or_init(build_http).clone()\n}',
    ],
    [
      "#[cfg(test)]\nfn http() -> reqwest::Client {\n    build_http()\n}",
      '#[cfg(any(test, feature = "testing"))]\nfn http() -> http::Client {\n    build_http()\n}',
    ],
    [
      `fn build_http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(crate::scryfall::USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(${read}))
        .build()
        .unwrap_or_default()
}`,
      `fn build_http() -> http::Client {
    http::Client::new(&http::Config {
        user_agent: crate::scryfall::USER_AGENT,
        connect_timeout: Some(Duration::from_secs(10)),
        read_timeout: Some(Duration::from_secs(${read})),
    })
    .deadline(REQUEST_DEADLINE)
}

/// **The whole of a request, where the host has no socket to bound one** — a browser, whose
/// ${B}fetch${B} has neither a connect phase nor a per-read timeout. The sync lane is held across
/// every request this module makes and a departure waits for the lane, so a request that never
/// ended would be a Leave that never ran. Natively it is not applied: the connect and read
/// bounds above already end a request that stops answering
/// ([${B}crate::platform::http::Client::deadline${B}]).
///
${deadlineDoc}
const REQUEST_DEADLINE: Duration = Duration::from_secs(${deadline});`,
    ],
  ]);

const write = new Set();

// ---------------------------------------------------------------------------------------
// sync_engine/client.rs, and its tests
// ---------------------------------------------------------------------------------------
{
  let text = read(join(DESK, "sync_engine/client.rs"));
  text = homeImports(text);
  text = httpClient(text, {
    read: 30,
    deadline: 120,
    deadlineDoc:
      "/// **Two minutes, and nobody has measured a browser against it.** A pull is unpaged and can\n/// answer tens of megabytes after a large import; the web host's phase measures what a page\n/// costs a Worker, and this is the number it starts from.",
  });
  text = swaps(text, [
    [
      `/// Classify a transport failure, so the four call sites agree about what it was.
fn kind_of(err: &reqwest::Error) -> Kind {
    if err.is_timeout() {
        Kind::Timeout
    } else if err.is_decode() {
        Kind::Parse
    } else if err.is_status() {
        Kind::Http
    } else {
        Kind::Other
    }
}`,
      `/// Classify a transport failure, so the four call sites agree about what it was.
///
/// **There is no ${B}Http${B} arm for a transport failure.** ${B}reqwest${B}'s ${B}is_status${B} is true only for
/// an error made by ${B}error_for_status${B}, which nothing here calls — a status is read off the
/// response and recorded as ${B}Kind::Http${B} where it is — so the arm never fired and did not come
/// with the move to ${B}platform::http${B}.
fn kind_of(err: &http::Error) -> Kind {
    if err.is_timeout() {
        Kind::Timeout
    } else if err.is_decode() {
        Kind::Parse
    } else {
        Kind::Other
    }
}`,
    ],
    ['.header("authorization", format!("Bearer ', '.header("authorization", &format!("Bearer ', 5],
    ["response.status().as_u16()", "response.status()", 7],
    [
      "use crate::errors::{self, Kind, Source};\n",
      "use crate::errors::{self, Kind, Source};\nuse crate::platform::http;\n",
    ],
    [
      "use serde::{Deserialize, Serialize};\n",
      "use serde::{Deserialize, Serialize};\nuse std::time::Duration;\n",
    ],
  ]);
  mustNotName("client.rs", text, SHIPPED_MAY_NOT);
  put(join(CORE, "sync_engine/client.rs"), text);
  removed.push(join(DESK, "sync_engine/client.rs"));

  let tests = read(join(DESK, "sync_engine/client/tests.rs"));
  tests = homeImports(tests);
  // The schema's own tests module is private to it; the fixture both reach is not.
  tests = swap(tests, "crate::schema::tests::deck(", "crate::schema::fixtures::deck(", 3);
  put(join(CORE, "sync_engine/client/tests.rs"), tests);
  removed.push(join(DESK, "sync_engine/client/tests.rs"));
}

// ---------------------------------------------------------------------------------------
// sync_engine/entitlement.rs
// ---------------------------------------------------------------------------------------
{
  let text = read(join(DESK, "sync_engine/entitlement.rs"));
  text = homeImports(text);
  text = httpClient(text, {
    read: 10,
    deadline: 30,
    deadlineDoc:
      "/// **Thirty seconds**: these are one small JSON body each way, and the client's own read bound is\n/// ten.",
  });
  text = swaps(text, [
    [
      "async fn refusal_of(response: reqwest::Response) -> Refusal {",
      "async fn refusal_of(response: http::Response) -> Refusal {",
    ],
    ["response.status().as_u16()", "response.status()", 1],
    [
      "use crate::sync_engine::client;\nuse crate::sync_pair::{crypto, identity};\n",
      "use crate::platform::http;\nuse crate::sync_engine::client;\nuse crate::sync_pair::{crypto, identity};\n",
    ],
    ["use serde::Deserialize;\n", "use serde::Deserialize;\nuse std::time::Duration;\n"],
  ]);
  text = deeper(text, 1);
  mustNotName("entitlement.rs", text, SHIPPED_MAY_NOT);
  put(join(CORE, "sync_engine/entitlement.rs"), text);
  removed.push(join(DESK, "sync_engine/entitlement.rs"));
}

// ---------------------------------------------------------------------------------------
// sync_engine/{wire,schedule}.rs, sync_pair/identity.rs
// ---------------------------------------------------------------------------------------
{
  let wire = deeper(homeImports(read(join(DESK, "sync_engine/wire.rs"))), 1);
  mustNotName("wire.rs", wire, SHIPPED_MAY_NOT);
  put(join(CORE, "sync_engine/wire.rs"), wire);
  removed.push(join(DESK, "sync_engine/wire.rs"));

  const schedule = homeImports(read(join(DESK, "sync_engine/schedule.rs")));
  mustNotName("schedule.rs", schedule, SHIPPED_MAY_NOT);
  put(join(CORE, "sync_engine/schedule.rs"), schedule);
  removed.push(join(DESK, "sync_engine/schedule.rs"));

  let identity = homeImports(read(join(DESK, "sync_pair/identity.rs")));
  identity = swap(
    identity,
    `fn mint_name() -> String {
    // ${B}COMPUTERNAME${B} on Windows, ${B}HOSTNAME${B} elsewhere, read straight out of the environment
    // rather than through a ${B}hostname${B} crate — one string read once per install is not worth a
    // dependency with a ${B}gethostname${B} call behind it.
    //
    // **${B}HOSTNAME${B} is a shell variable on Linux and macOS and is usually not exported to a
    // process**, so ${B}FALLBACK_DESKTOP${B} is the ordinary answer there rather than the exceptional
    // one. That is the honest trade for a portable Windows app: Windows puts ${B}COMPUTERNAME${B} in
    // every process's environment, and nobody has ever run a Linux build of this.
    const HOST_VAR: &str = if cfg!(windows) {
        "COMPUTERNAME"
    } else {
        "HOSTNAME"
    };
    let name = std::env::var(HOST_VAR)
        .map(|v| tidy(&v))
        .unwrap_or_default();`,
    `fn mint_name() -> String {
    // ${B}COMPUTERNAME${B} on Windows, ${B}HOSTNAME${B} elsewhere — [${B}crate::platform::device::name${B}],
    // which has the reasons. **${B}HOSTNAME${B} is usually not exported to a process**, so
    // ${B}FALLBACK_DESKTOP${B} is the ordinary answer on Linux and macOS rather than the exceptional
    // one, and it is the only answer in a browser, which is told no such thing.
    let name = crate::platform::device::name()
        .map(|v| tidy(&v))
        .unwrap_or_default();`,
  );
  identity = deeper(identity, 1);
  mustNotName("identity.rs", identity, SHIPPED_MAY_NOT);
  put(join(CORE, "sync_pair/identity.rs"), identity);
  removed.push(join(DESK, "sync_pair/identity.rs"));
}

// ---------------------------------------------------------------------------------------
// The two files that split: what is a command stays.
// ---------------------------------------------------------------------------------------

/** The item's first line that declares it, with `pub ` put in front, when it has no `pub`. */
function madePub(item) {
  if (/^pub\b/m.test(item.vis ?? "") || item.vis === "pub") return item.text;
  const lines = item.text.split("\n");
  const at = lines.findIndex((l) => /^(async fn|fn|const|static|struct|enum|type) /.test(l));
  if (at < 0) throw new Error(`no declaration line in ${item.name}`);
  lines[at] = "pub " + lines[at];
  return lines.join("\n");
}

/**
 * Split `file`'s items into the commands and the rest. Every top-level `use` belongs to neither —
 * each half writes its own — and the test module moves. A moved item a command names becomes
 * `pub`.
 */
function splitCommands(what, text) {
  const file = split(text);
  const isCommand = (it) => (it.attrs ?? []).some((a) => a.includes("tauri::command"));
  const stay = file.items.filter(isCommand);
  const move = file.items.filter((it) => !isCommand(it) && it.kind !== "use");
  const uses = file.items.filter((it) => it.kind === "use");
  const commands = stay.map((it) => it.text).join("");
  const moved = move.map((it) =>
    it.name && it.kind !== "mod" && new RegExp(`\\b${it.name}\\b`).test(code(commands)) ? madePub(it) : it.text,
  );
  if (!stay.length) throw new Error(`${what}: no commands`);
  return { header: file.header, uses, stay, moved, tail: file.tail };
}

/** Write a block of Rust `use` lines. (Not `useBlock`: eslint reads a `use…` name as a React hook.) */
const importLines = (lines) => lines.map((l) => `${l}\n`).join("");

// sync_engine/commands.rs
{
  const text = read(join(DESK, "sync_engine/commands.rs"));
  const parts = splitCommands("commands.rs", text);
  // The core half: the module doc, its own imports, everything but the commands.
  const coreUses = importLines([
    "use crate::sync_engine::client;",
    "use crate::sync_engine::entitlement;",
    "use crate::sync_pair::{crypto, identity};",
    "use rusqlite::Connection;",
    "use serde::Serialize;",
  ]);
  let core = parts.header + "\n" + coreUses + parts.moved.join("") + parts.tail;
  core = homeImports(core);
  mustNotName("commands.rs (core)", core, SHIPPED_MAY_NOT);
  put(join(CORE, "sync_engine/commands.rs"), core);

  const desk =
    `//! The sync commands: the ${B}#[tauri::command]${B} wrappers over ${B}grimoire_core::sync_engine::commands${B},
//! whose functions and DTOs they call through the glob below. The relay socket's state is the
//! one thing here that is not the core's: it is ${B}super::live${B}'s.

pub use grimoire_core::sync_engine::commands::*;

` +
    importLines([
      "use crate::sync::{self, AppState};",
      "use crate::sync_engine::client::{self, RelayOutcome};",
      "use crate::sync_engine::entitlement;",
      "use crate::sync_engine::live::{self, LiveState};",
      "use grimoire_core::state::Store;",
      "use std::sync::Arc;",
      "use tauri::Emitter;",
    ]) +
    parts.stay.map((it) => it.text).join("");
  put(join(DESK, "sync_engine/commands/mod.rs"), desk);
  removed.push(join(DESK, "sync_engine/commands.rs"));
}

// sync_pair/pairing.rs
{
  let text = read(join(DESK, "sync_pair/pairing.rs"));
  // The clock comes from `platform`; the wrapper that reads it does too.
  text = swaps(text, [
    [
      `/// Now, in unix milliseconds.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
`,
      "",
    ],
    ["expires_at: now_ms() + RENDEZVOUS_TTL_MS,", "expires_at: crate::platform::clock::now_ms() + RENDEZVOUS_TTL_MS,", 2],
    ["    let now = now_ms();\n", "    let now = grimoire_core::platform::clock::now_ms();\n"],
    // A command's own sentence for a failure, rather than a private helper across the glob.
    ["identity::rename_device(conn, &device_id, &name).map_err(err)", "identity::rename_device(conn, &device_id, &name).map_err(|e| e.to_string())"],
    ["async fn leave(state: &grimoire_core::state::State)", "pub async fn leave(state: &grimoire_core::state::State)"],
  ]);
  const parts = splitCommands("pairing.rs", text);
  const banner = parts.uses.find((u) => /use crate::sync::\{self, AppState\};/.test(u.text));
  if (!banner) throw new Error("pairing.rs: the commands' banner");
  const coreUses = importLines([
    "use crate::state::{Lane, Store};",
    "use crate::sync_engine::client;",
    "use crate::sync_engine::commands;",
    "use crate::sync_engine::entitlement;",
    "use crate::sync_pair::crypto;",
    "use crate::sync_pair::identity;",
    "use crate::sync_pair::invite::{Invite, QrMatrix};",
    "use rusqlite::Connection;",
    "use serde::Serialize;",
  ]);
  let core = parts.header + "\n" + coreUses + parts.moved.join("") + parts.tail;
  core = homeImports(core);
  // The tests read the clock the shipped code now reads, and took `Arc` from imports the
  // shipped half no longer needs.
  const bare = core.match(/(?<![:\w])now_ms\(\)/g) ?? [];
  if (bare.length !== 23) throw new Error(`pairing.rs: ${bare.length} bare now_ms() in the tests, wanted 23`);
  core = core.replace(/(?<![:\w])now_ms\(\)/g, "crate::platform::clock::now_ms()");
  core = swap(core, "    use std::sync::Mutex;\n", "    use std::sync::{Arc, Mutex};\n");
  mustNotName("pairing.rs (core)", core, SHIPPED_MAY_NOT);
  put(join(CORE, "sync_pair/pairing.rs"), core);

  const desk =
    `//! The pairing commands: the ${B}#[tauri::command]${B} wrappers over ${B}grimoire_core::sync_pair::pairing${B},
//! whose state machine, departure and removal they call through the glob below.

pub use grimoire_core::sync_pair::pairing::*;
` +
    banner.text.replace("use crate::sync::{self, AppState};", "use crate::sync::{self, AppState};\nuse crate::sync_pair::identity;\nuse std::sync::Arc;") +
    parts.stay.map((it) => it.text).join("");
  put(join(DESK, "sync_pair/pairing/mod.rs"), desk);
  removed.push(join(DESK, "sync_pair/pairing.rs"));
}

// ---------------------------------------------------------------------------------------
// deck_tokens: the test that named the sync client comes home.
// ---------------------------------------------------------------------------------------
{
  const deskPath = join(DESK, "deck_tokens/mod.rs");
  const desk = read(deskPath);
  const at = desk.indexOf("/// The tests of `deck_tokens` that name something this crate still holds.");
  if (at < 0) throw new Error("deck_tokens: the staying tests");
  const block = desk.slice(at);
  const start = block.indexOf("    /// **A paired device converts nothing at launch until a pull at v52 has landed");
  const end = block.lastIndexOf("\n}\n");
  if (start < 0 || end < 0) throw new Error("deck_tokens: the test");
  const test = block.slice(start, end + 1);
  put(deskPath, desk.slice(0, at).replace(/\n+$/, "\n"));

  const corePath = join(CORE, "deck_tokens.rs");
  const core = read(corePath);
  const fixtures = core.indexOf("\n/// ", core.indexOf("\n}\n", core.indexOf("#[cfg(test)]\nmod tests {")));
  const close = core.indexOf("\n}\n", core.indexOf("#[cfg(test)]\nmod tests {"));
  if (close < 0 || fixtures < 0) throw new Error("deck_tokens: the core's test module");
  put(corePath, core.slice(0, close + 1) + "\n" + test + core.slice(close + 1));
}

// ---------------------------------------------------------------------------------------
// The files that read these by path.
// ---------------------------------------------------------------------------------------
{
  const path = join(ROOT, "src/lib/ipc.test.ts");
  let text = read(path);
  text = swaps(text, [
    [
      'import syncClientRs from "../../src-tauri/src/sync_engine/client.rs?raw";\nimport syncCommandsRs from "../../src-tauri/src/sync_engine/commands.rs?raw";\n',
      'import syncClientRs from "../../crates/grimoire-core/src/sync_engine/client.rs?raw";\nimport syncCommandsRsCore from "../../crates/grimoire-core/src/sync_engine/commands.rs?raw";\nimport syncCommandsRsDesktop from "../../src-tauri/src/sync_engine/commands/mod.rs?raw";\n',
    ],
  ]);
  // The name every assertion already reads, joined from the two halves (5c's `combosRs`).
  const anchor = text.indexOf("\n", text.lastIndexOf("\nimport ")) + 1;
  text =
    text.slice(0, anchor) +
    "\n// `sync_engine::commands` is two files since the sync step: the functions and DTOs in the core,\n// the `#[tauri::command]` wrappers in `src-tauri`.\nconst syncCommandsRs = syncCommandsRsCore + \"\\n\" + syncCommandsRsDesktop;\n" +
    text.slice(anchor);
  put(path, text);

  const fence = join(CORE, "platform/fence.rs");
  let f = read(fence);
  f = swaps(f, [
    [
      '                "src/sync_engine/apply/tests.rs"\n            ],',
      '                "src/sync_engine/apply/tests.rs",\n                "src/sync_engine/client/tests.rs"\n            ],',
    ],
    [
      "        // The two files that are test code throughout were found by reading their parents,",
      "        // The files that are test code throughout were found by reading their parents,",
    ],
  ]);
  put(fence, f);

  const census = join(ROOT, "scripts/core-step-6-census.mjs");
  let c = read(census);
  c = swaps(c, [
    [
      `/** The eight files the sync client, the entitlement and pairing are, under ${B}src-tauri/src${B}. */
export const FILES = [
  "sync_engine/client.rs",
  "sync_engine/entitlement.rs",
  "sync_engine/live.rs",
  "sync_engine/schedule.rs",
  "sync_engine/commands.rs",
  "sync_engine/wire.rs",
  "sync_pair/identity.rs",
  "sync_pair/pairing.rs",
];`,
      `/**
 * The files the sync client, the entitlement and pairing are, from the repository's root: in the
 * core since the sync step's second part, but for the connection manager and the two modules'
 * command wrappers, which are the desktop's.
 */
export const FILES = [
  "crates/grimoire-core/src/sync_engine/client.rs",
  "crates/grimoire-core/src/sync_engine/entitlement.rs",
  "src-tauri/src/sync_engine/live.rs",
  "crates/grimoire-core/src/sync_engine/schedule.rs",
  "crates/grimoire-core/src/sync_engine/commands.rs",
  "src-tauri/src/sync_engine/commands/mod.rs",
  "crates/grimoire-core/src/sync_engine/wire.rs",
  "crates/grimoire-core/src/sync_pair/identity.rs",
  "crates/grimoire-core/src/sync_pair/pairing.rs",
  "src-tauri/src/sync_pair/pairing/mod.rs",
];`,
    ],
    ["readFileSync(`${root}/src-tauri/src/${name}`, \"utf8\")", "readFileSync(`${root}/${name}`, \"utf8\")"],
  ]);
  put(census, c);
}

// ---------------------------------------------------------------------------------------
// Write, then remove, then format.
// ---------------------------------------------------------------------------------------
for (const [path] of out) {
  if (!existsSync(dirname(path)) && DRY) console.log(`would make ${dirname(path)}`);
}
if (DRY) {
  for (const path of out.keys()) console.log(`would write ${path.slice(ROOT.length + 1)}`);
  for (const path of removed) console.log(`would remove ${path.slice(ROOT.length + 1)}`);
  process.exit(0);
}
for (const [path, text] of out) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  write.add(path);
}
for (const path of removed) {
  if (!out.has(path)) rmSync(path);
}
if (!NO_FMT) {
  try {
    execFileSync("cargo", ["fmt", "-p", "grimoire-core", "-p", "mtg-grimoire"], { stdio: "inherit" });
  } catch {
    console.error(
      "rustfmt failed: every file is written, so finish with `cargo fmt -p grimoire-core -p mtg-grimoire` once it compiles",
    );
  }
}
console.log(`wrote ${out.size} files, removed ${removed.length}`);
