import { describe, expect, it } from "vitest";
import type { ShelfCount } from "./ipc";
import {
  SHELF_EMPTY_HEIGHT,
  SHELF_HEADING_HEIGHT,
  SHELF_LABEL_HEIGHT,
  anchorPlan,
  layoutHeight,
  layoutShelves,
  rowHeight,
  rowOfTile,
  rowStartOf,
  shelfAtRow,
  type LayoutRow,
  type ShelfLayout,
  type ShelfSection,
} from "./shelfLayout";
import { buildShelves, visibleShelves, type Shelf, type ShelfFolder } from "./shelves";

const shelf = (id: number, over: Partial<Shelf> = {}): Shelf => ({
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

/** A shelf filed directly inside `parent`, one level deeper. */
const inside = (parent: Shelf, id: number, over: Partial<Shelf> = {}): Shelf =>
  shelf(id, {
    pathIds: [...parent.pathIds, id],
    path: [...parent.path, `Folder ${id}`],
    depth: parent.depth + 1,
    indent: Math.min(parent.depth + 1, 3),
    ...over,
  });

const section = (s: Shelf, tileCount: number): ShelfSection => ({ shelf: s, tileCount });

/** Each row as one short word, so a whole layout reads as one line of a truth table. */
const spell = (layout: ShelfLayout) =>
  layout.rows.map((row) =>
    row.kind === "label"
      ? `label:${row.group}`
      : row.kind === "tiles"
        ? `tiles:${row.shelf.id}:${row.start}-${row.end}`
        : `${row.kind}:${row.shelf.id}`,
  );

const NOT_SORTED = shelf(0, { kind: "unfiled", name: "Not sorted", path: ["Not sorted"] });
const BINDER = shelf(1);

describe("layoutShelves", () => {
  /**
   * Not sorted holds 3 and Binder 6, four to a row. Not sorted's row is short and Binder does not
   * fill it: two shelves never share a row, so Binder's heading always starts a line.
   */
  it("draws each shelf as a heading over rows of its own tiles, the last row short", () => {
    const layout = layoutShelves([section(NOT_SORTED, 3), section(BINDER, 6)], 4);
    expect(spell(layout)).toEqual([
      "heading:0",
      "tiles:0:0-3",
      "heading:1",
      "tiles:1:3-7",
      "tiles:1:7-9",
    ]);
    expect(layout.totalTiles).toBe(9);
    expect([...layout.tileStart]).toEqual([
      [0, 0],
      [1, 3],
    ]);
    expect(layout.columns).toBe(4);
  });

  it("draws a headless shelf's tiles with no heading above them", () => {
    const level = shelf(5, { headless: true });
    const sub = shelf(6);
    expect(spell(layoutShelves([section(level, 2), section(sub, 3)], 4))).toEqual([
      "tiles:5:0-2",
      "heading:6",
      "tiles:6:2-5",
    ]);
  });

  it("draws a collapsed shelf as its heading alone and gives it no tiles", () => {
    const shut = shelf(1, { collapsed: true });
    const layout = layoutShelves([section(shut, 12), section(shelf(2), 3)], 4);
    expect(spell(layout)).toEqual(["heading:1", "heading:2", "tiles:2:0-3"]);
    expect(layout.totalTiles).toBe(3);
    expect([...layout.tileStart]).toEqual([
      [1, 0],
      [2, 0],
    ]);
  });

  const parent = shelf(1);
  it.each<[string, ShelfSection[], string[]]>([
    [
      "a reader's folder with no cards and no subfolders gets the empty box",
      [section(parent, 0)],
      ["heading:1", "empty:1"],
    ],
    [
      // Review Focus 2: `Aerith upgrades` over `Mana base` — a container, not an empty folder.
      "a folder whose cards are all in a subfolder gets no box",
      [section(parent, 0), section(inside(parent, 2), 2)],
      ["heading:1", "heading:2", "tiles:2:0-2"],
    ],
    [
      "a folder over a collapsed subfolder is still a container",
      [section(parent, 0), section(inside(parent, 2, { collapsed: true }), 5)],
      ["heading:1", "heading:2"],
    ],
    [
      "a sibling after an empty folder is not inside it",
      [section(parent, 0), section(shelf(3), 2)],
      ["heading:1", "empty:1", "heading:3", "tiles:3:0-2"],
    ],
    [
      "an empty subfolder followed by its parent's sibling gets the box",
      [section(parent, 1), section(inside(parent, 2), 0), section(shelf(3), 1)],
      ["heading:1", "tiles:1:0-1", "heading:2", "empty:2", "heading:3", "tiles:3:1-2"],
    ],
    [
      // Issue #597: an empty Not sorted is drawn so a card can be dragged back to the root, and
      // the dashed box is what says so — the same drop box an empty folder draws.
      "an open, empty Not sorted gets the box",
      [section(NOT_SORTED, 0), section(shelf(1), 2)],
      ["heading:0", "empty:0", "heading:1", "tiles:1:0-2"],
    ],
    [
      "a collapsed, empty Not sorted is its heading alone",
      [section({ ...NOT_SORTED, collapsed: true }, 0)],
      ["heading:0"],
    ],
    [
      "an empty deck group gets no box",
      [section(shelf(20, { kind: "deck", group: "decks" }), 0)],
      ["label:decks", "heading:20"],
    ],
    [
      "a collapsed empty folder is its heading alone",
      [section(shelf(1, { collapsed: true }), 0)],
      ["heading:1"],
    ],
    [
      // Live-pass FAIL 13 (2026-09-26): an open managed shelf with nothing in it drew nothing
      // under its heading in the grid, while the table said its mode's sentence. The box is the
      // row both views draw that sentence in; the page decides it takes no drops.
      "an open, empty managed shelf gets the box",
      [section(shelf(10, { kind: "managed", group: "managed" }), 0)],
      ["label:managed", "heading:10", "empty:10"],
    ],
    [
      "a collapsed empty managed shelf is its heading alone",
      [section(shelf(10, { kind: "managed", group: "managed", collapsed: true }), 0)],
      ["label:managed", "heading:10"],
    ],
    [
      "an empty Recently removed gets no box",
      [section(shelf(30, { kind: "removed", group: "decks" }), 0)],
      ["label:decks", "heading:30"],
    ],
    [
      "an opened folder with nothing in it is the box alone",
      [section(shelf(5, { headless: true }), 0)],
      ["empty:5"],
    ],
    [
      // The subfolder of an opened folder is at depth 0, like the headless shelf itself — the
      // box is decided by what is inside, not by depth.
      "an opened folder whose cards are all in its subfolders gets no box",
      [section(shelf(5, { headless: true }), 0), section(shelf(6), 1)],
      ["heading:6", "tiles:6:0-1"],
    ],
  ])("%s", (_name, sections, rows) => {
    expect(spell(layoutShelves(sections, 4))).toEqual(rows);
  });

  it("opens each app-owned group with its label, once", () => {
    const decks = [20, 21, 22].map((id) =>
      shelf(id, { kind: id === 22 ? "removed" : "deck", group: "decks", collapsed: true }),
    );
    expect(
      spell(layoutShelves([section(BINDER, 1), ...decks.map((d) => section(d, 4))], 4)),
    ).toEqual([
      "heading:1",
      "tiles:1:0-1",
      "label:decks",
      "heading:20",
      "heading:21",
      "heading:22",
    ]);
    const managed = shelf(10, { kind: "managed", group: "managed" });
    expect(spell(layoutShelves([section(BINDER, 0), section(managed, 2)], 4))).toEqual([
      "heading:1",
      "empty:1",
      "label:managed",
      "heading:10",
      "tiles:10:0-2",
    ]);
  });

  it("draws no label for a group a filter has emptied", () => {
    expect(spell(layoutShelves([section(BINDER, 2)], 4))).toEqual(["heading:1", "tiles:1:0-2"]);
  });

  it("lays out a wall measured before its width is known as one column", () => {
    expect(layoutShelves([section(BINDER, 2)], 0).columns).toBe(1);
    expect(layoutShelves([section(BINDER, 2)], Number.NaN).columns).toBe(1);
    expect(spell(layoutShelves([section(BINDER, 5)], 3.7))).toEqual([
      "heading:1",
      "tiles:1:0-3",
      "tiles:1:3-5",
    ]);
  });

  it("reads a tile count that is not a positive number as none", () => {
    const layout = layoutShelves([section(BINDER, -3), section(shelf(2), Number.NaN)], 4);
    expect(spell(layout)).toEqual(["heading:1", "empty:1", "heading:2", "empty:2"]);
    expect(layout.totalTiles).toBe(0);
  });

  it("lays out nothing as nothing", () => {
    const layout = layoutShelves([], 4);
    expect(layout.rows).toEqual([]);
    expect(layout.totalTiles).toBe(0);
    expect(layout.tileStart.size).toBe(0);
  });

  /** The whole path for Review Focus 2, built from folders and counts the way a page does it. */
  it("keeps a container's heading over its subfolder's cards, with no box, end to end", () => {
    const folders: ShelfFolder[] = [
      {
        id: 1,
        parentId: null,
        name: "Aerith upgrades",
        sortOrder: 0,
        kind: "folder",
        locked: false,
      },
      { id: 2, parentId: 1, name: "Mana base", sortOrder: 0, kind: "folder", locked: false },
    ];
    const counts = new Map<number, ShelfCount>([
      [2, { folderId: 2, tiles: 7, copies: 9, value: 373.03, unpriced: 0, peek: [] }],
    ]);
    const shelves = buildShelves({ folders, levelId: null, folds: {}, filtering: false });
    const sections = visibleShelves(shelves, counts, false).map((s) =>
      section(s, counts.get(s.id)?.tiles ?? 0),
    );
    // Nothing is loose, so Not sorted is its drop box (issue #597); the container gets none.
    expect(spell(layoutShelves(sections, 4))).toEqual([
      "heading:0",
      "empty:0",
      "heading:1",
      "heading:2",
      "tiles:2:0-4",
      "tiles:2:4-7",
    ]);
  });
});

describe("rowHeight", () => {
  const binder = shelf(1);
  it.each<[LayoutRow["kind"], number, LayoutRow]>([
    ["label", SHELF_LABEL_HEIGHT, { kind: "label", group: "decks" }],
    ["heading", SHELF_HEADING_HEIGHT, { kind: "heading", shelf: binder }],
    ["empty", SHELF_EMPTY_HEIGHT, { kind: "empty", shelf: binder }],
    ["tiles", 312, { kind: "tiles", shelf: binder, start: 0, end: 4 }],
  ])("sizes a %s row at %i px", (_kind, height, row) => {
    expect(rowHeight(row, 312)).toBe(height);
  });

  it("pins the chrome sizes the grid estimates rows by", () => {
    expect([SHELF_HEADING_HEIGHT, SHELF_LABEL_HEIGHT, SHELF_EMPTY_HEIGHT]).toEqual([48, 40, 108]);
  });
});

describe("rowOfTile and shelfAtRow", () => {
  // heading:0 | tiles 0-3 | heading:1 | tiles 3-7 | tiles 7-9
  // label | heading:20 (collapsed) | heading:21 | tiles 9-11
  const deck = (id: number, collapsed: boolean) =>
    shelf(id, { kind: "deck", group: "decks", collapsed });
  const layout = layoutShelves(
    [
      section(NOT_SORTED, 3),
      section(BINDER, 6),
      section(deck(20, true), 8),
      section(deck(21, false), 2),
    ],
    4,
  );

  it("is laid out as the table above says", () => {
    expect(spell(layout)).toEqual([
      "heading:0",
      "tiles:0:0-3",
      "heading:1",
      "tiles:1:3-7",
      "tiles:1:7-9",
      "label:decks",
      "heading:20",
      "heading:21",
      "tiles:21:9-11",
    ]);
  });

  it.each<[number, number]>([
    [0, 1],
    [2, 1],
    [3, 3],
    [6, 3],
    [7, 4],
    [8, 4],
    [9, 8],
    [10, 8],
  ])("finds tile %i in row %i", (tile, row) => {
    expect(rowOfTile(layout, tile)).toBe(row);
  });

  it("finds no row for a tile the layout does not hold", () => {
    for (const tile of [-1, 11, 40, 1.5, Number.NaN]) expect(rowOfTile(layout, tile)).toBe(-1);
  });

  it.each<[number, number | null]>([
    [0, 0],
    [1, 0],
    [2, 1],
    [4, 1],
    [5, 20], // the Decks label belongs to the shelf it introduces
    [6, 20],
    [7, 21],
    [8, 21],
  ])("names row %i's shelf as %s", (row, id) => {
    expect(shelfAtRow(layout, row)?.id ?? null).toBe(id);
  });

  it("names no shelf for a row the layout does not have", () => {
    for (const row of [-1, 9, Number.NaN]) expect(shelfAtRow(layout, row)).toBeNull();
  });
});

describe("rowStartOf", () => {
  /** A label, a heading, two tile rows, an empty box and a heading — every row kind once. */
  const DECK = shelf(40, { kind: "deck", group: "decks" });
  const layout = layoutShelves(
    [section(BINDER, 3), section(shelf(2), 0), section(DECK, 0)],
    2,
  );

  it("adds up every row above it at its own height, tiles at the pitch it is given", () => {
    expect(spell(layout)).toEqual([
      "heading:1",
      "tiles:1:0-2",
      "tiles:1:2-3",
      "heading:2",
      "empty:2",
      "label:decks",
      "heading:40",
    ]);
    const pitch = 250;
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => rowStartOf(layout, i, pitch))).toEqual([
      0,
      SHELF_HEADING_HEIGHT,
      SHELF_HEADING_HEIGHT + pitch,
      SHELF_HEADING_HEIGHT + 2 * pitch,
      2 * SHELF_HEADING_HEIGHT + 2 * pitch,
      2 * SHELF_HEADING_HEIGHT + 2 * pitch + SHELF_EMPTY_HEIGHT,
      2 * SHELF_HEADING_HEIGHT + 2 * pitch + SHELF_EMPTY_HEIGHT + SHELF_LABEL_HEIGHT,
    ]);
  });

  it("has no start for a row the layout does not have", () => {
    for (const row of [-1, 7, 1.5, Number.NaN]) expect(rowStartOf(layout, row, 250)).toBe(-1);
  });

  it("carries the sum past the last row for the wall's whole height", () => {
    expect(layoutHeight(layout, 250)).toBe(rowStartOf(layout, 6, 250) + SHELF_HEADING_HEIGHT);
    expect(layoutHeight(layoutShelves([], 2), 250)).toBe(0);
  });
});

/**
 * **The fold anchor's arithmetic** (spec §3.9) — which scroll offset puts a row's top at a given
 * point of the scrollport, and how much temporary room above or below makes that offset reachable.
 * `rowTop` is measured without any room already added. So is `content` when the plan may add room;
 * when it may not, `content` may be an upper bound (see `AnchorInput.content`).
 */
describe("anchorPlan", () => {
  const VIEW = 600;

  it("scrolls by the difference when the offset it needs is reachable", () => {
    expect(anchorPlan({ rowTop: 900, target: 300, viewport: VIEW, content: 3000, room: true }))
      .toEqual({ scrollTop: 600, padStart: 0, padEnd: 0 });
  });

  /** The live pass's collection case: 126 was needed and 222 was set. */
  it("stops where it is needed, not at the wall's end", () => {
    const content = 222 + VIEW;
    expect(anchorPlan({ rowTop: 400, target: 274, viewport: VIEW, content, room: true }))
      .toEqual({ scrollTop: 126, padStart: 0, padEnd: 0 });
  });

  it("adds room above when the row would have to sit lower than the top of the page allows", () => {
    // Heading 196px down a folded wall, the pointer at 598: 402px of room above it.
    expect(anchorPlan({ rowTop: 196, target: 598, viewport: VIEW, content: 1210, room: true }))
      .toEqual({ scrollTop: 0, padStart: 402, padEnd: 0 });
  });

  it("adds room below when the wall ends before the row can rise that far", () => {
    // 1210px of folded wall: the most it scrolls is 610, and the row needs 900.
    expect(anchorPlan({ rowTop: 1150, target: 250, viewport: VIEW, content: 1210, room: true }))
      .toEqual({ scrollTop: 900, padStart: 0, padEnd: 290 });
  });

  /**
   * **The live re-check's finding A**: 576px of folded wall, 150px below the page's top, in a row a
   * 988px dock stretches — so the page is 1162px whatever the wall does, and the first 262px of
   * room below the wall only fill that row. Measured from the page's end the room was 28px and the
   * row swallowed it; measured from the wall's own end (726), it reaches past the row.
   */
  it("measures room below from the wall's own end when the page runs on past it", () => {
    const page = { rowTop: 630, target: 40, viewport: VIEW, content: 1162, room: true };
    expect(anchorPlan({ ...page, end: 150 + 576 })).toEqual({
      scrollTop: 590,
      padStart: 0,
      padEnd: 590 + VIEW - 726,
    });
    // A wall that is all of its page's content, `end`'s default, is the page's end.
    expect(anchorPlan(page)).toEqual({ scrollTop: 590, padStart: 0, padEnd: 28 });
  });

  /** An unfolded wall is the real page: the plan clamps to `content`. The caller may pass the page
   *  with its room still on, so this clamp is only a ceiling. It scrolls after the room is gone, and
   *  the browser's own end makes the last clamp. */
  it("clamps instead, at both ends, when no room may be added", () => {
    expect(anchorPlan({ rowTop: 196, target: 598, viewport: VIEW, content: 1210, room: false }))
      .toEqual({ scrollTop: 0, padStart: 0, padEnd: 0 });
    expect(anchorPlan({ rowTop: 1150, target: 250, viewport: VIEW, content: 1210, room: false }))
      .toEqual({ scrollTop: 610, padStart: 0, padEnd: 0 });
  });

  it("never scrolls a page shorter than its window", () => {
    expect(anchorPlan({ rowTop: 300, target: 100, viewport: VIEW, content: 400, room: false }))
      .toEqual({ scrollTop: 0, padStart: 0, padEnd: 0 });
  });

  it("rounds room up to whole pixels, so the offset it needs is always inside the page", () => {
    expect(anchorPlan({ rowTop: 100.4, target: 300, viewport: VIEW, content: 1000, room: true }))
      .toEqual({ scrollTop: 0, padStart: 200, padEnd: 0 });
  });
});
