// Step 6 of the core extraction: every function in the sync client, the entitlement and pairing
// that takes a database connection and holds it across an `.await` — which means across a
// network request, with the write lock held by its caller — and every one that blocks a thread
// on a future. It counted 31 of the first before the step and counts none of either after it;
// `core-step-6-census.test.mjs` holds it there. The record is
// docs/superpowers/research/2026-10-02-light-app-step-6-sync-trip-spike.md.
//   node scripts/core-step-6-census.mjs .
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { split, inner, code as blank } from "./lib/rs-items.mjs";

/**
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
];

/** A test module, or the scaffolding behind the `testing` feature: not shipped. */
const isTestModule = (it) => it.kind === "mod" && /tests|fixtures|testing/.test(it.name ?? "");

/**
 * A parameter that is a connection or a transaction, however it is spelled: any name, a
 * lifetime, `mut`, a `rusqlite::` path. Read off code with comments and strings blanked.
 */
const TAKES_A_CONNECTION = /:\s*&\s*(?:'\w+\s+)?(?:mut\s+)?(?:rusqlite::)?(?:Connection|Transaction)\b/;

/**
 * Every function among `items`, with the methods of an `impl` and the functions of a shipped
 * inline module walked into — each as `{ name, text }`.
 */
function functionsOf(items, owner = "") {
  const out = [];
  for (const it of items) {
    if (isTestModule(it)) continue;
    if (it.kind === "fn") out.push({ name: owner + it.name, text: it.text });
    else if ((it.kind === "impl" || it.kind === "mod") && /\{/.test(it.text)) {
      let body;
      try {
        body = inner(it).items;
      } catch {
        continue; // `mod x;`, which is another file and not this one's
      }
      out.push(...functionsOf(body, `${owner}${it.name ?? it.kind}::`));
    }
  }
  return out;
}

/**
 * Read the eight files under `root` and answer, per file, every shipped function with what it
 * does to a connection: `held` are the ones that take a connection or a transaction and await
 * with it, `blocking` the ones that drive a future with `block_on`.
 *
 * **What it cannot see, and what holds it instead**: an `async fn` handed a `&State` that locks
 * the connection itself and awaits with the guard in hand. The compiler refuses that one at every
 * entry point checked as `Send` (`nothing_is_held_across_a_request`), and clippy's
 * `await_holding_lock` everywhere.
 */
export function census(root) {
  const files = [];
  for (const name of FILES) {
    const source = readFileSync(`${root}/${name}`, "utf8").replace(/\r\n/g, "\n");
    const items = split(source).items;
    const shipped = items.filter((it) => !isTestModule(it));
    const tests = items.find((it) => it.kind === "mod" && it.name === "tests");
    const testCount =
      tests && tests.text.includes("{") ? inner(tests).items.filter((k) => /#\[(tokio::)?test/.test(k.text)).length : 0;
    const fns = [];
    for (const fn of functionsOf(items)) {
      const text = blank(fn.text);
      const signature = text.slice(0, text.indexOf("{") + 1);
      fns.push({
        name: fn.name,
        isAsync: /\basync\s+fn\b/.test(signature),
        takesConn: TAKES_A_CONNECTION.test(signature),
        awaits: (text.match(/\.await\b/g) ?? []).length,
        blocksOn: /\bblock_on\s*\(/.test(text),
        command: /#\[tauri::command/.test(fn.text),
      });
    }
    files.push({
      name,
      lines: shipped.reduce((n, it) => n + it.text.split("\n").length - 1, 0),
      tests: testCount,
      fns,
      held: fns.filter((f) => f.isAsync && f.takesConn && f.awaits > 0),
      blocking: fns.filter((f) => f.blocksOn),
    });
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root = "."] = process.argv.slice(2);
  const files = census(root);
  for (const f of files) {
    console.log(`\n=== ${f.name}: ${f.lines} shipped lines, ${f.fns.length} fns, ${f.tests} tests inline`);
    console.log(`  holds a connection across an await (${f.held.length}): ` + f.held.map((x) => `${x.name}[${x.awaits}]`).join(", "));
    console.log(`  blocks a thread on a future (${f.blocking.length}): ` + f.blocking.map((x) => x.name).join(", "));
  }
  const sum = (pick) => files.reduce((n, f) => n + pick(f), 0);
  console.log("\n", {
    fns: sum((f) => f.fns.length),
    asyncFns: sum((f) => f.fns.filter((x) => x.isAsync).length),
    held: sum((f) => f.held.length),
    awaits: sum((f) => f.held.reduce((n, x) => n + x.awaits, 0)),
    blocking: sum((f) => f.blocking.length),
  });
}
