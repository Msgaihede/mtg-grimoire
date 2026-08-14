/**
 * What one story must not be able to do to the next, and what each seed has to contain for a
 * story to be *about* anything.
 *
 * The first block is the reason this file exists. Task 6's brief asked for the isolation to be
 * proved by switching between two throwaway stories in a browser; a test that seeds a world,
 * edits it through a real write handler and then re-runs the decorator's setup proves the same
 * thing without a human watching, and keeps proving it.
 *
 * The second block is a consistency pass over the hand-written seeds. Forty-odd rows carry
 * denormalised copies of a card's set, collector number, language and name, and a typo in one
 * of them produces a row that renders plausibly and is wrong — the exact failure the
 * denormalisation exists to survive, staged by accident.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { installWorld } from "./world";
import { invoke, resetCommands } from "./core";
import { emitFake, listen } from "./event";
import { seed } from "./seeds";
import { CARDS } from "./cards";
import { CLOCK_BASE } from "./db";
import type { FakeDb, FakeDeck, FakeDeckCard, FakeEntry } from "./db";
import { useAppStore } from "@/lib/store";
import { SPECS } from "@/features/decks/validation/fixtures";
import { validateDeck } from "@/features/decks/validation/engine";
import type { CollectionPage, DeckDetail, DeckRow, EntryChange, SearchResponse } from "@/lib/ipc";

/** The one row every isolation test edits: `starter`'s first collection entry, four copies of
 *  Lightning Bolt `2x2 117`. */
const FIRST_ENTRY_QUANTITY = 4;

function firstEntry(db: FakeDb): FakeEntry {
  return db.collectionEntries[0];
}

describe("per-story isolation", () => {
  beforeEach(() => {
    resetCommands();
  });

  it("gives the next story a store the last one's writes never touched", async () => {
    const first = installWorld({ seed: "starter" }).db;
    expect(firstEntry(first).quantity).toBe(FIRST_ENTRY_QUANTITY);

    // Through `invoke`, not through the handler map: this is the path a component takes, so a
    // world that was seeded but never *registered* fails here rather than passing quietly.
    const change = await invoke<EntryChange>("collection_set_quantity", {
      id: firstEntry(first).id,
      quantity: 99,
    });
    expect(change.quantity).toBe(99);
    expect(firstEntry(first).quantity).toBe(99);

    const second = installWorld({ seed: "starter" }).db;
    expect(firstEntry(second).quantity).toBe(FIRST_ENTRY_QUANTITY);
    // Not the same objects, which is the property that makes the line above true rather than
    // lucky: the writes mutate rows in place, so a shared row array would have carried the 99.
    expect(second.collectionEntries).not.toBe(first.collectionEntries);
    expect(firstEntry(second)).not.toBe(firstEntry(first));
  });

  it("answers the second story's reads from the second story's rows", async () => {
    installWorld({ seed: "starter" });
    const before = await invoke<CollectionPage>("collection_list", {
      query: { limit: 0, offset: 0 },
    });
    await invoke("collection_remove", { id: before.items[0].id });

    installWorld({ seed: "starter" });
    const after = await invoke<CollectionPage>("collection_list", {
      query: { limit: 0, offset: 0 },
    });
    expect(after.total).toBe(before.total);
  });

  it("drops the listeners a story registered", async () => {
    installWorld({ seed: "starter" });
    const heard: unknown[] = [];
    await listen("sync:progress", (e) => heard.push(e.payload));
    emitFake("sync:progress", { phase: "downloading" });
    expect(heard).toHaveLength(1);

    installWorld({ seed: "starter" });
    emitFake("sync:progress", { phase: "ingesting" });
    // Still one. A surviving subscriber is invisible until a story emits — which is why this
    // is a test and not a code comment.
    expect(heard).toHaveLength(1);
  });

  it("restores the app store, actions included", () => {
    installWorld({ seed: "starter" });
    useAppStore.getState().setActiveView("decks");
    useAppStore.getState().setOpenDeckId(2);
    expect(useAppStore.getState().activeView).toBe("decks");

    installWorld({ seed: "starter" });
    const state = useAppStore.getState();
    expect(state.activeView).toBe("search");
    expect(state.openDeckId).toBeNull();
    expect(state.selectedCardId).toBeNull();
    // `setState(…, true)` replaces the state object wholesale. The actions live in it, so this
    // is the assertion that the replace did not leave the store without any.
    expect(typeof state.setActiveView).toBe("function");
  });

  it("applies the fault the story asked for, and clears it for the story after", async () => {
    installWorld({ seed: "starter", fault: "busy" });
    await expect(invoke("collection_set_quantity", { id: 1, quantity: 1 })).rejects.toThrow(
      /busy finishing a sync/,
    );

    installWorld({ seed: "starter" });
    await expect(
      invoke<EntryChange>("collection_set_quantity", { id: 1, quantity: 1 }),
    ).resolves.toMatchObject({ quantity: 1 });
  });

  it("defaults to starter with no fault when a story says nothing", () => {
    const db = installWorld(undefined).db;
    expect(db.fault).toBeNull();
    expect(db.cards).toBe(seed("starter").cards);
    expect(db.decks).toHaveLength(4);
  });
});

/**
 * Two worlds installed at once, which is what an autodocs page is.
 *
 * The block above proves a world is *replaced* cleanly — one story after another, which is the
 * canvas. This one proves two can be **live together**, because a docs page mounts every story
 * on it simultaneously and ten of this repository's story files put differing seeds and faults
 * on one page. Every test here fails against the module-global world this replaced: `installWorld`
 * overwrote one dispatch table, so the second install answered for both stories.
 *
 * `scope.ts`'s header names four ways into the fake. Three of them are unit-testable and are
 * below; the fourth (a mount effect landing before the story's own) needs React and lives in
 * `src/stories.test.tsx`.
 */
describe("two worlds at once", () => {
  beforeEach(() => {
    resetCommands();
  });

  /** What a default search finds in a world — the query `SearchPage` opens with. */
  const searchTotal = async (): Promise<number> => {
    const page = await invoke<SearchResponse>("search_cards", {
      req: { limit: 0, offset: 0, sort: "name" },
    });
    return page.total;
  };

  it("answers each world out of its own rows, whichever was installed last", async () => {
    const starter = installWorld({ seed: "starter" });
    const empty = installWorld({ seed: "empty" });

    // The *second* install is the one the pointer is left on, so this is the reading the old
    // module-global fake gave for both stories.
    await expect(searchTotal()).resolves.toBe(0);

    const inStarter = await starter.run(() => searchTotal());
    expect(inStarter).toBeGreaterThan(0);
    expect(inStarter).toBe(starter.db.cards.filter((c) => c.isPaper).length);
    await expect(empty.run(() => searchTotal())).resolves.toBe(0);
    // And back again: `run` restores the pointer rather than leaving it wherever it finished.
    await expect(starter.run(() => searchTotal())).resolves.toBe(inStarter);
  });

  it("applies each world's fault to that world only", async () => {
    const busy = installWorld({ seed: "starter", fault: "busy" });
    const fine = installWorld({ seed: "starter" });

    await expect(
      busy.run(() => invoke("collection_set_quantity", { id: 1, quantity: 7 })),
    ).rejects.toThrow(/busy finishing a sync/);
    await expect(
      fine.run(() => invoke<EntryChange>("collection_set_quantity", { id: 1, quantity: 7 })),
    ).resolves.toMatchObject({ quantity: 7 });
  });

  it("keeps a world's fetches in it when its query client is the one asking", async () => {
    const starter = installWorld({ seed: "starter" });
    const empty = installWorld({ seed: "empty" });
    const expected = await starter.run(() => searchTotal());

    // **Leave the pointer on the other world first.** Every call above re-points it at the
    // world that answered (`core.ts`'s `invoke`), so a `fetchQuery` written straight after one
    // would be answered correctly by accident and prove nothing about the binding.
    await expect(empty.run(() => searchTotal())).resolves.toBe(0);

    // No `run` around this: `fetchQuery` is the path a component's `useQuery` takes, and the
    // binding `worldQueryClient` puts on `queryFn` is the only thing pointing it at `starter`
    // while `empty` is the world the pointer was left on.
    const fetched = await starter.client.fetchQuery({
      queryKey: ["search", "starter"],
      queryFn: () => searchTotal(),
    });
    expect(fetched).toBe(expected);
  });

  it("carries a world across the await that follows one of its own calls", async () => {
    const starter = installWorld({ seed: "starter" });
    installWorld({ seed: "empty" });

    // `run` restores the pointer the moment this callback *returns its promise* — before the
    // first `await` has resolved. The second call is therefore made from a continuation that
    // nothing is holding the pointer for, and `useSync.ts:130` is the real call site with that
    // shape: it schedules its next poll after `await ipc.syncStatus()`.
    const [first, second] = await starter.run(async () => {
      const before = await searchTotal();
      const after = await searchTotal();
      return [before, after];
    });
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it("fires a timer in the world that scheduled it", async () => {
    const starter = installWorld({ seed: "starter" });
    const empty = installWorld({ seed: "empty" });
    const expected = await starter.run(() => searchTotal());

    let deliver: (n: number) => void = () => {};
    let fail: (e: unknown) => void = () => {};
    const fromTimer = new Promise<number>((resolve, reject) => {
      deliver = resolve;
      fail = reject;
    });
    starter.run(() => {
      // Thirty seconds later in the app (`useSync.ts:130`); zero here, and the wait is what
      // matters rather than the delay — by the time this runs, nothing is on the stack.
      setTimeout(() => void searchTotal().then(deliver, fail), 0);
    });

    // The other world answers a call in the meantime and leaves the pointer on itself, which
    // is what a docs page looks like — and without it this test passes on the pointer the
    // measurement above happened to leave behind rather than on the timer binding.
    // A macrotask timer fires after these microtasks, so the ordering is not a race.
    await expect(empty.run(() => searchTotal())).resolves.toBe(0);
    await expect(fromTimer).resolves.toBe(expected);
  });

  it("gives an emitted event to every mounted story and to no unmounted one", async () => {
    const heard: string[] = [];

    const first = installWorld({ seed: "starter" });
    const unmountFirst = first.mount();
    await first.run(() => listen("sync:progress", () => heard.push("first")));

    const second = installWorld({ seed: "starter" });
    const unmountSecond = second.mount();
    await second.run(() => listen("sync:progress", () => heard.push("second")));

    emitFake("sync:progress", { phase: "downloading" });
    // Both, because a `play` holds no handle on a world and nothing could choose between the
    // stories on a page with. On the canvas exactly one is ever mounted.
    expect(heard).toEqual(["first", "second"]);

    unmountFirst();
    heard.length = 0;
    emitFake("sync:progress", { phase: "ingesting" });
    // The first story's subscriber left with the first story — no sweep, and nothing reached
    // across to the second to do it.
    expect(heard).toEqual(["second"]);
    unmountSecond();
  });

  it("leaves the app store alone for a world that is sharing a page", () => {
    installWorld({ seed: "starter" });
    useAppStore.getState().setActiveView("decks");

    // What a docs page does: the store is one object for the whole page, so the second story
    // on it must not reach into the first story's view.
    installWorld({ seed: "empty" }, { resetStore: false });
    expect(useAppStore.getState().activeView).toBe("decks");

    // …and the canvas, where a story is on its own, still gets the app's own defaults.
    installWorld({ seed: "empty" });
    expect(useAppStore.getState().activeView).toBe("search");
  });
});

describe("the seeds", () => {
  it("empty has no cards and nothing owned", () => {
    const db = seed("empty");
    expect(db.cards).toHaveLength(0);
    expect(db.collectionEntries).toHaveLength(0);
    expect(db.wishlistEntries).toHaveLength(0);
    expect(db.decks).toHaveLength(0);
    expect(db.deckCards).toHaveLength(0);
  });

  it("starter spans every finish and every condition, and keeps a row at zero", () => {
    const rows = seed("starter").collectionEntries;
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((e) => e.finish))).toEqual(new Set(["nonfoil", "foil", "etched"]));
    expect(new Set(rows.map((e) => e.condition))).toEqual(new Set(["NM", "LP", "MP", "HP", "DMG"]));
    expect(rows.filter((e) => e.quantity === 0)).toHaveLength(1);
    // 20 copies over 12 entries: the two numbers a summary shows separately.
    expect(rows.reduce((n, e) => n + e.quantity, 0)).toBe(20);
  });

  it("starter carries a pinned foil wish the nonfoil in the binder does not fill", () => {
    const db = seed("starter");
    const foil = db.wishlistEntries.find((w) => w.preferredFinish === "foil");
    expect(foil).toBeDefined();
    expect(foil?.cardId).not.toBeNull();
    const owned = db.collectionEntries.filter((e) => e.cardId === foil?.cardId);
    expect(owned).toHaveLength(1);
    expect(owned[0].finish).toBe("nonfoil");
  });

  it("starter carries an any-printing wish, which names no printing at all", () => {
    const wish = seed("starter").wishlistEntries.find((w) => w.cardId === null);
    expect(wish).toBeDefined();
    expect(wish?.oracleId).not.toBeNull();
    expect(wish?.name).not.toBe("");
    // All three denormalised columns go with the card id: there is no printing to copy them
    // from, and a non-null one here would make a set filter answer about a printing nobody
    // asked for.
    expect(wish?.setCode).toBeNull();
    expect(wish?.collectorNumber).toBeNull();
    expect(wish?.lang).toBeNull();
  });

  it("starter's decks are the three sizes the plan asked for", () => {
    const db = seed("starter");
    /** Copies filed under one deck's categories of these kinds — the kind, because that is
     *  what the sizes are about; the category ids are per deck. **`live` only**: a size is a
     *  fact about the deck that is sleeved up, and a plan appears on no tile and in no format
     *  rule. Two of the four seeded decks now carry a theory list, so this filter is what the
     *  numbers below have always meant. */
    const quantityIn = (deckId: number, kinds: string[]) =>
      db.deckCards
        .filter((dc) => {
          const category = db.deckCategories.find((c) => c.id === dc.categoryId);
          return (
            dc.deckId === deckId &&
            dc.variant === "live" &&
            category !== undefined &&
            kinds.includes(category.kind)
          );
        })
        .reduce((n, dc) => n + dc.quantity, 0);

    expect(quantityIn(1, ["main"])).toBe(60);
    expect(quantityIn(1, ["side"])).toBe(15);
    expect(quantityIn(1, ["maybe"])).toBe(2);
    // 99 + the commander is the hundred; the companion begins the game outside the deck and
    // counts toward neither.
    expect(quantityIn(2, ["main", "commander"])).toBe(100);
    expect(quantityIn(2, ["companion"])).toBe(1);
    expect(quantityIn(3, ["main"])).toBe(22);
    // Exactly one built deck, which is what makes cross-deck contention visible at all.
    expect(db.decks.filter((d) => d.isBuilt).map((d) => d.id)).toEqual([2]);
    expect(db.decks.filter((d) => d.archived).map((d) => d.id)).toEqual([3]);
  });

  /**
   * One deck was left somewhere and three were not, which is the split a story needs: a deck
   * whose three columns are all defaults is indistinguishable from a deck nobody has ever
   * touched the toolbar on, so a seed where *every* deck read that way could not show the
   * memory working at all.
   */
  it("starter leaves one deck where the reader was, and the rest where a deck opens", () => {
    const db = seed("starter");
    const memory = (d: FakeDeck) => [d.lastVariant, d.lastGroupBy, d.lastSortBy];
    const untouched = ["live", "category", "alphabetical"];
    expect(db.decks.filter((d) => d.id !== 4).map(memory)).toEqual([
      untouched,
      untouched,
      untouched,
    ]);
    // The deck whose whole reason to exist is the plan beside it, reopening on the plan.
    expect(memory(db.decks.find((d) => d.id === 4)!)).toEqual(["theory", "type", "manaCost"]);
  });

  it("every seeded deck names a format the fake backend will accept", () => {
    // `deck_create`/`deck_update` validate against `SPECS`' 12 rows, not `format_specs`' 25.
    // A seeded deck in one of the other 13 formats would list and open and then refuse the
    // first rename.
    for (const deck of seed("starter").decks) {
      expect(Object.keys(SPECS)).toContain(deck.formatKey);
    }
  });

  it("needsReview flags one row in each of the three user card tables", () => {
    const db = seed("needsReview");
    const flagged = [
      db.collectionEntries.filter((e) => e.needsReview !== null),
      db.wishlistEntries.filter((w) => w.needsReview !== null),
      db.deckCards.filter((dc) => dc.needsReview !== null),
    ];
    for (const rows of flagged) {
      expect(rows).toHaveLength(1);
      // A sentence, not a flag: the reconciler writes what happened.
      expect(rows[0].needsReview).toMatch(/\.$/);
      expect(rows[0].needsReview!.split(" ").length).toBeGreaterThan(8);
    }
    // Three writers in `reconcile.rs`, three different sentences.
    expect(new Set(flagged.map((rows) => rows[0].needsReview)).size).toBe(3);
  });

  it("needsReview's three orphans name cards the corpus does not have", () => {
    const db = seed("needsReview");
    const known = new Set(db.cards.map((c) => c.id));
    const orphans = [
      ...db.collectionEntries.filter((e) => e.needsReview !== null).map((e) => e.cardId),
      ...db.wishlistEntries.filter((w) => w.needsReview !== null).map((w) => w.cardId),
      ...db.deckCards.filter((dc) => dc.needsReview !== null).map((dc) => dc.cardId),
    ];
    expect(orphans).toHaveLength(3);
    for (const cardId of orphans) {
      expect(cardId).not.toBeNull();
      expect(known.has(cardId!)).toBe(false);
    }
  });

  it("needsReview leaves starter's rows alone", () => {
    const starter = seed("starter");
    const flagged = seed("needsReview");
    expect(flagged.collectionEntries).toHaveLength(starter.collectionEntries.length + 1);
    expect(flagged.wishlistEntries).toHaveLength(starter.wishlistEntries.length + 1);
    expect(flagged.deckCards).toHaveLength(starter.deckCards.length + 1);
    expect(flagged.decks).toHaveLength(starter.decks.length);
  });

  it("large clears the search cap and stays deep enough to virtualise", async () => {
    installWorld({ seed: "large" });
    const page = await invoke<SearchResponse>("search_cards", {
      req: { limit: 0, offset: 0, sort: "name" },
    });
    expect(page.total).toBe(5000);
    expect(page.totalIsCapped).toBe(true);

    const collection = await invoke<CollectionPage>("collection_list", {
      query: { limit: 0, offset: 0 },
    });
    expect(collection.total).toBe(600);
  });

  it("large's synthetic printings agree about the card and differ about the printing", () => {
    const db = seed("large");
    // 43 real rows, then 650 oracle cards × 8 printings.
    expect(db.cards).toHaveLength(43 + 5200);
    const eight = db.cards.slice(43, 51);
    expect(new Set(eight.map((c) => c.oracleId)).size).toBe(1);
    expect(new Set(eight.map((c) => c.name)).size).toBe(1);
    expect(new Set(eight.map((c) => c.typeLine)).size).toBe(1);
    expect(new Set(eight.map((c) => c.id)).size).toBe(8);
    expect(new Set(eight.map((c) => c.collectorNumber)).size).toBe(8);
    // No synthetic card carries a `card_faces` array, so no face names disagree with the name
    // above them.
    expect(db.cards.slice(43).every((c) => c.faces === "[]")).toBe(true);
    // Ids are unique across the whole corpus, real rows included.
    expect(new Set(db.cards.map((c) => c.id)).size).toBe(db.cards.length);
    // Every synthetic row is paper, so the count a *default* search makes — `paperOnly` is
    // omitted-means-true — is the one that clears the cap. Only the two digital rows of the
    // real corpus are outside it.
    expect(db.cards.filter((c) => c.isPaper)).toHaveLength(5241);
  });

  it("large's collection rows hold a finish their own printing is printed in", () => {
    const db = seed("large");
    const byId = new Map(db.cards.map((c) => [c.id, c]));
    for (const row of db.collectionEntries) {
      const finishes = JSON.parse(byId.get(row.cardId)!.finishes) as string[];
      expect(finishes).toContain(row.finish);
    }
    // Distinct card ids, so the ten-term grain is distinct on its first term alone.
    expect(new Set(db.collectionEntries.map((e) => e.cardId)).size).toBe(
      db.collectionEntries.length,
    );
  });
});

describe("the seeded rows agree with the cards they name", () => {
  const names: ["empty", "starter", "needsReview", "large"] = [
    "empty",
    "starter",
    "needsReview",
    "large",
  ];

  it.each(names)("%s denormalises set, collector and language faithfully", (name) => {
    const db = seed(name);
    const byId = new Map(db.cards.map((c) => [c.id, c]));
    const check = (row: {
      cardId: string;
      setCode: string;
      collectorNumber: string;
      lang: string;
    }) => {
      const card = byId.get(row.cardId);
      // An orphan is the one row with no card to agree with; `needsReview` seeds three.
      if (!card) return;
      expect([row.setCode, row.collectorNumber, row.lang]).toEqual([
        card.setCode,
        card.collectorNumber,
        card.lang,
      ]);
    };
    for (const row of db.collectionEntries) check(row);
    for (const row of db.deckCards) {
      check(row);
      // `deck_cards` denormalises the name as well — the one thing an orphaned deck row still
      // has to show.
      const card = byId.get(row.cardId);
      if (card) expect(row.name).toBe(card.name);
    }
    for (const wish of db.wishlistEntries) {
      const card = wish.cardId === null ? null : byId.get(wish.cardId);
      if (!card) continue;
      expect([wish.setCode, wish.collectorNumber, wish.lang]).toEqual([
        card.setCode,
        card.collectorNumber,
        card.lang,
      ]);
      expect(wish.name).toBe(card.name);
    }
  });

  it.each(names)("%s hands out row ids in insertion order from 1", (name) => {
    const db = seed(name);
    for (const rows of [db.collectionEntries, db.wishlistEntries, db.deckCards]) {
      expect(rows.map((r) => r.id)).toEqual(rows.map((_, i) => i + 1));
    }
  });

  it.each(names)("%s dates every row at or before the fixture's clock", (name) => {
    const db = seed(name);
    for (const row of [...db.collectionEntries, ...db.wishlistEntries, ...db.decks]) {
      // `stamp` measures a write from the newest row in the store, so a seeded row above the
      // base would push every later edit past it and make the numbers depend on the seed.
      expect(row.updatedAt).toBeLessThanOrEqual(CLOCK_BASE);
    }
  });

  it("every deck card belongs to a deck that exists", () => {
    for (const name of names) {
      const db = seed(name);
      const decks = new Set(db.decks.map((d) => d.id));
      for (const row of db.deckCards) expect(decks.has(row.deckId)).toBe(true);
    }
  });

  it("no deck row is at quantity zero, and the grain never repeats", () => {
    const db = seed("needsReview");
    const grain = new Set<string>();
    const categories = new Map(db.deckCategories.map((c) => [c.id, c]));
    for (const row of db.deckCards as FakeDeckCard[]) {
      // `deck_cards` sides with the wishlist: `CHECK (quantity > 0)`, because a category slot
      // at zero holds no condition, no price and no story.
      expect(row.quantity).toBeGreaterThan(0);
      // `schema::DECK_CARD_GRAIN`, and the category has to be one of this deck's — nothing in
      // the DDL enforces that half, so a seed is exactly where it could go wrong unnoticed.
      expect(categories.get(row.categoryId)?.deckId).toBe(row.deckId);
      const key = `${row.deckId}|${row.variant}|${row.categoryId}|${row.cardId}`;
      expect(grain.has(key)).toBe(false);
      grain.add(key);
    }
  });

  /**
   * The three migrated decks own exactly the five rows schema v8's migration leaves them, and
   * the fourth owns the shape a deck the app makes **today** has.
   *
   * Both are real and the split is deliberate: `create_deck` seeds the four predefined at 0–3
   * and every `main` category arrives later, by name, from the first add — so a deck made today
   * has no "Main deck" at all and any number of piles the reader named. A fixture with only the
   * migrated shape would let a story be written against the accident that its main pile sorts
   * second and is called that.
   */
  it("every deck owns the categories its own shape gives it, and no more", () => {
    const migrated = [
      ["commander", "Commander", true, 0],
      ["main", "Main deck", true, 1],
      ["side", "Sideboard", true, 2],
      ["companion", "Companion", true, 3],
      // Seeded off, which is the whole of what makes a Maybeboard special.
      ["maybe", "Maybeboard", false, 4],
    ];
    for (const name of names) {
      const db = seed(name);
      for (const deck of db.decks) {
        const mine = db.deckCategories.filter((c) => c.deckId === deck.id);
        expect(mine.map((c) => [c.kind, c.name, c.isActive, c.sortOrder])).toEqual(
          deck.id === 4
            ? [
                ["commander", "Commander", true, 0],
                ["side", "Sideboard", true, 1],
                ["companion", "Companion", true, 2],
                ["maybe", "Maybeboard", false, 3],
                ["main", "Ramp", true, 4],
                ["main", "Card advantage", true, 5],
                // A pile the *reader* made and switched off. `isActive` is the whole of
                // "counts toward nothing", and nothing downstream reads `kind` for it — which
                // is what makes this row behave exactly like the Maybeboard above it.
                ["main", "Cut list", false, 6],
              ]
            : migrated,
        );
      }
      // Ids are unique across the store, not per deck: `categoryById` searches one table.
      const ids = db.deckCategories.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  /**
   * Every seeded cover names a printing the corpus still has — **or names none at all**, which
   * is the one deck showing a cover of the reader's own.
   *
   * `coverCardId` and `coverKind` are separate columns because a deck may carry both, and
   * `coverArtist` follows the *card id*: an uploaded picture has no Scryfall illustrator, so a
   * deck that has only ever had one credits nobody. That is deck 4, and it is the only null.
   */
  it("starter's cover cards are printings the corpus still has", () => {
    const db = seed("starter");
    const known = new Set(db.cards.map((c) => c.id));
    for (const deck of db.decks) {
      if (deck.coverCardId === null) {
        expect(deck.coverKind).toBe("custom");
        continue;
      }
      expect(known.has(deck.coverCardId)).toBe(true);
    }
    expect(db.decks.filter((d) => d.coverCardId === null).map((d) => d.id)).toEqual([4]);
  });

  it("the corpus keys the seeds are written against are unique", () => {
    // `printing(setCode, collectorNumber)` takes the first match. If a corpus refresh ever
    // introduced a second row at one of these keys, half the seeded rows would silently move
    // to a different printing.
    const keys = CARDS.map((c) => `${c.setCode}|${c.collectorNumber}`);
    expect(new Set(keys).size).toBe(CARDS.length);
  });
});

describe("a story can read the world it was given", () => {
  it("reads a built deck's claims out of the collection it was seeded beside", async () => {
    installWorld({ seed: "starter" });
    const commander = await invoke<DeckDetail>("deck_get", { id: 2, variant: "live" });
    const sol = commander!.cards.find((c) => c.name === "Sol Ring");
    // One copy wanted, one owned, and the exact printing preferred over the foil `sld` one.
    expect(sol?.ownedQuantity).toBe(1);
    expect(sol?.setCode).toBe("c21");
    // The zero row: a printing the deck wants and the collection records without holding.
    const copter = commander!.cards.find((c) => c.name === "Smuggler's Copter");
    expect(copter?.ownedQuantity).toBe(0);

    // The built deck above took one of the four Bolts, so the draft can only plan with three
    // of that printing — it fills the fourth from another printing of the same oracle card.
    const draft = await invoke<DeckDetail>("deck_get", { id: 1, variant: "live" });
    const bolt = draft!.cards.find((c) => c.name === "Lightning Bolt" && c.categoryKind === "main");
    expect(bolt?.quantity).toBe(4);
    expect(bolt?.ownedQuantity).toBe(4);
  });

  /**
   * The seeded decks say what `seeds.ts` claims they say — run through the real engine, not
   * asserted in a comment. Measured 2026-08-09; a corpus refresh that changed a legality or a
   * mana value breaks this rather than quietly making a fixture mean something else.
   */
  it.each([
    [1, [] as string[]],
    [
      2,
      [
        "Lurrus of the Dream-Den needs every permanent card in your deck to have mana value 2 " +
          "or less; Kenrith, the Returned King does not.",
      ],
    ],
    [3, ["Old School decks need at least 60 cards; you have 22."]],
  ])("deck %i validates to exactly the issues it was built to have", async (id, messages) => {
    installWorld({ seed: "starter" });
    const detail = await invoke<DeckDetail>("deck_get", { id, variant: "live" });
    const issues = validateDeck(detail!.cards, SPECS[detail!.deck.formatKey]);
    expect(issues.map((i) => i.message)).toEqual(messages);
  });

  /**
   * The tab memory through `invoke` rather than through the handler map — the path a component
   * takes, so a command registered under a name `ipc.ts` does not send fails here.
   *
   * The second assertion is the one worth making twice: `updatedAt` is the gallery's sort key,
   * so a view-state write that moved it would resort the wall every time somebody glanced at
   * their plan.
   */
  it("remembers the view a story left a deck on, and leaves the gallery's sort key", async () => {
    installWorld({ seed: "starter" });
    const readDeck = async () => (await invoke<DeckRow[]>("deck_list")).find((d) => d.id === 1)!;
    const before = await readDeck();
    expect([before.lastVariant, before.lastGroupBy, before.lastSortBy]).toEqual([
      "live",
      "category",
      "alphabetical",
    ]);

    await invoke("deck_set_view_state", { deckId: 1, viewState: { groupBy: "manaValue" } });

    const after = await readDeck();
    expect([after.lastVariant, after.lastGroupBy, after.lastSortBy]).toEqual([
      "live",
      "manaValue",
      "alphabetical",
    ]);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("serves the empty world without a single handler falling over", async () => {
    installWorld({ seed: "empty" });
    const page = await invoke<SearchResponse>("search_cards", {
      req: { limit: 0, offset: 0, sort: "name" },
    });
    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(0);
    expect(page.totalIsCapped).toBe(false);
    await expect(invoke("deck_get", { id: 1, variant: "live" })).resolves.toBeNull();
    await expect(invoke("sync_status", {})).resolves.toMatchObject({ cardCount: 0 });
  });
});
