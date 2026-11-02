import { describe, expect, it } from "vitest";
import { SET } from "../booster/fixture";
import { openableMatches, openables } from "./products";

/** The names of the fixture's products that `query` keeps, in the picker's order. */
const kept = (query: string) =>
  openables(SET)
    .filter((o) => openableMatches(o, query))
    .map((o) => o.name);

describe("openableMatches", () => {
  it("keeps every product on a blank query", () => {
    expect(kept("")).toHaveLength(4);
    expect(kept("   ")).toHaveLength(4);
  });

  it("matches every word, in any order, case-insensitively", () => {
    expect(kept("collector")).toEqual(["Test Collector Booster"]);
    expect(kept("BOX play")).toEqual(["Test Play Booster Box"]);
    expect(kept("play  booster")).toEqual(["Test Play Booster", "Test Play Booster Box"]);
    expect(kept("collector box")).toEqual([]);
  });

  it("finds a product by its kind and its sealed category", () => {
    expect(kept("sealed")).toEqual(["Test Play Booster Box", "Test Bundle"]);
    // "booster box" is the box's category in words, and the bundle's category is "bundle".
    expect(kept("sealed bundle")).toEqual(["Test Bundle"]);
  });
});
