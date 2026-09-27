import { beforeEach, describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from "@tanstack/react-query";

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { searchMarks: vi.fn() },
}));

import { ipc, type CardSummary, type SearchResponse } from "@/lib/ipc";
import {
  invalidateOwnedWrite,
  refreshCardSearches,
  searchMarksMeta,
  type SearchMarksMeta,
} from "./searchMarks";

const searchMarks = vi.mocked(ipc.searchMarks);

const row = (id: string, ownedQuantity = 0, wishlisted = false) =>
  ({ id, name: id, ownedQuantity, wishlisted }) as CardSummary;

/** Two loaded pages of two rows each — a search the reader has scrolled once. */
const PAGES: SearchResponse[] = [
  { items: [row("a"), row("b", 1)], total: 4, totalIsCapped: false },
  { items: [row("c"), row("d", 0, true)], total: 4, totalIsCapped: false },
];

type Pages = InfiniteData<SearchResponse, number>;

/**
 * A client holding one search under `key`, **observed** — so it is active, which is the only
 * kind a write patches — and with its page fetches counted, which is the thing a patch exists
 * not to do.
 */
async function mounted(key: unknown[], meta: SearchMarksMeta | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetchPage = vi.fn(async ({ pageParam }: { pageParam: number }) => PAGES[pageParam]);
  const options = {
    queryKey: key,
    queryFn: fetchPage,
    initialPageParam: 0,
    getNextPageParam: (_: SearchResponse, pages: SearchResponse[]) =>
      pages.length < PAGES.length ? pages.length : undefined,
    staleTime: Infinity,
    ...(meta ? { meta: searchMarksMeta(meta) } : {}),
  };
  const observer = new InfiniteQueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
  await observer.fetchNextPage();
  fetchPage.mockClear();
  return { client, fetchPage, unsubscribe, data: () => client.getQueryData<Pages>(key)! };
}

const PLAIN: SearchMarksMeta = { collapse: true, availableForDeck: undefined, ownedFilter: false };

// A block body: `mockReset` returns the mock, and a function returned from `beforeEach` is run as
// its teardown — which would call `searchMarks` once more after every case.
beforeEach(() => {
  searchMarks.mockReset();
});

describe("refreshCardSearches (issue #552)", () => {
  it("patches the two badges of an active search in place and fetches no page", async () => {
    const { client, fetchPage, data } = await mounted(["cards", "search", "x"], PLAIN);
    const before = data();
    searchMarks.mockResolvedValue([
      { id: "a", ownedQuantity: 3, wishlisted: false },
      { id: "b", ownedQuantity: 1, wishlisted: false },
      { id: "c", ownedQuantity: 0, wishlisted: false },
      { id: "d", ownedQuantity: 0, wishlisted: true },
    ]);

    await refreshCardSearches(client);

    expect(fetchPage).not.toHaveBeenCalled();
    expect(searchMarks).toHaveBeenCalledWith({
      ids: ["a", "b", "c", "d"],
      collapse: true,
      availableForDeck: undefined,
    });
    const after = data();
    expect(after.pages[0].items[0]).toMatchObject({ id: "a", ownedQuantity: 3 });
    // Identity is kept wherever nothing moved, so a "+" re-renders the row it changed.
    expect(after.pages[0].items[1]).toBe(before.pages[0].items[1]);
    expect(after.pages[1]).toBe(before.pages[1]);
  });

  it("asks at the search's own grain and scope", async () => {
    const { client } = await mounted(["cards", "search", "deck"], {
      collapse: false,
      availableForDeck: 7,
      ownedFilter: false,
    });
    searchMarks.mockResolvedValue([]);
    await refreshCardSearches(client);
    expect(searchMarks).toHaveBeenCalledWith(
      expect.objectContaining({ collapse: undefined, availableForDeck: 7 }),
    );
  });

  it("refetches a search filtered by Owned, whose rows a write can add or drop", async () => {
    const { client, fetchPage } = await mounted(["cards", "search", "owned"], {
      ...PLAIN,
      ownedFilter: true,
    });
    await refreshCardSearches(client);
    expect(searchMarks).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(PAGES.length));
  });

  it("refetches a search that stamped no meta, as every caller did before", async () => {
    const { client, fetchPage } = await mounted(["cards", "search", "cover"], null);
    await refreshCardSearches(client);
    expect(searchMarks).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(PAGES.length));
  });

  it("falls back to the refetch when the re-read fails, rather than leave a wrong badge", async () => {
    const { client, fetchPage } = await mounted(["cards", "search", "x"], PLAIN);
    // A string, which is what a Tauri command rejects with.
    searchMarks.mockRejectedValue("database is locked");
    await refreshCardSearches(client);
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(PAGES.length));
  });

  it("leaves an unobserved search to be refetched when it is next on screen", async () => {
    const { client, fetchPage, unsubscribe } = await mounted(["cards", "search", "x"], PLAIN);
    unsubscribe();
    await refreshCardSearches(client);
    expect(searchMarks).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(client.getQueryState(["cards", "search", "x"])?.isInvalidated).toBe(true);
  });

  it("sends exactly the old invalidation when there is nothing to patch", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await refreshCardSearches(client);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ["cards", "search"] });
  });
});

describe("invalidateOwnedWrite", () => {
  it("fires the other three roots and patches the search rather than refetching it", async () => {
    const { client, fetchPage } = await mounted(["cards", "search", "x"], PLAIN);
    searchMarks.mockResolvedValue([]);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    invalidateOwnedWrite(client);
    await vi.waitFor(() => expect(searchMarks).toHaveBeenCalledOnce());
    for (const queryKey of [["collection"], ["wishlist"], ["decks"]]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
