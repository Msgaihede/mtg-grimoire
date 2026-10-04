#!/usr/bin/env node
// Build the web host's module: `grimoire-web` for `wasm32-unknown-unknown`, then
// `wasm-bindgen --target web` into `dist-wasm/` at the repository root.
//
//   node scripts/build-wasm.mjs            the module a page ships
//   node scripts/build-wasm.mjs --names    the same, keeping every function's name
//
// It leaves `dist-wasm/grimoire_web.js`, `dist-wasm/grimoire_web_bg.wasm` and their `.d.ts`
// files, and prints the module's size in bytes and how long the build took.
//
// **The function names are taken out unless `--names` asks for them.** They are a custom
// section nothing executes — 927 282 B of a 7 729 043 B module, measured 2026-10-04 at step
// 5.5 (it was 1.6 MB of 10.1 MB while the module still carried an OCR runtime) — and what they
// buy is a named wasm frame in a trap's stack. A panic's own sentence and its file and line do
// not need them: the panic hook writes those to the Worker's console either way.
//
// Three things are checked here rather than assumed, because each fails in a way that does not
// name itself:
//
//   * **The `wasm-bindgen` CLI must be exactly the version `Cargo.lock` resolves.** The CLI
//     has a check of its own, and it is narrower than it sounds: it reads the module's
//     `__wbindgen_schema_version` and bails ("…linked against version of wasm-bindgen that
//     uses a different bindgen format than this binary…") when that is not *its* schema. The
//     schema version is not the crate's version — `wasm-bindgen-shared` 0.2.127 is on schema
//     `0.2.122` and 0.2.129 on `0.2.128`, read from their source on 2026-10-04 — so a CLI from
//     a neighbouring release on the same schema is let through, and nothing then promises its
//     glue fits this crate. That pair is what the first web host's warning was about: "compiles
//     and links, and then fails at run time inside the generated glue, complaining about an
//     import nobody wrote". It has not been reproduced in this tree; exact equality is the one
//     pair anybody has run, so it is the one this script accepts. The crate's version is read
//     from the lockfile, so there is no third place for the number to be written down.
//   * **clang 18 or newer must be reachable.** `sqlite-wasm-rs` compiles SQLite's C with `cc`
//     for wasm32, which MSVC cannot emit and older clangs get wrong; without one the failure
//     is a `cc` error a hundred lines into a build log.
//   * **Every function the Worker imports must be exported.** Deleting a `#[wasm_bindgen]`
//     attribute compiles with no error and no warning — the function is still `pub` — and the
//     failure surfaces only when a browser loads the module and finds the export missing.
//
// No `wasm-opt` and no `wasm-pack`: neither is required, and neither is on the machines that
// build this.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "wasm32-unknown-unknown";
/** The profile the root `Cargo.toml` defines for this build, and its folder under the target. */
const PROFILE = "wasm";
const PACKAGE = "grimoire-web";
/** The library's name, which is what cargo calls the artifact and `wasm-bindgen` the glue. */
const MODULE = "grimoire_web";
const OUT = join(ROOT, "dist-wasm");
/** Every `#[wasm_bindgen]` function the Worker's script reaches for (`crates/grimoire-web`). */
const EXPORTS = ["open", "call", "listen"];
/** Keep the `name` section: a readable wasm stack, for somebody chasing a trap. */
const KEEP_NAMES = process.argv.includes("--names");
/** `sqlite-wasm-rs` needs clang 18 or newer to compile SQLite for wasm32. */
const CLANG_FLOOR = 18;
/** Where the LLVM installer puts clang on Windows — not on `PATH`, and `cc` does not look. */
const WINDOWS_LLVM = "C:\\Program Files\\LLVM\\bin";

function refuse(message) {
  console.error(`build-wasm: ${message}`);
  process.exit(1);
}

/** Run a command to its end with its output shown, and stop the script if it failed. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: ROOT, ...options });
  if (result.error) refuse(`could not run \`${command}\`: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** A command's stdout, or `undefined` when it could not be run or did not succeed. */
function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim();
}

// --- the wasm-bindgen pair -------------------------------------------------------------------

/** The `wasm-bindgen` crate's version, as `Cargo.lock` resolves it. */
function lockedBindgen() {
  const lock = readFileSync(join(ROOT, "Cargo.lock"), "utf8");
  const found = /\[\[package\]\]\r?\nname = "wasm-bindgen"\r?\nversion = "([^"]+)"/.exec(lock);
  if (!found) refuse("Cargo.lock has no `wasm-bindgen` package, so there is no version to match.");
  return found[1];
}

const crate = lockedBindgen();
const cli = capture("wasm-bindgen", ["--version"]);
if (cli === undefined) {
  refuse(
    "the `wasm-bindgen` CLI is not on PATH. Install the version Cargo.lock resolves:\n" +
      `  cargo install wasm-bindgen-cli --version ${crate} --locked`,
  );
}
// `wasm-bindgen 0.2.127`, possibly with a commit after it.
const cliVersion = cli.split(/\s+/)[1];
if (cliVersion !== crate) {
  refuse(
    `the \`wasm-bindgen\` CLI is ${cliVersion} and Cargo.lock resolves the crate to ${crate}.\n` +
      "The two must be the same version exactly. The CLI itself only refuses a module on a\n" +
      "different bindgen schema, and a release shares its schema with its neighbours — so a\n" +
      "near miss gets through that check with glue nobody has tested. Install the matching CLI:\n" +
      `  cargo install wasm-bindgen-cli --version ${crate} --locked --force`,
  );
}

// --- clang -----------------------------------------------------------------------------------

/** clang's major version, or `undefined` when `compiler` is not a clang that answers. */
function clangMajor(compiler) {
  const said = capture(compiler, ["--version"]);
  const found = said === undefined ? null : /clang version (\d+)\./.exec(said);
  return found ? Number(found[1]) : undefined;
}

/**
 * The C compiler and the archiver for the wasm32 target: what the environment already names,
 * else `clang` on PATH, else — on Windows — the LLVM installer's own folder.
 */
function toolchain() {
  const env = { ...process.env };
  const named = env.CC_wasm32_unknown_unknown;
  let compiler;
  if (named) {
    compiler = named;
  } else if (clangMajor("clang") !== undefined) {
    compiler = "clang";
  } else if (process.platform === "win32" && existsSync(join(WINDOWS_LLVM, "clang.exe"))) {
    compiler = join(WINDOWS_LLVM, "clang.exe");
    env.CC_wasm32_unknown_unknown = compiler;
  } else {
    refuse(
      "no clang was found. `sqlite-wasm-rs` compiles SQLite's C for wasm32, which needs clang\n" +
        `${CLANG_FLOOR} or newer: put it on PATH, or name it in CC_wasm32_unknown_unknown` +
        (process.platform === "win32" ? ` (the LLVM installer puts it in ${WINDOWS_LLVM}).` : "."),
    );
  }
  const major = clangMajor(compiler);
  if (major === undefined) {
    refuse(`\`${compiler} --version\` did not answer as a clang.`);
  }
  if (major < CLANG_FLOOR) {
    refuse(
      `\`${compiler}\` is clang ${major}, and compiling SQLite for wasm32 needs ${CLANG_FLOOR} or newer.`,
    );
  }
  // An archiver beside a compiler that was found by its path: `cc` looks for `llvm-ar` on PATH,
  // and a clang that is not on PATH has its `llvm-ar` in the same folder.
  if (!env.AR_wasm32_unknown_unknown && compiler !== "clang") {
    const exe = process.platform === "win32" ? "llvm-ar.exe" : "llvm-ar";
    const beside = join(dirname(compiler), exe);
    if (existsSync(beside)) env.AR_wasm32_unknown_unknown = beside;
  }
  return { env, compiler, major };
}

const { env, compiler, major } = toolchain();
console.log(`build-wasm: wasm-bindgen ${crate}, clang ${major} (${compiler})`);

// --- build -----------------------------------------------------------------------------------

const started = performance.now();
run(
  "cargo",
  ["build", "-p", PACKAGE, "--lib", "--target", TARGET, "--profile", PROFILE, "--locked"],
  { env },
);

// Asked of cargo rather than assumed: `.cargo/config.toml` pins the build tree, and an
// environment may move it.
const metadata = capture("cargo", ["metadata", "--format-version", "1", "--no-deps", "--locked"]);
if (metadata === undefined) refuse("`cargo metadata` could not say where the build tree is.");
const built = join(JSON.parse(metadata).target_directory, TARGET, PROFILE, `${MODULE}.wasm`);
if (!existsSync(built)) refuse(`cargo finished and ${built} is not there.`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
run("wasm-bindgen", [
  "--target",
  "web",
  "--out-dir",
  OUT,
  ...(KEEP_NAMES ? [] : ["--remove-name-section"]),
  "--remove-producers-section",
  built,
]);

// --- the gate no compiler can be -------------------------------------------------------------

const glue = join(OUT, `${MODULE}.js`);
const wasm = join(OUT, `${MODULE}_bg.wasm`);
for (const file of [glue, wasm]) {
  if (!existsSync(file)) refuse(`wasm-bindgen finished and ${file} is not there.`);
}
const source = readFileSync(glue, "utf8");
const missing = EXPORTS.filter(
  (name) => !new RegExp(`^export (async )?function ${name}\\b`, "m").test(source),
);
if (missing.length > 0) {
  refuse(
    `${glue} does not export: ${missing.join(", ")}.\n` +
      "Each is a function the Worker's script calls. The likeliest cause is a missing\n" +
      "`#[wasm_bindgen]` attribute in crates/grimoire-web/src/glue.rs, which compiles with no\n" +
      "error and no warning.",
  );
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(
  `build-wasm: ${wasm} is ${statSync(wasm).size} bytes ` +
    `(profile \`${PROFILE}\`, ${KEEP_NAMES ? "function names kept" : "no function names"}, ` +
    `no wasm-opt), exporting ${EXPORTS.join(", ")}; built in ${seconds} s`,
);
