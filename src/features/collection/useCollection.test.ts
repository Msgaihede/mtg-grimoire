import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { CollectionPage, CollectionQuery } from "@/lib/ipc";

const collectionList = vi.hoisted(() => vi.fn());
const collectionSummary = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { collectionList, collectionSummary },
}));

import { activeFilterCount, nextOffset, useCollection } from "./useCollection";

const NONE = {
  text: "",
  format: "",
  colors: [],
  sets: [],
  manaValues: [],
  finishes: [],
  conditions: [],
  needsReview: undefined,
};

describe("activeFilterCount", () => {
  it("is zero when nothing is filtered", () => {
    expect(activeFilterCount(NONE)).toBe(0);
  });

  /**
   * Kinds, not values — the badge on Reset all tells the reader how much is about to
   * change, and "two finishes" is one thing that is on.
   */
  it("counts each kind of filter once", () => {
    expect(activeFilterCount({ ...NONE, finishes: ["foil", "etched"] })).toBe(1);
    expect(activeFilterCount({ ...NONE, conditions: ["NM", "LP"] })).toBe(1);
    expect(activeFilterCount({ ...NONE, needsReview: true })).toBe(1);
    // `false` — "the rows nothing flagged" — is a filter too, and is where the reader lands
    // once the flagged ones are dealt with. Compared against `undefined`, never tested for
    // truthiness, which is the whole difference between a tri-state and a checkbox.
    expect(activeFilterCount({ ...NONE, needsReview: false })).toBe(1);
  });

  /** Whitespace is not a search. */
  it("ignores a blank search box", () => {
    expect(activeFilterCount({ ...NONE, text: "   " })).toBe(0);
  });

  /**
   * The collection's row is longer than the search's by three: what the copy is (finish),
   * what state it is in (condition), and whether it is one of the rows a sync flagged.
   * Reset all has to reach every one of them, so the count has to see every one of them.
   */
  it("sees all eight kinds the collection offers", () => {
    expect(
      activeFilterCount({
        text: "bolt",
        format: "modern",
        colors: ["R"],
        sets: ["lea"],
        manaValues: [1],
        finishes: ["foil"],
        conditions: ["NM"],
        needsReview: true,
      }),
    ).toBe(8);
  });
});

const page = (items: number, total: number): CollectionPage => ({
  items: Array.from({ length: items }, (_, i) => ({ id: i }) as never),
  total,
});

describe("nextOffset", () => {
  it("asks for the next page at the number of rows already seen", () => {
    expect(nextOffset([page(100, 250)])).toBe(100);
    expect(nextOffset([page(100, 250), page(100, 250)])).toBe(200);
  });

  it("stops once the whole collection is loaded", () => {
    expect(nextOffset([page(100, 100)])).toBeUndefined();
    expect(nextOffset([page(100, 150), page(50, 150)])).toBeUndefined();
  });

  /** `total` and the rows can disagree while a write lands between two pages; a short page
   *  is the end of the data whatever the count says. */
  it("stops on a short page even when the total disagrees", () => {
    expect(nextOffset([page(0, 9999)])).toBeUndefined();
  });
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

const lastQuery = () =>
  collectionList.mock.calls[collectionList.mock.calls.length - 1][0] as CollectionQuery;

describe("useCollection", () => {
  beforeEach(() => {
    collectionList.mockReset().mockResolvedValue({ items: [], total: 0 });
    collectionSummary.mockReset().mockResolvedValue({
      totalCards: 0,
      uniqueCards: 0,
      entries: 0,
      tradelistCards: 0,
      valueUsd: 0,
      valueEur: 0,
      unpricedUsd: 0,
      unpricedEur: 0,
      needsReview: 0,
    });
  });

  it("clears all eight filters at once", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => {
      result.current.setText("bolt");
      result.current.setFormat("modern");
      result.current.toggleColor("R");
      result.current.toggleSet("lea");
      result.current.toggleManaValue(1);
      result.current.toggleFinish("foil");
      result.current.toggleCondition("NM");
      result.current.toggleNeedsReview();
    });

    expect(result.current.activeCount).toBe(8);

    act(() => result.current.resetAll());

    expect(result.current.activeCount).toBe(0);
    expect(result.current.finishes).toEqual([]);
    expect(result.current.conditions).toEqual([]);
    expect(result.current.needsReview).toBeUndefined();
    await waitFor(() => {
      const q = lastQuery();
      expect(q.text).toBeUndefined();
      expect(q.finishes).toBeUndefined();
      expect(q.conditions).toBeUndefined();
      expect(q.needsReview).toBeUndefined();
    });
  });

  /**
   * The chip the wishlist's twin already was. The backend has always taken three states
   * here — `collection::scope`'s `match` over `Option<bool>` — and the collection was the
   * one view that could only ask two of them, so "everything the sync did not touch" was a
   * question the reader could not put to the list they were looking at.
   *
   * `false` reaches the wire as `false`, which is the load-bearing half: dropping it the way
   * a blank string is dropped would silently turn the complement back into "ask nothing".
   */
  it("walks the needs-review filter through all three states", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(result.current.needsReview).toBeUndefined();

    act(() => result.current.toggleNeedsReview());
    expect(result.current.needsReview).toBe(true);
    await waitFor(() => expect(lastQuery().needsReview).toBe(true));

    act(() => result.current.toggleNeedsReview());
    expect(result.current.needsReview).toBe(false);
    await waitFor(() => expect(lastQuery().needsReview).toBe(false));

    act(() => result.current.toggleNeedsReview());
    expect(result.current.needsReview).toBeUndefined();
    await waitFor(() => expect(lastQuery().needsReview).toBeUndefined());
  });

  /** The two answered states are two different sets of rows, so they are two different
   *  requests — a key that spelled both `""` would serve the complement from the cache of
   *  the flagged rows. */
  it("keys the three needs-review states apart", () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    const off = result.current.queryKeyString;

    act(() => result.current.toggleNeedsReview());
    const flagged = result.current.queryKeyString;
    act(() => result.current.toggleNeedsReview());
    const clear = result.current.queryKeyString;

    expect(new Set([off, flagged, clear]).size).toBe(3);
  });

  /**
   * The key is the identity of the request. A new finish is a different set of rows and has
   * to cost a round trip; the *same* two finishes picked in the other order is the same set
   * of rows and must not, or every chip row would be a cache miss waiting to happen.
   */
  it("keys the query on which finishes are picked, not on the order they were picked in", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    const empty = result.current.queryKeyString;

    act(() => result.current.toggleFinish("foil"));
    const foil = result.current.queryKeyString;
    expect(foil).not.toBe(empty);

    act(() => result.current.toggleFinish("etched"));
    const both = result.current.queryKeyString;
    expect(both).not.toBe(foil);

    act(() => {
      result.current.toggleFinish("foil");
      result.current.toggleFinish("etched");
      result.current.toggleFinish("etched");
      result.current.toggleFinish("foil");
    });

    expect(result.current.finishes).toEqual(["etched", "foil"]);
    expect(result.current.queryKeyString).toBe(both);
  });

  /**
   * The summary is a statement about a *set* of rows, and an order is not part of a set —
   * so re-sorting the table must not re-run nine aggregates over the same rows.
   */
  it("re-sorts the list without re-asking what the collection adds up to", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionSummary).toHaveBeenCalledTimes(1));

    act(() => result.current.setSort("price"));

    await waitFor(() => expect(lastQuery().sort).toBe("price"));
    expect(collectionSummary).toHaveBeenCalledTimes(1);
  });
});
