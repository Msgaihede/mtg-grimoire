// The supply chain of the workflows and the composite action, held to five rules — the first four
// each a hole issue #545 found open on 2026-09-28, and all checkable from the files' text:
//
//   1. every `uses:` is local or a full commit SHA, the tag it was on in a trailing comment;
//   2. every `actions/checkout` says `persist-credentials: false`;
//   3. no workflow grants a write permission at the top level — a job names its own;
//   4. Dependabot watches both places a pin can live;
//   5. a job granted any write builds nothing (2026-10-21): no toolchain, no cache, no install,
//      no cargo and no Tauri build, so no build script or bundler plugin runs beside a token
//      that can write. What a build made reaches such a job as an artifact.
//
// Which job holds which secret, and every line those jobs run, is `release-rule.test.ts`'s.
//
// A tag is whatever its owner last pushed, so `@v1` in `release.yml` ran code nobody here had read
// beside a write token and a release in progress. The files are globbed, so a new workflow or a new
// composite action is held to the same rules the day it lands.
import { describe, expect, it } from "vitest";
import dependabot from "../.github/dependabot.yml?raw";
import releaseYml from "../.github/workflows/release.yml?raw";

const WORKFLOWS = import.meta.glob<string>("/.github/workflows/*.yml", {
  query: "?raw",
  import: "default",
  eager: true,
});
const ACTIONS = import.meta.glob<string>("/.github/actions/*/action.yml", {
  query: "?raw",
  import: "default",
  eager: true,
});
const FILES = Object.entries({ ...WORKFLOWS, ...ACTIONS });

/** A local action, or `owner/repo[/path]@<40 hex> # v…` — Dependabot's pinned-with-comment form. */
const PINNED = /^(?:\.\/\S+|[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40} # v\S+)$/;

/** Every `uses:` value in a file, trailing comment included. Comment lines never match. */
const usesOf = (src: string) =>
  [...src.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]*(.+?)[ \t]*$/gm)].map((m) => m[1]);

/** The text of each `actions/checkout` step: from its `- ` to the next line at that indent or less. */
function checkoutSteps(src: string) {
  const lines = src.split("\n");
  const indent = (line: string) => line.length - line.trimStart().length;
  const steps: string[] = [];
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
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** A workflow's text above `jobs:` — where a workflow-wide grant would sit. */
const header = (src: string) => code(src.slice(0, src.search(/^jobs:/m)));

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

/** A workflow's jobs, comment lines dropped, each from its key to the next job's. */
function jobsOf(src: string) {
  const body = code(src.slice(src.search(/^jobs:/m)));
  const starts = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):[ \t]*$/gm)];
  return starts.map((m, i) => ({
    name: m[1],
    text: body.slice(m.index, starts[i + 1]?.index ?? body.length),
  }));
}

/** A job's own `permissions:` block, as text. */
const permissionsOf = (job: string) => /^ {4}permissions:\n((?: {6}.*\n)*)/m.exec(job)?.[1] ?? "";

/** What builds, installs or restores a cache: any of these in a job beside a write is refused. */
const BUILDS =
  /rust-toolchain|rust-cache|tauri-action|actions\/cache|setup-java|gradle|\bcargo\b|\bpnpm\b|\bnpm (?:ci|install|i)\b|\bnpx\b|^ {10}cache:/m;

describe("every job granted a write", () => {
  const writers = Object.entries(WORKFLOWS).flatMap(([path, src]) =>
    jobsOf(src)
      .filter((job) => /:\s*write\b/.test(permissionsOf(job.text)))
      .map((job) => [`${path} ${job.name}`, job.text] as const),
  );

  it("is found", () => {
    expect(writers.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "/.github/workflows/release.yml release-please",
        "/.github/workflows/release.yml attach",
        "/.github/workflows/release.yml publish",
        "/.github/workflows/scanner-bundle.yml publish",
      ]),
    );
  });

  it.each(writers)("%s builds nothing", (_name, job) => {
    expect(job).not.toMatch(BUILDS);
  });

  // The two jobs that build the release's own files, and that were granted the write until
  // 2026-10-21, are not among them.
  it("leaves out the jobs that build what is published", () => {
    const names = writers.map(([name]) => name);
    expect(names).not.toContain("/.github/workflows/release.yml build");
    expect(names).not.toContain("/.github/workflows/scanner-bundle.yml build");
  });
});

describe("the rules' own guards", () => {
  // A census that matched nothing would pass every assertion above.
  it("sees the checkouts and the pins it is about", () => {
    expect(checkoutSteps(releaseYml).length).toBeGreaterThanOrEqual(1);
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
    // The write census reads a job's own block, and the build census sees a build.
    expect(permissionsOf("  a:\n    permissions:\n      contents: write\n    steps:\n")).toBe(
      "      contents: write\n",
    );
    expect(BUILDS.test("      - run: pnpm install --frozen-lockfile")).toBe(true);
    expect(BUILDS.test("      - uses: ./.github/actions/rust-toolchain")).toBe(true);
    expect(BUILDS.test("          node scripts/update-signing.ts sign x")).toBe(false);
  });
});

describe("dependabot.yml", () => {
  it("watches the workflows and every composite action", () => {
    expect(dependabot).toMatch(/package-ecosystem:\s*github-actions/);
    expect(dependabot).toMatch(/^\s*-\s*"\/"\s*$/m);
    expect(dependabot).toMatch(/^\s*-\s*"\/\.github\/actions\/\*"\s*$/m);
  });
});
