/**
 * The shelves as rows of a virtualised wall — which row is a heading, which is a run of tiles,
 * how tall each one is, which row a tile lands in and which shelf a row belongs to.
 *
 * **A row of tiles belongs to one shelf, and two shelves never share a row.** A shelf's last row
 * is short when its count is not a multiple of the column count, and the next shelf starts on a
 * row of its own under its own heading. That is what lets a heading be placed **before any card
 * has arrived** (spec §5.2): the rows are a function of the per-shelf counts and the column count
 * alone, so the page lays the whole wall out from `collection_shelf_counts` and a tile whose page
 * of results has not landed is drawn as an empty frame in a slot that is already the right size.
 *
 * Pure, for `gridNav.ts`'s reason: jsdom lays nothing out, so a rendered wall is one column wide
 * and every claim about a short row or a row boundary has to be made on a function that takes the
 * column count as an argument. `shelfLayout.test.ts` is where those claims live.
 *
 * **A layout is a value.** Nothing here mutates one after {@link layoutShelves} returns it, and
 * {@link rowOfTile} caches an index against the object — a caller that edited `rows` in place
 * would be answered from the old one. Build a new layout instead; it is cheap.
 */

import type { Shelf, ShelfGroup } from "./shelves";

export interface ShelfSection {
  shelf: Shelf;
  tileCount: number;
}

export type LayoutRow =
  | { kind: "label"; group: Exclude<ShelfGroup, "own"> }
  | { kind: "heading"; shelf: Shelf }
  // [start, end) in the flat tile order
  | { kind: "tiles"; shelf: Shelf; start: number; end: number }
  | { kind: "empty"; shelf: Shelf }; // an open folder or managed folder with no cards or subfolders

export interface ShelfLayout {
  rows: LayoutRow[];
  tileStart: ReadonlyMap<number, number>; // shelf id → flat index of its first tile
  totalTiles: number;
  columns: number;
}

export const SHELF_HEADING_HEIGHT = 48; // 40 + 8 gap
export const SHELF_LABEL_HEIGHT = 40;
export const SHELF_EMPTY_HEIGHT = 108; // 96 + 12 gap
/**
 * The sticky bar's height — the strip at the top of a sectioned wall that names the shelf the
 * reader is scrolled inside. **The one number for it**: `ShelfStickyBar` is sized from this as an
 * inline height, with no `h-*` class of its own (`ShelfStickyBar.test.tsx` pins both), and the grid
 * reserves the same number as the virtualiser's scroll padding at the start, so a row a reveal or
 * an arrow walk aligns to the top lands under the bar's bottom edge rather than behind it (final
 * review S-M2).
 */
export const SHELF_STICKY_HEIGHT = 36;
/** Indent per level, and where a level's 1px rail sits inside it — one pair for every wall (grid and tables). */
export const SHELF_INDENT_PX = 32;
export const SHELF_RAIL_OFFSET_PX = 11;

type TileRow = Extract<LayoutRow, { kind: "tiles" }>;

/**
 * Whether the section after `index` is drawn **inside** this one — the one fact that tells a
 * folder that is a pure container (`Aerith upgrades` over `Mana base`) from a folder that is
 * genuinely empty. Sections arrive depth-first, so a shelf's descendants follow it directly; a
 * descendant carries this shelf's id in its `pathIds`. The headless shelf is the level itself,
 * which is in nobody's `pathIds`, and everything after it is under the level by construction.
 */
function holdsNext(sections: readonly ShelfSection[], index: number): boolean {
  if (index + 1 >= sections.length) return false;
  const here = sections[index].shelf;
  return here.headless || sections[index + 1].shelf.pathIds.includes(here.id);
}

/**
 * The wall's rows, top to bottom.
 *
 * - A **label** (`Decks`, `Managed by decks`) before the first shelf of each app-owned group.
 * - Each shelf's **heading** — except the headless shelf, whose folder the path row names.
 * - Its **tiles**, `columns` to a row, from that shelf only; the last row may be short.
 * - An **empty** row for an open shelf with no cards and nothing drawn inside it — a reader's
 *   folder or Not sorted, where it is the dashed drop box, or a deck's **managed** wishlist
 *   folder, where it is the box that says the folder's mode sentence (live-pass FAIL 13,
 *   2026-09-26: the grid drew nothing there while the table said it). **The row is a place, not a
 *   target**: what it draws, and whether it takes a drop, is the page's `renderEmpty` — a managed
 *   folder is app-owned and takes none. A container whose cards are all in its subfolders gets no
 *   box, and neither does a deck group or Recently removed. Not sorted joined the reader's folders
 *   with issue #597, when `visibleShelves` stopped hiding it empty: a bare open heading over the
 *   next one reads as a shelf that failed to load, and the box is what says "drop cards here".
 * - A **collapsed** shelf is its heading alone. Its `tileCount` is ignored, because its cards are
 *   never fetched; it still gets a `tileStart`, at the running index, so every section has one.
 *
 * `columns` below one (a wall measured before its `ResizeObserver` answered) lays out as one
 * column, `columnsFor`'s floor; a `tileCount` that is not a positive number is none.
 */
export function layoutShelves(sections: readonly ShelfSection[], columns: number): ShelfLayout {
  const perRow = Number.isFinite(columns) && columns >= 1 ? Math.floor(columns) : 1;
  const rows: LayoutRow[] = [];
  const tileStart = new Map<number, number>();
  let total = 0;
  let group: ShelfGroup | null = null;

  for (let index = 0; index < sections.length; index++) {
    const { shelf, tileCount } = sections[index];
    if (shelf.group !== group) {
      if (shelf.group !== "own") rows.push({ kind: "label", group: shelf.group });
      group = shelf.group;
    }
    if (!shelf.headless) rows.push({ kind: "heading", shelf });
    tileStart.set(shelf.id, total);
    if (shelf.collapsed) continue;

    const count = Number.isFinite(tileCount) && tileCount > 0 ? Math.floor(tileCount) : 0;
    for (let offset = 0; offset < count; offset += perRow) {
      const end = Math.min(offset + perRow, count);
      rows.push({ kind: "tiles", shelf, start: total + offset, end: total + end });
    }
    if (
      count === 0 &&
      (shelf.kind === "folder" || shelf.kind === "unfiled" || shelf.kind === "managed") &&
      !holdsNext(sections, index)
    ) {
      rows.push({ kind: "empty", shelf });
    }
    total += count;
  }

  return { rows, tileStart, totalTiles: total, columns: perRow };
}

/** A row's height in px. Headings, labels and the empty box are chrome and keep their size under
 *  Ctrl+wheel zoom; a row of tiles is whatever the wall's tile size makes it. */
export function rowHeight(row: LayoutRow, tileRowHeight: number): number {
  switch (row.kind) {
    case "label":
      return SHELF_LABEL_HEIGHT;
    case "heading":
      return SHELF_HEADING_HEIGHT;
    case "empty":
      return SHELF_EMPTY_HEIGHT;
    case "tiles":
      return tileRowHeight;
  }
}

/**
 * Where row `index` starts, in px below the wall's first row: every row above it at its own
 * {@link rowHeight}, tile rows at `tileRowHeight`. `-1` for a row the layout does not have.
 *
 * The same sum the virtualiser makes from the same heights, so a caller can place a row — the
 * fold anchor's carried heading (spec §3.9) — without it being drawn, which during a drag it very
 * often is not, and without reading the DOM, where a carried heading is a floating copy at the
 * pointer rather than its slot in the wall.
 */
export function rowStartOf(layout: ShelfLayout, index: number, tileRowHeight: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= layout.rows.length) return -1;
  let start = 0;
  for (let at = 0; at < index; at++) start += rowHeight(layout.rows[at], tileRowHeight);
  return start;
}

/**
 * How tall the wall's rows are, top to bottom — every row at its own {@link rowHeight}, tile rows at
 * `tileRowHeight`. {@link rowStartOf}'s sum carried past the last row, which is where the wall's
 * own content ends.
 */
export function layoutHeight(layout: ShelfLayout, tileRowHeight: number): number {
  let height = 0;
  for (const row of layout.rows) height += rowHeight(row, tileRowHeight);
  return height;
}

/** What {@link anchorPlan} is given — all in px, in the scroller's own coordinates. */
export interface AnchorInput {
  /** The row's top in the scroll content, measured without any room this plan adds. */
  rowTop: number;
  /** Where the row's top must appear, measured down from the top of the scrollport. */
  target: number;
  /** The scrollport's height. */
  viewport: number;
  /**
   * The scroll content's height — and what it has to be depends on `room`, so read this before
   * "fixing" a caller that passes the page with its room still on.
   *
   * - **`room: true`**: the page **without** any room already added. Too small is safe here: the
   *   plan only adds room it did not strictly need, and the row still lands.
   * - **`room: false`**: an **upper bound** is enough, and the page with its room still on is the
   *   one the caller has. It scrolls to this plan's offset only after the room is gone, so the
   *   browser makes the final clamp against the real page. Subtracting the room here instead is
   *   wrong once a stretched row has swallowed some of it (see {@link anchorPlan}): the figure
   *   comes out too small, the clamp below lands early, and the Escape from a short page stopped
   *   hundreds of pixels short of where the page could go.
   */
  content: number;
  /**
   * Where the wall's own rows end in the scroll content, without room — which is where room added
   * below them starts to count. Defaults to `content`, for a wall that is the whole of its
   * scroller's content. See {@link anchorPlan} for the page where it is not.
   */
  end?: number;
  /** Whether temporary room may be added — a folded wall's, never the real page's. */
  room: boolean;
}

/** The scroll offset, and the room above (`padStart`) and below (`padEnd`) it needs. */
export interface AnchorPlan {
  scrollTop: number;
  padStart: number;
  padEnd: number;
}

/**
 * **Where to scroll so a row's top lands at `target`** — the fold anchor's arithmetic (spec §3.9).
 *
 * The offset it takes is `rowTop − target`. A page cannot scroll above its top or past its end,
 * and a folded wall is short, so that offset is often out of reach: the live pass measured a
 * collection wall of 1210px with its clamp at 222, a heading that needed the page *above* the top
 * (the pointer 402px below where the heading could reach), and one that needed 126 while the clamp
 * set 222. **With `room`, the gap is added as temporary space instead** — above the wall when the
 * row must sit lower than the page's top allows, below it when the wall ends too soon — so the row
 * lands exactly where it is wanted; the unfold asks again without room and the space goes. Without
 * `room` (the real page) the offset is clamped to `content` — which there may be an upper bound, the
 * page with its room still on (see {@link AnchorInput.content}), so this clamp is only a ceiling.
 * What makes it as close as the page allows is the caller scrolling after the room is gone, where
 * the browser's own end is the last clamp.
 *
 * **Room below is measured from the wall's own `end`, never from the page's** (the final re-check's
 * finding A, 2026-09-27). Both pages draw the wall in a flex row beside the docked search column,
 * which is as tall as the scrollport — so a folded wall shorter than the dock sits in a row the
 * dock decides (766px of folded wishlist in a 988px row), and room added below the wall grows the
 * wall inside that row without moving the page's end at all. The room is therefore whatever makes
 * **the wall's own rows** reach the bottom of the scrollport at the offset wanted: that holds
 * whatever stretches around the wall, and where nothing does it overshoots by only what the page
 * draws under the wall — blank space the unfold takes away with the rest.
 *
 * Room is rounded **up** to whole pixels, so the offset it was added for is always inside the page.
 */
export function anchorPlan({
  rowTop,
  target,
  viewport,
  content,
  end = content,
  room,
}: AnchorInput): AnchorPlan {
  const wanted = rowTop - target;
  const most = Math.max(0, content - viewport);
  if (wanted < 0) {
    return room
      ? { scrollTop: 0, padStart: Math.ceil(-wanted), padEnd: 0 }
      : { scrollTop: 0, padStart: 0, padEnd: 0 };
  }
  if (wanted > most) {
    const below = Math.max(wanted - most, wanted + viewport - end);
    return room
      ? { scrollTop: wanted, padStart: 0, padEnd: Math.ceil(below) }
      : { scrollTop: most, padStart: 0, padEnd: 0 };
  }
  return { scrollTop: wanted, padStart: 0, padEnd: 0 };
}

/** The row index of every tile row, in order — built once per layout, on first ask. */
const tileRowIndex = new WeakMap<ShelfLayout, readonly number[]>();

function tileRowsOf(layout: ShelfLayout): readonly number[] {
  let index = tileRowIndex.get(layout);
  if (index === undefined) {
    index = layout.rows.flatMap((row, at) => (row.kind === "tiles" ? [at] : []));
    tileRowIndex.set(layout, index);
  }
  return index;
}

/**
 * The row a tile is drawn in, or `-1` for an index the layout does not hold — a caret left on a
 * tile a refetch dropped, or a `NaN` off a DOM attribute. A binary search over the tile rows,
 * which are in tile order by construction.
 */
export function rowOfTile(layout: ShelfLayout, tileIndex: number): number {
  if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= layout.totalTiles) return -1;
  const index = tileRowsOf(layout);
  let low = 0;
  let high = index.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const row = layout.rows[index[middle]] as TileRow;
    if (tileIndex < row.start) high = middle - 1;
    else if (tileIndex >= row.end) low = middle + 1;
    else return index[middle];
  }
  return -1;
}

/**
 * The shelf a row belongs to — what the sticky bar names when this row is at the top of the wall.
 *
 * A heading, a run of tiles and an empty box each belong to their shelf. **A label belongs to the
 * shelf it introduces**, which is always the heading directly under it: the reader scrolled to
 * `Decks` is looking at the deck groups, and a bar that went blank for the label's 40px would
 * flicker on every pass over it. `null` only for a row the layout does not have.
 */
export function shelfAtRow(layout: ShelfLayout, rowIndex: number): Shelf | null {
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= layout.rows.length) return null;
  const row = layout.rows[rowIndex];
  if (row.kind !== "label") return row.shelf;
  const next = rowIndex + 1 < layout.rows.length ? layout.rows[rowIndex + 1] : null;
  return next !== null && next.kind !== "label" ? next.shelf : null;
}
