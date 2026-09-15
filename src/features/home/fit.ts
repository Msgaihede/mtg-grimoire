/**
 * The arithmetic of the square-cell grid, and of what fits inside one widget.
 *
 * **What fits is a question about pixels, never about cells**: eight columns of a 700px pane are
 * 76px each, and the same 2×2 footprint is a tile on one window and a panel on another. The page
 * measures its canvas, so every widget is told its box in pixels and cuts its lists to **whole
 * rows** against that box — half a row drawn into a clipped card reads as a broken card. The body
 * still scrolls, so an estimate a few pixels out costs a scrollbar rather than a sentence.
 *
 * **The tier is the one thing decided by cells rather than pixels**, deliberately: two cells is a
 * tile, three a panel, four or five a band, six or more the whole row. It decides *which content*
 * a card carries — a caption, a chip, a footer — and a card whose content changed as the window
 * was dragged a few pixels would read as a card that could not make up its mind.
 *
 * Nothing here touches the DOM. No `container-type` anywhere on this page: layout containment makes
 * a box the containing block for every `fixed` descendant, and these widgets open anchored popups
 * and dialogs — `HomePage.tsx`'s module doc and `features/decks/DeckStats.tsx` both say why.
 */

import type { Density } from "./widgetSettings";

/** The gap between two cells, in pixels — `gap-3`. */
export const GAP = 12;

/** The cell size the column count aims for: one more column for every `TARGET_CELL + GAP` of
 *  extra width. */
export const TARGET_CELL = 104;

/**
 * The smallest cell the grid is drawn at — eight columns of the narrowest pane this app is used at.
 * A canvas narrow enough to push a cell under this is drawn **stacked** instead (one widget per
 * row), because a Summary two 40px cells wide is not a smaller Summary but an unreadable one.
 */
export const CELL_MIN = 68;

/** The narrowest grid, in columns. `layout.ts`'s `MIN_COLUMNS`, restated to keep this file free of
 *  imports the tests would drag along. */
export const GRID_MIN_COLUMNS = 8;

/** How many columns a canvas this wide holds: at least eight, one more per ~116px beyond. */
export function columnsFor(width: number): number {
  return Math.max(GRID_MIN_COLUMNS, Math.floor((width + GAP) / (TARGET_CELL + GAP)));
}

/** One cell's size on a canvas this wide at this many columns. */
export function cellFor(width: number, cols: number): number {
  return Math.max(0, (width - GAP * (cols - 1)) / cols);
}

/** Is this canvas too narrow for the grid — should the page stack its widgets instead? */
export function isStacked(width: number): boolean {
  return width > 0 && cellFor(width, columnsFor(width)) < CELL_MIN;
}

/** The pixels `n` cells cover, gaps included. */
export function spanPx(n: number, cell: number): number {
  return n * cell + Math.max(0, n - 1) * GAP;
}

/** The pixel offset of cell `i`'s leading edge. */
export function offsetPx(i: number, cell: number): number {
  return i * (cell + GAP);
}

/** Which content a card carries, by its width in cells. See the module doc. */
export type Tier = 0 | 1 | 2 | 3;

export function tierFor(w: number): Tier {
  return w <= 2 ? 0 : w === 3 ? 1 : w <= 5 ? 2 : 3;
}

/**
 * Everything a widget body needs to know about the box it is drawn in.
 *
 * Built by the page from the widget's footprint and the measured cell ({@link makeFit}), and by
 * the catalogue from a kind's default footprint inside its preview box.
 */
export interface WidgetFit {
  /** The footprint, in cells. */
  w: number;
  h: number;
  tier: Tier;
  compact: boolean;
  /** The whole card's box, in pixels. */
  widthPx: number;
  heightPx: number;
  /** The body's inner width after the card's side padding. */
  bodyWidthPx: number;
  /** The body's height after the title row and the bottom padding. */
  bodyHeightPx: number;
  /** The gap between two rows of a list: 4px compact, 6px comfortable. */
  rowGap: number;
  /** How many columns a list of rows is laid out in — one per ~240px of card, at least one. */
  listColumns: number;
  /**
   * How many whole rows `rowH` pixels tall fit in the body after `reserved` pixels of something
   * else (a figure line, a footer). **Zero is a real answer**: a card with room for no row draws
   * none rather than one it clips.
   */
  fitCount: (rowH: number, reserved?: number) => number;
  /** {@link fitCount} with a floor of one — for a list that must say *something*. */
  linesFit: (rowH: number, reserved?: number) => number;
  /** {@link linesFit} across every list column: how many rows of a multi-column list fit. */
  rowsFit: (rowH: number, reserved?: number) => number;
}

/** `WidgetCard`'s border, on each edge. */
export const CARD_BORDER_PX = 1;

/** The title row's height: 32px on a one-cell-tall card, 40px otherwise. */
export function titleRowPx(h: number): number {
  return h === 1 ? 32 : 40;
}

/** The body's padding, on the sides and at the foot. */
export function bodyPadPx(h: number, compact: boolean): number {
  return compact || h === 1 ? 8 : 10;
}

/**
 * One widget's fit.
 *
 * @param widthPx the card's width in pixels — `spanPx(w, cell)` on the grid, the canvas's width
 * when stacked.
 * @param heightPx the card's height — `spanPx(h, cell)` on the grid.
 */
export function makeFit({
  w,
  h,
  widthPx,
  heightPx,
  density,
}: {
  w: number;
  h: number;
  widthPx: number;
  heightPx: number;
  density: Density;
}): WidgetFit {
  const compact = density === "compact";
  const pad = bodyPadPx(h, compact);
  const rowGap = compact ? 4 : 6;
  // The card's own 1px border comes off both axes before anything else does. Left out, the recent
  // cards strip measured 178.4px of content in a 177px body in the shipped window (2026-09-15) and
  // grew a vertical scrollbar over a card that fitted on paper.
  const inner = 2 * CARD_BORDER_PX;
  const bodyHeightPx = Math.max(0, heightPx - inner - titleRowPx(h) - pad);
  const bodyWidthPx = Math.max(0, widthPx - inner - 2 * pad);
  const listColumns = Math.max(1, Math.round(widthPx / 240));
  const fitCount = (rowH: number, reserved = 0) =>
    Math.max(0, Math.floor((bodyHeightPx - reserved + rowGap) / (rowH + rowGap)));
  const linesFit = (rowH: number, reserved = 0) => Math.max(1, fitCount(rowH, reserved));
  return {
    w,
    h,
    tier: tierFor(w),
    compact,
    widthPx,
    heightPx,
    bodyWidthPx,
    bodyHeightPx,
    rowGap,
    listColumns,
    fitCount,
    linesFit,
    rowsFit: (rowH, reserved) => linesFit(rowH, reserved) * listColumns,
  };
}
