#!/usr/bin/env node
// Build the web host's two modules for `wasm32-unknown-unknown`, then `wasm-bindgen --target
// web` each into `dist-wasm/` at the repository root.
//
//   node scripts/build-wasm.mjs                  both modules, as a page ships them
//   node scripts/build-wasm.mjs --names          the same, keeping every function's name
//   node scripts/build-wasm.mjs --only engine    the engine's module alone
//   node scripts/build-wasm.mjs --only scanner   the scanner's module alone
//
// | Module | Package | Leaves |
// | --- | --- | --- |
// | the engine | `grimoire-web` | `dist-wasm/grimoire_web.js`, `grimoire_web_bg.wasm`, their `.d.ts` |
// | the scanner | `grimoire-scan` | `dist-wasm/scanner/grimoire_scan.js`, `grimoire_scan_bg.wasm`, their `.d.ts` |
//
// It prints each module's size in bytes and how long its build took. `--only` rebuilds one and
// leaves the other's files where they were.
//
// **Two modules, because the scanner must not be the engine** (the light app's step 7.5;
// `docs/reference/light-app.md` §11.2 has the figures): a panic ends an instance, and the
// engine's instance is the database; a frame a reader runs on blocks its Worker for the better
// part of a second; and a module's memory is never given back, so the page ends the scanner's
// Worker when the reader leaves it. The scanner's module is `card-scanner` alone — no SQLite,
// none of the engine.
//
// **The scanner's module is built with `-C target-feature=+simd128`, and the engine's is not.**
// `rten`, which runs the two OCR models, compiles its WebAssembly kernels only under that
// feature: without it a title read is 0.9–1.6 s, with it 0.3 s. A browser without fixed-width
// SIMD cannot compile such a module at all, which is why the flag is the scanner's alone — the
// rest of the app must not come to depend on it. So:
//
//   * the flag goes in the environment of **one** cargo run, never in `.cargo/config.toml`,
//     where it would reach every build in the tree;
//   * that run has **a build tree of its own** (`<target>/scanner-simd128`). Cargo keys an
//     artifact on its flags, but a tree holds one copy of each — two builds taking turns in one
//     tree would each throw the other's dependencies away, every run;
//   * it is `-p grimoire-scan` **and nothing else**. Features are resolved for the packages a
//     build names: built beside the engine, the scanner's crate would be compiled with the
//     `corpus` feature the engine asks it for, and the module would carry SQLite.
//
// **The engine's module has a ceiling, and a build over it fails** (`ENGINE_CEILING_BYTES`,
// below, which says what it guards, what the module measures today, and how to raise it on
// purpose: read what grew with `--only engine --names`, then change the number and the
// measurement beside it in the same commit).
//
// **The function names are taken out unless `--names` asks for them.** They are a custom
// section nothing executes — 927 282 B of a 7 729 043 B module, measured 2026-10-04 at step
// 5.5 (it was 1.6 MB of 10.1 MB while the module still carried an OCR runtime) — and what they
// buy is a named wasm frame in a trap's stack. A panic's own sentence and its file and line do
// not need them: the panic hook writes those to the Worker's console either way.
//
// Four things are checked here rather than assumed, because each fails in a way that does not
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
//     from the lockfile, so there is no third place for the number to be written down — and
//     both modules are members of the one workspace, so one version is both modules'.
//   * **clang 18 or newer must be reachable, for the engine.** `sqlite-wasm-rs` compiles
//     SQLite's C with `cc` for wasm32, which MSVC cannot emit and older clangs get wrong;
//     without one the failure is a `cc` error a hundred lines into a build log. The scanner's
//     module compiles no C, and `--only scanner` asks for no compiler.
//   * **Every function a Worker imports must be exported.** Deleting a `#[wasm_bindgen]`
//     attribute compiles with no error and no warning — the function is still `pub` — and the
//     failure surfaces only when a browser loads the module and finds the export missing.
//   * **Each module must say it was built for the features it should have been.** A module
//     lists them in its `target_features` section, and that is read back: the scanner's must
//     name `simd128` and the engine's must not. A misspelt feature is a *warning* from rustc
//     and a scalar module that reads a title three times slower; the flag leaking into the
//     engine's build is an app that will not start in a browser that would have run it.
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
const OUT = join(ROOT, "dist-wasm");
/** WebAssembly's fixed-width SIMD, as rustc and a module's `target_features` section name it. */
const SIMD = "simd128";

/**
 * The two modules. `module` is the library's name, which is what cargo calls the artifact and
 * `wasm-bindgen` the glue; `exports` is every `#[wasm_bindgen]` function a Worker's script
 * reaches for, and `glue` the file they are written in; `tree` is a folder under cargo's target
 * directory, for a build that must not share one; `features` are the target features its
 * `rustc` is told to turn on; `clang` is whether anything in its graph compiles C.
 */
const MODULES = {
  engine: {
    package: "grimoire-web",
    module: "grimoire_web",
    out: OUT,
    exports: ["open", "call", "listen", "scanner_labels"],
    glue: "crates/grimoire-web/src/glue.rs",
    tree: null,
    features: [],
    clang: true,
  },
  scanner: {
    package: "grimoire-scan",
    module: "grimoire_scan",
    out: join(OUT, "scanner"),
    exports: ["start", "load", "frame", "reset", "set_filters", "memory_bytes"],
    glue: "crates/grimoire-scan/src/glue.rs",
    tree: "scanner-simd128",
    features: [SIMD],
    clang: false,
  },
};

/** Keep the `name` section: a readable wasm stack, for somebody chasing a trap. */
const KEEP_NAMES = process.argv.includes("--names");

/**
 * **The most the engine's module may be: 8 000 000 bytes**, names stripped — and the build
 * refuses one that is over.
 *
 * The engine links `card-scanner` on every target and is kept clear of its session — the
 * detector, the hashes, `ocrs` and the `rten` crates — only by nothing in the module reaching
 * them (`Cargo.toml`'s `[profile.wasm]`). That held by accident for one step: step 7.3 put the
 * scanner's commands in the table, each shut on a page by a refusal at *run* time, and the
 * linker kept what an `async fn` could still reach — 9 961 355 B where the module had been
 * 6 902 679 B, three megabytes of an OCR runtime the engine can never run, on every reader's
 * first visit. Nothing measured it, so nothing was red (step 7.5 found it by reading a size
 * this script had printed all along; `platform::host::with_files` is the fix).
 *
 * So the size is held. **7 291 289 B on 2026-10-08**; the ceiling is 709 kB over that — a
 * little under a tenth. The engine's own growth is what the headroom is for, and it is not
 * small: one sync fix merged that day (#855, an orphans pass and a schema rung) added
 * 251 kB by itself, where the steps before it had added 30–130 kB each. So the ceiling is
 * three changes of that size away, and still 1.96 MB under what the runtime's arrival made
 * the module — the runtime is 2.6 MB and more, so it cannot come back under this number.
 *
 * **To raise it, deliberately**: build, read what grew off the name section
 * (`node scripts/build-wasm.mjs --only engine --names`, then the names by crate), and if the
 * growth is the engine's own, change this number and the date and size above in the same
 * commit. A module over the ceiling for a reason nobody has read is the case it is for.
 * The scanner's module has no ceiling: it *is* the runtime.
 */
const ENGINE_CEILING_BYTES = 8_000_000;
/** `sqlite-wasm-rs` needs clang 18 or newer to compile SQLite for wasm32. */
const CLANG_FLOOR = 18;
/** Where the LLVM installer puts clang on Windows — not on `PATH`, and `cc` does not look. */
const WINDOWS_LLVM = "C:\\Program Files\\LLVM\\bin";

function refuse(message) {
  console.error(`build-wasm: ${message}`);
  process.exit(1);
}

/** Which modules this run builds: both, or the one `--only` names. */
function asked() {
  const at = process.argv.indexOf("--only");
  if (at === -1) return Object.keys(MODULES);
  const name = process.argv[at + 1];
  if (name === undefined || !Object.hasOwn(MODULES, name)) {
    refuse(`--only takes one of: ${Object.keys(MODULES).join(", ")}.`);
  }
  return [name];
}

const BUILDING = asked();

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

// Asked for only by a build that compiles C: the scanner's module alone builds on a machine
// with no clang at all.
const needsClang = BUILDING.some((name) => MODULES[name].clang);
const { env, compiler, major } = needsClang
  ? toolchain()
  : { env: { ...process.env }, compiler: undefined, major: undefined };
console.log(
  `build-wasm: wasm-bindgen ${crate}` +
    (needsClang ? `, clang ${major} (${compiler})` : ", and no C to compile"),
);

// --- build -----------------------------------------------------------------------------------

/**
 * The environment of one module's cargo run: the toolchain's, with the module's target
 * features added to whatever flags the caller already had. `CARGO_ENCODED_RUSTFLAGS` wins over
 * `RUSTFLAGS` when both are set, so the features go where cargo will read them.
 */
function withFeatures(base, features) {
  if (features.length === 0) return base;
  const flag = `target-feature=${features.map((feature) => `+${feature}`).join(",")}`;
  if (base.CARGO_ENCODED_RUSTFLAGS !== undefined) {
    const parts = [base.CARGO_ENCODED_RUSTFLAGS, "-C", flag].filter((part) => part !== "");
    return { ...base, CARGO_ENCODED_RUSTFLAGS: parts.join("\x1f") };
  }
  return { ...base, RUSTFLAGS: `${base.RUSTFLAGS ?? ""} -C ${flag}`.trim() };
}

/** An unsigned LEB128 in `bytes` at `at`, and where the byte after it is. */
function leb(bytes, at) {
  let value = 0;
  let scale = 1;
  for (;;) {
    const byte = bytes[at++];
    if (byte === undefined) refuse("a module ends in the middle of a number.");
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return [value, at];
    scale *= 128;
  }
}

/**
 * The target features a module says it uses — the entries its `target_features` custom section
 * marks `+` — or `undefined` when it has no such section. The section is the linker's own
 * record of what the objects it linked were compiled for.
 */
function targetFeatures(bytes) {
  // Past the magic and the version, a module is sections: an id, a size, and that many bytes.
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at++];
    let size;
    [size, at] = leb(bytes, at);
    const end = at + size;
    if (id === 0) {
      let length;
      [length, at] = leb(bytes, at);
      const name = bytes.subarray(at, at + length).toString("utf8");
      at += length;
      if (name === "target_features") {
        let count;
        [count, at] = leb(bytes, at);
        const used = [];
        for (let i = 0; i < count; i++) {
          const prefix = String.fromCharCode(bytes[at++]);
          [length, at] = leb(bytes, at);
          if (prefix === "+") used.push(bytes.subarray(at, at + length).toString("utf8"));
          at += length;
        }
        return used;
      }
    }
    at = end;
  }
  return undefined;
}

// Asked of cargo rather than assumed: `.cargo/config.toml` pins the build tree, and an
// environment may move it.
const metadata = capture("cargo", ["metadata", "--format-version", "1", "--no-deps", "--locked"]);
if (metadata === undefined) refuse("`cargo metadata` could not say where the build tree is.");
const TARGET_DIR = JSON.parse(metadata).target_directory;

/** Build one module, run `wasm-bindgen` over it, hold it to its gates and print its size. */
function build(name) {
  const { package: pkg, module, out, exports, glue: written, tree, features } = MODULES[name];
  const started = performance.now();
  const target = tree === null ? TARGET_DIR : join(TARGET_DIR, tree);
  run(
    "cargo",
    [
      "build",
      "-p",
      pkg,
      "--lib",
      "--target",
      TARGET,
      "--profile",
      PROFILE,
      "--locked",
      ...(tree === null ? [] : ["--target-dir", target]),
    ],
    { env: withFeatures(env, features) },
  );
  const built = join(target, TARGET, PROFILE, `${module}.wasm`);
  if (!existsSync(built)) refuse(`cargo finished and ${built} is not there.`);

  // Only this module's own four files are cleared: the engine's folder holds the scanner's, so
  // emptying it for an `--only engine` run would take the other module with it.
  mkdirSync(out, { recursive: true });
  for (const end of [".js", ".d.ts", "_bg.wasm", "_bg.wasm.d.ts"]) {
    rmSync(join(out, module + end), { force: true });
  }
  run("wasm-bindgen", [
    "--target",
    "web",
    "--out-dir",
    out,
    ...(KEEP_NAMES ? [] : ["--remove-name-section"]),
    "--remove-producers-section",
    built,
  ]);

  // The gates no compiler can be.
  const glue = join(out, `${module}.js`);
  const wasm = join(out, `${module}_bg.wasm`);
  for (const file of [glue, wasm]) {
    if (!existsSync(file)) refuse(`wasm-bindgen finished and ${file} is not there.`);
  }
  const source = readFileSync(glue, "utf8");
  const missing = exports.filter(
    (fn) => !new RegExp(`^export (async )?function ${fn}\\b`, "m").test(source),
  );
  if (missing.length > 0) {
    refuse(
      `${glue} does not export: ${missing.join(", ")}.\n` +
        "Each is a function a Worker's script calls. The likeliest cause is a missing\n" +
        `\`#[wasm_bindgen]\` attribute in ${written}, which compiles with no\n` +
        "error and no warning.",
    );
  }
  const used = targetFeatures(readFileSync(wasm));
  if (used === undefined) {
    refuse(`${wasm} has no \`target_features\` section, so what it was built for cannot be read.`);
  }
  const simd = used.includes(SIMD);
  if (simd !== features.includes(SIMD)) {
    refuse(
      simd
        ? `${wasm} was built with \`${SIMD}\`, and the ${name}'s module must not be: a browser\n` +
            "without fixed-width SIMD could not compile it. Is the flag in RUSTFLAGS, or in a\n" +
            "`.cargo/config.toml`? It belongs to the scanner's build alone."
        : `${wasm} was not built with \`${SIMD}\`, and the ${name}'s module must be: without\n` +
            "it the readers' inference is scalar, and a title read takes three times as long.",
    );
  }

  // With the names kept the module is a megabyte and more of names larger, and is nobody's
  // to ship: the ceiling is of the module as it is served.
  const size = statSync(wasm).size;
  if (name === "engine" && !KEEP_NAMES && size > ENGINE_CEILING_BYTES) {
    refuse(
      `${wasm} is ${size} bytes, over the engine module's ceiling of ${ENGINE_CEILING_BYTES}.\n` +
        "The likeliest cause is code the engine can never run being linked into it — the card\n" +
        "scanner's session and its OCR runtime, kept by a command that refuses only at run time.\n" +
        "Read what grew (`--only engine --names`); this script's header says how to raise the\n" +
        "ceiling when the growth is the engine's own.",
    );
  }

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `build-wasm: ${wasm} is ${statSync(wasm).size} bytes ` +
      `(profile \`${PROFILE}\`, ${simd ? "with" : "without"} \`${SIMD}\`, ` +
      `${KEEP_NAMES ? "function names kept" : "no function names"}, no wasm-opt` +
      `${name === "engine" && !KEEP_NAMES ? `, ${ENGINE_CEILING_BYTES - size} under its ceiling` : ""}), ` +
      `exporting ${exports.join(", ")}; built in ${seconds} s`,
  );
}

// A run of both starts from an empty folder, so a file a module has stopped writing does not
// outlive it; a run of one leaves the other's files alone.
if (BUILDING.length === Object.keys(MODULES).length) rmSync(OUT, { recursive: true, force: true });
for (const name of BUILDING) build(name);
