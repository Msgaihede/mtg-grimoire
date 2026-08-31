import { describe, expect, it } from "vitest";
import {
  ACTIVITY_DELAY_MS,
  RANK,
  createActivityStore,
  megabytes,
  oracleTagActivity,
  syncActivity,
  topActivity,
  updateActivity,
  type Activity,
} from "@/lib/activity";
import type { OracleTagProgressEvent, SyncProgressEvent } from "@/lib/ipc";

const job = (over: Partial<Activity> = {}): Activity => ({
  key: "sync",
  rank: RANK.sync,
  label: "Syncing card data",
  detail: null,
  value: null,
  ...over,
});

const event = (over: Partial<SyncProgressEvent> = {}): SyncProgressEvent => ({
  phase: "ingesting",
  done: 0,
  total: 0,
  message: null,
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
    expect(syncActivity(null, true)).toMatchObject({
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

describe("oracleTagActivity", () => {
  const tags = (over: Partial<OracleTagProgressEvent> = {}): OracleTagProgressEvent => ({
    phase: "downloading",
    done: 0,
    total: 0,
    ...over,
  });

  /**
   * `refreshing` decides, not the event — `syncActivity`'s rule, and the case for it is
   * strongest here. `refresh_if_due` is spawned at launch, so the ordinary refresh starts
   * before this window has a listener and Tauri drops what it emitted first; and a run that is
   * not due answers without emitting anything at all.
   */
  it("is null when nothing is running, whatever event is still in hand", () => {
    expect(oracleTagActivity(false, null)).toBeNull();
    expect(oracleTagActivity(false, tags({ done: 5, total: 10 }))).toBeNull();
  });

  /** The state a window that mounted mid-refresh is in: the status says so and no event has
   *  arrived, because the ones that would have said which phase were dropped. */
  it("is the generic sentence, indeterminate, before any event arrives", () => {
    expect(oracleTagActivity(true, null)).toMatchObject({
      key: "oracle-tags",
      rank: RANK.oracleTags,
      label: "Updating card tags",
      detail: null,
      value: null,
    });
  });

  it("counts the download in whole megabytes", () => {
    const activity = oracleTagActivity(true, tags({ done: 2_900_000, total: 5_850_000 }));

    expect(activity?.label).toBe("Downloading card tags");
    expect(activity?.detail).toBe("3 / 6 MB");
    expect(activity?.value).toBeCloseTo(0.496, 2);
  });

  /**
   * **The ingest counts nothing, and that is the backend's doing rather than a choice here**:
   * `refresh` hands `ingest_gz` a `&mut |_| {}` and emits `("ingesting", 0, 0)` exactly once.
   * So the phase has a sentence and an indeterminate bar, and inventing a figure for it would
   * be storying a number the app cannot produce.
   */
  it("names the ingest and the check without a number for either", () => {
    for (const phase of ["checking", "ingesting"] as const) {
      const activity = oracleTagActivity(true, tags({ phase }));
      expect(activity?.label).toBe(
        phase === "checking" ? "Checking for card tag updates" : "Importing card tags",
      );
      expect(activity?.detail).toBeNull();
      expect(activity?.value).toBeNull();
    }
  });

  /** Their event can outlive the run by a status read, so neither may read as finished — and
   *  the ribbon is not where a failed refresh is reported. */
  it("treats a finished or failed refresh as running with nothing to say", () => {
    for (const phase of ["done", "error"] as const) {
      const activity = oracleTagActivity(true, tags({ phase, done: 9, total: 9 }));
      expect(activity?.label).toBe("Updating card tags");
      expect(activity?.detail).toBeNull();
      expect(activity?.value).toBeNull();
    }
  });

  /**
   * The quietest job there is: it is the only one whose failure costs the reader nothing, since
   * every add still files by card type. So it yields the row to all three of the others.
   */
  it("is outranked by every other job", () => {
    const oracleTags = oracleTagActivity(true, null)!;
    const sync = syncActivity(null, true)!;
    const update = updateActivity({ done: 1, total: 2 }, "0.3.0")!;

    expect(topActivity([oracleTags, sync])).toBe(sync);
    expect(topActivity([oracleTags, update])).toBe(update);
    expect(RANK.oracleTags).toBeGreaterThan(RANK.marketplaceFeed);
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
