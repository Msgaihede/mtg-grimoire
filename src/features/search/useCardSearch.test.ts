import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FacetResponse, SearchRequest } from "@/lib/ipc";

const searchCards = vi.hoisted(() => vi.fn());
const facetCards = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { searchCards, facetCards },
}));

import {
  activeFilterCount,
  cycleTriState,
  toggleColor,
  toggleIn,
  useCardSearch,
} from "./useCardSearch";

describe("toggleIn", () => {
  it("adds what is missing and removes what is there", () => {
    expect(toggleIn([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggleIn([1, 2], 2)).toEqual([1]);
  });
});

describe("activeFilterCount", () => {
  const none = { text: "", format: "", colors: [], sets: [], manaValues: [], owned: undefined };

  it("is zero when nothing is filtered", () => {
    expect(activeFilterCount(none)).toBe(0);
  });

  /**
   * `false` is a filter — "the cards I do *not* have" — and a falsy check would count it as
   * nothing at all, leaving Reset all hidden over a search that is filtering hard.
   */
  it("counts an owned filter in either direction", () => {
    expect(activeFilterCount({ ...none, owned: true })).toBe(1);
    expect(activeFilterCount({ ...none, owned: false })).toBe(1);
  });

  /**
   * Each *kind* of filter counts once, however many values it holds: the badge tells the
   * reader how many things Reset all is about to clear, and "3" for three colours in one
   * chip row would be a different, less useful claim.
   */
  it("counts each kind of filter once", () => {
    expect(activeFilterCount({ ...none, colors: ["W", "U", "B"] })).toBe(1);
    expect(activeFilterCount({ ...none, sets: ["lea", "roe"] })).toBe(1);
    expect(activeFilterCount({ ...none, text: "bolt", format: "modern", manaValues: [1] })).toBe(3);
  });

  /** Whitespace is not a search. */
  it("ignores a blank search box", () => {
    expect(activeFilterCount({ ...none, text: "   " })).toBe(0);
  });
});

/**
 * One chip, three states — and which of the two *on* states comes first is the caller's,
 * because the useful first press is not the same question in both views. A search asks
 * "what have I already got"; a shopping list asks "what am I still missing".
 */
describe("cycleTriState", () => {
  it("goes off → the caller's question → its opposite → off", () => {
    expect(cycleTriState(undefined, true)).toBe(true);
    expect(cycleTriState(true, true)).toBe(false);
    expect(cycleTriState(false, true)).toBeUndefined();
  });

  it("starts from the other end when the caller asks the other question first", () => {
    expect(cycleTriState(undefined, false)).toBe(false);
    expect(cycleTriState(false, false)).toBe(true);
    expect(cycleTriState(true, false)).toBeUndefined();
  });
});

/** Unchanged behaviour, pinned here because Task 10 restyles the chips it belongs to. */
describe("toggleColor", () => {
  it("keeps C exclusive in both directions", () => {
    expect(toggleColor(["W", "U"], "C")).toEqual(["C"]);
    expect(toggleColor(["C"], "W")).toEqual(["W"]);
  });
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

const READY: FacetResponse = {
  colors: { W: 1, U: 1, B: 1, R: 1, G: 1, C: 1 },
  manaValues: { "0": 1 },
  formats: { modern: 1 },
  sets: { lea: 1 },
  owned: { owned: 1, missing: 0 },
  total: 1,
  ready: true,
};

const lastFacetRequest = () =>
  facetCards.mock.calls[facetCards.mock.calls.length - 1][0] as SearchRequest;

describe("the facet request useCardSearch builds", () => {
  beforeEach(() => {
    searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
    facetCards.mockReset().mockResolvedValue(READY);
  });

  it("carries the filters and nothing about the page", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(facetCards).toHaveBeenCalled());

    act(() => {
      result.current.setFormat("modern");
      result.current.toggleColor("R");
      result.current.toggleSet("lea");
      result.current.toggleManaValue(1);
      result.current.toggleOwned();
    });

    await waitFor(() => expect(lastFacetRequest().format).toBe("modern"));
    const req = lastFacetRequest();
    expect(req.colors).toBe("R");
    expect(req.sets).toEqual(["lea"]);
    expect(req.manaValues).toEqual([1]);
    expect(req.owned).toBe(true);
    // Facets depend on none of these, which is why they are a separate command: sending a
    // sort or an offset would recompute them on every header press and every page.
    expect(req.sort).toBeUndefined();
    expect(req.collapse).toBeUndefined();
    expect(req.offset).toBe(0);
  });

  /**
   * The claim the separate command exists for. A header press is a different *order* over
   * the same matches, and the counts under it do not move — so if the sort ever reached the
   * facet key, every column press would cost a second round trip that could only answer the
   * same numbers.
   */
  it("does not ask again when only the sort or the view mode changes", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(facetCards).toHaveBeenCalledTimes(1));
    const searches = searchCards.mock.calls.length;

    act(() => result.current.toggleSort("price", false));
    act(() => result.current.toggleAllPrintings());

    // The search really did re-run — otherwise this test would pass against a hook that
    // stopped querying altogether.
    await waitFor(() => expect(searchCards.mock.calls.length).toBeGreaterThan(searches));
    expect(facetCards).toHaveBeenCalledTimes(1);
  });

  /**
   * Every failure fails open, and the hook is where that is decided so no control has to
   * remember it. A cold index answers `ready: false` with **empty maps** rather than zeros;
   * handing those maps on as an answer would grey the entire filter row.
   *
   * Written as a *transition* rather than as a cold first load, because a cold first load
   * cannot tell a hook that answers nothing from one that has not answered yet — and because
   * this is the sequence the app really runs: a sync republishes the index, and the counts go
   * away under a reader who is mid-search.
   */
  it("hands on a cold index as no answer at all", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(result.current.facets).toEqual(READY));

    facetCards.mockResolvedValue({
      colors: {},
      manaValues: {},
      formats: {},
      sets: {},
      owned: { owned: 0, missing: 0 },
      total: 0,
      ready: false,
    });
    act(() => result.current.toggleColor("R"));

    await waitFor(() => expect(result.current.facets).toBeUndefined());
  });

  /**
   * The chips hold their last answer while the next one is in flight, rather than blinking
   * open and shut on every keystroke. The pass is short enough — 57 ms at the worst measured
   * — that an answer one filter out of date is the better of the two experiences.
   */
  it("holds the previous counts while the next answer is in flight", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(result.current.facets).toEqual(READY));

    facetCards.mockReturnValue(new Promise(() => {}));
    act(() => result.current.toggleColor("R"));

    await waitFor(() => expect(facetCards).toHaveBeenCalledTimes(2));
    expect(result.current.facets).toEqual(READY);
  });

  /**
   * …but only while it is *in flight*. A query that failed is not a slow query: the counts it
   * was holding belong to a search the reader has since left, and greying options by them
   * would be the one failure mode this feature is not allowed to have.
   *
   * The complementary case is deliberately not asserted because it does not happen: a failed
   * background re-read of a search that is *still on screen* keeps its answer, which React
   * Query decides and `useCardFacets` documents. Those counts still describe what is being
   * looked at.
   */
  it("drops the counts it was holding when the next facet query fails", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(result.current.facets).toEqual(READY));

    facetCards.mockRejectedValue("the index could not be read");
    act(() => result.current.toggleColor("R"));

    await waitFor(() => expect(result.current.facets).toBeUndefined());
  });
});
