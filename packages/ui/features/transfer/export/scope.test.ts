import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { WishlistQuery } from "@/lib/ipc";

const wishlistList = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { wishlistList },
}));

import { SWEEP_PAGE, sweep, useExportScope, type WishlistScopeFilters } from "./scope";

describe("sweep", () => {
  it("keeps asking until it has the whole set", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ id: i }));
    const page = vi.fn(async (limit: number, offset: number) => ({
      items: rows.slice(offset, offset + limit),
      total: rows.length,
    }));

    const all = await sweep(page);

    expect(all).toHaveLength(1200);
    expect(page).toHaveBeenCalledTimes(3);
    expect(page).toHaveBeenNthCalledWith(1, SWEEP_PAGE, 0);
    expect(page).toHaveBeenNthCalledWith(3, SWEEP_PAGE, 1000);
  });

  it("stops on a short page rather than trusting the total, which can move mid-sweep", async () => {
    const page = vi.fn(async (_limit: number, offset: number) =>
      offset === 0 ? { items: [{ id: 1 }], total: 9999 } : { items: [], total: 9999 },
    );
    expect(await sweep(page)).toHaveLength(1);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("reports progress against the total it was told", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ id: i }));
    const seen: number[] = [];
    await sweep(
      async (limit, offset) => ({ items: rows.slice(offset, offset + limit), total: 600 }),
      (loaded) => seen.push(loaded),
    );
    expect(seen).toEqual([500, 600]);
  });

  it("answers an empty list without asking twice", async () => {
    const page = vi.fn(async () => ({ items: [], total: 0 }));
    expect(await sweep(page)).toEqual([]);
    expect(page).toHaveBeenCalledTimes(1);
  });
});

/**
 * `everythingFilters` strips `folderId` along with every other row-narrowing filter — right for
 * every field but this one, because an absent `folderId` is itself a filter on the backend
 * (`64453bd`: "the root wishlist", not "no folder named"). Fix round 1: the wishlist arm has to
 * say "every folder" a second way, `flatten: true`, or "Everything" on this surface would sweep
 * only the root and caption a fraction of the list as the whole of it.
 */
describe("useExportScope — the wishlist's Everything arm", () => {
  beforeEach(() => {
    wishlistList.mockReset().mockResolvedValue({ items: [], total: 0 });
  });

  function wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return createElement(QueryClientProvider, { client: qc }, children);
  }

  const lastQuery = () =>
    wishlistList.mock.calls[wishlistList.mock.calls.length - 1][0] as WishlistQuery;

  it("sends flatten: true once Everything is on, even though folderId is stripped", async () => {
    const filters: WishlistScopeFilters = { text: "bolt", folderId: 3, marketplace: "tcgplayer" };
    const { result } = renderHook(() => useExportScope("wishlist", filters, true), { wrapper });
    await waitFor(() => expect(wishlistList).toHaveBeenCalled());

    act(() => result.current.setEverything(true));

    await waitFor(() => expect(lastQuery().flatten).toBe(true));
    // Stripped along with every other row-narrowing filter, exactly as `everythingFilters`
    // already strips `text` — that is fine now, because `flatten: true` is what actually says
    // "every folder" rather than leaving it to fall out of an absent `folderId`.
    expect(lastQuery().text).toBeUndefined();
    expect(lastQuery().folderId).toBeUndefined();
    // `marketplace` still rides along, the one field `everythingFilters` deliberately keeps.
    expect(lastQuery().marketplace).toBe("tcgplayer");
  });

  it("passes the reader's own folderId and flatten through untouched when Everything is off", async () => {
    const filters: WishlistScopeFilters = { folderId: 3, flatten: false, marketplace: "tcgplayer" };
    renderHook(() => useExportScope("wishlist", filters, true), { wrapper });

    await waitFor(() => expect(wishlistList).toHaveBeenCalled());
    expect(lastQuery().folderId).toBe(3);
    expect(lastQuery().flatten).toBe(false);
  });
});

/**
 * Issue #555: what the dialog's two buttons are told when the sweep has not answered, and when
 * it could not. Both used to read as a finished sweep over an empty list — `loading` was
 * `isFetching` and nothing reported a failure — so Copy and Save as… armed over a file of
 * nothing.
 */
describe("useExportScope — a sweep that has not answered, or could not", () => {
  const FILTERS: WishlistScopeFilters = { marketplace: "tcgplayer" };

  beforeEach(() => {
    wishlistList.mockReset();
  });

  /** `retry: false` so a failure is one call, which is what lets the counts below be exact. */
  function wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return createElement(QueryClientProvider, { client: qc }, children);
  }

  it("reports loading and no error until the sweep answers", async () => {
    let answer: (page: { items: never[]; total: number }) => void = () => {};
    wishlistList.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { result } = renderHook(() => useExportScope("wishlist", FILTERS, true), { wrapper });

    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.cards).toEqual([]);

    act(() => answer({ items: [], total: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  /**
   * The gap `isFetching` left, and the one no fetch mock can show: a query the network manager
   * has **paused** is waiting with nothing in flight, so `isFetching` is false while `cards` is
   * still the empty placeholder. Offline is the ordinary way to get there.
   */
  it("reports loading while the query waits with no fetch in flight", () => {
    onlineManager.setOnline(false);
    try {
      const { result } = renderHook(() => useExportScope("wishlist", FILTERS, true), { wrapper });

      expect(wishlistList).not.toHaveBeenCalled();
      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeNull();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("is not loading on a page whose dialog is shut", () => {
    const { result } = renderHook(() => useExportScope("wishlist", FILTERS, false), { wrapper });

    expect(result.current.loading).toBe(false);
    expect(wishlistList).not.toHaveBeenCalled();
  });

  it("reports a failure in ipcError's words, stops loading, and asks again on retry", async () => {
    // A Tauri command rejects with a bare string, which `ipcError` passes through as it is.
    wishlistList.mockRejectedValueOnce("database is locked");
    const { result } = renderHook(() => useExportScope("wishlist", FILTERS, true), { wrapper });

    await waitFor(() => expect(result.current.error).toBe("database is locked"));
    expect(result.current.loading).toBe(false);
    expect(result.current.cards).toEqual([]);
    expect(wishlistList).toHaveBeenCalledTimes(1);

    let answer: (page: { items: never[]; total: number }) => void = () => {};
    wishlistList.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    act(() => result.current.retry());

    // The retry is a wait, not a second failure: the query keeps its error until an attempt
    // succeeds, and an alert standing over the Retry it offered would say the retry had failed.
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.error).toBeNull();
    expect(wishlistList).toHaveBeenCalledTimes(2);

    act(() => answer({ items: [], total: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it("reports an Error's message rather than the object", async () => {
    wishlistList.mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderHook(() => useExportScope("wishlist", FILTERS, true), { wrapper });

    await waitFor(() => expect(result.current.error).toBe("disk full"));
  });

  it("hands back one retry across renders, so a caller can pass it straight to a button", async () => {
    wishlistList.mockResolvedValue({ items: [], total: 0 });
    const { result, rerender } = renderHook(() => useExportScope("wishlist", FILTERS, true), {
      wrapper,
    });
    const first = result.current.retry;
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender();

    expect(result.current.retry).toBe(first);
  });
});
