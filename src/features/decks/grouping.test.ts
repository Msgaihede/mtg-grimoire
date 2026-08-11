import { describe, expect, it } from "vitest";
import type { DeckCategory } from "@/lib/ipc";
import { card } from "./validation/fixtures";
import { buildGroups, GROUP_BY_OPTIONS } from "./grouping";

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
    totalPriceUsd: null,
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
        card({ name: "Sol Ring", quantity: 2, unitPriceUsd: 1.5 }),
        card({ name: "Arcane Signet", quantity: 1, unitPriceUsd: 0.99 }),
      ],
      [MAIN],
      "category",
      "alphabetical",
    );

    expect(group.totalPriceUsd).toBeCloseTo(3.99, 5);
  });

  /**
   * A partial total is more useful than none — the surface that shows it says
   * `PRICES_AS_OF` — but a group where *nothing* is priced quotes no number at all, because
   * `$0.00` is a price nobody offered.
   */
  it("skips unpriced cards, and is null when nothing in the group has a price", () => {
    const [partial] = buildGroups(
      [
        card({ name: "Sol Ring", quantity: 1, unitPriceUsd: 1.99 }),
        card({ name: "Orphan", quantity: 3, unitPriceUsd: null }),
      ],
      [MAIN],
      "category",
      "alphabetical",
    );
    expect(partial.totalPriceUsd).toBeCloseTo(1.99, 5);

    const [none] = buildGroups(
      [card({ name: "Orphan", quantity: 3, unitPriceUsd: null })],
      [MAIN],
      "category",
      "alphabetical",
    );
    expect(none.totalPriceUsd).toBeNull();
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
        card({ name: "Sol Ring", cmc: 1, quantity: 2, unitPriceUsd: 1.5 }),
        card({ name: "Mox Pearl", cmc: 0, quantity: 1, unitPriceUsd: null }),
      ],
      [MAIN],
      "manaValue",
      "alphabetical",
    );

    // The 0-drop is its own group; this one is the mana value 1 bucket.
    expect(group.name).toBe("Mana value 0");
    expect(group.count).toBe(1);
    expect(group.totalPriceUsd).toBeNull();
  });

  /** The toolbar's "Group by" select is built from this list. */
  it("offers exactly the three groupings the toolbar shows", () => {
    expect(GROUP_BY_OPTIONS.map((o) => o.value)).toEqual(["category", "manaValue", "type"]);
    expect(GROUP_BY_OPTIONS.map((o) => o.label)).toEqual(["Categories", "Mana value", "Type"]);
  });
});
