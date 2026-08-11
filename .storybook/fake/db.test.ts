/**
 * What the row store has to get right, and nothing that merely restates it.
 *
 * The first block is the whole reason `db.ts` stores rows: `ownedQuantity` is three
 * different questions with one name, and a fake that stored DTOs would answer them
 * identically and be plausible every time.
 */
import { describe, expect, it } from "vitest";
import { invoke, registerCommands, resetCommands } from "./core";
import { allHandlers, makeDb, neverCheckedUpdate, readHandlers, writeHandlers } from "./db";
import type { FakeDb, FakeDeck, FakeDeckCard, FakeDeckCategory, FakeEntry, FakeWish } from "./db";
import { DECK_CATEGORIES } from "./fixtures";
import { seed } from "./seeds";
import { CARDS, type FakeCard } from "./cards";
import type {
  CardSummary,
  CategoryKind,
  CollectionPage,
  CollectionSortKey,
  DeckDetail,
  EntryChange,
  EntryInput,
  SearchSortKey,
  WishlistPage,
  WishlistSortKey,
} from "@/lib/ipc";
import type { SortSpec } from "@/lib/sort";

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

/**
 * A category id from the deck and the kind, so a test can name one inline and the row
 * {@link deckCard} builds and the row {@link makeDeckDb} seeds agree without a lookup. Ten
 * apart per deck, which is nothing but room.
 */
function categoryId(deckId: number, kind: CategoryKind): number {
  return deckId * 10 + DECK_CATEGORIES.findIndex((c) => c.kind === kind);
}

/** Every deck's five categories, named, ordered and flagged as `DECK_CATEGORIES` has them —
 *  the Maybeboard inactive and the other four on. */
function categoriesOf(decks: FakeDeck[]): FakeDeckCategory[] {
  return decks.flatMap((d) =>
    DECK_CATEGORIES.map((c) => ({ ...c, id: categoryId(d.id, c.kind), deckId: d.id })),
  );
}

/**
 * `makeDb` with those five rows per deck already in it.
 *
 * A deck without its categories is a state neither `create_deck` nor the v7 migration can
 * leave behind — and every card write refuses one, so a fixture missing them would fail with
 * "That category is not there any more" rather than testing what it meant to.
 */
function makeDeckDb(init: Partial<FakeDb> = {}): FakeDb {
  const db = makeDb(init);
  db.deckCategories = init.deckCategories ?? categoriesOf(db.decks);
  return db;
}

/**
 * A deck card, filed by the **kind** of the category it is in — `main` unless a test says
 * otherwise, and `live` unless it says that too.
 *
 * `categoryKind` is not a column: it is the shorthand a test wants, resolved through
 * {@link categoryId} into the one column there is. A test about a category the *user* made
 * passes `categoryId` outright, which is what the two of them being different things means.
 */
function deckCard(
  over: Partial<FakeDeckCard> & { categoryKind?: CategoryKind } = {},
): FakeDeckCard {
  const card = CARDS.find((c) => c.id === (over.cardId ?? BOLT.id));
  const { categoryKind, ...rest } = over;
  const deckId = over.deckId ?? 1;
  return {
    id: 1,
    deckId,
    categoryId: categoryId(deckId, categoryKind ?? "main"),
    variant: "live",
    cardId: BOLT.id,
    tagId: null,
    quantity: 1,
    name: card?.name ?? "Gone",
    setCode: card?.setCode ?? "xxx",
    collectorNumber: card?.collectorNumber ?? "1",
    lang: card?.lang ?? "en",
    needsReview: null,
    ...rest,
  };
}

/** The live deck, which is what every read here is about unless it says otherwise. */
function liveDeck(db: FakeDb, id = 1): DeckDetail | null {
  return readHandlers(db).deck_get({ id, variant: "live" });
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

  it("is an ALLOCATION on a deck card, and an inactive category is never allocated for", () => {
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, finish: "nonfoil", quantity: 3 })],
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, deckId: 1, cardId: BOLT.id, categoryKind: "main", quantity: 2 }),
        deckCard({ id: 2, deckId: 1, cardId: BOLT.id, categoryKind: "maybe", quantity: 4 }),
      ],
    });
    const detail = liveDeck(db)!;
    const owned = (kind: CategoryKind) =>
      detail.cards.find((c) => c.categoryKind === kind)!.ownedQuantity;
    expect(owned("main")).toBe(2);
    // The Maybeboard is seeded inactive, and that — not its kind — is why it claims nothing.
    expect(owned("maybe")).toBe(0);
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

/**
 * `sorting::order_by` as this fake implements it, over the three lists that take a spec.
 *
 * A sort is an ordered list of `{key, dir}`, the first term deciding and the rest breaking
 * its ties, so every block below has to answer two questions and not one: does the key mean
 * what the Rust's `ORDER BY` means by it, and does a *later* term still get a say. The
 * two-term tests are written so the first term alone cannot produce the answer.
 *
 * Rows are asserted by row id (or by set code, for cards) rather than by name: half of these
 * fixtures are two printings of one card on purpose.
 */
describe("ordering", () => {
  /** The fixture printing at one `(setCode, collectorNumber)`, which `cards.ts` says is a key
   *  over these 43 rows even though it is not one in `cards`. */
  const at = (setCode: string, collectorNumber: string) =>
    CARDS.find((c) => c.setCode === setCode && c.collectorNumber === collectorNumber)!;

  describe("the search", () => {
    const setCodesFor = (db: ReturnType<typeof makeDb>, sort?: SortSpec<SearchSortKey>) =>
      readHandlers(db)
        .search_cards({ req: { sort, limit: 10, offset: 0 } })
        .items.map((i) => i.setCode);

    it("lets a second term break a tie the first leaves", () => {
      // Two rarities, two rows each, four different prices.
      const db = makeDb({
        cards: [
          at("lea", "161"), // Lightning Bolt, common, 620
          at("unf", "239"), // Forest, common, 0.98
          at("2x2", "117"), // Lightning Bolt, uncommon, 2.50
          at("nph", "57"), // Dismember, uncommon, 3.96
        ],
      });
      // `rarity` alone leaves both pairs tied, and the `c.id ASC` that `order_by` appends to
      // every order decides them — cheapest first in both pairs, by coincidence of the uuids,
      // which is the opposite of what the second term below asks for.
      expect(setCodesFor(db, [{ key: "rarity", dir: "asc" }])).toEqual([
        "unf",
        "lea",
        "nph",
        "2x2",
      ]);
      // Dearest first *within* each rarity — an order the first term on its own cannot reach.
      expect(
        setCodesFor(db, [
          { key: "rarity", dir: "asc" },
          { key: "price", dir: "desc" },
        ]),
      ).toEqual(["lea", "unf", "nph", "2x2"]);
    });

    it("ranks rarity rather than spelling it", () => {
      const db = makeDb({
        cards: [
          at("mp2", "8"), // special
          at("vma", "4"), // bonus — the fixture's only one, and one of its two digital rows
          at("roe", "4"), // mythic
          at("fut", "153"), // rare
          at("c21", "263"), // uncommon
          at("unf", "239"), // common
        ],
      });
      const page = readHandlers(db).search_cards({
        // `paperOnly` is omitted-means-true, and `vma 4` is digital.
        req: { paperOnly: false, sort: [{ key: "rarity", dir: "asc" }], limit: 10, offset: 0 },
      });
      // Alphabetically this is bonus, common, mythic, rare, special, uncommon — an order
      // describing nothing anybody wants, which is why the SQL is a `CASE` and not a column.
      expect(page.items.map((i) => i.rarity)).toEqual([
        "common",
        "uncommon",
        "rare",
        "mythic",
        "special",
        "bonus",
      ]);
    });

    it("orders `set` by the natural collector number and not by the string", () => {
      const db = makeDb({
        cards: [at("lea", "232"), at("lea", "47"), at("lea", "288"), at("lea", "161")],
      });
      const numbers = (sort: SortSpec<SearchSortKey>) =>
        readHandlers(db)
          .search_cards({ req: { sort, limit: 10, offset: 0 } })
          .items.map((i) => i.collectorNumber);
      // As strings `"161" < "232" < "288" < "47"`, so this answer is the CAST's and nothing
      // else's.
      expect(numbers([{ key: "set", dir: "asc" }])).toEqual(["47", "161", "232", "288"]);
      expect(numbers([{ key: "set", dir: "desc" }])).toEqual(["288", "232", "161", "47"]);
    });

    it("keeps the unpriced rows last in both directions", () => {
      const db = makeDb({
        cards: [
          at("2ed", "48"), // Ancestral Recall, price_usd 4999.95
          at("2x2", "117"), // Lightning Bolt, price_usd 2.50
          at("sld", "913"), // Sol Ring, price_usd null
        ],
      });
      expect(setCodesFor(db, [{ key: "price", dir: "asc" }])).toEqual(["2x2", "2ed", "sld"]);
      // Reversed rows, not moved holes — which is why the column states `NULLS LAST` twice
      // instead of letting SQLite's default flip it.
      expect(setCodesFor(db, [{ key: "price", dir: "desc" }])).toEqual(["2ed", "2x2", "sld"]);
    });

    it("keeps a missing type line last in both directions", () => {
      // No row of `CARDS` has a null `typeLine`, and the column is nullable, so the fixture
      // for it is made rather than found. Named `Aaa` so name order would put it first.
      const noType: FakeCard = {
        ...at("2x2", "117"),
        id: "no-type-line",
        name: "Aaa",
        typeLine: null,
      };
      const db = makeDb({ cards: [at("unf", "239"), noType, at("2x2", "117")] });
      const types = (sort: SortSpec<SearchSortKey>) =>
        readHandlers(db)
          .search_cards({ req: { sort, limit: 10, offset: 0 } })
          .items.map((i) => i.typeLine);
      expect(types([{ key: "type", dir: "asc" }])).toEqual([
        "Basic Land — Forest",
        "Instant",
        null,
      ]);
      expect(types([{ key: "type", dir: "desc" }])).toEqual([
        "Instant",
        "Basic Land — Forest",
        null,
      ]);
    });

    it("answers name order for an empty spec, for no spec, and reverses on desc", () => {
      // Declared out of name order, so insertion order is a wrong answer this can catch.
      const db = makeDb({
        cards: [at("c21", "263"), at("2ed", "48"), at("unf", "239")],
      });
      const names = (sort?: SortSpec<SearchSortKey>) =>
        readHandlers(db)
          .search_cards({ req: { sort, limit: 10, offset: 0 } })
          .items.map((i) => i.name);
      expect(names([])).toEqual(["Ancestral Recall", "Forest", "Sol Ring"]);
      expect(names()).toEqual(["Ancestral Recall", "Forest", "Sol Ring"]);
      expect(names([{ key: "name", dir: "desc" }])).toEqual([
        "Sol Ring",
        "Forest",
        "Ancestral Recall",
      ]);
    });

    it("drops a key it does not know, and keeps a repeated key's first appearance", () => {
      const db = makeDb({ cards: [at("c21", "263"), at("2ed", "48"), at("unf", "239")] });
      const nameOrder = ["2ed", "unf", "c21"];
      // `released` is the key the contract lost. A key the table does not list is dropped
      // rather than interpolated, so this spec is empty and the browse order answers.
      expect(
        setCodesFor(db, [{ key: "released", dir: "desc" }] as unknown as SortSpec<SearchSortKey>),
      ).toEqual(nameOrder);
      // A repeated key is dead SQL whose second copy reads like the one that won. The first
      // appearance is the one the reader built first.
      expect(
        setCodesFor(db, [
          { key: "name", dir: "asc" },
          { key: "name", dir: "desc" },
        ]),
      ).toEqual(nameOrder);
    });
  });

  describe("the collection", () => {
    const idsFor = (db: ReturnType<typeof makeDb>, sort?: SortSpec<CollectionSortKey>) =>
      readHandlers(db)
        .collection_list({ query: { sort, limit: 10, offset: 0 } })
        .items.map((i) => i.id);

    it("lets a second term break a tie the first leaves", () => {
      const db = makeDb({
        collectionEntries: [
          entry({ id: 1, cardId: at("c21", "263").id, quantity: 2 }), // Sol Ring
          entry({ id: 2, cardId: at("2ed", "48").id, quantity: 2 }), // Ancestral Recall
          entry({ id: 3, cardId: at("unf", "239").id, quantity: 5 }), // Forest
        ],
      });
      // The two twos tie, and `e.id ASC` decides them.
      expect(idsFor(db, [{ key: "quantity", dir: "desc" }])).toEqual([3, 1, 2]);
      expect(
        idsFor(db, [
          { key: "quantity", dir: "desc" },
          { key: "name", dir: "asc" },
        ]),
      ).toEqual([3, 2, 1]);
    });

    it("orders `finish` by the finish, then by the condition's grade", () => {
      const db = makeDb({
        collectionEntries: [
          entry({ id: 1, finish: "nonfoil", condition: "NM" }),
          entry({ id: 2, finish: "foil", condition: "DMG" }),
          entry({ id: 3, finish: "foil", condition: "NM" }),
          entry({ id: 4, finish: "etched", condition: "NM" }),
        ],
      });
      // `etched < foil < nonfoil` is byte order over the finish itself; `NM` before `DMG`
      // inside the foils is the **rank**, and alphabetical order would answer the reverse.
      expect(idsFor(db, [{ key: "finish", dir: "asc" }])).toEqual([4, 3, 2, 1]);
      expect(idsFor(db, [{ key: "finish", dir: "desc" }])).toEqual([1, 2, 3, 4]);
    });

    it("sorts `value` by the row total and `price` by one copy", () => {
      const db = makeDb({
        collectionEntries: [
          // `2x2 117` nonfoil is usd 2.50; ten copies are worth 25.00.
          entry({ id: 1, cardId: at("2x2", "117").id, quantity: 10 }),
          // `sta 105` nonfoil is usd 17.85; one copy is worth 17.85.
          entry({ id: 2, cardId: at("sta", "105").id, quantity: 1 }),
          // `sld 913`'s `usd` is null, so both columns are a hole for it.
          entry({ id: 3, cardId: at("sld", "913").id, quantity: 5 }),
        ],
      });
      expect(idsFor(db, [{ key: "value", dir: "desc" }])).toEqual([1, 2, 3]);
      expect(idsFor(db, [{ key: "price", dir: "desc" }])).toEqual([2, 1, 3]);
      // Ascending puts the two priced rows the other way round and leaves the hole where it
      // was: the two questions disagree in both directions.
      expect(idsFor(db, [{ key: "value", dir: "asc" }])).toEqual([2, 1, 3]);
      expect(idsFor(db, [{ key: "price", dir: "asc" }])).toEqual([1, 2, 3]);
    });

    it("reads `added` in the direction it was asked for", () => {
      const db = makeDb({
        collectionEntries: [entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })],
      });
      expect(idsFor(db, [{ key: "added", dir: "desc" }])).toEqual([3, 2, 1]);
      expect(idsFor(db, [{ key: "added", dir: "asc" }])).toEqual([1, 2, 3]);
    });

    it("answers name order for an empty spec and for no spec, with an orphan under its id", () => {
      const db = makeDb({
        collectionEntries: [
          entry({ id: 1, cardId: at("c21", "263").id }), // Sol Ring
          entry({ id: 2, cardId: "zzz-gone" }), // no such card
          entry({ id: 3, cardId: at("2ed", "48").id }), // Ancestral Recall
        ],
      });
      // `coalesce(c.name, e.card_id)` in byte order: `Ancestral Recall`, `Sol Ring`,
      // `zzz-gone`. The orphan sorts under its card id rather than at the top under an
      // empty string.
      expect(idsFor(db, [])).toEqual([3, 1, 2]);
      expect(idsFor(db)).toEqual([3, 1, 2]);
    });
  });

  describe("the wishlist", () => {
    const idsFor = (db: ReturnType<typeof makeDb>, sort?: SortSpec<WishlistSortKey>) =>
      readHandlers(db)
        .wishlist_list({ query: { sort, limit: 10, offset: 0 } })
        .items.map((i) => i.id);

    it("sorts `owned` by the finish-aware count the row prints", () => {
      const db = makeDb({
        collectionEntries: [entry({ id: 1, cardId: BOLT_2X2.id, finish: "nonfoil", quantity: 3 })],
        wishlistEntries: [
          // No finish named, so the three nonfoils in the binder count.
          wish({ id: 1, cardId: BOLT_2X2.id }),
          // For the foil, which those three do not fill.
          wish({ id: 2, cardId: BOLT_2X2.id, preferredFinish: "foil" }),
        ],
      });
      expect(idsFor(db, [{ key: "owned", dir: "desc" }])).toEqual([1, 2]);
      expect(idsFor(db, [{ key: "owned", dir: "asc" }])).toEqual([2, 1]);
    });

    it("sorts `cost` by what is still missing and `price` by one copy", () => {
      const db = makeDb({
        collectionEntries: [entry({ id: 1, cardId: at("2ed", "48").id, quantity: 1 })],
        wishlistEntries: [
          // Fulfilled: one wanted, one owned. `max(0, 1 - 1)` is 0, so the dearest card in
          // the fixture costs nothing to finish.
          wish({ id: 1, cardId: at("2ed", "48").id, quantity: 1 }),
          // Two wanted at usd 2.50 and none owned: 5.00 still to spend.
          wish({ id: 2, cardId: at("2x2", "117").id, quantity: 2 }),
          // A null `usd`, so the cost is a hole and not a zero.
          wish({ id: 3, cardId: at("sld", "913").id, quantity: 4 }),
        ],
      });
      expect(idsFor(db, [{ key: "cost", dir: "desc" }])).toEqual([2, 1, 3]);
      expect(idsFor(db, [{ key: "cost", dir: "asc" }])).toEqual([1, 2, 3]);
      // The same three rows, ordered by what one copy costs: the fulfilled wish is first
      // rather than second, which is the whole difference between the two keys.
      expect(idsFor(db, [{ key: "price", dir: "desc" }])).toEqual([1, 2, 3]);
    });

    it("reads `quantity` and `added` in the direction they were asked for", () => {
      const db = makeDb({
        wishlistEntries: [
          wish({ id: 1, cardId: at("c21", "263").id, quantity: 1 }),
          wish({ id: 2, cardId: at("2ed", "48").id, quantity: 4 }),
          wish({ id: 3, cardId: at("unf", "239").id, quantity: 2 }),
        ],
      });
      expect(idsFor(db, [{ key: "quantity", dir: "desc" }])).toEqual([2, 3, 1]);
      expect(idsFor(db, [{ key: "quantity", dir: "asc" }])).toEqual([1, 3, 2]);
      expect(idsFor(db, [{ key: "added", dir: "desc" }])).toEqual([3, 2, 1]);
      expect(idsFor(db, [{ key: "added", dir: "asc" }])).toEqual([1, 2, 3]);
    });

    it("answers name order for an empty spec and for no spec, and reverses on desc", () => {
      const db = makeDb({
        wishlistEntries: [
          wish({ id: 1, cardId: at("c21", "263").id }), // Sol Ring
          wish({ id: 2, cardId: at("2ed", "48").id }), // Ancestral Recall
          wish({ id: 3, cardId: at("unf", "239").id }), // Forest
        ],
      });
      expect(idsFor(db, [])).toEqual([2, 3, 1]);
      expect(idsFor(db)).toEqual([2, 3, 1]);
      expect(idsFor(db, [{ key: "name", dir: "desc" }])).toEqual([1, 3, 2]);
    });
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
    const db = makeDeckDb({
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, quantity: 1 }),
        entry({ id: 2, cardId: BOLT_2X2.id, quantity: 4 }),
      ],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT_2X2.id, categoryKind: "main", quantity: 4 })],
    });
    // All four from the exact printing's own entry, leaving the `lea` copy alone.
    expect(liveDeck(db)!.cards[0].ownedQuantity).toBe(4);
  });

  it("hands the commander its copy before the main deck gets one", () => {
    const solRing = CARDS.filter((c) => c.name === "Sol Ring")[0];
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: solRing.id, quantity: 1 })],
      decks: [deck({ id: 1, formatKey: "commander" })],
      deckCards: [
        // The main-deck row is first by id, so only `KIND_PRIORITY` can put the commander
        // ahead of it.
        deckCard({ id: 1, cardId: solRing.id, categoryKind: "main", quantity: 1 }),
        deckCard({ id: 2, cardId: solRing.id, categoryKind: "commander", quantity: 1 }),
      ],
    });
    const detail = liveDeck(db)!;
    const owned = (kind: CategoryKind) =>
      detail.cards.find((c) => c.categoryKind === kind)!.ownedQuantity;
    expect(owned("commander")).toBe(1);
    expect(owned("main")).toBe(0);
  });

  /**
   * Rule 2 of the two that decide what is allocated for at all: a plan reserves nothing, so
   * the copies stay available to every other deck until the change is made for real. The
   * `deck.rs` test of the same name is the other half of this.
   */
  it("claims nothing for the theory variant", () => {
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 4 })],
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, variant: "theory", categoryKind: "main", quantity: 4 }),
      ],
    });
    const theory = readHandlers(db).deck_get({ id: 1, variant: "theory" })!;
    expect(theory.cards).toHaveLength(1);
    expect(theory.cards[0].ownedQuantity).toBe(0);
    // Same printing, same category, in the live deck: that one claims.
    db.deckCards.push(deckCard({ id: 2, cardId: BOLT.id, categoryKind: "main", quantity: 4 }));
    expect(liveDeck(db)!.cards[0].ownedQuantity).toBe(4);
  });

  /**
   * Rule 1, and the whole point of it being `isActive` rather than a kind: this category is a
   * `main` one the user switched **off**. Any implementation still asking "is this the maybe
   * pile?" answers 4 here.
   */
  it("claims nothing for a main category the user switched off", () => {
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 4 })],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 4 })],
    });
    const main = db.deckCategories.find((c) => c.kind === "main")!;
    main.isActive = false;
    const detail = liveDeck(db)!;
    expect(detail.cards[0].categoryKind).toBe("main");
    expect(detail.cards[0].ownedQuantity).toBe(0);
    // …and it is out of the deck's count for the same reason, and only that reason.
    expect(detail.deck.cardCount).toBe(0);
    main.isActive = true;
    expect(liveDeck(db)!.cards[0].ownedQuantity).toBe(4);
  });

  it("takes a built deck's claims off what another deck can see, and a draft's not", () => {
    const seed = (isBuilt: boolean) =>
      makeDeckDb({
        collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 2 })],
        decks: [deck({ id: 1, isBuilt }), deck({ id: 2 })],
        deckCards: [
          deckCard({ id: 1, deckId: 1, cardId: BOLT.id, quantity: 2 }),
          deckCard({ id: 2, deckId: 2, cardId: BOLT.id, quantity: 2 }),
        ],
      });
    expect(liveDeck(seed(true), 2)!.cards[0].ownedQuantity).toBe(0);
    expect(liveDeck(seed(false), 2)!.cards[0].ownedQuantity).toBe(2);
  });

  it("splits one copy between two built decks instead of giving it to neither", () => {
    // The regression this exists for: allocating the read's own deck *last*, from what every
    // other built deck left, makes each read hand the copy to the other one — so both answer
    // 0 and nobody holds it. One id-ordered pass over every built deck, the read's included,
    // is what makes the two answers add up.
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 1 })],
      decks: [deck({ id: 1, isBuilt: true }), deck({ id: 2, isBuilt: true })],
      deckCards: [
        deckCard({ id: 1, deckId: 1, cardId: BOLT.id, quantity: 1 }),
        deckCard({ id: 2, deckId: 2, cardId: BOLT.id, quantity: 1 }),
      ],
    });
    const owned = (id: number) => liveDeck(db, id)!.cards[0].ownedQuantity;
    expect([owned(1), owned(2)]).toEqual([1, 0]);
  });

  it("gives two copies to the first two of three built decks, by deck id", () => {
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 2 })],
      decks: [1, 2, 3].map((id) => deck({ id, isBuilt: true })),
      deckCards: [1, 2, 3].map((id) => deckCard({ id, deckId: id, cardId: BOLT.id, quantity: 1 })),
    });
    const owned = (id: number) => liveDeck(db, id)!.cards[0].ownedQuantity;
    expect([owned(1), owned(2), owned(3)]).toEqual([1, 1, 0]);
  });

  it("is never blocked by the built deck's own claims", () => {
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 2 })],
      decks: [deck({ id: 1, isBuilt: true })],
      deckCards: [deckCard({ id: 1, deckId: 1, cardId: BOLT.id, quantity: 2 })],
    });
    expect(liveDeck(db)!.cards[0].ownedQuantity).toBe(2);
  });
});

describe("the deck read", () => {
  it("orders by category sort order, then the row's name, then row id", () => {
    const counterspell = CARDS.find((c) => c.name === "Counterspell")!;
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "maybe" }),
        deckCard({ id: 2, cardId: counterspell.id, categoryKind: "main" }),
        deckCard({ id: 3, cardId: BOLT.id, categoryKind: "commander" }),
        deckCard({ id: 4, cardId: BOLT.id, categoryKind: "main" }),
      ],
    });
    expect(liveDeck(db)!.cards.map((c) => [c.categoryName, c.name])).toEqual([
      ["Commander", "Lightning Bolt"],
      ["Main deck", "Counterspell"],
      ["Main deck", "Lightning Bolt"],
      ["Maybeboard", "Lightning Bolt"],
    ]);
  });

  /**
   * The variant scopes the **cards** and nothing else. An empty category still comes back —
   * that is where the next card goes — and an inactive one always does, because that is the
   * affordance for switching it back on. A list narrowed to the categories that happen to
   * hold something would make an empty deck uneditable.
   */
  it("returns every category, including an empty one and an inactive one", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 3 }),
        deckCard({ id: 2, cardId: BOLT.id, categoryKind: "maybe", quantity: 1 }),
        deckCard({ id: 3, cardId: BOLT.id, categoryKind: "side", variant: "theory", quantity: 9 }),
      ],
    });
    const detail = liveDeck(db)!;
    expect(detail.categories.map((c) => [c.name, c.isActive, c.cardCount])).toEqual([
      // Empty, and still a column.
      ["Commander", true, 0],
      ["Main deck", true, 3],
      // The nine copies are in the theory list, and this read asked for the live one.
      ["Sideboard", true, 0],
      ["Companion", true, 0],
      // Inactive, and still a column: counting toward nothing is not being hidden.
      ["Maybeboard", false, 1],
    ]);
    // `sum(quantity)` and the nonfoil `usd` × copies over the variant asked for — `lea 161`
    // is 620.00 — and `null` rather than 0 where there is nothing to price.
    expect(detail.categories.map((c) => c.totalPriceUsd)).toEqual([null, 1860, null, null, 620]);
    expect(readHandlers(db).deck_get({ id: 1, variant: "theory" })!.categories[2].cardCount).toBe(
      9,
    );
    // No tag has been made, so the palette is empty — and it is a list, not a null.
    expect(detail.tags).toEqual([]);
  });

  it("prices a deck card at the printing's nonfoil usd, and counts only main + commander", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 3 }),
        deckCard({ id: 2, cardId: BOLT.id, categoryKind: "side", quantity: 2 }),
        deckCard({ id: 3, cardId: BOLT.id, categoryKind: "commander", quantity: 1 }),
      ],
    });
    const detail = liveDeck(db)!;
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
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: delver.id, categoryKind: "commander" })],
    });
    expect(liveDeck(db)!.cards[0].everUncommon).toBe(true);
  });

  it("answers null under the gone fault, which is what a deleted deck looks like", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1 })], fault: "gone" });
    expect(liveDeck(db)).toBeNull();
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
    // 12 of the 25 seeded rows — `validation/fixtures.ts` mirrors the formats the engine tests need,
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
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, deckId: 1, cardId: BOLT.id, categoryKind: "main", quantity: 2 }),
      ],
    });
    writeHandlers(db).deck_set_card_quantity({
      deckId: 1,
      cardId: BOLT.id,
      categoryId: categoryId(1, "main"),
      variant: "live",
      quantity: 0,
    });
    expect(db.deckCards).toHaveLength(0);
  });

  it("refuses below zero in all three, and a refused write changes nothing", () => {
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, quantity: 3 })],
      wishlistEntries: [wish({ id: 1, quantity: 2 })],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, quantity: 4 })],
    });
    const w = writeHandlers(db);
    for (const call of [
      () => w.collection_set_quantity({ id: 1, quantity: -1 }),
      () => w.wishlist_set_quantity({ id: 1, quantity: -1 }),
      () =>
        w.deck_set_card_quantity({
          deckId: 1,
          cardId: BOLT.id,
          categoryId: categoryId(1, "main"),
          variant: "live",
          quantity: -1,
        }),
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

describe("the deck grain (deck, variant, category, card)", () => {
  /** The four card commands all address a row this way, which is the grain and nothing else. */
  const MAIN = { categoryId: categoryId(1, "main"), variant: "live" } as const;
  const SIDE = { categoryId: categoryId(1, "side"), variant: "live" } as const;

  it("sums a repeat add into one row", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1 })] });
    const w = writeHandlers(db);
    const add = { deckId: 1, cardId: BOLT.id, categoryName: null, variant: "live" } as const;
    w.deck_add_card({ ...add, categoryId: MAIN.categoryId, quantity: 2 });
    w.deck_add_card({ ...add, categoryId: MAIN.categoryId, quantity: 3 });
    expect(db.deckCards).toHaveLength(1);
    expect(db.deckCards[0].quantity).toBe(5);
  });

  it("makes the same printing in two categories two rows, and in two variants two more", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1 })] });
    const w = writeHandlers(db);
    const add = { deckId: 1, cardId: BOLT.id, categoryName: null, quantity: 1 } as const;
    w.deck_add_card({ ...add, ...MAIN });
    w.deck_add_card({ ...add, ...SIDE });
    expect(db.deckCards).toHaveLength(2);
    // A change tried out in Theory is a row of its own, never a draft that could silently
    // overwrite the deck as it is sleeved.
    w.deck_add_card({ ...add, categoryId: MAIN.categoryId, variant: "theory" });
    expect(db.deckCards).toHaveLength(3);
    expect(db.deckCards[2].quantity).toBe(1);
  });

  /**
   * The add path's other arm: a **name** rather than an id, found-or-created. The word is
   * `autoCategoryFor`'s to compute in TypeScript, because which pile a Sol Ring goes in is
   * domain logic; this is the plumbing that files it there. A second add of the same name
   * finds the category rather than making a second one.
   */
  it("finds or creates a main category by name, and refuses neither an id nor a name", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1 })] });
    const w = writeHandlers(db);
    const add = { deckId: 1, cardId: BOLT.id, categoryId: null, variant: "live" } as const;
    w.deck_add_card({ ...add, categoryName: "Removal", quantity: 1 });
    w.deck_add_card({ ...add, categoryName: "Removal", quantity: 1 });
    const made = db.deckCategories.filter((c) => c.name === "Removal");
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ deckId: 1, kind: "main", isActive: true });
    expect(db.deckCards).toHaveLength(1);
    expect(db.deckCards[0].quantity).toBe(2);
    expect(() => w.deck_add_card({ ...add, categoryName: null, quantity: 1 })).toThrow(
      /needs a category to go in/,
    );
  });

  it("refuses a category that is gone, and one that belongs to another deck", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1 }), deck({ id: 2 })] });
    const w = writeHandlers(db);
    const add = { deckId: 1, cardId: BOLT.id, categoryName: null, variant: "live" } as const;
    expect(() => w.deck_add_card({ ...add, categoryId: 999, quantity: 1 })).toThrow(
      /category is not there any more/,
    );
    expect(() =>
      w.deck_add_card({ ...add, categoryId: categoryId(2, "main"), quantity: 1 }),
    ).toThrow(/belongs to a different deck/);
    expect(db.deckCards).toHaveLength(0);
  });

  it("refuses to add a card the database does not have, or none of one", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1 })] });
    const w = writeHandlers(db);
    const add = { deckId: 1, categoryName: null, ...MAIN } as const;
    expect(() => w.deck_add_card({ ...add, cardId: "no-such-card", quantity: 1 })).toThrow(
      /no card with the id/,
    );
    expect(() => w.deck_add_card({ ...add, cardId: BOLT.id, quantity: 0 })).toThrow(/at least one/);
    expect(db.deckCards).toHaveLength(0);
  });

  it("folds a swap onto a printing the category already holds, and says so", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, deckId: 1, cardId: BOLT_A.id, categoryKind: "main", quantity: 2 }),
        deckCard({ id: 2, deckId: 1, cardId: BOLT_B.id, categoryKind: "main", quantity: 1 }),
      ],
    });
    const result = writeHandlers(db).deck_swap_printing({
      deckId: 1,
      fromCardId: BOLT_A.id,
      toCardId: BOLT_B.id,
      ...MAIN,
    });
    expect(result).toEqual({ folded: true, quantity: 3 });
    expect(db.deckCards).toHaveLength(1);
  });

  it("refuses a swap to a different oracle card", () => {
    const other = CARDS.find((c) => c.oracleId !== BOLT.oracleId)!;
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, deckId: 1, cardId: BOLT.id, categoryKind: "main", quantity: 1 }),
      ],
    });
    expect(() =>
      writeHandlers(db).deck_swap_printing({
        deckId: 1,
        fromCardId: BOLT.id,
        toCardId: other.id,
        ...MAIN,
      }),
    ).toThrow(/not another printing of/);
    expect(db.deckCards[0].cardId).toBe(BOLT.id);
  });

  it("rescues an orphaned row, which is the one pair that cannot be compared", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({
          id: 1,
          deckId: 1,
          cardId: "no-such-card",
          categoryKind: "main",
          quantity: 3,
          needsReview: "Scryfall removed this printing from its database.",
        }),
      ],
    });
    const result = writeHandlers(db).deck_swap_printing({
      deckId: 1,
      fromCardId: "no-such-card",
      toCardId: BOLT.id,
      ...MAIN,
    });
    expect(result).toEqual({ folded: false, quantity: 3 });
    // The swap is the cure, so the new row is written clean.
    expect(db.deckCards[0]).toMatchObject({ cardId: BOLT.id, needsReview: null });
  });

  it("refuses a swap to the printing the deck already plays", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1, updatedAt: 100 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main" })],
    });
    expect(() =>
      writeHandlers(db).deck_swap_printing({
        deckId: 1,
        fromCardId: BOLT.id,
        toCardId: BOLT.id,
        ...MAIN,
      }),
    ).toThrow(/already this printing/);
    // A no-op must not move `updatedAt` and resort the gallery.
    expect(db.decks[0].updatedAt).toBe(100);
  });

  it("moves every copy into the category the target holds, folding", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "maybe", quantity: 2 }),
        deckCard({ id: 2, cardId: BOLT.id, categoryKind: "main", quantity: 1 }),
      ],
    });
    writeHandlers(db).deck_move_card({
      deckId: 1,
      cardId: BOLT.id,
      fromCategoryId: categoryId(1, "maybe"),
      toCategoryId: MAIN.categoryId,
      variant: "live",
    });
    expect(db.deckCards).toHaveLength(1);
    expect(db.deckCards[0]).toMatchObject({ categoryId: MAIN.categoryId, quantity: 3 });
  });

  it("moves within one variant, leaving the other list where it was", () => {
    // A move is a re-filing, never a promotion of a theory row into the live deck.
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 2 }),
        deckCard({ id: 2, cardId: BOLT.id, categoryKind: "main", variant: "theory", quantity: 5 }),
      ],
    });
    writeHandlers(db).deck_move_card({
      deckId: 1,
      cardId: BOLT.id,
      fromCategoryId: MAIN.categoryId,
      toCategoryId: SIDE.categoryId,
      variant: "live",
    });
    expect(db.deckCards.map((dc) => [dc.variant, dc.categoryId, dc.quantity]).sort()).toEqual([
      ["live", SIDE.categoryId, 2],
      ["theory", MAIN.categoryId, 5],
    ]);
  });

  it("lands a move into an empty category on a new row id, not the one it came from", () => {
    // `INSERT … SELECT` then `DELETE`, so the copies land on a fresh rowid — and row id is
    // what the allocator breaks ties on within a kind, so the moved row queues behind the
    // rows that were already there rather than where it used to sit.
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "maybe", quantity: 2 }),
        deckCard({ id: 2, cardId: BOLT_B.id, categoryKind: "main", quantity: 1 }),
      ],
    });
    writeHandlers(db).deck_move_card({
      deckId: 1,
      cardId: BOLT.id,
      fromCategoryId: categoryId(1, "maybe"),
      toCategoryId: MAIN.categoryId,
      variant: "live",
    });
    const moved = db.deckCards.find((dc) => dc.cardId === BOLT.id)!;
    expect(moved.categoryId).toBe(MAIN.categoryId);
    expect(moved.id).toBeGreaterThan(2);
  });
});

describe("what a card write does to the deck row", () => {
  it("bumps updatedAt even on a removal that found nothing to remove", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1, updatedAt: 100 })] });
    const change = writeHandlers(db).deck_set_card_quantity({
      deckId: 1,
      cardId: BOLT.id,
      categoryId: categoryId(1, "main"),
      variant: "live",
      quantity: 0,
    });
    expect(change).toMatchObject({ id: 0, quantity: 0, removed: true });
    expect(db.decks[0].updatedAt).toBeGreaterThan(100);
  });

  it("leaves it alone when the write was refused, naming the category the user sees", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1, updatedAt: 100 })] });
    const w = writeHandlers(db);
    // The category's **name**, not its kind and not its id: a number the user never chose
    // says nothing, and "Main deck" is the column heading they are looking at.
    expect(() =>
      w.deck_set_card_quantity({
        deckId: 1,
        cardId: BOLT.id,
        categoryId: categoryId(1, "main"),
        variant: "live",
        quantity: 2,
      }),
    ).toThrow(/not in this deck's Main deck category/);
    expect(() =>
      w.deck_move_card({
        deckId: 1,
        cardId: BOLT.id,
        fromCategoryId: categoryId(1, "main"),
        toCategoryId: categoryId(1, "side"),
        variant: "live",
      }),
    ).toThrow(/not in this deck's Main deck category/);
    expect(db.decks[0].updatedAt).toBe(100);
  });

  it("answers GONE for a deck that is not there", () => {
    const db = makeDeckDb();
    expect(() =>
      writeHandlers(db).deck_set_card_quantity({
        deckId: 9,
        cardId: BOLT.id,
        categoryId: categoryId(9, "main"),
        variant: "live",
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
    // And it is born with its four predefined categories — a deck that cannot be filed into
    // anything is a state nothing downstream expects. `main` is not among them: a user
    // category is always `main`, and a deck may own any number.
    expect(db.deckCategories.map((c) => [c.kind, c.name, c.isActive])).toEqual([
      ["commander", "Commander", true],
      ["side", "Sideboard", true],
      ["companion", "Companion", true],
      ["maybe", "Maybeboard", false],
    ]);
  });

  it("deletes the deck's cards, categories and tags with it", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 }), deck({ id: 2 })],
      deckCards: [deckCard({ id: 1, deckId: 1 }), deckCard({ id: 2, deckId: 2 })],
      deckTags: [
        { id: 1, deckId: 1, name: "Removal", color: "red" },
        { id: 2, deckId: 2, name: "Ramp", color: "green" },
      ],
    });
    writeHandlers(db).deck_delete({ id: 1 });
    expect(db.decks.map((d) => d.id)).toEqual([2]);
    expect(db.deckCards.map((dc) => dc.deckId)).toEqual([2]);
    expect(new Set(db.deckCategories.map((c) => c.deckId))).toEqual(new Set([2]));
    expect(db.deckTags.map((t) => t.deckId)).toEqual([2]);
  });

  it("copies the cards but never isBuilt and never archived — a copy is a draft", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1, name: "Burn", isBuilt: true, archived: true })],
      deckCards: [deckCard({ id: 1, deckId: 1, quantity: 4 })],
    });
    const copy = writeHandlers(db).deck_duplicate({ id: 1 });
    expect(copy).toMatchObject({ name: "Burn (copy)", isBuilt: false, archived: false });
    expect(db.deckCards.filter((dc) => dc.deckId === copy.id)).toHaveLength(1);
    expect(db.deckCards.find((dc) => dc.deckId === copy.id)!.quantity).toBe(4);
  });

  /**
   * The half a "copy the cards" implementation gets wrong invisibly: a card row stores a
   * `category_id`, so copying it verbatim would file the copy's cards under the *original's*
   * categories — and deleting the original would then take the copy's cards with it through
   * `ON DELETE CASCADE`. Both variants come across, because a copy made to try something out
   * is exactly the copy that wants the plan.
   */
  it("copies categories and tags as new rows, remaps the cards, and takes both variants", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1, name: "Burn" })],
      deckCards: [
        deckCard({ id: 1, deckId: 1, categoryKind: "main", quantity: 4, tagId: 1 }),
        deckCard({ id: 2, deckId: 1, categoryKind: "side", variant: "theory", quantity: 2 }),
      ],
      deckTags: [{ id: 1, deckId: 1, name: "Removal", color: "red" }],
    });
    const copy = writeHandlers(db).deck_duplicate({ id: 1 });
    const theirs = db.deckCategories.filter((c) => c.deckId === copy.id);
    expect(theirs.map((c) => c.name)).toEqual(DECK_CATEGORIES.map((c) => c.name));
    // New rows, so no id is shared with the deck they were copied from.
    const sourceIds = new Set(db.deckCategories.filter((c) => c.deckId === 1).map((c) => c.id));
    expect(theirs.some((c) => sourceIds.has(c.id))).toBe(false);

    const copied = db.deckCards.filter((dc) => dc.deckId === copy.id);
    expect(copied.map((dc) => dc.variant)).toEqual(["live", "theory"]);
    for (const row of copied) {
      expect(theirs.map((c) => c.id)).toContain(row.categoryId);
    }
    const tag = db.deckTags.find((t) => t.deckId === copy.id)!;
    expect(tag.id).not.toBe(1);
    expect(copied[0].tagId).toBe(tag.id);
    // Which is the whole point: deleting the original leaves the copy whole.
    writeHandlers(db).deck_delete({ id: 1 });
    expect(db.deckCards.filter((dc) => dc.deckId === copy.id)).toHaveLength(2);
  });

  it("leaves absent patch fields alone", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1, name: "Burn", description: "fast" })] });
    const row = writeHandlers(db).deck_update({ id: 1, patch: { isBuilt: true } });
    expect(row).toMatchObject({ name: "Burn", description: "fast", isBuilt: true });
  });
});

describe("missing to the wishlist", () => {
  it("counts wishes, not rows: one card short in two categories is one wish for the sum", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT_A.id, categoryKind: "main", quantity: 2 }),
        deckCard({ id: 2, cardId: BOLT_B.id, categoryKind: "side", quantity: 1 }),
        // An inactive category is not a shopping list: a card the user has not decided to
        // play is not one they need to buy.
        deckCard({ id: 3, cardId: BOLT_A.id, categoryKind: "maybe", quantity: 9 }),
        // Neither is a plan. The theory list is not read at all.
        deckCard({ id: 4, cardId: BOLT_A.id, variant: "theory", quantity: 40 }),
      ],
    });
    expect(writeHandlers(db).deck_missing_to_wishlist({ deckId: 1 })).toBe(1);
    expect(db.wishlistEntries).toHaveLength(1);
    expect(db.wishlistEntries[0]).toMatchObject({ oracleId: BOLT.oracleId, quantity: 3 });
  });

  it("subtracts what the deck already holds, and pressing twice raises the line", () => {
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT_A.id, quantity: 1 })],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT_A.id, categoryKind: "main", quantity: 4 })],
    });
    const w = writeHandlers(db);
    expect(w.deck_missing_to_wishlist({ deckId: 1 })).toBe(1);
    expect(db.wishlistEntries[0].quantity).toBe(3);
    expect(w.deck_missing_to_wishlist({ deckId: 1 })).toBe(1);
    expect(db.wishlistEntries).toHaveLength(1);
    expect(db.wishlistEntries[0].quantity).toBe(6);
  });

  it("shops for nothing when the deck is covered", () => {
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT_A.id, quantity: 4 })],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT_A.id, categoryKind: "main", quantity: 4 })],
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
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1 })],
      wishlistEntries: [wish({ id: 1 })],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1 })],
      fault: "busy",
    });
    const w = writeHandlers(db);
    // Every command in the table except the five that do not take the write lock: `sync_run`
    // *is* the thing that holds it, and the four update commands take `sync::lock_db`, which
    // is a blocking lock rather than `db::lock_for`'s bounded one — so a check waits for a
    // sync instead of being refused by it.
    const unlocked = [
      "sync_run",
      "update_check",
      "update_download",
      "update_apply",
      "update_open_release_page",
    ];
    const args: Record<string, unknown> = {
      id: 1,
      deckId: 1,
      cardId: BOLT.id,
      categoryId: categoryId(1, "main"),
      categoryName: null,
      variant: "live",
      fromCategoryId: categoryId(1, "main"),
      toCategoryId: categoryId(1, "side"),
      fromCardId: BOLT.id,
      toCardId: BOLT_B.id,
      quantity: 1,
      entry: { cardId: BOLT.id, finish: "nonfoil", quantity: 1 },
      wish: { cardId: BOLT.id, quantity: 1 },
      deck: { name: "Burn", formatKey: "modern" },
      patch: {},
    };
    // 21 commands in the table, the five above excluded: 16 that really take the lock.
    const names = Object.keys(w).filter((n) => !unlocked.includes(n));
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
    const db = makeDeckDb({ decks: [deck({ id: 1 })] });
    registerCommands(allHandlers(db));
    await expect(
      invoke<EntryChange>("deck_add_card", {
        deckId: 1,
        cardId: BOLT.id,
        categoryId: null,
        // The add path's arm the editor uses: `autoCategoryFor`'s word, found or created.
        categoryName: "Main deck",
        variant: "live",
        quantity: 2,
      }),
    ).resolves.toMatchObject({ quantity: 2 });
    await expect(
      invoke<EntryChange>("collection_add", {
        entry: { cardId: BOLT.id, finish: "nonfoil", quantity: 1 },
      }),
    ).resolves.toMatchObject({ quantity: 1, removed: false });
    // A read taken after a write sees it: the two tables close over one store.
    await expect(invoke<DeckDetail>("deck_get", { id: 1, variant: "live" })).resolves.toMatchObject(
      { cards: [{ cardId: BOLT.id, quantity: 2, ownedQuantity: 1 }] },
    );
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

/**
 * The updater, whose whole design is that **nothing about it is stored as an answer**.
 *
 * `UpdateStatus` has three fields a fixture could have hard-coded and none of them is:
 * `available` is the cached release re-compared against the running version, `asset` is
 * `pick_asset`'s suffix match against the install kind, and `staged` is a boolean over an
 * object that carries a version. Store any of the three and a world can be built in which
 * they disagree — an install offered a download it has no asset for, a notice for a version
 * it is already running — which is exactly the class of bug the panel exists to not have.
 */
describe("the update state", () => {
  /** The version pair `.storybook/fake/fixtures.ts` seeds, restated as an expectation rather
   *  than imported: a test that read the same constant as the code could not notice the two
   *  drifting into the wrong order. */
  const RUNNING = "0.3.0";
  const RELEASED = "0.4.0";

  it("derives an update from two version strings, never from a stored flag", () => {
    // Default: the last check found the release this build *is*, so there is nothing to say.
    const quiet = readHandlers(makeDb()).update_status();
    expect(quiet).toMatchObject({ currentVersion: RUNNING, available: null, asset: null });
    // `lastCheckAt` is what separates this from "never looked", and it is answered.
    expect(quiet.lastCheckAt).toBe(String(WHEN));

    const seen = readHandlers(makeDb({ fault: "updateAvailable" })).update_status();
    expect(seen.available?.version).toBe(RELEASED);
    // The portable install's asset, chosen by the tail of its name — the release carries the
    // NSIS setup too, and `pick_asset` is what tells them apart.
    expect(seen.asset?.name).toBe(`mtg-grimoire-${RELEASED}-windows-x64-portable.zip`);
    expect(seen.staged).toBe(false);
  });

  it("offers an install kind it cannot update no asset at all", () => {
    const db = makeDb({ fault: "updateAvailable" });
    db.update.installKind = "other";
    const status = readHandlers(db).update_status();
    // The news is still delivered — a reader should know a new version exists — and there is
    // nothing to download it with, which is the whole of `UpdateAction`'s `unavailable`.
    expect(status.available?.version).toBe(RELEASED);
    expect(status.asset).toBeNull();
    expect(() => writeHandlers(db).update_download()).toThrow(/no download for this kind/);
  });

  it("never checked is not the same as nothing new", () => {
    const db = makeDb({ update: neverCheckedUpdate() });
    expect(readHandlers(db).update_status()).toMatchObject({
      lastCheckAt: null,
      available: null,
    });
    // And it is the state `seeds.ts`'s first-run world is in.
    expect(readHandlers(seed("empty")).update_status().lastCheckAt).toBeNull();
  });

  it("honours the 24 h throttle, and force is what skips it", () => {
    const db = makeDb();
    // A check inside the window answers the status it already had and asks nothing.
    expect(writeHandlers(db).update_check({ force: false }).available).toBeNull();
    expect(db.update.latestSeen?.version).toBe(RUNNING);

    // Which is why "Check now" sends `force: true`.
    expect(writeHandlers(db).update_check({ force: true }).available?.version).toBe(RELEASED);
    expect(db.update.latestSeen?.version).toBe(RELEASED);
  });

  it("checks when it has never checked, without being forced", () => {
    const db = makeDb({ update: neverCheckedUpdate() });
    expect(writeHandlers(db).update_check({ force: false }).available?.version).toBe(RELEASED);
    expect(db.update.lastCheckAt).toBe(String(WHEN));
  });

  it("downloads, stages, and only then has something to install", () => {
    const db = makeDb();
    // Nothing to download until a check has found something.
    expect(() => writeHandlers(db).update_download()).toThrow(/no update to download/);
    expect(() => writeHandlers(db).update_apply()).toThrow(/no downloaded update to install/);

    writeHandlers(db).update_check({ force: true });
    const after = writeHandlers(db).update_download();
    expect(after.staged).toBe(true);
    expect(db.update.staged).toEqual({ version: RELEASED });
    // Answered, and in the app the window closes moments later — so a successful apply has
    // nothing to assert but its own silence.
    expect(writeHandlers(db).update_apply()).toBeUndefined();
  });

  it("puts GitHub's refusal and a bad checksum in the sentences the app prints", () => {
    const db = makeDb({ fault: "updateError" });
    expect(() => writeHandlers(db).update_check({ force: true })).toThrow(/rate limiting/);
    // The check refused, so nothing was written: a failed check must not look like a
    // successful one that found nothing.
    expect(db.update.lastCheckAt).toBe(String(WHEN));
    expect(db.update.latestSeen?.version).toBe(RUNNING);

    const available = makeDb({ fault: "updateError" });
    available.update.latestSeen = available.update.remote;
    expect(() => writeHandlers(available).update_download()).toThrow(/published checksum/);
    expect(available.update.staged).toBeNull();
  });
});
