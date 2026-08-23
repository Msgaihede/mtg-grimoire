import { describe, expect, it } from "vitest";
import { dragData, readDragData } from "@/features/decks/dnd";
import { collectionDragData, readCollectionDrag } from "./collectionDrag";

const ENTRY = { entryId: 7, name: "Lightning Bolt", folderId: null } as const;

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
