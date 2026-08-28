import { describe, expect, it } from "vitest";
import { dragData, readDragData } from "@/features/decks/dnd";
import { boxed, recordDrags, startPointerDrag } from "@/test-drag";
import {
  collectionDragData,
  collectionTileDragData,
  collectionTileDraggable,
  readCollectionDrag,
  readCollectionDrop,
  readCollectionTileDrag,
  type CollectionTileDrag,
} from "./collectionDrag";

const ENTRY = { entryId: 7, name: "Lightning Bolt", folderId: null } as const;

/** What a *tile* hands a folder: one printing, and every entry the wall summed behind it — two
 *  copies filed in two different places, which is both the case a tile exists for and the one a
 *  {@link CollectionDrag} cannot state at all. */
const TILE: CollectionTileDrag = {
  cardId: "c1",
  name: "Lightning Bolt",
  copies: [
    { entryId: 7, folderId: null },
    { entryId: 8, folderId: 3 },
  ],
};

/** The card half a collection row always carries beside the entry half — `kind: "card"`, the arm
 *  the collection table has handed the deck's targets since long before folders existed. */
const CARD = { kind: "card", cardId: "c1", name: "Lightning Bolt", typeLine: "Instant" } as const;

describe("collectionDragData / readCollectionDrag", () => {
  it("round-trips an entry", () => {
    expect(readCollectionDrag(collectionDragData(ENTRY))).toEqual(ENTRY);
  });

  it("refuses a payload that is not a collection entry", () => {
    // Built with `dnd.ts`'s own `dragData` rather than a hand-written mark string, so this test
    // stays true if that module's mark ever changes — a copied literal would drift from it
    // silently, and the whole point of the separate key is that these two marks are unrelated.
    expect(readCollectionDrag(dragData(CARD))).toBeNull();
  });

  it("refuses a malformed entry id", () => {
    for (const entryId of [0, -1, 1.5, "7", undefined]) {
      expect(readCollectionDrag({ ...collectionDragData(ENTRY), entryId })).toBeNull();
    }
  });

  it("refuses a folder id that is neither null nor a whole number", () => {
    for (const folderId of [1.5, "3", undefined]) {
      expect(readCollectionDrag({ ...collectionDragData(ENTRY), folderId })).toBeNull();
    }
  });

  /**
   * The whole reason this file uses its own key rather than `dnd.ts`'s: a collection row is both
   * a card you can put in a deck and an entry you can file, and both readers have to say yes to
   * the same payload. Sharing `dragSource` would force this module's mark onto that key and one
   * of the two would be lied to.
   */
  it("lets one row be read as a card and as an entry at once", () => {
    const both = { ...dragData(CARD), ...collectionDragData(ENTRY) };
    expect(readDragData(both)).toEqual(CARD);
    expect(readCollectionDrag(both)).toEqual(ENTRY);
  });

  /** `folderId` travels so a target can refuse **before** the drop: the folder a row already
   *  sits in draws no ring at all, rather than a ring leading to a write that moves nothing and
   *  bumps `updated_at`. */
  it("carries where the row is filed now, so a folder can refuse itself", () => {
    const filed = readCollectionDrag(collectionDragData({ ...ENTRY, folderId: 3 }));
    expect(filed?.folderId).toBe(3);
  });
});

describe("collectionTileDragData / readCollectionTileDrag", () => {
  it("round-trips a tile and every copy behind it", () => {
    expect(readCollectionTileDrag(collectionTileDragData(TILE))).toEqual(TILE);
  });

  /** The third key earning its keep in both directions: a reader written for entries sees nothing
   *  in a tile, rather than reading an `entryId` out of a payload that has none. */
  it("refuses each of the other two payloads, and they refuse it", () => {
    const tile = collectionTileDragData(TILE);
    expect(readCollectionDrag(tile)).toBeNull();
    expect(readDragData(tile)).toBeNull();
    expect(readCollectionTileDrag(collectionDragData(ENTRY))).toBeNull();
    expect(readCollectionTileDrag(dragData(CARD))).toBeNull();
    // …and the mark's own job, which the two above do not exercise: the *fields* alone are a shape
    // anything in the store could have, so an unmarked payload carrying every one of them is still
    // not this module's drag.
    expect(readCollectionTileDrag({ ...TILE })).toBeNull();
  });

  /** `dnd.ts`'s `isId` rule, for its reason: an empty `card_id` addresses every row and no row. */
  it("refuses a card id that is not a non-empty string", () => {
    for (const cardId of ["", 1, null, undefined]) {
      expect(readCollectionTileDrag({ ...collectionTileDragData(TILE), cardId })).toBeNull();
    }
  });

  it("refuses a name that is not a string", () => {
    expect(readCollectionTileDrag({ ...collectionTileDragData(TILE), name: 7 })).toBeNull();
  });

  /**
   * **An empty `copies` is refused rather than tolerated.** A tile is drawn *because* rows grouped
   * into it, so an empty array is a bug in whatever built the payload — and a drop that wrote
   * nothing at all would look on screen exactly like a drop that worked.
   */
  it("refuses a copies list that is not a non-empty array", () => {
    for (const copies of [[], "7", 7, null, undefined, { entryId: 7, folderId: null }]) {
      expect(readCollectionTileDrag({ ...collectionTileDragData(TILE), copies })).toBeNull();
    }
  });

  /**
   * **One malformed copy refuses the whole tile**, where `dnd.ts`'s `readDragGroup` drops a bad
   * member and carries on. That function reads a multi-*select*, where four cards of five is still
   * the gesture the reader made; these copies are the whole of what the refile writes, and quietly
   * losing one would move eight rows of nine with nothing on screen saying which stayed behind.
   */
  it("refuses the whole tile for one malformed copy", () => {
    for (const bad of [
      { entryId: 0, folderId: null },
      { entryId: -1, folderId: null },
      { entryId: 1.5, folderId: null },
      { entryId: "8", folderId: null },
      { folderId: null },
      { entryId: 8, folderId: 1.5 },
      { entryId: 8, folderId: "3" },
      { entryId: 8 },
      null,
      "8",
    ]) {
      const copies = [{ entryId: 7, folderId: null }, bad];
      expect(readCollectionTileDrag({ ...collectionTileDragData(TILE), copies })).toBeNull();
    }
  });

  /** The entry payload's reason for carrying `folderId`, one grain finer: on a tile it is per
   *  **copy**, which is what lets a folder refuse the copies already in it while the drag is still
   *  in the air and still take the rest. */
  it("carries where each copy is filed now", () => {
    const read = readCollectionTileDrag(collectionTileDragData(TILE));
    expect(read?.copies.map((copy) => copy.folderId)).toEqual([null, 3]);
  });

  /** A tile is a card as well, exactly as a row is — this is the half that keeps a wall tile
   *  droppable on a deck category and the sidebar's Decks entry. */
  it("lets one tile be read as a card and as a shelf at once", () => {
    const both = { ...dragData(CARD), ...collectionTileDragData(TILE) };
    expect(readDragData(both)).toEqual(CARD);
    expect(readCollectionTileDrag(both)).toEqual(TILE);
  });
});

describe("collectionTileDraggable", () => {
  /**
   * **What the drag actually puts in the library's store**, read back through the two readers that
   * will ask for it — not the composition asserted by hand, which is the same expression twice.
   *
   * The card half is the half a unit test of `collectionTileDragData` cannot see going missing, and
   * it is the whole of what keeps a wall tile droppable on a deck category and the sidebar's Decks
   * entry. Both callbacks are read at `dragstart`, which is what the `tile: () => …` shape is for.
   */
  it("puts the card and the tile in the store, under their own keys", async () => {
    // A box, because dnd-kit hit-tests by coordinate and jsdom measures every rect as zero —
    // a source with no box has nowhere to be pressed.
    const element = boxed(document.createElement("div"), 0);
    document.body.append(element);
    const drags = recordDrags();
    const stop = collectionTileDraggable({
      element,
      tile: () => TILE,
      card: () => CARD,
    });

    const held = await startPointerDrag(element);
    expect(held.started).toBe(true);
    await held.cancel();
    stop();
    drags.stop();
    element.remove();

    const seen = drags.records;
    expect(seen).toHaveLength(1);
    expect(readDragData(seen[0])).toEqual(CARD);
    expect(readCollectionTileDrag(seen[0])).toEqual(TILE);
    // And nothing wrote the *entry* key, which is what a target reading rows depends on.
    expect(readCollectionDrag(seen[0])).toBeNull();
  });
});

describe("readCollectionDrop", () => {
  it("reads a row as an entry and a tile as a tile", () => {
    expect(readCollectionDrop(collectionDragData(ENTRY))).toEqual({ kind: "entry", entry: ENTRY });
    expect(readCollectionDrop(collectionTileDragData(TILE))).toEqual({ kind: "tile", tile: TILE });
  });

  /** A card payload carrying neither collection mark is not this feature's drag at all — which is
   *  what keeps a search tile from raising every folder's ring. */
  it("refuses a payload carrying neither mark", () => {
    expect(readCollectionDrop(dragData(CARD))).toBeNull();
    expect(readCollectionDrop({})).toBeNull();
  });

  /** A malformed payload of either shape is refused outright rather than falling through to the
   *  other reader and being reported as the thing it is not. */
  it("refuses a malformed payload of either shape", () => {
    expect(readCollectionDrop({ ...collectionDragData(ENTRY), entryId: 0 })).toBeNull();
    expect(readCollectionDrop({ ...collectionTileDragData(TILE), copies: [] })).toBeNull();
  });

  /** The two keys are disjoint by construction, so a payload with both can only be a bug upstream
   *  — and the entry is the narrower fact to act on: it moves one row where a tile moves a whole
   *  printing's shelf. */
  it("takes the entry when a payload somehow carries both", () => {
    const both = { ...collectionTileDragData(TILE), ...collectionDragData(ENTRY) };
    expect(readCollectionDrop(both)).toEqual({ kind: "entry", entry: ENTRY });
  });
});
