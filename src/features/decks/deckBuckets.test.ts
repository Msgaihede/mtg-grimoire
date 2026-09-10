import { describe, expect, it } from "vitest";
import type { DeckCard } from "@/lib/ipc";
import { deckStats } from "./DeckStats";
import {
  activeCards,
  cardManaValue,
  curveBucket,
  curveLabel,
  distribution,
  foldBuckets,
  front,
  isLand,
  OTHER,
  sizedCards,
  typeBucket,
  typeCounts,
  type Bucket,
} from "./deckBuckets";
import { X_GROUP_KEY } from "./grouping";
import { card } from "./validation/fixtures";

/** The bar labels, in the order the cut answers them — which is the thing most of this file is
 *  about, so it is read as a list and never as a set. */
const labels = (buckets: readonly Bucket[]) => buckets.map((bucket) => bucket.label);

/** Label → copies, for the cases that are about the arithmetic rather than the order. */
const counts = (buckets: readonly Bucket[]) =>
  Object.fromEntries(buckets.map((bucket) => [bucket.label, bucket.count]));

/**
 * The three real cards the two type readings disagree about, plus the two that pin the halves
 * they agree on.
 *
 * Verified spellings: Urza's Saga is a `Legendary Enchantment Land`, Tree of Tales an
 * `Artifact Land`, Dryad Arbor a `Land Creature`. All three are lands a deckbuilder counts in
 * their manabase and all three head a *spell* bar, which is the disagreement `isLand`'s doc
 * calls load-bearing.
 */
const URZAS_SAGA = "Legendary Enchantment Land — Urza's";
const TREE_OF_TALES = "Artifact Land";
const DRYAD_ARBOR = "Land Creature — Forest Dryad";

describe("front", () => {
  it("takes the face a deck is cast from, and answers a string for a row with no type line", () => {
    expect(front("Sorcery // Land")).toBe("Sorcery ");
    expect(front("Instant")).toBe("Instant");
    expect(front(null)).toBe("");
  });
});

/**
 * **The two readings disagree on purpose, and this pins the disagreement in both directions.**
 *
 * `isLand` asks the type line — the Lands figure, the curve and the average all read it, because
 * a deckbuilder counts Urza's Saga among their lands and none of these three costs anything to
 * put onto the battlefield. `typeBucket` files a card under the *first* type printed on it,
 * because the bars are headings a reader already sees over the rows. Folding the two orders
 * together breaks whichever job loses, so each case below says what both functions answer about
 * one card rather than testing them apart.
 */
describe("isLand against typeBucket", () => {
  it("calls all three hybrids lands while filing each under its first printed type", () => {
    expect(isLand(URZAS_SAGA)).toBe(true);
    expect(typeBucket(URZAS_SAGA)).toBe("Enchantment");

    expect(isLand(TREE_OF_TALES)).toBe(true);
    expect(typeBucket(TREE_OF_TALES)).toBe("Artifact");

    expect(isLand(DRYAD_ARBOR)).toBe(true);
    expect(typeBucket(DRYAD_ARBOR)).toBe("Creature");
  });

  it("agrees about a plain land and about a plain spell", () => {
    expect(isLand("Basic Land — Swamp")).toBe(true);
    expect(typeBucket("Basic Land — Swamp")).toBe("Land");

    expect(isLand("Instant")).toBe(false);
    expect(typeBucket("Instant")).toBe("Instant");
  });

  /** The front face decides both answers: a modal DFC whose back is a land is a spell, and one
   *  whose back is a creature is still a land. Reading the whole `type_line` gets each backwards. */
  it("reads the front face and never the back", () => {
    expect(isLand("Sorcery // Land")).toBe(false);
    expect(typeBucket("Sorcery // Land")).toBe("Sorcery");

    expect(isLand("Land // Creature — Elemental")).toBe(true);
    expect(typeBucket("Land // Creature — Elemental")).toBe("Land");
  });

  it("files a row whose printing has left the corpus under Other, and calls it no land", () => {
    expect(isLand(null)).toBe(false);
    expect(typeBucket(null)).toBe(OTHER);
    expect(typeBucket("Token Creature")).toBe("Creature");
    expect(typeBucket("Scheme")).toBe(OTHER);
  });
});

describe("cardManaValue", () => {
  it("prefers the synced column, and a zero there is an answer rather than an absence", () => {
    expect(cardManaValue(card({ cmc: 5, manaCost: "{X}{R}" }))).toBe(5);
    // The trap: `cmc` is checked against `null` and not for truthiness, so a Swamp's own 0 is
    // the answer even though it has no printed cost to fall back to.
    expect(cardManaValue(card({ cmc: 0, manaCost: null }))).toBe(0);
  });

  it("falls back to the printed cost, through the engine's own arithmetic", () => {
    expect(cardManaValue(card({ cmc: null, manaCost: "{2}{W}{W}" }))).toBe(4);
    // X is worth nothing (CR 202.3b) and a hybrid is worth its greater half.
    expect(cardManaValue(card({ cmc: null, manaCost: "{X}{B}{B}{B}" }))).toBe(3);
    expect(cardManaValue(card({ cmc: null, manaCost: "{2/W}" }))).toBe(2);
  });

  it("answers null for a row with neither", () => {
    expect(cardManaValue(card({ cmc: null, manaCost: null }))).toBeNull();
  });
});

describe("curveBucket and curveLabel", () => {
  it("floors, clamps at both ends, and leaves the eighth bucket open", () => {
    expect(curveBucket(0)).toBe(0);
    expect(curveBucket(3.5)).toBe(3);
    expect(curveBucket(7)).toBe(7);
    expect(curveBucket(8)).toBe(8);
    expect(curveBucket(13)).toBe(8);
    expect(curveBucket(-2)).toBe(0);
  });

  it("names the last bucket open-ended and the rest by their number", () => {
    expect(curveLabel(0)).toBe("0");
    expect(curveLabel(7)).toBe("7");
    expect(curveLabel(8)).toBe("8+");
  });
});

describe("typeCounts", () => {
  /**
   * The seeded order deliberately disagrees with the expected one — a fixture already in
   * `TYPE_BUCKETS` order would be green against an implementation that never sorted at all.
   */
  it("answers in the order the types are printed, whatever order the rows arrive in", () => {
    const rows = [
      card({ name: "Swamp", typeLine: "Basic Land — Swamp" }),
      card({ name: "Grizzly Bears", typeLine: "Creature — Bear" }),
      card({ name: "Lightning Bolt", typeLine: "Instant" }),
      card({ name: "Nothing At All", typeLine: null }),
    ];

    expect(labels(typeCounts(rows))).toEqual(["Creature", "Instant", "Land", OTHER]);
  });

  it("counts copies and never rows", () => {
    const rows = [
      card({ name: "Grizzly Bears", typeLine: "Creature — Bear", quantity: 4 }),
      card({ name: "Llanowar Elves", typeLine: "Creature — Elf Druid", quantity: 3 }),
      card({ name: "Lightning Bolt", typeLine: "Instant", quantity: 2 }),
    ];

    expect(counts(typeCounts(rows))).toEqual({ Creature: 7, Instant: 2 });
  });

  /** The three lands `isLand` disagrees with head their own spell bars here, which is the same
   *  rule as the block above said about one card at a time — said over a whole deck. */
  it("heads the Enchantment, Artifact and Creature bars with lands", () => {
    const rows = [
      card({ name: "Urza's Saga", typeLine: URZAS_SAGA }),
      card({ name: "Tree of Tales", typeLine: TREE_OF_TALES }),
      card({ name: "Dryad Arbor", typeLine: DRYAD_ARBOR }),
      card({ name: "Swamp", typeLine: "Basic Land — Swamp" }),
    ];

    expect(counts(typeCounts(rows))).toEqual({
      Creature: 1,
      Artifact: 1,
      Enchantment: 1,
      Land: 1,
    });
  });

  it("invents no empty bucket", () => {
    const bars = typeCounts([card({ typeLine: "Instant" })]);

    expect(labels(bars)).toEqual(["Instant"]);
    expect(labels(bars)).not.toContain("Planeswalker");
  });
});

describe("distribution by categories", () => {
  /**
   * **Keyed on the id and never on the word.** `deck_categories` has no unique index on the name,
   * so a deck really can hold two piles called the same thing — and folding them together would
   * be one bar silently standing for two piles the reader keeps apart on purpose.
   */
  it("gives two piles that share a name two buckets", () => {
    const rows = [
      card({ categoryId: 7, categoryName: "Ramp", quantity: 4 }),
      card({ categoryId: 9, categoryName: "Ramp", name: "Sol Ring", quantity: 2 }),
      card({ categoryId: 3, categoryName: "Removal", name: "Swords to Plowshares", quantity: 1 }),
    ];

    const bars = distribution(rows, "categories");

    expect(bars).toEqual([
      { key: "cat-7", label: "Ramp", count: 4 },
      { key: "cat-9", label: "Ramp", count: 2 },
      { key: "cat-3", label: "Removal", count: 1 },
    ]);
  });

  it("sums the copies of a pile that arrives in several rows, where its first row is", () => {
    const rows = [
      card({ categoryId: 9, categoryName: "Removal", name: "Bolt", quantity: 4 }),
      card({ categoryId: 2, categoryName: "Ramp", name: "Sol Ring", quantity: 1 }),
      card({ categoryId: 9, categoryName: "Removal", name: "Swords", quantity: 3 }),
    ];

    expect(distribution(rows, "categories")).toEqual([
      { key: "cat-9", label: "Removal", count: 7 },
      { key: "cat-2", label: "Ramp", count: 1 },
    ]);
  });
});

describe("distribution by manaValue", () => {
  /**
   * **This is the cut that counts lands, which is where it deliberately parts company with the
   * mana curve above it.** The curve is a chart about spells and drops them; this is a chart
   * about cards, and a Swamp is a card of mana value zero.
   */
  it("counts lands, where the curve excludes them", () => {
    const rows = [
      card({ name: "Swamp", typeLine: "Basic Land — Swamp", manaCost: null, cmc: 0, quantity: 20 }),
      card({ name: "Lightning Bolt", typeLine: "Instant", cmc: 1, quantity: 4 }),
    ];

    expect(counts(distribution(rows, "manaValue"))).toEqual({ "0": 20, "1": 4 });
    // The same rows through the curve, which is the surface this one must not be confused with.
    expect(deckStats(rows).curve[0]).toBe(0);
  });

  it("files a row with neither a cmc nor a printed cost under No mana value, never under 0", () => {
    const rows = [
      card({ name: "Orphan", cmc: null, manaCost: null, quantity: 2 }),
      card({ name: "Swamp", typeLine: "Basic Land — Swamp", manaCost: null, cmc: 0, quantity: 1 }),
    ];

    const bars = distribution(rows, "manaValue");

    expect(labels(bars)).toEqual(["0", "No mana value"]);
    expect(counts(bars)).toEqual({ "0": 1, "No mana value": 2 });
    expect(bars[bars.length - 1].key).toBe("mv-unknown");
  });

  it("ascends, ends open, and invents no empty bucket in between", () => {
    const rows = [
      card({ name: "Emrakul", cmc: 15, quantity: 1 }),
      card({ name: "Bolt", cmc: 1, quantity: 4 }),
      card({ name: "Wrath", cmc: 4, quantity: 2 }),
    ];

    expect(labels(distribution(rows, "manaValue"))).toEqual(["1", "4", "8+"]);
  });
});

describe("distribution by cardName", () => {
  it("folds one card's printings and finishes into one bucket, spelled as its first row is", () => {
    const rows = [
      card({ name: "Lightning Bolt", cardId: "bolt-lea", quantity: 2 }),
      card({ name: "lightning bolt", cardId: "bolt-m10", quantity: 1 }),
      card({ name: "Lightning Bolt", cardId: "bolt-lea", finish: "foil", quantity: 1 }),
    ];

    expect(distribution(rows, "cardName")).toEqual([
      { key: "name-lightning bolt", label: "Lightning Bolt", count: 4 },
    ]);
  });

  /** The seeded order is Bolt, Recall, Brainstorm; the answer is none of those three orders by
   *  accident — most copies first, then the alphabet. */
  it("sorts by copies descending, then by label ascending", () => {
    const rows = [
      card({ name: "Lightning Bolt", quantity: 4 }),
      card({ name: "Ancestral Recall", quantity: 4 }),
      card({ name: "Brainstorm", quantity: 5 }),
    ];

    expect(labels(distribution(rows, "cardName"))).toEqual([
      "Brainstorm",
      "Ancestral Recall",
      "Lightning Bolt",
    ]);
  });
});

describe("separateXGroup", () => {
  const X_SPELL = card({ name: "Fireball", manaCost: "{X}{R}", cmc: 1, quantity: 3 });
  const SWAMP = card({
    name: "Swamp",
    typeLine: "Basic Land — Swamp",
    manaCost: null,
    cmc: 0,
    quantity: 2,
  });
  const ORPHAN = card({ name: "Orphan", cmc: null, manaCost: null, quantity: 1 });

  it("leaves an X spell in its numeric bucket when the deck is not splitting", () => {
    expect(counts(distribution([X_SPELL, SWAMP], "manaValue", false))).toEqual({
      "0": 2,
      "1": 3,
    });
  });

  it("moves it to its own trailing bucket, behind the numbers and in front of the unknowns", () => {
    const bars = distribution([X_SPELL, SWAMP, ORPHAN], "manaValue", true);

    expect(labels(bars)).toEqual(["0", "X", "No mana value"]);
    expect(counts(bars)).toEqual({ "0": 2, X: 3, "No mana value": 1 });
    // The key is `grouping.ts`', imported rather than respelled, so the bar and the heading a
    // reader sees beside it cannot drift apart.
    expect(bars[1].key).toBe(X_GROUP_KEY);
  });

  it("reaches the mana-value cut and no other", () => {
    const rows = [X_SPELL, SWAMP, ORPHAN];

    for (const by of ["types", "categories", "cardName"] as const) {
      expect(distribution(rows, by, true)).toEqual(distribution(rows, by, false));
    }
  });
});

describe("foldBuckets", () => {
  /**
   * **The seeded order disagrees with the rank order on purpose.** The widest bucket is fourth
   * and the second-widest is second, so an implementation that answered `ranked.slice(0, limit)`
   * would draw them the other way round and every assertion below would notice.
   */
  const CUT: readonly Bucket[] = [
    { key: "a", label: "A", count: 1 },
    { key: "b", label: "B", count: 7 },
    { key: "c", label: "C", count: 3 },
    { key: "d", label: "D", count: 9 },
    { key: "e", label: "E", count: 5 },
  ];

  it("keeps the widest in the cut's own order, not in rank order", () => {
    expect(foldBuckets(CUT, 2)).toEqual([
      { key: "b", label: "B", count: 7 },
      { key: "d", label: "D", count: 9 },
      { key: "fold-other", label: OTHER, count: 9 },
    ]);

    expect(labels(foldBuckets(CUT, 3))).toEqual(["B", "D", "E", OTHER]);
  });

  it("sums everything it dropped into the one trailing Other", () => {
    // 1 + 3 + 5, the three it did not keep at a limit of 2.
    const two = foldBuckets(CUT, 2);
    expect(two[two.length - 1]).toEqual({ key: "fold-other", label: OTHER, count: 9 });
    // 1 + 3 at a limit of 3, which is a different sum over a different set.
    const three = foldBuckets(CUT, 3);
    expect(three[three.length - 1]).toEqual({ key: "fold-other", label: OTHER, count: 4 });
  });

  /** An `Other` standing for exactly one bucket is a bar that has been renamed rather than
   *  summarised, so the guard is `> limit + 1` and five buckets survive a limit of four. */
  it("folds nothing at limit + 1", () => {
    expect(foldBuckets(CUT, 4)).toEqual(CUT);
    expect(foldBuckets(CUT, 5)).toEqual(CUT);
    expect(foldBuckets(CUT, 3)).not.toEqual(CUT);
  });

  it("folds nothing at all at a limit of zero or less", () => {
    expect(foldBuckets(CUT, 0)).toEqual(CUT);
    expect(foldBuckets(CUT, -1)).toEqual(CUT);
  });

  it("appends no Other when the buckets it dropped hold nothing", () => {
    const withEmpties: readonly Bucket[] = [
      { key: "a", label: "A", count: 4 },
      { key: "b", label: "B", count: 3 },
      { key: "c", label: "C", count: 0 },
      { key: "d", label: "D", count: 0 },
    ];

    expect(labels(foldBuckets(withEmpties, 2))).toEqual(["A", "B"]);
  });

  it("answers a new array and leaves the cut it was handed alone", () => {
    const folded = foldBuckets(CUT, 2);

    expect(folded).not.toBe(CUT);
    expect(labels(CUT)).toEqual(["A", "B", "C", "D", "E"]);
    expect(foldBuckets(CUT, 9)).not.toBe(CUT);
  });

  /** The cut whose order is ascending rather than printed — the same rule, over a real
   *  distribution, so a fold that reordered would be visible as a curve reading 3, 1, Other. */
  it("keeps a mana-value cut ascending", () => {
    const rows = [
      card({ name: "One", cmc: 1, quantity: 9 }),
      card({ name: "Two", cmc: 2, quantity: 2 }),
      card({ name: "Three", cmc: 3, quantity: 8 }),
      card({ name: "Zero", cmc: 0, quantity: 1 }),
    ];

    expect(labels(foldBuckets(distribution(rows, "manaValue"), 2))).toEqual(["1", "3", OTHER]);
  });
});

describe("activeCards and sizedCards", () => {
  /**
   * A deck holding every case at once: two active `main` piles of one category, a Sideboard, a
   * Commander, a Companion, the seeded switched-off Maybeboard, a pile of the reader's own they
   * switched off, and a `maybe` pile they switched **on**.
   *
   * Every pile has its own `categoryId` where its switch differs from its neighbours', because
   * `deckStats` tallies by category and takes each pile's switch off its first row — a fixture
   * with two rows of one id disagreeing about `categoryActive` would encode a state the backend
   * cannot produce.
   */
  const DECK: DeckCard[] = [
    card({ categoryKind: "main", quantity: 40 }),
    card({ name: "Island", categoryKind: "main", quantity: 20 }),
    card({ name: "Pithing Needle", categoryKind: "side", quantity: 15 }),
    card({ name: "Kenrith, the Returned King", categoryKind: "commander", quantity: 1 }),
    card({ name: "Lurrus of the Dream-Den", categoryKind: "companion", quantity: 1 }),
    card({ name: "Shark Typhoon", categoryKind: "maybe", quantity: 7 }),
    card({
      name: "Cultivate",
      categoryKind: "main",
      categoryId: 11,
      categoryName: "Ramp",
      categoryActive: false,
      quantity: 5,
    }),
    card({
      name: "Ponder",
      categoryKind: "maybe",
      categoryId: 12,
      categoryName: "Shortlist",
      categoryActive: true,
      quantity: 3,
    }),
  ];

  const copies = (rows: readonly DeckCard[]) => rows.reduce((n, row) => n + row.quantity, 0);
  const names = (rows: readonly DeckCard[]) => rows.map((row) => row.name);

  it("leaves a switched-off pile out of both, whoever switched it off", () => {
    // The seeded Maybeboard and a `main` pile of the reader's own — one flag, not a kind test.
    expect(names(activeCards(DECK))).not.toContain("Shark Typhoon");
    expect(names(activeCards(DECK))).not.toContain("Cultivate");
    expect(names(sizedCards(DECK))).not.toContain("Shark Typhoon");
    expect(names(sizedCards(DECK))).not.toContain("Cultivate");
  });

  it("counts a sideboard as active and not as sized", () => {
    expect(names(activeCards(DECK))).toContain("Pithing Needle");
    expect(names(sizedCards(DECK))).not.toContain("Pithing Needle");
    // A companion is the other kind played *beside* the deck rather than in it (CR 100.4a).
    expect(names(activeCards(DECK))).toContain("Lurrus of the Dream-Den");
    expect(names(sizedCards(DECK))).not.toContain("Lurrus of the Dream-Den");
  });

  it("counts a Maybeboard the reader switched on, which is the kind test doing its own work", () => {
    expect(names(sizedCards(DECK))).toContain("Ponder");
    expect(names(sizedCards(DECK))).toContain("Kenrith, the Returned King");
  });

  it("answers two different totals over one deck", () => {
    expect(copies(activeCards(DECK))).toBe(80);
    expect(copies(sizedCards(DECK))).toBe(64);
  });

  /**
   * **The odds table's denominator and the Cards figure over it must be one number.** They are
   * two derivations — this one filters rows, `deckStats` tallies categories and applies the size
   * rule to each pile — so they can come to disagree, and a table answering about a deck the
   * reader is not being shown is exactly the failure `sizedCards`' doc names.
   */
  it("sums to the Cards figure the ledger draws", () => {
    const sized = copies(sizedCards(DECK));

    expect(sized).toBe(deckStats(DECK).sized);
    // Not vacuous: the deck really does hold copies this figure leaves out.
    expect(sized).toBeGreaterThan(0);
    expect(sized).toBeLessThan(copies(activeCards(DECK)));
  });

  it("still agrees when every pile counts", () => {
    const plain = [
      card({ categoryKind: "main", quantity: 60 }),
      card({ name: "Island", categoryKind: "main", quantity: 4 }),
    ];

    expect(copies(sizedCards(plain))).toBe(deckStats(plain).sized);
    expect(deckStats(plain).sized).toBe(64);
  });
});
