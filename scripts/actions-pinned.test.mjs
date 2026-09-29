// The supply chain of the three workflows and the composite action, held to four rules — each one
// a hole issue #545 found open on 2026-09-28, and each checkable from the files' text:
//
//   1. every `uses:` is local or a full commit SHA, the tag it was on in a trailing comment;
//   2. every `actions/checkout` says `persist-credentials: false`;
//   3. no workflow grants a write permission at the top level — a job names its own;
//   4. Dependabot watches both places a pin can live.
//
// A fifth held the release's signing secret to one step of a `sign` job; that job was removed on
// 2026-09-29 with update signing itself.
//
// A tag is whatever its owner last pushed, so `@v1` in `release.yml` ran code nobody here had read
// beside a write token and a release in progress. The files are globbed, so a new workflow or a new
// composite action is held to the same rules the day it lands.
import { describe, expect, it } from "vitest";
import dependabot from "../.github/dependabot.yml?raw";
import releaseYml from "../.github/workflows/release.yml?raw";

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
const FILES = Object.entries({ ...WORKFLOWS, ...ACTIONS });

/** A local action, or `owner/repo[/path]@<40 hex> # v…` — Dependabot's pinned-with-comment form. */
const PINNED = /^(?:\.\/\S+|[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40} # v\S+)$/;

/** Every `uses:` value in a file, trailing comment included. Comment lines never match. */
const usesOf = (src) =>
  [...src.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]*(.+?)[ \t]*$/gm)].map((m) => m[1]);

/** The text of each `actions/checkout` step: from its `- ` to the next line at that indent or less. */
function checkoutSteps(src) {
  const lines = src.split("\n");
  const indent = (line) => line.length - line.trimStart().length;
  const steps = [];
  lines.forEach((line, i) => {
    if (!/^\s*(?:-\s+)?uses:\s*actions\/checkout@/.test(line)) return;
    let start = i;
    while (start > 0 && !/^\s*-\s/.test(lines[start])) start -= 1;
    const dash = indent(lines[start]);
    let end = i + 1;
    while (end < lines.length && (lines[end].trim() === "" || indent(lines[end]) > dash)) end += 1;
    steps.push(lines.slice(start, end).join("\n"));
  });
  return steps;
}

/**
 * A file with its comment lines removed. These files explain themselves at length, and a comment
 * naming a secret or a permission is prose, not a grant.
 */
const code = (src) =>
  src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** A workflow's text above `jobs:` — where a workflow-wide grant would sit. */
const header = (src) => code(src.slice(0, src.search(/^jobs:/m)));

describe("every workflow and composite action", () => {
  it("is found", () => {
    expect(FILES.map(([path]) => path)).toEqual(
      expect.arrayContaining([
        "/.github/workflows/ci.yml",
        "/.github/workflows/release.yml",
        "/.github/workflows/scanner-bundle.yml",
        "/.github/actions/rust-toolchain/action.yml",
      ]),
    );
  });

  it.each(FILES)("%s pins every action by commit SHA", (_path, src) => {
    const all = usesOf(src);
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((u) => !PINNED.test(u))).toEqual([]);
  });

  it.each(FILES)("%s checks out without leaving the token behind", (_path, src) => {
    for (const step of checkoutSteps(src)) {
      expect(step).toMatch(/^\s*persist-credentials:\s*false\s*$/m);
    }
  });

  it.each(Object.entries(WORKFLOWS))(
    "%s grants no write permission workflow-wide",
    (_path, src) => {
      const top = header(src);
      expect(top).toMatch(/^permissions:/m);
      expect(top).not.toMatch(/:\s*write\b/);
    },
  );
});

describe("the rules' own guards", () => {
  // A census that matched nothing would pass every assertion above.
  it("sees the checkouts and the pins it is about", () => {
    expect(checkoutSteps(releaseYml).length).toBeGreaterThanOrEqual(2);
    expect(usesOf(releaseYml)).toContain(
      "tauri-apps/tauri-action@1deb371b0cd8bd54025b384f1cd735e725c4060f # v1.0.0",
    );
    expect(PINNED.test("tauri-apps/tauri-action@v1")).toBe(false);
    expect(
      PINNED.test("actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0"),
    ).toBe(true);
    expect(PINNED.test("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1")).toBe(false);
    expect(
      checkoutSteps(
        "steps:\n  - uses: actions/checkout@x\n  - run: echo\n        persist-credentials: false\n",
      ),
    ).toEqual(["  - uses: actions/checkout@x"]);
  });
});

describe("dependabot.yml", () => {
  it("watches the workflows and every composite action", () => {
    expect(dependabot).toMatch(/package-ecosystem:\s*github-actions/);
    expect(dependabot).toMatch(/^\s*-\s*"\/"\s*$/m);
    expect(dependabot).toMatch(/^\s*-\s*"\/\.github\/actions\/\*"\s*$/m);
  });
});
