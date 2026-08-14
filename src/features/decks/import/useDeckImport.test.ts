import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { DeckRow, ImportItem, ImportOutcome } from "@/lib/ipc";

const deckCreate = vi.hoisted(() => vi.fn());
const deckDelete = vi.hoisted(() => vi.fn());
const deckImportCommit = vi.hoisted(() => vi.fn());
const deckImportResolve = vi.hoisted(() => vi.fn());
const deckImportReadFile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckCreate, deckDelete, deckImportCommit, deckImportResolve, deckImportReadFile },
}));

import { useDeckImport } from "./useDeckImport";

const MADE: DeckRow = {
  id: 12,
  name: "Selvala",
  formatKey: "commander",
  formatName: "Commander",
  description: null,
  notes: null,
  coverCardId: null,
  coverKind: "card_art",
  coverArtist: null,
  cardCount: 0,
  isBuilt: false,
  archived: false,
  folderId: null,
  theoryEnabled: false,
  separateXGroup: false,
  updatedAt: 1_800_000_000,
};

const OUTCOME: ImportOutcome = { added: 117, removed: 0, categoriesCreated: 3 };

const ITEMS: ImportItem[] = [{ cardId: "p1", quantity: 1, categoryName: "Main deck" }];

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  deckCreate.mockReset().mockResolvedValue(MADE);
  deckDelete.mockReset().mockResolvedValue(undefined);
  deckImportCommit.mockReset().mockResolvedValue(OUTCOME);
  deckImportResolve.mockReset().mockResolvedValue([]);
  deckImportReadFile.mockReset().mockResolvedValue("");
});

describe("useDeckImport", () => {
  /**
   * The one rule that lives on this hook and nowhere else: the create and the commit are two
   * transactions, so a refusal between them has to be undone by hand.
   */
  it("deletes the deck it just made when the import is refused", async () => {
    deckImportCommit.mockRejectedValue("The card database is busy finishing a sync.");
    const { result } = renderHook(() => useDeckImport(), { wrapper });

    await expect(
      result.current.importIntoNewDeck.mutateAsync({
        name: "Selvala",
        formatKey: "commander",
        items: ITEMS,
      }),
      // The **commit's** refusal, never the delete's: the reader is owed the sentence about
      // why their import did not land.
    ).rejects.toBe("The card database is busy finishing a sync.");

    expect(deckDelete).toHaveBeenCalledWith(MADE.id);
  });

  /**
   * And the clean-up's own failure is swallowed. A second refusal about the tidying up would
   * bury the first, which is the one that says why nothing was imported.
   */
  it("still reports the import's refusal when the rollback fails too", async () => {
    deckImportCommit.mockRejectedValue("A category name cannot be blank.");
    deckDelete.mockRejectedValue("The card database is busy finishing a sync.");
    const { result } = renderHook(() => useDeckImport(), { wrapper });

    await expect(
      result.current.importIntoNewDeck.mutateAsync({
        name: "Selvala",
        formatKey: "commander",
        items: ITEMS,
      }),
    ).rejects.toBe("A category name cannot be blank.");
  });

  it("keeps the deck when the import lands", async () => {
    const { result } = renderHook(() => useDeckImport(), { wrapper });

    const landed = await result.current.importIntoNewDeck.mutateAsync({
      name: "Selvala",
      formatKey: "commander",
      items: ITEMS,
    });

    expect(landed).toEqual({ deck: MADE, outcome: OUTCOME });
    // `live` and `merge`, into a deck made one line ago: there is nothing to replace.
    expect(deckImportCommit).toHaveBeenCalledWith(MADE.id, "live", "merge", ITEMS);
    expect(deckDelete).not.toHaveBeenCalled();
  });

  /**
   * The `["decks"]` root and not one key: a commit runs the allocator, so the gallery's tile
   * counts and every open deck's `ownedQuantity` may have moved together.
   */
  it("invalidates the deck and the deck list after a commit", async () => {
    client.setQueryData(["decks", "list"], []);
    client.setQueryData(["decks", "detail", 4, "live"], null);
    const { result } = renderHook(() => useDeckImport(), { wrapper });

    await result.current.commit.mutateAsync({
      deckId: 4,
      variant: "live",
      mode: "merge",
      items: ITEMS,
    });

    await waitFor(() => {
      expect(client.getQueryState(["decks", "list"])?.isInvalidated).toBe(true);
      expect(client.getQueryState(["decks", "detail", 4, "live"])?.isInvalidated).toBe(true);
    });
  });

  /** The same, on the way out of a refusal: a `GONE` must not leave a deleted deck painted. */
  it("invalidates when a commit is refused", async () => {
    deckImportCommit.mockRejectedValue("That deck is gone.");
    client.setQueryData(["decks", "list"], []);
    const { result } = renderHook(() => useDeckImport(), { wrapper });

    await expect(
      result.current.commit.mutateAsync({
        deckId: 4,
        variant: "live",
        mode: "replace",
        items: ITEMS,
      }),
    ).rejects.toBe("That deck is gone.");

    await waitFor(() =>
      expect(client.getQueryState(["decks", "list"])?.isInvalidated).toBe(true),
    );
  });
});
