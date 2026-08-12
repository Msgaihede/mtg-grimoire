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
  SearchRequest,
  SearchSortKey,
  WishlistPage,
  WishlistSortKey,
} from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
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
    coverKind: "card_art",
    folderId: null,
    notes: null,
    theoryEnabled: false,
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
 * A deck without its categories is a state neither `create_deck` nor the v8 migration can
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

/**
 * `index::facets::compute`, mirrored.
 *
 * **Every dimension is counted over a base carrying every filter EXCEPT its own** — Solr's
 * `excludeTags` rule — so none of the numbers below is "how many cards are red". A test that
 * read them that way would pass against a facet that greys the whole picker on the first
 * press, which is the bug this rule exists to not have.
 *
 * The counts are measured over `CARDS` (43 rows, 41 of them paper) rather than derived from
 * the handler, for the reason every other block here is: a fixture that agreed with the code
 * would agree with a broken one.
 */
describe("facet counts", () => {
  /** One request's facets. `limit`/`offset` are filled in because `SearchRequest` requires
   *  them and facets depend on neither — that is why they are a separate command. */
  const facets = (db: FakeDb, req: Omit<SearchRequest, "limit" | "offset">) =>
    readHandlers(db).facet_cards({ req: { ...req, limit: 0, offset: 0 } });

  it("counts a dimension with its own filter removed, while every other one narrows", () => {
    const f = facets(makeDb(), { sets: ["lea"] });
    expect(f.total).toBe(4);
    expect(f.sets.lea).toBe(4);
    // Still offered, still counted: `2x2` reports what picking it *would* give.
    expect(f.sets["2x2"]).toBe(1);
    // …while the format select does narrow by it — 2 of the 4 `lea` printings are
    // modern-legal, against 27 over the whole paper corpus.
    expect(f.formats.modern).toBe(2);
  });

  it("sends every set code in the corpus, zeros included", () => {
    const f = facets(makeDb(), { text: "bolt" });
    // 33 distinct codes over the 43 fixture rows; the four Bolt printings are in four of
    // them, so 29 arrive as an explicit 0. `FacetResponse.sets` promises a key is never
    // absent, which is what lets the picker grey a row instead of dropping it.
    expect(Object.keys(f.sets)).toHaveLength(33);
    expect(f.sets.lea).toBe(1);
    expect(f.sets["2ed"]).toBe(0);
  });

  it("treats setCode and sets as one dimension, intersecting rather than unioning", () => {
    // `facets::union_sets`: the SQL pushes the two as separate `WHERE` terms, so a request
    // carrying both means "in this set AND in one of these".
    expect(facets(makeDb(), { setCode: "lea", sets: ["2x2"] }).total).toBe(0);
    // And the picker's own counts ignore **both**, or opening it on a request that already
    // names a set would offer nothing but that set.
    expect(facets(makeDb(), { setCode: "lea" }).sets["2x2"]).toBe(1);
  });

  it("reports a colour as the result after toggling it, because colours broaden", () => {
    const none = facets(makeDb(), {});
    expect(none.total).toBe(41);
    // Subset semantics, so this is mono-R plus the colourless cards — a narrowing count.
    expect(none.colors.R).toBe(15);

    const red = facets(makeDb(), { colors: "R" });
    expect(red.total).toBe(15);
    // Pressing W with R on asks for "castable in RW", a superset — never a shrink.
    expect(red.colors.W).toBe(22);
    // Pressing R again clears the filter.
    expect(red.colors.R).toBe(41);
  });

  it("makes the colourless chip exclusive both ways, as `toggleColor` does", () => {
    expect(facets(makeDb(), { colors: "R" }).colors.C).toBe(9);
    const c = facets(makeDb(), { colors: "C" });
    expect(c.total).toBe(9);
    expect(c.colors.C).toBe(41);
    // W/R replaces it rather than joining it: `"RC"` would silently mean plain `"R"`.
    expect(c.colors.R).toBe(15);
  });

  it("counts a colour over the paper decision the request made, not over the default", () => {
    // The colour dimension is the one that re-runs a filter over its own base, so it is the
    // one that can put the paper default back on a base that asked for digital printings.
    expect(facets(makeDb(), { paperOnly: false }).colors.R).toBe(16);
  });

  it("matches a mana chip exactly below 8 and as a range at 8", () => {
    const f = facets(makeDb(), {});
    // `Little Girl` (`unh`, cmc 0.5) is the corpus' one fractional cost and it belongs to
    // **no** chip — `Math.trunc` would file it under 0 and promise a card the search will
    // not return.
    expect(CARDS.some((c) => c.isPaper && c.cmc === 0.5)).toBe(true);
    expect(f.manaValues["0"]).toBe(CARDS.filter((c) => c.isPaper && c.cmc === 0).length);
    // 8 is open-ended: Avacyn (8), Kozilek (10), Emrakul (15).
    expect(f.manaValues["8"]).toBe(3);
  });

  it("counts the chips and the format select with their own filter removed", () => {
    const mana = facets(makeDb(), { manaValues: [1] });
    expect(mana.total).toBe(12);
    expect(mana.manaValues["2"]).toBe(5);

    const standard = facets(makeDb(), { format: "standard" });
    expect(standard.total).toBe(4);
    expect(standard.formats.modern).toBe(27);
  });

  it("empties the result on a format it has never heard of, but not the format select", () => {
    const f = facets(makeDb(), { format: "nonesuch" });
    expect(f.total).toBe(0);
    expect(f.sets.lea).toBe(0);
    // The way out stays open: greying every format at the one moment the reader needs to
    // pick a different one would strand them there.
    expect(f.formats.modern).toBe(27);
  });

  it("counts both sides of the owned cycle as if `owned` were not set", () => {
    const db = makeDb({ collectionEntries: [entry({ id: 1, cardId: BOLT.id })] });
    const f = facets(db, { owned: true });
    expect(f.total).toBe(1);
    expect(f.owned).toEqual({ owned: 1, missing: 40 });
  });

  it("answers the number the search does, because both derive from one filter mirror", () => {
    const db = makeDb({ collectionEntries: [entry({ id: 1, cardId: BOLT.id })] });
    // **`rarity` is deliberately not among these**: the index has no rarity dimension, so
    // `facets::base` drops it and a rarity-filtered request is faceted as though it were
    // unfiltered. The fake mirrors that gap, so the two really do disagree there — a case
    // added here for it would be right about the code and wrong about the backend.
    const cases: Omit<SearchRequest, "limit" | "offset">[] = [
      {},
      { colors: "R" },
      { text: "bolt", manaValues: [1] },
      { owned: false },
      { sets: ["lea"], format: "vintage" },
    ];
    for (const req of cases) {
      const page = readHandlers(db).search_cards({ req: { ...req, limit: 200, offset: 0 } });
      expect(facets(db, req).total).toBe(page.total);
    }
  });

  it("is ready by default, and answers the indexCold fault with every map empty", () => {
    expect(facets(makeDb(), {}).ready).toBe(true);

    const cold = facets(makeDb({ fault: "indexCold" }), {});
    expect(cold.ready).toBe(false);
    expect(cold.total).toBe(0);
    // Empty, not zeros. `ready: false` means "we did not count", and the UI leaves every
    // control live on it; a map of zeros would say "this is empty" and grey the lot.
    expect(cold.sets).toEqual({});
    expect(cold.colors).toEqual({});
    expect(cold.manaValues).toEqual({});
    expect(cold.formats).toEqual({});
    expect(cold.owned).toEqual({ owned: 0, missing: 0 });
  });

  /**
   * The other way to be not-ready, and the one every reader meets first: the index is fine,
   * it just has nothing to count.
   *
   * `facets::compute` guards on `ix.all.count() == 0` because `lib.rs` spawns the build at
   * setup and a first launch therefore publishes an index over zero rows for the whole of the
   * ~93 s opening sync. Counted honestly every option is zero, the greying rule dims the whole
   * row, and with no filter on there is no `Reset all` drawn to escape by — the rule holds and
   * the app reads as broken.
   *
   * **This mirror went in without the guard**, answering `ready: true` unconditionally against
   * a `compute` that had since grown one, and the `empty` seed is exactly the state it gets
   * wrong. `Search/Page`'s `Empty`, `Decks/SearchPanel` and `Collection/Page` all render that
   * seed, so the workbench drew a fully-greyed, escape-less filter row that the shipped window
   * cannot produce — and nothing went red, because no `play` looked at the filter row. Two of
   * them do now.
   */
  it("answers an empty corpus not-ready, exactly as a cold index does", () => {
    const empty = facets(seed("empty"), {});
    expect(empty.ready).toBe(false);
    expect(empty.total).toBe(0);
    expect(empty.sets).toEqual({});
    expect(empty.colors).toEqual({});
    expect(empty.manaValues).toEqual({});
    expect(empty.formats).toEqual({});
    // A corpus with rows in it is the contrast, and it is what keeps the line above from
    // passing for the wrong reason: `starter` differs from `empty` in nothing but its cards.
    expect(facets(seed("starter"), {}).ready).toBe(true);
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
    expect(page.items[0].unitPrice).toBeNull();
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
    const handlers = readHandlers(db);
    const usd = handlers
      .collection_list({ query: { limit: 10, offset: 0 } })
      .items.map((i) => i.unitPrice);
    expect(new Set(usd).size).toBe(3);
    // `eur_etched` does not exist, so the same read at Cardmarket leaves the etched row
    // unpriced rather than quoting it at the nonfoil rate — the hole, at the grain it happens.
    const eur = handlers.collection_list({
      query: { marketplace: "cardmarket", limit: 10, offset: 0 },
    });
    expect(eur.items.find((i) => i.finish === "etched")!.unitPrice).toBeNull();
    expect(eur.items.find((i) => i.finish === "nonfoil")!.unitPrice).not.toBeNull();
  });

  /**
   * **A downloaded feed prices from its own table, and its holes are its own.**
   *
   * The two Scryfall-backed marketplaces read `cards.prices`; Card Kingdom and Mana Pool read
   * `marketplace_prices`, joined on `(marketplace, card_id, finish)` with no foreign key — so a
   * printing a feed has never listed is unpriced *there* while every other marketplace quotes
   * it. That is the case no amount of currency arithmetic can produce, and it is the one the em
   * dash rule exists for.
   */
  it("prices a feed-backed marketplace from marketplace_prices, holes and all", () => {
    const sta = CARDS.find((c) => c.setCode === "sta" && c.name === "Lightning Bolt")!;
    const db = makeDb({
      collectionEntries: [entry({ id: 1, cardId: sta.id, finish: "nonfoil" })],
      marketplacePrices: [
        { marketplace: "cardkingdom", cardId: sta.id, finish: "nonfoil", price: 19.64 },
      ],
    });
    const handlers = readHandlers(db);
    const at = (marketplace: MarketplaceId) =>
      handlers.collection_list({ query: { marketplace, limit: 10, offset: 0 } }).items[0]
        .unitPrice;

    expect(at("cardkingdom")).toBe(19.64);
    // Listed by one feed and not by the other: unpriced at Mana Pool, and never filled in from
    // Card Kingdom's row or from Scryfall's blob.
    expect(at("manapool")).toBeNull();
    // And the Scryfall-backed one is untouched by either.
    expect(at("tcgplayer")).toBe(17.85);
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

/**
 * **A card is a priced answer too**, since `card_detail` and `card_printings` gained a
 * marketplace — which is the whole of what the card pane draws in its finish table and down its
 * printings list.
 *
 * The fixture is `sta 105`, the corpus's Japanese Lightning Bolt and one of its two rows priced
 * in all three finishes: `usd 17.85 / usd_foil 23.85 / usd_etched 18.68`, `eur 15.45 /
 * eur_foil 21.45` and **no `eur_etched`, because Scryfall has no such key**.
 */
describe("a card's per-finish prices", () => {
  const sta = CARDS.find((c) => c.setCode === "sta" && c.name === "Lightning Bolt")!;

  /** `marketplace_prices` for that one printing at one feed — what a fetch would have landed. */
  const feed = (marketplace: MarketplaceId, nonfoil: number, foil: number, etched: number) => [
    { marketplace, cardId: sta.id, finish: "nonfoil", price: nonfoil },
    { marketplace, cardId: sta.id, finish: "foil", price: foil },
    { marketplace, cardId: sta.id, finish: "etched", price: etched },
  ];

  const pricesAt = (db: FakeDb, marketplace?: MarketplaceId) =>
    readHandlers(db).card_detail({ id: sta.id, marketplace })!.finishPrices;

  it("answers all three finishes from each marketplace's own source", () => {
    const db = makeDb({
      marketplacePrices: [
        ...feed("cardkingdom", 19.64, 26.24, 20.55),
        ...feed("manapool", 16.42, 21.94, 17.19),
      ],
    });

    expect(pricesAt(db, "tcgplayer")).toEqual({ nonfoil: 17.85, foil: 23.85, etched: 18.68 });
    expect(pricesAt(db, "cardkingdom")).toEqual({ nonfoil: 19.64, foil: 26.24, etched: 20.55 });
    expect(pricesAt(db, "manapool")).toEqual({ nonfoil: 16.42, foil: 21.94, etched: 17.19 });
  });

  /**
   * **The etched contrast**, which is the one thing four marketplaces disagree about in kind
   * rather than in number: the same card in the same finish is priced on TCGplayer and on Mana
   * Pool — which publishes a real `price_cents_nm_etched` column — and *unpriceable* on
   * Cardmarket, because there is no `eur_etched` key in Scryfall's data at all.
   */
  it("prices etched where the source has it and answers null on Cardmarket, which cannot", () => {
    const db = makeDb({ marketplacePrices: feed("manapool", 16.42, 21.94, 17.19) });

    expect(pricesAt(db, "tcgplayer").etched).toBe(18.68);
    expect(pricesAt(db, "manapool").etched).toBe(17.19);
    expect(pricesAt(db, "cardmarket").etched).toBeNull();
    // And the euro nonfoil price sits right there unused: the hole is the answer, not a reason
    // to reach one key over.
    expect(pricesAt(db, "cardmarket").nonfoil).not.toBeNull();
  });

  it("answers null for a card a feed has never listed rather than another marketplace's price", () => {
    const db = makeDb({ marketplacePrices: feed("cardkingdom", 19.64, 26.24, 20.55) });

    expect(pricesAt(db, "manapool")).toEqual({ nonfoil: null, foil: null, etched: null });
    expect(pricesAt(db, "cardkingdom").nonfoil).toBe(19.64);
  });

  it("prices at tcgplayer when the read names no marketplace or names an unknown one", () => {
    const db = makeDb({ marketplacePrices: feed("cardkingdom", 19.64, 26.24, 20.55) });

    expect(pricesAt(db)).toEqual({ nonfoil: 17.85, foil: 23.85, etched: 18.68 });
    expect(pricesAt(db, "ebay" as MarketplaceId)).toEqual(pricesAt(db, "tcgplayer"));
    // `cardtrader` is in the picker and has no feed, so it prices as the default too.
    expect(pricesAt(db, "cardtrader")).toEqual(pricesAt(db, "tcgplayer"));
  });

  /** The printings list carries the same figures per row — the half a reader compares
   *  printings *by*, and the one the pane draws forty of. */
  it("prices every printings row at the marketplace the list was read at", () => {
    const db = makeDb({ marketplacePrices: feed("cardkingdom", 19.64, 26.24, 20.55) });
    const rowFor = (marketplace: MarketplaceId) =>
      readHandlers(db)
        .card_printings({ oracleId: sta.oracleId!, marketplace })
        .items.find((p) => p.id === sta.id)!.finishPrices;

    expect(rowFor("tcgplayer").foil).toBe(23.85);
    expect(rowFor("cardkingdom").foil).toBe(26.24);
    expect(rowFor("manapool").foil).toBeNull();
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
    expect(detail.categories.map((c) => c.totalPrice)).toEqual([null, 1860, null, null, 620]);
    expect(readHandlers(db).deck_get({ id: 1, variant: "theory" })!.categories[2].cardCount).toBe(
      9,
    );
    // `cardCountAllVariants` is the one number that is *not* scoped, and the Sideboard is where
    // that shows: 0 live, 9 theory, 9 either way you ask. It is what the delete confirmation
    // quotes, because `deck_cards.category_id` is `ON DELETE CASCADE` and a category is not
    // per-variant — a dialog reading `cardCount` would have promised 0 and taken 9.
    expect(detail.categories.map((c) => c.cardCountAllVariants)).toEqual([0, 3, 9, 0, 1]);
    expect(
      readHandlers(db).deck_get({ id: 1, variant: "theory" })!.categories[2]
        .cardCountAllVariants,
    ).toBe(9);
    // No tag has been made, so the palette is empty — and it is a list, not a null.
    expect(detail.tags).toEqual([]);
  });

  /**
   * A tag's `cardCount` is scoped to the variant asked for, exactly as a category's is.
   *
   * They are answered by one read and describe one list of cards, so scoping one and not the
   * other is a read that contradicts itself — which is what the Rust did once: `get_deck`
   * threaded its variant into `list_categories` and not into `list_tags`, so a Theory read
   * came back with Theory category counts beside Live tag counts.
   */
  it("counts a tag over the variant that was asked for, like a category", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckTags: [{ id: 1, deckId: 1, name: "Flex", color: "amber" }],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 3, tagId: 1 }),
        deckCard({
          id: 2,
          cardId: BOLT.id,
          categoryKind: "main",
          variant: "theory",
          quantity: 7,
          tagId: 1,
        }),
      ],
    });

    expect(liveDeck(db)!.tags).toEqual([
      { id: 1, deckId: 1, name: "Flex", color: "amber", cardCount: 3 },
    ]);
    expect(readHandlers(db).deck_get({ id: 1, variant: "theory" })!.tags[0].cardCount).toBe(7);
  });

  it("prices a deck card at the printing's nonfoil usd, and leaves the piles beside the deck out of its size", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 3 }),
        deckCard({ id: 2, cardId: BOLT.id, categoryKind: "side", quantity: 2 }),
        deckCard({ id: 3, cardId: BOLT.id, categoryKind: "commander", quantity: 1 }),
        deckCard({ id: 4, cardId: BOLT.id, categoryKind: "companion", quantity: 1 }),
      ],
    });
    const detail = liveDeck(db)!;
    // `lea 161`'s blob is `usd` 620.00 with both foil keys null.
    expect(detail.cards[0].unitPrice).toBe(620);
    // CR 100.4a for the sideboard, EDH's "effectively a 101st card" for the companion.
    expect(detail.deck.cardCount).toBe(4);
  });

  /**
   * The switch decides whether a pile counts at all; the kind decides only whether it is
   * played *beside* the deck or *in* it, and only `side` and `companion` are beside it. So an
   * active Maybeboard is part of the deck's size — the same sentence `engine.ts`'s
   * `SIZE_KINDS` and `deck.rs`'s `DECK_SELECT` are written from, and a fake that disagreed
   * would story a deck the app would count differently.
   */
  it("sizes a Maybeboard the reader switched on, and not one left switched off", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 3 }),
        deckCard({ id: 2, cardId: BOLT.id, categoryKind: "maybe", quantity: 5 }),
      ],
    });
    expect(liveDeck(db)!.deck.cardCount).toBe(3);

    const scratch = db.deckCategories.find((c) => c.kind === "maybe")!;
    scratch.isActive = true;
    expect(liveDeck(db)!.deck.cardCount).toBe(8);
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
      // Schema v8's writes: a category, a tag, a folder and a cover each name their own
      // arguments, and every one of them is here because `invoke` matches by name.
      name: "Ramp",
      color: "ember",
      isActive: false,
      ids: [categoryId(1, "main")],
      moveToCategoryId: null,
      tagId: null,
      parentId: null,
      folderId: null,
      sourcePath: "C:\\Users\\Reader\\Pictures\\sleeve.png",
      marketplace: "cardkingdom",
    };
    // 41 commands in the table, the five above excluded: 36 that really take the lock —
    // re-counted 2026-08-12 with `marketplace_feed_refresh`, which is the newest of them. It
    // rewrites `marketplace_prices` through `lock_for` like every other write here, where its
    // two read halves (`marketplace_feed_status` and `get_marketplace`, on `db_read`) are not
    // refusable at all.
    const names = Object.keys(w).filter((n) => !unlocked.includes(n));
    expect(names).toHaveLength(36);
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

  /**
   * The one setting stored as an `app_meta` row, and the two states that row has that a
   * narrowed field could not reach: never written, and written by a build that knew an id this
   * one does not. Both read as the default, and only a *write* refuses — which is the whole of
   * why the table cannot collect junk while a downgrade still renders prices.
   */
  it("falls back to the default marketplace on a missing or unknown row, and refuses a bad write", () => {
    expect(readHandlers(makeDb()).get_marketplace()).toBe("tcgplayer");
    expect(readHandlers(makeDb({ marketplace: "moxfield" })).get_marketplace()).toBe("tcgplayer");
    expect(readHandlers(makeDb({ marketplace: "cardmarket" })).get_marketplace()).toBe("cardmarket");

    const db = makeDb();
    writeHandlers(db).set_marketplace({ id: "cardmarket" });
    expect(db.marketplace).toBe("cardmarket");
    expect(readHandlers(db).get_marketplace()).toBe("cardmarket");

    expect(() => writeHandlers(db).set_marketplace({ id: "moxfield" })).toThrow(
      /is not a marketplace/,
    );
    // Refused, and the row it would have overwritten is still the one that was chosen.
    expect(db.marketplace).toBe("cardmarket");
  });

  /**
   * The feed status, including the row for a feed **nothing has ever fetched**.
   *
   * `marketplace_feed_meta` has no row for such a feed at all, and the command answers one
   * anyway with `fetchedAt: null` — because "never fetched" is the state a first selection acts
   * on, and a command that simply omitted it would leave a panel unable to tell it from "not
   * read yet". Only the two feed-backed marketplaces appear: TCGplayer and Cardmarket arrive
   * with the card data, and Card trader has nothing to fetch.
   */
  it("answers a row for every downloaded feed, fetched or not", () => {
    const db = makeDb();
    const status = readHandlers(db).marketplace_feed_status();

    expect(status.map((s) => s.marketplace)).toEqual(["cardkingdom", "manapool"]);
    // `null` rather than `0`, and **stale by definition** — which is what makes the backend's
    // start-up pass collect a feed nobody has ever fetched.
    expect(status.every((s) => s.fetchedAt === null && s.rowCount === null)).toBe(true);
    expect(status.every((s) => s.stale && !s.refreshing)).toBe(true);
  });

  /**
   * A refresh writes the feed's rows and its stamp — and **Card Kingdom publishes a build date
   * where Mana Pool publishes none**, which is the difference the panel draws two lines for.
   */
  it("fills one feed's prices without touching the other's", () => {
    const db = seed("starter");
    db.marketplacePrices = [];
    db.marketplaceFeeds = [];

    const answer = writeHandlers(db).marketplace_feed_refresh({ marketplace: "cardkingdom" });

    expect(answer.rowCount).toBeGreaterThan(0);
    expect(answer.feedBuiltAt).toBe("2026-08-11 21:07:02");
    expect(db.marketplacePrices.every((p) => p.marketplace === "cardkingdom")).toBe(true);
    // Mana Pool is untouched, and still says so.
    const status = readHandlers(db).marketplace_feed_status();
    expect(status.find((s) => s.marketplace === "manapool")!.fetchedAt).toBeNull();
    expect(status.find((s) => s.marketplace === "cardkingdom")!.rowCount).toBe(answer.rowCount);
  });

  /** A marketplace with no feed has nothing to refresh, and is refused in words rather than
   *  quietly doing nothing — the same rule `set_marketplace` follows one row up. */
  it("refuses a refresh for a marketplace whose prices are not downloaded", () => {
    expect(() =>
      writeHandlers(makeDb()).marketplace_feed_refresh({ marketplace: "tcgplayer" }),
    ).toThrow(/has no price feed to refresh/);
  });

  /**
   * **A failed fetch leaves the previous prices in place**, which is the whole of why the
   * backend refuses a feed that parsed to zero rows rather than writing it: an error page must
   * not be able to wipe a working price table. Stale prices under an honest as-of line beat no
   * prices at all.
   */
  it("keeps the prices it already had when a fetch fails, and writes the reason down", () => {
    const db = seed("starter");
    const before = db.marketplacePrices.length;
    db.fault = "feedFetchError";

    expect(() =>
      writeHandlers(db).marketplace_feed_refresh({ marketplace: "cardkingdom" }),
    ).toThrow(/could not be downloaded/);

    expect(db.marketplacePrices).toHaveLength(before);
    expect(db.errorLog[db.errorLog.length - 1].operation).toBe("marketplace_feed");
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

/**
 * Schema v8's satellite tables, and only the things a story could be wrong about.
 *
 * Not a restatement of every handler: what is pinned here is each place the fake had to make a
 * decision the DTO does not force — a count that is variant-scoped, a delete that folds, a
 * cascade that reaches sideways, a comparison that is by oracle card rather than by printing.
 */
describe("categories, tags, folders, history and the plan", () => {
  /** The row a write just appended. `Array.prototype.at` is out of `.storybook`'s lib target,
   *  which `tsc -p .storybook` enforces and the app's own program does not. */
  const lastAudit = (db: FakeDb) => db.deckAudit[db.deckAudit.length - 1];

  /** `[variant, quantity]` pairs, ordered so an assertion does not depend on row order. */
  const cmpRow = (a: (string | number)[], b: (string | number)[]) =>
    String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0;

  /** Deck 4 of the `starter` seed, which is the one deck carrying all of it. */
  const testbed = () => {
    const db = seed("starter");
    return { db, r: readHandlers(db), w: writeHandlers(db) };
  };

  it("scopes a category's two numbers to the variant and its identity to neither", () => {
    const { r } = testbed();
    const live = r.deck_category_list({ deckId: 4, variant: "live" });
    const theory = r.deck_category_list({ deckId: 4, variant: "theory" });

    // The same seven columns either way — switching lists changes what is *in* them, never
    // which there are, which is what keeps the headings still while a reader reads.
    expect(theory.map((c) => c.id)).toEqual(live.map((c) => c.id));
    const ramp = (rows: typeof live) => rows.find((c) => c.name === "Ramp")!;
    expect(ramp(live).cardCount).toBe(2);
    expect(ramp(theory).cardCount).toBe(5);
    // A pile holding nothing priced reads `null` and not `0`: SQL's `sum()` of no non-NULL
    // terms is NULL, and "nothing here has a price" is a different statement from "free".
    expect(live.find((c) => c.name === "Cut list")!.totalPrice).toBeNull();
  });

  it("refuses to rename or delete a predefined category and switches every one of them off", () => {
    const { db, r, w } = testbed();
    const commander = r.deck_category_list({ deckId: 4, variant: "live" })[0];

    expect(() => w.deck_category_rename({ id: commander.id, name: "Generals" })).toThrow(
      /required by this deck's rules/,
    );
    expect(() => w.deck_category_delete({ id: commander.id, moveToCategoryId: null })).toThrow(
      /required by this deck's rules/,
    );
    // The one write every kind answers to. Deactivating the commander is legal (if unwise) and
    // the validation engine reporting a missing commander is the honest cost.
    expect(w.deck_category_set_active({ id: commander.id, isActive: false }).isActive).toBe(false);
    expect(lastAudit(db)?.payload).toContain("deactivate");
  });

  it("moves a deleted category's cards in both variants, or lets them go", () => {
    const { db, r, w } = testbed();
    const of = (name: string) =>
      r.deck_category_list({ deckId: 4, variant: "live" }).find((c) => c.name === name)!.id;
    const ramp = of("Ramp");
    const advantage = of("Card advantage");

    w.deck_category_delete({ id: ramp, moveToCategoryId: advantage });

    // **Both lists move**, and neither into the other: a category is not variant-scoped, so the
    // cascade and the move both take the plan's rows along with the deck's.
    const landed = db.deckCards.filter((dc) => dc.categoryId === advantage);
    expect(landed.filter((dc) => dc.variant === "live").length).toBe(3);
    expect(landed.filter((dc) => dc.variant === "theory").length).toBe(7);
    // Counted in copies before anything moved, over both variants, which is the number the
    // confirm dialog warned about and the only part of a deleted category nobody gets back.
    expect(JSON.parse(lastAudit(db)!.payload)).toMatchObject({ action: "delete", cards: 7 });

    // The destructive half, on a fresh copy of the fixture.
    const second = testbed();
    const doomed = second.r
      .deck_category_list({ deckId: 4, variant: "live" })
      .find((c) => c.name === "Cut list")!.id;
    second.w.deck_category_delete({ id: doomed, moveToCategoryId: null });
    expect(second.db.deckCards.some((dc) => dc.categoryId === doomed)).toBe(false);
  });

  /** The half the seed cannot stage — it holds no printing filed in two of deck 4's piles at
   *  once — so it is directed rather than fixture-driven. */
  it("folds a moved card into a row the target already holds, per variant", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, categoryKind: "main", quantity: 2 }),
        deckCard({ id: 2, categoryKind: "main", variant: "theory", quantity: 3 }),
        deckCard({ id: 3, categoryId: 99, quantity: 4 }),
        deckCard({ id: 4, categoryId: 99, variant: "theory", quantity: 1 }),
      ],
      deckCategories: [
        ...categoriesOf([deck({ id: 1 })]),
        { id: 99, deckId: 1, name: "Doomed", kind: "main", isActive: true, sortOrder: 9 },
      ],
    });

    writeHandlers(db).deck_category_delete({
      id: 99,
      moveToCategoryId: categoryId(1, "main"),
    });

    // One row per variant, each the sum of its own pair — never 2+3+4+1 in one row.
    expect(
      db.deckCards.map((dc) => [dc.variant, dc.quantity]).sort((a, b) => cmpRow(a, b)),
    ).toEqual([
      ["live", 6],
      ["theory", 4],
    ]);
  });

  it("untags a deleted tag's cards rather than deleting them", () => {
    const { db, w } = testbed();
    const tag = db.deckTags.find((t) => t.deckId === 4 && t.name === "Cut candidate")!;
    expect(db.deckCards.filter((dc) => dc.tagId === tag.id).length).toBeGreaterThan(0);

    w.deck_tag_delete({ id: tag.id });

    expect(db.deckCards.filter((dc) => dc.tagId === tag.id)).toHaveLength(0);
    expect(db.deckCards.filter((dc) => dc.deckId === 4)).not.toHaveLength(0);
    // An id that resolves to nothing is a success: the caller wanted that tag gone.
    expect(() => w.deck_tag_delete({ id: tag.id })).not.toThrow();
  });

  it("offers the tag palette of every deck, most-used first, grouped on the pair", () => {
    const { r } = testbed();
    // "Cut candidate" is spelled the same way by two decks; the other two are used once each
    // and tie, so the name breaks it. No deck id anywhere in the call.
    expect(r.deck_tag_suggestions()).toEqual([
      { name: "Cut candidate", color: "ember" },
      { name: "Budget swap", color: "moss" },
      { name: "Combo piece", color: "gold" },
    ]);
  });

  it("refuses a tag of another deck on a card, and a card that has moved", () => {
    const { db, w } = testbed();
    const mine = db.deckTags.find((t) => t.deckId === 4)!;
    const theirs = db.deckTags.find((t) => t.deckId === 3)!;
    const row = db.deckCards.find((dc) => dc.deckId === 4 && dc.variant === "live")!;

    expect(() =>
      w.deck_card_set_tag({
        deckId: 4,
        cardId: row.cardId,
        categoryId: row.categoryId,
        variant: "live",
        tagId: theirs.id,
      }),
    ).toThrow(/belongs to a different deck/);
    expect(() =>
      w.deck_card_set_tag({
        deckId: 4,
        cardId: row.cardId,
        // A category of this deck that this card is not in — the stale editor's case.
        categoryId: db.deckCategories.find((c) => c.deckId === 4 && c.name === "Sideboard")!.id,
        variant: "live",
        tagId: mine.id,
      }),
    ).toThrow(/not in this deck's category any more/);
  });

  it("takes a folder's sub-folders and leaves its decks at the root", () => {
    const { db, w } = testbed();
    // Deck 4 is in `Constructed › Commander`; deleting the *parent* cascades onto the child.
    w.deck_folder_delete({ id: 1 });

    expect(db.deckFolders.map((f) => f.name)).toEqual(["Ideas"]);
    expect(db.decks.find((d) => d.id === 4)!.folderId).toBeNull();
    expect(db.decks).toHaveLength(4);
  });

  it("refuses a folder move that would make a cycle", () => {
    const { w } = testbed();
    expect(() => w.deck_folder_move({ id: 1, parentId: 1 })).toThrow(/inside itself/);
    // Into its own descendant, which is the case a one-level check misses.
    expect(() => w.deck_folder_move({ id: 1, parentId: 2 })).toThrow(/inside itself/);
    expect(w.deck_folder_move({ id: 2, parentId: null }).parentId).toBeNull();
  });

  it("records a deck's filing as a folder row carrying the path, and the root as null", () => {
    const { db, w } = testbed();
    w.deck_set_folder({ deckId: 1, folderId: 2 });
    expect(JSON.parse(lastAudit(db)!.payload)).toEqual({
      action: "move",
      // The path rather than the id: a bare number is something no reader could resolve once
      // the folder was renamed.
      folder: "Constructed › Commander",
    });

    w.deck_set_folder({ deckId: 1, folderId: null });
    expect(JSON.parse(lastAudit(db)!.payload)).toEqual({ action: "move", folder: null });
    // A deck that did not move records nothing.
    const before = db.deckAudit.length;
    w.deck_set_folder({ deckId: 1, folderId: null });
    expect(db.deckAudit).toHaveLength(before);
  });

  it("clamps the history's limit at both ends and answers nothing for a deck that is gone", () => {
    const { r } = testbed();
    // SQLite reads a negative `LIMIT` as *no limit at all*, which is what the clamp stops.
    expect(r.deck_audit_list({ deckId: 4, limit: -1 })).toHaveLength(1);
    expect(r.deck_audit_list({ deckId: 4, limit: 0 })).toHaveLength(1);
    expect(r.deck_audit_list({ deckId: 4, limit: 500 })).toHaveLength(13);
    // The history of a deck that does not exist is nothing, not an error.
    expect(r.deck_audit_list({ deckId: 99, limit: 10 })).toEqual([]);
    // Newest first, and the id breaks a same-second tie.
    const rows = r.deck_audit_list({ deckId: 4, limit: 500 });
    expect(rows[0].at).toBeGreaterThanOrEqual(rows[1].at);
  });

  it("compares the two lists by oracle card, one direction, skipping inactive piles", () => {
    const { r } = testbed();
    const diff = r.deck_theory_diff({ deckId: 4 });

    expect(diff.map((d) => [d.name, d.quantity])).toEqual([
      // Live's copy is in the switched-off "Cut list", which is excluded from *both* sides —
      // so the plan is short of one, and the row is unpriced because `lea` Black Lotus is
      // quoted in euros and in nothing else.
      ["Black Lotus", 1],
      ["Smuggler's Copter", 2],
      ["Urza's Saga", 1],
      ["Jace, the Mind Sculptor", 1],
    ]);
    expect(diff[0].unitPrice).toBeNull();
    // The deck holds two Sol Rings and the plan wants one. A cut is not a purchase, so there
    // is no row for it in either direction.
    expect(diff.some((d) => d.name === "Sol Ring")).toBe(false);
    // A plan that is a copy of its deck asks for nothing.
    expect(r.deck_theory_diff({ deckId: 3 })).toEqual([]);
  });

  it("seeds the plan from the deck without overwriting what the plan already says", () => {
    const { db, w } = testbed();
    const ramp = db.deckCategories.find((c) => c.deckId === 4 && c.name === "Ramp")!;
    const planned = db.deckCards.find(
      (dc) => dc.deckId === 4 && dc.variant === "theory" && dc.categoryId === ramp.id,
    )!;
    const before = planned.quantity;

    w.deck_theory_copy_from_live({ deckId: 4 });

    // The reader's own plan for that card is untouched — `DO NOTHING`, never a fold, because
    // topping it up with the live count would overwrite the edit the plan exists to hold.
    expect(planned.quantity).toBe(before);
    // The one `deck`-kind row that moves the day header's arithmetic.
    const row = lastAudit(db)!;
    expect(row.variant).toBe("theory");
    expect(row.delta).toBeGreaterThan(0);
    expect(JSON.parse(row.payload)).toMatchObject({ field: "theory", copied: row.delta });
  });

  it("wishes for the plan's shortfall without netting out the spare copies", () => {
    const { db, r, w } = testbed();
    const diff = r.deck_theory_diff({ deckId: 4 });
    const lotus = diff.find((d) => d.name === "Black Lotus")!;
    // The row a naive subtraction would drop: wanted 1, and one spare in the box.
    expect(lotus.ownedSpare).toBe(1);

    expect(w.deck_theory_missing_to_wishlist({ deckId: 4 })).toBe(diff.length);

    const wish = db.wishlistEntries.find((x) => x.name === "Black Lotus")!;
    // Any printing, always: a shopping list is not a printing preference.
    expect(wish.cardId).toBeNull();
    expect(wish.quantity).toBeGreaterThanOrEqual(1);
  });

  it("switching the plan on seeds it from live, and switching it off keeps every row", () => {
    const { db, w } = testbed();
    const rowsOf = (variant: string) =>
      db.deckCards.filter((dc) => dc.deckId === 1 && dc.variant === variant).length;
    const live = rowsOf("live");
    expect(rowsOf("theory")).toBe(0);

    // Deck 1 has no plan at all, so the flag fills it in the same write — an empty plan beside
    // a full deck reads as data loss rather than as a blank page.
    expect(w.deck_update({ id: 1, patch: { theoryEnabled: true } }).theoryEnabled).toBe(true);
    expect(rowsOf("theory")).toBe(live);

    // Off keeps every row: it hides a switch, it does not delete a list.
    w.deck_update({ id: 1, patch: { theoryEnabled: false } });
    expect(rowsOf("theory")).toBe(live);
  });

  it("puts a custom cover on without clearing the card underneath it", () => {
    const { db, w } = testbed();
    const row = w.deck_set_cover_image({ deckId: 1, sourcePath: "C:\\pictures\\sleeve.png" });

    expect(row.coverKind).toBe("custom");
    // Switching back to card art is `deck_update({ coverCardId })` and loses nothing either way,
    // which is only coherent because `coverKind` is the one answer to which is showing.
    expect(row.coverCardId).not.toBeNull();
    expect(w.deck_update({ id: 1, patch: { coverCardId: row.coverCardId! } }).coverKind).toBe(
      "card_art",
    );
    // Recorded even when both sides read `custom`: the payload does not name the file, so the
    // two sides matching is what "a different picture" looks like from here.
    expect(db.deckAudit.filter((a) => a.payload.includes('"field":"cover"'))).toHaveLength(2);
  });

  it("refuses every satellite read under the deckMeta fault, and the deck itself under none", () => {
    const db = seed("starter");
    db.fault = "deckMeta";
    const r = readHandlers(db);

    expect(() => r.deck_category_list({ deckId: 4, variant: "live" })).toThrow(/categories/);
    expect(() => r.deck_tag_list({ deckId: 4, variant: "live" })).toThrow(/tags/);
    expect(() => r.deck_tag_suggestions()).toThrow(/palette/);
    expect(() => r.deck_folder_list()).toThrow(/folders/);
    expect(() => r.deck_audit_list({ deckId: 4, limit: 10 })).toThrow(/history/);
    expect(() => r.deck_theory_diff({ deckId: 4 })).toThrow(/theory list/);
    // The deck is not a satellite: a screen that could not read it would not be showing a
    // panel about it.
    expect(r.deck_get({ id: 4, variant: "live" })).not.toBeNull();
    expect(r.deck_list()).toHaveLength(4);
  });
});
