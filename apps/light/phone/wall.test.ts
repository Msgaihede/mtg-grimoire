import { describe, expect, it } from "vitest";
import { columnsFor, GAP, rowHeightFor, TILE_MIN, tileWidthFor } from "./wall";

describe("the wall's arithmetic", () => {
  it("draws two columns on a 360px phone", () => {
    // 360 less the wall's own 12px padding each side.
    expect(columnsFor(336)).toBe(2);
  });

  it("draws two at the narrowest wall that holds two tiles", () => {
    expect(columnsFor(TILE_MIN * 2 + GAP)).toBe(2);
    expect(columnsFor(TILE_MIN * 2 + GAP - 1)).toBe(1);
  });

  it("never answers fewer than one column", () => {
    expect(columnsFor(100)).toBe(1);
  });

  it("answers two for a wall nothing has measured yet", () => {
    // Zero is what jsdom reports for ever and what the first paint reports before the observer
    // fires. One column there would flash a single huge tile on every open.
    expect(columnsFor(0)).toBe(2);
  });

  it("gains columns as the wall widens", () => {
    expect(columnsFor(600)).toBe(4);
    expect(columnsFor(1000)).toBe(6);
  });

  it("shares the wall out exactly, so the tiles reach both edges", () => {
    const columns = columnsFor(336);
    const width = tileWidthFor(336, columns);
    expect(width * columns + GAP * (columns - 1)).toBe(336);
  });

  it("falls back to the minimum tile on a wall nothing has measured", () => {
    expect(tileWidthFor(0, 2)).toBe(TILE_MIN);
  });

  it("makes a row a card, its chin and a gap", () => {
    // 162 wide → 227 of art at 5:7, a 28px chin ridden 4px up, and the 12px gap.
    expect(rowHeightFor(162)).toBe(227 + 28 - 4 + 12);
  });
});
