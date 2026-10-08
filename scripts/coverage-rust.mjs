// Rust line coverage, with the inline test modules taken back out.
//
// `cargo llvm-cov` instruments whatever it compiles, and `cargo test` compiles the crate
// with `--cfg test` — so every `#[cfg(test)] mod tests` body is in the report, and every
// line of it is covered by definition (a test that did not run is a test failure). On this
// crate that is the majority of the instrumented lines: the modules are large, and they
// pull the headline figure up by ~14 points over what the shipped code actually scores.
// llvm-cov has no way to drop them — `--ignore-filename-regex` is per *file*, and the tests
// live in the same files as the code they test.
//
// So this reads the LCOV export back and splits each file at its first column-0
// `#[cfg(test)]` **that gates a module** — `mod tests {`, `mod tests;`, or a `fixtures` module
// above one. Everything from that line down is test-only: every file here keeps its test
// modules at the foot, and the one with two (`index/mod.rs`, a `fixtures` module then
// `mod tests`) has nothing but test code between them.
//
// **It cut at the first `#[cfg(test)]` of any kind until 2026-10-02, and eleven files have one
// far above their tests** — a test-only `use`, a `thread_local!`, a helper function. In those
// the whole of the file below that line was dropped from the shipped figure: all of
// `wishlist.rs` from line 22, most of `sync_engine/apply.rs`. The single items such a gate
// covers are counted as shipped now, which is a few lines wrong in the other direction and
// the cheaper mistake. `platform::fence`'s I/O sweep in `grimoire-core` makes the same cut,
// for the same reason.
//
// **Both workspace members are measured, since 2026-10-02**: the app in `src-tauri` and the
// engine in `crates/grimoire-core`, which is where the app's modules are moving. One run, one
// LCOV, one table — a module that moves keeps its lines in the total and changes only its name.
//
// Prints both totals. The non-test one is what README.md quotes.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Where each member keeps its sources, `/`-separated from the repository root, and the prefix
 * its files carry in the table. The app's stay bare, as they were when it was the only package
 * here; the engine's say which crate they are in, because both have a `lib.rs` and a module
 * that has moved can leave a file of the same name behind. No module directory can be called
 * `grimoire-core` — a hyphen is not an identifier — so the prefix cannot collide with one.
 */
const MEMBERS = [
  { src: "apps/desktop/src-tauri/src", prefix: "" },
  { src: "crates/grimoire-core/src", prefix: "grimoire-core/" },
];
// Still under `target`: the workspace builds there (`.cargo/config.toml`).
const LCOV = join("target", "llvm-cov", "coverage.lcov");

const reportOnly = process.argv.includes("--report-only");

// ---------------------------------------------------------------- collect the report

if (!reportOnly) {
  // `--locked` for the same reason both CI workflows use it: a coverage run that quietly
  // resolves a different dependency set is measuring a build nobody ships.
  //
  // `--workspace`, run from the repository root where the workspace's manifest is: both
  // members' tests, which is what `cargo test --workspace` runs in `verify` and in CI.
  // `crates/card-scanner` is not a member, so its own suite is not in this figure — it never
  // was — and whatever of it the app's tests execute is dropped below with the dependencies.
  mkdirSync(join("target", "llvm-cov"), { recursive: true });
  execFileSync("cargo", ["llvm-cov", "--workspace", "--locked", "--lcov", "--output-path", LCOV], {
    stdio: "inherit",
  });
}

// ------------------------------------------------------- where each file stops being code

/** Every `.rs` under `dir`, at any depth. */
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".rs") ? [path] : [];
  });
}

/** Whether `line` opens or declares a module — what a test gate has to be followed by to be the cut. */
const declaresModule = (line) => /^(pub(\([a-z]+\))? )?mod \w/.test(line ?? "");

/**
 * file -> 1-based line of the first `#[cfg(test)]` that gates a module, or Infinity if it has
 * none. The key is the member's prefix and the path below its `src/`, `/`-separated — the name
 * the table prints.
 */
const boundary = new Map();
for (const { src, prefix } of MEMBERS) {
  const dir = join(...src.split("/"));
  for (const path of sources(dir)) {
    const lines = readFileSync(path, "utf8").split("\n");
    const at = lines.findIndex(
      (l, i) => l.startsWith("#[cfg(test)]") && declaresModule(lines[i + 1]),
    );
    const key = prefix + relative(dir, path).split(sep).join("/");
    boundary.set(key, at === -1 ? Infinity : at + 1);
  }
}

/**
 * An LCOV `SF:` path as the key above, or null when it is under neither member. The path is
 * absolute, and `\`-separated on Windows, so it is matched on the member's own `/…/src/`
 * segment rather than against a root that would have to agree with it about drive-letter case.
 */
function keyOf(sf) {
  const norm = sf.split("\\").join("/");
  for (const { src, prefix } of MEMBERS) {
    const marker = `/${src}/`;
    const i = norm.indexOf(marker);
    if (i !== -1) return prefix + norm.slice(i + marker.length);
  }
  return null;
}

// ------------------------------------------------------------------- read the LCOV back

/** file -> {hit, total, prodHit, prodTotal} over LCOV's per-line `DA:` records. */
const per = new Map();
let file = null;

for (const line of readFileSync(LCOV, "utf8").split("\n")) {
  if (line.startsWith("SF:")) {
    // Only a path below a member's `src/` is a key the boundary map knows; anything outside
    // both (a dependency, `card-scanner`, a build script) is not these crates' coverage and
    // is dropped.
    file = keyOf(line.slice(3));
    if (file && !per.has(file)) {
      per.set(file, { hit: 0, total: 0, prodHit: 0, prodTotal: 0 });
    }
  } else if (line.startsWith("DA:") && file) {
    const [no, count] = line.slice(3).split(",").map(Number);
    const rec = per.get(file);
    rec.total += 1;
    if (count > 0) rec.hit += 1;
    if (no < (boundary.get(file) ?? Infinity)) {
      rec.prodTotal += 1;
      if (count > 0) rec.prodHit += 1;
    }
  }
}

// ------------------------------------------------------------------------------ report

const pct = (hit, total) => (total === 0 ? null : (hit / total) * 100);
const show = (hit, total) => {
  const p = pct(hit, total);
  return (p === null ? "-" : p.toFixed(2) + "%").padStart(8);
};

const totals = { hit: 0, total: 0, prodHit: 0, prodTotal: 0 };

// The name column is as wide as the longest name needs, and never narrower than it was when
// every name was the app's: a prefixed path under `sync_engine/` is past 24 characters, and a
// row that overflowed would push its three figures out from under their headings.
const NAME = Math.max(24, ...[...per.keys()].map((name) => name.length + 2));
const RULE = "-".repeat(NAME + 28);

console.log(
  "file".padEnd(NAME) + "all lines".padStart(10) + "non-test".padStart(10) + "lines".padStart(8),
);
console.log(RULE);
for (const [name, r] of [...per].sort((a, b) => a[0].localeCompare(b[0]))) {
  for (const k of ["hit", "total", "prodHit", "prodTotal"]) totals[k] += r[k];
  console.log(
    name.padEnd(NAME) +
      show(r.hit, r.total) +
      show(r.prodHit, r.prodTotal) +
      String(r.prodTotal).padStart(8),
  );
}
console.log(RULE);
console.log(
  "TOTAL".padEnd(NAME) +
    show(totals.hit, totals.total) +
    show(totals.prodHit, totals.prodTotal) +
    String(totals.prodTotal).padStart(8),
);
console.log("");
console.log(
  `  including test modules : ${show(totals.hit, totals.total).trim()} (${totals.hit}/${totals.total})`,
);
console.log(
  `  shipped code only      : ${show(totals.prodHit, totals.prodTotal).trim()} (${totals.prodHit}/${totals.prodTotal})  <- the README figure`,
);
