import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { DeckRow } from "@/lib/ipc";

const deckList = vi.hoisted(() => vi.fn());
const deckCreate = vi.hoisted(() => vi.fn());
const deckUpdate = vi.hoisted(() => vi.fn());
const deckDelete = vi.hoisted(() => vi.fn());
const deckDuplicate = vi.hoisted(() => vi.fn());
const deckSetFolder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckList,
    deckCreate,
    deckUpdate,
    deckDelete,
    deckDuplicate,
    deckSetFolder,
  },
}));

import { useDecks } from "./useDecks";

const BURN: DeckRow = {
  gameKey: "any",
  id: 4,
  name: "Burn",
  formatKey: "modern",
  formatName: "Modern",
  description: null,
  coverCardId: null,
  coverArtist: null,
  archived: false,
  cardCount: 60,
  updatedAt: 1_800_000_000,
  // The four v8 deck columns, the three v12 view-state ones and `separateXGroup` from v13.
  // Every real row carries all eight, so the fixture does too — and `folderId` is the one this
  // hook can never write: filing is `deckSetFolder`, because a patch reads a bound null as
  // "leave it" and so cannot reach the root of the tree.
  coverKind: "card_art",
  folderId: null,
  notes: null,
  theoryEnabled: false,
  // How the editor was last read — written by `deckSetViewState` and by nothing this hook
  // offers, since looking at a deck is not editing one.
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  defaultCategoryId: 0,
};

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  deckList.mockReset().mockResolvedValue([BURN]);
  deckCreate.mockReset().mockResolvedValue(BURN);
  deckUpdate.mockReset().mockResolvedValue({ ...BURN, archived: true });
  deckDelete.mockReset().mockResolvedValue(undefined);
  deckDuplicate.mockReset().mockResolvedValue({ ...BURN, id: 5, name: "Burn (copy)" });
  deckSetFolder.mockReset().mockResolvedValue({ ...BURN, folderId: 1 });
});

/**
 * `useDeck.test.ts`'s helper and its reasoning — a `staleTime: 30_000` cache is *fresh*, so
 * `isInvalidated` is the whole of what tells the Collection page anything happened.
 *
 * The decks root is stood for by an open editor's **detail** key rather than by `["decks",
 * "list"]`, which is this hook's own query: `invalidateQueries` refetches an *observed* query
 * and clears the flag again when the answer lands, so the list would be a race. Everything here
 * is unobserved and stays marked.
 */
const OWNED_CACHES: readonly (readonly string[])[] = [
  ["collection", "list", "{}"],
  ["cards", "search", "{}"],
  ["decks", "detail", "4", "live", "tcgplayer"],
  ["wishlist", "list", "{}"],
];

function seedOwned(c: QueryClient): void {
  for (const key of OWNED_CACHES) c.setQueryData(key, { items: [], total: 0 });
}

const staleRoots = (c: QueryClient): string[] =>
  OWNED_CACHES.filter((key) => c.getQueryState(key)?.isInvalidated === true)
    .map((key) => key[0])
    .sort();

/**
 * **Since schema v25 four of these five writes move `collection_folders` rows**, so the
 * collection root is not optional: `deck_create` and `deck_duplicate` insert the deck's group,
 * a rename renames it, and `deck_delete` files every copy the group held into `Recently removed`
 * and drops the folder. The wishlist and the card search are still provably unmoved — no
 * quantity changes and no printing is added or dropped — so firing those would be refetches
 * that can only answer what is already on screen.
 */
describe("useDecks invalidation", () => {
  it("marks the decks and the collection stale when a deck is deleted", async () => {
    seedOwned(client);
    const { result } = renderHook(() => useDecks(), { wrapper });
    await waitFor(() => expect(result.current.decks).toEqual([BURN]));
    // The list query above is seeded *and* observed, so re-seed it after the read landed —
    // this is about what the write marks, not about what the mount did.
    seedOwned(client);
    expect(staleRoots(client)).toEqual([]);

    await result.current.remove.mutateAsync(4);

    await waitFor(() => expect(staleRoots(client)).toEqual(["collection", "decks"]));
  });
});

describe("useDecks", () => {
  /** `["decks", "list"]` under the `["decks"]` root every deck write invalidates — the
   *  gallery and the open editor are one cache, so a rename reaches both. */
  it("reads the gallery under the decks root", async () => {
    const { result } = renderHook(() => useDecks(), { wrapper });

    await waitFor(() => expect(result.current.decks).toEqual([BURN]));
    expect(client.getQueryData(["decks", "list"])).toEqual([BURN]);
  });

  /**
   * The **root**, not `["decks", "list"]`, from all four: a rename changes the tile *and* the
   * header of the editor that deck is open in, and archiving reorders a gallery the editor is
   * open on top of. Invalidating only the list would leave a detail on screen describing the
   * deck as it was.
   */
  it("refreshes every deck query after each of the four gallery writes", async () => {
    const { result } = renderHook(() => useDecks(), { wrapper });
    await waitFor(() => expect(result.current.decks).toEqual([BURN]));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.create.mutateAsync({ name: "Burn", formatKey: "modern" });
    expect(deckCreate).toHaveBeenCalledWith({ name: "Burn", formatKey: "modern" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });

    invalidate.mockClear();
    await result.current.update.mutateAsync({ id: 4, patch: { archived: true } });
    expect(deckUpdate).toHaveBeenCalledWith(4, { archived: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });

    invalidate.mockClear();
    await result.current.remove.mutateAsync(4);
    expect(deckDelete).toHaveBeenCalledWith(4);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });

    invalidate.mockClear();
    await result.current.duplicate.mutateAsync(4);
    expect(deckDuplicate).toHaveBeenCalledWith(4);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
  });

  /**
   * **The four writes that move a `collection_folders` row say so**, which is the gap this file
   * carried from schema v25 until 2026-08-23: `deck_create` and `deck_duplicate` insert the
   * deck's group, `deck_delete` files every copy it held into `Recently removed` and drops the
   * folder, and a rename renames it. The collection page's tree, its list, its summary and both
   * folder cards are all wrong afterwards, and `["decks"]` reaches none of them.
   */
  it("refreshes the collection after the four writes that move a folder", async () => {
    const { result } = renderHook(() => useDecks(), { wrapper });
    await waitFor(() => expect(result.current.decks).toEqual([BURN]));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    for (const write of [
      () => result.current.create.mutateAsync({ name: "Burn", formatKey: "modern" }),
      () => result.current.remove.mutateAsync(4),
      () => result.current.duplicate.mutateAsync(4),
      () => result.current.update.mutateAsync({ id: 4, patch: { name: "Burn II" } }),
    ]) {
      invalidate.mockClear();
      await write();
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] });
    }
  });

  /**
   * And the two that do not, which is the half worth pinning as an absence. A deck's **group**
   * is renamed by a rename and by nothing else, so a patch that names no `name` — archiving,
   * a cover, a format — moves nothing in any folder; and `deck_set_folder` files the deck into
   * a `deck_folders` row, which is the gallery's tree and not the collection's. The wishlist is
   * untouched by all five: no wish's `ownedQuantity` can move without a quantity moving.
   */
  it("leaves the collection alone for a patch that is not a rename, and the wishlist always", async () => {
    const { result } = renderHook(() => useDecks(), { wrapper });
    await waitFor(() => expect(result.current.decks).toEqual([BURN]));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.update.mutateAsync({ id: 4, patch: { archived: true } });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["collection"] });

    invalidate.mockClear();
    await result.current.setFolder.mutateAsync({ id: 4, folderId: 1 });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["collection"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["wishlist"] });
  });

  /**
   * **Filing is the one deck write a patch cannot express.** `update` writes every column with
   * `coalesce(?n, column)`, so a bound NULL reads as "leave it alone" — there is no patch that
   * takes a deck back to the root of the tree, and a drag out of a folder written as one is a
   * write that silently does nothing. `deck_set_folder` is where `null` means the root, and
   * this is the assertion that keeps the gallery reaching for it.
   */
  it("files a deck with deckSetFolder, and takes null to mean the root", async () => {
    const { result } = renderHook(() => useDecks(), { wrapper });
    await waitFor(() => expect(result.current.decks).toEqual([BURN]));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.setFolder.mutateAsync({ id: 4, folderId: 1 });
    expect(deckSetFolder).toHaveBeenCalledWith(4, 1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });

    await result.current.setFolder.mutateAsync({ id: 4, folderId: null });
    expect(deckSetFolder).toHaveBeenCalledWith(4, null);
  });

  /**
   * **A refused file re-reads too**, and the rule lives on the mutation definition rather than
   * on a call site — `useDeck`'s and `useDeckFolders`' reasoning, applied to the write that
   * shares their hazard: a refusal here is a busy database or a folder another surface has
   * already deleted, and the second must not leave a tile painted in a drawer that is gone.
   */
  it("re-reads when a file is refused", async () => {
    deckSetFolder.mockRejectedValue("That folder is not there any more.");
    const { result } = renderHook(() => useDecks(), { wrapper });
    await waitFor(() => expect(result.current.decks).toEqual([BURN]));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await expect(result.current.setFolder.mutateAsync({ id: 4, folderId: 9 })).rejects.toBe(
      "That folder is not there any more.",
    );

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] }));
  });
});
