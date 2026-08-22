import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { WishlistFolder, WishlistFolderSummary } from "@/lib/ipc";

const wishlistFolderList = vi.hoisted(() => vi.fn());
const wishlistFolderCreate = vi.hoisted(() => vi.fn());
const wishlistFolderRename = vi.hoisted(() => vi.fn());
const wishlistFolderMove = vi.hoisted(() => vi.fn());
const wishlistFolderDelete = vi.hoisted(() => vi.fn());
const wishlistFolderSummary = vi.hoisted(() => vi.fn());
// `useWishlistFolders` reads `useMarketplace()`, which is the real hook here rather than a
// fake — so its own queries need answers too. `marketplaceFeedStatus` is never asserted on;
// it only has to resolve so that hook does not sit on a rejected query for the life of the test.
const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    wishlistFolderList,
    wishlistFolderCreate,
    wishlistFolderRename,
    wishlistFolderMove,
    wishlistFolderDelete,
    wishlistFolderSummary,
    getMarketplace,
    marketplaceFeedStatus,
  },
}));

import { useWishlistFolderList, useWishlistFolders } from "./useWishlistFolders";

/** Two folders, one inside the other — flat rows, because the tree is the reader's to build
 *  from `parentId` and `wishlist_folders` has no notion of depth. */
const WANTS: WishlistFolder = { id: 1, parentId: null, name: "Wants", sortOrder: 0 };
const STAPLES: WishlistFolder = { id: 2, parentId: 1, name: "Staples", sortOrder: 0 };

/** One summary row per folder above — direct per folder, never recursive. */
const WANTS_SUMMARY: WishlistFolderSummary = {
  folderId: 1,
  wishes: 3,
  missing: 2,
  cost: 45.5,
  unpriced: 0,
};
const STAPLES_SUMMARY: WishlistFolderSummary = {
  folderId: 2,
  wishes: 1,
  missing: 1,
  cost: 12,
  unpriced: 1,
};

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  wishlistFolderList.mockReset().mockResolvedValue([WANTS, STAPLES]);
  wishlistFolderCreate.mockReset().mockResolvedValue(STAPLES);
  wishlistFolderRename.mockReset().mockResolvedValue({ ...WANTS, name: "Wishlist" });
  wishlistFolderMove.mockReset().mockResolvedValue({ ...STAPLES, parentId: null });
  wishlistFolderDelete.mockReset().mockResolvedValue(undefined);
  wishlistFolderSummary.mockReset().mockResolvedValue([WANTS_SUMMARY, STAPLES_SUMMARY]);
  // Matches `DEFAULT_MARKETPLACE`, so a test that does not care about marketplace settles with
  // no observable change from the hook's own initial guess.
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
});

describe("useWishlistFolderList", () => {
  /**
   * **The card menu's hook, and the whole reason it is not `useWishlistFolders`.**
   *
   * `Add to → Wishlist` is built on five surfaces that draw no folder card and no price
   * subtotal, and `wishlist_folder_summary` is a `GROUP BY` over every wish with the
   * owned-copies subquery and a marketplace price expression in it. Asserting the command is
   * **not** called is the only way this stays true: adding the summary back would leave every
   * other test in this file green, because the folder rows would be identical either way.
   */
  it("reads the folder list and asks for no summary", async () => {
    const { result } = renderHook(() => useWishlistFolderList(), { wrapper });

    await waitFor(() => expect(result.current.folders).toEqual([WANTS, STAPLES]));
    expect(wishlistFolderList).toHaveBeenCalledWith();
    expect(wishlistFolderSummary).not.toHaveBeenCalled();
  });

  /** The same key both hooks read, which is what makes the split free: a page mounting each of
   *  them once asks the backend for the list once. */
  it("caches under the key the full hook reads, so the two share one answer", async () => {
    const { result } = renderHook(
      () => ({ list: useWishlistFolderList(), full: useWishlistFolders() }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.full.folders).toEqual([WANTS, STAPLES]));
    expect(result.current.list.folders).toBe(result.current.full.folders);
    expect(wishlistFolderList).toHaveBeenCalledTimes(1);
  });

  /** Empty is the ordinary answer and it is **one identity**, so a consumer memoising on this
   *  array does not see a new one every render while nothing is filed. */
  it("answers one stable empty array before the first read lands", () => {
    const { result, rerender } = renderHook(() => useWishlistFolderList(), { wrapper });
    const first = result.current.folders;

    expect(first).toEqual([]);
    rerender();
    expect(result.current.folders).toBe(first);
  });
});

describe("useWishlistFolders", () => {
  /** No argument, and none in the command either: a folder belongs to no wish, it files them.
   *  So there is one query for the whole app rather than one per wish. */
  it("reads every folder there is, with no wish to scope it by", async () => {
    const { result } = renderHook(() => useWishlistFolders(), { wrapper });

    await waitFor(() => expect(result.current.folders).toEqual([WANTS, STAPLES]));
    expect(wishlistFolderList).toHaveBeenCalledWith();
    expect(client.getQueryData(["wishlist", "folders"])).toEqual([WANTS, STAPLES]);
  });

  /** `null` is the root of the tree, and it is an argument with a meaning rather than an
   *  omission — the same `null` `wishlistSetFolder` uses to un-file a wish. */
  it("makes a folder at the root and inside another one", async () => {
    const { result } = renderHook(() => useWishlistFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));

    await result.current.create.mutateAsync({ parentId: null, name: "Wants" });
    expect(wishlistFolderCreate).toHaveBeenCalledWith(null, "Wants");

    await result.current.create.mutateAsync({ parentId: 1, name: "Staples" });
    expect(wishlistFolderCreate).toHaveBeenCalledWith(1, "Staples");
  });

  it("renames and re-parents by id, and takes null back to the root", async () => {
    const { result } = renderHook(() => useWishlistFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));

    await result.current.rename.mutateAsync({ id: 1, name: "Wishlist" });
    expect(wishlistFolderRename).toHaveBeenCalledWith(1, "Wishlist");

    await result.current.move.mutateAsync({ id: 2, parentId: null });
    expect(wishlistFolderMove).toHaveBeenCalledWith(2, null);
  });

  /**
   * **The whole `["wishlist"]` root, not this hook's own key** — and a folder delete is the
   * case that proves why it has to be.
   *
   * `wishlist_entries.folder_id` is `ON DELETE SET NULL`, so deleting a folder changes
   * **wishes** this hook never mentions: they surface at the root, filed nowhere. A wall that
   * refreshed only its folder list would go on drawing them inside a folder that is not there.
   */
  it("refreshes every wish query after a folder write, not just the folder list", async () => {
    const { result } = renderHook(() => useWishlistFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.remove.mutateAsync(2);

    expect(wishlistFolderDelete).toHaveBeenCalledWith(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["wishlist", "folders"] });
  });

  /**
   * **A refused write re-reads too**, and the rule lives on the mutation definition rather than
   * on a call site — `useDeckFolders`' reasoning, applied to the surface that has the same
   * shape.
   *
   * Every refusal here is a busy database or a folder another surface has already deleted, and
   * the second must not leave a tree drawing a node that is gone.
   */
  it("re-reads when a folder write is refused", async () => {
    wishlistFolderMove.mockRejectedValue("A folder cannot be moved inside itself.");
    const { result } = renderHook(() => useWishlistFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await expect(result.current.move.mutateAsync({ id: 1, parentId: 2 })).rejects.toBe(
      "A folder cannot be moved inside itself.",
    );

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] }));
  });

  /** The summary is priced at `useMarketplace()`'s answer, and the query is keyed on it — never
   *  on a bare `["wishlist", "folderSummary"]` that both marketplaces would share. */
  it("prices the summary at the marketplace useMarketplace names, and keys the query by it", async () => {
    getMarketplace.mockResolvedValue("manapool");
    const { result } = renderHook(() => useWishlistFolders(), { wrapper });

    await waitFor(() => expect(result.current.summary.get(1)).toEqual(WANTS_SUMMARY));
    expect(result.current.summary.get(2)).toEqual(STAPLES_SUMMARY);
    expect(wishlistFolderSummary).toHaveBeenCalledWith("manapool");
    expect(client.getQueryData(["wishlist", "folderSummary", "manapool"])).toEqual([
      WANTS_SUMMARY,
      STAPLES_SUMMARY,
    ]);
  });

  /**
   * **Two marketplaces are two cached answers, and neither may be served from the other's.**
   * A stale row is seeded under a different marketplace's key before the hook ever runs; if the
   * summary query were keyed on anything less than the marketplace id, TanStack would have
   * happily handed that row back instead of asking `wishlistFolderSummary` at all.
   */
  it("never serves one marketplace's folder summary from the other's cached page", async () => {
    getMarketplace.mockResolvedValue("manapool");
    client.setQueryData(
      ["wishlist", "folderSummary", "cardkingdom"],
      [{ ...WANTS_SUMMARY, wishes: 999 }],
    );

    const { result } = renderHook(() => useWishlistFolders(), { wrapper });

    await waitFor(() => expect(result.current.summary.get(1)).toEqual(WANTS_SUMMARY));
    expect(wishlistFolderSummary).toHaveBeenCalledWith("manapool");
    // The other marketplace's cached page is untouched — proof the two answers never mixed.
    expect(client.getQueryData(["wishlist", "folderSummary", "cardkingdom"])).toEqual([
      { ...WANTS_SUMMARY, wishes: 999 },
    ]);
  });
});
