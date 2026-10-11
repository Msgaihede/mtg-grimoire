// Every script a workflow, a composite action, a Tauri config or another script asks pnpm for is
// a script `package.json` has.
//
// On 2026-10-04 an edit that added `lint:claude` took `web:smoke`'s line instead of the one below
// it. Nothing local runs `web:smoke` — `pnpm verify` does not — so the first thing to notice was
// CI's `web` job, on `main` and on the release PR that merged it: `npm error Missing script`. A
// name is checkable from the files' text, so it is checked here, where `verify` reads it.
//
// The files are globbed, so a new workflow is held to the same rule the day it lands.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";

const WORKFLOWS = import.meta.glob("/.github/workflows/*.yml", {
  query: "?raw",
  import: "default",
  eager: true,
});
const ACTIONS = import.meta.glob("/.github/actions/*/action.yml", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * A file with its comment lines removed. These files explain themselves at length, and a comment
 * naming a script is prose, not a call.
 */
const code = (src) =>
  src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const TAURI_CONFIGS = import.meta.glob("/apps/*/src-tauri/tauri*.conf.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** pnpm's own commands that something here runs. Any other word after `pnpm` is a script's name. */
const PNPM_OWN = new Set(["install", "exec"]);

/**
 * Every script name a text runs, once each: `pnpm <name>` and `pnpm run <name>`, either after
 * `-w`. Not `pnpm/action-setup` and not `cache: pnpm`: a name follows `pnpm` and a space.
 */
const runsOf = (src) => [
  ...new Set(
    [...src.matchAll(/\bpnpm (?:(?:-w|--workspace-root) )?(?:run )?([\w][\w:.-]*)/g)]
      .map((m) => m[1])
      .filter((name) => !PNPM_OWN.has(name)),
  ),
];

/** The two commands the Tauri CLI runs for a config, from the app's folder. */
const hooksOf = (conf) =>
  [...conf.matchAll(/"before(?:Dev|Build)Command":\s*"([^"]+)"/g)].map((m) => m[1]);

const CALLERS = [
  ...Object.entries({ ...WORKFLOWS, ...ACTIONS }).map(([path, src]) => [path, code(src)]),
  ...Object.entries(TAURI_CONFIGS).map(([path, conf]) => [path, hooksOf(conf).join("\n")]),
  ["/package.json", Object.values(pkg.scripts).join("\n")],
];

describe("every script that is run", () => {
  it.each(CALLERS)("%s names only scripts package.json has", (_path, src) => {
    expect(runsOf(src).filter((name) => !(name in pkg.scripts))).toEqual([]);
  });

  // The census above reads a name only where it directly follows `pnpm`, `pnpm run`, or either
  // after `-w`. A call spelled any other way — `pnpm --filter x run y`, `pnpm -r run y`,
  // `pnpm -C dir y` — would name a script it never checked, so that spelling fails here.
  it.each(CALLERS)("%s calls pnpm only in a form this can read", (_path, src) => {
    expect(src).not.toMatch(/\bpnpm (?!(?:(?:-w|--workspace-root) )?(?:run )?\w)/);
  });

  // npm strips a `--` before a script's arguments; pnpm hands it to the script. Vitest then reads
  // `--shard=1/3` as a file to look for, and `scanner-assets.mjs` never sees `--web`.
  // Anywhere on the line: `pnpm test:run --coverage -- --shard=1/3` hands the `--` on just the same.
  it.each(CALLERS)("%s puts no `--` between a script and its arguments", (_path, src) => {
    expect(src).not.toMatch(/\bpnpm [^\n]* -- /);
  });

  // The one npm left is the deploy tool's install, which is npm's on purpose. The whole line, and
  // only in its two spellings: with the folder as `--prefix`, or with it as the step's
  // `working-directory`.
  it.each(CALLERS)("%s runs npm for the deploy tool's install and nothing else", (_path, src) => {
    const other = src.split("\n").filter((line) => /\b(?:npm|npx|pnpx|corepack)\b/.test(line));
    expect(
      other.filter(
        (line) => !/^\s*run: npm ci --ignore-scripts(?: --prefix infrastructure\/wrangler)?$/.test(line),
      ),
    ).toEqual([]);
  });

  // The Tauri CLI runs these in `apps/<name>`, where a plain `pnpm run` reads that app's manifest
  // and finds no script (measured 2026-10-08).
  it("reaches a root script from an app's folder through the workspace root", () => {
    const hooks = Object.values(TAURI_CONFIGS).flatMap(hooksOf);
    expect(hooks.length).toBe(5);
    for (const hook of hooks) expect(hook).toMatch(/^pnpm -w run [\w:.-]+$/);
  });
});

describe("the rule's own guards", () => {
  // A census that matched nothing would pass the assertions above.
  it("sees the calls it is about", () => {
    const ci = code(WORKFLOWS["/.github/workflows/ci.yml"]);
    expect(runsOf(ci)).toEqual(expect.arrayContaining(["build", "lint", "web:smoke", "test:run"]));
    expect(runsOf(pkg.scripts.verify).length).toBeGreaterThan(0);
    expect(runsOf("run: pnpm web:smoke\n# pnpm gone")).toEqual(["web:smoke", "gone"]);
    expect(runsOf(code("  # pnpm gone\n  run: pnpm -w run build"))).toEqual(["build"]);
    expect(runsOf("pnpm --workspace-root run tauri:light android")).toEqual(["tauri:light"]);
    expect(
      runsOf("run: pnpm install --frozen-lockfile\nrun: pnpm exec tauri android build\nuses: pnpm/action-setup@abc\ncache: pnpm"),
    ).toEqual([]);
    const unreadable = /\bpnpm (?!(?:(?:-w|--workspace-root) )?(?:run )?\w)/;
    for (const call of ["pnpm --filter @grimoire/ui run gone", "pnpm -r run gone", "pnpm -C apps/light gone"])
      expect(call, call).toMatch(unreadable);
    for (const call of ["pnpm build", "pnpm -w run dev", "pnpm --workspace-root run tauri:light android", "pnpm install --frozen-lockfile"])
      expect(call, call).not.toMatch(unreadable);
  });
});

// `release.yml` runs on a release and nowhere else, so a step that names a folder a move took
// away is found by the release. Every `working-directory:`, every `--prefix` and every `cd` to a
// plain relative folder, in a workflow or a composite action, is held to a folder that exists.
// (A stale folder left on a developer's disk passes here; CI's checkout is clean, and CI is where
// this is read.)
//
// What the text cannot say is not guessed at. A `working-directory:` written as an expression is
// a folder only the runner knows, so those are collected and listed below rather than skipped; a
// `cd` to a variable, to `..` or to `-` is not a plain relative folder and is not read. A `cd` is
// read from the root of the checkout, which is where a step starts unless it set a
// `working-directory:` of its own, and none that is checked here does both.

/** A `cd` at the start of a command, to a folder spelled as a plain relative path. */
const CD = /(?:^|&&|;|\|\||run:)[ \t]*cd[ \t]+["']?(\w[\w./-]*)/gm;

/** The folders a text steps into, and the `working-directory:` values that are expressions. */
const stepsInto = (src) => {
  const text = code(src);
  return {
    dirs: [
      ...[...text.matchAll(/(?:working-directory:|--prefix)\s+["']?([\w./-]+)/g)].map((m) => m[1]),
      ...[...text.matchAll(CD)].map((m) => m[1]),
    ],
    expressions: [...text.matchAll(/working-directory:\s+["']?(\$\{\{[^\n]*)/g)].map((m) => m[1]),
  };
};

describe("the folders a workflow steps into", () => {
  const repo = `${resolve(import.meta.dirname, "..")}/`;
  const files = Object.entries({ ...WORKFLOWS, ...ACTIONS });

  it("all exist", () => {
    const missing = [];
    for (const [file, text] of files)
      for (const dir of stepsInto(text).dirs)
        if (!existsSync(repo + dir)) missing.push(`${file}: ${dir}`);
    expect(files.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  // A new entry here is a folder this test cannot check: look at it by hand, then add it.
  it("has no working-directory it cannot read", () => {
    const expressions = files.flatMap(([file, text]) =>
      stepsInto(text).expressions.map((expression) => `${file}: ${expression}`),
    );
    expect(expressions).toEqual([]);
  });

  it("reads the forms it is about, and not a comment", () => {
    const sample = [
      "      - working-directory: apps/light",
      "        run: cd infrastructure/relay && npm ci; cd ../up",
      "        run: npm --prefix 'apps/share' ci",
      "      # working-directory: gone/one",
      "      #   cd gone/two",
      "        run: cd $HOME && cd - && cd ..",
      "        working-directory: ${{ inputs.dir }}",
    ].join("\n");
    expect(stepsInto(sample)).toEqual({
      dirs: ["apps/light", "apps/share", "infrastructure/relay"],
      expressions: ["${{ inputs.dir }}"],
    });
  });
});
