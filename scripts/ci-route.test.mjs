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
    "/share/**/*.test.{ts,tsx}",
    "/scripts/**/*.test.mjs",
  ],
  { query: "?raw", import: "default", eager: true },
);

// Both cargo packages `rust` tests. `target/` is never globbed.
const RUST = import.meta.glob(
  ["/src-tauri/src/**/*.rs", "/src-tauri/build.rs", "/crates/*/src/**/*.rs", "/crates/*/build.rs"],
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

const RUST_OWNED = /^(src-tauri|crates)\//;

describe("the census", () => {
  const ts = tsReads();
  const rust = rustReads();

  // Guards the regexes above: a census that matched nothing would pass every assertion below.
  it("finds the crossings that motivated it", () => {
    const tsPaths = ts.map((r) => r.path);
    const rustPaths = rust.map((r) => r.path);
    expect(tsPaths).toContain("src-tauri/src/deck.rs");
    expect(tsPaths).toContain("src-tauri/src/share/__golden__/snapshot.json");
    expect(tsPaths).toContain("src-tauri/tauri.conf.json");
    expect(tsPaths).toContain("crates/card-scanner/src/session.rs");
    expect(rustPaths).toContain("src/lib/userTables.json");
    expect(rustPaths).toContain("src/features/transfer/__golden__");
    expect(rustPaths).toContain("src/features/transfer/__golden__/corpus.json");
    expect(rustPaths).toContain("share-worker/wrangler.jsonc");
    expect(rustPaths).toContain("src-tauri/gen/android/app/build.gradle.kts");
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
  // [path, frontend, rust, powershell, wasm, android]
  it.each([
    [".github/workflows/ci.yml", T, T, T, T, T],
    ["scripts/ci-route.mjs", T, T, T, T, T],
    ["scripts/build-wasm.mjs", T, F, F, T, F],
    ["vite.web.config.ts", T, F, F, T, F],
    ["src/workers/search.worker.ts", T, F, F, T, F],
    ["src/web/boot.ts", T, F, F, T, F],
    ["src/lib/core/index.ts", T, F, F, T, F],
    ["docs/reference/ci-and-releases.md", F, F, F, F, F],
    ["README.md", F, F, F, F, F],
    ["src/features/decks/CLAUDE.md", F, F, F, F, F],
    [".vscode/settings.json", F, F, F, F, F],
    [".gitignore", F, F, F, F, F],
    [".release-please-manifest.json", F, F, F, F, F],
    [".github/workflows/release.yml", F, F, F, F, F],
    ["scripts/android-devtools.ps1", F, F, T, F, F],
    [".claude/skills/running-the-app/lock.ps1", F, F, T, F, F],
    ["src-tauri/x.psm1", F, F, T, F, F],
    ["tools/x.psd1", F, F, T, F, F],
    ["src-tauri/gen/android/app/build.gradle.kts", F, T, F, F, F],
    ["src-tauri/gen/android/app/src/main/AndroidManifest.xml", F, T, F, F, F],
    ["src-tauri/gen/android/app/src/main/res/values/colors.xml", F, F, F, F, F],
    ["src-tauri/src/deck.rs", T, T, F, T, T],
    ["src-tauri/src/schema.rs", T, T, F, T, T],
    ["src-tauri/Cargo.lock", T, T, F, T, T],
    ["src-tauri/src/share/__golden__/snapshot.json", T, T, F, T, T],
    ["src/features/transfer/__golden__/deck.arena.all.txt", T, T, F, F, F],
    ["src/features/transfer/__golden__/corpus.json", T, T, F, F, F],
    ["src/lib/userTables.json", T, T, F, F, F],
    ["src/features/decks/DeckEditor.tsx", T, F, F, F, F],
    ["public/favicon.svg", T, F, F, F, F],
    ["index.html", T, F, F, F, F],
    ["package.json", T, F, F, T, F],
    ["package-lock.json", T, F, F, T, F],
    ["vite.config.ts", T, F, F, T, F],
    ["eslint.config.js", T, F, F, T, F],
    ["scripts/golden.mjs", T, F, F, F, F],
    ["crates/card-scanner/src/session.rs", T, T, F, T, T],
    ["share-worker/wrangler.jsonc", T, T, F, T, T],
    ["relay/src/index.ts", T, T, F, T, T],
    ["some/new/thing.txt", T, T, F, T, T],
  ])("%s", (path, frontend, rust, powershell, wasm, android) => {
    expect(route([path])).toEqual({ frontend, rust, powershell, wasm, android });
  });

  it("routes an empty diff nowhere, skipping blank lines as the `case` loop did", () => {
    expect(route([])).toEqual(Object.fromEntries(JOBS.map((j) => [j, false])));
    expect(route(["", ""])).toEqual(Object.fromEntries(JOBS.map((j) => [j, false])));
  });

  it("ORs a set of paths together", () => {
    expect(route(["README.md", "scripts/x.ps1", "src/lib/userTables.json"])).toEqual({
      frontend: true,
      rust: true,
      powershell: true,
      wasm: false,
      android: false,
    });
  });

  it("ends on the fail-safe, which sets every build job and not `powershell`", () => {
    const last = ARMS.at(-1);
    expect(last.match).toEqual(["*"]);
    expect(armFor("anything/at/all")).toBe(armFor("zzz"));
    expect([...last.jobs].sort()).toEqual(["android", "frontend", "rust", "wasm"]);
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
});
