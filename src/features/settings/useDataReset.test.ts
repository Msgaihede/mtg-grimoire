import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const collectionClear = vi.hoisted(() => vi.fn());
const wishlistClear = vi.hoisted(() => vi.fn());
const decksClear = vi.hoisted(() => vi.fn());
const cacheClear = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { collectionClear, wishlistClear, decksClear, cacheClear },
}));

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
   * Deliberately short, and worth pinning as an absence: nothing the collection page or the
   * search wall draws is derived from a deck's allocation, so clearing every deck must not
   * refetch either of them.
   */
  it("marks only the decks when the decks are cleared", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.decks.run());

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidatedRoots()).toEqual(["decks"]);
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
