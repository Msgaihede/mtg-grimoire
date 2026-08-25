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
  manaX: false,
  rarities: [],
  priceMin: undefined,
  priceMax: undefined,
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
    expect(activeFilterCount({ ...NONE, rarities: ["rare", "mythic"] })).toBe(1);
  });

  /**
   * The band is one kind however many of its two ends are set — `$5 – $20` is one control and
   * one thing to clear, so a reader who set both ends must not read `Reset all 2` over it.
   */
  it("counts a price band once, whichever ends of it are set", () => {
    expect(activeFilterCount({ ...NONE, priceMin: 5 })).toBe(1);
    expect(activeFilterCount({ ...NONE, priceMax: 20 })).toBe(1);
    expect(activeFilterCount({ ...NONE, priceMin: 5, priceMax: 20 })).toBe(1);
  });

  /** A floor of zero is a bound the reader typed, and `0` is falsy — so this is the case a
   *  truthiness test would drop, leaving Reset all dark over a list that really is banded. */
  it("counts a floor of zero", () => {
    expect(activeFilterCount({ ...NONE, priceMin: 0 })).toBe(1);
  });

  /** Whitespace is not a search. */
  it("ignores a blank search box", () => {
    expect(activeFilterCount({ ...NONE, text: "   " })).toBe(0);
  });

  /**
   * The collection's row is longer than the search's by three: what the copy is (finish),
   * what state it is in (condition), and whether it is one of the rows a sync flagged. Ten
   * kinds over twelve fields — the price band is one kind with two ends, and the X chip rides
   * with the mana values. Reset all has to reach every one of them, so the count has to see
   * every one of them.
   */
  it("sees all ten kinds the collection offers", () => {
    expect(
      activeFilterCount({
        text: "bolt",
        format: "modern",
        colors: ["R"],
        sets: ["lea"],
        manaValues: [1],
        manaX: true,
        rarities: ["rare"],
        priceMin: 5,
        priceMax: 20,
        finishes: ["foil"],
        conditions: ["NM"],
        needsReview: true,
      }),
    ).toBe(10);
  });

  /** X is the last chip of the mana-value group and is OR'd with the numerals, so it is that
   *  same kind — but an X-only filter still has to be seen, or Reset all would hide over a
   *  list that is filtered. */
  it("counts the X chip with the mana values it sits among", () => {
    expect(activeFilterCount({ ...NONE, manaX: true })).toBe(1);
    expect(activeFilterCount({ ...NONE, manaValues: [1], manaX: true })).toBe(1);
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
      value: 0,
      unpriced: 0,
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
      // The tenth chip of the mana-value group, cleared by the same press — and not a ninth
      // kind: it is counted with the numerals it sits among, so the badge still reads 8.
      result.current.toggleManaX();
      result.current.toggleFinish("foil");
      result.current.toggleCondition("NM");
      result.current.toggleNeedsReview();
    });

    expect(result.current.activeCount).toBe(8);

    act(() => result.current.resetAll());

    expect(result.current.activeCount).toBe(0);
    expect(result.current.finishes).toEqual([]);
    expect(result.current.conditions).toEqual([]);
    expect(result.current.manaX).toBe(false);
    expect(result.current.needsReview).toBeUndefined();
    await waitFor(() => {
      const q = lastQuery();
      expect(q.text).toBeUndefined();
      expect(q.finishes).toBeUndefined();
      expect(q.conditions).toBeUndefined();
      expect(q.manaX).toBeUndefined();
      expect(q.needsReview).toBeUndefined();
    });
  });

  /**
   * The X chip, end to end and without a facet in sight — this view wires no counts at all,
   * so the chip's whole job here is to reach the query and the key.
   *
   * The key is the half that can fail silently: "costs 1" and "costs 1, or has an X in its
   * cost" are two different sets of rows over the same local SQLite, so a key that could not
   * tell them apart would answer the second out of the first's cached pages instantly, with
   * nothing on screen to notice. A new request having gone out at all is therefore the
   * assertion, and the payload is read from that request rather than from a re-render.
   */
  it("sends the X chip and keys the query on it", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => result.current.toggleManaValue(1));
    await waitFor(() => expect(lastQuery().manaValues).toEqual([1]));
    const asked = collectionList.mock.calls.length;
    const key = result.current.queryKeyString;

    act(() => result.current.toggleManaX());

    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(asked));
    expect(result.current.queryKeyString).not.toBe(key);
    expect(lastQuery().manaX).toBe(true);
    // Additive: the numeral it was pressed beside is still on the wire, because `cmc` counts
    // `{X}` as zero and a `{X}` card answers both chips.
    expect(lastQuery().manaValues).toEqual([1]);

    // …and turning it back off is the same search again, by the same key. The key is a
    // function of the filters and of nothing else, so this is also what says the segment is
    // the chip's own rather than something that grows on every press.
    act(() => result.current.toggleManaX());

    expect(result.current.queryKeyString).toBe(key);
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

    act(() => result.current.setSortKey("price"));

    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "price", dir: "desc" }]));
    expect(collectionSummary).toHaveBeenCalledTimes(1);
  });
});
