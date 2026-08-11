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
