import { describe, expect, it } from "vitest";
import type { ShelfCount } from "./ipc";
import {
  SHELF_EMPTY_HEIGHT,
  SHELF_HEADING_HEIGHT,
  SHELF_LABEL_HEIGHT,
  layoutShelves,
  rowHeight,
  rowOfTile,
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
    ["an empty Not sorted gets no box", [section(NOT_SORTED, 0)], ["heading:0"]],
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
    expect(spell(layoutShelves(sections, 4))).toEqual([
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
