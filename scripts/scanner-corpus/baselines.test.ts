import { describe, expect, it } from "vitest";
import { keepingRuns, parsePending, rowsOf, settlePending, withoutRuns } from "./baselines.ts";

const text = (over: object = {}) =>
  JSON.stringify({
    v: 2,
    commit: "abc",
    extra: { kept: [1, 2] },
    runs: [
      { id: "a", x: 1 },
      { id: "b", x: 2 },
      { id: "c", x: 3 },
    ],
    skipped: [
      { id: "s", why: "no" },
      { id: "t", why: "no" },
    ],
    ...over,
  });

describe("keepingRuns", () => {
  it("drops every run and skipped entry whose id is not held, and keeps every other field", () => {
    const got = JSON.parse(keepingRuns(text(), ["a", "c", "s"])!);
    expect(got.runs).toEqual([
      { id: "a", x: 1 },
      { id: "c", x: 3 },
    ]);
    expect(got.skipped).toEqual([{ id: "s", why: "no" }]);
    expect(got).toMatchObject({ v: 2, commit: "abc", extra: { kept: [1, 2] } });
  });

  it("is null when every id in the file is held", () => {
    expect(keepingRuns(text(), ["a", "b", "c", "s", "t", "more"])).toBeNull();
  });

  it("does not refuse a version it does not know", () => {
    expect(JSON.parse(keepingRuns(text({ v: 9 }), ["a"])!).runs).toHaveLength(1);
  });

  it("copes with a file that has no skipped list", () => {
    expect(JSON.parse(keepingRuns(JSON.stringify({ runs: [{ id: "a" }] }), [])!)).toEqual({ runs: [] });
  });

  it("throws on text that is not JSON", () => {
    expect(() => keepingRuns("nope", ["a"])).toThrow();
  });
});

describe("the pending list", () => {
  it("reads a missing, corrupt or wrongly shaped file as empty", () => {
    expect(parsePending(null)).toEqual([]);
    expect(parsePending("{{")).toEqual([]);
    expect(parsePending('{"a":1}')).toEqual([]);
    expect(parsePending('["a.json", 3, "../x", ".hid.json"]')).toEqual(["a.json"]);
  });

  it("adds a failed upload", () => {
    expect(settlePending([], ["a.json"], [])).toEqual(["a.json"]);
  });

  it("removes a retry that succeeded and keeps one that failed", () => {
    expect(settlePending(["a.json", "b.json"], ["a.json"], ["b.json"])).toEqual(["a.json"]);
    expect(settlePending(["a.json", "b.json"], ["a.json", "b.json"], [])).toEqual(["a.json", "b.json"]);
  });

  it("holds each name once, sorted", () => {
    expect(settlePending(["b.json"], ["c.json", "a.json", "c.json"], [])).toEqual(["a.json", "b.json", "c.json"]);
    expect(settlePending(["b.json"], [], ["a.json", "b.json"])).toEqual([]);
  });
});

describe("removing named scans from a baseline", () => {
  it("drops only the named ids' rows, in runs and skipped, and keeps the rest", () => {
    const out = JSON.parse(withoutRuns(text(), ["b", "t"])!);
    expect(out.runs.map((r: { id: string }) => r.id)).toEqual(["a", "c"]);
    expect(out.skipped.map((r: { id: string }) => r.id)).toEqual(["s"]);
    expect(out.extra).toEqual({ kept: [1, 2] });
  });

  it("is null when none of them is there, and with no ids at all", () => {
    expect(withoutRuns(text(), ["zzz"])).toBeNull();
    expect(withoutRuns(text(), [])).toBeNull();
  });

  it("never strips a baseline against what is held: an empty held list is not a purge here", () => {
    // `keepingRuns(text, [])` would empty the file; `withoutRuns` of the same call's ids does not.
    expect(JSON.parse(withoutRuns(text(), ["a"])!).runs).toHaveLength(2);
  });

  it("copes with a file that has no skipped list, and throws on text that is not JSON", () => {
    expect(JSON.parse(withoutRuns(JSON.stringify({ runs: [{ id: "a" }] }), ["a"])!).runs).toEqual([]);
    expect(() => withoutRuns("nope", ["a"])).toThrow();
  });

  it("counts a scan's rows", () => {
    expect(rowsOf(text(), "a")).toBe(1);
    expect(rowsOf(text(), "s")).toBe(1);
    expect(rowsOf(text(), "zzz")).toBe(0);
    expect(rowsOf(JSON.stringify({ v: 1 }), "a")).toBe(0);
  });
});
