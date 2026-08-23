import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { CollectionFolder, CollectionRow } from "@/lib/ipc";

const collectionList = vi.hoisted(() => vi.fn());
const collectionToDeck = vi.hoisted(() => vi.fn());
const collectionFolderList = vi.hoisted(() => vi.fn());
// `useMarketplace` is the real hook here rather than a fake — the marketplace is part of both
// the payload and the key — so its own two queries need answers or it sits rejected for the
// life of the file.
const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionList,
    collectionToDeck,
    collectionFolderList,
    getMarketplace,
    marketplaceFeedStatus,
  },
}));

import { copySource, useCollectionSearch } from "./useCollectionSearch";

/** The deck this panel is docked beside — the one a move files *into*. */
const DECK_ID = 4;

/** This deck's own group: `kind: "deck"`, named after the deck, `deckId` pointing back at it. */
const THIS_GROUP: CollectionFolder = {
  id: 10,
  parentId: null,
  name: "Kenrith",
  kind: "deck",
  deckId: DECK_ID,
  sortOrder: 0,
};
/** Another deck's group — the folder the confirm exists for. */
const OTHER_GROUP: CollectionFolder = {
  id: 11,
  parentId: null,
  name: "Mono-Red Aggro",
  kind: "deck",
  deckId: 9,
  sortOrder: 0,
};
/** A drawer the reader made. On the desk, so no confirm. */
const BINDER: CollectionFolder = {
  id: 12,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
};
/** The one holding area. **On the desk too** — a card that left the collection without leaving
 *  the database is not a card a deck is using. */
const REMOVED: CollectionFolder = {
  id: 13,
  parentId: null,
  name: "Recently removed",
  kind: "removed",
  deckId: null,
  sortOrder: 0,
};

const FOLDERS = [THIS_GROUP, OTHER_GROUP, BINDER, REMOVED];

function row(over: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 1,
    cardId: "bolt",
    folderId: null,
    folderName: null,
    name: "Lightning Bolt",
    oracleId: "o-bolt",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "161",
    lang: "en",
    rarity: "common",
    manaCost: "{R}",
    typeLine: "Instant",
    layout: "normal",
    finish: "nonfoil",
    condition: "NM",
    quantity: 3,
    tradelistQuantity: 0,
    unitPrice: 400.5,
    purchasePrice: null,
    purchaseCurrency: null,
    acquiredAt: null,
    acquisitionSource: null,
    serialNumber: null,
    altered: false,
    signed: false,
    proxy: false,
    misprint: false,
    grading: null,
    tags: "[]",
    notes: null,
    needsReview: null,
    updatedAt: 0,
    promoTypes: null,
    legalities: null,
    ...over,
  };
}

const BOLT = row();

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  collectionList.mockReset().mockResolvedValue({ items: [BOLT], total: 1 });
  collectionToDeck.mockReset().mockResolvedValue({ entryId: 5, fromDeck: null, quantity: 1 });
  collectionFolderList.mockReset().mockResolvedValue(FOLDERS);
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
});

/** The hook, mounted the way the tab mounts it. */
function mount(options: { deckId?: number | null } = {}) {
  return renderHook(
    () =>
      useCollectionSearch({
        deckId: options.deckId === undefined ? DECK_ID : options.deckId,
        defaultFormat: { value: "commander", label: "Commander" },
      }),
    { wrapper },
  );
}

/** The query object the last `collection_list` was asked with. */
function lastQuery() {
  return collectionList.mock.calls[collectionList.mock.calls.length - 1][0];
}

describe("useCollectionSearch", () => {
  /**
   * **The default is only-unallocated, and it is the whole point of the feature.**
   *
   * A copy sitting in another deck's group is spoken for: a reader building a deck out of what
   * they have wants the cards that are actually free. `"all"` is the deliberate press that makes
   * the spoken-for copies visible — and pressing Add on one of those is what the confirm is for.
   *
   * The assertion is on the **payload**, not on a piece of state, because nothing has ever sent
   * this field: `CollectionQuery.allocation` has existed since schema v25 and every caller in
   * the app gets `All` by omission. A hook that held the right state and dropped the field on the
   * way to the wire would read as correct everywhere but in the answers.
   */
  it("asks for only the unallocated copies until the reader says otherwise", async () => {
    mount();

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(lastQuery().allocation).toBe("unallocated");
  });

  /**
   * The other half of the toggle, and that it reaches the wire as a **new request** rather than
   * being served from the cached page: the two allocations are two different sets of rows, so a
   * key that did not carry the field would show the reader the narrowed list under a widened
   * control.
   */
  it("sends `all` once the reader asks to see every copy", async () => {
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    const asked = collectionList.mock.calls.length;

    act(() => result.current.setAllocation("all"));

    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(asked));
    expect(lastQuery().allocation).toBe("all");
  });

  /**
   * The deck's format opens the search, exactly as it does on the card-search tab — and `null`
   * is a working panel rather than a degraded one, which is why the fence is `DeckEditor`'s
   * `hasLegalityData` and never this hook's. `casual` is every deck's birth format and answers
   * no rows at all.
   */
  it("opens on the deck's format", async () => {
    mount();

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(lastQuery().format).toBe("commander");
  });

  /**
   * The write, addressed the way `collection_alloc::collection_to_deck` declares it: the
   * **collection row**, the deck, the category and how many copies.
   */
  it("moves copies out of a collection row and into the deck", async () => {
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    await act(async () => {
      await result.current.move.mutateAsync({ row: BOLT, categoryId: 3, quantity: 1 });
    });

    expect(collectionToDeck).toHaveBeenCalledWith(BOLT.id, DECK_ID, { id: 3 }, 1);
  });

  /**
   * **Not optimistic, and not merely marked stale.** `lib/query.ts` caches 30 s, so a mounted
   * query told it is stale and not refetched goes on drawing the row the write has just moved
   * out of the list — PR 2 shipped exactly that ghost row. The list observer here is mounted, so
   * the assertion is a second `collection_list`, not an `invalidateQueries` call count.
   */
  it("re-reads the list after a move rather than patching it", async () => {
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    const asked = collectionList.mock.calls.length;

    await act(async () => {
      await result.current.move.mutateAsync({ row: BOLT, categoryId: 3, quantity: 1 });
    });

    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(asked));
  });

  /**
   * The three roots a move actually moves numbers under, and **the deck is the one easiest to
   * forget**: the copies came off somebody's desk *and* landed in a deck's list, and when they
   * came out of another deck's group that deck's live list is one shorter too. `invalidateQueries`
   * matches by key **prefix**, so `["collection"]` reaches the list, the summary, the folder
   * census and the per-folder subtotals together, and `["decks"]` reaches every deck's detail.
   */
  it("invalidates the collection and every deck", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    await act(async () => {
      await result.current.move.mutateAsync({ row: BOLT, categoryId: 3, quantity: 1 });
    });

    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["collection"]));
    expect(keys).toContain(JSON.stringify(["decks"]));
  });

  /**
   * And on a **refusal** too, for `useCollectionFolders`' reason: the usual refusal is a row
   * something else has already moved or deleted, so the list on screen is the thing that is
   * wrong. Leaving it alone after `GONE` is how a panel comes to offer a copy that is not there.
   */
  it("re-reads after a refused move as well", async () => {
    collectionToDeck.mockRejectedValue(new Error("That row is gone"));
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    const asked = collectionList.mock.calls.length;

    await act(async () => {
      await result.current.move
        .mutateAsync({ row: BOLT, categoryId: 3, quantity: 1 })
        .catch(() => undefined);
    });

    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(asked));
  });
});

/**
 * Where a copy is filed, as the one question the Add button has to answer before it presses.
 *
 * A pure function over the folder census rather than a field on the row: `CollectionRow` carries
 * `folderId` and `folderName` and **not** the folder's `kind`, so "is this copy in a deck" cannot
 * be read off the row at all. `collection_folder_list` is the census and it is already fetched
 * once per window for the card menu.
 */
describe("copySource", () => {
  it("calls the root, a reader's drawer and Recently removed the desk", () => {
    for (const folderId of [null, BINDER.id, REMOVED.id]) {
      expect(copySource(row({ folderId }), FOLDERS, DECK_ID).kind).toBe("desk");
    }
  });

  /** A copy already in this deck's group — `collection_to_deck` refuses it in words
   *  (`ALREADY_HERE`), so the button says so instead of pressing. */
  it("knows a copy this deck already holds", () => {
    const source = copySource(row({ folderId: THIS_GROUP.id }), FOLDERS, DECK_ID);
    expect(source.kind).toBe("here");
  });

  /**
   * **The case the whole confirm exists for, and the name is the load-bearing half**: the side
   * effect lands on a deck the reader is not looking at, so the question has to say which one.
   */
  it("names the other deck a copy is spoken for by", () => {
    const source = copySource(row({ folderId: OTHER_GROUP.id }), FOLDERS, DECK_ID);
    expect(source).toEqual({ kind: "otherDeck", deckName: "Mono-Red Aggro" });
  });

  /** A folder the census has not answered for yet — the first render, before
   *  `collection_folder_list` lands. **The desk is the wrong guess to make here**: it would let
   *  an add slip past the confirm, so an unknown folder is treated as spoken for and named as
   *  best it can be. */
  it("treats a folder it cannot place as spoken for", () => {
    const source = copySource(row({ folderId: 99, folderName: "Somewhere" }), [], DECK_ID);
    expect(source).toEqual({ kind: "otherDeck", deckName: "Somewhere" });
  });
});
