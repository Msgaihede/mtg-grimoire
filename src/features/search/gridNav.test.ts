import { describe, expect, it } from "vitest";
import { nextGridIndex } from "./gridNav";

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
