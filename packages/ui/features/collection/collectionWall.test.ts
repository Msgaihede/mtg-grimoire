import { describe, expect, it } from "vitest";
import { buildFolderTree } from "@/lib/folderTree";
import type { CollectionFolder, CollectionRow } from "@/lib/ipc";
import { UNFILED_SHELF } from "@/lib/shelves";
import {
  collectionTiles,
  ownedFinishes,
  shelfTotal,
  subtotalsOf,
  tilesByShelf,
} from "./collectionWall";

const row = (over: Partial<CollectionRow> = {}): CollectionRow =>
  ({
    id: 1,
    cardId: "card-1",
    name: "Lightning Bolt",
    setCode: "sta",
    collectorNumber: "105",
    rarity: "uncommon",
    finish: "etched",
    condition: "NM",
    lang: "en",
    quantity: 1,
    unitPrice: 3.5,
    typeLine: "Instant",
    oracleId: "oracle-1",
    folderId: null,
    ...over,
  }) as CollectionRow;

describe("collectionTiles", () => {
  it("folds two grades of one printing in one finish and one folder into one tile", () => {
    const tiles = collectionTiles([
      row({ id: 1, condition: "NM", quantity: 1 }),
      row({ id: 2, condition: "NONE", quantity: 2 }),
    ]);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].copies).toBe(3);
    expect(tiles[0].id).toBe("card-1");
    expect(tiles[0].finish).toBe("etched");
  });

  it("keeps a foil and a plain copy of one printing as two tiles", () => {
    const tiles = collectionTiles([
      row({ id: 1, finish: "foil" }),
      row({ id: 2, finish: "nonfoil" }),
    ]);
    expect(tiles.map((t) => t.finish)).toEqual(["foil", "nonfoil"]);
    expect(new Set(tiles.map((t) => t.key)).size).toBe(2);
  });

  it("keeps one printing filed in two folders as a tile on each shelf, ringing together", () => {
    const tiles = collectionTiles([row({ id: 1, folderId: 3 }), row({ id: 2, folderId: null })]);
    expect(tiles).toHaveLength(2);
    expect(tiles[0].key).not.toBe(tiles[1].key);
    expect(tiles[0].ringKey).toBe(tiles[1].ringKey);
  });

  it("names a printing the corpus has forgotten by its set and number", () => {
    expect(collectionTiles([row({ name: null })])[0].name).toBe("STA 105");
  });

  it("marks a finish word this build cannot name with nothing", () => {
    const [tile] = collectionTiles([row({ finish: "glossy" })]);
    expect(tile.finish).toBeNull();
    expect(tile.finishes).toBe("[]");
  });
});

describe("ownedFinishes", () => {
  it("answers the app's finish order, dropping words it cannot name", () => {
    expect(ownedFinishes(new Set(["foil", "glossy", "nonfoil"]))).toBe('["nonfoil","foil"]');
  });
});

describe("tilesByShelf", () => {
  it("puts a tile filed nowhere on Not sorted, in the order the tiles came", () => {
    const tiles = collectionTiles([
      row({ id: 1, cardId: "a", folderId: null }),
      row({ id: 2, cardId: "b", folderId: 7 }),
      row({ id: 3, cardId: "c", folderId: null }),
    ]);
    const shelves = tilesByShelf(tiles);
    expect(shelves.get(UNFILED_SHELF)?.map((t) => t.id)).toEqual(["a", "c"]);
    expect(shelves.get(7)?.map((t) => t.id)).toEqual(["b"]);
  });
});

describe("subtotalsOf", () => {
  const folder = (id: number, parentId: number | null): CollectionFolder =>
    ({
      id,
      parentId,
      name: `F${id}`,
      sortOrder: 0,
      kind: "user",
      deckId: null,
      locked: false,
    }) as CollectionFolder;
  const tree = buildFolderTree([folder(1, null), folder(2, 1), folder(3, 1)], []);

  it("adds every sub-folder's cards into its parent, and an empty folder reads zero", () => {
    const totals = subtotalsOf(
      tree,
      new Map([
        [1, { cards: 1, value: 2 }],
        [2, { cards: 3, value: null }],
      ]),
    );
    expect(totals.get(1)).toEqual({ cards: 4, value: 2 });
    expect(totals.get(3)).toEqual({ cards: 0, value: null });
  });

  it("keeps a subtree nothing in which is priced at null, never zero", () => {
    const totals = subtotalsOf(tree, new Map([[2, { cards: 3, value: null }]]));
    expect(totals.get(1)).toEqual({ cards: 3, value: null });
  });
});

describe("shelfTotal", () => {
  const subtotals = new Map([[1, { cards: 12, value: 4 }]]);
  const summary = new Map([
    [1, { cards: 2, value: 1 }],
    [5, { cards: 3, value: null }],
  ]);

  it("reads a folder's subtree, then its own row, then zero for an empty folder", () => {
    expect(shelfTotal({ id: 1, kind: "folder" }, subtotals, summary)).toBe(12);
    expect(shelfTotal({ id: 5, kind: "deck" }, subtotals, summary)).toBe(3);
    expect(shelfTotal({ id: 9, kind: "folder" }, subtotals, summary)).toBe(0);
  });

  it("knows no total for Not sorted, or before the summary has answered", () => {
    expect(shelfTotal({ id: 0, kind: "unfiled" }, subtotals, summary)).toBeNull();
    expect(shelfTotal({ id: 1, kind: "folder" }, subtotals, null)).toBeNull();
  });
});
