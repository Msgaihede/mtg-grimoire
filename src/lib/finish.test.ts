import { describe, expect, it } from "vitest";
import { finishPrice, isFinish, parseFinishes, soleFinish } from "./finish";

const PRICES = `{"usd":"5.00","usd_foil":"40.00","usd_etched":null,"eur":"4.20","tix":"0.03"}`;

describe("finishPrice", () => {
  /**
   * A lookup by finish with **no fallback of any kind**. `price_usd` — the derived column
   * — is a nonfoil→foil→etched chain built for sorting, and using it here would price a
   * plain copy at foil rates.
   */
  it("reads the key its finish is worth, and nothing else", () => {
    expect(finishPrice(PRICES, "nonfoil")).toBe(5);
    expect(finishPrice(PRICES, "foil")).toBe(40);
    expect(finishPrice(PRICES, "etched")).toBeNull();
    // A priced etched card as well as an unpriced one: with only the `null` above, a
    // `usd_etched` misspelt in `PRICE_KEY` would read as "no etched price" and pass.
    expect(finishPrice(`{"usd":"5.00","usd_etched":"71.50"}`, "etched")).toBe(71.5);
  });

  it("is null rather than zero for anything unreadable", () => {
    expect(finishPrice(null, "nonfoil")).toBeNull();
    expect(finishPrice("not json", "nonfoil")).toBeNull();
    expect(finishPrice(`{"usd":"not a number"}`, "nonfoil")).toBeNull();
  });
});

describe("parseFinishes", () => {
  it("keeps the enum and drops anything else", () => {
    expect(parseFinishes(`["nonfoil","foil","glossy"]`)).toEqual(["nonfoil", "foil"]);
    expect(parseFinishes(null)).toEqual([]);
    expect(isFinish("foil")).toBe(true);
    expect(isFinish("Foil")).toBe(false);
  });
});

describe("soleFinish", () => {
  /**
   * The mark says what the object *is*, never what it could have been. A printing sold in
   * both finishes is a choice the buyer makes rather than a property of the cardboard — and
   * 53 224 of the corpus's 107 337 paper printings have a foil version, so marking those
   * would put a sheen on 61 % of every wall.
   */
  it("is the finish when the printing leaves no choice", () => {
    expect(soleFinish(`["foil"]`)).toBe("foil");
    expect(soleFinish(`["etched"]`)).toBe("etched");
  });

  it("is null when the printing offers a choice, or says nothing", () => {
    expect(soleFinish(`["nonfoil","foil"]`)).toBeNull();
    expect(soleFinish(`["foil","etched"]`)).toBeNull();
    expect(soleFinish(null)).toBeNull();
    expect(soleFinish("not json")).toBeNull();
  });

  /** Nonfoil-only is the ordinary case and carries no mark: it is the assumed finish. */
  it("is null for a nonfoil-only printing", () => {
    expect(soleFinish(`["nonfoil"]`)).toBeNull();
  });
});
