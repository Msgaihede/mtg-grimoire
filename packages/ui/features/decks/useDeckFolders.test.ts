import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { DeckFolder } from "@/lib/ipc";

const deckFolderList = vi.hoisted(() => vi.fn());
const deckFolderCreate = vi.hoisted(() => vi.fn());
const deckFolderRename = vi.hoisted(() => vi.fn());
const deckFolderMove = vi.hoisted(() => vi.fn());
const deckFolderReorder = vi.hoisted(() => vi.fn());
const deckFolderDelete = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckFolderList,
    deckFolderCreate,
    deckFolderRename,
    deckFolderMove,
    deckFolderReorder,
    deckFolderDelete,
  },
}));

import { useDeckFolders } from "./useDeckFolders";

/** Two folders, one inside the other — flat rows, because the tree is the reader's to build
 *  from `parentId` and `deck_folders` has no notion of depth. */
const EDH: DeckFolder = { id: 1, parentId: null, name: "Commander", sortOrder: 0 };
const LEGENDS: DeckFolder = { id: 2, parentId: 1, name: "Legends", sortOrder: 0 };

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  deckFolderList.mockReset().mockResolvedValue([EDH, LEGENDS]);
  deckFolderCreate.mockReset().mockResolvedValue(LEGENDS);
  deckFolderRename.mockReset().mockResolvedValue({ ...EDH, name: "EDH" });
  deckFolderMove.mockReset().mockResolvedValue({ ...LEGENDS, parentId: null });
  // The whole cabinet, flat, as it now stands — `deck_meta::reorder_folders` ends in the same
  // `list_folders` the plain read does, so this is not scoped to the level that was written.
  deckFolderReorder
    .mockReset()
    .mockResolvedValue([{ ...LEGENDS, parentId: null, sortOrder: 0 }, { ...EDH, sortOrder: 1 }]);
  deckFolderDelete.mockReset().mockResolvedValue(undefined);
});

describe("useDeckFolders", () => {
  /** No argument, and none in the command either: a folder belongs to no deck, it files them.
   *  So there is one query for the whole app rather than one per deck. */
  it("reads every folder there is, with no deck to scope it by", async () => {
    const { result } = renderHook(() => useDeckFolders(), { wrapper });

    await waitFor(() => expect(result.current.folders).toEqual([EDH, LEGENDS]));
    expect(deckFolderList).toHaveBeenCalledWith();
    expect(client.getQueryData(["decks", "folders"])).toEqual([EDH, LEGENDS]);
  });

  /** `null` is the root of the tree, and it is an argument with a meaning rather than an
   *  omission — the same `null` `deckSetFolder` uses to un-file a deck. */
  it("makes a folder at the root and inside another one", async () => {
    const { result } = renderHook(() => useDeckFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));

    await result.current.create.mutateAsync({ parentId: null, name: "Commander" });
    expect(deckFolderCreate).toHaveBeenCalledWith(null, "Commander");

    await result.current.create.mutateAsync({ parentId: 1, name: "Legends" });
    expect(deckFolderCreate).toHaveBeenCalledWith(1, "Legends");
  });

  it("renames and re-parents by id, and takes null back to the root", async () => {
    const { result } = renderHook(() => useDeckFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));

    await result.current.rename.mutateAsync({ id: 1, name: "EDH" });
    expect(deckFolderRename).toHaveBeenCalledWith(1, "EDH");

    await result.current.move.mutateAsync({ id: 2, parentId: null });
    expect(deckFolderMove).toHaveBeenCalledWith(2, null);
  });

  /**
   * **The whole `["decks"]` root, not this hook's own key** — and a folder delete is the case
   * that proves why it has to be.
   *
   * `decks.folder_id` is `ON DELETE SET NULL`, so deleting a folder changes **decks** this hook
   * never mentions: they surface at the root, filed nowhere. A gallery that refreshed only its
   * folder list would go on drawing them inside a folder that is not there.
   */
  it("refreshes every deck query after a folder write, not just the folder list", async () => {
    const { result } = renderHook(() => useDeckFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.remove.mutateAsync(2);

    expect(deckFolderDelete).toHaveBeenCalledWith(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["decks", "folders"] });
  });

  /**
   * **A refused write re-reads too**, and the rule lives on the mutation definition rather than
   * on a call site — `useDeck`'s reasoning, applied to the surface that has the same shape.
   *
   * Every refusal here is a busy database or a folder another surface has already deleted, and
   * the second must not leave a tree drawing a node that is gone.
   */
  it("re-reads when a folder write is refused", async () => {
    deckFolderMove.mockRejectedValue("A folder cannot be moved inside itself.");
    const { result } = renderHook(() => useDeckFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await expect(result.current.move.mutateAsync({ id: 1, parentId: 2 })).rejects.toBe(
      "A folder cannot be moved inside itself.",
    );

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] }));
  });

  /**
   * **`ids` is the whole level, in order — not a move, and not one folder's new index.**
   *
   * `sort_order` is written from position and `parent_id` from the argument, in one transaction,
   * so the single call below takes `Legends` out of `Commander` **and** puts it first at the root.
   * Pinning the array by value is what makes the order load-bearing: a hook that sent the ids in
   * any other arrangement would be writing a different `sort_order` to every row it named.
   */
  it("sends the whole level in order, with the parent that level belongs to", async () => {
    const { result } = renderHook(() => useDeckFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));

    await result.current.reorder.mutateAsync({ parentId: null, ids: [2, 1] });
    expect(deckFolderReorder).toHaveBeenCalledWith(null, [2, 1]);

    // `parentId` is passed through rather than derived from the ids — a level inside a folder is
    // the same call with the folder's own id, and `null` above was the root rather than an
    // omission.
    await result.current.reorder.mutateAsync({ parentId: 1, ids: [2] });
    expect(deckFolderReorder).toHaveBeenLastCalledWith(1, [2]);
  });

  /**
   * **The one write in this hook that does not take the whole `["decks"]` root**, and the
   * assertion is the exact call list rather than a pair of `toHaveBeenCalledWith`s, because both
   * halves of the claim are failures worth catching: dropping the invalidation leaves a tree
   * drawing yesterday's order, and widening it to `["decks"]` refetches the gallery, every open
   * deck's categories, its audit and its undo cursor to redraw a row of folder cards.
   *
   * A reorder writes `deck_folders.sort_order` and `deck_folders.parent_id` and nothing else — no
   * deck's `folder_id` moves, because the folder a deck is filed in is the same folder afterwards
   * and is merely sitting somewhere else.
   */
  it("re-reads the folder list after a reorder, and nothing else under decks", async () => {
    const { result } = renderHook(() => useDeckFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.reorder.mutateAsync({ parentId: null, ids: [2, 1] });

    expect(invalidate.mock.calls).toEqual([[{ queryKey: ["decks", "folders"] }]]);
  });

  /** A refused reorder re-reads too, `move`'s rule: the refusal is a busy database or an id in
   *  `ids` another surface has already deleted, and the second leaves a tree drawing a node that
   *  is gone. */
  it("re-reads the folder list when a reorder is refused", async () => {
    deckFolderReorder.mockRejectedValue("A folder cannot be moved inside itself.");
    const { result } = renderHook(() => useDeckFolders(), { wrapper });
    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await expect(result.current.reorder.mutateAsync({ parentId: 2, ids: [1] })).rejects.toBe(
      "A folder cannot be moved inside itself.",
    );

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks", "folders"] }),
    );
  });
});
