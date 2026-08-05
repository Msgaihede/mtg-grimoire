import { describe, expect, it } from "vitest";
import { eurPrice, usdPrice } from "./prices";

describe("price text", () => {
  it("writes a price in its own currency, to the cent", () => {
    expect(usdPrice(5)).toBe("$5.00");
    expect(usdPrice(1234.5)).toBe("$1,234.50");
    expect(eurPrice(4.2)).toBe("€4.20");
  });

  /**
   * The two halves of the one rule this module exists for. **No price** is an em dash,
   * because `$0.00` is a price nobody quoted — and a card whose price genuinely *is* zero
   * (bulk commons are, in the data) has been quoted one, so it reads as one. The
   * distinction is a `=== null`, and the obvious `value ? … : "—"` gets it wrong in the
   * direction that hides a real number.
   */
  it("tells no price apart from a price of nothing", () => {
    expect(usdPrice(null)).toBe("—");
    expect(eurPrice(null)).toBe("—");
    expect(usdPrice(0)).toBe("$0.00");
    expect(eurPrice(0)).toBe("€0.00");
  });
});
