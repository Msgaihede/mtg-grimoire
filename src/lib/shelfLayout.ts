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
  | { kind: "empty"; shelf: Shelf }; // a folder with no cards and no subfolders

export interface ShelfLayout {
  rows: LayoutRow[];
  tileStart: ReadonlyMap<number, number>; // shelf id → flat index of its first tile
  totalTiles: number;
  columns: number;
}

export const SHELF_HEADING_HEIGHT = 48; // 40 + 8 gap
export const SHELF_LABEL_HEIGHT = 40;
export const SHELF_EMPTY_HEIGHT = 108; // 96 + 12 gap
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
 * - An **empty** row — the dashed drop box — for a reader's folder with no cards and nothing drawn
 *   inside it. A container whose cards are all in its subfolders gets no box, and neither does Not
 *   sorted, a deck group, Recently removed or a managed folder: none of them is a thing the reader
 *   files into by dropping on an empty shelf.
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
    if (count === 0 && shelf.kind === "folder" && !holdsNext(sections, index)) {
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
