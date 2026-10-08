import { describe, expect, it } from "vitest";
import { deckCardSlot } from "./dnd";
import { validateForMarks } from "./validation/engine";
import { card, commander, islands, spec } from "./validation/fixtures";
import type { CardFacts, ValidationIssue } from "./validation/types";
import { ruleBreak, violationsBySlot, violationsFor } from "./violations";

const issue = (over: Partial<ValidationIssue> = {}): ValidationIssue => ({
  severity: "error",
  code: "banned",
  message: "Mana Crypt is banned in Commander.",
  ...over,
});

const slotOf = (row: CardFacts): string => deckCardSlot(row.categoryId, row.cardId, row.finish);

describe("violationsBySlot", () => {
  /**
   * The engine collapses rows that produce the same sentence into one finding whose `rowIds`
   * names all of them, which is right for a panel that lists sentences and exactly wrong for a
   * list that marks cards. This turns it back round.
   */
  it("lists one collapsed finding under every row it names", () => {
    const main = card({ name: "Mana Crypt" });
    const side = card({ name: "Mana Crypt", categoryKind: "side" });
    const banned = issue({ cardIds: [main.cardId], rowIds: [main.id, side.id] });
    const bySlot = violationsBySlot([banned], [main, side]);

    expect([...bySlot.keys()]).toEqual([slotOf(main), slotOf(side)]);
    expect(violationsFor(bySlot, main)).toEqual([banned]);
    expect(violationsFor(bySlot, side)).toEqual([banned]);
  });

  it("keeps every finding about one row, in the order the engine reported them", () => {
    const row = card();
    const first = issue({ code: "singleton", message: "max 1 copy", rowIds: [row.id] });
    const second = issue({ code: "color-identity", message: "outside GW", rowIds: [row.id] });

    expect(violationsFor(violationsBySlot([first, second], [row]), row)).toEqual([first, second]);
  });

  /**
   * An issue about the deck itself carries no ids on purpose — highlighting sixty rows says
   * nothing the sentence did not — so it belongs to no row here either.
   */
  it("drops the findings that are about the deck rather than about a row", () => {
    const row = card();
    const size = issue({ code: "deck-size", message: "Commander decks are exactly 100 cards." });

    expect(violationsBySlot([size, issue({ rowIds: [row.id] })], [row]).size).toBe(1);
  });

  /** A finding that names a printing and no row is a finding no mark can carry — the marks
   *  never fall back to the printing, which is the grain issue #554 took away. */
  it("files nothing by printing alone", () => {
    const row = card();

    expect(violationsBySlot([issue({ cardIds: [row.cardId] })], [row]).size).toBe(0);
  });

  it("answers an empty map for an empty deck", () => {
    expect(violationsBySlot([], []).size).toBe(0);
  });
});

/**
 * Issue #554, end to end through the engine: the two reported reproductions, each asserted on
 * the parked row and the active one, since the fix is that they now answer differently.
 */
describe("marks through validateForMarks", () => {
  it("leaves a parked copy unmarked when the active piles break singleton", () => {
    const active = card({ name: "Sol Ring", quantity: 2 });
    const parked = card({ name: "Sol Ring", categoryKind: "maybe", categoryActive: false });
    const deck = [commander(), islands(97), active, parked];
    const bySlot = violationsBySlot(validateForMarks(deck, spec("commander")), deck);

    expect(ruleBreak(violationsFor(bySlot, active))).toBe(
      "Commander decks are singleton: max 1 copy of Sol Ring; you have 2.",
    );
    expect(ruleBreak(violationsFor(bySlot, parked))).toBeNull();
  });

  it("says a ban once on each row of a card in an active pile and a parked one", () => {
    const banned = '{"modern":"banned"}';
    const active = card({ name: "Sol Ring", legalities: banned });
    const parked = card({
      name: "Sol Ring",
      categoryKind: "maybe",
      categoryActive: false,
      legalities: banned,
    });
    const deck = [islands(59), active, parked];
    const bySlot = violationsBySlot(validateForMarks(deck, spec("modern")), deck);

    expect(violationsFor(bySlot, active)).toHaveLength(1);
    expect(violationsFor(bySlot, parked)).toHaveLength(1);
    expect(ruleBreak(violationsFor(bySlot, active))).toBe("Sol Ring is banned in Modern.");
    expect(ruleBreak(violationsFor(bySlot, parked))).toBe("Sol Ring is banned in Modern.");
  });
});

describe("ruleBreak", () => {
  /**
   * The mark this feeds is the one the spec insists must not be confusable with a game
   * changer: one is a problem, the other is a fact about a powerful card. So only an
   * **error** draws it — a warning is a fact worth a look, and an orphaned row is not a rule
   * the reader broke.
   */
  it("reports the errors and ignores the warnings", () => {
    const warning = issue({ severity: "warning", code: "orphan", message: "Not in the database." });
    const error = issue({ message: "Mana Crypt is banned in Commander." });

    expect(ruleBreak([warning])).toBeNull();
    expect(ruleBreak([warning, error])).toBe("Mana Crypt is banned in Commander.");
  });

  /** Several sentences, one line: the mark is a tooltip, and a card can break two rules. */
  it("joins several sentences into one line", () => {
    expect(
      ruleBreak([
        issue({ message: "Mana Crypt is banned in Commander." }),
        issue({ code: "singleton", message: "Commander decks are singleton." }),
      ]),
    ).toBe("Mana Crypt is banned in Commander. Commander decks are singleton.");
  });

  /** One sentence once, whichever findings carry it: a tooltip and an accessible name that said
   *  "banned" twice were issue #554's second symptom. Filing by row is the fix; this is the
   *  backstop, so a sentence reaching one row twice by any route is still said once. */
  it("says a repeated sentence once", () => {
    const banned = issue({ message: "Sol Ring is banned in Modern." });

    expect(ruleBreak([banned, { ...banned, cardIds: ["other"] }])).toBe(
      "Sol Ring is banned in Modern.",
    );
  });

  /** A card with nothing wrong with it is the common case, and `undefined` is what a `Map`
   *  lookup answers for one — so the caller can hand the lookup straight in. */
  it("answers null for a card with nothing wrong with it", () => {
    expect(ruleBreak(undefined)).toBeNull();
    expect(ruleBreak([])).toBeNull();
  });
});
