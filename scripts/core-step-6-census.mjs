// Step 6 of the core extraction: every function in the sync client, the entitlement and pairing
// that takes a database connection and holds it across an `.await` — which means across a
// network request, with the write lock held by its caller. The step is done when this counts
// none. The record is docs/superpowers/research/2026-10-02-light-app-step-6-sync-trip-spike.md.
//   node scripts/core-step-6-census.mjs .
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [root] = process.argv.slice(2);
const { split, inner } = await import(pathToFileURL(`${root}/scripts/lib/rs-items.mjs`).href);
const FILES = [
  "sync_engine/client.rs",
  "sync_engine/entitlement.rs",
  "sync_engine/live.rs",
  "sync_engine/schedule.rs",
  "sync_engine/commands.rs",
  "sync_engine/wire.rs",
  "sync_pair/identity.rs",
  "sync_pair/pairing.rs",
];
const code = (t) =>
  t
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
let totals = { fns: 0, asyncFns: 0, held: 0, awaits: 0 };
for (const f of FILES) {
  const src = readFileSync(`${root}/src-tauri/src/${f}`, "utf8");
  const file = split(src);
  const shipped = file.items.filter((it) => !(it.kind === "mod" && /tests|fixtures|testing/.test(it.name ?? "")));
  const lines = shipped.reduce((n, it) => n + it.text.split("\n").length - 1, 0);
  const tests = file.items.find((it) => it.kind === "mod" && it.name === "tests");
  const testCount = tests && tests.text.includes("{") ? inner(tests).items.filter((k) => /#\[(tokio::)?test/.test(k.text)).length : 0;
  const fns = [];
  const push = (it, owner = "") => {
    const c = code(it.text);
    const isAsync = /\basync fn\b/.test(c.slice(0, c.indexOf("{")));
    const takesConn = /\bconn: &(mut )?Connection\b/.test(c.slice(0, c.indexOf("{") + 1));
    const awaits = (c.match(/\.await\b/g) ?? []).length;
    const marks = [];
    if (/#\[tauri::command/.test(it.text)) marks.push("cmd");
    if (/\btauri::|AppHandle/.test(c)) marks.push("tauri");
    if (/\bAppState\b/.test(c)) marks.push("AppState");
    if (/\breqwest\b|http\(\)/.test(c)) marks.push("http");
    if (/tokio_tungstenite|tungstenite|WebSocket/.test(c)) marks.push("ws");
    if (/\btokio::/.test(c)) marks.push("tokio");
    if (/std::thread|thread::/.test(c)) marks.push("thread");
    if (/SystemTime|Instant\b/.test(c)) marks.push("clock");
    if (/block_on/.test(c)) marks.push("block_on");
    if (/with_write(_waiting)?\(/.test(c)) marks.push("with_write");
    if (/\.emit\(/.test(c)) marks.push("emit");
    if (/cfg\(not\(test\)\)|cfg!\(test\)/.test(c)) marks.push("cfgtest");
    if (/opener|open_url|open::/.test(c)) marks.push("opener");
    fns.push({ name: owner + it.name, lines: it.text.split("\n").length - 1, isAsync, takesConn, awaits, marks });
  };
  for (const it of shipped) {
    if (it.kind === "fn") push(it);
    else if (it.kind === "impl" && it.text.includes("fn ")) {
      // Methods are not split out; count the impl as one.
      push(it, "impl ");
    }
  }
  const held = fns.filter((x) => x.isAsync && x.takesConn && x.awaits > 0);
  totals.fns += fns.length;
  totals.asyncFns += fns.filter((x) => x.isAsync).length;
  totals.held += held.length;
  totals.awaits += held.reduce((n, x) => n + x.awaits, 0);
  console.log(`\n=== ${f}: ${lines} shipped lines, ${fns.length} fns, ${testCount} tests inline`);
  console.log(`  holds a connection across an await (${held.length}): ` + held.map((x) => `${x.name}[${x.awaits}]`).join(", "));
  const desk = fns.filter((x) => x.marks.some((m) => ["cmd", "tauri", "AppState", "ws", "thread", "block_on", "opener", "emit"].includes(m)));
  console.log(`  names the desktop (${desk.length}): ` + desk.map((x) => `${x.name}<${x.marks.join(",")}>`).join(", "));
  const other = fns.filter((x) => x.marks.some((m) => ["http", "tokio", "clock", "cfgtest"].includes(m)) && !desk.includes(x));
  console.log(`  reaches the machine (${other.length}): ` + other.map((x) => `${x.name}<${x.marks.join(",")}>`).join(", "));
}
console.log("\n", totals);
