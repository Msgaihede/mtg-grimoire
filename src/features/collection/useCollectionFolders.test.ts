import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { CollectionFolder, CollectionFolderSummary } from "@/lib/ipc";

const collectionFolderList = vi.hoisted(() => vi.fn());
const collectionFolderCreate = vi.hoisted(() => vi.fn());
const collectionFolderRename = vi.hoisted(() => vi.fn());
const collectionFolderMove = vi.hoisted(() => vi.fn());
const collectionFolderReorder = vi.hoisted(() => vi.fn());
const collectionFolderDelete = vi.hoisted(() => vi.fn());
const collectionFolderSetLocked = vi.hoisted(() => vi.fn());
const collectionFolderSummary = vi.hoisted(() => vi.fn());
// `useCollectionFolders` reads `useMarketplace()`, which is the real hook here rather than a
// fake — so its own queries need answers too. `marketplaceFeedStatus` is never asserted on; it
// only has to resolve so that hook does not sit on a rejected query for the life of the test.
const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionFolderList,
    collectionFolderCreate,
    collectionFolderRename,
    collectionFolderMove,
    collectionFolderReorder,
    collectionFolderDelete,
    collectionFolderSetLocked,
    collectionFolderSummary,
    getMarketplace,
    marketplaceFeedStatus,
  },
}));

import { useCollectionFolderList, useCollectionFolders } from "./useCollectionFolders";

/** Two drawers, one inside the other — flat rows, because the tree is the reader's to build from
 *  `parentId` and `collection_folders` has no notion of depth. */
const BINDER: CollectionFolder = {
  id: 1,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
};
const FOILS: CollectionFolder = {
  id: 2,
  parentId: 1,
  name: "Foils",
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
};

/** One summary row per folder above — direct per folder, never recursive, and copies rather than
 *  rows. */
const BINDER_SUMMARY: CollectionFolderSummary = { folderId: 1, cards: 12, value: 340.25 };
const FOILS_SUMMARY: CollectionFolderSummary = { folderId: 2, cards: 3, value: null };

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  collectionFolderList.mockReset().mockResolvedValue([BINDER, FOILS]);
  collectionFolderCreate.mockReset().mockResolvedValue(FOILS);
  collectionFolderRename.mockReset().mockResolvedValue({ ...BINDER, name: "Binder" });
  collectionFolderMove.mockReset().mockResolvedValue({ ...FOILS, parentId: null });
  // The whole cabinet, flat, as it now stands — `collection_folders::reorder_folders` ends in the
  // same `list_folders` the plain read does, so this is not scoped to the level that was written.
  collectionFolderReorder
    .mockReset()
    .mockResolvedValue([{ ...FOILS, parentId: null, sortOrder: 0 }, { ...BINDER, sortOrder: 1 }]);
  collectionFolderDelete.mockReset().mockResolvedValue(undefined);
  // The folder re-read, `rename`'s shape: the row as it now stands, with its own flag written.
  collectionFolderSetLocked.mockReset().mockResolvedValue({ ...BINDER, locked: true });
  collectionFolderSummary.mockReset().mockResolvedValue([BINDER_SUMMARY, FOILS_SUMMARY]);
  // Matches `DEFAULT_MARKETPLACE`, so a test that does not care about marketplace settles with no
  // observable change from the hook's own initial guess.
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
});

describe("useCollectionFolderList", () => {
  /**
   * **The card menu's hook, and the whole reason it is not `useCollectionFolders`.**
   *
   * `Add to → Collection` is built on five surfaces that draw no folder card and no subtotal, and
   * `collection_folder_summary` is a `GROUP BY` over every entry with a marketplace price
   * expression in it. Asserting the command is **not** called is the only way this stays true:
   * adding the summary back would leave every other test in this file green, because the folder
   * rows would be identical either way.
   */
  it("reads the folder list and asks for no summary", async () => {
    const { result } = renderHook(() => useCollectionFolderList(), { wrapper });

    await waitFor(() => expect(result.current.folders).toEqual([BINDER, FOILS]));
    expect(collectionFolderList).toHaveBeenCalledWith();
    expect(collectionFolderSummary).not.toHaveBeenCalled();
  });

  /** The same key both hooks read, which is what makes the split free: a page mounting each of
   *  them once asks the backend for the list once. */
  it("caches under the key the full hook reads, so the two share one answer", async () => {
    const { result } = renderHook(
      () => ({ list: useCollectionFolderList(), full: useCollectionFolders() }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.full.folders).toEqual([BINDER, FOILS]));
    expect(result.current.list.folders).toBe(result.current.full.folders);
    expect(collectionFolderList).toHaveBeenCalledTimes(1);
  });

  /** Empty is the ordinary answer and it is **one identity**, so a consumer memoising on this
   *  array does not see a new one every render while nothing is filed. */
  it("answers one stable empty array before the first read lands", () => {
    const { result, rerender } = renderHook(() => useCollectionFolderList(), { wrapper });
    const first = result.current.folders;

    expect(first).toEqual([]);
    rerender();
    expect(result.current.folders).toBe(first);
  });
});

describe("useCollectionFolders", () => {
  /** No argument, and none in the command either: a folder belongs to no entry, it files them. So
   *  there is one query for the whole app rather than one per row. */
  it("reads every folder there is, with no entry to scope it by", async () => {
    const { result } = renderHook(() => useCollectionFolders(), { wrapper });

    await waitFor(() => expect(result.current.folders).toEqual([BINDER, FOILS]));
    expect(collectionFolderList).toHaveBeenCalledWith();
    expect(client.getQueryData(["collection", "folders"])).toEqual([BINDER, FOILS]);
  });

  /** `null` is the root of the tree, and it is an argument with a meaning rather than an
   *  omission — the same `null` `collectionSetFolder` uses to un-file a copy. */
  it("makes a folder at the root and inside another one", async () => {
    const { result } = renderHook(() => useCollectionFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));

    await result.current.create.mutateAsync({ parentId: null, name: "Trade binder" });
    expect(collectionFolderCreate).toHaveBeenCalledWith(null, "Trade binder");

    await result.current.create.mutateAsync({ parentId: 1, name: "Foils" });
    expect(collectionFolderCreate).toHaveBeenCalledWith(1, "Foils");
  });

  it("renames and re-parents by id, and takes null back to the root", async () => {
    const { result } = renderHook(() => useCollectionFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));

    await result.current.rename.mutateAsync({ id: 1, name: "Binder" });
    expect(collectionFolderRename).toHaveBeenCalledWith(1, "Binder");

    await result.current.move.mutateAsync({ id: 2, parentId: null });
    expect(collectionFolderMove).toHaveBeenCalledWith(2, null);
  });

  /**
   * **The whole `["collection"]` root, not this hook's own key** — and a folder delete is the case
   * that proves why it has to be.
   *
   * Deleting a folder changes **entries** this hook never mentions: `delete_folder` re-files the
   * sub-tree by hand and the `ON DELETE SET NULL` behind it is the backstop, so the copies surface
   * at the root, filed nowhere. A page that refreshed only its folder list would go on drawing
   * them inside a folder that is not there.
   */
  it("refreshes every collection query after a folder write, not just the folder list", async () => {
    const { result } = renderHook(() => useCollectionFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.remove.mutateAsync(2);

    expect(collectionFolderDelete).toHaveBeenCalledWith(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["collection", "folders"] });
  });

  /**
   * **A refused write re-reads too**, and the rule lives on the mutation definition rather than on
   * a call site.
   *
   * Every refusal here is a busy database, one of the cabinet's four refusals in words, or a
   * folder another surface has already deleted — and the last must not leave a tree drawing a node
   * that is gone.
   */
  it("re-reads when a folder write is refused", async () => {
    collectionFolderMove.mockRejectedValue("A folder cannot be moved inside itself.");
    const { result } = renderHook(() => useCollectionFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await expect(result.current.move.mutateAsync({ id: 1, parentId: 2 })).rejects.toBe(
      "A folder cannot be moved inside itself.",
    );

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] }));
  });

  /** The summary is priced at `useMarketplace()`'s answer, and the query is keyed on it — never on
   *  a bare `["collection", "folderSummary"]` that both marketplaces would share. */
  it("prices the summary at the marketplace useMarketplace names, and keys the query by it", async () => {
    getMarketplace.mockResolvedValue("manapool");
    const { result } = renderHook(() => useCollectionFolders(), { wrapper });

    await waitFor(() => expect(result.current.summary.get(1)).toEqual(BINDER_SUMMARY));
    expect(result.current.summary.get(2)).toEqual(FOILS_SUMMARY);
    expect(collectionFolderSummary).toHaveBeenCalledWith("manapool");
    expect(client.getQueryData(["collection", "folderSummary", "manapool"])).toEqual([
      BINDER_SUMMARY,
      FOILS_SUMMARY,
    ]);
  });

  /**
   * **Two marketplaces are two cached answers, and neither may be served from the other's.** A
   * stale row is seeded under a different marketplace's key before the hook ever runs; if the
   * summary query were keyed on anything less than the marketplace id, TanStack would have happily
   * handed that row back instead of asking `collectionFolderSummary` at all.
   */
  it("never serves one marketplace's folder summary from the other's cached page", async () => {
    getMarketplace.mockResolvedValue("manapool");
    client.setQueryData(
      ["collection", "folderSummary", "cardkingdom"],
      [{ ...BINDER_SUMMARY, cards: 999 }],
    );

    const { result } = renderHook(() => useCollectionFolders(), { wrapper });

    await waitFor(() => expect(result.current.summary.get(1)).toEqual(BINDER_SUMMARY));
    expect(collectionFolderSummary).toHaveBeenCalledWith("manapool");
    // The other marketplace's cached page is untouched — proof the two answers never mixed.
    expect(client.getQueryData(["collection", "folderSummary", "cardkingdom"])).toEqual([
      { ...BINDER_SUMMARY, cards: 999 },
    ]);
  });

  /**
   * **An empty folder is missing from the summary, not zero in it** — `collection_folder_summary`
   * is a `GROUP BY` over `collection_entries`, so a drawer holding nothing emits no row. The map
   * has to answer a miss for it, which is what makes the folder list the census and this a lookup
   * layered onto it.
   */
  it("has no entry at all for a folder holding nothing", async () => {
    collectionFolderSummary.mockResolvedValue([BINDER_SUMMARY]);
    const { result } = renderHook(() => useCollectionFolders(), { wrapper });

    await waitFor(() => expect(result.current.summary.get(1)).toEqual(BINDER_SUMMARY));
    expect(result.current.summary.has(2)).toBe(false);
    // And the folder itself is still in the census, which is the half a tree is built from.
    expect(result.current.folders.map((f) => f.id)).toEqual([1, 2]);
  });

  /**
   * **`ids` is the whole level, in order — not a move, and not one folder's new index.**
   *
   * `sort_order` is written from position and `parent_id` from the argument, in one transaction,
   * so the single call below takes `Foils` out of `Trade binder` **and** puts it first at the
   * root. Pinning the array by value is what makes the order load-bearing: a hook that sent the
   * ids in any other arrangement would be writing a different `sort_order` to every row it named.
   */
  it("sends the whole level in order, with the parent that level belongs to", async () => {
    const { result } = renderHook(() => useCollectionFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));

    await result.current.reorder.mutateAsync({ parentId: null, ids: [2, 1] });
    expect(collectionFolderReorder).toHaveBeenCalledWith(null, [2, 1]);

    // `parentId` is passed through rather than derived from the ids — a level inside a drawer is
    // the same call with the drawer's own id, and `null` above was the root rather than an
    // omission.
    await result.current.reorder.mutateAsync({ parentId: 1, ids: [2] });
    expect(collectionFolderReorder).toHaveBeenLastCalledWith(1, [2]);
  });

  /**
   * **The one write on this page that settles on a key rather than a root**, and the assertion is
   * the exact call list rather than a pair of `toHaveBeenCalledWith`s, because three different
   * failures are worth catching at once.
   *
   * Dropping the invalidation leaves a tree drawing yesterday's order. Widening it to
   * `["collection"]` — which is what the other five folder writes take, and rightly, since a
   * delete re-files copies — refetches the table, the header and `collection_folder_summary`, a
   * `GROUP BY` over every entry carrying a price expression, to redraw a row of folder cards.
   * And adding `["decks"]` — which {@link useSetCollectionFolder} takes, and rightly, because
   * filing a copy is how one enters or leaves a deck's group since schema v25 — would be copying
   * the largest set in the file onto the one write that moves no `collection_entries.folder_id`
   * at all.
   */
  it("re-reads the folder list after a reorder, and nothing else", async () => {
    const { result } = renderHook(() => useCollectionFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.reorder.mutateAsync({ parentId: null, ids: [2, 1] });

    expect(invalidate.mock.calls).toEqual([[{ queryKey: ["collection", "folders"] }]]);
  });

  /** A refused reorder re-reads too, `move`'s rule: the refusal is a busy database, a cycle, or an
   *  id in `ids` another surface has already deleted — and the last leaves a tree drawing a node
   *  that is gone. */
  it("re-reads the folder list when a reorder is refused", async () => {
    collectionFolderReorder.mockRejectedValue("A folder cannot be moved inside itself.");
    const { result } = renderHook(() => useCollectionFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await expect(result.current.reorder.mutateAsync({ parentId: 2, ids: [1] })).rejects.toBe(
      "A folder cannot be moved inside itself.",
    );

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection", "folders"] }),
    );
  });

  /** Both ways round, by id, and the flag is the argument rather than a toggle the hook works
   *  out for itself — the row the reader pressed is not always the row the badge is drawn from,
   *  because the lock inherits. */
  it("sets and clears a folder's own lock by id", async () => {
    const { result } = renderHook(() => useCollectionFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));

    await result.current.setLocked.mutateAsync({ id: 1, locked: true });
    expect(collectionFolderSetLocked).toHaveBeenCalledWith(1, true);

    await result.current.setLocked.mutateAsync({ id: 1, locked: false });
    expect(collectionFolderSetLocked).toHaveBeenLastCalledWith(1, false);
  });

  /**
   * **The whole `["collection"]` root, and the exact call list is the assertion** — because the
   * plausible mistake here is the narrow settle beside it rather than no settle at all.
   *
   * A reorder settles on `["collection", "folders"]` alone, and rightly: it moves no
   * `collection_entries.folder_id`, so every number counted from entries is still true. A lock
   * moves none either, and yet it is the opposite case — the collection page asks its list with
   * `excludeLocked`, so setting a folder aside changes **which rows come back**, and with them
   * the header's totals and the count. A `settleOrder` here would leave the table drawing the
   * copies the reader has just put away, and `lib/query.ts`'s `staleTime: 30_000` means a
   * mounted observer that is merely stale never refetches on its own.
   */
  it("refreshes every collection query after a lock, not just the folder list", async () => {
    const { result } = renderHook(() => useCollectionFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.setLocked.mutateAsync({ id: 1, locked: true });

    expect(invalidate.mock.calls).toEqual([[{ queryKey: ["collection"] }]]);
  });

  /** A refused lock re-reads too, `writes`' rule: the refusal is a busy database or a folder
   *  another surface has already deleted, and the second must not leave a tree drawing a node
   *  that is gone. */
  it("re-reads when a lock is refused", async () => {
    collectionFolderSetLocked.mockRejectedValue("That folder belongs to the app.");
    const { result } = renderHook(() => useCollectionFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await expect(result.current.setLocked.mutateAsync({ id: 1, locked: true })).rejects.toBe(
      "That folder belongs to the app.",
    );

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] }));
  });
});
