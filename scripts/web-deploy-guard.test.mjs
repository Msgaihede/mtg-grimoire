// The deploy guard's two pure halves: reading the constant, and the verdict. No git here — the
// script's `main` is the only part that asks it, and `npm run web:deploy-guard` is that part's
// own test, against the real tag.
import { describe, expect, it } from "vitest";
import {
  MANIFEST_PATH,
  SCHEMA_PATH,
  releaseTag,
  userSchemaVersion,
  verdict,
} from "./web-deploy-guard.mjs";
import schemaRs from "../crates/grimoire-core/src/schema.rs?raw";
import wireRs from "../crates/grimoire-core/src/sync_engine/wire.rs?raw";
import packageJson from "../package.json?raw";

describe("userSchemaVersion", () => {
  it("reads the engine's real declaration", () => {
    // The path the script reads, and the shape it expects: a rename of either is red here before
    // it is a guard that cannot tell.
    expect(SCHEMA_PATH).toBe("crates/grimoire-core/src/schema.rs");
    const version = userSchemaVersion(schemaRs);
    expect(version).not.toBeNull();
    expect(version).toBeGreaterThanOrEqual(59);
  });

  it("reads the number, with either line ending", () => {
    expect(userSchemaVersion("pub const USER_SCHEMA_VERSION: i64 = 60;\n")).toBe(60);
    expect(userSchemaVersion("x\r\npub const USER_SCHEMA_VERSION: i64 = 61;\r\ny\r\n")).toBe(61);
  });

  it("is not fooled by prose that names the constant", () => {
    const source = [
      "/// See [`USER_SCHEMA_VERSION`]: `pub const USER_SCHEMA_VERSION: i64 = 3;` was v3.",
      "    // pub const USER_SCHEMA_VERSION: i64 = 4;",
      "pub const USER_SCHEMA_VERSION: i64 = 59;",
      "pub const CORPUS_SCHEMA_VERSION: i64 = 6;",
    ].join("\n");
    expect(userSchemaVersion(source)).toBe(59);
  });

  it.each([
    ["no declaration", "pub const CORPUS_SCHEMA_VERSION: i64 = 6;\n"],
    ["an empty file", ""],
    [
      "two declarations",
      "pub const USER_SCHEMA_VERSION: i64 = 59;\npub const USER_SCHEMA_VERSION: i64 = 60;\n",
    ],
    ["another type", "pub const USER_SCHEMA_VERSION: u32 = 59;\n"],
    ["an expression", "pub const USER_SCHEMA_VERSION: i64 = 58 + 1;\n"],
    ["a private constant", "const USER_SCHEMA_VERSION: i64 = 59;\n"],
    ["zero", "pub const USER_SCHEMA_VERSION: i64 = 0;\n"],
  ])("answers null for %s, never a number", (_name, source) => {
    expect(userSchemaVersion(source)).toBeNull();
  });
});

describe("releaseTag", () => {
  it("is `v` and the manifest's root version", () => {
    expect(MANIFEST_PATH).toBe(".release-please-manifest.json");
    expect(releaseTag('{\n  ".": "0.40.0"\n}\n')).toBe("v0.40.0");
  });

  it.each([
    ["not JSON", "0.40.0"],
    ["no root package", '{"relay": "0.40.0"}'],
    ["a number", '{".": 40}'],
    ["a pre-release", '{".": "0.41.0-rc.1"}'],
    ["a tag already", '{".": "v0.40.0"}'],
  ])("answers null for %s", (_name, manifest) => {
    expect(releaseTag(manifest)).toBeNull();
  });
});

describe("verdict", () => {
  it("passes when the two are equal", () => {
    const answer = verdict({ tree: 59, release: 59, tag: "v0.40.0" });
    expect(answer).toMatchObject({ ok: true, code: 0 });
    expect(answer.sentence).toContain("59");
    expect(answer.sentence).toContain("v0.40.0");
  });

  it("says so when HEAD is the release itself", () => {
    const answer = verdict({ tree: 59, release: 59, tag: "v0.40.0", headIsTag: true });
    expect(answer).toMatchObject({ ok: true, code: 0 });
    expect(answer.sentence).toMatch(/^HEAD is v0\.40\.0/);
  });

  it("refuses a tree ahead of the release, in one sentence that names both", () => {
    expect(verdict({ tree: 60, release: 59, tag: "v0.40.0" })).toEqual({
      ok: false,
      code: 1,
      sentence:
        "This tree's user schema is 60, the last release (v0.40.0) is 59: a web app deployed from here would send paired desktops ops they must hold until a release exists.",
    });
  });

  it("refuses a tree behind it too — a difference either way is two schemas in one group", () => {
    expect(verdict({ tree: 58, release: 59, tag: "v0.40.0" })).toMatchObject({
      ok: false,
      code: 1,
    });
  });

  // A tagged commit with an edited `schema.rs` on top of it is not the release: what would be
  // built and uploaded is the tree.
  it("does not pass a differing tree for sitting on the tag", () => {
    expect(verdict({ tree: 60, release: 59, tag: "v0.40.0", headIsTag: true }).ok).toBe(false);
  });

  it.each([
    ["no tag", { tree: 59, release: 59, tag: null }, /names no released version/],
    ["no constant in the tree", { tree: null, release: 59, tag: "v0.40.0" }, /in this tree/],
    ["no constant at the tag", { tree: 59, release: null, tag: "v0.40.0" }, /at v0\.40\.0/],
    [
      "a tag git cannot show",
      { tree: 59, release: null, tag: "v0.40.0", unreadable: "fatal: invalid object name" },
      /git could not read .* at v0\.40\.0 \(fatal: invalid object name\)/,
    ],
    ["nothing on either side", { tree: null, release: null, tag: "v0.40.0" }, /in this tree/],
  ])("cannot tell with %s, and that is never a pass", (_name, input, sentence) => {
    const answer = verdict(input);
    expect(answer).toMatchObject({ ok: false, code: 2 });
    expect(answer.sentence).toMatch(sentence);
    expect(answer.sentence).toMatch(/nothing was compared|no tag to compare/);
  });
});

describe("what the guard stands on", () => {
  // The whole argument is that an op carries the sender's user schema. If the stamp ever reads
  // another constant, this guard compares the wrong number.
  it("is the constant sync stamps every op with", () => {
    expect(wireRs).toMatch(/op\.schema = Some\(crate::schema::USER_SCHEMA_VERSION\);/);
  });

  it("is an npm script, so the runbook's step is one command", () => {
    expect(JSON.parse(packageJson).scripts["web:deploy-guard"]).toBe(
      "node scripts/web-deploy-guard.mjs",
    );
  });
});
