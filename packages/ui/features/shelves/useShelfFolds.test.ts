import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const shelfFolds = vi.hoisted(() => vi.fn());
const setShelfFolds = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { shelfFolds, setShelfFolds },
}));

import { applyFoldChanges, readFolds, SHELF_FOLDS_KEY, useShelfFolds } from "./useShelfFolds";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // A reader who has opened one deck group (`3`, whose default is shut) and shut one binder (`7`),
  // and touched nothing on the wishlist. Both values are off their defaults, which is the only kind
  // of entry the row is supposed to hold (spec §5.7).
  shelfFolds.mockReset().mockResolvedValue({ collection: { "3": false, "7": true }, wishlist: {} });
  setShelfFolds.mockReset().mockResolvedValue(undefined);
});

describe("readFolds / applyFoldChanges", () => {
  it("keeps boolean entries and drops everything else a hand-edited row could hold", () => {
    expect(readFolds({ "3": true, "4": "yes", "5": null, "6": false })).toEqual({ "3": true, "6": false });
    expect(readFolds(undefined)).toEqual({});
    expect(readFolds("nonsense")).toEqual({});
    expect(readFolds(["x"])).toEqual({});
  });

  it("sets an override on a boolean and removes it on null", () => {
    expect(applyFoldChanges({ "3": true, "7": false }, { "3": null, "9": true })).toEqual({
      "7": false,
      "9": true,
    });
  });
});

/**
 * The shelves' collapse memory: one `app_meta` row, a map per page of folder id → collapsed, read
 * once per window and written optimistically — `useSearchOpen`'s shape (spec §5.7).
 */
describe("useShelfFolds", () => {
  it("answers the stored overrides for its own page", async () => {
    const { result } = renderHook(() => useShelfFolds("collection"), { wrapper });

    await waitFor(() => expect(result.current.folds).toEqual({ "3": false, "7": true }));
    expect(shelfFolds).toHaveBeenCalled();
  });

  it("answers no overrides for a page the row does not carry", async () => {
    shelfFolds.mockResolvedValue({ collection: { "3": false } });
    const { result } = renderHook(() => useShelfFolds("wishlist"), { wrapper });

    await waitFor(() => expect(shelfFolds).toHaveBeenCalled());
    expect(result.current.folds).toEqual({});
  });

  /** A preference that cannot be read is every shelf at its default, never a page that will not
   *  draw — driven all the way to `error` so this cannot pass on a read that merely had not answered. */
  it("answers no overrides when the read fails", async () => {
    shelfFolds.mockRejectedValue("The database is busy with a sync — try again in a moment.");
    const { result } = renderHook(() => useShelfFolds("collection"), { wrapper });

    await waitFor(() => expect(client.getQueryState(SHELF_FOLDS_KEY)?.status).toBe("error"));
    expect(result.current.folds).toEqual({});
  });

  it("writes the page and the change it was given", async () => {
    const { result } = renderHook(() => useShelfFolds("collection"), { wrapper });
    await waitFor(() => expect(result.current.folds).toEqual({ "3": false, "7": true }));

    act(() => result.current.setFold(9, true));

    await waitFor(() => expect(setShelfFolds).toHaveBeenCalledWith("collection", { "9": true }));
  });

  /** `null` is "back to the default" — the entry leaves the cache *and* the write says so, or the
   *  row would keep an override that now means nothing. */
  it("removes an override on null, in the cache and in the write", async () => {
    const { result } = renderHook(() => useShelfFolds("collection"), { wrapper });
    await waitFor(() => expect(result.current.folds).toEqual({ "3": false, "7": true }));

    act(() => result.current.setFold(7, null));

    // `waitFor`, not a bare read: TanStack's notifyManager delivers a `setQueryData` on
    // `setTimeout(0)`, so the render that carries it lands a macrotask after the press
    // (`useSearchOpen.test.ts` has the same shape, for the same reason).
    await waitFor(() => expect(result.current.folds).toEqual({ "3": false }));
    await waitFor(() => expect(setShelfFolds).toHaveBeenCalledWith("collection", { "7": null }));
  });

  /** Expand all / Collapse all are one press — one write, not one per shelf. */
  it("applies several changes as one write", async () => {
    const { result } = renderHook(() => useShelfFolds("collection"), { wrapper });
    await waitFor(() => expect(result.current.folds).toEqual({ "3": false, "7": true }));

    act(() => result.current.setMany({ "3": null, "7": null, "11": true }));

    await waitFor(() => expect(result.current.folds).toEqual({ "11": true }));
    await waitFor(() => expect(setShelfFolds).toHaveBeenCalledTimes(1));
    expect(setShelfFolds).toHaveBeenCalledWith("collection", { "3": null, "7": null, "11": true });
  });

  it("shows the new state before the write answers", async () => {
    setShelfFolds.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useShelfFolds("collection"), { wrapper });
    await waitFor(() => expect(result.current.folds).toEqual({ "3": false, "7": true }));

    act(() => result.current.setFold(12, true));

    // The write above never settles, so a hook that waited on it could not pass this.
    await waitFor(() => expect(result.current.folds).toEqual({ "3": false, "7": true, "12": true }));
  });

  /** BUSY during a sync is not a reason to snap a shelf open again under the reader's hand. */
  it("keeps the new state when the write is refused", async () => {
    setShelfFolds.mockRejectedValue("The database is busy with a sync — try again in a moment.");
    const { result } = renderHook(() => useShelfFolds("collection"), { wrapper });
    await waitFor(() => expect(result.current.folds).toEqual({ "3": false, "7": true }));

    act(() => result.current.setFold(12, true));

    await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.status).toBe("error"));
    expect(result.current.folds).toEqual({ "3": false, "7": true, "12": true });
  });

  it("does not disturb the other page", async () => {
    shelfFolds.mockResolvedValue({ collection: { "3": false }, wishlist: { "40": false } });
    const { result } = renderHook(() => useShelfFolds("collection"), { wrapper });
    const wishlist = renderHook(() => useShelfFolds("wishlist"), { wrapper });
    await waitFor(() => expect(wishlist.result.current.folds).toEqual({ "40": false }));

    act(() => result.current.setFold(5, true));

    expect(wishlist.result.current.folds).toEqual({ "40": false });
    expect(client.getQueryData(SHELF_FOLDS_KEY)).toEqual({
      collection: { "3": false, "5": true },
      wishlist: { "40": false },
    });
  });

  /** Two presses on one shelf a moment apart must land in the order they were made, or the stored
   *  answer could be the first press rather than the last. One mutation scope serialises them. */
  it("sends one write at a time, in the order the presses were made", async () => {
    let release!: () => void;
    setShelfFolds.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useShelfFolds("collection"), { wrapper });
    await waitFor(() => expect(result.current.folds).toEqual({ "3": false, "7": true }));

    act(() => {
      result.current.setFold(3, true);
      result.current.setFold(3, null);
    });

    await waitFor(() => expect(setShelfFolds).toHaveBeenCalledTimes(1));
    expect(setShelfFolds).toHaveBeenNthCalledWith(1, "collection", { "3": true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(setShelfFolds).toHaveBeenCalledTimes(1);

    act(() => release());
    await waitFor(() => expect(setShelfFolds).toHaveBeenCalledTimes(2));
    expect(setShelfFolds).toHaveBeenNthCalledWith(2, "collection", { "3": null });
  });

  /** The page memoises `buildShelves` on `folds`; a new object every render would rebuild the
   *  whole shelf list on every keystroke in the search box. */
  it("keeps the same folds object across a render that changed nothing", async () => {
    const { result, rerender } = renderHook(() => useShelfFolds("collection"), { wrapper });
    await waitFor(() => expect(result.current.folds).toEqual({ "3": false, "7": true }));
    const first = result.current.folds;

    rerender();

    expect(result.current.folds).toBe(first);
  });
});
