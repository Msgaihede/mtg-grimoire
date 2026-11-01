import { describe, expect, it } from "vitest";
import type { FinishPrices } from "@/lib/ipc";
import { lowestPrices } from "./prices";

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
