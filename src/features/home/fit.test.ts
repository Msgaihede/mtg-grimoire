import { describe, expect, it } from "vitest";

import {
  bodyPadPx,
  CELL_MIN,
  cellFor,
  columnsFor,
  GAP,
  GRID_MIN_COLUMNS,
  isStacked,
  makeFit,
  offsetPx,
  spanPx,
  TARGET_CELL,
  tierFor,
  titleRowPx,
} from "./fit";
import { MIN_COLUMNS } from "./layout";

/**
 * Every expected number in this file is worked by hand from the pixel sizes the design draws and
 * written as a literal. Deriving one from `GAP` or `TARGET_CELL` would move the expectation with
 * the constant it exists to hold still.
 */

describe("the grid's constants", () => {
  it("draws a 12px gap, aims for 104px cells and stacks under 68px", () => {
    expect(GAP).toBe(12);
    expect(TARGET_CELL).toBe(104);
    expect(CELL_MIN).toBe(68);
  });

  // The two files restate one number so this one imports nothing; this is what keeps them one.
  it("agrees with layout.ts about the narrowest grid", () => {
    expect(GRID_MIN_COLUMNS).toBe(8);
    expect(MIN_COLUMNS).toBe(GRID_MIN_COLUMNS);
  });
});

describe("columnsFor", () => {
  it("never answers fewer than eight columns", () => {
    for (const width of [0, 1, 300, 627, 800, 1031]) {
      expect(columnsFor(width), String(width)).toBe(8);
    }
  });

  // Nine 104px cells and eight 12px gaps are 1032px. A count taken from `width / 116` alone —
  // forgetting there is one gap fewer than cells — would not reach nine until 1044.
  it("adds a column exactly when one more 104px cell and its gap fit", () => {
    expect(columnsFor(1031)).toBe(8);
    expect(columnsFor(1032)).toBe(9);
    expect(columnsFor(1147)).toBe(9);
    expect(columnsFor(1148)).toBe(10);
    expect(columnsFor(2000)).toBe(17);
  });

  it("never draws a cell under the target once the grid has grown past eight", () => {
    for (let width = 1032; width <= 3200; width += 7) {
      const cols = columnsFor(width);
      expect(cols, String(width)).toBeGreaterThan(8);
      expect(cellFor(width, cols), String(width)).toBeGreaterThanOrEqual(104);
    }
  });
});

describe("cellFor", () => {
  it("shares the width left after the gaps between the columns", () => {
    expect(cellFor(1032, 9)).toBe(104);
    expect(cellFor(628, 8)).toBe(68);
    expect(cellFor(700, 8)).toBe(77);
  });

  it("answers zero rather than a negative cell for a canvas narrower than its gaps", () => {
    expect(cellFor(50, 8)).toBe(0);
  });
});

describe("isStacked", () => {
  // 628px is exactly eight 68px cells and seven gaps: the smallest cell the grid is still drawn at.
  it("stacks a canvas whose cells would fall under 68px, and not one at exactly 68", () => {
    expect(isStacked(627)).toBe(true);
    expect(isStacked(628)).toBe(false);
    expect(isStacked(1)).toBe(true);
    expect(isStacked(1600)).toBe(false);
  });

  // Before the first measurement the width is zero, and a page that stacked for one frame and then
  // sprang into a grid would read as a page that could not make up its mind.
  it("does not stack a canvas that has not been measured", () => {
    expect(isStacked(0)).toBe(false);
  });
});

describe("spanPx and offsetPx", () => {
  it("covers n cells and the gaps between them, and no gap for one cell or none", () => {
    expect(spanPx(1, 100)).toBe(100);
    expect(spanPx(3, 100)).toBe(324);
    expect(spanPx(0, 100)).toBe(0);
  });

  it("puts cell i's leading edge after i cells and i gaps", () => {
    expect(offsetPx(0, 100)).toBe(0);
    expect(offsetPx(2, 100)).toBe(224);
  });

  // The two are one geometry: a widget `n` wide ends one gap short of where cell `n` begins.
  it("ends a span one gap before the next cell's edge", () => {
    for (const n of [1, 2, 5, 8]) {
      expect(spanPx(n, 91) + 12, String(n)).toBe(offsetPx(n, 91));
    }
  });
});

describe("tierFor", () => {
  it("reads two cells as a tile, three a panel, four or five a band, six or more the row", () => {
    expect([1, 2].map(tierFor)).toEqual([0, 0]);
    expect(tierFor(3)).toBe(1);
    expect([4, 5].map(tierFor)).toEqual([2, 2]);
    expect([6, 8, 12].map(tierFor)).toEqual([3, 3, 3]);
  });
});

describe("the card's chrome", () => {
  it("draws a shorter title row on a one-cell-tall card", () => {
    expect(titleRowPx(1)).toBe(32);
    expect([2, 3, 8].map(titleRowPx)).toEqual([40, 40, 40]);
  });

  it("pads the body 10px, or 8px when compact or one cell tall", () => {
    expect(bodyPadPx(2, false)).toBe(10);
    expect(bodyPadPx(2, true)).toBe(8);
    expect(bodyPadPx(1, false)).toBe(8);
    expect(bodyPadPx(1, true)).toBe(8);
  });
});

describe("makeFit", () => {
  /** A 3×3 card on 104px cells: 336px square. */
  const panel = (density: "comfortable" | "compact") =>
    makeFit({ w: 3, h: 3, widthPx: 336, heightPx: 336, density });

  it("measures a comfortable card's body after its title row and padding", () => {
    const fit = panel("comfortable");
    expect(fit).toMatchObject({
      w: 3,
      h: 3,
      tier: 1,
      compact: false,
      widthPx: 336,
      heightPx: 336,
      bodyWidthPx: 314,
      bodyHeightPx: 284,
      rowGap: 6,
      listColumns: 1,
    });
  });

  // Eleven 20px rows and ten 6px gaps are 280px, inside 284 (336 less two border pixels, the 40px title row and 10px of padding); a twelfth needs 306.
  it("counts whole rows, gaps between them and not after the last", () => {
    expect(panel("comfortable").fitCount(20)).toBe(11);
  });

  it("packs a compact card tighter: less padding and a 4px gap", () => {
    const fit = panel("compact");
    expect(fit).toMatchObject({ compact: true, bodyHeightPx: 286, bodyWidthPx: 318, rowGap: 4 });
    // Twelve rows and eleven gaps are 284px, inside 286; thirteen need 308.
    expect(fit.fitCount(20)).toBe(12);
  });

  // A body exactly three rows tall — 20 + 6 + 20 + 6 + 20 = 72 — has to take three. Divided without
  // the trailing gap's allowance it would take two, and one pixel less has to take two.
  it("takes a row that fits to the pixel, and not one a pixel short", () => {
    const exact = makeFit({ w: 2, h: 2, widthPx: 220, heightPx: 124, density: "comfortable" });
    expect(exact.bodyHeightPx).toBe(72);
    expect(exact.fitCount(20)).toBe(3);
    const short = makeFit({ w: 2, h: 2, widthPx: 220, heightPx: 123, density: "comfortable" });
    expect(short.fitCount(20)).toBe(2);
  });

  // Ten rows and nine gaps are 254px, exactly the 254 left after 30px of figures.
  it("takes the reserved pixels off the body first", () => {
    expect(panel("comfortable").fitCount(20, 30)).toBe(10);
    expect(panel("comfortable").linesFit(20, 30)).toBe(10);
  });

  it("uses the one-cell-tall title row and padding", () => {
    const strip = makeFit({ w: 4, h: 1, widthPx: 452, heightPx: 104, density: "comfortable" });
    expect(strip).toMatchObject({ bodyHeightPx: 62, bodyWidthPx: 434, tier: 2 });
  });

  // Zero is a real answer: a card with room for no row draws none rather than one it clips. A list
  // that must say something asks `linesFit`, which floors at one.
  it("answers zero whole rows where none fit, and linesFit one", () => {
    const tiny = makeFit({ w: 2, h: 1, widthPx: 220, heightPx: 40, density: "comfortable" });
    expect(tiny.bodyHeightPx).toBe(0);
    expect(tiny.fitCount(20)).toBe(0);
    expect(tiny.linesFit(20)).toBe(1);
    expect(panel("comfortable").fitCount(20, 500)).toBe(0);
    expect(panel("comfortable").linesFit(20, 500)).toBe(1);
  });

  it("never answers a negative body", () => {
    const squashed = makeFit({ w: 1, h: 2, widthPx: 10, heightPx: 10, density: "comfortable" });
    expect(squashed.bodyHeightPx).toBe(0);
    expect(squashed.bodyWidthPx).toBe(0);
  });

  it("lays a list out in one column per ~240px of card, and at least one", () => {
    const columns = (widthPx: number) =>
      makeFit({ w: 4, h: 3, widthPx, heightPx: 336, density: "comfortable" }).listColumns;
    expect(columns(100)).toBe(1);
    expect(columns(359)).toBe(1);
    expect(columns(360)).toBe(2);
    expect(columns(720)).toBe(3);
  });

  it("counts rows across every list column, with linesFit's floor in each", () => {
    const wide = makeFit({ w: 6, h: 3, widthPx: 720, heightPx: 336, density: "comfortable" });
    expect(wide.rowsFit(20)).toBe(33);
    expect(wide.rowsFit(20, 30)).toBe(30);
    expect(wide.rowsFit(20, 500)).toBe(3);
  });
});
