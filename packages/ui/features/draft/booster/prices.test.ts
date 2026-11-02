import { describe, expect, it } from "vitest";
import type { FinishPrices } from "@/lib/ipc";
import { convertPrices, lowestPrices } from "./prices";

const at = (nonfoil: number | null, foil: number | null = null, etched: number | null = null) =>
  ({ nonfoil, foil, etched }) satisfies FinishPrices;

describe("lowestPrices", () => {
  it("takes each finish's lowest quote, where a missing quote is not free", () => {
    const a = new Map([
      ["x", at(1, 5)],
      ["y", at(null, 2)],
    ]);
    const b = new Map([
      ["x", at(2, 3)],
      ["z", at(4)],
    ]);
    expect(lowestPrices([a, b])).toEqual(
      new Map([
        ["x", at(1, 3)],
        ["y", at(null, 2)],
        ["z", at(4)],
      ]),
    );
  });

  it("never stands one marketplace's non-foil in for another's foil", () => {
    // A quotes only the non-foil; B quotes the foil. The foil is B's 6, not A's 1.
    const merged = lowestPrices([new Map([["x", at(1)]]), new Map([["x", at(null, 6)]])]);
    expect(merged.get("x")).toEqual(at(1, 6));
  });

  it("is the one answer itself when there is one", () => {
    const only = new Map([["x", at(1)]]);
    expect(lowestPrices([only])).toBe(only);
  });
});

describe("convertPrices", () => {
  it("multiplies every finish, and leaves an unquoted one unquoted", () => {
    const answer = new Map([["x", at(2, null, 4)]]);
    expect(convertPrices(answer, 1.5)).toEqual(new Map([["x", at(3, null, 6)]]));
  });

  it("is the answer itself at a factor of 1", () => {
    const answer = new Map([["x", at(2)]]);
    expect(convertPrices(answer, 1)).toBe(answer);
  });

  it("converts before the lowest is taken, so dollars and euros compare in one currency", () => {
    // $2.00 at TCGplayer against €1.90 at Cardmarket, $1.10 to the euro: €1.90 is $2.09.
    const tcg = new Map([["x", at(2, 10)]]);
    const cardmarket = new Map([["x", at(1.9, 8)]]);
    const merged = lowestPrices([tcg, convertPrices(cardmarket, 1.1)]);
    expect(merged.get("x")?.nonfoil).toBe(2);
    expect(merged.get("x")?.foil).toBeCloseTo(8.8);
  });
});
