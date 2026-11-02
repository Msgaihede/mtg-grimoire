import { describe, expect, it } from "vitest";
import { DEFAULT_COLLECTION_VALUE } from "@/lib/collectionValue";
import { parseStored } from "./reducedPick";

describe("parseStored", () => {
  it("reads the figures the page kept", () => {
    expect(parseStored(JSON.stringify({ sellPercent: 60, minimumValue: 0.25 }))).toEqual({
      sellPercent: 60,
      minimumValue: 0.25,
    });
  });

  it("is no reduction for nothing, or nothing readable", () => {
    expect(parseStored(null)).toEqual(DEFAULT_COLLECTION_VALUE);
    expect(parseStored("{")).toEqual(DEFAULT_COLLECTION_VALUE);
    expect(parseStored("[60]")).toEqual(DEFAULT_COLLECTION_VALUE);
  });

  it("puts back only the figure that is out of bounds", () => {
    expect(parseStored(JSON.stringify({ sellPercent: 140, minimumValue: 1 }))).toEqual({
      sellPercent: 100,
      minimumValue: 1,
    });
    expect(parseStored(JSON.stringify({ sellPercent: 80, minimumValue: -2 }))).toEqual({
      sellPercent: 80,
      minimumValue: 0,
    });
  });
});
