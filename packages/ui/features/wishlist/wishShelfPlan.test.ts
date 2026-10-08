import { describe, expect, it } from "vitest";
import type { ShelfCount, WishlistFolder, WishRow } from "@/lib/ipc";
import { buildFolderTree } from "@/lib/folderTree";
import { layoutShelves } from "@/lib/shelfLayout";
import type { Shelf } from "@/lib/shelves";
import {
  countTotals,
  effectiveCounts,
  fileTarget,
  foldChanges,
  foldFor,
  foldedForDrag,
  isBand,
  keepNewFolder,
  newFolderShelf,
  NEW_FOLDER_SHELF,
  rowsByShelf,
  sectionsOf,
  shelfStat,
  shelfTable,
  tileCountOf,
  toShelfFolder,
  folderFigures,
  subtotalsOf,
} from "./wishShelfPlan";

/** A shelf built by hand — `buildShelves` is what makes them in the app; this is the shape. */
const shelf = (over: Partial<Shelf> & Pick<Shelf, "id">): Shelf => ({
  kind: over.id === 0 ? "unfiled" : "folder",
  group: "own",
  name: over.id === 0 ? "Not sorted" : `F${over.id}`,
  pathIds: [over.id],
  path: [`F${over.id}`],
  depth: 0,
  indent: 0,
  lead: [],
  leadIds: [],
  headless: false,
  collapsed: false,
  locked: false,
  ...over,
});

const count = (folderId: number, tiles: number, over: Partial<ShelfCount> = {}): ShelfCount => ({
  folderId,
  tiles,
  copies: tiles,
  value: tiles * 2,
  unpriced: 0,
  peek: [],
  ...over,
});

const wish = (id: number, folderId: number | null): WishRow =>
  ({ id, folderId, name: `W${id}`, quantity: 1, unitPrice: 2 }) as WishRow;

const counts = (...rows: ShelfCount[]) => new Map(rows.map((c) => [c.folderId, c]));

describe("toShelfFolder", () => {
  const folder: WishlistFolder = {
    id: 4,
    parentId: 1,
    name: "Foils",
    sortOrder: 2,
    managedDeckId: null,
    managedTokens: false,
  };

  it("reads a reader's folder as a folder and a deck's as managed, and locks neither", () => {
    expect(toShelfFolder(folder)).toEqual({
      id: 4,
      parentId: 1,
      name: "Foils",
      sortOrder: 2,
      kind: "folder",
      locked: false,
    });
    expect(toShelfFolder({ ...folder, managedDeckId: 7 }).kind).toBe("managed");
  });
});

describe("the folder being added", () => {
  it("is a folder no row can be, filed last under its parent", () => {
    const phantom = newFolderShelf(3);
    expect(phantom.id).toBe(NEW_FOLDER_SHELF);
    expect(phantom.id).toBeLessThan(0);
    expect(phantom.parentId).toBe(3);
    expect(phantom.sortOrder).toBe(Number.MAX_SAFE_INTEGER);
    expect(phantom.kind).toBe("folder");
  });
});

describe("fileTarget", () => {
  it("files Not sorted at the root and every folder into itself", () => {
    expect(fileTarget(shelf({ id: 0 }))).toBeNull();
    expect(fileTarget(shelf({ id: 5 }))).toBe(5);
  });
});

describe("rowsByShelf", () => {
  it("groups the rows by shelf, loose ones under 0, keeping the order they arrived in", () => {
    const grouped = rowsByShelf([wish(1, null), wish(2, 5), wish(3, null)]);
    expect(grouped.get(0)?.map((w) => w.id)).toEqual([1, 3]);
    expect(grouped.get(5)?.map((w) => w.id)).toEqual([2]);
  });
});

describe("effectiveCounts", () => {
  it("is null until the counts have answered", () => {
    expect(effectiveCounts(undefined, new Map())).toBeNull();
  });

  it("never draws fewer slots than the rows already loaded, and never shrinks a larger count", () => {
    const loaded = rowsByShelf([wish(1, null), wish(2, null), wish(3, 5)]);
    const merged = effectiveCounts([count(0, 1), count(7, 9)], loaded)!;
    expect(merged.get(0)?.tiles).toBe(2);
    expect(merged.get(5)?.tiles).toBe(1);
    expect(merged.get(7)?.tiles).toBe(9);
  });
});

describe("countTotals", () => {
  it("sums every shelf, treating an unpriced shelf's value as nothing rather than as unknown", () => {
    expect(countTotals(undefined)).toBeNull();
    expect(
      countTotals([
        count(0, 2, { copies: 5, value: 10, unpriced: 1 }),
        count(3, 1, { value: null, unpriced: 1 }),
      ]),
    ).toEqual({ wishes: 3, copies: 6, value: 10, unpriced: 2 });
  });
});

describe("tileCountOf", () => {
  it("draws no slot for a shut shelf, for the folder being added, or for a shelf the counts do not know", () => {
    const known = counts(count(5, 4));
    expect(tileCountOf(shelf({ id: 5 }), known)).toBe(4);
    expect(tileCountOf(shelf({ id: 5, collapsed: true }), known)).toBe(0);
    expect(tileCountOf(shelf({ id: NEW_FOLDER_SHELF }), known)).toBe(0);
    expect(tileCountOf(shelf({ id: 6 }), known)).toBe(0);
  });

  it("maps visible shelves to sections one to one", () => {
    const sections = sectionsOf(
      [shelf({ id: 0 }), shelf({ id: 5, collapsed: true })],
      counts(count(0, 2), count(5, 3)),
    );
    expect(sections.map((s) => [s.shelf.id, s.tileCount])).toEqual([
      [0, 2],
      [5, 0],
    ]);
  });
});

describe("keepNewFolder", () => {
  /** Review Focus 4's shape seen from a field: a filter hides the shelves with no match, and the
   *  folder being added has none — it does not exist yet — so it would vanish under the reader's
   *  own caret. It is put back, with the ancestors it hangs under. */
  it("puts the folder being added back, under its ancestors, in tree order", () => {
    const all = [
      shelf({ id: 0 }),
      shelf({ id: 1 }),
      shelf({ id: 2, depth: 1, pathIds: [1, 2] }),
      shelf({ id: NEW_FOLDER_SHELF, depth: 1, pathIds: [1, NEW_FOLDER_SHELF] }),
      shelf({ id: 3 }),
    ];
    const visible = [all[0], all[4]];
    expect(keepNewFolder(all, visible).map((s) => s.id)).toEqual([0, 1, NEW_FOLDER_SHELF, 3]);
  });

  it("changes nothing when no folder is being added", () => {
    const all = [shelf({ id: 0 }), shelf({ id: 1 })];
    expect(keepNewFolder(all, [all[1]]).map((s) => s.id)).toEqual([1]);
  });
});

describe("foldedForDrag", () => {
  /** Spec §3.9: every shelf folds to its heading, so the whole tree is on screen — the nested
   *  heading of a shut parent included, which is what makes it a column of targets rather than
   *  the page with its cards hidden. Nothing about it is a stored fold. */
  it("draws every heading shut and empty, nested ones under a shut parent included", () => {
    const all = [
      shelf({ id: 0 }),
      shelf({ id: 1, collapsed: true }),
      shelf({ id: 2, depth: 1, pathIds: [1, 2] }),
    ];
    const folded = foldedForDrag(all, counts(count(0, 2), count(2, 1)), false);
    expect(folded.map((s) => [s.shelf.id, s.shelf.collapsed, s.tileCount])).toEqual([
      [0, true, 0],
      [1, true, 0],
      [2, true, 0],
    ]);
  });

  /** An empty Not sorted is on the wall before the drag (issue #597), so it stays as a heading
   *  during one rather than making every heading below it jump up by a shelf. */
  it("drops the opened folder's own headless shelf, and keeps an empty Not sorted's heading", () => {
    const all = [shelf({ id: 4, headless: true }), shelf({ id: 0 }), shelf({ id: 5 })];
    expect(foldedForDrag(all, counts(count(4, 3)), false).map((s) => s.shelf.id)).toEqual([0, 5]);
  });
});

describe("folds", () => {
  it("stores only a departure from the kind's default", () => {
    expect(foldFor(shelf({ id: 1 }), true)).toBe(true);
    expect(foldFor(shelf({ id: 1 }), false)).toBeNull();
    expect(foldFor(shelf({ id: 9, kind: "managed", group: "managed" }), false)).toBe(false);
    expect(foldFor(shelf({ id: 9, kind: "managed", group: "managed" }), true)).toBeNull();
  });

  it("writes one change per shelf below the level for Expand all and Collapse all, app-owned ones included", () => {
    const all = [
      shelf({ id: 4, headless: true }),
      shelf({ id: 0 }),
      shelf({ id: 1 }),
      shelf({ id: 9, kind: "managed", group: "managed" }),
      shelf({ id: NEW_FOLDER_SHELF }),
    ];
    expect(foldChanges(all, false)).toEqual({ "0": null, "1": null, "9": false });
    expect(foldChanges(all, true)).toEqual({ "0": true, "1": true, "9": null });
  });
});

describe("shelfStat", () => {
  const base = { currency: "usd" as const, filtering: false };
  const tree = [shelf({ id: 1 }), shelf({ id: 2, depth: 1, pathIds: [1, 2] }), shelf({ id: 0 })];

  it("reads a folder's own recursive figures, and a dash before they have answered", () => {
    const subtotal = { wishes: 6, copies: 7, cost: 312, unpriced: 1 };
    expect(shelfStat({ ...base, shelf: tree[0], shelves: tree, counts: counts(), subtotal })).toBe(
      "6 cards · $312.00 · 1 unpriced",
    );
    expect(
      shelfStat({ ...base, shelf: tree[0], shelves: tree, counts: counts(), subtotal: null }),
    ).toBe("—");
  });

  it("says a folder holding nothing in wishes alone, with no money beside it", () => {
    const subtotal = { wishes: 0, copies: 0, cost: null, unpriced: 0 };
    expect(shelfStat({ ...base, shelf: tree[0], shelves: tree, counts: counts(), subtotal })).toBe(
      "0 cards",
    );
  });

  it("reads Not sorted off its own count", () => {
    const own = counts(count(0, 5, { copies: 8, value: 163.96, unpriced: 1 }));
    expect(
      shelfStat({ ...base, shelf: tree[2], shelves: tree, counts: own, subtotal: null }),
    ).toBe("5 cards · $163.96 · 1 unpriced");
  });

  /** Spec §3.4: under a filter a heading reads `3 of 42` — the matches in it *and below it*, over
   *  its unfiltered total — so a parent whose only match is two drawers down still says so. */
  it("reads N of M under a filter, counting the matches below as well as its own", () => {
    const filtered = { ...base, filtering: true };
    const subtotal = { wishes: 42, copies: 42, cost: 10, unpriced: 0 };
    expect(
      shelfStat({
        ...filtered,
        shelf: tree[0],
        shelves: tree,
        counts: counts(count(1, 1), count(2, 2)),
        subtotal,
      }),
    ).toBe("3 of 42 cards");
    expect(
      shelfStat({
        ...filtered,
        shelf: tree[2],
        shelves: tree,
        counts: counts(count(0, 2)),
        subtotal: null,
      }),
    ).toBe("2 matching");
  });

  it("says nothing on the heading of the folder being added", () => {
    expect(
      shelfStat({
        ...base,
        shelf: shelf({ id: NEW_FOLDER_SHELF }),
        shelves: tree,
        counts: counts(),
        subtotal: null,
      }),
    ).toBe("");
  });
});

describe("shelfTable", () => {
  const managed = shelf({ id: 9, kind: "managed", group: "managed" });

  it("interleaves a band before each shelf's rows, a label before the managed group, and no band for a headless shelf", () => {
    const sections = [
      { shelf: shelf({ id: 4, headless: true }), tileCount: 1 },
      { shelf: shelf({ id: 5 }), tileCount: 1 },
      { shelf: { ...managed, collapsed: true }, tileCount: 0 },
    ];
    const rows = new Map([
      [4, [wish(1, 4)]],
      [5, [wish(2, 5)]],
    ]);
    const table = shelfTable(sections, (id) => rows.get(id) ?? [], true);
    expect(
      table.rows.map((row) =>
        isBand(row) ? `${row.band}:${row.band === "label" ? row.group : row.shelf.id}` : row.id,
      ),
    ).toEqual([1, "heading:5", 2, "label:managed", "heading:9"]);
    expect(table.owners.map((owner) => owner?.id ?? null)).toEqual([4, 5, 5, null, 9]);
    // `VirtualTable` adds the bands itself (rule 3), so `total` counts wishes only.
    expect(table.total).toBe(2);
  });

  it("marks an empty folder's band — open, no rows, and nothing nested under it — and nothing else", () => {
    const sections = [
      { shelf: shelf({ id: 1 }), tileCount: 0 },
      { shelf: shelf({ id: 2, depth: 1, pathIds: [1, 2] }), tileCount: 0 },
      { shelf: shelf({ id: 3, collapsed: true }), tileCount: 0 },
    ];
    const table = shelfTable(sections, () => [], true);
    expect(
      table.rows.map((row) =>
        isBand(row) && row.band === "heading" ? [row.shelf.id, row.empty] : null,
      ),
    ).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
  });

  /**
   * **The opened folder, empty, draws its box in the table too** (live pass §13). The level's own
   * shelf is headless — the path row names it — so there is no heading band for the box to hang
   * under, and the table drew nothing at all: an empty bordered table with no drop target, where
   * the wall drew the dashed box. It is a band of its own now, owned by the level's shelf.
   */
  it("draws the headless level's empty box as a band of its own", () => {
    const level = shelf({ id: 4, headless: true });
    const table = shelfTable([{ shelf: level, tileCount: 0 }], () => [], true);
    expect(table.rows).toEqual([{ band: "empty", shelf: level }]);
    expect(table.owners).toEqual([level]);
  });

  /**
   * **One layout, one story.** Every shelf the wall gives an empty box — `layoutShelves`' `empty`
   * rows — gets one in the table, and no other shelf does: asked over a spread of shelves (a
   * headless level, an empty folder, a container, a shut one, Not sorted and a deck's managed
   * folder), so whichever way `layoutShelves` rules on a kind, the two views rule the same way. The
   * old second copy of the rule said yes to an empty managed folder where the wall said no.
   */
  it("gives a box to exactly the shelves the wall's own layout does", () => {
    const sections = [
      { shelf: shelf({ id: 4, headless: true }), tileCount: 0 },
      { shelf: shelf({ id: 0 }), tileCount: 0 },
      { shelf: shelf({ id: 1, pathIds: [4, 1] }), tileCount: 0 },
      { shelf: shelf({ id: 2, pathIds: [4, 2] }), tileCount: 0 },
      { shelf: shelf({ id: 3, depth: 1, pathIds: [4, 2, 3] }), tileCount: 0 },
      { shelf: shelf({ id: 5, collapsed: true }), tileCount: 0 },
      { shelf: { ...managed, collapsed: false }, tileCount: 0 },
    ];
    const boxed = (ids: number[]) => [...ids].sort((a, b) => a - b);
    const wall = layoutShelves(sections, 1)
      .rows.flatMap((row) => (row.kind === "empty" ? [row.shelf.id] : []));
    const table = shelfTable(sections, () => [], true).rows.flatMap((row) =>
      isBand(row) && (row.band === "empty" || (row.band === "heading" && row.empty))
        ? [row.shelf.id]
        : [],
    );
    expect(boxed(table)).toEqual(boxed(wall));
    // The spread is not vacuous: the wall boxes the empty leaves and nothing that holds a folder.
    expect(boxed(wall)).toEqual(expect.arrayContaining([1, 3]));
    expect(wall).not.toContain(2);
    expect(wall).not.toContain(5);
  });

  it("stops at the first shelf still loading, so no band promises rows that have not arrived", () => {
    const sections = [
      { shelf: shelf({ id: 0 }), tileCount: 3 },
      { shelf: shelf({ id: 5 }), tileCount: 2 },
    ];
    const table = shelfTable(sections, (id) => (id === 0 ? [wish(1, null)] : []), false);
    expect(
      table.rows.filter(isBand).map((row) => (row.band === "heading" ? row.shelf.id : null)),
    ).toEqual([0]);
    expect(table.total).toBe(5);
  });
});

describe("subtotalsOf and folderFigures", () => {
  const folder = (id: number, parentId: number | null): WishlistFolder => ({
    id,
    parentId,
    name: `F${id}`,
    sortOrder: 0,
    managedDeckId: null,
    managedTokens: false,
  });
  const tree = buildFolderTree([folder(1, null), folder(2, 1), folder(3, null)], []);
  const subtotals = subtotalsOf(
    tree,
    new Map([
      [1, { wishes: 1, copies: 2, cost: 3, unpriced: 0 }],
      [2, { wishes: 2, copies: 2, cost: 0, unpriced: 1 }],
    ]),
  );

  it("adds a sub-folder's wishes into its parent, and an empty folder reads zero", () => {
    expect(subtotals.get(1)).toEqual({ wishes: 3, copies: 4, cost: 3, unpriced: 1 });
    expect(subtotals.get(3)).toEqual({ wishes: 0, copies: 0, cost: 0, unpriced: 0 });
  });

  it("reads a folder's recursive figures, a zero cost as no price", () => {
    expect(folderFigures({ id: 1, kind: "folder" }, subtotals)).toEqual({
      wishes: 3,
      copies: 4,
      cost: 3,
      unpriced: 1,
    });
    expect(folderFigures({ id: 2, kind: "folder" }, subtotals)?.cost).toBeNull();
  });

  it("knows nothing for Not sorted, or before the summary has answered", () => {
    expect(folderFigures({ id: 0, kind: "unfiled" }, subtotals)).toBeNull();
    expect(folderFigures({ id: 1, kind: "folder" }, null)).toBeNull();
  });
});
