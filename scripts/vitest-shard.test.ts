import { describe, expect, it } from "vitest";
import recorded from "./vitest-durations.json" with { type: "json" };
import { durationKey, partition } from "./vitest-shard.ts";

describe("partition", () => {
  const keys = Array.from({ length: 40 }, (_, i) => `ui:f${String(i).padStart(2, "0")}.test.ts`);
  const durations = Object.fromEntries(keys.map((k, i) => [k, (i % 7) * 1000 + i * 10 + 5]));

  it("puts every file in exactly one shard", () => {
    for (const count of [1, 4, 6, 9]) {
      const shards = partition(keys, count, durations);
      expect(shards).toHaveLength(count);
      expect(shards.flat().sort()).toEqual([...keys].sort());
    }
  });

  // Each CI shard computes the packing on its own runner, so the order Vitest happens to collect
  // the files in must not move one.
  it("packs the same whatever order the files come in", () => {
    const reversed = [...keys].reverse();
    expect(partition(reversed, 4, durations)).toEqual(partition(keys, 4, durations));
  });

  it("evens the shards' time out where a count would not", () => {
    // Six heavy files that a slice by position would hand to one shard.
    const heavy = { ...durations };
    for (const k of keys.slice(0, 6)) heavy[k] = 60_000;
    const totals = partition(keys, 4, heavy).map((s) => s.reduce((t, k) => t + heavy[k], 0));
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(60_000);
  });

  it("weighs a file the record lacks at the record's median", () => {
    const shards = partition(["ui:new.test.ts", ...keys], 4, durations);
    expect(shards.flat()).toContain("ui:new.test.ts");
  });
});

describe("durationKey", () => {
  it("is the path from the root, `/`-separated, on either OS", () => {
    expect(durationKey("/r/repo", "/r/repo/packages/ui/a.test.ts")).toBe("packages/ui/a.test.ts");
    expect(durationKey("D:\\r\\repo", "D:\\r\\repo\\scripts\\b.test.ts")).toBe("scripts/b.test.ts");
  });
});

describe("vitest-durations.json", () => {
  it("is keyed project:path with whole milliseconds", () => {
    for (const [key, ms] of Object.entries(recorded as Record<string, number>)) {
      expect(key).toMatch(/^[a-z0-9-]+:[^\\]+\.test\.tsx?$/);
      expect(Number.isInteger(ms) && ms >= 0).toBe(true);
    }
  });
});
