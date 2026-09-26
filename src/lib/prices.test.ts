import { describe, expect, it } from "vitest";
import { MARKETPLACES } from "./marketplace";
import {
  formatPrice,
  parsePurchasePrice,
  priceText,
  pricesAsOf,
  unreadablePriceNote,
} from "./prices";

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

  /** A lone comma before two digits is a decimal point — how most of Europe writes `2,50` — and a
   *  comma *before* a dot is grouping, which is how both of this app's formatters write a
   *  thousand. */
  it("reads a lone comma as a decimal point and a comma before a dot as grouping", () => {
    expect(parsePurchasePrice("2,50")).toBe(2.5);
    expect(parsePurchasePrice("1,234.56")).toBe(1234.56);
  });

  /**
   * **One rule for both separators, and it is read off the digits rather than off a locale.**
   * A lone comma before exactly three digits is grouping, because no real price has three
   * decimals; a lone separator before any other count of digits is a decimal part; with both
   * separators present the later one is the decimal point. Each row is a way one of the two
   * parsers this replaced got it wrong: the CSV importer stripped every comma (`4,50` → 450, a
   * Danish or German spreadsheet's whole column a hundred times over), and the box read a lone
   * comma as a decimal point (`$1,500` → 1.5). `12.5`, `4.25` and `1.2345` are the shape this
   * app's own CSV writes a price in (`String(n)`), so they have to come back as written.
   */
  it.each([
    ["4,50", 4.5],
    ["€4,50", 4.5],
    ["4,5", 4.5],
    ["0,99", 0.99],
    ["12.5", 12.5],
    ["4.25", 4.25],
    ["1.2345", 1.2345],
    ["$1,234.50", 1234.5],
    ["1.234,50", 1234.5],
    ["1 234,50", 1234.5],
    ["1,234,567", 1234567],
    ["1.234.567", 1234567],
    ["$1,500", 1500],
    ["12,000", 12000],
    ["1.234.567,89", 1234567.89],
  ])("reads %j as %d", (text, amount) => {
    expect(parsePurchasePrice(text)).toBe(amount);
  });

  /**
   * **A lone dot before exactly three digits is refused, and it is the one refusal of a
   * well-formed number.** `1.500` is fifteen hundred kroner in Danish and one and a half in this
   * app's own export of a three-decimal price, and either reading is a silent thousand-fold error
   * for somebody. A visible refusal costs one retyped box; `unreadablePriceNote` says how.
   */
  it.each(["1.500", "1.125", "$1.500"])("refuses the ambiguous %j", (text) => {
    expect(parsePurchasePrice(text)).toBeUndefined();
  });

  /** The same arm where only one reading exists — `0.125` and `1000.125` are no thousands figure
   *  anyone writes — refused all the same, because three decimals is not a price either. */
  it.each(["0.125", "1000.125"])("refuses %j, a lone dot before three digits", (text) => {
    expect(parsePurchasePrice(text)).toBeUndefined();
  });

  /**
   * **Text is stripped at the ends and never from between the digits.** A currency symbol, a
   * code or a word may sit before or after the number; between its digits only a grouping space
   * or apostrophe may, and only before a group of three. Each refused row was glued into a
   * different number when everything outside digits and separators was stripped first: `1e3` →
   * 13, `2 for 5` → 25, `10 (paid 8)` → 108, and `−4,50` — a real minus sign, U+2212 — → 4.5.
   */
  it.each([
    ["USD 4.50", 4.5],
    ["4,50 kr", 4.5],
    ["kr. 4,50", 4.5],
    ["€ 1 234,50", 1234.5],
    ["1 234,50", 1234.5],
    ["1'234.50", 1234.5],
    [".99", 0.99],
    ["12.", 12],
  ])("reads %j as %d, stripping only the ends", (text, amount) => {
    expect(parsePurchasePrice(text)).toBe(amount);
  });

  it.each(["1e3", "2 for 5", "10 (paid 8)", "−4,50", "12 5", "4.50 - 5.00"])(
    "refuses %j rather than gluing its digits together",
    (text) => {
      expect(parsePurchasePrice(text)).toBeUndefined();
    },
  );

  /**
   * **Malformed grouping is refused rather than guessed at**, because a number silently wrong is
   * worse than a field that took nothing: `1,2,3` is no grouping anyone writes, and neither is a
   * four-digit group (`1234,567`) or a first group with a leading zero (`0,500` or `0.500.000`,
   * where the thousands reading would be the thousand-fold error this rule exists to stop).
   * `undefined` means "send no price", which the edit dialog turns into a greyed Save naming the
   * trouble.
   */
  it.each(["", "abc", "1,2,3", "1,23,4", "1234,567", "0,500", "0.500.000", "1,234.5.6", "1,,5"])(
    "refuses %j",
    (text) => {
      expect(parsePurchasePrice(text)).toBeUndefined();
    },
  );

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

/** The sentence a price box draws under a refused entry — both boxes' one wording. */
describe("unreadablePriceNote", () => {
  /** Nothing to say about a blank box or a price that reads. */
  it("says nothing when there is nothing wrong", () => {
    expect(unreadablePriceNote("")).toBeNull();
    expect(unreadablePriceNote("   ")).toBeNull();
    expect(unreadablePriceNote("12.50")).toBeNull();
    expect(unreadablePriceNote("1,500")).toBeNull();
  });

  /** **The ambiguous dot names both readings**, in spellings this parser takes without a second
   *  thought and **without rounding** — `12.125` is offered back as `12.1250`, never `12.13`,
   *  so the reader retypes the one they meant rather than a nearby one. */
  it("names both readings of a lone dot before three digits, losslessly", () => {
    expect(unreadablePriceNote("1.500")).toBe(`Write 1500 or 1.50 — "1.500" could mean either.`);
    expect(unreadablePriceNote("€12.125")).toBe(
      `Write 12125 or 12.1250 — "€12.125" could mean either.`,
    );
    expect(parsePurchasePrice("12.1250")).toBe(12.125);
  });

  /** `0.125` and `1000.125` cannot be thousands figures, so they get the ordinary sentence rather
   *  than a suggestion nobody could have meant; so does everything else that will not read. */
  it("says the ordinary sentence for everything else it refuses", () => {
    for (const text of ["0.125", "1000.125", "about four fifty", "1,2,3", "-4", "1e3"]) {
      expect(unreadablePriceNote(text)).toBe("That is not a price — try 12.50.");
    }
  });
});

/** **The other direction: a stored price written back as text this parser reads exactly.** The
 *  edit box is seeded from it and the CSV writes it, so a price with exactly three decimals gets a
 *  fourth — `1.125` would be refused as ambiguous, `1.1250` is not. */
describe("priceText", () => {
  it("writes every price so that it reads back as itself", () => {
    expect(priceText(1.125)).toBe("1.1250");
    expect(priceText(0.125)).toBe("0.1250");
    expect(priceText(4.25)).toBe("4.25");
    expect(priceText(1500)).toBe("1500");
    for (const value of [0, 0.5, 0.99, 1.125, 4.25, 12.5, 1.2345, 1234.567, 1500, 1234567.89]) {
      expect(parsePurchasePrice(priceText(value))).toBe(value);
    }
  });
});
