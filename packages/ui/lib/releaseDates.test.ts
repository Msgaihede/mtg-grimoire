import { describe, expect, it } from "vitest";
import { releaseDates } from "./releaseDates";

/** The log's own shapes: the hand-written block on top, then release-please's headings. */
const LOG = `# Changelog

## Unreleased

### ⚠ BREAKING CHANGES

* something not yet released

## [0.44.0](https://github.com/Msgaihede/mtg-grimoire/compare/v0.43.0...v0.44.0) (2026-10-11)


### Features

* a line that names [0.1.0](https://example.com) (2020-01-01) mid-sentence

### [0.9.1](https://github.com/Msgaihede/mtg-grimoire/compare/v0.9.0...v0.9.1) (2026-08-16)

## [0.9.0](https://github.com/Msgaihede/mtg-grimoire/compare/v0.8.0...v0.9.0) (2026-08-15)
`;

describe("releaseDates", () => {
  it("reads each release heading's day, and nothing else", () => {
    expect(releaseDates(LOG)).toEqual({
      "0.44.0": "2026-10-11",
      "0.9.1": "2026-08-16",
      "0.9.0": "2026-08-15",
    });
  });

  it("keeps the newest heading for a version named twice", () => {
    const twice = `## [1.0.0](x) (2026-02-02)\n\n## [1.0.0](x) (2026-01-01)\n`;
    expect(releaseDates(twice)).toEqual({ "1.0.0": "2026-02-02" });
  });

  it("answers an empty log with no days", () => {
    expect(releaseDates("")).toEqual({});
  });
});
