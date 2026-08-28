import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { boxed, startPointerDrag } from "@/test-drag";
import {
  categoryDragData,
  movedTo,
  readCategoryDrag,
  useCategoryDragSource,
  useCategoryReorderDrop,
} from "./categoryDrag";

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

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

/** A heading with a grip inside it — the shape both surfaces draw, and the only shape where the
 *  press guard means anything. */
function mountSource(id: number, top = 0) {
  const heading = boxed(document.createElement("div"), top);
  const grip = document.createElement("button");
  grip.textContent = "Move";
  // A `<span>`, which is what `GroupHeader` really draws the pile's name as — and the choice
  // matters to the case below. dnd-kit's *default* `preventActivation` refuses a press that lands
  // on an interactive element, so a heading whose name were a `<button>` would refuse the press
  // even with no handle declared, and the test would pass without the handle doing any work.
  const name = document.createElement("span");
  name.textContent = "Ramp";
  heading.append(grip, name);
  document.body.append(heading);
  const view = renderHook(() => useCategoryDragSource(id));
  // Two acts, because that is what React does: `attachSource` is keyed on the handle, so the
  // grip's own ref lands first and the source's callback is a *new* function by the time React
  // runs it. Attaching both from one snapshot of the hook's result would register a source that
  // had never heard of the grip — which is the failure the early return exists for.
  act(() => {
    view.result.current.attachHandle(grip);
  });
  let stop: (() => void) | undefined;
  act(() => {
    stop = view.result.current.attachSource(heading);
  });
  undo.push(() => {
    stop?.();
    heading.remove();
  });
  return { heading, grip, name };
}

function mountTarget(id: number, onMove: (from: number, to: number) => void, top = 200) {
  const element = boxed(document.createElement("div"), top);
  document.body.append(element);
  const view = renderHook(() => useCategoryReorderDrop(id, onMove));
  act(() => {
    view.result.current.attach(element);
  });
  undo.push(() => element.remove());
  return {
    element,
    get state() {
      return view.result.current;
    },
  };
}

describe("the category reorder, as a pointer gesture", () => {
  it("moves a pile onto the pile it was let go over", async () => {
    const onMove = vi.fn();
    const target = mountTarget(2, onMove);
    const { heading, grip } = mountSource(1);

    const held = await startPointerDrag(heading, { pressOn: grip });
    expect(held.started).toBe(true);
    await held.over(target.element);
    await held.drop();

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(1, 2);
  });

  /**
   * **The press guard, which is the whole reason the heading is the source and the grip is only
   * where a press may start.** A heading carries the pile's name, its markers and its two
   * numbers, and a press anywhere on it plus five pixels of travel must not carry the column
   * away.
   */
  it("does not start from a press on the heading's own name", async () => {
    const target = mountTarget(2, () => {});
    const { heading, name } = mountSource(1);

    const held = await startPointerDrag(heading, { pressOn: name });
    expect(held.started).toBe(false);
    await held.cancel();
    expect(target.state.eligible).toBe(false);
  });

  /**
   * **A click on the grip is a click, not a zero-pixel reorder.** dnd-kit switches its activation
   * constraints off for a press inside a declared handle, so this is the behaviour the source has
   * to put back — 5px of travel, which is what the gesture has always cost.
   */
  it("needs travel before a press on the grip becomes a drag", async () => {
    mountTarget(2, () => {});
    const { heading, grip } = mountSource(1);

    // The press lands at the heading's centre, `boxed(…, 0)` putting that at (100, 20) — so the
    // two moves below are 3px and 20px of travel, either side of the 5 the source asks for.
    const held = await startPointerDrag(heading, { pressOn: grip, move: false });
    expect(held.started).toBe(false);
    await held.moveTo(103, 20);
    expect(held.started).toBe(false);
    await held.moveTo(120, 20);
    expect(held.started).toBe(true);
    await held.cancel();
  });

  it("arms every other pile and never the one being dragged", async () => {
    const other = mountTarget(2, () => {});
    const itself = mountTarget(1, () => {}, 400);
    const { heading, grip } = mountSource(1);

    const held = await startPointerDrag(heading, { pressOn: grip });
    expect(other.state.eligible).toBe(true);
    expect(itself.state.eligible).toBe(false);

    await held.cancel();
    expect(other.state.eligible).toBe(false);
  });

  it("writes nothing when the reorder is cancelled", async () => {
    const onMove = vi.fn();
    const target = mountTarget(2, onMove);
    const { heading, grip } = mountSource(1);

    const held = await startPointerDrag(heading, { pressOn: grip });
    await held.over(target.element);
    await held.cancel();

    expect(onMove).not.toHaveBeenCalled();
    expect(target.state.over).toBe(false);
  });

  /** The fence between the two drags in this feature, from the source side: a category payload
   *  carries this module's mark and `dnd.ts`'s reader must go on finding nothing in it. */
  it("carries a payload no card reader can read", () => {
    expect(categoryDragData(4)).toEqual({ "mtg-grimoire/category-order": true, categoryId: 4 });
  });
});
