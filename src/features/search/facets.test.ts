import { describe, expect, it } from "vitest";
import type { FacetResponse } from "@/lib/ipc";
import {
  colorDisabled,
  countDisabled,
  facetsOrUndefined,
  facetTitle,
  optionDisabled,
} from "./facets";

describe("the greying rule", () => {
  it("greys an option whose count is zero, and only that one", () => {
    expect(optionDisabled({ lea: 0 }, "lea", false)).toBe(true);
    expect(optionDisabled({ lea: 3 }, "lea", false)).toBe(false);
  });

  /** The way out of a dead end has to stay open, or a reader who filters into nothing is
   *  stuck with every control greyed and no way back. */
  it("never greys an option that is currently selected", () => {
    expect(optionDisabled({ lea: 0 }, "lea", true)).toBe(false);
  });

  /** Not-greyed means "we don't know". A cold index or a failed query must not disable
   *  anything, because a wrongly-greyed control hides cards that exist. */
  it("fails open when there are no counts at all", () => {
    expect(optionDisabled(undefined, "lea", false)).toBe(false);
  });

  /**
   * **A key that is not there is unknown, not zero** — the one place this parts from the
   * plan's sketch, which greyed it.
   *
   * `FacetResponse.sets` promises every code in the corpus arrives, zeros included, and
   * `ipc.ts` says in as many words to "treat a missing one as a bug rather than as a zero".
   * Under that contract a lookup never misses, so this arm only decides what happens when
   * something *has* gone wrong — and the rule for that is stated once: fail open. A control
   * that wrongly stays live costs one press; one that wrongly greys hides cards that exist.
   *
   * It is also the fence that makes the next test true without anyone remembering to put it
   * up.
   */
  it("leaves an option the answer never mentioned live", () => {
    expect(optionDisabled({ lea: 2 }, "neo", false)).toBe(false);
  });

  /**
   * The X chip's count is a *field* of the response rather than a key in a map, because X is
   * not a mana value — so it asks the rule directly. All three arms again, because "the same
   * rule" is a claim about behaviour and not about which function happens to call which.
   */
  describe("a bare count, which is how the X chip asks", () => {
    it("greys a count of zero and nothing else", () => {
      expect(countDisabled(0, false)).toBe(true);
      expect(countDisabled(3, false)).toBe(false);
    });

    it("never greys the chip that is switched on, and fails open with no count", () => {
      expect(countDisabled(0, true)).toBe(false);
      expect(countDisabled(undefined, false)).toBe(false);
    });
  });

  /**
   * A cold index answers `ready: false` with every map **empty** rather than zeroed, and
   * `facetsOrUndefined` is what a caller is supposed to route it through. This is the belt
   * behind that brace: read the maps directly and they still grey nothing, so the one bug
   * that would grey the whole filter row cannot be written.
   */
  it("greys nothing at all when read straight off a cold response", () => {
    const cold: FacetResponse = {
      colors: {},
      manaValues: {},
      manaX: 0,
      formats: {},
      rarities: {},
      sets: {},
      owned: { owned: 0, missing: 0 },
      total: 0,
      ready: false,
    };
    expect(optionDisabled(cold.manaValues, "7", false)).toBe(false);
    expect(optionDisabled(cold.formats, "modern", false)).toBe(false);
    expect(colorDisabled(cold.colors.W, cold.total, false)).toBe(false);
    // **The X chip is the one control this belt does not fit**, and it is worth writing down
    // rather than leaving to be discovered. Its count is a *number* beside the maps, so a cold
    // response carries a plain `0` where the maps carry an absent key — and zero is the one
    // thing the rule reads as "empty". `facetsOrUndefined` is therefore the whole of what
    // keeps it live: the line below is the brace, and the line above it is what it prevents.
    expect(countDisabled(cold.manaX, false)).toBe(true);
    expect(facetsOrUndefined(cold)).toBeUndefined();
  });

  describe("colours, which broaden rather than narrow", () => {
    /** With `U` on, pressing `W` asks for a superset — so "would return nothing" is the
     *  wrong question and "would change nothing" is the right one. */
    it("greys a colour that would leave the result set unchanged", () => {
      expect(colorDisabled(40, 40, false)).toBe(true);
    });

    it("greys a colour that would empty the result set", () => {
      expect(colorDisabled(0, 40, false)).toBe(true);
    });

    it("leaves a colour live when toggling it changes the answer", () => {
      expect(colorDisabled(58, 40, false)).toBe(false);
      expect(colorDisabled(12, 40, false)).toBe(false);
    });

    it("never greys a selected colour, and fails open without a count", () => {
      expect(colorDisabled(40, 40, true)).toBe(false);
      expect(colorDisabled(undefined, 40, false)).toBe(false);
    });
  });
});

describe("facetTitle", () => {
  /** The word "printings" is the whole fix for the two different numbers this app calls
   *  `total`: the list collapses printings into cards and a facet count never does. */
  it("says what it counted, and says printings", () => {
    expect(facetTitle("Modern", 12481)).toBe("Modern — 12,481 printings");
    expect(facetTitle("Limited Edition Alpha", 1)).toBe("Limited Edition Alpha — 1 printing");
  });

  /** A greyed control's tooltip has to explain *why* it is greyed. "0 printings" is a
   *  number where a reason belongs. */
  it("gives a reason rather than a zero", () => {
    expect(facetTitle("Mana value 7", 0)).toBe("Mana value 7 — nothing in this search");
  });

  /** No count, no sentence — the control keeps the plain label it has always had, which is
   *  what makes an unfaceted filter row (the collection's) render unchanged. */
  it("says nothing when nothing is known", () => {
    expect(facetTitle("Mana value 7", undefined)).toBeUndefined();
  });
});

describe("facetsOrUndefined", () => {
  const ready: FacetResponse = {
    colors: { W: 1 },
    manaValues: { "0": 1 },
    manaX: 1,
    formats: { modern: 1 },
    rarities: { rare: 1 },
    sets: { lea: 1 },
    owned: { owned: 1, missing: 0 },
    total: 1,
    ready: true,
  };

  it("passes a ready answer through and drops everything else", () => {
    expect(facetsOrUndefined(ready)).toBe(ready);
    expect(facetsOrUndefined({ ...ready, ready: false })).toBeUndefined();
    expect(facetsOrUndefined(undefined)).toBeUndefined();
  });
});
