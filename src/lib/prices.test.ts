import { describe, expect, it } from "vitest";
import { MARKETPLACES } from "./marketplace";
import { formatPrice, pricesAsOf } from "./prices";

describe("price text", () => {
  it("writes a price in the currency it is handed", () => {
    expect(formatPrice(5, "usd")).toBe("$5.00");
    expect(formatPrice(1234.5, "usd")).toBe("$1,234.50");
    expect(formatPrice(4.2, "eur")).toBe("€4.20");
  });

  /**
   * The whole reason `formatPrice` takes a currency rather than the caller picking a
   * formatter: one number formatted two ways is two different sentences, and the marketplace
   * setting decides which one a cell prints. Same input, two answers, no arithmetic — there
   * is no conversion anywhere in this app and this is where that shows.
   */
  it("does not convert — it only relabels the number it was given", () => {
    expect(formatPrice(10, "usd")).toBe("$10.00");
    expect(formatPrice(10, "eur")).toBe("€10.00");
  });

  /**
   * The two halves of the one rule this module exists for. **No price** is an em dash,
   * because `$0.00` is a price nobody quoted — and a card whose price genuinely *is* zero
   * (bulk commons are, in the data) has been quoted one, so it reads as one. The
   * distinction is a `=== null`, and the obvious `value ? … : "—"` gets it wrong in the
   * direction that hides a real number.
   */
  it("tells no price apart from a price of nothing, in both currencies", () => {
    expect(formatPrice(null, "usd")).toBe("—");
    expect(formatPrice(null, "eur")).toBe("—");
    expect(formatPrice(0, "usd")).toBe("$0.00");
    expect(formatPrice(0, "eur")).toBe("€0.00");
  });
});

describe("pricesAsOf", () => {
  /**
   * It names the marketplace, which is the whole reason it stopped being a constant: with
   * five in the picker, "prices as of the last sync" leaves the reader guessing whose prices
   * they are reading — and the setting exists precisely because that answer changed.
   */
  it("names the marketplace the prices came from", () => {
    expect(pricesAsOf(MARKETPLACES.tcgplayer)).toBe(
      "TCGplayer prices as of the last card-data sync.",
    );
    expect(pricesAsOf(MARKETPLACES.cardmarket)).toBe(
      "Cardmarket prices as of the last card-data sync.",
    );
  });
});
