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
  ipc: { deckList, deckCreate, deckUpdate, deckDelete, deckDuplicate, deckSetFolder },
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
  isBuilt: false,
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
  deckUpdate.mockReset().mockResolvedValue({ ...BURN, isBuilt: true });
  deckDelete.mockReset().mockResolvedValue(undefined);
  deckDuplicate.mockReset().mockResolvedValue({ ...BURN, id: 5, name: "Burn (copy)" });
  deckSetFolder.mockReset().mockResolvedValue({ ...BURN, folderId: 1 });
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
   * The **root**, not `["decks", "list"]`, from all four: a rename changes the tile *and*
   * the header of the editor that deck is open in, and a build toggle rewrites the deck's
   * claims — which is what every `ownedQuantity` in the open detail is attributed from.
   * Invalidating only the list would leave a detail on screen describing the deck as it was.
   */
  it("refreshes every deck query after each of the four gallery writes", async () => {
    const { result } = renderHook(() => useDecks(), { wrapper });
    await waitFor(() => expect(result.current.decks).toEqual([BURN]));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.create.mutateAsync({ name: "Burn", formatKey: "modern" });
    expect(deckCreate).toHaveBeenCalledWith({ name: "Burn", formatKey: "modern" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });

    invalidate.mockClear();
    await result.current.update.mutateAsync({ id: 4, patch: { isBuilt: true } });
    expect(deckUpdate).toHaveBeenCalledWith(4, { isBuilt: true });
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
   * A deck write moves no card between a binder and a shelf: `allocate_deck` writes
   * `deck_allocations` and never once touches `collection_entries` (spec §6's
   * non-destructive model). So the collection and the wishlist are left alone rather than
   * refetched — the discipline the quick-add already applies in the other direction.
   */
  it("leaves the collection and the wishlist alone", async () => {
    const { result } = renderHook(() => useDecks(), { wrapper });
    await waitFor(() => expect(result.current.decks).toEqual([BURN]));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.update.mutateAsync({ id: 4, patch: { isBuilt: true } });

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
