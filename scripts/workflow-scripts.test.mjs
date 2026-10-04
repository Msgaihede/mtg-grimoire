// Every `npm run <name>` a workflow, a composite action or another npm script asks for is a script
// `package.json` has.
//
// On 2026-10-04 an edit that added `lint:claude` took `web:smoke`'s line instead of the one below
// it. Nothing local runs `web:smoke` — `npm run verify` does not — so the first thing to notice was
// CI's `web` job, on `main` and on the release PR that merged it: `npm error Missing script`. A
// name is checkable from the files' text, so it is checked here, where `verify` reads it.
//
// The files are globbed, so a new workflow is held to the same rule the day it lands.
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
