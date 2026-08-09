/**
 * What the row store has to get right, and nothing that merely restates it.
 *
 * The first block is the whole reason `db.ts` stores rows: `ownedQuantity` is three
 * different questions with one name, and a fake that stored DTOs would answer them
 * identically and be plausible every time.
 */
import { describe, expect, it } from "vitest";
import { invoke, registerCommands, resetCommands } from "./core";
import { allHandlers, makeDb, readHandlers, writeHandlers } from "./db";
import type { FakeDeck, FakeDeckCard, FakeEntry, FakeWish } from "./db";
import { CARDS, type FakeCard } from "./cards";
import type {
  CardSummary,
  CollectionPage,
  DeckDetail,
  EntryChange,
  EntryInput,
  WishlistPage,
} from "@/lib/ipc";

const BOLT = CARDS.find((c) => c.name === "Lightning Bolt")!;
/** The second Bolt printing — `2x2 117`, uncommon. Used wherever "a different printing of
 *  the same card" is the point. */
const BOLT_2X2 = CARDS.filter((c) => c.name === "Lightning Bolt")[1];
/** Fixed rather than `Date.now()`: a story fixture with a moving timestamp is a story
 *  fixture that renders differently every second. 2026-08-09T09:00:00Z. */
const WHEN = 1786266000;

/**
 * A collection row, with the denormalised printing copied off the card it names — which is
 * what `collection_add` does at write time, and the reason those three columns outlive the
 * printing. An id no card has leaves them at the caller's values, so an orphan is one
 * `cardId: "gone"` away.
 */
function entry(over: Partial<FakeEntry> = {}): FakeEntry {
  const card = CARDS.find((c) => c.id === (over.cardId ?? BOLT.id));
  return {
    id: 1,
    cardId: BOLT.id,
    finish: "nonfoil",
    condition: "NM",
    quantity: 1,
    tradelistQuantity: 0,
    lang: card?.lang ?? "en",
    setCode: card?.setCode ?? "xxx",
    collectorNumber: card?.collectorNumber ?? "1",
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
    conditionOriginal: null,
    tags: "[]",
    notes: null,
    needsReview: null,
    updatedAt: WHEN,
    ...over,
  };
}

function wish(over: Partial<FakeWish> = {}): FakeWish {
  const card = CARDS.find((c) => c.id === over.cardId);
  return {
    id: 1,
    cardId: null,
    oracleId: card?.oracleId ?? BOLT.oracleId,
    name: card?.name ?? BOLT.name,
    setCode: card?.setCode ?? null,
    collectorNumber: card?.collectorNumber ?? null,
    lang: card?.lang ?? null,
    quantity: 1,
    preferredFinish: null,
    notes: null,
    needsReview: null,
    updatedAt: WHEN,
    ...over,
  };
}

function deck(over: Partial<FakeDeck> = {}): FakeDeck {
  return {
    id: 1,
    name: "Test deck",
    formatKey: "modern",
    description: null,
    coverCardId: null,
    isBuilt: false,
    archived: false,
    updatedAt: WHEN,
    ...over,
  };
}

function deckCard(over: Partial<FakeDeckCard> = {}): FakeDeckCard {
  const card = CARDS.find((c) => c.id === (over.cardId ?? BOLT.id));
  return {
    id: 1,
    deckId: 1,
    cardId: BOLT.id,
    zone: "main",
    quantity: 1,
    name: card?.name ?? "Gone",
    setCode: card?.setCode ?? "xxx",
    collectorNumber: card?.collectorNumber ?? "1",
    lang: card?.lang ?? "en",
    needsReview: null,
    ...over,
  };
}

/** `n` distinct paper printings, for the one thing that needs more cards than the fixture
 *  has: the search's 5 000-row count ceiling. */
function bulkCards(n: number): FakeCard[] {
  return Array.from({ length: n }, (_, i) => ({
    ...BOLT,
    id: `bulk-${i}`,
    // Padded so the default name order is the generated order, which keeps a paging
    // assertion readable if one is ever added.
    name: `Bulk Card ${String(i).padStart(5, "0")}`,
  }));
}

describe("the three ownedQuantity derivations", () => {
  it("is finish-BLIND on a search row: a foil and a nonfoil of one printing sum", () => {
    const db = makeDb({
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, finish: "nonfoil", quantity: 2 }),
        entry({ id: 2, cardId: BOLT.id, finish: "foil", quantity: 1 }),
      ],
    });
    const page = readHandlers(db).search_cards({
      req: { text: "Lightning Bolt", limit: 10, offset: 0 },
    }) as { items: CardSummary[] };
    expect(page.items.find((i) => i.id === BOLT.id)!.ownedQuantity).toBe(3);
  });

  it("is finish-AWARE on a wish: a foil wish is not filled by the nonfoil in the binder", () => {
    const db = makeDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, finish: "nonfoil", quantity: 4 })],
      wishlistEntries: [wish({ id: 1, cardId: BOLT.id, preferredFinish: "foil", quantity: 1 })],
    });
    const page = readHandlers(db).wishlist_list({
      query: { limit: 10, offset: 0 },
    }) as WishlistPage;
    expect(page.items[0].ownedQuantity).toBe(0);
  });

  it("is an ALLOCATION on a deck card, and the maybe pile is never allocated", () => {
    const db = makeDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, finish: "nonfoil", quantity: 3 })],
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, deckId: 1, cardId: BOLT.id, zone: "main", quantity: 2 }),
        deckCard({ id: 2, deckId: 1, cardId: BOLT.id, zone: "maybe", quantity: 4 }),
      ],
    });
    const detail = readHandlers(db).deck_get({ id: 1 }) as DeckDetail;
    expect(detail.cards.find((c) => c.zone === "main")!.ownedQuantity).toBe(2);
    expect(detail.cards.find((c) => c.zone === "maybe")!.ownedQuantity).toBe(0);
  });
});

describe("zero", () => {
  it("keeps a collection row, with its condition and its purchase price", () => {
    const db = makeDb({
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, quantity: 0, condition: "LP", purchasePrice: 12 }),
      ],
    });
    const page = readHandlers(db).collection_list({
      query: { limit: 10, offset: 0 },
    }) as CollectionPage;
    expect(page.items).toHaveLength(1);
    expect(page.items[0].condition).toBe("LP");
    expect(page.items[0].purchasePrice).toBe(12);
  });

  it("still counts as owned to the search's `owned` filter, which counts entries", () => {
    const db = makeDb({ collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 0 })] });
    const page = readHandlers(db).search_cards({
      req: { owned: true, limit: 100, offset: 0 },
    }) as { items: CardSummary[] };
    expect(page.items.map((i) => i.id)).toContain(BOLT.id);
    expect(page.items.find((i) => i.id === BOLT.id)!.ownedQuantity).toBe(0);
  });
});

describe("the search's total", () => {
  it("caps at 5000 and says that it did", () => {
    const db = makeDb({ cards: bulkCards(5200) });
    const page = readHandlers(db).search_cards({ req: { limit: 10, offset: 0 } }) as {
      total: number;
      totalIsCapped: boolean;
    };
    expect(page.total).toBe(5000);
    expect(page.totalIsCapped).toBe(true);
  });
});

describe("the paper filter", () => {
  it("defaults to on and keys on isPaper, so the two digital printings are hidden", () => {
    const db = makeDb();
    const all = readHandlers(db).search_cards({ req: { limit: 200, offset: 0 } });
    const withDigital = readHandlers(db).search_cards({
      req: { paperOnly: false, limit: 200, offset: 0 },
    });
    // 43 fixture rows, 2 of them `isPaper: false` (Black Lotus `vma`, A-Vivi Ornitier
    // `fin`) — measured 2026-08-09 over `CARDS`.
    expect(withDigital.items).toHaveLength(43);
    expect(all.items).toHaveLength(41);
  });

  it("is off for the collection, which lists what the user owns", () => {
    const vma = CARDS.find((c) => c.name === "Black Lotus" && c.setCode === "vma")!;
    const db = makeDb({ collectionEntries: [entry({ id: 1, cardId: vma.id })] });
    const page = readHandlers(db).collection_list({ query: { limit: 10, offset: 0 } });
    expect(page.items).toHaveLength(1);
  });
});

describe("a row whose card is gone", () => {
  it("is listed with null card fields and its own set code and lang", () => {
    const db = makeDb({
      collectionEntries: [
        entry({
          id: 1,
          cardId: "no-such-card",
          setCode: "lea",
          collectorNumber: "161",
          lang: "en",
        }),
      ],
    });
    const page = readHandlers(db).collection_list({ query: { limit: 10, offset: 0 } });
    expect(page.items[0].name).toBeNull();
    expect(page.items[0].rarity).toBeNull();
    expect(page.items[0].unitPriceUsd).toBeNull();
    expect(page.items[0].setCode).toBe("lea");
    expect(page.items[0].lang).toBe("en");
  });

  it("survives a colour filter and fails a rarity one — SQL's NULLs, not a rule of thumb", () => {
    const db = makeDb({ collectionEntries: [entry({ id: 1, cardId: "no-such-card" })] });
    const handlers = readHandlers(db);
    // `instr(coalesce(NULL,''),'W') = 0` is 1, so the exclusion form the colour filter is
    // written as passes an orphan; `NULL = 'rare'` is NULL, so the rarity filter drops it.
    // Both measured against SQLite 2026-08-09 (`node:sqlite`, a single all-NULL row).
    expect(
      handlers.collection_list({ query: { colors: "R", limit: 10, offset: 0 } }).items,
    ).toHaveLength(1);
    expect(
      handlers.collection_list({ query: { rarity: "rare", limit: 10, offset: 0 } }).items,
    ).toHaveLength(0);
  });
});

describe("prices", () => {
  it("reads a collection row's price by its finish, never the fallback column", () => {
    // `sta 105`, the Japanese Lightning Bolt: usd 17.85, usd_foil 23.85, usd_etched 18.68,
    // eur 15.45 — three distinct USD keys, so the three finishes cannot agree by accident.
    const sta = CARDS.find((c) => c.setCode === "sta" && c.name === "Lightning Bolt")!;
    const db = makeDb({
      collectionEntries: [
        entry({ id: 1, cardId: sta.id, finish: "nonfoil" }),
        entry({ id: 2, cardId: sta.id, finish: "foil" }),
        entry({ id: 3, cardId: sta.id, finish: "etched" }),
      ],
    });
    const page = readHandlers(db).collection_list({ query: { limit: 10, offset: 0 } });
    const usd = page.items.map((i) => i.unitPriceUsd);
    expect(new Set(usd).size).toBe(3);
    // `eur_etched` does not exist, so the etched row is unpriced in euros rather than
    // quoted at the nonfoil rate.
    expect(page.items.find((i) => i.finish === "etched")!.unitPriceEur).toBeNull();
  });

  it("counts a zero row in uniqueCards and not in totalCards", () => {
    const db = makeDb({
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, quantity: 0 }),
        entry({ id: 2, cardId: BOLT_2X2.id, quantity: 2 }),
      ],
    });
    const summary = readHandlers(db).collection_summary({ query: { limit: 0, offset: 0 } });
    expect(summary.totalCards).toBe(2);
    expect(summary.uniqueCards).toBe(2);
    expect(summary.entries).toBe(2);
  });
});

describe("the printings list", () => {
  it("is paper only and newest first", () => {
    const answer = readHandlers(makeDb()).card_printings({ oracleId: BOLT.oracleId });
    // Four Lightning Bolt printings in the fixture, all paper — measured over `CARDS`.
    expect(answer.total).toBe(4);
    expect(answer.items).toHaveLength(4);
    const dates = answer.items.map((i) => i.releasedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("answers nothing for a blank oracle id rather than matching every card without one", () => {
    expect(readHandlers(makeDb()).card_printings({ oracleId: "  " })).toEqual({
      items: [],
      total: 0,
    });
  });
});

describe("card detail", () => {
  it("derives faces the way parse_faces does, blank mana cost and all", () => {
    // Delver of Secrets: the back face is a transform back, whose `mana_cost` is `""` in
    // Scryfall's blob and must not render as a cost of `{}`.
    const delver = CARDS.find((c) => c.name.startsWith("Delver of Secrets"))!;
    const detail = readHandlers(makeDb()).card_detail({ id: delver.id })!;
    expect(detail.faces).toHaveLength(2);
    expect(detail.faces[0].manaCost).toBe("{U}");
    expect(detail.faces[1].manaCost).toBeNull();
  });

  it("answers null for an id no row has", () => {
    expect(readHandlers(makeDb()).card_detail({ id: "no-such-card" })).toBeNull();
  });
});

describe("the allocator", () => {
  it("prefers the exact printing, then falls back to any printing of the same card", () => {
    const db = makeDb({
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, quantity: 1 }),
        entry({ id: 2, cardId: BOLT_2X2.id, quantity: 4 }),
      ],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT_2X2.id, zone: "main", quantity: 4 })],
    });
    const detail = readHandlers(db).deck_get({ id: 1 })!;
    // All four from the exact printing's own entry, leaving the `lea` copy alone.
    expect(detail.cards[0].ownedQuantity).toBe(4);
  });

  it("hands the commander its copy before the main deck gets one", () => {
    const solRing = CARDS.filter((c) => c.name === "Sol Ring")[0];
    const db = makeDb({
      collectionEntries: [entry({ id: 1, cardId: solRing.id, quantity: 1 })],
      decks: [deck({ id: 1, formatKey: "commander" })],
      deckCards: [
        // The main-deck row is first by id, so only zone priority can put the commander
        // ahead of it.
        deckCard({ id: 1, cardId: solRing.id, zone: "main", quantity: 1 }),
        deckCard({ id: 2, cardId: solRing.id, zone: "commander", quantity: 1 }),
      ],
    });
    const detail = readHandlers(db).deck_get({ id: 1 })!;
    expect(detail.cards.find((c) => c.zone === "commander")!.ownedQuantity).toBe(1);
    expect(detail.cards.find((c) => c.zone === "main")!.ownedQuantity).toBe(0);
  });

  it("takes a built deck's claims off what another deck can see, and a draft's not", () => {
    const seed = (isBuilt: boolean) =>
      makeDb({
        collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 2 })],
        decks: [deck({ id: 1, isBuilt }), deck({ id: 2 })],
        deckCards: [
          deckCard({ id: 1, deckId: 1, cardId: BOLT.id, quantity: 2 }),
          deckCard({ id: 2, deckId: 2, cardId: BOLT.id, quantity: 2 }),
        ],
      });
    expect(readHandlers(seed(true)).deck_get({ id: 2 })!.cards[0].ownedQuantity).toBe(0);
    expect(readHandlers(seed(false)).deck_get({ id: 2 })!.cards[0].ownedQuantity).toBe(2);
  });

  it("splits one copy between two built decks instead of giving it to neither", () => {
    // The regression this exists for: allocating the read's own deck *last*, from what every
    // other built deck left, makes each read hand the copy to the other one — so both answer
    // 0 and nobody holds it. One id-ordered pass over every built deck, the read's included,
    // is what makes the two answers add up.
    const db = makeDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 1 })],
      decks: [deck({ id: 1, isBuilt: true }), deck({ id: 2, isBuilt: true })],
      deckCards: [
        deckCard({ id: 1, deckId: 1, cardId: BOLT.id, quantity: 1 }),
        deckCard({ id: 2, deckId: 2, cardId: BOLT.id, quantity: 1 }),
      ],
    });
    const owned = (id: number) => readHandlers(db).deck_get({ id })!.cards[0].ownedQuantity;
    expect([owned(1), owned(2)]).toEqual([1, 0]);
  });

  it("gives two copies to the first two of three built decks, by deck id", () => {
    const db = makeDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 2 })],
      decks: [1, 2, 3].map((id) => deck({ id, isBuilt: true })),
      deckCards: [1, 2, 3].map((id) => deckCard({ id, deckId: id, cardId: BOLT.id, quantity: 1 })),
    });
    const owned = (id: number) => readHandlers(db).deck_get({ id })!.cards[0].ownedQuantity;
    expect([owned(1), owned(2), owned(3)]).toEqual([1, 1, 0]);
  });

  it("is never blocked by the built deck's own claims", () => {
    const db = makeDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 2 })],
      decks: [deck({ id: 1, isBuilt: true })],
      deckCards: [deckCard({ id: 1, deckId: 1, cardId: BOLT.id, quantity: 2 })],
    });
    expect(readHandlers(db).deck_get({ id: 1 })!.cards[0].ownedQuantity).toBe(2);
  });
});

describe("the deck read", () => {
  it("orders by zone priority, then name, then row id", () => {
    const counterspell = CARDS.find((c) => c.name === "Counterspell")!;
    const db = makeDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, zone: "maybe" }),
        deckCard({ id: 2, cardId: counterspell.id, zone: "main" }),
        deckCard({ id: 3, cardId: BOLT.id, zone: "commander" }),
        deckCard({ id: 4, cardId: BOLT.id, zone: "main" }),
      ],
    });
    expect(
      readHandlers(db)
        .deck_get({ id: 1 })!
        .cards.map((c) => [c.zone, c.name]),
    ).toEqual([
      ["commander", "Lightning Bolt"],
      ["main", "Counterspell"],
      ["main", "Lightning Bolt"],
      ["maybe", "Lightning Bolt"],
    ]);
  });

  it("prices a deck card at the printing's nonfoil usd, and counts only main + commander", () => {
    const db = makeDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, zone: "main", quantity: 3 }),
        deckCard({ id: 2, cardId: BOLT.id, zone: "side", quantity: 2 }),
        deckCard({ id: 3, cardId: BOLT.id, zone: "commander", quantity: 1 }),
      ],
    });
    const detail = readHandlers(db).deck_get({ id: 1 })!;
    // `lea 161`'s blob is `usd` 620.00 with both foil keys null.
    expect(detail.cards[0].unitPriceUsd).toBe(620);
    expect(detail.deck.cardCount).toBe(4);
  });

  it("reads everUncommon off the column, not off the 43 rows the fixture happens to hold", () => {
    // Delver of Secrets is the one row where the two disagree: `everUncommon: true` from the
    // full corpus, while the only Delver printing here is the `isd` **common**. Recomputed,
    // Pauper Commander would show a legal commander as ineligible.
    const delver = CARDS.find((c) => c.name.startsWith("Delver of Secrets"))!;
    expect(delver.rarity).toBe("common");
    const db = makeDb({
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: delver.id, zone: "commander" })],
    });
    expect(readHandlers(db).deck_get({ id: 1 })!.cards[0].everUncommon).toBe(true);
  });

  it("answers null under the gone fault, which is what a deleted deck looks like", () => {
    const db = makeDb({ decks: [deck({ id: 1 })], fault: "gone" });
    expect(readHandlers(db).deck_get({ id: 1 })).toBeNull();
  });
});

describe("the table as a command table", () => {
  it("registers whole and dispatches under the names ipc.ts sends", async () => {
    resetCommands();
    registerCommands(readHandlers(makeDb({ collectionEntries: [entry({ id: 1 })] })));
    await expect(
      invoke<CollectionPage>("collection_list", { query: { limit: 10, offset: 0 } }),
    ).resolves.toMatchObject({ total: 1 });
    // The argument *name* is the half of the contract only a dispatcher can check: `invoke`
    // matches by name, so `q` reaches the handler as an undefined `query` and is a runtime
    // rejection here exactly as it is in the app.
    await expect(invoke("collection_list", { q: {} })).rejects.toThrow();
  });
});

describe("the tables that are not tables", () => {
  it("serves format_specs from the validation fixtures, in sort order", () => {
    const specs = readHandlers(makeDb()).format_specs_list();
    // 12 of the 25 seeded rows — `fixtures.ts` mirrors the formats the engine tests need,
    // measured 2026-08-09.
    expect(specs).toHaveLength(12);
    expect(specs.map((s) => s.sortOrder)).toEqual(
      [...specs.map((s) => s.sortOrder)].sort((a, b) => a - b),
    );
  });

  it("derives the set list from the cards, counting paper printings only", () => {
    const sets = readHandlers(makeDb()).list_sets();
    // 33 distinct set codes over the 43 fixture rows, measured 2026-08-09.
    expect(sets).toHaveLength(33);
    // `vma` holds one fixture row and it is digital, so the picker offers a 0 — the state
    // the real `list_sets` reaches through its `FILTER (WHERE is_paper = 1)`.
    expect(sets.find((s) => s.code === "vma")!.cardCount).toBe(0);
    const dates = sets.map((s) => s.releasedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("reports the fixture's own card count and the faults the sync surfaces", () => {
    expect(readHandlers(makeDb()).sync_status()).toMatchObject({
      cardCount: 43,
      syncing: false,
      lastError: null,
      imageStoreFailures: 0,
    });
    expect(readHandlers(makeDb({ fault: "syncError" })).sync_status().lastError).not.toBeNull();
    expect(
      readHandlers(makeDb({ fault: "imageFailures" })).sync_status().imageStoreFailures,
    ).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ the writes ------- */

/** The two Lightning Bolt printings the swap tests pair off. */
const [BOLT_A, BOLT_B] = CARDS.filter((c) => c.oracleId === BOLT.oracleId);

describe("zero is not one thing", () => {
  it("keeps the collection row and says removed: false", () => {
    const db = makeDb({ collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 3 })] });
    const change = writeHandlers(db).collection_set_quantity({ id: 1, quantity: 0 });
    expect(change).toMatchObject({ quantity: 0, removed: false });
    expect(db.collectionEntries).toHaveLength(1);
  });

  it("keeps the condition, the price paid and the tags on the row it emptied", () => {
    const db = makeDb({
      collectionEntries: [
        entry({ id: 1, quantity: 3, condition: "LP", purchasePrice: 12, tags: '["cube"]' }),
      ],
    });
    writeHandlers(db).collection_set_quantity({ id: 1, quantity: 0 });
    expect(db.collectionEntries[0]).toMatchObject({
      condition: "LP",
      purchasePrice: 12,
      tags: '["cube"]',
      // A tradelist bigger than the pile it comes from is not a promise anyone can keep.
      tradelistQuantity: 0,
    });
  });

  it("removes the wish, because a wish for none of something is not a wish", () => {
    const db = makeDb({ wishlistEntries: [wish({ id: 1, cardId: BOLT.id, quantity: 2 })] });
    const change = writeHandlers(db).wishlist_set_quantity({ id: 1, quantity: 0 });
    expect(change).toMatchObject({ removed: true });
    expect(db.wishlistEntries).toHaveLength(0);
  });

  it("removes the deck row, siding with the wishlist", () => {
    const db = makeDb({
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, deckId: 1, cardId: BOLT.id, zone: "main", quantity: 2 })],
    });
    writeHandlers(db).deck_set_card_quantity({
      deckId: 1,
      cardId: BOLT.id,
      zone: "main",
      quantity: 0,
    });
    expect(db.deckCards).toHaveLength(0);
  });

  it("refuses below zero in all three, and a refused write changes nothing", () => {
    const db = makeDb({
      collectionEntries: [entry({ id: 1, quantity: 3 })],
      wishlistEntries: [wish({ id: 1, quantity: 2 })],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, quantity: 4 })],
    });
    const w = writeHandlers(db);
    for (const call of [
      () => w.collection_set_quantity({ id: 1, quantity: -1 }),
      () => w.wishlist_set_quantity({ id: 1, quantity: -1 }),
      () => w.deck_set_card_quantity({ deckId: 1, cardId: BOLT.id, zone: "main", quantity: -1 }),
    ]) {
      expect(call).toThrow(/not a quantity/);
    }
    expect(db.collectionEntries[0].quantity).toBe(3);
    expect(db.wishlistEntries).toHaveLength(1);
    expect(db.deckCards[0].quantity).toBe(4);
  });
});

describe("the collection grain", () => {
  const add = (over: Partial<EntryInput> = {}): { entry: EntryInput } => ({
    entry: { cardId: BOLT.id, finish: "nonfoil", quantity: 1, ...over },
  });

  it("folds a second add of the same grain into the row that is already there", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    const first = w.collection_add(add({ quantity: 2, purchasePrice: 10 }));
    const second = w.collection_add(add({ quantity: 3, purchasePrice: 99 }));
    expect(first.id).toBe(second.id);
    expect(second.quantity).toBe(5);
    expect(db.collectionEntries).toHaveLength(1);
    // "One more of these", not "and here is what I paid this time": the first writer's
    // price stays.
    expect(db.collectionEntries[0].purchasePrice).toBe(10);
  });

  it("makes a copy that differs in any term of the grain a second row", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    w.collection_add(add());
    w.collection_add(add({ finish: "foil" }));
    w.collection_add(add({ finish: "foil", condition: "LP" }));
    w.collection_add(add({ finish: "foil", signed: true }));
    w.collection_add(add({ finish: "foil", serialNumber: "042/500" }));
    expect(db.collectionEntries).toHaveLength(5);
  });

  it("is one row for one slab however its JSON was spelled", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    const first = w.collection_add(
      add({ grading: '{"company":"PSA","grade":10,"cert":"12345678"}' }),
    );
    const again = w.collection_add(
      add({ grading: '{ "cert": "12345678", "grade": "10", "company": "PSA" }' }),
    );
    expect(again.id).toBe(first.id);
    // An absent cert and an explicit null are the same slab, and neither is the certified one.
    const bare = w.collection_add(add({ grading: '{"company":"PSA","grade":10}' }));
    const nullCert = w.collection_add(add({ grading: '{"grade":10,"cert":null,"company":"PSA"}' }));
    expect(nullCert.id).toBe(bare.id);
    expect(bare.id).not.toBe(first.id);
    expect(db.collectionEntries.map((e) => e.grading)).toEqual([
      '{"company":"PSA","grade":"10","cert":"12345678"}',
      '{"company":"PSA","grade":"10"}',
    ]);
  });

  it("refuses a grading that is not one, in a sentence naming the shape", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    for (const bad of [
      "not json at all",
      '{"company":"PSA"}',
      '{"grade":10}',
      '{"company":"PSA","grade":10,"subgrades":{"centering":9}}',
      '["PSA", 10]',
    ]) {
      expect(() => w.collection_add(add({ grading: bad }))).toThrow(/is not a grading/);
    }
    expect(db.collectionEntries).toHaveLength(0);
  });

  it("denormalizes the printing, and refuses a card the database does not have", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    w.collection_add({ entry: { cardId: BOLT_B.id, finish: "nonfoil", quantity: 1 } });
    expect(db.collectionEntries[0]).toMatchObject({
      setCode: BOLT_B.setCode,
      collectorNumber: BOLT_B.collectorNumber,
      lang: BOLT_B.lang,
    });
    expect(() =>
      w.collection_add({ entry: { cardId: "no-such-card", finish: "nonfoil", quantity: 1 } }),
    ).toThrow(/no card with the id/);
  });

  it("refuses an add of zero rather than conjuring a row out of nothing", () => {
    const db = makeDb();
    expect(() => writeHandlers(db).collection_add(add({ quantity: 0 }))).toThrow(/at least one/);
    expect(db.collectionEntries).toHaveLength(0);
  });

  it("tells an edit that lands on an occupied grain what to do instead", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    const nonfoil = w.collection_add(add());
    w.collection_add(add({ finish: "foil" }));
    expect(() => w.collection_update({ id: nonfoil.id, patch: { finish: "foil" } })).toThrow(
      /change its quantity instead/,
    );
    expect(db.collectionEntries[0].finish).toBe("nonfoil");
  });

  it("removes only through collection_remove", () => {
    const db = makeDb({ collectionEntries: [entry({ id: 1, quantity: 0 })] });
    expect(writeHandlers(db).collection_remove({ id: 1 })).toMatchObject({ removed: true });
    expect(db.collectionEntries).toHaveLength(0);
    // A stale id is a success: the caller wanted that row gone, and it is gone.
    expect(writeHandlers(db).collection_remove({ id: 1 }).removed).toBe(true);
  });
});

describe("the wishlist write", () => {
  it("makes a pinned wish and an any-printing wish two different wishes", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    const any = w.wishlist_add({ wish: { oracleId: BOLT.oracleId!, quantity: 4 } });
    const pinned = w.wishlist_add({ wish: { cardId: BOLT.id, quantity: 1 } });
    expect(any.id).not.toBe(pinned.id);
    // An any-printing wish pins nothing but its name.
    expect(db.wishlistEntries.find((x) => x.id === any.id)).toMatchObject({
      cardId: null,
      setCode: null,
      collectorNumber: null,
      lang: null,
      name: BOLT.name,
    });
    expect(db.wishlistEntries.find((x) => x.id === pinned.id)!.setCode).toBe(BOLT.setCode);
  });

  it("raises the quantity rather than making a second line", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    const first = w.wishlist_add({ wish: { oracleId: BOLT.oracleId!, quantity: 1 } });
    const second = w.wishlist_add({ wish: { oracleId: BOLT.oracleId!, quantity: 3 } });
    expect([second.id, second.quantity]).toEqual([first.id, 4]);
    expect(db.wishlistEntries).toHaveLength(1);
  });

  it("refuses a wish that names neither a card nor an oracle card", () => {
    const db = makeDb();
    expect(() => writeHandlers(db).wishlist_add({ wish: { oracleId: "  ", quantity: 1 } })).toThrow(
      /either a card or an oracle id/,
    );
    expect(db.wishlistEntries).toHaveLength(0);
  });
});

describe("the deck grain (deck, card, zone)", () => {
  it("sums a repeat add into one row", () => {
    const db = makeDb({ decks: [deck({ id: 1 })] });
    const w = writeHandlers(db);
    w.deck_add_card({ deckId: 1, cardId: BOLT.id, zone: "main", quantity: 2 });
    w.deck_add_card({ deckId: 1, cardId: BOLT.id, zone: "main", quantity: 3 });
    expect(db.deckCards).toHaveLength(1);
    expect(db.deckCards[0].quantity).toBe(5);
  });

  it("makes the same printing in two zones two rows", () => {
    const db = makeDb({ decks: [deck({ id: 1 })] });
    const w = writeHandlers(db);
    w.deck_add_card({ deckId: 1, cardId: BOLT.id, zone: "main", quantity: 1 });
    w.deck_add_card({ deckId: 1, cardId: BOLT.id, zone: "side", quantity: 1 });
    expect(db.deckCards).toHaveLength(2);
  });

  it("refuses to add a card the database does not have, or none of one", () => {
    const db = makeDb({ decks: [deck({ id: 1 })] });
    const w = writeHandlers(db);
    expect(() =>
      w.deck_add_card({ deckId: 1, cardId: "no-such-card", zone: "main", quantity: 1 }),
    ).toThrow(/no card with the id/);
    expect(() =>
      w.deck_add_card({ deckId: 1, cardId: BOLT.id, zone: "main", quantity: 0 }),
    ).toThrow(/at least one/);
    expect(db.deckCards).toHaveLength(0);
  });

  it("folds a swap onto a printing the zone already holds, and says so", () => {
    const db = makeDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, deckId: 1, cardId: BOLT_A.id, zone: "main", quantity: 2 }),
        deckCard({ id: 2, deckId: 1, cardId: BOLT_B.id, zone: "main", quantity: 1 }),
      ],
    });
    const result = writeHandlers(db).deck_swap_printing({
      deckId: 1,
      fromCardId: BOLT_A.id,
      toCardId: BOLT_B.id,
      zone: "main",
    });
    expect(result).toEqual({ folded: true, quantity: 3 });
    expect(db.deckCards).toHaveLength(1);
  });

  it("refuses a swap to a different oracle card", () => {
    const other = CARDS.find((c) => c.oracleId !== BOLT.oracleId)!;
    const db = makeDb({
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, deckId: 1, cardId: BOLT.id, zone: "main", quantity: 1 })],
    });
    expect(() =>
      writeHandlers(db).deck_swap_printing({
        deckId: 1,
        fromCardId: BOLT.id,
        toCardId: other.id,
        zone: "main",
      }),
    ).toThrow(/not another printing of/);
    expect(db.deckCards[0].cardId).toBe(BOLT.id);
  });

  it("rescues an orphaned row, which is the one pair that cannot be compared", () => {
    const db = makeDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({
          id: 1,
          deckId: 1,
          cardId: "no-such-card",
          zone: "main",
          quantity: 3,
          needsReview: "Scryfall removed this printing from its database.",
        }),
      ],
    });
    const result = writeHandlers(db).deck_swap_printing({
      deckId: 1,
      fromCardId: "no-such-card",
      toCardId: BOLT.id,
      zone: "main",
    });
    expect(result).toEqual({ folded: false, quantity: 3 });
    // The swap is the cure, so the new row is written clean.
    expect(db.deckCards[0]).toMatchObject({ cardId: BOLT.id, needsReview: null });
  });

  it("refuses a swap to the printing the deck already plays", () => {
    const db = makeDb({
      decks: [deck({ id: 1, updatedAt: 100 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT.id, zone: "main" })],
    });
    expect(() =>
      writeHandlers(db).deck_swap_printing({
        deckId: 1,
        fromCardId: BOLT.id,
        toCardId: BOLT.id,
        zone: "main",
      }),
    ).toThrow(/already this printing/);
    // A no-op must not move `updatedAt` and resort the gallery.
    expect(db.decks[0].updatedAt).toBe(100);
  });

  it("moves every copy into the zone the target holds, folding", () => {
    const db = makeDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, zone: "maybe", quantity: 2 }),
        deckCard({ id: 2, cardId: BOLT.id, zone: "main", quantity: 1 }),
      ],
    });
    writeHandlers(db).deck_move_card({ deckId: 1, cardId: BOLT.id, from: "maybe", to: "main" });
    expect(db.deckCards).toHaveLength(1);
    expect(db.deckCards[0]).toMatchObject({ zone: "main", quantity: 3 });
  });

  it("lands a move into an empty zone on a new row id, not the one it came from", () => {
    // `INSERT … SELECT` then `DELETE`, so the copies land on a fresh rowid — and row id is
    // what the allocator breaks ties on within a zone, so the moved row queues behind the
    // rows that were already there rather than where it used to sit.
    const db = makeDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, zone: "maybe", quantity: 2 }),
        deckCard({ id: 2, cardId: BOLT_B.id, zone: "main", quantity: 1 }),
      ],
    });
    writeHandlers(db).deck_move_card({ deckId: 1, cardId: BOLT.id, from: "maybe", to: "main" });
    const moved = db.deckCards.find((dc) => dc.cardId === BOLT.id)!;
    expect(moved.zone).toBe("main");
    expect(moved.id).toBeGreaterThan(2);
  });
});

describe("what a zone write does to the deck row", () => {
  it("bumps updatedAt even on a removal that found nothing to remove", () => {
    const db = makeDb({ decks: [deck({ id: 1, updatedAt: 100 })] });
    const change = writeHandlers(db).deck_set_card_quantity({
      deckId: 1,
      cardId: BOLT.id,
      zone: "main",
      quantity: 0,
    });
    expect(change).toMatchObject({ id: 0, quantity: 0, removed: true });
    expect(db.decks[0].updatedAt).toBeGreaterThan(100);
  });

  it("leaves it alone when the write was refused", () => {
    const db = makeDb({ decks: [deck({ id: 1, updatedAt: 100 })] });
    const w = writeHandlers(db);
    expect(() =>
      w.deck_set_card_quantity({ deckId: 1, cardId: BOLT.id, zone: "main", quantity: 2 }),
    ).toThrow(/not in this deck's main zone/);
    expect(() =>
      w.deck_move_card({ deckId: 1, cardId: BOLT.id, from: "main", to: "side" }),
    ).toThrow(/not in this deck's main zone/);
    expect(db.decks[0].updatedAt).toBe(100);
  });

  it("answers GONE for a deck that is not there", () => {
    const db = makeDb();
    expect(() =>
      writeHandlers(db).deck_set_card_quantity({
        deckId: 9,
        cardId: BOLT.id,
        zone: "main",
        quantity: 1,
      }),
    ).toThrow(/not there any more/);
  });
});

describe("the deck row itself", () => {
  it("names a new deck, defaults a blank format to casual and refuses an unknown one", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    expect(w.deck_create({ deck: { name: "Burn", formatKey: "" } }).formatKey).toBe("casual");
    expect(() => w.deck_create({ deck: { name: "  ", formatKey: "modern" } })).toThrow(
      /needs a name/,
    );
    expect(() => w.deck_create({ deck: { name: "Burn", formatKey: "nonsense" } })).toThrow(
      /not a format this app knows/,
    );
    expect(db.decks).toHaveLength(1);
  });

  it("deletes the deck's cards with it", () => {
    const db = makeDb({
      decks: [deck({ id: 1 }), deck({ id: 2 })],
      deckCards: [deckCard({ id: 1, deckId: 1 }), deckCard({ id: 2, deckId: 2 })],
    });
    writeHandlers(db).deck_delete({ id: 1 });
    expect(db.decks.map((d) => d.id)).toEqual([2]);
    expect(db.deckCards.map((dc) => dc.deckId)).toEqual([2]);
  });

  it("copies the cards but never isBuilt and never archived — a copy is a draft", () => {
    const db = makeDb({
      decks: [deck({ id: 1, name: "Burn", isBuilt: true, archived: true })],
      deckCards: [deckCard({ id: 1, deckId: 1, quantity: 4 })],
    });
    const copy = writeHandlers(db).deck_duplicate({ id: 1 });
    expect(copy).toMatchObject({ name: "Burn (copy)", isBuilt: false, archived: false });
    expect(db.deckCards.filter((dc) => dc.deckId === copy.id)).toHaveLength(1);
    expect(db.deckCards.find((dc) => dc.deckId === copy.id)!.quantity).toBe(4);
  });

  it("leaves absent patch fields alone", () => {
    const db = makeDb({ decks: [deck({ id: 1, name: "Burn", description: "fast" })] });
    const row = writeHandlers(db).deck_update({ id: 1, patch: { isBuilt: true } });
    expect(row).toMatchObject({ name: "Burn", description: "fast", isBuilt: true });
  });
});

describe("missing to the wishlist", () => {
  it("counts wishes, not rows: one card short in two zones is one wish for the sum", () => {
    const db = makeDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT_A.id, zone: "main", quantity: 2 }),
        deckCard({ id: 2, cardId: BOLT_B.id, zone: "side", quantity: 1 }),
        // The scratchpad is not a shopping list.
        deckCard({ id: 3, cardId: BOLT_A.id, zone: "maybe", quantity: 9 }),
      ],
    });
    expect(writeHandlers(db).deck_missing_to_wishlist({ deckId: 1 })).toBe(1);
    expect(db.wishlistEntries).toHaveLength(1);
    expect(db.wishlistEntries[0]).toMatchObject({ oracleId: BOLT.oracleId, quantity: 3 });
  });

  it("subtracts what the deck already holds, and pressing twice raises the line", () => {
    const db = makeDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT_A.id, quantity: 1 })],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT_A.id, zone: "main", quantity: 4 })],
    });
    const w = writeHandlers(db);
    expect(w.deck_missing_to_wishlist({ deckId: 1 })).toBe(1);
    expect(db.wishlistEntries[0].quantity).toBe(3);
    expect(w.deck_missing_to_wishlist({ deckId: 1 })).toBe(1);
    expect(db.wishlistEntries).toHaveLength(1);
    expect(db.wishlistEntries[0].quantity).toBe(6);
  });

  it("shops for nothing when the deck is covered", () => {
    const db = makeDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT_A.id, quantity: 4 })],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT_A.id, zone: "main", quantity: 4 })],
    });
    expect(writeHandlers(db).deck_missing_to_wishlist({ deckId: 1 })).toBe(0);
    expect(db.wishlistEntries).toHaveLength(0);
  });
});

describe("the busy fault", () => {
  it("refuses a write in words and leaves the row alone", () => {
    const db = makeDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 3 })],
      fault: "busy",
    });
    expect(() => writeHandlers(db).collection_set_quantity({ id: 1, quantity: 5 })).toThrow(
      /busy/i,
    );
    expect(db.collectionEntries[0].quantity).toBe(3);
  });

  it("refuses every write there is, and no read", () => {
    const db = makeDb({
      collectionEntries: [entry({ id: 1 })],
      wishlistEntries: [wish({ id: 1 })],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1 })],
      fault: "busy",
    });
    const w = writeHandlers(db);
    // Every command in the table except `sync_run`, which does not take the write lock.
    const args: Record<string, unknown> = {
      id: 1,
      deckId: 1,
      cardId: BOLT.id,
      zone: "main",
      from: "main",
      to: "side",
      fromCardId: BOLT.id,
      toCardId: BOLT_B.id,
      quantity: 1,
      entry: { cardId: BOLT.id, finish: "nonfoil", quantity: 1 },
      wish: { cardId: BOLT.id, quantity: 1 },
      deck: { name: "Burn", formatKey: "modern" },
      patch: {},
    };
    // 17 writes in the table, `sync_run` excluded: it does not take the write lock.
    const names = Object.keys(w).filter((n) => n !== "sync_run");
    expect(names).toHaveLength(16);
    for (const name of names) {
      expect(() => (w as unknown as Record<string, (a: unknown) => unknown>)[name](args)).toThrow(
        /busy/i,
      );
    }
    // Reads answer through every second of a sync, because they take `db_read`.
    expect(readHandlers(db).collection_list({ query: { limit: 10, offset: 0 } }).total).toBe(1);
  });
});

describe("the whole command table", () => {
  it("dispatches the writes under the names and argument names ipc.ts sends", async () => {
    resetCommands();
    const db = makeDb({ decks: [deck({ id: 1 })] });
    registerCommands(allHandlers(db));
    await expect(
      invoke<EntryChange>("deck_add_card", {
        deckId: 1,
        cardId: BOLT.id,
        zone: "main",
        quantity: 2,
      }),
    ).resolves.toMatchObject({ quantity: 2 });
    await expect(
      invoke<EntryChange>("collection_add", {
        entry: { cardId: BOLT.id, finish: "nonfoil", quantity: 1 },
      }),
    ).resolves.toMatchObject({ quantity: 1, removed: false });
    // A read taken after a write sees it: the two tables close over one store.
    await expect(invoke<DeckDetail>("deck_get", { id: 1 })).resolves.toMatchObject({
      cards: [{ cardId: BOLT.id, quantity: 2, ownedQuantity: 1 }],
    });
    // `deck_missing_to_wishlist` takes `deckId` where its four neighbours take `id` — the
    // odd one out, and Tauri matches by name.
    await expect(invoke<number>("deck_missing_to_wishlist", { id: 1 })).rejects.toThrow();
  });

  it("answers a sync run without touching the store", () => {
    const db = makeDb();
    expect(writeHandlers(db).sync_run()).toEqual({
      updated: false,
      cardCount: 43,
      updatedAt: null,
    });
    expect(() => writeHandlers(makeDb({ fault: "syncError" })).sync_run()).toThrow(/rate limited/);
  });
});
