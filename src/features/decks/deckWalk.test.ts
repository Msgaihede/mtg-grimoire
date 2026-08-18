import { beforeEach, describe, expect, it } from "vitest";
import type { DeckCard } from "@/lib/ipc";
import type { PaneDeckContext } from "@/lib/store";
import { card, resetRowIds } from "./validation/fixtures";
import type { CardGroup } from "./grouping";
import { deckWalkStops, sameDeckSlot, type DeckWalkStop } from "./deckWalk";

beforeEach(resetRowIds);

/**
 * One drawn group. Only three of its ten fields are read here — `kind` and `isActive`, which are
 * the two words `splitRail` tests, and `cards` — so the rest are filled in with whatever a pile
 * of the reader's own carries and nothing below says anything about them.
 *
 * **`kind` defaults to `main` and `isActive` to `true`**, which between them is "an ordinary pile
 * in the flow": every case that reaches the rail has to say which of the two rules put it there,
 * which is what keeps the flow-then-rail assertions from passing on an accident of array order.
 */
function group(name: string, cards: DeckCard[], over: Partial<CardGroup> = {}): CardGroup {
  return {
    key: `cat-${name}`,
    name,
    kind: "main",
    categoryId: 1,
    isActive: true,
    isPredefined: false,
    isAuto: false,
    cards,
    count: cards.reduce((n, c) => n + c.quantity, 0),
    totalPrice: null,
    ...over,
  };
}

/** A row filed in a named pile — the two fields a stop's address takes off the card rather than
 *  off the group it was drawn in. */
function inPile(name: string, categoryId: number, categoryName: string): DeckCard {
  return card({ name, categoryId, categoryName });
}

const names = (stops: readonly DeckWalkStop[]) => stops.map((s) => s.name);

describe("deckWalkStops", () => {
  /**
   * **The order is the desk's, and the desk's order is `splitRail`'s**: the piles that flow, then
   * the piles pinned to the right of them. Reading `groups` straight through would put the
   * Sideboard in the middle here, which is not where any reader is looking at it.
   */
  it("walks the flow before the rail", () => {
    const stops = deckWalkStops(
      [
        group("Ramp", [inPile("Sol Ring", 1, "Ramp")]),
        group("Sideboard", [inPile("Pyroblast", 2, "Sideboard")], { kind: "side" }),
        group("Removal", [inPile("Swords to Plowshares", 3, "Removal")]),
      ],
      4,
    );

    expect(names(stops)).toEqual(["Sol Ring", "Swords to Plowshares", "Pyroblast"]);
  });

  /**
   * The rail's second rule, which is the one that moves a pile the reader made. `splitRail` tests
   * the kind first and the switch second, so a switched-off pile follows the Sideboard however
   * early its `sortOrder` puts it — and the walk has to agree, or a reader arrowing through a
   * deck skips out of the flow and back into it.
   *
   * It is also the case that discriminates a walk derived from `splitRail` from one that simply
   * kept the array order: `Cuts` is second in the input and last in the answer.
   */
  it("rails a pile the reader switched off, behind the piles played beside the deck", () => {
    const stops = deckWalkStops(
      [
        group("Ramp", [inPile("Sol Ring", 1, "Ramp")]),
        group("Cuts", [inPile("Shock", 6, "Cuts")], { isActive: false }),
        group("Sideboard", [inPile("Pyroblast", 2, "Sideboard")], { kind: "side" }),
      ],
      4,
    );

    expect(names(stops)).toEqual(["Sol Ring", "Pyroblast", "Shock"]);
  });

  /**
   * Nothing here sorts. `buildGroups` has already put each pile's cards in the order `sortBy`
   * asked for, so the walk's only job inside a pile is to leave them alone — a second sort here
   * would be a second answer to a question the toolbar has already asked, and the reader would
   * arrow through their deck in an order no view draws.
   */
  it("keeps each pile's cards in the order they were handed over", () => {
    const stops = deckWalkStops(
      [
        group("Ramp", [
          inPile("Wayfarer's Bauble", 1, "Ramp"),
          inPile("Arcane Signet", 1, "Ramp"),
          inPile("Sol Ring", 1, "Ramp"),
        ]),
      ],
      4,
    );

    expect(names(stops)).toEqual(["Wayfarer's Bauble", "Arcane Signet", "Sol Ring"]);
  });

  /**
   * **A stop is the whole five-part address**, and `toEqual` rather than `toMatchObject` is the
   * assertion: the failure worth catching is a slot naming four parts, which is exactly what
   * `toMatchObject` cannot see. `PaneDeckContext`'s doc records that mistake twice, over
   * `variant` and over `finish`, each time rewriting a deck row the reader was not looking at.
   *
   * The row here is deliberately the awkward one — the theory list, a foil, and a pile that is
   * neither the first nor the default — so every part of the address is something the code had
   * to go and read rather than a value it could have got right by accident.
   */
  it("addresses each stop the way every deck write is addressed", () => {
    const foil = card({
      name: "Sol Ring",
      categoryId: 9,
      categoryName: "Ramp",
      variant: "theory",
      finish: "foil",
    });

    expect(deckWalkStops([group("Ramp", [foil])], 4)).toEqual([
      {
        oracleId: "o-Sol Ring",
        name: "Sol Ring",
        deck: {
          deckId: 4,
          categoryId: 9,
          categoryName: "Ramp",
          cardId: "c-Sol Ring",
          variant: "theory",
          finish: "foil",
        },
      },
    ]);
  });

  /**
   * An orphan is a row whose printing has left the corpus — `deck_card_select` is a LEFT JOIN, so
   * `oracleId` is `null` and the denormalized name is all it has left. There are no printings to
   * show for one, so a walk *through printings* does not stop on it: stepping there would open a
   * modal with nothing in it and no sentence saying why.
   *
   * The neighbours are what make this a test about skipping rather than about filtering: the row
   * comes out of the middle and the two either side stay adjacent.
   */
  it("steps over a row whose printing has left the corpus", () => {
    const stops = deckWalkStops(
      [
        group("Ramp", [
          inPile("Sol Ring", 1, "Ramp"),
          card({ name: "Ghost", categoryId: 1, categoryName: "Ramp", oracleId: null }),
          inPile("Arcane Signet", 1, "Ramp"),
        ]),
      ],
      4,
    );

    expect(names(stops)).toEqual(["Sol Ring", "Arcane Signet"]);
  });

  /**
   * One printing filed in two piles is **two** stops, because it is two `deck_cards` rows with
   * two addresses — and a press inside the modal rewrites one of them. Collapsing them by oracle
   * id would hide half the deck from the walk and point every press at whichever copy was found
   * first, which is the shape of the bug `selectedSlot` was fixed for on 2026-08-17.
   */
  it("stops twice on a card the deck holds in two piles", () => {
    const stops = deckWalkStops(
      [
        group("Ramp", [inPile("Sol Ring", 1, "Ramp")]),
        group("Sideboard", [inPile("Sol Ring", 2, "Sideboard")], { kind: "side" }),
      ],
      4,
    );

    expect(stops.map((s) => s.deck.categoryName)).toEqual(["Ramp", "Sideboard"]);
    expect(new Set(stops.map((s) => s.oracleId))).toEqual(new Set(["o-Sol Ring"]));
  });

  /** A deck nobody has put a card in yet. The piles are still drawn — an empty Sideboard is where
   *  the next sideboard card goes — and there is still nothing to walk. */
  it("answers nothing for a deck with no cards in it", () => {
    const drawn = [group("Ramp", []), group("Sideboard", [], { kind: "side" })];

    expect(deckWalkStops([], 4)).toEqual([]);
    expect(deckWalkStops(drawn, 4)).toEqual([]);
  });
});

/**
 * **The test that would have caught both incidents `deckSlotOf`'s doc records.**
 *
 * A deck row is `(deck, card, category, variant, finish)`, and a comparison that names four of
 * the five finds the reader's place in the walk on a row they are not looking at — the plain copy
 * when they opened the foil one, the live list when they are editing the theory one. Each of the
 * five is moved on its own below, because a sweep that moved two at once would pass against a
 * comparison that read only one of them.
 */
describe("sameDeckSlot", () => {
  const SLOT: PaneDeckContext = {
    deckId: 4,
    categoryId: 9,
    categoryName: "Ramp",
    cardId: "c-Sol Ring",
    variant: "live",
    finish: null,
  };

  it("says a slot is itself", () => {
    expect(sameDeckSlot(SLOT, { ...SLOT })).toBe(true);
  });

  /** One part of the address moved, five times over. Typed as a tuple list rather than left to
   *  inference so the second column is one `Partial` and not five one-key object types. */
  const MOVED: [string, Partial<PaneDeckContext>][] = [
    ["deck", { deckId: 5 }],
    ["category", { categoryId: 10 }],
    ["printing", { cardId: "c-Arcane Signet" }],
    // The two that were added to `PaneDeckContext` after the fact, each because a context
    // without it had already rewritten the wrong row: `variant` (schema v8, two lists) and
    // `finish` (schema v18, a pile holding the regular copy and the foil as two rows).
    ["list", { variant: "theory" }],
    ["finish", { finish: "foil" }],
  ];

  it.each(MOVED)("tells two rows apart by their %s", (_part, difference) => {
    expect(sameDeckSlot(SLOT, { ...SLOT, ...difference })).toBe(false);
  });

  /**
   * The sixth field, and the one that is deliberately **not** part of the comparison.
   * `categoryName` is `categoryId` spelled out for a sibling surface with no category list to
   * translate an id with — it is derived from a field this already tests, so comparing it would
   * only add a way to be wrong: a pile renamed while the modal is open would read as a different
   * row and the reader would lose their place for a change to a heading.
   */
  it("does not read the category's name, which is the id spelled out", () => {
    expect(sameDeckSlot(SLOT, { ...SLOT, categoryName: "Mana" })).toBe(true);
  });
});
