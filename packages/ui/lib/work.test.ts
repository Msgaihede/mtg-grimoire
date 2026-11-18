import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RANK, workActivity } from "@/lib/activity";
import {
  ACTIVITY_DELAY_MS,
  WORK_MIN_SHOWN_MS,
  beginWork,
  busySentence,
  resetWork,
  trackWork,
  useWorkStore,
} from "./work";

const busy = () => useWorkStore.getState().busy;
const live = () => useWorkStore.getState().live;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetWork();
  vi.useRealTimers();
});

describe("beginWork", () => {
  it("shows nothing until the work has outlasted the delay", () => {
    beginWork("Selecting all cards…");
    expect(live()).toHaveLength(1);

    vi.advanceTimersByTime(ACTIVITY_DELAY_MS - 1);
    expect(busy()).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-busy");

    vi.advanceTimersByTime(1);
    expect(busy()).toEqual({ label: "Selecting all cards…", more: 0 });
    expect(document.documentElement).toHaveAttribute("data-busy");
  });

  it("never shows work that ends inside the delay", () => {
    const done = beginWork("Quick");
    vi.advanceTimersByTime(ACTIVITY_DELAY_MS - 50);
    done();
    vi.advanceTimersByTime(5_000);
    expect(busy()).toBeNull();
    expect(live()).toEqual([]);
  });

  it("stays up for the minimum time once shown, however soon the work ends", () => {
    const done = beginWork("Adding 300 cards…");
    vi.advanceTimersByTime(ACTIVITY_DELAY_MS + 30);
    done();

    // Ended, but held: the label stays, and nothing is live any more.
    expect(live()).toEqual([]);
    expect(busy()).toEqual({ label: "Adding 300 cards…", more: 0 });

    vi.advanceTimersByTime(WORK_MIN_SHOWN_MS - 30 - 1);
    expect(busy()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(busy()).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-busy");
  });

  it("goes down the moment the work ends when it was up longer than the minimum", () => {
    const done = beginWork("Long");
    vi.advanceTimersByTime(ACTIVITY_DELAY_MS + WORK_MIN_SHOWN_MS + 500);
    done();
    expect(busy()).toBeNull();
  });

  it("ends once, however many times it is told to", () => {
    const first = beginWork("First");
    beginWork("Second");
    first();
    first();
    expect(live().map((w) => w.label)).toEqual(["Second"]);
  });

  it("names the oldest shown piece and counts the others", () => {
    const a = beginWork("Adding 300 cards…");
    vi.advanceTimersByTime(100);
    beginWork("Selecting all cards…");
    vi.advanceTimersByTime(ACTIVITY_DELAY_MS - 100);
    // The second has not outlasted its own delay yet.
    expect(busy()).toEqual({ label: "Adding 300 cards…", more: 0 });

    vi.advanceTimersByTime(100);
    expect(busy()).toEqual({ label: "Adding 300 cards…", more: 1 });
    expect(busySentence(busy()!)).toBe("Adding 300 cards… and 1 more");

    a();
    expect(busy()).toEqual({ label: "Selecting all cards…", more: 0 });
  });
});

describe("trackWork", () => {
  it("resolves with the work's value and ends the work", async () => {
    const tracked = trackWork("Saving", Promise.resolve(42));
    expect(live()).toHaveLength(1);
    await expect(tracked).resolves.toBe(42);
    expect(live()).toEqual([]);
  });

  it("rejects with the work's reason and still ends the work", async () => {
    const tracked = trackWork("Saving", Promise.reject("refused"));
    await expect(tracked).rejects.toBe("refused");
    expect(live()).toEqual([]);
  });
});

describe("workActivity", () => {
  it("is the header's job while busy, indeterminate and above every background job", () => {
    expect(workActivity(null)).toBeNull();
    expect(workActivity({ label: "Adding…", more: 2 })).toEqual({
      key: "work",
      rank: RANK.work,
      label: "Adding… and 2 more",
      detail: null,
      value: null,
    });
    expect(Math.min(...Object.values(RANK))).toBe(RANK.work);
  });
});

describe("resetWork", () => {
  it("forgets live work and every timer", () => {
    beginWork("Left running");
    vi.advanceTimersByTime(ACTIVITY_DELAY_MS);
    expect(busy()).not.toBeNull();

    resetWork();
    expect(live()).toEqual([]);
    expect(busy()).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-busy");
    vi.advanceTimersByTime(5_000);
    expect(busy()).toBeNull();
  });
});
