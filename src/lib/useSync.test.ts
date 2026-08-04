import { describe, expect, it } from "vitest";
import type { SyncStatus } from "@/lib/ipc";
import { mergeStatus, statusLine } from "@/lib/useSync";

const idle: SyncStatus = {
  cardCount: 116_568,
  lastCheckAt: "1800000000",
  bulkUpdatedAt: "2026-08-03T21:16:27.869+00:00",
  lastError: "rate limited by Scryfall",
  dataDir: "D:\\app\\data",
  syncing: false,
};

/** The whole point of `SyncStatus` having four nullable fields (see `sync::status`). */
describe("mergeStatus", () => {
  it("keeps the last known figures when the database was unreadable", () => {
    const busy: SyncStatus = {
      cardCount: null,
      lastCheckAt: null,
      bulkUpdatedAt: null,
      lastError: null,
      dataDir: "D:\\app\\data",
      syncing: true,
    };

    const merged = mergeStatus(idle, busy);

    expect(merged.cardCount).toBe(116_568);
    expect(merged.bulkUpdatedAt).toBe("2026-08-03T21:16:27.869+00:00");
    expect(merged.lastCheckAt).toBe("1800000000");
    // A `null` here means "could not read", so an error banner the user has not
    // acknowledged must not vanish for the length of an ingest.
    expect(merged.lastError).toBe("rate limited by Scryfall");
  });

  it("always takes syncing and dataDir from the fresh poll", () => {
    const busy: SyncStatus = { ...idle, cardCount: null, syncing: true, dataDir: "C:\\other" };

    const merged = mergeStatus(idle, busy);

    expect(merged.syncing).toBe(true);
    expect(merged.dataDir).toBe("C:\\other");
  });

  /**
   * `card_count` is `Some(..)` for every poll that got the lock, so a non-null count is
   * the signal that the other three were read too — and a `null` alongside it is a real
   * absence. A successful run clears `last_error`, and that clearance has to land.
   */
  it("accepts a cleared error once the database is readable again", () => {
    const cleared: SyncStatus = { ...idle, lastError: null, cardCount: 116_600 };

    const merged = mergeStatus(idle, cleared);

    expect(merged.lastError).toBeNull();
    expect(merged.cardCount).toBe(116_600);
  });

  it("takes the first poll as-is", () => {
    expect(mergeStatus(null, idle)).toEqual(idle);
  });
});

describe("statusLine", () => {
  it("reads as a count and a date", () => {
    expect(statusLine(idle)).toBe("116,568 cards · data from 2026-08-03");
  });

  it("says so when the database is empty rather than printing a zero", () => {
    expect(statusLine({ ...idle, cardCount: 0, bulkUpdatedAt: null })).toBe("No card data yet");
  });

  it("drops the date when Scryfall never supplied one", () => {
    expect(statusLine({ ...idle, bulkUpdatedAt: null })).toBe("116,568 cards");
  });

  it("ignores a timestamp that is not a date", () => {
    expect(statusLine({ ...idle, bulkUpdatedAt: "soon" })).toBe("116,568 cards");
  });

  it("has nothing to say before the first poll answers", () => {
    expect(statusLine(null)).toBeNull();
  });
});
