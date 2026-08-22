import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const collectionClear = vi.hoisted(() => vi.fn());
const wishlistClear = vi.hoisted(() => vi.fn());
const decksClear = vi.hoisted(() => vi.fn());
const cacheClear = vi.hoisted(() => vi.fn());
const deckDrivenCollection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { collectionClear, wishlistClear, decksClear, cacheClear, deckDrivenCollection },
}));

import { DECK_DRIVEN_KEY } from "@/lib/useDeckDrivenCollection";
import { useDangerZone, useLocalCache } from "./useDataReset";

let client: QueryClient;
let invalidate: MockInstance<QueryClient["invalidateQueries"]>;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

/** The roots one press marked stale, flattened to their heads for a readable assertion. */
const invalidatedRoots = () =>
  invalidate.mock.calls.map(([filters]) => (filters?.queryKey as string[])[0]);

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  invalidate = vi.spyOn(client, "invalidateQueries").mockReturnValue(Promise.resolve());
  collectionClear.mockReset().mockResolvedValue({ entries: 12, allocations: 3 });
  wishlistClear.mockReset().mockResolvedValue(4);
  decksClear.mockReset().mockResolvedValue({ decks: 2, folders: 1, covers: 0 });
  cacheClear.mockReset().mockResolvedValue({ files: 20, bytes: 4_000, rows: 20, failed: 0 });
  // The hand-kept collection, the app's default. The derived test seeds `DECK_DRIVEN_KEY`
  // instead — `staleTime: Infinity` means a seeded answer is never re-asked.
  deckDrivenCollection.mockReset().mockResolvedValue(false);
});

describe("useDangerZone", () => {
  /**
   * The five roots, and four of them are joins rather than the table that was emptied. This is
   * the assertion that would have caught the obvious version of this hook — the one that
   * invalidates `["collection"]` and leaves every search row still claiming an `ownedQuantity`.
   */
  it("marks every root a cleared collection can have made wrong", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.collection.run());

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidatedRoots().sort()).toEqual(["card", "cards", "collection", "decks", "wishlist"]);
  });

  /**
   * Deliberately short, and worth pinning as an absence — **while the collection is hand
   * kept**. `CollectionRow.deckCount` is `null` in that mode and `CardSummary.ownedQuantity` is
   * allocation-blind, so clearing every deck must not refetch either of them.
   */
  it("marks only the decks when the decks are cleared", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.decks.run());

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidatedRoots()).toEqual(["decks"]);
  });

  /**
   * **The same press, and it is `collectionClear` under another name.**
   *
   * While the collection is derived it is the sum of every `variant: 'live'` deck card;
   * `decks_clear` cascades those rows away, so Clear decks does not release claims — it empties
   * the collection. Both clauses of the doc this replaced were false by then: `CollectionRow`
   * grew a `deckCount`, and "the deck pages and nothing else" had become the whole app. The
   * roots are `COLLECTION_ROOTS`, a superset of the four a deck *write* takes, which is the
   * right direction for the one press here that cannot be undone.
   */
  it("marks every root a cleared collection can have made wrong when the decks are the collection", async () => {
    client.setQueryData(DECK_DRIVEN_KEY, true);
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.decks.run());

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidatedRoots().sort()).toEqual(["card", "cards", "collection", "decks", "wishlist"]);
  });

  /**
   * The same again against the **real** cache rather than the spy, because the spy cannot see
   * the thing that makes this a bug rather than a cosmetic gap.
   *
   * `src/lib/query.ts` sets `staleTime: 30_000`, so the collection page's cached answer is
   * *fresh* and navigating back to it refetches nothing. `isInvalidated` is the whole of what
   * tells it the decks — and therefore the collection — are gone. The key is the real
   * `["collection", "list", …]` shape rather than the bare root, so a fix that invalidated the
   * root string and nothing under it would still fail here.
   */
  it("actually marks the cached collection page stale, not just the root", async () => {
    invalidate.mockRestore();
    client.setQueryData(DECK_DRIVEN_KEY, true);
    client.setQueryData(["collection", "list", "{}"], { items: [], total: 0 });
    const { result } = renderHook(() => useDangerZone(), { wrapper });
    expect(client.getQueryState(["collection", "list", "{}"])?.isInvalidated).toBe(false);

    act(() => result.current.decks.run());

    await waitFor(() =>
      expect(client.getQueryState(["collection", "list", "{}"])?.isInvalidated).toBe(true),
    );
  });

  it("reports what the clear did, in the panel's plain tone", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.wishlist.run());

    await waitFor(() =>
      expect(result.current.status).toEqual({
        tone: "plain",
        text: "Cleared 4 wishlist entries.",
      }),
    );
  });

  /**
   * The rule `@/lib/writes` exists for, applied across three buttons: a refusal replaces the
   * sentence a *different* button left standing, rather than the panel reporting a success that
   * has been overtaken.
   */
  it("lets a refused clear replace an earlier one's success", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.wishlist.run());
    await waitFor(() => expect(result.current.status?.tone).toBe("plain"));

    decksClear.mockRejectedValueOnce("The card database is busy.");
    act(() => result.current.decks.run());

    await waitFor(() =>
      expect(result.current.status).toEqual({
        tone: "problem",
        text: "The card database is busy.",
      }),
    );
  });

  /** And back the other way, which is the half a one-directional implementation gets wrong. */
  it("lets a later success replace a refusal", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    decksClear.mockRejectedValueOnce("The card database is busy.");
    act(() => result.current.decks.run());
    await waitFor(() => expect(result.current.status?.tone).toBe("problem"));

    act(() => result.current.collection.run());

    await waitFor(() =>
      expect(result.current.status).toEqual({
        tone: "plain",
        text: "Cleared 12 collection entries and released 3 deck reservations.",
      }),
    );
  });

  it("says nothing at all until something has been pressed", () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    expect(result.current.status).toBeNull();
  });
});

describe("useLocalCache", () => {
  /**
   * **Nothing goes stale, and that is the point.** Card art is served over `mtgimg://` outside
   * the query cache entirely, so a sweep that invalidated anything would be refetching rows to
   * describe bytes no row describes.
   */
  it("marks no query stale", async () => {
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.clear.run());

    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("says what it freed", async () => {
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.clear.run());

    await waitFor(() =>
      expect(result.current.status).toEqual({
        tone: "plain",
        text: "Freed 4 KB across 20 files.",
      }),
    );
  });

  it("shows the mid-sync refusal as the backend words it", async () => {
    cacheClear.mockRejectedValueOnce(
      "a card update is running — clear the cache once it has finished",
    );
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.clear.run());

    await waitFor(() =>
      expect(result.current.status).toEqual({
        tone: "problem",
        text: "a card update is running — clear the cache once it has finished",
      }),
    );
  });
});
