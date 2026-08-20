import { describe, expect, it } from "vitest";
import { foldForFields } from "./fold";

import { transferCard as card } from "../fixtures";

describe("foldForFields", () => {
  it("sums two rows the chosen fields cannot tell apart", () => {
    const rows = [card({ quantity: 2, condition: "NM" }), card({ quantity: 1, condition: "LP" })];
    const folded = foldForFields(rows, ["quantity", "name"]);
    expect(folded).toHaveLength(1);
    expect(folded[0].quantity).toBe(3);
  });

  it("keeps them apart the moment the file can say why they are two", () => {
    const rows = [card({ quantity: 2, condition: "NM" }), card({ quantity: 1, condition: "LP" })];
    const folded = foldForFields(rows, ["quantity", "name", "condition"]);
    expect(folded).toHaveLength(2);
    expect(folded.map((c) => c.quantity)).toEqual([2, 1]);
  });

  it("never folds a foil into a regular copy when the finish is written", () => {
    const rows = [card({ quantity: 1, finish: "foil" }), card({ quantity: 1, finish: null })];
    expect(foldForFields(rows, ["quantity", "name", "finish"])).toHaveLength(2);
  });

  it("keeps first-appearance order, because the caller's order is the file's order", () => {
    const rows = [card({ name: "Sol Ring" }), card({ name: "Arcane Signet" }), card({ name: "Sol Ring" })];
    expect(foldForFields(rows, ["quantity", "name"]).map((c) => c.name)).toEqual([
      "Sol Ring",
      "Arcane Signet",
    ]);
  });

  it("sums the tradelist quantity alongside the quantity, never keying on it", () => {
    const rows = [
      card({ quantity: 2, tradelistQuantity: 1 }),
      card({ quantity: 1, tradelistQuantity: 3 }),
    ];
    const folded = foldForFields(rows, ["quantity", "name", "tradelistQuantity"]);
    expect(folded).toHaveLength(1);
    expect(folded[0].tradelistQuantity).toBe(4);
  });

  it("is a no-op on an empty list", () => {
    expect(foldForFields([], ["quantity", "name"])).toEqual([]);
  });
});
