/**
 * A picked set off the search column let go on a collection shelf — **one** `collection_add_many`
 * for the set (2026-11-18), where it was one `collection_add` per card fired together, and one
 * receipt. The page's own drag tests (`CollectionPage.test.tsx`) carry the gesture; these pin the
 * write and the sentence.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const collectionAdd = vi.hoisted(() => vi.fn());
const collectionAddMany = vi.hoisted(() => vi.fn());
const collectionSetFolderMany = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { collectionAdd, collectionAddMany, collectionSetFolderMany },
}));

import { useBulkUndo } from "@/lib/bulkUndo";
import { useNotifications } from "@/lib/notifications";
import type { CollectionFolder } from "@/lib/ipc";
import type { CollectionSingleDrop } from "./collectionDrag";
import { useCollectionDrops } from "./useCollectionDrops";
import { useSetCollectionFolderMany } from "./useCollectionFolders";

const BINDER = 3;

const card = (cardId: string): CollectionSingleDrop => ({
  kind: "new",
  card: { cardId, name: `Card ${cardId}`, finish: "nonfoil", oracleId: `o-${cardId}` },
});

function mounted() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(
    () =>
      useCollectionDrops({
        census: [],
        userFolders: [],
        deckGroups: [],
        lockedIds: new Set(),
        nodes: [],
        treeParent: new Map(),
        folderNameOf: (id) => (id === BINDER ? "Binder" : null),
        setFolder: vi.fn(),
        moveCopy: vi.fn(),
        moveMany: vi.fn(),
        reorder: vi.fn(),
        setPicking: vi.fn(),
      }),
    { wrapper },
  );
  return { ...hook, invalidate };
}

const notices = () => useNotifications.getState().notices;

beforeEach(() => {
  collectionAdd.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
  collectionAddMany
    .mockReset()
    .mockImplementation((items: readonly unknown[]) =>
      Promise.resolve({ added: items.length, copies: items.length, refused: [], undoId: 50 }),
    );
});

describe("useCollectionDrops — a picked set off the search column", () => {
  it("adds the set in one write and one refresh, says it once and offers it back", async () => {
    const { result, invalidate } = mounted();
    const set = Array.from({ length: 50 }, (_, i) => card(`c${i}`));
    act(() => result.current.commitFile({ kind: "group", members: set }, BINDER));

    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(collectionAdd).not.toHaveBeenCalled();
    expect(collectionAddMany).toHaveBeenCalledTimes(1);
    const items = collectionAddMany.mock.calls[0][0] as readonly Record<string, unknown>[];
    expect(items).toHaveLength(50);
    // Each item the single drop's add: the drag's finish, no grade named, one copy, the shelf.
    expect(items[0]).toEqual({
      cardId: "c0",
      finish: "nonfoil",
      condition: "NONE",
      quantity: 1,
      folderId: BINDER,
    });
    expect(notices()[0]).toMatchObject({ title: "Added 50 cards to “Binder”", tone: "success" });
    expect(useBulkUndo.getState().offers.collection).toMatchObject({
      id: 50,
      label: "Added 50 cards to Binder.",
    });
    const roots = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(roots.filter((key) => key === '["collection"]')).toHaveLength(1);
  });

  it("folds a partial refusal into one warning", async () => {
    collectionAddMany.mockResolvedValue({
      added: 2,
      copies: 2,
      refused: [{ index: 1, reason: "that card is not in the database" }],
      undoId: 51,
    });
    const { result } = mounted();
    act(() =>
      result.current.commitFile(
        { kind: "group", members: [card("a"), card("b"), card("c")] },
        BINDER,
      ),
    );

    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(notices()[0]).toMatchObject({
      tone: "warning",
      title: "Added 2 cards to “Binder”",
      body: "1 card couldn't be added — that card is not in the database",
    });
  });

  it("says a refused call as the error arm", async () => {
    collectionAddMany.mockRejectedValue("database is busy");
    const { result } = mounted();
    act(() =>
      result.current.commitFile({ kind: "group", members: [card("a"), card("b")] }, BINDER),
    );

    await waitFor(() =>
      expect(notices()[0]).toMatchObject({
        tone: "error",
        title: "Couldn't add 2 cards to “Binder”",
        body: "database is busy",
      }),
    );
    expect(useBulkUndo.getState().offers.collection).toBeNull();
  });

  it("keeps the single add for a set of one", async () => {
    const { result } = mounted();
    act(() => result.current.commitFile({ kind: "group", members: [card("a")] }, BINDER));

    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(collectionAdd).toHaveBeenCalledTimes(1);
    expect(collectionAddMany).not.toHaveBeenCalled();
    expect(notices()[0]).toMatchObject({ title: "Added “Card a” to “Binder”" });
  });
});

/**
 * **A set mixing new cards with rows already in the collection is one press and two writes**
 * (issue #1164 review). Each bulk half's hook offered its own ticket on the collection's one scope
 * and whichever answered last won — so Undo took back half the press. With the real hooks: a mixed
 * press offers nothing, and takes down an older press's offer.
 */
describe("useCollectionDrops — a picked set mixing new cards and entries", () => {
  it("offers no undo for either half", async () => {
    let moved: (outcome: unknown) => void = () => {};
    collectionSetFolderMany
      .mockReset()
      .mockImplementation(() => new Promise((resolve) => (moved = resolve)));
    useBulkUndo.getState().offer({ id: 7, scope: "collection", label: "Imported 40 cards." });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const binder = { id: BINDER, name: "Binder", kind: "user" } as CollectionFolder;
    const { result } = renderHook(
      () => {
        const moveMany = useSetCollectionFolderMany().mutateAsync;
        return useCollectionDrops({
          census: [binder],
          userFolders: [binder],
          deckGroups: [],
          lockedIds: new Set(),
          nodes: [],
          treeParent: new Map(),
          folderNameOf: (id) => (id === BINDER ? "Binder" : null),
          setFolder: vi.fn(),
          moveCopy: vi.fn(),
          moveMany,
          reorder: vi.fn(),
          setPicking: vi.fn(),
        });
      },
      { wrapper },
    );
    const entry = (entryId: number): CollectionSingleDrop => ({
      kind: "entry",
      entry: { entryId, name: `Entry ${entryId}`, folderId: null },
    });

    act(() =>
      result.current.commitFile(
        { kind: "group", members: [card("a"), entry(20), card("b"), entry(21)] },
        BINDER,
      ),
    );
    await waitFor(() => expect(collectionAddMany).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(collectionSetFolderMany).toHaveBeenCalledTimes(1));
    // The move answers after the add, which is the order that left the move's half on offer.
    await act(async () => moved({ changes: [], undoId: 60 }));

    await waitFor(() => expect(notices()).toHaveLength(2));
    expect(useBulkUndo.getState().offers.collection).toBeNull();
  });
});
