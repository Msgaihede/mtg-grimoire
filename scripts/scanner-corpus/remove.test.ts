import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRemove } from "./remove.ts";
import type { S3 } from "./s3.ts";

// Two in-memory buckets standing in for R2; nothing here opens a socket.
function fakeS3(initial: Record<string, string[]>, failOn: string[] = [], failPut: string[] = [], failList = false) {
  const buckets = new Map(Object.entries(initial).map(([name, keys]) => [name, new Map(keys.map((k) => [k, new Uint8Array([1])]))]));
  const calls: string[] = [];
  const s3 = {
    async list(bucket: string, prefix: string) {
      if (failList) throw new Error("GET: 503");
      return [...(buckets.get(bucket) ?? [])].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.length }));
    },
    async get(bucket: string, key: string) {
      return buckets.get(bucket)!.get(key)!;
    },
    async put(bucket: string, key: string, body: Uint8Array<ArrayBuffer>) {
      if (failPut.includes(`${bucket}/${key}`)) throw new Error("PUT failed: 500");
      calls.push(`put ${bucket}/${key}`);
      buckets.get(bucket)!.set(key, body);
    },
    async remove(bucket: string, key: string) {
      if (failOn.includes(`${bucket}/${key}`)) throw new Error("DELETE failed: 500");
      calls.push(`remove ${bucket}/${key}`);
      buckets.get(bucket)!.delete(key);
    },
  } as unknown as S3;
  return { s3, buckets, calls };
}

const baseline = (...ids: string[]) => JSON.stringify({ runs: ids.map((id) => ({ id })), skipped: [] });
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scanner-remove-"));
  for (const sub of ["labels", "runs", "frames/a", "baselines"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "labels", "a.json"), "{}");
  writeFileSync(join(dir, "runs", "a.bin"), "x");
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "out", "results.json"), "{}");
  writeFileSync(join(dir, "baselines", "base.json"), baseline("a", "b"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BOTH = { inbox: ["runs/a.bin", "labels/a.json"], corpus: ["runs/a.bin", "labels/a.json", "baselines/base.json"] };
const go = (s3: S3, ids: string[], yes: boolean) => {
  const out: string[] = [];
  return runRemove({ s3, dir, inbox: "inbox", corpus: "corpus", ids, yes, log: (l) => out.push(l) }).then((code) => ({ code, out }));
};

describe("scanner:corpus remove", () => {
  it("is a dry run without --yes: it says where each id is and deletes nothing", async () => {
    const { s3, calls } = fakeS3(BOTH);
    const { code, out } = await go(s3, ["a"], false);
    expect(code).toBe(0);
    expect(out[0]).toBe("a: found in inbox (run and label), corpus (run and label), local mirror; baseline rows: base.json 1");
    expect(out.at(-1)).toBe("nothing was deleted; add --yes to delete");
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, "labels", "a.json"))).toBe(true);
    // Not a byte of the mirror moves: the baseline, the report and the frames are as they were.
    expect(readFileSync(join(dir, "baselines", "base.json"), "utf8")).toBe(baseline("a", "b"));
    expect(readFileSync(join(dir, "out", "results.json"), "utf8")).toBe("{}");
    expect(existsSync(join(dir, "frames", "a"))).toBe(true);
    expect(existsSync(join(dir, "baselines", ".pending.json"))).toBe(false);
  });

  it("reports an id found nowhere in a dry run and exits 1 without stopping the others", async () => {
    const { s3 } = fakeS3(BOTH);
    const { code, out } = await go(s3, ["zz", "a"], false);
    expect(code).toBe(1);
    expect(out[0]).toBe("zz: not found anywhere");
    expect(out[1]).toContain("a: found in");
  });

  it("with --yes deletes the inbox before the corpus, the label before the run, then the mirror and the baseline rows", async () => {
    const { s3, calls, buckets } = fakeS3(BOTH);
    const { code, out } = await go(s3, ["a"], true);
    expect(code).toBe(0);
    expect(calls.slice(0, 4)).toEqual(["remove inbox/labels/a.json", "remove inbox/runs/a.bin", "remove corpus/labels/a.json", "remove corpus/runs/a.bin"]);
    expect(calls.slice(4)).toEqual(["put corpus/baselines/base.json"]);
    expect([...buckets.get("corpus")!.keys()]).toEqual(["baselines/base.json"]);
    expect(existsSync(join(dir, "labels", "a.json"))).toBe(false);
    expect(existsSync(join(dir, "frames", "a"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "baselines", "base.json"), "utf8")).runs).toEqual([{ id: "b" }]);
    expect(out).toContain("removed 1 of 1");
  });

  it("removes a half pair and ignores an object it was not asked about; an empty corpus listing does not stop it", async () => {
    const { s3, calls } = fakeS3({ inbox: ["runs/c.bin", "runs/c.bin.old"], corpus: [] });
    const { code } = await go(s3, ["c"], true);
    expect(code).toBe(0);
    expect(calls.filter((c) => c.startsWith("remove"))).toEqual(["remove inbox/runs/c.bin"]);
  });

  it("does not strip a baseline against an empty corpus: only the removed id's rows go", async () => {
    const { s3 } = fakeS3({ inbox: ["runs/a.bin", "labels/a.json"], corpus: [] });
    await go(s3, ["a"], true);
    expect(JSON.parse(readFileSync(join(dir, "baselines", "base.json"), "utf8")).runs).toEqual([{ id: "b" }]);
  });

  it("lists a failure, goes on to the next id, leaves the failed one's corpus copy alone and exits 1", async () => {
    const { s3, calls, buckets } = fakeS3(
      { inbox: ["runs/a.bin", "labels/a.json", "runs/d.bin", "labels/d.json"], corpus: ["runs/a.bin", "labels/a.json", "runs/d.bin", "labels/d.json"] },
      ["inbox/labels/a.json"],
    );
    const { code, out } = await go(s3, ["a", "d"], true);
    expect(code).toBe(1);
    expect(calls).not.toContain("remove corpus/runs/a.bin");
    expect(calls).toContain("remove corpus/runs/d.bin");
    expect(existsSync(join(dir, "labels", "a.json"))).toBe(true);
    // The inbox's label was the first step and failed, so the id stopped there: everything of a's is still held,
    // the corpus pair included (deleting it would let the next pull adopt the inbox copy again).
    expect(buckets.get("inbox")!.has("labels/a.json")).toBe(true);
    expect(buckets.get("inbox")!.has("runs/a.bin")).toBe(true);
    expect(buckets.get("corpus")!.has("labels/a.json")).toBe(true);
    expect(buckets.get("corpus")!.has("runs/a.bin")).toBe(true);
    expect(buckets.get("corpus")!.has("labels/d.json")).toBe(false);
    // a was not fully removed, so its baseline rows stay; d has none.
    expect(JSON.parse(readFileSync(join(dir, "baselines", "base.json"), "utf8")).runs).toEqual([{ id: "a" }, { id: "b" }]);
    expect(out.join("\n")).toContain("1 did not go");
    expect(out).toContain("removed 1 of 2");
  });

  it("strips an id held only by a baseline, found nowhere else, and does not call it a failure", async () => {
    const { s3 } = fakeS3({ inbox: [], corpus: ["baselines/base.json"] });
    const dry = await go(s3, ["b"], false);
    expect(dry.code).toBe(0);
    expect(dry.out[0]).toContain("b: found only in baselines (base.json 1)");
    const { code, out } = await go(s3, ["b"], true);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("1 only in baselines");
    expect(JSON.parse(readFileSync(join(dir, "baselines", "base.json"), "utf8")).runs).toEqual([{ id: "a" }]);
  });

  it("finishes a half-removed mirror: a lone label is found, removed and not reported as missing", async () => {
    rmSync(join(dir, "runs", "a.bin"));
    rmSync(join(dir, "frames", "a"), { recursive: true });
    const { s3 } = fakeS3({ inbox: [], corpus: [] });
    const dry = await go(s3, ["a"], false);
    expect(dry.code).toBe(0);
    expect(dry.out[0]).toContain("a: found in local mirror");
    const { code } = await go(s3, ["a"], true);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "labels", "a.json"))).toBe(false);
  });

  it("lists a local removal that fails, keeps that id's baseline rows and exits 1", async () => {
    // A label that is a non-empty directory cannot be removed as a file.
    rmSync(join(dir, "labels", "a.json"));
    mkdirSync(join(dir, "labels", "a.json"));
    writeFileSync(join(dir, "labels", "a.json", "x"), "x");
    const { s3, calls } = fakeS3(BOTH);
    const { code, out } = await go(s3, ["a"], true);
    expect(code).toBe(1);
    expect(calls).toContain("remove corpus/runs/a.bin");
    expect(out.join("\n")).toContain("a: local pair:");
    expect(out).toContain("removed 0 of 1");
    expect(JSON.parse(readFileSync(join(dir, "baselines", "base.json"), "utf8")).runs).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("lists a baseline upload that fails and retries it next time through .pending.json", async () => {
    const { s3 } = fakeS3(BOTH, [], ["corpus/baselines/base.json"]);
    const { code, out } = await go(s3, ["a"], true);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("baselines/base.json: PUT failed: 500");
    expect(JSON.parse(readFileSync(join(dir, "baselines", ".pending.json"), "utf8"))).toEqual(["base.json"]);
    expect(JSON.parse(readFileSync(join(dir, "baselines", "base.json"), "utf8")).runs).toEqual([{ id: "b" }]);
  });

  it("deletes nothing when a listing fails", async () => {
    const { s3, calls } = fakeS3(BOTH, [], [], true);
    await expect(go(s3, ["a"], true)).rejects.toThrow("GET: 503");
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, "labels", "a.json"))).toBe(true);
    expect(readFileSync(join(dir, "baselines", "base.json"), "utf8")).toBe(baseline("a", "b"));
  });

  it("counts an id found nowhere in a real run as exit 1 and still removes the others", async () => {
    const { s3, calls } = fakeS3(BOTH);
    const { code, out } = await go(s3, ["nope", "a"], true);
    expect(code).toBe(1);
    expect(out[0]).toBe("nope: not found anywhere");
    expect(calls).toContain("remove corpus/runs/a.bin");
  });
});
