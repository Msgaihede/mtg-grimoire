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
const collectionAdd = vi.hoisted(() => vi.fn());
const wishlistAdd = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionFolderList,
    wishlistFolderList,
    getMarketplace,
    marketplaceFeedStatus,
    collectionSetFolder,
    collectionSetFolderMany,
    collectionAdd,
    wishlistAdd,
  },
}));

import { resetBulkUndo, useBulkUndo } from "@/lib/bulkUndo";
import { useNotifications } from "@/lib/notifications";
import type { CardMenuTarget } from "./cardMenu";
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
  collectionAdd.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
  wishlistAdd.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
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

  /** A menu has closed by the time the answer arrives, so the answer is a toast. */
  it("says a move with one toast, and a refusal as an error naming the count", async () => {
    const { result } = await mounted();
    act(() => result.current.deps.moveCopies?.([7, 8], 3));
    await waitFor(() =>
      expect(useNotifications.getState().notices[0]?.title).toBe("Moved 2 cards to “Trade binder”"),
    );

    collectionSetFolderMany.mockRejectedValue("That entry is in a deck.");
    act(() => result.current.deps.moveCopies?.([7, 8], 3));
    await waitFor(() =>
      expect(useNotifications.getState().notices[0]).toMatchObject({
        title: "Couldn't move 2 cards to “Trade binder”",
        body: "That entry is in a deck.",
        tone: "error",
      }),
    );
  });
});

const card = (cardId: string, name: string): CardMenuTarget => ({
  cardId,
  name,
  setCode: "lea",
  collectorNumber: "1",
  oracleId: `o-${cardId}`,
  finishes: null,
});

/**
 * The adds and the single move — **one toast per press**, the owner's rule: a picked set's
 * `Add 3 cards to → Collection` calls the dep once per card in one tick, and the reader made one
 * press.
 */
describe("useCardMenuDeps — receipts", () => {
  async function mounted() {
    const hook = renderHook(() => useCardMenuDeps(), { wrapper });
    await waitFor(() => expect(hook.result.current.deps.collectionFolders).toHaveLength(1));
    return hook;
  }

  it("names one card added to the collection", async () => {
    const { result } = await mounted();
    act(() => result.current.deps.addToCollection(card("a", "Sol Ring"), "nonfoil", null));
    await waitFor(() =>
      expect(useNotifications.getState().notices[0]).toMatchObject({
        title: "Added “Sol Ring” to your collection",
        tone: "success",
      }),
    );
  });

  it("says a picked set's add as exactly one notice with the count", async () => {
    const { result } = await mounted();
    act(() => {
      // What `buildCardMenu`'s `fileAll` does for a picked set: one call per card, one tick.
      for (const name of ["Sol Ring", "Arcane Signet", "Mind Stone"]) {
        result.current.deps.addToCollection(card(name, name), "nonfoil", 3);
      }
    });
    await waitFor(() => expect(useNotifications.getState().notices).toHaveLength(1));
    expect(useNotifications.getState().notices[0]?.title).toBe("Added 3 cards to “Trade binder”");
    expect(collectionAdd).toHaveBeenCalledTimes(3);
  });

  it("folds a partly refused set into one warning carrying the first refusal", async () => {
    wishlistAdd
      .mockResolvedValueOnce({ id: 1, quantity: 1, removed: false })
      .mockRejectedValueOnce("The wishlist is locked")
      .mockRejectedValueOnce("Something else");
    const { result } = await mounted();
    act(() => {
      for (const name of ["Sol Ring", "Arcane Signet", "Mind Stone"]) {
        result.current.deps.addToWishlist(card(name, name), null);
      }
    });
    await waitFor(() => expect(useNotifications.getState().notices).toHaveLength(1));
    expect(useNotifications.getState().notices[0]).toMatchObject({
      title: "Added 1 of 3 cards to your wishlist",
      body: "The wishlist is locked",
      tone: "warning",
    });
  });

  it("says a refused single add as an error naming the card", async () => {
    wishlistAdd.mockRejectedValue("The wishlist is locked");
    const { result } = await mounted();
    act(() => result.current.deps.addToWishlist(card("a", "Sol Ring"), null));
    await waitFor(() =>
      expect(useNotifications.getState().notices[0]).toMatchObject({
        title: "Couldn't add “Sol Ring” to your wishlist",
        body: "The wishlist is locked",
        tone: "error",
      }),
    );
  });

  it("names the card a single move filed, and where", async () => {
    const { result } = await mounted();
    act(() => result.current.deps.moveToFolder?.(7, 3, "Sol Ring"));
    await waitFor(() =>
      expect(useNotifications.getState().notices[0]?.title).toBe(
        "Moved “Sol Ring” to “Trade binder”",
      ),
    );
  });
});
