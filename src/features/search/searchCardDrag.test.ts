import { describe, expect, it } from "vitest";
import { collectionDragData } from "@/features/collection/collectionDrag";
import { dragData, readDragData } from "@/features/decks/dnd";
import { readSearchCardDrag, searchCardDragData, type SearchCardDrag } from "./searchCardDrag";

/** What a search tile hands a folder: the printing, its name, the finish a drop would write, and
 *  the oracle id a wish for "any printing" needs. */
const CARD: SearchCardDrag = {
  cardId: "c1",
  name: "Lightning Bolt",
  finish: "nonfoil",
  oracleId: "o1",
};

/** The card half the same tile carries beside this one — `kind: "search-card"`, the arm the deck
 *  editor's own docked panel has handed its category columns since the panel existed. */
const DECK_CARD = {
  kind: "search-card",
  cardId: "c1",
  name: "Lightning Bolt",
  typeLine: "Instant",
} as const;

describe("searchCardDragData / readSearchCardDrag", () => {
  it("round-trips a card through the mark", () => {
    expect(readSearchCardDrag(searchCardDragData(CARD))).toEqual(CARD);
  });

  it("refuses a record carrying no mark", () => {
    expect(readSearchCardDrag({})).toBeNull();
  });

  it("refuses another feature's mark", () => {
    // Built with the other module's own writer rather than a hand-copied literal, so this stays
    // true if either mark string ever moves — the whole point of a key of this module's own is
    // that the two are unrelated, and a copied string would drift from it silently.
    const entry = collectionDragData({ entryId: 7, name: "Lightning Bolt", folderId: null });
    expect(readSearchCardDrag(entry)).toBeNull();
  });

  it("refuses a record whose cardId is not a string", () => {
    for (const cardId of [7, null, undefined, "", { id: "c1" }]) {
      expect(readSearchCardDrag({ ...searchCardDragData(CARD), cardId })).toBeNull();
    }
  });

  it("refuses a record whose finish is not a finish this build knows", () => {
    for (const finish of ["surge", "", null, undefined, 1]) {
      expect(readSearchCardDrag({ ...searchCardDragData(CARD), finish })).toBeNull();
    }
  });

  it("reads a null oracleId as a card with no oracle row", () => {
    const orphan = { ...CARD, oracleId: null };
    expect(readSearchCardDrag(searchCardDragData(orphan))).toEqual(orphan);
    // And anything that is neither a string nor `null` is not an answer about an oracle row.
    expect(readSearchCardDrag({ ...searchCardDragData(CARD), oracleId: 7 })).toBeNull();
  });

  /**
   * The load-bearing one, and the whole reason this module answers under a key of its own: a
   * search tile is both a card a deck category can take and a printing a folder can file, and
   * both readers have to say yes to the *same* record. Sharing `dnd.ts`'s `dragSource` would put
   * this module's mark on that key and one of the two would be lied to.
   */
  it("keeps a foreign key beside its own", () => {
    const both = { ...dragData(DECK_CARD), ...searchCardDragData(CARD) };
    expect(readDragData(both)).toEqual(DECK_CARD);
    expect(readSearchCardDrag(both)).toEqual(CARD);
  });
});
