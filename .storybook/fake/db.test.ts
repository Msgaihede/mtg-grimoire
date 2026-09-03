/**
 * What the row store has to get right, and nothing that merely restates it.
 *
 * The first block is the whole reason `db.ts` stores rows: `ownedQuantity` is three
 * different questions with one name, and a fake that stored DTOs would answer them
 * identically and be plausible every time.
 */
import { describe, expect, it } from "vitest";
import { invoke, registerCommands, resetCommands } from "./core";
import {
  ART_TAGGED_PRINTINGS,
  ORACLE_TAGGED_NAMES,
  SUPPORTING_SINCE,
  allHandlers,
  applySupporterFault,
  artTagIllustrations,
  makeDb,
  mirrorFailedPass,
  neverCheckedUpdate,
  oracleTagCards,
  oracleTagEdges,
  oracleTagRows,
  pluginHandlers,
  readHandlers,
  writeHandlers,
} from "./db";
import { listen } from "./event";
import type {
  FakeCollectionFolder,
  FakeDb,
  FakeDeck,
  FakeDeckCard,
  FakeDeckCategory,
  FakeEntry,
  FakeWish,
} from "./db";
import { DECK_CATEGORIES } from "./fixtures";
import { seed } from "./seeds";
import { CARDS, type FakeCard } from "./cards";
import type {
  CardSummary,
  CategoryKind,
  CollectionImportItem,
  CollectionPage,
  CollectionQuery,
  CollectionSortKey,
  DeckDetail,
  DeckVariant,
  EntryChange,
  EntryInput,
  ImportResolveLine,
  SearchRequest,
  SearchSortKey,
  TransferImportMode,
  WishlistImportItem,
  WishlistPage,
  WishlistQuery,
  WishlistSortKey,
} from "@/lib/ipc";
import type { Finish } from "@/lib/finish";
import { PRINTING_GROUP_BY_OPTIONS } from "@/features/card/printings";
import type { MarketplaceId } from "@/lib/marketplace";
import type { SortSpec } from "@/lib/sort";

const BOLT = CARDS.find((c) => c.name === "Lightning Bolt")!;
/** The second Bolt printing — `2x2 117`, uncommon. Used wherever "a different printing of
 *  the same card" is the point. */
const BOLT_2X2 = CARDS.filter((c) => c.name === "Lightning Bolt")[1];
/** The corpus's foil-only printing — the `mp2` Consecrated Sphinx Invocation, `finishes:
 *  ["foil"]`, `usd` null and `usd_foil` 164.95. What a deck row priced at a flat `nonfoil`
 *  rendered as an em dash. */
const FOIL_ONLY = CARDS.find((c) => c.finishes === '["foil"]')!;
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
    // The root, unless `over` files it. The eleventh term of the storage grain, so a test that
    // wants two rows of one printing can make them with this alone.
    folderId: null,
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
    // The root, and every test that cares says so itself. `null` is a real destination here
    // rather than an absence: it is where an unfiled wish is, and the grain's fourth term.
    folderId: null,
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
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
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
 * The collection folder that stands for a deck, from the deck id — {@link categoryId}'s trick
 * one table over, so a test can file an entry into a deck's group inline and the row
 * {@link makeDeckDb} seeds and the row {@link entry} builds agree without a lookup.
 *
 * Well clear of the ids a hand-written fixture uses, because a few tests seed both cabinets.
 */
function groupId(deckId: number): number {
  return 100 + deckId;
}

/** The one holding area, of which schema v25 allows exactly one. */
const REMOVED_FOLDER = 199;

/** Every deck's group plus the single `Recently removed` folder — what schema v25 built and what
 *  `deck_create` has made for every deck since. */
function groupsOf(decks: FakeDeck[]): FakeCollectionFolder[] {
  return [
    ...decks.map((d) => ({
      id: groupId(d.id),
      parentId: null,
      name: d.name,
      kind: "deck",
      deckId: d.id,
      sortOrder: 0,
    })),
    {
      id: REMOVED_FOLDER,
      parentId: null,
      name: "Recently removed",
      kind: "removed",
      deckId: null,
      sortOrder: 0,
    },
  ];
}

/**
 * `makeDb` with those five categories per deck already in it, **and the app's own folders**.
 *
 * A deck without its categories is a state neither `create_deck` nor the v8 migration can
 * leave behind — and every card write refuses one, so a fixture missing them would fail with
 * "That category is not there any more" rather than testing what it meant to.
 *
 * A deck without its **group** is the same kind of impossible since schema v25: `create_deck`
 * makes one, the migration made one for every deck that already existed, and
 * `collection_to_deck` answers "That deck has no folder to hold its cards" without one. So the
 * groups are here for exactly {@link categoriesOf}'s reason, and `Recently removed` with them —
 * a store missing it would refuse every cut rather than testing what it meant to.
 */
function makeDeckDb(init: Partial<FakeDb> = {}): FakeDb {
  const db = makeDb(init);
  db.deckCategories = init.deckCategories ?? categoriesOf(db.decks);
  db.collectionFolders = init.collectionFolders ?? groupsOf(db.decks);
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
    labelId: null,
    quantity: 1,
    name: card?.name ?? "Gone",
    setCode: card?.setCode ?? "xxx",
    collectorNumber: card?.collectorNumber ?? "1",
    lang: card?.lang ?? "en",
    finish: null,
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

  it("is what THIS DECK'S GROUP holds, and an inactive category is never attributed to", () => {
    const db = makeDeckDb({
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, finish: "nonfoil", quantity: 3, folderId: groupId(1) }),
      ],
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
    // The Maybeboard is seeded inactive, and that — not its kind — is why nothing is attributed
    // to it. The third copy in the group stays unattributed rather than moving to that row.
    expect(owned("maybe")).toBe(0);
  });

  it("is 0 on a deck card whose copies are in the binder rather than in the deck", () => {
    // The same fixture with the entry at the root, which is the whole of what schema v25
    // changed: owning four copies is not the same thing as the deck holding them.
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 4 })],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT.id, quantity: 4 })],
    });
    expect(liveDeck(db)!.cards[0].ownedQuantity).toBe(0);
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
    // 52 fixture rows, 2 of them `isPaper: false` (Black Lotus `vma`, A-Vivi Ornitier
    // `fin`) — measured 2026-08-22 over `CARDS`.
    expect(withDigital.items).toHaveLength(52);
    expect(all.items).toHaveLength(50);
  });

  it("is off for the collection, which lists what the user owns", () => {
    const vma = CARDS.find((c) => c.name === "Black Lotus" && c.setCode === "vma")!;
    const db = makeDb({ collectionEntries: [entry({ id: 1, cardId: vma.id })] });
    const page = readHandlers(db).collection_list({ query: { limit: 10, offset: 0 } });
    expect(page.items).toHaveLength(1);
  });
});

/**
 * The card filter, which is what "View all printings" hands over: every printing of one oracle
 * card, and never the *other* cards a prefix-matched name would answer.
 *
 * Bolt is the fixture for it because it is the only name in the corpus with four printings and
 * two rarities, so a filter that quietly collapsed or widened would be visible in the count.
 */
describe("the oracle-card filter", () => {
  it("narrows to one card's printings and ANDs with the filters beside it", () => {
    const reads = readHandlers(makeDb());
    const bolts = reads.search_cards({
      req: { oracleId: BOLT.oracleId, collapse: false, limit: 200, offset: 0 },
    });
    expect(bolts.items).toHaveLength(4);
    expect(bolts.items.every((i) => i.name === "Lightning Bolt")).toBe(true);

    // ANDed, not ORed: the same request with a set filter answers that one printing.
    const one = reads.search_cards({
      req: { oracleId: BOLT.oracleId, sets: ["2x2"], collapse: false, limit: 200, offset: 0 },
    });
    expect(one.items.map((i) => i.setCode)).toEqual(["2x2"]);
  });

  it("treats a blank id as no filter, the way a cleared control sends one", () => {
    const reads = readHandlers(makeDb());
    const unfiltered = reads.search_cards({ req: { collapse: false, limit: 200, offset: 0 } });
    // `resetAll` clears this to exactly `""`. Bound literally it would match nothing and draw
    // an empty wall with no chip to explain it — the direction `filters.rs` names as failing
    // closed.
    const blank = reads.search_cards({
      req: { oracleId: "  ", collapse: false, limit: 200, offset: 0 },
    });
    expect(blank.items).toHaveLength(unfiltered.items.length);
    expect(unfiltered.items.length).toBeGreaterThan(4);
  });
});

/**
 * `search.rs`'s `c.game_changer` — the crown the wall and the table draw beside the finish
 * marks.
 *
 * The three names are written out rather than counted off `CARDS`, for the reason every
 * other block here writes its numbers out: a list derived from the fixture would agree with
 * a `toCardSummary` that re-derived the flag from a hand-typed list of names, which is the
 * one way this field can go wrong. They are also deliberately unalike — a **land** with no
 * mana cost, a **common**, and a **foil-only** printing at rarity `special` — so no story
 * built on the corpus can leave the impression that a crown is a property of rarity, of a
 * cost, or of a finish.
 */
describe("the game changers", () => {
  it("reads the column onto a search row, and the corpus has exactly three", () => {
    const page = readHandlers(makeDb()).search_cards({ req: { limit: 200, offset: 0 } });
    expect(
      page.items
        .filter((i) => i.gameChanger)
        .map((i) => i.name)
        .sort(),
    ).toEqual(["Ancient Tomb", "Consecrated Sphinx", "Rhystic Study"]);
  });

  it("survives collapsing, where a row is a card and not the printing it came from", () => {
    const study = CARDS.find((c) => c.name === "Rhystic Study")!;
    // A second printing of the same oracle card, and the **newer** one — so it is the
    // representative the collapsed row is built from, and a group that lost the crown on the
    // way through `collapseToCards` would say so here.
    const db = makeDb({
      cards: [study, { ...study, id: "rhystic-second", setCode: "cmr", releasedAt: "2020-11-20" }],
    });
    const page = readHandlers(db).search_cards({ req: { collapse: true, limit: 10, offset: 0 } });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].printings).toBe(2);
    expect(page.items[0].gameChanger).toBe(true);
  });
});

/**
 * The paper filter's neighbour, whose default is the **opposite** — omitted means off, because
 * the search view is the only caller that sends it (`filters::CardFilters::playable_only`).
 * Getting that backwards is the one mistake this mirror can make silently: the collection would
 * stop listing an art card its owner really owns, and nothing would say so.
 */
describe("the playable filter", () => {
  /** The three paper printings the mask reads as legal nowhere, named rather than counted so a
   *  regenerated `cards.ts` fails here rather than one number out. */
  const UNPLAYABLE = [
    "Prismatic Ending // Prismatic Ending",
    "Kozilek, Compleated",
    "Little Girl",
    // A Plane card: `planar` is legal in no format at all, which is a fourth way into this
    // filter and not a fourth spelling of the same one.
    "Llanowar",
  ];

  it("is off unless asked for, and then hides the printings no format allows", () => {
    const db = makeDb();
    const seen = (req: Record<string, unknown>) =>
      (
        readHandlers(db).search_cards({ req: { limit: 200, offset: 0, ...req } }) as {
          items: { name: string }[];
        }
      ).items.map((i) => i.name);

    // The four really are in the corpus and really are unplayable, so the assertion below is
    // about the filter rather than about a fixture that never had them.
    for (const name of UNPLAYABLE) {
      const card = CARDS.find((c) => c.name === name)!;
      expect(card.isPaper).toBe(true);
      expect(/"(legal|restricted)"/.test(card.legalities)).toBe(false);
    }

    expect(seen({})).toHaveLength(50);
    expect(seen({ playableOnly: false })).toHaveLength(50);

    const playable = seen({ playableOnly: true });
    expect(playable).toHaveLength(46);
    for (const name of UNPLAYABLE) expect(playable).not.toContain(name);
    // `restricted` counts as playable — a Vintage search that hid Black Lotus would be wrong.
    expect(playable).toContain("Black Lotus");
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
 * The counts are measured over `CARDS` (52 rows, 50 of them paper) rather than derived from
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
    // modern-legal, against 33 over the whole paper corpus.
    expect(f.formats.modern).toBe(2);
  });

  it("sends every set code in the corpus, zeros included", () => {
    const f = facets(makeDb(), { text: "bolt" });
    // 38 distinct codes over the 52 fixture rows; the four Bolt printings are in four of
    // them, so 34 arrive as an explicit 0. `FacetResponse.sets` promises a key is never
    // absent, which is what lets the picker grey a row instead of dropping it.
    expect(Object.keys(f.sets)).toHaveLength(38);
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
    expect(none.total).toBe(50);
    // Subset semantics, so this is mono-R plus the colourless cards — a narrowing count.
    expect(none.colors.R).toBe(16);

    const red = facets(makeDb(), { colors: "R" });
    expect(red.total).toBe(16);
    // Pressing W with R on asks for "castable in RW", a superset — never a shrink.
    expect(red.colors.W).toBe(30);
    // Pressing R again clears the filter.
    expect(red.colors.R).toBe(50);
  });

  it("makes the colourless chip exclusive both ways, as `toggleColor` does", () => {
    expect(facets(makeDb(), { colors: "R" }).colors.C).toBe(9);
    const c = facets(makeDb(), { colors: "C" });
    expect(c.total).toBe(9);
    expect(c.colors.C).toBe(50);
    // W/R replaces it rather than joining it: `"RC"` would silently mean plain `"R"`.
    expect(c.colors.R).toBe(16);
  });

  /**
   * `playableOnly` is not a facet either, so it narrows every base — and it **cannot move a
   * format count**, because a card legal in a format is playable by definition. That equality
   * is the assertion worth making: if it ever failed, the format select would grey an option
   * the search returns rows for.
   */
  it("narrows every base by the playable decision and leaves the format counts alone", () => {
    const off = facets(makeDb(), {});
    const on = facets(makeDb(), { playableOnly: true });

    expect(off.total).toBe(50);
    expect(on.total).toBe(46);
    // Chip 8 is open-ended and loses `Kozilek, Compleated` (cmc 10), the one of the four
    // unplayable rows with a cost at all.
    expect(on.manaValues["8"]).toBe(off.manaValues["8"] - 1);
    for (const key of ["modern", "vintage", "commander", "pauper"]) {
      expect(on.formats[key]).toBe(off.formats[key]);
    }
  });

  it("counts a colour over the paper decision the request made, not over the default", () => {
    // The colour dimension is the one that re-runs a filter over its own base, so it is the
    // one that can put the paper default back on a base that asked for digital printings.
    expect(facets(makeDb(), { paperOnly: false }).colors.R).toBe(17);
  });

  it("matches a mana chip exactly below 8 and as a range at 8", () => {
    const f = facets(makeDb(), {});
    // `Little Girl` (`unh`, cmc 0.5) is the corpus' one fractional cost and it belongs to
    // **no** chip — `Math.trunc` would file it under 0 and promise a card the search will
    // not return.
    expect(CARDS.some((c) => c.isPaper && c.cmc === 0.5)).toBe(true);
    expect(f.manaValues["0"]).toBe(CARDS.filter((c) => c.isPaper && c.cmc === 0).length);
    // 8 is open-ended: Avacyn (8), Dusk // Dawn (9), Kozilek (10), Brisela (11),
    // Emrakul (15).
    expect(f.manaValues["8"]).toBe(5);
  });

  /**
   * **The X chip is a member of the mana OR group, not a second question ANDed onto it.**
   * `filters.rs` puts `mana_cost LIKE '%{X}%'` in among the `cmc IN (…)` alternatives for
   * exactly this reason, and the fake mirrors it — an AND would answer *nothing* here, since
   * no card is both mana value 0 and variable-cost, and the row would look like a filter that
   * had simply stopped working.
   */
  it("asks the mana chips and the X chip as one OR, never as an intersection", () => {
    const db = makeDb();
    const zeros = facets(db, { manaValues: [0] }).total;
    const xs = facets(db, { manaX: true }).total;

    // `Agadeem's Awakening` (`{X}{B}{B}{B}`, mana value 3) is the corpus' one paper `{X}`
    // printing, so the two sets cannot overlap and their union is exactly their sum.
    expect(xs).toBe(1);
    expect(zeros).toBeGreaterThan(0);
    expect(facets(db, { manaValues: [0], manaX: true }).total).toBe(zeros + xs);
  });

  /**
   * `base("mana")` drops the **whole** mana question — the numerals and X together — because
   * one OR group is one dimension. A base that dropped only `manaValues` would grey X out the
   * moment a numeral it has nothing to do with was pressed.
   */
  it("counts the X chip over the same base the numerals are counted over", () => {
    expect(facets(makeDb(), {}).manaX).toBe(1);
    expect(facets(makeDb(), { manaValues: [0] }).manaX).toBe(1);
    // A filter from another dimension does narrow it, which is the half that proves the count
    // is a count and not a constant.
    expect(facets(makeDb(), { format: "nonesuch" }).manaX).toBe(0);
  });

  it("counts the chips and the format select with their own filter removed", () => {
    const mana = facets(makeDb(), { manaValues: [1] });
    expect(mana.total).toBe(14);
    expect(mana.manaValues["2"]).toBe(5);

    const standard = facets(makeDb(), { format: "standard" });
    expect(standard.total).toBe(4);
    expect(standard.formats.modern).toBe(33);
  });

  it("empties the result on a format it has never heard of, but not the format select", () => {
    const f = facets(makeDb(), { format: "nonesuch" });
    expect(f.total).toBe(0);
    expect(f.sets.lea).toBe(0);
    // The way out stays open: greying every format at the one moment the reader needs to
    // pick a different one would strand them there.
    expect(f.formats.modern).toBe(33);
  });

  it("counts both sides of the owned cycle as if `owned` were not set", () => {
    const db = makeDb({ collectionEntries: [entry({ id: 1, cardId: BOLT.id })] });
    const f = facets(db, { owned: true });
    expect(f.total).toBe(1);
    expect(f.owned).toEqual({ owned: 1, missing: 49 });
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
    // **`manaX` is the one that cannot say "we did not count".** It is a scalar, so where the
    // maps have an absent key it has a `0` — and `0` is exactly what the greying rule reads as
    // "nothing in this search". `ready: false` is the whole of the guard, spent by
    // `facetsOrUndefined` before any chip sees this object.
    expect(cold.manaX).toBe(0);
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
    // **`oracleId` null means exactly one thing here: this entry is orphaned.** It is read off
    // `cards.oracle_id` and never denormalised onto the entry, and no live row is null (0 of
    // 116 590) — so it is the fact the card menu's "View all printings" reads to tell "this
    // printing has left the card database" from "the reader's copy is fine".
    expect(page.items[0].oracleId).toBeNull();
  });

  it("answers the oracle card behind a healthy row, which is what greys nothing", () => {
    const db = makeDb({ collectionEntries: [entry({ id: 1, cardId: BOLT.id })] });
    const page = readHandlers(db).collection_list({ query: { limit: 10, offset: 0 } });
    expect(page.items[0].oracleId).toBe(BOLT.oracleId);
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
      handlers.collection_list({ query: { marketplace, limit: 10, offset: 0 } }).items[0].unitPrice;

    expect(at("cardkingdom")).toBe(19.64);
    // Listed by one feed and not by the other: unpriced at Mana Pool, and never filled in from
    // Card Kingdom's row or from Scryfall's blob.
    expect(at("manapool")).toBeNull();
    // And the Scryfall-backed one is untouched by either.
    expect(at("tcgplayer")).toBe(17.85);
  });

  /**
   * **A deck row is a printing, so it is priced in whatever finish that printing is sold in.**
   *
   * The chain is `nonfoil → foil → etched` (`sorting::printing_price_by_finish_expr`), and the
   * case it exists for is the foil-only printing: `usd` is null on all 13 515 of them in the live
   * corpus, so a deck priced at a flat nonfoil rate drew an em dash on every Invocation, Secret
   * Lair and promo in it — beside a search wall quoting that same printing.
   *
   * Each marketplace keeps its own holes, because the chain is built out of the per-finish
   * expression rather than beside it: Card Kingdom quotes this printing because its feed carries
   * a foil row for it, and Mana Pool does not because it carries none.
   */
  it("prices a deck card in the finish the printing is sold in, at every marketplace", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: FOIL_ONLY.id, quantity: 1 })],
      marketplacePrices: [
        { marketplace: "cardkingdom", cardId: FOIL_ONLY.id, finish: "foil", price: 181.45 },
      ],
    });
    const at = (marketplace: MarketplaceId) =>
      readHandlers(db).deck_get({ id: 1, variant: "live", marketplace })!.cards[0].unitPrice;

    expect(at("tcgplayer")).toBe(164.95);
    expect(at("cardmarket")).toBe(149.75);
    expect(at("cardkingdom")).toBe(181.45);
    expect(at("manapool")).toBeNull();
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
 * Which printing stands for a collapsed row — `released_at DESC, price ASC NULLS LAST, id DESC`.
 *
 * **The corpus cannot show this and a fixture has to.** The rule only bites when two printings
 * share the newest release date, and none of `cards.ts`'s 36 paper groups does (measured
 * 2026-08-14); `large`'s synthetic corpus does, in 126 of its 686 groups, which is what makes the
 * change visible in the workbench. So every row here is cut from a real Bolt row with three
 * columns replaced, which keeps the other thirty the ingest's.
 *
 * The ids are named rather than uuid-shaped and are chosen so that **`id DESC` alone would pick
 * the wrong one in every case below** — otherwise the old rule would pass these too.
 */
describe("the collapsed row's representative", () => {
  /** One printing of the Bolt oracle card: its own id, release date and dollar price, and
   *  `oracleId` left alone so any set of these collapses into one group. */
  const printing = (id: string, releasedAt: string, usd: number | null): FakeCard => ({
    ...BOLT,
    id,
    releasedAt,
    priceUsd: usd,
    prices: JSON.stringify({ usd: usd === null ? null : usd.toFixed(2) }),
  });

  const repOf = (cards: FakeCard[], marketplace?: MarketplaceId) =>
    readHandlers(makeDb({ cards })).search_cards({
      req: { collapse: true, marketplace, limit: 10, offset: 0 },
    }).items[0];

  it("takes the cheapest printing of the newest release, and never an older cheaper one", () => {
    const row = repOf([
      printing("z-new-dear", "2024-04-08", 50),
      printing("a-new-cheap", "2024-04-08", 5),
      // Cheaper than either, and irrelevant: the date decides first, so a collapsed row always
      // stands for the card as it is printed now.
      printing("m-old-cheapest", "2019-01-01", 1),
    ]);
    expect(row.id).toBe("a-new-cheap");
    // The span is still every printing that matched, which is what keeps it wider than the
    // representative's own price.
    expect([row.priceLow, row.priceHigh]).toEqual([1, 50]);
    expect(row.printings).toBe(3);
  });

  /**
   * `null` is "this marketplace does not quote this printing", not "free".
   *
   * Sorted first it would make the cheapest-of-the-latest rule hand every row to the printing
   * nobody has a price for — the one thing the rule cannot be allowed to mean.
   */
  it("sorts an unpriced printing last, and falls back to the id when none is priced", () => {
    const unpriced = printing("z-new-null", "2024-04-08", null);
    expect(repOf([unpriced, printing("a-new", "2024-04-08", 9)]).id).toBe("a-new");
    // With nothing of that date priced there is no price to order by, and `id DESC` — the last
    // key, unchanged — is what still makes the pick total.
    expect(repOf([printing("a-new-null", "2024-04-08", null), unpriced]).id).toBe("z-new-null");
  });

  /**
   * The representative is picked at the marketplace the request named, from the same call the
   * span below it is built from — so the row cannot choose its printing at one marketplace and
   * quote its range at another.
   */
  it("picks at the marketplace the search named", () => {
    // `z-bolt` is what `id DESC` alone would take, and no marketplace below picks it — so each
    // assertion is one the old rule fails.
    const db = makeDb({
      cards: [
        printing("z-bolt", "2024-04-08", 50),
        printing("a-bolt", "2024-04-08", 5),
        printing("m-bolt", "2024-04-08", 20),
      ],
      marketplacePrices: [
        // Card Kingdom's order is its own: it makes the dearest of the three in dollars the
        // cheapest here, so the pick has to move with the parameter rather than with the blob.
        { marketplace: "cardkingdom", cardId: "z-bolt", finish: "nonfoil", price: 40 },
        { marketplace: "cardkingdom", cardId: "a-bolt", finish: "nonfoil", price: 30 },
        { marketplace: "cardkingdom", cardId: "m-bolt", finish: "nonfoil", price: 3 },
        // Mana Pool has never listed the other two at all — absent rows, not zeroes.
        { marketplace: "manapool", cardId: "m-bolt", finish: "nonfoil", price: 44 },
      ],
    });
    const at = (marketplace: MarketplaceId) =>
      readHandlers(db).search_cards({ req: { collapse: true, marketplace, limit: 10, offset: 0 } })
        .items[0];

    expect(at("tcgplayer").id).toBe("a-bolt");
    expect(at("cardkingdom").id).toBe("m-bolt");
    // The only printing this feed prices, so it represents the card *and* is the whole span —
    // the two read off one call, which is what stops them quoting different marketplaces.
    expect(at("manapool").id).toBe("m-bolt");
    expect([at("manapool").priceLow, at("manapool").priceHigh]).toEqual([44, 44]);
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

    /**
     * The first of the two keys with **no column to press** — added 2026-08-20 and reachable
     * only from the filter bar's sort picker, so nothing in the table can ask for this order
     * and a story that wants it is driving that control.
     *
     * `cards.cmc` is REAL and nullable and **no row of `CARDS` has a null one**, so the hole
     * is made rather than found, exactly as the type-line fixture above it is. Little Girl's
     * 0.5 is found, and is the fixture's own proof that the column is REAL rather than an
     * INTEGER: a cast would file her with the Forest.
     */
    it("keeps a missing mana value last in both directions", () => {
      const noCmc: FakeCard = { ...at("2x2", "117"), id: "no-mana-value", cmc: null };
      const db = makeDb({
        cards: [
          at("mb2", "502"), // Kozilek, Compleated — 10
          at("unf", "239"), // Forest — 0
          noCmc, // `2x2 117` with its cost taken away
          at("unh", "16"), // Little Girl — 0.5
          at("fut", "153"), // Tarmogoyf — 2
        ],
      });
      expect(setCodesFor(db, [{ key: "manaValue", dir: "asc" }])).toEqual([
        "unf",
        "unh",
        "fut",
        "mb2",
        "2x2",
      ]);
      // Reversed rows, not moved holes — the rule every nullable column in `SEARCH_SORTS`
      // states twice, and the whole reason this one is `nullsLast` and not `reversible`.
      expect(setCodesFor(db, [{ key: "manaValue", dir: "desc" }])).toEqual([
        "mb2",
        "fut",
        "unh",
        "unf",
        "2x2",
      ]);
    });

    /**
     * The other key with no column. `released_at` is ISO `YYYY-MM-DD`, so the byte order
     * {@link cmp} applies *is* date order — which is the claim worth pinning, because a
     * comparator that parsed the string first would agree with this on every row here and
     * disagree with SQLite the moment a corpus held a date it could not parse.
     *
     * Its hole cannot be storied: `FakeCard.releasedAt` is not nullable where
     * `cards.released_at` is (the fake says so at `toCardSummary`), so the both-directions
     * rule is carried by `nullsLast` and pinned above, on the one of the two whose fixture
     * column can hold a null.
     */
    it("orders `released` by the date and not by the order the rows arrived", () => {
      // Declared newest-first, so insertion order is a wrong answer this can catch.
      const db = makeDb({
        cards: [
          at("sld", "913"), // 2025-12-01 — the corpus's newest printing
          at("lea", "161"), // 1993-08-05 — its oldest
          at("pcy", "45"), // 2000-06-05
        ],
      });
      expect(setCodesFor(db, [{ key: "released", dir: "asc" }])).toEqual(["lea", "pcy", "sld"]);
      // Newest first, which is the direction the picker opens this key on and the one
      // `SEARCH_FIRST_DIR` gives it.
      expect(setCodesFor(db, [{ key: "released", dir: "desc" }])).toEqual(["sld", "pcy", "lea"]);
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
      // A key the table does not list is dropped rather than interpolated, so this spec is
      // empty and the browse order answers. **Synthetic on purpose**: this used to be
      // `released`, which stopped being an unknown key the day the filter bar's sort picker
      // gave it a control (2026-08-20). A hyphenated word is something no member of
      // `SEARCH_SORTS` can ever become — they are camelCase — so the next real key cannot
      // collide with it and quietly turn this assertion into its opposite.
      expect(
        setCodesFor(db, [
          { key: "not-a-sort-key", dir: "desc" },
        ] as unknown as SortSpec<SearchSortKey>),
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

/**
 * `card_image_uri`'s four answers: a URL, and the three ways to `null` that `card.rs` names —
 * every one of which the card menu's "Copy card image" has to treat as "copy nothing" rather
 * than as a failure.
 */
describe("one printing's image URL", () => {
  /** The corpus's one row with no picture on either side — `imageStatus: "missing"`, null in
   *  both URL columns, which is what `image_uris IS NULL` looks like from here. */
  const ARTLESS = CARDS.find((c) => c.artCropUrl === null && c.normalUrl === null)!;

  it("answers the display URL off the row, and the art crop for the art variant", () => {
    const reads = readHandlers(makeDb());
    expect(reads.card_image_uri({ cardId: BOLT.id, variant: "display" })).toBe(BOLT.normalUrl);
    expect(reads.card_image_uri({ cardId: BOLT.id, variant: "art" })).toBe(BOLT.artCropUrl);
    // Real Scryfall URLs off the generated corpus, never a path minted by rewriting one.
    expect(BOLT.normalUrl).toMatch(/^https:\/\/cards\.scryfall\.io\//);
  });

  it("answers null three ways, and every one of them is an answer", () => {
    const reads = readHandlers(makeDb());
    // 1. A printing this corpus does not have.
    expect(reads.card_image_uri({ cardId: "no-such-card", variant: "display" })).toBeNull();
    // 2. A row whose `image_uris` column is empty.
    expect(reads.card_image_uri({ cardId: ARTLESS.id, variant: "display" })).toBeNull();
    // 3. A variant the source lacked — `thumb` and `grid` on every row here, because the
    //    generator keeps `art_crop` and `normal` and nothing else.
    expect(reads.card_image_uri({ cardId: BOLT.id, variant: "thumb" })).toBeNull();
    expect(reads.card_image_uri({ cardId: BOLT.id, variant: "grid" })).toBeNull();
  });

  it("refuses a variant that is not one of the four, rather than answering null for it", () => {
    // The distinction the app depends on: `png` is a caller mistake and gets a rejection,
    // where a missing picture is an answer. In the crate the same check is what keeps an
    // unchecked string out of a `json_extract` path.
    expect(() =>
      readHandlers(makeDb()).card_image_uri({ cardId: BOLT.id, variant: "png" }),
    ).toThrow(/unknown image variant: png/);
  });

  it("answers null for every card under the imageUrisMissing fault", () => {
    const reads = readHandlers(makeDb({ fault: "imageUrisMissing" }));
    expect(reads.card_image_uri({ cardId: BOLT.id, variant: "display" })).toBeNull();
    expect(reads.card_image_uri({ cardId: BOLT.id, variant: "art" })).toBeNull();
    // The fault is the column being empty, not the corpus being gone: the card is still there.
    const detail = readHandlers(makeDb({ fault: "imageUrisMissing" })).card_detail({ id: BOLT.id });
    expect(detail?.name).toBe(BOLT.name);
  });
});

/**
 * The export's one command. It writes a file and touches no database, so there is nothing to
 * read back — what a story can observe is that it was accepted, or the sentence it was refused
 * with, which is exactly what `ExportDialog` can observe too.
 */
describe("writing an export", () => {
  it("accepts a path and contents, and is not refusable by a running sync", () => {
    // `busy` deliberately: this command takes no `AppState`, so a sync holding the write lock
    // cannot reach it. See the `unlocked` list in the busy-fault sweep.
    const w = writeHandlers(makeDb({ fault: "busy" }));
    expect(() =>
      w.export_write_file({ path: "C:\\decks\\removal.txt", contents: "1 Lightning Bolt\n" }),
    ).not.toThrow();
  });

  it("names the path it could not write, because that is the half the reader chose", () => {
    const w = writeHandlers(makeDb({ fault: "exportWriteError" }));
    expect(() => w.export_write_file({ path: "E:\\removal.txt", contents: "1 Shock\n" })).toThrow(
      /could not write E:\\removal\.txt/,
    );
  });
});

/**
 * The plain-text mirror's four commands — two stored settings, one derived report, and the one
 * fault that is a pass having already failed.
 *
 * There is no filesystem here, so what is asserted is the *model*: what the panel is told, what
 * the second press of Rebuild answers, and which of the crate's three root refusals a fake with
 * no disk can honestly make.
 */
describe("the plain-text mirror", () => {
  it("is on, beside the database, with no pass behind it", () => {
    const status = readHandlers(makeDb()).mirror_status();

    expect(status).toEqual({
      enabled: true,
      root: "D:\\Storybook\\data\\export",
      // All three null together: a pass's time, its report and its failure describe a folder
      // that may not survive a restart, so none of them is a stored setting.
      lastRunAt: null,
      lastReport: null,
      lastError: null,
    });
  });

  /** `settings::root`'s filter, which exists because a row this build did not write must not
   *  be able to point a pruning pass at a relative path. */
  it("reads a relative stored root as the default rather than following it", () => {
    for (const junk of ["export", "", "./export", "..\\export"]) {
      const db = makeDb();
      db.mirror.root = junk;
      expect(readHandlers(db).mirror_status().root).toBe("D:\\Storybook\\data\\export");
    }
  });

  it("stores an absolute root verbatim and answers it back", () => {
    const db = makeDb();
    writeHandlers(db).mirror_set_root({ root: "E:\\Backups\\MTG" });
    expect(readHandlers(db).mirror_status().root).toBe("E:\\Backups\\MTG");
    // A UNC share is absolute too, and is what a reader mirroring to a NAS picks.
    writeHandlers(db).mirror_set_root({ root: "\\\\nas\\cards" });
    expect(readHandlers(db).mirror_status().root).toBe("\\\\nas\\cards");
  });

  /** A refused write must leave the previous choice alone: the read discards junk silently, so
   *  a write that half-landed would look like a save and read back as the default. */
  it("refuses a relative root in words and keeps the one it had", () => {
    const db = makeDb();
    writeHandlers(db).mirror_set_root({ root: "E:\\Backups\\MTG" });

    expect(() => writeHandlers(db).mirror_set_root({ root: "export" })).toThrow(
      /not an absolute path/,
    );

    expect(readHandlers(db).mirror_status().root).toBe("E:\\Backups\\MTG");
  });

  it("switches off and on again", () => {
    const db = makeDb();
    writeHandlers(db).mirror_set_enabled({ enabled: false });
    expect(readHandlers(db).mirror_status().enabled).toBe(false);
    writeHandlers(db).mirror_set_enabled({ enabled: true });
    expect(readHandlers(db).mirror_status().enabled).toBe(true);
  });

  /**
   * **The second press is the interesting one.** A mirror that is already correct writes
   * nothing and reports every file unchanged, which is the hash-comparison the whole design
   * rests on — and a fake whose Rebuild answered the same numbers twice would show a reader a
   * button that cannot tell them anything.
   */
  it("writes everything once and reports it unchanged after that", () => {
    const db = makeDb();
    const first = writeHandlers(db).mirror_rebuild();

    expect(first.written).toBeGreaterThan(0);
    expect(first).toMatchObject({ unchanged: 0, skipped: 0, pruned: 0, failed: 0 });

    const second = writeHandlers(db).mirror_rebuild();
    expect(second).toEqual({
      written: 0,
      unchanged: first.written,
      skipped: 0,
      pruned: 0,
      failed: 0,
    });
  });

  /** Seven formats a thing, counted off the rows — never a constant, or the summary would be a
   *  caption on a fixture rather than a fact about the world beside it. */
  it("counts a pass off the rows it would write", () => {
    const empty = writeHandlers(makeDb()).mirror_rebuild().written;
    const withDeck = writeHandlers(
      makeDb({ decks: [deck({ id: 1, theoryEnabled: false })] }),
    ).mirror_rebuild().written;
    const withTheory = writeHandlers(
      makeDb({ decks: [deck({ id: 1, theoryEnabled: true })] }),
    ).mirror_rebuild().written;

    expect(withDeck - empty).toBe(7);
    // A theory list is a second set of seven, one directory down.
    expect(withTheory - withDeck).toBe(7);
  });

  /** It stamps the pass, which is what moves the panel's "Last written…" line. */
  it("records when it ran", () => {
    const db = makeDb();
    expect(readHandlers(db).mirror_status().lastRunAt).toBeNull();

    writeHandlers(db).mirror_rebuild();

    const at = readHandlers(db).mirror_status().lastRunAt;
    // A string, because the crate sends one: a JSON number is an `f64` on the other side.
    expect(typeof at).toBe("string");
    expect(Number(at)).toBeGreaterThan(1_700_000_000);
  });

  /** Unlocked, and deliberately: a pass holds the *read* connection, so a sync underneath it
   *  cannot refuse it. Asserted here as well as in the busy sweep because the sweep proves the
   *  name is on the exemption list and this proves the exemption is true. */
  it("rebuilds through a running sync", () => {
    expect(() => writeHandlers(makeDb({ fault: "busy" })).mirror_rebuild()).not.toThrow();
  });

  describe("the mirrorRootUnwritable fault", () => {
    const gone = () => {
      const db = makeDb({ fault: "mirrorRootUnwritable" });
      mirrorFailedPass(db);
      return db;
    };

    it("reports a pass that ran and could not write, with nothing pressed", () => {
      const status = readHandlers(gone()).mirror_status();

      expect(status.root).toBe("E:\\Backups\\MTG");
      expect(status.lastRunAt).not.toBeNull();
      expect(status.lastError).toMatch(/is not there/);
      // Nothing partial: the first `create_dir_all` is what fails, so every file is a failure
      // and none of them was written.
      expect(status.lastReport).toMatchObject({ written: 0, unchanged: 0 });
      expect(status.lastReport?.failed).toBeGreaterThan(0);
    });

    it("refuses a manual rebuild, naming the folder", () => {
      expect(() => writeHandlers(gone()).mirror_rebuild()).toThrow(/E:\\Backups\\MTG/);
    });

    /** The half that makes it a fault rather than a seed: pressing the button must not clear
     *  the error by succeeding into a folder that is not there. */
    it("leaves the failed pass on the world after a refused rebuild", () => {
      const db = gone();
      expect(() => writeHandlers(db).mirror_rebuild()).toThrow();
      expect(readHandlers(db).mirror_status().lastError).toMatch(/is not there/);
    });
  });
});

/**
 * The three Tauri **plugin** commands, which mirror no module in the crate and belong to neither
 * table above.
 *
 * They exist because the fake `invoke` is the whole IPC layer in Storybook, so a Copy, an Open on
 * or a Save as… reaches one of them or is answered `No fake handler registered` — a rejection
 * about the workbench, drawn in a `role="alert"` the app wrote about the reader's disk. The path
 * `save` builds is asserted here rather than only through the export dialog's story, because a
 * story that goes green on the wrong file name is a story about nothing.
 */
describe("the plugin commands", () => {
  it("builds the save path from the dialog's own defaultPath", () => {
    // The name really does travel: `ExportDialog` seeds `defaultPath` with
    // `${suggestedFileName}.${extension}`, so switching format changes the file this answers with,
    // exactly as it does in the window.
    const p = pluginHandlers();
    expect(p["plugin:dialog|save"]({ options: { defaultPath: "Ramp.txt" } })).toBe(
      "D:\\Storybook\\Ramp.txt",
    );
    expect(p["plugin:dialog|save"]({ options: { defaultPath: "Ramp.csv" } })).toBe(
      "D:\\Storybook\\Ramp.csv",
    );
  });

  it("still answers a path when the caller named no default", () => {
    // `save()` takes `options = {}`, so `defaultPath` really is optional on the wire. Answering
    // `undefined` here would put the literal string "undefined" through `export_write_file`.
    expect(pluginHandlers()["plugin:dialog|save"]({})).toBe("D:\\Storybook\\export.txt");
  });

  it("accepts a clipboard write and an opened URL, and stores neither", () => {
    const p = pluginHandlers();
    // `write_text` only — this app grants `clipboard-manager:allow-write-text` and never the
    // read, so there is no command a story could get the string back with and keeping it would
    // offer a check the app itself cannot make.
    expect(p["plugin:clipboard-manager|write_text"]()).toBeUndefined();
    expect(p["plugin:opener|open_url"]()).toBeUndefined();
  });

  it("is reachable through the dispatch table a story registers", async () => {
    // Through `invoke`, by the name and the argument name the plugin wrapper really sends —
    // `{ options }`, which is the half only a dispatcher can check.
    resetCommands();
    registerCommands(allHandlers(makeDb()));
    await expect(
      invoke<string>("plugin:dialog|save", { options: { defaultPath: "Sideboard.txt" } }),
    ).resolves.toBe("D:\\Storybook\\Sideboard.txt");
  });
});

/**
 * **Driven through the writes that record history, which is not all of them.** The five card
 * writes record none here — see `journalled`'s doc, and note that Storybook's history drawer has
 * never listed a card add either, so the two are consistent rather than one being broken. A
 * category rename is the smallest write that *does*, and it exercises the same wrapper.
 */
describe("undo and redo", () => {
  /** A step is recorded by the wrapper rather than by each handler, so a new deck write is
   *  covered by construction rather than by somebody remembering. */
  it("records a step for a deck write and puts the write back", () => {
    const db = makeDeckDb({ decks: [deck()] });
    const h = allHandlers(db);
    const made = h.deck_category_create({ deckId: 1, name: "Ramp" });
    h.deck_category_rename({ id: made.id, name: "Acceleration" });
    expect(db.deckCategories.find((c) => c.id === made.id)?.name).toBe("Acceleration");

    const state = h.deck_undo_state({ deckId: 1, redoId: null });
    expect(state.undo).not.toBeNull();
    h.deck_undo_apply({ deckId: 1, auditId: state.undo!.id });

    expect(db.deckCategories.find((c) => c.id === made.id)?.name).toBe("Ramp");
  });

  /** And forward again — the *after* half of the step, which is what redo is. */
  it("puts it back again on redo", () => {
    const db = makeDeckDb({ decks: [deck()] });
    const h = allHandlers(db);
    const made = h.deck_category_create({ deckId: 1, name: "Ramp" });
    h.deck_category_rename({ id: made.id, name: "Acceleration" });
    const undoId = h.deck_undo_state({ deckId: 1, redoId: null }).undo!.id;
    h.deck_undo_apply({ deckId: 1, auditId: undoId });

    // The state command answers the redo half **only for the id the caller hands in**, because
    // the redo stack lives in the webview and dies with the window.
    expect(h.deck_undo_state({ deckId: 1, redoId: null }).redo).toBeNull();
    expect(h.deck_undo_state({ deckId: 1, redoId: undoId }).redo).not.toBeNull();

    h.deck_redo_apply({ deckId: 1, auditId: undoId });
    expect(db.deckCategories.find((c) => c.id === made.id)?.name).toBe("Acceleration");
  });

  /**
   * **The stack stays linear**, which is what makes Ctrl+Z twice go back two changes rather
   * than toggling one: an undo is a deck write and belongs in the history, but it records no
   * step of its own, so the cursor walks straight past it.
   */
  it("writes history for the undo itself and does not make it undoable", () => {
    const db = makeDeckDb({ decks: [deck()] });
    const h = allHandlers(db);
    const made = h.deck_category_create({ deckId: 1, name: "Ramp" });
    const first = h.deck_undo_state({ deckId: 1, redoId: null }).undo!.id;
    h.deck_category_rename({ id: made.id, name: "Acceleration" });
    const second = h.deck_undo_state({ deckId: 1, redoId: null }).undo!.id;
    expect(second).not.toBe(first);

    h.deck_undo_apply({ deckId: 1, auditId: second });

    const newest = db.deckAudit[db.deckAudit.length - 1];
    expect(JSON.parse(newest.payload)).toEqual({ field: "undo", of: second });
    expect(db.deckUndo.some((s) => s.auditId === newest.id)).toBe(false);
    expect(h.deck_undo_state({ deckId: 1, redoId: null }).undo!.id).toBe(first);
  });

  /** The toolbar can be a moment behind the deck, so the id is checked rather than trusted. */
  it("refuses an id that is not the cursor", () => {
    const db = makeDeckDb({ decks: [deck()] });
    const h = allHandlers(db);
    const made = h.deck_category_create({ deckId: 1, name: "Ramp" });
    const stale = h.deck_undo_state({ deckId: 1, redoId: null }).undo!.id;
    h.deck_category_rename({ id: made.id, name: "Acceleration" });

    expect(() => h.deck_undo_apply({ deckId: 1, auditId: stale })).toThrow(/edited since/);
  });

  /** A write that changed nothing wrote no history row, so it files no step — a Ctrl+Z that
   *  appears to do nothing is worse than one that says there is nothing left. */
  it("files no step for a write that recorded no history", () => {
    const db = makeDeckDb({ decks: [deck({ name: "Burn" })] });
    const h = allHandlers(db);

    h.deck_update({ id: 1, patch: { name: "Burn" } });

    expect(db.deckUndo).toHaveLength(0);
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
 * `card_meld_parts`, the read behind the card pane's orientation control.
 *
 * **Three of the four cases here are `[]`, and that is the command rather than a gap in the
 * fixture**: 72 of the live corpus's 116 590 rows are `meld`, so every other layout, every
 * unknown id and every `meld` row whose blob carried no `all_parts` answers empty. It must
 * never reject — a card the reader opened has to open.
 *
 * The corpus carries the whole triangle (`Bruna` `emn 15`, `Gisela` `emn 28`, `Brisela`
 * `emn 15b`), so both directions are reachable: a half naming its result, and the result naming
 * its two halves. What is *not* obvious and is the reason the exclusion is by **name**: a meld
 * row's `all_parts` lists the row's own card too, and can list it under a different printing's
 * id — so an id test would leave the open card among its own relatives.
 */
describe("a meld card's other halves", () => {
  const meldParts = (id: string) => readHandlers(makeDb()).card_meld_parts({ id });
  const named = (name: string, set: string) =>
    CARDS.find((c) => c.name === name && c.setCode === set)!;

  it("names the result and the other half from a meld part, and never the card itself", () => {
    const bruna = named("Bruna, the Fading Light", "emn");
    expect(meldParts(bruna.id)).toEqual([
      {
        id: named("Brisela, Voice of Nightmares", "emn").id,
        name: "Brisela, Voice of Nightmares",
        component: "meld_result",
        artist: "Clint Cearley",
      },
      {
        id: named("Gisela, the Broken Blade", "emn").id,
        name: "Gisela, the Broken Blade",
        component: "meld_part",
        artist: "Clint Cearley",
      },
    ]);
  });

  it("names both halves from the meld result, in Scryfall's own order", () => {
    const brisela = named("Brisela, Voice of Nightmares", "emn");
    expect(meldParts(brisela.id).map((p) => [p.name, p.component])).toEqual([
      ["Bruna, the Fading Light", "meld_part"],
      ["Gisela, the Broken Blade", "meld_part"],
    ]);
    // Every id resolves to a row this fixture holds, which is what lets the pane *open* one.
    for (const part of meldParts(brisela.id)) {
      expect(CARDS.some((c) => c.id === part.id)).toBe(true);
    }
  });

  it("drops the set's checklist card, which `all_parts` carries beside the meld rows", () => {
    // `Gisela`'s blob lists four relatives; the `combo_piece` "Eldritch Moon Checklist" is not
    // one of the cards this melds with and would be an orientation control that opens a leaflet.
    const gisela = named("Gisela, the Broken Blade", "emn");
    expect(meldParts(gisela.id).map((p) => p.name)).toEqual([
      "Brisela, Voice of Nightmares",
      "Bruna, the Fading Light",
    ]);
  });

  it("answers an empty list for another layout and for an id no row has, and never throws", () => {
    // `split` — the layout beside `meld` in the fixture's layout zoo, and the one a reader is
    // most likely to have open when the pane asks.
    expect(meldParts(named("Fire // Ice", "apc").id)).toEqual([]);
    expect(meldParts(named("Lightning Bolt", "lea").id)).toEqual([]);
    expect(meldParts("no-such-card")).toEqual([]);
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

describe("what a deck owns", () => {
  it("counts every printing of the oracle card in its group — a Bolt is a Bolt", () => {
    const db = makeDeckDb({
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, quantity: 1, folderId: groupId(1) }),
        entry({ id: 2, cardId: BOLT_2X2.id, quantity: 3, folderId: groupId(1) }),
      ],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT_2X2.id, categoryKind: "main", quantity: 4 })],
    });
    // Four owned off two printings: the deck lists one of them and holds both, and the read is
    // oracle-grained. The old allocator preferred the exact printing and this has no preference
    // to express — it is a sum over the folder.
    expect(liveDeck(db)!.cards[0].ownedQuantity).toBe(4);
  });

  it("gives the commander its copy before the main deck gets one", () => {
    const solRing = CARDS.filter((c) => c.name === "Sol Ring")[0];
    const db = makeDeckDb({
      collectionEntries: [
        entry({ id: 1, cardId: solRing.id, quantity: 1, folderId: groupId(1) }),
      ],
      decks: [deck({ id: 1, formatKey: "commander" })],
      deckCards: [
        // The main-deck row is first by id; the commander's category sorts ahead of it, and
        // attribution walks the read's own order.
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
   * A plan reserves nothing. The group is not scoped to a variant — the copies really are in the
   * deck's folder whichever list is being read — so this is a rule `attributeOwned` draws by hand
   * rather than one a table's shape draws for it. The `deck.rs` test of the same name is the
   * other half.
   */
  it("attributes nothing to the theory variant", () => {
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 4, folderId: groupId(1) })],
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, variant: "theory", categoryKind: "main", quantity: 4 }),
      ],
    });
    const theory = readHandlers(db).deck_get({ id: 1, variant: "theory" })!;
    expect(theory.cards).toHaveLength(1);
    expect(theory.cards[0].ownedQuantity).toBe(0);
    // Same printing, same category, in the live deck: that one is attributed the copies.
    db.deckCards.push(deckCard({ id: 2, cardId: BOLT.id, categoryKind: "main", quantity: 4 }));
    expect(liveDeck(db)!.cards[0].ownedQuantity).toBe(4);
  });

  /**
   * The filter is `isActive` and not a kind, and this category is a `main` one the user switched
   * **off**. Any implementation still asking "is this the maybe pile?" answers 4 here.
   */
  it("attributes nothing to a main category the user switched off", () => {
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 4, folderId: groupId(1) })],
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

  /**
   * Exclusivity, and the whole reason `decks.is_built` could be deleted: a copy in deck 1's
   * group is *physically* in deck 1, so deck 2 reads 0 without anything having to decide which
   * of them the copy is reserved for. There is no split to get right, no built flag to consult,
   * and no way for the two answers to add up to more than the collection holds.
   */
  it("does not see a copy sitting in another deck's group", () => {
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 1, folderId: groupId(1) })],
      decks: [deck({ id: 1 }), deck({ id: 2 })],
      deckCards: [
        deckCard({ id: 1, deckId: 1, cardId: BOLT.id, quantity: 1 }),
        deckCard({ id: 2, deckId: 2, cardId: BOLT.id, quantity: 1 }),
      ],
    });
    expect(liveDeck(db, 1)!.cards[0].ownedQuantity).toBe(1);
    expect(liveDeck(db, 2)!.cards[0].ownedQuantity).toBe(0);
  });

  it("clamps at the row's own quantity, so a deck holding more than it lists reads its list", () => {
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 4, folderId: groupId(1) })],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT.id, quantity: 2 })],
    });
    expect(liveDeck(db)!.cards[0].ownedQuantity).toBe(2);
  });

  it("reads 0 for a deck with no group at all", () => {
    // Unreachable through the app — every deck gets one — and the honest answer for a store
    // that has been edited by hand.
    const db = makeDeckDb({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 4 })],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT.id, quantity: 4 })],
    });
    db.collectionFolders = [];
    expect(liveDeck(db)!.cards[0].ownedQuantity).toBe(0);
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
      readHandlers(db).deck_get({ id: 1, variant: "theory" })!.categories[2].cardCountAllVariants,
    ).toBe(9);
    // No label has been made, so the palette is empty — and it is a list, not a null.
    expect(detail.labels).toEqual([]);
  });

  /**
   * A label's `cardCount` is scoped to the variant asked for, exactly as a category's is.
   *
   * They are answered by one read and describe one list of cards, so scoping one and not the
   * other is a read that contradicts itself — which is what the Rust did once: `get_deck`
   * threaded its variant into `list_categories` and not into `list_labels`, so a Theory read
   * came back with Theory category counts beside Live label counts.
   */
  it("counts a label over the variant that was asked for, like a category", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckLabels: [{ id: 1, name: "Flex", color: "amber" }],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 3, labelId: 1 }),
        deckCard({
          id: 2,
          cardId: BOLT.id,
          categoryKind: "main",
          variant: "theory",
          quantity: 7,
          labelId: 1,
        }),
      ],
    });

    expect(liveDeck(db)!.labels).toEqual([{ id: 1, name: "Flex", color: "amber", cardCount: 3 }]);
    expect(readHandlers(db).deck_get({ id: 1, variant: "theory" })!.labels[0].cardCount).toBe(7);
  });

  it("prices a deck card in the finish it is sold in, and leaves the piles beside the deck out of its size", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 3 }),
        deckCard({ id: 2, cardId: BOLT.id, categoryKind: "side", quantity: 2 }),
        deckCard({ id: 3, cardId: BOLT.id, categoryKind: "commander", quantity: 1 }),
        deckCard({ id: 4, cardId: BOLT.id, categoryKind: "companion", quantity: 1 }),
        deckCard({ id: 5, cardId: FOIL_ONLY.id, categoryKind: "main", quantity: 1 }),
      ],
    });
    const detail = liveDeck(db)!;
    // `lea 161`'s blob is `usd` 620.00 with both foil keys null: the chain starts at nonfoil
    // and stops there whenever there is one.
    expect(detail.cards.find((c) => c.cardId === BOLT.id)!.unitPrice).toBe(620);
    // The Invocation exists only in foil, so its `usd` is null and its `usd_foil` is not — the
    // whole of the bug this chain fixed. A deck names a printing, and this printing costs
    // $164.95.
    expect(detail.cards.find((c) => c.cardId === FOIL_ONLY.id)!.unitPrice).toBe(164.95);
    // CR 100.4a for the sideboard, EDH's "effectively a 101st card" for the companion.
    expect(detail.deck.cardCount).toBe(5);
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
    // 38 distinct set codes over the 52 fixture rows, measured 2026-08-22.
    expect(sets).toHaveLength(38);
    // `vma` holds one fixture row and it is digital, so the picker offers a 0 — the state
    // the real `list_sets` reaches through its `FILTER (WHERE is_paper = 1)`.
    expect(sets.find((s) => s.code === "vma")!.cardCount).toBe(0);
    const dates = sets.map((s) => s.releasedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("reports the fixture's own card count and the faults the sync surfaces", () => {
    expect(readHandlers(makeDb()).sync_status()).toMatchObject({
      cardCount: 52,
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

/**
 * **Zero used to mean three different things and now means one**, which is the reversal schema
 * v24 landed and the reason this block was rewritten rather than deleted.
 *
 * The collection was the outlier: a stepper taken to zero *kept* the row, on the argument that
 * the row still held a condition, a purchase price and an acquisition story worth preserving. It
 * deletes now, siding with the wishlist and the deck — a collection is what somebody *has*, a row
 * saying the reader has none of a printing says nothing, and every list, count and total in the
 * app carried a special case to describe it. What survives of the old asymmetry is exactly one
 * place: an **edit form** applies a zero like any other value and keeps the row, because nothing
 * typed into a number field beside seven others should delete the row being edited.
 */
describe("zero, and the one place it still keeps a row", () => {
  it("removes the collection row and says removed: true", () => {
    const db = makeDb({ collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 3 })] });
    const change = writeHandlers(db).collection_set_quantity({ id: 1, quantity: 0 });
    expect(change).toMatchObject({ quantity: 0, removed: true });
    expect(db.collectionEntries).toHaveLength(0);
    // Still not `collection_remove`, which is the **unconditional** delete: an adjustment to a
    // row that is not there could not do what it was asked, so a second press is a refusal
    // rather than a second success.
    expect(() => writeHandlers(db).collection_set_quantity({ id: 1, quantity: 0 })).toThrow(
      /not there any more/,
    );
  });

  /**
   * **What the reversal costs, written down rather than left to be discovered.**
   *
   * This test asserted the opposite until schema v24 — the emptied row survived with its
   * condition, its purchase price and its tags — and that preservation *was* the argument for
   * the old rule. The rule was reversed anyway, so the cost is real and this is where it is
   * recorded: a zero takes the row's `condition` and `conditionOriginal`, the purchase price and
   * currency, `acquiredAt`, the acquisition source, the notes and the tags with it. A reader who
   * trades a playset away and buys it back next year retypes every one of them.
   *
   * Asserted as the whole array rather than field by field, because the claim is that *nothing*
   * is left — a `toMatchObject` against a row that is gone would fail for the right reason by
   * accident, and one against `[0]` would throw rather than assert.
   */
  it("takes the condition, the price paid, the provenance and the tags with it", () => {
    const db = makeDb({
      collectionEntries: [
        entry({
          id: 1,
          quantity: 3,
          condition: "LP",
          conditionOriginal: "lightly played",
          purchasePrice: 12,
          purchaseCurrency: "USD",
          acquiredAt: "2024-01-05",
          acquisitionSource: "the LGS",
          notes: "the good one",
          tags: '["cube"]',
        }),
      ],
    });
    writeHandlers(db).collection_set_quantity({ id: 1, quantity: 0 });
    expect(db.collectionEntries).toEqual([]);
  });

  it("keeps the row an edit form takes to zero, with all of that still on it", () => {
    const db = makeDb({
      collectionEntries: [
        entry({ id: 1, quantity: 3, condition: "LP", purchasePrice: 12, tags: '["cube"]' }),
      ],
    });
    const change = writeHandlers(db).collection_update({ id: 1, patch: { quantity: 0 } });
    expect(change).toMatchObject({ quantity: 0, removed: false });
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

  it("removes the deck row, which all three tables now agree on", () => {
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

  /**
   * **Adding into a folder is an *add*, and the eleventh grain term is what makes it one.**
   *
   * `folderId` was hard-coded to the root in this fake for as long as `EntryInput` had no such
   * field, so every "Add to → Collection → <binder>" landed unfiled, folded into whatever was
   * already at the root and reported success. Nothing threw and nothing logged — the fake being
   * *kinder* than the app about the one press this whole cabinet exists for, which is the
   * direction of drift that lets a story document a state the reader can never reach.
   *
   * Two rows for one printing at one finish, condition and language is the whole assertion; the
   * second half is that a *second* add into the same folder still folds, so the term narrows the
   * grain rather than disabling the fold.
   */
  it("makes the same printing filed in a folder a second row, and still folds inside it", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    const binder = w.collection_folder_create({ parentId: null, name: "Binder" });

    const atRoot = w.collection_add(add({ quantity: 2 }));
    const filed = w.collection_add(add({ quantity: 3, folderId: binder.id }));

    expect(filed.id).not.toBe(atRoot.id);
    // The column is written rather than defaulted to the root, and none of the root's copies
    // came with it.
    expect(db.collectionEntries.map((e) => [e.id, e.folderId, e.quantity])).toEqual([
      [atRoot.id, null, 2],
      [filed.id, binder.id, 3],
    ]);

    // The same press again is "one more of these", which is what the fold is for.
    expect(w.collection_add(add({ quantity: 1, folderId: binder.id }))).toMatchObject({
      id: filed.id,
      quantity: 4,
    });
    expect(db.collectionEntries).toHaveLength(2);

    // A folder that is not there is a sentence rather than a foreign-key failure, and the
    // refused add writes nothing.
    expect(() => w.collection_add(add({ folderId: 404 }))).toThrow(/not there any more/);
    expect(db.collectionEntries).toHaveLength(2);
  });

  /**
   * **The add is fenced on the folder's *kind* as well as on its existence**, which this fake was
   * missing for a day. `collection::folder_named` answers `FOLDER_NOT_YOURS` for a `deck` folder
   * or `Recently removed`, in `collection_folders`' own wording and exactly as
   * `collection_set_folder` does — so an `Add to → Collection → <a deck's group>` succeeded here
   * and was refused in the window, which is the direction of drift a fake must never take.
   *
   * The menu offers `kind === "user"` and nothing else and no build creates a `deck` folder yet,
   * so the fixture seeds one by hand: that is the only way to exercise the branch at all, and
   * saying so is better than a test that passes because the state is unreachable.
   */
  it("refuses an add into a folder the app owns, and still takes the reader's own", () => {
    const db = makeDb({
      collectionFolders: [
        { id: 1, parentId: null, name: "Binder", kind: "user", deckId: null, sortOrder: 0 },
        { id: 2, parentId: null, name: "Burn", kind: "deck", deckId: 7, sortOrder: 1 },
      ],
    });
    const w = writeHandlers(db);

    expect(() => w.collection_add(add({ folderId: 2 }))).toThrow(/the app's own/);
    expect(db.collectionEntries).toHaveLength(0);

    // And the reader's own drawer is untouched by the fence — the two halves are one question
    // asked in one order, gone before not-yours.
    expect(w.collection_add(add({ quantity: 1, folderId: 1 }))).toMatchObject({ quantity: 1 });
    expect(db.collectionEntries).toHaveLength(1);
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

  /**
   * **An edit that lands on a grain the collection already holds folds into it.**
   *
   * This asserted a refusal until schema v24 — "You already have an entry for that printing at
   * that finish and condition — change its quantity instead" — which named the way out and then
   * left the reader to walk it. It was already the odd one out: `collection_set_folder` merges
   * when a card is filed into a folder that holds its printing, and the wishlist's two grain
   * writes have merged since v23. An edit is the same fact from the third side — the reader has
   * said these two rows are one row — so it is answered the same way, and the sentence is deleted
   * rather than left standing beside a state nothing can reach.
   *
   * **The answer names a row the caller did not pass in**, which is the half a table has to
   * follow: the row the reader was editing is gone. The patch carries a non-grain field as well,
   * so this also pins the ordering — the crate applies the patch's non-grain half to the source
   * *before* the fold, which is why the quantity that folds is the one the reader typed rather
   * than the one the row had, and why the note survives the row it was typed onto.
   */
  it("folds an edit that lands on an occupied grain into the row already there", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    const nonfoil = w.collection_add(add());
    const foil = w.collection_add(add({ finish: "foil" }));

    const change = w.collection_update({
      id: nonfoil.id,
      patch: { finish: "foil", quantity: 4, notes: "the good one" },
    });

    expect(change.id).toBe(foil.id);
    expect(change).toMatchObject({ quantity: 5, removed: false });
    expect(db.collectionEntries).toHaveLength(1);
    // The survivor had no note of its own, so it takes the folded row's — `foldEntry`'s
    // coalesce, and the proof that the non-grain half landed before the source went.
    expect(db.collectionEntries[0]).toMatchObject({ id: foil.id, notes: "the good one" });
  });

  it("has three doors out now, and only collection_remove is unconditional", () => {
    const db = makeDb({ collectionEntries: [entry({ id: 1, quantity: 0 })] });
    expect(writeHandlers(db).collection_remove({ id: 1 })).toMatchObject({ removed: true });
    expect(db.collectionEntries).toHaveLength(0);
    // A stale id is a success here and a refusal at the other two: a delete that finds nothing
    // already has what it wanted, where an adjustment to a row that is not there could not do
    // what it was asked.
    expect(writeHandlers(db).collection_remove({ id: 1 }).removed).toBe(true);
    expect(() => writeHandlers(db).collection_set_quantity({ id: 1, quantity: 0 })).toThrow(
      /not there any more/,
    );
    expect(() => writeHandlers(db).collection_update({ id: 1, patch: { quantity: 1 } })).toThrow(
      /not there any more/,
    );
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

/**
 * The filing cabinet, and it is the **refusals** that earn this block rather than the writes.
 *
 * A fake that accepted a cycle would let a story draw a tree the app refuses to make, and the
 * story would then document a lie — which is worse than no story, because it is a claim about
 * the app made in the app's own drawing. Same for a merge that failed instead: the reader would
 * meet a `UNIQUE constraint failed` in the workbench and never in the window.
 */
describe("the wishlist's folders", () => {
  /** A wishlist with `Ordered` and `Backordered` inside it, and nothing filed yet. */
  function filing(over: Partial<FakeDb> = {}): FakeDb {
    return makeDb({
      wishlistFolders: [
        { id: 1, parentId: null, name: "Ordered", sortOrder: 0 },
        { id: 2, parentId: 1, name: "Backordered", sortOrder: 0 },
      ],
      ...over,
    });
  }

  it("files a new folder among its siblings and refuses a blank name", () => {
    const db = filing();
    const w = writeHandlers(db);
    const inner = w.wishlist_folder_create({ parentId: 1, name: "  Paid for  " });
    // Trimmed, and `max + 1` **among siblings** — so the second child of `Ordered` is 1 while
    // the root's own numbering is untouched.
    expect(inner).toMatchObject({ parentId: 1, name: "Paid for", sortOrder: 1 });
    expect(w.wishlist_folder_create({ parentId: null, name: "Someday" }).sortOrder).toBe(1);

    expect(() => w.wishlist_folder_create({ parentId: null, name: "   " })).toThrow(
      /A folder needs a name\./,
    );
    expect(() => w.wishlist_folder_rename({ id: 1, name: " " })).toThrow(/A folder needs a name\./);
    expect(db.wishlistFolders.find((f) => f.id === 1)!.name).toBe("Ordered");
  });

  /**
   * What `wishlist_folder_list` **answers**, which nothing else here asks it.
   *
   * The create test above pins what goes *into* `sortOrder`; this pins what comes back out of
   * it, and the two are different claims. `ORDER BY sort_order, id` is the reader's own
   * arrangement — the folder tree is one of `sortOptions`' two exemptions, the "the reader
   * arranged it themselves" one — so a store that answered in insertion order would draw every
   * wall of folder cards in the order they were made and look entirely plausible doing it.
   *
   * The fixture is built so that all three ways of getting this wrong show:
   * `sortOrder` ignored (insertion order), the `id` tie-break dropped (a stable sort then keeps
   * insertion order among the two zeroes), and the comparison reversed. It is also **out of id
   * order on purpose** — birth order and filing order are two different things, and a reader who
   * has dragged their folders about is exactly how the two come apart.
   */
  it("answers every folder flat, in `sortOrder, id` rather than in the order they were made", () => {
    const db = makeDb({
      wishlistFolders: [
        { id: 3, parentId: null, name: "Someday", sortOrder: 0 },
        { id: 1, parentId: null, name: "Ordered", sortOrder: 0 },
        { id: 2, parentId: 1, name: "Backordered", sortOrder: 1 },
      ],
    });
    // `Backordered` is in the answer despite being nobody's sibling on screen: the list is flat
    // and unscoped, and building the tree from `parentId` is `folderTree.ts`'s job.
    expect(readHandlers(db).wishlist_folder_list()).toEqual([
      { id: 1, parentId: null, name: "Ordered", sortOrder: 0 },
      { id: 3, parentId: null, name: "Someday", sortOrder: 0 },
      { id: 2, parentId: 1, name: "Backordered", sortOrder: 1 },
    ]);
  });

  it("refuses a cycle, a move into itself, and a loop it did not write", () => {
    const db = filing();
    const w = writeHandlers(db);
    // `Ordered` under its own child.
    expect(() => w.wishlist_folder_move({ id: 1, parentId: 2 })).toThrow(/inside itself/);
    expect(() => w.wishlist_folder_move({ id: 1, parentId: 1 })).toThrow(/inside itself/);
    expect(db.wishlistFolders.find((f) => f.id === 1)!.parentId).toBeNull();

    // A loop written straight into the store, between two folders neither of which is the one
    // being moved — so the `cursor === id` arm never fires and only the hop budget ends the
    // climb. A fake with no budget hangs the tab here rather than failing.
    db.wishlistFolders[0].parentId = 2;
    const moving = w.wishlist_folder_create({ parentId: null, name: "Someday" });
    expect(() => w.wishlist_folder_move({ id: moving.id, parentId: 1 })).toThrow(/inside itself/);
    expect(db.wishlistFolders.find((f) => f.id === moving.id)!.parentId).toBeNull();
  });

  /**
   * The destination, which the cycle walk above cannot check for it and does not.
   *
   * `wishlist_folder_create` refuses a parent that is gone, because `wishlist_folders.parent_id`
   * is a real foreign key and SQLite refuses one in the app. `wishlist_folder_move` writes the
   * **same column** and so has to refuse the same thing, or the pair disagree — the fake would
   * write a sub-tree hanging off nothing, and a story would then draw a folder that cannot
   * exist.
   *
   * The walk is no substitute: `wishFolderById(db, cursor)?.parentId ?? null` reads an id no
   * folder has as "already at the root" and ends the climb on the first hop, so an unchecked
   * move sails straight through it.
   *
   * **This test was ahead of the crate and the crate was brought to it** (2026-08-22). Rust's
   * `move_folder` had the identical hole — `optional()?.flatten()` reads a missing id as the
   * root, exactly as the walk here does — so the `UPDATE` ran and answered
   * `FOREIGN KEY constraint failed`, a sentence about a constraint rather than about the folder,
   * and only while `PRAGMA foreign_keys` was on. It looks the id up and answers `FOLDER_GONE`
   * now, which is what this had been asserting all along.
   */
  it("refuses a parent that is gone, the fence `wishlist_folder_create` already has", () => {
    const db = filing();
    const w = writeHandlers(db);
    expect(() => w.wishlist_folder_move({ id: 2, parentId: 404 })).toThrow(/not there any more/);
    // Nothing moved: a refusal that had already written the column would be worse than none.
    expect(db.wishlistFolders.find((f) => f.id === 2)!.parentId).toBe(1);
    // `null` is the root and is always a destination — the one parent there is no row to find.
    w.wishlist_folder_move({ id: 2, parentId: null });
    expect(db.wishlistFolders.find((f) => f.id === 2)!.parentId).toBeNull();
  });

  /**
   * **The second wish is pinned to `BOLT_2X2` rather than made from its oracle id**, and the
   * change is not cosmetic: `BOLT_2X2` is *a different printing of the same card*, so
   * `BOLT_2X2.oracleId === BOLT.oracleId` and two any-printing wishes for it are one
   * {@link wishGrain}. This fixture was therefore an unlabelled instance of the collision the
   * two tests below are about — the old bare-loop un-filing wrote both rows at the root and
   * this passed, while the app answered `UNIQUE constraint failed` and deleted nothing.
   * Pinning the printing puts the two wishes on genuinely different grains, which is what this
   * test meant by "both wishes are still on the list".
   */
  it("takes the sub-folders and leaves the wishes standing at the root", () => {
    const db = filing({
      wishlistEntries: [
        wish({ id: 1, oracleId: BOLT.oracleId, folderId: 1 }),
        wish({ id: 2, cardId: BOLT_2X2.id, folderId: 2 }),
      ],
    });
    writeHandlers(db).wishlist_folder_delete({ id: 1 });
    expect(db.wishlistFolders).toHaveLength(0);
    // The two cascades pointing opposite ways: the cabinet and its drawer are gone, and both
    // wishes are still on the list.
    expect(db.wishlistEntries.map((x) => x.folderId)).toEqual([null, null]);
    // An id that resolves to nothing is a success: the caller wanted it gone and it is.
    expect(() => writeHandlers(db).wishlist_folder_delete({ id: 404 })).not.toThrow();
  });

  /**
   * The delete **merges**, and the two shapes that make it have to.
   *
   * Un-filing a sub-tree rewrites the fourth term of {@link wishGrain} on every wish in it, so a
   * press that files two wishes at the root for the same card lands twice on one grain. Both
   * shapes are reachable in the shipped app:
   *
   * - a **root** wish plus the same card filed in the folder, which the design accepts on
   *   purpose — the three writers that add at the root cannot name a folder, so a card the
   *   reader has filed acquires a second root row;
   * - two wishes in **sibling sub-folders**, colliding with each other with no root row in play.
   *
   * A bare loop over the rows produced both here while the app answered `UNIQUE constraint
   * failed: index 'idx_wishlist_grain'` and deleted nothing at all — the fake kinder than the
   * app, which is the drift that lets a story document a state the reader cannot reach. Both
   * assertions fail on that loop, the first on the quantity and the second on the length.
   */
  it("merges a wish it un-files onto the root row already holding that card", () => {
    const db = filing({
      wishlistEntries: [
        wish({ id: 1, oracleId: BOLT.oracleId, quantity: 1, folderId: null }),
        wish({ id: 2, oracleId: BOLT.oracleId, quantity: 2, folderId: 1, notes: "ordered" }),
      ],
    });
    writeHandlers(db).wishlist_folder_delete({ id: 1 });
    expect(db.wishlistFolders).toHaveLength(0);
    // One wish at the root for all three copies, wearing the filed row's note — the survivor
    // had none, and `mergeWishOnto` falls back to the row it folds in.
    expect(db.wishlistEntries).toEqual([
      expect.objectContaining({ id: 1, folderId: null, quantity: 3, notes: "ordered" }),
    ]);
  });

  it("merges two sub-folder wishes that collide with each other at the root", () => {
    const db = makeDb({
      wishlistFolders: [
        { id: 1, parentId: null, name: "Top", sortOrder: 0 },
        { id: 2, parentId: 1, name: "A", sortOrder: 0 },
        { id: 3, parentId: 1, name: "B", sortOrder: 1 },
      ],
      wishlistEntries: [
        wish({ id: 1, oracleId: BOLT.oracleId, quantity: 2, folderId: 2 }),
        wish({ id: 2, oracleId: BOLT.oracleId, quantity: 5, folderId: 3 }),
        // A card only one of them holds, so the merge is shown to be about the grain rather
        // than about "everything in a deleted folder becomes one row".
        wish({ id: 3, cardId: BOLT_2X2.id, quantity: 1, folderId: 3 }),
      ],
    });
    writeHandlers(db).wishlist_folder_delete({ id: 1 });
    expect(db.wishlistFolders).toHaveLength(0);
    // Lowest id first, so the row that survives is a fact about the store and not about
    // iteration order — the crate collects its sub-tree with `ORDER BY w.id` for the same reason.
    expect(db.wishlistEntries).toEqual([
      expect.objectContaining({ id: 1, folderId: null, quantity: 7 }),
      expect.objectContaining({ id: 3, folderId: null, quantity: 1 }),
    ]);
  });

  it("merges when the destination already holds the same card, and names the survivor", () => {
    const db = filing({
      wishlistEntries: [
        wish({ id: 10, oracleId: BOLT.oracleId, quantity: 2, folderId: null, notes: "root" }),
        wish({ id: 11, oracleId: BOLT.oracleId, quantity: 5, folderId: 1 }),
      ],
    });
    const change = writeHandlers(db).wishlist_set_folder({ id: 10, folderId: 1 });
    // The destination's id and the summed quantity, and `removed: false` over a row that really
    // was deleted — the field means "the wish is gone", and it is emphatically still on the list.
    expect(change).toEqual({ id: 11, quantity: 7, removed: false });
    expect(db.wishlistEntries).toHaveLength(1);
    expect(db.wishlistEntries[0].notes).toBe("root");
  });

  /**
   * Which note survives the merge, pinned **by direction** rather than by accident.
   *
   * The test above has a note on the source and none on the destination, so it holds for
   * `target.notes ?? source.notes` and for the inverted `source.notes ?? target.notes` alike —
   * both answer `"root"`, and a refactor that swapped them would stay green. What that swap
   * costs the reader is their own annotation: the destination is the row they filed and wrote on,
   * and the source is a duplicate a deck sweep made at the root, so the inverted rule silently
   * replaces "already paid for" with a sentence about a row that no longer exists.
   *
   * Both halves are here because the coalesce is two claims: the survivor's note **wins**, and
   * it **falls back** when there is nothing to win with. A rule that only ever kept the target's
   * would drop the note off a wish the reader had just written one on.
   */
  it("keeps the destination's own note, and falls back to the source's only when it has none", () => {
    const annotated = () =>
      filing({
        wishlistEntries: [
          wish({ id: 10, oracleId: BOLT.oracleId, quantity: 1, notes: "cheapest on the feed" }),
          wish({ id: 11, oracleId: BOLT.oracleId, quantity: 1, folderId: 1, notes: "paid for" }),
        ],
      });
    const kept = annotated();
    writeHandlers(kept).wishlist_set_folder({ id: 10, folderId: 1 });
    expect(kept.wishlistEntries.map((w) => w.notes)).toEqual(["paid for"]);

    // The same merge with the destination's note taken away: the fold is a fallback as well as
    // a preference, so the note that does exist is the one that survives.
    const inherited = annotated();
    inherited.wishlistEntries[1].notes = null;
    writeHandlers(inherited).wishlist_set_folder({ id: 10, folderId: 1 });
    expect(inherited.wishlistEntries.map((w) => w.notes)).toEqual(["cheapest on the feed"]);
  });

  it("moves a wish to a named folder and back to the root, and refuses a folder that is gone", () => {
    const db = filing({ wishlistEntries: [wish({ id: 1, oracleId: BOLT.oracleId, quantity: 2 })] });
    const w = writeHandlers(db);
    expect(w.wishlist_set_folder({ id: 1, folderId: 2 })).toEqual({
      id: 1,
      quantity: 2,
      removed: false,
    });
    // `null` is the root, a real destination rather than an omission.
    w.wishlist_set_folder({ id: 1, folderId: null });
    expect(db.wishlistEntries[0].folderId).toBeNull();
    expect(() => w.wishlist_set_folder({ id: 1, folderId: 404 })).toThrow(/not there any more/);
    expect(() => w.wishlist_set_folder({ id: 404, folderId: 1 })).toThrow(/wishlist entry/);
  });

  it("re-pins a wish to a printing, un-pins it, and merges onto a grain already taken", () => {
    const db = makeDb({
      wishlistEntries: [
        wish({ id: 1, cardId: null, oracleId: BOLT.oracleId, quantity: 1, needsReview: "gone" }),
      ],
    });
    const w = writeHandlers(db);
    w.wishlist_set_printing({ id: 1, cardId: BOLT_2X2.id });
    // All four printing columns travel together, and choosing a printing **is** the review.
    expect(db.wishlistEntries[0]).toMatchObject({
      cardId: BOLT_2X2.id,
      setCode: BOLT_2X2.setCode,
      collectorNumber: BOLT_2X2.collectorNumber,
      needsReview: null,
    });
    // Un-pinning nulls all three again — `null` is a destination, not "leave it".
    w.wishlist_set_printing({ id: 1, cardId: null });
    expect(db.wishlistEntries[0]).toMatchObject({ cardId: null, setCode: null, lang: null });

    // A second wish pinned onto the first's grain merges rather than raising the unique index.
    const second = w.wishlist_add({ wish: { cardId: BOLT.id, quantity: 3 } });
    expect(w.wishlist_set_printing({ id: second.id, cardId: null })).toEqual({
      id: 1,
      quantity: 4,
      removed: false,
    });
    expect(db.wishlistEntries).toHaveLength(1);
  });

  it("is the same card twice when the only difference is the folder", () => {
    const db = filing();
    const w = writeHandlers(db);
    const root = w.wishlist_add({ wish: { oracleId: BOLT.oracleId!, quantity: 1 } });
    const filed = w.wishlist_add({ wish: { oracleId: BOLT.oracleId!, quantity: 1, folderId: 1 } });
    // The grain's fourth term: an add that names a folder is an add, never the reader's existing
    // row quietly moved out of the root.
    expect(filed.id).not.toBe(root.id);
    expect(db.wishlistEntries).toHaveLength(2);
    // And each row says the other is out there — the whole reason `elsewhere` exists.
    const rows = readHandlers(db).wishlist_list({
      query: { limit: 10, offset: 0, flatten: true },
    }).items;
    expect(rows.map((r) => r.elsewhere)).toEqual([1, 1]);
  });

  /**
   * `elsewhere`'s orphan fence — the one line of it that is a **fence** rather than arithmetic.
   *
   * `elsewhereWishes` returns `0` outright for a wish with no oracle id, and `db.ts` copies the
   * crate's warning about it verbatim: the tempting tidy is `(o.oracleId ?? "") === (w.oracleId
   * ?? "")`, to match the grain's own first term, and that would put every orphan on `""` and
   * have them all count each other. `wishlist.rs` spells it `o.oracle_id IS NOT NULL` for
   * exactly that reason.
   *
   * An orphan is a wish whose printing has left the corpus and which never carried an oracle id
   * — two of them are two unrelated cards, and "also on your list" over a pair of them is the
   * mark saying something false about the one thing it exists to say something true about.
   *
   * **Both directions are pinned in one read**, because a fence is only worth having while the
   * arithmetic behind it still works: two orphans answer `0`, and the two Bolts beside them —
   * one oracle card, two printings — still answer `1` each.
   */
  it("counts nothing for an orphan with no oracle id, and still counts for the cards that have one", () => {
    const db = makeDb({
      wishlistEntries: [
        // No oracle id at all: the table's `CHECK (oracle_id IS NOT NULL OR card_id IS NOT NULL)`
        // is satisfied by the printing alone, and the printing is one the corpus does not hold.
        wish({ id: 1, cardId: "a-printing-scryfall-dropped", oracleId: null, name: "Gone One" }),
        wish({ id: 2, cardId: "another-printing-it-dropped", oracleId: null, name: "Gone Two" }),
        // One card, two printings, and therefore two chances to buy it twice.
        wish({ id: 3, cardId: BOLT.id }),
        wish({ id: 4, cardId: BOLT_2X2.id }),
      ],
    });
    const rows = readHandlers(db).wishlist_list({ query: { limit: 10, offset: 0 } }).items;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.elsewhere]))).toEqual({
      1: 0,
      2: 0,
      3: 1,
      4: 1,
    });
  });

  it("reads the root by default, one folder when asked, and everything when flattened", () => {
    const db = filing({
      wishlistEntries: [
        wish({ id: 1, oracleId: BOLT.oracleId, folderId: null }),
        wish({ id: 2, oracleId: BOLT_2X2.oracleId, folderId: 1 }),
        wish({ id: 3, oracleId: FOIL_ONLY.oracleId, folderId: 2 }),
      ],
    });
    const list = (query: Partial<WishlistQuery>) =>
      readHandlers(db)
        .wishlist_list({ query: { limit: 10, offset: 0, ...query } })
        .items.map((r) => r.id);
    // **An absent `folderId` is the root**, not "everything" — the trap this fake must not be
    // kinder about than the backend.
    expect(list({})).toEqual([1]);
    expect(list({ folderId: null })).toEqual([1]);
    // Direct only: `Ordered` does not answer for what is inside `Backordered`.
    expect(list({ folderId: 1 })).toEqual([2]);
    expect(list({ flatten: true }).sort()).toEqual([1, 2, 3]);
    // `flatten` ignores `folderId` entirely rather than combining with it.
    expect(list({ folderId: 2, flatten: true }).sort()).toEqual([1, 2, 3]);
  });

  it("summarises each folder directly, leaves the root out, and skips an empty one", () => {
    const db = filing({
      wishlistFolders: [
        { id: 1, parentId: null, name: "Ordered", sortOrder: 0 },
        { id: 2, parentId: 1, name: "Backordered", sortOrder: 0 },
        { id: 3, parentId: null, name: "Someday", sortOrder: 1 },
      ],
      wishlistEntries: [
        wish({ id: 1, cardId: BOLT.id, quantity: 2, folderId: 1 }),
        wish({ id: 2, cardId: BOLT_2X2.id, quantity: 1, folderId: 2 }),
        wish({ id: 3, cardId: BOLT.id, quantity: 9, folderId: null }),
      ],
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 1 })],
    });
    const rows = readHandlers(db).wishlist_folder_summary({});
    // Two rows: the root is not a folder and draws no tile, and an empty folder has no row at
    // all — which is why a page has to build its tree from `wishlist_folder_list`.
    expect(rows.map((r) => r.folderId)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ wishes: 1, missing: 1 });
    expect(rows[1]).toMatchObject({ wishes: 1, missing: 1 });
  });

  /**
   * The other two figures on a folder card, which the summary test above leaves unasserted.
   *
   * `cost` is **what is still to buy**, never what is wanted: a folder charging the reader for
   * copies already in the binder is a subtotal they cannot act on, and it is the same
   * subtraction {@link toWishRow} makes so the card and the page header cannot disagree.
   *
   * `unpriced` is the non-obvious one and the reason this test exists. It counts a row only when
   * that row has copies **still to buy** *and* no price — `unit === null && missing > 0`. Drop
   * the second half and every folder holding a finished wish for an unpriceable printing grows a
   * "could not price" note about a card the reader already owns, which reads as a hole in the
   * marketplace's data rather than as the nothing it is.
   *
   * The fixture is two folders and three wishes, chosen so each clause fails loudly on its own:
   *
   * - `Ordered` wants two Alpha Bolts (`lea 161`, `usd` 620.00, nonfoil only) and two Invocation
   *   Consecrated Sphinxes (`mp2 8`, foil-only — `usd` is null, `usd_foil` 164.95), one of which
   *   is in the binder. The Sphinx wish names no finish, so it is priced at `nonfoil` and cannot
   *   be priced at all: three copies still to find, `$1240.00` of Bolts, and **one** unpriced.
   * - `Backordered` wants one of the same Sphinx, and the binder's copy covers it. Nothing to
   *   buy, so nothing to price and **nothing** unpriced.
   *
   * That one copy answering both folders is the model rather than a fixture bug:
   * {@link ownedAgainstWish} asks what the binder holds *against this wish*, and two wishes for
   * one card are two intentions — the wishlist has nowhere to say which of them a copy on the
   * shelf belongs to, and no folder to file it into either.
   */
  it("prices only the missing copies, and calls a row unpriced only while it has some", () => {
    const db = filing({
      wishlistEntries: [
        wish({ id: 1, cardId: BOLT.id, quantity: 2, folderId: 1 }),
        wish({ id: 2, cardId: FOIL_ONLY.id, quantity: 2, folderId: 1 }),
        wish({ id: 3, cardId: FOIL_ONLY.id, quantity: 1, folderId: 2 }),
      ],
      collectionEntries: [entry({ id: 1, cardId: FOIL_ONLY.id, finish: "foil", quantity: 1 })],
    });
    expect(readHandlers(db).wishlist_folder_summary({})).toEqual([
      { folderId: 1, wishes: 2, missing: 3, cost: 620 * 2, unpriced: 1 },
      { folderId: 2, wishes: 1, missing: 0, cost: 0, unpriced: 0 },
    ]);
  });

  it("throws the filing cabinet away with the wishes it filed", () => {
    const db = filing({ wishlistEntries: [wish({ id: 1, oracleId: BOLT.oracleId, folderId: 1 })] });
    // `wishlist_entries.folder_id` is `ON DELETE SET NULL`, so emptying the entries alone would
    // leave every folder standing and every folder card drawing zeroes.
    expect(writeHandlers(db).wishlist_clear()).toBe(1);
    expect(db.wishlistFolders).toHaveLength(0);
  });
});

/**
 * The binder's own filing cabinet (schema v24), and the **refusals** earn this block the way
 * the wishlist's do — with one more of them, because a collection folder can belong to the app.
 *
 * A fake that let a story file a card into a deck's folder by hand would draw an affordance the
 * window refuses, which is worse than no story: it is a claim about the app made in the app's
 * own drawing.
 */
describe("the collection's folders", () => {
  /** A binder with `Trade binder` inside it, and nothing filed yet. Every folder is the
   *  reader's; a test that wants one of the app's says so. */
  function filed(over: Partial<FakeDb> = {}): FakeDb {
    return makeDb({
      collectionFolders: [
        { id: 1, parentId: null, name: "Binder", kind: "user", deckId: null, sortOrder: 0 },
        { id: 2, parentId: 1, name: "Trade binder", kind: "user", deckId: null, sortOrder: 0 },
      ],
      ...over,
    });
  }

  it("files a new folder among its siblings, always as the reader's own", () => {
    const db = filed();
    const w = writeHandlers(db);
    const inner = w.collection_folder_create({ parentId: 1, name: "  Paid for  " });
    // Trimmed, `max + 1` **among siblings**, and `user` **written** rather than left to the
    // column's default — a default is a decision nobody can see at the call site.
    expect(inner).toMatchObject({ parentId: 1, name: "Paid for", sortOrder: 1, kind: "user" });
    expect(inner.deckId).toBeNull();
    expect(w.collection_folder_create({ parentId: null, name: "Someday" }).sortOrder).toBe(1);

    expect(() => w.collection_folder_create({ parentId: null, name: "   " })).toThrow(
      /A folder needs a name\./,
    );
    expect(() => w.collection_folder_rename({ id: 1, name: " " })).toThrow(/A folder needs a name/);
    expect(db.collectionFolders.find((f) => f.id === 1)!.name).toBe("Binder");
  });

  /**
   * The fence this cabinet has and the other two do not, on **every** write that names a folder.
   *
   * `deck` and `removed` folders say something the app is responsible for — that a deck holds
   * these copies, that these have left the collection — and a reader renaming or filing into one
   * would be asserting it without any of the writes that make it true. Nothing in this build
   * *creates* one, which is exactly why the fence is written before there is anything to fence:
   * a fence added after the thing it guards is one somebody has to remember to add.
   *
   * `collection_folder_delete` is the odd one out and is here for it: an id that is not there is
   * a **success**, so its two halves come apart — only a folder that exists *and* is the app's is
   * refused.
   */
  it("refuses every write against a folder the app owns, and only those", () => {
    const db = filed({
      collectionFolders: [
        { id: 1, parentId: null, name: "Binder", kind: "user", deckId: null, sortOrder: 0 },
        { id: 2, parentId: null, name: "Burn", kind: "deck", deckId: 7, sortOrder: 1 },
        { id: 3, parentId: null, name: "Recently removed", kind: "removed", deckId: null,
          sortOrder: 2 },
      ],
      collectionEntries: [entry({ id: 1, quantity: 1 })],
    });
    const w = writeHandlers(db);
    const notYours = /is the app's own/;
    expect(() => w.collection_folder_rename({ id: 2, name: "Mine now" })).toThrow(notYours);
    expect(() => w.collection_folder_move({ id: 3, parentId: 1 })).toThrow(notYours);
    expect(() => w.collection_folder_move({ id: 1, parentId: 2 })).toThrow(notYours);
    expect(() => w.collection_folder_create({ parentId: 3, name: "Inside" })).toThrow(notYours);
    expect(() => w.collection_folder_delete({ id: 2 })).toThrow(notYours);
    // Filing into one by hand is the refusal the reader is most likely to meet, since a picker
    // is what would offer it.
    expect(() => w.collection_set_folder({ id: 1, folderId: 2 })).toThrow(notYours);
    expect(db.collectionEntries[0].folderId).toBeNull();
    // Nothing about the fence stops the reader's own folders working.
    expect(w.collection_set_folder({ id: 1, folderId: 1 }).id).toBe(1);
  });

  /**
   * **The fence has a second end**: nothing may be filed *out* of a deck's group by hand either.
   * A copy walking out leaves the deck listing a card whose copies are gone — the same invariant
   * as filing one *in*, reached from the other side, and the frontend's `canFile` is the only
   * guard on it today.
   *
   * The refusal names the **source** rather than the folder: the reader is not changing anything
   * about the folder, they are taking a card out of it.
   *
   * Two things this must not fence, both asserted because either would break the feature rather
   * than a test: `Recently removed` as a source — filing a cut card into a binder is what that
   * folder is *for* — and `deck_to_collection`, which is the sanctioned way out of a group.
   */
  it("refuses to file a card out of a deck by hand, and only out of a deck", () => {
    const db = filed({
      collectionFolders: [
        { id: 1, parentId: null, name: "Binder", kind: "user", deckId: null, sortOrder: 0 },
        { id: 2, parentId: null, name: "Burn", kind: "deck", deckId: 7, sortOrder: 1 },
        { id: 3, parentId: null, name: "Recently removed", kind: "removed", deckId: null,
          sortOrder: 2 },
      ],
      collectionEntries: [
        entry({ id: 1, quantity: 1, folderId: 2 }),
        entry({ id: 2, quantity: 1, folderId: 3, cardId: "c-Counterspell" }),
      ],
    });
    const w = writeHandlers(db);

    expect(() => w.collection_set_folder({ id: 1, folderId: 1 })).toThrow(/are in a deck/);
    // The root is not a way around it: `null` is a destination like any other here.
    expect(() => w.collection_set_folder({ id: 1, folderId: null })).toThrow(/are in a deck/);
    expect(db.collectionEntries[0].folderId).toBe(2);

    // And out of the holding area by hand, which is the reader tidying rather than a deck
    // losing custody of anything.
    expect(w.collection_set_folder({ id: 2, folderId: 1 }).id).toBe(2);
  });

  it("answers every folder flat, in `sortOrder, id`, and hides none of them by kind", () => {
    const db = makeDb({
      collectionFolders: [
        { id: 3, parentId: null, name: "Someday", kind: "user", deckId: null, sortOrder: 0 },
        { id: 1, parentId: null, name: "Binder", kind: "user", deckId: null, sortOrder: 0 },
        { id: 2, parentId: null, name: "Burn", kind: "deck", deckId: 7, sortOrder: 1 },
      ],
    });
    // The reader's own arrangement, `sortOptions`' "they arranged it themselves" exemption — so
    // insertion order would look entirely plausible and be wrong. The `deck` folder is in the
    // answer: a page that could not see it would draw a tree the collection does not have.
    expect(readHandlers(db).collection_folder_list().map((f) => f.id)).toEqual([1, 3, 2]);
    expect(readHandlers(db).collection_folder_list()[2]).toMatchObject({
      kind: "deck",
      deckId: 7,
    });
  });

  it("refuses a cycle, a move into itself, a parent that is gone, and a loop it did not write", () => {
    const db = filed();
    const w = writeHandlers(db);
    expect(() => w.collection_folder_move({ id: 1, parentId: 2 })).toThrow(/inside itself/);
    expect(() => w.collection_folder_move({ id: 1, parentId: 1 })).toThrow(/inside itself/);
    expect(db.collectionFolders.find((f) => f.id === 1)!.parentId).toBeNull();
    // The destination, which the cycle walk cannot check for it: `collectionFolderById(...)
    // ?.parentId ?? null` reads an id no folder has as "already at the root" and ends the climb
    // on the first hop.
    expect(() => w.collection_folder_move({ id: 2, parentId: 404 })).toThrow(/not there any more/);
    expect(db.collectionFolders.find((f) => f.id === 2)!.parentId).toBe(1);

    // A loop written straight into the store, between two folders neither of which is the one
    // being moved — so the `cursor === id` arm never fires and only the hop budget ends the
    // climb. A fake with no budget hangs the tab here rather than failing.
    db.collectionFolders[0].parentId = 2;
    const moving = w.collection_folder_create({ parentId: null, name: "Someday" });
    expect(() => w.collection_folder_move({ id: moving.id, parentId: 1 })).toThrow(/inside itself/);
  });

  it("takes the sub-folders and leaves the cards standing at the root", () => {
    const db = filed({
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, folderId: 1 }),
        entry({ id: 2, cardId: BOLT_2X2.id, folderId: 2 }),
      ],
    });
    writeHandlers(db).collection_folder_delete({ id: 1 });
    expect(db.collectionFolders).toHaveLength(0);
    // The two cascades pointing opposite ways: the cabinet and its drawer are gone, and both
    // cards are still owned. A folder is where a card was kept; the card is the reader's.
    expect(db.collectionEntries.map((e) => e.folderId)).toEqual([null, null]);
    // An id that resolves to nothing is a success.
    expect(() => writeHandlers(db).collection_folder_delete({ id: 404 })).not.toThrow();
  });

  /**
   * The delete **merges**, and the two shapes that make it have to.
   *
   * Un-filing a sub-tree rewrites the eleventh term of `collectionGrain` on every row in it, so a
   * press can land twice on one grain. Both shapes are reachable in the shipped app:
   *
   * - a filed row and an **unfiled** row for the same printing, which is what every writer that
   *   cannot name a folder produces — a quick add from the search, an import, a deck sweep;
   * - two rows in **sibling sub-folders**, colliding with each other with no root row in play.
   *
   * A bare loop over the rows produces both while the app answers `UNIQUE constraint failed:
   * index 'idx_collection_grain'` and deletes nothing — the fake kinder than the app, which is
   * the drift that lets a story document a state the reader cannot reach.
   */
  it("merges the rows it un-files, onto the root row and onto each other", () => {
    const db = makeDb({
      collectionFolders: [
        { id: 1, parentId: null, name: "Top", kind: "user", deckId: null, sortOrder: 0 },
        { id: 2, parentId: 1, name: "A", kind: "user", deckId: null, sortOrder: 0 },
        { id: 3, parentId: 1, name: "B", kind: "user", deckId: null, sortOrder: 1 },
      ],
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, quantity: 1, folderId: null }),
        entry({ id: 2, cardId: BOLT.id, quantity: 2, folderId: 2, notes: "traded for" }),
        entry({ id: 3, cardId: BOLT.id, quantity: 5, folderId: 3 }),
        // A printing only one of them holds, so the merge is shown to be about the grain rather
        // than about "everything in a deleted folder becomes one row".
        entry({ id: 4, cardId: BOLT_2X2.id, quantity: 1, folderId: 3 }),
      ],
    });
    writeHandlers(db).collection_folder_delete({ id: 1 });
    expect(db.collectionFolders).toHaveLength(0);
    // Lowest id first, so the row that survives is a fact about the store and not about
    // iteration order — the crate collects its sub-tree with `ORDER BY e.id` for the same reason.
    // The survivor had no note and takes the folded row's: a fold that dropped it would be a
    // receipt destroyed to resolve a filing decision.
    expect(db.collectionEntries).toEqual([
      expect.objectContaining({ id: 1, folderId: null, quantity: 8, notes: "traded for" }),
      expect.objectContaining({ id: 4, folderId: null, quantity: 1 }),
    ]);
  });

  it("moves a row to a folder and back to the root, and refuses a folder that is gone", () => {
    const db = filed({ collectionEntries: [entry({ id: 1, quantity: 2 })] });
    const w = writeHandlers(db);
    expect(w.collection_set_folder({ id: 1, folderId: 2 })).toEqual({
      id: 1,
      quantity: 2,
      removed: false,
    });
    // `null` is the root of the collection, a real destination rather than an omission.
    w.collection_set_folder({ id: 1, folderId: null });
    expect(db.collectionEntries[0].folderId).toBeNull();
    expect(() => w.collection_set_folder({ id: 1, folderId: 404 })).toThrow(/not there any more/);
    expect(() => w.collection_set_folder({ id: 404, folderId: 1 })).toThrow(/collection entry/);
  });

  it("merges onto a grain the destination already holds, and names the survivor", () => {
    const db = filed({
      collectionEntries: [
        entry({ id: 10, cardId: BOLT.id, quantity: 2, notes: "root" }),
        entry({ id: 11, cardId: BOLT.id, quantity: 5, folderId: 1, notes: "binder" }),
      ],
    });
    const change = writeHandlers(db).collection_set_folder({ id: 10, folderId: 1 });
    // The destination's id and the summed quantity, and `removed: false` over a row that really
    // was deleted — the field means "the reader owns none of it", and they own seven.
    expect(change).toEqual({ id: 11, quantity: 7, removed: false });
    expect(db.collectionEntries).toHaveLength(1);
    // The survivor's own answers are not up for revision: the destination is the row the reader
    // filed and wrote on, and inverting the coalesce would replace their note with one about a
    // row that no longer exists.
    expect(db.collectionEntries[0].notes).toBe("binder");
  });

  it("is the same printing twice when the only difference is the folder", () => {
    const db = filed({ collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 1 })] });
    const w = writeHandlers(db);
    // An add names no folder and lands at the root, so it folds into the row already there
    // rather than into the filed one — which is the whole point of the eleventh term.
    w.collection_set_folder({ id: 1, folderId: 1 });
    const added = w.collection_add({ entry: { cardId: BOLT.id, finish: "nonfoil", quantity: 1 } });
    expect(added.id).not.toBe(1);
    expect(db.collectionEntries.map((e) => e.folderId)).toEqual([1, null]);
  });

  it("reads every folder by default, one folder when asked, and the root only when told", () => {
    const db = filed({
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, folderId: null }),
        entry({ id: 2, cardId: BOLT_2X2.id, folderId: 1 }),
        entry({ id: 3, cardId: FOIL_ONLY.id, finish: "foil", folderId: 2 }),
      ],
    });
    // Sorted by id rather than read off the page: the list's own order is name order, which is
    // a different claim and one `describe("ordering")` already pins.
    const list = (query: Partial<CollectionQuery>) =>
      readHandlers(db)
        .collection_list({ query: { limit: 10, offset: 0, ...query } })
        .items.map((r) => r.id)
        .sort((a, b) => a - b);
    // **Absent and `null` are one state here, and it is "every folder"** — the opposite of
    // `wishlist_list`, whose absent `folderId` is the root. `Option<i64>` cannot tell a JSON
    // `null` from an omission, which is why the root is a second field here rather than a value
    // of this one: the mirror, the export sweep, the deck panel and the importer's preview all
    // ask by saying nothing, and had to keep the answer they already had.
    expect(list({})).toEqual([1, 2, 3]);
    expect(list({ folderId: null })).toEqual([1, 2, 3]);
    expect(list({ rootOnly: false })).toEqual([1, 2, 3]);
    // Direct only: `Binder` does not answer for what is inside `Trade binder`.
    expect(list({ folderId: 1 })).toEqual([2]);
    // The third state — `folder_id IS NULL`, the copies nobody has filed and only those. This
    // is `WishlistQuery.flatten` read from the other end: there the flag widens the root to
    // everything, here it narrows everything to the root.
    expect(list({ rootOnly: true })).toEqual([1]);
    expect(list({ folderId: null, rootOnly: true })).toEqual([1]);
    // **A folder id wins rather than intersecting to nothing.** A stale flag beside an id would
    // otherwise answer the empty intersection, which on screen reads as an emptied drawer.
    expect(list({ folderId: 1, rootOnly: true })).toEqual([2]);
    // The header is taken over the same rows — `collection_summary` reads `collectionScope` and
    // nothing else, so a root-only list may not be summarised over the whole cabinet.
    expect(
      readHandlers(db).collection_summary({ query: { limit: 0, offset: 0, rootOnly: true } })
        .entries,
    ).toBe(1);
    // And the row carries its folder's name for the table's own column — a display string, so
    // the root reads `null` rather than a word.
    const rows = readHandlers(db).collection_list({ query: { limit: 10, offset: 0 } }).items;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.folderName]))).toEqual({
      1: null,
      2: "Binder",
      3: "Trade binder",
    });
  });

  /**
   * `allocation: "unallocated"` — the copies a **deck** is holding, and nothing else.
   *
   * The root, a folder the reader made and `Recently removed` are all cards on their desk; only
   * a copy a deck has taken off it is spoken for. The fixture seeds all four folders by hand
   * over `makeDb`, which has no decks in it: the branch is then exercised by the *kind* column
   * alone, with no `deck_create` and no `collection_to_deck` in the way. The two writes reach it
   * from the other end in "takes a copy out of the unallocated list by moving it" below, so the
   * predicate and the presses that produce it are each pinned once.
   */
  it("drops only a deck folder's copies when the query asks for the unallocated ones", () => {
    const db = makeDb({
      collectionFolders: [
        { id: 1, parentId: null, name: "Binder", kind: "user", deckId: null, sortOrder: 0 },
        { id: 2, parentId: null, name: "Recently removed", kind: "removed", deckId: null,
          sortOrder: 1 },
        { id: 3, parentId: null, name: "Burn", kind: "deck", deckId: 7, sortOrder: 2 },
      ],
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, folderId: null }),
        entry({ id: 2, cardId: BOLT_2X2.id, folderId: 1 }),
        entry({ id: 3, cardId: FOIL_ONLY.id, finish: "foil", folderId: 2 }),
        entry({ id: 4, cardId: BOLT.id, folderId: 3 }),
      ],
    });
    const list = (allocation: CollectionQuery["allocation"]) =>
      readHandlers(db)
        .collection_list({ query: { limit: 10, offset: 0, allocation } })
        .items.map((r) => r.id)
        .sort((a, b) => a - b);
    expect(list(undefined)).toEqual([1, 2, 3, 4]);
    expect(list("all")).toEqual([1, 2, 3, 4]);
    expect(list("unallocated")).toEqual([1, 2, 3]);
  });

  /**
   * The two numbers on a folder tile, and both have a rule of their own.
   *
   * `cards` is **copies** (`sum(quantity)`) rather than rows — the header's own arithmetic — so a
   * row stepped to zero contributes nothing while still being a row. `value` is **`null` and
   * never `0`** where the marketplace prices nothing in the folder: a tile has no room for the
   * header's "n unpriced" note, so a folder of cards the feed has never heard of would otherwise
   * read as a folder worth nothing.
   *
   * `FOIL_ONLY` at `nonfoil` is the unpriceable row — the printing is foil-only, so its `usd` is
   * null while `usd_foil` is not — which is the same trick the wishlist's own summary test uses.
   *
   * Direct per folder and never recursive: `Binder` answers for its own copies and **not** for
   * `Trade binder`'s, because `buildFolderTree` sums a node's children on the way up and two
   * implementations of one figure disagree the first time either changes.
   */
  it("counts copies per folder directly, leaves the root out, skips an empty one, and answers null for an unpriced folder", () => {
    const db = filed({
      collectionFolders: [
        { id: 1, parentId: null, name: "Binder", kind: "user", deckId: null, sortOrder: 0 },
        { id: 2, parentId: 1, name: "Trade binder", kind: "user", deckId: null, sortOrder: 0 },
        { id: 3, parentId: null, name: "Someday", kind: "user", deckId: null, sortOrder: 1 },
      ],
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, quantity: 2, folderId: 1 }),
        // A row at zero: still a row, and worth nothing — so it moves neither figure.
        entry({ id: 2, cardId: BOLT_2X2.id, quantity: 0, folderId: 1 }),
        entry({ id: 3, cardId: FOIL_ONLY.id, finish: "nonfoil", quantity: 3, folderId: 2 }),
        entry({ id: 4, cardId: BOLT.id, quantity: 9, folderId: null }),
      ],
    });
    const rows = readHandlers(db).collection_folder_summary({});
    // Two rows: the root is not a folder and draws no tile, and `Someday` has no row at all —
    // which is why a page has to build its tree from `collection_folder_list`.
    expect(rows.map((r) => r.folderId)).toEqual([1, 2]);
    expect(rows[0].cards).toBe(2);
    expect(rows[0].value).toBeGreaterThan(0);
    // Copies counted, and `null` rather than `0` for what none of them can be priced at.
    expect(rows[1]).toEqual({ folderId: 2, cards: 3, value: null });
  });

  it("throws the filing cabinet away with the cards it filed, and rebuilds the app's own", () => {
    const db = filed({ collectionEntries: [entry({ id: 1, folderId: 1 })] });
    // `collection_entries.folder_id` is `ON DELETE SET NULL`, so emptying the entries alone would
    // hand the reader an empty cabinet to take apart one drawer at a time.
    expect(writeHandlers(db).collection_clear().entries).toBe(1);
    // Every drawer the reader made is gone; `Recently removed` is put straight back, because it
    // is where the app *puts* cards rather than filing the reader chose. There are no decks in
    // this fixture, so it is the only row left.
    expect(db.collectionFolders.map((f) => f.kind)).toEqual(["removed"]);
  });
});

/**
 * **The two reads a folder rule is answered from** — `deck::played_keys` and
 * `deck::decks_playing`, issue #358's pair.
 *
 * The read side of the fence `collection_to_deck` keeps: one says what a deck plays, the other
 * which decks play a given hand. Both key a card by
 * `coalesce(cards.oracle_id, deck_cards.card_id)`, so a rule is about the **card** and never the
 * printing the reader happens to own — and the fence is written over the first of them, which is
 * what stops a control offering a filing the write then refuses.
 */
describe("the two reads a folder rule is answered from", () => {
  /** A second card, so a hand can name more than one. **Two printings under one oracle id**,
   *  which is what makes it useful on both sides of the every-not-any rule below. */
  const SOL_RING = CARDS.find((c) => c.name === "Sol Ring")!;
  const SOL_RING_SLD = CARDS.filter((c) => c.name === "Sol Ring")[1];

  /**
   * `DISTINCT`, over piles and over printings alike.
   *
   * Two piles of one deck may name one card and a rule asking "does this deck play it" must not
   * care how many rows say yes; a second *printing* of that card is the same card again, which
   * is the whole reason the key is the oracle id rather than `card_id`. And an **inactive** pile
   * is still the reader's list — the Maybeboard is switched off for the counting, not for the
   * filing — so a fence that skipped it would refuse a press the app allows.
   *
   * **The answer comes back sorted by the key** (`ORDER BY 1`), so the expectation is sorted and
   * the answer is not: an assertion that sorted both sides could not tell a list from a set.
   */
  it("answers the live list's cards once each, whichever pile and whichever printing", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 4 }),
        deckCard({ id: 2, cardId: BOLT.id, categoryKind: "side", quantity: 1 }),
        deckCard({ id: 3, cardId: BOLT_2X2.id, categoryKind: "main", quantity: 1 }),
        deckCard({ id: 4, cardId: SOL_RING.id, categoryKind: "maybe", quantity: 1 }),
      ],
    });

    expect(readHandlers(db).deck_played_keys({ deckId: 1 })).toEqual(
      [BOLT.oracleId, SOL_RING.oracleId].sort(),
    );
  });

  /**
   * **A plan is not a list.** A theory row holds no cards — `THEORY_HOLDS_NOTHING`'s sentence,
   * read from the other end — so a group filled behind one would be spoken for by a deck nobody
   * is holding. A deck that is not there answers the same empty list rather than refusing: the
   * cards a deck with no row plays is nothing, and there is no fence in the statement.
   */
  it("answers nothing for a plan, and nothing for a deck that is not there", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, variant: "theory", categoryKind: "main", quantity: 4 }),
      ],
    });
    const r = readHandlers(db);

    expect(r.deck_played_keys({ deckId: 1 })).toEqual([]);
    expect(r.deck_played_keys({ deckId: 404 })).toEqual([]);
  });

  /**
   * **`coalesce`, and this is the arm that needs it.** `cards` is rebuildable and the deck is
   * not: an import writes a printing this corpus has not got, and a resync can drop one. The
   * `LEFT JOIN` keeps the row and the fallback keys it by the id the deck row already holds — a
   * printing with no `cards` row is still a card, and it is only ever the same card as itself.
   */
  it("keys a printing `cards` has never heard of by the deck row's own id", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 1 }),
        deckCard({ id: 2, cardId: "gone", categoryKind: "main", quantity: 1 }),
      ],
    });

    expect(readHandlers(db).deck_played_keys({ deckId: 1 })).toEqual(
      [BOLT.oracleId, "gone"].sort(),
    );
  });

  /**
   * **Every, never any.** A rule naming two cards asks which decks could hold both, and an `any`
   * would answer with the union — every deck that plays one of them — which is the failure that
   * looks most like working: the list is longer, every entry is plausible, and half of them
   * would refuse the filing they were offered for.
   *
   * Deck 3's Sol Ring is the **other** printing, so it is the oracle key that puts it in the
   * answer rather than the id it stores. Deck 4 plays the Bolt in its *plan* only, which is the
   * same exclusion `deck_played_keys` makes one deck at a time.
   */
  it("answers the decks that play every key, never the ones that play any", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 }), deck({ id: 2 }), deck({ id: 3 }), deck({ id: 4 })],
      deckCards: [
        deckCard({ id: 1, deckId: 1, cardId: BOLT.id, quantity: 4 }),
        deckCard({ id: 2, deckId: 1, cardId: SOL_RING.id, quantity: 1 }),
        deckCard({ id: 3, deckId: 2, cardId: BOLT.id, quantity: 2 }),
        deckCard({ id: 4, deckId: 3, cardId: BOLT.id, quantity: 1 }),
        deckCard({ id: 5, deckId: 3, cardId: SOL_RING_SLD.id, quantity: 1 }),
        deckCard({ id: 6, deckId: 4, cardId: SOL_RING.id, quantity: 1 }),
        deckCard({ id: 7, deckId: 4, cardId: BOLT.id, variant: "theory", quantity: 1 }),
      ],
    });
    const playing = (keys: string[]) => readHandlers(db).deck_ids_playing({ keys });

    expect(playing([BOLT.oracleId])).toEqual([1, 2, 3]);
    expect(playing([SOL_RING.oracleId])).toEqual([1, 3, 4]);
    // Both: the intersection, and not the union of the two lines above.
    expect(playing([BOLT.oracleId, SOL_RING.oracleId])).toEqual([1, 3]);
    // A key nobody plays takes the whole hand with it, which is the same rule said backwards.
    expect(playing([BOLT.oracleId, "gone"])).toEqual([]);
    // One card asked for twice is one card: the keys are a set before they are counted, or a
    // caller that repeated itself would be told no deck plays anything.
    expect(playing([BOLT.oracleId, BOLT.oracleId])).toEqual([1, 2, 3]);
  });

  /**
   * **No keys is no decks, and the vacuous reading is the wrong one.** "Every deck plays all
   * zero of these" is what a `HAVING count(*) = 0` would say, and it is the wrong answer to the
   * only question that produces it: a caller with an empty hand has nothing to file, and
   * offering it the whole gallery is worse than offering it nothing.
   */
  it("answers no decks at all for no keys", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT.id, quantity: 1 })],
    });

    expect(readHandlers(db).deck_ids_playing({ keys: [] })).toEqual([]);
  });

  /**
   * **The `starter` seed measured against the fence**, because a Storybook world is the thing
   * every play and every hand-driven press runs against and a rule that refuses the seed is a
   * workbench nobody can use.
   *
   * Deck 1 — `Modern Goodstuff`, the deck every editor story opens — plays **18** cards, and its
   * Collection Search tab can still file five of the reader's twelve rows. The four it now
   * refuses are the ones the deck genuinely does not play; `mh2 267` and `mh2 138` keep
   * answering `ALREADY_HERE`, which is the older refusal and still ahead of nothing.
   *
   * **The one that matters is `c21 263`** — the Sol Ring in `Kenrith Two-Drops`, the seed's only
   * copy filed under a deck the reader is not standing in, and therefore the only row the
   * cross-deck confirmation can be reached from. Deck 1 plays no Sol Ring, so confirming that
   * press now refuses. No story's `play` presses it (`CrossDeckConfirm` stops at the question),
   * so nothing goes red — which is exactly why it is measured here instead.
   */
  it("still lets the starter seed's deck file five of the reader's twelve rows", () => {
    const db = seed("starter");
    const main = db.deckCategories.find((c) => c.deckId === 1 && c.kind === "main")!;
    // A fresh world per row: a filing that succeeds changes what the next one is asked about.
    const fileIntoDeckOne = (entryId: number) => {
      try {
        writeHandlers(seed("starter")).collection_to_deck({
          entryId,
          deckId: 1,
          categoryId: main.id,
          quantity: 1,
        });
        return "filed";
      } catch (refusal) {
        return (refusal as Error).message;
      }
    };
    const outcome = (predicate: (answer: string) => boolean) =>
      db.collectionEntries
        .map((e) => ({ e, answer: fileIntoDeckOne(e.id) }))
        .filter(({ answer }) => predicate(answer))
        .map(({ e }) => `${e.setCode} ${e.collectorNumber}`);

    expect(readHandlers(db).deck_played_keys({ deckId: 1 })).toHaveLength(18);
    expect(outcome((a) => a === "filed")).toEqual([
      "2x2 117",
      "lea 161",
      "sta 105",
      "fut 153",
      "mh2 259",
    ]);
    // Sol Ring twice — the cross-deck row and the reader's other printing of it — plus the two
    // cards deck 1 has simply never listed.
    expect(outcome((a) => a.includes("does not play this card"))).toEqual([
      "c21 263",
      "sld 913",
      "mp2 8",
      "lea 232",
    ]);
    // And the two older refusals are untouched: the copies already in this deck's group, and
    // the row the reader has stepped to zero.
    expect(outcome((a) => a.includes("already in this deck"))).toEqual(["mh2 267", "mh2 138"]);
    expect(outcome((a) => a.includes("not that many"))).toEqual(["kld 235"]);
  });
});

/**
 * The two writes that move copies across the deck boundary — the only pair in the crate that
 * can, which is what makes exclusivity a fact about **where a row sits** rather than a sum
 * somebody has to remember to compute.
 *
 * Every one of these has a `collection_alloc.rs` test of the same shape; where the two disagree
 * the fake is wrong.
 */
describe("moving copies across the deck boundary", () => {
  /**
   * Two decks with their groups and their categories, four Bolts at the root — **and one Bolt on
   * each deck's live main pile**.
   *
   * That last part is issue #358's, and it is a precondition rather than a convenience:
   * `collection_to_deck` now refuses a card the destination's live list does not play, so a
   * fixture whose decks list nothing could exercise exactly one branch of this command and no
   * other. **Every count below reads over that baseline** — `listed` starts at 1 for both decks,
   * and a filing into `main` folds into the row that is already there rather than inserting one.
   */
  const boundary = (init: Partial<FakeDb> = {}) =>
    makeDeckDb({
      decks: [deck({ id: 1, name: "Deck A" }), deck({ id: 2, name: "Deck B" })],
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 4 })],
      deckCards: [
        deckCard({ id: 1, deckId: 1, categoryKind: "main", quantity: 1 }),
        deckCard({ id: 2, deckId: 2, categoryKind: "main", quantity: 1 }),
      ],
      ...init,
    });
  const copiesIn = (db: FakeDb, folderId: number | null) =>
    db.collectionEntries
      .filter((e) => e.folderId === folderId)
      .reduce((n, e) => n + e.quantity, 0);
  const listed = (db: FakeDb, deckId: number) =>
    db.deckCards
      .filter((dc) => dc.deckId === deckId && dc.variant === "live" && dc.cardId === BOLT.id)
      .reduce((n, dc) => n + dc.quantity, 0);

  it("takes a card out of the binder and leaves the rest of the row behind", () => {
    const db = boundary();
    const out = writeHandlers(db).collection_to_deck({
      entryId: 1,
      deckId: 1,
      categoryId: categoryId(1, "main"),
      quantity: 1,
    });
    expect(out).toMatchObject({ fromDeck: null, quantity: 1 });
    expect(copiesIn(db, null)).toBe(3);
    expect(copiesIn(db, groupId(1))).toBe(1);
    // Two on the list, one of them backed: the row the deck already had, plus the copy this
    // press filed into it. The list and the group are separate facts, which is the whole reason
    // a card can be listed and missing.
    expect(listed(db, 1)).toBe(2);
    // The answer names the row the copies landed in, which is not always the id it was handed.
    expect(db.collectionEntries.find((e) => e.id === out.entryId)!.folderId).toBe(groupId(1));
  });

  /**
   * The case the UI confirms before pressing, because the side effect lands on a deck the reader
   * is not looking at: the copies are custody and not a reservation, so a deck that loses them
   * loses the card.
   */
  it("decrements the other deck's live list too, and names it", () => {
    const db = boundary({ collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 1 })] });
    const w = writeHandlers(db);
    w.collection_to_deck({ entryId: 1, deckId: 1, categoryId: categoryId(1, "main"), quantity: 1 });
    const filedEntry = db.collectionEntries.find((e) => e.folderId === groupId(1))!;

    const out = w.collection_to_deck({
      entryId: filedEntry.id,
      deckId: 2,
      categoryId: categoryId(2, "main"),
      quantity: 1,
    });

    expect(out.fromDeck).toBe("Deck A");
    // Deck A is back to the one row it started with and Deck B has folded the copy into its own,
    // which is the move read from both ends over {@link boundary}'s baseline.
    expect(listed(db, 1)).toBe(1);
    expect(listed(db, 2)).toBe(2);
    expect(copiesIn(db, groupId(1))).toBe(0);
    expect(copiesIn(db, groupId(2))).toBe(1);
  });

  it("folds into the row the destination already holds rather than making a second", () => {
    const db = boundary({
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, quantity: 4 }),
        entry({ id: 2, cardId: BOLT.id, quantity: 1, folderId: groupId(1) }),
      ],
    });
    const out = writeHandlers(db).collection_to_deck({
      entryId: 1,
      deckId: 1,
      categoryId: categoryId(1, "main"),
      quantity: 2,
    });
    // One row in the group holding three, and the remainder back at the root — `folderId` is the
    // eleventh term of the grain, so the two halves cannot be one row.
    expect(out.entryId).toBe(2);
    expect(db.collectionEntries.filter((e) => e.folderId === groupId(1))).toHaveLength(1);
    expect(copiesIn(db, groupId(1))).toBe(3);
    expect(copiesIn(db, null)).toBe(2);
  });

  it("splits the tradelist rather than duplicating it", () => {
    const db = boundary({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 4, tradelistQuantity: 3 })],
    });
    writeHandlers(db).collection_to_deck({
      entryId: 1,
      deckId: 1,
      categoryId: categoryId(1, "main"),
      quantity: 2,
    });
    // The two halves sum to the three the one row held: moving a card must not put it on the
    // trade list twice.
    expect(db.collectionEntries.map((e) => e.tradelistQuantity).sort()).toEqual([1, 2]);
  });

  it("refuses copies that are already in this deck", () => {
    const db = boundary({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 1, folderId: groupId(1) })],
    });
    expect(() =>
      writeHandlers(db).collection_to_deck({
        entryId: 1,
        deckId: 1,
        categoryId: categoryId(1, "main"),
        quantity: 1,
      }),
    ).toThrow(/already in this deck/);
  });

  /**
   * **Issue #358's fence.** A copy filed into a deck's group that no `deck_cards` row backs is a
   * phantom: the collection says it is spoken for, every other deck is refused it, and nothing
   * on the deck screen accounts for it. So the list has to name the card first — `deck_add_card`
   * is what puts it there, and it writes no collection row at all.
   *
   * **And the pile is the other half of the same test.** The name arm *creates* a category, so a
   * refusal landing after that create leaves an empty column standing after a press that failed
   * — the state the rollback exists for, and the class of defect this feature has already
   * shipped once. This refusal is asked *before* the create, which is where the crate puts it,
   * so there is nothing to roll back rather than something rolled back correctly.
   */
  it("refuses a card the deck does not play, and invents no pile on the way", () => {
    const db = boundary({
      collectionEntries: [entry({ id: 1, cardId: FOIL_ONLY.id, finish: "foil", quantity: 2 })],
    });
    const before = db.deckCategories.length;

    expect(() =>
      writeHandlers(db).collection_to_deck({
        entryId: 1,
        deckId: 1,
        categoryName: "Ramp",
        quantity: 1,
      }),
    ).toThrow(/does not play this card/);

    expect(db.deckCategories.some((c) => c.name === "Ramp")).toBe(false);
    expect(db.deckCategories).toHaveLength(before);
    // And nothing moved: the copies are where the reader left them, and the deck's list is
    // untouched — a refused press writes to neither cabinet.
    expect(copiesIn(db, null)).toBe(2);
    expect(copiesIn(db, groupId(1))).toBe(0);
    expect(db.deckCards.filter((dc) => dc.deckId === 1)).toHaveLength(1);
  });

  /**
   * **A different printing of a card the deck plays is the same card.** The fence keys on
   * `coalesce(cards.oracle_id, deck_cards.card_id)` — `deck::release_group_copies`' rule and
   * `owned_by_oracle`'s — so a list naming the pretty Bolt takes the reader's cheap one. Matched
   * on the printing this would refuse the commonest filing there is.
   */
  it("accepts another printing of a card the deck plays", () => {
    const db = boundary({
      deckCards: [
        deckCard({ id: 1, deckId: 1, cardId: BOLT_2X2.id, categoryKind: "main", quantity: 1 }),
      ],
    });

    const out = writeHandlers(db).collection_to_deck({
      entryId: 1,
      deckId: 1,
      categoryId: categoryId(1, "main"),
      quantity: 1,
    });

    expect(out.quantity).toBe(1);
    expect(copiesIn(db, groupId(1))).toBe(1);
    // A second row rather than a fold: the printing is part of the deck-card grain, so the deck
    // now lists both — which is the state `deck_to_collection`'s oracle arm exists to cut back
    // through. The fence is about the card; the row is about the printing.
    expect(
      db.deckCards
        .filter((dc) => dc.deckId === 1)
        .map((dc) => dc.cardId)
        .sort(),
    ).toEqual([BOLT.id, BOLT_2X2.id].sort());
  });

  /**
   * **A plan is not a list.** A theory row holds no cards — `THEORY_HOLDS_NOTHING`'s sentence
   * from the other end of this same pair — so copies filed behind one would be spoken for by a
   * deck nobody is holding, and no other deck could ever have them.
   */
  it("refuses a card the deck only plans to play", () => {
    const db = boundary({
      deckCards: [
        deckCard({
          id: 1,
          deckId: 1,
          cardId: BOLT.id,
          variant: "theory",
          categoryKind: "main",
          quantity: 4,
        }),
      ],
    });

    expect(() =>
      writeHandlers(db).collection_to_deck({
        entryId: 1,
        deckId: 1,
        categoryId: categoryId(1, "main"),
        quantity: 1,
      }),
    ).toThrow(/does not play this card/);
    expect(copiesIn(db, groupId(1))).toBe(0);
  });

  /**
   * **Where the new fence sits among the refusals it joined**, which is the half a sentence
   * cannot pin. `collection_alloc`'s order since issue #358 is: the deck, the source row, the
   * fence, the pile, the group, the quantity, `ALREADY_HERE` — so the fence is ahead of the
   * pile's refusals and of the group's, and behind the two lookups it needs answers from.
   *
   * The deck stays first because "that deck is gone" and "that deck does not play this" are
   * different things to tell a stale editor. **The source row moved up with the fence**, which
   * is the one precedence this change really did move: a caller sending a dead entry id and a
   * dead category id now hears about the entry, and the crate argues that is the right order
   * anyway — the entry is what the reader pointed at, the category only where it was going.
   */
  it("comes after the deck and the row, ahead of the pile and the group", () => {
    const db = boundary({
      collectionEntries: [entry({ id: 1, cardId: FOIL_ONLY.id, finish: "foil", quantity: 1 })],
    });
    const w = writeHandlers(db);
    const move = (over: { entryId?: number; deckId?: number; categoryId?: number }) =>
      w.collection_to_deck({
        entryId: 1,
        deckId: 1,
        categoryId: categoryId(1, "main"),
        quantity: 1,
        ...over,
      });

    // A deck that is not there beats everything: the id is stale and there is no list to read.
    expect(() => move({ deckId: 404 })).toThrow(/deck is not there any more/);
    // A row that is not there beats the fence, and now the pile too — two dead ids, and the one
    // the reader pointed at is the one they hear about.
    expect(() => move({ entryId: 404, categoryId: 909 })).toThrow(/collection entry is not there/);
    // A pile that is not there does **not** beat the fence: the name arm creates, so nothing
    // about a category may be decided before the card has been allowed through.
    expect(() => move({ categoryId: 909 })).toThrow(/does not play this card/);
    // Nor does a deck with no group — the fence is asked before the group is looked up, so this
    // press meets the card's sentence rather than the folder's.
    db.collectionFolders = db.collectionFolders.filter((f) => f.deckId !== 1);
    expect(() => move({})).toThrow(/does not play this card/);
  });

  it("refuses a quantity larger than the row holds, and a quantity of none", () => {
    const db = boundary();
    const w = writeHandlers(db);
    const move = (quantity: number) =>
      w.collection_to_deck({ entryId: 1, deckId: 1, categoryId: categoryId(1, "main"), quantity });
    expect(() => move(5)).toThrow(/not that many copies/i);
    expect(() => move(0)).toThrow(/at least one/);
    expect(copiesIn(db, null)).toBe(4);
  });

  /**
   * **The name arm, and the reason it exists.** `collection_to_deck` took a category **id** for
   * one release, so an owned add that had to invent a pile resolved the name in TypeScript and
   * created it through `deck_category_create` — the reader's own "New category" write, which
   * marks a pile `"user"`. `drawsWhenEmpty` reads that flag, so a `Ramp` the app invented drew an
   * empty heading for ever where the same pile invented by a `need` add left the desk with its
   * last card. `categoryForName` is the one write that records `"auto"`.
   */
  it("marks a pile it had to invent as the app's, not the reader's", () => {
    const db = boundary();
    writeHandlers(db).collection_to_deck({
      entryId: 1,
      deckId: 1,
      categoryName: "Ramp",
      quantity: 1,
    });
    const made = db.deckCategories.find((c) => c.deckId === 1 && c.name === "Ramp")!;
    expect(made.origin).toBe("auto");
    // The deck's own row plus the one this press wrote into the pile it invented — the fence
    // asks whether the deck **plays** the card and the pile is where the copies are filed, so
    // the two are different questions and this is what they look like answered separately.
    expect(listed(db, 1)).toBe(2);
    expect(db.deckCards.filter((dc) => dc.categoryId === made.id).map((dc) => dc.cardId)).toEqual([
      BOLT.id,
    ]);
  });

  /** And it finds before it creates, so a pile the reader made keeps `"user"` however many cards
   *  the app later files into it — `category_for_name`'s own rule, and the case a name-matching
   *  drawing rule gets wrong. */
  it("files into a pile the reader made rather than making a second", () => {
    const db = boundary();
    const w = writeHandlers(db);
    const mine = w.deck_category_create({ deckId: 1, name: "Ramp" });
    expect(mine.origin).toBe("user");

    w.collection_to_deck({ entryId: 1, deckId: 1, categoryName: "Ramp", quantity: 1 });

    expect(db.deckCategories.filter((c) => c.deckId === 1 && c.name === "Ramp")).toHaveLength(1);
    expect(db.deckCategories.find((c) => c.id === mine.id)!.origin).toBe("user");
    expect(db.deckCards.filter((dc) => dc.categoryId === mine.id).map((dc) => dc.cardId)).toEqual([
      BOLT.id,
    ]);
  });

  /** The id and the name are alternatives and exactly one must arrive: `deck_add_card` lets the
   *  id win because a drag carries both, and nothing sends both here — so both is a caller that
   *  has lost track of which it meant, refused in words rather than silently preferred. */
  it("refuses a pile named and pointed at together, and neither at all", () => {
    const db = boundary();
    const w = writeHandlers(db);
    expect(() =>
      w.collection_to_deck({
        entryId: 1,
        deckId: 1,
        categoryId: categoryId(1, "main"),
        categoryName: "Ramp",
        quantity: 1,
      }),
    ).toThrow(/one pile/);
    expect(() => w.collection_to_deck({ entryId: 1, deckId: 1, quantity: 1 })).toThrow(
      /needs a category/,
    );
    expect(copiesIn(db, null)).toBe(4);
    expect(db.deckCategories.some((c) => c.name === "Ramp")).toBe(false);
  });

  it("refuses a deck with no folder to hold its cards", () => {
    const db = boundary();
    db.collectionFolders = db.collectionFolders.filter((f) => f.deckId !== 1);
    expect(() =>
      writeHandlers(db).collection_to_deck({
        entryId: 1,
        deckId: 1,
        categoryId: categoryId(1, "main"),
        quantity: 1,
      }),
    ).toThrow(/no folder to hold its cards/);
  });

  /**
   * **A refused filing by name leaves no pile behind** —
   * `collection_alloc::a_refused_filing_by_name_leaves_no_pile_behind`, mirrored.
   *
   * The name arm has to be resolved *before* the refusals below it, because the history row this
   * write files names the pile the card went into. In the crate that is free: the create is
   * inside the move's own transaction, so a refusal that lands after it takes the invented pile
   * with it. The fake has no transaction, so it has to undo the one write by hand — and without
   * that it shows a state the backend cannot produce, which is the class of defect this feature
   * has already shipped once.
   *
   * Driven through `NOT_THAT_MANY`, the refusal a reader actually meets: they asked for more
   * copies than the row holds and would otherwise be left with an empty column they never made.
   */
  it("leaves no pile behind when a filing by name is refused", () => {
    const db = boundary();
    const before = db.deckCategories.length;

    expect(() =>
      writeHandlers(db).collection_to_deck({
        entryId: 1,
        deckId: 1,
        categoryName: "Ramp",
        quantity: 99,
      }),
    ).toThrow(/that many/);

    expect(db.deckCategories.some((c) => c.deckId === 1 && c.name === "Ramp")).toBe(false);
    expect(db.deckCategories).toHaveLength(before);
  });

  /** And the pile the reader already had is **not** swept up with it: the name arm finds before
   *  it creates, so a refusal after a *find* has nothing to undo. */
  it("keeps a pile the reader made when a filing by name is refused", () => {
    const db = boundary();
    const w = writeHandlers(db);
    const mine = w.deck_category_create({ deckId: 1, name: "Ramp" });

    expect(() =>
      w.collection_to_deck({ entryId: 1, deckId: 1, categoryName: "Ramp", quantity: 99 }),
    ).toThrow(/that many/);

    expect(db.deckCategories.find((c) => c.id === mine.id)).toBeDefined();
  });

  it("files what the deck's group held into Recently removed when the card is cut", () => {
    const db = boundary();
    const w = writeHandlers(db);
    w.collection_to_deck({ entryId: 1, deckId: 1, categoryId: categoryId(1, "main"), quantity: 2 });
    const dc = db.deckCards.find((row) => row.deckId === 1)!;

    const out = w.deck_to_collection({ deckCardId: dc.id, quantity: 2 });

    expect(out).toMatchObject({ fromDeck: null, quantity: 2 });
    expect(copiesIn(db, REMOVED_FOLDER)).toBe(2);
    expect(copiesIn(db, groupId(1))).toBe(0);
    // The row the deck started with survives the cut, holding a copy nobody owns: cutting two
    // took the two that were filed and the list is what the reader still wants.
    expect(listed(db, 1)).toBe(1);
  });

  /**
   * **A cut reaches the copies when the list names another printing**, which is the state
   * `deck_swap_printing` leaves behind — it rewrites the deck row's `cardId` and touches no
   * collection table — and the state schema v25's conversion writes wholesale, because the old
   * allocator matched candidates by **oracle id**. Matched on the exact printing alone the cut
   * moves nothing: the deck card goes and the copies stay filed under a deck that no longer
   * lists them. `deck::release_group_copies` matches the oracle card, which is
   * `owned_by_oracle`'s "a Bolt is a Bolt" read from the other end.
   */
  it("cuts through to another printing of the same card in the group", () => {
    const db = boundary({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 2, folderId: groupId(1) })],
      deckCards: [deckCard({ id: 1, cardId: BOLT_2X2.id, categoryKind: "main", quantity: 2 })],
    });

    const out = writeHandlers(db).deck_to_collection({ deckCardId: 1, quantity: 2 });

    expect(out.quantity).toBe(2);
    expect(copiesIn(db, REMOVED_FOLDER)).toBe(2);
    expect(copiesIn(db, groupId(1))).toBe(0);
  });

  /**
   * And the fallback is a fallback: where the group holds the very printing the list names, that
   * is the row that leaves and the reader's other copy stays where they put it. This is what
   * keeps every cut of a card nobody ever swapped exactly what it was.
   */
  it("takes the exact printing before another of the same card", () => {
    const db = boundary({
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, quantity: 1, folderId: groupId(1) }),
        entry({ id: 2, cardId: BOLT_2X2.id, quantity: 1, folderId: groupId(1) }),
      ],
      deckCards: [deckCard({ id: 1, cardId: BOLT_2X2.id, categoryKind: "main", quantity: 1 })],
    });

    writeHandlers(db).deck_to_collection({ deckCardId: 1, quantity: 1 });

    const inRemoved = db.collectionEntries.filter((e) => e.folderId === REMOVED_FOLDER);
    expect(inRemoved.map((e) => e.cardId)).toEqual([BOLT_2X2.id]);
    expect(copiesIn(db, groupId(1))).toBe(1);
  });

  /**
   * Added from search as "I need to buy this". There is no backing copy, so nothing lands on the
   * reader's desk — and this is the whole reason no per-deck-card provenance flag is needed: the
   * group **is** the provenance record.
   */
  it("makes a deck card nobody owned just go away", () => {
    // Neither cabinet seeded: no copies, and no list row either — the deck's whole list is what
    // the search add below writes, which is exactly the provenance this test is about.
    const db = boundary({ collectionEntries: [], deckCards: [] });
    const w = writeHandlers(db);
    w.deck_add_card({
      deckId: 1,
      cardId: BOLT.id,
      categoryId: categoryId(1, "main"),
      categoryName: null,
      variant: "live",
      quantity: 1,
    });
    const dc = db.deckCards.find((row) => row.deckId === 1)!;

    const out = w.deck_to_collection({ deckCardId: dc.id, quantity: 1 });

    expect(out).toEqual({ entryId: null, fromDeck: null, deckCardId: null, quantity: 0 });
    expect(db.collectionEntries).toHaveLength(0);
    expect(db.deckCards).toHaveLength(0);
  });

  it("reports what actually moved when the list wants more than the group holds", () => {
    const db = boundary();
    const w = writeHandlers(db);
    w.collection_to_deck({ entryId: 1, deckId: 1, categoryId: categoryId(1, "main"), quantity: 1 });
    // An import writes a list without moving copies, so the two can disagree — and a cut must
    // not refuse over a disagreement it did not cause.
    db.deckCards.find((row) => row.deckId === 1)!.quantity = 3;

    const out = w.deck_to_collection({ deckCardId: db.deckCards[0].id, quantity: 3 });

    expect(out.quantity).toBe(1);
    expect(copiesIn(db, REMOVED_FOLDER)).toBe(1);
    // Deck A's, not the whole table's: Deck B's own row is {@link boundary}'s baseline and this
    // press never named it.
    expect(db.deckCards.filter((row) => row.deckId === 1)).toHaveLength(0);
  });

  it("refuses a theory row: a plan holds no cards", () => {
    const db = boundary();
    const w = writeHandlers(db);
    w.deck_add_card({
      deckId: 1,
      cardId: BOLT.id,
      categoryId: categoryId(1, "main"),
      categoryName: null,
      variant: "theory",
      quantity: 1,
    });
    const dc = db.deckCards.find((row) => row.variant === "theory")!;
    expect(() => w.deck_to_collection({ deckCardId: dc.id, quantity: 1 })).toThrow(
      /a plan holds no cards/,
    );
  });

  it("refuses a deck card that is not there, and a quantity of none or too many", () => {
    const db = boundary();
    const w = writeHandlers(db);
    expect(() => w.deck_to_collection({ deckCardId: 404, quantity: 1 })).toThrow(
      /not in this deck any more/,
    );
    w.collection_to_deck({ entryId: 1, deckId: 1, categoryId: categoryId(1, "main"), quantity: 1 });
    // Two on the row now — the deck's own copy and the one just filed — so three is what asks
    // for more than the list holds.
    const dc = db.deckCards.find((row) => row.deckId === 1)!;
    expect(dc.quantity).toBe(2);
    expect(() => w.deck_to_collection({ deckCardId: dc.id, quantity: 0 })).toThrow(/at least one/);
    expect(() => w.deck_to_collection({ deckCardId: dc.id, quantity: 3 })).toThrow(
      /not that many copies/i,
    );
  });

  /**
   * **The history the pair writes**, and neither row is a shape of its own: filing a card into a
   * deck from the collection is an *add*, cutting one is a *removal*, and a reader cannot see
   * which command ran. So `collection_to_deck` writes `deck::add_card`'s row and
   * `deck_to_collection` writes `deck::set_card_quantity`'s — same kinds, same payload keys,
   * same signed `delta` — which is what lets `auditText.ts` word both with no new arm.
   *
   * `collection_alloc.rs` gained the add row on 2026-08-23, and this is that write mirrored.
   * The cut's has been there since v25; it was missing **here** the whole time, and a fake that
   * recorded only the add would have drawn a Collection Search press in the drawer with the cut
   * that reverses it missing.
   */
  it("records the add and the removal deck_add_card and the stepper would have", () => {
    const db = boundary();
    const w = writeHandlers(db);
    w.collection_to_deck({ entryId: 1, deckId: 1, categoryId: categoryId(1, "main"), quantity: 2 });

    const add = db.deckAudit[db.deckAudit.length - 1];
    expect(add).toMatchObject({ deckId: 1, kind: "add", variant: "live", cardName: BOLT.name });
    // The copies **added**, never the total the row landed on: `delta` is what the day header
    // adds up, so a fold from 2 to 3 is one copy of history and not three.
    expect(add.delta).toBe(2);
    expect(JSON.parse(add.payload)).toEqual({ category: "Main deck", quantity: 2 });

    // Part of the row: the stepper's `quantity` shape, `from` and `to` rather than a count. The
    // row holds three — {@link boundary}'s baseline copy and the two this press filed — so the
    // step is 3 → 2 and `delta` is still the one copy that left.
    const dc = db.deckCards.find((row) => row.deckId === 1)!;
    w.deck_to_collection({ deckCardId: dc.id, quantity: 1 });
    const part = db.deckAudit[db.deckAudit.length - 1];
    expect(part).toMatchObject({ kind: "quantity", delta: -1 });
    expect(JSON.parse(part.payload)).toEqual({ category: "Main deck", from: 3, to: 2 });

    // The whole of it: a `remove`, and `reason` is null because where the copies went is a
    // standing fact about every cut on this list rather than something true of this row. The
    // group has only one copy left to give back, and the row still quotes what the **list**
    // held — `held` and never `moved`.
    w.deck_to_collection({ deckCardId: dc.id, quantity: 2 });
    const whole = db.deckAudit[db.deckAudit.length - 1];
    expect(whole).toMatchObject({ kind: "remove", delta: -2 });
    expect(JSON.parse(whole.payload)).toEqual({
      category: "Main deck",
      quantity: 2,
      reason: null,
    });
  });

  /**
   * **The *source* deck's own history, which was a hole this pair opened.** Taking a copy out of
   * another deck decrements that deck's live list — the whole of `fromDeck` — and recorded
   * nothing there until 2026-08-23. The reader is told once, in a dialog sentence that dies with
   * the dialog, and then opens Deck A a week later to find the card simply gone.
   *
   * **One row per `deckCards` row decremented, in the stepper's two shapes.** The walk can span
   * two piles of one deck, so there is no single row a summary could name; the seed puts the Bolt
   * in two piles precisely because that is the case one row cannot describe.
   */
  it("records the source deck's loss, one row per pile it took from", () => {
    const db = boundary({
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 4, folderId: groupId(1) })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 2 }),
        deckCard({ id: 2, cardId: BOLT.id, categoryKind: "side", quantity: 2 }),
        // The destination has to play the card too — issue #358's fence — and this fixture
        // replaces {@link boundary}'s whole `deckCards` array, so Deck B's baseline row is
        // written out here rather than inherited.
        deckCard({ id: 3, deckId: 2, cardId: BOLT.id, categoryKind: "main", quantity: 1 }),
      ],
    });

    writeHandlers(db).collection_to_deck({
      entryId: 1,
      deckId: 2,
      categoryId: categoryId(2, "main"),
      quantity: 3,
    });

    const lost = db.deckAudit.filter((a) => a.deckId === 1);
    expect(lost.map((a) => [a.kind, a.delta])).toEqual([
      ["remove", -2],
      ["quantity", -1],
    ]);
    expect(JSON.parse(lost[0].payload)).toEqual({
      category: "Main deck",
      quantity: 2,
      reason: null,
    });
    expect(JSON.parse(lost[1].payload)).toEqual({ category: "Sideboard", from: 2, to: 1 });
    // The deck the copies went *to* keeps its own single `add`: two logs describing one press
    // from its two ends, neither a summary of the other.
    expect(db.deckAudit.filter((a) => a.deckId === 2).map((a) => a.kind)).toEqual(["add"]);
  });

  /**
   * **The `deckCards` row the filing wrote, answered back** — the only thing a caller has to
   * point at, because an owned add lands a row the editor has never seen and the `ON CONFLICT`
   * arm makes the id underivable from the arguments. The second press is the half worth pinning:
   * it inserts nothing, so a fake reading `nextId` would answer a row that does not exist.
   *
   * **Filed into the Sideboard rather than the main pile**, which is what still makes the insert
   * arm reachable at all under issue #358's fence: the deck has to already play the card, and
   * {@link boundary} makes it play it on `main` — so a filing into that pile could only ever
   * fold. The fence is about the **deck**, the pile is about where the copies go, and this is
   * the press that tells the two apart.
   */
  it("answers the deck card it wrote, through both arms", () => {
    const db = boundary();
    const w = writeHandlers(db);
    const first = w.collection_to_deck({
      entryId: 1,
      deckId: 1,
      categoryId: categoryId(1, "side"),
      quantity: 1,
    });
    const written = db.deckCards.find((row) => row.categoryId === categoryId(1, "side"))!;
    expect(first.deckCardId).toBe(written.id);

    const rootRow = db.collectionEntries.find((e) => e.folderId === null)!;
    const again = w.collection_to_deck({
      entryId: rootRow.id,
      deckId: 1,
      categoryId: categoryId(1, "side"),
      quantity: 1,
    });
    expect(again.deckCardId).toBe(first.deckCardId);
    // Two rows on this deck and not three: the one it started with, and the one both presses
    // landed on.
    expect(db.deckCards.filter((row) => row.deckId === 1)).toHaveLength(2);
  });

  /**
   * **A cut is recorded even when nothing moved.** A deck card nobody owned still *left the
   * deck*, and the history is a record of the deck rather than of the collection — so the row
   * quotes what the list held, not what the group gave back.
   */
  it("records a cut of a card nobody owned, which moved nothing", () => {
    // Both cabinets empty, for the reason "makes a deck card nobody owned just go away" states.
    const db = boundary({ collectionEntries: [], deckCards: [] });
    const w = writeHandlers(db);
    w.deck_add_card({
      deckId: 1,
      cardId: BOLT.id,
      categoryId: categoryId(1, "main"),
      categoryName: null,
      variant: "live",
      quantity: 1,
    });
    const dc = db.deckCards.find((row) => row.deckId === 1)!;

    const out = w.deck_to_collection({ deckCardId: dc.id, quantity: 1 });

    expect(out.quantity).toBe(0);
    expect(db.deckAudit[db.deckAudit.length - 1]).toMatchObject({ kind: "remove", delta: -1 });
  });

  /**
   * **Neither files an undo step, and that is a decision.** Each moves copies across the deck
   * boundary; `deck_undo` restores `deck_cards` cells and its primitives touch no collection
   * table, so the only step available would put the list back and leave the copies where they
   * went — a deck claiming cards its own group no longer holds, told to a reader who pressed
   * Ctrl+Z and watched the row reappear. Both are on `NO_UNDO_STEP` for that, rather than
   * slipping through {@link journalled} because their arguments happen not to carry a deck id.
   *
   * Read through `allHandlers`, because the wrapper is what would file the step — `writeHandlers`
   * alone could not tell a decision from an omission.
   */
  it("files no undo step either way, so the cursor still names the press before", () => {
    const db = boundary();
    const h = allHandlers(db);
    h.deck_add_card({
      deckId: 1,
      cardId: BOLT_2X2.id,
      categoryId: categoryId(1, "main"),
      categoryName: null,
      variant: "live",
      quantity: 1,
    });
    h.deck_update({ id: 1, patch: { name: "Renamed" } });
    const before = db.deckUndo.length;
    const cursor = h.deck_undo_state({ deckId: 1, redoId: null }).undo!.id;

    h.collection_to_deck({ entryId: 1, deckId: 1, categoryId: categoryId(1, "main"), quantity: 1 });
    const dc = db.deckCards.find((row) => row.cardId === BOLT.id)!;
    h.deck_to_collection({ deckCardId: dc.id, quantity: 1 });

    // Two history rows written, and not one step behind them.
    expect(db.deckUndo).toHaveLength(before);
    expect(h.deck_undo_state({ deckId: 1, redoId: null }).undo!.id).toBe(cursor);
  });

  /**
   * Exclusivity read from the collection's own end: `allocation: "unallocated"` drops the copies
   * a **deck** is holding and nothing else, so the only copy stops being available the moment it
   * is filed into a group — with no ledger consulted and nothing to recompute.
   */
  it("takes a copy out of the unallocated list by moving it, and puts it back by cutting it", () => {
    const db = boundary({ collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 1 })] });
    const w = writeHandlers(db);
    const free = () =>
      (
        readHandlers(db).collection_list({
          query: { limit: 10, offset: 0, allocation: "unallocated" },
        }) as CollectionPage
      ).items.reduce((n, row) => n + row.quantity, 0);
    expect(free()).toBe(1);

    w.collection_to_deck({ entryId: 1, deckId: 1, categoryId: categoryId(1, "main"), quantity: 1 });
    expect(free()).toBe(0);

    // `Recently removed` is on the spare side deliberately: a card that left a deck without
    // leaving the database is back on the reader's desk.
    w.deck_to_collection({ deckCardId: db.deckCards[0].id, quantity: 1 });
    expect(free()).toBe(1);
  });

  /**
   * **The other two callers of the same walk**, and until 2026-08-23 this fake had neither:
   * `deck_category_clear` and `deck_category_delete` took whole piles of `deck_cards` out and
   * released **no** copies at all, where the crate files every one of them into
   * `Recently removed` through `deck::release_group_copies`. It was noted in PR 3's review,
   * deliberately not widened then, and closed here because Bucket F was already in the file.
   *
   * The state it left behind is the feature's central invariant broken quietly — *a copy in a
   * deck's group is backed by a deck card in that deck* — so a Storybook world that cleared a
   * pile went on drawing those copies under a folder for a pile that was gone, and no other
   * deck could ever have them.
   */
  describe("the pile writes release their copies too", () => {
    /** One deck, four Bolts filed into its group — folded onto the main-pile row
     *  {@link boundary} gives it, so the list says **five** where the group holds four. */
    const filled = (over: Partial<FakeDb> = {}) => {
      const db = boundary(over);
      writeHandlers(db).collection_to_deck({
        entryId: 1,
        deckId: 1,
        categoryId: categoryId(1, "main"),
        quantity: 4,
      });
      return db;
    };

    it("files a cleared pile's copies into Recently removed", () => {
      const db = filled();
      expect(copiesIn(db, groupId(1))).toBe(4);

      const cleared = writeHandlers(db).deck_category_clear({
        deckId: 1,
        categoryId: categoryId(1, "main"),
        variant: "live",
      });

      // The answer is still `deck_cards` copies, never the copies that moved — what the
      // confirmation quoted is what left the deck. **Five against four**, which is the whole of
      // that sentence made visible: the list held one copy nobody owned beside the four the
      // group did, and only the four came back.
      expect(cleared).toBe(5);
      expect(copiesIn(db, groupId(1))).toBe(0);
      expect(copiesIn(db, REMOVED_FOLDER)).toBe(4);
    });

    /** A plan holds no cards, so there is nothing in any folder behind a theory row — the
     *  refusal `deck_to_collection` makes one card at a time is simply an empty loop here. */
    it("moves nothing when the pile being cleared is the plan", () => {
      const db = filled();
      writeHandlers(db).deck_add_card({
        deckId: 1,
        cardId: BOLT.id,
        categoryId: categoryId(1, "main"),
        categoryName: null,
        variant: "theory",
        quantity: 2,
      });

      writeHandlers(db).deck_category_clear({
        deckId: 1,
        categoryId: categoryId(1, "main"),
        variant: "theory",
      });

      expect(copiesIn(db, groupId(1))).toBe(4);
      expect(copiesIn(db, REMOVED_FOLDER)).toBe(0);
    });

    it("files a deleted category's copies away when the cards go with it", () => {
      const db = filled();

      writeHandlers(db).deck_category_delete({
        id: categoryId(1, "main"),
        moveToCategoryId: null,
      });

      expect(copiesIn(db, groupId(1))).toBe(0);
      expect(copiesIn(db, REMOVED_FOLDER)).toBe(4);
    });

    /** **And the move arm releases nothing**, which is the half a blanket release would get
     *  wrong: those cards are still in this deck, one pile over, so the group is still exactly
     *  where their copies belong. */
    it("leaves the copies alone when the cards are re-filed into another pile", () => {
      const db = filled();

      writeHandlers(db).deck_category_delete({
        id: categoryId(1, "main"),
        moveToCategoryId: categoryId(1, "side"),
      });

      expect(copiesIn(db, groupId(1))).toBe(4);
      expect(copiesIn(db, REMOVED_FOLDER)).toBe(0);
    });

    /**
     * The oracle arm, in bulk. `deck_swap_printing` rewrites a deck row's identity and touches
     * no collection table, so after "Use this printing" the group holds the *old* printing —
     * matched exactly, a cleared pile would strand every copy behind it.
     */
    it("reaches another printing of the same card when the pile is cleared", () => {
      const db = boundary({
        collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 2, folderId: groupId(1) })],
        deckCards: [deckCard({ id: 1, cardId: BOLT_2X2.id, categoryKind: "main", quantity: 2 })],
      });

      writeHandlers(db).deck_category_clear({
        deckId: 1,
        categoryId: categoryId(1, "main"),
        variant: "live",
      });

      expect(copiesIn(db, groupId(1))).toBe(0);
      expect(copiesIn(db, REMOVED_FOLDER)).toBe(2);
    });
  });
});

/**
 * `deck_clear` — the pile clear above with one filter dropped, so these are the same questions
 * asked of the whole list.
 *
 * **Every assertion here has something outside its scope to be wrong about**, which is the only
 * way this shape of command can be tested: a handler that cleared both variants, or both decks,
 * or the categories along with the cards, passes every assertion made purely about what went
 * away. So the fixture carries a `theory` row, a second deck and five categories that must all
 * still be standing afterwards.
 */
describe("deck_clear", () => {
  /** Copies in one folder. The boundary suite above declares its own; this describe is not
   *  inside it, and a clear is not a move. */
  const copiesIn = (db: FakeDb, folderId: number | null) =>
    db.collectionEntries
      .filter((e) => e.folderId === folderId)
      .reduce((n, e) => n + e.quantity, 0);

  /**
   * Two decks with their categories and their groups. Deck 1 lists **six** live copies over
   * three rows in two piles — two printings of one card, which is what makes copies and rows
   * different numbers — plus seven in the plan; its group holds exactly the six the live list
   * claims, which is the state a reader who filed their cards into the deck is in. Deck 2 lists
   * four of its own.
   */
  const listed = () =>
    makeDeckDb({
      decks: [deck({ id: 1, name: "Deck A" }), deck({ id: 2, name: "Deck B" })],
      collectionEntries: [
        entry({ id: 1, cardId: BOLT.id, quantity: 3, folderId: groupId(1) }),
        entry({ id: 2, cardId: BOLT_2X2.id, quantity: 3, folderId: groupId(1) }),
      ],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 2 }),
        deckCard({ id: 2, cardId: BOLT_2X2.id, categoryKind: "main", quantity: 3 }),
        deckCard({ id: 3, cardId: BOLT.id, categoryKind: "side", quantity: 1 }),
        deckCard({ id: 4, cardId: BOLT.id, categoryKind: "main", variant: "theory", quantity: 7 }),
        deckCard({ id: 5, deckId: 2, cardId: BOLT.id, categoryKind: "main", quantity: 4 }),
      ],
    });

  /** The scope, from all three sides at once: every pile of this deck's `live` list goes, and
   *  the plan beside it and the other deck's list are untouched. */
  it("empties every pile of one variant and leaves the other list and the other deck alone", () => {
    const db = listed();

    writeHandlers(db).deck_clear({ deckId: 1, variant: "live" });

    expect(db.deckCards.map((dc) => dc.id)).toEqual([4, 5]);
    expect(db.deckCards.find((dc) => dc.id === 4)!.quantity).toBe(7);
    expect(db.deckCards.find((dc) => dc.id === 5)!.quantity).toBe(4);
  });

  /** **The piles survive**, which is the whole difference between this and `deck_delete` — and
   *  the assertion is the rows themselves rather than a count, because a handler that rebuilt
   *  the five defaults would answer 5 to a count and have thrown the reader's work away. */
  it("leaves the deck's categories standing", () => {
    const db = listed();
    const before = db.deckCategories.map((c) => ({ ...c }));

    writeHandlers(db).deck_clear({ deckId: 1, variant: "live" });

    expect(db.deckCategories).toEqual(before);
  });

  /** Copies, not rows: three rows holding 2, 3 and 1 is the **6** the confirmation quoted. */
  it("answers the copies it removed rather than the rows", () => {
    const db = listed();

    expect(writeHandlers(db).deck_clear({ deckId: 1, variant: "live" })).toBe(6);
  });

  /**
   * A `deck_cards` row is an intention and a row in the deck's group is a card the reader
   * physically owns — so the copies come back rather than staying filed under a list that has
   * stopped naming them. Asserted against the same two folders the pile clear's tests use.
   */
  it("files a cleared live list's copies into Recently removed", () => {
    const db = listed();
    expect(copiesIn(db, groupId(1))).toBe(6);

    writeHandlers(db).deck_clear({ deckId: 1, variant: "live" });

    expect(copiesIn(db, groupId(1))).toBe(0);
    expect(copiesIn(db, REMOVED_FOLDER)).toBe(6);
  });

  /** A plan holds no cards, so there is nothing behind a theory row in any folder to give
   *  back — and the group keeps its six even though seven copies just left the list. */
  it("moves nothing when the list being cleared is the plan", () => {
    const db = listed();

    expect(writeHandlers(db).deck_clear({ deckId: 1, variant: "theory" })).toBe(7);

    expect(copiesIn(db, groupId(1))).toBe(6);
    expect(copiesIn(db, REMOVED_FOLDER)).toBe(0);
  });

  /** **An empty list writes nothing at all**, `updatedAt` included: the handler returns before
   *  opening a transaction, where `deck_set_card_quantity`'s zero arm commits whatever it
   *  found. The deck's stamp is the assertion that separates the two. */
  it("answers 0 for an empty list and moves nothing, the deck's own stamp included", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 3, folderId: groupId(1) })],
      deckCards: [deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", variant: "theory" })],
    });
    const stamped = db.decks[0].updatedAt;

    expect(writeHandlers(db).deck_clear({ deckId: 1, variant: "live" })).toBe(0);

    expect(db.decks[0].updatedAt).toBe(stamped);
    expect(db.deckCards).toHaveLength(1);
    expect(copiesIn(db, groupId(1))).toBe(3);
    expect(copiesIn(db, REMOVED_FOLDER)).toBe(0);
  });

  /** The busy sweep below walks this handler too; asserted here as well because the sweep
   *  proves *a* write refuses and this proves it is this one — and everything after the door
   *  in this command moves the reader's cards. */
  it("refuses while a sync holds the write lock", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1 })], fault: "busy" });

    expect(() => writeHandlers(db).deck_clear({ deckId: 1, variant: "live" })).toThrow(/busy/i);
  });

  /** The deck has to exist, and the check is at the top with the other two — a clear aimed at a
   *  deck another view deleted is not a clear that quietly succeeds over no rows. */
  it("refuses a deck that is not there", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1 })] });

    expect(() => writeHandlers(db).deck_clear({ deckId: 99, variant: "live" })).toThrow();
  });
});

describe("collection_import_commit", () => {
  it("accumulates a repeated grain and counts added versus updated", () => {
    const db = makeDb();
    const items: CollectionImportItem[] = [
      { cardId: BOLT.id, finish: "nonfoil", quantity: 2 },
      // Two lines, one grain: the file named the same printing twice and the copies add up.
      { cardId: BOLT.id, finish: "nonfoil", quantity: 3 },
    ];
    const out = writeHandlers(db).collection_import_commit({ items, mode: "add" });
    expect(out).toEqual({ added: 1, updated: 1, removed: 0 });
    expect(db.collectionEntries).toHaveLength(1);
    expect(db.collectionEntries[0].quantity).toBe(5);
  });

  /**
   * **A `set` of 0 deletes the row**, which is `collection_set_quantity`'s schema v24 reversal
   * reached from a file rather than from the stepper — `wishlist_import_commit` has done the same
   * one table over since v23, and `removed` was that command's alone and a hard 0 here until the
   * collection followed.
   */
  it("deletes a row a set line takes to zero, and counts it as removed", () => {
    const db = makeDb({ collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 4 })] });
    const out = writeHandlers(db).collection_import_commit({
      items: [{ cardId: BOLT.id, finish: "nonfoil", quantity: 0 }],
      mode: "set",
    });
    expect(out).toEqual({ added: 0, updated: 0, removed: 1 });
    expect(db.collectionEntries).toHaveLength(0);
  });

  /**
   * **An import line lands on its own grain, not on the plain one** — the fake's half of the fold
   * `collection::commit_import` does, and the six grain columns were dropped from this map while
   * `CollectionImportItem` already carried them. A file describing an altered copy therefore
   * folded into the plain row here and into its own row in the app, and a re-import could never
   * add to the reader's altered row: it wrote an anonymous twin beside it.
   *
   * One altered line and one plain line for the same printing is the cheapest seed where the two
   * answers differ — two rows if the column is carried, one folded row of three copies if it is
   * not.
   */
  it("keeps an altered import line off the plain grain", () => {
    const db = makeDb();
    const items: CollectionImportItem[] = [
      { cardId: BOLT.id, finish: "nonfoil", quantity: 1 },
      { cardId: BOLT.id, finish: "nonfoil", quantity: 2, altered: true },
    ];

    const out = writeHandlers(db).collection_import_commit({ items, mode: "add" });

    expect(out).toEqual({ added: 2, updated: 0, removed: 0 });
    expect(db.collectionEntries.map((e) => [e.altered, e.quantity])).toEqual([
      [false, 1],
      [true, 2],
    ]);
  });

  it("is all or nothing: one line it cannot land leaves the collection as it was", () => {
    const db = makeDb();
    const items: CollectionImportItem[] = [
      { cardId: BOLT.id, finish: "nonfoil", quantity: 1 },
      // A finish no CHECK will take. A half-imported collection is worse than a refused one.
      { cardId: BOLT.id, finish: "glitter" as Finish, quantity: 1 },
    ];
    expect(() => writeHandlers(db).collection_import_commit({ items, mode: "add" })).toThrow(
      /not a finish/,
    );
    expect(db.collectionEntries).toHaveLength(0);
  });

  it("refuses an unknown mode rather than defaulting it, and writes nothing", () => {
    const db = makeDb();
    expect(() =>
      writeHandlers(db).collection_import_commit({
        items: [{ cardId: BOLT.id, finish: "nonfoil", quantity: 1 }],
        mode: "replace" as TransferImportMode,
      }),
    ).toThrow(/not an import mode/);
    expect(db.collectionEntries).toHaveLength(0);
  });

  /**
   * **A deck import files the whole file into that deck's group; every other import lands at the
   * root.** The command hard-coded the root until 2026-08-23, so ticking "Add cards to
   * collection" on a deck import left the deck reading *missing* on every line the reader had
   * just said they own, with every other deck still free to claim the copies.
   *
   * The assertion is the **folder column**, never the counts: a root import and a group import
   * both answer `added: 1`, which is exactly why the counters that were already tested could not
   * see it. The second half imports the same line with no folder — the folder is the eleventh
   * term of the grain, so it is a second row rather than four more copies.
   */
  it("files a deck import into that deck's group, and everything else at the root", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1, name: "Deck A" })] });
    const line: CollectionImportItem[] = [{ cardId: BOLT.id, finish: "nonfoil", quantity: 4 }];
    const w = writeHandlers(db);

    w.collection_import_commit({ items: line, mode: "add", folderId: groupId(1) });
    expect(db.collectionEntries.map((e) => e.folderId)).toEqual([groupId(1)]);

    w.collection_import_commit({ items: line, mode: "add" });
    expect(db.collectionEntries.map((e) => [e.folderId, e.quantity])).toEqual([
      [groupId(1), 4],
      [null, 4],
    ]);
  });

  /**
   * **The widened fence is widened by exactly one kind**, and both refusals land before anything
   * is written. `Recently removed` is where copies go when they *leave* a deck, so a file naming
   * it would be an import that arrives already discarded; a binder is still a destination, which
   * is what keeps this a fence about the *kind* rather than a list of two ids.
   */
  it("still refuses a folder that is gone or is the holding area", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1, name: "Deck A" })] });
    const line: CollectionImportItem[] = [{ cardId: BOLT.id, finish: "nonfoil", quantity: 1 }];
    const w = writeHandlers(db);

    expect(() => w.collection_import_commit({ items: line, mode: "add", folderId: 404 })).toThrow(
      /not there any more/,
    );
    expect(() =>
      w.collection_import_commit({ items: line, mode: "add", folderId: REMOVED_FOLDER }),
    ).toThrow(/the app's own/);
    expect(db.collectionEntries).toHaveLength(0);

    db.collectionFolders.push({
      id: 7,
      parentId: null,
      name: "Binder",
      kind: "user",
      deckId: null,
      sortOrder: 9,
    });
    w.collection_import_commit({ items: line, mode: "add", folderId: 7 });
    expect(db.collectionEntries.map((e) => e.folderId)).toEqual([7]);
  });
});

describe("wishlist_import_commit", () => {
  it("accumulates a repeated grain and counts added versus updated", () => {
    const db = makeDb();
    const items: WishlistImportItem[] = [
      { oracleId: BOLT.oracleId!, quantity: 2 },
      { oracleId: BOLT.oracleId!, quantity: 1 },
    ];
    const out = writeHandlers(db).wishlist_import_commit({ items, mode: "add" });
    expect(out).toEqual({ added: 1, updated: 1, removed: 0 });
    expect(db.wishlistEntries).toHaveLength(1);
    expect(db.wishlistEntries[0].quantity).toBe(3);
  });

  it("is all or nothing: one line it cannot land leaves the wishlist as it was", () => {
    const db = makeDb();
    const items: WishlistImportItem[] = [
      { oracleId: BOLT.oracleId!, quantity: 1 },
      { oracleId: BOLT.oracleId!, quantity: 1, preferredFinish: "glitter" as Finish },
    ];
    expect(() => writeHandlers(db).wishlist_import_commit({ items, mode: "add" })).toThrow(
      /not a finish/,
    );
    expect(db.wishlistEntries).toHaveLength(0);
  });

  it("refuses an unknown mode rather than defaulting it, and writes nothing", () => {
    const db = makeDb();
    expect(() =>
      writeHandlers(db).wishlist_import_commit({
        items: [{ oracleId: BOLT.oracleId!, quantity: 1 }],
        mode: "replace" as TransferImportMode,
      }),
    ).toThrow(/not an import mode/);
    expect(db.wishlistEntries).toHaveLength(0);
  });

  /**
   * The trap `removed` being counted explicitly (rather than derived from a row-count delta)
   * exists for: one line creates a row and another zeroes an existing one, in the same `set`
   * call. A before/after row count alone would cancel these two events out and report neither.
   *
   * Expected by hand: before the import, 1 wish exists (the any-printing one seeded via
   * `wishlist_add`). The first item names that exact grain (`oracleId`, no `cardId`) at
   * quantity `0` — `add_wish`'s own fold (which never subtracts) leaves the row momentarily
   * higher, and the immediate `set` to `0` deletes it: `removed` becomes `1`, row count drops by
   * one. The second item names a different grain (pinned to `BOLT.id`) that does not exist yet,
   * so it is created and then `set` to `5` — a real net-new row, row count rises by one. Net row
   * count is therefore unchanged (1 → 1), which is exactly the case that would read as "nothing
   * happened" without the explicit counter: `added = (after - before) + removed = (1 - 1) + 1 =
   * 1`, `removed = 1`, `updated = items.length - added - removed = 2 - 1 - 1 = 0`.
   */
  it("counts a mixed set import: one new row, one deleted, none merely updated", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    w.wishlist_add({ wish: { oracleId: BOLT.oracleId!, quantity: 2 } });
    const out = w.wishlist_import_commit({
      items: [
        // Same grain as the seeded wish (any printing): zeroed by this line.
        { oracleId: BOLT.oracleId!, quantity: 0 },
        // A different grain (pinned to a printing): a genuinely new row.
        { oracleId: BOLT.oracleId!, cardId: BOLT.id, quantity: 5 },
      ],
      mode: "set",
    });
    expect(out).toEqual({ added: 1, updated: 0, removed: 1 });
    // The any-printing wish is gone and only the pinned one remains — not an id check, because
    // `nextId` derives from the array's current contents and reuses the id the delete freed.
    expect(db.wishlistEntries).toHaveLength(1);
    expect(db.wishlistEntries[0]).toMatchObject({ cardId: BOLT.id, quantity: 5 });
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
   *
   * **A pile this path creates is `origin: "auto"`** — the app asked for it while filing a card
   * — which is the fact `grouping.ts` reads to hide it again once it is empty.
   */
  it("finds or creates a main category by name, and refuses neither an id nor a name", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1 })] });
    const w = writeHandlers(db);
    const add = { deckId: 1, cardId: BOLT.id, categoryId: null, variant: "live" } as const;
    w.deck_add_card({ ...add, categoryName: "Removal", quantity: 1 });
    w.deck_add_card({ ...add, categoryName: "Removal", quantity: 1 });
    const made = db.deckCategories.filter((c) => c.name === "Removal");
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ deckId: 1, kind: "main", isActive: true, origin: "auto" });
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
      toCategoryName: null,
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
      toCategoryName: null,
      variant: "live",
    });
    expect(db.deckCards.map((dc) => [dc.variant, dc.categoryId, dc.quantity]).sort()).toEqual([
      ["live", SIDE.categoryId, 2],
      ["theory", MAIN.categoryId, 5],
    ]);
  });

  it("lands a move into an empty category on a new row id, not the one it came from", () => {
    // `INSERT … SELECT` then `DELETE`, so the copies land on a fresh rowid — and row id is what
    // `deck_to_collection` takes copies off a list in, so the moved row queues behind the rows
    // that were already there rather than where it used to sit.
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
      toCategoryName: null,
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
        toCategoryName: null,
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

  /**
   * The whole deck in one INSERT, which is what the "New deck" dialog sends now that it hosts
   * every deck-level field: create-then-patch-then-file would be three writes and a half-made
   * deck to unwind by hand when the second one failed.
   */
  it("writes every field of a create, keeps card_art, and records one audit row", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    const folder = w.deck_folder_create({ parentId: null, name: "Ideas" });
    const row = w.deck_create({
      deck: {
        name: "  Burn  ",
        formatKey: "modern",
        description: "fast red",
        notes: "the sideboard plan lives here",
        coverCardId: BOLT.id,
        folderId: folder.id,
        theoryEnabled: true,
      },
    });
    expect(row).toMatchObject({
      name: "Burn",
      formatKey: "modern",
      description: "fast red",
      notes: "the sideboard plan lives here",
      coverCardId: BOLT.id,
      folderId: folder.id,
      theoryEnabled: true,
      // The column's DDL default, and the only kind there is: a create used to be unable to set
      // the *custom* one, which needed a path on disk and a deck id, and that whole half is
      // deleted.
      coverKind: "card_art",
    });
    // Joined from `cards` rather than echoed back, which is the half a store of DTOs would get
    // right by accident.
    expect(row.coverArtist).toBe("Christopher Rush");
    // Theory on at birth seeds nothing — the patch copies the live list across on off → on,
    // and a deck being born has no live cards to copy.
    expect(db.deckCards).toHaveLength(0);
    // One event, however many fields it was born with. `deck_update` writes a row per changed
    // field because each of those is an event; this is the one with a null `from`.
    expect(db.deckAudit).toHaveLength(1);
    expect(db.deckAudit[0]).toMatchObject({ deckId: row.id, kind: "deck", delta: 0 });
    expect(JSON.parse(db.deckAudit[0].payload)).toEqual({ field: "name", from: null, to: "Burn" });
  });

  it("reads an absent folderId as the top level, not as 'leave it'", () => {
    const db = makeDb();
    const w = writeHandlers(db);
    w.deck_folder_create({ parentId: null, name: "Ideas" });
    const row = w.deck_create({ deck: { name: "Burn", formatKey: "modern" } });
    // `DeckPatch.folderId` cannot un-file a deck, because `coalesce(?n, folder_id)` reads a
    // bound NULL as "leave it" — and a reader who knows that rule will assume it holds here.
    // It does not: an INSERT has nothing to leave, so an omitted field is the column's own
    // default and an omitted folder is the root.
    expect(row).toMatchObject({
      folderId: null,
      description: null,
      notes: null,
      coverCardId: null,
      coverKind: "card_art",
      theoryEnabled: false,
      archived: false,
    });
    expect(row.coverArtist).toBeNull();
  });

  /**
   * **And its group**, which since schema v25 is as much a part of a deck existing as its four
   * predefined categories: a deck without one can hold no card at all, because
   * `collection_to_deck` looks the destination up by `deck_id` and refuses in words when there
   * is none. The folder wears the deck's *trimmed* name — the name the deck itself got.
   */
  it("gives the new deck the group that holds its copies, named after it", () => {
    const db = makeDeckDb({ decks: [] });
    const row = writeHandlers(db).deck_create({ deck: { name: "  Burn  ", formatKey: "modern" } });
    const group = db.collectionFolders.find((f) => f.deckId === row.id);
    expect(group).toMatchObject({ kind: "deck", name: "Burn", parentId: null, sortOrder: 0 });
    // And a rename moves it: the folder's name is a snapshot and nothing else updates it.
    writeHandlers(db).deck_update({ id: row.id, patch: { name: "Boros Burn" } });
    expect(db.collectionFolders.find((f) => f.deckId === row.id)!.name).toBe("Boros Burn");
  });

  /**
   * **The labels stay, and that is the change rather than a leak.** A label carried
   * `deck_id … ON DELETE CASCADE` until schema v21 and went with the deck that made it, which
   * was right while it belonged to one. It belongs to the app now: deleting the deck where
   * "Removal" was first typed must not take the label off the nine other decks wearing it, so
   * the delete unclaims it here — through `deck_cards` — and leaves it standing. `reset_decks`,
   * which is every deck at once, is the one thing that sweeps the table.
   */
  it("deletes the deck's cards and categories with it, and leaves the app's labels alone", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 }), deck({ id: 2 })],
      deckCards: [deckCard({ id: 1, deckId: 1 }), deckCard({ id: 2, deckId: 2 })],
      deckLabels: [
        { id: 1, name: "Removal", color: "red" },
        { id: 2, name: "Ramp", color: "green" },
      ],
    });
    writeHandlers(db).deck_delete({ id: 1 });
    expect(db.decks.map((d) => d.id)).toEqual([2]);
    expect(db.deckCards.map((dc) => dc.deckId)).toEqual([2]);
    expect(new Set(db.deckCategories.map((c) => c.deckId))).toEqual(new Set([2]));
    expect(db.deckLabels.map((t) => t.id)).toEqual([1, 2]);
  });

  /**
   * **The copies come back rather than going with the deck**, and the order is the whole of it:
   * `collection_folders.deck_id` cascades, so a delete that dropped the group first would take
   * the reader's cards with it. The group goes; what was in it is on their desk.
   */
  it("files the group's copies into Recently removed before the group goes", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 3, folderId: groupId(1) })],
      deckCards: [deckCard({ id: 1, deckId: 1, quantity: 3 })],
    });
    writeHandlers(db).deck_delete({ id: 1 });
    expect(db.collectionFolders.map((f) => f.id)).toEqual([REMOVED_FOLDER]);
    expect(db.collectionEntries).toHaveLength(1);
    expect(db.collectionEntries[0]).toMatchObject({ quantity: 3, folderId: REMOVED_FOLDER });
  });

  it("deletes a deck whose group holds nothing without needing a holding area", () => {
    // A store with no `removed` folder is one that has been edited by hand, and deleting a deck
    // that holds nothing must not depend on it — the same asymmetry `deck_to_collection` draws.
    const db = makeDeckDb({ decks: [deck({ id: 1 })] });
    db.collectionFolders = db.collectionFolders.filter((f) => f.kind !== "removed");
    writeHandlers(db).deck_delete({ id: 1 });
    expect(db.decks).toHaveLength(0);
    expect(db.collectionFolders).toHaveLength(0);
  });

  it("copies the cards but never archived, and gives the copy an empty group of its own", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1, name: "Burn", archived: true })],
      collectionEntries: [entry({ id: 1, cardId: BOLT.id, quantity: 4, folderId: groupId(1) })],
      deckCards: [deckCard({ id: 1, deckId: 1, quantity: 4 })],
    });
    const copy = writeHandlers(db).deck_duplicate({ id: 1 });
    expect(copy).toMatchObject({ name: "Burn (copy)", archived: false });
    expect(db.deckCards.filter((dc) => dc.deckId === copy.id)).toHaveLength(1);
    expect(db.deckCards.find((dc) => dc.deckId === copy.id)!.quantity).toBe(4);
    // A copy is a **draft**: it lists the cards and holds none of them, because the copies are
    // physically in the original. A duplicate that came with them would be a press that quietly
    // unbuilt a deck.
    const group = db.collectionFolders.find((f) => f.deckId === copy.id)!;
    expect(group.name).toBe("Burn (copy)");
    expect(db.collectionEntries.filter((e) => e.folderId === group.id)).toHaveLength(0);
    expect(liveDeck(db, copy.id)!.cards[0].ownedQuantity).toBe(0);
    expect(liveDeck(db, 1)!.cards[0].ownedQuantity).toBe(4);
  });

  /**
   * The half a "copy the cards" implementation gets wrong invisibly: a card row stores a
   * `category_id`, so copying it verbatim would file the copy's cards under the *original's*
   * categories — and deleting the original would then take the copy's cards with it through
   * `ON DELETE CASCADE`. Both variants come across, because a copy made to try something out
   * is exactly the copy that wants the plan.
   */
  it("copies categories as new rows, keeps the app's label ids, and takes both variants", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1, name: "Burn" })],
      deckCards: [
        deckCard({ id: 1, deckId: 1, categoryKind: "main", quantity: 4, labelId: 1 }),
        deckCard({ id: 2, deckId: 1, categoryKind: "side", variant: "theory", quantity: 2 }),
      ],
      deckLabels: [{ id: 1, name: "Removal", color: "red" }],
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
    // **The label is not copied, because since schema v21 there is nothing to copy.** A duplicate
    // used to get its own `deck_labels` rows and a remap onto them; a label is one app-wide row
    // now, so the copied card keeps the very id it had — the duplicate wears the same labels as
    // its original, which is what a reader duplicating a deck means by "the same deck".
    expect(db.deckLabels.map((t) => t.id)).toEqual([1]);
    expect(copied[0].labelId).toBe(1);
    // Which is the whole point: deleting the original leaves the copy whole.
    writeHandlers(db).deck_delete({ id: 1 });
    expect(db.deckCards.filter((dc) => dc.deckId === copy.id)).toHaveLength(2);
  });

  it("leaves absent patch fields alone", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1, name: "Burn", description: "fast" })] });
    const row = writeHandlers(db).deck_update({ id: 1, patch: { notes: "sideboard plan" } });
    expect(row).toMatchObject({ name: "Burn", description: "fast", notes: "sideboard plan" });
  });

  /**
   * The three columns that remember where the reader was — and the three things this write
   * deliberately does **not** do, which is most of why it is a command of its own rather than a
   * `DeckPatch` field: no `updated_at` bump, no history row, no folder write. Looking at a tab
   * is not editing a deck, and a patch field would have inherited all three.
   */
  it("writes each view-state field, leaves an absent one alone, and moves nothing else", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1 })] });
    const w = writeHandlers(db);
    const row = db.decks[0];
    const state = () => [row.lastVariant, row.lastGroupBy, row.lastSortBy];
    expect(state()).toEqual(["live", "category", "alphabetical"]);

    w.deck_set_view_state({ deckId: 1, viewState: { variant: "theory" } });
    expect(state()).toEqual(["theory", "category", "alphabetical"]);

    // The variant is not sent this time, so it is still the one the press before chose: absent
    // means "leave it", per field, so three controls write without sharing any state.
    w.deck_set_view_state({ deckId: 1, viewState: { groupBy: "manaValue", sortBy: "price" } });
    expect(state()).toEqual(["theory", "manaValue", "price"]);

    expect(row.updatedAt).toBe(WHEN);
    expect(db.deckAudit).toEqual([]);
  });

  /**
   * The three refusals, and they are checked by three different amounts on purpose: the deck has
   * to exist, the variant is the backend's own word list, and a grouping or a sort is only
   * refused for being **blank** — a build that refused a word it did not know would refuse the
   * future, since that vocabulary is TypeScript's.
   */
  it("refuses an unknown deck, an unknown variant and a blank mode, and stores the rest", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1 })] });
    const w = writeHandlers(db);
    expect(() => w.deck_set_view_state({ deckId: 99, viewState: { variant: "theory" } })).toThrow(
      /not there any more/,
    );
    expect(() =>
      w.deck_set_view_state({
        deckId: 1,
        viewState: { variant: "sideboard" as DeckVariant },
      }),
    ).toThrow(/not a deck variant/);
    expect(() => w.deck_set_view_state({ deckId: 1, viewState: { sortBy: "" } })).toThrow(
      /cannot be blank/,
    );
    // Refused whole, and this is the call that proves it: every field is checked before the row
    // is touched, so a good `variant` beside a blank `groupBy` lands neither.
    expect(() =>
      w.deck_set_view_state({ deckId: 1, viewState: { variant: "theory", groupBy: "  " } }),
    ).toThrow(/cannot be blank/);
    expect([db.decks[0].lastVariant, db.decks[0].lastGroupBy]).toEqual(["live", "category"]);

    // Anything that is not blank is stored, whether or not this build has a mode by that name.
    w.deck_set_view_state({ deckId: 1, viewState: { groupBy: "byArtist" } });
    expect(db.decks[0].lastGroupBy).toBe("byArtist");
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
      // In the deck's own group: what it *holds* is where its rows sit, so a copy in the binder
      // is a copy this button still shops for.
      collectionEntries: [
        entry({ id: 1, cardId: BOLT_A.id, quantity: 1, folderId: groupId(1) }),
      ],
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
      collectionEntries: [
        entry({ id: 1, cardId: BOLT_A.id, quantity: 4, folderId: groupId(1) }),
      ],
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT_A.id, categoryKind: "main", quantity: 4 })],
    });
    expect(writeHandlers(db).deck_missing_to_wishlist({ deckId: 1 })).toBe(0);
    expect(db.wishlistEntries).toHaveLength(0);
  });
});

/**
 * What a decklist has to survive on its way into a deck.
 *
 * The resolve half is about **which printing a name means**, which is the one question the
 * webview cannot answer for itself; the commit half is about the grain, the variant and the
 * categories. Neither is about parsing — that is `import/parse.ts`, and it never reaches here.
 */
describe("the decklist import", () => {
  /** `c21 263`, 2021 — the older Sol Ring, and the one nothing prefers until it is owned. */
  const SOL_OLD = CARDS.find((c) => c.name === "Sol Ring" && c.setCode === "c21")!;
  /** `sld 913`, 2025 — the newest, which is what a bare name lands on. */
  const SOL_NEW = CARDS.find((c) => c.name === "Sol Ring" && c.setCode === "sld")!;
  /** The double-faced row: a decklist writes it `Delver of Secrets` and `cards.name` does not. */
  const DELVER = CARDS.find((c) => c.name.startsWith("Delver of Secrets //"))!;

  /** The three fields of a resolve line, so a case can name only the ones it is about. */
  function resolve(db: FakeDb, lines: Partial<ImportResolveLine>[]) {
    return readHandlers(db).import_resolve({
      lines: lines.map((l) => ({ name: "", setCode: null, collectorNumber: null, ...l })),
    });
  }

  it("resolves a name to a printing it has", () => {
    const rows = resolve(makeDb(), [
      { name: "Sol Ring" },
      // The set code in the case a parser that upper-cased `(C21)` would send. Honoured, and
      // `printingCount` is the *arm's* count — one printing, not the card's two.
      { name: "Sol Ring", setCode: "C21", collectorNumber: "263" },
    ]);
    expect(rows[0]).toMatchObject({ index: 0, hintMissed: false });
    // The newest of the two, because the collection holds neither.
    expect(rows[0].matched).toMatchObject({ cardId: SOL_NEW.id, printingCount: 2 });
    expect(rows[1].matched).toMatchObject({ cardId: SOL_OLD.id, printingCount: 1 });
    expect(rows[1].hintMissed).toBe(false);
  });

  it("resolves a front-face name to a double-faced card", () => {
    const rows = resolve(makeDb(), [
      { name: "Delver of Secrets" },
      // …and the fold arm, which is where case and diacritics survive: neither the exact-name
      // arm nor the front-face range matches this one.
      { name: "delver of secrets" },
    ]);
    // **The whole printed name** comes back, which is what `deck_cards.name` denormalizes and
    // the one case a preview echoing the line's own name would hide.
    expect(rows[0].matched).toMatchObject({ cardId: DELVER.id, name: DELVER.name });
    expect(rows[1].matched).toMatchObject({ cardId: DELVER.id });
  });

  it("prefers a printing the collection holds", () => {
    const db = makeDb({ collectionEntries: [entry({ id: 1, cardId: SOL_OLD.id, quantity: 1 })] });
    // The older printing now, and the reason is on the row: `ownedQuantity` is why it won.
    expect(resolve(db, [{ name: "Sol Ring" }])[0].matched).toMatchObject({
      cardId: SOL_OLD.id,
      ownedQuantity: 1,
    });
  });

  it("answers a name it does not know with a null match", () => {
    const rows = resolve(makeDb(), [
      { name: "Nonesuch Card" },
      // A hint that named nothing is reported and **falls through**: wanting a printing this
      // app has not got is never a reason to lose the card.
      { name: "Sol Ring", setCode: "zzz", collectorNumber: "1" },
      // A collector number with no set beside it cannot narrow anything, so it is a missed
      // hint without ever being tried.
      { name: "Sol Ring", collectorNumber: "263" },
    ]);
    expect(rows[0]).toMatchObject({ matched: null, hintMissed: false });
    expect(rows[1].hintMissed).toBe(true);
    expect(rows[1].matched).toMatchObject({ cardId: SOL_NEW.id });
    expect(rows[2].hintMissed).toBe(true);
    expect(rows[2].matched).toMatchObject({ cardId: SOL_NEW.id });
  });

  it("commits a merge onto the grain", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 1 })],
    });
    const out = writeHandlers(db).deck_import_commit({
      deckId: 1,
      variant: "live",
      mode: "merge",
      items: [
        { cardId: BOLT.id, quantity: 2, categoryName: "Main deck" },
        // The same card on two lines is one row for the sum, not two.
        { cardId: BOLT.id, quantity: 3, categoryName: "Main deck" },
      ],
    });
    // `added` is what the list **asked for**, not what the deck landed on.
    expect(out).toEqual({ added: 5, removed: 0, categoriesCreated: 0, labelsCreated: 0 });
    expect(db.deckCards).toHaveLength(1);
    expect(db.deckCards[0].quantity).toBe(6);
  });

  it("commits a replace that clears only its own variant", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT_A.id, categoryKind: "main", quantity: 4 }),
        deckCard({ id: 2, cardId: BOLT_A.id, variant: "theory", quantity: 7 }),
      ],
    });
    const out = writeHandlers(db).deck_import_commit({
      deckId: 1,
      variant: "live",
      mode: "replace",
      items: [{ cardId: BOLT_B.id, quantity: 1, categoryName: "Main deck" }],
    });
    // Copies, not rows — the number the history's `delta` carries.
    expect(out).toEqual({ added: 1, removed: 4, categoriesCreated: 0, labelsCreated: 0 });
    // Replacing what is sleeved up never touches the plan.
    expect(db.deckCards.filter((dc) => dc.variant === "theory")).toHaveLength(1);
    expect(db.deckCards.filter((dc) => dc.variant === "live")).toHaveLength(1);
    // The cards go and the **filing stays**: a category is the reader's, not the list's.
    expect(db.deckCategories.filter((c) => c.deckId === 1)).toHaveLength(5);
    // One row per *effect*, never one per card.
    expect(db.deckAudit.map((a) => a.kind)).toEqual(["remove", "add"]);
    expect(db.deckAudit.map((a) => a.delta)).toEqual([-4, 1]);
  });

  /** Copies in one folder. `deck_clear` declares this too; an import is not a clear and this
   *  describe is not inside that one. */
  const copiesIn = (db: FakeDb, folderId: number | null) =>
    db.collectionEntries
      .filter((e) => e.folderId === folderId)
      .reduce((n, e) => n + e.quantity, 0);

  /**
   * A deck whose group holds exactly the copies its live list claims — a reader who filed their
   * cards into the deck, and the only state a stranding is visible from. Two printings over two
   * piles, seven copies in the plan beside them, and a second deck holding three of its own, so
   * every assertion below has a list and a folder outside its own scope to be wrong about.
   */
  const filed = () =>
    makeDeckDb({
      decks: [deck({ id: 1, name: "Deck A" }), deck({ id: 2, name: "Deck B" })],
      collectionEntries: [
        entry({ id: 1, cardId: BOLT_A.id, quantity: 4, folderId: groupId(1) }),
        entry({ id: 2, cardId: SOL_NEW.id, quantity: 2, folderId: groupId(1) }),
        entry({ id: 3, cardId: BOLT_A.id, quantity: 3, folderId: groupId(2) }),
      ],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT_A.id, categoryKind: "main", quantity: 4 }),
        deckCard({ id: 2, cardId: SOL_NEW.id, categoryKind: "side", quantity: 2 }),
        deckCard({ id: 3, cardId: BOLT_A.id, variant: "theory", quantity: 7 }),
        deckCard({ id: 4, deckId: 2, cardId: BOLT_A.id, categoryKind: "main", quantity: 3 }),
      ],
    });

  /**
   * A `deck_cards` row is an intention and a row in the deck's group is cardboard the reader
   * physically owns — so importing over a list does not stop them owning it. Left where they
   * were, the copies stay filed under a deck that has stopped naming them: invisible on the
   * Collection page and unavailable to every other deck, which is exactly the stranding
   * `deck_clear` releases behind its identical delete.
   *
   * The imported line names a **different printing of the same card**, which is the arm that
   * hides it: {@link attributeOwned} matches on the oracle id, so a group nobody released hands
   * the freshly imported row a copy the reader never filed and the deck reads as owning one.
   */
  it("files a replaced live list's copies into Recently removed", () => {
    const db = filed();
    expect(copiesIn(db, groupId(1))).toBe(6);

    writeHandlers(db).deck_import_commit({
      deckId: 1,
      variant: "live",
      mode: "replace",
      items: [{ cardId: BOLT_B.id, quantity: 1, categoryName: "Main deck" }],
    });

    expect(copiesIn(db, groupId(1))).toBe(0);
    expect(copiesIn(db, REMOVED_FOLDER)).toBe(6);
    // The other deck's group is no part of this import's business.
    expect(copiesIn(db, groupId(2))).toBe(3);
    // What the reader is then looking at: a fresh list owning nothing until they file the
    // copies again, which is where `Clear live list…` leaves them too.
    expect(liveDeck(db)!.cards.map((c) => c.ownedQuantity)).toEqual([0]);
  });

  /**
   * A plan holds no cards, so nothing in any folder backs a theory row and there is nothing to
   * give back — `releasePileCopies` decides that per row rather than the handler testing the
   * argument it was called with. The group keeps its six even though seven copies just left the
   * plan, and the holding area is never written to: the two assertions a release fenced on the
   * wrong thing fails.
   */
  it("moves nothing when the list being replaced is the plan", () => {
    const db = filed();

    const out = writeHandlers(db).deck_import_commit({
      deckId: 1,
      variant: "theory",
      mode: "replace",
      items: [{ cardId: BOLT_B.id, quantity: 1, categoryName: "Main deck" }],
    });

    expect(out.removed).toBe(7);
    expect(copiesIn(db, groupId(1))).toBe(6);
    expect(copiesIn(db, REMOVED_FOLDER)).toBe(0);
    // The live list is still standing and still owns what it always did, which is what makes
    // the two counts above about custody rather than about an import that did nothing.
    expect(db.deckCards.filter((dc) => dc.variant === "live")).toHaveLength(3);
    expect(liveDeck(db)!.cards.map((c) => c.ownedQuantity)).toEqual([4, 2]);
  });

  /**
   * A merge takes nothing out of the list, so there is nothing to release — the release belongs
   * to the clear the `replace` arm performs and not to the import. A handler that gave the
   * copies back on every commit would empty the group of a deck the reader had just topped up.
   */
  it("moves nothing on a merge, which takes nothing out", () => {
    const db = filed();

    writeHandlers(db).deck_import_commit({
      deckId: 1,
      variant: "live",
      mode: "merge",
      items: [{ cardId: BOLT_A.id, quantity: 2, categoryName: "Main deck" }],
    });

    expect(copiesIn(db, groupId(1))).toBe(6);
    expect(copiesIn(db, REMOVED_FOLDER)).toBe(0);
    // Folded onto the row that was already there, so the deck now claims six copies of a card
    // whose four in the group never moved — a merge writes a list without moving cardboard.
    expect(db.deckCards.find((dc) => dc.id === 1)!.quantity).toBe(6);
  });

  /**
   * Archidekt's `^Keeper,#4aab08^` through the fake, which is what the import dialog's stories
   * run against — so the three rules `import::label_for_name` holds have to hold here too, or a
   * play would pass over behaviour the app does not have.
   */
  it("finds or makes the label an item names, and never touches one it finds", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckLabels: [{ id: 7, name: "Keeper", color: "#d9b95c" }],
    });
    const out = writeHandlers(db).deck_import_commit({
      deckId: 1,
      variant: "live",
      mode: "merge",
      items: [
        // A different case *and* a different colour, so neither match could be a coincidence.
        {
          cardId: BOLT_A.id,
          quantity: 1,
          categoryName: "Ramp",
          labelName: "KEEPER",
          labelColor: "#4aab08",
        },
        {
          cardId: BOLT_B.id,
          quantity: 1,
          categoryName: "Ramp",
          labelName: "Fence",
          labelColor: "#fffc19",
        },
        { cardId: SOL_NEW.id, quantity: 1, categoryName: "Ramp" },
      ],
    });

    expect(out.labelsCreated).toBe(1);
    expect(db.deckLabels).toEqual([
      // Used as it stands: `labelKey` matched it, so neither the name nor the colour moved.
      { id: 7, name: "Keeper", color: "#d9b95c" },
      { id: 8, name: "Fence", color: "#fffc19" },
    ]);
    expect(db.deckCards.map((dc) => dc.labelId)).toEqual([7, 8, null]);
  });

  /** `label_id = coalesce(deck_cards.label_id, excluded.label_id)` — the copies sum and the label
   *  does not, because a label the reader put on a row by hand is a decision an import may not
   *  overturn. */
  it("keeps a label the deck card already wore through a merge", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckLabels: [{ id: 3, name: "Cut candidate", color: "#d3202a" }],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id, categoryKind: "main", quantity: 1, labelId: 3 }),
      ],
    });
    writeHandlers(db).deck_import_commit({
      deckId: 1,
      variant: "live",
      mode: "merge",
      items: [
        {
          cardId: BOLT.id,
          quantity: 2,
          categoryName: "Main deck",
          labelName: "Keeper",
          labelColor: "#4aab08",
        },
      ],
    });

    expect(db.deckCards[0]).toMatchObject({ quantity: 3, labelId: 3 });
    // The file's label is still made — it is only this row it may not claim.
    expect(db.deckLabels.map((t) => t.name)).toEqual(["Cut candidate", "Keeper"]);
  });

  it("creates the categories the items name", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1 })] });
    const out = writeHandlers(db).deck_import_commit({
      deckId: 1,
      variant: "live",
      mode: "merge",
      items: [
        { cardId: BOLT_A.id, quantity: 1, categoryName: "Ramp" },
        // Trimmed before it is keyed, so this is the same pile and not a second creation.
        { cardId: BOLT_B.id, quantity: 1, categoryName: "  Ramp  " },
        // A section the deck already has by name costs nothing — matched by **name alone**, so
        // a `Sideboard` line lands on the seeded `side` row rather than making a second pile.
        { cardId: SOL_NEW.id, quantity: 1, categoryName: "Sideboard" },
      ],
    });
    expect(out.categoriesCreated).toBe(1);
    const ramp = db.deckCategories.filter((c) => c.deckId === 1 && c.name === "Ramp");
    expect(ramp).toHaveLength(1);
    // `auto`, like every pile `category_for_name` makes: an import is the add path in bulk, and
    // a pile it had to invent is one nobody asked for by name.
    expect(ramp[0]).toMatchObject({ kind: "main", isActive: true, origin: "auto" });
    // Two printings, so two rows — one pile.
    expect(db.deckCards.filter((dc) => dc.categoryId === ramp[0].id)).toHaveLength(2);
    expect(db.deckCards.filter((dc) => dc.categoryId === categoryId(1, "side"))).toHaveLength(1);
  });

  it("switches off a pile it creates for a {noDeck} item, and leaves an existing one alone", () => {
    const db = makeDeckDb({ decks: [deck({ id: 1 })] });
    const w = writeHandlers(db);
    const mine = w.deck_category_create({ deckId: 1, name: "Keepers" });
    w.deck_import_commit({
      deckId: 1,
      variant: "live",
      mode: "merge",
      items: [
        { cardId: BOLT.id, quantity: 1, categoryName: "(New) Maybeboard", inactive: true },
        // The reader's own pile, described by the file the same way — and left exactly as they
        // set it, because an import may not reach into filing somebody did by hand.
        { cardId: BOLT.id, quantity: 1, categoryName: "Keepers", inactive: true },
      ],
    });
    const made = db.deckCategories.find((c) => c.deckId === 1 && c.name === "(New) Maybeboard");
    expect(made?.isActive).toBe(false);
    expect(db.deckCategories.find((c) => c.id === mine.id)?.isActive).toBe(true);
  });

  it("refuses an empty item list", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, quantity: 4 })],
    });
    // The refusal that matters most in `replace`, where "do nothing" and "clear the deck and
    // put nothing back" are the same call with the same arguments.
    expect(() =>
      writeHandlers(db).deck_import_commit({
        deckId: 1,
        variant: "live",
        mode: "replace",
        items: [],
      }),
    ).toThrow(/nothing to import/i);
    expect(db.deckCards).toHaveLength(1);
    expect(db.deckAudit).toHaveLength(0);
  });

  it("is all or nothing: one line it cannot land leaves the deck as it was", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: BOLT_A.id, categoryKind: "main", quantity: 4 })],
    });
    expect(() =>
      writeHandlers(db).deck_import_commit({
        deckId: 1,
        variant: "live",
        mode: "replace",
        items: [
          { cardId: BOLT_B.id, quantity: 1, categoryName: "Ramp" },
          { cardId: "no-such-card", quantity: 1, categoryName: "Ramp" },
        ],
      }),
    ).toThrow(/no card with the id/);
    // The rows the replace was about to clear are still there, and no half-made category is
    // left behind it.
    expect(db.deckCards).toHaveLength(1);
    expect(db.deckCards[0].quantity).toBe(4);
    expect(db.deckCategories.some((c) => c.name === "Ramp")).toBe(false);
  });

  it("has no file to read, and says so rather than inventing a decklist", () => {
    expect(() => readHandlers(makeDb()).import_read_file()).toThrow(/no file picker/i);
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
      // The sixth, and it is unlocked for a third reason again: `oracle_tags::refresh` opens
      // with a read and a network call, and only its ingest reaches for `db::lock_for`. So a
      // running sync delays a tag refresh rather than refusing it at the door.
      "oracle_tags_refresh",
      // The art taxonomy's refresh, unlocked for exactly the same reason as its oracle twin —
      // `tags::refresh` opens with a read and a network call and only its ingest reaches for
      // `db::lock_for`. It is the *larger* of the two (12.5 MB against 5.85), which is why
      // `tags::art::refresh_if_due` is emphatic that nothing may wait on it.
      "art_tags_refresh",
      // The combo feed's refresh, unlocked for the same reason as both taxonomies above it and
      // with the most at stake in it: `combos::refresh` opens on `lock_db_read` and a network
      // call, and only its ingest reaches for the write connection — one 2 000-combo batch at a
      // time, standing aside between them. It is by far the largest of the three (27.5 MB
      // compressed against 12.5 and 5.85), so a `BUSY` at the door would throw a whole download
      // away over a lock it would have got a moment later.
      "combos_refresh",
      // The only one here that touches **no database at all**:
      // `export::export_write_file` takes no `AppState`, so there is no connection for a sync
      // to be holding and no `BUSY` it could ever answer. It writes a file at a path the OS
      // save dialog produced and nothing else.
      "export_write_file",
      // Unlocked for the first reason on this list rather than a new one:
      // `mirror::settings::mirror_rebuild` runs on the blocking pool against `db_read`, like
      // every other read-shaped command, because a pass reads the whole collection and writes a
      // few hundred small files — far too much to do while holding the write connection, and
      // forbidden from touching it at all. It is in `writeHandlers` because it *writes*, just
      // not to the database. Its two neighbours (`mirror_set_enabled`, `mirror_set_root`) take
      // `sync::with_write` and are in the loop below with everything else.
      "mirror_rebuild",
      // The backup archive, both doors, unlocked for `mirror_rebuild`'s reason exactly:
      // `mirror::snapshot::build_now` opens a **read-only connection of its own** and falls back
      // to the shared read connection only if it cannot — it never reaches for the write one, so
      // there is no `BUSY` for either to answer. They are in `writeHandlers` because they
      // *produce* something (a download, or a file at a picked path), not because they write a
      // row.
      "mirror_backup_zip",
      "mirror_backup_save",
      // The eleventh, and the first that touches **no connection of any kind**: pairing's
      // cancel clears `AppState.pairing`, a mutex of its own that has nothing to do with
      // the database, so there is no `BUSY` for it to answer. Its seven neighbours all take
      // `sync::with_write` and are in the loop below — `sync_pairing_status` included,
      // which is a *write* in the crate because `identity::ensure` mints a row on first
      // read, and sits in `readHandlers` here only because this fake mints its identity in
      // `makeDb`.
      "sync_pairing_cancel",
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
      // Schema v8's writes: a category, a label, a folder and a cover each name their own
      // arguments, and every one of them is here because `invoke` matches by name.
      name: "Ramp",
      color: "ember",
      isActive: false,
      ids: [categoryId(1, "main")],
      moveToCategoryId: null,
      labelId: null,
      parentId: null,
      folderId: null,
      sourcePath: "C:\\Users\\Reader\\Pictures\\sleeve.png",
      marketplace: "cardkingdom",
      // `set_printing_group_by`'s. Never actually read on this path — the lock is taken before
      // the mode is looked at, which is the order the Rust has — but it is here because the
      // rule this record stands for is that `invoke` matches by name, not by position.
      mode: "artist",
      // `set_card_zoom`'s pair — the only write here that takes two arguments of its own. Never
      // read on this path either, for `mode`'s reason: the lock comes before the value is looked
      // at. Both are valid all the same, so a handler that took the lock *after* validating would
      // fail this loop by answering `Ok` instead of BUSY rather than by answering the wrong error.
      section: "deck",
      zoom: 1.25,
      // `set_list_view`'s second argument — it shares `section` with the zoom above, which is the
      // one collision in this record and is harmless because `"deck"` is a section name neither
      // write validates. Valid all the same, for `zoom`'s reason: a handler that validated before
      // taking the lock would fail this loop by answering `Ok` instead of BUSY.
      view: "grid",
      // `set_flatten_state`'s second argument, and the **third** write to share the `section`
      // above — which is why that key carries three values beside it rather than three sections.
      // `"deck"` is a section name none of the three validates, so all three are valid here for
      // `zoom`'s reason: a handler that validated before taking the lock would fail this loop by
      // answering `Ok` instead of BUSY.
      flattened: true,
      // `deck_set_view_state`'s, and empty is a real value for it: every field is optional and
      // absent means "leave it".
      viewState: {},
      // `set_nav_collapsed`'s. Never read on this path either — the lock comes first, as it
      // does for every write here — and unlike `mode` and `zoom` there is no invalid value it
      // *could* be given: a boolean has no junk state, so this write's only refusal is the one
      // this loop is about.
      collapsed: true,
      // Schema v25's pair. Neither is read on this path — `refuseIfBusy` comes first, as it does
      // for every write here — but both are named because `invoke` matches by name, and a
      // handler that took the lock after resolving its row would fail this loop by answering
      // "not there any more" instead of BUSY.
      entryId: 1,
      deckCardId: 1,
      // The mirror's pair. `enabled` is the **fourth** one-line boolean write here and is never
      // read on this path — `refuseIfBusy` comes first, as it does for every write in the loop
      // — while `root` *is* validated, and is absolute here on purpose: a relative one would
      // fail this loop by answering "not an absolute path" instead of BUSY, which is exactly
      // the ordering mistake the loop is looking for.
      enabled: true,
      root: "D:\\Backups\\MTG",
    };
    // The five above excluded, this is every command that really takes the write lock —
    // re-counted 2026-08-12 **after a merge in which three branches had each added one**,
    // which is the case this number keeps losing to: deck-import added `deck_import_commit`,
    // the marketplace branch added `set_marketplace`, and the price-feed branch added
    // `marketplace_feed_refresh`. Each was re-counted correctly against its own base, and the
    // merge made every one of those counts wrong at once.
    //
    // All three follow the same split as `error_log_clear` before them: the write half takes
    // `AppState.db` through `lock_for` and is therefore refusable, while its read half
    // (`import_resolve`, `get_marketplace`, and `marketplace_feed_status`) goes through
    // `db_read` and answers through every second of a sync.
    //
    // The card pane's grouping selector then added `set_printing_group_by`, on the same split
    // again: the write refuses under a sync, the read (`printing_group_by`, on `db_read`) does
    // not. Re-measured 2026-08-14, on a branch whose siblings touch no handler in this table.
    //
    // The tab memory then added `deck_set_view_state` — the one write here that answers `void`,
    // moves no `updated_at` and records no history, and refusable all the same because it takes
    // the same write lock as every other. That it changes so little is exactly why it belongs in
    // this sweep: a handler that forgot `refuseIfBusy` would look identical from outside.
    //
    // The context-menu branch then added `export_write_file` and the number did **not** move,
    // which is the case worth naming beside the three that moved it: that command holds no
    // connection, so it joined `unlocked` rather than the count. A new write that forgot
    // `refuseIfBusy` would fail this loop; a new write correctly outside the lock has to be
    // argued for on the list above.
    //
    // `Clear stack…` then added `deck_category_clear`, which moved it 39 → 40. It is a **card**
    // write despite the name — it empties a pile of one variant and changes nothing about the
    // category — so it takes the write lock like every other and belongs in the loop rather than
    // in `unlocked`.
    //
    // `Set as foil` then added `deck_set_card_finish`, 40 → 41. Another card write: it moves
    // copies between two rows of one printing and takes the write lock like every other.
    //
    // Settings' four clears then took it 41 → 45 in one branch, which is the largest single
    // move this number has had. All four are ordinary writes on `AppState.db` and refusable for
    // the usual reason. `cache_clear` is the one worth a sentence: it carries a **second**
    // refusal of its own — a sync in flight, checked before the connection is ever asked for,
    // which is the `syncing` fault rather than this one — and it still belongs in this loop,
    // because a reader who is merely mid-*write* gets BUSY here exactly like everything else.
    //
    // The tags branch then added three writes: `tag_mute` and `tag_unmute` take
    // `sync::with_write` and are refusable like everything else in the loop, while
    // `art_tags_refresh` joined `unlocked` beside its oracle twin. Two of three, and the third
    // had to be argued for on the list above rather than counted here.
    //
    // The bulk-import commands added two more: `collection_import_commit` and
    // `wishlist_import_commit` are one transaction for a whole imported file rather than one
    // `collection_add`/`wishlist_add` per line, and each holds the same write lock its per-line
    // sibling does, so a reader mid-write gets BUSY on an import exactly as they do on a
    // quick-add.
    //
    // **Those two branches landed independently and each wrote 45 → 47, which is the merge this
    // paragraph exists for**: the number is a fact about the *merged* table, so the two moves sum
    // to 45 → 49 rather than either one winning. Neither side was wrong when it was written, and
    // taking one side's figure would have been a count that was true of a tree nobody has.
    //
    // The remembered card zoom then added `set_card_zoom`, on the same split as the two settings
    // before it: the write takes `sync::with_write` and is refusable, while the read (`card_zoom`,
    // on `db_read`) answers through every second of a sync. It is the one write here that takes
    // **two** arguments of its own, which is why `section` and `zoom` both appear above.
    //
    // So the number below is measured, not reasoned about: it is what `Object.keys` answers on
    // the merged table. Re-measure it after the next merge rather than adding one to it.
    // **And it happened again, on the very next merge.** Schema v21's global labels added
    // `deck_label_remove_from_deck` — the write that takes a label off one deck's list and leaves
    // the label standing — while the remembered card zoom added `set_card_zoom`. Each branch wrote
    // 49 → 50 and was right about the tree it was in; the merged table holds both, so it is 51.
    // Re-measure after the next merge rather than adding one to whichever figure you find here.
    //
    // **And a third time, on the same merge.** The collapsible sidebar added `set_nav_collapsed`
    // and the remembered search column added `set_deck_search_open`; each branch wrote 51 → 52
    // and was right about the tree it was in, so the merged table holds both and it is 53. Both
    // are the same split as every preference before them — the write takes the write connection
    // and is refusable, while the read (`nav_collapsed` and `deck_search_open`, on `db_read`)
    // answers through every second of a sync. And both are writes with **no validation of their
    // own**, a `boolean` having arrived narrowed, which is exactly why this loop matters more
    // for them than for their neighbours: a handler that forgot `refuseIfBusy` would have a
    // one-line body, and nothing else in the file would notice.
    //
    // The deck-driven collection then added `set_deck_driven_collection`, 53 → 54 — the
    // **third** of those one-line boolean writes and on exactly the same split — and its
    // removal took it back out again, 60 → 59. That is the one move recorded here that goes
    // *down*, and it is the best argument in this whole comment for measuring the figure
    // rather than accumulating it.
    //
    // Schema v23's wishlist folders then added **six**, 54 → 60, the largest single move since
    // Settings' four clears: `wishlist_folder_create`, `_rename`, `_move` and `_delete`,
    // `wishlist_set_folder`, and `wishlist_set_printing` — that last one is `wishlist.rs`'
    // rather than `wishlist_folders.rs`' and had simply never been registered anywhere, so it
    // arrived in this loop at the same time as the five it is not related to. All six take
    // `sync::with_write` and are refusable for the usual reason; the branch's two reads
    // (`wishlist_folder_list` and `wishlist_folder_summary`) go through `db_read` and are not
    // in this table at all.
    //
    // **That figure was 54 + 6, and this rung had been reconciled at a merge three times**
    // before the deck-driven write was deleted out of it again. The wishlist branch wrote
    // 52 → 58 against a tree holding `set_nav_collapsed` alone, then 53 → 59 once
    // `set_deck_search_open` landed, and then 54 → 60 beside the deck-driven write. Each was
    // right about the tree it was in and none predicted the merge — which is the whole of why
    // this file's own rule says never to add one branch's delta to another's total. Measured
    // again at 59 on 2026-08-23, with `set_deck_driven_collection` gone.
    //
    // Schema v24's **collection** folders then added five, 59 → 64: `collection_folder_create`,
    // `_rename`, `_move` and `_delete`, and `collection_set_folder`. Five where the wishlist's
    // branch added six, and the missing one is not an omission — that sixth was
    // `wishlist_set_printing`, a `wishlist.rs` write that had simply never been registered here
    // and rode along with folders it is unrelated to. Four of these five take `sync::with_write`
    // and the fifth (`collection_set_folder`) takes `collection_source::with_write_owned`,
    // because filing a row changes which rows *exist* — a merge deletes one — and the facet
    // index's `owned` dimension is built by counting them. Both are the same lock from this
    // loop's point of view. The branch's two reads (`collection_folder_list` and
    // `collection_folder_summary`) go through `db_read` and are not in this table at all,
    // exactly as the wishlist's two are not.
    //
    // Schema v25's deck groups then added **two**, 64 → 66: `collection_to_deck` and
    // `deck_to_collection`, the only pair in the crate that moves a collection row across the
    // deck boundary. Both take `collection_source::with_write_owned` and not bare `with_write`,
    // because a move can *delete* a row by folding it and the facet index's `owned` dimension is
    // built by counting rows — the same lock from this loop's point of view. **Nothing came out
    // in the same release**, which is worth saying because that release deleted a whole table:
    // `deck_allocations` and `decks.is_built` are gone, but neither ever had a command of its
    // own — the flag rode `deck_update` and the allocator was called by writes rather than being
    // one. So this is the rare move that is a pure addition, and it is still measured rather
    // than reasoned about.
    //
    // **Re-measured at 66 on 2026-08-23 and it had not moved** — the first entry in this comment
    // that records a release rather than a delta, and it needed one. The deck builder's
    // Collection Search tab, the own/need toggle and the import's "add these to my collection"
    // box are a whole feature that adds no command at all: `collection_to_deck` was registered a
    // release early and called by nothing, and what shipped here is its first caller. A comment
    // that reasoned "a feature lands, so add one" would have written 67 and been wrong. The
    // figure is a fact about the *handlers*, and a release can be entirely about who presses
    // them.
    //
    // The plain-text mirror then added **three** handlers and moved it by **two**, 66 → 68,
    // which is the split this comment keeps having to make: `mirror_set_enabled` and
    // `mirror_set_root` take `sync::with_write` and are refusable like everything in the loop,
    // while `mirror_rebuild` joined `unlocked` — it holds the *read* connection for the length
    // of a pass and has no BUSY to answer. `mirror_status`, the panel's one read, is in
    // `readHandlers` and not in this table at all. Measured after the change rather than
    // reasoned about, and this is the second entry here where a branch's handler count and its
    // delta to this number are different figures.
    // The remembered list layout then added **one**, 68 → 69: `set_list_view`, the fifth write
    // here whose whole body is a validation and a spread, on the same split as every preference
    // before it — it takes `sync::with_write` and is refusable, while the read (`list_view`, on
    // `db_read`) answers through every second of a sync. It is the **second** write in the table
    // to take two arguments of its own, `set_card_zoom` being the first, and it shares that one's
    // `section` name — which is why the record above carries one `section` and two values beside
    // it rather than two sections.
    // The remembered Flatten switch then added **one**, 69 → 70: `set_flatten_state`, on the same
    // split as every preference before it — it takes `sync::with_write` and is refusable, while
    // the read (`flatten_state`, on `db_read`) answers through every second of a sync. It is the
    // **third** write to take two arguments of its own and the third to share `section`, and it
    // is the first of those three whose body is a spread with only *half* a validation: the
    // section can be blank and the value cannot be junk, because a `bool` off the IPC boundary
    // has no junk state.
    // Folder reordering then added **three**, 70 -> 73 — one per cabinet
    // (`deck_folder_reorder`, `collection_folder_reorder`, `wishlist_folder_reorder`), and for
    // once the handler count and the delta are the same figure. All three take
    // `sync::with_write` like every other folder write, so none of them joined `unlocked`: a
    // reorder is `sort_order` and `parent_id` on one table and has no read half to answer
    // through a sync. They are also the first writes in this table whose `ids` is a list of
    // **folder** ids rather than category ids — which the record above does not need to know,
    // because every one of them reaches `refuseIfBusy` before it looks at an argument.
    const names = Object.keys(w).filter((n) => !unlocked.includes(n));
    // Pairing then added **seven**, 73 -> 80: begin, accept, respond, confirm, complete,
    // rename and revoke all take `sync::with_write`, because every one of them reads or
    // writes the three tables user schema v28 created. The eighth handler the feature ships,
    // `sync_pairing_cancel`, joined `unlocked` instead — the fourth distinct reason on
    // that list, and the cleanest: it touches no connection at all.
    // The relay then added **five**, 80 -> 85, and two of them are *reads*. Every one of
    // the five takes `sync::with_write` in the crate: `sync_relay_set_url`, `sync_now` and
    // `sync_review_clear` because they write, and `sync_relay_status` and `sync_review_list`
    // because that is the crate's single-writer path — the status counts unpushed rows of
    // `sync_ops` on the write connection, and `ipc.ts` says so at the call site. So both sit in
    // `writeHandlers` here, which is the opposite call from `sync_pairing_status` one feature
    // over and for the opposite reason: that command's crate-side write has no counterpart in
    // this fake, and these two's refusal does.
    // The hosted relay then moved it by **two**, 85 -> 87, which is three added and one gone
    // rather than a feature's handler count: `sync_relay_set_url` left with the address field
    // the panel typed into, and `sync_supporter_status`, `sync_patreon_begin` and
    // `sync_patreon_claim` arrived. **All three are here and none of them joined `unlocked`**,
    // and for once that is the crate's own words rather than an inference — every one takes
    // `sync::with_write`, and `sync_supporter_status`'s doc says why a *read* does: so that it
    // cannot answer from beside the claim that has just written, which is the read the panel
    // makes next. This is the fourth entry here whose delta and whose handler count differ.
    // Leaving a group then added **one**, 87 -> 88: `sync_group_leave` takes `sync::with_write`
    // like the seven pairing writes beside it, because it empties `sync_devices` and `sync_group`
    // and deletes the five grant rows. It is refusable at the door for the ordinary reason, and
    // that is worth this loop's attention rather than in spite of it: everything *after* the door
    // in that command is best effort by design (spec §2.1), so `refuseIfBusy` is the one refusal
    // it has and a handler that forgot it would look identical from outside.
    // The backup archive then added **two handlers and no refusals**, so its own delta was zero:
    // `mirror_backup_zip` and `mirror_backup_save` both joined `unlocked` above, for
    // `mirror_rebuild`'s reason.
    //
    // One-sided pairing then moved it by **minus one**: `sync_pairing_respond` and
    // `sync_pairing_complete` are gone (a relay carries both blobs now, spec §1) and
    // `sync_pairing_poll` replaces them — two handlers out, one in. It takes `sync::with_write`
    // and no arguments of its own, exactly as `sync_pairing_confirm` beside it needs none in
    // `args` above. So the two changes compose to 88 → 87, and this line was **re-counted by
    // running the sweep across the merge**, not by adding the two deltas on paper.
    //
    // Card-art-only covers then took **one**, 87 → 86: `deck_set_cover_image` is gone with the
    // whole custom-cover feature — the crate command, the `/cover/<deckId>` route, the encoder
    // and the `data/covers/` directory — because the picture never survived a sync, the path
    // being stored absolute. It was a write and it took `refuseIfBusy`, so this is a plain
    // deletion from the list rather than a handler moving to `unlocked`. Re-counted by running
    // the sweep, not by subtracting on paper.
    //
    // `Clear list` then added **one**, 86 → 87: `deck_clear` empties every pile of one variant
    // and is a card write in the same sense `deck_category_clear` is — it takes `with_write`
    // like every other and changes nothing about a category — so it belongs in the loop rather
    // than in `unlocked`. Its command is a *widening* of one already counted here and the count
    // still moved by one, for the reason the bulk-import pair moved it by two: the narrow
    // command did not go away. Re-counted by running the sweep.
    expect(names).toHaveLength(87);
    for (const name of names) {
      expect(() => (w as unknown as Record<string, (a: unknown) => unknown>)[name](args)).toThrow(
        /busy/i,
      );
    }
    // Reads answer through every second of a sync, because they take `db_read`.
    expect(readHandlers(db).collection_list({ query: { limit: 10, offset: 0 } }).total).toBe(1);
  });
});

/**
 * The roster — the one place this fake narrows what it stores before answering.
 *
 * `pairing::status` filters `revoked_at IS NOT NULL` out of `devices` while `identity::roster`
 * keeps every row, because the mark has two readers that need it (`add_device` clears it on a
 * re-pair, `baseline::peers_needing` reads it to skip a peer that will never answer) and the
 * panel is asking a different question: who is in the group *now*. The `paired` seed's third
 * device is what makes both halves assertable at once.
 */
describe("the roster", () => {
  it("keeps the removed device in the store and off what the status answers", () => {
    const db = seed("paired");

    expect(db.pairing.devices).toHaveLength(3);
    expect(db.pairing.devices.filter((d) => d.revokedAt !== null)).toHaveLength(1);

    const names = readHandlers(db).sync_pairing_status().devices.map((d) => d.name);
    expect(names).toEqual(["Desk", "Phone"]);
  });

  /** The removal is a stamp and not a delete here, exactly as it is in `sync_devices` — so the
   *  row leaving the panel and the row surviving the table are two separate facts, and this is
   *  the press that produces both. */
  it("takes a removed device off the status without dropping its row", () => {
    const db = seed("paired");
    writeHandlers(db).sync_device_revoke({ deviceId: "c0ffee00c0ffee00c0ffee00c0ffee00" });

    expect(db.pairing.devices).toHaveLength(3);
    expect(readHandlers(db).sync_pairing_status().devices.map((d) => d.name)).toEqual(["Desk"]);
    // The rotation is the removal, so the epoch moves with it.
    expect(readHandlers(db).sync_pairing_status().epoch).toBe(3);
  });

  /**
   * Leaving — **the whole roster goes, and the grant goes with it** (spec §2.1 and §2.3).
   *
   * The two halves are asserted together because either alone passes against a real bug. A
   * handler that cleared the group and kept the refresh secret leaves a device that reads
   * *Supporting* with nowhere to sync; one that cleared the grant with `revoke` rather than
   * `clear` leaves `groupBound: true`, and the panel draws *Membership ended* at a reader whose
   * pledge is untouched. Both are one field away from correct and neither shows up in the
   * roster.
   */
  it("takes this device out of the group and clears the grant with it", () => {
    const db = seed("paired");
    writeHandlers(db).sync_patreon_claim({ code: "PQRS-TVWX-YZ01" });
    expect(writeHandlers(db).sync_supporter_status().entitled).toBe(true);

    writeHandlers(db).sync_group_leave();

    // No group, and the roster is emptied rather than stamped: `identity::leave_group` is a
    // DELETE on both tables, where a removal is an UPDATE on one.
    expect(db.pairing.group).toBeNull();
    expect(db.pairing.devices).toEqual([]);
    expect(readHandlers(db).sync_pairing_status().groupId).toBeNull();
    // A device out of the box, field by field — and `groupBound` is the one that separates
    // `clear` from `revoke`, so it is spelled out rather than folded into a truthiness check.
    expect(writeHandlers(db).sync_supporter_status()).toEqual({
      entitled: false,
      status: "dead",
      since: null,
      groupBound: false,
    });
  });

  /** The one refusal `leave_group_now` has, in the crate's own sentence. Everything after that
   *  check is best effort, so this is the only way the press can answer no. */
  it("refuses to leave a group this device is not in", () => {
    expect(() => writeHandlers(makeDb()).sync_group_leave()).toThrow(/not in a pairing group/i);
  });
});

/**
 * `sync_pairing_poll` — one command answering both sides of `task-5-brief.md` Step 6's state
 * machine, and the regression a poll past completion shipped once.
 *
 * **The bug this pins**: the joining device's branch used to set `db.pairing.pending = null` the
 * moment it joined the group, so a *third* poll fell through to the `pending === null` guard and
 * answered `"idle"` — a device that had just paired reading as unpaired again on the very next
 * ask. Nothing in the real state machine clears `Pending` on success for either side, only cancel
 * and expiry do, and the offering device's branch was already written that way; every test below
 * polls at least one step past `"complete"` for exactly that reason, on both sides, so a story
 * asserting the correct behaviour can never see this fake disagree with it again.
 */
describe("the pairing ceremony's poll", () => {
  it("answers idle with nothing in flight", () => {
    expect(writeHandlers(seed("starter")).sync_pairing_poll()).toEqual({
      stage: "idle",
      sas: null,
    });
  });

  it("walks the offering device waiting -> compare -> complete, and stays complete", () => {
    const w = writeHandlers(seed("starter"));
    w.sync_pairing_begin();

    expect(w.sync_pairing_poll()).toEqual({ stage: "waiting", sas: null });
    const compared = w.sync_pairing_poll();
    expect(compared.stage).toBe("compare");
    expect(compared.sas).not.toBeNull();

    w.sync_pairing_confirm();
    expect(w.sync_pairing_poll()).toEqual({ stage: "complete", sas: null });
    // Past completion is where this fake diverged from the crate, on the *other* side — pinned
    // on this side too, since the crate's own asymmetry-free design says both must hold.
    expect(w.sync_pairing_poll()).toEqual({ stage: "complete", sas: null });
  });

  /** The one this fix is for — see the describe's own comment. */
  it("walks the joining device compare -> complete, and stays complete rather than reverting to idle", () => {
    const db = seed("starter");
    const w = writeHandlers(db);
    // A code from a separate offering device, exactly as a reader would carry one in from
    // another window — `sync_pairing_accept` only cares that it is well-shaped.
    const offerCode = writeHandlers(seed("starter")).sync_pairing_begin().code;

    const shake = w.sync_pairing_accept({ code: offerCode });
    expect(w.sync_pairing_poll()).toEqual({ stage: "compare", sas: shake.sas });

    const completed = w.sync_pairing_poll();
    expect(completed).toEqual({ stage: "complete", sas: null });
    // The join actually happened — this is not a stage label painted over an untouched store.
    expect(db.pairing.group).not.toBeNull();
    expect(db.pairing.devices).toHaveLength(2);

    // The regression: a further poll must answer `"complete"` again, not `"idle"` — which means
    // `pending` must still be there to ask.
    expect(w.sync_pairing_poll()).toEqual({ stage: "complete", sas: null });
    expect(db.pairing.pending).not.toBeNull();
  });
});

/**
 * The membership block — the three commands that replaced the relay-address field.
 *
 * **The whole value of this describe is that four states which share most of their fields cannot
 * be folded into one another.** A device out of the box and a device whose pledge ended differ in
 * exactly one boolean; a device paired *into* a group differs from a lapse in exactly one other.
 * Every assertion here is chosen so that collapsing any pair would go red.
 */
describe("the membership", () => {
  const lapsed = () => {
    const db = makeDb({ fault: "patreonLapsed" });
    applySupporterFault(db);
    return db;
  };
  const declined = () => {
    const db = makeDb({ fault: "patreonDeclined" });
    applySupporterFault(db);
    return db;
  };

  it("opens not connected, which is what every install answers", () => {
    // `toEqual` and never `toMatchObject`: the field this asserts was renamed `connected` →
    // `entitled` (spec §2.5), and a partial match would have gone on passing against a DTO
    // that had silently stopped carrying it — which is exactly how the rename reached the
    // shipped window as `undefined`.
    expect(writeHandlers(makeDb()).sync_supporter_status()).toEqual({
      entitled: false,
      status: "dead",
      since: null,
      groupBound: false,
    });
  });

  /**
   * **The shape `entitlement::revoke` actually leaves, asserted field by field.** `revoke` is
   * `clear` plus one row, so it deletes the refresh secret *and* the date: three of these four
   * fields are byte-identical to a device out of the box, and `groupBound` is the only thing
   * that remembers. A fault that seeded a plausible `since` here would let a panel keyed on the
   * date pass — which is not hypothetical, it is the bug this fault was written after.
   */
  it("leaves a lapse looking exactly like a fresh device but for groupBound", () => {
    const status = writeHandlers(lapsed()).sync_supporter_status();

    expect(status).toEqual({
      entitled: false,
      status: "dead",
      since: null,
      groupBound: true,
    });
    // Said again as a difference rather than as a value, because the value is what rots: this is
    // the assertion that fails if the fault is ever given a date "so the story reads better".
    expect(status.since).toBeNull();
  });

  /** §7.2: a declined card is a state, not an ending — still entitled, still dated, and the
   *  one supporter state where sync is expected to keep working. */
  it("keeps a declined card entitled and dated", () => {
    expect(writeHandlers(declined()).sync_supporter_status()).toMatchObject({
      entitled: true,
      status: "grace",
      groupBound: true,
    });
    expect(writeHandlers(declined()).sync_supporter_status().since).not.toBeNull();
  });

  /**
   * **The second device — spec §2.2, and the reader's item 3.**
   *
   * It has connected nothing: no refresh secret, no claim code ever pasted here. What it holds
   * is a `supporter_status` written by `/token`'s group door, and `entitled` is *derived* from
   * that rather than stored — which is the whole assertion. A fake that kept `entitled` as a
   * fourth stored boolean could set it either way and this would prove nothing.
   *
   * **It differs from a lapse in exactly one field**, which the next test says as a pair, and it
   * is the difference between drawing *Supporting since …* and drawing **Connect Patreon at a
   * paid-up supporter on every device but one**.
   */
  it("makes a device entitled through its group without a secret of its own", () => {
    const db = makeDb({ fault: "patreonGroupEntitled" });
    applySupporterFault(db);

    // The row half: this device holds nothing Patreon ever gave it. Written as an assertion
    // rather than left to the fault, because a fault that quietly set it would story the
    // *first* device and could never fail the bug this exists for.
    expect(db.supporter.refreshSecret).toBe(false);
    expect(writeHandlers(db).sync_supporter_status()).toEqual({
      entitled: true,
      status: "active",
      since: SUPPORTING_SINCE,
      groupBound: true,
    });
  });

  /**
   * The pair, side by side — **`status` is the only field between them.**
   *
   * Both hold no refresh secret and both are `groupBound`. Reading entitlement off the secret
   * alone collapses them into the lapse, which is the shipped bug; reading it off "a status row
   * exists" collapses every fresh install into the supporter, which takes the Connect button
   * away from the one panel that needs it. Only `active`/`grace` against `dead` gets both.
   */
  it("tells a group-entitled device from a lapse on the status alone", () => {
    const entitled = makeDb({ fault: "patreonGroupEntitled" });
    applySupporterFault(entitled);
    const ended = lapsed();

    expect(entitled.supporter.refreshSecret).toBe(ended.supporter.refreshSecret);
    expect(entitled.supporter.groupBound).toBe(ended.supporter.groupBound);
    expect(writeHandlers(entitled).sync_supporter_status().entitled).toBe(true);
    expect(writeHandlers(ended).sync_supporter_status().entitled).toBe(false);
  });

  /** ...and the half that is behaviour rather than a sentence: the second device syncs. Gated
   *  on the refresh secret it would answer `null` here, which is the panel drawing *sync is
   *  off* under a membership somebody is paying for. */
  it("syncs on a group entitlement, with no secret on this device", () => {
    const db = seed("paired");
    db.fault = "patreonGroupEntitled";
    applySupporterFault(db);

    expect(db.supporter.refreshSecret).toBe(false);
    expect(writeHandlers(db).sync_now()).toMatchObject({ pushed: 3 });
  });

  /** A second device may still connect a membership of its own, because it has claimed
   *  nothing — the refusal is spent codes, not covered devices. */
  it("still lets a group-entitled device claim a membership of its own", () => {
    const db = seed("paired");
    db.fault = "patreonGroupEntitled";
    applySupporterFault(db);

    expect(writeHandlers(db).sync_patreon_claim({ code: "PQRS-TVWX-YZ01" })).toMatchObject({
      entitled: true,
      status: "active",
    });
    expect(db.supporter.refreshSecret).toBe(true);
  });

  it("answers a URL for Connect Patreon and opens nothing", () => {
    expect(writeHandlers(makeDb()).sync_patreon_begin()).toMatch(/^https:\/\/www\.patreon\.com\//);
  });

  it("refuses a malformed claim code in the crate's own words", () => {
    expect(() => writeHandlers(makeDb()).sync_patreon_claim({ code: "ABCD" })).toThrow(
      /refused that claim code/i,
    );
  });

  it("connects on a well-shaped code, and lower case is the reader's to get wrong", () => {
    const db = makeDb();

    expect(writeHandlers(db).sync_patreon_claim({ code: " pqrs-tvwx-yz01 " })).toMatchObject({
      entitled: true,
      status: "active",
      groupBound: true,
    });
  });

  /** One-time at the far end, so the second press is the same refusal the first would have got
   *  a minute later. A fake that accepted it would teach a story a code can be reused. */
  it("refuses a second claim, because the relay has spent the code", () => {
    const db = makeDb();
    writeHandlers(db).sync_patreon_claim({ code: "PQRS-TVWX-YZ01" });

    expect(() => writeHandlers(db).sync_patreon_claim({ code: "PQRS-TVWX-YZ01" })).toThrow(
      /refused that claim code/i,
    );
  });

  /**
   * **Spec §6.3, and it is the reason the panel's *unpaired* sentence is not what a new
   * supporter sees.** `ensure_group` runs before the request that has to name a group, so a
   * claim on a device in no group founds one of one — which makes `RelayStatus.paired` true.
   */
  it("founds a group of one when the device is in none", () => {
    const db = makeDb();
    expect(readHandlers(db).sync_pairing_status().groupId).toBeNull();

    writeHandlers(db).sync_patreon_claim({ code: "PQRS-TVWX-YZ01" });

    expect(readHandlers(db).sync_pairing_status().groupId).not.toBeNull();
    expect(writeHandlers(db).sync_relay_status().paired).toBe(true);
  });

  /** ...and it leaves a group that already exists alone, or a claim on a paired device would
   *  throw the roster away — which is the one thing spec §6.3 has to not do. */
  it("leaves an existing group alone", () => {
    const db = seed("paired");
    const before = readHandlers(db).sync_pairing_status();

    writeHandlers(db).sync_patreon_claim({ code: "PQRS-TVWX-YZ01" });

    const after = readHandlers(db).sync_pairing_status();
    expect(after.groupId).toBe(before.groupId);
    expect(after.devices).toHaveLength(before.devices.length);
  });

  /**
   * **What replaced the empty address as "sync is off".** `sync_now` answered `null` for an
   * unset URL; it answers `null` for no grant now, and the panel's "there was nothing to sync"
   * sentence is drawn from exactly this.
   */
  it("has nothing to sync until a membership is connected", () => {
    const db = seed("paired");
    expect(writeHandlers(db).sync_now()).toBeNull();

    writeHandlers(db).sync_patreon_claim({ code: "PQRS-TVWX-YZ01" });

    expect(writeHandlers(db).sync_now()).toMatchObject({ pushed: 3 });
  });

  /** A declined card still mints tokens, so the trip still runs — the half of §7.2 that is
   *  about behaviour rather than about a sentence. */
  it("still syncs through a declined card", () => {
    const db = seed("paired");
    db.fault = "patreonDeclined";
    applySupporterFault(db);

    expect(writeHandlers(db).sync_now()).toMatchObject({ pushed: 3 });
  });

  /** ...and a lapse stops it, which is the same fact from the other side. */
  it("stops syncing once the membership has ended", () => {
    const db = seed("paired");
    db.fault = "patreonLapsed";
    applySupporterFault(db);

    expect(writeHandlers(db).sync_now()).toBeNull();
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
    const added = await invoke<EntryChange>("collection_add", {
      entry: { cardId: BOLT.id, finish: "nonfoil", quantity: 1 },
    });
    expect(added).toMatchObject({ quantity: 1, removed: false });
    // Schema v25's pair, whose four argument names are the reason this test exists: an add puts
    // the copy on the reader's *desk*, and only this write puts it in the deck.
    await expect(
      invoke<{ quantity: number }>("collection_to_deck", {
        entryId: added.id,
        deckId: 1,
        categoryId: db.deckCards[0].categoryId,
        quantity: 1,
      }),
    ).resolves.toMatchObject({ quantity: 1 });
    // A read taken after a write sees it: the two tables close over one store.
    await expect(invoke<DeckDetail>("deck_get", { id: 1, variant: "live" })).resolves.toMatchObject(
      { cards: [{ cardId: BOLT.id, quantity: 3, ownedQuantity: 1 }] },
    );
    await expect(
      invoke<{ quantity: number }>("deck_to_collection", {
        deckCardId: db.deckCards[0].id,
        quantity: 1,
      }),
    ).resolves.toMatchObject({ quantity: 1 });
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
    expect(readHandlers(makeDb({ marketplace: "cardmarket" })).get_marketplace()).toBe(
      "cardmarket",
    );

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
   * The second `app_meta` row, and the same three questions asked of it — because they are the
   * three every stored preference has, not three facts about marketplaces.
   *
   * The refusal is the one worth the assertion. `printing_group_by` discards a mode it does not
   * know *in silence*, so a fake that accepted `"rarity"` would save it, read back `"artist"`,
   * and look to a story exactly like a preference that worked — which is the bug the backend's
   * validation exists to make unreachable, and therefore the bug this file has to be capable of
   * refusing in the same place.
   */
  it("falls back to artist on a missing or unknown grouping row, and refuses a bad write", () => {
    expect(readHandlers(makeDb()).printing_group_by()).toBe("artist");
    expect(readHandlers(makeDb({ printingGroupBy: "rarity" })).printing_group_by()).toBe("artist");
    expect(readHandlers(makeDb({ printingGroupBy: "price" })).printing_group_by()).toBe("price");

    // Every mode the picker offers, not just the default: the setting outlives the process, so
    // what matters about it is that what went in comes back out.
    const db = makeDb();
    let chosen = "";
    for (const { value: mode } of PRINTING_GROUP_BY_OPTIONS) {
      writeHandlers(db).set_printing_group_by({ mode });
      expect(db.printingGroupBy).toBe(mode);
      expect(readHandlers(db).printing_group_by()).toBe(mode);
      chosen = mode;
    }

    expect(() => writeHandlers(db).set_printing_group_by({ mode: "rarity" })).toThrow(
      /is not a way this app groups printings/,
    );
    // Refused, and the row it would have overwritten is still the one that was chosen.
    expect(db.printingGroupBy).toBe(chosen);
  });

  /**
   * The fourth `app_meta` row and the only one whose value is an **object**, which is where its
   * three questions differ from the two above. There is no single default to fall back on: seven
   * walls have each been zoomed or not, so an absent key *is* the answer for one nobody has
   * touched — and the fallback for junk is therefore **per entry** rather than for the whole row,
   * which is the difference between a reader noticing one wall opened at 100% and noticing that
   * all of them did.
   */
  it("answers only the walls it has a usable zoom for, and refuses an unstorable one", () => {
    expect(readHandlers(makeDb()).card_zoom()).toEqual({});
    expect(readHandlers(makeDb({ cardZoom: { deck: 1.2 } })).card_zoom()).toEqual({ deck: 1.2 });

    // One bad entry costs one wall. `40` and the blank key are what a hand-edit or a build with a
    // wider ladder leaves behind; neither is a reason to forget the entry beside them.
    expect(
      readHandlers(makeDb({ cardZoom: { deck: 1.2, tags: 40, "": 1.5 } })).card_zoom(),
    ).toEqual({ deck: 1.2 });

    const db = makeDb();
    const w = writeHandlers(db);
    // Seven walls, seven independent memories — the whole reason the value is an object.
    w.set_card_zoom({ section: "deckSearch", zoom: 1.5 });
    w.set_card_zoom({ section: "deck", zoom: 0.7 });
    expect(readHandlers(db).card_zoom()).toEqual({ deckSearch: 1.5, deck: 0.7 });

    // **The section name is not validated and must not be**: the walls are TypeScript's
    // vocabulary and `zoom.rs` deliberately does not know them, which is what `isZoomSection`
    // exists for on the other side. A fake that checked here would hide that split.
    w.set_card_zoom({ section: "eighthWall", zoom: 1.1 });
    expect(readHandlers(db).card_zoom().eighthWall).toBe(1.1);

    // The number *is*, and the refusal is the half a fake is easiest to leave out — the read
    // drops an entry it cannot use in silence, so an unchecked write would look like it worked.
    for (const zoom of [0.49, 2.01, 0, -1, 40, NaN]) {
      expect(() => w.set_card_zoom({ section: "deck", zoom })).toThrow(/is not a card zoom/);
    }
    expect(() => w.set_card_zoom({ section: "", zoom: 1 })).toThrow(/cannot be blank/);
    // Refused, and the entry each would have overwritten is still the one that was chosen.
    expect(db.cardZoom.deck).toBe(0.7);
  });

  /**
   * The seventh `app_meta` row, and the one that is **half of each** of its two object-shaped
   * neighbours — which is why the questions asked of it are a subset rather than a copy.
   *
   * Like the zoom's and the layout's, there is no single default to fall back on: the collection
   * opens flattened and the wishlist does not, so an absent key is the only thing that can stand
   * for a switch nobody has pressed, and the whole answer is the two pages the row actually
   * names. Unlike them, there is no unusable **value** to ask about — a `bool` off the IPC
   * boundary is one of two things — so the write's only refusal is the blank section, and the
   * read's only filter is the same key.
   *
   * The round trip is what the pair is for, and it has to run **in both directions**: `false` is
   * a choice a reader made rather than a switch withdrawn, and on the collection it is the only
   * thing that can beat a `true` default. A fake that stored `true` and deleted on `false` would
   * pass every flattening assertion and lose the un-flattening for good.
   */
  it("answers only the pages it has a switch for, remembers both directions, and refuses a blank section", () => {
    expect(readHandlers(makeDb()).flatten_state()).toEqual({});
    expect(readHandlers(makeDb({ flattenState: { collection: false } })).flatten_state()).toEqual({
      collection: false,
    });

    // One unusable key costs one page. A blank section is what a hand-edit leaves behind — the
    // write below refuses it — and it is no reason to forget the entry beside it.
    expect(
      readHandlers(makeDb({ flattenState: { wishlist: true, "": true } })).flatten_state(),
    ).toEqual({ wishlist: true });

    const db = makeDb();
    const w = writeHandlers(db);
    // Two cabinets, two independent memories — the whole reason the value is an object, and the
    // reason it matters more here than for the two rows above: the defaults differ, so a write
    // that leaked across would not merely be wrong, it would be wrong in a way that looks right.
    w.set_flatten_state({ section: "collection", flattened: false });
    w.set_flatten_state({ section: "wishlist", flattened: true });
    expect(readHandlers(db).flatten_state()).toEqual({ collection: false, wishlist: true });

    // The way back. `false` wrote an entry above; `true` has to overwrite it rather than the read
    // falling back on the store's own default.
    w.set_flatten_state({ section: "collection", flattened: true });
    expect(readHandlers(db).flatten_state().collection).toBe(true);

    // **The section name is not validated and must not be**: which pages have a cabinet is
    // TypeScript's vocabulary and `flatten.rs` deliberately does not know them, which is what
    // `isFlattenSection` exists for on the other side.
    w.set_flatten_state({ section: "shoebox", flattened: true });
    expect(readHandlers(db).flatten_state().shoebox).toBe(true);

    // The blank one is the whole of the validation, and there is deliberately no second refusal
    // beside it — see this test's note.
    expect(() => w.set_flatten_state({ section: "", flattened: true })).toThrow(/cannot be blank/);
    // `Object.keys` rather than `toHaveProperty("")` — an empty path is not a key vitest's
    // matcher can be asked about, it throws inside the matcher itself.
    expect(Object.keys(db.flattenState)).not.toContain("");
  });

  /**
   * The fifth `app_meta` row, and the one where **two of the three questions above have no
   * answer** — which is why it gets a test of its own rather than a line in one of theirs.
   *
   * There is no unknown-value case and no never-written case to ask about. The row holds a
   * boolean, `nav_collapsed` is infallible at the far end, and every unreadable state the Rust
   * can meet — no row, a junk row, a row a newer build wrote a word into — collapses to `false`
   * before the value crosses the IPC boundary. So "never written" and "written to the default"
   * are one state here on purpose, and a fake that invented a third would be storying the app
   * against a backend it does not have.
   *
   * What is left is the round trip, and the round trip is the whole of what this pair is for: a
   * press has to survive the next launch, in **both** directions. Collapsing is the easy half to
   * get right and expanding again is the one a fake that only ever stored `true` would pass.
   */
  it("opens the shell expanded, and remembers a collapse in both directions", () => {
    // Not `null`, and that is the assertion rather than an incidental `toBe`: a fresh database
    // answers the same `false` an unreadable one does, which is the state every story that says
    // nothing about the sidebar stands in.
    expect(readHandlers(makeDb()).nav_collapsed()).toBe(false);
    expect(readHandlers(makeDb({ navCollapsed: true })).nav_collapsed()).toBe(true);

    const db = makeDb();
    const w = writeHandlers(db);
    w.set_nav_collapsed({ collapsed: true });
    expect(db.navCollapsed).toBe(true);
    expect(readHandlers(db).nav_collapsed()).toBe(true);

    // The way back. The shell is read once at launch and owns its state afterwards, so this is
    // the half a story cannot see going wrong until the *next* mount.
    w.set_nav_collapsed({ collapsed: false });
    expect(db.navCollapsed).toBe(false);
    expect(readHandlers(db).nav_collapsed()).toBe(false);

    // Five rows of one key/value table: pressing the sidebar toggle must not be a way to lose
    // one of the four beside it.
    w.set_printing_group_by({ mode: "set" });
    w.set_nav_collapsed({ collapsed: true });
    expect(readHandlers(db).printing_group_by()).toBe("set");
  });

  /**
   * The same split every `app_meta` pair here draws, and the only refusal this one has.
   *
   * `set_marketplace`, `set_printing_group_by` and `set_card_zoom` each open with a validation
   * *and* the busy check; this write has nothing to validate, because a `boolean` off the IPC
   * boundary has no junk state for a check to catch. That leaves the sync as the whole of what
   * it can refuse — and the read beside it refusing nothing at all, since it takes `db_read`
   * and answers through every second of a sync.
   *
   * The busy sweep above already walks every write including this one; what it cannot say is
   * that the *read* stayed live, which is the half of the split a reader mid-sync actually sees:
   * the shell still draws in the shape they left it, and only the press is turned away.
   */
  it("refuses to collapse the sidebar mid-sync, and still says how it is drawn", () => {
    const db = makeDb({ navCollapsed: true, fault: "busy" });
    expect(() => writeHandlers(db).set_nav_collapsed({ collapsed: false })).toThrow(/busy/i);
    // Refused, and the row it would have overwritten is untouched — so the shell a reader
    // pressed at is still the shell the next read describes.
    expect(db.navCollapsed).toBe(true);
    expect(readHandlers(db).nav_collapsed()).toBe(true);
  });

  /**
   * The third `app_meta` row, and the one **no command sets on purpose**: `deck_create` writes
   * it as a side effect of making a deck, so the questions worth asking of it are questions
   * about the create — a reader who has never made one, the format the row actually ended up
   * carrying, and a create that was refused.
   */
  it("remembers the format of the last deck created, and only of one that was created", () => {
    // Never written, because nothing has been created. The dialog's own default is what stands
    // in for it, and only the caller can supply that.
    expect(readHandlers(makeDb()).deck_last_format()).toBeNull();

    const db = makeDb();
    const w = writeHandlers(db);
    w.deck_create({ deck: { name: "Burn", formatKey: "modern" } });
    expect(readHandlers(db).deck_last_format()).toBe("modern");

    // The last create wins: this is a memory of what the reader just did, not a first choice
    // they are stuck with.
    w.deck_create({ deck: { name: "Atraxa", formatKey: "commander" } });
    expect(readHandlers(db).deck_last_format()).toBe("commander");

    // The **validated** key rather than the raw input. A blank format makes a `casual` deck, so
    // `casual` is what a blank format is remembered as — storing the argument instead would
    // hand the next dialog a blank and look like a memory that had never been written.
    expect(w.deck_create({ deck: { name: "Kitchen table", formatKey: "" } }).formatKey).toBe(
      "casual",
    );
    expect(readHandlers(db).deck_last_format()).toBe("casual");

    // A refused create writes nothing at all — the row and the memory are one transaction, so a
    // deck that never existed cannot leave a preference behind. Both refusals, because they
    // happen at different points and only one of them is about the format.
    expect(() => w.deck_create({ deck: { name: "Burn", formatKey: "premodern" } })).toThrow(
      /not a format this app knows/,
    );
    expect(() => w.deck_create({ deck: { name: "   ", formatKey: "modern" } })).toThrow(
      /needs a name/,
    );
    expect(readHandlers(db).deck_last_format()).toBe("casual");

    // And a store is a store: none of that reached a world that was not asked.
    expect(readHandlers(makeDb()).deck_last_format()).toBeNull();
  });

  /**
   * The one place this row differs from the two above it: an unplaceable key comes back
   * **verbatim** where theirs fall back on a default. There is no list on this side to check it
   * against — the formats are `format_specs`' rows and the narrowing is the webview's — and
   * `premodern` is the standing proof, a format this fixture's 12 specs refuse to *create* in
   * and this read still hands over.
   */
  it("hands back a stored format this build cannot place, rather than a default", () => {
    expect(readHandlers(makeDb({ lastDeckFormat: "premodern" })).deck_last_format()).toBe(
      "premodern",
    );
  });

  /** Three rows of one key/value table: writing any of them must not be a way to lose another. */
  it("keeps the grouping, the marketplace and the remembered format apart", () => {
    const db = makeDb();
    writeHandlers(db).set_printing_group_by({ mode: "set" });
    writeHandlers(db).set_marketplace({ id: "cardmarket" });
    writeHandlers(db).deck_create({ deck: { name: "Burn", formatKey: "modern" } });

    expect(readHandlers(db).printing_group_by()).toBe("set");
    expect(readHandlers(db).get_marketplace()).toBe("cardmarket");
    expect(readHandlers(db).deck_last_format()).toBe("modern");
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
      cardCount: 52,
      updatedAt: null,
    });
    expect(() => writeHandlers(makeDb({ fault: "syncError" })).sync_run()).toThrow(/rate limited/);
  });
});

/**
 * The Oracle tag taxonomy, whose whole contract is a **shape** rather than a set of values:
 * one entry per requested id, in request order, deduped, empty for anything unknown.
 *
 * Every clause of that is a way a fixture can look perfectly fine in Storybook and break the
 * real UI, because a component that matches by position instead of by id renders correctly
 * against a fake that never reorders and never drops.
 */
describe("the Oracle tag taxonomy", () => {
  const BOLT_ORACLE = BOLT.oracleId;

  /** The seed's own state: ingested, fresh, and answering slugs. */
  const tagged = () => seed("starter");

  /**
   * Subscribe to `oracle-tags:progress` the way a component does — through the fake's own
   * `listen`, into whichever scope is active — so the phase order asserted below is the one a
   * subscriber would really hear rather than one read off the handler's source.
   */
  async function watchPhases() {
    const seen: string[] = [];
    const stop = await listen<{ phase: string }>("oracle-tags:progress", (e) =>
      seen.push(e.payload.phase),
    );
    return { seen, stop };
  }

  /**
   * The names in `ORACLE_TAGGINGS` are resolved against `cards.ts`, which is generated
   * wholesale — so a corpus refresh that renamed or dropped a card would silently shrink the
   * taxonomy to nothing anybody noticed. This is what notices.
   */
  it("resolves every tagged name against the generated corpus", () => {
    const names = new Set(CARDS.map((c) => c.name));
    expect(ORACLE_TAGGED_NAMES.filter((n) => !names.has(n))).toEqual([]);
  });

  /**
   * The counts `.storybook/CLAUDE.md` quotes, measured here rather than asserted in prose — a
   * prose-only edit routes to neither CI job, and every count in that file has drifted at least
   * once. **Both numbers, because they are two facts**: the taxonomy is keyed by oracle card
   * and a story renders printings, so 32 tagged cards cover 42 of the 52 rows. The ten left
   * are both basic lands, Delver of Secrets, Tarmogoyf and Little Girl — deliberately untagged,
   * so every `starter` deck holds cards on both sides of the type-line fallback — plus the five
   * layout-zoo rows added for the orientation control, which are there to be *drawn* sideways
   * rather than to be filed.
   */
  it("covers 32 of the corpus's oracle cards and 42 of its printings", () => {
    const tagged = new Set(oracleTagCards(CARDS).map((r) => r.oracleId));

    expect(ORACLE_TAGGED_NAMES).toHaveLength(32);
    expect(tagged.size).toBe(32);
    // 42 rather than 38 since 2026-08-21: the four named-treatment printings are all
    // reprints of oracle cards this list already covers, so they widen the *printing* reach
    // without touching the 32 oracle cards — which is the distinction this test is for.
    expect(CARDS.filter((c) => tagged.has(c.oracleId))).toHaveLength(42);
    expect(CARDS).toHaveLength(52);
  });

  /** Keyed by **oracle card**: all four Lightning Bolt printings share one set of rows, which
   *  is what makes the printing-keyed read a join rather than a lookup. */
  it("writes one set of rows per oracle card, not per printing", () => {
    const rows = oracleTagCards(CARDS);
    const bolts = rows.filter((r) => r.oracleId === BOLT_ORACLE);

    expect(CARDS.filter((c) => c.oracleId === BOLT_ORACLE).length).toBeGreaterThan(1);
    expect(bolts.map((r) => r.slug)).toEqual([
      "burn",
      "damage",
      "removal",
      "removal-creature",
      "spot-removal",
    ]);
  });

  /**
   * **The status can never fail.** A store that has never ingested answers every field null
   * with `stale: true` — a real state, not an error — which is what lets every caller read it
   * with no guard, and what puts the app on the type-line fallback rather than on a banner.
   */
  it("answers a never-ingested store rather than refusing", () => {
    const status = readHandlers(makeDb()).oracle_tags_status();

    expect(status).toEqual({
      updatedAt: null,
      ingestedAt: null,
      checkedAt: null,
      tagCount: null,
      taggingCount: null,
      stale: true,
      refreshing: false,
    });
  });

  /** …and an ingested one carries the file's own figures, with `ingestedAt` and `checkedAt`
   *  both inside the seven-day window, so nothing seeded is due for a refresh. */
  it("answers an ingested store as fresh, with the file's counts", () => {
    const status = readHandlers(tagged()).oracle_tags_status();

    expect(status).toMatchObject({ tagCount: 4_521, taggingCount: 229_633, stale: false });
    expect(status.ingestedAt).not.toBeNull();
  });

  /**
   * The whole contract of both reads, in one assertion each: **order preserved, duplicates
   * dropped, unknown ids answered rather than omitted.** A decklist with two printings of one
   * card sends the same id twice, and a caller reading `result[i]` against `input[i]` works
   * right up until it does.
   */
  it("answers one entry per distinct printing id, in request order, empty for the unknown", () => {
    const db = tagged();
    const asked = [BOLT.id, "not-a-card", BOLT_2X2.id, BOLT.id];

    const answer = readHandlers(db).oracle_tags_for_printings({ cardIds: asked });

    // Three, not four: the repeated Bolt is one entry. Shorter than the request, which is the
    // property `ipc.ts` tells every caller to match by id for.
    expect(answer.map((a) => a.cardId)).toEqual([BOLT.id, "not-a-card", BOLT_2X2.id]);
    expect(answer[0].slugs).toContain("removal");
    // An id the corpus does not have is an **answer**, not an absence — the caller's response
    // to it is the same as to an untagged card, so telling them apart would help nobody.
    expect(answer[1].slugs).toEqual([]);
    // Two printings of one oracle card get identical slugs, because a tag is a fact about the
    // oracle text.
    expect(answer[2].slugs).toEqual(answer[0].slugs);
  });

  it("answers the oracle-keyed read under `oracleId`, by the same rules", () => {
    const db = tagged();

    const answer = readHandlers(db).oracle_tags_for_cards({
      oracleIds: [BOLT_ORACLE, "  ", BOLT_ORACLE, "no-such-oracle"],
    });

    // The blank is dropped like a duplicate is — `read_tags_keyed` trims and skips empties —
    // and the field is `oracleId`, never `cardId`.
    expect(answer.map((a) => a.oracleId)).toEqual([BOLT_ORACLE, "no-such-oracle"]);
    expect(answer[0].slugs).toContain("burn");
    expect(answer[1].slugs).toEqual([]);
  });

  /** An empty request is answered without reading a row: Rust prepares no statement for one,
   *  and a caller with nothing to categorise must not have to guard the call. */
  it("answers an empty request with an empty list, on a store with no taxonomy at all", () => {
    const empty = makeDb();
    expect(readHandlers(empty).oracle_tags_for_printings({ cardIds: [] })).toEqual([]);
    expect(readHandlers(empty).oracle_tags_for_cards({ oracleIds: [] })).toEqual([]);
  });

  /** Every id answers an empty list when there is no taxonomy — the first-launch state, and
   *  the one the `oracleTagsMissing` fault stands a story in on a full corpus. */
  it("answers every id emptily when nothing has been ingested", () => {
    const answer = readHandlers(makeDb()).oracle_tags_for_printings({ cardIds: [BOLT.id] });
    expect(answer).toEqual([{ cardId: BOLT.id, slugs: [] }]);
  });

  /** A forced refresh fills both tables and walks the five phases. `force` is what a story has
   *  to send, because a taxonomy inside its weekly window is not due. */
  it("ingests the taxonomy on a forced refresh, and emits every phase", async () => {
    const db = seed("starter");
    db.oracleTags = [];
    db.oracleTagMeta = null;
    const phases = await watchPhases();

    const status = writeHandlers(db).oracle_tags_refresh({ force: true });

    phases.stop();
    expect(phases.seen).toEqual(["checking", "downloading", "downloading", "ingesting", "done"]);
    expect(db.oracleTags.length).toBeGreaterThan(0);
    expect(status.stale).toBe(false);
    expect(readHandlers(db).oracle_tags_for_printings({ cardIds: [BOLT.id] })[0].slugs).toContain(
      "removal",
    );
  });

  /** Not due, not forced: the status it already had, and **not a single event** — which is why
   *  a story that wants to watch the phases has to force one. */
  it("emits nothing for a refresh that is not due", async () => {
    const db = seed("starter");
    const phases = await watchPhases();

    writeHandlers(db).oracle_tags_refresh({ force: false });

    phases.stop();
    expect(phases.seen).toEqual([]);
  });

  /**
   * **A failed fetch leaves the previous taxonomy exactly where it was.** Stale categories beat
   * none, and nothing about categorising a card may fail a deck add — so the refusal is a
   * sentence and a row in `error_log`, and the screen behind it does not change at all.
   */
  it("keeps the tags it already had when a fetch fails, and writes the reason down", () => {
    const db = seed("starter");
    const before = db.oracleTags.length;
    db.fault = "oracleTagsFetchError";

    expect(() => writeHandlers(db).oracle_tags_refresh({ force: true })).toThrow(
      /could not be downloaded/,
    );

    expect(db.oracleTags).toHaveLength(before);
    expect(db.oracleTagMeta).not.toBeNull();
    expect(db.errorLog[db.errorLog.length - 1].operation).toBe("oracle_tags");
    // The status still answers, and still says the taxonomy is there: a refusal here is never a
    // reason to stop filing cards.
    expect(readHandlers(db).oracle_tags_status().ingestedAt).not.toBeNull();
  });

  /**
   * **`ORACLE_TAG_EDGES` is a claim about `ORACLE_TAGGINGS`, and this is what holds it to it.**
   *
   * Those taggings are written out already closed — every list carries its ancestors — so an
   * edge `child → parent` is the assertion that no card in the fixture carries the child without
   * the parent. Get one wrong and nothing else breaks: the rail would simply file a tag under a
   * heading whose `cardCount` did not include it, which reads as a counting bug three screens
   * away from the table that caused it.
   *
   * It is also why `repeatable-token-generator` has **no** edge to `token-generator` despite the
   * names — Ragavan carries the first without the second, so that edge is not in this taxonomy
   * and adding it on the strength of the spelling would fail here.
   */
  it("keeps every oracle parent edge consistent with the closed taggings", () => {
    const edges = oracleTagEdges();
    const bySlug = new Map(oracleTagCards(CARDS).map((r) => [r.oracleId, [] as string[]]));
    for (const row of oracleTagCards(CARDS)) bySlug.get(row.oracleId)!.push(row.slug);

    const broken: string[] = [];
    for (const slugs of bySlug.values()) {
      for (const edge of edges) {
        if (slugs.includes(edge.childSlug) && !slugs.includes(edge.parentSlug)) {
          broken.push(`${edge.childSlug} without ${edge.parentSlug}`);
        }
      }
    }
    expect(broken).toEqual([]);
    // Every slug an edge names has a row of its own, so no rail entry points at a tag the
    // taxonomy does not hold.
    const known = new Set(oracleTagRows().map((t) => t.slug));
    const dangling = edges
      .flatMap((e) => [e.childSlug, e.parentSlug])
      .filter((slug) => !known.has(slug));
    expect(dangling).toEqual([]);
  });
});

/**
 * The **art** taxonomy, whose whole contract is one word different from the oracle one's and
 * the difference decides every answer: it is keyed on the **illustration**.
 *
 * An art tag is a fact about a picture, not about a card. Get that wrong and the fake is still
 * plausible — a wall comes back, the counts are numbers — while every story on the page teaches
 * a reader that all four Lightning Bolts depict the same thing.
 */
describe("the art tag taxonomy", () => {
  /** The seed's own state: both taxonomies ingested, fresh, and answering. */
  const tagged = () => seed("starter");

  const LIGHTNING = CARDS.find((c) => c.name === "Lightning Bolt" && c.setCode === "lea")!;
  const LURRUS = CARDS.find((c) => c.name === "Lurrus of the Dream-Den")!;
  const LLANOWAR = CARDS.find((c) => c.name === "Llanowar Elves")!;
  const FOREST = CARDS.find((c) => c.name === "Forest" && c.setCode === "unf")!;
  const ISLAND = CARDS.find((c) => c.name === "Island" && c.setCode === "lea")!;

  /** `ART_TAGGINGS` names printings by `(name, setCode)` against a corpus that is generated
   *  wholesale, so a regenerated `cards.ts` could silently empty the taxonomy — a pair that no
   *  longer resolves contributes nothing and nothing else would go red. This notices, exactly as
   *  {@link ORACLE_TAGGED_NAMES}' test does one taxonomy over. */
  it("resolves every tagged printing against the generated corpus", () => {
    const printings = new Set(CARDS.map((c) => `${c.name} ${c.setCode}`));

    expect(ART_TAGGED_PRINTINGS.filter((p) => !printings.has(p))).toEqual([]);
    // Eleven printings, eleven illustrations: no two of them share an art, so each tagging lands
    // on a row of its own and the counts below are readable one card at a time.
    expect(ART_TAGGED_PRINTINGS).toHaveLength(11);
    expect(new Set(artTagIllustrations(CARDS).map((r) => r.illustrationId)).size).toBe(11);
  });

  /**
   * **The key is the illustration, and this is the assertion that says so.**
   *
   * Lightning Bolt has four printings, four illustrations and one oracle id. `lightning` is on
   * the `lea` art alone, so the art taxonomy answers one printing where the *oracle* tag `burn`
   * answers all four — which is the whole difference between the two tables, and it is invisible
   * unless the other three Bolts are left untagged.
   */
  it("tags a printing's illustration, never its oracle card", () => {
    const db = tagged();
    const bolts = CARDS.filter((c) => c.name === "Lightning Bolt");
    expect(bolts).toHaveLength(4);

    const lit = db.artTags.filter((r) => r.slug === "lightning");
    expect(lit.map((r) => r.illustrationId)).toEqual([LIGHTNING.illustrationId]);

    // The oracle side of the same card, for contrast: one set of rows shared by all four.
    const art = readHandlers(db).search_cards({
      req: { artTags: { include: ["lightning"] }, limit: 50, offset: 0 },
    });
    const oracle = readHandlers(db).search_cards({
      req: { oracleTags: { include: ["burn"] }, limit: 50, offset: 0 },
    });
    expect(art.items.map((i) => i.id)).toEqual([LIGHTNING.id]);
    expect(oracle.items.filter((i) => i.name === "Lightning Bolt")).toHaveLength(4);
  });

  /**
   * **The closure is the answer and the direct taggings are the wrong number.**
   *
   * Nothing is tagged `animal` or `creature` directly. `cat` is on Lurrus and `monkey` on
   * Ragavan, so a query for their grandparent has to reach both through the hierarchy — the same
   * shape as the real `removal`, which has zero direct taggings and answers 6 686 cards. A
   * predicate over the taggings would answer this with nothing at all, which looks like a data
   * problem rather than a query one.
   */
  it("answers a category tag through the closure, not through its own taggings", () => {
    const db = tagged();
    const rows = readHandlers(db).search_cards({
      req: { artTags: { include: ["animal"] }, limit: 50, offset: 0 },
    });

    expect(rows.items.map((i) => i.name).sort()).toEqual([
      "Lurrus of the Dream-Den",
      "Ragavan, Nimble Pilferer",
    ]);
    // …and `creature`, one level further up, adds the angels, the elf and the sphinx.
    const creatures = readHandlers(db).search_cards({
      req: { artTags: { include: ["creature"] }, limit: 50, offset: 0 },
    });
    expect(creatures.total).toBe(6);
  });

  /**
   * **`forest` has two parents and both are followed.** 43 % of Scryfall's art tags do, so a
   * closure walk that took the first parent and stopped would be wrong for two tags in five —
   * and it would be wrong quietly, since the tag it *did* reach would still answer.
   */
  it("follows every parent edge, not the first", () => {
    const rows = artTagIllustrations(CARDS).filter(
      (r) => r.illustrationId === FOREST.illustrationId,
    );
    expect(rows.map((r) => r.slug).sort()).toEqual(["forest", "landscape", "plant"]);
  });

  /**
   * **The weight floor drops `weak` and nothing else**, and the two counts are what make that
   * visible: Llanowar Elves' `forest` is `weak` (the wood behind the elf is the background
   * element Scryfall's own definition names), so `landscape` answers three illustrations open
   * and two floored.
   *
   * `median` surviving is the half a control's wording rests on — the predicate is
   * `weight <> 'weak'`, so this **excludes background detail** rather than narrowing to strong
   * matches, and Forest `unf` is `median` and stays.
   */
  it("drops only the weak rows when the floor is on", () => {
    const db = tagged();
    const open = readHandlers(db).search_cards({
      req: { artTags: { include: ["landscape"] }, limit: 50, offset: 0 },
    });
    const floored = readHandlers(db).search_cards({
      req: { artTags: { include: ["landscape"] }, artWeightFloor: "strong", limit: 50, offset: 0 },
    });

    expect(open.items.map((i) => i.name).sort()).toEqual(["Forest", "Island", "Llanowar Elves"]);
    expect(floored.items.map((i) => i.name).sort()).toEqual(["Forest", "Island"]);

    // **`"any"` is not a floor**, and neither is a word this build has not heard of: an
    // unrecognised value fails *open*, showing more rather than hiding cards nobody reports.
    const any = readHandlers(db).search_cards({
      req: { artTags: { include: ["landscape"] }, artWeightFloor: "any", limit: 50, offset: 0 },
    });
    expect(any.total).toBe(3);
  });

  /**
   * **The closure's weight is the strongest tagging it descends from, not the last one written.**
   *
   * Island `lea` is tagged `water` strong *and* `landscape` median, and both reach `landscape` —
   * directly and through `water`. The row has to come out `strong`, so the floored search above
   * keeps it. A single-tagging fixture passes a last-write-wins fold by luck of ordering.
   */
  it("folds a closure row to the strongest tagging that reaches it", () => {
    const rows = artTagIllustrations(CARDS).filter(
      (r) => r.illustrationId === ISLAND.illustrationId,
    );
    expect(rows).toEqual([
      { illustrationId: ISLAND.illustrationId, slug: "landscape", weight: "strong" },
      { illustrationId: ISLAND.illustrationId, slug: "water", weight: "strong" },
    ]);
    // The weak one keeps its weight all the way up: nothing stronger reaches Llanowar's
    // `landscape`, so the fold leaves it alone.
    const elves = artTagIllustrations(CARDS).filter(
      (r) => r.illustrationId === LLANOWAR.illustrationId && r.slug === "landscape",
    );
    expect(elves.map((r) => r.weight)).toEqual(["weak"]);
  });

  /**
   * **One tagging reaches every printing that shares the art**, which is the positive half of
   * the illustration rule — Lightning Bolt is the negative half.
   *
   * Ancestral Recall `lea` and `2ed` are one illustration (Mark Poole's, `d20eda7b…`) under two
   * printings. Built here rather than seeded, because the seed only tags motifs somebody has
   * actually checked are in the picture and nobody has checked that one: what this is about is
   * the join, and the join does not care what the slug says.
   */
  it("reaches both printings that share one illustration", () => {
    const both = CARDS.filter((c) => c.name === "Ancestral Recall");
    expect(both).toHaveLength(2);
    expect(both[0].illustrationId).toBe(both[1].illustrationId);

    const db = makeDb({
      artTags: [{ illustrationId: both[0].illustrationId!, slug: "flower", weight: "median" }],
    });
    const rows = readHandlers(db).search_cards({
      req: { artTags: { include: ["flower"] }, limit: 50, offset: 0 },
    });
    expect(rows.items.map((i) => i.setCode).sort()).toEqual(["2ed", "lea"]);
  });

  /**
   * **A printing with no `illustration_id` fails every include and passes every exclude**, and
   * that is SQL's rule rather than a choice — the real predicate correlates on a NULL column, so
   * the `EXISTS` finds nothing and the `NOT EXISTS` around it is satisfied. Three of the 43
   * printings are in that state, against 4 977 of 116 712 live ones.
   */
  it("keeps an illustration-less printing out of every include and in every exclude", () => {
    const db = tagged();
    const blind = CARDS.filter((c) => c.illustrationId === null);
    expect(blind.length).toBeGreaterThan(0);

    const included = readHandlers(db).search_cards({
      req: { artTags: { include: ["creature"] }, limit: 50, offset: 0 },
    });
    const excluded = readHandlers(db).search_cards({
      req: { artTags: { exclude: ["creature"] }, limit: 200, offset: 0 },
    });
    for (const card of blind) {
      expect(included.items.some((i) => i.id === card.id)).toBe(false);
      expect(excluded.items.some((i) => i.id === card.id)).toBe(true);
    }
  });

  /**
   * **The exclude arm ignores the floor, deliberately.** "Not a landscape" means not a landscape
   * at all, including weakly — a floor here would let the weakly-tagged cards back into a result
   * the reader asked to have none of, which is the one direction a filter must never fail in.
   */
  it("excludes a weak match even with the floor on", () => {
    const db = tagged();
    const rows = readHandlers(db).search_cards({
      req: { artTags: { exclude: ["landscape"] }, artWeightFloor: "strong", limit: 200, offset: 0 },
    });
    expect(rows.items.some((i) => i.id === LLANOWAR.id)).toBe(false);
  });

  /**
   * **Includes INTERSECT and the two taxonomies AND with each other**, so "an animal that ramps"
   * is one request. A union here would answer a superset that looks entirely plausible.
   */
  it("intersects the includes and ANDs the two taxonomies", () => {
    const db = tagged();
    // Lurrus is a cat; Ragavan is a monkey. Nothing is both.
    expect(
      readHandlers(db).search_cards({
        req: { artTags: { include: ["cat", "monkey"] }, limit: 50, offset: 0 },
      }).total,
    ).toBe(0);
    // An animal that also ramps: Ragavan makes treasure but is not tagged `ramp`, and Lurrus is
    // recursion — so the pair narrows to nothing, where either alone answers something.
    const animals = readHandlers(db).search_cards({
      req: { artTags: { include: ["animal"] }, limit: 50, offset: 0 },
    });
    const both = readHandlers(db).search_cards({
      req: {
        artTags: { include: ["animal"] },
        oracleTags: { include: ["recursion"] },
        limit: 50,
        offset: 0,
      },
    });
    expect(animals.total).toBe(2);
    expect(both.items.map((i) => i.name)).toEqual(["Lurrus of the Dream-Den"]);
  });

  /** A blank or all-blank list is **no filter**, never "match nothing" — `filters::picked_tags`.
   *  A cleared chip row sends `[]` and some send `[""]`, and either taken literally would be an
   *  empty wall with no chip drawn to explain it. */
  it("treats an empty or blank tag list as no filter at all", () => {
    const db = tagged();
    const all = readHandlers(db).search_cards({ req: { limit: 200, offset: 0 } }).total;

    for (const include of [[], [""], ["  "]]) {
      expect(
        readHandlers(db).search_cards({ req: { artTags: { include }, limit: 200, offset: 0 } })
          .total,
      ).toBe(all);
    }
  });

  /**
   * **The facets narrow by a tag**, since 2026-08-20. `run_facets` resolves each picked slug
   * through its closure into a bitset over `cards.rowid`, intersects those with the FTS one and
   * hands `compute` the single narrowing set it takes — so the counts describe the tag-filtered
   * wall rather than the corpus above it, and this mirror stopped stripping the three tag fields
   * out of its base on the same day.
   *
   * Read against `search_cards`' own answer rather than a written-down number, because the two
   * agreeing is the whole claim: a count that disagreed with the wall beside it would grey a set
   * the search returns rows for. Uncollapsed on purpose — `facet_cards.total` is **printings**,
   * always, while a collapsed search counts cards.
   */
  it("facets a tag-filtered request over the tag-filtered corpus", () => {
    const db = tagged();
    const plain = readHandlers(db).facet_cards({ req: { limit: 50, offset: 0 } });
    const req = { artTags: { include: ["animal"] }, limit: 200, offset: 0 };
    const tagFiltered = readHandlers(db).facet_cards({ req });
    const wall = readHandlers(db).search_cards({ req });

    expect(wall.total).toBeGreaterThan(0);
    expect(tagFiltered.total).toBe(wall.total);
    expect(tagFiltered.total).toBeLessThan(plain.total);

    // Every other dimension narrows with it — and a set the motif cannot reach arrives as an
    // explicit **0** rather than as an absent key, which is what lets the picker grey a row
    // instead of dropping it.
    const reachable = new Set(wall.items.map((i) => i.setCode));
    expect(reachable.size).toBeGreaterThan(0);
    expect(Object.keys(tagFiltered.sets).length).toBeGreaterThan(reachable.size);
    for (const [code, count] of Object.entries(tagFiltered.sets)) {
      if (!reachable.has(code)) expect(count).toBe(0);
    }
  });

  /**
   * The weight floor rides the art **include** arm and nothing else, so it moves the counts the
   * same way the wall moves — `landscape` is the seed's floored motif, weak on Llanowar Elves.
   */
  it("narrows the facet counts by the art weight floor", () => {
    const db = tagged();
    const req = { artTags: { include: ["landscape"] }, limit: 200, offset: 0 };
    const open = readHandlers(db).facet_cards({ req });
    const floored = readHandlers(db).facet_cards({ req: { ...req, artWeightFloor: "strong" } });

    expect(open.total).toBe(3);
    expect(floored.total).toBe(2);
    expect(floored.total).toBe(
      readHandlers(db).search_cards({ req: { ...req, artWeightFloor: "strong" } }).total,
    );
  });

  /** The status is the oracle one's twin and cannot fail either: a store that has never
   *  ingested answers every field null with `stale: true`, which is what lets the Tags page say
   *  it has nothing yet rather than draw a banner. */
  it("answers a never-ingested art store rather than refusing", () => {
    expect(readHandlers(makeDb()).art_tags_status()).toEqual({
      updatedAt: null,
      ingestedAt: null,
      checkedAt: null,
      tagCount: null,
      taggingCount: null,
      stale: true,
      refreshing: false,
    });
    // …and the seeded one carries the real file's figures, inside the seven-day window.
    expect(readHandlers(tagged()).art_tags_status()).toMatchObject({
      tagCount: 11_531,
      taggingCount: 475_163,
      stale: false,
    });
  });

  /**
   * A refresh emits its five phases on **its own channel** and fills all four tables. The
   * channel matters: either taxonomy may be refreshing while the other is, so one shared line
   * would have them fighting over it.
   */
  it("rebuilds the art taxonomy and reports it on art-tags:progress", async () => {
    const db = makeDb();
    const seen: string[] = [];
    const stop = await listen<{ phase: string }>("art-tags:progress", (e) =>
      seen.push(e.payload.phase),
    );

    const status = writeHandlers(db).art_tags_refresh({ force: true });

    expect(seen).toEqual(["checking", "downloading", "downloading", "ingesting", "done"]);
    expect(status.ingestedAt).not.toBeNull();
    expect(db.artTags.length).toBeGreaterThan(0);
    expect(db.artTagTaxonomy).toHaveLength(13);
    expect(db.artTagParents.length).toBeGreaterThan(0);
    await stop();
  });

  /** The fetch failing leaves **the taxonomy already ingested exactly where it was** and writes
   *  the reason to `error_log` under its own dataset name — so a reader can tell an art tag
   *  failure from an oracle one in the same list. */
  it("keeps the art taxonomy it had when a refresh fails", () => {
    const db = tagged();
    const before = db.artTags.length;
    db.fault = "artTagsFetchError";

    expect(() => writeHandlers(db).art_tags_refresh({ force: true })).toThrow(
      /could not be downloaded/,
    );
    expect(db.artTags).toHaveLength(before);
    expect(db.artTagMeta).not.toBeNull();
    expect(db.errorLog[db.errorLog.length - 1].operation).toBe("art_tags");
  });

  /** Not stale and not forced is a **no-op**: it answers the status it already had and emits
   *  nothing, which is why a story that wants the phases has to press with `force`. */
  it("does nothing at all when the taxonomy is fresh and nobody forced it", async () => {
    const db = tagged();
    const seen: string[] = [];
    const stop = await listen<{ phase: string }>("art-tags:progress", (e) =>
      seen.push(e.payload.phase),
    );

    writeHandlers(db).art_tags_refresh({ force: false });

    expect(seen).toEqual([]);
    await stop();
  });

  /** {@link LURRUS} is here so the two constants above are not unused, and because it is the one
   *  card carrying **only** a leaf tag — the whole reason the closure test above can tell a
   *  rollup from a direct tagging. */
  it("gives the leaf-only card exactly its leaf and its ancestors", () => {
    const rows = artTagIllustrations(CARDS).filter(
      (r) => r.illustrationId === LURRUS.illustrationId,
    );
    expect(rows.map((r) => r.slug)).toEqual(["animal", "cat", "creature"]);
  });
});

/**
 * Finding a tag, rather than finding a card that holds one — and switching one off.
 *
 * Two commands read the taxonomies and three write the reader's answer over them, and the rule
 * that ties them together is the one worth the assertions: **muting hides a tag, and never hides
 * a card.**
 */
describe("the tag search, the tag tree and muting", () => {
  const tagged = () => seed("starter");
  const slugs = (hits: { slug: string }[]) => hits.map((h) => h.slug);

  /** Substring, with the exact hit first and prefixes ahead of the rest — the three bands, and
   *  the departure from Scryfall that makes a type-ahead possible at all (`otag:remov` 404s
   *  there, verified live 2026-08-20). */
  it("matches a substring and ranks the exact hit first", () => {
    const hits = readHandlers(tagged()).tag_search({
      text: "creature",
      namespace: "both",
      limit: 20,
    });

    // Exact first, whatever its reach; `removal-creature` is a substring match behind it.
    expect(hits[0].slug).toBe("creature");
    expect(slugs(hits)).toContain("removal-creature");
  });

  /** The needle goes through the same `normalize` the ingest wrote `slug_norm` with, so
   *  punctuation and case are both ignored. Two copies of this rule would leave the search
   *  matching nothing with both halves self-consistent and no test failing. */
  it("normalises the needle the way the ingest normalised the column", () => {
    const read = readHandlers(tagged());
    for (const text of ["SPOT-REMOVAL", "spot removal", "spotremoval", "  spot!removal  "]) {
      expect(slugs(read.tag_search({ text, namespace: "oracle", limit: 20 }))[0]).toBe(
        "spot-removal",
      );
    }
  });

  /** **An empty box matches everything, not nothing** — so it opens on the tags with the widest
   *  reach rather than looking broken before it has been typed in. */
  it("answers the widest tags for an empty needle", () => {
    const hits = readHandlers(tagged()).tag_search({ text: "", namespace: "art", limit: 3 });

    expect(hits).toHaveLength(3);
    expect(hits[0].cardCount).toBeGreaterThanOrEqual(hits[1].cardCount);
  });

  /**
   * `"both"` puts **art first on an equal rank**: the page's job is an art theme, so a reader who
   * types a word both taxonomies know means the picture, and the oracle tag of that name is the
   * secondary reading.
   *
   * Built rather than seeded, and everything but the namespace is held equal on purpose — same
   * slug, same label, same band, same reach — because with any of those differing the tie never
   * comes up and the assertion passes on a rule that was never applied. The real taxonomies share
   * plenty of slugs (`dog` is in both) and mean different things by them.
   */
  it("puts art ahead of oracle on an equal rank", () => {
    const row = (id: string) => ({
      slug: "chimera",
      id,
      label: "Chimera",
      description: null,
      slugNorm: "chimera",
    });
    const db = makeDb({ artTagTaxonomy: [row("a-1")], oracleTagTaxonomy: [row("o-1")] });

    const hits = readHandlers(db).tag_search({ text: "chimera", namespace: "both", limit: 10 });

    expect(hits.map((h) => h.namespace)).toEqual(["art", "oracle"]);
    expect(hits.map((h) => h.cardCount)).toEqual([0, 0]);
  });

  /** A `cardCount` over the **closure**, a `childCount` over the visible children, and **every**
   *  parent rather than the first — the three numbers a rail draws itself out of. */
  it("counts a tag by its closure and names all of its parents", () => {
    const [forest] = readHandlers(tagged()).tag_search({
      text: "forest",
      namespace: "art",
      limit: 5,
    });

    expect(forest.cardCount).toBe(2);
    expect(forest.childCount).toBe(0);
    expect(forest.parents.map((p) => p.slug)).toEqual(["landscape", "plant"]);
    expect(forest.parents.every((p) => p.namespace === "art")).toBe(true);
  });

  /** The roots are the tags with no parent edge at all; a named parent answers its own children,
   *  and a tag with two parents is listed under **both**. */
  it("walks the tree one level at a time, listing a tag under every parent", () => {
    const read = readHandlers(tagged());

    expect(slugs(read.tag_children({ namespace: "art", slug: null })).sort()).toEqual([
      "creature",
      "landscape",
      "lightning",
      "plant",
    ]);
    expect(slugs(read.tag_children({ namespace: "art", slug: "creature" })).sort()).toEqual([
      "angel",
      "animal",
      "elf",
      "sphinx",
    ]);
    expect(slugs(read.tag_children({ namespace: "art", slug: "plant" }))).toContain("forest");
    expect(slugs(read.tag_children({ namespace: "art", slug: "landscape" }))).toContain("forest");
  });

  /** An unknown namespace **throws** rather than answering nothing: a typo and a taxonomy that
   *  has never been fetched would otherwise be the same answer, and only one of them is a bug. */
  it("refuses a namespace it does not know", () => {
    expect(() =>
      readHandlers(tagged()).tag_search({ text: "dog", namespace: "arty", limit: 5 }),
    ).toThrow(/unknown tag namespace/);
  });

  /**
   * `tag_resolve` is the *filter* side and is exact where the type-ahead above is a substring,
   * because a substring resolves one typed name to many tags that would then have to be ORed —
   * while every tag filter in this app intersects.
   *
   * Separators and case are still noise, which is Scryfall's own rule: `otag:"spot removal"`,
   * `otag:spot-removal`, `otag:spotremoval` and `otag:SPOT-REMOVAL` all returned exactly 4 907
   * cards, verified live 2026-08-20.
   */
  it("resolves every spelling of a name and refuses a partial one", () => {
    const read = readHandlers(tagged());
    const asks = ["SPOT-REMOVAL", "spot removal", "spotremoval", "  spot!removal  "].map(
      (value) => ({ namespace: "oracle", value }),
    );

    expect(read.tag_resolve({ asks }).map((r) => r?.slug)).toEqual(Array(4).fill("spot-removal"));
    // The needle the type-ahead finds it from, which this one must not.
    expect(read.tag_resolve({ asks: [{ namespace: "oracle", value: "spot-remov" }] })).toEqual([
      null,
    ]);
  });

  /**
   * The misses ride along **in place**, because the box has to be able to name the token it
   * could not find — and a list with them filtered out is the same length only by accident and
   * can name nothing.
   */
  it("answers one entry per ask, in order, with the misses kept", () => {
    const out = readHandlers(tagged()).tag_resolve({
      asks: [
        { namespace: "oracle", value: "nonesuch" },
        { namespace: "oracle", value: "spot-removal" },
        { namespace: "art", value: "nonesuch" },
      ],
    });

    expect(out.map((r) => r?.slug ?? null)).toEqual([null, "spot-removal", null]);
  });

  /**
   * The two taxonomies are separate files with separate id spaces that share plenty of slugs, so
   * resolving across both would let `o:cat` filter by the picture. A resolver that got this
   * wrong would answer a wall of cats either way, which is why it is asserted rather than
   * assumed.
   */
  it("resolves inside the namespace it was asked in", () => {
    const read = readHandlers(tagged());

    expect(read.tag_resolve({ asks: [{ namespace: "art", value: "cat" }] })[0]?.namespace).toBe(
      "art",
    );
    expect(read.tag_resolve({ asks: [{ namespace: "oracle", value: "cat" }] })).toEqual([null]);
    expect(() =>
      read.tag_resolve({ asks: [{ namespace: "both", value: "cat" }] }),
    ).toThrow(/unknown tag namespace/);
  });

  /**
   * **A muted tag still resolves, and this is the one tag read that ignores the mute table.**
   * Muting hides a *tag* — from the box, the rail and a parent's `childCount` — and is
   * documented never to hide a *card*. A reader who spells a tag out in the query box has named
   * it rather than browsed onto it, and refusing them the cards would be muting doing the one
   * thing it is documented never to do.
   */
  it("still resolves a tag the reader has muted", () => {
    const db = tagged();
    const cat = readHandlers(db).tag_search({ text: "cat", namespace: "art", limit: 5 })[0];

    writeHandlers(db).tag_mute({ namespace: "art", tagId: cat.id, slug: cat.slug });

    const read = readHandlers(db);
    expect(read.tag_resolve({ asks: [{ namespace: "art", value: "cat" }] })[0]?.slug).toBe("cat");
    // The type-ahead beside it still hides the tag, which is what makes the pair deliberate.
    expect(slugs(read.tag_search({ text: "cat", namespace: "art", limit: 5 }))).toEqual([]);
  });

  /**
   * A blank or all-punctuation value is every keystroke on the way to a real tag. It must answer
   * nothing rather than the first row whose `slugNorm` happens to be blank — in the app that
   * column is `NOT NULL DEFAULT ''` between schema v20 and v22, so a whole taxonomy can be
   * sitting at `''` and a half-typed `o:` would resolve onto an arbitrary one of them.
   */
  it("answers nothing for a blank needle", () => {
    const out = readHandlers(tagged()).tag_resolve({
      asks: [
        { namespace: "oracle", value: "" },
        { namespace: "oracle", value: "   " },
        { namespace: "art", value: "---" },
      ],
    });

    expect(out).toEqual([null, null, null]);
  });

  /**
   * **Muting takes the tag off every read, and takes nothing off the card wall.**
   *
   * It leaves the search, the tree, its parent's `childCount` and its children's `parents` — and
   * the cards it reached are still there, because nothing in the card filters consults the mute
   * table. Hiding a card because one of its tags was muted would be a silent loss of results.
   */
  it("hides a muted tag from every tag read and no card from the wall", () => {
    const db = tagged();
    const before = readHandlers(db).search_cards({ req: { limit: 200, offset: 0 } }).total;
    const cat = readHandlers(db).tag_search({ text: "cat", namespace: "art", limit: 5 })[0];

    writeHandlers(db).tag_mute({ namespace: "art", tagId: cat.id, slug: cat.slug });

    const read = readHandlers(db);
    expect(slugs(read.tag_search({ text: "cat", namespace: "art", limit: 5 }))).toEqual([]);
    expect(slugs(read.tag_children({ namespace: "art", slug: "animal" }))).toEqual(["monkey"]);
    const [animal] = read.tag_search({ text: "animal", namespace: "art", limit: 5 });
    expect(animal.childCount).toBe(1);
    // The card wall is untouched, and so is the muted tag's own reach where it is still visible.
    expect(read.search_cards({ req: { limit: 200, offset: 0 } }).total).toBe(before);
    expect(animal.cardCount).toBe(2);
  });

  /** **Muting a category takes its subtree off the rail with it** — the children are not roots,
   *  so nothing lists them — and they stay findable through the search. Accepted, recoverable by
   *  unmuting, and the reason `parents` names every branch. */
  it("takes a muted category's subtree off the rail, leaving it findable by search", () => {
    const db = tagged();
    const animal = readHandlers(db).tag_search({ text: "animal", namespace: "art", limit: 5 })[0];

    writeHandlers(db).tag_mute({ namespace: "art", tagId: animal.id, slug: animal.slug });

    const read = readHandlers(db);
    expect(slugs(read.tag_children({ namespace: "art", slug: "creature" }))).not.toContain(
      "animal",
    );
    expect(slugs(read.tag_search({ text: "cat", namespace: "art", limit: 5 }))).toEqual(["cat"]);
    // The child's breadcrumb loses the muted parent rather than naming a tag nothing can reach.
    expect(read.tag_search({ text: "cat", namespace: "art", limit: 5 })[0].parents).toEqual([]);
  });

  /**
   * **A mute is keyed on the id and re-muting refreshes the row rather than adding one**, which
   * is what makes a rename harmless — Scryfall's docs say outright not to treat a slug as a
   * permanent identifier.
   */
  it("keys a mute on the uuid and folds a re-mute into the row it already has", () => {
    const db = tagged();
    writeHandlers(db).tag_mute({ namespace: "art", tagId: "u-1", slug: "cat" });
    writeHandlers(db).tag_mute({ namespace: "art", tagId: "u-1", slug: "kitty" });
    // The same uuid in the other taxonomy is a **different** mute: two files, two id spaces.
    writeHandlers(db).tag_mute({ namespace: "oracle", tagId: "u-1", slug: "cat" });

    expect(readHandlers(db).tags_muted()).toEqual([
      { namespace: "art", tagId: "u-1", slug: "kitty", mutedAt: WHEN },
      { namespace: "oracle", tagId: "u-1", slug: "cat", mutedAt: WHEN },
    ]);
  });

  /**
   * **A blank id is refused, and that refusal is load-bearing.** `oracle_tags.id` is
   * `NOT NULL DEFAULT ''` in the app, so one stored mute with an empty id would equal every
   * un-refreshed row and take the whole taxonomy off the page with nothing logged. The read side
   * guards it too: a tag whose id was never written is *unmutable* rather than mutable-by-
   * accident.
   */
  it("refuses a blank tag id, and leaves a tag that has one visible", () => {
    const db = tagged();
    expect(() => writeHandlers(db).tag_mute({ namespace: "art", tagId: "", slug: "cat" })).toThrow(
      /no Scryfall id yet/,
    );
    expect(db.mutedTags).toEqual([]);

    // The read side of the same fence: a blank-id row *and* a blank-id mute, and the tag is
    // still offered rather than the whole taxonomy vanishing.
    const stale = makeDb({
      artTagTaxonomy: [
        { slug: "cat", id: "", label: "Cat", description: null, slugNorm: "cat" },
        { slug: "monkey", id: "", label: "Monkey", description: null, slugNorm: "monkey" },
      ],
      mutedTags: [{ namespace: "art", tagId: "", slug: "cat", mutedAt: WHEN }],
    });
    expect(slugs(readHandlers(stale).tag_search({ text: "", namespace: "art", limit: 9 }))).toEqual(
      ["cat", "monkey"],
    );
  });

  /** A namespace no build knows is refused on the way **in**, which is the only place the row can
   *  be created and therefore the honest place to stop it. `"both"` is an input to a search, never
   *  a stored row. */
  it("refuses to file a mute under a namespace that is not a taxonomy", () => {
    const db = tagged();
    expect(() =>
      writeHandlers(db).tag_mute({ namespace: "both", tagId: "u-1", slug: "cat" }),
    ).toThrow(/is not a tag taxonomy/);
  });

  /** Unmuting a tag that was never muted is **not** an error, and unlike muting it accepts a
   *  blank id — a row with one is unreachable by any tag it named, so junk to delete is all it
   *  can ever be. */
  it("gives a tag back, and shrugs at one that was never taken", () => {
    const db = tagged();
    writeHandlers(db).tag_mute({ namespace: "art", tagId: "u-1", slug: "cat" });

    expect(() => writeHandlers(db).tag_unmute({ namespace: "art", tagId: "nope" })).not.toThrow();
    expect(() => writeHandlers(db).tag_unmute({ namespace: "art", tagId: "" })).not.toThrow();
    writeHandlers(db).tag_unmute({ namespace: "art", tagId: "u-1" });
    expect(readHandlers(db).tags_muted()).toEqual([]);
  });

  /** **A user table**: a mute survives a taxonomy rebuild, because everything around it is
   *  Scryfall's answer and this one is the reader's. */
  it("keeps a mute across a taxonomy refresh", () => {
    const db = tagged();
    writeHandlers(db).tag_mute({ namespace: "art", tagId: "u-1", slug: "cat" });

    writeHandlers(db).art_tags_refresh({ force: true });

    expect(readHandlers(db).tags_muted()).toHaveLength(1);
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
describe("categories, labels, folders, history and the plan", () => {
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

  /**
   * `deck_categories.origin` — three writers, three answers, and the fourth case is the reason
   * it is a column rather than a name list.
   *
   * `AUTO_CATEGORY_NAMES` would have answered all four by matching, and it would have got the
   * third one wrong: "Card advantage" is a pile the reader made, and filing a card into it by
   * name **finds** it rather than creating one, so it stays theirs — and goes on drawing the day
   * they empty it.
   */
  it("records who made a category, and leaves a found one alone", () => {
    const { r, w } = testbed();
    const of = (name: string) =>
      r.deck_category_list({ deckId: 4, variant: "live" }).find((c) => c.name === name)!;
    const add = { deckId: 4, cardId: BOLT.id, categoryId: null, variant: "live" } as const;

    // Seeded with the deck; made by the add path while filing a Sol Ring.
    expect(of("Sideboard").origin).toBe("user");
    expect(of("Ramp").origin).toBe("auto");
    // The panel's "New category" button.
    expect(w.deck_category_create({ deckId: 4, name: "Combo pieces" }).origin).toBe("user");

    w.deck_add_card({ ...add, categoryName: "Card advantage", quantity: 1 });
    expect(of("Card advantage").origin).toBe("user");
    // A name this deck has never had is the other half: nobody asked for it, so it is the app's.
    w.deck_add_card({ ...add, categoryName: "Burn", quantity: 1 });
    expect(of("Burn").origin).toBe("auto");
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
        {
          id: 99,
          deckId: 1,
          name: "Doomed",
          kind: "main",
          isActive: true,
          sortOrder: 9,
          origin: "user",
        },
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

  it("unlabels a deleted label's cards rather than deleting them", () => {
    const { db, w } = testbed();
    const label = db.deckLabels.find((l) => l.name === "Cut candidate")!;
    expect(db.deckCards.filter((dc) => dc.labelId === label.id).length).toBeGreaterThan(0);

    w.deck_label_delete({ deckId: 4, id: label.id });

    expect(db.deckCards.filter((dc) => dc.labelId === label.id)).toHaveLength(0);
    expect(db.deckCards.filter((dc) => dc.deckId === 4)).not.toHaveLength(0);
    // An id that resolves to nothing is a success: the caller wanted that label gone.
    expect(() => w.deck_label_delete({ deckId: 4, id: label.id })).not.toThrow();
  });

  /**
   * **Taking a label off one deck is not deleting it**, and the distinction is what the app-wide
   * list needed: while a label belonged to a deck the two were one press, and conflating them now
   * would mean a reader tidying one deck stripping the label off every other deck wearing it.
   */
  it("takes a label off one deck's list and leaves the label itself standing", () => {
    const { db, w } = testbed();
    const label = db.deckLabels.find((l) => l.name === "Cut candidate")!;
    const before = db.deckCards.filter(
      (dc) => dc.labelId === label.id && dc.deckId === 4 && dc.variant === "live",
    ).length;
    expect(before).toBeGreaterThan(0);

    expect(w.deck_label_remove_from_deck({ deckId: 4, labelId: label.id, variant: "live" })).toBe(
      before,
    );

    expect(db.deckCards.filter((dc) => dc.labelId === label.id && dc.deckId === 4)).toHaveLength(0);
    expect(db.deckLabels.some((l) => l.id === label.id)).toBe(true);
    // Nothing left to take off: a success that writes nothing, never a refusal.
    const audit = db.deckAudit.length;
    expect(w.deck_label_remove_from_deck({ deckId: 4, labelId: label.id, variant: "live" })).toBe(0);
    expect(db.deckAudit).toHaveLength(audit);
  });

  /**
   * Every label there is, most-used first — the one command in the deck surface with no deck id
   * at all, and the only list that can answer a label no card is wearing.
   *
   * It replaced `deck_tag_suggestions` — the label was called a tag then — which grouped on
   * `(name, color)` and answered names without ids because two decks could hold two rows spelling
   * one word. There is one row per name now, so this answers ids and picking one **uses** that
   * label rather than copying it.
   */
  it("answers every label there is, most-used first, with no deck id in the call", () => {
    const { r } = testbed();
    expect(r.deck_label_all()).toEqual([
      // Worn by the two copies on deck 4's live Ramp row, and by nothing in its plan.
      { id: 1, name: "Cut candidate", color: "ember", cardCount: 2, deckCount: 1 },
      // Worn by nothing at all, which is the row `deck_label_list` can never answer. Ties break
      // on the name.
      { id: 2, name: "Budget swap", color: "moss", cardCount: 0, deckCount: 0 },
      { id: 3, name: "Combo piece", color: "gold", cardCount: 0, deckCount: 0 },
    ]);
  });

  /**
   * **The wrong-deck refusal is gone and its disappearance is the feature**: there is no other
   * deck's label any more, so a label made while standing in one deck goes straight onto a card in
   * another. What is left is the stale editor's case, which is unchanged.
   */
  it("accepts any label on a card, and refuses a card that has moved", () => {
    const { db, w } = testbed();
    const anyLabel = db.deckLabels.find((l) => l.name === "Budget swap")!;
    const row = db.deckCards.find((dc) => dc.deckId === 4 && dc.variant === "live")!;

    w.deck_card_set_label({
      deckId: 4,
      cardId: row.cardId,
      categoryId: row.categoryId,
      variant: "live",
      labelId: anyLabel.id,
    });
    expect(row.labelId).toBe(anyLabel.id);

    expect(() =>
      w.deck_card_set_label({
        deckId: 4,
        cardId: row.cardId,
        // A category of this deck that this card is not in — the stale editor's case.
        categoryId: db.deckCategories.find((c) => c.deckId === 4 && c.name === "Sideboard")!.id,
        variant: "live",
        labelId: anyLabel.id,
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

  it("compares the two lists by the exact card, one direction, skipping inactive piles", () => {
    const { db, r } = testbed();
    const diff = r.deck_theory_diff({ deckId: 4 });

    expect(diff.map((d) => [d.name, d.quantity])).toEqual([
      // Live's copy is in the switched-off "Cut list", which is excluded from *both* sides —
      // so the plan is short of one, and the row is unpriced because `lea` Black Lotus is
      // quoted in euros and in nothing else.
      ["Black Lotus", 1],
      ["Smuggler's Copter", 2],
      // **The grain is the whole of `(cardId, finish)`, not the oracle card** (2026-08-20), and
      // the seed stages both halves at once rather than a mutation: the deck sleeves two regular
      // `c21 263` Sol Rings and the plan names the foil `sld 913`, so the plan is short of one —
      // where an oracle-grained answer saw a Sol Ring against a Sol Ring and reported nothing.
      ["Sol Ring", 1],
      ["Urza's Saga", 1],
      ["Jace, the Mind Sculptor", 1],
    ]);
    expect(diff[0].unitPrice).toBeNull();
    // Deck 4's one theory row with an object to mark, and the row `heldAsOtherPrinting` is about:
    // two regular copies on the table against a foil the reader would still have to buy.
    expect(diff[2]).toMatchObject({ finish: "foil", heldAsOtherPrinting: 1 });
    // A plan that is a copy of its deck asks for nothing.
    expect(r.deck_theory_diff({ deckId: 3 })).toEqual([]);

    // Re-print the *plan's* Sol Ring onto the exact object the deck already sleeves — that
    // printing **and** the regular copy — and the row goes: one wanted against two held is a cut
    // the reader already made, and this list runs one direction only.
    const c21 = CARDS.find((c) => c.name === "Sol Ring" && c.setCode === "c21")!;
    const planned = db.deckCards.find(
      (dc) => dc.deckId === 4 && dc.variant === "theory" && dc.name === "Sol Ring",
    )!;
    planned.cardId = c21.id;
    planned.setCode = c21.setCode;
    planned.collectorNumber = c21.collectorNumber;
    planned.finish = null;
    expect(r.deck_theory_diff({ deckId: 4 }).some((d) => d.name === "Sol Ring")).toBe(false);

    // **And half of that key is the finish.** Put the foil back and leave the printing where the
    // deck's own copies are: `c21 263` in foil is a different object from `c21 263`, so the plan
    // is short of one again — and the two regular copies excuse it for *playing* while the row
    // stays for buying. `deckCards.finish` is `null` for the regular one.
    planned.finish = "foil";
    expect(r.deck_theory_diff({ deckId: 4 }).find((d) => d.name === "Sol Ring")).toMatchObject({
      quantity: 1,
      finish: "foil",
      heldAsOtherPrinting: 1,
    });
  });

  /** The three Lightning Bolts these directed cases need: one oracle card, three printings, so
   *  "a different printing of the same card" is a fixture rather than a comment. */
  const BOLTS = CARDS.filter((c) => c.name === "Lightning Bolt");

  /** A one-deck world with a plan, for the cases the seed cannot stage: the substitution
   *  arithmetic needs printings paired against each other, and deck 4 stages exactly one pair. */
  const planDeck = (deckCards: FakeDeckCard[]) =>
    makeDeckDb({ decks: [deck({ id: 1, theoryEnabled: true })], deckCards });

  /**
   * `heldAsOtherPrinting` at its simplest — the plan names one printing and the deck plays
   * another of the same card. The row stays, because the reader would still have to go and buy
   * it; the number beside it says the deck runs without them doing so. That difference is the
   * whole of what the dialog's `Missing` / `Different printing` split is computed from.
   */
  it("counts a wanted copy as held when the deck plays another printing of that card", () => {
    const db = planDeck([
      deckCard({ id: 1, cardId: BOLTS[1].id, quantity: 1 }),
      deckCard({ id: 2, cardId: BOLTS[0].id, variant: "theory", quantity: 1 }),
    ]);
    expect(readHandlers(db).deck_theory_diff({ deckId: 1 })).toMatchObject([
      { setCode: BOLTS[0].setCode, quantity: 1, heldAsOtherPrinting: 1 },
    ]);
  });

  /**
   * A row is **partly both**, which is why the field is a count and never a flag: two copies
   * wanted, one of them already on the table as another printing. The row still shows its full
   * `quantity` under either filter, because the full quantity is what a press writes.
   */
  it("covers only the copies another printing accounts for, leaving the rest missing", () => {
    const db = planDeck([
      deckCard({ id: 1, cardId: BOLTS[1].id, quantity: 1 }),
      deckCard({ id: 2, cardId: BOLTS[0].id, variant: "theory", quantity: 2 }),
    ]);
    expect(readHandlers(db).deck_theory_diff({ deckId: 1 })).toMatchObject([
      { quantity: 2, heldAsOtherPrinting: 1 },
    ]);
  });

  /**
   * One live copy excuses **one** row's copy. Two theory printings of one oracle card against a
   * single live copy of a third: the pool holds one, the first row in the list's own reading
   * order takes it and the second reads zero. Without the pool both rows would read 1 and the
   * dialog would say the deck already plays two copies it has never owned.
   */
  it("lets one live copy excuse one row and not the next one down the list", () => {
    const db = planDeck([
      deckCard({ id: 1, cardId: BOLTS[2].id, quantity: 1 }),
      // Same name and same pile, so `deckReadOrder` breaks the tie on the row id — which is
      // what makes "the first row" a fact about the deck rather than about who asked.
      deckCard({ id: 2, cardId: BOLTS[0].id, variant: "theory", quantity: 1 }),
      deckCard({ id: 3, cardId: BOLTS[1].id, variant: "theory", quantity: 1 }),
    ]);
    expect(
      readHandlers(db)
        .deck_theory_diff({ deckId: 1 })
        .map((d) => [d.setCode, d.quantity, d.heldAsOtherPrinting]),
    ).toEqual([
      [BOLTS[0].setCode, 1, 1],
      [BOLTS[1].setCode, 1, 0],
    ]);
  });

  /**
   * An exact match is not *also* a substitute. Two wanted against one of the same printing and
   * one of another: the exact line has already taken its copy, so only the second is left in
   * the pool and the one remaining copy is covered once rather than twice.
   */
  it("does not let a copy an exact line already matched excuse a row as well", () => {
    const db = planDeck([
      deckCard({ id: 1, cardId: BOLTS[0].id, quantity: 1 }),
      deckCard({ id: 2, cardId: BOLTS[1].id, quantity: 1 }),
      deckCard({ id: 3, cardId: BOLTS[0].id, variant: "theory", quantity: 2 }),
    ]);
    expect(readHandlers(db).deck_theory_diff({ deckId: 1 })).toMatchObject([
      { quantity: 1, heldAsOtherPrinting: 1 },
    ]);
  });

  /**
   * An orphan reads zero however full the pool is. A printing that has left `cards` has no
   * oracle card, so nothing can be said to be another printing *of* it — and the row is still a
   * row, because a deck card outlives the card database's memory of it.
   */
  it("reads zero for an orphan, whatever else the deck is playing", () => {
    const db = planDeck([
      deckCard({ id: 1, cardId: BOLTS[0].id, quantity: 2 }),
      deckCard({ id: 2, cardId: "gone", name: "Gone", variant: "theory", quantity: 1 }),
    ]);
    expect(readHandlers(db).deck_theory_diff({ deckId: 1 })).toMatchObject([
      { name: "Gone", quantity: 1, heldAsOtherPrinting: 0, ownedSpare: 0 },
    ]);
  });

  /**
   * `only` is the reader's ticks, in {@link readHandlers.deck_theory_slots}' own `group_key`
   * spelling. A key naming no row of the *current* difference writes nothing rather than
   * refusing: the diff is re-read inside the write, so a row ticked and then acquired in another
   * window is simply not short any more.
   */
  it("writes only the rows `only` names, and nothing for a key the difference has not got", () => {
    const { db, r, w } = testbed();
    const diff = r.deck_theory_diff({ deckId: 4 });
    const lotus = diff.find((d) => d.name === "Black Lotus")!;
    const before = db.wishlistEntries.length;

    expect(w.deck_theory_missing_to_wishlist({ deckId: 4, only: [`${lotus.cardId}|`] })).toBe(1);
    expect(db.wishlistEntries).toHaveLength(before + 1);
    expect(db.wishlistEntries[before]).toMatchObject({ name: "Black Lotus", cardId: lotus.cardId });

    expect(w.deck_theory_missing_to_wishlist({ deckId: 4, only: [] })).toBe(0);
    expect(w.deck_theory_missing_to_wishlist({ deckId: 4, only: ["no-such-card|"] })).toBe(0);
    expect(db.wishlistEntries).toHaveLength(before + 1);
  });

  /**
   * **The wish is pinned to the printing the plan names** (2026-08-22) and carries its finish.
   * A plan naming a printing is a plan for *that* cardboard — the rule the comparison has
   * followed since 2026-08-20 — and an any-printing wish would hand the reader back the very
   * substitution the plan was tracking.
   */
  it("pins the wish to the plan's printing and its finish, and pins nothing for a regular copy", () => {
    const { db, r, w } = testbed();
    const diff = r.deck_theory_diff({ deckId: 4 });
    const ring = diff.find((d) => d.name === "Sol Ring")!;
    const lotus = diff.find((d) => d.name === "Black Lotus")!;

    w.deck_theory_missing_to_wishlist({ deckId: 4 });

    // Found by id, because the seed already holds an **any-printing** Sol Ring wish and the two
    // are different rows on the grain `(oracleId, cardId, preferredFinish)`.
    const wish = db.wishlistEntries.find((x) => x.cardId === ring.cardId)!;
    // The plan names the foil Secret Lair, so that is the cardboard being shopped for — the
    // printing and the object both, carried end to end.
    expect(wish).toMatchObject({
      setCode: "sld",
      collectorNumber: "913",
      preferredFinish: "foil",
    });

    // The regular copy pins **nothing**: `null` and not `"nonfoil"`, because the unmarked case in
    // `deckCards` is the unmarked case here too, and spelling it out would split this wish from
    // every other one the app makes for that card.
    expect(db.wishlistEntries.find((x) => x.cardId === lotus.cardId)!.preferredFinish).toBeNull();
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
    // Pinned to the printing the plan named (2026-08-22). This used to assert `cardId: null` —
    // "a shopping list is not a printing preference" — which is the wrong rule for a list built
    // out of a plan: the plan named `lea 232`, so that is the cardboard being shopped for.
    expect(wish.cardId).toBe(lotus.cardId);
    expect(wish.quantity).toBeGreaterThanOrEqual(1);
  });

  it("switching the plan on moves the deck into it, and switching it off keeps every row", () => {
    const { db, w } = testbed();
    const rowsOf = (variant: string) =>
      db.deckCards.filter((dc) => dc.deckId === 1 && dc.variant === variant).length;
    const live = rowsOf("live");
    expect(rowsOf("theory")).toBe(0);

    // Deck 1 has no plan at all, so the switch hands it the deck: what the reader built **is**
    // the plan now, and the live list is what they will fill as they acquire it. A copy would
    // leave a live list nobody had decided was real.
    const row = w.deck_update({ id: 1, patch: { theoryEnabled: true } });
    expect(row.theoryEnabled).toBe(true);
    expect(rowsOf("theory")).toBe(live);
    expect(rowsOf("live")).toBe(0);
    // And the reader is left on the tab their cards are on, in the same write.
    expect(row.lastVariant).toBe("theory");

    // Off keeps every row: it hides a switch, it does not delete a list. Nothing comes back to
    // live either — the move is not undone by putting the switch back.
    w.deck_update({ id: 1, patch: { theoryEnabled: false } });
    expect(rowsOf("theory")).toBe(live);
    expect(rowsOf("live")).toBe(0);
  });

  /**
   * The guard, and it is about not destroying an edit: a plan the reader has already started is
   * not something a **re-press** of the switch may pour the live deck over.
   *
   * Deck 4 is the case in one deck — it has both lists — and switching it off and back on is
   * the exact gesture that would do the damage. The reader who really does want the deck copied
   * into a plan they have begun asks for it by name, through `deck_theory_copy_from_live`.
   */
  it("leaves a plan the reader has already started alone, and the deck beside it", () => {
    const { db, w } = testbed();
    const rowsOf = (variant: string) =>
      db.deckCards.filter((dc) => dc.deckId === 4 && dc.variant === variant).length;
    const [live, theory] = [rowsOf("live"), rowsOf("theory")];
    expect([live, theory]).not.toContain(0);

    w.deck_update({ id: 4, patch: { theoryEnabled: false } });
    w.deck_update({ id: 4, patch: { theoryEnabled: true } });

    expect([rowsOf("live"), rowsOf("theory")]).toEqual([live, theory]);
  });

  /**
   * **The copies do not move and the number does**, which is the whole shape of what schema v25
   * left behind: the switch rewrites `deck_cards.variant` and touches no folder at all, so deck
   * 1's group still holds its two Counterspells — and every row of the plan reads 0, because a
   * plan reserves nothing and `attributeOwned` says so by hand.
   */
  it("reads 0 across a plan while the copies stay in the deck's own group", () => {
    const { db, r, w } = testbed();
    const group = db.collectionFolders.find((f) => f.deckId === 1)!;
    const heldByFolder = () =>
      db.collectionEntries.filter((e) => e.folderId === group.id).reduce((n, e) => n + e.quantity, 0);
    const counterspell = (variant: "live" | "theory") =>
      r.deck_get({ id: 1, variant })!.cards.find((c) => c.name === "Counterspell")!;
    expect(counterspell("live").ownedQuantity).toBe(2);
    expect(heldByFolder()).toBe(3);

    w.deck_update({ id: 1, patch: { theoryEnabled: true } });

    expect(counterspell("theory").ownedQuantity).toBe(0);
    expect(heldByFolder()).toBe(3);
  });

  /**
   * **A cover is a card id, and this is what is left of the pair that used to be here.**
   *
   * The deleted case drove `deck_set_cover_image` — a path the backend re-encoded, which set
   * `coverKind` to `custom` and deliberately left `coverCardId` alone, so switching back to card
   * art lost nothing. That command is gone from the crate and from this fake, along with the
   * route, the encoder and the directory, because the picture never survived a sync. What the
   * pair was really pinning is the half that remains: a cover write is a patch, it writes
   * `card_art`, and it is audited under `cover`.
   */
  it("sets a card-art cover through the patch, and records it", () => {
    const { db, w } = testbed();

    const row = w.deck_update({ id: 1, patch: { coverCardId: BOLT.id } });

    expect(row.coverCardId).toBe(BOLT.id);
    expect(row.coverKind).toBe("card_art");
    expect(db.deckAudit.filter((a) => a.payload.includes('"field":"cover"'))).toHaveLength(1);
  });

  it("refuses every satellite read under the deckMeta fault, and the deck itself under none", () => {
    const db = seed("starter");
    db.fault = "deckMeta";
    const r = readHandlers(db);

    expect(() => r.deck_category_list({ deckId: 4, variant: "live" })).toThrow(/categories/);
    expect(() => r.deck_label_list({ deckId: 4, variant: "live" })).toThrow(/labels/);
    expect(() => r.deck_label_all()).toThrow(/label list/);
    expect(() => r.deck_folder_list()).toThrow(/folders/);
    expect(() => r.deck_audit_list({ deckId: 4, limit: 10 })).toThrow(/history/);
    expect(() => r.deck_theory_diff({ deckId: 4 })).toThrow(/theory list/);
    // The deck is not a satellite: a screen that could not read it would not be showing a
    // panel about it.
    expect(r.deck_get({ id: 4, variant: "live" })).not.toBeNull();
    expect(r.deck_list()).toHaveLength(4);
  });
});

/**
 * The four Settings can throw away.
 *
 * Every one of them is a **table**, not a row, so there is no id to get wrong and nothing to
 * assert about arguments — what these pin is which tables each takes and, more to the point,
 * which it leaves standing. That second half is what a story about a wipe is actually showing,
 * and it is where a fake that "just empties everything" would stop being a fake of this crate.
 */
describe("the four clears", () => {
  /** `starter` owns cards, wishes cards, and holds decks in folders — all three at once. */
  const world = () => seed("starter");

  it("empties the collection and leaves the decks and wishes standing", () => {
    const db = world();
    const wishes = db.wishlistEntries.length;
    const decks = db.decks.length;

    const out = writeHandlers(db).collection_clear();

    expect(out.entries).toBeGreaterThan(0);
    expect(db.collectionEntries).toHaveLength(0);
    expect(db.wishlistEntries).toHaveLength(wishes);
    expect(db.decks).toHaveLength(decks);
  });

  /**
   * **The rebuild is the half a wipe that skipped it could never recover from.** Since schema
   * v25 `Recently removed` and a deck's group are not the reader's filing at all — they are
   * where the app puts cards, and both `collection_to_deck` and `deck_to_collection` refuse in
   * words when the one they need is missing. Those rows are made by a migration, and a machine
   * already at head never runs one again: a sweep that left the cabinet bare would be a database
   * where no deck can ever hold a card, permanently, with nothing going red.
   *
   * An archived deck gets one like every other, because archiving is a flag and not a delete.
   */
  it("sweeps the cabinet and rebuilds Recently removed and one group per deck", () => {
    const db = world();
    expect(db.decks.some((d) => d.archived)).toBe(true);

    writeHandlers(db).collection_clear();

    const removed = db.collectionFolders.filter((f) => f.kind === "removed");
    expect(removed.map((f) => f.name)).toEqual(["Recently removed"]);
    expect(db.collectionFolders.filter((f) => f.kind === "user")).toHaveLength(0);
    const groups = db.collectionFolders.filter((f) => f.kind === "deck");
    expect(groups.map((f) => f.deckId)).toEqual(db.decks.map((d) => d.id));
    expect(groups.map((f) => f.name)).toEqual(db.decks.map((d) => d.name));
  });

  it("empties the wishlist and touches nothing else", () => {
    const db = world();
    const entries = db.collectionEntries.length;

    expect(writeHandlers(db).wishlist_clear()).toBeGreaterThan(0);
    expect(db.wishlistEntries).toHaveLength(0);
    expect(db.collectionEntries).toHaveLength(entries);
  });

  /**
   * The folders are the half a reader does not predict, and the half worth a test: `decks.
   * folder_id` is `ON DELETE SET NULL`, so the crate clears them in a **second** statement and
   * a fake that stopped at the cascade would draw an empty tree still standing in the gallery.
   */
  it("empties the decks, everything hanging off them, and the folders", () => {
    const db = world();
    const entries = db.collectionEntries.length;

    const out = writeHandlers(db).decks_clear();

    expect(out.decks).toBeGreaterThan(0);
    expect(out.folders).toBeGreaterThan(0);
    expect(db.decks).toHaveLength(0);
    expect(db.deckFolders).toHaveLength(0);
    expect(db.deckCards).toHaveLength(0);
    expect(db.deckCategories).toHaveLength(0);
    expect(db.deckLabels).toHaveLength(0);
    expect(db.deckAudit).toHaveLength(0);
    // A deck is not the collection's owner. The reader still owns every card.
    expect(db.collectionEntries).toHaveLength(entries);
    // **And the groups go with the decks, while the copies in them go to `Recently removed`**
    // — `delete_deck`'s destination, which this agrees with deliberately: a wiped deck's cards
    // are exactly cards taken out of a deck. `collection_folders.deck_id` CASCADEs, so leaving
    // the groups standing would draw a collection tree full of folders for decks that are gone.
    expect(db.collectionFolders.filter((f) => f.kind === "deck")).toHaveLength(0);
    const removed = db.collectionFolders.find((f) => f.kind === "removed")!;
    expect(db.collectionEntries.filter((e) => e.folderId === removed.id).length).toBeGreaterThan(
      0,
    );
  });

  it("reports what the cache freed, and answers zero the second time", () => {
    const db = world();

    const first = writeHandlers(db).cache_clear();
    expect(first.files).toBeGreaterThan(0);
    expect(first.bytes).toBeGreaterThan(0);
    expect(first.failed).toBe(0);

    expect(writeHandlers(db).cache_clear()).toMatchObject({ files: 0, bytes: 0, rows: 0 });
  });

  /**
   * The one refusal `cache_clear` has, and it is **not** `busy`: the crate checks it before the
   * write connection is ever asked for, because `data/tmp/` is where the corpus download puts
   * 77 MB that the ingest then reads back.
   */
  it("refuses the cache sweep while a card update is running", () => {
    const db = { ...world(), fault: "syncing" as const };

    expect(() => writeHandlers(db).cache_clear()).toThrow(/card update is running/);
    expect(db.imageCache.files).toBeGreaterThan(0);
  });

  /** And that fault reaches nothing else — it is one command's, deliberately. */
  it("leaves every other clear alone under the syncing fault", () => {
    const db = { ...world(), fault: "syncing" as const };

    expect(() => writeHandlers(db).collection_clear()).not.toThrow();
    expect(() => writeHandlers(db).wishlist_clear()).not.toThrow();
    expect(() => writeHandlers(db).decks_clear()).not.toThrow();
  });
});
