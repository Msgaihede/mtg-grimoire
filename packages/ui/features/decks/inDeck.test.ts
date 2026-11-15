import { describe, expect, it } from "vitest";
import { inDeckByOracle } from "./inDeck";

describe("inDeckByOracle", () => {
  it("sums copies of one card across printings and piles", () => {
    const counts = inDeckByOracle([
      { oracleId: "o-bolt", quantity: 2 },
      { oracleId: "o-bolt", quantity: 1 },
      { oracleId: "o-path", quantity: 1 },
    ]);
    expect(counts.get("o-bolt")).toBe(3);
    expect(counts.get("o-path")).toBe(1);
  });

  it("skips orphans and empty rows", () => {
    const counts = inDeckByOracle([
      { oracleId: null, quantity: 4 },
      { oracleId: "o-bolt", quantity: 0 },
    ]);
    expect(counts.size).toBe(0);
  });
});
