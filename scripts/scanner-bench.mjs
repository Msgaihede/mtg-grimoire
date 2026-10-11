#!/usr/bin/env node
// What one frame costs the card scanner as WebAssembly in a Worker — and, beside it, natively.
//
//   pnpm scanner:bench                        build, run in headless Chrome, print the summary
//   pnpm scanner:bench --native            the same frames through the native runner too
//   pnpm scanner:bench --sizes             the module's size, with the readers and without
//   pnpm scanner:bench --simd              the module built with WebAssembly's 128-bit SIMD,
//                                                which the readers' inference has a kernel for
//   pnpm scanner:bench --dir <inputs>      a directory `bench-prep` made (a real bundle)
//   pnpm scanner:bench --serve --port 8787 leave the page up for a browser — a phone's,
//                                                after `adb reverse tcp:8787 tcp:8787`
//   pnpm scanner:bench --summarise <file>  reduce a native runner's output (`adb shell`)
//   pnpm scanner:bench --trap              after the run, panic in the module on purpose
//                                                and report what the next frame meets
//
// Also `--runs <n>` (3), `--frames <n>` (30), `--no-build`, which trusts `web/pkg/` as it is,
// and `--out <file>`, which writes the JSON there as well — stdout ends with the run's one
// status line, so a file is what another program should read.
//
// **What it measures is `crates/card-scanner/bench`**: the crate behind three exports, built
// with the web host's own profile (`lto = "fat"`, one codegen unit, `panic = "abort"`), and a
// page that posts each frame to a dedicated Worker as a transferred `ArrayBuffer` — the trip a
// camera page's frame makes. The page does the measuring and shows it as text; this script
// builds the module, serves the folder, opens the page in a headless Chromium and prints what
// it found, as JSON on stdout and as the page's own text on stderr.
//
// **It is a measurement with two things it refuses to pass.** The figures are for a reader and
// no threshold is held to any of them; but a run exits 1, after printing everything it found,
// when
//
//   * **a mode answered `ok` on no frame of a run**, on any host — every frame refused, or a
//     session that never loaded, would otherwise be a table of fast, empty calls; or
//   * **under `--native`, the hosts disagree** — per configuration (readers or none) and mode,
//     the native runs and the module must agree on how many frames answered `ok`, how many
//     decisions there were, on which frame the first fell and what each one named, how many
//     frames a reader ran on, and how many reads there were and what they matched. Every host
//     resolves inside the frame here (`native.rs` says why), so the frame a decision lands on
//     is comparable across all three, the one-thread native run included. **Never a timing.**
//
// A disagreement is a finding before it is a bug: the module's inference runs other kernels
// than a desktop's and a read on the edge may fall the other way. It is still the one thing
// this run exists to notice, so it is not let through as a pass.
//
// **Synthetic inputs unless `--dir` names real ones.** With no `--dir`, `bench-prep` invents a
// bundle the size of the published one, two cards and a burst of frames of each, under the
// scanner's `target/` — every stage runs, and no figure says anything about accuracy. No models
// are invented, so the readers do not run until a directory holds them.
//
// **The `wasm-bindgen` CLI must be exactly the version the bench's lockfile resolves**, for the
// reason `scripts/build-wasm.mjs` gives at length; the bench pins the repository's own.
//
// The browser and its DevTools socket are `scripts/web-smoke/harness.mjs`'s — the web smoke's
// own launcher, with nothing intercepted: the only host this page asks is this script.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";
import { summarise, textOf } from "../crates/card-scanner/bench/web/summary.js";
import {
  connect,
  discard,
  fail,
  launch,
  openPage,
  pause,
  runAs,
  undo,
} from "./web-smoke/harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = join(ROOT, "crates/card-scanner");
const BENCH = join(SCANNER, "bench");
const WEB = join(BENCH, "web");
/** Both packages build here: the tree `.gitignore` covers, and never the app's. */
const TARGET_DIR = join(SCANNER, "target");
const TARGET = "wasm32-unknown-unknown";
/** The bench's own copy of the web host's profile. */
const PROFILE = "wasm";
const MODULE = "scanner_bench";
/**
 * The builds: with the readers compiled in, without them, and with them and `simd128`.
 *
 * **`simd` is the one that is not the web host's build**: the root's `wasm` profile sets no
 * target feature, so the module the app ships is scalar. It is here because the readers'
 * inference (`rten`) has a WASM kernel it compiles only under that feature, and what that is
 * worth in a Worker is a figure the next step needs. It builds into a tree of its own —
 * changed flags would otherwise recompile every dependency twice a run, there and back.
 */
const BUILDS = {
  ocr: { features: [], rustflags: null, tree: TARGET_DIR },
  lean: { features: ["--no-default-features"], rustflags: null, tree: TARGET_DIR },
  simd: {
    features: [],
    rustflags: "-C target-feature=+simd128",
    tree: join(TARGET_DIR, "simd128"),
  },
};
/** Where the invented inputs go when no `--dir` is given. */
const INVENTED = join(TARGET_DIR, "bench-inputs");
const EXE = process.platform === "win32" ? ".exe" : "";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  // Chromium refuses to stream-compile a module served as anything else.
  ".wasm": "application/wasm",
};

// --- arguments -------------------------------------------------------------------------------

function options() {
  const given = process.argv.slice(2);
  const flag = (name) => given.includes(name);
  const value = (name, otherwise) => {
    const at = given.indexOf(name);
    return at >= 0 && given[at + 1] !== undefined ? given[at + 1] : otherwise;
  };
  return {
    dir: value("--dir", null),
    runs: Number(value("--runs", 3)),
    frames: Number(value("--frames", 30)),
    port: Number(value("--port", 0)),
    summarise: value("--summarise", null),
    out: value("--out", null),
    build: !flag("--no-build"),
    sizes: flag("--sizes"),
    native: flag("--native"),
    serve: flag("--serve"),
    trap: flag("--trap"),
    simd: flag("--simd"),
  };
}

// --- processes -------------------------------------------------------------------------------

/** Run a command to its end with its output on stderr, and fail the run if it failed. */
function run(command, args, env = process.env) {
  // stdout is the summary's, so a build's chatter goes to stderr with its warnings.
  const result = spawnSync(command, args, { cwd: ROOT, env, stdio: ["ignore", 2, 2] });
  if (result.error) fail(`could not run \`${command}\`: ${result.error.message}`);
  if (result.status !== 0) fail(`\`${command} ${args.join(" ")}\` exited ${result.status}`);
}

/** A command's stdout, or `undefined` when it could not be run or did not succeed. */
function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", 2],
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout;
}

// --- the module ------------------------------------------------------------------------------

/** The `wasm-bindgen` crate's version, as the bench's own lockfile resolves it. */
function lockedBindgen() {
  const lock = readFileSync(join(BENCH, "Cargo.lock"), "utf8");
  const found = /\[\[package\]\]\r?\nname = "wasm-bindgen"\r?\nversion = "([^"]+)"/.exec(lock);
  if (!found) fail("crates/card-scanner/bench/Cargo.lock has no `wasm-bindgen` package.");
  return found[1];
}

/** Build one of {@link BUILDS} into `web/pkg/<name>/`, and answer what it weighs. */
function buildModule(name) {
  const { features, rustflags, tree } = BUILDS[name];
  run(
    "cargo",
    [
      "build",
      "--manifest-path",
      join(BENCH, "Cargo.toml"),
      "--target-dir",
      tree,
      "--lib",
      "--target",
      TARGET,
      "--profile",
      PROFILE,
      "--locked",
      ...features,
    ],
    rustflags === null ? process.env : { ...process.env, RUSTFLAGS: rustflags },
  );
  const built = join(tree, TARGET, PROFILE, `${MODULE}.wasm`);
  if (!existsSync(built)) fail(`cargo finished and ${built} is not there.`);
  const out = join(WEB, "pkg", name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // As the web host's module is made: no function names, no producers section, no `wasm-opt`.
  run("wasm-bindgen", [
    "--target",
    "web",
    "--out-dir",
    out,
    "--remove-name-section",
    "--remove-producers-section",
    built,
  ]);
  return sizeOf(name);
}

/** A built module's bytes: as served, and through brotli at its highest setting. */
function sizeOf(name) {
  const wasm = join(WEB, "pkg", name, `${MODULE}_bg.wasm`);
  if (!existsSync(wasm)) return null;
  const bytes = readFileSync(wasm);
  return {
    wasm_bytes: bytes.length,
    wasm_brotli_bytes: brotliCompressSync(bytes).length,
    glue_bytes: statSync(join(WEB, "pkg", name, `${MODULE}.js`)).size,
  };
}

function build({ sizes, simd }) {
  const crate = lockedBindgen();
  const cli = capture("wasm-bindgen", ["--version"])?.trim().split(/\s+/)[1];
  if (cli === undefined) {
    fail(
      "the `wasm-bindgen` CLI is not on PATH. Install the version the bench's lockfile resolves:\n" +
        `  cargo install wasm-bindgen-cli --version ${crate} --locked`,
    );
  }
  if (cli !== crate) {
    fail(
      `the \`wasm-bindgen\` CLI is ${cli} and crates/card-scanner/bench/Cargo.lock resolves the ` +
        `crate to ${crate}. The two must be the same version exactly (scripts/build-wasm.mjs).`,
    );
  }
  // The lean build first, so the module left in cargo's tree is the one a later run reuses.
  return {
    lean: sizes ? buildModule("lean") : sizeOf("lean"),
    ocr: buildModule("ocr"),
    simd: simd ? buildModule("simd") : sizeOf("simd"),
  };
}

// --- the inputs ------------------------------------------------------------------------------

/** The directory a run reads: `--dir`, or one `bench-prep` invents under the build tree. */
function inputs(dir) {
  if (dir !== null) {
    const named = resolve(dir);
    if (!existsSync(join(named, "card-hashes.bin"))) fail(`${named} holds no card-hashes.bin.`);
    return named;
  }
  if (!existsSync(join(INVENTED, "card-hashes.bin"))) {
    console.error(`scanner-bench: no --dir, so inventing inputs in ${INVENTED}`);
    run("cargo", [
      "run",
      "--release",
      "--manifest-path",
      join(SCANNER, "Cargo.toml"),
      "--target-dir",
      TARGET_DIR,
      "--features",
      "builder",
      "--bin",
      "bench-prep",
      "--locked",
      "--",
      "--out",
      INVENTED,
    ]);
  }
  return INVENTED;
}

/** What the page is told the directory holds — made per request, so a file dropped in is seen. */
function manifest(dir) {
  const size = (name) => (existsSync(join(dir, name)) ? statSync(join(dir, name)).size : null);
  const models = ["models/text-detection.rten", "models/text-recognition.rten"];
  const both = models.every((name) => size(name) !== null);
  const frames = existsSync(join(dir, "frames"))
    ? readdirSync(join(dir, "frames"))
        .filter((name) => /\.(jpe?g|png)$/i.test(name))
        .sort()
        .map((name) => `frames/${name}`)
    : [];
  return {
    bundle: "card-hashes.bin",
    bundle_bytes: size("card-hashes.bin"),
    labels: size("labels.json") === null ? null : "labels.json",
    labels_bytes: size("labels.json"),
    models: both ? { detection: models[0], recognition: models[1] } : null,
    models_bytes: both ? size(models[0]) + size(models[1]) : null,
    frames,
  };
}

// --- the server ------------------------------------------------------------------------------

/** `web/` at the root and the inputs under `/inputs/`, on this machine's loopback only. */
async function serve(dir, port) {
  const under = (root, path) => {
    const onDisk = normalize(join(root, path));
    const inside = onDisk.startsWith(root + sep) && existsSync(onDisk) && statSync(onDisk).isFile();
    return inside ? onDisk : null;
  };
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    if (path === "/inputs/manifest.json") {
      response.writeHead(200, { "Content-Type": TYPES[".json"], "Cache-Control": "no-store" });
      return void response.end(JSON.stringify(manifest(dir)));
    }
    const file = path.startsWith("/inputs/")
      ? under(dir, path.slice("/inputs/".length))
      : under(WEB, path === "/" ? "index.html" : path.slice(1));
    if (file === null) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      return void response.end("Not found");
    }
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Content-Length": body.length,
      // A rebuilt module under the same name must be the one the next run loads.
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });
  await new Promise((done) => server.listen(port, "127.0.0.1", done));
  undo.push(() => {
    server.close();
    server.closeAllConnections();
  });
  return `http://localhost:${server.address().port}`;
}

// --- the two hosts ---------------------------------------------------------------------------

/** The page's own run, in a headless Chromium: its summary, or the sentence it failed with. */
async function inBrowser(origin, { runs, frames, trap, simd }) {
  const profile = await mkdtemp(join(tmpdir(), "grimoire-scanner-bench-"));
  let browser = null;
  let stop = () => undefined;
  // In a `finally`, and around the launch itself: a browser that never listens, or a page that
  // never finishes, must not leave its profile in the temp directory — `launch` puts the
  // process on the harness's undo list, and nothing puts the folder there.
  try {
    const { address, kill } = await launch(profile);
    stop = kill;
    browser = await connect(address);
    const asks =
      `runs=${runs}&frames=${frames}` + (trap ? "&trap=1" : "") + (simd ? "&module=simd" : "");
    const page = await openPage(browser, `${origin}/?${asks}`, () => undefined);
    const result = await page.until(
      "the bench to finish",
      "window.__scannerBench?.done ? JSON.stringify(window.__scannerBench) : null",
      20 * 60_000,
    );
    const { summary, error } = JSON.parse(result);
    if (error) fail(`the page's run failed: ${error}`);
    return summary;
  } finally {
    browser?.close();
    stop();
    // The browser lets go of its profile a moment after it is told to stop.
    await pause(500);
    await discard(profile);
  }
}

/** The native runner over the same directory — with its threads, and held to one. */
function natively(dir, { runs, frames }) {
  run("cargo", [
    "build",
    "--release",
    "--manifest-path",
    join(BENCH, "Cargo.toml"),
    "--target-dir",
    TARGET_DIR,
    "--bin",
    "scanner-bench-native",
    "--locked",
  ]);
  const runner = join(TARGET_DIR, "release", `scanner-bench-native${EXE}`);
  return [[], ["--one-thread"]].map((extra) => {
    const printed = capture(runner, [dir, "--runs", `${runs}`, "--frames", `${frames}`, ...extra]);
    if (printed === undefined) fail(`${runner} ${extra.join(" ")} failed.`);
    return summarise(JSON.parse(printed));
  });
}

// --- what a run is held to -------------------------------------------------------------------

/**
 * What every host must agree on, per configuration and mode: frames, how many answered `ok`,
 * the decisions — how many, on which frame the first fell, what each named — how many frames a
 * reader ran on, and the reads with what they matched. No timing is on the list.
 */
const AGREED = [
  "frames",
  "ok_frames",
  "decisions",
  "decided_at",
  "decided",
  "read_frames",
  "titles",
  "collectors",
];

const called = (config) => (config.ocr ? "with the readers" : "no readers");

/** Each mode of each configuration of each host in which some run answered `ok` on no frame. */
function emptyRuns(summaries) {
  const found = [];
  for (const summary of summaries) {
    for (const config of summary.configs) {
      for (const mode of config.modes) {
        if (mode.ok_frames.length === 0 || mode.ok_frames.some((ok) => ok === 0)) {
          const said = mode.errors.length ? ` — ${mode.errors.join(" | ")}` : "";
          found.push(
            `${summary.host}, ${called(config)}, ${mode.mode}: no frame answered ok ` +
              `(${mode.ok_frames.join("/")} of ${mode.frames})${said}`,
          );
        }
      }
    }
  }
  return found;
}

/**
 * Where `other` parts from `reference` on anything in {@link AGREED}, as sentences. A
 * configuration only one of them ran — a module built without the readers has no second one —
 * is not a disagreement; a mode only one of them ran is.
 */
function disagreements(reference, other) {
  const found = [];
  for (const config of reference.configs) {
    const theirs = other.configs.find((candidate) => candidate.ocr === config.ocr);
    if (!theirs) continue;
    for (const mode of config.modes) {
      const where = `${called(config)}, ${mode.mode}`;
      const same = theirs.modes.find((candidate) => candidate.mode === mode.mode);
      if (!same) {
        found.push(`${where}: ${reference.host} ran it and ${other.host} did not`);
        continue;
      }
      for (const key of AGREED) {
        const [ours, others] = [JSON.stringify(mode[key]), JSON.stringify(same[key])];
        if (ours !== others) {
          found.push(
            `${where}: \`${key}\` is ${ours} on ${reference.host} and ${others} on ${other.host}`,
          );
        }
      }
    }
  }
  return found;
}

// --- the run ---------------------------------------------------------------------------------

/** The result, on stdout for a reader and in `--out`'s file for a program. */
function print(result, out) {
  const json = JSON.stringify(result, null, 2);
  if (out !== null) writeFileSync(out, `${json}\n`);
  console.log(json);
}

async function main(asked) {
  if (asked.summarise !== null) {
    const summary = summarise(JSON.parse(readFileSync(asked.summarise, "utf8")));
    console.error(textOf(summary));
    return print(summary, asked.out);
  }

  const sizes = asked.build
    ? build(asked)
    : { lean: sizeOf("lean"), ocr: sizeOf("ocr"), simd: sizeOf("simd") };
  if (sizes.ocr === null)
    fail("crates/card-scanner/bench/web/pkg/ocr is not built: drop --no-build.");
  if (asked.simd && sizes.simd === null) fail("…/web/pkg/simd is not built: drop --no-build.");
  for (const name of ["lean", "simd"]) if (sizes[name] === null) delete sizes[name];
  const dir = inputs(asked.dir);
  const origin = await serve(dir, asked.port);

  if (asked.serve) {
    console.error(
      `scanner-bench: serving ${dir}\n  ${origin}/?runs=${asked.runs}&frames=${asked.frames}\n` +
        "  Ctrl-C to stop.",
    );
    await new Promise(() => undefined);
  }

  const native = asked.native ? natively(dir, asked) : [];
  const wasm = await inBrowser(origin, asked);
  for (const summary of [...native, wasm]) console.error(`\n${textOf(summary)}`);
  // Everything found is printed before anything is refused: a run that fails is the one whose
  // figures somebody will want to read.
  const refused = [
    ...emptyRuns([...native, wasm]),
    ...[...native.slice(1), wasm].flatMap((other) =>
      native.length > 0 ? disagreements(native[0], other) : [],
    ),
  ];
  print({ inputs: dir, sizes, native, wasm, refused }, asked.out);
  if (refused.length > 0) {
    fail(`${refused.length} thing(s) a run may not pass with:\n  ${refused.join("\n  ")}`);
  }
  if (native.length > 0) {
    console.error(
      `\nscanner-bench: ${native.length + 1} hosts agree on ${AGREED.join(", ")} in every mode.`,
    );
  }
}

const asked = options();
// A page left up for a phone is up until somebody stops it; a run is bounded, builds and all.
await runAs("scanner-bench", asked.serve ? 12 * 3_600_000 : 45 * 60_000, () => main(asked));
