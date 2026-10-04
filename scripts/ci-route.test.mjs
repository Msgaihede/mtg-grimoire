// The router against the files the two suites actually read. **The census is derived from the
// sources on every run** — the `?raw` imports of every test file vitest collects, and the
// `include_str!`/`include_bytes!`/`CARGO_MANIFEST_DIR` reads of every Rust source — so a new
// crossing is checked the day it lands, with nobody remembering to add it to a list. The
// sentence this replaced ("the two build jobs share no inputs") was false for as long as
// `ipc.test.ts` had existed, and nothing could notice.
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { ARMS, JOBS, armFor, route } from "./ci-route.mjs";
import ciYml from "../.github/workflows/ci.yml?raw";

// Vite needs both glob arguments as literals, so the options repeat.
// Mirrors `test.include` in `vite.config.ts`: every file vitest collects.
const TS_TESTS = import.meta.glob(
  [
    "/src/**/*.test.{ts,tsx}",
    "/.storybook/**/*.test.ts",
    "/relay/src/**/*.test.ts",
    "/share-worker/src/**/*.test.ts",
    "/app-worker/src/**/*.test.ts",
    "/share/**/*.test.{ts,tsx}",
    "/mobile/**/*.test.{ts,tsx}",
    "/scripts/**/*.test.mjs",
  ],
  { query: "?raw", import: "default", eager: true },
);

// Every cargo package `rust` tests: the app, the engine in `crates/grimoire-core` — whose tests
// run in `rust` and in no other job — and `card-scanner`. `target/` is never globbed.
const RUST = import.meta.glob(
  [
    "/src-tauri/src/**/*.rs",
    "/src-tauri/build.rs",
    "/crates/*/src/**/*.rs",
    "/crates/*/build.rs",
    "/mobile/src-tauri/src/**/*.rs",
    "/mobile/src-tauri/build.rs",
  ],
  { query: "?raw", import: "default", eager: true },
);

/** Repo-relative, no leading slash — the shape `git diff --name-only` prints. */
const rel = (abs) => posix.normalize(abs).replace(/^\/+/, "");

/**
 * A read of a directory stands for any file in it. `git diff` never names a directory, and
 * `case` patterns end in `/*`, so the directory's own path would match the wrong arm.
 */
const asChangedFile = (path) => (posix.extname(path) === "" ? `${path}/any-file` : path);

/** Every file a collected test reads as text, resolved to the repo path it names. */
function tsReads() {
  const out = [];
  for (const [file, src] of Object.entries(TS_TESTS)) {
    for (const [, spec] of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)\?raw["']/g)) {
      let abs;
      if (spec.startsWith("@/")) abs = `/src/${spec.slice(2)}`;
      else if (spec.startsWith("/")) abs = spec;
      else if (spec.startsWith(".")) abs = posix.join(posix.dirname(file), spec);
      else continue; // A package in `node_modules/`, which no diff names.
      out.push({ reader: rel(file), path: rel(abs) });
    }
  }
  return out;
}

/** Every file a Rust source reads at compile or test time, resolved to its repo path. */
function rustReads() {
  const out = [];
  for (const [file, src] of Object.entries(RUST)) {
    const crate = rel(file).startsWith("src-tauri/")
      ? "src-tauri"
      : rel(file).split("/").slice(0, 2).join("/");
    const push = (path) => out.push({ reader: rel(file), path: rel(path) });
    // Relative to the file that names it.
    for (const [, p] of src.matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)/g)) {
      push(posix.join(posix.dirname(file), p));
    }
    // Relative to the crate root: `Path::new(env!("CARGO_MANIFEST_DIR")).join("…")`.
    for (const [, p] of src.matchAll(
      /env!\("CARGO_MANIFEST_DIR"\)\s*\)\s*\.join\(\s*"([^"]+)"\s*\)/g,
    )) {
      push(posix.join(`/${crate}`, p));
    }
    // And `concat!(env!("CARGO_MANIFEST_DIR"), "/…")`.
    for (const [, p] of src.matchAll(
      /concat!\(\s*env!\("CARGO_MANIFEST_DIR"\)\s*,\s*"([^"]+)"\s*\)/g,
    )) {
      push(posix.join(`/${crate}`, p));
    }
  }
  return out;
}

const RUST_OWNED = /^(src-tauri|crates|mobile\/src-tauri)\//;

describe("the census", () => {
  const ts = tsReads();
  const rust = rustReads();

  // Guards the regexes above: a census that matched nothing would pass every assertion below.
  it("finds the crossings that motivated it", () => {
    const tsPaths = ts.map((r) => r.path);
    const rustPaths = rust.map((r) => r.path);
    // Both halves of a module the core extraction split: the engine's file, and the desktop's
    // command wrappers beside it.
    expect(tsPaths).toContain("crates/grimoire-core/src/deck.rs");
    expect(tsPaths).toContain("src-tauri/src/deck/mod.rs");
    expect(tsPaths).toContain("src-tauri/src/share/__golden__/snapshot.json");
    expect(tsPaths).toContain("src-tauri/tauri.conf.json");
    expect(tsPaths).toContain("crates/card-scanner/src/session.rs");
    expect(rustPaths).toContain("src/lib/userTables.json");
    expect(rustPaths).toContain("src/lib/syncedTables.json");
    expect(rustPaths).toContain("src/features/transfer/__golden__");
    expect(rustPaths).toContain("src/features/transfer/__golden__/corpus.json");
    expect(rustPaths).toContain("share-worker/wrangler.jsonc");
    expect(rustPaths).toContain("release-please-config.json");
  });

  // The engine's sources are in the census by the same glob as `card-scanner`'s, so a file one
  // of them reads is held to `rust` below — where its tests run; `core` only compiles. A crate
  // the glob missed would be a crate whose reads nothing checks.
  it("reads every package's sources, the engine's among them", () => {
    const sources = Object.keys(RUST).map(rel);
    expect(sources).toContain("crates/grimoire-core/src/lib.rs");
    expect(sources).toContain("crates/card-scanner/src/session.rs");
    expect(sources).toContain("src-tauri/src/desktop.rs");
    expect(sources).toContain("mobile/src-tauri/src/lib.rs");
  });

  it("routes every file a frontend test reads to `frontend`", () => {
    const missed = ts.filter((r) => !route([asChangedFile(r.path)]).frontend);
    expect(missed).toEqual([]);
  });

  it("routes every file a Rust source reads to `rust`", () => {
    const missed = rust.filter((r) => !route([asChangedFile(r.path)]).rust);
    expect(missed).toEqual([]);
  });

  // The bug this file exists for: a crossing must run the side that reads it AND the side that
  // owns it, or a change on one side goes red on the next unrelated PR.
  it("routes every crossing to both `frontend` and `rust`", () => {
    const crossings = [
      ...ts.filter((r) => RUST_OWNED.test(r.path)),
      ...rust.filter((r) => !r.path.startsWith(`${r.reader.split("/")[0]}/`)),
    ];
    expect(crossings.length).toBeGreaterThan(0);
    const missed = crossings.filter((r) => {
      const on = route([asChangedFile(r.path)]);
      return !(on.frontend && on.rust);
    });
    expect(missed).toEqual([]);
  });
});

describe("the arms", () => {
  const T = true;
  const F = false;
  // [path, frontend, rust, core, powershell, storybook, android, web]
  it.each([
    [".github/workflows/ci.yml", T, T, T, T, T, T, T],
    ["scripts/ci-route.mjs", T, T, T, T, T, T, T],
    ["rust-toolchain.toml", T, T, T, F, F, T, T],
    [".github/actions/rust-toolchain/action.yml", T, T, T, F, F, T, T],
    ["Cargo.toml", T, T, T, F, F, T, T],
    ["Cargo.lock", T, T, T, F, F, T, T],
    [".cargo/config.toml", T, T, T, F, F, T, T],
    [".github/workflows/release.yml", T, F, F, F, F, F, F],
    [".github/workflows/scanner-bundle.yml", T, F, F, F, F, F, F],
    // A measurement on an emulator, outside the gate (step 4.5): its pins and its toolchain are
    // `frontend`'s to check, and its script sits in `scripts/` like the router itself.
    [".github/workflows/android-emulator.yml", T, F, F, F, F, F, F],
    ["scripts/android-first-run.sh", T, F, F, F, F, F, F],
    [".github/dependabot.yml", T, F, F, F, F, F, F],
    [".nvmrc", T, F, F, F, T, F, T],
    ["src/lib/core/index.ts", T, F, F, F, T, F, T],
    ["docs/reference/ci-and-releases.md", F, F, F, F, F, F, F],
    ["README.md", F, F, F, F, F, F, F],
    ["src/features/decks/CLAUDE.md", F, F, F, F, F, F, F],
    [".storybook/CLAUDE.md", F, F, F, F, F, F, F],
    // Prose wins over the web host's arm too: it sits above it, and `*` crosses `/`.
    ["crates/grimoire-web/CLAUDE.md", F, F, F, F, F, F, F],
    [".vscode/settings.json", F, F, F, F, F, F, F],
    [".gitignore", F, F, F, F, F, F, F],
    [".release-please-manifest.json", F, F, F, F, F, F, F],
    // Read by a Rust test since the engine's manifest began carrying the app's version.
    ["release-please-config.json", T, T, F, F, F, F, F],
    ["scripts/x.ps1", F, F, F, T, F, F, F],
    [".claude/skills/running-the-app/lock.ps1", F, F, F, T, F, F, F],
    ["src-tauri/x.psm1", F, F, F, T, F, F, F],
    ["tools/x.psd1", F, F, F, T, F, F, F],
    // A module the core extraction split: the desktop keeps its command wrappers at the old
    // module path, and the engine's half — a `core` row — is below.
    ["src-tauri/src/deck/mod.rs", T, T, F, F, F, F, F],
    ["src-tauri/src/desktop.rs", T, T, F, F, F, F, F],
    ["src-tauri/src/schema/mod.rs", T, T, F, F, F, F, F],
    ["src-tauri/Cargo.toml", T, T, F, F, F, F, F],
    ["src-tauri/src/share/__golden__/snapshot.json", T, T, F, F, F, F, F],
    ["src/features/transfer/__golden__/deck.arena.all.txt", T, T, F, F, T, F, T],
    ["src/features/transfer/__golden__/corpus.json", T, T, F, F, T, F, T],
    ["src/lib/userTables.json", T, T, F, F, T, F, T],
    ["src/lib/syncedTables.json", T, T, F, F, T, F, T],
    ["src/features/decks/DeckEditor.tsx", T, F, F, F, T, F, T],
    ["public/favicon.svg", T, F, F, F, T, F, T],
    // The desktop's document. The web build's is `mobile/index.html`, a `mobile/*` row below.
    ["index.html", T, F, F, F, T, F, F],
    [".storybook/fake/db.ts", T, F, F, F, T, F, F],
    // The one file there the light config imports, in every mode.
    [".storybook/fake/aliases.ts", T, F, F, F, T, F, T],
    [".storybook/DesignSystem.mdx", T, F, F, F, T, F, F],
    ["package.json", T, F, F, F, T, F, T],
    ["package-lock.json", T, F, F, F, T, F, T],
    ["components.json", T, F, F, F, T, F, F],
    ["vite.config.ts", T, F, F, F, T, F, T],
    ["vite.watch.ts", T, F, F, F, T, F, T],
    ["tsconfig.json", T, F, F, F, T, F, T],
    ["tsconfig.node.json", T, F, F, F, T, F, T],
    // The web Worker's own `tsc` program, by the glob — so by any name it lands under.
    ["tsconfig.web-worker.json", T, F, F, F, T, F, T],
    // Out of the fail-safe with it: no Rust job reads a `tsc` program.
    ["tsconfig.relay.json", T, F, F, F, T, F, T],
    ["tsconfig.share-worker.json", T, F, F, F, T, F, T],
    // Anchored: a `tsconfig.json` further down is some other arm's, or nobody's.
    [".design-sync/tsconfig.json", T, T, T, F, T, F, T],
    // The light app's Vite config: linted, built into the APK's bundle, built into `dist-web/`.
    // `rust` rides with `android`.
    ["vite.mobile.config.ts", T, T, F, F, F, T, T],
    ["eslint.config.js", T, F, F, F, T, F, F],
    ["scripts/golden.mjs", T, F, F, F, F, F, F],
    // The web build's two scripts, which `scripts/*` would lint and never run.
    ["scripts/build-wasm.mjs", T, F, F, F, F, F, T],
    ["scripts/web-smoke.mjs", T, F, F, F, F, F, T],
    ["scripts/web-smoke/default-cards.jsonl", T, F, F, F, F, F, T],
    // The web host: a workspace member `rust` tests, and the crate `web` compiles for a browser.
    // Not `core` — the engine does not depend on a host.
    ["crates/grimoire-web/src/lib.rs", T, T, F, F, F, F, T],
    ["crates/grimoire-web/Cargo.toml", T, T, F, F, F, F, T],
    ["crates/grimoire-core/src/lib.rs", T, T, T, F, F, F, T],
    // The schema since 2026-10-02. `src-tauri/src/schema/mod.rs` above is what the desktop host
    // kept of it — the conversion from a single file — so both rows are true, and this is the
    // one a new rung changes. The deck's row is the same pair, one step later.
    ["crates/grimoire-core/src/deck.rs", T, T, T, F, F, F, T],
    ["crates/grimoire-core/src/schema.rs", T, T, T, F, F, F, T],
    ["crates/grimoire-core/Cargo.toml", T, T, T, F, F, F, T],
    // `core` since the extraction's seventh step, when the engine took the crate for the
    // scanner's session glue — and `web` with it, which links the same dependency.
    ["crates/card-scanner/src/session.rs", T, T, T, F, F, F, T],
    ["crates/card-scanner/Cargo.lock", T, T, T, F, F, F, T],
    ["crates/card-scanner/.cargo/config.toml", T, T, T, F, F, F, T],
    ["share-worker/wrangler.jsonc", T, T, T, F, T, F, T],
    ["relay/src/index.ts", T, T, T, F, T, F, T],
    // The web app's hosting: checked and tested by `frontend`, copied into `dist-web/` by `web`.
    // Out of the fail-safe the other two Workers still fall to — no Rust source reads it.
    ["app-worker/wrangler.jsonc", T, F, F, F, F, F, T],
    ["app-worker/_headers", T, F, F, F, F, F, T],
    ["app-worker/src/headers.ts", T, F, F, F, F, F, T],
    ["app-worker/src/index.ts", T, F, F, F, F, F, T],
    // Its runbook is prose, by the arm above every tree's; its `tsc` program is the glob's.
    ["app-worker/README.md", F, F, F, F, F, F, F],
    ["tsconfig.app-worker.json", T, F, F, F, T, F, T],
    ["some/new/thing.txt", T, T, T, F, T, F, T],
    // The light app: its host, built into an APK, and its pages, which no Rust job reads — and
    // which are the web build's own page, where the phone's host is nothing to a browser.
    ["mobile/src-tauri/src/lib.rs", T, T, F, F, F, T, F],
    ["mobile/src-tauri/Cargo.toml", T, T, F, F, F, T, F],
    ["mobile/src-tauri/gen/android/app/src/main/AndroidManifest.xml", T, T, F, F, F, T, F],
    ["mobile/index.html", T, F, F, F, T, F, T],
    ["mobile/phone/CardSheet.tsx", T, F, F, F, T, F, T],
    ["mobile/host.test.ts", T, F, F, F, T, F, T],
  ])("%s", (path, frontend, rust, core, powershell, storybook, android, web) => {
    expect(route([path])).toEqual({ frontend, rust, core, powershell, storybook, android, web });
  });

  it("routes an empty diff nowhere, skipping blank lines as the `case` loop did", () => {
    expect(route([])).toEqual(Object.fromEntries(JOBS.map((j) => [j, false])));
    expect(route(["", ""])).toEqual(Object.fromEntries(JOBS.map((j) => [j, false])));
  });

  it("ORs a set of paths together", () => {
    expect(route(["README.md", "scripts/x.ps1", "src/lib/userTables.json"])).toEqual({
      frontend: true,
      rust: true,
      core: false,
      powershell: true,
      storybook: true,
      android: false,
      web: true,
    });
  });

  // `web` is a build job the fail-safe sets and `android` is one it does not, and the difference
  // is whether a path nobody placed can be an input: it cannot be one to the APK, and it can be
  // one to a build of the page and the engine both.
  it("ends on the fail-safe, which sets every build job and not `powershell` or `android`", () => {
    const last = ARMS.at(-1);
    expect(last.match).toEqual(["*"]);
    expect(armFor("anything/at/all")).toBe(armFor("zzz"));
    expect([...last.jobs].sort()).toEqual(["core", "frontend", "rust", "storybook", "web"]);
  });

  // `core`'s wasm leg proves the engine compiles for a browser; `web` links that compile into
  // the module a browser loads, and opens it. An arm that set `core` alone would be a change to
  // what the module is made of that no job had loaded.
  it("never routes to `core` without `web`", () => {
    const coreArms = ARMS.filter((arm) => arm.jobs.includes("core"));
    expect(coreArms.length).toBeGreaterThan(0);
    expect(coreArms.filter((arm) => !arm.jobs.includes("web"))).toEqual([]);
  });

  // The web host is a host: the engine does not depend on it, so `core` has nothing to prove
  // about a change there — and both arms below it would run `core` for one.
  it("puts the web host's arm above the engine's and `crates/*`", () => {
    const at = (pattern) => ARMS.findIndex((arm) => arm.match.includes(pattern));
    expect(at("crates/grimoire-web/*")).toBeGreaterThan(-1);
    expect(at("crates/grimoire-web/*")).toBeLessThan(at("crates/grimoire-core/*"));
    expect(at("crates/grimoire-web/*")).toBeLessThan(at("crates/*"));
    expect(ARMS[at("crates/grimoire-web/*")].jobs).not.toContain("core");
  });

  // Each of these is one file inside a tree a wider arm takes, and that arm does not set `web`:
  // below it, the file would be linted or type-checked and the build it feeds never run.
  it.each([
    ["scripts/build-wasm.mjs", "scripts/*"],
    ["scripts/web-smoke.mjs", "scripts/*"],
    ["scripts/web-smoke/*", "scripts/*"],
    [".storybook/fake/aliases.ts", ".storybook/*"],
  ])("puts `%s` above `%s`", (file, tree) => {
    const at = (pattern) => ARMS.findIndex((arm) => arm.match.includes(pattern));
    expect(at(file)).toBeGreaterThan(-1);
    expect(at(file)).toBeLessThan(at(tree));
    expect(ARMS[at(tree)].jobs).not.toContain("web");
  });

  // `core` compiles the engine for two foreign targets and runs nothing. Its native compile and
  // its tests are `rust`'s, so an arm that set `core` alone would cross-compile a change no job
  // had tested.
  // The APK build compiles the light host and runs nothing; the host's tests are `rust`'s.
  it("never routes to `android` without `rust`", () => {
    const arms = ARMS.filter((arm) => arm.jobs.includes("android"));
    expect(arms.length).toBeGreaterThan(0);
    expect(arms.filter((arm) => !arm.jobs.includes("rust"))).toEqual([]);
  });

  it("puts the light host's arm above the light app's", () => {
    const at = (pattern) => ARMS.findIndex((arm) => arm.match.includes(pattern));
    expect(at("mobile/src-tauri/*")).toBeGreaterThan(-1);
    expect(at("mobile/src-tauri/*")).toBeLessThan(at("mobile/*"));
  });

  it("never routes to `core` without `rust`", () => {
    const coreArms = ARMS.filter((arm) => arm.jobs.includes("core"));
    expect(coreArms.length).toBeGreaterThan(0);
    expect(coreArms.filter((arm) => !arm.jobs.includes("rust"))).toEqual([]);
  });

  // First match wins, and `crates/*` would take the engine's tree and skip the one job that
  // exists for it.
  it("puts the engine's arm above `crates/*`", () => {
    const at = (pattern) => ARMS.findIndex((arm) => arm.match.includes(pattern));
    expect(at("crates/grimoire-core/*")).toBeGreaterThan(-1);
    expect(at("crates/grimoire-core/*")).toBeLessThan(at("crates/*"));
  });
});

// The workflow half of the contract. The script prints names the workflow reads; a name the
// workflow reads and the script never prints is `''`, which skips its job, which `ci-ok` counts
// as a pass.
describe("ci.yml", () => {
  it.each(JOBS)("exposes and gates on `%s`", (job) => {
    expect(ciYml).toContain(`${job}: \${{ steps.classify.outputs.${job} }}`);
    expect(ciYml).toContain(`if: needs.changes.outputs.${job} == 'true'`);
  });

  it("keeps the three decisions the router depends on", () => {
    // Both ends of a move, not the destination alone.
    expect(ciYml).toContain("git diff --name-only --no-renames");
    expect(ciYml).toContain("node scripts/ci-route.mjs");
    // A skipped `changes` is never a pass.
    expect(ciYml).toContain('[ "$CHANGES" = "success" ] || exit 1');
  });

  // A job gated on a `changes` output belongs in every list of jobs. In `needs` alone its failure
  // is a result the gate never reads; in neither, it is a job the gate does not wait for.
  it.each(JOBS)("checks, and gates `ci-ok` on, `%s`", (job) => {
    const needs = /^ {4}needs: \[([^\]]*)\]$/m.exec(ciYml.slice(ciYml.indexOf("\n  ci-ok:")))?.[1];
    expect(needs?.split(",").map((s) => s.trim())).toContain(job);
    const env = job.toUpperCase();
    expect(ciYml).toContain(`${env}: \${{ needs.${job}.result }}`);
    expect(ciYml).toMatch(new RegExp(`for result in [^;]*"\\$${env}"`));
    expect(ciYml).toMatch(new RegExp(`for job in [a-z ]*\\b${job}\\b[a-z ]*; do`));
  });
});
