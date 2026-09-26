import { describe, expect, it } from "vitest";
import { layoutShelves } from "@/lib/shelfLayout";
import type { Shelf } from "@/lib/shelves";
import { nextGridIndex, nextShelfTileIndex } from "./gridNav";

/**
 * A 4-column wall of 10 tiles — three rows, the last of them part-full:
 *
 * ```
 *  0  1  2  3
 *  4  5  6  7
 *  8  9
 * ```
 *
 * Nearly every case below is read off this picture, which is the whole reason this arithmetic
 * is a module of its own: jsdom measures every box at zero, so a rendered `CardGrid` is one
 * column wide and there is no such thing as a row boundary in it.
 */
const WALL = { columns: 4, count: 10 };
const move = (index: number, key: string, wall = WALL) =>
  nextGridIndex(index, key, wall.columns, wall.count);

describe("nextGridIndex", () => {
  it("steps one tile either way along a row", () => {
    expect(move(5, "ArrowRight")).toBe(6);
    expect(move(5, "ArrowLeft")).toBe(4);
  });

  it("steps a whole row either way", () => {
    expect(move(5, "ArrowDown")).toBe(9);
    expect(move(5, "ArrowUp")).toBe(1);
  });

  /**
   * **The reason left and right are not row-bounded.** A wall of search results is one list that
   * happens to be wrapped, and the reader asked for "the next card in the grid" — so the last
   * tile of a row steps to the first tile of the next, in both directions. Stopping at the edge
   * would leave them pressing Down and then Home to carry on reading.
   */
  it("carries across a row boundary rather than stopping at the edge", () => {
    expect(move(3, "ArrowRight")).toBe(4);
    expect(move(4, "ArrowLeft")).toBe(3);
  });

  /**
   * Neither end wraps. Wrapping would send a reader from the bottom of a 117 k-row browse back
   * to the top on one keypress — and `null` is what tells the caller the press was never its
   * own, so the event is left alone rather than swallowed.
   */
  it("refuses to wrap round either end of the list", () => {
    expect(move(0, "ArrowLeft")).toBeNull();
    expect(move(9, "ArrowRight")).toBeNull();
  });

  /**
   * Up and down clamp *into* the list instead of refusing, and both consequences are wanted: the
   * last row is nearly always part-full, so Down from the row above it lands on the last card;
   * and Up from the top row lands on the first, which reads as Home. A refusal would be a key
   * that works everywhere except at the edge the reader is standing at.
   */
  it("clamps a vertical move into the list rather than overshooting it", () => {
    // Index 7 is the end of the middle row; the tile under it does not exist.
    expect(move(7, "ArrowDown")).toBe(9);
    expect(move(2, "ArrowUp")).toBe(0);
  });

  /** And the same clamp, once it has nowhere left to go, is a `null` like any other. */
  it("answers nothing for a vertical move that is already against the edge", () => {
    expect(move(0, "ArrowUp")).toBeNull();
    expect(move(9, "ArrowDown")).toBeNull();
  });

  /**
   * Unhandled is not the same as handled-to-no-effect. The caller only calls `preventDefault()`
   * on an answer, so a key this module does not know keeps whatever the browser and the tile's
   * own handlers make of it — Enter opens the card, Shift+F10 opens its menu, Tab leaves.
   */
  it("takes no interest in any other key", () => {
    for (const key of ["Enter", " ", "Tab", "Home", "End", "PageDown", "a"]) {
      expect(move(5, key)).toBeNull();
    }
  });

  /**
   * **The wall jsdom draws, and the one a reader on a narrow window really gets.** At one column
   * every tile is its own row, so up and down collapse onto left and right — which is why
   * `CardGrid.test.tsx` can prove the wiring and can prove nothing about direction.
   */
  it("collapses up and down onto the list itself in a single column", () => {
    const column = { columns: 1, count: 3 };
    expect(move(1, "ArrowDown", column)).toBe(2);
    expect(move(1, "ArrowUp", column)).toBe(0);
    expect(move(2, "ArrowDown", column)).toBeNull();
  });

  /** An empty wall — a search with no matches, or a collection nobody has started. */
  it("has nowhere to send anybody on an empty wall", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect(nextGridIndex(0, key, 4, 0)).toBeNull();
    }
  });

  /**
   * The degenerate measurements a virtualised wall can really produce. `columnsFor` floors at
   * one column so the virtualiser is never handed `Infinity` rows, but this function is also
   * called with whatever a `data-grid-index` attribute parsed to — and a `NaN` reaching the
   * arithmetic would come back out of it and index the row array with it.
   */
  it("refuses a wall it has not been given honest numbers for", () => {
    expect(nextGridIndex(0, "ArrowRight", 0, 10)).toBeNull();
    expect(nextGridIndex(0, "ArrowRight", Number.NaN, 10)).toBeNull();
    expect(nextGridIndex(Number.NaN, "ArrowRight", 4, 10)).toBeNull();
  });

  /**
   * A caret on a tile the list has since dropped — a background refetch shortening the results
   * under a reader who has scrolled deep into them. The clamp is what makes that self-healing:
   * the press lands on the nearest tile that still exists rather than on `undefined`.
   */
  it("brings a caret that has fallen off the end of the list back onto it", () => {
    expect(move(40, "ArrowLeft")).toBe(9);
    expect(move(40, "ArrowUp")).toBe(9);
  });
});

type Arrow = Parameters<typeof nextShelfTileIndex>[2];

const navShelf = (id: number, over: Partial<Shelf> = {}): Shelf => ({
  id,
  kind: "folder",
  group: "own",
  name: `Folder ${id}`,
  pathIds: [id],
  path: [`Folder ${id}`],
  depth: 0,
  indent: 0,
  lead: [],
  leadIds: [],
  headless: false,
  collapsed: false,
  locked: false,
  ...over,
});

/**
 * Five shelves, four columns. B is collapsed over five cards it never fetched and C is an empty
 * folder, so between A's short last row and D's first row sit three headings and a dashed box:
 *
 *     A   0  1  2  3
 *         4  5
 *     B   (collapsed)
 *     C   (empty)
 *     D   6  7  8  9
 *        10 11 12
 *     E  13
 */
const SHELVES = layoutShelves(
  [
    { shelf: navShelf(1), tileCount: 6 },
    { shelf: navShelf(2, { collapsed: true }), tileCount: 5 },
    { shelf: navShelf(3), tileCount: 0 },
    { shelf: navShelf(4), tileCount: 7 },
    { shelf: navShelf(5), tileCount: 1 },
  ],
  4,
);

describe("nextShelfTileIndex", () => {
  it("is laid out as the picture says", () => {
    expect(SHELVES.totalTiles).toBe(14);
    expect(SHELVES.rows.map((row) => row.kind)).toEqual([
      "heading",
      "tiles",
      "tiles",
      "heading",
      "heading",
      "empty",
      "heading",
      "tiles",
      "tiles",
      "heading",
      "tiles",
    ]);
  });

  it.each<[number, Arrow, number | null]>([
    // Left and right walk the flat order, across rows and across shelves.
    [5, "ArrowRight", 6],
    [3, "ArrowRight", 4],
    [6, "ArrowLeft", 5],
    [12, "ArrowRight", 13],
    [13, "ArrowLeft", 12],
    // …and neither end wraps.
    [0, "ArrowLeft", null],
    [13, "ArrowRight", null],
    // Up and down within a shelf are a whole row.
    [1, "ArrowDown", 5],
    [5, "ArrowUp", 1],
    [7, "ArrowDown", 11],
    // Down onto a short row keeps the column where it exists and lands on the last card where not.
    [2, "ArrowDown", 5],
    [3, "ArrowDown", 5],
    [9, "ArrowDown", 12],
    // Past a shelf's last row: the next shelf's first row, stepping over the collapsed B, the
    // empty C and three headings.
    [4, "ArrowDown", 6],
    [5, "ArrowDown", 7],
    [11, "ArrowDown", 13],
    // Past a shelf's first row: the previous shelf's last row — which is short.
    [6, "ArrowUp", 4],
    [7, "ArrowUp", 5],
    [9, "ArrowUp", 5],
    [13, "ArrowUp", 10],
    // Nothing above the first row or below the last.
    [2, "ArrowUp", null],
    [13, "ArrowDown", null],
  ])("moves from tile %i on %s to %s", (from, key, to) => {
    expect(nextShelfTileIndex(SHELVES, from, key)).toBe(to);
  });

  it("walks every shelf top to bottom in a single column", () => {
    const column = layoutShelves(
      [
        { shelf: navShelf(1), tileCount: 2 },
        { shelf: navShelf(2), tileCount: 1 },
      ],
      1,
    );
    expect(nextShelfTileIndex(column, 1, "ArrowDown")).toBe(2);
    expect(nextShelfTileIndex(column, 2, "ArrowUp")).toBe(1);
  });

  it("has nowhere to send anybody on a wall of headings", () => {
    const empty = layoutShelves([{ shelf: navShelf(1, { collapsed: true }), tileCount: 4 }], 4);
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const) {
      expect(nextShelfTileIndex(empty, 0, key)).toBeNull();
    }
  });

  it("refuses an index it has not been given honestly", () => {
    expect(nextShelfTileIndex(SHELVES, Number.NaN, "ArrowRight")).toBeNull();
    expect(nextShelfTileIndex(SHELVES, 1.5, "ArrowDown")).toBeNull();
  });

  it("brings a caret that has fallen off the end back onto the wall", () => {
    expect(nextShelfTileIndex(SHELVES, 40, "ArrowLeft")).toBe(13);
    expect(nextShelfTileIndex(SHELVES, 40, "ArrowUp")).toBe(13);
  });

  /** `CardGrid` reads `KeyboardEvent.key`, a `string`, so the cast is the realistic caller. */
  it("takes no interest in a key that is not an arrow", () => {
    expect(nextShelfTileIndex(SHELVES, 5, "Enter" as Arrow)).toBeNull();
  });
});
