import { describe, expect, it } from "vitest";
import { tagsOverflow } from "./tagRow";

/**
 * **The row overflows exactly when its tags, at the widths they want, and the gaps between them
 * are wider than the line** (issue #901). The arithmetic is the whole decision — `DeckTile`
 * reserves room for the `…` pill on its answer, and the reserve must not feed back into it.
 */
describe("tagsOverflow", () => {
  it("fits tags whose widths and gaps sum to the line exactly", () => {
    expect(tagsOverflow([40, 50], 4, 94)).toBe(false);
  });

  it("overflows by a single pixel, because a pixel is a tag wrapped off the line", () => {
    expect(tagsOverflow([40, 50], 4, 93)).toBe(true);
  });

  it("counts the gaps between tags and none outside them", () => {
    // Three tags, two gaps: 30 * 3 + 2 * 5 = 100.
    expect(tagsOverflow([30, 30, 30], 5, 100)).toBe(false);
    expect(tagsOverflow([30, 30, 30], 5, 99.5)).toBe(true);
  });

  it("overflows on one tag wider than the line — a tag cut short is a tag not shown", () => {
    expect(tagsOverflow([140], 4, 120)).toBe(true);
  });

  it("absorbs sub-pixel noise in the sum", () => {
    expect(tagsOverflow([33.333, 33.333, 33.334], 0, 100 - 0.001)).toBe(false);
  });

  it("never overflows with no tags, and a row with no layout is not an overflowing one", () => {
    expect(tagsOverflow([], 4, 0)).toBe(false);
    // jsdom: every box zero wide, and no gap the stylesheet would have given.
    expect(tagsOverflow([0, 0, 0], 0, 0)).toBe(false);
  });
});
