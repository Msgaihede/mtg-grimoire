import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { DeckFolder } from "@/lib/ipc";

const deckFolderList = vi.hoisted(() => vi.fn());
const deckFolderCreate = vi.hoisted(() => vi.fn());
const deckFolderRename = vi.hoisted(() => vi.fn());
const deckFolderMove = vi.hoisted(() => vi.fn());
const deckFolderDelete = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckFolderList, deckFolderCreate, deckFolderRename, deckFolderMove, deckFolderDelete },
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
});
