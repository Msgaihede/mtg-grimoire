/**
 * The four worlds a story can mount against.
 *
 * A story asks for one by name — `parameters: { fake: { seed: "empty" } }` — and
 * `preview.tsx` hands the result to {@link allHandlers}. The names are the four questions a
 * screen has to answer rather than four sizes of the same answer:
 *
 * * **`empty`** — first run. No cards at all, so every zero state is reachable at once: the
 *   search with nothing to search, the collection with nothing in it, the deck gallery before
 *   there is a deck. It is the only seed whose `cards` is empty, and that is the whole of what
 *   "nothing has been synced yet" means to this app — and the only one that has never asked
 *   GitHub for a release either.
 * * **`starter`** — the default, and what a story gets when it says nothing. The full 43-row
 *   corpus, twelve collection entries, five wishes and three decks, arranged so that the rows
 *   a screen is *interesting* about all exist somewhere: a row at quantity zero, a graded slab,
 *   a proxy, an unpriced finish, a foil wish the nonfoil in the binder does not fill, a built
 *   deck whose claims another deck can feel.
 * * **`needsReview`** — `starter` plus one orphaned row in each of the three user card tables,
 *   each carrying a **real sentence** copied from `reconcile.rs`. `needs_review` is a sentence
 *   and not a flag: it says what happened, and the row stays listed and counted while it says
 *   it.
 * * **`large`** — past `search::TOTAL_CAP`, so `totalIsCapped` is reachable, and deep enough
 *   that the virtualisers are doing work rather than rendering every row they are given.
 *
 * **Every seed builds its rows fresh on every call**, and that is load-bearing rather than
 * tidy: the writes in `db.ts` mutate row objects in place (`existing.quantity += …`), so a
 * module-level array of rows shared between two seeds of the same name would carry the first
 * story's edits into the second. `world.test.ts` is the proof. The one thing deliberately
 * shared is `cards` — by reference in {@link makeDb}, and memoised in {@link largeCards} —
 * because `cards` is the sync's table and **no write in this fake touches it**.
 */
import { CARDS, type FakeCard } from "./cards";
import {
  CLOCK_BASE,
  makeDb,
  marketplaceFeedMeta,
  marketplaceFeedPrices,
  neverCheckedUpdate,
  oracleTagCards,
  oracleTagMeta,
} from "./db";
import type {
  FakeDb,
  FakeDeck,
  FakeDeckAudit,
  FakeDeckCard,
  FakeDeckCategory,
  FakeDeckFolder,
  FakeDeckTag,
  FakeEntry,
  FakeWish,
} from "./db";
import { DECK_CATEGORIES, printing } from "./fixtures";
import type { CategoryKind, CategoryOrigin, DeckAuditKind, DeckVariant } from "@/lib/ipc";

export type SeedName = "empty" | "starter" | "needsReview" | "large";

/* ------------------------------------------------------------------ row builders ------- */

/**
 * Row ids, handed out in insertion order — `INTEGER PRIMARY KEY`'s own behaviour, and what
 * `nextId` continues from after the first write.
 *
 * Not cosmetic. Row id is the allocator's last tiebreaker ("then the oldest entry") and it is
 * the whole of both lists' `sort: "added"`, so declaration order below is the order a reader
 * sees under "Recently added" and the order two decks compete for the same copies in.
 */
function ids(): () => number {
  let n = 0;
  return () => (n += 1);
}

/**
 * A collection row with its three denormalised columns copied off the card it names — which is
 * exactly what `collection_add` does at write time, and the reason those columns outlive the
 * printing. Nothing here may pass them by hand: a row that disagrees with its own card is a
 * state the app cannot produce.
 */
function entry(
  id: number,
  card: FakeCard,
  finish: FakeEntry["finish"],
  condition: FakeEntry["condition"],
  quantity: number,
  over: Partial<FakeEntry> = {},
): FakeEntry {
  return {
    id,
    cardId: card.id,
    finish,
    condition,
    quantity,
    tradelistQuantity: 0,
    lang: card.lang,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
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
    // The column's own `DEFAULT '[]'`. A tags string is never null.
    tags: "[]",
    notes: null,
    needsReview: null,
    // One instant for the whole seeded world. `db.ts` measures a write's `updated_at` from
    // `CLOCK_BASE`, so a seeded row at exactly that value makes the first write of any story
    // land at `CLOCK_BASE + 1` — deterministic, and above everything it was seeded beside.
    updatedAt: CLOCK_BASE,
    ...over,
  };
}

/** A wish **pinned to a printing**: it names a card id, so its own set/collector/lang are
 *  that printing's and it is filled only by copies of it. */
function pinnedWish(
  id: number,
  card: FakeCard,
  quantity: number,
  over: Partial<FakeWish> = {},
): FakeWish {
  return {
    id,
    cardId: card.id,
    oracleId: card.oracleId,
    name: card.name,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    lang: card.lang,
    quantity,
    preferredFinish: null,
    notes: null,
    needsReview: null,
    updatedAt: CLOCK_BASE,
    ...over,
  };
}

/**
 * A wish for **any printing**: `cardId` is null and the three denormalised columns are null
 * with it, because a wish that names no printing has none to copy them from. `wishCard`
 * resolves it to the newest printing of the oracle card, which is a printing and not *the*
 * printing — see the row it is used for below.
 */
function anyPrintingWish(
  id: number,
  card: FakeCard,
  quantity: number,
  over: Partial<FakeWish> = {},
): FakeWish {
  return {
    id,
    cardId: null,
    oracleId: card.oracleId,
    // Never null: a wish carries its own name because it may never have had a card row.
    name: card.name,
    setCode: null,
    collectorNumber: null,
    lang: null,
    quantity,
    preferredFinish: null,
    notes: null,
    needsReview: null,
    updatedAt: CLOCK_BASE,
    ...over,
  };
}

/**
 * The categories of all four seeded decks, in **two different shapes**, because the app has two.
 *
 * Decks 1–3 get the five rows schema v8's migration leaves a deck that predates it: one built
 * out of each zone that held cards, plus whichever of the four predefined ones that first pass
 * missed. All three hold `main` cards, so all three come out with the same five —
 * `DECK_CATEGORIES`, sort orders and all, which is why the Commander column sorts ahead of the
 * main deck there.
 *
 * **Deck 4 is in the shape a deck the app makes today is in**: `create_deck` seeds the four
 * predefined at 0–3, and every `main` category arrives later, by name, from the first add. So
 * it has no "Main deck" at all and three piles the reader named instead. Both shapes are real,
 * and having one of each is what stops a story from being written against the accident of the
 * older one.
 *
 * Ids are handed out deck by deck from one sequence, so category 1 is deck 1's Commander and
 * category 6 is deck 2's. Nothing outside this file may assume that arithmetic —
 * {@link categoryOf} and {@link categoryNamed} are how a row finds its category.
 *
 * **`origin` is the third thing these two shapes differ about, and it is the one a name cannot
 * tell you.** Decks 1–3 are all `user`: four predefined seeds plus the pile v8's migration
 * built, which the v15 backfill deliberately leaves alone. Deck 4 has one of each class, so a
 * story can see all three answers at once — see the tuples below.
 */
function starterCategories(): FakeDeckCategory[] {
  const next = ids();
  const migrated = [1, 2, 3].flatMap((deckId) =>
    DECK_CATEGORIES.map((c) => ({
      id: next(),
      deckId,
      name: c.name,
      kind: c.kind,
      isActive: c.isActive,
      sortOrder: c.sortOrder,
      origin: c.origin,
    })),
  );
  /**
   * Deck 4's, `(kind, name, isActive, origin)` in `sortOrder` — the four predefined first,
   * because `create_deck` writes them before the reader has added anything.
   *
   * **The last three are the whole point of the column.** `Ramp` is a pile no one asked for:
   * the reader added a Sol Ring, `autoCategoryFor` answered "Ramp" and `category_for_name` made
   * it — so it is `auto`, and it draws only for as long as it holds something. The two below it
   * are the reader's own, and *neither is distinguishable from `Ramp` by its name*: "Card
   * advantage" was made by hand and then renamed (the history says so — it used to be "Value"),
   * and "Cut list" is a pile they made and switched off. A rule matching names would have had to
   * guess at all three and would have got at least one wrong.
   */
  const testbed: [CategoryKind, string, boolean, CategoryOrigin][] = [
    ["commander", "Commander", true, "user"],
    ["side", "Sideboard", true, "user"],
    ["companion", "Companion", true, "user"],
    ["maybe", "Maybeboard", false, "user"],
    // Made by the add path, and holding cards in both lists — so it is drawn in both, and what
    // its `auto` says is only that emptying it would take the heading with it.
    ["main", "Ramp", true, "auto"],
    ["main", "Card advantage", true, "user"],
    // **The point of the whole fixture.** A pile the *reader* made and switched off, which
    // counts toward nothing — no size, no copy limit, no legality check — and claims no copies,
    // exactly as the Maybeboard above it does. Nothing in the engine, the allocator or the
    // stats knows which of the two is which, and the illegal card filed here is how a story can
    // show that: switch it on and the deck reports a banned card.
    //
    // It is also this seed's **empty user pile**: it holds one card in the live list and none in
    // the plan, so opening deck 4 on its theory tab draws it with nothing under it. An `auto`
    // pile in that state would not be drawn at all.
    ["main", "Cut list", false, "user"],
  ];
  return [
    ...migrated,
    ...testbed.map(([kind, name, isActive, origin], sortOrder) => ({
      id: next(),
      deckId: 4,
      name,
      kind,
      isActive,
      sortOrder,
      origin,
    })),
  ];
}

/** One deck's category of a given kind. Decks 1–3 have exactly one of each of the five, which
 *  is why this throws rather than taking the first match of many — deck 4 owns three `main`
 *  categories and is addressed with {@link categoryNamed} instead. */
function categoryOf(
  categories: FakeDeckCategory[],
  deckId: number,
  kind: CategoryKind,
): FakeDeckCategory {
  const found = categories.filter((c) => c.deckId === deckId && c.kind === kind);
  if (found.length !== 1) throw new Error(`Deck ${deckId} has ${found.length} ${kind} categories`);
  return found[0];
}

/** One deck's category by name — `DECK_CATEGORY_GRAIN` is `(deck_id, name)`, so this is exact
 *  wherever {@link categoryOf} is ambiguous. */
function categoryNamed(
  categories: FakeDeckCategory[],
  deckId: number,
  name: string,
): FakeDeckCategory {
  const found = categories.find((c) => c.deckId === deckId && c.name === name);
  if (!found) throw new Error(`Deck ${deckId} has no category called ${name}`);
  return found;
}

/** A deck row, filed under one of its own deck's categories — which is what schema v8 replaced
 *  the zone with. `name` is denormalised alongside the printing: it is the one thing an
 *  orphaned deck card still has to show. */
function deckCard(
  id: number,
  deckId: number,
  card: FakeCard,
  category: FakeDeckCategory,
  quantity: number,
  over: Partial<FakeDeckCard> = {},
): FakeDeckCard {
  return {
    id,
    deckId,
    categoryId: category.id,
    // The deck as it is sleeved. No seed carries a `theory` row: a plan counts on no tile and
    // reserves no copy, so seeding one would make every count in this file need a caveat.
    variant: "live",
    cardId: card.id,
    tagId: null,
    quantity,
    name: card.name,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    lang: card.lang,
    // The regular copy. A seed that wanted a foil row would have to pick a printing whose
    // `finishes` lists one, or the finish menu greys on the very card it seeded.
    finish: null,
    needsReview: null,
    ...over,
  };
}

/* ------------------------------------------------------------------ empty -------------- */

/**
 * First run: the app has never synced.
 *
 * `cards: []` and one more thing, because everything else is already empty in {@link makeDb}.
 * `sync_status` reads `cardCount` straight off this array, so this seed is the one that
 * renders the ribbon's "no cards yet" state honestly rather than by faking a number.
 *
 * {@link neverCheckedUpdate} is the same claim about the *other* thing a first run has not
 * done. `update_status`' `lastCheckAt` is the only field that tells "nothing newer" from
 * "haven't looked", and a window that has never reached the network should not be answering
 * "checked just now" beside a card database it has never filled.
 */
function emptySeed(): FakeDb {
  return makeDb({ cards: [], update: neverCheckedUpdate() });
}

/* ------------------------------------------------------------------ starter ------------ */

/**
 * Twelve collection rows over twelve printings, spanning all three finishes and all five
 * conditions, and every one of them is here for a branch.
 *
 * Counted: nonfoil 8, foil 3, etched 1; NM 8, LP 1, MP 1, HP 1, DMG 1; **20 copies across 12
 * entries**, which is why `collection_summary`'s `totalCards` and `entries` disagree in every
 * story built on this seed — as they must, since a row at zero is still a row.
 */
function starterEntries(): FakeEntry[] {
  const next = ids();
  const bolt2x2 = printing("2x2", "117");
  return [
    // The ordinary row, and the only one with a tradelist: two of the four are spoken for.
    entry(next(), bolt2x2, "nonfoil", "NM", 4, {
      tradelistQuantity: 2,
      tags: '["burn","modern"]',
    }),
    // The whole acquisition story on one row — price, currency, date, source, and the
    // condition the seller called it before it was normalised to `HP`.
    entry(next(), printing("lea", "161"), "nonfoil", "HP", 1, {
      purchasePrice: 450,
      purchaseCurrency: "USD",
      acquiredAt: "2021-06-14",
      acquisitionSource: "Card Kingdom",
      conditionOriginal: "Heavily Played",
      notes: "Corner wear along the top edge — the reason it was affordable.",
    }),
    // The etched finish and a non-English printing in one row: `sta 105` is the fixture's only
    // `lang: "ja"` card and one of two that offer `etched`. `lang` is copied off the card, so
    // a story cannot accidentally file a Japanese printing under `en`.
    entry(next(), printing("sta", "105"), "etched", "NM", 1),
    entry(next(), printing("mh2", "267"), "foil", "NM", 2),
    // Two Sol Rings, and the pair is the fixture for "same card, different printing": the
    // any-printing wish below is filled by both, the Commander deck's exact-printing rule
    // prefers this one, and the row after it is the unpriced one.
    entry(next(), printing("c21", "263"), "nonfoil", "LP", 1),
    // `sld 913` is foil-only and **every key of its prices blob is null** (measured
    // 2026-08-09), so this row is the collection's `unpricedUsd` branch: a card you own,
    // counted, worth nothing the app can quote.
    entry(next(), printing("sld", "913"), "foil", "NM", 1),
    // The nonfoil Ragavan that does **not** fill the foil wish below — the wishlist's
    // finish-aware rule, staged as two rows rather than asserted in a comment.
    entry(next(), printing("mh2", "138"), "nonfoil", "DMG", 1, {
      conditionOriginal: "Damaged",
    }),
    entry(next(), printing("fut", "153"), "nonfoil", "MP", 3, { signed: true }),
    entry(next(), printing("mh2", "259"), "nonfoil", "NM", 4, { tradelistQuantity: 1 }),
    // A slab. The JSON is in `GRADING_FIELDS` order (`company`, `grade`, `cert`) because
    // `grading` enters the grain as **raw text** — a seed that spelled it any other way would
    // be a row `canonical_grading` can never produce, and the next edit would fork it.
    entry(next(), printing("mp2", "8"), "foil", "NM", 1, {
      grading: '{"company":"PSA","grade":"9","cert":"88104412"}',
    }),
    // **Quantity 0, and the row stays.** The condition, the note and the row's place in the
    // list all survive the day the user owns none of the card; deleting is `collection_remove`
    // and only ever that. The Commander deck below asks for this printing, which is what makes
    // the zero visible: it reads `owned 0` against a row that exists.
    entry(next(), printing("kld", "235"), "nonfoil", "NM", 0, {
      notes: "Traded away at the last Modern night. Keeping the row for the note.",
    }),
    // A proxy, and the fixture's second unpriced card (`lea 232` has no `usd` at all — it is
    // priced in euros and in tickets). The archived deck's Black Lotus is allocated from this
    // row, because the allocator prefers real copies to proxies and there is no real copy.
    entry(next(), printing("lea", "232"), "nonfoil", "NM", 1, {
      proxy: true,
      notes: "Cube proxy. The real one is not happening.",
    }),
  ];
}

/**
 * Five wishes, each a different answer to "is this filled?".
 *
 * The counts a story can rely on, given {@link starterEntries}: the foil Ragavan reads **0 of
 * 1** while a nonfoil Ragavan sits in the collection, the any-printing Sol Ring reads **2 of
 * 1** (both printings count), and the Counterspell reads **2 of 4**.
 */
function starterWishes(): FakeWish[] {
  const next = ids();
  return [
    // Pinned **and** foil: `ownedAgainstWish` narrows by finish, so the nonfoil Ragavan in the
    // binder fills none of this. The wishlist's whole finish rule in one row.
    pinnedWish(next(), printing("mh2", "138"), 1, { preferredFinish: "foil" }),
    // Any printing. `wishCard` resolves it to the **newest** printing of the oracle card,
    // which here is `sld 913` (2025-12-01) and not `c21 263` (2021-04-23) — and `sld 913` has
    // no `usd` key at all, so this wish renders with no unit price. That is the loose answer a
    // loose question earns, not a gap: the wish names no printing to price.
    anyPrintingWish(next(), printing("c21", "263"), 1),
    // Unowned, and a game changer — the one wish that is only ever a want.
    pinnedWish(next(), printing("pcy", "45"), 1),
    // Partly filled: two foils owned against a wish for four.
    pinnedWish(next(), printing("mh2", "267"), 4),
    pinnedWish(next(), printing("wwk", "31"), 1, {
      notes: "Under $25 or not at all. The Worldwake art is the one.",
    }),
  ];
}

/**
 * Four decks: a Modern draft, a built Commander deck, an archived one, and the deck schema v8
 * is *about*.
 *
 * `updatedAt` is staggered and every value is **below** `CLOCK_BASE`, for two reasons. The
 * gallery sorts `archived` last then `updated_at DESC`, so the order here is the order a
 * reader sees; and `stamp` measures a write from the newest row in the store, so keeping the
 * seeds under the base leaves the first edit of any story at `CLOCK_BASE + 1`.
 */
const HOUR = 3_600;
const DAY = 86_400;

/**
 * The folder the fourth deck is filed in — and the reason decks 1–3 stay at the **root**.
 *
 * The gallery draws the folder it is standing in, so a deck filed away is not on the wall the
 * reader opens on. Keeping the first three unfiled is what leaves every gallery story about
 * them saying exactly what it said before folders existed, while
 * {@link starterFolders} still gives the tree something real to draw and
 * `deck_set_folder` something real to move between.
 */
const FILED_DECK_FOLDER = 2;

/** The columns {@link starterDecks}' `deck` helper fills in for a deck that says nothing about
 *  them — the four schema v8 added and the three that remember where the reader was. */
type DefaultedDeckColumn =
  | "coverKind"
  | "folderId"
  | "notes"
  | "theoryEnabled"
  | "lastVariant"
  | "lastGroupBy"
  | "lastSortBy";

function starterDecks(): FakeDeck[] {
  /** The v8 columns and the three view-state ones default to their DDL values, so a deck below
   *  says only what is unusual about it. Deck 4 spells them all out and is written without
   *  this. */
  const deck = (
    over: Omit<FakeDeck, DefaultedDeckColumn> & Partial<Pick<FakeDeck, DefaultedDeckColumn>>,
  ): FakeDeck => ({
    coverKind: "card_art",
    folderId: null,
    notes: null,
    // Off on the first three: the Theory/Live control **is** this boolean, and a deck that
    // draws one is a deck every story about it has to say which list it is looking at.
    theoryEnabled: false,
    // The three defaults, which is what a deck nobody has touched the toolbar on holds — and
    // what keeps every story written before the editor remembered anything saying exactly what
    // it said. Deck 4 is the one that was left somewhere.
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
    ...over,
  });
  return [
    deck({
      id: 1,
      name: "Modern Goodstuff",
      formatKey: "modern",
      description: "Sixty legal cards and no plan. The shell every Modern story is cut from.",
      coverCardId: printing("mh2", "138").id,
      // A draft. Its claims are computed from what the built deck below left, and stored
      // nowhere — which is exactly what an unbuilt deck is.
      isBuilt: false,
      archived: false,
      updatedAt: CLOCK_BASE - HOUR,
    }),
    deck({
      id: 2,
      name: "Kenrith Two-Drops",
      formatKey: "commander",
      description:
        "Every permanent in the 99 costs two or less. The commander is the one card that does not.",
      coverCardId: printing("eld", "303").id,
      // **The one built deck**, and what makes cross-deck contention visible at all: a built
      // deck's claims come off what every other deck can see. It takes one of the four
      // `2x2` Bolts, so the Modern draft above can only claim three of that printing and
      // fills its fourth copy from another Bolt in the binder — measured in `world.test.ts`.
      isBuilt: true,
      archived: false,
      updatedAt: CLOCK_BASE - DAY,
    }),
    deck({
      id: 3,
      name: "Old School 93/94",
      formatKey: "oldschool",
      description: "Twenty-two cards in, and then the prices were looked up.",
      coverCardId: printing("lea", "232").id,
      isBuilt: false,
      archived: true,
      // **A plan that is an exact copy of the deck**, which is not a degenerate fixture: it is
      // the state `deck_theory_copy_from_live` *produces*, and the only command that produces
      // it — switching the list on **moves** the deck into the plan and leaves live empty, so a
      // full list beside a full list is now reachable by that command alone. This is the deck
      // whose two lists genuinely agree: the answer `deck_theory_diff` gives when there is
      // nothing to buy, which is a sentence rather than a blank panel. An archived deck is the
      // cheapest place to keep it — nothing else opens it. Both lists are seeded outright
      // rather than left to a toggle, which is what keeps that true whatever the switch does.
      theoryEnabled: true,
      updatedAt: CLOCK_BASE - 30 * DAY,
    }),
    {
      id: 4,
      name: "Rhystic Testbed",
      formatKey: "commander",
      description: "The plan beside the deck: a theory list, a pile switched off, two labels.",
      // **The one deck showing a cover of the reader's own**, and the only seeded deck with no
      // `coverCardId` at all — which is exactly why it credits nobody: `coverArtist` follows the
      // card id and an uploaded picture has no Scryfall illustrator to name.
      //
      // A deck carrying *both* covers at once is the commoner state and is deliberately not
      // seeded: it is reachable through `deck_set_cover_image`, which is the path a reader
      // actually takes to it, and seeding one here would put a card-art credit on the folder
      // card of every gallery story that has nothing to do with covers. There is no
      // `cover/<deckId>` route on the fake image handler either, so what a tile draws for this
      // is the no-cover affordance — the state, not the bytes, is what this seeds.
      coverCardId: null,
      coverKind: "custom",
      isBuilt: false,
      archived: false,
      // Filed, so the root wall is still the three decks every gallery story was written
      // against — see {@link FILED_DECK_FOLDER}.
      folderId: FILED_DECK_FOLDER,
      notes:
        "Bracket 3, so two game changers is the budget. The Cut list is switched off rather " +
        "than emptied — the cards are still there when I change my mind.",
      // **The one deck with a plan.** Everything the theory list is for is only reachable from
      // a deck that has one: the editor's Theory/Live control, `deck_theory_diff`, and the two
      // theory commands.
      theoryEnabled: true,
      // **The one deck that was left somewhere**, and all three columns say so at once: it
      // reopens on Theory, grouped by type and sorted by mana cost. Three defaults would seed
      // a memory nothing could tell from having none, which is the state the other three decks
      // already hold — and the plan is the honest thing for *this* deck to have been left on,
      // since it is the deck whose whole reason to exist is the plan beside it.
      lastVariant: "theory",
      lastGroupBy: "type",
      lastSortBy: "manaCost",
      updatedAt: CLOCK_BASE - 2 * HOUR,
    },
  ];
}

/**
 * The filing tree: two roots and one child.
 *
 * Flat rows, exactly as `deck_folders` is — the tree is the reader's to build from `parentId`,
 * and this shape is the smallest one that makes that worth doing. `Ideas` is empty on purpose:
 * an empty folder is a real thing a reader has, and a tree that only ever drew folders with
 * decks in them would never show the state a new folder starts in.
 */
function starterFolders(): FakeDeckFolder[] {
  return [
    { id: 1, parentId: null, name: "Constructed", sortOrder: 0 },
    { id: FILED_DECK_FOLDER, parentId: 1, name: "Commander", sortOrder: 0 },
    { id: 3, parentId: null, name: "Ideas", sortOrder: 1 },
  ];
}

/**
 * What is in those three decks.
 *
 * All three are run through the real `validateDeck` by `world.test.ts`, which pins the exact
 * issue list each one produces (none, one, one). What follows is why those are the right three.
 *
 * **Deck 1, `modern` — 60 in the main deck, 15 in the sideboard, 2 on the Maybeboard.** Every
 * row of those first two categories is `modern: "legal"` (measured over `CARDS` 2026-08-09),
 * no card appears in two of them, and the twenty lands are basics plus `Urza's Saga` — so it
 * validates clean, with an issue list of exactly zero. The corpus has no Plains and no
 * Mountain, which is why a deck whose spells are mostly red runs Forests and Islands; it is a
 * fixture with a real curve and a real land count, not a list anyone would sleeve. The
 * Maybeboard row is `Ancient Tomb`, which is `modern: "not_legal"` **on purpose**: an
 * **inactive** category counts toward nothing at all — not size, not copies, not legality, and
 * the allocator claims no copies for it — and a pile holding an illegal card is the only way a
 * story can show that. It is inactive because it was seeded that way, not because of its kind:
 * switch it on and the deck reports an illegal card.
 *
 * **Deck 2, `commander` — 99 main + 1 commander + 1 companion.** Kenrith commands, so colour
 * identity constrains nothing and every card in the fixture is available. The 15 nonbasics are
 * all permanents of mana value ≤ 2 or non-permanents, which means Lurrus's condition is broken
 * by **exactly one card and that card is the commander** — measured: the deck's whole issue
 * list is one error reading "Lurrus of the Dream-Den needs every permanent card in your deck to
 * have mana value 2 or less; Kenrith, the Returned King does not." `companions.ts`'
 * `STARTING_DECK` is `["main", "commander"]`, so Kenrith at mana value 5 is inside the pile
 * Lurrus judges. That is not a mistake in the fixture — it is unavoidable here and worth
 * staging deliberately. Lurrus is `WB`, so its commander's identity must cover `W` and `B`, and
 * the corpus's only legends that wide are Kenrith (mana value 5) and Tymna (3); every
 * legal-companion arrangement is out of reach, and the app's own note says as much ("most of
 * why Lurrus is not an EDH companion"). The 84 basics are what singleton leaves: 99 − 15
 * distinct nonbasics, and basics are the one card a singleton format lets repeat.
 *
 * **Deck 3, `oldschool` — 22 main, archived.** Under the 60-card minimum on purpose ("Old
 * School decks need at least 60 cards; you have 22." is its whole issue list): an archived deck
 * is one somebody stopped working on, and it is the cheapest place to keep the "below the
 * minimum" branch reachable without spoiling a deck a story is likely to open.
 * Black Lotus and Ancestral Recall are `oldschool: "restricted"`, at one copy each, which is
 * `restricted_semantic: "max_one"` satisfied rather than asserted.
 */
function starterDeckCards(categories: FakeDeckCategory[]): FakeDeckCard[] {
  const next = ids();
  /** A row, filed under this deck's category of that kind. */
  const filed = (deckId: number, card: FakeCard, kind: CategoryKind, quantity: number) =>
    deckCard(next(), deckId, card, categoryOf(categories, deckId, kind), quantity);
  const main = (deckId: number, card: FakeCard, quantity: number) =>
    filed(deckId, card, "main", quantity);
  return [
    // --- deck 1: 20 lands + 40 spells --------------------------------------------------
    main(1, printing("unf", "239"), 10),
    main(1, printing("lea", "288"), 6),
    main(1, printing("mh2", "259"), 4),
    main(1, printing("2x2", "117"), 4),
    main(1, printing("mh2", "138"), 4),
    main(1, printing("fut", "153"), 4),
    main(1, printing("isd", "51"), 4),
    main(1, printing("mh2", "267"), 4),
    main(1, printing("eld", "115"), 4),
    main(1, printing("gtc", "148"), 4),
    main(1, printing("nph", "57"), 4),
    main(1, printing("wwk", "31"), 4),
    main(1, printing("kld", "235"), 4),
    // 15 exactly, which is `sideboardMax` for Modern. Four cards, none of them in the main
    // deck, because the copy limit counts main and side together.
    filed(1, printing("gtc", "215"), "side", 4),
    filed(1, printing("apc", "128"), "side", 4),
    filed(1, printing("acr", "211"), "side", 4),
    filed(1, printing("nph", "9"), "side", 3),
    filed(1, printing("tmp", "315"), "maybe", 2),

    // --- deck 2: the 99, then the two cards outside it ---------------------------------
    main(2, printing("c21", "263"), 1),
    main(2, printing("kld", "235"), 1),
    main(2, printing("dom", "168"), 1),
    main(2, printing("isd", "51"), 1),
    main(2, printing("mh2", "138"), 1),
    main(2, printing("fut", "153"), 1),
    main(2, printing("mh2", "259"), 1),
    main(2, printing("tmp", "315"), 1),
    main(2, printing("2x2", "117"), 1),
    main(2, printing("mh2", "267"), 1),
    main(2, printing("ema", "32"), 1),
    main(2, printing("apc", "128"), 1),
    main(2, printing("gtc", "148"), 1),
    main(2, printing("nph", "57"), 1),
    main(2, printing("acr", "211"), 1),
    main(2, printing("unf", "239"), 42),
    main(2, printing("lea", "288"), 42),
    filed(2, printing("eld", "303"), "commander", 1),
    filed(2, printing("iko", "226"), "companion", 1),

    // --- deck 3 -------------------------------------------------------------------------
    main(3, printing("lea", "232"), 1),
    main(3, printing("lea", "47"), 1),
    main(3, printing("lea", "161"), 4),
    main(3, printing("lea", "288"), 16),
    // Its plan, copy for copy — what `seed_from_live` leaves behind, and the only pair of lists
    // in any seed that `deck_theory_diff` answers **nothing** about.
    ...[
      [printing("lea", "232"), 1],
      [printing("lea", "47"), 1],
      [printing("lea", "161"), 4],
      [printing("lea", "288"), 16],
    ].map(([card, quantity]) =>
      deckCard(next(), 3, card as FakeCard, categoryOf(categories, 3, "main"), quantity as number, {
        variant: "theory",
      }),
    ),
  ];
}

/**
 * Deck 4's two lists — **the only rows in any seed with a `theory` variant**, and the only ones
 * carrying a tag.
 *
 * Everything schema v8 added is reachable from this one deck, and each piece is here to be seen
 * rather than to be counted:
 *
 * * **A real difference between the two lists.** The plan wants a Smuggler's Copter and a Jace
 *   the deck does not have, and wants *one* Sol Ring where the deck holds two — so
 *   `deck_theory_diff` answers two rows and not three: what live has and theory dropped is a
 *   cut the reader already made, and this list runs one direction only.
 * * **A card with a rule violation.** Two Sol Rings in a singleton format, which the engine
 *   reports against the card. The plan is the fix, which is what a plan is for.
 * * **Two game changers**, Rhystic Study and Consecrated Sphinx, so the editor's game-changer
 *   figure is a number rather than a zero.
 * * **A card in a switched-off pile the reader named.** Black Lotus is `commander: "banned"`,
 *   and filed under the inactive "Cut list" it produces no issue at all — the same silence the
 *   Maybeboard gives, from a category with no special kind. Switch it on and the deck reports a
 *   banned card.
 * * **A tagged card.** One label on one row; the deck's other label is worn by nothing, which
 *   is the state `DeckDetail.tags` exists to describe — a palette exists whether or not a row
 *   is using it.
 */
function testbedDeckCards(
  categories: FakeDeckCategory[],
  tags: FakeDeckTag[],
  startId: number,
): FakeDeckCard[] {
  let id = startId;
  const cut = tags.find((t) => t.deckId === 4 && t.name === "Cut candidate")!;
  const filed = (
    card: FakeCard,
    name: string,
    quantity: number,
    variant: DeckVariant,
    over: Partial<FakeDeckCard> = {},
  ) => deckCard(id++, 4, card, categoryNamed(categories, 4, name), quantity, { variant, ...over });

  return [
    // --- live: what is sleeved up -------------------------------------------------------
    filed(printing("eld", "303"), "Commander", 1, "live"),
    // Two copies in a singleton format, wearing the label that says the reader knows.
    filed(printing("c21", "263"), "Ramp", 2, "live", { tagId: cut.id }),
    filed(printing("pcy", "45"), "Card advantage", 1, "live"),
    filed(printing("mp2", "8"), "Card advantage", 1, "live"),
    // Banned in Commander, and silent because the pile it is in is switched off.
    filed(printing("lea", "232"), "Cut list", 1, "live"),

    // --- theory: the plan ---------------------------------------------------------------
    filed(printing("eld", "303"), "Commander", 1, "theory"),
    // One, not two: the plan is where the copy limit gets fixed. And **not a diff row** — a
    // card live has more of is a cut the reader already made, which this list does not carry.
    filed(printing("c21", "263"), "Ramp", 1, "theory"),
    // **Wanted in an active pile while the live copy sits in the switched-off one**, which is
    // the case that proves the exclusion runs on *both* sides: the Cut list's Black Lotus is
    // not "held", so the plan is short of one. It is also the corpus's only unpriced card —
    // `lea` Black Lotus is quoted in euros and in nothing else — so this is the row whose cost
    // a total cannot count, and the figure says so rather than rounding it to zero.
    filed(printing("lea", "232"), "Ramp", 1, "theory"),
    // Wanted and not held. The collection records this printing without holding a copy, so it
    // reads no spare either — a zero that came from the real arithmetic.
    filed(printing("kld", "235"), "Ramp", 2, "theory"),
    filed(printing("mh2", "259"), "Ramp", 1, "theory"),
    filed(printing("pcy", "45"), "Card advantage", 1, "theory"),
    filed(printing("mp2", "8"), "Card advantage", 1, "theory"),
    filed(printing("wwk", "31"), "Card advantage", 1, "theory"),
  ];
}

/**
 * Two labels on the deck that has a plan, and two on the archived deck.
 *
 * The archived deck's exist for `deck_tag_suggestions` and for nothing else: that command is
 * **global**, grouping on the `(name, colour)` pair across every deck and answering most-used
 * first, so a palette that came from one deck could never show the ordering it is built around.
 * Two decks spelling "Cut candidate" the same way is what puts it above the other two, and
 * `Budget swap` is the one name deck 4 has *not* used — so the panel opened on deck 4 has
 * exactly one offer to make, which is the state a suggestion list is worth drawing in.
 */
function starterTags(): FakeDeckTag[] {
  return [
    { id: 1, deckId: 3, name: "Cut candidate", color: "ember" },
    { id: 2, deckId: 3, name: "Budget swap", color: "moss" },
    { id: 3, deckId: 4, name: "Cut candidate", color: "ember" },
    // Worn by no row. A tag is a label the reader made, and it exists before anything is
    // wearing it — which is the state a palette has to be able to draw.
    { id: 4, deckId: 4, name: "Combo piece", color: "gold" },
  ];
}

/**
 * A timestamp `daysAgo` days back at a fixed local hour — **the one clock in this file that is
 * not {@link CLOCK_BASE}**, and the exception is forced.
 *
 * Every other timestamp here is an *ordering* number and `db.ts`'s simplification 8 says so:
 * nothing renders one as a date. `deck_audit.at` is the exception, because `auditText`'s day
 * grouping renders exactly that — so a history dated from a fixed instant in the past would
 * file every row under one absolute heading and put "Today" and "Yesterday" out of reach.
 * A fixed *hour* rather than an offset in seconds, because an offset crosses midnight and files
 * a story's entries under the wrong day whenever the catalogue is opened late.
 */
function daysAgo(days: number, hour: number, minute: number): number {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * What has happened to the seeded decks — **the past their writes wrote**, which is what makes
 * a drawer opened on the first frame of a story show a history rather than a blank column.
 * Every write in `db.ts` appends to this same table, so a change made during a story lands
 * above these under "Today".
 *
 * **Deck 4 carries a week of building**, three days of three different shapes: one that gained
 * and cut, one that only cut, and the day the deck was made. Every kind is represented, because
 * the drawer's filter chips are only worth pressing if there is something behind each of them.
 *
 * **Deck 3 carries rows written by a build that knew more than this one** — a `kind` this app
 * has never met and a payload it cannot parse. That is not a curiosity: a database outlives the
 * app that wrote it, so this build may be older *or* newer than the one that wrote a row, and
 * `auditText.ts` is total over both. An archived deck is the honest place for it.
 *
 * **Decks 1 and 2 carry none**, which is a state too: the drawer's empty column, and the one a
 * reader meets on a deck they have not edited since the table existed.
 */
function starterAudit(): FakeDeckAudit[] {
  let id = 0;
  const row = (
    deckId: number,
    kind: DeckAuditKind,
    at: number,
    payload: string,
    over: Partial<FakeDeckAudit> = {},
  ): FakeDeckAudit => ({
    id: (id += 1),
    deckId,
    at,
    variant: "live",
    kind,
    cardId: null,
    cardName: null,
    payload,
    delta: 0,
    ...over,
  });
  /** A row about one printing, named as the backend denormalises it — the card's own name,
   *  copied at write time, which is the one name a history line keeps when the printing goes. */
  const card = (
    deckId: number,
    kind: DeckAuditKind,
    at: number,
    setCode: string,
    collectorNumber: string,
    payload: string,
    delta: number,
  ): FakeDeckAudit => {
    const p = printing(setCode, collectorNumber);
    return row(deckId, kind, at, payload, { cardId: p.id, cardName: p.name, delta });
  };

  return [
    // --- deck 4: a week of building, oldest first (the read sorts it) --------------------
    row(4, "folder", daysAgo(6, 18, 0), '{"action":"move","folder":"Constructed › Commander"}'),
    row(4, "deck", daysAgo(6, 18, 1), '{"field":"format","from":"casual","to":"commander"}'),
    card(4, "add", daysAgo(6, 18, 2), "eld", "303", '{"category":"Commander","quantity":1}', 1),
    // The one `deck`-kind row that can move the day header's arithmetic, and by five — every
    // *other* nonzero delta in this table belongs to a card-shaped kind. `copy_from_live` seeds
    // the plan and carries the copies it wrote, in the payload and in `delta` both.
    row(4, "deck", daysAgo(6, 18, 3), '{"field":"theory","copied":5}', {
      variant: "theory",
      delta: 5,
    }),

    row(4, "category", daysAgo(1, 20, 15), '{"action":"deactivate","name":"Cut list"}'),
    // The one shape a `quantity` row takes in a singleton deck: basic lands, which CR 100.2a
    // exempts from every copy limit.
    card(4, "quantity", daysAgo(1, 22, 24), "lea", "288", '{"category":"Ramp","from":3,"to":7}', 4),
    card(4, "remove", daysAgo(1, 22, 31), "isd", "51", '{"category":"Ramp","quantity":1}', -1),

    card(4, "tag", daysAgo(0, 11, 4), "c21", "263", '{"tag":"Cut candidate","previous":null}', 0),
    row(
      4,
      "category",
      daysAgo(0, 11, 20),
      '{"action":"rename","name":"Card advantage","previousName":"Value"}',
    ),
    card(
      4,
      "remove",
      daysAgo(0, 13, 51),
      "mp2",
      "8",
      '{"category":"Draw","reason":"cut for the curve"}',
      -1,
    ),
    card(
      4,
      "swap",
      daysAgo(0, 13, 58),
      "c21",
      "263",
      '{"fromSet":"c21","toSet":"sld","folded":true}',
      0,
    ),
    card(4, "move", daysAgo(0, 14, 9), "avr", "6", '{"from":"Creature","to":"Maybeboard"}', 0),
    card(4, "add", daysAgo(0, 14, 12), "kld", "235", '{"category":"Ramp","quantity":1}', 1),

    // --- deck 3: written by a build that knew more than this one -------------------------
    card(3, "add", daysAgo(0, 15, 55), "mh2", "138", '{"category":"Main deck","quantity":1}', 1),
    // A payload that is not JSON at all. `auditText.ts` degrades to the shortest honest
    // sentence rather than throwing, and the row keeps its date, its delta and its place.
    row(3, "category", daysAgo(0, 16, 12), "{oh dear"),
    // A kind this build has never heard of, which lands in the drawer's sixth chip — the one
    // that exists only when such a row does. A row that matched no chip and quietly vanished
    // would be a log with a hole in it.
    row(3, "teleported" as DeckAuditKind, daysAgo(0, 16, 40), '{"whither":"the shadow realm"}', {
      delta: 3,
    }),
  ];
}

/**
 * Both downloaded price feeds, already fetched — which is the state a reader who has ever
 * chosen Card Kingdom is in, and the only one a story about *prices* can be written against.
 *
 * The `never fetched` state is still reachable and is the honest default of every other seed:
 * `empty` has no cards to price, and `large` deliberately skips this so its 5 243-row corpus
 * does not build 30 000 feed rows for a seed whose whole subject is virtualisation. A story that
 * wants "no rows yet" on a full corpus empties `db.marketplacePrices`.
 */
function starterFeeds(cards: readonly FakeCard[]) {
  const marketplacePrices = marketplaceFeedPrices(cards);
  return {
    marketplacePrices,
    marketplaceFeeds: marketplaceFeedMeta(marketplacePrices, FETCHED_AT),
  };
}

/** When the seeded feeds were pulled: an hour before the seeded world's own clock, so a panel
 *  reads `fresh` rather than sitting on the 24 h staleness edge. */
const FETCHED_AT = CLOCK_BASE - HOUR;

/**
 * The Oracle tag taxonomy, already ingested — which is the state a reader who has had the app
 * open once is in, and the only one a deck story about *piles* can be written against. Without
 * it every add files by card type, and a story showing "Creature", "Instant", "Land" would be
 * showing the fallback rather than the feature.
 *
 * **`empty` and `large` deliberately go without**, exactly as they go without price feeds:
 * `empty` is a first launch and has no cards to tag, and `large`'s 5 243 synthetic printings
 * carry oracle ids the taxonomy has never heard of — they would all answer an empty list
 * anyway, which is honest and is what a seed about virtualisation should show. The
 * `oracleTagsMissing` fault is how a story stands in the never-ingested state on a *full*
 * corpus.
 *
 * Ingested at the same instant the feeds were fetched, which is well inside the taxonomy's own
 * seven-day window: `oracle_tags_status` answers `stale: false`, so nothing here is due for a
 * refresh until a story forces one.
 */
function starterTaxonomy(cards: readonly FakeCard[]) {
  return { oracleTags: oracleTagCards(cards), oracleTagMeta: oracleTagMeta(FETCHED_AT) };
}

function starterSeed(): FakeDb {
  const decks = starterDecks();
  const deckCategories = starterCategories();
  const deckTags = starterTags();
  const migrated = starterDeckCards(deckCategories);
  return makeDb({
    ...starterFeeds(CARDS),
    ...starterTaxonomy(CARDS),
    collectionEntries: starterEntries(),
    wishlistEntries: starterWishes(),
    decks,
    deckFolders: starterFolders(),
    deckCategories,
    deckTags,
    // One id sequence over both halves, `INTEGER PRIMARY KEY`'s own behaviour: deck 4's rows
    // continue where decks 1–3's stopped rather than starting again and colliding.
    deckCards: [...migrated, ...testbedDeckCards(deckCategories, deckTags, migrated.length + 1)],
    deckAudit: starterAudit(),
  });
}

/* ------------------------------------------------------------------ needsReview -------- */

/**
 * Three card ids no row of `CARDS` carries, one per user card table.
 *
 * Deliberately outside the fixture rather than deleted from it: an orphan is a row whose
 * printing left the database, and the only way to be one is to name an id `cards` has no row
 * for. `world.test.ts` asserts all three are absent, so a future corpus refresh that happened
 * to mint one of them fails a test rather than quietly healing the seed.
 */
const ORPHAN_ENTRY_ID = "f3c1a0d2-5e47-4b98-9a3c-71d8e6b40f21";
const ORPHAN_WISH_ID = "a7b209e4-8c31-4d5f-b062-9e14c7a3d885";
const ORPHAN_DECK_CARD_ID = "0c62f9b1-4a7d-4e83-8f15-2b90d4c6e737";

/**
 * The sentences, copied verbatim from `reconcile.rs` — one from each of the three writers, so
 * a story renders three genuinely different explanations rather than one repeated.
 *
 * `sweep_orphans`' is the common one (it runs after every ingest); `flag_deleted`'s is what a
 * `/migrations` `delete` writes, with the date interpolated as the real one does; `merge`'s is
 * the note left on a row that *was* repointed, onto an id that has not arrived yet — which is
 * why the id in that sentence is the id the row now carries.
 */
const MISSING_NOTE =
  "This printing is not in the card database. It may have been removed by the last " +
  "card-data sync, or it may return with the next one.";
const DELETED_NOTE =
  "Scryfall removed this printing from its database on 2026-07-31. Your copies are still " +
  "recorded — check the printing and re-add it if you can identify it, or remove this entry.";
const MERGED_NOTE =
  `Scryfall merged this printing into ${ORPHAN_DECK_CARD_ID}, which is not in the card ` +
  "database yet. It should arrive with the next card-data sync.";

/**
 * `starter`, plus one flagged orphan in each of `collection_entries`, `wishlist_entries` and
 * `deck_cards` — the three tables `reconcile::sweep_orphans` walks.
 *
 * The denormalised columns on these rows are **the row's own record and are checked against
 * nothing**, which is the point of denormalising them: there is no card left to re-read. So the
 * collection orphan renders with a null name under a set and collector number, the wish renders
 * under the name it stored, and the deck row keeps the name it was added with. They are the
 * only three rows in any seed that name a card `cards` does not have.
 *
 * The deck orphan goes in deck 1's `main`, taking it to 61 — legal, because Modern's `deckMax`
 * is null. It is not in deck 2, where a 101st card would bury the orphan under a size error,
 * and not in deck 1's sideboard, where it would be the 16th of 15.
 */
function needsReviewSeed(): FakeDb {
  const db = starterSeed();
  // The builders are called with an arbitrary real printing and then overridden: they are here
  // for the column *defaults* (`tags: "[]"`, the eleven nulls, the timestamp), and every column
  // that says anything about the row is replaced below. The card handed in is never referenced
  // by the result.
  db.collectionEntries.push({
    ...entry(db.collectionEntries.length + 1, printing("2x2", "117"), "nonfoil", "LP", 2),
    cardId: ORPHAN_ENTRY_ID,
    setCode: "mh3",
    collectorNumber: "108",
    lang: "en",
    needsReview: MISSING_NOTE,
  });
  db.wishlistEntries.push({
    ...pinnedWish(db.wishlistEntries.length + 1, printing("2x2", "117"), 1),
    cardId: ORPHAN_WISH_ID,
    oracleId: null,
    name: "Orcish Bowmasters",
    setCode: "ltr",
    collectorNumber: "103",
    lang: "en",
    needsReview: DELETED_NOTE,
  });
  db.deckCards.push({
    ...deckCard(
      db.deckCards.length + 1,
      1,
      printing("2x2", "117"),
      categoryOf(db.deckCategories, 1, "main"),
      1,
    ),
    cardId: ORPHAN_DECK_CARD_ID,
    name: "Psychic Frog",
    setCode: "mh3",
    collectorNumber: "56",
    lang: "en",
    needsReview: MERGED_NOTE,
  });
  return db;
}

/* ------------------------------------------------------------------ large -------------- */

/**
 * 26 words and 25 words, one synthetic card name per pair.
 *
 * 26 × 25 = **650** oracle cards, and the first list covers A–Z so the name order a
 * virtualised list scrolls through spans the alphabet evenly instead of piling up under one
 * letter. Invented rather than measured, and they are the only invented *strings* in any seed:
 * every column of every synthetic card below is a real column of a real printing.
 */
const ADJECTIVES = [
  "Ancient",
  "Blighted",
  "Crimson",
  "Dire",
  "Ember",
  "Fabled",
  "Gilded",
  "Hallowed",
  "Ivory",
  "Jagged",
  "Keening",
  "Luminous",
  "Molten",
  "Nameless",
  "Obsidian",
  "Pale",
  "Quicksilver",
  "Ruined",
  "Sunlit",
  "Thornclad",
  "Umbral",
  "Verdant",
  "Wailing",
  "Xanthic",
  "Yawning",
  "Zealous",
];
const NOUNS = [
  "Aegis",
  "Bulwark",
  "Chorus",
  "Drake",
  "Effigy",
  "Falcon",
  "Gauntlet",
  "Harbinger",
  "Idol",
  "Juggernaut",
  "Kraken",
  "Lantern",
  "Marauder",
  "Nomad",
  "Oracle",
  "Phalanx",
  "Quarry",
  "Reliquary",
  "Sentinel",
  "Talisman",
  "Undertow",
  "Vigil",
  "Warden",
  "Yeoman",
  "Zealot",
];

/** 650 oracle cards × 8 printings = 5 200, which clears `search::TOTAL_CAP` (5 000) by enough
 *  that a filtered search still exceeds it. */
const LARGE_PRINTINGS_EACH = 8;
/** Six hundred collection rows: deep enough that the collection table virtualises, small
 *  enough that `collection_summary` is still summing rows a reader could in principle check. */
const LARGE_ENTRY_COUNT = 600;

/**
 * The rows of `CARDS` a synthetic card may be cut from: **34 of the 43**, measured 2026-08-14.
 *
 * **Single-faced**, which drops five (the transform, split, adventure, modal DFC and art
 * series rows): a synthetic name on a multi-faced template would leave the `faces` blob naming
 * the card it was copied from, and a pane that renders face names would show two cards at once.
 * A story about a double-faced card belongs on `starter`, where the five real ones are.
 *
 * **And paper**, which drops two more — `Black Lotus vma` and `A-Vivi Ornitier fin`. Not
 * squeamishness about digital printings: `paperOnly` is *omitted-means-true* in
 * `matchesCardFilters`, so a corpus that reached 5 200 with digital rows in it answers 4 965
 * to the search a story actually makes (measured before this filter was added) and the seed
 * whose entire job is to clear the cap does not clear it.
 *
 * **And playable somewhere**, which drops the last two — `Kozilek, Compleated` (a Mystery
 * Booster 2 playtest card) and `Little Girl` (Unhinged), both legal in no format at all. Same
 * failure as the paper one and found the same way: `legalities` is taken **card-shaped**, so
 * each of those two templates made *eight* unplayable printings 18 times over, and the search
 * view's `playableOnly` default then answered **4 950** — 50 short of the cap this seed exists
 * to clear. Two of 36 templates cost 288 printings, which is the arithmetic that makes a
 * one-in-eighteen fixture detail a story-wide failure.
 */
const LARGE_TEMPLATES = CARDS.filter(
  (c) => c.faces === "[]" && c.isPaper && /"(legal|restricted)"/.test(c.legalities),
);

/** A deterministic uuid-shaped id. `f` in the first nibble and a counter in the node field:
 *  unique across the synthetic corpus by construction, and obviously not a Scryfall id to
 *  anyone who reads one in a URL. */
function synthId(kind: number, n: number): string {
  return `f000000${kind}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

let largeCardsMemo: FakeCard[] | null = null;

/**
 * The `large` corpus: the 43 real printings followed by 5 200 synthetic ones — **5 243 rows**,
 * of which **5 241 are paper** and **5 238 are also playable somewhere**, which is what a
 * default search counts (`paperOnly` is omitted-means-true and the search view sends
 * `playableOnly`) and is comfortably past the 5 000 cap. All 5 200 synthetic rows are in that
 * figure by construction; the five it drops are the two digital and the three unplayable real
 * ones. Collapsed — which is also the default — that is **683 cards**.
 *
 * The real rows stay at the front so a story on this seed can still find Lightning Bolt; the
 * synthetic ones are what push the count past the cap.
 *
 * Each synthetic oracle card takes its **card-shaped** columns from one template — name aside:
 * type line, mana cost, mana value, colours, legalities, power/toughness, `gameChanger`,
 * `everUncommon` — and each of its eight printings takes its **printing-shaped** columns from a
 * second real row: set, rarity, prices, finishes, artist, release date, frame, `isPaper`. That
 * split is not decoration. It is what makes eight printings of one synthetic card *agree* about
 * the card and *differ* about the printing, which is the only thing a printings list is about.
 * The one column that straddles the split is `legalities`, taken card-shaped: `oldschool` is
 * printing-sensitive in real data and is not here, so all eight printings answer it alike.
 *
 * Oracle text is rewritten to name the synthetic card wherever the template named itself (6 of
 * the 43 rows do), so a card called "Ancient Aegis" does not deal 3 damage as Lightning Bolt.
 *
 * Memoised, and safe for exactly the reason {@link makeDb} shares `CARDS` by reference: `cards`
 * is the sync's table and no write in this fake touches it. The 600 entries below are **not**
 * memoised — those are rows a story edits.
 */
function largeCards(): FakeCard[] {
  if (largeCardsMemo) return largeCardsMemo;
  const out: FakeCard[] = [...CARDS];
  for (let k = 0; k < ADJECTIVES.length * NOUNS.length; k += 1) {
    const template = LARGE_TEMPLATES[k % LARGE_TEMPLATES.length];
    const name = `${ADJECTIVES[Math.floor(k / NOUNS.length)]} ${NOUNS[k % NOUNS.length]}`;
    const oracleId = synthId(1, k);
    const oracleText =
      template.oracleText === null ? null : template.oracleText.split(template.name).join(name);
    for (let j = 0; j < LARGE_PRINTINGS_EACH; j += 1) {
      const n = k * LARGE_PRINTINGS_EACH + j;
      const print = LARGE_TEMPLATES[(k + j) % LARGE_TEMPLATES.length];
      out.push({
        ...template,
        id: synthId(0, n),
        oracleId,
        name,
        oracleText,
        setCode: print.setCode,
        setName: print.setName,
        // Unique across the whole synthetic corpus, so two printings that landed in the same
        // set cannot claim the same slot in it.
        collectorNumber: String(n + 1),
        lang: print.lang,
        rarity: print.rarity,
        prices: print.prices,
        priceUsd: print.priceUsd,
        finishes: print.finishes,
        artist: print.artist,
        illustrationId: print.illustrationId,
        releasedAt: print.releasedAt,
        imageStatus: print.imageStatus,
        promo: print.promo,
        fullArt: print.fullArt,
        frameEffects: print.frameEffects,
        borderColor: print.borderColor,
        isPaper: print.isPaper,
        digital: print.digital,
        artCropUrl: print.artCropUrl,
        normalUrl: print.normalUrl,
      });
    }
  }
  largeCardsMemo = out;
  return out;
}

/**
 * A collection deep enough to virtualise: 600 rows, one per oracle card, on the **first**
 * printing of each — so no two rows share a card id and the grain is distinct by construction
 * without any of the other nine terms doing work.
 *
 * Finish is drawn from each card's own `finishes` array rather than cycled blindly: a foil row
 * on a nonfoil-only printing is a state the app cannot produce, and it would price as null and
 * look like a bug in the summary.
 */
function largeEntries(cards: FakeCard[]): FakeEntry[] {
  const next = ids();
  const conditions: FakeEntry["condition"][] = ["NM", "LP", "MP", "HP", "DMG"];
  const rows: FakeEntry[] = [];
  for (let i = 0; i < LARGE_ENTRY_COUNT; i += 1) {
    const card = cards[CARDS.length + i * LARGE_PRINTINGS_EACH];
    const finishes = JSON.parse(card.finishes) as FakeEntry["finish"][];
    rows.push(
      entry(
        next(),
        card,
        finishes[i % finishes.length],
        conditions[i % conditions.length],
        1 + (i % 4),
      ),
    );
  }
  return rows;
}

/**
 * Past the cap, and nothing else.
 *
 * No decks and no wishes: this seed exists for the two things only depth can show — a count
 * that stops at 5 000 and says so, and a list long enough that the virtualiser is deciding what
 * to render. A deck story wants `starter`, where the decks mean something.
 */
function largeSeed(): FakeDb {
  const cards = largeCards();
  return makeDb({ cards, collectionEntries: largeEntries(cards) });
}

/* ------------------------------------------------------------------ the switch --------- */

/**
 * The world for one story.
 *
 * A fresh {@link FakeDb} every call — see this file's header for why that is the contract and
 * not an implementation detail.
 */
export function seed(name: SeedName): FakeDb {
  switch (name) {
    case "empty":
      return emptySeed();
    case "needsReview":
      return needsReviewSeed();
    case "large":
      return largeSeed();
    default:
      return starterSeed();
  }
}
