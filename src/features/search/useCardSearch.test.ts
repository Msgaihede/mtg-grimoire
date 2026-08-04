import { describe, expect, it } from "vitest";
import { activeFilterCount, toggleColor, toggleIn } from "./useCardSearch";

describe("toggleIn", () => {
  it("adds what is missing and removes what is there", () => {
    expect(toggleIn([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggleIn([1, 2], 2)).toEqual([1]);
  });
});

describe("activeFilterCount", () => {
  const none = { text: "", format: "", colors: [], sets: [], manaValues: [] };

  it("is zero when nothing is filtered", () => {
    expect(activeFilterCount(none)).toBe(0);
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

/** Unchanged behaviour, pinned here because Task 10 restyles the chips it belongs to. */
describe("toggleColor", () => {
  it("keeps C exclusive in both directions", () => {
    expect(toggleColor(["W", "U"], "C")).toEqual(["C"]);
    expect(toggleColor(["C"], "W")).toEqual(["W"]);
  });
});
