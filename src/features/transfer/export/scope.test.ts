import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
