import { CHIN_HEIGHT, CHIN_RISE } from "@/lib/cardZoom";

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
