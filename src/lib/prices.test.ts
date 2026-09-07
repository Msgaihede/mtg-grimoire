import { describe, expect, it } from "vitest";
import { MARKETPLACES } from "./marketplace";
import { formatPrice, parsePurchasePrice, pricesAsOf } from "./prices";

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

/**
 * The other half of `formatPrice`'s contract: what a reader may type back in.
 *
 * Both purchase-price boxes show a formatted figure — the add popup as its placeholder, the edit
 * dialog as the box's seeded value — so the strings in the first test below are not invented
 * inputs. They are `formatPrice`'s **own output**, which is the case that has to work and the
 * reason this function lives in this file rather than beside either box.
 */
describe("parsePurchasePrice", () => {
  /** Round-tripped through the formatter rather than hand-written, so this cannot drift into
   *  asserting a shape `formatPrice` has stopped producing. */
  it("reads back what this module writes, in both currencies", () => {
    expect(parsePurchasePrice(formatPrice(2.5, "usd"))).toBe(2.5);
    expect(parsePurchasePrice(formatPrice(1234.56, "usd"))).toBe(1234.56);
    expect(parsePurchasePrice(formatPrice(2.5, "eur"))).toBe(2.5);
    expect(parsePurchasePrice(formatPrice(1234.56, "eur"))).toBe(1234.56);
  });

  /** A lone comma is a decimal point — how most of Europe writes `2,50` — and a comma *before* a
   *  dot is grouping, which is how both of this app's formatters write a thousand. */
  it("reads a lone comma as a decimal point and a comma before a dot as grouping", () => {
    expect(parsePurchasePrice("2,50")).toBe(2.5);
    expect(parsePurchasePrice("1,234.56")).toBe(1234.56);
  });

  /**
   * The one input this refuses rather than guesses, and the reason it is a refusal.
   *
   * German writes `1.234,56`. Stripping the dots the way the grouping rule does would record
   * `1.23456` — a fifth of a cent, silently, against a card the reader believes they paid twelve
   * hundred for. `undefined` means "send no price", which the edit dialog turns into a greyed
   * Save naming the trouble rather than a write of nothing.
   */
  it("refuses a dot-grouped decimal comma instead of guessing at it", () => {
    expect(parsePurchasePrice("1.234,56")).toBeUndefined();
  });

  /** Blank, a word and a negative are all the same answer: say nothing. A price the reader did
   *  not state must never reach a `coalesce` as a number. */
  it("says nothing for a box that holds no price", () => {
    expect(parsePurchasePrice("")).toBeUndefined();
    expect(parsePurchasePrice("   ")).toBeUndefined();
    expect(parsePurchasePrice("free")).toBeUndefined();
    expect(parsePurchasePrice("-4")).toBeUndefined();
  });

  /** **A typed `0` is a real answer and is not folded into the silence above.** "It was free" is
   *  a fact about a copy — a prize, a gift, a card out of somebody's spare box — and the reader
   *  had to press a key to say it. `??` rather than `||` downstream is what keeps it. */
  it("sends a typed zero, because free is something the reader said", () => {
    expect(parsePurchasePrice("0")).toBe(0);
    expect(parsePurchasePrice("$0.00")).toBe(0);
  });
});
