import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionFolder } from "@/lib/ipc";

const collectionFolderList = vi.hoisted(() => vi.fn());
const wishlistFolderList = vi.hoisted(() => vi.fn());
const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
const collectionSetFolder = vi.hoisted(() => vi.fn());
const collectionSetFolderMany = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionFolderList,
    wishlistFolderList,
    getMarketplace,
    marketplaceFeedStatus,
    collectionSetFolder,
    collectionSetFolderMany,
  },
}));

import { resetBulkUndo, useBulkUndo } from "@/lib/bulkUndo";
import { useCardMenuDeps } from "./useCardMenuDeps";

const BINDER: CollectionFolder = {
  id: 3,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
  syncUid: "uid-binder",
};

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  collectionFolderList.mockReset().mockResolvedValue([BINDER]);
  wishlistFolderList.mockReset().mockResolvedValue([]);
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
  collectionSetFolder.mockReset().mockResolvedValue({ id: 7, quantity: 1, removed: false });
  collectionSetFolderMany.mockReset().mockResolvedValue({ changes: [], undoId: 77 });
  resetBulkUndo();
});

/**
 * `moveCopies` — the card menu's `Move N cards to` as **one** write (issue #555), where it used to
 * loop `moveToFolder`. What a surface with no copy picker of its own reaches.
 */
describe("useCardMenuDeps — moveCopies", () => {
  async function mounted() {
    const hook = renderHook(() => useCardMenuDeps(), { wrapper });
    // The cabinet has answered, so the destination can be named.
    await waitFor(() => expect(hook.result.current.deps.collectionFolders).toHaveLength(1));
    return hook;
  }

  it("files every entry in one write and offers it back by the drawer's name", async () => {
    const { result } = await mounted();

    act(() => result.current.deps.moveCopies?.([7, 8], 3));

    await waitFor(() => expect(collectionSetFolderMany).toHaveBeenCalledTimes(1));
    expect(collectionSetFolderMany).toHaveBeenCalledWith([7, 8], 3);
    expect(collectionSetFolder).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(useBulkUndo.getState().offers.collection?.label).toBe(
        "Moved 2 cards to Trade binder.",
      ),
    );
  });

  it("names the root as the collection", async () => {
    const { result } = await mounted();
    act(() => result.current.deps.moveCopies?.([7, 8], null));
    await waitFor(() =>
      expect(useBulkUndo.getState().offers.collection?.label).toBe("Moved 2 cards to Collection."),
    );
    expect(collectionSetFolderMany).toHaveBeenCalledWith([7, 8], null);
  });

  /** A menu has closed by the time the answer arrives, so the refusal is the page's to draw. */
  it("hands a refusal to the page, and says none of them moved", async () => {
    collectionSetFolderMany.mockRejectedValue("That entry is in a deck.");
    const { result } = await mounted();

    act(() => result.current.deps.moveCopies?.([7, 8], 3));

    await waitFor(() =>
      expect(result.current.error).toBe("Could not move those cards — That entry is in a deck."),
    );
    expect(useBulkUndo.getState().offers.collection).toBeNull();
  });
});
