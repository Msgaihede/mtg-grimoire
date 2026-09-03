import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type {
  CollectionImportItem,
  DeckRow,
  ImportCommitOutcome,
  ImportItem,
  ImportMatch,
  ImportOutcome,
  ImportResolveLine,
  ImportResolveRow,
} from "@/lib/ipc";

const deckCreate = vi.hoisted(() => vi.fn());
const deckDelete = vi.hoisted(() => vi.fn());
const deckImportCommit = vi.hoisted(() => vi.fn());
const importResolve = vi.hoisted(() => vi.fn());
const importReadFile = vi.hoisted(() => vi.fn());
const oracleTagsForPrintings = vi.hoisted(() => vi.fn());
const collectionImportCommit = vi.hoisted(() => vi.fn());
const collectionFolderList = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckCreate,
    deckDelete,
    deckImportCommit,
    importResolve,
    importReadFile,
    oracleTagsForPrintings,
    collectionImportCommit,
    collectionFolderList,
  },
}));

import { NO_DECK_GROUP, useImport } from "./useImport";

/**
 * The cabinet as `collection_folder_list` answers it: unfiltered by kind, so a **deck** group
 * and a binder the reader made sit in one flat list and are told apart by `kind`/`deckId`.
 *
 * Deck 4's group is `77` and deck 12's — {@link MADE}, the deck `importIntoNewDeck` makes — is
 * `78`. Two of them, because a lookup that took the first `deck` row would pass with one.
 */
const FOLDERS = [
  { id: 5, parentId: null, name: "Binder", kind: "user", deckId: null, sortOrder: 0 },
  { id: 77, parentId: null, name: "Selvala", kind: "deck", deckId: 4, sortOrder: 1 },
  { id: 78, parentId: null, name: "Selvala", kind: "deck", deckId: 12, sortOrder: 2 },
  { id: 9, parentId: null, name: "Recently removed", kind: "removed", deckId: null, sortOrder: 3 },
];

const MADE: DeckRow = {
  gameKey: "any",
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
  archived: false,
  folderId: null,
  theoryEnabled: false,
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  defaultCategoryId: 0,
  bracket: 0,
  updatedAt: 1_800_000_000,
};

const OUTCOME: ImportOutcome = { added: 117, removed: 0, categoriesCreated: 3, labelsCreated: 0 };

const ITEMS: ImportItem[] = [{ cardId: "p1", quantity: 1, categoryName: "Main deck" }];

/** The **same line** at the collection's own grain — eleven columns rather than the deck's
 *  three, which is the whole reason the two lists are planned separately rather than adapted
 *  across. */
const COPIES: CollectionImportItem[] = [
  { cardId: "p1", quantity: 1, finish: "nonfoil", condition: "NM" },
];

const OWNED: ImportCommitOutcome = { added: 1, updated: 0, removed: 0 };

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
  importResolve.mockReset().mockResolvedValue([]);
  importReadFile.mockReset().mockResolvedValue("");
  oracleTagsForPrintings.mockReset().mockResolvedValue([]);
  collectionImportCommit.mockReset().mockResolvedValue(OWNED);
  collectionFolderList.mockReset().mockResolvedValue(FOLDERS);
});

/** `useDeck.test.ts`'s helper and its reasoning — a `staleTime: 30_000` cache is *fresh*, so
 *  `isInvalidated` is the whole of what tells the Collection page anything happened. */
const OWNED_CACHES: readonly (readonly string[])[] = [
  ["collection", "list", "{}"],
  ["cards", "search", "{}"],
  ["decks", "list"],
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
 * A deck import that clears nothing is a **deck** write, and the roots it fires say so.
 *
 * `deck_import_commit` adds `deck_cards` rows and nothing else, so every `ownedQuantity` in
 * *this* deck re-attributes — the group's copies are handed out across a list that just
 * changed — and nothing about what the reader *owns* has moved. Since schema v25 the copies
 * enter a deck only through `collection_to_deck`, so the collection, the wishlist and the search
 * wall cannot have changed, and firing their roots here would be three refetches per import that
 * can only ever answer what is already on screen.
 *
 * **The one press that broke that is a live `replace`, and it has a describe of its own below.**
 */
describe("the roots an import commit fires", () => {
  it("marks only the decks stale after a commit", async () => {
    seedOwned(client);
    const { result } = renderHook(() => useImport(), { wrapper });
    expect(staleRoots(client)).toEqual([]);

    await result.current.commit.mutateAsync({
      deckId: 4,
      variant: "live",
      mode: "merge",
      items: ITEMS,
    });

    await waitFor(() => expect(staleRoots(client)).toEqual(["decks"]));
  });

  /** A list committed as a **new** deck is the same write with a `deck_create` in front of it,
   *  and it moves the same things. */
  it("marks only the decks stale after a list is imported as a new deck", async () => {
    seedOwned(client);
    const { result } = renderHook(() => useImport(), { wrapper });

    await result.current.importIntoNewDeck.mutateAsync({
      name: "Selvala",
      formatKey: "commander",
      gameKey: "paper",
      items: ITEMS,
    });

    await waitFor(() => expect(staleRoots(client)).toEqual(["decks"]));
  });
});

/**
 * The one press whose deck write is also a **collection** write — issue #336.
 *
 * A `replace` on the `live` variant deletes every `deck_cards` row of that list, and
 * `release_live_copies` files the copies behind them into `Recently removed`. So rows really do
 * leave the deck's group: the Collection page's placement, the search wall's owned badges and the
 * wishlist's owned progress all answer a question this press changed, and `query.ts` caches 30 s —
 * which makes a missing root a wrong screen for half a minute rather than a slow one.
 *
 * **The two neighbours are the whole of what a wrong condition costs**, so both are asserted
 * beside it: `merge` clears nothing at all, and a `replace` on the plan clears rows that were
 * never backed by cardboard.
 */
describe("the roots a live replace fires", () => {
  it("marks the collection, the wishlist, the search wall and the decks stale", async () => {
    seedOwned(client);
    const { result } = renderHook(() => useImport(), { wrapper });

    await result.current.commit.mutateAsync({
      deckId: 4,
      variant: "live",
      mode: "replace",
      items: ITEMS,
    });

    await waitFor(() =>
      expect(staleRoots(client)).toEqual(["cards", "collection", "decks", "wishlist"]),
    );
  });

  /** A plan holds no copies, so a replace there releases none — the same fence the preview's own
   *  sentence is drawn behind, and the reason this is not "any replace". */
  it("marks only the decks stale when the replace is aimed at the plan", async () => {
    seedOwned(client);
    const { result } = renderHook(() => useImport(), { wrapper });

    await result.current.commit.mutateAsync({
      deckId: 4,
      variant: "theory",
      mode: "replace",
      items: ITEMS,
    });

    await waitFor(() => expect(staleRoots(client)).toEqual(["decks"]));
  });

  /** And on the way out of a refusal, for the reason every other arm here does it: the deck half
   *  can have landed under a collection half that did not, and a refused write can still be a
   *  database another surface has changed. */
  it("marks the same four stale when a live replace is refused", async () => {
    deckImportCommit.mockRejectedValue("That deck is gone.");
    seedOwned(client);
    const { result } = renderHook(() => useImport(), { wrapper });

    await expect(
      result.current.commit.mutateAsync({
        deckId: 4,
        variant: "live",
        mode: "replace",
        items: ITEMS,
      }),
    ).rejects.toBe("That deck is gone.");

    await waitFor(() =>
      expect(staleRoots(client)).toEqual(["cards", "collection", "decks", "wishlist"]),
    );
  });
});

describe("useImport", () => {
  /**
   * The one rule that lives on this hook and nowhere else: the create and the commit are two
   * transactions, so a refusal between them has to be undone by hand.
   */
  it("deletes the deck it just made when the import is refused", async () => {
    deckImportCommit.mockRejectedValue("The card database is busy finishing a sync.");
    const { result } = renderHook(() => useImport(), { wrapper });

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
    const { result } = renderHook(() => useImport(), { wrapper });

    await expect(
      result.current.importIntoNewDeck.mutateAsync({
        name: "Selvala",
        formatKey: "commander",
        items: ITEMS,
      }),
    ).rejects.toBe("A category name cannot be blank.");
  });

  it("keeps the deck when the import lands", async () => {
    const { result } = renderHook(() => useImport(), { wrapper });

    const landed = await result.current.importIntoNewDeck.mutateAsync({
      name: "Selvala",
      formatKey: "commander",
      items: ITEMS,
    });

    expect(landed).toEqual({
      deck: MADE,
      outcome: OUTCOME,
      // Nothing was claimed, so both halves of the collection answer are absent rather than
      // zero: `owned: { added: 0 }` would be the command saying it wrote nothing, and it was
      // never called.
      owned: null,
      ownRefusal: null,
    });
    // `live` and `merge`, into a deck made one line ago: there is nothing to replace.
    expect(deckImportCommit).toHaveBeenCalledWith(MADE.id, "live", "merge", ITEMS);
    expect(deckDelete).not.toHaveBeenCalled();
  });

  /**
   * The `["decks"]` root and not one key: a commit changes this deck's list, so the gallery's
   * tile counts and every `ownedQuantity` in the open editor move together.
   */
  it("invalidates the deck and the deck list after a commit", async () => {
    client.setQueryData(["decks", "list"], []);
    client.setQueryData(["decks", "detail", 4, "live"], null);
    const { result } = renderHook(() => useImport(), { wrapper });

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
    const { result } = renderHook(() => useImport(), { wrapper });

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
 * **One call for the list, never one per line** — the whole reason `import_resolve` takes
 * every line at once is that an import is one round trip, and a per-line taxonomy lookup would
 * put ~100 `invoke`s straight back. **And it cannot fail the press**: the taxonomy is a second
 * dataset with a supported state of never having been downloaded, so a refusal answers no tags
 * and every line still lands, filed by its type line.
 */
describe("the Oracle tags a resolve reads", () => {
  it("asks for the whole list in one call, with each printing named once", async () => {
    importResolve.mockResolvedValue([
      row(0, "bolt"),
      row(1, "sol-ring"),
      // A line nothing answered, and the same printing on a second line: neither is worth
      // asking about twice, and the command drops both anyway.
      row(2, null),
      row(3, "bolt"),
    ]);
    oracleTagsForPrintings.mockResolvedValue([{ cardId: "bolt", slugs: ["removal"] }]);
    const { result } = renderHook(() => useImport(), { wrapper });

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
    importResolve.mockResolvedValue([row(0, null), row(1, null)]);
    const { result } = renderHook(() => useImport(), { wrapper });

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
    importResolve.mockResolvedValue([row(0, "bolt")]);
    oracleTagsForPrintings.mockRejectedValue("The card database is busy finishing a sync.");
    const { result } = renderHook(() => useImport(), { wrapper });

    const resolved = await result.current.resolve.mutateAsync(LINES);

    expect(resolved).toEqual({ rows: [row(0, "bolt")], tags: [] });
    await waitFor(() => expect(result.current.resolve.isSuccess).toBe(true));
  });

  /** The resolve's own refusal is still the caller's news — the tag read is the half that
   *  fails quietly, and only that half. */
  it("still refuses when the printings themselves could not be looked up", async () => {
    importResolve.mockRejectedValue("The card database is busy finishing a sync.");
    const { result } = renderHook(() => useImport(), { wrapper });

    await expect(
      result.current.resolve.mutateAsync(LINES),
    ).rejects.toBe("The card database is busy finishing a sync.");
    expect(oracleTagsForPrintings).not.toHaveBeenCalled();
  });
});

/**
 * "I have physically built this deck" - the box on the preview, and the second command one
 * press now makes.
 *
 * **Two commands, one press**, `importIntoNewDeck`'s shape one file up: the deck's own commit
 * first, then the collection's. The order is the whole of what a reader is protected by. A
 * collection write that landed and a deck write that then failed would leave copies claimed by
 * a deck with no list to spend them on - a state nothing on screen explains. The other way
 * round, a deck write that landed and a collection write that failed is **exactly the import
 * the reader would have got with the box unticked**, which is a state the app has shipped since
 * the importer existed.
 *
 * So the deck half's refusal is thrown, the way it always was, and the collection half's is
 * carried back beside the outcome instead. Re-pressing Import after a landed deck commit would
 * merge the whole list a second time.
 */
describe("the collection half of a deck import", () => {
  it("writes the copies after the deck's own commit", async () => {
    const order: string[] = [];
    deckImportCommit.mockImplementation(async () => {
      order.push("deck");
      return OUTCOME;
    });
    collectionImportCommit.mockImplementation(async () => {
      order.push("collection");
      return OWNED;
    });
    const { result } = renderHook(() => useImport(), { wrapper });

    const landed = await result.current.commit.mutateAsync({
      deckId: 4,
      variant: "live",
      mode: "merge",
      items: ITEMS,
      collectionItems: COPIES,
    });

    expect(order).toEqual(["deck", "collection"]);
    // `add` and never `set`: the reader is saying they own these copies as well as whatever
    // else is in the box, not that this file is the whole of what they own.
    // **The deck's own group, never the root** — the blocker this argument settled. Filed at
    // the top level the deck goes on reading *missing* on every line the reader just said they
    // own, and every other deck can still claim the copies.
    expect(collectionImportCommit).toHaveBeenCalledWith(COPIES, "add", 77);
    expect(landed).toEqual({ outcome: OUTCOME, owned: OWNED, ownRefusal: null });
  });

  /** The box unticked is the import this app has always made: `deck_cards` and nothing else. */
  it("touches the collection not at all when the box is unticked", async () => {
    const { result } = renderHook(() => useImport(), { wrapper });

    await result.current.commit.mutateAsync({
      deckId: 4,
      variant: "live",
      mode: "merge",
      items: ITEMS,
    });

    expect(collectionImportCommit).not.toHaveBeenCalled();
  });

  /** An empty list is the same statement as an unticked box, and a command asked to write
   *  nothing is a round trip that can only answer that it wrote nothing. */
  it("makes no second call when the collection half is empty", async () => {
    const { result } = renderHook(() => useImport(), { wrapper });

    const landed = await result.current.commit.mutateAsync({
      deckId: 4,
      variant: "live",
      mode: "merge",
      items: ITEMS,
      collectionItems: [],
    });

    expect(collectionImportCommit).not.toHaveBeenCalled();
    expect(landed.owned).toBeNull();
  });

  /**
   * The deck's refusal still ends the press, and the collection is never written on top of an
   * import that did not land.
   */
  it("writes no copies when the deck's own commit is refused", async () => {
    deckImportCommit.mockRejectedValue("That deck is gone.");
    const { result } = renderHook(() => useImport(), { wrapper });

    await expect(
      result.current.commit.mutateAsync({
        deckId: 4,
        variant: "live",
        mode: "merge",
        items: ITEMS,
        collectionItems: COPIES,
      }),
    ).rejects.toBe("That deck is gone.");

    expect(collectionImportCommit).not.toHaveBeenCalled();
  });

  /**
   * And the collection's refusal does **not** throw, because the deck import behind it really
   * did land. Throwing would put "Could not import the list" over a list that is now in the
   * deck, and invite a second press that merges all of it again.
   */
  it("keeps the landed deck import when the copies are refused", async () => {
    collectionImportCommit.mockRejectedValue("The card database is busy finishing a sync.");
    const { result } = renderHook(() => useImport(), { wrapper });

    const landed = await result.current.commit.mutateAsync({
      deckId: 4,
      variant: "live",
      mode: "merge",
      items: ITEMS,
      collectionItems: COPIES,
    });

    expect(landed).toEqual({
      outcome: OUTCOME,
      owned: null,
      ownRefusal: "The card database is busy finishing a sync.",
    });
  });

  /**
   * **A deck with no group refuses rather than quietly filing at the root**, which is the
   * failure mode this whole change exists to remove: the reader ticked a box saying these copies
   * belong to *this deck*, and the top level is a different statement. Every deck has a group —
   * schema v25 made one per deck and `deck_create` makes one since — so this is a database
   * edited by hand, and the sentence is `collection_alloc::NO_DECK_GROUP`'s rather than a second
   * wording invented here.
   *
   * It rides back as `ownRefusal` like every other refusal on this half: the deck list has
   * already landed, so throwing would put "Could not import the list" over a list that is in the
   * deck.
   */
  it("refuses the copies rather than filing them at the root when a deck has no group", async () => {
    collectionFolderList.mockResolvedValue(FOLDERS.filter((f) => f.kind !== "deck"));
    const { result } = renderHook(() => useImport(), { wrapper });

    const landed = await result.current.commit.mutateAsync({
      deckId: 4,
      variant: "live",
      mode: "merge",
      items: ITEMS,
      collectionItems: COPIES,
    });

    expect(collectionImportCommit).not.toHaveBeenCalled();
    expect(landed).toEqual({ outcome: OUTCOME, owned: null, ownRefusal: NO_DECK_GROUP });
  });

  /** The lookup is only made when there is something to file — an unticked box must not cost a
   *  round trip to the folder table either. */
  it("does not read the folder list when the box is unticked", async () => {
    const { result } = renderHook(() => useImport(), { wrapper });

    await result.current.commit.mutateAsync({ deckId: 4, variant: "live", mode: "merge", items: ITEMS });

    expect(collectionFolderList).not.toHaveBeenCalled();
  });

  /** The same three rules with a `deck_create` in front of them - and the create's rollback
   *  still belongs to the deck half alone. */
  it("writes the copies for a list imported as a new deck", async () => {
    const { result } = renderHook(() => useImport(), { wrapper });

    const landed = await result.current.importIntoNewDeck.mutateAsync({
      name: "Selvala",
      formatKey: "commander",
      items: ITEMS,
      collectionItems: COPIES,
    });

    // The group of the deck `deck_create` just made, which is why the lookup happens at press
    // time: a second before this there was no deck for a query to have been keyed on.
    expect(collectionImportCommit).toHaveBeenCalledWith(COPIES, "add", 78);
    expect(landed).toEqual({ deck: MADE, outcome: OUTCOME, owned: OWNED, ownRefusal: null });
  });

  /**
   * A refused deck commit deletes the deck it just made **and** leaves the collection alone -
   * the rollback would otherwise have nothing to say about copies filed against a deck that no
   * longer exists.
   */
  it("rolls the new deck back without having written any copies", async () => {
    deckImportCommit.mockRejectedValue("A category name cannot be blank.");
    const { result } = renderHook(() => useImport(), { wrapper });

    await expect(
      result.current.importIntoNewDeck.mutateAsync({
        name: "Selvala",
        formatKey: "commander",
        items: ITEMS,
        collectionItems: COPIES,
      }),
    ).rejects.toBe("A category name cannot be blank.");

    expect(deckDelete).toHaveBeenCalledWith(MADE.id);
    expect(collectionImportCommit).not.toHaveBeenCalled();
  });
});

/**
 * The roots a ticked box fires: the **union** of the deck import's own and the collection
 * import's.
 *
 * `src/lib/query.ts` caches 30 s, so a root left out is a stale screen rather than a slow one -
 * the search wall's owned badges, the wishlist's owned-progress and the collection's own list and
 * summary each answer a question this write just changed the answer to. It is the set
 * `CollectionPreview` already passes `useImportCommit` for exactly the same command, plus the
 * `["decks"]` this hook has always fired.
 */
describe("the roots a ticked box fires", () => {
  it("marks the collection, the wishlist, the search wall and the decks stale", async () => {
    seedOwned(client);
    const { result } = renderHook(() => useImport(), { wrapper });

    await result.current.commit.mutateAsync({
      deckId: 4,
      variant: "live",
      mode: "merge",
      items: ITEMS,
      collectionItems: COPIES,
    });

    await waitFor(() =>
      expect(staleRoots(client)).toEqual(["cards", "collection", "decks", "wishlist"]),
    );
  });

  /** And on the way out of a refusal, for the reason the deck root already does it: the
   *  database can have been changed by the half that landed, or by another surface. */
  it("marks the same four stale when the deck's commit is refused", async () => {
    deckImportCommit.mockRejectedValue("That deck is gone.");
    seedOwned(client);
    const { result } = renderHook(() => useImport(), { wrapper });

    await expect(
      result.current.commit.mutateAsync({
        deckId: 4,
        variant: "live",
        mode: "merge",
        items: ITEMS,
        collectionItems: COPIES,
      }),
    ).rejects.toBe("That deck is gone.");

    await waitFor(() =>
      expect(staleRoots(client)).toEqual(["cards", "collection", "decks", "wishlist"]),
    );
  });

  /** The unticked press is unchanged, which is the half this union must not cost: three
   *  refetches per plain decklist import that can only ever answer what is already on screen. */
  it("still marks only the decks stale for a list imported as a new deck with no copies", async () => {
    seedOwned(client);
    const { result } = renderHook(() => useImport(), { wrapper });

    await result.current.importIntoNewDeck.mutateAsync({
      name: "Selvala",
      formatKey: "commander",
      items: ITEMS,
    });

    await waitFor(() => expect(staleRoots(client)).toEqual(["decks"]));
  });
});
