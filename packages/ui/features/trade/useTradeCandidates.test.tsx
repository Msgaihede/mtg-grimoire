import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardSummary, CollectionFolder, CollectionQuery, CollectionRow } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

const collectionList = vi.hoisted(() => vi.fn());
const collectionFolderList = vi.hoisted(() => vi.fn());
const searchCards = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...real, ipc: { ...real.ipc, collectionList, collectionFolderList, searchCards } };
});

import { CANDIDATE_LIMIT, useTradeCandidates, type TradeScope } from "./useTradeCandidates";

function row(over: Partial<CollectionRow> & Pick<CollectionRow, "id" | "cardId" | "name">) {
  return {
    folderId: null,
    oracleId: `oracle-${over.cardId}`,
    setCode: "gtc",
    collectorNumber: "148",
    rarity: "uncommon",
    finish: "nonfoil",
    condition: "NM",
    quantity: 1,
    unitPrice: 5.84,
    ...over,
  } as CollectionRow;
}

function card(over: Partial<CardSummary> & Pick<CardSummary, "id" | "name">) {
  return {
    setCode: "sta",
    collectorNumber: "42",
    rarity: "rare",
    price: 2.1,
    oracleId: `oracle-${over.id}`,
    finishes: '["nonfoil","foil"]',
    ...over,
  } as CardSummary;
}

function folder(id: number, kind: string, name = kind): CollectionFolder {
  return { rules: [], id, parentId: null, name, kind, deckId: null, sortOrder: id, locked: false, syncUid: null };
}

/**
 * The collection, answering its two questions apart: the copies outside every deck, and — to the
 * read that names shelves — the copies in those folders. One `mockResolvedValue` would hand both
 * reads the same rows, and every deck's copy would then also be an ordinary one.
 */
function answer(outside: CollectionRow[], inDecks: CollectionRow[]) {
  collectionList.mockImplementation(async (q: CollectionQuery) => {
    const items = q.shelves === undefined ? outside : inDecks;
    return { items, total: items.length };
  });
}

/** The one read that named shelves. */
const deckRead = () =>
  collectionList.mock.calls.map(([q]) => q as CollectionQuery).filter((q) => q.shelves !== undefined);

type Props = { scope: TradeScope; text: string; marketplace: MarketplaceId };

function candidates(initial: Props) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook((p: Props) => useTradeCandidates(p.scope, p.text, p.marketplace), {
    wrapper,
    initialProps: initial,
  });
}

beforeEach(() => {
  collectionList.mockReset().mockResolvedValue({ items: [], total: 0 });
  collectionFolderList.mockReset().mockResolvedValue([]);
  searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
});

describe("useTradeCandidates", () => {
  it("asks nothing and answers nothing for an empty field", async () => {
    const hook = candidates({ scope: "collection", text: "   ", marketplace: "tcgplayer" });

    // Past the debounce, so "nothing was asked" is a fact and not a race the test won.
    await new Promise((done) => setTimeout(done, 350));

    expect(hook.result.current).toEqual({ rows: [], deckRows: [], pending: false, error: null });
    expect(collectionList).not.toHaveBeenCalled();
    expect(searchCards).not.toHaveBeenCalled();
  });

  it("reads the collection by name, for the copies a finish could take", async () => {
    collectionList.mockResolvedValue({
      items: [row({ id: 1, cardId: "charm", name: "Boros Charm", quantity: 3 })],
      total: 1,
    });
    const hook = candidates({ scope: "collection", text: " charm ", marketplace: "cardmarket" });

    // The wait is part of the answer: for the length of the debounce the rows are an older one.
    expect(hook.result.current.pending).toBe(true);
    await waitFor(() => expect(hook.result.current.rows).toHaveLength(1));

    expect(collectionList).toHaveBeenCalledExactlyOnceWith({
      text: "charm",
      // Not the copies a deck is holding, and not the ones in a locked folder.
      allocation: "unallocated",
      excludeLocked: true,
      // The trade's marketplace, which is where the row's price comes from.
      marketplace: "cardmarket",
      limit: 60,
      offset: 0,
    });
    expect(searchCards).not.toHaveBeenCalled();
    expect(hook.result.current).toEqual({
      rows: [
        {
          key: "charm:nonfoil",
          cardId: "charm",
          oracleId: "oracle-charm",
          name: "Boros Charm",
          setCode: "gtc",
          collectorNumber: "148",
          rarity: "uncommon",
          finish: "nonfoil",
          unitPrice: 5.84,
          owned: 3,
          source: "collection",
          place: "collection",
          deckName: null,
        },
      ],
      // No deck, so no second read: the one call above is the whole of what was asked.
      deckRows: [],
      pending: false,
      error: null,
    });
  });

  it("folds a printing's rows into one candidate a finish, and counts the copies", async () => {
    collectionList.mockResolvedValue({
      items: [
        row({ id: 1, cardId: "charm", name: "Boros Charm", quantity: 3 }),
        // Another condition, another folder: the same line of a trade.
        row({ id: 2, cardId: "charm", name: "Boros Charm", condition: "LP", folderId: 7 }),
        // Another finish is another line.
        row({ id: 3, cardId: "charm", name: "Boros Charm", finish: "foil", unitPrice: 13.25 }),
      ],
      total: 3,
    });
    collectionFolderList.mockResolvedValue([folder(7, "user")]);
    const hook = candidates({ scope: "collection", text: "charm", marketplace: "tcgplayer" });

    await waitFor(() => expect(hook.result.current.rows).toHaveLength(2));

    expect(hook.result.current.rows.map((r) => [r.key, r.owned, r.unitPrice])).toEqual([
      ["charm:nonfoil", 4, 5.84],
      ["charm:foil", 1, 13.25],
    ]);
  });

  it("leaves out copies filed where a finish cannot reach them", async () => {
    collectionList.mockResolvedValue({
      items: [
        row({ id: 1, cardId: "charm", name: "Boros Charm", folderId: 7 }),
        // *Recently removed* is neither a deck's folder nor the reader's, so the query's two
        // filters let it through and the folder's kind is what stops it.
        row({ id: 2, cardId: "charm", name: "Boros Charm", quantity: 5, folderId: 9 }),
        row({ id: 3, cardId: "gone", name: "Boros Reckoner", folderId: 9 }),
      ],
      total: 3,
    });
    collectionFolderList.mockResolvedValue([folder(7, "user"), folder(9, "removed")]);
    const hook = candidates({ scope: "collection", text: "boros", marketplace: "tcgplayer" });

    await waitFor(() => expect(hook.result.current.pending).toBe(false));
    await waitFor(() =>
      expect(hook.result.current.rows.map((r) => [r.name, r.owned])).toEqual([["Boros Charm", 1]]),
    );
  });

  /**
   * The owner's collection: 226 of 340 copies filed in deck groups, and a search from a trade
   * that found none of his three Sol Rings. A deck's copies are offered — as a list of their own,
   * because trading one leaves that deck a card short.
   */
  describe("the copies a deck is holding", () => {
    const CABINET = [
      folder(7, "user", "Binder"),
      folder(11, "deck", "Serah"),
      folder(12, "deck", "Azula"),
      folder(9, "removed", "Recently removed"),
    ];

    it("asks for them apart, by the deck groups, and answers them as their own list", async () => {
      collectionFolderList.mockResolvedValue(CABINET);
      answer(
        [row({ id: 1, cardId: "ring", name: "Sol Ring", folderId: 7, quantity: 2 })],
        [
          row({ id: 2, cardId: "ring", name: "Sol Ring", folderId: 11, folderName: "Serah" }),
          row({ id: 3, cardId: "ring", name: "Sol Ring", folderId: 12, folderName: "Azula" }),
          // Another condition of the same printing in the same deck: one row, two copies.
          row({
            id: 4,
            cardId: "ring",
            name: "Sol Ring",
            folderId: 12,
            folderName: "Azula",
            condition: "LP",
          }),
          row({
            id: 5,
            cardId: "ring",
            name: "Sol Ring",
            folderId: 12,
            folderName: "Azula",
            finish: "foil",
            unitPrice: 9.5,
          }),
        ],
      );
      const hook = candidates({ scope: "collection", text: "sol", marketplace: "cardmarket" });

      await waitFor(() => expect(hook.result.current.pending).toBe(false));

      // The deck groups and nothing else: no allocation to leave them out, and no lock to ask.
      expect(deckRead()).toEqual([
        { text: "sol", shelves: [11, 12], marketplace: "cardmarket", limit: 60, offset: 0 },
      ]);
      // Never mixed in: the ordinary list is the binder's two copies and nothing of a deck's.
      expect(hook.result.current.rows.map((r) => [r.key, r.owned, r.place, r.deckName])).toEqual([
        ["ring:nonfoil", 2, "collection", null],
      ]);
      expect(
        hook.result.current.deckRows.map((r) => [r.key, r.owned, r.place, r.deckName, r.unitPrice]),
      ).toEqual([
        // One row a deck, so the reader sees which deck a copy would come out of.
        ["ring:nonfoil:deck:11", 1, "deck", "Serah", 5.84],
        ["ring:nonfoil:deck:12", 2, "deck", "Azula", 5.84],
        ["ring:foil:deck:12", 1, "deck", "Azula", 9.5],
      ]);
      // The backend has no third word for where a line came from, and needs none.
      expect(hook.result.current.deckRows.map((r) => r.source)).toEqual([
        "collection",
        "collection",
        "collection",
      ]);
    });

    it("offers a card whose every copy is in a deck, where the other list is empty", async () => {
      collectionFolderList.mockResolvedValue(CABINET);
      answer([], [row({ id: 2, cardId: "ring", name: "Sol Ring", folderId: 11 })]);
      const hook = candidates({ scope: "collection", text: "sol", marketplace: "tcgplayer" });

      await waitFor(() => expect(hook.result.current.pending).toBe(false));

      expect(hook.result.current.rows).toEqual([]);
      // The folder list's own name for the group, where the row brought none.
      expect(hook.result.current.deckRows.map((r) => [r.name, r.deckName])).toEqual([
        ["Sol Ring", "Serah"],
      ]);
    });

    it("never offers a copy from Recently removed, a proxy, or a row no deck holds", async () => {
      collectionFolderList.mockResolvedValue(CABINET);
      answer(
        [
          row({ id: 1, cardId: "ring", name: "Sol Ring" }),
          // A stand-in for the card is not the card: the backend neither counts nor takes one.
          row({ id: 2, cardId: "ring", name: "Sol Ring", proxy: true, quantity: 4 }),
          row({ id: 3, cardId: "vault", name: "Sol Vault", folderId: 9 }),
        ],
        [
          row({ id: 4, cardId: "ring", name: "Sol Ring", folderId: 11 }),
          row({ id: 5, cardId: "ring", name: "Sol Ring", folderId: 11, proxy: true, quantity: 4 }),
          // An answer that is not the one asked for: the holding area, a binder, the root.
          row({ id: 6, cardId: "talisman", name: "Sol Talisman", folderId: 9 }),
          row({ id: 7, cardId: "grail", name: "Sol Grail", folderId: 7 }),
          row({ id: 8, cardId: "kite", name: "Sol Kite" }),
          // A row the last copy has left.
          row({ id: 9, cardId: "ray", name: "Solar Ray", folderId: 12, quantity: 0 }),
        ],
      );
      const hook = candidates({ scope: "collection", text: "sol", marketplace: "tcgplayer" });

      await waitFor(() => expect(hook.result.current.pending).toBe(false));

      expect(hook.result.current.rows.map((r) => [r.name, r.owned])).toEqual([["Sol Ring", 1]]);
      expect(hook.result.current.deckRows.map((r) => [r.name, r.owned, r.deckName])).toEqual([
        ["Sol Ring", 1, "Serah"],
      ]);
    });

    it("caps each list on its own, names first", async () => {
      collectionFolderList.mockResolvedValue(CABINET);
      answer(
        Array.from({ length: 20 }, (_, i) =>
          row({ id: i, cardId: `card-${i}`, name: `Goblin ${i}` }),
        ),
        [
          row({ id: 100, cardId: "runner", name: "Arc Runner", folderId: 11 }),
          ...Array.from({ length: 20 }, (_, i) =>
            row({ id: 101 + i, cardId: `deck-${i}`, name: `Goblin Deck ${i}`, folderId: 12 }),
          ),
        ],
      );
      const hook = candidates({ scope: "collection", text: "goblin", marketplace: "tcgplayer" });

      await waitFor(() => expect(hook.result.current.pending).toBe(false));

      expect(hook.result.current.rows).toHaveLength(CANDIDATE_LIMIT);
      expect(hook.result.current.deckRows).toHaveLength(CANDIDATE_LIMIT);
      // The card that only mentions a goblin sorted first by shelf, and is ranked out of the cut.
      expect(hook.result.current.deckRows.map((r) => r.name)).not.toContain("Arc Runner");
    });

    it("stays pending until both lists are in, so the top row is known before it is taken", async () => {
      collectionFolderList.mockResolvedValue(CABINET);
      let land: (rows: CollectionRow[]) => void = () => {};
      const late = new Promise<CollectionRow[]>((done) => {
        land = done;
      });
      collectionList.mockImplementation(async (q: CollectionQuery) => {
        const items =
          q.shelves === undefined ? [row({ id: 1, cardId: "ring", name: "Sol Ring" })] : await late;
        return { items, total: items.length };
      });
      const hook = candidates({ scope: "collection", text: "sol", marketplace: "tcgplayer" });

      await waitFor(() => expect(hook.result.current.rows).toHaveLength(1));
      expect(hook.result.current.pending).toBe(true);

      land([row({ id: 2, cardId: "ring", name: "Sol Ring", folderId: 11 })]);

      await waitFor(() => expect(hook.result.current.pending).toBe(false));
      expect(hook.result.current.deckRows).toHaveLength(1);
    });

    it("says a failed deck read rather than answering as if no deck held the card", async () => {
      collectionFolderList.mockResolvedValue(CABINET);
      collectionList.mockImplementation(async (q: CollectionQuery) => {
        if (q.shelves !== undefined) throw "database is locked";
        return { items: [row({ id: 1, cardId: "ring", name: "Sol Ring" })], total: 1 };
      });
      const hook = candidates({ scope: "collection", text: "sol", marketplace: "tcgplayer" });

      await waitFor(() => expect(hook.result.current.error).toBe("database is locked"));

      expect(hook.result.current.deckRows).toEqual([]);
    });

    it("asks nothing of the decks for every card, or where there is no deck", async () => {
      collectionFolderList.mockResolvedValue(CABINET);
      const all = candidates({ scope: "all", text: "sol", marketplace: "tcgplayer" });
      await waitFor(() => expect(all.result.current.pending).toBe(false));
      expect(collectionList).not.toHaveBeenCalled();
      all.unmount();

      collectionFolderList.mockResolvedValue([folder(7, "user"), folder(9, "removed")]);
      const none = candidates({ scope: "collection", text: "sol", marketplace: "tcgplayer" });
      await waitFor(() => expect(none.result.current.pending).toBe(false));
      expect(collectionList).toHaveBeenCalledTimes(1);
      expect(deckRead()).toEqual([]);
    });
  });

  it("puts a card named for the text above one that only mentions it", async () => {
    collectionList.mockResolvedValue({
      items: [
        // Name order, as the collection answers: the rules-text match sorts first.
        row({ id: 1, cardId: "a", name: "Arc Runner" }),
        row({ id: 2, cardId: "b", name: "Chain Lightning Bolt Thrower" }),
        row({ id: 3, cardId: "c", name: "Bolt Bend" }),
      ],
      total: 3,
    });
    const hook = candidates({ scope: "collection", text: "bolt", marketplace: "tcgplayer" });

    await waitFor(() => expect(hook.result.current.rows).toHaveLength(3));

    expect(hook.result.current.rows.map((r) => r.name)).toEqual([
      "Bolt Bend",
      "Chain Lightning Bolt Thrower",
      "Arc Runner",
    ]);
  });

  it("offers no more than the limit, however many rows the collection has", async () => {
    collectionList.mockResolvedValue({
      items: Array.from({ length: 20 }, (_, i) =>
        row({ id: i, cardId: `card-${i}`, name: `Goblin ${i}` }),
      ),
      total: 20,
    });
    const hook = candidates({ scope: "collection", text: "goblin", marketplace: "tcgplayer" });

    await waitFor(() => expect(hook.result.current.rows.length).toBeGreaterThan(0));

    expect(hook.result.current.rows).toHaveLength(CANDIDATE_LIMIT);
  });

  it("reads the card search for every card, one row a card in its first finish", async () => {
    searchCards.mockResolvedValue({
      items: [
        card({ id: "bolt", name: "Lightning Bolt" }),
        // A foil-only printing: the search's price is its foil's, so the candidate is foil.
        card({ id: "promo", name: "Bolt Promo", finishes: '["foil"]', price: 30 }),
        // Finishes unknown: the regular copy, which is what a price is assumed to be.
        card({ id: "odd", name: "Bolt Oddity", finishes: null, price: null }),
      ],
      total: 3,
      totalIsCapped: false,
    });
    const hook = candidates({ scope: "all", text: "bolt", marketplace: "manapool" });

    await waitFor(() => expect(hook.result.current.rows).toHaveLength(3));

    expect(searchCards).toHaveBeenCalledExactlyOnceWith({
      text: "bolt",
      collapse: true,
      marketplace: "manapool",
      limit: CANDIDATE_LIMIT,
      offset: 0,
    });
    expect(collectionList).not.toHaveBeenCalled();
    expect(
      hook.result.current.rows.map((r) => [r.key, r.finish, r.unitPrice, r.owned, r.source]),
    ).toEqual([
      ["bolt:nonfoil", "nonfoil", 2.1, null, "search"],
      ["promo:foil", "foil", 30, null, "search"],
      ["odd:nonfoil", "nonfoil", null, null, "search"],
    ]);
    // Nobody's copies: neither place, and no deck.
    expect(hook.result.current.rows.map((r) => [r.place, r.deckName])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    expect(hook.result.current.deckRows).toEqual([]);
  });

  it("sends Scryfall's syntax as terms, as every other card box does", async () => {
    const hook = candidates({ scope: "all", text: "t:goblin bolt", marketplace: "tcgplayer" });

    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    await waitFor(() => expect(hook.result.current.pending).toBe(false));

    expect(searchCards.mock.lastCall?.[0]).toMatchObject({
      text: "bolt",
      predicates: [{ field: "typeLine", value: "goblin", negated: false }],
    });
  });

  it("switches read with the scope, and empties the moment the field does", async () => {
    collectionList.mockResolvedValue({
      items: [row({ id: 1, cardId: "charm", name: "Boros Charm" })],
      total: 1,
    });
    searchCards.mockResolvedValue({
      items: [card({ id: "bolt", name: "Lightning Bolt" })],
      total: 1,
      totalIsCapped: false,
    });
    const hook = candidates({ scope: "collection", text: "b", marketplace: "tcgplayer" });
    await waitFor(() => expect(hook.result.current.rows[0]?.name).toBe("Boros Charm"));

    hook.rerender({ scope: "all", text: "b", marketplace: "tcgplayer" });
    await waitFor(() => expect(hook.result.current.rows[0]?.name).toBe("Lightning Bolt"));

    // No 300ms of the last search's rows hanging under an empty box.
    hook.rerender({ scope: "all", text: "", marketplace: "tcgplayer" });
    expect(hook.result.current).toEqual({ rows: [], deckRows: [], pending: false, error: null });
  });

  it("says a failed search in the backend's own words", async () => {
    searchCards.mockRejectedValue("fts5: syntax error");
    const hook = candidates({ scope: "all", text: "bolt", marketplace: "tcgplayer" });

    await waitFor(() => expect(hook.result.current.error).toBe("fts5: syntax error"));

    expect(hook.result.current.rows).toEqual([]);
  });
});
