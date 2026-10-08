import { describe, expect, it } from "vitest";

import type { HomeLayout, HomeWidget } from "@/lib/ipc";

import {
  addWidget,
  bounded,
  firstFree,
  isFree,
  LAYOUT_VERSION,
  MIN_COLUMNS,
  moveWidget,
  newWidgetId,
  normalise,
  overlaps,
  parseLayout,
  patchConfig,
  removeWidget,
  resizeWidget,
  rowsUsed,
  sameGeometry,
  setConfig,
  spanFor,
  toStored,
  widgetConfig,
} from "./layout";
import { DEFAULT_LAYOUT } from "./widgets";

/** A widget at a cell, in the order a reader says it: where, then how big. */
function at(id: string, kind: string, x: number, y: number, w: number, h: number): HomeWidget {
  return { id, kind, x, y, w, h, config: null };
}

function doc(...widgets: HomeWidget[]): HomeLayout {
  return { version: 2, widgets };
}

/** Every widget as `[id, x, y, w, h]` — what a grid assertion is about, and nothing else. */
const cellsOf = (widgets: readonly HomeWidget[]) =>
  widgets.map(({ id, x, y, w, h }) => [id, x, y, w, h]);

const ids = (layout: HomeLayout): string[] => layout.widgets.map((widget) => widget.id);

function expectNoOverlaps(widgets: readonly HomeWidget[]): void {
  for (let i = 0; i < widgets.length; i += 1) {
    for (let j = i + 1; j < widgets.length; j += 1) {
      expect(overlaps(widgets[i], widgets[j]), `${widgets[i].id} × ${widgets[j].id}`).toBe(false);
    }
  }
}

/** Two widgets on an eight-column grid with room around them: `a` a 4×2 band at the top left,
 *  `b` a 3×3 panel under it. */
function pair(): HomeLayout {
  return doc(at("a", "summary", 0, 0, 4, 2), at("b", "decks", 0, 2, 3, 3));
}

// Written out rather than read off the constants' own source: a test that compared the version
// against `LAYOUT_VERSION` would move with it, and `home.rs` writes the same two numbers.
describe("the grid's constants", () => {
  it("writes version two onto a grid at least eight columns wide", () => {
    expect(LAYOUT_VERSION).toBe(2);
    expect(MIN_COLUMNS).toBe(8);
  });
});

describe("parseLayout", () => {
  it("hands back the default for anything that is not a layout", () => {
    for (const junk of [
      null,
      undefined,
      7,
      "x",
      "",
      true,
      [],
      {},
      { widgets: 7 },
      { widgets: {} },
      { version: 2 },
    ]) {
      expect(parseLayout(junk), JSON.stringify(junk) ?? "undefined").toEqual(DEFAULT_LAYOUT);
    }
  });

  it("never throws, whatever it is handed", () => {
    for (const junk of [
      Symbol("x"),
      () => 1,
      new Map(),
      NaN,
      { widgets: [Symbol("y")] },
      { widgets: [{ id: "a", kind: "decks", x: Symbol("x"), config: null }] },
    ]) {
      expect(() => parseLayout(junk)).not.toThrow();
    }
  });

  // The rule's edge, and the one a naive implementation gets wrong: "no widgets" and "no
  // document" are one value to a `?? DEFAULT_LAYOUT`, so a reader who cleared their home page
  // would be handed the defaults back on every launch, for ever. `home.rs` pins the Rust half.
  it("keeps an empty widget list rather than restoring the default", () => {
    expect(parseLayout({ version: 2, widgets: [] })).toEqual({ version: 2, widgets: [] });
    expect(parseLayout({ version: 1, widgets: [] })).toEqual({ version: 2, widgets: [] });
  });

  // An older build reading a newer build's row rearranges the widgets it knows and does not
  // quietly empty the row of the ones it does not.
  it("keeps a widget kind this build has never heard of, config and cells verbatim", () => {
    const config = { fromTheFuture: [1, 2], nested: { deep: true } };
    const parsed = parseLayout({
      version: 2,
      widgets: [{ id: "a", kind: "fromTheFuture", x: 3, y: 1, w: 5, h: 4, config }],
    });
    expect(parsed.widgets).toHaveLength(1);
    expect(parsed.widgets[0]).toMatchObject({ kind: "fromTheFuture", x: 3, y: 1, w: 5, h: 4 });
    expect(parsed.widgets[0].config).toBe(config);
  });

  // `home::stored` deliberately does not check the version on read, because defaulting over a
  // newer document loses the reader's widgets on every older build.
  it("keeps a newer document's version and its widgets", () => {
    const parsed = parseLayout({
      version: 3,
      widgets: [{ id: "a", kind: "summary", x: 2, y: 0, w: 4, h: 2, config: null }],
    });
    expect(parsed.version).toBe(3);
    expect(cellsOf(parsed.widgets)).toEqual([["a", 2, 0, 4, 2]]);
  });

  it("reads a document with no usable version at version two", () => {
    expect(parseLayout({ widgets: [] }).version).toBe(2);
    expect(parseLayout({ version: "3", widgets: [] }).version).toBe(2);
    expect(parseLayout({ version: Number.POSITIVE_INFINITY, widgets: [] }).version).toBe(2);
  });

  it("drops an entry that is not a widget rather than the whole document", () => {
    const parsed = parseLayout({
      version: 2,
      widgets: [
        { id: "", kind: "summary", x: 0, y: 0, w: 4, h: 2 },
        { id: "  ", kind: "summary", x: 0, y: 0, w: 4, h: 2 },
        { id: "a", kind: "  ", x: 0, y: 0, w: 4, h: 2 },
        { id: 7, kind: "summary", x: 0, y: 0, w: 4, h: 2 },
        { kind: "summary", x: 0, y: 0, w: 4, h: 2 },
        7,
        null,
        "x",
        [],
        { id: "keep", kind: "summary", x: 0, y: 0, w: 4, h: 2 },
      ],
    });
    expect(ids(parsed)).toEqual(["keep"]);
  });

  it("reads an absent config as null rather than dropping the widget", () => {
    const parsed = parseLayout({
      version: 2,
      widgets: [{ id: "a", kind: "summary", x: 0, y: 0, w: 4, h: 2 }],
    });
    expect(parsed.widgets[0].config).toBeNull();
  });

  // The page normalises against the grid it measures; this runs before any window has been
  // measured, so a widget stored past an eight-column grid's edge is kept where it was put.
  it("does not normalise stored cells against any column count", () => {
    const parsed = parseLayout({
      version: 2,
      widgets: [{ id: "far", kind: "decks", x: 12, y: 40, w: 4, h: 6, config: null }],
    });
    expect(cellsOf(parsed.widgets)).toEqual([["far", 12, 40, 4, 6]]);
  });

  // Each fraction sits where `round` disagrees with `floor` or with `ceil`, so a reader that
  // truncated would land on a different cell.
  it("rounds stored cells to whole numbers", () => {
    const parsed = parseLayout({
      version: 2,
      widgets: [{ id: "a", kind: "decks", x: 1.4, y: 2.6, w: 2.5, h: 3.4, config: null }],
    });
    expect(cellsOf(parsed.widgets)).toEqual([["a", 1, 3, 3, 3]]);
  });

  describe("an entry with no usable cells", () => {
    /** One `decks` entry — whose own footprint, 3×3, is none of the numbers in its junk — read
     *  alone, so it can only land at the top-left corner if it was treated as unplaced. */
    const lone = (fields: Record<string, unknown>) =>
      cellsOf(
        parseLayout({ version: 2, widgets: [{ id: "d", kind: "decks", config: null, ...fields }] })
          .widgets,
      );

    it("is placed at its kind's own footprint rather than dropped", () => {
      expect(lone({})).toEqual([["d", 0, 0, 3, 3]]);
    });

    // Partial geometry is a widget somebody half-wrote; honouring the half would place a widget
    // at a size nobody chose.
    it("treats partial or unusable cells as never placed", () => {
      for (const fields of [
        { x: 5, y: 5, w: 2 },
        { x: 5, y: 5, h: 2 },
        { y: 5, w: 2, h: 2 },
        { x: 5, w: 2, h: 2 },
        { x: 5, y: 5, w: "2", h: 2 },
        { x: -1, y: 5, w: 2, h: 2 },
        { x: 5, y: 5, w: 2, h: Number.NaN },
        { x: 5, y: 5, w: 0.4, h: 2 },
      ]) {
        expect(lone(fields), JSON.stringify(fields)).toEqual([["d", 0, 0, 3, 3]]);
      }
    });

    // `ipc.ts`: Rust answers `0` for all four cells of a version-1 widget. A `0` wide widget is
    // not a widget at the top-left corner, it is one that was never placed.
    it("treats Rust's zeroes as never placed", () => {
      expect(lone({ x: 0, y: 0, w: 0, h: 0, span: 1 })).toEqual([["d", 0, 0, 3, 3]]);
    });

    it("places a kind this build does not know at the unknown bounds' footprint", () => {
      const parsed = parseLayout({
        version: 2,
        widgets: [{ id: "u", kind: "fromTheFuture", config: null }],
      });
      expect(cellsOf(parsed.widgets)).toEqual([["u", 0, 0, 2, 2]]);
    });

    it("flows around the widgets before it that were placed", () => {
      const parsed = parseLayout({
        version: 2,
        widgets: [
          { id: "band", kind: "summary", x: 0, y: 0, w: 8, h: 2, config: null },
          { id: "d", kind: "decks", config: null },
        ],
      });
      expect(cellsOf(parsed.widgets)).toEqual([
        ["band", 0, 0, 8, 2],
        ["d", 0, 2, 3, 3],
      ]);
    });
  });

  /**
   * The upgrade from the page this build replaced.
   *
   * The fixture is the version-1 default, in Rust's own read shape (a `span`, zeroed cells). Two
   * things in it discriminate: `summary` and `folders` are `span: 2` over kinds whose own
   * footprint is four wide, so a reader that ignored the span would draw them half-width; and
   * `wishlistValue` is the first widget with nowhere to go in row two, so it only lands at
   * `(0, 5)` if every widget is placed against the ones before it in list order.
   */
  describe("a version-1 document", () => {
    const v1 = {
      version: 1,
      widgets: [
        { id: "summary", kind: "summary", x: 0, y: 0, w: 0, h: 0, span: 2, config: null },
        { id: "decks", kind: "decks", span: 1, config: { deckIds: [4] } },
        { id: "activity", kind: "activity", span: 1, config: null },
        { id: "collectionValue", kind: "collectionValue", span: 1, config: null },
        { id: "wishlistValue", kind: "wishlistValue", span: 1, config: null },
        { id: "folders", kind: "folders", span: 2, config: null },
      ],
    };

    it("is laid out in order at each kind's footprint, a span of two the whole row", () => {
      const parsed = parseLayout(v1);
      expect(cellsOf(parsed.widgets)).toEqual([
        ["summary", 0, 0, 8, 2],
        ["decks", 0, 2, 3, 3],
        ["activity", 3, 2, 3, 3],
        ["collectionValue", 6, 2, 2, 3],
        ["wishlistValue", 0, 5, 2, 3],
        ["folders", 0, 8, 8, 2],
      ]);
      expectNoOverlaps(parsed.widgets);
    });

    it("leaves at version two, carrying every widget's kind and config", () => {
      const parsed = parseLayout(v1);
      expect(parsed.version).toBe(2);
      expect(parsed.widgets.map((widget) => widget.kind)).toEqual(v1.widgets.map((w) => w.kind));
      expect(parsed.widgets[1].config).toBe(v1.widgets[1].config);
    });

    // The whole row is the narrowest grid's width *within the kind's bounds* — a kind that may
    // never be eight wide is as wide as it may be, at its own height.
    it("holds a span of two to the kind's widest", () => {
      const parsed = parseLayout({
        version: 1,
        widgets: [{ id: "d", kind: "decks", span: 2, config: null }],
      });
      expect(cellsOf(parsed.widgets)).toEqual([["d", 0, 0, 4, 3]]);
    });

    it("fits the narrowest grid once normalised, without moving a widget", () => {
      const parsed = parseLayout(v1);
      expect(sameGeometry(normalise(parsed.widgets, 8), parsed.widgets)).toBe(true);
    });
  });

  it("does not hand out the shared default object", () => {
    const parsed = parseLayout(null);
    parsed.widgets[0].x = 99;
    parsed.widgets.push(at("scribble", "summary", 0, 20, 2, 2));
    expect(DEFAULT_LAYOUT.widgets).toHaveLength(8);
    expect(DEFAULT_LAYOUT.widgets[0].x).toBe(0);
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
  });
});

describe("overlaps", () => {
  const square = { x: 2, y: 2, w: 2, h: 2 };

  it("does not count edges that only touch", () => {
    for (const other of [
      { x: 4, y: 2, w: 2, h: 2 },
      { x: 0, y: 2, w: 2, h: 2 },
      { x: 2, y: 4, w: 2, h: 2 },
      { x: 2, y: 0, w: 2, h: 2 },
      { x: 4, y: 4, w: 1, h: 1 },
    ]) {
      expect(overlaps(square, other), JSON.stringify(other)).toBe(false);
      expect(overlaps(other, square), JSON.stringify(other)).toBe(false);
    }
  });

  it("counts a single shared cell, and containment", () => {
    for (const other of [
      { x: 3, y: 3, w: 2, h: 2 },
      { x: 1, y: 1, w: 2, h: 2 },
      { x: 3, y: 3, w: 1, h: 1 },
      { x: 0, y: 0, w: 8, h: 8 },
    ]) {
      expect(overlaps(square, other), JSON.stringify(other)).toBe(true);
      expect(overlaps(other, square), JSON.stringify(other)).toBe(true);
    }
  });
});

describe("isFree", () => {
  const widgets = [
    { id: "a", x: 0, y: 0, w: 4, h: 2 },
    { id: "b", x: 4, y: 0, w: 2, h: 2 },
  ];

  it("answers yes for clear cells inside the grid, up to its right edge", () => {
    expect(isFree(widgets, { x: 6, y: 0, w: 2, h: 2 }, 8)).toBe(true);
    expect(isFree(widgets, { x: 0, y: 2, w: 8, h: 1 }, 8)).toBe(true);
  });

  it("answers no for a rectangle outside the grid", () => {
    expect(isFree(widgets, { x: 7, y: 0, w: 2, h: 2 }, 8)).toBe(false);
    expect(isFree(widgets, { x: 0, y: 2, w: 9, h: 1 }, 8)).toBe(false);
    expect(isFree(widgets, { x: -1, y: 4, w: 1, h: 1 }, 8)).toBe(false);
    expect(isFree(widgets, { x: 0, y: -1, w: 1, h: 1 }, 8)).toBe(false);
  });

  it("answers no for a rectangle with no area", () => {
    expect(isFree([], { x: 0, y: 0, w: 0, h: 1 }, 8)).toBe(false);
    expect(isFree([], { x: 0, y: 0, w: 1, h: 0 }, 8)).toBe(false);
  });

  it("answers no for cells under a widget", () => {
    expect(isFree(widgets, { x: 3, y: 1, w: 2, h: 2 }, 8)).toBe(false);
  });

  it("ignores the named widget's own cells and nobody else's", () => {
    expect(isFree(widgets, { x: 1, y: 0, w: 4, h: 2 }, 8, "a")).toBe(false);
    expect(isFree(widgets, { x: 1, y: 1, w: 3, h: 2 }, 8, "a")).toBe(true);
  });

  // `widget.id === ignoreId` alone would read an id-less rectangle as the one being ignored, since
  // both sides are `undefined` — and every cell under it would read as free.
  it("ignores nothing when no id is named, even a rectangle with no id", () => {
    expect(isFree([{ x: 0, y: 0, w: 2, h: 2 }], { x: 1, y: 1, w: 1, h: 1 }, 8)).toBe(false);
  });
});

describe("firstFree", () => {
  it("answers the top-left corner of an empty grid", () => {
    expect(firstFree([], 3, 3, 8)).toEqual({ x: 0, y: 0 });
  });

  // One occupied cell at the corner separates the two reading orders: row-major finds `(1, 0)`,
  // column-major `(0, 1)`.
  it("reads each row left to right before the row under it", () => {
    expect(firstFree([{ x: 0, y: 0, w: 1, h: 1 }], 1, 1, 8)).toEqual({ x: 1, y: 0 });
  });

  it("takes the first spot where the whole rectangle fits", () => {
    const widgets = [{ x: 0, y: 0, w: 4, h: 1 }];
    expect(firstFree(widgets, 4, 1, 8)).toEqual({ x: 4, y: 0 });
    expect(firstFree(widgets, 5, 1, 8)).toEqual({ x: 0, y: 1 });
  });

  it("checks the rectangle's height, not just its top row", () => {
    expect(firstFree([{ x: 0, y: 1, w: 8, h: 1 }], 1, 2, 8)).toEqual({ x: 0, y: 2 });
  });

  // The second widget sits deeper than the free row, so the answer cannot be the "under
  // everything" fallback a search that never fitted twelve columns into eight would fall to.
  it("places a rectangle wider than the grid at the grid's width", () => {
    const widgets = [
      { x: 7, y: 0, w: 1, h: 1 },
      { x: 0, y: 3, w: 1, h: 1 },
    ];
    expect(firstFree(widgets, 12, 2, 8)).toEqual({ x: 0, y: 1 });
  });

  it("stacks under everything when nothing near the top is free", () => {
    expect(firstFree([{ x: 0, y: 0, w: 8, h: 250 }], 1, 1, 8)).toEqual({ x: 0, y: 250 });
  });
});

describe("rowsUsed", () => {
  it("answers how far down the deepest widget reaches", () => {
    expect(rowsUsed([])).toBe(0);
    expect(
      rowsUsed([
        { x: 0, y: 4, w: 1, h: 3 },
        { x: 1, y: 0, w: 1, h: 2 },
      ]),
    ).toBe(7);
  });
});

describe("bounded", () => {
  it("keeps a footprint inside the kind's bounds as it is", () => {
    expect(bounded("decks", 3, 4, 8)).toEqual([3, 4]);
  });

  it("brings a footprint inside the kind's min and max", () => {
    expect(bounded("summary", 1, 9, 8)).toEqual([2, 3]);
    expect(bounded("decks", 9, 1, 8)).toEqual([4, 2]);
  });

  // A kind whose floor is wider than a very narrow grid still fits the grid: a widget that cannot
  // be placed at all would be a widget that vanished.
  it("lets the grid's width win over the kind's floor", () => {
    expect(bounded("summary", 8, 2, 6)).toEqual([6, 2]);
    expect(bounded("summary", 2, 2, 1)).toEqual([1, 2]);
  });

  it("rounds", () => {
    expect(bounded("decks", 2.6, 3.4, 8)).toEqual([3, 3]);
  });

  it("holds a kind this build does not know to the unknown bounds", () => {
    expect(bounded("fromTheFuture", 1, 1, 8)).toEqual([1, 1]);
    expect(bounded("fromTheFuture", 20, 20, 12)).toEqual([8, 8]);
  });
});

describe("normalise", () => {
  it("answers a layout that already fits with the same cells", () => {
    expect(normalise(DEFAULT_LAYOUT.widgets, 8)).toEqual(DEFAULT_LAYOUT.widgets);
    expect(normalise(DEFAULT_LAYOUT.widgets, 14)).toEqual(DEFAULT_LAYOUT.widgets);
  });

  it("is idempotent on a layout it had to change", () => {
    const messy = [
      at("a", "summary", 5, 0, 8, 2),
      at("b", "decks", 0, 0, 9, 1),
      at("c", "fromTheFuture", 13, 0, 3, 3),
      at("d", "activity", 1.4, -2, 3, 3),
    ];
    const once = normalise(messy, 8);
    expect(normalise(once, 8)).toEqual(once);
    expectNoOverlaps(once);
  });

  it("narrows a widget wider than the grid", () => {
    expect(cellsOf(normalise([at("a", "summary", 0, 0, 8, 2)], 6))).toEqual([["a", 0, 0, 6, 2]]);
  });

  it("pulls a widget past the right edge back inside", () => {
    expect(cellsOf(normalise([at("a", "decks", 13, 1, 2, 3)], 8))).toEqual([["a", 6, 1, 2, 3]]);
    expect(cellsOf(normalise([at("a", "folders", 6, 0, 4, 2)], 8))).toEqual([["a", 4, 0, 4, 2]]);
  });

  it("pulls a widget above or left of the grid inside it", () => {
    expect(cellsOf(normalise([at("a", "decks", -3, -2, 3, 3)], 8))).toEqual([["a", 0, 0, 3, 3]]);
  });

  it("brings a footprint inside its kind's bounds", () => {
    expect(cellsOf(normalise([at("a", "summary", 0, 0, 1, 5)], 8))).toEqual([["a", 0, 0, 2, 3]]);
    expect(cellsOf(normalise([at("a", "decks", 0, 0, 9, 9)], 8))).toEqual([["a", 0, 0, 4, 6]]);
  });

  // `fromTheFuture` at 1×1 would be floored to 2×2 by any known kind's bounds, and at 20×20 is
  // past every known kind's ceiling — only the unknown bounds answer both.
  it("holds a kind this build does not know to the unknown bounds", () => {
    expect(cellsOf(normalise([at("u", "fromTheFuture", 0, 0, 1, 1)], 8))).toEqual([
      ["u", 0, 0, 1, 1],
    ]);
    expect(cellsOf(normalise([at("u", "fromTheFuture", 0, 0, 20, 20)], 8))).toEqual([
      ["u", 0, 0, 8, 8],
    ]);
  });

  // Swapping the list order swaps which widget moves, so a normalise that moved the *earlier* one
  // — or the smaller one, or the one further right — goes red on one of the two.
  it("moves the later of two colliding widgets to the first free cell", () => {
    const band = at("band", "summary", 0, 0, 4, 2);
    const panel = at("panel", "decks", 2, 0, 3, 3);
    expect(cellsOf(normalise([band, panel], 8))).toEqual([
      ["band", 0, 0, 4, 2],
      ["panel", 4, 0, 3, 3],
    ]);
    expect(cellsOf(normalise([panel, band], 8))).toEqual([
      ["panel", 2, 0, 3, 3],
      ["band", 0, 3, 4, 2],
    ]);
  });

  // Where `b` was stored it only touches `a`'s right edge; pulled back inside the grid it covers
  // `a`, so the collision check has to run on the cells *after* the clamp.
  it("re-places a widget that only collides once it has been pulled inside", () => {
    const widgets = [at("a", "collectionValue", 4, 0, 2, 2), at("b", "folders", 6, 0, 4, 2)];
    expect(cellsOf(normalise(widgets, 8))).toEqual([
      ["a", 4, 0, 2, 2],
      ["b", 0, 0, 4, 2],
    ]);
  });

  it("carries everything but the cells through, and leaves its input alone", () => {
    const config = { title: "Mine" };
    const input: HomeWidget[] = [
      { id: "a", kind: "decks", x: 13, y: 0, w: 3, h: 3, span: 1, config },
    ];
    const [out] = normalise(input, 8);
    expect(out).toMatchObject({ id: "a", kind: "decks", span: 1 });
    expect(out.config).toBe(config);
    expect(input[0].x).toBe(13);
  });
});

describe("sameGeometry", () => {
  it("answers yes for the same widgets at the same cells", () => {
    const copy = pair().widgets.map((widget) => ({ ...widget, config: { changed: true } }));
    expect(sameGeometry(pair().widgets, copy)).toBe(true);
  });

  it("answers no for a moved or resized widget, a new order, or a different count", () => {
    const base = pair().widgets;
    expect(sameGeometry(base, [base[0], { ...base[1], x: 1 }])).toBe(false);
    expect(sameGeometry(base, [base[0], { ...base[1], y: 3 }])).toBe(false);
    expect(sameGeometry(base, [base[0], { ...base[1], w: 2 }])).toBe(false);
    expect(sameGeometry(base, [base[0], { ...base[1], h: 2 }])).toBe(false);
    expect(sameGeometry(base, [base[1], base[0]])).toBe(false);
    expect(sameGeometry(base, [base[0]])).toBe(false);
  });
});

describe("moveWidget", () => {
  it("moves one widget's corner to free cells and changes nothing else", () => {
    const moved = moveWidget(pair(), "b", 4, 0, 8);
    expect(cellsOf(moved.widgets)).toEqual([
      ["a", 0, 0, 4, 2],
      ["b", 4, 0, 3, 3],
    ]);
  });

  it("refuses cells under another widget and hands back the layout unchanged", () => {
    const before = pair();
    const refused = moveWidget(before, "b", 2, 1, 8);
    expect(refused).toEqual(pair());
    expect(refused).not.toBe(before);
  });

  it("refuses cells outside the grid", () => {
    expect(moveWidget(pair(), "b", 6, 2, 8)).toEqual(pair());
    expect(moveWidget(pair(), "b", -1, 2, 8)).toEqual(pair());
    expect(moveWidget(pair(), "b", 0, -1, 8)).toEqual(pair());
    // The same cell is free on a wider grid, so the refusal above is the column count's.
    expect(cellsOf(moveWidget(pair(), "b", 6, 2, 9).widgets)[1]).toEqual(["b", 6, 2, 3, 3]);
  });

  // A drag that ends where it began is a no-op, not a refusal — and that is observable only when
  // the move overlaps the widget's *old* cells without matching them: a move onto exactly the same
  // cells answers the same document whether it was accepted or refused.
  it("does not count the moving widget's own cells as in its way", () => {
    const nudged = moveWidget(pair(), "b", 1, 3, 8);
    expect(cellsOf(nudged.widgets)[1]).toEqual(["b", 1, 3, 3, 3]);
    expect(moveWidget(pair(), "b", 0, 2, 8)).toEqual(pair());
  });

  it("changes nothing for an id nothing carries", () => {
    expect(moveWidget(pair(), "ghost", 5, 5, 8)).toEqual(pair());
  });

  it("leaves the layout it was handed alone", () => {
    const before = pair();
    moveWidget(before, "b", 4, 0, 8);
    expect(before).toEqual(pair());
  });
});

describe("resizeWidget", () => {
  it("changes one widget's footprint and holds its corner", () => {
    const grown = resizeWidget(pair(), "b", 4, 5, 8);
    expect(cellsOf(grown.widgets)).toEqual([
      ["a", 0, 0, 4, 2],
      ["b", 0, 2, 4, 5],
    ]);
  });

  it("refuses a footprint that would cover another widget", () => {
    const before = doc(at("a", "summary", 0, 0, 4, 2), at("b", "decks", 4, 0, 3, 3));
    const refused = resizeWidget(before, "a", 5, 2, 8);
    expect(refused).toEqual(before);
    expect(refused).not.toBe(before);
  });

  it("refuses a footprint that would run past the grid's right edge", () => {
    const before = doc(at("v", "collectionValue", 6, 0, 2, 3));
    expect(resizeWidget(before, "v", 3, 3, 8)).toEqual(before);
  });

  it("brings the footprint inside the kind's bounds before placing it", () => {
    const alone = doc(at("a", "summary", 0, 0, 4, 2));
    expect(cellsOf(resizeWidget(alone, "a", 1, 9, 8).widgets)).toEqual([["a", 0, 0, 2, 3]]);
    expect(cellsOf(resizeWidget(pair(), "b", 10, 10, 8).widgets)[1]).toEqual(["b", 0, 2, 4, 6]);
  });

  it("brings the footprint inside the grid's width", () => {
    const band = doc(at("a", "summary", 0, 0, 4, 2));
    expect(cellsOf(resizeWidget(band, "a", 8, 2, 6).widgets)).toEqual([["a", 0, 0, 6, 2]]);
  });

  // Shrinking lands entirely inside the widget's old cells, so without `ignoreId` every shrink
  // would be refused — and a refusal answers a document equal to the input.
  it("does not count the widget's own cells as in its way", () => {
    expect(cellsOf(resizeWidget(pair(), "a", 3, 1, 8).widgets)[0]).toEqual(["a", 0, 0, 3, 1]);
  });

  it("changes nothing for an id nothing carries", () => {
    expect(resizeWidget(pair(), "ghost", 2, 2, 8)).toEqual(pair());
  });

  it("leaves the layout it was handed alone", () => {
    const before = pair();
    resizeWidget(before, "b", 4, 5, 8);
    expect(before).toEqual(pair());
  });
});

describe("addWidget", () => {
  it("adds an unconfigured widget at its kind's footprint in the first free cell", () => {
    const added = addWidget(doc(at("a", "summary", 0, 0, 2, 1)), "decks", 8);
    expect(added.widgets[1]).toEqual({
      id: "decks",
      kind: "decks",
      x: 2,
      y: 0,
      w: 3,
      h: 3,
      config: null,
    });
  });

  // The default fills eight by seven exactly, so the first free cell for anything is the row
  // under it — and on a wider grid it is the column beside it.
  it("finds the first free cell against every widget already placed", () => {
    const added = (cols: number) => cellsOf(addWidget(DEFAULT_LAYOUT, "decks", cols).widgets)[8];
    expect(added(8)).toEqual(["decks-2", 0, 7, 3, 3]);
    expect(added(12)).toEqual(["decks-2", 8, 0, 3, 3]);
  });

  it("bounds the footprint by the grid's width", () => {
    expect(cellsOf(addWidget(doc(), "summary", 3).widgets)).toEqual([["summary", 0, 0, 3, 2]]);
  });

  // A reader may pin two sets of decks in two `decks` widgets — the id identifies a widget, so a
  // second one of a kind is a layout to build rather than a case to refuse.
  it("mints an id that does not collide with one already placed", () => {
    const once = addWidget(doc(), "decks", 8);
    const twice = addWidget(once, "decks", 8);
    const thrice = addWidget(twice, "decks", 8);
    expect(ids(thrice)).toEqual(["decks", "decks-2", "decks-3"]);
    expect(cellsOf(thrice.widgets)).toEqual([
      ["decks", 0, 0, 3, 3],
      ["decks-2", 3, 0, 3, 3],
      ["decks-3", 0, 3, 3, 3],
    ]);
  });

  it("leaves the layout it was handed alone", () => {
    const before = pair();
    addWidget(before, "folders", 8);
    expect(before).toEqual(pair());
  });
});

describe("newWidgetId", () => {
  it("takes the kind itself when nothing has it", () => {
    expect(newWidgetId("folders", pair())).toBe("folders");
  });

  it("steps past every id already placed, however they were minted", () => {
    const layout = doc(
      at("decks", "decks", 0, 0, 2, 2),
      at("decks-2", "decks", 2, 0, 2, 2),
      at("decks-4", "decks", 4, 0, 2, 2),
    );
    expect(newWidgetId("decks", layout)).toBe("decks-3");
  });
});

describe("removeWidget", () => {
  it("removes the widget carrying the id and leaves the rest where they were", () => {
    expect(cellsOf(removeWidget(pair(), "a").widgets)).toEqual([["b", 0, 2, 3, 3]]);
  });

  it("removes nothing for an id nothing carries", () => {
    expect(removeWidget(pair(), "nope")).toEqual(pair());
  });

  it("leaves the layout it was handed alone", () => {
    const before = pair();
    removeWidget(before, "a");
    expect(before).toEqual(pair());
  });
});

describe("setConfig", () => {
  it("replaces one widget's config and no other's", () => {
    const set = setConfig(pair(), "b", { deckIds: [4, 9] });
    expect(set.widgets[1].config).toEqual({ deckIds: [4, 9] });
    expect(set.widgets[0].config).toBeNull();
  });

  it("replaces rather than merges", () => {
    const first = setConfig(pair(), "b", { deckIds: [4], stale: true });
    const second = setConfig(first, "b", { deckIds: [9] });
    expect(second.widgets[1].config).toEqual({ deckIds: [9] });
  });

  it("leaves the layout it was handed alone", () => {
    const before = pair();
    setConfig(before, "b", { deckIds: [1] });
    expect(before.widgets[1].config).toBeNull();
  });
});

describe("patchConfig", () => {
  const configured = (config: unknown): HomeLayout =>
    doc(at("a", "summary", 0, 0, 4, 2), { ...at("b", "decks", 0, 2, 3, 3), config });

  // What stops an older build deleting a newer one's settings: a key this build has no reader for
  // is still there after a write this build made.
  it("changes the named fields and keeps every other stored key", () => {
    const patched = patchConfig(
      configured({ scope: "pinned", fromTheFuture: { keep: 1 } }),
      "b",
      { density: "compact", scope: "archived" },
    );
    expect(patched.widgets[1].config).toEqual({
      scope: "archived",
      fromTheFuture: { keep: 1 },
      density: "compact",
    });
  });

  // `toEqual` reads `{ title: undefined }` as equal to `{}`, so the assertion is on the keys: a
  // patch that stored the `undefined` would pass a `toEqual` and write a blank title to the row.
  it("removes a field patched to undefined", () => {
    const patched = patchConfig(configured({ title: "Mine", scope: "pinned" }), "b", {
      title: undefined,
    });
    expect(Object.keys(patched.widgets[1].config as object)).toEqual(["scope"]);
  });

  // A spread of an array or a string is an object of its indices, so `{ ...config }` would keep
  // `0` and `1` where the fields should stand alone.
  it("replaces a config that is not an object with the fields", () => {
    for (const junk of [null, undefined, 7, "ab", [1, 2], true]) {
      const patched = patchConfig(configured(junk), "b", { density: "compact" });
      expect(patched.widgets[1].config, JSON.stringify(junk) ?? "undefined").toEqual({
        density: "compact",
      });
      expect(Object.keys(patched.widgets[1].config as object)).toEqual(["density"]);
    }
  });

  it("touches no other widget, and neither the layout nor the config it was handed", () => {
    const stored = { scope: "pinned" };
    const before = configured(stored);
    const patched = patchConfig(before, "b", { scope: undefined, art: false });
    expect(patched.widgets[0].config).toBeNull();
    expect(stored).toEqual({ scope: "pinned" });
    expect(before.widgets[1].config).toBe(stored);
  });

  it("changes nothing for an id nothing carries", () => {
    expect(patchConfig(pair(), "ghost", { title: "x" })).toEqual(pair());
  });
});

describe("widgetConfig", () => {
  const widget = (config: unknown): HomeWidget => ({ ...at("a", "decks", 0, 0, 3, 3), config });

  it("hands back the fallback for a widget that was never configured", () => {
    expect(widgetConfig(widget(null), { deckIds: [] })).toEqual({ deckIds: [] });
    expect(widgetConfig(widget(undefined), { limit: 50 })).toEqual({ limit: 50 });
  });

  it("hands back the fallback for a config of the wrong shape", () => {
    for (const junk of [7, "x", true, [], [1, 2]]) {
      expect(widgetConfig(widget(junk), { limit: 50 })).toEqual({ limit: 50 });
    }
  });

  it("hands back the stored config when it matches", () => {
    expect(widgetConfig(widget({ limit: 20 }), { limit: 50 })).toEqual({ limit: 20 });
    expect(widgetConfig(widget({ deckIds: [4, 9] }), { deckIds: [] as number[] })).toEqual({
      deckIds: [4, 9],
    });
  });

  // One bad field costs that field its stored value and nothing else, so a config written by a
  // build that spelled `limit` as a string still yields a usable object.
  it("keeps the fallback's value for a field of the wrong type", () => {
    expect(widgetConfig(widget({ limit: "20" }), { limit: 50 })).toEqual({ limit: 50 });
    expect(
      widgetConfig(widget({ collectionFolderIds: [1], wishlistFolderIds: "no" }), {
        collectionFolderIds: [] as number[],
        wishlistFolderIds: [] as number[],
      }),
    ).toEqual({ collectionFolderIds: [1], wishlistFolderIds: [] });
  });

  it("fills a field the stored config does not carry", () => {
    expect(widgetConfig(widget({ deckIds: [4] }), { deckIds: [] as number[], limit: 6 })).toEqual({
      deckIds: [4],
      limit: 6,
    });
  });

  it("checks an array's elements against the one the fallback names", () => {
    expect(widgetConfig(widget({ deckIds: ["4"] }), { deckIds: [0] })).toEqual({ deckIds: [0] });
    expect(widgetConfig(widget({ deckIds: [4, 9] }), { deckIds: [0] })).toEqual({ deckIds: [4, 9] });
  });

  it("carries through a stored key the fallback does not name", () => {
    expect(widgetConfig(widget({ limit: 20, fromTheFuture: "keep" }), { limit: 50 })).toEqual({
      limit: 20,
      fromTheFuture: "keep",
    });
  });

  it("reads a non-object fallback by shape alone", () => {
    expect(widgetConfig(widget([4, 9]), [0])).toEqual([4, 9]);
    expect(widgetConfig(widget(["4"]), [0])).toEqual([0]);
    expect(widgetConfig(widget("x"), 7)).toBe(7);
  });

  it("does not reach into the fallback it was handed", () => {
    const fallback = { deckIds: [] as number[] };
    widgetConfig(widget({ deckIds: [4] }), fallback);
    expect(fallback.deckIds).toEqual([]);
  });
});

describe("spanFor", () => {
  // Written as the boundary rather than as `MIN_COLUMNS / 2`, which is how the source spells it.
  it("answers the whole row for more than four cells and one column otherwise", () => {
    expect([1, 2, 3, 4].map(spanFor)).toEqual([1, 1, 1, 1]);
    expect([5, 6, 8, 12].map(spanFor)).toEqual([2, 2, 2, 2]);
  });
});

describe("toStored", () => {
  it("writes every widget's version-1 span from its width, over whatever it carried", () => {
    const stored = toStored(
      doc(
        { ...at("narrow", "decks", 0, 0, 4, 3), span: 2 },
        { ...at("wide", "summary", 0, 3, 5, 2), span: 1 },
        at("unset", "folders", 0, 5, 8, 2),
      ),
    );
    expect(stored.widgets.map((widget) => widget.span)).toEqual([1, 2, 2]);
  });

  it("keeps everything else, and leaves the layout it was handed alone", () => {
    const config = { title: "Mine" };
    const before: HomeLayout = { version: 3, widgets: [{ ...at("a", "decks", 1, 2, 3, 4), config }] };
    const stored = toStored(before);
    expect(stored).toEqual({
      version: 3,
      widgets: [{ id: "a", kind: "decks", x: 1, y: 2, w: 3, h: 4, span: 1, config }],
    });
    expect(before.widgets[0]).not.toHaveProperty("span");
  });
});

/**
 * `DEFAULT_LAYOUT` is a module-level object every Reset writes, so a function that answered a
 * shallow copy would let a caller's next edit rewrite the default for the rest of the session.
 * Each result is scribbled on and the default is compared against the literal `widgets.test.ts`
 * pins, taken before any of it ran.
 */
describe("nothing mutates DEFAULT_LAYOUT", () => {
  const snapshot = JSON.stringify(DEFAULT_LAYOUT);

  const scribble = (layout: HomeLayout | HomeWidget[]) => {
    const widgets = Array.isArray(layout) ? layout : layout.widgets;
    for (const widget of widgets) {
      widget.x += 50;
      widget.w = 1;
      widget.config = { scribbled: true };
    }
    widgets.push(at("scribble", "summary", 0, 90, 2, 2));
  };

  it("survives every function's result being written over", () => {
    const first = DEFAULT_LAYOUT.widgets[0].id;
    scribble(parseLayout(null));
    scribble(addWidget(DEFAULT_LAYOUT, "decks", 8));
    scribble(removeWidget(DEFAULT_LAYOUT, "decks"));
    scribble(moveWidget(DEFAULT_LAYOUT, first, 0, 0, 8));
    scribble(moveWidget(DEFAULT_LAYOUT, first, 4, 0, 8));
    scribble(moveWidget(DEFAULT_LAYOUT, "ghost", 4, 0, 8));
    scribble(resizeWidget(DEFAULT_LAYOUT, first, 3, 2, 8));
    scribble(resizeWidget(DEFAULT_LAYOUT, first, 8, 8, 8));
    scribble(setConfig(DEFAULT_LAYOUT, first, { title: "x" }));
    scribble(patchConfig(DEFAULT_LAYOUT, first, { title: "x" }));
    scribble(normalise(DEFAULT_LAYOUT.widgets, 8));
    scribble(toStored(DEFAULT_LAYOUT));
    expect(JSON.stringify(DEFAULT_LAYOUT)).toBe(snapshot);
  });
});
