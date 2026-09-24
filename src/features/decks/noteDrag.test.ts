import { describe, expect, it } from "vitest";
import { stickyNoteDragData } from "@/features/home/stickyNoteDrag";
import { categoryDragData } from "./categoryDrag";
import { deckNoteDragData, readDeckNoteDrag } from "./noteDrag";

describe("readDeckNoteDrag", () => {
  it("reads back the note a card put in the air", () => {
    expect(readDeckNoteDrag(deckNoteDragData(7))).toBe(7);
  });

  /** A sticky note is the same shape of row in a different table, and a pile is the other reorder
   *  in this feature — neither may land on a deck note as if it were one. */
  it("refuses every other reorder's payload", () => {
    expect(readDeckNoteDrag(stickyNoteDragData(7))).toBeNull();
    expect(readDeckNoteDrag(categoryDragData(7))).toBeNull();
  });

  it("refuses its own mark carrying anything but a positive integer id", () => {
    const mark = Object.keys(deckNoteDragData(1)).find((key) => key !== "deckNoteId")!;
    for (const id of ["7", 1.5, 0, -3, null]) {
      expect(readDeckNoteDrag({ [mark]: true, deckNoteId: id })).toBeNull();
    }
  });
});
