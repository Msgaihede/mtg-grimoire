import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const getMarketplace = vi.hoisted(() => vi.fn());
const setMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
const marketplaceFeedRefresh = vi.hoisted(() => vi.fn());
const onMarketplaceProgress = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    getMarketplace,
    setMarketplace,
    marketplaceFeedStatus,
    marketplaceFeedRefresh,
    onMarketplaceProgress,
  },
}));

import type { FeedProgressEvent, MarketplaceFeedStatus } from "@/lib/ipc";
import { feedState, useMarketplace, useMarketplaceProgress } from "./useMarketplace";

const NOW = 1_800_000_000;

function status(over: Partial<MarketplaceFeedStatus> = {}): MarketplaceFeedStatus {
  return {
    marketplace: "cardkingdom",
    fetchedAt: NOW - 3_600,
    feedBuiltAt: "2026-08-11 21:07:02",
    rowCount: 149_989,
    stale: false,
    refreshing: false,
    ...over,
  };
}

/** Both feeds fetched an hour ago, which is the ordinary state a reader is in. */
const BOTH_FRESH: MarketplaceFeedStatus[] = [
  status(),
  status({ marketplace: "manapool", feedBuiltAt: null, rowCount: 102_321 }),
];

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  setMarketplace.mockReset().mockResolvedValue(undefined);
  marketplaceFeedStatus.mockReset().mockResolvedValue(BOTH_FRESH);
  marketplaceFeedRefresh.mockReset().mockResolvedValue(status());
  onMarketplaceProgress.mockReset().mockResolvedValue(() => {});
});

/**
 * The ordering is the whole content of {@link feedState}, so it is asserted directly rather
 * than through a render: which of two true things a reader is told first is a decision, and it
 * is the kind that goes wrong silently.
 */
describe("feedState", () => {
  it("says fetching over everything else, because it is happening now", () => {
    expect(feedState(status(), true, false)).toBe("fetching");
    // Even over a failure and over rows the backend calls stale: a fetch running on top of
    // either is not "failed" and not "stale", it is a fetch.
    expect(feedState(status({ stale: true }), true, true)).toBe("fetching");
  });

  /** "We tried and it did not work" is a different sentence from "nobody has tried", and only
   *  one of them is worth offering a retry against. */
  it("says failed over never and over the age of the rows", () => {
    expect(feedState(null, false, true)).toBe("failed");
    expect(feedState(status(), false, true)).toBe("failed");
  });

  /**
   * **`never` is `fetchedAt`, not `rowCount`.** They are different questions: a feed that was
   * fetched and landed nothing is not a feed nobody has fetched, and only the second is a state
   * a first selection should act on. The backend calls a never-fetched feed stale as well —
   * that is what makes its start-up pass collect one — so the order here is what stops the
   * panel saying "a refresh is due" about prices that have never existed.
   */
  it("says never when the feed has not been fetched, whatever else is true of it", () => {
    expect(feedState(null, false, false)).toBe("never");
    expect(feedState(status({ fetchedAt: null, rowCount: null, stale: true }), false, false)).toBe(
      "never",
    );
    // Fetched, and it landed nothing. Not "never": somebody tried.
    expect(feedState(status({ rowCount: 0 }), false, false)).toBe("fresh");
  });

  /**
   * **Staleness is read, not computed.** `REFRESH_INTERVAL_SECS` (24 h — Card Kingdom's own
   * regeneration cadence) lives in `marketplace_feed.rs`, where it also decides whether the
   * backend refreshes at start-up. A second copy of that arithmetic here would be a second
   * place for one number to drift, and the two behaviours would part company silently.
   */
  it("takes the backend's word for whether a feed is stale", () => {
    expect(feedState(status({ stale: false }), false, false)).toBe("fresh");
    expect(feedState(status({ stale: true }), false, false)).toBe("stale");
  });
});

describe("useMarketplace", () => {
  it("resolves the stored id and describes both downloaded feeds", async () => {
    const { result } = renderHook(() => useMarketplace(), { wrapper });

    await waitFor(() => expect(result.current.feeds[0].status).not.toBeNull());
    expect(result.current.marketplace.id).toBe("tcgplayer");
    expect(result.current.feeds.map((f) => f.marketplace.id)).toEqual([
      "cardkingdom",
      "manapool",
    ]);
    expect(result.current.feeds.every((f) => f.state === "fresh")).toBe(true);
    // TCGplayer's prices arrive with the card data, so the chosen marketplace has no feed.
    expect(result.current.feed).toBeNull();
  });

  /**
   * **Choosing a feed with nothing in it fetches it.**
   *
   * The reader has just asked for prices this app does not have; every surface in the window
   * would otherwise fill with em dashes until somebody found a button. It happens in the hook
   * rather than in the panel so it holds however the switch was thrown.
   */
  it("fetches a feed-backed marketplace that has no rows when it is chosen", async () => {
    marketplaceFeedStatus.mockResolvedValue([
      status({ fetchedAt: null, rowCount: 0 }),
      BOTH_FRESH[1],
    ]);
    const { result } = renderHook(() => useMarketplace(), { wrapper });
    await waitFor(() => expect(result.current.feeds[0].status?.rowCount).toBe(0));

    result.current.select("cardkingdom");

    await waitFor(() => expect(marketplaceFeedRefresh).toHaveBeenCalledWith("cardkingdom"));
  });

  /** A feed that already has rows is left alone however old they are: staleness is the
   *  backend's to act on at start-up, and 63.7 MiB is not a thing to download on a whim. */
  it("does not fetch a feed that already has rows", async () => {
    const { result } = renderHook(() => useMarketplace(), { wrapper });
    await waitFor(() => expect(result.current.feeds[0].status).not.toBeNull());

    result.current.select("cardkingdom");

    await waitFor(() => expect(setMarketplace).toHaveBeenCalledWith("cardkingdom"));
    expect(marketplaceFeedRefresh).not.toHaveBeenCalled();
  });

  /** And a marketplace whose prices come with the card data has nothing to fetch at all. */
  it("does not fetch anything when a Scryfall-backed marketplace is chosen", async () => {
    const { result } = renderHook(() => useMarketplace(), { wrapper });
    await waitFor(() => expect(result.current.feeds[0].status).not.toBeNull());

    result.current.select("cardmarket");

    await waitFor(() => expect(setMarketplace).toHaveBeenCalledWith("cardmarket"));
    expect(marketplaceFeedRefresh).not.toHaveBeenCalled();
  });

  /**
   * **A refresh nobody in this window started still reads as `fetching`.**
   *
   * The backend refreshes the selected feed at app start when its rows are older than a day or
   * absent, so a fetch can be running before any component has mounted a mutation. A state
   * derived only from this window's own `useMutation` would report `fresh` through the whole of
   * it — which is the bug this reconciliation exists to prevent.
   */
  it("reads a backend-started fetch out of the progress event", async () => {
    const progress = (event: FeedProgressEvent) =>
      client.setQueryData(["marketplace", "progress"], event);
    const { result } = renderHook(() => useMarketplace(), { wrapper });
    await waitFor(() => expect(result.current.feeds[0].state).toBe("fresh"));

    progress({ marketplace: "cardkingdom", phase: "downloading", done: 1, total: 100 });

    await waitFor(() => expect(result.current.feeds[0].state).toBe("fetching"));
    expect(result.current.refreshing).toBe("cardkingdom");
    // The event speaks only for the feed it names — Mana Pool is not fetching.
    expect(result.current.feeds[1].state).toBe("fresh");
  });

  /** The same event's failure arm, for a fetch this window did not make: the state is news the
   *  reader needs, and there is no message on a progress event to invent one from. */
  it("reads a backend-side failure out of the progress event, with no message", async () => {
    const { result } = renderHook(() => useMarketplace(), { wrapper });
    await waitFor(() => expect(result.current.feeds[0].state).toBe("fresh"));

    client.setQueryData(["marketplace", "progress"], {
      marketplace: "cardkingdom",
      phase: "error",
      done: 0,
      total: 0,
    });

    await waitFor(() => expect(result.current.feeds[0].state).toBe("failed"));
    expect(result.current.feeds[0].error).toBeNull();
    // And the rows are still there: a failed fetch leaves the previous prices in place.
    expect(result.current.feeds[0].status?.rowCount).toBe(149_989);
  });

  /**
   * A refusal this window *did* cause carries its sentence — including the empty-feed one,
   * which is refused rather than written precisely so an error page cannot wipe a working
   * price table.
   */
  it("reports a refused refresh in words, over the rows it left alone", async () => {
    marketplaceFeedRefresh.mockRejectedValue("Card Kingdom's price feed was empty.");
    const { result } = renderHook(() => useMarketplace(), { wrapper });
    await waitFor(() => expect(result.current.feeds[0].status).not.toBeNull());

    result.current.refresh("cardkingdom");

    await waitFor(() => expect(result.current.feeds[0].state).toBe("failed"));
    expect(result.current.feeds[0].error).toBe("Card Kingdom's price feed was empty.");
    expect(result.current.feeds[0].status?.rowCount).toBe(149_989);
  });

  /**
   * **Every price-bearing query is invalidated when a feed lands, and none of their keys
   * moved.** The marketplace is the same one it was, so nothing would refetch on its own — and
   * the numbers in the collection, the search, the decks and the wishlist have all just
   * changed underneath the pages showing them.
   */
  it("re-reads every priced list after a refresh", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useMarketplace(), { wrapper });
    await waitFor(() => expect(result.current.feeds[0].status).not.toBeNull());
    invalidate.mockClear();

    result.current.refresh("cardkingdom");

    await waitFor(() => expect(marketplaceFeedRefresh).toHaveBeenCalled());
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] }),
    );
    for (const key of [["collection"], ["wishlist"], ["decks"]]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    }
  });
});

describe("useMarketplaceProgress", () => {
  /** One subscription, on the one event name — a subscriber spelling it differently hears
   *  nothing at all, forever, with no error anywhere. */
  it("subscribes once and stores the event where every observer can read it", async () => {
    let emit: ((e: FeedProgressEvent) => void) | undefined;
    onMarketplaceProgress.mockImplementation((cb: (e: FeedProgressEvent) => void) => {
      emit = cb;
      return Promise.resolve(() => {});
    });

    const { result } = renderHook(
      () => {
        useMarketplaceProgress();
        return useMarketplace();
      },
      { wrapper },
    );
    await waitFor(() => expect(onMarketplaceProgress).toHaveBeenCalledTimes(1));

    emit?.({ marketplace: "manapool", phase: "ingesting", done: 4_000, total: 102_321 });

    await waitFor(() => expect(result.current.progress?.marketplace).toBe("manapool"));
    expect(result.current.feeds[1].state).toBe("fetching");
  });

  /** A `done` event is the other half of the invalidation: a start-up refresh nobody pressed
   *  still has to reach the pages already on screen. */
  it("re-reads the priced lists when a fetch it did not start finishes", async () => {
    let emit: ((e: FeedProgressEvent) => void) | undefined;
    onMarketplaceProgress.mockImplementation((cb: (e: FeedProgressEvent) => void) => {
      emit = cb;
      return Promise.resolve(() => {});
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useMarketplaceProgress(), { wrapper });
    await waitFor(() => expect(onMarketplaceProgress).toHaveBeenCalled());
    invalidate.mockClear();

    emit?.({ marketplace: "cardkingdom", phase: "done", done: 1, total: 1 });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] });
  });

  /** Registering a listener fails outside a Tauri window — a plain `vite dev`, a story. The
   *  status read is the reliable half of the pair and still answers, so this must not throw. */
  it("survives a window with no Tauri event bridge", async () => {
    onMarketplaceProgress.mockRejectedValue(new Error("not a tauri window"));

    const { result } = renderHook(
      () => {
        useMarketplaceProgress();
        return useMarketplace();
      },
      { wrapper },
    );

    await waitFor(() => expect(result.current.feeds[0].status).not.toBeNull());
    expect(result.current.feeds[0].state).toBe("fresh");
  });
});
