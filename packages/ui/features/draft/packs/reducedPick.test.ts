import { describe, expect, it } from "vitest";
import { DEFAULT_PACK_REDUCTION, parseStored } from "./reducedPick";

describe("parseStored", () => {
  it("reads the figures the page kept", () => {
    expect(
      parseStored(JSON.stringify({ sellPercent: 60, minimumValue: 0.25, bulkPrice: 0.01 })),
    ).toEqual({ sellPercent: 60, minimumValue: 0.25, bulkPrice: 0.01 });
  });

  /** A device that kept its figures before issue #1477 has no bulk price, and reads as none. */
  it("reads figures kept before the bulk price as no bulk price", () => {
    expect(parseStored(JSON.stringify({ sellPercent: 60, minimumValue: 0.25 }))).toEqual({
      sellPercent: 60,
      minimumValue: 0.25,
      bulkPrice: 0,
    });
  });

  it("is no reduction for nothing, or nothing readable", () => {
    expect(parseStored(null)).toEqual(DEFAULT_PACK_REDUCTION);
    expect(parseStored("{")).toEqual(DEFAULT_PACK_REDUCTION);
    expect(parseStored("[60]")).toEqual(DEFAULT_PACK_REDUCTION);
  });

  it("puts back only the figure that is out of bounds", () => {
    expect(parseStored(JSON.stringify({ sellPercent: 140, minimumValue: 1 }))).toEqual({
      sellPercent: 100,
      minimumValue: 1,
      bulkPrice: 0,
    });
    expect(parseStored(JSON.stringify({ sellPercent: 80, minimumValue: -2 }))).toEqual({
      sellPercent: 80,
      minimumValue: 0,
      bulkPrice: 0,
    });
    expect(
      parseStored(JSON.stringify({ sellPercent: 80, minimumValue: 1, bulkPrice: "lots" })),
    ).toEqual({ sellPercent: 80, minimumValue: 1, bulkPrice: 0 });
  });
});
