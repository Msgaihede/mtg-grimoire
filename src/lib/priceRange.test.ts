import { describe, expect, it } from "vitest";
import { priceRange } from "./priceRange";

describe("priceRange", () => {
  it("renders a range when the ends differ", () => {
    expect(priceRange(0.75, 4200)).toBe("$0.75–$4,200.00");
  });

  /**
   * Most cards have exactly one printing, and an uncollapsed row always does — `$2.15–$2.15`
   * would be noise on both.
   */
  it("renders one price when the ends agree", () => {
    expect(priceRange(2.15, 2.15)).toBe("$2.15");
  });

  /** `usdPrice` never invents `$0.00`, and neither does this. */
  it("is an em dash when nothing is priced", () => {
    expect(priceRange(null, null)).toBe("—");
  });

  /**
   * A group where only some printings are priced. The end that is known is shown and the
   * one that is not is not invented — a range opening on an em dash reads as "from
   * unknown", which is what it is.
   */
  it("shows the end it knows", () => {
    expect(priceRange(null, 9)).toBe("—–$9.00");
    expect(priceRange(9, null)).toBe("$9.00–—");
  });
});
