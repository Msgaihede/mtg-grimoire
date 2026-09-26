import { describe, expect, it } from "vitest";
import { buildFolderTree } from "@/lib/folderTree";
import type { CollectionFolder, ShelfCount } from "@/lib/ipc";
import { UNFILED_SHELF, type Shelf } from "@/lib/shelves";
import {
  DRAFT_SHELF,
  countsById,
  draftFolder,
  foldAll,
  foldChange,
  foldedForDrag,
  keepShelf,
  peekOf,
  rolledUp,
  shelfFolderOf,
  shelfStat,
  treeParents,
} from "./collectionShelfModel";

const folder = (id: number, over: Partial<CollectionFolder> = {}): CollectionFolder => ({
  id,
  parentId: null,
  name: `F${id}`,
  kind: "user",
  deckId: null,
  sortOrder: id,
  locked: false,
  syncUid: null,
  ...over,
});

const shelf = (over: Partial<Shelf> & Pick<Shelf, "id">): Shelf => ({
  kind: "folder",
  group: "own",
  name: `F${over.id}`,
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

const count = (folderId: number, over: Partial<ShelfCount> = {}): ShelfCount => ({
  folderId,
  tiles: 1,
  copies: 1,
  value: null,
  unpriced: 0,
  peek: [],
  ...over,
});

describe("shelfFolderOf", () => {
  it("maps the three kinds, and fails closed on a fourth", () => {
    const none = new Set<number>();
    expect(shelfFolderOf(folder(1), none).kind).toBe("folder");
    expect(shelfFolderOf(folder(2, { kind: "deck", deckId: 7 }), none).kind).toBe("deck");
    expect(shelfFolderOf(folder(3, { kind: "removed" }), none).kind).toBe("removed");
    // A kind this build has never heard of is the app's, never the reader's: a "folder" shelf
    // is draggable, renameable and a drop target, and turning those on for a kind nobody has
    // thought about is the failure `readersOwnLevel` is written positively to prevent.
    expect(shelfFolderOf(folder(4, { kind: "binder" }), none).kind).toBe("removed");
  });

  it("carries the effective lock, never the folder's own flag", () => {
    const child = folder(9, { parentId: 3, locked: false });
    expect(shelfFolderOf(child, new Set([3, 9])).locked).toBe(true);
    expect(shelfFolderOf(folder(3, { locked: true }), new Set()).locked).toBe(false);
  });
});

describe("draftFolder", () => {
  it("sorts after every sibling and inherits its parent's lock", () => {
    expect(draftFolder(3, new Set([3]))).toEqual({
      id: DRAFT_SHELF,
      parentId: 3,
      name: "",
      sortOrder: Number.MAX_SAFE_INTEGER,
      kind: "folder",
      locked: true,
    });
    expect(draftFolder(null, new Set([3])).locked).toBe(false);
  });
});

describe("countsById", () => {
  it("is null before the counts answer, and a map by shelf after", () => {
    expect(countsById(undefined)).toBeNull();
    const map = countsById([count(UNFILED_SHELF), count(3, { copies: 4 })]);
    expect(map?.get(3)?.copies).toBe(4);
    expect(map?.get(UNFILED_SHELF)).toBeDefined();
  });
});

describe("rolledUp", () => {
  /** Review Focus 2's container: `Mana base` holds nothing of its own, all of it in a child. */
  it("adds a subfolder's figures into every ancestor between it and the level", () => {
    const shelves = [
      shelf({ id: 3, pathIds: [3] }),
      shelf({ id: 9, pathIds: [3, 9], depth: 1, indent: 1 }),
      shelf({ id: 11, pathIds: [3, 9, 11], depth: 2, indent: 2 }),
    ];
    const rolled = rolledUp(
      shelves,
      new Map([
        [9, count(9, { copies: 4, value: 88, unpriced: 0 })],
        [11, count(11, { copies: 2, value: null, unpriced: 2 })],
      ]),
    );
    expect(rolled.get(3)).toEqual({ copies: 6, value: 88, unpriced: 2 });
    expect(rolled.get(9)).toEqual({ copies: 6, value: 88, unpriced: 2 });
    expect(rolled.get(11)).toEqual({ copies: 2, value: null, unpriced: 2 });
  });

  it("keeps a value null until something under it is priced", () => {
    const rolled = rolledUp(
      [shelf({ id: 3 }), shelf({ id: 9, pathIds: [3, 9], depth: 1 })],
      new Map([[9, count(9, { copies: 1, value: null, unpriced: 1 })]]),
    );
    expect(rolled.get(3)?.value).toBeNull();
  });

  it("has no entry for a shelf with nothing in it or under it", () => {
    expect(rolledUp([shelf({ id: 3 })], new Map()).get(3)).toBeUndefined();
  });
});

describe("shelfStat", () => {
  const usd = { currency: "usd" as const };

  it("draws an em dash while the counts have not answered", () => {
    expect(shelfStat({ figures: null, total: 42, filtering: false, ...usd })).toBe("—");
  });

  it("states copies, value and unpriced, joined with the app's middot", () => {
    expect(
      shelfStat({ figures: { copies: 42, value: 2490, unpriced: 3 }, total: 42, filtering: false, ...usd }),
    ).toBe("42 cards · $2,490.00 · 3 unpriced");
    expect(
      shelfStat({ figures: { copies: 1, value: 4, unpriced: 0 }, total: 1, filtering: false, ...usd }),
    ).toBe("1 card · $4.00");
    expect(
      shelfStat({ figures: { copies: 1204, value: null, unpriced: 0 }, total: null, filtering: false, ...usd }),
    ).toBe("1,204 cards");
  });

  it("reads an answered shelf with no row as empty, not as still counting", () => {
    expect(shelfStat({ figures: undefined, total: 0, filtering: false, ...usd })).toBe("0 cards");
  });

  it("says 3 of 42 under a filter, and the match alone where the whole is unknown", () => {
    expect(
      shelfStat({ figures: { copies: 3, value: 9, unpriced: 0 }, total: 42, filtering: true, ...usd }),
    ).toBe("3 of 42 cards");
    expect(
      shelfStat({ figures: { copies: 3, value: 9, unpriced: 0 }, total: null, filtering: true, ...usd }),
    ).toBe("3 cards");
  });
});

describe("foldChange and foldAll", () => {
  it("writes an override only where the reader moved a shelf off its default", () => {
    expect(foldChange({ kind: "folder" }, false)).toBeNull();
    expect(foldChange({ kind: "folder" }, true)).toBe(true);
    expect(foldChange({ kind: "unfiled" }, true)).toBe(true);
    expect(foldChange({ kind: "deck" }, false)).toBe(false);
    expect(foldChange({ kind: "deck" }, true)).toBeNull();
    expect(foldChange({ kind: "removed" }, true)).toBeNull();
  });

  it("covers every shelf but the level's own cards and a folder still being named", () => {
    const shelves = [
      shelf({ id: 3, headless: true }),
      shelf({ id: 9 }),
      shelf({ id: 20, kind: "deck", group: "decks" }),
      shelf({ id: DRAFT_SHELF }),
    ];
    expect(foldAll(shelves, true)).toEqual({ "9": true, "20": null });
    expect(foldAll(shelves, false)).toEqual({ "9": null, "20": false });
  });
});

describe("treeParents", () => {
  it("answers the level a folder is drawn in, so an orphan's parent is the root", () => {
    const nodes = buildFolderTree(
      [folder(3), folder(9, { parentId: 3 }), folder(5, { parentId: 99 })],
      [],
    );
    const parents = treeParents(nodes);
    expect(parents.get(9)).toBe(3);
    expect(parents.get(3)).toBeNull();
    expect(parents.get(5)).toBeNull();
  });
});

describe("peekOf", () => {
  /** A collapsed container holds nothing of its own, so its peek is what is under it — the
   *  subtree its collapse hid — in wall order, never more than four. */
  it("reads the shelf's own peek first, then its subfolders', up to four", () => {
    const shelves = [
      shelf({ id: 3, pathIds: [3] }),
      shelf({ id: 9, pathIds: [3, 9], depth: 1 }),
      shelf({ id: 4, pathIds: [4] }),
    ];
    const counts = new Map([
      [3, count(3, { peek: ["a"] })],
      [9, count(9, { peek: ["b", "c", "d", "e"] })],
      [4, count(4, { peek: ["z"] })],
    ]);
    expect(peekOf(shelves[0], shelves, counts)).toEqual([
      { cardId: "a", name: "" },
      { cardId: "b", name: "" },
      { cardId: "c", name: "" },
      { cardId: "d", name: "" },
    ]);
    expect(peekOf(shelves[2], shelves, counts)).toEqual([{ cardId: "z", name: "" }]);
  });

  it("is empty before the counts answer", () => {
    expect(peekOf(shelf({ id: 3 }), [shelf({ id: 3 })], null)).toEqual([]);
  });
});

describe("keepShelf", () => {
  const drawn = [
    shelf({ id: 0, kind: "unfiled" }),
    shelf({ id: 3 }),
    shelf({ id: DRAFT_SHELF }),
    shelf({ id: 20, kind: "deck", group: "decks" }),
  ];

  it("changes nothing for a shelf that is already drawn, or for no shelf", () => {
    expect(keepShelf(drawn, drawn, DRAFT_SHELF)).toEqual(drawn);
    expect(keepShelf(drawn, drawn, null)).toEqual(drawn);
  });

  it("puts a hidden heading back before the next drawn shelf that follows it", () => {
    const shown = [drawn[1], drawn[3]];
    expect(keepShelf(shown, drawn, DRAFT_SHELF).map((s) => s.id)).toEqual([3, DRAFT_SHELF, 20]);
  });

  it("appends it when nothing after it is drawn", () => {
    expect(keepShelf([drawn[1]], drawn, DRAFT_SHELF).map((s) => s.id)).toEqual([3, DRAFT_SHELF]);
  });

  /** Under a filter the draft's parent can be hidden too — and a heading drawn without the one it
   *  hangs under would say it is somewhere it is not. */
  it("puts back the headings it hangs under, in the tree's order", () => {
    const tree = [
      shelf({ id: 3, pathIds: [3] }),
      shelf({ id: 9, pathIds: [3, 9], depth: 1 }),
      shelf({ id: DRAFT_SHELF, pathIds: [3, 9, DRAFT_SHELF], depth: 2 }),
      shelf({ id: 4, pathIds: [4] }),
    ];
    expect(keepShelf([tree[3]], tree, DRAFT_SHELF).map((s) => s.id)).toEqual([3, 9, DRAFT_SHELF, 4]);
  });
});

describe("foldedForDrag", () => {
  /** Spec §3.9: every heading, shut — the nested one under a parent the reader had shut
   *  included — and no headless shelf, which has no heading to fold to. Nothing is written. */
  it("draws every heading shut, opens what the reader had shut to find them, and drops the headless", () => {
    const tree = [
      shelf({ id: 3, headless: true }),
      shelf({ id: 9, pathIds: [9], collapsed: true }),
      shelf({ id: 11, pathIds: [9, 11], depth: 1 }),
      shelf({ id: 20, kind: "deck", group: "decks", collapsed: true }),
    ];
    const folded = foldedForDrag(tree, new Map([[11, count(11)]]), false);
    expect(folded.map((s) => [s.id, s.collapsed])).toEqual([
      [9, true],
      [11, true],
      [20, true],
    ]);
  });
});
