import { describe, expect, it } from "vitest";
import { activeFilterCount, cycleTriState, toggleColor, toggleIn } from "./useCardSearch";

describe("toggleIn", () => {
  it("adds what is missing and removes what is there", () => {
    expect(toggleIn([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggleIn([1, 2], 2)).toEqual([1]);
  });
});

describe("activeFilterCount", () => {
  const none = { text: "", format: "", colors: [], sets: [], manaValues: [], owned: undefined };

  it("is zero when nothing is filtered", () => {
    expect(activeFilterCount(none)).toBe(0);
  });

  /**
   * `false` is a filter — "the cards I do *not* have" — and a falsy check would count it as
   * nothing at all, leaving Reset all hidden over a search that is filtering hard.
   */
  it("counts an owned filter in either direction", () => {
    expect(activeFilterCount({ ...none, owned: true })).toBe(1);
    expect(activeFilterCount({ ...none, owned: false })).toBe(1);
  });

  /**
   * Each *kind* of filter counts once, however many values it holds: the badge tells the
   * reader how many things Reset all is about to clear, and "3" for three colours in one
   * chip row would be a different, less useful claim.
   */
  it("counts each kind of filter once", () => {
    expect(activeFilterCount({ ...none, colors: ["W", "U", "B"] })).toBe(1);
    expect(activeFilterCount({ ...none, sets: ["lea", "roe"] })).toBe(1);
    expect(activeFilterCount({ ...none, text: "bolt", format: "modern", manaValues: [1] })).toBe(3);
  });

  /** Whitespace is not a search. */
  it("ignores a blank search box", () => {
    expect(activeFilterCount({ ...none, text: "   " })).toBe(0);
  });
});

/**
 * One chip, three states — and which of the two *on* states comes first is the caller's,
 * because the useful first press is not the same question in both views. A search asks
 * "what have I already got"; a shopping list asks "what am I still missing".
 */
describe("cycleTriState", () => {
  it("goes off → the caller's question → its opposite → off", () => {
    expect(cycleTriState(undefined, true)).toBe(true);
    expect(cycleTriState(true, true)).toBe(false);
    expect(cycleTriState(false, true)).toBeUndefined();
  });

  it("starts from the other end when the caller asks the other question first", () => {
    expect(cycleTriState(undefined, false)).toBe(false);
    expect(cycleTriState(false, false)).toBe(true);
    expect(cycleTriState(true, false)).toBeUndefined();
  });
});

/** Unchanged behaviour, pinned here because Task 10 restyles the chips it belongs to. */
describe("toggleColor", () => {
  it("keeps C exclusive in both directions", () => {
    expect(toggleColor(["W", "U"], "C")).toEqual(["C"]);
    expect(toggleColor(["C"], "W")).toEqual(["W"]);
  });
});
