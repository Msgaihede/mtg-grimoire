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
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckList, deckCreate, deckUpdate, deckDelete, deckDuplicate },
}));

import { useDecks } from "./useDecks";

const BURN: DeckRow = {
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
});
