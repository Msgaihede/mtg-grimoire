import { CHIN_HEIGHT, CHIN_RISE } from "@grimoire/ui/lib/cardZoom";

/**
 * The narrowest a tile is drawn.
 *
 * **141, and it is a measurement rather than a taste**: on 2026-08-29 a OnePlus in Chrome
 * reported 360 CSS px, and 141 was the widest tile that drew two columns on the wall that left.
 * A wall of card faces showing one card is half the screen as felt.
 */
export const TILE_MIN = 141;

/** Between tiles, and between rows. */
export const GAP = 12;

/** A Magic card is 5:7. */
const CARD_HEIGHT_PER_WIDTH = 7 / 5;

/** What a wall draws before anything has measured it. */
const UNMEASURED_COLUMNS = 2;

/**
 * How many tiles fit across a wall `width` px wide.
 *
 * **Zero is unmeasured, and answers two** — what jsdom reports for ever, and what the first paint
 * reports before the `ResizeObserver` fires. One column there would be a single huge tile flashed
 * on every open.
 */
export function columnsFor(width: number): number {
  if (width <= 0) return UNMEASURED_COLUMNS;
  return Math.max(1, Math.floor((width + GAP) / (TILE_MIN + GAP)));
}

/**
 * The width each tile is drawn at: the wall shared out, so the tiles reach both edges.
 *
 * The desktop wall draws an exact tile and centres the remainder, because there a wheel steps the
 * tile's size and a stretched tile makes most steps move nothing. A phone has no such gesture, so
 * the remainder is better spent on the cards.
 */
export function tileWidthFor(width: number, columns: number): number {
  if (width <= 0) return TILE_MIN;
  return (width - GAP * (columns - 1)) / columns;
}

/** One row's height: the art, the chin ridden up onto it, and the gap under it. */
export function rowHeightFor(tileWidth: number): number {
  return Math.round(tileWidth * CARD_HEIGHT_PER_WIDTH) + CHIN_HEIGHT - CHIN_RISE + GAP;
}

/**
 * The shelved wall's chrome rows, in px — the phone's own heights, never the desktop's
 * `shelfLayout.rowHeight()` (48 / 40 / 108), which are sized for a pointer and a 40px heading.
 *
 * - **A heading is 56**: a 48px control — a thumb's target, not a pointer's — and 8px above it,
 *   which is what parts one shelf's last row of cards from the next shelf's name.
 * - **A label is 40**: `ShelfLabel`'s own `h-10`, drawn as it is on the desktop.
 * - **An empty shelf is 56**: a 44px dashed box and the wall's 12px gap under it.
 */
export const SHELF_HEADING_PX = 56;
export const SHELF_LABEL_PX = 40;
export const SHELF_EMPTY_PX = 56;

/**
 * How far one level of nesting moves a heading right. **Headings only**: the tiles under a nested
 * shelf are drawn at the wall's full width, because one column count serves every shelf and a
 * phone has no width to give up to an indent — the desktop's 32px a level, three levels deep,
 * would take a 360px wall to one column. The heading's indent, its path and its heading level
 * say where the shelf sits.
 */
export const SHELF_INDENT_PX = 12;

/** One row of a shelved wall's height: its chrome's, or a row of tiles at `tileRowHeight`. */
export function shelfRowHeight(
  kind: "label" | "heading" | "tiles" | "empty",
  tileRowHeight: number,
): number {
  switch (kind) {
    case "label":
      return SHELF_LABEL_PX;
    case "heading":
      return SHELF_HEADING_PX;
    case "empty":
      return SHELF_EMPTY_PX;
    case "tiles":
      return tileRowHeight;
  }
}
