// `pnpm test:run --shard=N/M`, split by how long the files take rather than by how many there
// are (2026-10-29).
//
// **Vitest's own split is a count**: it sorts the files by a hash of their path and hands each
// shard an equal slice. Measured on the CI run of 2026-10-29, the four slices of ~185 files took
// 382, 186, 311 and 136 s: one shard held 6436 tests against another's 3808, and the frontend job
// waited on it. This sequencer packs the files instead — the longest first, each into the shard
// with the least time so far — by the durations `pnpm test:durations` recorded in
// `vitest-durations.json`. A file the record does not name (a new one, or a renamed one) weighs
// the record's median, so the split is never stale enough to lose a file: every shard computes
// the same packing from the same list, and each runs its own part of it.
//
// **The record is a hint, never a contract.** It can drift as files grow, and the cost is a
// less even split, not a wrong one; regenerate it when one shard runs long (`pnpm
// test:durations`, then commit the file).
import { BaseSequencer, type TestSpecification } from "vitest/node";
import recorded from "./vitest-durations.json" with { type: "json" };

/** A file's key in the record: its path from the repository root, `/`-separated. */
export function durationKey(root: string, moduleId: string): string {
  const slash = (p: string) => p.replaceAll("\\", "/");
  const base = slash(root).replace(/\/$/, "");
  const id = slash(moduleId);
  return id.startsWith(`${base}/`) ? id.slice(base.length + 1) : id;
}

/**
 * Longest-processing-time packing of `keys` into `count` shards by `durations` (ms), a key the
 * record lacks weighing its median. Deterministic for a given list and record — ties break by
 * key, then by the lower shard — so every shard of one run agrees on the packing.
 */
export function partition(
  keys: readonly string[],
  count: number,
  durations: Readonly<Record<string, number>>,
): string[][] {
  const known = Object.values(durations).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = (key: string) => durations[key] ?? median;
  const order = [...keys].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ total: 0, keys: [] as string[] }));
  for (const key of order) {
    let lightest = shards[0];
    for (const shard of shards) if (shard.total < lightest.total) lightest = shard;
    lightest.keys.push(key);
    lightest.total += weight(key);
  }
  return shards.map((shard) => shard.keys);
}

export default class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const key = (spec: TestSpecification) =>
      `${spec.project.name}:${durationKey(root, spec.moduleId)}`;
    const mine = new Set(partition(files.map(key), shard.count, recorded)[shard.index - 1]);
    return files.filter((spec) => mine.has(key(spec)));
  }
}
