import { describe, expect, it } from "vitest";
import type { DeckFinish, TheorySlot } from "@/lib/ipc";
import { theoryMatchDelta, theoryMatchPlan, theorySlot } from "./theoryMatch";

/** The two fields {@link theorySlot} and {@link theoryMatchDelta} read, and nothing else — both
 *  signatures take a `Pick`, so a test that built a whole `DeckCard` would be asserting about
 *  fields no code path touches. */
const row = (cardId: string, finish: DeckFinish = null) => ({ cardId, finish });

/** A **live** row, which needs two fields more than the lookup does: what it holds, and whether
 *  the pile it is in counts. Active by default, because that is the ordinary card. */
const live = (cardId: string, quantity: number, finish: DeckFinish = null, active = true) => ({
  cardId,
  finish,
  quantity,
  categoryActive: active,
});

/** A slot as `deck_theory_slots` answers one — see the note on the literals below. */
const slot = (key: string, quantity = 1): TheorySlot => ({ key, quantity });

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

describe("theoryMatchDelta", () => {
  it("marks a live row the plan asks for", () => {
    const plan = theoryMatchPlan(
      [slot("bolt-lea|"), slot("ring-c21|")],
      [live("bolt-lea", 1), live("ring-c21", 1)],
    );

    expect(theoryMatchDelta(plan, row("bolt-lea"))).toBe(0);
    expect(theoryMatchDelta(plan, row("ring-c21"))).toBe(0);
  });

  it("leaves a printing the plan does not name unmarked", () => {
    // The same card, a different printing. The plan named the Alpha copy.
    const plan = theoryMatchPlan([slot("bolt-lea|")], [live("bolt-m10", 1)]);

    expect(theoryMatchDelta(plan, row("bolt-m10"))).toBeNull();
  });

  it("leaves the regular copy unmarked when the plan calls for the foil", () => {
    const plan = theoryMatchPlan(
      [slot("ring-c21|foil")],
      [live("ring-c21", 1), live("ring-c21", 1, "foil")],
    );

    expect(theoryMatchDelta(plan, row("ring-c21"))).toBeNull();
    expect(theoryMatchDelta(plan, row("ring-c21", "foil"))).toBe(0);
  });

  /**
   * The one field of the row's stored grain this deliberately drops — the backend drops it too,
   * so a card planned as Ramp and sleeved into Main deck is one planned card at both ends.
   */
  it("marks a row the reader has since filed under a different pile", () => {
    const plan = theoryMatchPlan([slot("ring-c21|")], [live("ring-c21", 1)]);

    expect(theoryMatchDelta(plan, row("ring-c21"))).toBe(0);
  });

  /** A deck with no plan, and the Theory tab itself: the query is not mounted, so there is no
   *  question and nothing is marked. */
  it("marks nothing when there is no plan to compare against", () => {
    expect(theoryMatchPlan(undefined, [live("bolt-lea", 1)])).toBeUndefined();
    expect(theoryMatchDelta(undefined, row("bolt-lea"))).toBeNull();
  });

  it("marks nothing against a plan that is empty", () => {
    expect(theoryMatchDelta(theoryMatchPlan([], [live("bolt-lea", 1)]), row("bolt-lea"))).toBeNull();
  });

  /** One card the plan files in two of its piles should arrive folded — the command groups — but
   *  a `Vec` is what crosses the boundary, so the map sums rather than letting the last row win. */
  it("sums a card the plan files twice into one address", () => {
    const plan = theoryMatchPlan([slot("bolt-lea|", 2), slot("bolt-lea|", 2)], [live("bolt-lea", 4)]);

    expect(plan?.size).toBe(1);
    expect(theoryMatchDelta(plan, row("bolt-lea"))).toBe(0);
  });
});

/** Issue #212 — the number the mark draws when the two lists disagree about a card they both
 *  hold. Every case here is about `live − planned` and about which of them is suppressed. */
describe("theoryMatchDelta's count", () => {
  it("counts a live list short of the plan as a negative", () => {
    const plan = theoryMatchPlan([slot("bolt-lea|", 4)], [live("bolt-lea", 2)]);

    expect(theoryMatchDelta(plan, row("bolt-lea"))).toBe(-2);
  });

  it("counts a live list over the plan as a positive", () => {
    const plan = theoryMatchPlan([slot("bolt-lea|", 2)], [live("bolt-lea", 4)]);

    expect(theoryMatchDelta(plan, row("bolt-lea"))).toBe(2);
  });

  /** The whole reason both sides are summed before they are subtracted: a plan and a deck that
   *  agree exactly, filed differently, must read as agreeing. Per-row arithmetic would draw two
   *  numbers here, both false. */
  it("sums both sides across their piles before subtracting", () => {
    const plan = theoryMatchPlan(
      [slot("bolt-lea|", 5)],
      [live("bolt-lea", 4), live("bolt-lea", 1)],
    );

    expect(theoryMatchDelta(plan, row("bolt-lea"))).toBe(0);
  });

  /** `diff_select`'s rule read from the live side: a card parked in a switched-off pile is not
   *  something the deck has, so it may not fill the plan's order. */
  it("does not count a copy sitting in a switched-off pile", () => {
    const plan = theoryMatchPlan(
      [slot("bolt-lea|", 4)],
      [live("bolt-lea", 1), live("bolt-lea", 3, null, false)],
    );

    expect(theoryMatchDelta(plan, row("bolt-lea"))).toBe(-3);
  });

  /** The finishes are two planned cards, so their counts never pool. */
  it("counts the finishes apart", () => {
    const plan = theoryMatchPlan(
      [slot("ring-c21|", 3), slot("ring-c21|foil", 1)],
      [live("ring-c21", 1), live("ring-c21", 1, "foil")],
    );

    expect(theoryMatchDelta(plan, row("ring-c21"))).toBe(-2);
    expect(theoryMatchDelta(plan, row("ring-c21", "foil"))).toBe(0);
  });

  /** The issue's own exclusion: never a difference where neither side is above one. A Commander
   *  deck is every row of it, and the mark there is the tick or nothing. */
  it("draws no difference where neither side is above one", () => {
    // The only reachable shape of it: the plan asks for one and the copy is parked in a pile
    // that counts toward nothing, so the live side sums to zero.
    const plan = theoryMatchPlan([slot("sol-c21|", 1)], [live("sol-c21", 1, null, false)]);

    expect(theoryMatchDelta(plan, row("sol-c21"))).toBe(0);
  });

  /** ...and the floor is `> 1` on **either** side rather than on both, so a 2-of the reader has
   *  not started acquiring still says how many are missing. */
  it("draws the difference as soon as one side is above one", () => {
    const plan = theoryMatchPlan([slot("sol-c21|", 2)], [live("sol-c21", 1, null, false)]);

    expect(theoryMatchDelta(plan, row("sol-c21"))).toBe(-2);
  });
});
