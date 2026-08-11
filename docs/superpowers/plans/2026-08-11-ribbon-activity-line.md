# Ribbon activity line — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a long job is running, the top ribbon says what it is doing —
`Downloading card data · 45 / 77 MB` — instead of leaving the corpus summary up for ninety
seconds.

**Architecture:** A small activity registry (a vanilla zustand store created inside an
`ActivityProvider` at the top of `AppShell`) that any feature can register a job into.
Two adapters exist today: the Scryfall sync and the update download. The ribbon renders the
top-ranked job into the status-line slot, gated by a 400 ms delay so a sub-second phase
never flashes a sentence; the mana line keeps reacting instantly.

**Tech Stack:** React 19, TypeScript 6, zustand 5 (`zustand/vanilla` + `useStore`), Vitest +
Testing Library, Storybook 9.

**Spec:** `docs/superpowers/specs/2026-08-11-ribbon-activity-line-design.md` — read it first.

## Global Constraints

- Work on branch `feat/ribbon-activity-line`. Commit after each task with
  `feat:`/`fix:`/`chore:`/`test:`/`refactor:` prefixes.
- `npm run verify` (build + lint + Vitest + cargo test) must pass before the final commit.
  `node_modules` is already installed in this worktree; three suites fail without it.
- Frontend work follows the `frontend-design` skill and
  `docs/superpowers/specs/2026-08-04-visual-design-direction.md`. Do not invent colours,
  type or motion.
- **Dim text is `text-dim`, never `text-muted`** (`src/lib/tokens.test.ts` guards it).
- Data-shaped text (byte counts, card counts) is Geist Mono with `tabular-nums`.
- Motion: 150 ms transitions, `motion-reduce:` variants. Nothing new animates here.
- Sentence case; verbs on buttons.
- No z-index literals — `LAYER` in `src/lib/layers.ts` is the only place they are written.
  (Nothing in this plan needs one.)
- No new dependencies. zustand 5 is already a dependency.
- Tests cover logic that can break. No ceremony tests.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/activity.ts` **(new)** | The `Activity` type, the ranks, the store factory, `topActivity`, the shared `megabytes` formatter, and the two adapters. Pure TypeScript, no React, no JSX. |
| `src/lib/activity.test.ts` **(new)** | The store's rules and both adapters. |
| `src/lib/useDelayedFlag.ts` **(new)** | One generic hook: true after N ms of continuous truth, false instantly. |
| `src/lib/useDelayedFlag.test.ts` **(new)** | Fake-timer coverage of that hook. |
| `src/components/ActivityProvider.tsx` **(new)** | The context, the provider, `useRegisterActivity`, `useTopActivity`. |
| `src/components/ActivityProvider.test.tsx` **(new)** | Registration, replacement, drop-on-unmount, ranking through React. |
| `src/lib/mana.ts` **(modify)** | Loses `manaLineSync`; keeps `ManaLineSync`, which `Activity` now extends. |
| `src/lib/mana.test.ts` **(modify)** | Loses the `manaLineSync` block (it moves to `activity.test.ts`). |
| `src/components/SyncProgress.tsx` **(modify)** | Its private byte formatter becomes the shared `megabytes`. |
| `src/components/Ribbon.tsx` **(modify)** | `sync` → `activity`, plus `activityVisible`; the status line becomes one permanently mounted `role="status"`. |
| `src/components/Ribbon.test.tsx` **(modify)** | The new slot behaviour. |
| `src/components/Ribbon.stories.tsx` **(modify)** | Stories per phase and for an update download. |
| `src/components/ManaLine.stories.tsx` **(modify)** | Two prose references to `manaLineSync`. |
| `src/components/AppShell.tsx` **(modify)** | Splits into provider + inner shell; registers both adapters; owns the delay gate. |
| `src/components/AppShell.test.tsx` **(modify)** | One end-to-end test: an event becomes a sentence. |
| `CLAUDE.md` **(modify)** | The registry's rules, in the frontend design section. |

---

## Task 1: The activity registry

**Files:**
- Create: `src/lib/activity.ts`
- Create: `src/lib/activity.test.ts`

**Interfaces:**
- Consumes: `ManaLineSync` from `src/lib/mana.ts` (`{ value: number | null; label: string }`).
- Produces: `Activity`, `RANK`, `ActivityState`, `createActivityStore()`,
  `topActivity(jobs)`, `megabytes(done, total)`, `ACTIVITY_DELAY_MS`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/activity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_DELAY_MS,
  RANK,
  createActivityStore,
  megabytes,
  topActivity,
  type Activity,
} from "@/lib/activity";

const job = (over: Partial<Activity> = {}): Activity => ({
  key: "sync",
  rank: RANK.sync,
  label: "Syncing card data",
  detail: null,
  value: null,
  ...over,
});

describe("topActivity", () => {
  it("is null when nothing is running", () => {
    expect(topActivity([])).toBeNull();
  });

  /** The sync is the job that blocks Refresh and rewrites the corpus; a background
   *  download is the one that can wait its turn to be described. */
  it("describes the lowest rank, whatever order the jobs arrived in", () => {
    const sync = job();
    const update = job({ key: "update-download", rank: RANK.update });

    expect(topActivity([update, sync])).toBe(sync);
    expect(topActivity([sync, update])).toBe(sync);
  });

  /** Two hooks' effects run in an order nobody chose. Without a tie-break the ribbon's
   *  answer would depend on it, and the test would pass or fail by luck. */
  it("breaks a tie by insertion order", () => {
    const first = job({ key: "a", rank: 5 });
    const second = job({ key: "b", rank: 5 });

    expect(topActivity([first, second])).toBe(first);
    expect(topActivity([second, first])).toBe(second);
  });
});

describe("the activity store", () => {
  it("holds one job per key, and replaces rather than duplicating", () => {
    const store = createActivityStore();

    store.getState().put(job({ label: "Checking for card data updates" }));
    store.getState().put(job({ label: "Importing cards", detail: "83,000 cards" }));

    expect(store.getState().jobs).toHaveLength(1);
    expect(store.getState().jobs[0].label).toBe("Importing cards");
  });

  /**
   * The whole reason the ribbon does not re-render sixty times an ingest for nothing.
   * `useRegisterActivity` puts on every render; an identical put must be a no-op all the
   * way down to the array's identity, or every keystroke in the search box would re-render
   * the status line.
   */
  it("leaves the store untouched when a put changes nothing", () => {
    const store = createActivityStore();
    store.getState().put(job());
    const before = store.getState().jobs;

    store.getState().put(job());

    expect(store.getState().jobs).toBe(before);
  });

  it("moves a job's numbers without disturbing the others", () => {
    const store = createActivityStore();
    store.getState().put(job());
    store.getState().put(job({ key: "update-download", rank: RANK.update }));

    store.getState().put(job({ detail: "45 / 77 MB", value: 0.58 }));

    expect(store.getState().jobs.map((j) => j.key)).toEqual(["sync", "update-download"]);
    expect(store.getState().jobs[0].value).toBe(0.58);
  });

  it("drops by key, and dropping an absent key changes nothing", () => {
    const store = createActivityStore();
    store.getState().put(job());
    store.getState().put(job({ key: "update-download", rank: RANK.update }));

    store.getState().drop("sync");
    expect(store.getState().jobs.map((j) => j.key)).toEqual(["update-download"]);

    const before = store.getState().jobs;
    store.getState().drop("nothing-by-that-name");
    expect(store.getState().jobs).toBe(before);
  });
});

describe("megabytes", () => {
  /** Whole megabytes: a tenth of a megabyte reflowing twice a second is noise. */
  it("reports both ends in whole megabytes", () => {
    expect(megabytes(45_300_000, 77_000_000)).toBe("45 / 77 MB");
    expect(megabytes(0, 77_000_000)).toBe("0 / 77 MB");
  });
});

describe("ACTIVITY_DELAY_MS", () => {
  /** Long enough to sit out a sub-second `checking` phase, short enough that a reader who
   *  clicked Refresh is not left wondering. */
  it("is 400ms", () => {
    expect(ACTIVITY_DELAY_MS).toBe(400);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/activity.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/activity"`.

- [ ] **Step 3: Write the module**

Create `src/lib/activity.ts`:

```ts
/**
 * What the app is doing, when it is doing something long enough to say so.
 *
 * The ribbon has one place for this — the line beside Refresh, and the 2px mana line
 * beneath it — and more than one thing in the app can be running. So a job is registered
 * here rather than plumbed to the ribbon by whoever started it: a sync, an update download,
 * and whatever Plan 6 adds, all described the same way and ranked against each other.
 */
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
  return (
    a.rank === b.rank && a.label === b.label && a.detail === b.detail && a.value === b.value
  );
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
```

Add the zustand import at the top of the file, above the `@/lib/mana` import (the repo
orders external packages first):

```ts
import { createStore } from "zustand/vanilla";
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/lib/activity.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/activity.ts src/lib/activity.test.ts
git commit -m "feat(activity): register what the app is doing, and rank it"
```

---

## Task 2: The two adapters that exist today

Turn a sync's progress event and an update download into `Activity` values. `manaLineSync`
is the sync half already, minus the detail — it moves out of `src/lib/mana.ts`, which is a
module about Magic's colour pie and was only ever housing it.

**Files:**
- Modify: `src/lib/activity.ts` (append)
- Modify: `src/lib/activity.test.ts` (append)
- Modify: `src/lib/mana.ts` — delete `manaLineSync` and its now-unused imports
- Modify: `src/lib/mana.test.ts` — delete the `describe("manaLineSync")` block and the
  `manaLineSync` import; keep everything else
- Modify: `src/components/SyncProgress.tsx` — use the shared `megabytes`
- Modify: `src/components/AppShell.tsx:16,122` — the one call site

**Interfaces:**
- Consumes: `Activity`, `RANK`, `megabytes` (Task 1); `PHASE_LABEL` from
  `@/lib/useSyncProgress`; `SyncPhase`, `SyncProgressEvent`, `UpdateProgressEvent` from
  `@/lib/ipc`.
- Produces: `syncActivity(progress: SyncProgressEvent | null, busy: boolean): Activity | null`
  and `updateActivity(progress: UpdateProgressEvent | null, version: string | null): Activity | null`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/activity.test.ts` (and extend the import from `@/lib/activity` with
`syncActivity` and `updateActivity`):

```ts
import type { SyncProgressEvent } from "@/lib/ipc";

const event = (over: Partial<SyncProgressEvent> = {}): SyncProgressEvent => ({
  phase: "ingesting",
  done: 0,
  total: 0,
  message: null,
  ...over,
});

describe("syncActivity", () => {
  /**
   * `busy` decides, not the event. A run inside the 24 h check window emits nothing at all,
   * and Tauri drops every event emitted before the webview registered its listener — so an
   * event is evidence of progress, never of running.
   */
  it("is null when nothing is running, whatever event is still in hand", () => {
    expect(syncActivity(null, false)).toBeNull();
    expect(syncActivity(event({ phase: "ingesting", done: 5, total: 10 }), false)).toBeNull();
  });

  it("is the generic sentence, indeterminate, before any event arrives", () => {
    const activity = syncActivity(null, true);

    expect(activity).toMatchObject({
      key: "sync",
      rank: RANK.sync,
      label: "Syncing card data",
      detail: null,
      value: null,
    });
  });

  it("counts a download in whole megabytes", () => {
    const activity = syncActivity(
      event({ phase: "downloading", done: 45_300_000, total: 77_000_000 }),
      true,
    );

    expect(activity?.label).toBe("Downloading card data");
    expect(activity?.detail).toBe("45 / 77 MB");
    expect(activity?.value).toBeCloseTo(0.588, 2);
  });

  /**
   * No denominator in the text, deliberately: the ingest's total is `INGEST_TOTAL_ESTIMATE`,
   * a constant, and `83,000 / 117,000 cards` would state a figure nobody has counted. The
   * bar may imply the fraction; a number may not.
   */
  it("counts an ingest in cards and never prints its estimated total", () => {
    const activity = syncActivity(
      event({ phase: "ingesting", done: 83_000, total: 117_000 }),
      true,
    );

    expect(activity?.label).toBe("Importing cards");
    expect(activity?.detail).toBe("83,000 cards");
    expect(activity?.value).toBeCloseTo(0.709, 2);
  });

  /** The one phase whose fraction is exactly true: the freelist is counted once at entry
   *  and only falls (`maintenance::reclaim_freed_pages`). */
  it("reports the reclaim as a percentage", () => {
    expect(syncActivity(event({ phase: "reclaiming", done: 620, total: 1000 }), true)?.detail).toBe(
      "62%",
    );
  });

  it("has no number for the phases that count nothing", () => {
    for (const phase of ["checking", "sets", "compacting"] as const) {
      const activity = syncActivity(event({ phase }), true);
      expect(activity?.detail).toBeNull();
      expect(activity?.value).toBeNull();
    }
  });

  /** Their event can outlive the run by a poll interval, so they must not read as a full
   *  or an empty bar — and the ribbon is not where a failure is reported. */
  it("treats a finished or failed run as running with nothing to say", () => {
    for (const phase of ["done", "error"] as const) {
      const activity = syncActivity(event({ phase, done: 9, total: 9 }), true);
      expect(activity?.label).toBe("Syncing card data");
      expect(activity?.value).toBeNull();
      expect(activity?.detail).toBeNull();
    }
  });

  it("never runs past the end", () => {
    expect(
      syncActivity(event({ phase: "ingesting", done: 130_000, total: 117_000 }), true)?.value,
    ).toBe(1);
  });
});

describe("updateActivity", () => {
  /** `useUpdate` holds a progress event only while a download is in flight — it is nulled
   *  in the call's `finally` — so this is structural rather than a rule to remember. */
  it("is null when no download is running", () => {
    expect(updateActivity(null, "0.3.0")).toBeNull();
  });

  it("names the version it is fetching", () => {
    const activity = updateActivity({ done: 12_000_000, total: 40_000_000 }, "0.3.0");

    expect(activity).toMatchObject({
      key: "update-download",
      rank: RANK.update,
      label: "Downloading update 0.3.0",
      detail: "12 / 40 MB",
    });
    expect(activity?.value).toBeCloseTo(0.3, 2);
  });

  /** A download with no version in hand is a state the poll can genuinely be in for a
   *  moment; "Downloading update null" is not a thing to put on screen. */
  it("still says what it is doing when the version is unknown", () => {
    expect(updateActivity({ done: 0, total: 0 }, null)).toMatchObject({
      label: "Downloading update",
      detail: null,
      value: null,
    });
  });

  it("is outranked by a sync", () => {
    const sync = syncActivity(null, true)!;
    const update = updateActivity({ done: 1, total: 2 }, "0.3.0")!;

    expect(topActivity([update, sync])).toBe(sync);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/lib/activity.test.ts`
Expected: FAIL — `syncActivity is not a function` (and the same for `updateActivity`).

- [ ] **Step 3: Write the adapters**

Append to `src/lib/activity.ts`:

```ts
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
export function syncActivity(
  progress: SyncProgressEvent | null,
  busy: boolean,
): Activity | null {
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
 * Fold an update download into a job.
 *
 * Takes the two values it needs rather than the whole `Update`, so this module stays free of
 * a hook's return type and the test can name the case in two arguments. `progress` is
 * non-null only while a download is in flight — `useUpdate` clears it in the call's
 * `finally` — which is what keeps a *check*, and a staged build waiting to install, out of
 * the ribbon.
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
```

Extend the imports at the top of `src/lib/activity.ts`:

```ts
import type {
  SyncPhase,
  SyncProgressEvent,
  UpdateProgressEvent,
} from "@/lib/ipc";
import type { ManaLineSync } from "@/lib/mana";
import { PHASE_LABEL } from "@/lib/useSyncProgress";
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/lib/activity.test.ts`
Expected: PASS.

- [ ] **Step 5: Delete `manaLineSync` and move its call site**

In `src/lib/mana.ts`, delete the whole `manaLineSync` function and its doc comment
(lines ~147–168), and delete the now-unused first import line
`import type { SyncPhase, SyncProgressEvent } from "@/lib/ipc";` and
`import { PHASE_LABEL } from "@/lib/useSyncProgress";`. **Keep** `ManaLineSync` and update
its doc to say what it now is:

```ts
/**
 * What the mana line draws — the subset of an `Activity` the line itself needs.
 *
 * `Activity` extends this, so the ribbon hands the top job straight to `ManaLine`. It stays
 * here rather than moving to `activity.ts` because it is a property of the *line*: a
 * fraction and a name for it are all a 2px rule can carry.
 */
export interface ManaLineSync {
  /** 0–1, or `null` for a phase with no denominator. */
  value: number | null;
  label: string;
}
```

In `src/lib/mana.test.ts`, delete the `describe("manaLineSync", …)` block at the end of the
file, the `manaLineSync` entry in the `@/lib/mana` import, the now-unused
`import type { SyncProgressEvent } from "@/lib/ipc";`, and the `event()` helper if nothing
else in that file uses it (check first — `grep -n "event(" src/lib/mana.test.ts`).

In `src/components/AppShell.tsx`, change the import on line 16 and the prop on line 122:

```ts
import { syncActivity } from "@/lib/activity";
```

```tsx
          sync={syncActivity(progress, busy)}
```

(`Activity` extends `ManaLineSync`, so this type-checks and behaves identically. Task 4
replaces the prop itself.)

- [ ] **Step 6: Share the byte formatter with the first-run overlay**

In `src/components/SyncProgress.tsx`, replace the private `mb` helper inside `detail()`:

```ts
/** The numbers under the bar, in the unit the phase is actually counting. */
function detail(e: SyncProgressEvent): string | null {
  if (e.phase === "downloading" && e.total > 0) return megabytes(e.done, e.total);
  if (e.phase === "ingesting") return `${e.done.toLocaleString("en-US")} cards`;
  return null;
}
```

and add `import { megabytes } from "@/lib/activity";` to its imports. The overlay's own
`detail()` stays: it deliberately shows fewer phases than the ribbon does, because a first
run never reaches `reclaiming` with an empty database behind it.

- [ ] **Step 7: Run the whole frontend suite**

Run: `npx vitest run`
Expected: PASS. If `mana.test.ts` fails to compile, an import was left behind.

- [ ] **Step 8: Commit**

```bash
git add src/lib/activity.ts src/lib/activity.test.ts src/lib/mana.ts src/lib/mana.test.ts src/components/SyncProgress.tsx src/components/AppShell.tsx
git commit -m "refactor(activity): fold the sync and the update download into activities"
```

---

## Task 3: The React glue

The provider, the two hooks, and the delay. Nothing renders differently yet — this is the
interface Tasks 4 and 5 consume.

**Files:**
- Create: `src/lib/useDelayedFlag.ts`
- Create: `src/lib/useDelayedFlag.test.ts`
- Create: `src/components/ActivityProvider.tsx`
- Create: `src/components/ActivityProvider.test.tsx`

**Interfaces:**
- Consumes: `createActivityStore`, `topActivity`, `Activity`, `ActivityState` (Task 1).
- Produces: `<ActivityProvider>{children}</ActivityProvider>`,
  `useRegisterActivity(job: Activity | null): void`, `useTopActivity(): Activity | null`,
  `useDelayedFlag(active: boolean, ms: number): boolean`.

- [ ] **Step 1: Write the failing test for the delay**

Create `src/lib/useDelayedFlag.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedFlag } from "@/lib/useDelayedFlag";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const flag = (active: boolean) =>
  renderHook(({ active }) => useDelayedFlag(active, 400), { initialProps: { active } });

describe("useDelayedFlag", () => {
  it("waits out the delay before turning on", () => {
    const { result } = flag(true);

    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(399));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  /** The case the delay exists for: a Refresh that finds nothing new is over in ~1.8s, of
   *  which `checking` is under one — and a sentence nobody can finish reading is worse than
   *  no sentence. */
  it("never turns on for something shorter than the delay", () => {
    const { result, rerender } = flag(true);

    act(() => vi.advanceTimersByTime(200));
    rerender({ active: false });
    act(() => vi.advanceTimersByTime(5_000));

    expect(result.current).toBe(false);
  });

  /** Asymmetric on purpose: appearing is what needs a threshold, and a line that lingered
   *  after the work stopped would be the interface lying. */
  it("turns off the instant the work stops", () => {
    const { result, rerender } = flag(true);
    act(() => vi.advanceTimersByTime(400));
    expect(result.current).toBe(true);

    rerender({ active: false });

    expect(result.current).toBe(false);
  });

  it("re-arms after a gap", () => {
    const { result, rerender } = flag(true);
    act(() => vi.advanceTimersByTime(400));
    rerender({ active: false });

    rerender({ active: true });
    act(() => vi.advanceTimersByTime(399));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/lib/useDelayedFlag.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/useDelayedFlag"`.

- [ ] **Step 3: Write the hook**

Create `src/lib/useDelayedFlag.ts`:

```ts
import { useEffect, useState } from "react";

/**
 * `true` once `active` has been true for `ms` without interruption; `false` the instant it
 * stops.
 *
 * Deliberately asymmetric. Appearing is the half that needs a threshold — the ribbon's
 * activity line must not flash a sentence during a sub-second phase — and disappearing must
 * not, because a line that lingered after the work stopped would be the interface saying
 * something untrue about the present moment.
 */
export function useDelayedFlag(active: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!active) {
      // A `setState` to the value it already holds is a bail-out in React, not a render.
      setOn(false);
      return;
    }
    const timer = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);

  return on;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/lib/useDelayedFlag.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing test for the provider**

Create `src/components/ActivityProvider.test.tsx`:

```tsx
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ActivityProvider,
  useRegisterActivity,
  useTopActivity,
} from "@/components/ActivityProvider";
import { RANK, type Activity } from "@/lib/activity";

const wrapper = ({ children }: { children: ReactNode }) => (
  <ActivityProvider>{children}</ActivityProvider>
);

const job = (over: Partial<Activity> = {}): Activity => ({
  key: "sync",
  rank: RANK.sync,
  label: "Syncing card data",
  detail: null,
  value: null,
  ...over,
});

describe("the activity registry, through React", () => {
  it("has nothing to say until something registers", () => {
    const { result } = renderHook(() => useTopActivity(), { wrapper });

    expect(result.current).toBeNull();
  });

  it("reports the registered job, and follows it as it moves", () => {
    const { result, rerender } = renderHook(
      ({ detail }: { detail: string | null }) => {
        useRegisterActivity(job({ label: "Importing cards", detail }));
        return useTopActivity();
      },
      { wrapper, initialProps: { detail: "1,000 cards" } },
    );

    expect(result.current?.detail).toBe("1,000 cards");

    rerender({ detail: "83,000 cards" });

    expect(result.current?.detail).toBe("83,000 cards");
  });

  /**
   * The reason registration is declarative rather than a `begin()`/`end()` pair: an early
   * return, a thrown render, an unmount mid-job, and an imperative registry would claim
   * forever that something was running.
   */
  it("drops the job when the component describing it goes away", () => {
    const { result, rerender } = renderHook(
      ({ running }: { running: boolean }) => {
        useRegisterActivity(running ? job() : null);
        return useTopActivity();
      },
      { wrapper, initialProps: { running: true } },
    );

    expect(result.current).not.toBeNull();

    rerender({ running: false });

    expect(result.current).toBeNull();
  });

  it("ranks two live jobs and hands back the loud one", () => {
    const { result } = renderHook(
      () => {
        useRegisterActivity(job({ key: "update-download", rank: RANK.update, label: "Downloading update 0.3.0" }));
        useRegisterActivity(job({ label: "Importing cards" }));
        return useTopActivity();
      },
      { wrapper },
    );

    expect(result.current?.label).toBe("Importing cards");
  });

  /** Consumers outside a provider are a wiring mistake, and a silent `null` would look
   *  exactly like "nothing is running". */
  it("refuses to answer outside a provider", () => {
    expect(() => renderHook(() => useTopActivity())).toThrow(/ActivityProvider/);
  });
});
```

- [ ] **Step 6: Run and watch it fail**

Run: `npx vitest run src/components/ActivityProvider.test.tsx`
Expected: FAIL — `Failed to resolve import "@/components/ActivityProvider"`.

- [ ] **Step 7: Write the provider**

Create `src/components/ActivityProvider.tsx`:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { createActivityStore, topActivity, type Activity, type ActivityState } from "@/lib/activity";

const ActivityContext = createContext<StoreApi<ActivityState> | null>(null);

/**
 * Holds the app's activity registry, above everything that writes to it or reads it.
 *
 * At the top of `AppShell`, which is above both of today's writers *and* above the view —
 * so a job started from inside a view registers with no rewiring. The store is created once
 * per provider and never re-created; the provider itself never re-renders when a job moves,
 * because the state is in the store rather than in its own `useState`.
 */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createActivityStore);
  return <ActivityContext.Provider value={store}>{children}</ActivityContext.Provider>;
}

function useActivityStore(): StoreApi<ActivityState> {
  const store = useContext(ActivityContext);
  // A silent `null` here would be indistinguishable from "nothing is running", which is the
  // one wiring mistake this could make and the hardest one to notice.
  if (!store) throw new Error("useTopActivity/useRegisterActivity need an <ActivityProvider>");
  return store;
}

/**
 * Describe a long job for as long as it is running, and stop describing it when it is not.
 *
 * Declarative rather than a `begin()`/`end()` pair, and that is the whole design: pass the
 * job (or `null`) on every render and the registry cannot outlive the component that owns
 * it. The two effects are deliberately separate — see below.
 */
export function useRegisterActivity(job: Activity | null): void {
  const store = useActivityStore();
  const key = job?.key ?? null;

  // Every render, with no dependency array. The adapters build a fresh object each time, and
  // `put` is identity-in-identity-out when nothing moved, so this costs one shallow compare
  // and saves every call site a `useMemo` it could forget a dependency of.
  useEffect(() => {
    if (job !== null) store.getState().put(job);
  });

  // Removal is keyed and therefore rare: dropping and re-adding on every progress event
  // would blink the top job to null fifty-eight times an ingest, and the ribbon's delay
  // would re-arm on every blink. This runs only when the job ends or its key changes.
  useEffect(() => {
    if (key === null) return;
    return () => store.getState().drop(key);
  }, [store, key]);
}

/**
 * The job the ribbon is describing, or `null` when the app is idle.
 *
 * The selector returns an element of the store's array rather than a new object, so a
 * subscriber re-renders when the top job actually moves and not merely when the store is
 * written to.
 */
export function useTopActivity(): Activity | null {
  const store = useActivityStore();
  return useStore(store, (s) => topActivity(s.jobs));
}
```

- [ ] **Step 8: Run and watch it pass**

Run: `npx vitest run src/components/ActivityProvider.test.tsx`
Expected: PASS, 5 tests. (The last one logs a React error boundary warning — that is the
throw being caught, not a failure.)

- [ ] **Step 9: Commit**

```bash
git add src/lib/useDelayedFlag.ts src/lib/useDelayedFlag.test.ts src/components/ActivityProvider.tsx src/components/ActivityProvider.test.tsx
git commit -m "feat(activity): a provider, a registration hook, and the appearance delay"
```

---

## Task 4: The ribbon says it

The visible change. `Ribbon` takes the job instead of the mana line's slice of it, and the
status line becomes one permanently mounted live region. `AppShell`'s call site is updated
in the same task because a component and its only consumer cannot be committed apart —
its gate is `busy` for now, and Task 5 replaces that with the registry and the delay.

**Files:**
- Modify: `src/components/Ribbon.tsx`
- Modify: `src/components/Ribbon.test.tsx`
- Modify: `src/components/Ribbon.stories.tsx`
- Modify: `src/components/ManaLine.stories.tsx` — two prose references
- Modify: `src/components/AppShell.tsx:113-126` — the call site

**Interfaces:**
- Consumes: `Activity` (Task 1), `syncActivity` (Task 2).
- Produces: `RibbonProps` with `activity: Activity | null` and `activityVisible: boolean`
  in place of `sync: ManaLineSync | null`.

- [ ] **Step 1: Write the failing tests**

In `src/components/Ribbon.test.tsx`, replace `sync: null` in the `props` factory with:

```ts
  activity: null,
  activityVisible: false,
```

Replace the existing `it("hands the sync to the mana line", …)` test with this block, and
add the two new ones:

```tsx
const importing: Activity = {
  key: "sync",
  rank: 0,
  label: "Importing cards",
  detail: "83,000 cards",
  value: 0.5,
};

it("hands the sync to the mana line, whether or not the row has room to say so", () => {
  render(<Ribbon {...props({ busy: true, activity: importing })} />);

  // The line reacts to the job immediately; only the sentence waits.
  expect(screen.getByRole("progressbar", { name: "Importing cards" })).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
});

/**
 * The whole feature: for ninety seconds the row used to go on reading "116,568 cards", which
 * is the one sentence least about what is happening.
 */
it("says what the app is doing, and gives the summary back when it stops", () => {
  const { rerender } = render(
    <Ribbon {...props({ busy: true, activity: importing, activityVisible: true })} />,
  );

  expect(screen.getByRole("status")).toHaveTextContent("Importing cards · 83,000 cards");
  expect(screen.queryByText(/116,568 cards/)).not.toBeInTheDocument();

  rerender(<Ribbon {...props()} />);

  expect(screen.getByRole("status")).toHaveTextContent("116,568 cards · data from 2026-08-03");
});

/**
 * A live region announces its accessible text, and skips `aria-hidden` subtrees. The label
 * changes about four times in a sync and is worth hearing; the number changes fifty-eight
 * times during the ingest alone, and the mana line's `aria-valuenow` already carries it.
 */
it("announces the phase and not the number", () => {
  render(<Ribbon {...props({ busy: true, activity: importing, activityVisible: true })} />);

  expect(screen.getByText(/83,000 cards/, { selector: "span" })).toHaveAttribute(
    "aria-hidden",
    "true",
  );
});

/**
 * A live region that first appears with its sentence already inside it announces nothing —
 * the lesson the sidebar's drop report and the card pane's swap report both cost. So the
 * line is mounted from the start and is merely empty.
 */
it("keeps the status line mounted before it has anything to say", () => {
  render(<Ribbon {...props({ statusLine: null })} />);

  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});
```

Add `import type { Activity } from "@/lib/activity";` to the file's imports.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components/Ribbon.test.tsx`
Expected: FAIL — TypeScript rejects `activity`/`activityVisible`, and `getByRole("status")`
finds nothing.

- [ ] **Step 3: Change the ribbon**

In `src/components/Ribbon.tsx`, replace the `sync` prop in `RibbonProps`:

```ts
  /**
   * The long job the app is running, or `null` when it is idle. Drives the mana line, and —
   * once {@link RibbonProps.activityVisible} — the status line too.
   */
  activity: Activity | null;
  /**
   * Whether the job has been running long enough to be worth a sentence.
   *
   * A separate flag rather than a second, delayed copy of the job: two props carrying the
   * same thing at two different times are two props that can disagree. `AppShell` owns the
   * threshold (`ACTIVITY_DELAY_MS`), because the 2px line must react instantly while a
   * sentence nobody can finish reading is worse than no sentence at all.
   */
  activityVisible: boolean;
```

Update the destructuring and the body:

```tsx
export function Ribbon({
  title,
  statusLine,
  dataDir,
  imageStoreFailures = 0,
  busy,
  upToDate,
  hasError,
  onRefresh,
  activity,
  activityVisible,
  updateVersion = null,
  updateInstallable = false,
  onOpenUpdate,
}: RibbonProps) {
```

Replace the `{statusLine && (…)}` block with:

```tsx
          {/* One line, mounted for the life of the ribbon, saying either what the app is
              doing or what is in the database.

              **Mounted even when empty**, because it is a live region and a live region that
              first appears with its sentence already inside it announces nothing — the same
              lesson as the sidebar's drop report. Empty, `sr-only` takes it out of the flex
              row so the gap between Refresh and its neighbour does not grow by a phantom
              element. */}
          <p
            role="status"
            className={cn(
              said ? "min-w-0 truncate text-xs text-dim" : "sr-only",
            )}
            title={tooltip}
          >
            {said}
            {/* Hidden from the announcement, not from the eye: the label changes about four
                times in a sync and the number changes fifty-eight times during the ingest
                alone. The mana line's `aria-valuenow` is where that fraction belongs.
                Geist Mono because the direction's third type role is data, and a count that
                reflows its own width every 200 ms is exactly what it is for. */}
            {showActivity && activity.detail && (
              <span aria-hidden="true" className="font-mono tabular-nums">
                {" · "}
                {activity.detail}
              </span>
            )}
          </p>
```

and compute the two locals just above the `return`, under the existing `tooltip`:

```tsx
  // The job takes the row while it is running; the corpus summary is a static fact about a
  // database and comes straight back when it stops.
  const showActivity = activityVisible && activity !== null;
  const said = showActivity ? activity.label : statusLine;
```

TypeScript narrows `activity` through `showActivity` only if it is a `const` in the same
scope — it is. Finally, hand the job to the line:

```tsx
      <ManaLine sync={activity} />
```

Add `import type { Activity } from "@/lib/activity";` to the imports; `ManaLineSync` is no
longer imported here.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/components/Ribbon.test.tsx`
Expected: PASS. The two pre-existing tooltip tests still pass — the `title` is on the same
element, which now also happens to be the live region.

- [ ] **Step 5: Update the call site so the app compiles**

In `src/components/AppShell.tsx`, replace the `sync={…}` prop:

```tsx
          activity={syncActivity(progress, busy)}
          activityVisible={busy}
```

Run: `npx vitest run` — expected PASS (the AppShell suite included; `busy` as the gate means
the sentence appears immediately, which no existing test asserts either way).

- [ ] **Step 6: Story the new states**

In `src/components/Ribbon.stories.tsx`, replace `sync: null` in `meta.args` with
`activity: null, activityVisible: false`, then replace the `Syncing` story and add three
more after it:

```tsx
/**
 * A sync in flight, reported three ways and animated once.
 *
 * The icon does **not** spin: the mana line two pixels below is the app's one sync animation.
 * The button says it instead by going disabled, and by `aria-busy` — which is the half of that
 * pair no screenshot shows, and the half a screen reader gets.
 *
 * The status line stops reporting the corpus and starts reporting the work. `value: 0.5` with
 * "Importing cards" is the ingest at half way, which is the phase a sync spends most of its
 * ~93 s in (CLAUDE.md, measured 2026-08-06).
 */
export const Syncing: Story = {
  args: {
    busy: true,
    activity: {
      key: "sync",
      rank: RANK.sync,
      label: "Importing cards",
      detail: "83,000 cards",
      value: 0.5,
    },
    activityVisible: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const refresh = canvas.getByRole("button", { name: "Refresh data" });
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(canvas.getByRole("status")).toHaveTextContent("Importing cards · 83,000 cards");
    // The line is named after the phase — an unnamed progress bar is announced as an anonymous
    // percentage, and the phase is the only thing that says what is being measured.
    await expect(canvas.getByRole("progressbar", { name: "Importing cards" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
  },
};

/**
 * The download, in the one unit a 77 MB file is worth reporting in.
 *
 * Whole megabytes: a tenth of a megabyte reflowing twice a second is motion without
 * information. The number is Geist Mono and `aria-hidden` — the label is what gets announced,
 * because it changes about four times in a sync while this changes constantly, and the mana
 * line's `aria-valuenow` already carries the fraction.
 */
export const Downloading: Story = {
  args: {
    busy: true,
    activity: {
      key: "sync",
      rank: RANK.sync,
      label: "Downloading card data",
      detail: "45 / 77 MB",
      value: 0.58,
    },
    activityVisible: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/45 \/ 77 MB/, { selector: "span" })).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  },
};

/**
 * The first second of a Refresh: the bar is up, the sentence is not.
 *
 * `checking` is over in under a second and a Refresh that finds nothing new is over in ~1.8 s,
 * so `AppShell` holds the text back by `ACTIVITY_DELAY_MS` while the line reacts immediately.
 * This is that gap, which is a state a reader really does see on most Refreshes — and the row
 * goes on showing the corpus summary rather than blanking.
 */
export const StartingUp: Story = {
  args: {
    busy: true,
    activity: {
      key: "sync",
      rank: RANK.sync,
      label: "Checking for card data updates",
      detail: null,
      value: null,
    },
    activityVisible: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(IDLE_LINE);
    // The line is already moving, under the name of the phase nobody has been told about yet.
    await expect(
      canvas.getByRole("progressbar", { name: "Checking for card data updates" }),
    ).toBeInTheDocument();
  },
};

/**
 * The app's other long job, in the same row.
 *
 * The registry is what makes this the same code path as a sync: `updateActivity` produces an
 * `Activity` and the ribbon does not know or care which feature made it. Refresh stays
 * **enabled** — a download says nothing about the card data, and the two really can overlap,
 * which is why activities carry a rank at all.
 */
export const UpdateDownloading: Story = {
  args: {
    activity: {
      key: "update-download",
      rank: RANK.update,
      label: "Downloading update 0.3.0",
      detail: "12 / 40 MB",
      value: 0.3,
    },
    activityVisible: true,
    updateVersion: "0.3.0",
    updateInstallable: true,
    onOpenUpdate: fn(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent("Downloading update 0.3.0");
    await expect(canvas.getByRole("button", { name: "Refresh data" })).toBeEnabled();
  },
};
```

Add `import { RANK } from "@/lib/activity";` to the story file's imports.

- [ ] **Step 7: Fix the two prose references in `ManaLine.stories.tsx`**

`manaLineSync` no longer exists. In the component description (line ~17) and in
`BeforeAnyEvent`'s doc (line ~63), change `manaLineSync` to `syncActivity`.

- [ ] **Step 8: Run the suite and the story runner**

Run: `npx vitest run`
Expected: PASS, including `src/stories.test.tsx`, which plays every new story.

- [ ] **Step 9: Commit**

```bash
git add src/components/Ribbon.tsx src/components/Ribbon.test.tsx src/components/Ribbon.stories.tsx src/components/ManaLine.stories.tsx src/components/AppShell.tsx
git commit -m "feat(ribbon): say what the app is doing while the mana line fills"
```

---

## Task 5: `AppShell` wires the registry

Replace the direct call and the `busy` gate with the real thing: a provider, both adapters
registered, and the 400 ms delay.

**Files:**
- Modify: `src/components/AppShell.tsx`
- Modify: `src/components/AppShell.test.tsx`

**Interfaces:**
- Consumes: `ActivityProvider`, `useRegisterActivity`, `useTopActivity` (Task 3);
  `syncActivity`, `updateActivity`, `ACTIVITY_DELAY_MS` (Tasks 1–2); `useDelayedFlag`
  (Task 3).
- Produces: nothing new. `AppShell`'s own props are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `src/components/AppShell.test.tsx`, inside the `describe("the status line", …)`
block:

```tsx
  /**
   * The end-to-end claim: an event out of `sync.rs` becomes a sentence in the row. Every
   * piece of this has a unit test; this is the one test that proves they are connected.
   *
   * Real timers, not fake ones, because the assertion is about a 400 ms threshold and
   * `findByText` is already a polling wait. It costs the suite half a second.
   */
  it("says what the sync is doing, once it has been doing it for a moment", async () => {
    let emit: ((e: SyncProgressEvent) => void) | undefined;
    onSyncProgress.mockImplementation((cb: (e: SyncProgressEvent) => void) => {
      emit = cb;
      return Promise.resolve(() => {});
    });
    syncStatus.mockResolvedValue(status({ syncing: true }));

    render(<AppShell update={noUpdate}>{null}</AppShell>);
    await waitFor(() => expect(emit).toBeDefined());
    act(() => emit!({ phase: "ingesting", done: 83_000, total: 117_000, message: null }));

    // Not immediately: a sub-second phase must not flash a sentence at the reader, and the
    // corpus summary holds the row until the job has earned it.
    expect(screen.queryByText(/Importing cards/)).not.toBeInTheDocument();
    expect(screen.getByText(/116,568 cards/)).toBeInTheDocument();

    expect(await screen.findByText(/Importing cards · 83,000 cards/)).toBeInTheDocument();
  });

  /** The corpus summary is not lost while it is hidden — it comes straight back, because it
   *  is a static fact about a database rather than an answer to one click. */
  it("gives the summary back when the sync stops", async () => {
    let emit: ((e: SyncProgressEvent) => void) | undefined;
    onSyncProgress.mockImplementation((cb: (e: SyncProgressEvent) => void) => {
      emit = cb;
      return Promise.resolve(() => {});
    });
    syncStatus.mockResolvedValue(status({ syncing: true }));

    render(<AppShell update={noUpdate}>{null}</AppShell>);
    await waitFor(() => expect(emit).toBeDefined());
    act(() => emit!({ phase: "ingesting", done: 83_000, total: 117_000, message: null }));
    await screen.findByText(/Importing cards/);

    syncStatus.mockResolvedValue(status({ syncing: false }));

    expect(await screen.findByText("116,568 cards · data from 2026-08-03")).toBeInTheDocument();
  });
```

Add `SyncProgressEvent` to the type-only import from `@/lib/ipc` at the top of the file.

The second test relies on the status poll's 1 s syncing cadence and `findByText`'s default
1 s timeout being too tight — pass a longer one if it is flaky:
`await screen.findByText("116,568 cards · data from 2026-08-03", {}, { timeout: 3000 })`.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components/AppShell.test.tsx`
Expected: FAIL on the first new test — the sentence appears immediately, because the gate is
still `busy`, so `queryByText(/Importing cards/)` finds it.

- [ ] **Step 3: Split the shell and register the jobs**

In `src/components/AppShell.tsx`, rename the exported component's body to an inner one and
wrap it:

```tsx
/**
 * The window: sidebar, ribbon, and whatever view the store points at.
 *
 * Owns the sync status because everything that needs it lives here — the ribbon's summary
 * line, Refresh button and mana line, and the first-run overlay — and one poll for the
 * whole app is the point of the arrangement.
 *
 * The provider is out here rather than inside, because a store read by the component that
 * creates it is a store nothing else can be mounted above. Here it covers both of today's
 * writers *and* `children`, so a long job started from inside a view registers with no
 * rewiring.
 */
export function AppShell({ children, update }: { children: ReactNode; update: Update }) {
  return (
    <ActivityProvider>
      <Shell update={update}>{children}</Shell>
    </ActivityProvider>
  );
}

function Shell({ children, update }: { children: ReactNode; update: Update }) {
```

…keeping the entire existing body of `AppShell` as `Shell`'s body. Then, just after
`const busy = refreshing || status?.syncing === true;`, add:

```tsx
  // The two long jobs this window can be running. Both are registered from here because both
  // are already owned here — the sync by this component and the update by `App`, which hands
  // it down — and the registry is what lets the ribbon describe either without knowing which.
  useRegisterActivity(syncActivity(progress, busy));
  useRegisterActivity(updateActivity(update.progress, update.status?.available?.version ?? null));
  const activity = useTopActivity();
  // The line moves the moment a job starts; the sentence waits, so a sub-second `checking`
  // phase never flashes words the reader cannot finish. It gates the slot rather than one
  // job, so a sync handing over to a download swaps the sentence without the row blinking.
  const activityVisible = useDelayedFlag(activity !== null, ACTIVITY_DELAY_MS);
```

and pass them down:

```tsx
          activity={activity}
          activityVisible={activityVisible}
```

Imports to add:

```ts
import {
  ActivityProvider,
  useRegisterActivity,
  useTopActivity,
} from "@/components/ActivityProvider";
import { ACTIVITY_DELAY_MS, syncActivity, updateActivity } from "@/lib/activity";
import { useDelayedFlag } from "@/lib/useDelayedFlag";
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/components/AppShell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run everything**

Run: `npx vitest run`
Expected: PASS. `App.test.tsx` renders the real `App` and therefore the real provider; if
anything throws `need an <ActivityProvider>`, a consumer is mounted above it.

- [ ] **Step 6: Commit**

```bash
git add src/components/AppShell.tsx src/components/AppShell.test.tsx
git commit -m "feat(ribbon): drive the activity line from the registry"
```

---

## Task 6: Verify in the real window, and write down what was learned

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-08-11-ribbon-activity-line-design.md` (status line only)

- [ ] **Step 1: Full verification**

Run: `npm run verify`
Expected: build + lint + Vitest + `cargo test` all green. Nothing in this plan touches Rust,
so the `cargo` half should be untouched; `tsc -p .storybook` runs as part of the build and
type-checks the fake against `ipc.ts`.

- [ ] **Step 2: Build and launch the real window**

Per `docs`/CLAUDE.md's "Verifying UI in the real app", and the worktree fast path:

```powershell
Get-Process mtg-grimoire -ErrorAction SilentlyContinue | Stop-Process
npm run tauri build -- --debug --no-bundle
# ~547 MB, seconds, against a ~93 s sync:
Copy-Item D:\Code\mtg-grimoire\src-tauri\target\debug\data\mtg.db .\src-tauri\target\debug\data\
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
Start-Process .\src-tauri\target\debug\mtg-grimoire.exe
```

A second instance exits silently with code 0 (`tauri-plugin-single-instance`), so check
`Get-Process mtg-grimoire` before launching.

- [ ] **Step 3: Drive it**

Start the console recorder first (`node scripts/cdp.mjs console out.jsonl`), then in another
shell:

1. `node scripts/cdp.mjs click "button[aria-label*='Refresh'], button:has-text" ` — use
   `node scripts/cdp.mjs text "Refresh data"` to press it by its visible text.
2. Immediately: `node scripts/cdp.mjs eval "document.querySelector('[role=status]').textContent"`
   — expect the corpus summary, **not** a phase, for the first 400 ms.
3. Then poll it: expect `Checking for card data updates`, and — if the day's bulk file has
   rotated — `Downloading card data · N / 77 MB` and `Importing cards · N cards`.
   **Take the ingest the day offers**; do not reset `sync_meta` to force one, because a
   hand-written `sync_meta` makes every later measurement a fiction.
4. Width: `node scripts/cdp.mjs size 1024 768 "..."` with a probe reading the ribbon row's
   `scrollWidth` vs `clientWidth`, mid-sync, to prove the longest sentence
   (`Downloading update 0.3.0 · 12 / 40 MB` beside the update button) does not push the row
   sideways. Read `innerWidth`/`innerHeight` **before** the first override and end the run
   with an explicit `size 1280 800` — `clearDeviceMetricsOverride` restores nothing.
5. `node scripts/cdp.mjs shot ribbon-activity.png` mid-sync, and look at it.

Check the recorder's line count afterwards: a recorder dies with the window it is attached
to and says nothing about it.

- [ ] **Step 4: Record what the pass measured**

Add to `CLAUDE.md`'s **Frontend design (binding)** section, adjusting any figure the live
pass contradicts:

```markdown
- **The ribbon says what the app is doing, and it is a registry rather than a sync.** A long
  job registers an `Activity` (`src/lib/activity.ts`) — key, rank, label, `detail`, value —
  through `useRegisterActivity`, and the lowest rank wins the row (`RANK.sync` 0 beats
  `RANK.update` 10; ties break by insertion order). The store is created per
  `ActivityProvider`, at the top of `AppShell` and above `children`, so a job started inside
  a view needs no wiring — and so it never becomes a second `useAppStore`, the one global
  Storybook cannot make per-story. Registration is **declarative**: pass the job or `null`
  every render, and a job cannot outlive the component describing it.
- **The mana line reacts instantly and the sentence waits `ACTIVITY_DELAY_MS` (400 ms).**
  `checking` is over in under a second and a no-op Refresh in ~1.8 s, so an ungated line
  flashes words nobody can finish reading. The gate is on the *slot*, not the job, so a sync
  handing over to an update download swaps the sentence without the row blinking.
- **The status line is one permanently mounted `role="status"`, and the number inside it is
  `aria-hidden`.** Mounted because a live region that first appears with its sentence already
  inside announces nothing (the sidebar's drop report's lesson). The number is hidden because
  a live region announces its accessible text: the label changes ~4 times a sync, the ingest's
  count changes ~58 times, and the mana line's `aria-valuenow` is where a fraction belongs.
```

Also change the spec's header from `**Status:** approved, not yet implemented` to
`**Status:** implemented 2026-08-11`.

- [ ] **Step 5: Clean up and commit**

Delete anything the pass wrote into `src-tauri/target/debug/data/` beyond the copied
database — `data/` is the user's and is never committed. Confirm with `git status`.

```bash
git add CLAUDE.md docs/superpowers/specs/2026-08-11-ribbon-activity-line-design.md
git commit -m "docs: record the ribbon activity registry's rules"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/ribbon-activity-line
gh pr create --title "feat(ribbon): say what the app is doing while it loads" --body "..."
```

The body should say what changed, what the live pass measured, and that CI's `frontend` job
is the gate (`ci-ok` is the one protected check; this change touches `src/**` only, so the
`rust` matrix is skipped by the `changes` router — which is expected, not a broken run).

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 the registry, `Activity`, ranks, per-provider store | 1, 3 |
| §1 declarative registration, `useTopActivity` tie-break | 1, 3 |
| §2 `syncActivity` incl. the detail table and the ingest's missing denominator | 2 |
| §2 `updateActivity`, in-flight only | 2 |
| §2 `SyncProgress` shares the formatter | 2, step 6 |
| §3 `activity` + `activityVisible` props, slot replacement | 4 |
| §3 the 400 ms gate on the slot | 3 (hook), 5 (wiring) |
| §3 permanently mounted live region, `aria-hidden` detail | 4 |
| §4 errors: nothing new, terminal phases stay indeterminate | 2 (test) |
| §5 unit, component, integration, story and CDP coverage | 1–6 |
| §6 out of scope | untouched by every task |

**Placeholder scan:** the only `"..."` is the `gh pr create --body`, which is prose the
implementer writes from the finished diff, and the CDP probe expression in Task 6 step 4,
which depends on what the window reports at the time. Both are marked as such.

**Type consistency:** `Activity` (`key`, `rank`, `label`, `detail`, `value`) is used with the
same five field names in Tasks 1–5. `RANK.sync`/`RANK.update` throughout. `put`/`drop`/`jobs`
match between `ActivityState`, the store, and `useRegisterActivity`. `megabytes(done, total)`
has one signature and three call sites (`syncActivity`, `updateActivity`, `SyncProgress`).
`syncActivity(progress, busy)` and `updateActivity(progress, version)` are called exactly as
declared. `activity`/`activityVisible` are the same two names in `RibbonProps`, the tests, the
stories and `AppShell`.
