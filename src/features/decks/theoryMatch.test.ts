import { describe, expect, it } from "vitest";
import type { DeckFinish } from "@/lib/ipc";
import { matchesTheory, theoryMatchSet, theorySlot } from "./theoryMatch";

/** The two fields the whole module reads, and nothing else — the signatures take a `Pick`, so a
 *  test that built a whole `DeckCard` would be asserting about fields no code path touches. */
const row = (cardId: string, finish: DeckFinish = null) => ({ cardId, finish });

/**
 * **The slots are hand-spelled rather than built with {@link theorySlot}, and that is the point.**
 *
 * They come off the wire from `deck_theory_slots`, which answers `deck_theory.rs`'s own
 * `group_key` strings — so a test that generated both sides here would pass whatever separator
 * this file happened to use and prove only that it agrees with itself. These are the same
 * literals `deck_theory.rs`'s own tests assert (`"bolt-lea|"`, `"bolt-lea|foil"`), written out on
 * both sides of the boundary so a change to `GROUP_SEPARATOR` fails one suite or the other rather
 * than silently unlighting every mark in the app.
 */
describe("theorySlot", () => {
  it("spells a live row the way the backend spells a planned one", () => {
    expect(theorySlot(row("bolt-lea"))).toBe("bolt-lea|");
    expect(theorySlot(row("bolt-lea", "foil"))).toBe("bolt-lea|foil");
    expect(theorySlot(row("bolt-lea", "etched"))).toBe("bolt-lea|etched");
  });

  it("gives two regular copies of one printing the same address", () => {
    expect(theorySlot(row("bolt-lea"))).toBe(theorySlot(row("bolt-lea", null)));
  });
});

describe("matchesTheory", () => {
  it("marks a live row the plan asks for", () => {
    const plan = theoryMatchSet(["bolt-lea|", "ring-c21|"]);

    expect(matchesTheory(plan, row("bolt-lea"))).toBe(true);
    expect(matchesTheory(plan, row("ring-c21"))).toBe(true);
  });

  it("leaves a printing the plan does not name unmarked", () => {
    // The same card, a different printing. The plan named the Alpha copy.
    expect(matchesTheory(theoryMatchSet(["bolt-lea|"]), row("bolt-m10"))).toBe(false);
  });

  it("leaves the regular copy unmarked when the plan calls for the foil", () => {
    const plan = theoryMatchSet(["ring-c21|foil"]);

    expect(matchesTheory(plan, row("ring-c21"))).toBe(false);
    expect(matchesTheory(plan, row("ring-c21", "foil"))).toBe(true);
  });

  /**
   * The one field of the row's stored grain this deliberately drops — the backend drops it too,
   * so a card planned as Ramp and sleeved into Main deck is one planned card at both ends.
   */
  it("marks a row the reader has since filed under a different pile", () => {
    expect(matchesTheory(theoryMatchSet(["ring-c21|"]), row("ring-c21"))).toBe(true);
  });

  /** A deck with no plan, and the Theory tab itself: the query is not mounted, so there is no
   *  question and nothing is marked. */
  it("marks nothing when there is no plan to compare against", () => {
    expect(theoryMatchSet(undefined)).toBeUndefined();
    expect(matchesTheory(undefined, row("bolt-lea"))).toBe(false);
  });

  it("marks nothing against a plan that is empty", () => {
    expect(matchesTheory(theoryMatchSet([]), row("bolt-lea"))).toBe(false);
  });

  /** One card the plan files in two of its piles arrives as two identical slots — the set folds
   *  them, which is why the command does not bother to distinct them. */
  it("folds a card the plan files twice into one address", () => {
    expect(theoryMatchSet(["bolt-lea|", "bolt-lea|"])?.size).toBe(1);
  });
});
