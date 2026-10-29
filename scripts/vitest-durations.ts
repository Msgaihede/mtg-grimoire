// The reporter behind `pnpm test:durations`: one full run of the suite, and each file's time
// written to `scripts/vitest-durations.json` for `vitest-shard.ts` to pack the CI shards by.
//
// A file's time is everything a worker spends on it — the environment (jsdom, ~20–30 % of the
// suite), the setup file, the import, then the tests — because that is what a shard waits on.
// Whole milliseconds, sorted by key, so a regenerated record diffs by the files that moved.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Reporter, TestModule } from "vitest/node";
import { durationKey } from "./vitest-shard.ts";

const OUT = fileURLToPath(new URL("./vitest-durations.json", import.meta.url));

export default class DurationsReporter implements Reporter {
  private root = "";

  onInit(ctx: { config: { root: string } }): void {
    this.root = ctx.config.root;
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const entries = modules.map((module) => {
      const d = module.diagnostic();
      const ms =
        d.environmentSetupDuration +
        d.prepareDuration +
        d.setupDuration +
        d.collectDuration +
        d.duration;
      return [
        `${module.project.name}:${durationKey(this.root, module.moduleId)}`,
        Math.round(ms),
      ] as const;
    });
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    writeFileSync(OUT, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
    console.log(`vitest-durations: ${entries.length} files → ${OUT}`);
  }
}
