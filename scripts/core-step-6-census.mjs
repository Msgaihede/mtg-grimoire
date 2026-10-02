// Step 6 of the core extraction: every function in the sync client, the entitlement and pairing
// that takes a database connection and holds it across an `.await` — which means across a
// network request, with the write lock held by its caller — and every one that blocks a thread
// on a future. It counted 31 of the first before the step and counts none of either after it;
// `core-step-6-census.test.mjs` holds it there. The record is
// docs/superpowers/research/2026-10-02-light-app-step-6-sync-trip-spike.md.
//   node scripts/core-step-6-census.mjs .
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { split, inner } from "./lib/rs-items.mjs";

/** The eight files the sync client, the entitlement and pairing are, under `src-tauri/src`. */
export const FILES = [
  "sync_engine/client.rs",
  "sync_engine/entitlement.rs",
  "sync_engine/live.rs",
  "sync_engine/schedule.rs",
  "sync_engine/commands.rs",
  "sync_engine/wire.rs",
  "sync_pair/identity.rs",
  "sync_pair/pairing.rs",
];

/** A file's code lines: a line that starts a comment is prose, and prose may name anything. */
const code = (text) =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

/**
 * Read the eight files under `root` and answer, per file, every shipped function with what it
 * does to a connection: `held` are the ones that take `conn: &Connection` and await with it,
 * `blocking` the ones that drive a future with `block_on`.
 */
export function census(root) {
  const files = [];
  for (const name of FILES) {
    const source = readFileSync(`${root}/src-tauri/src/${name}`, "utf8").replace(/\r\n/g, "\n");
    const items = split(source).items;
    const shipped = items.filter((it) => !(it.kind === "mod" && /tests|fixtures|testing/.test(it.name ?? "")));
    const tests = items.find((it) => it.kind === "mod" && it.name === "tests");
    const testCount =
      tests && tests.text.includes("{") ? inner(tests).items.filter((k) => /#\[(tokio::)?test/.test(k.text)).length : 0;
    const fns = [];
    for (const it of shipped) {
      if (it.kind !== "fn" && !(it.kind === "impl" && it.text.includes("fn "))) continue;
      const text = code(it.text);
      const signature = text.slice(0, text.indexOf("{") + 1);
      fns.push({
        name: (it.kind === "impl" ? "impl " : "") + it.name,
        isAsync: /\basync fn\b/.test(signature),
        takesConn: /\bconn: &(mut )?Connection\b/.test(signature),
        awaits: (text.match(/\.await\b/g) ?? []).length,
        blocksOn: /\bblock_on\(/.test(text),
        command: /#\[tauri::command/.test(it.text),
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
