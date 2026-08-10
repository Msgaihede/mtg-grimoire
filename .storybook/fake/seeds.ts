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
 *   "nothing has been synced yet" means to this app.
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
import { CLOCK_BASE, makeDb } from "./db";
import type { FakeDb, FakeDeck, FakeDeckCard, FakeEntry, FakeWish } from "./db";
import { printing } from "./fixtures";
import type { DeckZone } from "@/lib/ipc";

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

/** A deck row. `name` is denormalised alongside the printing — it is the one thing an orphaned
 *  deck card still has to show. */
function deckCard(
  id: number,
  deckId: number,
  card: FakeCard,
  zone: DeckZone,
  quantity: number,
  over: Partial<FakeDeckCard> = {},
): FakeDeckCard {
  return {
    id,
    deckId,
    cardId: card.id,
    zone,
    quantity,
    name: card.name,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    lang: card.lang,
    needsReview: null,
    ...over,
  };
}

/* ------------------------------------------------------------------ empty -------------- */

/**
 * First run: the app has never synced.
 *
 * `cards: []` and nothing else, because everything else is already empty in {@link makeDb} —
 * and the empty `cards` is the only part a story cannot get any other way. `sync_status` reads
 * `cardCount` straight off this array, so this seed is also the one that renders the ribbon's
 * "no cards yet" state honestly rather than by faking a number.
 */
function emptySeed(): FakeDb {
  return makeDb({ cards: [] });
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
 * Three decks: a Modern draft, a built Commander deck, and an archived one.
 *
 * `updatedAt` is staggered and every value is **below** `CLOCK_BASE`, for two reasons. The
 * gallery sorts `archived` last then `updated_at DESC`, so the order here is the order a
 * reader sees; and `stamp` measures a write from the newest row in the store, so keeping the
 * seeds under the base leaves the first edit of any story at `CLOCK_BASE + 1`.
 */
const HOUR = 3_600;
const DAY = 86_400;

function starterDecks(): FakeDeck[] {
  return [
    {
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
    },
    {
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
    },
    {
      id: 3,
      name: "Old School 93/94",
      formatKey: "oldschool",
      description: "Twenty-two cards in, and then the prices were looked up.",
      coverCardId: printing("lea", "232").id,
      isBuilt: false,
      archived: true,
      updatedAt: CLOCK_BASE - 30 * DAY,
    },
  ];
}

/**
 * What is in those three decks.
 *
 * All three are run through the real `validateDeck` by `world.test.ts`, which pins the exact
 * issue list each one produces (none, one, one). What follows is why those are the right three.
 *
 * **Deck 1, `modern` — 60 main, 15 side, 2 in the scratchpad.** Every row of `main` and `side`
 * is `modern: "legal"` (measured over `CARDS` 2026-08-09), no card appears in two zones, and
 * the twenty lands are basics plus `Urza's Saga` — so it validates clean, with an issue list
 * of exactly zero. The corpus has no Plains and no Mountain, which is why a deck whose spells
 * are mostly red runs Forests and Islands; it is a fixture with a real curve and a real land
 * count, not a list anyone would sleeve. The `maybe` row is `Ancient Tomb`, which
 * is `modern: "not_legal"` **on purpose**: `maybe` counts toward nothing at all — not size,
 * not copies, not legality, and the allocator does not claim copies for it — and a scratchpad
 * holding an illegal card is the only way a story can show that.
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
function starterDeckCards(): FakeDeckCard[] {
  const next = ids();
  const main = (deckId: number, card: FakeCard, quantity: number) =>
    deckCard(next(), deckId, card, "main", quantity);
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
    // deck, because `COPY_ZONES` counts main and side together.
    deckCard(next(), 1, printing("gtc", "215"), "side", 4),
    deckCard(next(), 1, printing("apc", "128"), "side", 4),
    deckCard(next(), 1, printing("acr", "211"), "side", 4),
    deckCard(next(), 1, printing("nph", "9"), "side", 3),
    deckCard(next(), 1, printing("tmp", "315"), "maybe", 2),

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
    deckCard(next(), 2, printing("eld", "303"), "commander", 1),
    deckCard(next(), 2, printing("iko", "226"), "companion", 1),

    // --- deck 3 -------------------------------------------------------------------------
    main(3, printing("lea", "232"), 1),
    main(3, printing("lea", "47"), 1),
    main(3, printing("lea", "161"), 4),
    main(3, printing("lea", "288"), 16),
  ];
}

function starterSeed(): FakeDb {
  return makeDb({
    collectionEntries: starterEntries(),
    wishlistEntries: starterWishes(),
    decks: starterDecks(),
    deckCards: starterDeckCards(),
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
    ...deckCard(db.deckCards.length + 1, 1, printing("2x2", "117"), "main", 1),
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
 * The rows of `CARDS` a synthetic card may be cut from: **36 of the 43**, measured 2026-08-09.
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
 */
const LARGE_TEMPLATES = CARDS.filter((c) => c.faces === "[]" && c.isPaper);

/** A deterministic uuid-shaped id. `f` in the first nibble and a counter in the node field:
 *  unique across the synthetic corpus by construction, and obviously not a Scryfall id to
 *  anyone who reads one in a URL. */
function synthId(kind: number, n: number): string {
  return `f000000${kind}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

let largeCardsMemo: FakeCard[] | null = null;

/**
 * The `large` corpus: the 43 real printings followed by 5 200 synthetic ones — **5 243 rows**,
 * of which **5 241 are paper**, which is what a default search counts (`paperOnly` is
 * omitted-means-true) and is comfortably past the 5 000 cap.
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
