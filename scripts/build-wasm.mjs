#!/usr/bin/env node
// Build the Rust core for the browser: cargo, then wasm-bindgen, then the assets the web
// bundle serves them from.
//
// Two prerequisites this script checks rather than assumes, because both fail in ways that
// do not name themselves:
//
//   * `wasm-bindgen-cli` must match the `wasm-bindgen` crate EXACTLY. A mismatch compiles
//     and links fine and then fails at run time inside the generated glue, complaining about
//     an import nobody wrote. So the version is pinned in three places and checked here.
//   * clang must be on PATH. `sqlite-wasm-rs` compiles SQLite's C amalgamation with `cc` for
//     wasm32 and MSVC cannot emit wasm; without clang the failure is a `cc` error a hundred
//     lines into a build log.
//
// And one thing it checks *after* the build, which no compiler can: that every entry point
// the Worker imports is actually exported. See EXPORTS below.
//
// Output lands in `web/public/`, which is gitignored in full: everything there is generated,
// including the favicon copy, so that the DESKTOP bundle never carries a 2 MB wasm module it
// has no use for.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Kept in step with `wasm-bindgen = "=0.2.127"` in `src-tauri/Cargo.toml`. */
const PINNED = "0.2.127";
const OUT = join("web", "public", "wasm");

/**
 * Every `#[wasm_bindgen]` function `src/workers/db.ts` reaches for.
 *
 * **This list exists because the compiler cannot hold it.** Deleting the `#[wasm_bindgen]`
 * attribute from `web::glue::open` was run as a mutation on 2026-08-28: `cargo build
 * --target wasm32-unknown-unknown` succeeded with **no error and no warning at all** — the
 * function is still `pub` in a `pub mod`, so not even dead-code analysis sees anything wrong.
 * The failure surfaces only when a browser loads the module and finds the export missing,
 * which is a blank page with a message nobody reads.
 *
 * Grepping the generated glue is the cheapest gate that can catch it, and it catches it at
 * build time rather than at Task 10's manual pass.
 */
const EXPORTS = [
  "open",
  "call",
  "ingest_cards",
  "ingest_combos",
  "ingest_tags",
  "ingest_prices",
  "update_check",
  "close",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, ...options });
  if (result.error) {
    console.error(`could not run \`${command}\`: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim();
}

// --- the two prerequisites -------------------------------------------------------------
const manifest = readFileSync(join("src-tauri", "Cargo.toml"), "utf8");
if (!manifest.includes(`wasm-bindgen = "=${PINNED}"`)) {
  console.error(
    `src-tauri/Cargo.toml does not pin wasm-bindgen to =${PINNED}.\n` +
      "The crate and this script must name the same version, and the pin must keep its `=`:\n" +
      "a caret would let cargo resolve a newer crate than the installed CLI can generate for.",
  );
  process.exit(1);
}

const cli = capture("wasm-bindgen", ["--version"]);
if (cli === undefined) {
  console.error(
    "wasm-bindgen is not on PATH. Install the matching CLI:\n" +
      `  cargo install wasm-bindgen-cli --version ${PINNED} --locked`,
  );
  process.exit(1);
}
if (!cli.endsWith(PINNED)) {
  console.error(
    `wasm-bindgen-cli is \`${cli}\` and the crate is pinned to ${PINNED}.\n` +
      "These must match exactly. A mismatch is not a build error - it fails at run time\n" +
      "inside the generated glue, complaining about an import nobody wrote.\n" +
      `  cargo install wasm-bindgen-cli --version ${PINNED} --locked --force`,
  );
  process.exit(1);
}

if (capture("clang", ["--version"]) === undefined) {
  console.error(
    "clang is not on PATH, and sqlite-wasm-rs compiles SQLite's C amalgamation with `cc`\n" +
      "targeting wasm32 - which MSVC cannot do. Install LLVM and put its bin directory on\n" +
      "PATH (on Windows that is usually C:\\Program Files\\LLVM\\bin).",
  );
  process.exit(1);
}

// --- build -----------------------------------------------------------------------------
run("cargo", [
  "build",
  "--manifest-path",
  join("src-tauri", "Cargo.toml"),
  "--target",
  "wasm32-unknown-unknown",
  "--release",
  "--lib",
  "--locked",
]);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
run("wasm-bindgen", [
  "--target",
  "web",
  "--out-dir",
  OUT,
  // No `.d.ts`: `src/workers/db.ts` declares the functions it calls by hand, and tsconfig's
  // `include` is `src` alone - a generated declaration outside it would be typed by nothing
  // and would break the desktop build on a checkout that never ran this script.
  "--no-typescript",
  join("src-tauri", "target", "wasm32-unknown-unknown", "release", "mtg_grimoire_lib.wasm"),
]);

// --- the gate no compiler can be --------------------------------------------------------
const gluePath = join(OUT, "mtg_grimoire_lib.js");
const glue = readFileSync(gluePath, "utf8");
const missing = EXPORTS.filter((name) => !new RegExp(`^export function ${name}\\b`, "m").test(glue));
if (missing.length > 0) {
  console.error(
    `${gluePath} does not export: ${missing.join(", ")}\n` +
      "Every name above is one `src/workers/db.ts` calls. The likeliest cause is a missing\n" +
      "`#[wasm_bindgen]` attribute in `src-tauri/src/web/glue.rs` - which compiles clean,\n" +
      "with no error and no warning, because the function is still `pub` in a `pub mod`.",
  );
  process.exit(1);
}

// The web bundle's `publicDir` is `web/public`, so it does not get the repo's `public/`.
// `index.html` links the favicon by absolute path, and copying it here keeps that one
// `index.html` serving both builds.
copyFileSync(
  join("public", "mtg-grimoire-mark.svg"),
  join("web", "public", "mtg-grimoire-mark.svg"),
);

console.log(`wasm core built into ${OUT}, exporting ${EXPORTS.join(", ")}`);
