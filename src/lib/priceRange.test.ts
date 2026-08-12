import { describe, expect, it } from "vitest";
import { priceRange } from "./priceRange";

describe("priceRange", () => {
  it("renders a range when the ends differ", () => {
    expect(priceRange(0.75, 4200, "usd")).toBe("$0.75–$4,200.00");
  });

  /**
   * Most cards have exactly one printing, and an uncollapsed row always does — `$2.15–$2.15`
   * would be noise on both.
   */
  it("renders one price when the ends agree", () => {
    expect(priceRange(2.15, 2.15, "usd")).toBe("$2.15");
  });

  /** `formatPrice` never invents `$0.00`, and neither does this. */
  it("is an em dash when nothing is priced", () => {
    expect(priceRange(null, null, "usd")).toBe("—");
    expect(priceRange(null, null, "eur")).toBe("—");
  });

  /**
   * A group where only some printings are priced. The end that is known is shown and the
   * one that is not is not invented — a range opening on an em dash reads as "from
   * unknown", which is what it is.
   */
  it("shows the end it knows", () => {
    expect(priceRange(null, 9, "usd")).toBe("—–$9.00");
    expect(priceRange(9, null, "usd")).toBe("$9.00–—");
  });

  /**
   * Both ends take the currency they are given, and both symbols move together — a range
   * that formatted one end in dollars and the other in euros would be a cell nobody could
   * read at all. The euro spans in `CardSummary` are their own pair for exactly this reason:
   * a group's euro span can be narrower than its dollar one, or absent while the dollar one
   * exists, and the two must never be mixed inside one range.
   */
  it("draws both ends in the currency it is given", () => {
    expect(priceRange(0.75, 4200, "eur")).toBe("€0.75–€4,200.00");
    expect(priceRange(2.15, 2.15, "eur")).toBe("€2.15");
    expect(priceRange(null, 9, "eur")).toBe("—–€9.00");
  });
});
