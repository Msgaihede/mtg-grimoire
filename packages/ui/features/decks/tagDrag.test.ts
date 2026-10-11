import { describe, expect, it } from "vitest";
import { categoryDragData } from "./categoryDrag";
import { deckNoteDragData } from "./noteDrag";
import { deckTagDragData, readDeckTagDrag } from "./tagDrag";

describe("readDeckTagDrag", () => {
  it("reads back the tag a chip put in the air", () => {
    expect(readDeckTagDrag(deckTagDragData("No Gamechangers"))).toBe("No Gamechangers");
  });

  /** The settings dialog is drawn over a deck whose piles and notes reorder too — neither may
   *  land on a chip as if it were a tag. */
  it("refuses every other reorder's payload", () => {
    expect(readDeckTagDrag(categoryDragData(7))).toBeNull();
    expect(readDeckTagDrag(deckNoteDragData(7))).toBeNull();
  });

  it("refuses its own mark carrying anything but a non-empty string", () => {
    const mark = Object.keys(deckTagDragData("Meme")).find((key) => key !== "deckTag")!;
    for (const tag of ["", 7, null, undefined]) {
      expect(readDeckTagDrag({ [mark]: true, deckTag: tag })).toBeNull();
    }
  });
});
