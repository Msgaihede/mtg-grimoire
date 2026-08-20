import { describe, expect, it } from "vitest";
import type { DeckFinish } from "@/lib/ipc";
import { matchesTheory, theoryMatchSet, theorySlot } from "./theoryMatch";

/** The two fields the whole module reads, and nothing else — the signatures take a `Pick`, so a
 *  test that built a whole `DeckCard` would be asserting about fields no code path touches. */
const row = (cardId: string, finish: DeckFinish = null) => ({ cardId, finish });

describe("theorySlot", () => {
  it("addresses a row by its printing and its finish", () => {
    expect(theorySlot(row("bolt-lea", "foil"))).not.toBe(theorySlot(row("bolt-lea")));
    expect(theorySlot(row("bolt-lea"))).not.toBe(theorySlot(row("bolt-m10")));
  });

  it("gives two regular copies of one printing the same address", () => {
    expect(theorySlot(row("bolt-lea"))).toBe(theorySlot(row("bolt-lea", null)));
  });
});

describe("matchesTheory", () => {
  it("marks a live row the plan asks for", () => {
    const plan = theoryMatchSet([row("bolt-lea"), row("ring-c21")]);

    expect(matchesTheory(plan, row("bolt-lea"))).toBe(true);
    expect(matchesTheory(plan, row("ring-c21"))).toBe(true);
  });

  it("leaves a printing the plan does not name unmarked", () => {
    const plan = theoryMatchSet([row("bolt-lea")]);

    // The same card, a different printing. The plan named the Alpha copy.
    expect(matchesTheory(plan, row("bolt-m10"))).toBe(false);
  });

  it("leaves the regular copy unmarked when the plan calls for the foil", () => {
    const plan = theoryMatchSet([row("ring-c21", "foil")]);

    expect(matchesTheory(plan, row("ring-c21"))).toBe(false);
    expect(matchesTheory(plan, row("ring-c21", "foil"))).toBe(true);
  });

  /**
   * The one field of the row's stored grain this deliberately drops. A card planned as Ramp and
   * sleeved into Main deck is still the card that was planned — see the module note.
   */
  it("marks a row the reader has since filed under a different pile", () => {
    const plan = theoryMatchSet([{ cardId: "ring-c21", finish: null }]);

    expect(matchesTheory(plan, row("ring-c21"))).toBe(true);
  });

  /** A deck with no plan, and the Theory tab itself: there is no question, so nothing is marked. */
  it("marks nothing when there is no plan to compare against", () => {
    expect(theoryMatchSet(undefined)).toBeUndefined();
    expect(matchesTheory(undefined, row("bolt-lea"))).toBe(false);
  });

  it("marks nothing against a plan that is empty", () => {
    expect(matchesTheory(theoryMatchSet([]), row("bolt-lea"))).toBe(false);
  });

  /** One card filed in two of the plan's piles is one address, not two — the set folds it. */
  it("folds a card the plan files twice into one address", () => {
    expect(theoryMatchSet([row("bolt-lea"), row("bolt-lea")])?.size).toBe(1);
  });
});
