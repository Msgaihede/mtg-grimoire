import { describe, expect, it } from "vitest";
import {
  nextPlan,
  parseArgs,
  previousTag,
  pushOne,
  pushVerdict,
  rangeOf,
  releaseTags,
  versionArg,
  versionOf,
} from "./cli.mjs";

/**
 * `pushOne`'s four doors, each recording what it was asked: GitHub's answer for a tag, whether a
 * body was already kept, the keeping, and the edit.
 */
function github({ releases = {}, alreadyKept = [], failing = [] } = {}) {
  const kept = [];
  const edits = [];
  return {
    kept,
    edits,
    doors: {
      view: (tag) => releases[tag] ?? null,
      wasKept: (tag) => alreadyKept.includes(tag),
      keep: (tag, body) => kept.push({ tag, body }),
      edit: (tag, isLatest) => {
        if (failing.includes(tag)) throw new Error("HTTP 502: Bad Gateway\nmore lines");
        edits.push({ tag, isLatest });
      },
    },
  };
}
const published = (body = "release-please's notes") => ({ isDraft: false, body });

describe("versionOf", () => {
  it("reads the root package's version from release-please's manifest", () => {
    expect(versionOf('{\n  ".": "0.43.0"\n}\n')).toBe("0.43.0");
  });

  // A version becomes a file name and a tag. Anything that is not three numbers is no version.
  it("answers null for anything that is not a plain version", () => {
    expect(versionOf('{ ".": "0.43" }')).toBeNull();
    expect(versionOf('{ ".": "../../etc/passwd" }')).toBeNull();
    expect(versionOf('{ ".": "1.0.0-beta.1" }')).toBeNull();
    expect(versionOf('{ "packages/ui": "0.43.0" }')).toBeNull();
    expect(versionOf("not json")).toBeNull();
  });
});

describe("versionArg", () => {
  it("takes a version with or without its v", () => {
    expect(versionArg("v0.43.0")).toBe("0.43.0");
    expect(versionArg("0.43.0")).toBe("0.43.0");
    expect(versionArg("scanner-bundle-v3")).toBeNull();
    expect(versionArg("0.43")).toBeNull();
  });
});

describe("releaseTags", () => {
  it("keeps the version tags, oldest first by number and not by letter", () => {
    expect(releaseTags("v0.10.0\nv0.9.1\nscanner-bundle-v3\nv0.2.0\nv0.9.0\n")).toEqual([
      "v0.2.0",
      "v0.9.0",
      "v0.9.1",
      "v0.10.0",
    ]);
  });
});

describe("previousTag and rangeOf", () => {
  const tags = ["v0.2.0", "v0.3.0", "v0.4.0"];

  it("ranges a release from the one before it", () => {
    expect(rangeOf(previousTag(tags, "v0.4.0"), "v0.4.0")).toBe("v0.3.0..v0.4.0");
  });

  it("ranges the first release from the beginning", () => {
    expect(previousTag(tags, "v0.2.0")).toBeNull();
    expect(rangeOf(null, "v0.2.0")).toBe("v0.2.0");
  });
});

describe("nextPlan", () => {
  it("writes when the release branch is a version ahead", () => {
    expect(nextPlan({ released: "0.43.0", coming: "0.44.0" })).toEqual({
      write: true,
      failed: false,
      why: "Writing the notes for 0.44.0, from v0.43.0 to this commit.",
    });
  });

  it("does nothing, and is not a failure, with no release branch or the same version on it", () => {
    expect(nextPlan({ released: "0.43.0", coming: null })).toMatchObject({ write: false, failed: false });
    expect(nextPlan({ released: "0.43.0", coming: "0.43.0" })).toMatchObject({ write: false, failed: false });
  });

  it("fails when this tree names no released version", () => {
    expect(nextPlan({ released: null, coming: "0.44.0" })).toMatchObject({ write: false, failed: true });
  });
});

// `push` is the one command that changes anything on GitHub — the bodies of public releases.
describe("pushOne", () => {
  it("keeps the body it replaces, then sets the new one", () => {
    const gh = github({ releases: { "v0.41.0": published("the old body") } });
    expect(pushOne({ version: "0.41.0", hasNotes: true, latestTag: "v0.43.0", ...gh.doors })).toEqual({
      tag: "v0.41.0",
      outcome: "pushed",
      why: "the release body is changelog/0.41.0.md",
    });
    expect(gh.kept).toEqual([{ tag: "v0.41.0", body: "the old body" }]);
    expect(gh.edits).toEqual([{ tag: "v0.41.0", isLatest: false }]);
  });

  // An edit must not move the "Latest" mark: `release.yml`'s deploy refusal reads it.
  it("says which release is the latest one, on every edit", () => {
    const gh = github({ releases: { "v0.43.0": published() } });
    pushOne({ version: "0.43.0", hasNotes: true, latestTag: "v0.43.0", ...gh.doors });
    expect(gh.edits).toEqual([{ tag: "v0.43.0", isLatest: true }]);
  });

  // A second run must not replace the original it kept with the notes the first run wrote.
  it("keeps a body once", () => {
    const gh = github({ releases: { "v0.41.0": published("generated notes") }, alreadyKept: ["v0.41.0"] });
    expect(pushOne({ version: "0.41.0", hasNotes: true, latestTag: "v0.43.0", ...gh.doors }).outcome).toBe("pushed");
    expect(gh.kept).toEqual([]);
    expect(gh.edits).toHaveLength(1);
  });

  it("leaves a draft alone: nothing kept, nothing edited", () => {
    const gh = github({ releases: { "v0.34.0": { isDraft: true, body: "never to be published" } } });
    expect(pushOne({ version: "0.34.0", hasNotes: true, latestTag: "v0.43.0", ...gh.doors })).toEqual({
      tag: "v0.34.0",
      outcome: "draft",
      why: "a draft, left alone",
    });
    expect(gh.kept).toEqual([]);
    expect(gh.edits).toEqual([]);
  });

  it("refuses a version with no file, or no release, without asking for an edit", () => {
    const gh = github({ releases: { "v0.41.0": published() } });
    expect(pushOne({ version: "0.41.0", hasNotes: false, latestTag: "v0.43.0", ...gh.doors })).toMatchObject({
      outcome: "refused",
      why: "changelog/0.41.0.md does not exist",
    });
    expect(pushOne({ version: "9.9.9", hasNotes: true, latestTag: "v0.43.0", ...gh.doors })).toMatchObject({
      outcome: "refused",
      why: "GitHub has no such release, or gh could not ask",
    });
    expect(gh.edits).toEqual([]);
  });

  it("reports an edit that failed, in one line, and does not throw", () => {
    const gh = github({ releases: { "v0.41.0": published() }, failing: ["v0.41.0"] });
    expect(pushOne({ version: "0.41.0", hasNotes: true, latestTag: "v0.43.0", ...gh.doors })).toEqual({
      tag: "v0.41.0",
      outcome: "refused",
      why: "the edit failed: HTTP 502: Bad Gateway",
    });
  });
});

describe("pushVerdict", () => {
  const result = (outcome) => ({ tag: "v0.0.0", outcome, why: "" });

  it("counts what happened", () => {
    expect(pushVerdict([result("pushed"), result("pushed"), result("draft")], { all: true })).toEqual({
      code: 0,
      tally: "2 pushed, 1 draft left alone, 0 refused",
    });
  });

  // With `--all` a draft among the files is expected. Anything else that was not pushed is a
  // failure: forty-five rewritten releases and one skipped must not read as forty-six.
  it("fails on any refusal, with or without --all", () => {
    expect(pushVerdict([result("pushed"), result("refused")], { all: true }).code).toBe(1);
    expect(pushVerdict([result("refused")], { all: false }).code).toBe(1);
  });

  it("fails on a draft that was asked for by name", () => {
    expect(pushVerdict([result("draft")], { all: false }).code).toBe(1);
    expect(pushVerdict([result("draft")], { all: true }).code).toBe(0);
  });
});

describe("parseArgs", () => {
  it("reads a command, its names and its flags", () => {
    expect(parseArgs(["tag", "v0.41.0", "0.42.0", "--force"])).toEqual({
      command: "tag",
      names: ["v0.41.0", "0.42.0"],
      force: true,
      all: false,
      backup: null,
    });
    expect(parseArgs(["push", "--all", "--backup", "D:/kept"])).toEqual({
      command: "push",
      names: [],
      force: false,
      all: true,
      backup: "D:/kept",
    });
    expect(parseArgs([])).toMatchObject({ command: "", names: [] });
  });
});
