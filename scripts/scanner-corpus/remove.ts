// `pnpm scanner:corpus remove`: take named scans out of both buckets and the mirror, for a bad
// scan, a wrongly tagged one or a general cleanup. Remove only: a scan is never relabelled, so
// the corpus holds only labels a reader chose. Without `yes` it lists what it would delete and
// deletes nothing. The decision is `removalPlan`; this is the executor, over an injected `S3`
// and `log` so a suite can drive it without a network.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { rowsOf, withoutRuns } from "./baselines.ts";
import { hasLocal, removePair, removeReport } from "./mirror.ts";
import { removalPlan, type Removal, type Side } from "./plan.ts";
import { reconcileBaselines } from "./reconcile.ts";
import type { S3 } from "./s3.ts";

const SIDE: Record<Exclude<Side, null>, string> = { both: "run and label", run: "run only", label: "label only" };

/** Each local baseline's name and how many rows it holds for this scan. */
function baselineRows(dir: string, id: string): { name: string; rows: number | null }[] {
  const folder = join(dir, "baselines");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => {
      try {
        return { name, rows: rowsOf(readFileSync(join(folder, name), "utf8"), id) };
      } catch {
        return { name, rows: null };
      }
    });
}

function found(r: Removal, inboxName: string, corpusName: string, dir: string): string {
  const where = [
    r.inbox ? `${inboxName} (${SIDE[r.inbox]})` : null,
    r.corpus ? `${corpusName} (${SIDE[r.corpus]})` : null,
    r.local ? "local mirror" : null,
  ].filter(Boolean);
  const rows = baselineRows(dir, r.id);
  const baselines = rows.length
    ? rows.map((b) => `${b.name} ${b.rows ?? "unreadable"}`).join(", ")
    : "no baselines here";
  return `${r.id}: found in ${where.join(", ")}; baseline rows: ${baselines}`;
}

/** Returns the exit code: 1 when an id was found nowhere or anything failed, else 0. */
export async function runRemove(o: {
  s3: S3;
  dir: string;
  inbox: string;
  corpus: string;
  ids: string[];
  yes: boolean;
  log: (line: string) => void;
}): Promise<number> {
  const { s3, dir, log } = o;
  const listBoth = async (bucket: string) => [
    ...(await s3.list(bucket, "runs/")),
    ...(await s3.list(bucket, "labels/")),
  ];
  // A corpus that lists empty does not stop this: that guards pruning by absence, and this deletes by name.
  // The mirror counts by any of the scan's four paths, so a half-removed pair is still found and finished.
  const plans = removalPlan(o.ids, await listBoth(o.inbox), await listBoth(o.corpus), o.ids.filter((id) => hasLocal(dir, id)));
  const bucketOf = { inbox: o.inbox, corpus: o.corpus };
  // A row in a baseline is something to remove: an id held only there is not a failure.
  // Decided once, before anything is stripped.
  const heldByBaselines = new Set(
    plans.filter((r) => r.notFound && baselineRows(dir, r.id).some((b) => (b.rows ?? 0) > 0)).map((r) => r.id),
  );
  const nowhere = (r: Removal) => r.notFound && !heldByBaselines.has(r.id);
  const missing = plans.filter(nowhere);
  const sentence = (r: Removal) =>
    nowhere(r)
      ? `${r.id}: not found anywhere`
      : r.notFound
        ? `${r.id}: found only in baselines (${baselineRows(dir, r.id).filter((b) => (b.rows ?? 0) > 0).map((b) => `${b.name} ${b.rows}`).join(", ")})`
        : found(r, o.inbox, o.corpus, dir);

  if (!o.yes) {
    for (const r of plans) log(sentence(r));
    log("nothing was deleted; add --yes to delete");
    return missing.length ? 1 : 0;
  }

  const failed: string[] = [];
  const done = new Set<string>();
  // Every named id that did not stop: its baseline rows go found or not, so a rerun finishes a baseline step that failed.
  const strip = new Set<string>();
  let removedLocal = false;
  for (const r of plans) {
    if (r.notFound) {
      strip.add(r.id);
      log(nowhere(r) ? sentence(r) : `${sentence(r)}: removing its rows`);
      continue;
    }
    const gone: string[] = [];
    let stopped = false;
    // One failure ends this id: deleting the corpus copy after a failed inbox one would let the next pull adopt it again.
    for (const { bucket, key } of r.deletions) {
      try {
        await s3.remove(bucketOf[bucket], key);
        gone.push(`${bucketOf[bucket]}/${key}`);
      } catch (error) {
        failed.push(`${r.id}: ${bucketOf[bucket]}/${key}: ${(error as Error).message}`);
        stopped = true;
        break;
      }
    }
    if (!stopped && r.local) {
      try {
        removePair(dir, r.id);
        removedLocal = true;
        gone.push("the local pair");
      } catch (error) {
        failed.push(`${r.id}: local pair: ${(error as Error).message}`);
        stopped = true;
      }
    }
    if (!stopped) {
      done.add(r.id);
      strip.add(r.id);
    }
    const what = gone.length ? gone.join(", ") : "nothing";
    log(`${r.id}: ${stopped ? `stopped after ${what}; run it again to finish` : `deleted ${what}`}`);
  }

  if (removedLocal && removeReport(dir)) {
    log("deleted out/results.json, out/summary.md and out/report.html: they held a removed scan; the next replay rewrites them");
  }
  // Only the removed ids' rows go, never "everything the corpus does not hold": an empty listing would make that a purge.
  if (strip.size) {
    try {
      await reconcileBaselines({
        dir,
        s3,
        bucket: o.corpus,
        down: (await s3.list(o.corpus, "baselines/")).map((e) => e.key),
        rewrite: (text) => withoutRuns(text, strip),
        without: "the removed scans",
        failed,
        log,
      });
    } catch (error) {
      failed.push(`baselines: ${(error as Error).message}`);
    }
  }

  const baselineOnly = heldByBaselines.size;
  log(
    `removed ${done.size} of ${plans.length}${baselineOnly ? `, ${baselineOnly} only in baselines` : ""}${missing.length ? `, ${missing.length} not found anywhere` : ""}`,
  );
  if (failed.length) log(`${failed.length} did not go:\n  ${failed.join("\n  ")}`);
  return failed.length || missing.length ? 1 : 0;
}
