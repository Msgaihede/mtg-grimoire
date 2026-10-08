// The command table's read entries, drafted from the desktop's wrappers.
//
//   node scripts/core-command-table.mjs [--dry]
//
// Writes the `commands! { … }` block between `// BEGIN TABLE` and `// END TABLE` in
// `crates/grimoire-core/src/commands.rs`: one `read` line per desktop wrapper that holds the read
// connection and calls the core, its body that wrapper's own with the connection renamed `conn`.
// A wrapper this cannot read stops the run, naming it, unless it is in `OVERRIDES` below.
//
// **A one-off record, like the move scripts**: it drafted the reads on 2026-10-03 (the light
// app's phase 2, the command table — Markus chose the reads first), and a command that joins the
// table later is one line written by hand next to its neighbours, not a rerun of this.
//
// What it reads: every `#[tauri::command]` under `apps/desktop/src-tauri/src` (descending into an inline
// `mod commands { … }`), cut by `scripts/lib/rs-items.mjs`. **What it takes as a read**: a
// wrapper whose body names `lock_db_read` and none of `with_write`, `with_write_owned`, the sync
// lane, a window, the updater, the mirror, the change mask, a file dialog, a raw request body, the
// scanner's state or a network call — and is not in `NOT_READS`, the two that start background
// work after reading. `READS_ALSO` are reads a word in their doc comment would otherwise exclude.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { inner, split } from "./lib/rs-items.mjs";

const ROOT = process.cwd();
const DESK = join(ROOT, "apps/desktop/src-tauri/src");
const TABLE_FILE = join(ROOT, "crates/grimoire-core/src/commands.rs");
const DRY = process.argv.includes("--dry");

/** Read the connection, then start a picture fetch nobody waits for: tasks, not reads. */
const NOT_READS = new Set(["prefetch_images", "prewarm_collection"]);
/** Reads whose doc comment says "window", which the marker sweep reads as a window. */
const READS_ALSO = new Set(["card_holdings"]);
/** Wrappers whose body is not the common shape, written out. */
const OVERRIDES = {
  marketplace_feed_status: {
    module: "marketplace_feed",
    body: [
      "let now = crate::platform::clock::now_secs();",
      "Ok(PROVIDERS.iter().map(|p| read_status(conn, *p, now)).collect::<Vec<_>>())",
    ],
  },
  // In `desktop.rs`, which the core does not have; the function it calls is `errors`'.
  error_log_list: {
    module: "errors",
    body: ['list(conn, limit).map_err(|e| format!("could not read the error log: {e}"))'],
  },
  // Three wrappers in an inline `mod commands` that renames what it imports
  // (`plan as read_plan`, `card_wishes as read_wishes`): the table calls the core's own names.
  deck_missing_plan: { module: "deck_missing", body: ["plan(conn, deck_id)"] },
  deck_pull_plan: { module: "deck_pull", body: ["plan(conn, deck_id)"] },
  deck_quick_add_wishes: {
    module: "deck_quick_add",
    body: ["card_wishes(conn, &card_id, finish.as_deref())"],
  },
};

const MARKERS = {
  write: /with_write\(/,
  owned: /with_write_owned\(/,
  lane: /lane_for_press|\.lane\(\)|on_a_worker/,
  desktop:
    /AppHandle|\.emit\(|WebviewWindow|tauri::Webview\b|ipc::Request|InvokeBody|\.mirror\b|mirror_status|mirror::|\.changes\b|Updater|update::|file_dialog|DialogExt/,
  scanner: /\.scanner\./,
  network: /scryfall|refresh\(|client::|entitlement::|share::publish|http::/,
};

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".rs")) files.push(p);
  }
};
walk(DESK);

/** `apps/desktop/src-tauri/src/tags/muted/mod.rs` → `tags::muted`. */
const moduleOf = (file) =>
  relative(DESK, file).replace(/\\/g, "/").replace(/\/mod\.rs$/, "").replace(/\.rs$/, "").split("/").join("::");

/** The text between the bracket at `at` and its match, skipping string literals. */
function balanced(text, at) {
  const open = text[at];
  const close = { "(": ")", "{": "}" }[open];
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(at + 1, i);
  }
  throw new Error(`unbalanced at ${at}`);
}

/** Split a parameter list at its top-level commas. */
function params(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "<" || ch === "(") depth++;
    if (ch === ">" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((p) => p.trim().replace(/\s+/g, " ")).filter((p) => p && !/^state\s*:/.test(p));
}

const CONNECTION = [
  /&(?:crate::)?(?:sync::)?lock_db_read\((?:&state|&app|state\.inner\(\))\)/g,
  /let conn = (?:crate::)?(?:sync::)?lock_db_read\(&(?:state|app)\);\s*/g,
];
const toConn = (s) =>
  s
    .replace(CONNECTION[1], "")
    .replace(CONNECTION[0], "conn")
    .replace(/&conn\b/g, "conn")
    .split("grimoire_core::")
    .join("crate::");

/** One wrapper as `{ name, module, params, body: string[] }`. */
function entryOf(file, item) {
  const name = item.name;
  if (OVERRIDES[name]) {
    const sigAt = item.text.indexOf("fn " + name);
    const ps = params(balanced(item.text, item.text.indexOf("(", sigAt)));
    return { name, module: OVERRIDES[name].module, params: ps, body: OVERRIDES[name].body };
  }
  const text = item.text;
  const sigAt = text.indexOf("fn " + name);
  const open = text.indexOf("(", sigAt);
  const paramText = balanced(text, open);
  const afterParams = open + paramText.length + 2;
  const bodyAt = text.indexOf("{", afterParams);
  const returns = text.slice(afterParams, bodyAt).replace(/^\s*->\s*/, "").trim();
  const body = balanced(text, bodyAt);
  let lets = [];
  let expr;
  let wrapOk;
  const spawn = body.indexOf("spawn_blocking(");
  if (spawn >= 0) {
    lets = body
      .slice(0, spawn)
      .split(";")
      .map((s) => s.trim().replace(/\s+/g, " "))
      .filter((s) => s.startsWith("let ") && !/^let (?:state|app) = state\.inner\(\)\.clone\(\)$/.test(s));
    const closure = balanced(body, body.indexOf("(", spawn)).trim();
    const m = /^move \|\| ([\s\S]*)$/.exec(closure);
    if (!m) throw new Error(`${name}: its spawn_blocking is not \`move || …\``);
    expr = m[1].trim();
    // `.await.map_err(…)?` flattens a `Result` the closure answered; without the `?` the
    // closure answered the value itself.
    wrapOk = !/\?\s*$/.test(body.slice(body.lastIndexOf(".await")).trim());
  } else {
    expr = body.trim();
    wrapOk = !/^Result</.test(returns);
  }
  let value = toConn(expr).replace(/^\{\s*([\s\S]*?)\s*\}$/, "$1");
  const statements = value
    .split(/;\s*\n/)
    .map((s) => s.trim().replace(/\s+/g, " ").replace(/\( /g, "(").replace(/,? \)/g, ")"));
  const last = statements.pop();
  const lines = [...lets.map((l) => `${toConn(l)};`), ...statements.map((s) => `${s};`), wrapOk ? `Ok(${last})` : last];
  for (const l of lines) {
    if (/\bstate\b|\bapp\b|lock_db_read/.test(l)) throw new Error(`${name}: its body still names the host — ${l}`);
  }
  return { name, module: moduleOf(file), params: params(paramText), body: lines };
}

const entries = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (!text.includes("tauri::command")) continue;
  const visit = (items) => {
    for (const it of items) {
      if (it.kind === "mod" && it.name !== "tests" && it.text.trimEnd().endsWith("}") && it.text.includes("tauri::command")) {
        visit(inner(it).items);
        continue;
      }
      if (!(it.attrs ?? []).some((a) => a.includes("tauri::command"))) continue;
      const t = it.text;
      const isRead =
        READS_ALSO.has(it.name) ||
        (/lock_db_read/.test(t) && !NOT_READS.has(it.name) && !Object.values(MARKERS).some((re) => re.test(t)));
      if (isRead || OVERRIDES[it.name]) entries.push(entryOf(file, it));
    }
  };
  visit(split(text).items);
}
entries.sort((a, b) => (a.module === b.module ? a.name.localeCompare(b.name) : a.module.localeCompare(b.module)));

const render = (e) => {
  const head = `    read ${e.name} in ${e.module}(${e.params.join(", ")}) = |conn|`;
  const one = `${head} ${e.body.length === 1 ? e.body[0] : `{ ${e.body.join(" ")} }`};`;
  if (one.length <= 100 && e.body.length === 1) return one;
  return `${head} {\n${e.body.map((l) => `        ${l}`).join("\n")}\n    };`;
};
let lastModule = null;
const lines = [];
for (const e of entries) {
  if (e.module !== lastModule) {
    if (lastModule !== null) lines.push("");
    lines.push(`    // ${e.module}`);
    lastModule = e.module;
  }
  lines.push(render(e));
}
const block = `// BEGIN TABLE\ncommands! {\n${lines.join("\n")}\n}\n// END TABLE`;

const source = readFileSync(TABLE_FILE, "utf8");
const from = source.indexOf("// BEGIN TABLE");
const to = source.indexOf("// END TABLE") + "// END TABLE".length;
if (from < 0 || to < from) throw new Error("no // BEGIN TABLE … // END TABLE in commands.rs");
console.log(`${entries.length} reads`);
if (DRY) process.exit(0);
writeFileSync(TABLE_FILE, source.slice(0, from) + block + source.slice(to));
console.log("wrote crates/grimoire-core/src/commands.rs");
