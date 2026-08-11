import { describe, expect, it } from "vitest";
import { card } from "./validation/fixtures";
import {
  AUTO_CATEGORIES,
  AUTO_CATEGORY_DISPLAY_ORDER,
  autoCategoryDisplayOrder,
  autoCategoryFor,
  AUTO_CATEGORY_NAMES,
  PREDEFINED_CATEGORY_NAMES,
  UNCATEGORISED,
} from "./autoCategory";

describe("autoCategoryFor", () => {
  /**
   * The whole rule, stated as a table: every bucket is reachable from the plainest type line
   * that means it. A rule nothing exercises end to end is a rule that can lose an arm.
   */
  it("files a card under the first bucket its type line names", () => {
    const answers = AUTO_CATEGORIES.map((bucket) =>
      autoCategoryFor(card({ typeLine: bucket as string })),
    );
    expect(answers).toEqual([...AUTO_CATEGORIES]);
  });

  /**
   * The order in {@link AUTO_CATEGORIES} is the whole of the rule for a card with two types,
   * and these are the three pairs that actually ship in quantity.
   */
  it("resolves a card with two types by the order of the list", () => {
    expect(autoCategoryFor(card({ typeLine: "Artifact Creature — Golem" }))).toBe("Creature");
    expect(autoCategoryFor(card({ typeLine: "Legendary Enchantment Creature — God" }))).toBe(
      "Creature",
    );
    // Dryad Arbor, and every artifact land: a land is a land before it is anything else,
    // which is why `Land` leads the list.
    expect(autoCategoryFor(card({ typeLine: "Land Creature — Forest Dryad" }))).toBe("Land");
    expect(autoCategoryFor(card({ typeLine: "Artifact Land" }))).toBe("Land");
  });

  /**
   * The front face decides. `type_line` carries both halves of a double-faced card separated
   * by `//`, and the back of a modal DFC is routinely a land while its front is a spell — a
   * deck's curve is cast from the front, so reading the whole string would file every MDFC
   * spell under Land.
   */
  it("reads the front face of a double-faced type line", () => {
    expect(autoCategoryFor(card({ typeLine: "Sorcery // Land" }))).toBe("Sorcery");
    expect(autoCategoryFor(card({ typeLine: "Creature — Human // Land" }))).toBe("Creature");
  });

  /**
   * The type line and nothing else: a card whose text, cost, colours and rarity all say
   * "removal spell" is filed by the two words printed under its art.
   */
  it("reads nothing but the type line", () => {
    expect(
      autoCategoryFor(
        card({
          typeLine: "Instant",
          name: "Path to Exile",
          oracleText: "Exile target creature.",
          manaCost: "{W}",
          rarity: "uncommon",
        }),
      ),
    ).toBe("Instant");
  });

  /**
   * An orphan — a row whose printing has left `cards` — has no type line at all, and the one
   * thing it must never answer is `""`: the backend's find-or-create matches on
   * `(deck_id, name)`, and a blank name is a category nobody can see, name or switch back on.
   */
  it("answers Uncategorised for a row with no type line", () => {
    expect(autoCategoryFor(card({ typeLine: null }))).toBe(UNCATEGORISED);
    expect(autoCategoryFor(card({ typeLine: "" }))).toBe(UNCATEGORISED);
    expect(autoCategoryFor(card({ typeLine: "Dungeon" }))).toBe(UNCATEGORISED);
  });

  /**
   * The trap this module is fenced against.
   *
   * `schema::DECK_CATEGORY_GRAIN` is `(deck_id, name)` and **ignores kind**, so the add
   * path's find-or-create resolves a name to whichever category already carries it. If this
   * rule ever answered `"Sideboard"` or `"Maybeboard"`, a plain add would file the card into
   * a pile the reader did not choose — and in the Maybeboard's case an *inactive* one, which
   * is a card gone from every number in the app without having left the deck.
   *
   * A sweep rather than a review note, for `layers.test.ts`' reason: the failure is silent
   * everywhere it would happen.
   */
  it("never answers with the name of a predefined category", () => {
    const collisions = AUTO_CATEGORY_NAMES.filter((name) =>
      PREDEFINED_CATEGORY_NAMES.includes(name),
    );
    expect(collisions).toEqual([]);
  });

  /** The mirror is only worth having if it is the real list. */
  it("mirrors the four names the backend seeds", () => {
    expect([...PREDEFINED_CATEGORY_NAMES]).toEqual([
      "Commander",
      "Sideboard",
      "Companion",
      "Maybeboard",
    ]);
  });
});

describe("the matching order and the reading order", () => {
  /**
   * The two lists are the same eight words and differ **only** about Land, and both answers
   * are deliberate. Written as a test rather than left to a comment because the obvious
   * tidy-up — folding them back into one constant — passes type-checking and breaks whichever
   * job loses.
   */
  it("holds the same eight buckets, and differs only about where Land goes", () => {
    expect([...AUTO_CATEGORY_DISPLAY_ORDER].sort()).toEqual([...AUTO_CATEGORIES].sort());
    expect(AUTO_CATEGORIES[0]).toBe("Land");
    expect(AUTO_CATEGORY_DISPLAY_ORDER[AUTO_CATEGORY_DISPLAY_ORDER.length - 1]).toBe("Land");
    // Everything else is in the order it was written in.
    expect(AUTO_CATEGORY_DISPLAY_ORDER.slice(0, -1)).toEqual(
      AUTO_CATEGORIES.filter((bucket) => bucket !== "Land"),
    );
  });

  /**
   * **Dryad Arbor is why the matching order checks Land first.** Its type line is
   * `Land Creature — Forest Dryad`; a list that checked `Creature` first would file it in the
   * creature column, where no decklist has ever put it, and every artifact land is the same
   * card.
   *
   * And it is filed under a heading that is drawn **last**, which is the other half: the
   * lands are where a decklist stops counting.
   */
  it("files Dryad Arbor as a land, and draws lands last", () => {
    expect(autoCategoryFor(card({ typeLine: "Land Creature — Forest Dryad" }))).toBe("Land");
    expect(autoCategoryDisplayOrder("Land")).toBeGreaterThan(autoCategoryDisplayOrder("Creature"));
    expect(autoCategoryDisplayOrder("Land")).toBe(AUTO_CATEGORIES.length - 1);
  });

  /** An unknown sorts with the unknowns at the foot, not at the head — including the
   *  fallback the orphan gets. */
  it("sorts the fallback and anything it has never heard of after every bucket", () => {
    expect(autoCategoryDisplayOrder(UNCATEGORISED)).toBe(AUTO_CATEGORIES.length);
    expect(autoCategoryDisplayOrder("Dungeon")).toBe(AUTO_CATEGORIES.length);
    expect(autoCategoryDisplayOrder(UNCATEGORISED)).toBeGreaterThan(
      autoCategoryDisplayOrder("Land"),
    );
  });

  /** The reading order is the eight buckets and nothing else — the fallback earns its place
   *  at the foot by being absent from the list, not by being written into the end of it. */
  it("keeps the fallback out of the reading order entirely", () => {
    expect(AUTO_CATEGORY_DISPLAY_ORDER).not.toContain(UNCATEGORISED);
    expect(AUTO_CATEGORY_DISPLAY_ORDER).toHaveLength(AUTO_CATEGORIES.length);
  });
});
