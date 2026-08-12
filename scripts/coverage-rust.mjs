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
// `#[cfg(test)]`. Everything from that line down is test-only: in every file here the
// attribute is the last item, and the one file with two (`index/mod.rs`, a `fixtures`
// module then `mod tests`) has nothing but test code between them.
//
// Prints both totals. The non-test one is what README.md quotes.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join("src-tauri", "src");
const LCOV = join("src-tauri", "target", "llvm-cov", "coverage.lcov");

const reportOnly = process.argv.includes("--report-only");

// ---------------------------------------------------------------- collect the report

if (!reportOnly) {
  // `--locked` for the same reason both CI workflows use it: a coverage run that quietly
  // resolves a different dependency set is measuring a build nobody ships.
  mkdirSync(join("src-tauri", "target", "llvm-cov"), { recursive: true });
  execFileSync(
    "cargo",
    [
      "llvm-cov",
      "--manifest-path",
      join("src-tauri", "Cargo.toml"),
      "--locked",
      "--lcov",
      "--output-path",
      LCOV,
    ],
    { stdio: "inherit" },
  );
}

// ------------------------------------------------------- where each file stops being code

/** Every `.rs` under `src-tauri/src/`, relative and `/`-separated. */
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".rs") ? [path] : [];
  });
}

/** file -> 1-based line of its first `#[cfg(test)]`, or Infinity if it has none. */
const boundary = new Map();
for (const path of sources(SRC)) {
  const lines = readFileSync(path, "utf8").split("\n");
  const at = lines.findIndex((l) => l.startsWith("#[cfg(test)]"));
  const key = relative(SRC, path).split(sep).join("/");
  boundary.set(key, at === -1 ? Infinity : at + 1);
}

// ------------------------------------------------------------------- read the LCOV back

/** file -> {hit, total, prodHit, prodTotal} over LCOV's per-line `DA:` records. */
const per = new Map();
let file = null;

for (const line of readFileSync(LCOV, "utf8").split("\n")) {
  if (line.startsWith("SF:")) {
    // Absolute, and `\`-separated on Windows. Only the part below `src-tauri/src/` is a
    // key the boundary map knows; anything outside it (a dependency, a build script) is
    // not this crate's coverage and is dropped.
    const norm = line.slice(3).split("\\").join("/");
    const i = norm.indexOf("/src-tauri/src/");
    file = i === -1 ? null : norm.slice(i + "/src-tauri/src/".length);
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

console.log(
  "file".padEnd(24) + "all lines".padStart(10) + "non-test".padStart(10) + "lines".padStart(8),
);
console.log("-".repeat(52));
for (const [name, r] of [...per].sort((a, b) => a[0].localeCompare(b[0]))) {
  for (const k of ["hit", "total", "prodHit", "prodTotal"]) totals[k] += r[k];
  console.log(
    name.padEnd(24) +
      show(r.hit, r.total) +
      show(r.prodHit, r.prodTotal) +
      String(r.prodTotal).padStart(8),
  );
}
console.log("-".repeat(52));
console.log(
  "TOTAL".padEnd(24) +
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
