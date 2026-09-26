import { describe, expect, it } from "vitest";
import type { ShelfCount } from "./ipc";
import {
  MAX_SHELF_INDENT,
  UNFILED_SHELF,
  buildShelves,
  defaultCollapsed,
  shelvesToCount,
  shelvesToFetch,
  visibleShelves,
  type BuildShelvesInput,
  type Shelf,
  type ShelfFolder,
  type ShelfKind,
} from "./shelves";

const folder = (
  id: number,
  parentId: number | null,
  name: string,
  over: Partial<ShelfFolder> = {},
): ShelfFolder => ({ id, parentId, name, sortOrder: 0, kind: "folder", locked: false, ...over });

/**
 * The collection the canvas draws, with the app's own folders given ids in an order their names
 * do not share — so a test that passes because the list came back in id order cannot pass here.
 *
 *     Binder (1)
 *       Staples (2)
 *         Fetchlands (3)
 *         Shocklands (4)
 *       Trade binder (5)        sortOrder 1
 *     Display case (6)          sortOrder 1
 *     Shoebox (7)               sortOrder 2
 *     deck groups: Modern Goodstuff (20), Kenrith Two-Drops (21, sortOrder 5), Zombies (23)
 *     Recently removed (22)
 */
const CABINET: readonly ShelfFolder[] = [
  folder(7, null, "Shoebox", { sortOrder: 2 }),
  folder(6, null, "Display case", { sortOrder: 1 }),
  folder(5, 1, "Trade binder", { sortOrder: 1 }),
  folder(4, 2, "Shocklands"),
  folder(3, 2, "Fetchlands"),
  folder(2, 1, "Staples"),
  folder(1, null, "Binder"),
  folder(20, null, "Modern Goodstuff", { kind: "deck" }),
  folder(21, null, "Kenrith Two-Drops", { kind: "deck", sortOrder: 5 }),
  folder(22, null, "Recently removed", { kind: "removed" }),
  folder(23, null, "Zombies", { kind: "deck" }),
];

const build = (folders: readonly ShelfFolder[], over: Partial<BuildShelvesInput> = {}) =>
  buildShelves({ folders, levelId: null, folds: {}, filtering: false, ...over });

const ids = (shelves: readonly Shelf[]) => shelves.map((shelf) => shelf.id);
const byId = (shelves: readonly Shelf[], id: number) => {
  const found = shelves.find((shelf) => shelf.id === id);
  if (found === undefined) throw new Error(`no shelf ${id}`);
  return found;
};

const count = (folderId: number, tiles = 1): ShelfCount => ({
  folderId,
  tiles,
  copies: tiles,
  value: null,
  unpriced: 0,
  peek: [],
});
const countsOf = (...rows: ShelfCount[]) => new Map(rows.map((row) => [row.folderId, row]));

describe("defaultCollapsed", () => {
  it.each<[ShelfKind, boolean]>([
    ["unfiled", false],
    ["folder", false],
    ["deck", true],
    ["removed", true],
    ["managed", true],
  ])("%s starts collapsed: %s", (kind, collapsed) => {
    expect(defaultCollapsed(kind)).toBe(collapsed);
  });
});

describe("buildShelves at the root", () => {
  /**
   * Not sorted first, the reader's folders depth-first with a shelf before its subfolders', then
   * the deck groups **by name** — not by id, and not by a `sortOrder` nobody can set on one — and
   * Recently removed last although `R` sorts before `Z`.
   */
  it("draws Not sorted, the reader's tree depth-first, then the decks, removed last", () => {
    expect(ids(build(CABINET))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 21, 20, 23, 22]);
  });

  it("orders siblings by sortOrder, then by name, then by id", () => {
    const shelves = build([
      folder(1, null, "Zoo", { sortOrder: 1 }),
      folder(4, null, "Burn", { sortOrder: 1 }),
      folder(2, null, "Burn", { sortOrder: 1 }),
      folder(3, null, "Aggro", { sortOrder: 0 }),
    ]);
    expect(ids(shelves)).toEqual([0, 3, 2, 4, 1]);
  });

  it("names the unfiled shelf Not sorted and gives it no lead, no lock and no fold", () => {
    expect(build([])).toEqual([
      {
        id: UNFILED_SHELF,
        kind: "unfiled",
        group: "own",
        name: "Not sorted",
        pathIds: [UNFILED_SHELF],
        path: ["Not sorted"],
        depth: 0,
        indent: 0,
        lead: [],
        leadIds: [],
        headless: false,
        collapsed: false,
        locked: false,
      },
    ]);
  });

  it("files the deck groups and Recently removed under the decks group, and nothing else", () => {
    const groups = build(CABINET).map((shelf) => [shelf.id, shelf.group]);
    expect(groups).toEqual([
      [0, "own"],
      [1, "own"],
      [2, "own"],
      [3, "own"],
      [4, "own"],
      [5, "own"],
      [6, "own"],
      [7, "own"],
      [21, "decks"],
      [20, "decks"],
      [23, "decks"],
      [22, "decks"],
    ]);
  });

  it("draws the wishlist's managed folders last, by name, under the managed group", () => {
    const shelves = build([
      folder(1, null, "Ordered"),
      folder(2, 1, "Backordered"),
      folder(10, null, "Yuriko upgrades", { kind: "managed" }),
      folder(11, null, "Atraxa upgrades", { kind: "managed" }),
    ]);
    expect(shelves.map((shelf) => [shelf.id, shelf.group])).toEqual([
      [0, "own"],
      [1, "own"],
      [2, "own"],
      [11, "managed"],
      [10, "managed"],
    ]);
  });

  /** `buildFolderTree`'s rule, kept: a folder whose parent is gone is drawn at the root rather
   *  than dropped with its cards still in it. */
  it("draws a folder whose parent is missing at the root", () => {
    const orphan = byId(build([folder(5, 99, "Orphan")]), 5);
    expect(orphan.depth).toBe(0);
    expect(orphan.pathIds).toEqual([5]);
  });

  /** `locked` is the effective lock `lockedFolderIds` computed on the page — copied, never
   *  re-derived here, so the inheritance is written in exactly one place. */
  it("copies each folder's lock as it was given", () => {
    const shelves = build([folder(1, null, "Trade", { locked: true }), folder(2, 1, "Foils")]);
    expect(byId(shelves, 1).locked).toBe(true);
    expect(byId(shelves, 2).locked).toBe(false);
    expect(byId(shelves, UNFILED_SHELF).locked).toBe(false);
  });
});

describe("buildShelves depth, indent and lead", () => {
  /** One chain six deep under the root: Binder › Staples › Lands › Fetchlands › Foils › Showcase
   *  › Etched. */
  const CHAIN: readonly ShelfFolder[] = [
    folder(1, null, "Binder"),
    folder(2, 1, "Staples"),
    folder(3, 2, "Lands"),
    folder(4, 3, "Fetchlands"),
    folder(5, 4, "Foils"),
    folder(6, 5, "Showcase"),
    folder(7, 6, "Etched"),
  ];

  /** Down to the cap the lead is the whole chain; below it the lead starts at the ancestor on the
   *  cap — `Fetchlands › Foils › Showcase`, spec §3.3's own example. */
  it.each<[string, number, number, number, string[], number[]]>([
    ["Binder", 0, 0, 1, [], []],
    ["Staples", 1, 1, 2, ["Binder"], [1]],
    ["Lands", 2, 2, 3, ["Binder", "Staples"], [1, 2]],
    ["Fetchlands", 3, 3, 4, ["Binder", "Staples", "Lands"], [1, 2, 3]],
    ["Foils", 4, 3, 5, ["Fetchlands"], [4]],
    ["Showcase", 5, 3, 6, ["Fetchlands", "Foils"], [4, 5]],
    ["Etched", 6, 3, 7, ["Fetchlands", "Foils", "Showcase"], [4, 5, 6]],
  ])("draws %s at depth %i, indent %i", (_name, depth, indent, id, lead, leadIds) => {
    const shelf = byId(build(CHAIN), id);
    expect(shelf.depth).toBe(depth);
    expect(shelf.indent).toBe(indent);
    expect(shelf.indent).toBeLessThanOrEqual(MAX_SHELF_INDENT);
    expect(shelf.lead).toEqual(lead);
    expect(shelf.leadIds).toEqual(leadIds);
  });

  it("keeps the whole path from the level whatever the lead shows", () => {
    const showcase = byId(build(CHAIN), 6);
    expect(showcase.pathIds).toEqual([1, 2, 3, 4, 5, 6]);
    expect(showcase.path).toEqual([
      "Binder",
      "Staples",
      "Lands",
      "Fetchlands",
      "Foils",
      "Showcase",
    ]);
  });

  /** Spec §3.3: opening a folder is the reader's escape from a deep chain, because depth starts
   *  again under the level. */
  it("starts depth, indent and lead again under an opened folder", () => {
    const shelves = build(CHAIN, { levelId: 3 });
    expect(ids(shelves)).toEqual([3, 4, 5, 6, 7]);
    expect(byId(shelves, 4)).toMatchObject({ depth: 0, indent: 0, lead: [], pathIds: [4] });
    expect(byId(shelves, 6)).toMatchObject({
      depth: 2,
      indent: 2,
      lead: ["Fetchlands", "Foils"],
      leadIds: [4, 5],
      pathIds: [4, 5, 6],
    });
  });
});

describe("buildShelves inside an opened folder", () => {
  it("draws the level's own cards headless, then its subfolders, and no app-owned group", () => {
    const shelves = build(CABINET, { levelId: 1 });
    expect(ids(shelves)).toEqual([1, 2, 3, 4, 5]);
    expect(shelves[0]).toEqual({
      id: 1,
      kind: "folder",
      group: "own",
      name: "Binder",
      pathIds: [1],
      path: ["Binder"],
      depth: 0,
      indent: 0,
      lead: [],
      leadIds: [],
      headless: true,
      collapsed: false,
      locked: false,
    });
    expect(shelves.slice(1).map((shelf) => [shelf.id, shelf.depth])).toEqual([
      [2, 0],
      [3, 1],
      [4, 1],
      [5, 0],
    ]);
  });

  /** A deck group opens exactly as a pinned entry does today — and inside it, it is the level,
   *  so it is drawn headless and open, not shut under a Decks label. */
  it("opens a deck group as a headless level, open and under no label", () => {
    const [shelf] = build(CABINET, { levelId: 20 });
    expect(shelf).toMatchObject({
      id: 20,
      kind: "deck",
      group: "own",
      headless: true,
      collapsed: false,
    });
  });

  /** A folder collapsed at the root has no chevron once it is the level, so a stored fold must
   *  never shut its own cards away. */
  it("never collapses the headless shelf, whatever the stored fold says", () => {
    const shelves = build(CABINET, { levelId: 1, folds: { "1": true } });
    expect(shelves[0].collapsed).toBe(false);
    expect(shelvesToFetch(shelves)).toEqual([1, 2, 3, 4, 5]);
  });

  it("answers no shelves for a level that no longer exists", () => {
    expect(build(CABINET, { levelId: 999 })).toEqual([]);
  });
});

describe("collapse", () => {
  it("starts deck groups and Recently removed shut and everything else open", () => {
    const shelves = build(CABINET);
    expect(shelves.filter((shelf) => shelf.collapsed).map((shelf) => shelf.id)).toEqual([
      21, 20, 23, 22,
    ]);
  });

  it("takes a stored fold over the default in either direction, Not sorted included", () => {
    const shelves = build(CABINET, { folds: { "20": false, "2": true, "0": true } });
    expect(byId(shelves, 20).collapsed).toBe(false);
    expect(byId(shelves, 2).collapsed).toBe(true);
    expect(byId(shelves, UNFILED_SHELF).collapsed).toBe(true);
  });

  it("opens every shelf while a filter is active", () => {
    const shelves = build(CABINET, { folds: { "2": true, "0": true }, filtering: true });
    expect(shelves.every((shelf) => !shelf.collapsed)).toBe(true);
  });

  /** Review Focus 5: a fold stored for a folder deleted in another window, or on a synced device,
   *  changes nothing and throws nothing. */
  it("ignores stored folds for folders that no longer exist", () => {
    const stale = { "999": true, "-1": false, banana: true };
    expect(build(CABINET, { folds: stale })).toEqual(build(CABINET));
    expect(shelvesToFetch(build(CABINET, { folds: stale }))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("shelvesToFetch and shelvesToCount", () => {
  it("fetches the open shelves and counts every shelf", () => {
    const shelves = build(CABINET);
    expect(shelvesToFetch(shelves)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(shelvesToCount(shelves)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 21, 20, 23, 22]);
  });

  /** Review Focus 3: a collapsed parent takes its whole subtree off the wall and out of the
   *  query, and opening it again brings every one of them back. */
  it("drops a collapsed parent's whole subtree from the fetch and from the wall", () => {
    const shut = build(CABINET, { folds: { "1": true } });
    expect(shelvesToFetch(shut)).toEqual([0, 6, 7]);
    expect(ids(visibleShelves(shut, null, false))).toEqual([0, 1, 6, 7, 21, 20, 23, 22]);
    expect(shelvesToCount(shut)).toEqual(shelvesToCount(build(CABINET)));

    const reopened = build(CABINET, { folds: { "1": false } });
    expect(shelvesToFetch(reopened)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps a shelf out of the fetch while an ancestor is shut, whatever its own fold", () => {
    const shelves = build(CABINET, { folds: { "1": true, "2": false } });
    expect(shelvesToFetch(shelves)).toEqual([0, 6, 7]);
  });

  it("hides only the shut shelf's descendants, keeping its heading", () => {
    const shelves = build(CABINET, { folds: { "2": true } });
    expect(shelvesToFetch(shelves)).toEqual([0, 1, 5, 6, 7]);
    expect(ids(visibleShelves(shelves, null, false))).toEqual([0, 1, 2, 5, 6, 7, 21, 20, 23, 22]);
  });

  /** Expand all is a fold of `false` on every shelf, app-owned ones included (spec §3.4). */
  it("fetches the deck groups once they are folded open", () => {
    const shelves = build(CABINET, {
      folds: { "20": false, "21": false, "22": false, "23": false },
    });
    expect(shelvesToFetch(shelves)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 21, 20, 23, 22]);
  });
});

describe("visibleShelves", () => {
  it("hides Not sorted once the counts say it holds nothing, and keeps every empty folder", () => {
    const shelves = build(CABINET);
    expect(ids(visibleShelves(shelves, countsOf(count(3, 11)), false))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 21, 20, 23, 22,
    ]);
    expect(ids(visibleShelves(shelves, countsOf(count(0, 0)), false))).not.toContain(0);
    expect(ids(visibleShelves(shelves, countsOf(count(0, 7)), false))).toContain(0);
  });

  it("hides nothing but the collapsed subtrees while the counts are still loading", () => {
    const shelves = build(CABINET);
    expect(ids(visibleShelves(shelves, null, false))).toEqual(ids(shelves));
    expect(ids(visibleShelves(build(CABINET, { filtering: true }), null, true))).toEqual(
      ids(shelves),
    );
  });

  /** Review Focus 2: `Mana base` holds every card and `Aerith upgrades` none — its heading still
   *  shows, filtered or not, because it is where `Mana base` lives. */
  it("keeps a folder whose cards are all in its subfolders", () => {
    const folders = [folder(1, null, "Aerith upgrades"), folder(2, 1, "Mana base")];
    const counts = countsOf(count(2, 7));
    expect(ids(visibleShelves(build(folders), counts, false))).toEqual([1, 2]);
    expect(ids(visibleShelves(build(folders, { filtering: true }), counts, true))).toEqual([1, 2]);
  });

  it("while filtering, hides every shelf with no match in itself or below it", () => {
    const shelves = build(CABINET, { filtering: true });
    const counts = countsOf(count(3, 2), count(21, 1));
    expect(ids(visibleShelves(shelves, counts, true))).toEqual([1, 2, 3, 21]);
  });

  /**
   * Review Focus 4: the only match is two levels inside a folder the reader collapsed. The filter
   * opens every heading above it; clearing the filter puts the fold back, and nothing was written
   * — the stored map is frozen here, so a write would throw.
   */
  it("shows a match deep inside a collapsed parent and restores the fold once cleared", () => {
    const folds = Object.freeze({ "1": true });
    const counts = countsOf(count(3, 1));

    const filtered = build(CABINET, { folds, filtering: true });
    const drawn = visibleShelves(filtered, counts, true);
    expect(ids(drawn)).toEqual([1, 2, 3]);
    expect(drawn.every((shelf) => !shelf.collapsed)).toBe(true);
    expect(shelvesToFetch(filtered)).toContain(3);

    const cleared = build(CABINET, { folds, filtering: false });
    expect(byId(cleared, 1).collapsed).toBe(true);
    expect(ids(visibleShelves(cleared, countsOf(count(3, 11), count(0, 2)), false))).toEqual([
      0, 1, 6, 7, 21, 20, 23, 22,
    ]);
    expect(shelvesToFetch(cleared)).toEqual([0, 6, 7]);
    expect(folds).toEqual({ "1": true });
  });

  /** Inside a folder the headless shelf is the level's own cards and has no heading to keep as a
   *  container — with no match of its own it goes, and its subfolders stay. */
  it("drops the headless shelf when only its subfolders match", () => {
    const shelves = build(CABINET, { levelId: 1, filtering: true });
    expect(ids(visibleShelves(shelves, countsOf(count(3, 1)), true))).toEqual([2, 3]);
  });

  it("ignores a count row for a shelf that is not in the list", () => {
    const shelves = build(CABINET, { filtering: true });
    expect(ids(visibleShelves(shelves, countsOf(count(999, 4), count(6, 1)), true))).toEqual([6]);
  });
});
