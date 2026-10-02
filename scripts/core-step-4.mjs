// The shared core's step 4: the domain cluster, moved out of `src-tauri` into
// `crates/grimoire-core` by one pass over the tree.
//
//   node scripts/core-step-4.mjs          # move, then `cargo fmt` both crates
//   node scripts/core-step-4.mjs --dry    # say what would stay, move and widen; write nothing
//
// `--dry` covers the modules. The once-steps at the foot — `with_write`, `prepare_database`, the
// tests that go home, the TypeScript imports — only run for real.
//
// The plan is `docs/superpowers/plans/2026-10-02-light-app-core-step-4-domain.md`, and it has
// the reason for every list below.
//
// **What it does to one module.** The file is cut into its top-level items
// (`scripts/lib/rs-items.mjs`). An item *stays* in `src-tauri` when it is a `#[tauri::command]`
// wrapper, when its code names the desktop (`tauri::`, `AppState`, a window), when it is on
// `FORCE_STAY`, or when it is a private helper only staying items call. Everything else goes to
// `crates/grimoire-core/src/<module>.rs`, tests included — except a test that names something
// that stays, which stays too. What is left is written to `src-tauri/src/<module>/mod.rs` under
// `pub use grimoire_core::<module>::*;`, so `crate::<module>::…` in `src-tauri` resolves as it
// did and no caller is edited.
//
// **Re-runnable.** A module whose file is already gone from `src-tauri/src` is skipped, and each
// one-off step below checks whether it has been done. So a second run changes nothing, and a
// branch that edited a moved file runs this *before* it merges `main`: both sides have then made
// the same move. What is left to merge is what the branch changed — **and the few files `main`
// edited by hand after its own run** (the plan names them), where `main`'s side is taken.
//
// It is a text transformation and it is checked by the compiler, not by itself: a cut in the
// wrong place, a path it did not rewrite and a visibility it did not widen are each a compile
// error in one of the two crates.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { code, inner, printUse, split, leavesOf } from "./lib/rs-items.mjs";

const ROOT = process.cwd();
const DESK = join(ROOT, "src-tauri/src");
const CORE = join(ROOT, "crates/grimoire-core/src");
const DRY = process.argv.includes("--dry");
const NO_FMT = process.argv.includes("--no-fmt");
const VERBOSE = process.argv.includes("--verbose");

// ── What moves ─────────────────────────────────────────────────────────────────────────────

/** Top-level modules, each one file. */
const TOP = [
  "activity", "bulk_undo", "card", "collection", "collection_alloc", "collection_folders",
  "collection_source", "deck", "deck_audit", "deck_completion", "deck_meta", "deck_missing",
  "deck_notes", "deck_pull", "deck_query", "deck_quick_add", "deck_theory", "deck_todos",
  "deck_tokens", "deck_undo", "deckpane", "decksort", "home", "import", "listview", "maintenance",
  "managed_wishlist", "markcolors", "marketplace", "nav", "new_printings", "price_history",
  "recent_cards", "reset", "search", "searchopen", "set_completion", "shelffolds", "stackhide",
  "startview", "sticky_notes", "upcoming_sets", "value_history", "wishlist", "wishlist_folders",
  "wishlist_optimize", "zoom",
];

/** Modules inside a directory `src-tauri` keeps. `with` are the files declared from inside. */
const NESTED = [
  { id: "sync_engine::apply", file: "sync_engine/apply.rs", with: ["sync_engine/apply/tests.rs", "sync_engine/apply/rehome.rs"] },
  { id: "sync_engine::baseline", file: "sync_engine/baseline.rs", with: [] },
];

const MODULES = [...TOP.map((id) => ({ id, file: `${id}.rs`, with: [] })), ...NESTED];

/**
 * Rule 8: a function that names a later step's code stays behind, alone. The desktop's own
 * markers find most of what stays; these name nothing the sweep can see.
 */
const FORCE_STAY = {
  // `combos::match_combos` — `combos` is a feed and moves with the I/O step.
  deck: ["DeckBracketRead", "bracket_reads"],
  // `images::Cache`, and the three feeds' `any_refresh_running`.
  reset: ["clear_cache", "cache_clear_refusal"],
  // A path the desktop's file dialog answered: a host reads its own file.
  import: ["read_import_file"],
};

/**
 * The three places a moved body is edited rather than moved, as exact text. Each is refused if
 * its text is not there, so a branch that changed one of these lines hears about it.
 */
const PATCHES = {
  // `std::thread::sleep` panics in a browser; `platform::pause` is that call natively.
  maintenance: [["std::thread::sleep(RECLAIM_YIELD);", "crate::platform::pause(RECLAIM_YIELD);"]],
  // A dependency's `cfg(test)` is off while another crate's tests build, so a behaviour that
  // switches on it follows the `testing` feature instead (the core's rule 11).
  bulk_undo: [
    ["#[cfg(not(test))]\nfn with_store", '#[cfg(not(any(test, feature = "testing")))]\nfn with_store'],
    ["#[cfg(test)]\nfn with_store", '#[cfg(any(test, feature = "testing"))]\nfn with_store'],
  ],
};

/**
 * What `src-tauri` reaches without spelling its name, so the sweep cannot see it: a type a
 * closure parameter infers.
 */
const WIDEN = {
  // `bulk_undo`'s wrapper asks `with_store(|s| s.table_of(id))`: it never spells `Store`.
  bulk_undo: ["Store", "Store.table_of"],
};

/** `crate::sync::…` names that are the core's by another path. */
const SYNC_HOME = {
  get_meta: "crate::sync_meta::get_meta",
  set_meta: "crate::sync_meta::set_meta",
  set_meta_opt: "crate::sync_meta::set_meta_opt",
  with_write: "crate::state::with_write",
  with_write_waiting: "crate::state::with_write_waiting",
  lock_plain: "crate::db::lock_plain",
};

/** What already lives in the core under a directory `src-tauri` still has. */
const CORE_NESTED = {
  sync_engine: ["capture", "hlc", "merge"],
  sync_pair: ["crypto", "invite"],
  index: ["bitset"],
};

/** Items of a module the core holds that are still `src-tauri`'s. */
const DESK_ITEMS = { schema: ["prepare_data_dir"], errors: ["kind_of"] };

/** A trait is used through its methods; its name appears nowhere. */
const TRAIT_METHODS = {
  OptionalExtension: /\.optional\(\)/,
  Read: /\.read(_to_end|_to_string|_exact)?\(|\.take\(|\.bytes\(\)/,
  Write: /\.write(_all)?\(|\.flush\(\)|\bwrite!\(|\bwriteln!\(/,
  BufRead: /\.lines\(\)|\.read_line\(|\.read_until\(/,
  Seek: /\.seek\(|\.rewind\(\)/,
  Emitter: /\.emit(_to)?\(/,
  Manager: /\.(state|try_state|manage|get_webview_window|webview_windows|path|app_handle)\(/,
  Hasher: /\.finish\(\)/,
  Hash: /\.hash\(/,
  Digest: /::digest\(|\.update\(|\.finalize\(\)/,
  FromStr: /::from_str\(|\.parse(::<[^>]*>)?\(\)/,
  Deserialize: /\bDeserialize\b|::deserialize\(/,
  Serialize: /\bSerialize\b|\.serialize\(/,
};

// ── Small things ───────────────────────────────────────────────────────────────────────────

const read = (p) => readFileSync(p, "utf8");
const DESKTOP_RE = /\btauri::|\btauri_plugin\w*::|\bAppHandle\b|\bWebviewWindow\b|\bAppState\b/;
const isCommand = (it) => it.attrs.some((a) => /#\[tauri::command/.test(a));
const isTestGated = (it) => it.attrs.some((a) => /#\[cfg\(test\)\]/.test(a));
const isTestFn = (it) => it.attrs.some((a) => /#\[(tokio::)?test\b/.test(a));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (name) => new RegExp(`(?<![A-Za-z0-9_])${esc(name)}(?![A-Za-z0-9_])`);
/** A free function called or passed by name — not a method of the same name. */
const called = (name) => new RegExp(`(?<![A-Za-z0-9_.])${esc(name)}(?:\\s*(?:::<[^>]*>)?\\s*\\(|\\s*[,)])`);
/**
 * What an item names: its code, plus the identifiers its format strings capture — `"{GRAIN}"`
 * is a reference the compiler resolves, inside a literal `code` blanks.
 */
const refs = (text) =>
  code(text) + "\n" + [...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)(?=[}:])/g)].map((m) => m[1]).join(" ");
const names = (it, text) => (it.kind === "fn" ? called(it.name) : word(it.name)).test(text);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".rs")) out.push(p);
  }
  return out;
}

const rel = (p, base) => p.slice(base.length + 1).replace(/\\/g, "/");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] }).toString();

// ── Reading the tree ───────────────────────────────────────────────────────────────────────

const pending = MODULES.filter((m) => existsSync(join(DESK, m.file)));
const MOVING = new Set(MODULES.map((m) => m.id));
const coreTop = new Set(
  [...read(join(CORE, "lib.rs")).matchAll(/^pub mod (\w+);/gm)].map((m) => m[1]),
);

/** module id → the names of its items that stay in `src-tauri`. */
const stayNames = new Map();
for (const [id, list] of Object.entries(DESK_ITEMS)) stayNames.set(id, new Set(list));
// A module an earlier run moved: what stayed of it is what its remainder defines. Without this
// a second run would read `deck::bracket_reads` as the core's and send a test of it home.
for (const m of MODULES) {
  const remainder = join(DESK, m.id.replace(/::/g, "/"), "mod.rs");
  if (existsSync(join(DESK, m.file)) || !existsSync(remainder)) continue;
  const defined = split(read(remainder)).items.filter((i) => i.name && i.kind !== "impl" && !isTestGated(i));
  stayNames.set(m.id, new Set(defined.map((i) => i.name)));
}

/** Whether `crate::a::b::c` names something the core holds once this step has run. */
function available(path) {
  const p = path.split("::");
  if (p[0] !== "crate") return true;
  const [, a, b, c] = p;
  if (a === undefined) return true;
  if (a === "sync") return b in SYNC_HOME;
  if (a in CORE_NESTED) {
    if (CORE_NESTED[a].includes(b)) return true;
    const id = `${a}::${b}`;
    return MOVING.has(id) && !stayNames.get(id)?.has(c);
  }
  if (MOVING.has(a) || coreTop.has(a)) return !stayNames.get(a)?.has(b);
  return false;
}

/** Every `crate::…` path spelled in `c` (code, comments already blanked), groups expanded. */
function cratePaths(c) {
  const out = [];
  const re = /\bcrate::/g;
  let m;
  while ((m = re.exec(c))) {
    const at = m.index + m[0].length;
    const mm = /^[A-Za-z0-9_:]*/.exec(c.slice(at));
    const head = mm[0].replace(/::$/, "");
    const after = c.slice(at + mm[0].length);
    if (mm[0].endsWith("::") || mm[0] === "") {
      if (after[0] === "{") {
        let depth = 0;
        let j = 0;
        for (; j < after.length; j++) {
          if (after[j] === "{") depth++;
          else if (after[j] === "}" && --depth === 0) break;
        }
        for (const leaf of leavesOf(after.slice(1, j))) out.push(`crate::${head ? head + "::" : ""}${leaf.path}`);
        continue;
      }
    }
    if (head) out.push(`crate::${head}`);
  }
  return out;
}

/** The `use` item's parts: what precedes the declaration, its visibility, and its tree. */
function parseUse(it) {
  const m = /^([\s\S]*?)^([ \t]*)((?:pub(?:\([^)]*\))?\s+)?)use\s+([\s\S]*?);([^\n]*\n?)$/m.exec(it.text);
  if (!m) throw new Error(`not a use: ${it.text}`);
  return { lead: m[1], indent: m[2], vis: m[3], leaves: leavesOf(m[4]), trail: m[5] };
}

function usedIn(leaf, hay) {
  if (leaf.name === "*") return true;
  if (leaf.name === "_") return true;
  // Not behind a `::` — `std::sync::Mutex::new(…)` spells the type and uses no import.
  if (new RegExp(`(?<![A-Za-z0-9_])(?<!::)${esc(leaf.name)}(?![A-Za-z0-9_])`).test(hay)) return true;
  const trait = TRAIT_METHODS[leaf.path.split("::").pop()];
  return trait ? trait.test(hay) : false;
}

/** A path as the core spells it. */
function rehome(path) {
  const p = path.split("::");
  if (p[0] === "crate" && p[1] === "sync" && p[2] in SYNC_HOME) return [SYNC_HOME[p[2]], ...p.slice(3)].join("::");
  if (p[0] === "crate" && p[1] === "schema" && p[2] === "tests") return ["crate::schema::fixtures", ...p.slice(3)].join("::");
  if (p[0] === "grimoire_core") return ["crate", ...p.slice(1)].join("::");
  return path;
}

/** The same, over code: only where the text is code, never in a comment or a string. */
function rehomeCode(text) {
  const c = code(text);
  const edits = [];
  const re = /\bcrate::sync::(\w+)|\bcrate::schema::tests\b|\bgrimoire_core::/g;
  let m;
  while ((m = re.exec(c))) {
    if (m[0] === "grimoire_core::") edits.push([m.index, m[0].length, "crate::"]);
    else if (m[0] === "crate::schema::tests") edits.push([m.index, m[0].length, "crate::schema::fixtures"]);
    else if (m[1] in SYNC_HOME) edits.push([m.index, m[0].length, SYNC_HOME[m[1]]]);
  }
  let out = text;
  for (const [at, len, to] of edits.reverse()) out = out.slice(0, at) + to + out.slice(at + len);
  return out;
}

/**
 * A `use` item kept to the leaves `hay` names. Returns the text to write and the leaves it
 * dropped. An item whose every leaf is kept, with no path to rewrite, is returned as it stood.
 */
function filterUse(it, hay, { toCore }) {
  const u = parseUse(it);
  if (u.vis) {
    // A re-export is API, not a convenience: kept whole.
    return { text: toCore ? rehomeCode(it.text) : it.text, dropped: [] };
  }
  const kept = u.leaves.filter((l) => usedIn(l, hay));
  const dropped = u.leaves.filter((l) => !usedIn(l, hay));
  if (kept.length === 0) return { text: "", dropped };
  const moved = toCore ? kept.map((l) => ({ ...l, path: rehome(l.path) })) : kept;
  const unchanged = dropped.length === 0 && moved.every((l, i) => l.path === kept[i].path);
  if (unchanged) return { text: it.text, dropped };
  // A leaf the core now reaches under another module cannot share its old statement's prefix.
  return { text: `${u.lead}${u.indent}use ${printUse(moved)};${u.trail || "\n"}`, dropped };
}

// ── Classifying one module ─────────────────────────────────────────────────────────────────

function load(mod) {
  const text = read(join(DESK, mod.file));
  if (text.includes("\r\n")) throw new Error(`${mod.file} has CRLF line endings`);
  const parsed = split(text);
  const items = parsed.items.map((it) => ({ ...it, c: refs(it.text) }));
  for (const it of items) {
    if (isTestGated(it)) it.role = "test";
    else if (it.kind === "use") it.role = "use";
    else if (isCommand(it) || DESKTOP_RE.test(it.c) || FORCE_STAY[mod.id]?.includes(it.name)) it.role = "stay";
    else it.role = "core";
  }
  // The `impl` of a type that stays, stays.
  const stayTypes = new Set(items.filter((i) => i.role === "stay" && /^(struct|enum)$/.test(i.kind)).map((i) => i.name));
  for (const it of items) if (it.kind === "impl" && stayTypes.has(it.name)) it.role = "stay";
  const testMod = items.find((i) => i.role === "test" && i.kind === "mod" && /\{/.test(i.c));
  const body = testMod ? inner(testMod) : null;
  const ins = body ? body.items.map((it) => ({ ...it, c: refs(it.text) })) : [];
  return { ...mod, parsed, items, testMod, body, ins };
}

/** Top-level imports and the test module's own, as name → path. */
function importsOf(m) {
  const map = new Map();
  const add = (it) => {
    for (const l of parseUse(it).leaves) if (l.name !== "*") map.set(l.name, l.path);
  };
  for (const it of m.items) if (it.kind === "use") add(it);
  for (const it of m.ins) if (it.kind === "use") add(it);
  return map;
}

/**
 * Decide where each item of a test module goes. `taint` is why it cannot live in the core; `copy`
 * marks a helper the tainted ones call; `gone` marks a `copy` nothing left in the core calls.
 * So: tainted, or `copy && gone` — `src-tauri`; `copy && !gone` — a fixture both sides reach;
 * neither — the core's `mod tests`.
 */
function splitTests(ins, stay, imports) {
  const taintOf = (it) => {
    if (DESKTOP_RE.test(it.c)) return "the desktop";
    for (const n of stay) if (word(n).test(it.c)) return n;
    for (const p of cratePaths(it.c)) if (!available(p)) return p;
    for (const [name, path] of imports) {
      if (!word(name).test(it.c)) continue;
      if (path.startsWith("tauri")) return path;
      if (path.startsWith("crate::") && !available(path)) return path;
      if (path.startsWith("super::") && stay.has(path.split("::")[1])) return path;
    }
    return null;
  };
  for (const it of ins) {
    it.taint = it.kind === "use" ? null : taintOf(it);
  }
  // A helper that cannot move takes the tests that call it.
  for (let grew = true; grew; ) {
    grew = false;
    for (const helper of ins) {
      if (!helper.taint || !helper.name || helper.kind === "use" || isTestFn(helper)) continue;
      for (const it of ins) {
        if (it === helper || it.taint || it.kind === "use") continue;
        if (names(helper, it.c)) {
          it.taint = `${helper.name}()`;
          grew = true;
        }
      }
    }
  }
  // What the staying tests need a copy of.
  const staying = ins.filter((i) => i.taint);
  for (const it of ins) it.copy = false;
  for (let grew = true; grew; ) {
    grew = false;
    const hay = [...staying, ...ins.filter((i) => i.copy)].map((i) => i.c).join("\n");
    for (const it of ins) {
      if (it.taint || it.copy || it.kind === "use" || !it.name || isTestFn(it)) continue;
      if (names(it, hay)) {
        it.copy = true;
        grew = true;
      }
    }
  }
  // A helper only the staying tests called has no caller left in the core.
  for (const it of ins) it.gone = false;
  for (let grew = true; grew; ) {
    grew = false;
    const left = ins.filter((i) => !i.taint && !i.gone && i.kind !== "use");
    for (const it of left) {
      if (!it.copy || isTestFn(it) || !it.name) continue;
      const hay = left.filter((o) => o !== it).map((o) => o.c).join("\n");
      if (!names(it, hay)) {
        it.gone = true;
        grew = true;
      }
    }
  }
}

/** Bring one module's stay set, and its tests' split, to a fixed point. Returns whether it grew. */
function settle(m) {
  const before = stayNames.get(m.id)?.size ?? -1;
  const stay = new Set(m.items.filter((i) => i.role === "stay" && i.name && i.kind !== "impl").map((i) => i.name));
  stayNames.set(m.id, stay);
  splitTests(m.ins, stay, importsOf(m));

  // A private helper only staying items call stays with them.
  const coreTests = m.ins.filter((i) => !i.taint && !i.gone).map((i) => i.c).join("\n");
  for (let grew = true; grew; ) {
    grew = false;
    for (const it of m.items) {
      if (it.role !== "core" || it.vis !== "" || !it.name || it.kind === "impl" || it.kind === "mod") continue;
      const others = m.items.filter((o) => o !== it && !(o.kind === "impl" && o.name === it.name));
      const byCore = others.some((o) => (o.role === "core" || (o.role === "test" && o !== m.testMod)) && names(it, o.c));
      const byStay = others.some((o) => o.role === "stay" && names(it, o.c));
      if (!byCore && byStay && !names(it, coreTests)) {
        it.role = "stay";
        stay.add(it.name);
        for (const o of m.items) if (o.kind === "impl" && o.name === it.name) o.role = "stay";
        grew = true;
      }
    }
  }
  return stay.size !== before;
}

// ── Writing one module ─────────────────────────────────────────────────────────────────────

const corePath = (m) => m.id.replace(/::/g, "/");

/**
 * Why a module keeps something in `src-tauri` that is not a command wrapper — the sentence its
 * remainder's doc carries. Every line under 100 columns: rustfmt does not wrap a comment.
 */
const REMAINDER_NOTES = {
  deck:
    "//! [`bracket_reads`] and [`DeckBracketRead`] are here for a different reason: they name `combos`,\n" +
    "//! a feed, which moves with the extraction's I/O step. They go home with it.\n",
  reset:
    "//! [`clear_cache`] and what only it calls are here for a different reason: they name\n" +
    "//! `images::Cache` and the three feeds, which move with the extraction's I/O step.\n",
  import:
    "//! [`read_import_file`] is here for a different reason, and for good: it reads a path the\n" +
    "//! desktop's own file dialog answered, and a host reads its own file.\n",
  collection_source:
    "//! [`with_write_owned`] is the core's `with_write` plus the facet index's `owned` rebuild, and\n" +
    "//! the index's lifecycle moves with the extraction's I/O step.\n",
  marketplace:
    "//! [`set_marketplace_now`] is here for good: it tells the plain-text mirror, which is the\n" +
    "//! desktop's.\n",
  maintenance:
    "//! The tests are the ones over a database `split` converted from a single file, which only the\n" +
    "//! desktop has ever had.\n",
};

function remainderHeader(m, hasItems) {
  const note = REMAINDER_NOTES[m.id];
  return (
    `//! **The desktop's half of \`${m.id}\`.**\n` +
    "//!\n" +
    "//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this\n" +
    "//! one reaches that crate's item — except for what is defined below, because an item a module\n" +
    "//! defines shadows a glob import of the same name." +
    (hasItems
      ? " What is below names a window or the\n//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.\n"
      : " Nothing of the module's code is left\n//! here: what is below are the tests of it that name something this crate still holds.\n") +
    (note ? "//!\n" + note : "") +
    "\n"
  );
}

/** Build both halves of one module. Writes nothing. */
function build(m) {
  const stayItems = m.items.filter((i) => i.role === "stay");
  const stayCode = stayItems.map((i) => i.c).join("\n");
  const coreCode = m.items
    .filter((i) => i.role === "core" || (i.role === "test" && i !== m.testMod))
    .map((i) => i.c)
    .join("\n");

  // A test-module item goes one of three ways: it stays in the core's `mod tests`; it goes to
  // the remainder's (it names what stays, or only such tests called it); or — a helper both
  // sides call — it becomes a fixture at the foot of the core file, behind `testing`.
  const fixtureIns = m.ins.filter((i) => i.kind !== "use" && i.copy && !i.gone && !i.taint);
  const coreTestIns = m.ins.filter((i) => i.kind !== "use" && !i.taint && !i.gone && !i.copy);
  const stayTestIns = m.ins.filter((i) => i.kind !== "use" && (i.taint || (i.copy && i.gone)));
  const coreTestCode = coreTestIns.map((i) => i.c).join("\n");
  const stayTestCode = stayTestIns.map((i) => i.c).join("\n");
  const fixtureCode = fixtureIns.map((i) => i.c).join("\n");
  const testImports = new Set();
  for (const it of m.ins) if (it.kind === "use") for (const l of parseUse(it).leaves) testImports.add(l.name);

  // What each half's top-level imports lose, and the desktop half's own copy of them.
  let deskUses = "";
  const coreDropped = [];
  const deskDropped = [];
  for (const it of m.items) {
    if (it.role !== "use") continue;
    coreDropped.push(...filterUse(it, coreCode, { toCore: true }).dropped);
    // A re-export is the core module's API, and the remainder's glob already carries it.
    if (parseUse(it).vis) continue;
    const d = filterUse(it, stayCode, { toCore: false });
    deskUses += d.text;
    deskDropped.push(...d.dropped);
  }
  const testUses = (list, hay, dropped, toCore, { skipSuperGlob = false } = {}) => {
    let out = "";
    for (const it of list) {
      if (it.kind !== "use") continue;
      if (skipSuperGlob && /^\s*use super::\*;\s*$/.test(it.text)) continue;
      out += filterUse(it, hay, { toCore }).text;
    }
    // What the tests reached through `use super::*` and the half above them no longer imports.
    for (const l of dropped) {
      if (l.name === "*" || testImports.has(l.name) || !usedIn(l, hay)) continue;
      const path = toCore ? rehome(l.path) : l.path;
      out += `    use ${path}${l.alias ? ` as ${l.alias}` : ""};\n`;
    }
    return out;
  };
  // Whether code in a child module names anything the module itself defines or imports.
  const upNames = [
    ...m.items.filter((i) => i.role === "core" && i.name && i.kind !== "impl").map((i) => i.name),
    ...m.items.filter((i) => i.role === "use").flatMap((i) => parseUse(i).leaves.map((l) => l.name)),
  ].filter((n) => n !== "*" && n !== "_");
  const reachesUp = (hay) => upNames.some((n) => usedIn({ name: n, path: n }, hay));
  let core = m.parsed.header;
  let desk = deskUses;
  for (const it of m.items) {
    if (it.role === "stay") continue;
    if (it.role === "use") {
      core += filterUse(it, coreCode, { toCore: true }).text;
      continue;
    }
    if (it === m.testMod) {
      if (coreTestIns.length > 0) {
        core +=
          m.body.before +
          testUses(m.ins, coreTestCode, coreDropped, true) +
          (fixtureIns.length > 0 ? "    use super::fixtures::*;\n" : "") +
          coreTestIns.map((i) => rehomeCode(i.text)).join("") +
          m.body.tail +
          m.body.after;
      }
      if (fixtureIns.length > 0) {
        core +=
          "\n/// **The test scaffolding this module's tests share with the ones `src-tauri` still holds** —\n" +
          "/// behind the `testing` feature, which no build ships. At the foot of the file, below\n" +
          "/// `mod tests`, because `scripts/coverage-rust.mjs` counts everything from the first column-0\n" +
          "/// `#[cfg(test)]` down as test code.\n" +
          '#[cfg(any(test, feature = "testing"))]\npub mod fixtures {\n' +
          (reachesUp(fixtureCode) ? "    use super::*;\n" : "") +
          testUses(m.ins, fixtureCode, coreDropped, true, { skipSuperGlob: true }) +
          fixtureIns.map((i) => publish(rehomeCode(i.text), i)).join("") +
          "}\n";
      }
      continue;
    }
    core += rehomeCode(it.text);
  }
  core += m.parsed.tail;
  for (const [from, to] of PATCHES[m.id] ?? []) {
    // In code, and exactly once: a comment that quotes the line must not be what gets patched.
    const c = code(core);
    const at = c.indexOf(from);
    if (at < 0 || c.indexOf(from, at + 1) >= 0) {
      throw new Error(`${m.file}: the text a patch replaces is not there exactly once, as code: ${from}`);
    }
    core = core.slice(0, at) + to + core.slice(at + from.length);
  }

  const hasDesk = stayItems.length > 0 || stayTestIns.length > 0;
  if (hasDesk) {
    let out = remainderHeader(m, stayItems.length > 0) + `pub use grimoire_core::${m.id}::*;\n\n` + desk;
    out += stayItems.map((i) => i.text).join("");
    if (stayTestIns.length > 0) {
      out +=
        `\n/// The tests of \`${m.id}\` that name something this crate still holds. Each goes home when what it\n/// names does.\n#[cfg(test)]\nmod tests {\n` +
        testUses(m.ins, stayTestCode, deskDropped, false) +
        (fixtureIns.some((i) => names(i, stayTestCode)) ? `    use grimoire_core::${m.id}::fixtures::*;\n` : "") +
        stayTestIns.map((i) => i.text).join("") +
        `}\n`;
    }
    desk = out;
  }
  return { core, desk: hasDesk ? desk : null };
}

/**
 * A test helper made `pub` for the fixtures module: its own head, a struct's fields and an
 * inherent `impl`'s methods. A trait `impl` is left as it is — its methods take the trait's.
 */
function publish(text, it) {
  const lines = text.split("\n");
  const at = it.headLine;
  const isTraitImpl = it.kind === "impl" && /\sfor\s/.test(lines.slice(at, at + 3).join(" "));
  if (it.kind !== "impl") {
    lines[at] = it.vis ? lines[at].replace(it.vis, "pub") : lines[at].replace(/^(\s*)/, "$1pub ");
  }
  if (it.kind === "struct" || (it.kind === "impl" && !isTraitImpl)) {
    for (let k = at + 1; k < lines.length; k++) {
      const field = it.kind === "struct" && /^ {8}[a-z_][A-Za-z0-9_]*:\s/.test(lines[k]);
      const method = it.kind === "impl" && /^ {8}(?:const\s+|async\s+|unsafe\s+)*fn\s/.test(lines[k]);
      if (field || method) lines[k] = lines[k].replace(/^( {8})/, "$1pub ");
    }
  }
  return lines.join("\n");
}

// ── Widening ───────────────────────────────────────────────────────────────────────────────

/**
 * Make `pub` what `src-tauri` still names. `own` is the module's remainder (code), where a
 * private name can be spelled bare; `all` is every file `src-tauri` keeps, where a `pub(crate)`
 * name is reached by path or by import.
 */
function widen(m, coreText, own, kept, imported) {
  const last = m.id.split("::").pop();
  const parsed = split(coreText);
  const widened = [];
  const all = kept.join("\n");
  const byPath = (name) => new RegExp(`(?<![A-Za-z0-9_])${last}::${esc(name)}(?![A-Za-z0-9_])`).test(all) || imported.has(`${m.id}::${name}`);
  // A function is named by a call or through a path — never by a parameter that shares its name.
  const spelledBare = (it) =>
    it.kind === "fn"
      ? new RegExp(`(?<![A-Za-z0-9_.])${esc(it.name)}\\s*(?:::<[^>]*>)?\\s*\\(|::${esc(it.name)}(?![A-Za-z0-9_])`).test(own)
      : word(it.name).test(own);
  const pubHead = (text, it) => {
    const lines = text.split("\n");
    const at = it.headLine;
    lines[at] = it.vis ? lines[at].replace(it.vis, "pub") : lines[at].replace(/^(\s*)/, "$1pub ");
    return lines.join("\n");
  };
  let out = parsed.header;
  for (const it of parsed.items) {
    let text = it.text;
    const gated = isTestGated(it);
    if (it.kind === "mod" && gated) {
      out += text;
      continue;
    }
    const restricted = it.vis.startsWith("pub(");
    if (it.name && it.kind !== "impl" && it.kind !== "use" && (it.vis === "" || restricted)) {
      const needed =
        (own && spelledBare(it)) ||
        ((restricted || gated) && byPath(it.name)) ||
        WIDEN[m.id]?.includes(it.name);
      if (needed) {
        text = pubHead(text, it);
        if (gated) text = text.replace("#[cfg(test)]", '#[cfg(any(test, feature = "testing"))]');
        widened.push(it.name);
      }
    }
    if (it.kind === "impl" || it.kind === "struct" || it.kind === "enum") {
      // Methods, associated consts and fields: one level in.
      text = text
        .split("\n")
        .map((line) => {
          const mm = /^(\s{4})(pub\((?:crate|super)\)\s+)?((?:const\s+|async\s+|unsafe\s+)*fn\s+|const\s+)?([a-z_A-Z][A-Za-z0-9_]*)(\s*[(<:])/.exec(line);
          if (!mm) return line;
          const [, indent, vis, kw, name] = mm;
          if (!kw && !/:$/.test(mm[5].trim())) return line;
          if (!kw && it.kind !== "struct") return line;
          const spelled = new RegExp(`[.:]${esc(name)}(?![A-Za-z0-9_])`);
          const literal = it.kind === "struct" && !kw && new RegExp(`(?<![A-Za-z0-9_])${esc(it.name)}\\s*\\{`).test(own);
          // **A member is widened only where its type is named too** — `.name`, `.id` and
          // `.record(` are spelled on a dozen unrelated types, and a bare match published nine
          // members nothing reaches. A restricted one is reached from another file; a private
          // one only from this module's own remainder. What a caller reaches without naming the
          // type — a closure parameter that infers it — is a compile error, and goes on `WIDEN`.
          // "Names the type" is by this module's path or an import of it — `Feed` alone is also
          // `marketplace_feed`'s.
          const typed = new RegExp(`(?<![A-Za-z0-9_])${last}::${esc(it.name)}(?![A-Za-z0-9_])`);
          const inOwn = word(it.name).test(own) && (spelled.test(own) || literal);
          const need =
            WIDEN[m.id]?.includes(`${it.name}.${name}`) ||
            inOwn ||
            (vis && kept.some((c) => (typed.test(c) || cratePaths(c).includes(`crate::${m.id}::${it.name}`)) && spelled.test(c)));
          if (!need) return line;
          widened.push(`${it.name}.${name}`);
          return `${indent}pub ${line.slice(indent.length + (vis ? vis.length : 0))}`;
        })
        .join("\n");
    }
    out += text;
  }
  return { text: out + parsed.tail, widened };
}

// ── The run ────────────────────────────────────────────────────────────────────────────────

const loaded = pending.map(load);
for (let grew = true; grew; ) {
  grew = false;
  for (const m of loaded) if (settle(m)) grew = true;
}

// A moving item must not name a staying one.
const refusals = [];
for (const m of loaded) {
  const stay = m.items.filter((i) => i.role === "stay" && i.name && i.kind !== "impl");
  for (const it of m.items) {
    if (it.role !== "core") continue;
    for (const s of stay) if (names(s, it.c)) refusals.push(`${m.file}: \`${it.name ?? it.kind}\` moves and names \`${s.name}\`, which stays`);
  }
  // An item the remainder defines shadows the glob's item of the same name, without a word.
  const moving = new Set(m.items.filter((i) => i.role === "core" && i.name && i.kind !== "impl").map((i) => i.name));
  for (const s of stay) if (moving.has(s.name)) refusals.push(`${m.file}: \`${s.name}\` both moves and stays; the one that stays would shadow the other`);
  for (const f of m.with) {
    const c = code(read(join(DESK, f)));
    if (DESKTOP_RE.test(c)) refusals.push(`${f}: names the desktop`);
    for (const p of cratePaths(c)) if (!available(p)) refusals.push(`${f}: names ${p}, which stays`);
  }
}
if (refusals.length) {
  console.error(refusals.join("\n"));
  process.exit(1);
}

const built = loaded.map((m) => ({ m, ...build(m) }));

// Everything `src-tauri` keeps: the files that do not move, and the remainders.
const movingFiles = new Set(loaded.flatMap((m) => [m.file, ...m.with]));
const kept = walk(DESK)
  .map((p) => rel(p, DESK))
  .filter((f) => !movingFiles.has(f));
const keptCode = kept.map((f) => code(read(join(DESK, f)))).concat(built.filter((b) => b.desk).map((b) => code(b.desk)));
const imported = new Set();
for (const c of keptCode) {
  for (const p of cratePaths(c)) imported.add(p.replace(/^crate::/, ""));
}
// `super::apply::order_of`, spelled from inside `sync_engine/`.
for (const f of kept.filter((f) => f.startsWith("sync_engine/"))) {
  const c = code(read(join(DESK, f)));
  for (const mm of c.matchAll(/\bsuper::(\w+)::(\w+)/g)) imported.add(`sync_engine::${mm[1]}::${mm[2]}`);
}

let report = "";
for (const b of built) {
  const own = b.desk ? code(b.desk) : "";
  const w = widen(b.m, b.core, own, keptCode, imported);
  b.core = w.text;
  b.widened = w.widened;
  const stay = b.m.items.filter((i) => i.role === "stay");
  const cmds = stay.filter(isCommand).length;
  const other = stay.filter((i) => !isCommand(i) && i.name).map((i) => `${i.kind} ${i.name}`);
  const tests = b.m.ins.filter((i) => i.taint && isTestFn(i));
  const helpers = b.m.ins.filter((i) => (i.taint || i.copy) && !isTestFn(i) && i.kind !== "use");
  report +=
    `${b.m.id}: ${b.desk ? "remainder" : "whole"}; ${cmds} commands` +
    (other.length ? `; stays: ${other.join(", ")}` : "") +
    (tests.length ? `\n   tests that stay (${tests.length}): ${tests.map((t) => `${t.name} [${t.taint}]`).join("; ")}` : "") +
    (helpers.some((t) => t.taint || t.gone) && VERBOSE
      ? `\n   helpers that stay: ${helpers.filter((t) => t.taint || t.gone).map((t) => `${t.name}${t.taint ? " [" + t.taint + "]" : ""}`).join("; ")}`
      : "") +
    (helpers.some((t) => !t.taint && !t.gone)
      ? `\n   fixtures: ${[...new Set(helpers.filter((t) => !t.taint && !t.gone).map((t) => t.name))].join(", ")}`
      : "") +
    (w.widened.length ? `\n   widened: ${w.widened.join(", ")}` : "") +
    "\n";
}
console.log(report);

if (DRY) {
  console.log(`${loaded.length} modules would move; ${MODULES.length - loaded.length} already have.`);
  process.exit(0);
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────

const put = (p, text) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

for (const b of built) {
  const from = `src-tauri/src/${b.m.file}`;
  const to = `crates/grimoire-core/src/${corePath(b.m)}.rs`;
  mkdirSync(dirname(join(ROOT, to)), { recursive: true });
  git("mv", from, to);
  put(join(ROOT, to), b.core);
  for (const f of b.m.with) {
    const dest = `crates/grimoire-core/src/${f}`;
    mkdirSync(dirname(join(ROOT, dest)), { recursive: true });
    git("mv", `src-tauri/src/${f}`, dest);
    put(join(ROOT, dest), rehomeCode(read(join(ROOT, dest))));
  }
  if (b.desk) {
    if (b.m.id.includes("::")) throw new Error(`${b.m.id} left a remainder and has nowhere to keep one`);
    put(join(DESK, b.m.id, "mod.rs"), b.desk);
  }
}

// The two module maps.
{
  const libPath = join(DESK, "lib.rs");
  let lib = read(libPath);
  for (const b of built) {
    if (b.desk || b.m.id.includes("::")) continue;
    lib = lib.replace(new RegExp(`^pub mod ${b.m.id};$`, "m"), `pub use grimoire_core::${b.m.id};`);
  }
  put(libPath, lib);

  const corePathLib = join(CORE, "lib.rs");
  const core = split(read(corePathLib));
  for (const b of built) {
    if (b.m.id.includes("::")) continue;
    if (core.items.some((i) => i.kind === "mod" && i.name === b.m.id)) continue;
    const at = core.items.findIndex((i) => i.kind === "mod" && i.name > b.m.id);
    const item = { kind: "mod", name: b.m.id, text: `pub mod ${b.m.id};\n` };
    // The first declaration carries the blank line under the file's `//!` header.
    if (at === 0 && core.items[0].text.startsWith("\n")) {
      item.text = "\n" + item.text;
      core.items[0].text = core.items[0].text.slice(1);
    }
    if (at < 0) core.items.push(item);
    else core.items.splice(at, 0, item);
  }
  put(corePathLib, core.header + core.items.map((i) => i.text).join("") + core.tail);

  for (const dir of new Set(built.filter((b) => b.m.id.includes("::")).map((b) => b.m.id.split("::")[0]))) {
    const mine = built.filter((b) => b.m.id.startsWith(`${dir}::`)).map((b) => b.m.id.split("::")[1]);
    const deskMod = join(DESK, dir, "mod.rs");
    let d = read(deskMod);
    for (const name of mine) d = d.replace(new RegExp(`^pub mod ${name};$`, "m"), `pub use grimoire_core::${dir}::${name};`);
    put(deskMod, d);
    const coreMod = join(CORE, dir, "mod.rs");
    let c = read(coreMod);
    for (const name of mine) if (!new RegExp(`^pub mod ${name};$`, "m").test(c)) c = c.replace(/\n*$/, `\npub mod ${name};\n`);
    put(coreMod, c);
  }
}

// ── Once: `with_write` ─────────────────────────────────────────────────────────────────────
//
// The one definition of a user-facing write, and the body it shares with its waiting twin. It
// arms and settles the managed wishlists and reconciles tokens around the caller's closure, so it
// could not move before those modules did. `&State` where it took `&AppState`: a caller holding
// an `Arc<AppState>` still passes `&state`, through the `Deref` the state step added.
{
  const syncPath = join(DESK, "sync.rs");
  const sync = split(read(syncPath));
  const wanted = ["with_write", "with_write_waiting", "written"];
  const moved = sync.items.filter((i) => i.kind === "fn" && wanted.includes(i.name));
  if (moved.length === wanted.length) {
    const statePath = join(CORE, "state.rs");
    const state = split(read(statePath));
    const at = state.items.findIndex((i) => i.kind === "mod" && isTestGated(i));
    if (at < 0) throw new Error("state.rs has no test module to put `with_write` above");
    const text = moved
      .map((i) => {
        if (!i.text.includes("state: &AppState")) throw new Error(`${i.name} does not take \`&AppState\``);
        return i.text.replace("pub(crate) fn", "pub fn").replace("state: &AppState", "state: &State");
      })
      .join("");
    state.items.splice(at, 0, { text });
    put(statePath, state.header + state.items.map((i) => i.text).join("") + state.tail);
    const first = sync.items.indexOf(moved[0]);
    const reexport =
      "\n/// [`with_write`] and [`with_write_waiting`] — the one definition of a user-facing write —\n" +
      "/// are `grimoire-core`'s since the extraction's domain step, re-exported at the names every\n" +
      "/// caller here knows them by. They take `&State`, which an `&AppState` derefs to.\n" +
      "pub(crate) use grimoire_core::state::{with_write, with_write_waiting};\n";
    const rest = sync.items.filter((i) => !moved.includes(i));
    rest.splice(first, 0, { text: reexport });
    put(syncPath, sync.header + rest.map((i) => i.text).join("") + sync.tail);
  } else if (moved.length !== 0) {
    throw new Error("sync.rs holds some of `with_write`, `with_write_waiting` and `written`, not all three");
  }
}

// ── Once: `prepare_database` goes home ─────────────────────────────────────────────────────
//
// The launch's logged passes call `maintenance`, `managed_wishlist`, `deck_tokens` and
// `deck_meta`, which are the core's now. It rejoins `bring_to_head`, directly below it.
{
  const deskPath = join(DESK, "schema/mod.rs");
  const desk = split(read(deskPath));
  const fn = desk.items.find((i) => i.kind === "fn" && i.name === "prepare_database");
  if (fn) {
    const schemaPath = join(CORE, "schema.rs");
    const schema = split(read(schemaPath));
    const at = schema.items.findIndex((i) => i.kind === "fn" && i.name === "bring_to_head");
    if (at < 0) throw new Error("schema.rs has no `bring_to_head`");
    schema.items.splice(at + 1, 0, { text: fn.text });
    put(schemaPath, schema.header + schema.items.map((i) => i.text).join("") + schema.tail);
    const rest = desk.items.filter((i) => i !== fn);
    const hay = rest.filter((i) => i.kind !== "use" && !isTestGated(i)).map((i) => refs(i.text)).join("\n");
    const tests = rest.filter((i) => isTestGated(i)).map((i) => refs(i.text)).join("\n");
    // What only the tests still name, they reached through `use super::*`. It goes inside
    // their module, never above it under a column-0 `#[cfg(test)]`: `scripts/coverage-rust.mjs`
    // counts everything from the first of those down as test code.
    const holder = rest.find((i) => i.kind === "mod" && isTestGated(i) && /\{/.test(code(i.text)));
    const forTests = [];
    let out = desk.header;
    for (const it of rest) {
      if (it.kind === "use" && !isTestGated(it)) {
        const f = filterUse({ ...it }, hay, { toCore: false });
        out += f.text;
        for (const l of f.dropped) if (usedIn(l, tests)) forTests.push(l);
      } else if (it === holder && forTests.length > 0) {
        const b = inner(it);
        out +=
          b.before +
          forTests.map((l) => `    use ${l.path}${l.alias ? ` as ${l.alias}` : ""};\n`).join("") +
          b.items.map((i) => i.text).join("") +
          b.tail +
          b.after;
      } else {
        out += it.text;
      }
    }
    if (forTests.length > 0 && !holder) throw new Error("schema/mod.rs: imports only tests name, and no test module to hold them");
    put(deskPath, out + desk.tail);
  }
}

// ── Once: the tests the storage step left behind go home ───────────────────────────────────
//
// Step 2 left in `src-tauri` every test of `schema` and of `sync_engine::capture` that named a
// module still there. With this step's modules in the core, most of them name nothing
// `src-tauri` holds any more. Each is decided the way a module's own tests are — `splitTests` —
// and what can go joins the core file's `mod tests`, a helper both sides call its `fixtures`.
function homecoming({ desk, core, id, whole }) {
  const deskPath = join(DESK, desk);
  if (!existsSync(deskPath)) return;
  const d = split(read(deskPath));
  const holder = whole ? null : d.items.find((i) => i.kind === "mod" && isTestGated(i) && /\{/.test(code(i.text)));
  if (!whole && !holder) return;
  const body = whole ? null : inner(holder);
  const ins = (whole ? d.items : body.items).map((it) => ({ ...it, c: refs(it.text) }));
  const imports = new Map();
  for (const it of whole ? ins : [...d.items, ...ins]) {
    if (it.kind !== "use") continue;
    for (const l of parseUse(it).leaves) if (l.name !== "*") imports.set(l.name, l.path);
  }
  splitTests(ins, stayNames.get(id) ?? new Set(), imports);
  const going = ins.filter((i) => i.kind !== "use" && !i.taint && !i.copy);
  const shared = ins.filter((i) => i.kind !== "use" && !i.taint && i.copy && !i.gone);
  if (!going.some(isTestFn)) return;

  const corePathAbs = join(CORE, core);
  const c = split(read(corePathAbs));
  const tests = c.items.find((i) => i.kind === "mod" && i.name === "tests" && isTestGated(i));
  if (!tests) throw new Error(`${core} has no \`mod tests\` for ${desk}'s tests to join`);
  const tb = inner(tests);
  tests.text = tb.before + tb.items.map((i) => i.text).join("") + going.map((i) => rehomeCode(i.text)).join("") + tb.tail + tb.after;
  if (shared.length > 0) {
    const fixtures = c.items.find((i) => i.kind === "mod" && i.name === "fixtures");
    if (!fixtures) throw new Error(`${core} has no \`fixtures\` for ${desk}'s shared helpers`);
    const fb = inner(fixtures);
    fixtures.text =
      fb.before + fb.items.map((i) => i.text).join("") + shared.map((i) => publish(rehomeCode(i.text), i)).join("") + fb.tail + fb.after;
  }
  put(corePathAbs, c.header + c.items.map((i) => i.text).join("") + c.tail);

  const left = ins.filter((i) => !going.includes(i) && !shared.includes(i));
  const leftCode = left.filter((i) => i.kind !== "use").map((i) => i.c).join("\n");
  const rebuilt = left.map((i) => (i.kind === "use" ? filterUse(i, leftCode, { toCore: false }).text : i.text)).join("");
  if (whole) {
    put(deskPath, d.header + rebuilt + d.tail);
  } else {
    holder.text = body.before + rebuilt + body.tail + body.after;
    const out = d.items.map((i) => (i.kind === "use" && isTestGated(i) ? filterUse(i, leftCode, { toCore: false }).text : i.text));
    put(deskPath, d.header + out.join("") + d.tail);
  }
  console.log(
    `${desk}: ${going.filter(isTestFn).length} tests went home to ${core}; ${left.filter((i) => i.kind !== "use" && isTestFn(i)).length} stay` +
      (shared.length ? `; fixtures: ${shared.map((i) => i.name).join(", ")}` : ""),
  );
}
homecoming({ desk: "schema/mod.rs", core: "schema.rs", id: "schema", whole: false });
homecoming({ desk: "sync_engine/capture_tests.rs", core: "sync_engine/capture.rs", id: "sync_engine::capture", whole: true });

// ── Once: the TypeScript that reads a moved file as text ───────────────────────────────────
//
// `ipc.test.ts` holds the hand-written mirror in `ipc.ts` to the Rust it mirrors by importing
// each file with `?raw`. A module that moved whole is read from the core; one that left its
// wrappers behind is read as both halves, under the name the assertions already use.
{
  const where = new Map();
  for (const m of MODULES) {
    const path = corePath(m);
    if (!existsSync(join(CORE, `${path}.rs`))) continue;
    where.set(path, existsSync(join(DESK, path, "mod.rs")));
  }
  const roots = ["src", ".storybook", "scripts", "share", "mobile", "relay", "share-worker"];
  const tsFiles = [];
  const walkTs = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === "dist" || e === "target") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walkTs(p);
      else if (/\.(ts|tsx|mjs)$/.test(e)) tsFiles.push(p);
    }
  };
  for (const r of roots) if (existsSync(join(ROOT, r))) walkTs(join(ROOT, r));
  for (const file of tsFiles) {
    const text = read(file);
    const joins = [];
    const next = text.replace(
      /^import (\w+) from "((?:\.\.\/)+)src-tauri\/src\/([a-z_/]+)\.rs\?raw";$/gm,
      (line, name, up, path) => {
        if (!where.has(path)) return line;
        if (!where.get(path)) return `import ${name} from "${up}crates/grimoire-core/src/${path}.rs?raw";`;
        joins.push(name);
        return (
          `import ${name}Core from "${up}crates/grimoire-core/src/${path}.rs?raw";\n` +
          `import ${name}Desktop from "${up}src-tauri/src/${path}/mod.rs?raw";`
        );
      },
    );
    if (next === text) continue;
    let out = next;
    if (joins.length > 0) {
      const lines = next.split("\n");
      let last = -1;
      let open = false;
      for (let k = 0; k < lines.length; k++) {
        if (/^import\s/.test(lines[k])) open = true;
        if (open && /(from\s+)?["'][^"']+["'];\s*$/.test(lines[k])) {
          last = k;
          open = false;
        }
      }
      const block = [
        "",
        "// **A module the core extraction split in two is read as both halves** — the engine's file in",
        "// `crates/grimoire-core` and the desktop's command wrappers, which stayed in `src-tauri` — under",
        "// the one name every assertion below already uses.",
        ...joins.map((n) => `const ${n} = ${n}Core + "\\n" + ${n}Desktop;`),
      ];
      lines.splice(last + 1, 0, ...block);
      out = lines.join("\n");
    }
    put(file, out);
    console.log(`rewrote the Rust imports of ${rel(file, ROOT)}`);
  }
}

if (!NO_FMT) {
  execFileSync("cargo", ["fmt", "-p", "mtg-grimoire", "-p", "grimoire-core"], { cwd: ROOT, stdio: "inherit" });
}
console.log(`${built.length} modules moved.`);
