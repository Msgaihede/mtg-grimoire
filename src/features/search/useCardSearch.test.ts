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

import { COLD_POLL_MS } from "./useCardFacets";
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

/** One client per test, reachable from the test body so it can drive a re-read of a key that
 *  is already loaded — the only way to reach "an answer, and an error beside it". */
let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
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
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
   */
  it("drops the counts it was holding when the next facet query fails", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(result.current.facets).toEqual(READY));

    facetCards.mockRejectedValue("the index could not be read");
    act(() => result.current.toggleColor("R"));

    await waitFor(() => expect(result.current.facets).toBeUndefined());
  });

  /**
   * And the other half of that, which is the opposite answer to a failure and is meant to be.
   *
   * A **re-read of the search still on screen** is a case the app really reaches — the app's
   * `QueryClient` runs `staleTime: 30_000`, `retry: 1` and refetch-on-focus — and React Query
   * keeps the data and records the error beside it rather than clearing one for the other.
   * The counts that survive are keyed on this exact filter set, so they still describe what
   * the reader is looking at. Failing open is for not knowing; here we know, and throwing
   * them away would grey nothing over results they correctly describe.
   */
  it("keeps the counts when a re-read of the same search fails", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(result.current.facets).toEqual(READY));

    facetCards.mockRejectedValue(new Error("the index could not be read"));
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["cards", "facets"] });
    });

    // The re-read really happened and really failed — without this the assertion below would
    // pass against a hook that never asked again.
    const cached = qc.getQueryCache().findAll({ queryKey: ["cards", "facets"] });
    expect(cached).toHaveLength(1);
    expect(cached[0].state.status).toBe("error");
    expect(cached[0].state.data).toEqual(READY);

    // **The flush matters, and reading without it is how the first version of this comment
    // came to say something false.** `refetchQueries` resolves when the fetch settles, which
    // is a tick before React Query's notifier has told the observer about it — so an
    // assertion here reads the state *before* the error, and would hold whatever the hook
    // did with it. A hook that dropped its counts on `isError` passes without this line.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(result.current.facets).toEqual(READY);
  });

  /**
   * **A not-ready answer corrects itself, and nothing else in the app would ever correct it.**
   *
   * This is the one defect the live pass found (2026-08-11, shipped window): after a sync the
   * filter row showed no counts at all while `facet_cards`, called directly, answered
   * `ready: true`. `sync.rs` calls `lifecycle::spawn_build` and then `emit_done` on the very
   * next line, and `spawn_build` runs `clear` **synchronously on the caller's thread** — so
   * `done` is emitted over a cold index by construction. `useSyncInvalidation` invalidates
   * `["cards"]`, which prefix-matches the facet key, and the single refetch that produces
   * lands inside the ~767 ms build and caches `ready: false`. Success, so no retry; same
   * filters, so no new key; `staleTime` 30 s, so not stale. The row sits there.
   *
   * The sequence below is that exact one, minus the timers: an answer arrives not-ready, the
   * backend then becomes ready, and **nothing touches the hook** — no filter change, no
   * remount, no refetch driven from the test. Against the ordering as it shipped this fails,
   * because the second call never happens.
   */
  it("asks again on its own while the index is cold, and stops once it is ready", async () => {
    const COLD: FacetResponse = { ...READY, ready: false };
    facetCards.mockReset().mockResolvedValue(COLD);

    const { result } = renderHook(() => useCardSearch(), { wrapper });
    // A cold answer is collapsed to `undefined` at the door, which is what leaves every
    // control live — so the row is failing open here, not merely empty.
    await waitFor(() => expect(facetCards).toHaveBeenCalledTimes(1));
    expect(result.current.facets).toBeUndefined();

    // The index finishes building. Real time rather than fake timers, because the hook is
    // one of several driving this render and `vi.useFakeTimers` here would also freeze the
    // debounce and React Query's own scheduling.
    facetCards.mockResolvedValue(READY);

    await waitFor(() => expect(result.current.facets).toEqual(READY), { timeout: 5000 });

    // …and then it stops. The interval is a function of the answer, so a ready one turns it
    // off — without that this hook would poll a healthy index every 500 ms forever.
    const settled = facetCards.mock.calls.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, COLD_POLL_MS * 3));
    });
    expect(facetCards.mock.calls.length).toBe(settled);
  });
});
