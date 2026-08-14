import { describe, expect, it } from "vitest";
import type { DeckCategory } from "@/lib/ipc";
import { card } from "./validation/fixtures";
import { asGroupBy, buildGroups, DEFAULT_GROUP_BY, GROUP_BY_OPTIONS } from "./grouping";

/**
 * One `deck_categories` row. The ids match `validation/fixtures`' `CATEGORIES` table so a
 * `card({ categoryKind: "side" })` lands in the Sideboard built here without either side
 * having to say so twice.
 */
function category(over: Partial<DeckCategory> = {}): DeckCategory {
  return {
    id: 1,
    deckId: 1,
    name: "Main deck",
    kind: "main",
    isActive: true,
    sortOrder: 1,
    cardCount: 0,
    totalPrice: null,
    cardCountAllVariants: over.cardCount ?? 0,
    ...over,
  };
}

const MAIN = category();
const SIDE = category({ id: 2, name: "Sideboard", kind: "side", sortOrder: 2 });
const COMMANDER = category({ id: 3, name: "Commander", kind: "commander", sortOrder: 0 });
const MAYBE = category({
  id: 5,
  name: "Maybeboard",
  kind: "maybe",
  isActive: false,
  sortOrder: 4,
});
/** A pile of the reader's own that they switched off — the Maybeboard's twin, and the one
 *  fixture that proves nothing in here reads the *kind* to decide whether a pile counts. */
const CUTS = category({ id: 6, name: "Cuts", kind: "main", isActive: false, sortOrder: 5 });

const names = (groups: readonly { name: string }[]) => groups.map((g) => g.name);

describe("buildGroups by category", () => {
  it("draws every category in sort order, empty ones included", () => {
    const groups = buildGroups(
      [card({ categoryKind: "main" })],
      [COMMANDER, MAIN, SIDE],
      "category",
      "alphabetical",
    );

    // An empty Sideboard is where the next sideboard card goes; a column that vanished when
    // the last card left it would be a column the reader cannot put one back into.
    expect(names(groups)).toEqual(["Commander", "Main deck", "Sideboard"]);
    expect(groups.map((g) => g.cards.length)).toEqual([0, 1, 0]);
  });

  it("carries the category's own identity onto the group", () => {
    const [commander, main, maybe] = buildGroups(
      [],
      [COMMANDER, MAIN, MAYBE],
      "category",
      "alphabetical",
    );

    expect(commander).toMatchObject({
      categoryId: 3,
      kind: "commander",
      isActive: true,
      isPredefined: true,
    });
    expect(main).toMatchObject({
      categoryId: 1,
      kind: "main",
      isActive: true,
      isPredefined: false,
    });
    expect(maybe).toMatchObject({
      categoryId: 5,
      kind: "maybe",
      isActive: false,
      isPredefined: true,
    });
  });

  /** Copies, not rows — a deck is counted in cards. */
  it("counts copies rather than rows", () => {
    const [group] = buildGroups(
      [card({ name: "Lightning Bolt", quantity: 4 }), card({ name: "Sol Ring", quantity: 2 })],
      [MAIN],
      "category",
      "alphabetical",
    );

    expect(group.cards).toHaveLength(2);
    expect(group.count).toBe(6);
  });

  /** Unit price × copies, and never `cards.price_usd`, which is a display fallback chain. */
  it("sums unit price by copies", () => {
    const [group] = buildGroups(
      [
        card({ name: "Sol Ring", quantity: 2, unitPrice: 1.5 }),
        card({ name: "Arcane Signet", quantity: 1, unitPrice: 0.99 }),
      ],
      [MAIN],
      "category",
      "alphabetical",
    );

    expect(group.totalPrice).toBeCloseTo(3.99, 5);
  });

  /**
   * **The heading totals the rows it was given, and there is nothing else it could total.**
   *
   * This used to take a `Currency` and pick between two fields per row, so it had a test that
   * the pick was right. The marketplace is a query parameter now: a row arrives with one
   * `unitPrice`, already at the marketplace the deck was read at, so a heading and the rows
   * under it cannot be about different money. What is left to assert is that the sum is exactly
   * the rows' own numbers — which is what makes switching marketplace show a *different* total
   * over the same pile without this function knowing a marketplace exists.
   */
  it("sums the prices the rows carry and invents nothing", () => {
    const cheap = [
      card({ name: "Sol Ring", quantity: 2, unitPrice: 1.5 }),
      card({ name: "Arcane Signet", quantity: 1, unitPrice: 0.99 }),
    ];
    const dear = [
      card({ name: "Sol Ring", quantity: 2, unitPrice: 1.65 }),
      card({ name: "Arcane Signet", quantity: 1, unitPrice: 1.09 }),
    ];

    expect(buildGroups(cheap, [MAIN], "category", "alphabetical")[0].totalPrice).toBeCloseTo(
      3.99,
      5,
    );
    expect(buildGroups(dear, [MAIN], "category", "alphabetical")[0].totalPrice).toBeCloseTo(
      4.39,
      5,
    );
  });

  /**
   * **The hole, at the one place a total could paper over it.**
   *
   * A card the selected marketplace does not quote is unpriced *there* — `eur_etched` does not
   * exist in Scryfall's data at all, and a printing a bulk feed has never listed is the same
   * shape one source over. Both arrive as a `null` `unitPrice`, and both are left out of the
   * sum rather than valued at anything. There is no second number on the row to borrow, which
   * is the whole point of the shape: the mistake this guards is no longer expressible.
   */
  it("leaves an unpriced card out of the total rather than valuing it", () => {
    const cards = [
      card({ name: "Sol Ring", quantity: 1, unitPrice: 1.5 }),
      card({ name: "Never listed", quantity: 2, unitPrice: null }),
    ];

    expect(buildGroups(cards, [MAIN], "category", "alphabetical")[0].totalPrice).toBeCloseTo(
      1.5,
      5,
    );

    // Nothing priced at all: an em dash rather than a zero, because `$0.00` is a price nobody
    // quoted.
    const unlisted = [card({ name: "Never listed", quantity: 2, unitPrice: null })];
    expect(buildGroups(unlisted, [MAIN], "category", "alphabetical")[0].totalPrice).toBeNull();
  });

  /**
   * A partial total is more useful than none — the surface that shows it says whose prices
   * they are and when they were true — but a group where *nothing* is priced quotes no number
   * at all, because `$0.00` is a price nobody offered.
   */
  it("skips unpriced cards, and is null when nothing in the group has a price", () => {
    const [partial] = buildGroups(
      [
        card({ name: "Sol Ring", quantity: 1, unitPrice: 1.99 }),
        card({ name: "Orphan", quantity: 3, unitPrice: null }),
      ],
      [MAIN],
      "category",
      "alphabetical",
    );
    expect(partial.totalPrice).toBeCloseTo(1.99, 5);

    const [none] = buildGroups(
      [card({ name: "Orphan", quantity: 3, unitPrice: null })],
      [MAIN],
      "category",
      "alphabetical",
    );
    expect(none.totalPrice).toBeNull();
  });

  it("sorts the cards inside each group by the order it was given", () => {
    const [group] = buildGroups(
      [card({ name: "Sol Ring", cmc: 1 }), card({ name: "Arcane Signet", cmc: 2 })],
      [MAIN],
      "category",
      "manaCost",
    );

    expect(names(group.cards)).toEqual(["Sol Ring", "Arcane Signet"]);
  });

  /**
   * Total, like every other module here: a row filed under a category the read did not
   * answer with is still in the deck, and is drawn under the name the row itself carries
   * rather than dropped on the floor.
   */
  it("keeps a row whose category is not in the list", () => {
    const stray = card({ name: "Stray" });
    const groups = buildGroups(
      [
        {
          ...stray,
          categoryId: 99,
          categoryName: "Gone",
          categoryKind: "main",
          categoryActive: true,
        },
      ],
      [MAIN],
      "category",
      "alphabetical",
    );

    expect(names(groups)).toEqual(["Main deck", "Gone"]);
    expect(groups[1].cards).toHaveLength(1);
  });
});

describe("buildGroups by a derived key", () => {
  /**
   * **The rule the spec is most explicit about.** Under `manaValue` and `type` the derived
   * groups are built from the **active** cards only, and every inactive category is then
   * appended as itself, unchanged, in `sort_order`.
   *
   * Both halves matter. If an inactive card were bucketed with the rest, a Maybeboard card
   * would be counted into the curve the reader is reading — the one thing an inactive pile
   * must never do. If the pile were dropped instead, switching the grouping would make ten
   * cards disappear from the editor with no way to get them back.
   */
  it("inactive_categories_survive_every_grouping", () => {
    const cards = [
      card({ name: "Sol Ring", cmc: 1, typeLine: "Artifact" }),
      {
        ...card({ name: "Avacyn", cmc: 8, typeLine: "Creature — Angel" }),
        categoryId: 5,
        categoryName: "Maybeboard",
        categoryKind: "maybe" as const,
        categoryActive: false,
      },
      {
        ...card({ name: "Ghalta", cmc: 12, typeLine: "Creature — Dinosaur" }),
        categoryId: 6,
        categoryName: "Cuts",
        categoryKind: "main" as const,
        categoryActive: false,
      },
    ];

    for (const groupBy of ["manaValue", "type"] as const) {
      const groups = buildGroups(cards, [MAIN, MAYBE, CUTS], groupBy, "alphabetical");
      const inactive = groups.filter((g) => !g.isActive);

      // The two switched-off piles are there, as themselves, in sort_order — the Maybeboard
      // before the reader's own "Cuts".
      expect(names(inactive)).toEqual(["Maybeboard", "Cuts"]);
      expect(inactive.map((g) => g.categoryId)).toEqual([5, 6]);
      expect(names(inactive[0].cards)).toEqual(["Avacyn"]);
      expect(names(inactive[1].cards)).toEqual(["Ghalta"]);

      // And their cards are in no derived group.
      const derived = groups.filter((g) => g.categoryId === null);
      expect(derived.flatMap((g) => names(g.cards))).toEqual(["Sol Ring"]);
    }
  });

  /** Derived groups are built from what is there. A deck with no planeswalkers has no
   *  planeswalker heading — unlike a category, which is a place as well as a heading. */
  it("has no empty derived groups at all", () => {
    const groups = buildGroups(
      [card({ name: "Sol Ring", cmc: 1, typeLine: "Artifact" })],
      [MAIN],
      "type",
      "alphabetical",
    );

    expect(names(groups)).toEqual(["Artifact"]);
    expect(groups.every((g) => g.cards.length > 0)).toBe(true);
  });

  /**
   * The type headings are drawn in the **reading** order — Land last, as in every decklist —
   * while `autoCategoryFor` matches in an order that checks Land *first*. The two differ only
   * about Land and both answers are deliberate; `autoCategory.ts` names Dryad Arbor as the
   * reason.
   */
  it("heads the type groups in reading order, with the lands last", () => {
    const groups = buildGroups(
      [
        card({ name: "Lightning Bolt", typeLine: "Instant" }),
        card({ name: "Forest", typeLine: "Basic Land — Forest" }),
        card({ name: "Grizzly Bears", typeLine: "Creature — Bear" }),
        card({ name: "Sol Ring", typeLine: "Artifact" }),
        card({ name: "Orphan", typeLine: null }),
      ],
      [MAIN],
      "type",
      "alphabetical",
    );

    expect(names(groups)).toEqual(["Creature", "Artifact", "Instant", "Land", "Uncategorised"]);
  });

  it("buckets mana value 0 through 7 exactly, 8 and up together, and unknown last", () => {
    const groups = buildGroups(
      [
        card({ name: "Emrakul", cmc: 15 }),
        card({ name: "Orphan", cmc: null }),
        card({ name: "Ancestral Recall", cmc: 1 }),
        card({ name: "Black Lotus", cmc: 0 }),
        card({ name: "Ulamog", cmc: 8 }),
      ],
      [MAIN],
      "manaValue",
      "alphabetical",
    );

    expect(names(groups)).toEqual([
      "Mana value 0",
      "Mana value 1",
      "Mana value 8 or more",
      "Mana value unknown",
    ]);
    expect(names(groups[2].cards)).toEqual(["Emrakul", "Ulamog"]);
  });

  it("names a derived group nothing can be dropped into", () => {
    const [group] = buildGroups([card({ cmc: 1 })], [MAIN], "manaValue", "alphabetical");

    expect(group.categoryId).toBeNull();
    expect(group.kind).toBeNull();
    expect(group.isPredefined).toBe(false);
    expect(group.isActive).toBe(true);
  });

  it("counts and prices a derived group by the same two rules", () => {
    const [group] = buildGroups(
      [
        card({ name: "Sol Ring", cmc: 1, quantity: 2, unitPrice: 1.5 }),
        card({ name: "Mox Pearl", cmc: 0, quantity: 1, unitPrice: null }),
      ],
      [MAIN],
      "manaValue",
      "alphabetical",
    );

    // The 0-drop is its own group; this one is the mana value 1 bucket.
    expect(group.name).toBe("Mana value 0");
    expect(group.count).toBe(1);
    expect(group.totalPrice).toBeNull();
  });

  /**
   * The toolbar's "Group by" select is built from this list, and what this pins is its
   * *membership* and the label each mode is offered by — three groupings, named once.
   *
   * **Not the order the reader sees**, which is `DeckEditor`'s: it puts this array through
   * `sortOptions` before drawing it, so the sequence here is free to read in whatever order
   * explains the modes. `DeckEditor.test.tsx` is where the picker's own order is pinned.
   */
  it("offers exactly the three groupings the toolbar shows", () => {
    expect(GROUP_BY_OPTIONS.map((o) => o.value)).toEqual(["category", "manaValue", "type"]);
    expect(GROUP_BY_OPTIONS.map((o) => o.label)).toEqual(["Categories", "Mana value", "Type"]);
  });
});

/**
 * `DeckRow.lastGroupBy` is a `string` on the wire, so the editor cannot draw it until this has
 * had a look at it — and what a word neither side recognises must become is the *default*
 * rather than itself. A select holding a value that is in none of its own options is a mode the
 * reader cannot leave.
 */
describe("asGroupBy", () => {
  it("keeps every grouping the toolbar offers", () => {
    for (const option of GROUP_BY_OPTIONS) {
      expect(asGroupBy(option.value)).toBe(option.value);
    }
  });

  /** A row written by a build that offered a fourth mode, a row this build has stopped
   *  offering one for, and the two shapes of nothing a column can hold. */
  it("falls back to the default for a word this build does not offer", () => {
    expect(asGroupBy("colour")).toBe(DEFAULT_GROUP_BY);
    expect(asGroupBy("")).toBe(DEFAULT_GROUP_BY);
    // Case is not a spelling this module accepts: the stored word is the union's own.
    expect(asGroupBy("Category")).toBe(DEFAULT_GROUP_BY);
    expect(DEFAULT_GROUP_BY).toBe("category");
  });

  /** The membership test is derived from {@link GROUP_BY_OPTIONS}, so the two cannot disagree
   *  — a fourth grouping appended there is accepted here without a second edit. */
  it("accepts exactly what the toolbar offers and nothing else", () => {
    const offered = GROUP_BY_OPTIONS.map((o) => o.value as string);
    for (const word of [...offered, "manavalue", "maybe", "sortOrder"]) {
      expect(asGroupBy(word) === word).toBe(offered.includes(word));
    }
  });
});
