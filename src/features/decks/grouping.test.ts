import { describe, expect, it } from "vitest";
import type { DeckCard, DeckCategory } from "@/lib/ipc";
import { card } from "./validation/fixtures";
import {
  asGroupBy,
  buildGroups,
  DEFAULT_EMPTY_GROUP_RULES,
  DEFAULT_GROUP_BY,
  drawsWhenEmpty,
  type EmptyGroupRules,
  GROUP_BY_OPTIONS,
  X_GROUP_KEY,
  X_GROUP_NAME,
} from "./grouping";

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
const COMPANION = category({ id: 4, name: "Companion", kind: "companion", sortOrder: 3 });
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

/**
 * A pile of the reader's own, in the shape the categories panel makes one: **`kind: "main"`**,
 * whatever it is called. That is what makes a category named "Sideboard" here a genuinely
 * different row from {@link SIDE}, which is the seeded zone.
 */
const own = (id: number, name: string, sortOrder: number) =>
  category({ id, name, kind: "main", sortOrder });

const RAMP = own(7, "Ramp", 3);

/** A card filed into a particular category, rather than into the default pile for its kind —
 *  `card()` files by kind alone, and every pile the reader makes is a `main`. */
function inCategory(target: DeckCategory, over: Partial<DeckCard> = {}): DeckCard {
  return {
    ...card(over),
    categoryId: target.id,
    categoryName: target.name,
    categoryKind: target.kind,
    categoryActive: target.isActive,
  };
}

const names = (groups: readonly { name: string }[]) => groups.map((g) => g.name);

/** A deck whose format has a command zone — Commander, Brawl, Oathbreaker and the rest of the
 *  seed's `requires_commander` rows. */
const EDH: EmptyGroupRules = { requiresCommander: true, narrowed: false };
/** The toolbar's text field or a tag chip is on, so these groups were built from a slice of the
 *  deck rather than from the deck. */
const NARROWED: EmptyGroupRules = { requiresCommander: false, narrowed: true };
/** Both at once — the case that proves the two rules are answered separately rather than one
 *  standing in for the other. */
const NARROWED_EDH: EmptyGroupRules = { requiresCommander: true, narrowed: true };

describe("buildGroups by category", () => {
  it("draws every category in sort order, the empty ones included", () => {
    const groups = buildGroups(
      [card({ categoryKind: "main" })],
      [COMMANDER, MAIN, SIDE, RAMP],
      "category",
      "alphabetical",
    );

    // Three of these four hold nothing and two of them draw anyway: an empty Sideboard is where
    // the next sideboard card goes, and an empty `Ramp` is where the next ramp spell goes. The
    // command zone is the one that is out, because the default rules describe a deck whose
    // format has no such zone — `drawsWhenEmpty`, swept below.
    expect(names(groups)).toEqual(["Main deck", "Sideboard", "Ramp"]);
    expect(groups.map((g) => g.cards.length)).toEqual([1, 0, 0]);
  });

  it("carries the category's own identity onto the group", () => {
    const [commander, main, maybe] = buildGroups(
      [card({ categoryKind: "main" })],
      [COMMANDER, MAIN, MAYBE],
      "category",
      "alphabetical",
      false,
      // A commander-format deck, so the empty command zone is one of the three groups there is
      // an identity to read. Under the default rules it would be two.
      EDH,
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
        // A card in `Main deck` as well, so this stays a test about *where the stray goes*:
        // the assertion below is about order, and a real pile in front of the stray is what
        // makes "after the real ones" something the list can show.
        card({ name: "Bolt", categoryKind: "main" }),
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

/**
 * **A pile holding cards always draws; an empty one is a question about the deck.**
 *
 * The rule this file used to state the other way round: a pile the reader made and emptied was
 * hidden, and the four seeded zones were the exception that drew anyway. A column is a *place*
 * as well as a heading, so the reversal is that every empty pile of the reader's own draws — and
 * the argument the old rule was made of (a category is a card's *function* now, so a deck
 * accumulates a dozen of them) survives exactly where it was really true: while a filter is
 * narrowing the deck, where an empty pile is the filter's doing rather than the deck's.
 *
 * Two of the fixed zones went the other way and are conditional now. Every case below is about
 * one flag being read for another's question — which is the mistake this rule is one bad line
 * away from at all times, and there are four flags in it rather than two.
 */
describe("the categories that draw with nothing in them", () => {
  /**
   * **The reversal, and what it costs to get wrong.** A reader who makes a `Ramp` pile and then
   * goes to drag the first card into it finds nothing on screen to drag it *to* — the pile they
   * made a second ago is not drawn, and a hidden category is not a drop target.
   */
  it("draws a category of the reader's own that holds nothing", () => {
    const groups = buildGroups(
      [card({ categoryKind: "main" })],
      [MAIN, RAMP],
      "category",
      "alphabetical",
    );

    expect(names(groups)).toEqual(["Main deck", "Ramp"]);
    expect(groups[1].cards).toEqual([]);
  });

  /**
   * The two unconditional fixed zones, swept rather than restated.
   *
   * A reader can neither rename nor delete these, and both are places the next card goes: an
   * empty Sideboard is where the next sideboard card lands, an empty Maybeboard where the next
   * cut does. A rail that appeared with the first card would move the layout under the reader's
   * hand, which is `views/columns.ts`' half of the same argument.
   */
  it.each([
    ["Sideboard", SIDE],
    ["Maybeboard", MAYBE],
  ] as const)("draws an empty %s whatever the format", (name, fixed) => {
    for (const rules of [DEFAULT_EMPTY_GROUP_RULES, EDH, NARROWED, NARROWED_EDH]) {
      const groups = buildGroups(
        [card({ categoryKind: "main" })],
        [MAIN, fixed],
        "category",
        "alphabetical",
        false,
        rules,
      );

      expect(names(groups)).toContain(name);
      expect(groups.find((g) => g.name === name)?.cards).toEqual([]);
    }
  });

  /**
   * **An empty command zone is a fact about a Commander deck and is not a fact about a Standard
   * one.** Drawn where the format has the zone, because the editor must never answer a validity
   * question by omission; left out where the game being built for has no such zone at all, where
   * it is a heading over a rule nobody is playing by.
   */
  it("draws an empty Commander zone only where the format has one", () => {
    const one = card({ categoryKind: "main" });

    expect(
      names(buildGroups([one], [COMMANDER, MAIN], "category", "alphabetical", false, EDH)),
    ).toEqual(["Commander", "Main deck"]);

    expect(
      names(
        buildGroups(
          [one],
          [COMMANDER, MAIN],
          "category",
          "alphabetical",
          false,
          DEFAULT_EMPTY_GROUP_RULES,
        ),
      ),
    ).toEqual(["Main deck"]);
  });

  /**
   * **The editor never hides cardboard.** A reader who built a Commander deck and then
   * re-formatted it to Modern still has a card in the command zone, and a rule reading only the
   * format would take ten copies off the screen with nothing on it to say where they went. The
   * emptiness test runs in front of `drawsWhenEmpty`, so this cannot be got wrong by editing
   * that predicate alone.
   */
  it("draws a Commander pile that holds cards even where the format has no command zone", () => {
    const groups = buildGroups(
      [inCategory(COMMANDER, { name: "Kenrith, the Returned King" })],
      [COMMANDER, MAIN],
      "category",
      "alphabetical",
      false,
      DEFAULT_EMPTY_GROUP_RULES,
    );

    expect(names(groups)).toEqual(["Commander", "Main deck"]);
    expect(names(groups[0].cards)).toEqual(["Kenrith, the Returned King"]);
  });

  /**
   * **A companion is a card you either have or do not.** Every format in the seed bar Gladiator
   * allows one, so a rule keyed on the format would draw the heading in almost every deck ever
   * built — and an empty Companion pile says nothing that its absence does not say more quietly.
   * The moment a card is in it, it is a pile like any other.
   */
  it("never draws an empty Companion, and draws one holding a card", () => {
    for (const rules of [DEFAULT_EMPTY_GROUP_RULES, EDH, NARROWED, NARROWED_EDH]) {
      expect(names(buildGroups([], [COMPANION], "category", "alphabetical", false, rules))).toEqual(
        [],
      );

      expect(
        names(
          buildGroups(
            [inCategory(COMPANION, { name: "Lurrus of the Dream-Den" })],
            [COMPANION],
            "category",
            "alphabetical",
            false,
            rules,
          ),
        ),
      ).toEqual(["Companion"]);
    }
  });

  /**
   * **While a filter is on, an empty pile is the filter's doing rather than the deck's.**
   * Without this, typing three letters answers with twenty headings over three cards — which is
   * the wall the old rule existed to stop, kept for the one case it was really about. The fixed
   * zones outlive the filter because they are the deck's furniture rather than its contents; the
   * two conditional zones keep their own answers, which is what says the narrowing did not
   * quietly become the whole rule again.
   */
  it("hides the reader's own empty piles under a filter and keeps the fixed zones", () => {
    const one = card({ categoryKind: "main" });

    expect(
      names(
        buildGroups(
          [one],
          [COMMANDER, MAIN, SIDE, COMPANION, RAMP, MAYBE],
          "category",
          "alphabetical",
          false,
          NARROWED,
        ),
      ),
    ).toEqual(["Main deck", "Sideboard", "Maybeboard"]);

    // The same deck under a filter in a commander format: the command zone is back and nothing
    // else moved.
    expect(
      names(
        buildGroups(
          [one],
          [COMMANDER, MAIN, SIDE, COMPANION, RAMP, MAYBE],
          "category",
          "alphabetical",
          false,
          NARROWED_EDH,
        ),
      ),
    ).toEqual(["Commander", "Main deck", "Sideboard", "Maybeboard"]);
  });

  /**
   * **The test that proves the rule reads the kind and the flag, never the heading.**
   *
   * `DECK_CATEGORY_GRAIN` is `(deck_id, name)` and the seeded Sideboard was never named by the
   * user, so a reader is free to make a pile of their own and call it "Sideboard". That one is
   * theirs — theirs to rename, theirs to delete, and theirs to be narrowed away by a filter like
   * any other pile of theirs. A rule matching on the name would keep it on screen through every
   * search the reader ever ran.
   */
  it("narrows away a pile of the reader's own called Sideboard, which the seeded one is not", () => {
    const mine = own(8, "Sideboard", 6);

    expect(
      names(
        buildGroups(
          [card({ categoryKind: "main" })],
          [MAIN, SIDE, mine],
          "category",
          "alphabetical",
          false,
          NARROWED,
        ),
      ),
    ).toEqual(["Main deck", "Sideboard"]);
    // The one that survived is the seeded row, not the reader's — same heading, different pile.
    expect(
      buildGroups(
        [card({ categoryKind: "main" })],
        [MAIN, SIDE, mine],
        "category",
        "alphabetical",
        false,
        NARROWED,
      ).map((g) => g.categoryId),
    ).toEqual([MAIN.id, SIDE.id]);

    // And it is a place like any other the moment something is in it — this is about the cards,
    // never about which row it is.
    expect(
      names(
        buildGroups(
          [inCategory(mine, { name: "Bolt" })],
          [mine],
          "category",
          "alphabetical",
          false,
          NARROWED,
        ),
      ),
    ).toEqual(["Sideboard"]);
  });

  /**
   * **Switched off and empty are different questions**, and this is the pair that says so.
   *
   * `is_active = 0` means "counts toward nothing" — not size, not copies, not legality, and the
   * allocator claims no copy for it. It says nothing whatever about how many cards are in the
   * pile, and a reader who switched a ten-card pile off must still see those ten cards; that is
   * how they switch it back on.
   */
  it("keeps a switched-off category that holds cards", () => {
    const groups = buildGroups(
      [card({ categoryKind: "main" }), inCategory(CUTS, { name: "Ghalta" })],
      [MAIN, CUTS],
      "category",
      "alphabetical",
    );

    expect(names(groups)).toEqual(["Main deck", "Cuts"]);
    expect(groups[1]).toMatchObject({ isActive: false, isPredefined: false });
    expect(names(groups[1].cards)).toEqual(["Ghalta"]);
  });

  /** The other half of the same pair: the seeded Maybeboard is off *and* empty and it draws, and
   *  so does a pile of the reader's own in exactly the same two states — `isActive` is not a
   *  question `drawsWhenEmpty` asks. Under a filter they part company, and *that* is the flag
   *  telling them apart rather than the switch. */
  it("draws the empty Maybeboard and the reader's own empty switched-off pile alike", () => {
    const one = card({ categoryKind: "main" });

    expect(names(buildGroups([one], [MAIN, MAYBE, CUTS], "category", "alphabetical"))).toEqual([
      "Main deck",
      "Maybeboard",
      "Cuts",
    ]);
    expect(
      names(buildGroups([one], [MAIN, MAYBE, CUTS], "category", "alphabetical", false, NARROWED)),
    ).toEqual(["Main deck", "Maybeboard"]);
  });

  /**
   * The heading stays when the last card leaves, which is the whole affordance: a pile the
   * reader has just emptied is where they put the next card, and one that vanished under their
   * hand would take its own drop target with it. Under a filter the same pair reads the other
   * way, because there the emptiness is the filter's.
   */
  it("keeps a category when its last card leaves, and drops it only under a filter", () => {
    expect(names(buildGroups([inCategory(RAMP)], [RAMP], "category", "alphabetical"))).toEqual([
      "Ramp",
    ]);
    expect(names(buildGroups([], [RAMP], "category", "alphabetical"))).toEqual(["Ramp"]);
    expect(names(buildGroups([], [RAMP], "category", "alphabetical", false, NARROWED))).toEqual([]);
  });

  /**
   * The order of what is drawn is the order it always was — `sortOrder`, then id — with anything
   * left out simply absent rather than the survivors resequenced.
   *
   * Written as a mixture on purpose, and read twice: unfiltered, where only the two conditional
   * zones are missing; and narrowed, where the reader's own empty piles go and the fixed ones
   * stay. A filter that rebuilt the list instead of narrowing it would pass every other test in
   * this block.
   */
  it("leaves the drawn groups in sortOrder, with the undrawn ones simply absent", () => {
    const draw = own(9, "Draw", 6);
    const deck = [card({ categoryKind: "main" }), inCategory(draw), inCategory(RAMP)];
    const categories = [COMMANDER, MAIN, SIDE, RAMP, MAYBE, draw, own(10, "Tutor", 7), CUTS];

    expect(names(buildGroups(deck, categories, "category", "alphabetical"))).toEqual([
      "Main deck",
      "Sideboard",
      "Ramp",
      "Maybeboard",
      "Cuts",
      "Draw",
      "Tutor",
    ]);

    expect(
      names(buildGroups(deck, categories, "category", "alphabetical", false, NARROWED_EDH)),
    ).toEqual(["Commander", "Main deck", "Sideboard", "Ramp", "Maybeboard", "Draw"]);
  });

  /**
   * The predicate itself, at its one seam. It is handed a `Pick` of the group and therefore
   * *cannot* consult the name — the guarantee the "Sideboard" case above depends on — and the
   * four answers below are the whole of it, stated without a `buildGroups` in the way.
   */
  it("answers from the kind, the format and the filter, and never from the name", () => {
    // The reader's own pile: drawn, unless a filter is what emptied it.
    expect(drawsWhenEmpty({ kind: "main", isPredefined: false }, DEFAULT_EMPTY_GROUP_RULES)).toBe(
      true,
    );
    expect(drawsWhenEmpty({ kind: "main", isPredefined: false }, NARROWED)).toBe(false);

    // The two unconditional zones, either way.
    for (const kind of ["side", "maybe"] as const) {
      for (const rules of [DEFAULT_EMPTY_GROUP_RULES, EDH, NARROWED, NARROWED_EDH]) {
        expect(drawsWhenEmpty({ kind, isPredefined: true }, rules)).toBe(true);
      }
    }

    // The command zone follows the format and nothing else — a filter does not take it away.
    expect(drawsWhenEmpty({ kind: "commander", isPredefined: true }, EDH)).toBe(true);
    expect(drawsWhenEmpty({ kind: "commander", isPredefined: true }, NARROWED_EDH)).toBe(true);
    expect(
      drawsWhenEmpty({ kind: "commander", isPredefined: true }, DEFAULT_EMPTY_GROUP_RULES),
    ).toBe(false);
    expect(drawsWhenEmpty({ kind: "commander", isPredefined: true }, NARROWED)).toBe(false);

    // The companion never, under any of the four.
    for (const rules of [DEFAULT_EMPTY_GROUP_RULES, EDH, NARROWED, NARROWED_EDH]) {
      expect(drawsWhenEmpty({ kind: "companion", isPredefined: true }, rules)).toBe(false);
    }

    // A derived group's `kind` is `null` and it is never asked — but if it were, it is a pile
    // like the reader's own rather than a special case.
    expect(drawsWhenEmpty({ kind: null, isPredefined: false }, DEFAULT_EMPTY_GROUP_RULES)).toBe(
      true,
    );
  });

  /**
   * **What a caller that has not heard of a format gets.** The argument defaults, so every call
   * site written before this rule existed keeps compiling — and what it keeps compiling *to* is
   * the unfiltered non-commander answer, which is the one a story, a chart or a test asking
   * about something else wants.
   */
  it("answers DEFAULT_EMPTY_GROUP_RULES when it is given no rules at all", () => {
    expect(DEFAULT_EMPTY_GROUP_RULES).toEqual({ requiresCommander: false, narrowed: false });

    for (const group of [
      { kind: "main", isPredefined: false },
      { kind: "side", isPredefined: true },
      { kind: "commander", isPredefined: true },
      { kind: "companion", isPredefined: true },
      { kind: "maybe", isPredefined: true },
    ] as const) {
      expect(drawsWhenEmpty(group)).toBe(drawsWhenEmpty(group, DEFAULT_EMPTY_GROUP_RULES));
    }

    // The same for the whole function: no sixth argument is the default rules, not "draw
    // everything" and not the old rule.
    expect(names(buildGroups([], [MAIN, RAMP, COMMANDER], "category", "alphabetical"))).toEqual(
      names(
        buildGroups(
          [],
          [MAIN, RAMP, COMMANDER],
          "category",
          "alphabetical",
          false,
          DEFAULT_EMPTY_GROUP_RULES,
        ),
      ),
    );
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
   * **The derived halves were already right and are untouched.** A `manaValue` or `type` bucket
   * is built out of the cards, so an empty one has never been expressible — which is why the
   * empty-pile rule is a rule about *category* groups alone.
   *
   * What reaches a derived grouping is the tail: the **switched-off** piles, appended as
   * themselves. They go through the same filter, so an empty `Cuts` joins the empty Maybeboard
   * there — while `Ramp`, empty but switched **on**, is in no derived grouping at all, because
   * the tail is `!isActive` and not "everything that draws".
   */
  it("appends the empty switched-off piles to a derived grouping, and drops the reader's own under a filter", () => {
    const cards = [card({ name: "Sol Ring", cmc: 1, typeLine: "Artifact" })];
    const categories = [MAIN, RAMP, CUTS, MAYBE];

    for (const groupBy of ["manaValue", "type"] as const) {
      const bare = buildGroups(cards, [MAIN], groupBy, "alphabetical");
      const padded = buildGroups(cards, categories, groupBy, "alphabetical");

      // The one bucket the card makes, then the two switched-off piles in sortOrder — and never
      // `Ramp`, which is switched on and therefore not part of the tail at all.
      expect(names(padded)).toEqual([...names(bare), "Maybeboard", "Cuts"]);
      expect(padded.filter((g) => g.categoryId !== null).map((g) => g.categoryId)).toEqual([
        MAYBE.id,
        CUTS.id,
      ]);

      // Under a filter the reader's own empty pile goes here for the same reason it goes under
      // `category`: the emptiness is the filter's doing, and the fixed zone outlives it.
      const narrowed = buildGroups(cards, categories, groupBy, "alphabetical", false, NARROWED);
      expect(names(narrowed)).toEqual([...names(bare), "Maybeboard"]);
    }
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
 * The deck's own `separateXGroup` preference, applied.
 *
 * A spell printing `{X}` has a mana value — Scryfall counts the variable as 0, so Fireball is
 * mana value 1 — and that number is honest about a card nobody casts for one mana. The switch
 * is the reader's answer to whether their curve should say so.
 *
 * **Every card here is one array built once and handed to both calls**, which is what lets the
 * off case be compared against the on case at all: `card()` hands out a fresh row id per call,
 * so two separately-built fixtures are never deep-equal. `buildGroups` mutates nothing it is
 * given — `sortCards` copies — so one array can serve both.
 */
describe("buildGroups with the X pile split out", () => {
  /** Fireball's real cost and mana value, so the fixture is about the thing it is about. */
  const fireball = (over: Partial<DeckCard> = {}) =>
    card({ name: "Fireball", manaCost: "{X}{R}", cmc: 1, ...over });

  /**
   * **Off is the default and off is exactly what this function answered before the switch
   * existed.** Every caller that has not heard of `separateX` — and every test above this
   * line — keeps the grouping it had, which is the whole reason the parameter is last and
   * optional.
   */
  it("groups identically with the switch off and with it omitted", () => {
    const cards = [
      fireball(),
      card({ name: "Lightning Bolt", manaCost: "{R}", cmc: 1 }),
      card({ name: "Orphan", manaCost: null, cmc: null }),
    ];

    expect(buildGroups(cards, [MAIN], "manaValue", "alphabetical", false)).toEqual(
      buildGroups(cards, [MAIN], "manaValue", "alphabetical"),
    );
    // And the X card is bucketed by its mana value like anything else: Fireball is a 1-drop.
    const groups = buildGroups(cards, [MAIN], "manaValue", "alphabetical");
    expect(groups.map((g) => g.key)).toEqual(["mv-1", "mv-unknown"]);
    expect(names(groups[0].cards)).toEqual(["Fireball", "Lightning Bolt"]);
  });

  /**
   * **The card leaves its bucket rather than appearing in two.** Every surface that draws these
   * headings counts copies and sums prices per group, so a card in both piles makes the
   * headings add up to more than the deck — and nothing on screen would say which one lied.
   * The two assertions at the foot are that arithmetic, stated as arithmetic.
   */
  it("moves an {X} card's copies and money out of its mana-value bucket", () => {
    const cards = [
      fireball({ quantity: 2, unitPrice: 1.5 }),
      card({ name: "Lightning Bolt", manaCost: "{R}", cmc: 1, quantity: 3, unitPrice: 0.5 }),
    ];

    const [before] = buildGroups(cards, [MAIN], "manaValue", "alphabetical");
    expect(before.count).toBe(5);
    expect(before.totalPrice).toBeCloseTo(4.5, 5);

    const after = buildGroups(cards, [MAIN], "manaValue", "alphabetical", true);
    expect(after.map((g) => g.key)).toEqual(["mv-1", X_GROUP_KEY]);
    const [one, x] = after;

    expect(names(one.cards)).toEqual(["Lightning Bolt"]);
    expect(one.count).toBe(3);
    expect(one.totalPrice).toBeCloseTo(1.5, 5);

    expect(names(x.cards)).toEqual(["Fireball"]);
    expect(x.count).toBe(2);
    expect(x.totalPrice).toBeCloseTo(3, 5);

    expect(one.count + x.count).toBe(before.count);
    expect((one.totalPrice ?? 0) + (x.totalPrice ?? 0)).toBeCloseTo(before.totalPrice ?? 0, 5);
  });

  /** A heading and nothing more, like every other mana-value group: no id, so nothing can be
   *  dropped into it — `cardControl.tsx`'s `deckGroupProps` and `useCategoryDrop` both gate on
   *  `categoryId === null`, and an id here would quietly make the curve a drop target. */
  it("names a derived group nothing can be dropped into", () => {
    const [x] = buildGroups([fireball()], [MAIN], "manaValue", "alphabetical", true);

    expect(x).toMatchObject({
      key: X_GROUP_KEY,
      name: X_GROUP_NAME,
      categoryId: null,
      kind: null,
      isActive: true,
      isPredefined: false,
    });
  });

  /**
   * `0 … 8 or more, X, unknown`. Like "8 or more", X is open-ended rather than a number, so it
   * belongs at the tail of the curve rather than at the head where a reader counts their
   * cheapest spells — and *unknown* stays behind it, because it is the absence of an answer
   * rather than an answer.
   */
  it("reads 0 through 8, then X, then unknown", () => {
    const curve = [
      ...Array.from({ length: 9 }, (_, mv) =>
        card({ name: `Spell ${mv}`, manaCost: `{${mv}}`, cmc: mv }),
      ),
      fireball(),
      card({ name: "Orphan", manaCost: null, cmc: null }),
    ];

    const groups = buildGroups(curve, [MAIN], "manaValue", "alphabetical", true);

    expect(groups.map((g) => g.key)).toEqual([
      "mv-0",
      "mv-1",
      "mv-2",
      "mv-3",
      "mv-4",
      "mv-5",
      "mv-6",
      "mv-7",
      "mv-8",
      X_GROUP_KEY,
      "mv-unknown",
    ]);
    expect(names(groups[9].cards)).toEqual(["Fireball"]);
  });

  /**
   * **An X in the printed cost is knowledge; "unknown" is for a row that carries none.** So the
   * X test runs before the `cmc` check: an orphaned row whose card left the database keeps the
   * cost `deck_cards` copied at write time, and filing it under "Mana value unknown" would
   * throw away the one thing it still says about itself.
   */
  it("files an {X} card with no mana value under X rather than unknown", () => {
    const groups = buildGroups(
      [card({ name: "Orphaned X", manaCost: "{X}{B}{B}{B}", cmc: null })],
      [MAIN],
      "manaValue",
      "alphabetical",
      true,
    );

    expect(groups.map((g) => g.key)).toEqual([X_GROUP_KEY]);
    expect(names(groups[0].cards)).toEqual(["Orphaned X"]);
  });

  /**
   * **It is a `manaValue` rule and inert everywhere else.** Under `category` the headings are
   * the reader's own piles and under `type` they are what a card *is*; neither is a curve, and
   * an "X" column beside Creature would be a fourth grouping wearing the third one's name.
   */
  it("changes nothing under the other two groupings", () => {
    const cards = [
      fireball({ typeLine: "Sorcery" }),
      card({ name: "Sol Ring", manaCost: "{1}", cmc: 1, typeLine: "Artifact" }),
    ];

    for (const groupBy of ["category", "type"] as const) {
      expect(buildGroups(cards, [MAIN], groupBy, "alphabetical", true)).toEqual(
        buildGroups(cards, [MAIN], groupBy, "alphabetical", false),
      );
    }
  });

  /**
   * The file's governing rule, unchanged by the switch: an inactive pile is never bucketed
   * into somebody else's curve and never hidden either — including when the card in it is an
   * X spell, which must not turn up in an X heading it was switched out of.
   */
  it("appends an inactive category whole in both X modes", () => {
    const cards = [
      fireball(),
      {
        ...card({ name: "Comet Storm", manaCost: "{X}{R}", cmc: 2 }),
        categoryId: 5,
        categoryName: "Maybeboard",
        categoryKind: "maybe" as const,
        categoryActive: false,
      },
    ];

    for (const separateX of [false, true]) {
      const groups = buildGroups(cards, [MAIN, MAYBE], "manaValue", "alphabetical", separateX);

      const inactive = groups.filter((g) => !g.isActive);
      expect(names(inactive)).toEqual(["Maybeboard"]);
      expect(names(inactive[0].cards)).toEqual(["Comet Storm"]);

      const derived = groups.filter((g) => g.categoryId === null);
      expect(derived.flatMap((g) => names(g.cards))).toEqual(["Fireball"]);
    }
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
