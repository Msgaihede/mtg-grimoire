/**
 * A picked set let go on a wishlist shelf — **at most two writes whatever its size** (2026-11-18):
 * the cards off the search column in one `wishlist_add_many`, the wishes already on the list in one
 * `wishlist_set_folder_many`, and one receipt for the press. The page's own drag tests
 * (`WishlistPage.test.tsx`) carry the gesture; these pin the writes and the sentence.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const wishlistAdd = vi.hoisted(() => vi.fn());
const wishlistAddMany = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { wishlistAdd, wishlistAddMany },
}));

import { useBulkUndo } from "@/lib/bulkUndo";
import type { WishlistFolder } from "@/lib/ipc";
import { useNotifications } from "@/lib/notifications";
import { useWishDrops } from "./useWishDrops";
import type { WishSingleDrop } from "./wishDrag";

const ORDERED: WishlistFolder = {
  rules: [],
  id: 4,
  parentId: null,
  name: "Ordered",
  sortOrder: 0,
  managedDeckId: null,
  managedTokens: false,
  syncUid: null,
  managedDeckUid: null,
};

const card = (cardId: string): WishSingleDrop => ({
  kind: "new",
  card: { cardId, name: cardId, finish: "nonfoil", oracleId: `o-${cardId}` },
});
const wish = (wishId: number): WishSingleDrop => ({
  kind: "wish",
  wish: { wishId, name: `wish ${wishId}`, folderId: null },
});

const moveWish = vi.fn();
const moveWishes = vi.fn();

function mounted() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(
    () =>
      useWishDrops({
        census: [ORDERED],
        userNodes: [],
        treeParent: new Map(),
        managed: new Set(),
        setFolder: vi.fn(),
        moveWish,
        moveWishes,
        reorder: vi.fn(),
        settleWhole: vi.fn(),
      }),
    { wrapper },
  );
}

const notices = () => useNotifications.getState().notices;

beforeEach(() => {
  wishlistAdd.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
  wishlistAddMany
    .mockReset()
    .mockImplementation((items: readonly unknown[]) =>
      Promise.resolve({ added: items.length, copies: items.length, refused: [], undoId: 30 }),
    );
  moveWish.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
  moveWishes.mockReset().mockResolvedValue({ changes: [], undoId: 31 });
});

describe("useWishDrops — a picked set dropped on a shelf", () => {
  it("makes one add-many and one set-folder-many for a set of new cards and wishes", async () => {
    const { result } = mounted();
    act(() =>
      result.current.fileWish(
        { kind: "group", members: [card("a"), wish(10), card("b"), wish(11)] },
        ORDERED.id,
      ),
    );

    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(wishlistAddMany).toHaveBeenCalledTimes(1);
    // Each item the single drop's add: one copy, the printing's own finish, the shelf.
    expect(wishlistAddMany).toHaveBeenCalledWith([
      { cardId: "a", quantity: 1, preferredFinish: "nonfoil", folderId: ORDERED.id },
      { cardId: "b", quantity: 1, preferredFinish: "nonfoil", folderId: ORDERED.id },
    ]);
    expect(moveWishes).toHaveBeenCalledExactlyOnceWith({
      ids: [10, 11],
      folderId: ORDERED.id,
      destination: "Ordered",
    });
    expect(wishlistAdd).not.toHaveBeenCalled();
    expect(moveWish).not.toHaveBeenCalled();
    expect(notices()[0]).toMatchObject({ title: "Moved 4 wishes to “Ordered”", tone: "success" });
    // The add's ticket is offered on the wishlist page (the move's is its hook's, mocked here).
    expect(useBulkUndo.getState().offers.wishlist).toMatchObject({
      id: 30,
      label: "Added 2 cards to Ordered.",
    });
  });

  it("keeps the single commands for a half of exactly one", async () => {
    const { result } = mounted();
    act(() =>
      result.current.fileWish({ kind: "group", members: [card("a"), wish(10)] }, ORDERED.id),
    );

    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(wishlistAdd).toHaveBeenCalledTimes(1);
    expect(moveWish).toHaveBeenCalledExactlyOnceWith({ id: 10, folderId: ORDERED.id });
    expect(wishlistAddMany).not.toHaveBeenCalled();
    expect(moveWishes).not.toHaveBeenCalled();
  });

  it("folds a refused move and a partly refused add into one warning, first refusal first", async () => {
    moveWishes.mockRejectedValue("That folder is gone.");
    wishlistAddMany.mockResolvedValue({
      added: 1,
      copies: 1,
      refused: [{ index: 1, reason: "That printing is not there any more." }],
      undoId: 32,
    });
    const { result } = mounted();
    act(() =>
      result.current.fileWish(
        { kind: "group", members: [card("a"), card("b"), wish(10), wish(11)] },
        ORDERED.id,
      ),
    );

    await waitFor(() => expect(notices()).toHaveLength(1));
    // In the order dropped: `b` is refused before either wish is.
    expect(notices()[0]).toMatchObject({
      tone: "warning",
      title: "Moved 1 wish to “Ordered”",
      body: "3 wishes couldn't be moved — That printing is not there any more.",
    });
  });

  it("says a set that landed nothing as the error arm", async () => {
    wishlistAddMany.mockRejectedValue("database is busy");
    const { result } = mounted();
    act(() =>
      result.current.fileWish({ kind: "group", members: [card("a"), card("b")] }, ORDERED.id),
    );

    await waitFor(() =>
      expect(notices()[0]).toMatchObject({
        tone: "error",
        title: "Couldn't add 2 wishes to “Ordered”",
        body: "database is busy",
      }),
    );
  });
});
