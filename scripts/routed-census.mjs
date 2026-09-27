// Every `#[tauri::command]` in the crate, split into what `web::route` answers and what it
// does not — printed grouped by module so the "why not" table in `docs/reference/web-target.md`
// can be checked against the code rather than against the last person to edit it.
//
//   node scripts/routed-census.mjs
//   node scripts/routed-census.mjs --check 120   # non-zero exit if the routed count differs
//
// **This exists because that table has rotted twice.** A prose-only edit routes to neither CI
// job, so nothing goes red when a count drifts — and the counts here have been wrong in both
// directions: 155 when the answer was 152 (a grep counted doc-comment mentions of the attribute
// and missed the seven `#[tauri::command(async)]` spellings), and 156/36 for a day after
// `sync_group_leave` landed. Both mistakes are the kind a reader cannot spot.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

// Repo-root relative, which is `build-wasm.mjs`'s convention: every script here is run from
// the root by npm, and `import.meta.url` would need a Windows drive-letter fix-up to boot.
const ROOT = join("src-tauri", "src");

function rsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? rsFiles(path)
      : name.endsWith(".rs")
        ? [path]
        : [];
  });
}

/**
 * Commands in one file.
 *
 * Comment lines are skipped, because the modules that explain *why* a command is `(async)`
 * quote the attribute in prose — and both attribute spellings are matched, because the bare
 * `#[tauri::command]` pattern silently misses the other seven.
 */
function commandsIn(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.startsWith("//")) continue;
    if (s !== "#[tauri::command]" && !s.startsWith("#[tauri::command(")) continue;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const m = /(?:pub )?(?:async )?fn ([a-z_0-9]+)/.exec(lines[j]);
      if (m) {
        out.push(m[1]);
        break;
      }
    }
  }
  return out;
}

/**
 * The names `web::route::COMMANDS` advertises, read out of `route.rs`'s text.
 *
 * **Every `//` comment is stripped before a quoted word is matched**, because the array carries
 * prose between its entries and prose quotes things: a comment there naming
 * `cfg(not(target_family = "wasm"))` counted `wasm` as a routed command — one more than the array
 * holds, and a ghost the check below then reported as a typo. No command name can contain `//`,
 * so cutting each line there loses nothing the array says.
 */
export function routedNames(routeSource) {
  const block = routeSource.slice(routeSource.indexOf("pub const COMMANDS"));
  const code = block
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  return new Set(
    code.slice(0, code.indexOf("];")).match(/"[a-z_0-9]+"/g)?.map((s) => s.slice(1, -1)) ?? [],
  );
}

function main() {
  const routed = routedNames(readFileSync(join(ROOT, "web", "route.rs"), "utf8"));

  const byFile = new Map();
  let total = 0;
  for (const path of rsFiles(ROOT).sort()) {
    const found = commandsIn(path);
    if (!found.length) continue;
    total += found.length;
    const missing = found.filter((c) => !routed.has(c));
    if (missing.length) byFile.set(relative(ROOT, path).replaceAll("\\", "/"), missing.sort());
  }

  const notRouted = [...byFile.values()].reduce((n, v) => n + v.length, 0);
  console.log(`commands in the crate   ${total}`);
  console.log(`named in COMMANDS       ${routed.size}`);
  console.log(`not routed              ${notRouted}\n`);
  for (const [file, names] of byFile) console.log(`  ${file.padEnd(26)} ${names.join(" ")}`);

  // A name advertised that is not a command anywhere is a typo the drift fence cannot see: that
  // test calls every name and only checks it is not `Unknown`, which a misspelling would also be.
  const all = new Set(rsFiles(ROOT).flatMap(commandsIn));
  const ghosts = [...routed].filter((c) => !all.has(c)).sort();
  if (ghosts.length) console.log(`\n!! in COMMANDS but not a command anywhere: ${ghosts.join(" ")}`);

  const want = process.argv.indexOf("--check");
  if (want !== -1) {
    const expected = Number(process.argv[want + 1]);
    if (routed.size !== expected) {
      console.error(`\nFAIL routed is ${routed.size}, expected ${expected}`);
      process.exitCode = 1;
    }
  }
}

// Run as a script, never on import — `ci-route.mjs`' guard, so a test can call `routedNames`
// without the census reading the crate and printing it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
