import { describe, expect, it } from "vitest";
import { entryTagsInUse, parseEntryTags } from "./entryTags";

describe("parseEntryTags", () => {
  it("reads the column's JSON array", () => {
    expect(parseEntryTags('["Cube","trade bait"]')).toEqual(["Cube", "trade bait"]);
    expect(parseEntryTags("[]")).toEqual([]);
  });

  it("reads nothing out of a missing value", () => {
    expect(parseEntryTags(null)).toEqual([]);
    expect(parseEntryTags(undefined)).toEqual([]);
  });

  // `deck::read_tags`' leniency: the column only promises valid JSON, and it syncs.
  it("reads text that is not JSON, or JSON that is not an array, as no tags", () => {
    expect(parseEntryTags("cube")).toEqual([]);
    expect(parseEntryTags("")).toEqual([]);
    expect(parseEntryTags('"cube"')).toEqual([]);
    expect(parseEntryTags('{"tags":["cube"]}')).toEqual([]);
    expect(parseEntryTags("null")).toEqual([]);
  });

  it("skips an item that is not a string and keeps the rest in order", () => {
    expect(parseEntryTags('["Cube", 3, null, {"x":1}, "Trade"]')).toEqual(["Cube", "Trade"]);
  });
});

describe("entryTagsInUse", () => {
  it("is empty for no rows", () => {
    expect(entryTagsInUse([])).toEqual([]);
  });

  it("folds spellings by their capitals and sums the stacks", () => {
    expect(
      entryTagsInUse([
        { tag: "Cube", count: 3 },
        { tag: "cube", count: 1 },
      ]),
    ).toEqual([{ tag: "Cube", count: 4 }]);
  });

  it("draws the spelling more stacks use, whichever came first", () => {
    const rows = [
      { tag: "MODERN", count: 1 },
      { tag: "modern", count: 5 },
      { tag: "Modern", count: 2 },
    ];
    expect(entryTagsInUse(rows)).toEqual([{ tag: "modern", count: 8 }]);
    expect(entryTagsInUse([...rows].reverse())).toEqual([{ tag: "modern", count: 8 }]);
  });

  it("breaks a tie by the spelling that sorts first, so the order it arrived in is moot", () => {
    const rows = [
      { tag: "cube", count: 2 },
      { tag: "Cube", count: 2 },
    ];
    expect(entryTagsInUse(rows)).toEqual([{ tag: "Cube", count: 4 }]);
    expect(entryTagsInUse([...rows].reverse())).toEqual([{ tag: "Cube", count: 4 }]);
  });

  it("sorts by the app's label comparison, not by byte order", () => {
    expect(
      entryTagsInUse([
        { tag: "Zed", count: 1 },
        { tag: "apple", count: 1 },
        { tag: "Binder 2", count: 1 },
        { tag: "Binder 10", count: 1 },
      ]).map((r) => r.tag),
    ).toEqual(["apple", "Binder 2", "Binder 10", "Zed"]);
  });
});
