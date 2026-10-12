import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPair, corpusDir, cutFrames, localIds, orphans, removePair, removeReport, sweepOrphans, writePair } from "./mirror.ts";

const jpeg = (len: number, fill: number) => {
  const bytes = new Uint8Array(len).fill(fill);
  bytes.set([0xff, 0xd8, 0xff]);
  return bytes;
};
const label = (lengths: number[]) => JSON.stringify({ run: lengths.map((bytes) => ({ bytes })) });
const concat = (parts: Uint8Array[]) => Buffer.concat(parts);

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("the local mirror", () => {
  it("sits in the main checkout, not a worktree, unless told otherwise", () => {
    expect(corpusDir({}, "D:/Code/repo/.git")).toBe(join("D:/Code/repo", ".scanner-corpus"));
    expect(corpusDir({ SCANNER_CORPUS_DIR: "E:/scans" }, "D:/Code/repo/.git")).toBe("E:/scans");
  });

  it("cuts a run where its label says, and refuses one that does not add up", () => {
    const frames = cutFrames(label([5, 7]), concat([jpeg(5, 1), jpeg(7, 2)]));
    expect(frames.map((f) => f.length)).toEqual([5, 7]);
    expect(() => cutFrames(label([5, 7]), concat([jpeg(5, 1), jpeg(6, 2)]))).toThrow(
      "the label's frames add up to 12 bytes and the run is 11",
    );
    expect(() => cutFrames(label([5, 7]), new Uint8Array(12))).toThrow("frame 0 does not start as a JPEG does");
  });

  it("writes a pair with its frames, lists it, and removes all of it", () => {
    dir = mkdtempSync(join(tmpdir(), "scanner-corpus-"));
    const run = concat([jpeg(5, 1), jpeg(7, 2)]);
    writePair(dir, "id1", new TextEncoder().encode(label([5, 7])), run);
    expect(localIds(dir)).toEqual(["id1"]);
    expect(readdirSync(join(dir, "frames", "id1"))).toEqual(["00.jpg", "01.jpg"]);
    expect(readFileSync(join(dir, "frames", "id1", "01.jpg"))).toEqual(Buffer.from(jpeg(7, 2)));
    removePair(dir, "id1");
    expect(localIds(dir)).toEqual([]);
    expect(existsSync(join(dir, "frames", "id1"))).toBe(false);
    expect(existsSync(join(dir, "runs", "id1.bin"))).toBe(false);
  });

  it("refuses an id that could leave the mirror, and deletes nothing", () => {
    dir = mkdtempSync(join(tmpdir(), "scanner-corpus-"));
    const outside = join(dir, "frames", "x");
    mkdirSync(join(dir, "frames", "id1"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    expect(() => removePair(join(dir, "frames", "id1"), "../x")).toThrow();
    expect(() => removePair(dir, "../x")).toThrow();
    expect(() => writePair(dir, "../x", new TextEncoder().encode(label([5])), jpeg(5, 1))).toThrow();
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(dir, "frames", "id1"))).toBe(true);
  });

  it("skips a label file whose name is not a safe id", () => {
    dir = mkdtempSync(join(tmpdir(), "scanner-corpus-"));
    mkdirSync(join(dir, "labels"), { recursive: true });
    mkdirSync(join(dir, "runs"), { recursive: true });
    writeFileSync(join(dir, "labels", "a.b.json"), "{}");
    writeFileSync(join(dir, "runs", "a.b.bin"), "");
    expect(localIds(dir)).toEqual([]);
  });

  it("does not list a label whose run never landed", () => {
    dir = mkdtempSync(join(tmpdir(), "scanner-corpus-"));
    writePair(dir, "id1", new TextEncoder().encode(label([5])), jpeg(5, 1));
    rmSync(join(dir, "runs", "id1.bin"));
    expect(localIds(dir)).toEqual([]);
  });

  it("removes a scan's slices with it", () => {
    dir = mkdtempSync(join(tmpdir(), "scanner-corpus-"));
    writePair(dir, "id1", new TextEncoder().encode(label([5])), jpeg(5, 1));
    mkdirSync(join(dir, "out", "slices", "id1"), { recursive: true });
    mkdirSync(join(dir, "out", "slices", "id2"), { recursive: true });
    removePair(dir, "id1");
    expect(existsSync(join(dir, "out", "slices", "id1"))).toBe(false);
    expect(existsSync(join(dir, "out", "slices", "id2"))).toBe(true);
  });

  it("leaves an id listed when a removal is interrupted after its frames are gone", () => {
    dir = mkdtempSync(join(tmpdir(), "scanner-corpus-"));
    writePair(dir, "id1", new TextEncoder().encode(label([5])), jpeg(5, 1));
    // A run that cannot be removed as a file: the removal fails after the frames and slices.
    rmSync(join(dir, "runs", "id1.bin"));
    mkdirSync(join(dir, "runs", "id1.bin"));
    writeFileSync(join(dir, "runs", "id1.bin", "x"), "x");
    expect(() => removePair(dir, "id1")).toThrow();
    expect(existsSync(join(dir, "frames", "id1"))).toBe(false);
    expect(localIds(dir)).toEqual(["id1"]);
  });

  it("names the frame and slice folders that belong to no local pair", () => {
    expect(orphans(["a", "b", "../x"], ["b", "c"], ["a"])).toEqual({ frames: ["b"], slices: ["b", "c"] });
  });

  it("sweeps those folders and only those", () => {
    dir = mkdtempSync(join(tmpdir(), "scanner-corpus-"));
    writePair(dir, "id1", new TextEncoder().encode(label([5])), jpeg(5, 1));
    for (const sub of [["frames", "gone"], ["out", "slices", "gone"], ["out", "slices", "id1"]]) {
      mkdirSync(join(dir, ...sub), { recursive: true });
    }
    expect(sweepOrphans(dir)).toBe(2);
    expect(existsSync(join(dir, "frames", "gone"))).toBe(false);
    expect(existsSync(join(dir, "out", "slices", "gone"))).toBe(false);
    expect(existsSync(join(dir, "out", "slices", "id1"))).toBe(true);
    expect(existsSync(join(dir, "frames", "id1"))).toBe(true);
    expect(sweepOrphans(dir)).toBe(0);
  });

  it("removes the last report's three files, and says whether any was there", () => {
    dir = mkdtempSync(join(tmpdir(), "scanner-corpus-"));
    expect(removeReport(dir)).toBe(false);
    mkdirSync(join(dir, "out"), { recursive: true });
    for (const name of ["results.json", "summary.md", "report.html", "keep.txt"]) writeFileSync(join(dir, "out", name), "x");
    expect(removeReport(dir)).toBe(true);
    expect(readdirSync(join(dir, "out"))).toEqual(["keep.txt"]);
  });
});

describe("checkPair", () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const run = concat([jpeg(5, 1), jpeg(7, 2)]);

  it("passes a pair whose label adds up to the run", () => {
    expect(checkPair(enc(label([5, 7])), run)).toBeNull();
  });

  it("names a label whose bytes are wrong", () => {
    expect(checkPair(enc(label([5, 8])), run)).toContain("add up to 13 bytes and the run is 12");
  });

  it("names a run cut short", () => {
    expect(checkPair(enc(label([5, 7])), run.subarray(0, 9))).toContain("add up to 12 bytes and the run is 9");
  });

  it("refuses a label whose run is empty", () => {
    expect(checkPair(enc(label([])), new Uint8Array(0))).toContain("no frames");
  });

  it("names a label that is not JSON, or has no run", () => {
    expect(checkPair(enc("not json"), run)).toContain("label");
    expect(checkPair(enc("{}"), run)).toContain("label");
  });
});
