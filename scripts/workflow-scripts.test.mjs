// Every `npm run <name>` a workflow, a composite action or another npm script asks for is a script
// `package.json` has.
//
// On 2026-10-04 an edit that added `lint:claude` took `web:smoke`'s line instead of the one below
// it. Nothing local runs `web:smoke` — `npm run verify` does not — so the first thing to notice was
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

/** Every script name a text runs, once each. */
const runsOf = (src) => [
  ...new Set([...src.matchAll(/\bnpm run ([\w][\w:.-]*)/g)].map((m) => m[1])),
];

const CALLERS = [
  ...Object.entries({ ...WORKFLOWS, ...ACTIONS }).map(([path, src]) => [path, code(src)]),
  ["/package.json", Object.values(pkg.scripts).join("\n")],
];

describe("every npm script that is run", () => {
  it.each(CALLERS)("%s names only scripts package.json has", (_path, src) => {
    expect(runsOf(src).filter((name) => !(name in pkg.scripts))).toEqual([]);
  });
});

describe("the rule's own guards", () => {
  // A census that matched nothing would pass the assertion above.
  it("sees the calls it is about", () => {
    const ci = code(WORKFLOWS["/.github/workflows/ci.yml"]);
    expect(runsOf(ci)).toEqual(expect.arrayContaining(["build", "lint", "web:smoke"]));
    expect(runsOf(pkg.scripts.verify).length).toBeGreaterThan(0);
    expect(runsOf("run: npm run web:smoke\n# npm run gone")).toEqual(["web:smoke", "gone"]);
    expect(runsOf(code("  # npm run gone\n  run: npm run build"))).toEqual(["build"]);
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
