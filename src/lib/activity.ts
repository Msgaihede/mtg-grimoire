/**
 * What the app is doing, when it is doing something long enough to say so.
 *
 * The ribbon has one place for this — the line beside Refresh, and the 2px mana line
 * beneath it — and more than one thing in the app can be running. So a job is registered
 * here rather than plumbed to the ribbon by whoever started it: a sync, an update download,
 * and whatever comes next, all described the same way and ranked against each other.
 */
import { createStore } from "zustand/vanilla";
import type { ManaLineSync } from "@/lib/mana";

/** One long-running job, as the ribbon needs to describe it. */
export interface Activity extends ManaLineSync {
  /** One job per key — registering the same key again replaces it. */
  key: string;
  /**
   * Which job wins when two are running. Lower is louder; see {@link RANK}.
   *
   * On the job rather than in a table here, because the ribbon must be able to rank a job
   * from a feature this module has never heard of.
   */
  rank: number;
  /**
   * The unit the job is counting — `"45 / 77 MB"`, `"83,000 cards"`, `"62%"` — or `null`
   * for a phase that counts nothing.
   *
   * Separate from `label` because the two are read by different audiences: the label is
   * announced and the detail is looked at. See `Ribbon`, where the detail is `aria-hidden`.
   */
  detail: string | null;
}

/**
 * The ranks, ten apart so a job that belongs between two of these does not renumber them.
 *
 * The sync outranks the download because it is the job that disables Refresh and rewrites
 * the corpus underneath every view; a download changes nothing until the reader restarts,
 * and has a panel of its own in Settings.
 */
export const RANK = {
  sync: 0,
  update: 10,
} as const;

/** How long a job must run before the ribbon puts a sentence on screen. See `Ribbon`. */
export const ACTIVITY_DELAY_MS = 400;

export interface ActivityState {
  /** Insertion-ordered, which is what makes {@link topActivity}'s tie-break deterministic. */
  jobs: Activity[];
  /** Add a job, or replace the one already under its key. */
  put: (job: Activity) => void;
  /** Remove a job. Silent when there is nothing under that key. */
  drop: (key: string) => void;
}

function unchanged(a: Activity, b: Activity): boolean {
  return a.rank === b.rank && a.label === b.label && a.detail === b.detail && a.value === b.value;
}

/**
 * A registry, per provider rather than per module.
 *
 * `useAppStore` is on record in CLAUDE.md as the one global that cannot be made per-story
 * from `.storybook/` — zustand's `create` does not expose its initializer — and a docs page
 * mounting ten stories at once is where that bites. A factory means a story, a test and the
 * app each get their own.
 */
export function createActivityStore() {
  return createStore<ActivityState>((set) => ({
    jobs: [],
    put: (job) =>
      set((s) => {
        const at = s.jobs.findIndex((j) => j.key === job.key);
        if (at === -1) return { jobs: [...s.jobs, job] };
        // Identity in, identity out. `useRegisterActivity` puts on every render, so a put
        // that changes nothing must not notify a single subscriber.
        if (unchanged(s.jobs[at], job)) return s;
        const jobs = s.jobs.slice();
        jobs[at] = job;
        return { jobs };
      }),
    drop: (key) =>
      set((s) =>
        s.jobs.some((j) => j.key === key) ? { jobs: s.jobs.filter((j) => j.key !== key) } : s,
      ),
  }));
}

/**
 * The job the ribbon describes: the lowest rank, ties broken by insertion order.
 *
 * Strictly lower, so the first job to arrive keeps the row — two hooks' effects run in an
 * order nobody chose, and an answer that depended on it would be a bug that reproduced
 * about half the time.
 */
export function topActivity(jobs: readonly Activity[]): Activity | null {
  let top: Activity | null = null;
  for (const job of jobs) if (top === null || job.rank < top.rank) top = job;
  return top;
}

/**
 * `45 / 77 MB`.
 *
 * Whole megabytes on purpose: a tenth of a megabyte reflowing twice a second is motion
 * without information, and this number sits in a 48px row beside a moving bar.
 */
export function megabytes(done: number, total: number): string {
  const mb = (n: number) => (n / 1_000_000).toFixed(0);
  return `${mb(done)} / ${mb(total)} MB`;
}
