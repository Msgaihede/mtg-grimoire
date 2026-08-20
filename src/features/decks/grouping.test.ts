import { describe, expect, it } from "vitest";
import type { DeckCard, DeckCategory } from "@/lib/ipc";
import { card } from "./validation/fixtures";
import {
  asGroupBy,
  buildGroups,
  COMMAND_ZONE_KINDS,
  DEFAULT_EMPTY_GROUP_RULES,
  DEFAULT_GROUP_BY,
  drawsWhenEmpty,
  type EmptyGroupRules,
  GROUP_BY_OPTIONS,
  isCommandZone,
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
    // `user` is the default here because it is the schema's: the four seeded zones are written
    // as `user`, and so is every pile the reader types. `auto` is the narrow case — a pile
    // `category_for_name` invented while filing a card — so it is the one a fixture asks for.
    origin: "user",
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

/**
 * A pile the **app** made while filing a card — `category_for_name`'s find-or-create, reached by
 * every add, drag and imported line that named no category of its own.
 *
 * Structurally identical to {@link own} bar one word, and that is the point of the fixture:
 * nothing about the row tells the two apart except `origin`, so every test pairing them is a
 * test that the rule reads provenance rather than the heading.
 */
const made = (id: number, name: string, sortOrder: number) =>
  category({ id, name, kind: "main", origin: "auto", sortOrder });

/**
 * **The pile this whole design exists for**: a `Ramp` the *reader* typed.
 *
 * "Ramp", "Draw", "Removal" and "Lands" are exactly what a person names their own piles, so
 * hiding empty piles by `AUTO_CATEGORY_NAMES` would misfire on the one case the reader called
 * out as deliberate. `DECK_CATEGORY_GRAIN` is `(deck_id, name)` — one pile per name per deck —
 * so once they have made this, `category_for_name` *finds* it rather than making a second, and
 * it stays `user` however many ramp spells the app later files into it.
 */
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
const EDH: EmptyGroupRules = { requiresCommander: true };

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
    // A pile the app made, holding a card — so it is here to have an identity read at all, and
    // `isAuto` is the field that would silently be `false` on every group if the wiring were
    // dropped. Nothing else in the group distinguishes it from `Main deck`.
    const removal = made(11, "Removal", 2);

    const [commander, main, auto, maybe] = buildGroups(
      [card({ categoryKind: "main" }), inCategory(removal, { name: "Swords to Plowshares" })],
      [COMMANDER, MAIN, removal, MAYBE],
      "category",
      "alphabetical",
      false,
      // A commander-format deck, so the empty command zone is one of the four groups there is
      // an identity to read. Under the default rules it would be three.
      EDH,
    );

    expect(commander).toMatchObject({
      categoryId: 3,
      kind: "commander",
      isActive: true,
      isPredefined: true,
      isAuto: false,
    });
    expect(main).toMatchObject({
      categoryId: 1,
      kind: "main",
      isActive: true,
      isPredefined: false,
      isAuto: false,
    });
    expect(auto).toMatchObject({
      categoryId: 11,
      kind: "main",
      isActive: true,
      isPredefined: false,
      isAuto: true,
    });
    expect(maybe).toMatchObject({
      categoryId: 5,
      kind: "maybe",
      isActive: false,
      isPredefined: true,
      isAuto: false,
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
 * **A pile holding cards always draws; an empty one is a question about who made it.**
 *
 * Three classes, three answers, and every case below is one of them: a predefined zone answers by
 * what the format has, a pile the app made never draws empty, and a pile the reader made always
 * does until they delete it. The whole rule is four lines, which is what makes the failure mode
 * worth testing at this density — every one of these is one flag being read for another's
 * question.
 *
 * **The card's "Move…" select was removed on 2026-08-14**, which is what makes the reader's arm
 * load-bearing rather than cosmetic: that select was built from the deck's `categories` rather
 * than from these groups, so it was the one way to reach an empty pile that drew no heading. A
 * drawn heading is a drop target, so drawing one is now the affordance itself.
 *
 * **A `narrowed` flag used to be the fourth answer here and there are no tests for it any more.**
 * While the toolbar's filter ran, only the predefined zones drew empty. The wall that stopped was
 * always auto piles, and those are out whenever they are empty now, so the filter decides nothing
 * about which headings exist and the editor passes nothing about it.
 */
describe("the categories that draw with nothing in them", () => {
  /**
   * **The reader's arm, and what it costs to get wrong.** A reader who makes a `Ramp` pile and
   * then goes to drag the first card into it finds nothing on screen to drag it *to* — the pile
   * they made a second ago is not drawn, and a hidden category is not a drop target.
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
   *
   * **They reach `drawsWhenEmpty`'s last line rather than a branch of their own now**, exactly as
   * a pile of the reader's does — the schema seeds them `origin: 'user'` — so what this pins is
   * that "always, until it is deleted" really is one answer covering both, and that no arm above
   * that line quietly claims them.
   */
  it.each([
    ["Sideboard", SIDE],
    ["Maybeboard", MAYBE],
  ] as const)("draws an empty %s whatever the format", (name, fixed) => {
    for (const rules of [DEFAULT_EMPTY_GROUP_RULES, EDH]) {
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
    for (const rules of [DEFAULT_EMPTY_GROUP_RULES, EDH]) {
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
   * **The auto arm, which is the whole of what the reader asked for**: *"Ramp should only show
   * once a ramp card is added and Draw once a draw card is added."*
   *
   * A pile the app made while filing a card is a pile nobody asked for, so an empty one is a
   * heading about a card the deck does not contain. Without this a deck accumulates columns
   * faster than it fills them — `autoCategoryFor` can answer with thirteen Oracle-tag buckets and
   * eight type ones — and the wall is worst on the deck with the fewest cards in it.
   */
  it("never draws an empty pile the app made, whatever the format", () => {
    const one = card({ categoryKind: "main" });
    const removal = made(11, "Removal", 2);
    const draw = made(12, "Draw", 6);

    for (const rules of [DEFAULT_EMPTY_GROUP_RULES, EDH]) {
      expect(
        names(buildGroups([one], [MAIN, removal, draw], "category", "alphabetical", false, rules)),
      ).toEqual(["Main deck"]);
    }
  });

  /**
   * **The other half of the same arm: it appears with its first card.** The pile is not
   * suppressed, it is only not kept as a place — so the moment a ramp spell is filed there the
   * heading is a heading like any other, drop target included. A rule that read `isAuto` without
   * the emptiness test in front of it would hide cardboard, which this file forbids everywhere.
   */
  it("draws a pile the app made the moment it holds a card", () => {
    const removal = made(11, "Removal", 2);

    const groups = buildGroups(
      [card({ categoryKind: "main" }), inCategory(removal, { name: "Swords to Plowshares" })],
      [MAIN, removal],
      "category",
      "alphabetical",
    );

    expect(names(groups)).toEqual(["Main deck", "Removal"]);
    expect(names(groups[1].cards)).toEqual(["Swords to Plowshares"]);
  });

  /**
   * **The case this whole design exists for, and the one a name list gets wrong.**
   *
   * Two piles called `Ramp`, empty, both `kind: "main"`, differing in one word — and they get
   * opposite answers. `AUTO_CATEGORY_NAMES` already lists every name `autoCategoryFor` can
   * produce, and hiding empty piles *by that list* was considered and rejected precisely here:
   * "Ramp", "Draw", "Removal" and "Lands" are exactly what a person names their own piles.
   * `DECK_CATEGORY_GRAIN` is `(deck_id, name)`, so once the reader has made theirs,
   * `category_for_name` *finds* it rather than creating one and it keeps `origin: 'user'` for
   * ever — meaning a name rule would take over the pile they were most deliberate about, and
   * start hiding it the day they emptied it.
   */
  it("draws an empty Ramp the reader made and hides an empty Ramp the app made", () => {
    const one = card({ categoryKind: "main" });
    const theirs = RAMP;
    const ours = made(11, "Ramp", 3);

    expect(names(buildGroups([one], [MAIN, theirs], "category", "alphabetical"))).toEqual([
      "Main deck",
      "Ramp",
    ]);
    expect(names(buildGroups([one], [MAIN, ours], "category", "alphabetical"))).toEqual([
      "Main deck",
    ]);

    // Same heading, same kind, same emptiness, opposite answers — so the difference is not
    // anything a view could have read off the group's face.
    expect(theirs.name).toBe(ours.name);
    expect(theirs.kind).toBe(ours.kind);
  });

  /**
   * **A pile of the reader's own called "Sideboard" is theirs, and it draws like theirs.**
   *
   * `DECK_CATEGORY_GRAIN` is `(deck_id, name)` and the seeded Sideboard was never named by the
   * user, so a reader is free to make a second pile with that heading; it is a `main` they can
   * rename and delete. Both draw empty, which is the point — "always, until it is deleted" is one
   * answer for the seeded zone and for theirs — and what this pins is that the two are still two
   * rows and nothing collapsed them by name.
   */
  it("draws both a seeded Sideboard and a pile of the reader's own called Sideboard", () => {
    const mine = own(8, "Sideboard", 6);

    const groups = buildGroups(
      [card({ categoryKind: "main" })],
      [MAIN, SIDE, mine],
      "category",
      "alphabetical",
    );

    expect(names(groups)).toEqual(["Main deck", "Sideboard", "Sideboard"]);
    expect(groups.map((g) => g.categoryId)).toEqual([MAIN.id, SIDE.id, mine.id]);
    // The seeded one is furniture and theirs is not — a distinction `CategoriesDialog` reads for
    // its Rename and Delete affordances, and `drawsWhenEmpty` deliberately does not.
    expect(groups.map((g) => g.isPredefined)).toEqual([false, true, false]);
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
   *  question `drawsWhenEmpty` asks. It is not asked in the other direction either, which is the
   *  second assertion: switching a pile the app made off does not turn it into a place. */
  it("draws the empty Maybeboard and the reader's own empty switched-off pile alike", () => {
    const one = card({ categoryKind: "main" });

    expect(names(buildGroups([one], [MAIN, MAYBE, CUTS], "category", "alphabetical"))).toEqual([
      "Main deck",
      "Maybeboard",
      "Cuts",
    ]);

    // The app's pile, switched off and empty: still out, because the switch says what a pile
    // *counts* toward and says nothing about who wanted it.
    const off = category({
      id: 12,
      name: "Removal",
      origin: "auto",
      isActive: false,
      sortOrder: 6,
    });
    expect(names(buildGroups([one], [MAIN, off], "category", "alphabetical"))).toEqual([
      "Main deck",
    ]);
  });

  /**
   * **The heading stays when the last card leaves — for the pile the reader made.** That is the
   * whole affordance: a pile they have just emptied is where they put the next card, and one that
   * vanished under their hand would take its own drop target with it. The app's pile is the
   * opposite by design: it arrived with a card and leaves with the last one, because nothing was
   * ever reserving that place.
   */
  it("keeps the reader's emptied pile and takes the app's emptied pile away", () => {
    expect(names(buildGroups([inCategory(RAMP)], [RAMP], "category", "alphabetical"))).toEqual([
      "Ramp",
    ]);
    expect(names(buildGroups([], [RAMP], "category", "alphabetical"))).toEqual(["Ramp"]);

    const ours = made(11, "Ramp", 3);
    expect(names(buildGroups([inCategory(ours)], [ours], "category", "alphabetical"))).toEqual([
      "Ramp",
    ]);
    expect(names(buildGroups([], [ours], "category", "alphabetical"))).toEqual([]);
  });

  /**
   * The order of what is drawn is the order it always was — `sortOrder`, then id — with anything
   * left out simply absent rather than the survivors resequenced.
   *
   * Written as a mixture on purpose — all three classes, full and empty — and read twice, once
   * in a format with no command zone and once in a format with one. A rule that rebuilt the list
   * instead of subtracting from it would pass every other test in this block.
   */
  it("leaves the drawn groups in sortOrder, with the undrawn ones simply absent", () => {
    // The app's two piles: `Draw` holds a card and `Tutor` does not.
    const draw = made(9, "Draw", 6);
    const tutor = made(10, "Tutor", 7);
    const deck = [card({ categoryKind: "main" }), inCategory(draw), inCategory(RAMP)];
    const categories = [COMMANDER, MAIN, SIDE, RAMP, MAYBE, draw, tutor, CUTS];

    // Out: the empty command zone (no such zone in this format), the empty `Tutor` (the app's).
    // In: `Cuts`, empty *and* switched off, because the reader made it.
    expect(names(buildGroups(deck, categories, "category", "alphabetical"))).toEqual([
      "Main deck",
      "Sideboard",
      "Ramp",
      "Maybeboard",
      "Cuts",
      "Draw",
    ]);

    // The same deck in a commander format: the command zone comes back at its own sortOrder and
    // nothing else moves.
    expect(names(buildGroups(deck, categories, "category", "alphabetical", false, EDH))).toEqual([
      "Commander",
      "Main deck",
      "Sideboard",
      "Ramp",
      "Maybeboard",
      "Cuts",
      "Draw",
    ]);
  });

  /**
   * The predicate itself, at its one seam — the three classes stated without a `buildGroups` in
   * the way.
   *
   * It is handed a `Pick` of `kind` and `isAuto`, so it *cannot* consult the name — the guarantee
   * the two `Ramp`s above depend on — and it cannot consult `isPredefined` either, which is not
   * an omission: that flag says a row cannot be renamed or deleted, which is the categories
   * panel's question and not a heading's.
   */
  it("answers from the kind, the format and who made the pile, and can read nothing else", () => {
    // The reader's own pile: always, in any format.
    for (const rules of [DEFAULT_EMPTY_GROUP_RULES, EDH]) {
      expect(drawsWhenEmpty({ kind: "main", isAuto: false }, rules)).toBe(true);
      // The app's pile: never, in any format.
      expect(drawsWhenEmpty({ kind: "main", isAuto: true }, rules)).toBe(false);
    }

    // The two unconditional zones reach the same last line the reader's pile does — they are
    // seeded `origin: 'user'`, so `isAuto` is false and there is no arm of their own to get
    // wrong.
    for (const kind of ["side", "maybe"] as const) {
      for (const rules of [DEFAULT_EMPTY_GROUP_RULES, EDH]) {
        expect(drawsWhenEmpty({ kind, isAuto: false }, rules)).toBe(true);
      }
    }

    // The two conditional zones answer before that line is reached, so `isAuto` cannot touch
    // either — structural rather than lucky, and the loop is what says so.
    for (const isAuto of [false, true]) {
      expect(drawsWhenEmpty({ kind: "commander", isAuto }, EDH)).toBe(true);
      expect(drawsWhenEmpty({ kind: "commander", isAuto }, DEFAULT_EMPTY_GROUP_RULES)).toBe(false);
      expect(drawsWhenEmpty({ kind: "companion", isAuto }, EDH)).toBe(false);
      expect(drawsWhenEmpty({ kind: "companion", isAuto }, DEFAULT_EMPTY_GROUP_RULES)).toBe(false);
    }

    // A derived group's `kind` is `null` and it is never asked — but if it were, it is a pile
    // like the reader's own rather than a special case.
    expect(drawsWhenEmpty({ kind: null, isAuto: false }, DEFAULT_EMPTY_GROUP_RULES)).toBe(true);
  });

  /**
   * **What a caller that has not heard of a format gets.** The argument defaults, so every call
   * site written before this rule existed keeps compiling — and what it keeps compiling *to* is
   * the non-commander answer, which is the one a story, a chart or a test asking about something
   * else wants.
   *
   * The `toEqual` is the interesting line: it is what goes red if a second member is ever added
   * back to {@link EmptyGroupRules} without every default being thought about.
   */
  it("answers DEFAULT_EMPTY_GROUP_RULES when it is given no rules at all", () => {
    expect(DEFAULT_EMPTY_GROUP_RULES).toEqual({ requiresCommander: false });

    for (const group of [
      { kind: "main", isAuto: false },
      { kind: "main", isAuto: true },
      { kind: "side", isAuto: false },
      { kind: "commander", isAuto: false },
      { kind: "companion", isAuto: false },
      { kind: "maybe", isAuto: false },
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
  it("appends the empty switched-off piles to a derived grouping, and never an auto one", () => {
    const cards = [card({ name: "Sol Ring", cmc: 1, typeLine: "Artifact" })];
    const categories = [MAIN, RAMP, CUTS, MAYBE];
    // Switched off *and* made by the app *and* empty — three reasons a naive tail might keep it,
    // and `drawsWhenEmpty` runs before `!isActive` ever sees it.
    const off = category({
      id: 12,
      name: "Removal",
      origin: "auto",
      isActive: false,
      sortOrder: 6,
    });

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

      expect(names(buildGroups(cards, [...categories, off], groupBy, "alphabetical"))).toEqual(
        names(padded),
      );
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

    expect(names(groups)).toEqual(["Creature", "Artifact", "Instant", "Land", "Uncategorized"]);
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
    // Nothing *made* a mana-value bucket — it is a heading over the cards that answered to it —
    // and an empty one has never been expressible, so `drawsWhenEmpty` is never asked about it.
    expect(group.isAuto).toBe(false);
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
 * **A commander is not a card in the curve; it is the card the curve was built around.**
 *
 * Two rules with one subject. Under `manaValue` and `type` a command zone's cards are in no
 * bucket and the pile is appended as itself — the second half of the sentence that keeps an
 * *inactive* pile out of the curve, and the same argument underneath it: a derived heading is a
 * heading about the cards the deck is drawn from, and neither of these two is one. And under all
 * three groupings, `category` included, the active command zones come **first**, commander then
 * companion, whatever `sortOrder` the reader has left them in.
 *
 * **Switched off and empty stay the two separate questions this file has always kept apart, and
 * nothing here answers either of them.** A switched-off command zone counts toward nothing, so it
 * is not what the deck is read against and it is not in the head run — it is exactly where it was
 * before the run existed. Whether an *empty* one is drawn at all is `drawsWhenEmpty`'s, swept
 * above and untouched; the head run reorders the piles that are drawn and never decides which
 * those are.
 */
describe("the command zones, which head every grouping", () => {
  /**
   * The two seeded zones as a reader who has dragged their piles about has left them: the
   * Companion above the Commander, and both below `Ramp`.
   *
   * `schema::PREDEFINED_CATEGORIES` seeds them the other way round — Commander, Sideboard,
   * Companion, Maybeboard — so **no fixture above this line can tell "commander first" from
   * "sortOrder first"**: every assertion in this file that shows the Commander at the head shows
   * it at `sortOrder` 0 as well. These two are what make the two answers different, and the piles
   * are reorderable by a drag on the desk and by the Categories dialog, so this is a deck a
   * reader can really have.
   */
  const LATE_COMMANDER = category({ id: 3, name: "Commander", kind: "commander", sortOrder: 8 });
  const EARLY_COMPANION = category({ id: 4, name: "Companion", kind: "companion", sortOrder: 7 });

  /** A Commander pile the reader dragged to the end of the desk and then switched off — the two
   *  facts the head run must both leave alone, on one row. */
  const OFF_COMMANDER = category({
    id: 3,
    name: "Commander",
    kind: "commander",
    isActive: false,
    sortOrder: 8,
  });

  /**
   * **The rule, in the one grouping a commander used to disappear into.** Before this, the
   * commander was bucketed like any other card: `Mana value 4` counted it, and the reader
   * reading that number to decide whether they had too many four-drops was reading one card of
   * the ninety-nine that is never drawn.
   *
   * The pile is appended exactly as `categoryGroup` builds it — id, kind and switch — so it is
   * still a drop target, still renameable and still the thing a right-click on the heading acts
   * on. "Not bucketed" had to mean "drawn somewhere else", never "gone".
   */
  it("keeps a commander out of every derived bucket and heads the list with its pile", () => {
    const cards = [
      inCategory(COMMANDER, {
        name: "Kenrith, the Returned King",
        cmc: 4,
        typeLine: "Legendary Creature — Human Noble",
      }),
      card({ name: "Sol Ring", cmc: 1, typeLine: "Artifact" }),
      card({ name: "Grizzly Bears", cmc: 2, typeLine: "Creature — Bear" }),
    ];

    for (const groupBy of ["manaValue", "type"] as const) {
      const groups = buildGroups(cards, [COMMANDER, MAIN], groupBy, "alphabetical");

      // The pile in front, then the two spells' buckets and nothing else — `Main deck` is
      // active, and a derived grouping's tail is the switched-off piles alone.
      expect(names(groups)).toEqual(
        groupBy === "manaValue"
          ? ["Commander", "Mana value 1", "Mana value 2"]
          : ["Commander", "Creature", "Artifact"],
      );

      expect(groups[0]).toMatchObject({ kind: "commander", categoryId: 3, isActive: true });
      expect(names(groups[0].cards)).toEqual(["Kenrith, the Returned King"]);

      // And the commander is in no bucket at all — not `Mana value 4`, and not `Creature`
      // beside the bears.
      const derived = groups.filter((g) => g.categoryId === null);
      expect(derived.flatMap((g) => names(g.cards)).sort()).toEqual(["Grizzly Bears", "Sol Ring"]);
    }
  });

  /**
   * **The companion is the same rule and the second half of the order.** It is played from
   * outside the deck too (CR 100.4a; EDH's companion is "effectively a 101st card"), so it is
   * bucketed no more than the commander is — and it is read *after* the commander, which the
   * reader asked for explicitly.
   *
   * The fixtures number Companion (7) before Commander (8), so `sortOrder` alone would answer
   * the other way round. That is the whole assertion: the run is ordered by
   * `COMMAND_ZONE_KINDS`, not by the reader's arrangement, and the reader's arrangement is what
   * would otherwise be doing the work.
   */
  it("appends a companion the same way, and reads it after the commander whatever sortOrder says", () => {
    const cards = [
      inCategory(LATE_COMMANDER, {
        name: "Kenrith, the Returned King",
        cmc: 4,
        typeLine: "Legendary Creature — Human Noble",
      }),
      inCategory(EARLY_COMPANION, {
        name: "Lurrus of the Dream-Den",
        cmc: 3,
        typeLine: "Legendary Creature — Cat Nightmare",
      }),
      card({ name: "Sol Ring", cmc: 1, typeLine: "Artifact" }),
    ];

    for (const groupBy of ["manaValue", "type"] as const) {
      const groups = buildGroups(
        cards,
        [MAIN, EARLY_COMPANION, LATE_COMMANDER],
        groupBy,
        "alphabetical",
      );

      expect(names(groups)).toEqual([
        "Commander",
        "Companion",
        groupBy === "manaValue" ? "Mana value 1" : "Artifact",
      ]);
      expect(names(groups[0].cards)).toEqual(["Kenrith, the Returned King"]);
      expect(names(groups[1].cards)).toEqual(["Lurrus of the Dream-Den"]);

      // Neither of them reached a bucket: the deck's one other card is the whole of what did.
      const derived = groups.filter((g) => g.categoryId === null);
      expect(derived.flatMap((g) => names(g.cards))).toEqual(["Sol Ring"]);
    }
  });

  /**
   * **`category` is a grouping too, and the head rule is not a bucketing rule.** Under this mode
   * nothing is derived at all — the piles *are* the headings — so lifting the two zones out of
   * the reader's own order is the only thing that happens, and it is the case a rule written
   * inside the derived arm would have missed entirely.
   */
  it("heads the category grouping too, ahead of the piles sortOrder puts first", () => {
    const groups = buildGroups(
      [
        inCategory(LATE_COMMANDER, { name: "Kenrith, the Returned King" }),
        inCategory(EARLY_COMPANION, { name: "Lurrus of the Dream-Den" }),
        card({ categoryKind: "main" }),
        inCategory(RAMP, { name: "Cultivate" }),
      ],
      [MAIN, RAMP, EARLY_COMPANION, LATE_COMMANDER],
      "category",
      "alphabetical",
    );

    // `sortOrder` is 1, 3, 7, 8, so left alone this reads Main deck, Ramp, Companion, Commander.
    // The two zones come out of that order and go in front in the game's own; everything else
    // keeps the arrangement the reader made, which is the half that must not move.
    expect(names(groups)).toEqual(["Commander", "Companion", "Main deck", "Ramp"]);
  });

  /**
   * **A switched-off command zone is unchanged, and that is a rule rather than an oversight.**
   * `isActive` means the pile counts toward nothing — not size, not copies, not legality, not
   * the allocator — so it is not what the rest of the deck is read *against* either, and there
   * is nothing about it to put at the head.
   *
   * It stays in `sortOrder` under `category` and in the `!isActive` tail under a derived
   * grouping: exactly the two places it was before the head run existed. The fixture is dragged
   * to the end of the desk so that "left alone" and "moved to the front" are different answers.
   */
  it("leaves a switched-off command zone where it was, in both derived modes and under category", () => {
    const cards = [
      inCategory(OFF_COMMANDER, { name: "Kenrith, the Returned King", cmc: 4 }),
      card({ name: "Sol Ring", cmc: 1, typeLine: "Artifact" }),
      inCategory(MAYBE, { name: "Avacyn", cmc: 8, typeLine: "Creature — Angel" }),
    ];
    const categories = [MAIN, MAYBE, OFF_COMMANDER];

    for (const groupBy of ["manaValue", "type"] as const) {
      const groups = buildGroups(cards, categories, groupBy, "alphabetical");

      // The one bucket the deck's one active, non-command card makes, then both switched-off
      // piles as themselves in sortOrder — the Maybeboard (4) before the Commander (8).
      expect(names(groups)).toEqual([
        groupBy === "manaValue" ? "Mana value 1" : "Artifact",
        "Maybeboard",
        "Commander",
      ]);
      expect(groups[2].isActive).toBe(false);
      expect(names(groups[2].cards)).toEqual(["Kenrith, the Returned King"]);
    }

    // And under `category`, where every pile is drawn, it is simply still last.
    expect(names(buildGroups(cards, categories, "category", "alphabetical"))).toEqual([
      "Main deck",
      "Maybeboard",
      "Commander",
    ]);
  });

  /**
   * **The curve is unchanged for everything that is not a commander**, which is the half of this
   * change with no visible symptom and therefore the half most easily broken by a later tidy. A
   * skip written a rung too high — over the whole `cards` loop rather than over the one card —
   * would empty the buckets and every assertion about the head would still pass.
   *
   * Compared by name, copies and money rather than by identity: `card()` hands out a fresh row
   * id per call, so two separately-built fixtures are never deep-equal.
   */
  it("buckets a deck of commander and spells exactly as the same deck without the commander", () => {
    const spells = [
      card({ name: "Sol Ring", cmc: 1, typeLine: "Artifact", quantity: 1, unitPrice: 1.5 }),
      card({ name: "Lightning Bolt", cmc: 1, typeLine: "Instant", quantity: 4, unitPrice: 0.5 }),
      card({ name: "Grizzly Bears", cmc: 2, typeLine: "Creature — Bear" }),
    ];
    const withCommander = [
      inCategory(COMMANDER, {
        name: "Kenrith, the Returned King",
        cmc: 4,
        typeLine: "Legendary Creature — Human Noble",
        unitPrice: 9,
      }),
      ...spells,
    ];

    for (const groupBy of ["manaValue", "type"] as const) {
      const bare = buildGroups(spells, [MAIN], groupBy, "alphabetical");
      const headed = buildGroups(withCommander, [COMMANDER, MAIN], groupBy, "alphabetical");

      // One group longer, and the extra one is the pile in front. Everything behind it — the
      // headings, the cards under them, the copies and the money — is what the deck with no
      // commander in it already answered.
      expect(names(headed)).toEqual(["Commander", ...names(bare)]);
      expect(headed.slice(1).map((g) => names(g.cards))).toEqual(bare.map((g) => names(g.cards)));
      expect(headed.slice(1).map((g) => g.count)).toEqual(bare.map((g) => g.count));
      expect(headed.slice(1).map((g) => g.totalPrice)).toEqual(bare.map((g) => g.totalPrice));
    }
  });

  /**
   * **Two rules in one order, and this is the seam between them.** `drawsWhenEmpty` decides
   * whether an empty command zone is a heading at all — it is, and only where the format has
   * such a zone, because an empty command zone in a Commander deck is itself a fact about the
   * deck's validity — and the head run then puts whatever it kept in front.
   *
   * So an empty Commander heads a `manaValue` grouping, which is the one shape of this feature
   * that looks like a defect and is not: a heading over no cards, above the curve. In a format
   * with no command zone there was never a heading to move.
   */
  it("heads a derived grouping with an empty command zone only where the format has one", () => {
    const cards = [card({ name: "Sol Ring", cmc: 1, typeLine: "Artifact" })];

    expect(
      names(buildGroups(cards, [MAIN, COMMANDER], "manaValue", "alphabetical", false, EDH)),
    ).toEqual(["Commander", "Mana value 1"]);

    expect(
      names(
        buildGroups(
          cards,
          [MAIN, COMMANDER],
          "manaValue",
          "alphabetical",
          false,
          DEFAULT_EMPTY_GROUP_RULES,
        ),
      ),
    ).toEqual(["Mana value 1"]);
  });

  /**
   * The order, checked as a *list* rather than through a deck — the one place it is.
   *
   * `COMMAND_ZONE_KINDS` is what `isCommandZone` and the head run's comparator both read, so its
   * order **is** commander-before-companion and a reversal here is the whole feature reversed.
   * Everything else in this block would report that as two piles the wrong way round in one
   * assertion, which reads as a fixture problem; this says what it is.
   */
  it("names the two zones once, commander first, and calls nothing else one", () => {
    expect(COMMAND_ZONE_KINDS).toEqual(["commander", "companion"]);
    expect(COMMAND_ZONE_KINDS.every((kind) => isCommandZone(kind))).toBe(true);

    // Every other kind is a pile like any other, and a derived group's `null` kind is not a zone
    // anything is played from.
    expect((["main", "side", "maybe"] as const).some((kind) => isCommandZone(kind))).toBe(false);
    expect(isCommandZone(null)).toBe(false);
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
      isAuto: false,
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
