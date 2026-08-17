import { describe, expect, it } from "vitest";
import { categoryDragData, movedTo, readCategoryDrag } from "./categoryDrag";

describe("movedTo", () => {
  it("moves an id to a position, closing the gap it left", () => {
    expect(movedTo([1, 2, 3, 4], 2, 0)).toEqual([2, 1, 3, 4]);
    expect(movedTo([1, 2, 3, 4], 2, 3)).toEqual([1, 3, 4, 2]);
  });

  /**
   * The keyboard asks for `index - 1` on the first row and `index + 1` on the last, every time
   * the reader presses one more than there is list. Clamping there is what makes the handler a
   * two-line `onKeyDown` instead of a bounds check at each of the two call sites — and what
   * keeps `splice` from being handed a `-1`, which inserts from the *other* end.
   */
  it("clamps a position off either end rather than wrapping", () => {
    expect(movedTo([1, 2, 3], 1, -1)).toEqual([1, 2, 3]);
    expect(movedTo([1, 2, 3], 3, 9)).toEqual([1, 2, 3]);
  });

  it("answers a copy for an id the list does not hold", () => {
    const ids = [1, 2, 3];
    expect(movedTo(ids, 99, 0)).toEqual(ids);
    expect(movedTo(ids, 99, 0)).not.toBe(ids);
  });

  /**
   * The case the desk adds and the dialog never had: the list the command is sent is **every**
   * category, and the piles a reader can drag are a subset of it — the rail is out and the empty
   * auto piles were never built. So a move is resolved against the whole list, and the ids that
   * are not on screen ride along in the places they were in.
   */
  it("keeps the ids that are not being dragged in the order they were in", () => {
    // [Commander, Ramp, Removal, Sideboard, Maybeboard, Lands]; the reader drags Lands onto Ramp.
    expect(movedTo([1, 2, 3, 4, 5, 6], 6, 1)).toEqual([1, 6, 2, 3, 4, 5]);
    // …and Ramp onto Lands, which lands it past the two railed piles it never saw.
    expect(movedTo([1, 2, 3, 4, 5, 6], 2, 5)).toEqual([1, 3, 4, 5, 6, 2]);
  });
});

describe("the category drag's own mark", () => {
  it("reads back an id it wrote", () => {
    expect(readCategoryDrag(categoryDragData(7))).toBe(7);
  });

  /**
   * The fence this mark exists for. `dnd.ts`'s payload is the shape a card drag carries, and a
   * heading is a drop target sitting inside a view full of them — so a card let go over one must
   * never be read as a pile being moved.
   */
  it("refuses a drag that is not a category being moved", () => {
    expect(readCategoryDrag({})).toBeNull();
    expect(
      readCategoryDrag({ dragSource: "mtg-grimoire/deck-drag", cardId: "abc", categoryId: 3 }),
    ).toBeNull();
  });

  /** An id addressing every row or no row, refused for `dnd.ts`'s `isCategoryId` reason. */
  it("refuses an id no row could have", () => {
    expect(readCategoryDrag({ "mtg-grimoire/category-order": true, categoryId: 0 })).toBeNull();
    expect(readCategoryDrag({ "mtg-grimoire/category-order": true, categoryId: -3 })).toBeNull();
    expect(readCategoryDrag({ "mtg-grimoire/category-order": true, categoryId: 1.5 })).toBeNull();
    expect(readCategoryDrag({ "mtg-grimoire/category-order": true, categoryId: "4" })).toBeNull();
  });
});
