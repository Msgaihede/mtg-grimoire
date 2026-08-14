/**
 * What the app is doing, when it is doing something long enough to say so.
 *
 * The ribbon has one place for this — the line beside Refresh, and the 2px mana line
 * beneath it — and more than one thing in the app can be running. So a job is registered
 * here rather than plumbed to the ribbon by whoever started it: a sync, an update download,
 * and whatever comes next, all described the same way and ranked against each other.
 */
import { createStore } from "zustand/vanilla";
import type {
  FeedProgressEvent,
  OracleTagProgressEvent,
  SyncPhase,
  SyncProgressEvent,
  UpdateProgressEvent,
} from "@/lib/ipc";
import type { ManaLineSync } from "@/lib/mana";
import { ORACLE_TAG_PHASE_LABEL } from "@/lib/useOracleTagProgress";
import { PHASE_LABEL } from "@/lib/useSyncProgress";

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
  /**
   * A price feed being downloaded. **Between** the two, which is what the gaps are for: it is
   * quieter than a sync (which rewrites the corpus under every view and disables Refresh) and
   * louder than an update download (which changes nothing until the reader restarts), because
   * it is rewriting the numbers on the screen the reader is looking at right now.
   */
  marketplaceFeed: 5,
  update: 10,
  /**
   * The Oracle tag taxonomy being refreshed, and **the quietest job there is** — which is why
   * it sits below the update download rather than between two of the others.
   *
   * It is the only long job whose failure costs the reader nothing at all: `autoCategoryFor`
   * falls back to the type line, so an app with no taxonomy files every card and simply files
   * it less well. A sync rewrites the corpus under every view, a feed rewrites the numbers on
   * the screen being looked at, and an update download ends in a build worth restarting for.
   * This one changes where the *next* card lands. So it yields the row to all three, and the
   * ladder keeps its ten-apart spacing past `update` for whatever comes next.
   */
  oracleTags: 15,
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

/**
 * Fold a sync into the job the ribbon describes.
 *
 * `busy` decides whether anything is running, never the event: a run inside the 24 h check
 * window emits nothing at all, and Tauri drops the events emitted before the webview started
 * listening. `done` and `error` are terminal phases whose event can outlive the run by a poll
 * interval, so they fall back to the generic sentence and an indeterminate bar rather than
 * reading as finished — and a failure is reported by the banner and the status poll, which
 * outlive the event and can say why.
 */
export function syncActivity(progress: SyncProgressEvent | null, busy: boolean): Activity | null {
  if (!busy) return null;
  const phase: SyncPhase | null =
    progress && progress.phase !== "done" && progress.phase !== "error" ? progress.phase : null;
  if (!phase || !progress) {
    return { key: "sync", rank: RANK.sync, label: "Syncing card data", detail: null, value: null };
  }
  return {
    key: "sync",
    rank: RANK.sync,
    label: PHASE_LABEL[phase],
    detail: syncDetail(phase, progress),
    value: progress.total > 0 ? Math.min(1, progress.done / progress.total) : null,
  };
}

/**
 * The number under each phase, in the unit that phase is actually counting.
 *
 * The ingest gets no denominator: its total is `INGEST_TOTAL_ESTIMATE`, a constant, and a
 * printed `83,000 / 117,000` would state a figure nobody has counted. The reclaim is the
 * opposite — the freelist is counted once at entry and only falls — so it is the one phase
 * whose percentage is exactly true.
 */
function syncDetail(phase: SyncPhase, e: SyncProgressEvent): string | null {
  if (phase === "downloading" && e.total > 0) return megabytes(e.done, e.total);
  if (phase === "ingesting") return `${e.done.toLocaleString("en-US")} cards`;
  if (phase === "reclaiming" && e.total > 0) {
    return `${Math.min(100, Math.round((e.done / e.total) * 100))}%`;
  }
  return null;
}

/**
 * Fold a price-feed download into the job the ribbon describes.
 *
 * Takes the marketplace's label and the event rather than a hook's return type —
 * `updateActivity`'s arrangement, for its reason. `label` is `null` when nothing is being
 * fetched, and **it and not the event decides whether anything is running**: `syncActivity`'s
 * rule, for `syncActivity`'s reason. A terminal `done`/`error` event outlives the run it
 * describes, and the start-up refresh emits its first events before this window is listening —
 * so a job built from the event alone would both linger and start late.
 *
 * Two phases count two different things and the detail says which: bytes while the 63.7 MiB is
 * coming down, rows while it is being written. A phase with no denominator gets an
 * indeterminate bar rather than an invented percentage.
 */
export function marketplaceFeedActivity(
  label: string | null,
  progress: FeedProgressEvent | null,
): Activity | null {
  if (label === null) return null;
  const phase =
    progress && progress.phase !== "done" && progress.phase !== "error" ? progress : null;
  return {
    key: "marketplace-feed",
    rank: RANK.marketplaceFeed,
    label:
      phase?.phase === "ingesting" ? `Importing ${label} prices` : `Downloading ${label} prices`,
    detail: feedDetail(phase),
    value: phase && phase.total > 0 ? Math.min(1, phase.done / phase.total) : null,
  };
}

/** Bytes while downloading, rows while ingesting, and nothing at all without a total — the
 *  ingest's own count is real (it is rows written), so unlike the card sync's estimate it can
 *  be printed as a figure. */
function feedDetail(progress: FeedProgressEvent | null): string | null {
  if (!progress) return null;
  if (progress.phase === "downloading" && progress.total > 0) {
    return megabytes(progress.done, progress.total);
  }
  if (progress.phase === "ingesting") return `${progress.done.toLocaleString("en-US")} prices`;
  return null;
}

/**
 * Fold an Oracle tag refresh into the job the ribbon describes.
 *
 * `refreshing` decides whether anything is running and the event never does — `syncActivity`'s
 * rule, and the case for it here is the strongest of the three. `oracle_tags::refresh_if_due`
 * is spawned at launch, so the ordinary refresh **begins before this window has a listener**
 * and Tauri drops every event it emitted first; a job built from the event alone would start
 * late, and would linger afterwards because a terminal `done`/`error` outlives its run.
 * `OracleTagStatus.refreshing` is the reliable half, and `useOracleTagProgress` is what folds
 * the two together.
 *
 * **Only the download counts anything**, which is a fact about `oracle_tags.rs` rather than a
 * choice made here: `checking` emits `(0, 0)`, and the ingest hands its inner callback to
 * `&mut |_| {}` and emits `("ingesting", 0, 0)` once. So the ~5.8 MiB has a bar and a figure,
 * and the seconds of ingest after it have a sentence and an indeterminate bar. Better than
 * inventing a denominator: `syncActivity` refuses to print the card ingest's estimated total
 * for the same reason.
 */
export function oracleTagActivity(
  refreshing: boolean,
  progress: OracleTagProgressEvent | null,
): Activity | null {
  if (!refreshing) return null;
  const phase =
    progress && progress.phase !== "done" && progress.phase !== "error" ? progress : null;
  return {
    key: "oracle-tags",
    rank: RANK.oracleTags,
    // The generic sentence for a run this window has only heard *about* — a status that says
    // `refreshing` with no event yet, and the two terminal phases whose event can outlive the
    // run by a status read. None of the three is a phase, and none may read as finished.
    label: phase ? ORACLE_TAG_PHASE_LABEL[phase.phase] : "Updating card tags",
    detail:
      phase?.phase === "downloading" && phase.total > 0 ? megabytes(phase.done, phase.total) : null,
    value:
      phase?.phase === "downloading" && phase.total > 0
        ? Math.min(1, phase.done / phase.total)
        : null,
  };
}

/**
 * Fold an update download into a job.
 *
 * Takes the two values it needs rather than the whole `Update`, so this module stays free of
 * a hook's return type and a test can name the case in two arguments. `progress` is non-null
 * only while a download is in flight — `useUpdate` clears it in the call's `finally` — which
 * is what keeps a *check*, and a staged build waiting to install, out of the ribbon.
 */
export function updateActivity(
  progress: UpdateProgressEvent | null,
  version: string | null,
): Activity | null {
  if (!progress) return null;
  return {
    key: "update-download",
    rank: RANK.update,
    label: version ? `Downloading update ${version}` : "Downloading update",
    detail: progress.total > 0 ? megabytes(progress.done, progress.total) : null,
    value: progress.total > 0 ? Math.min(1, progress.done / progress.total) : null,
  };
}
