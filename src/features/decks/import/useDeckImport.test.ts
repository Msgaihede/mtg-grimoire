import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type {
  DeckRow,
  ImportItem,
  ImportMatch,
  ImportOutcome,
  ImportResolveLine,
  ImportResolveRow,
} from "@/lib/ipc";

const deckCreate = vi.hoisted(() => vi.fn());
const deckDelete = vi.hoisted(() => vi.fn());
const deckImportCommit = vi.hoisted(() => vi.fn());
const deckImportResolve = vi.hoisted(() => vi.fn());
const deckImportReadFile = vi.hoisted(() => vi.fn());
const oracleTagsForPrintings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckCreate,
    deckDelete,
    deckImportCommit,
    deckImportResolve,
    deckImportReadFile,
    oracleTagsForPrintings,
  },
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
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  defaultCategoryId: 0,
  updatedAt: 1_800_000_000,
};

const OUTCOME: ImportOutcome = { added: 117, removed: 0, categoriesCreated: 3 };

const ITEMS: ImportItem[] = [{ cardId: "p1", quantity: 1, categoryName: "Main deck" }];

/** A resolved row, thin: this hook reads exactly one field off a match — the printing id it
 *  asks the taxonomy about — so the rest is not invented here. */
function row(index: number, cardId: string | null): ImportResolveRow {
  return {
    index,
    matched: cardId === null ? null : ({ cardId } as ImportMatch),
    hintMissed: false,
  };
}

/** What the caller sends. The mocked resolve ignores it — what each line resolved *to* is
 *  staged on the mock — so one line stands for any list. */
const LINES: ImportResolveLine[] = [
  { name: "Lightning Bolt", setCode: null, collectorNumber: null },
];

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
  oracleTagsForPrintings.mockReset().mockResolvedValue([]);
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

/**
 * The second read the resolve makes, and the two rules that make it safe to make at all.
 *
 * **One call for the list, never one per line** — the whole reason `deck_import_resolve` takes
 * every line at once is that an import is one round trip, and a per-line taxonomy lookup would
 * put ~100 `invoke`s straight back. **And it cannot fail the press**: the taxonomy is a second
 * dataset with a supported state of never having been downloaded, so a refusal answers no tags
 * and every line still lands, filed by its type line.
 */
describe("the Oracle tags a resolve reads", () => {
  it("asks for the whole list in one call, with each printing named once", async () => {
    deckImportResolve.mockResolvedValue([
      row(0, "bolt"),
      row(1, "sol-ring"),
      // A line nothing answered, and the same printing on a second line: neither is worth
      // asking about twice, and the command drops both anyway.
      row(2, null),
      row(3, "bolt"),
    ]);
    oracleTagsForPrintings.mockResolvedValue([{ cardId: "bolt", slugs: ["removal"] }]);
    const { result } = renderHook(() => useDeckImport(), { wrapper });

    const resolved = await result.current.resolve.mutateAsync(LINES);

    expect(oracleTagsForPrintings).toHaveBeenCalledTimes(1);
    expect(oracleTagsForPrintings).toHaveBeenCalledWith(["bolt", "sol-ring"]);
    // Both halves come back from the one press, so the preview is never drawn from half of them.
    expect(resolved.rows).toHaveLength(4);
    expect(resolved.tags).toEqual([{ cardId: "bolt", slugs: ["removal"] }]);
  });

  /** A list of typos, or a paste made during the opening sync. There is nothing to ask about,
   *  so nothing is asked. */
  it("asks nothing when no line resolved", async () => {
    deckImportResolve.mockResolvedValue([row(0, null), row(1, null)]);
    const { result } = renderHook(() => useDeckImport(), { wrapper });

    const resolved = await result.current.resolve.mutateAsync(LINES);

    expect(oracleTagsForPrintings).not.toHaveBeenCalled();
    expect(resolved.tags).toEqual([]);
  });

  /**
   * **A refused taxonomy read is not a refused import.** The reader pasted 105 lines; losing
   * that to a fetch of the tag table would be the worst trade this dialog could make, and the
   * type-line filing it falls back to is the behaviour the app shipped with.
   */
  it("resolves with no tags when the tag read is refused", async () => {
    deckImportResolve.mockResolvedValue([row(0, "bolt")]);
    oracleTagsForPrintings.mockRejectedValue("The card database is busy finishing a sync.");
    const { result } = renderHook(() => useDeckImport(), { wrapper });

    const resolved = await result.current.resolve.mutateAsync(LINES);

    expect(resolved).toEqual({ rows: [row(0, "bolt")], tags: [] });
    await waitFor(() => expect(result.current.resolve.isSuccess).toBe(true));
  });

  /** The resolve's own refusal is still the caller's news — the tag read is the half that
   *  fails quietly, and only that half. */
  it("still refuses when the printings themselves could not be looked up", async () => {
    deckImportResolve.mockRejectedValue("The card database is busy finishing a sync.");
    const { result } = renderHook(() => useDeckImport(), { wrapper });

    await expect(
      result.current.resolve.mutateAsync(LINES),
    ).rejects.toBe("The card database is busy finishing a sync.");
    expect(oracleTagsForPrintings).not.toHaveBeenCalled();
  });
});
