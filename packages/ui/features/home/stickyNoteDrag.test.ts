/**
 * The note reorder: the two reducers exhaustively, the mark's fence, and the gesture itself.
 *
 * **The reducers are where the behaviour is, and that is deliberate.** A drop is a pointer
 * gesture over measured rectangles, so the arithmetic of *what order results* is kept out of the
 * DOM entirely and checked here as a table — every clamp, every id the list does not hold, every
 * position off either end. What the gesture tests below add is only the wiring: that a drop calls
 * the move with the two ids, that every other tile arms, and that a press with no travel is still
 * a click.
 *
 * ⚠️ **An absence assertion about dnd-kit is vacuous unless it is about state this app owns.**
 * The library's own plugins mutate the DOM on a `requestAnimationFrame`, so "the mark is not
 * there" can pass because nothing has run yet. Every assertion below reads a hook's own answer or
 * a spy, never the shape of the tree.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { boxed, startPointerDrag } from "@/test-drag";
import {
  movedTo,
  readStickyNoteDrag,
  steppedBy,
  stickyNoteDragData,
  useStickyNoteTile,
} from "./stickyNoteDrag";

/**
 * ⚠️ **Not `[1, 2, 3, …]`, on purpose.** `sortOrder` is monotonic and never dense — a delete
 * leaves a hole — and a fixture whose ids happened to be their own positions would pass over a
 * reducer that read one for the other. Nothing here may be true only of a list that was never
 * deleted from.
 */
const IDS = [4, 11, 12, 30, 31] as const;

describe("movedTo", () => {
  it("moves an id to a position, closing the gap it left", () => {
    expect(movedTo(IDS, 12, 0)).toEqual([12, 4, 11, 30, 31]);
    expect(movedTo(IDS, 12, 4)).toEqual([4, 11, 30, 31, 12]);
  });

  /** Landing *where this one is* rather than before or after it: a note dropped on the tile two
   *  places along takes that place and the ones it passed close up behind it. */
  it("lands a note exactly where the tile it was dropped on was", () => {
    expect(movedTo(IDS, 4, 2)).toEqual([11, 12, 4, 30, 31]);
    expect(movedTo(IDS, 31, 1)).toEqual([4, 31, 11, 12, 30]);
  });

  /**
   * The arrow keys ask for `from - 1` at the front and `from + 1` at the back every time a reader
   * presses one more than there is board. Clamping here is also what keeps `splice` from being
   * handed a `-1`, which inserts from the *other* end.
   */
  it("clamps a position off either end rather than wrapping", () => {
    expect(movedTo(IDS, 4, -1)).toEqual([...IDS]);
    expect(movedTo(IDS, 4, -99)).toEqual([...IDS]);
    expect(movedTo(IDS, 31, 9)).toEqual([...IDS]);
  });

  it("answers a copy for an id the list does not hold", () => {
    const ids = [...IDS];
    expect(movedTo(ids, 999, 0)).toEqual(ids);
    expect(movedTo(ids, 999, 0)).not.toBe(ids);
  });

  it("never mutates the list it was given", () => {
    const ids = [...IDS];
    movedTo(ids, 12, 0);
    expect(ids).toEqual([...IDS]);
  });

  it("answers the same order for a move onto the place the note already has", () => {
    expect(movedTo(IDS, 12, 2)).toEqual([...IDS]);
  });

  /** Every id travels, because the command writes `sort_order` from position over all of them —
   *  so a reducer that answered only the run between the two would renumber the rest by omission. */
  it("carries every id, in the order they were in", () => {
    for (let to = 0; to < IDS.length; to++) {
      const next = movedTo(IDS, 11, to);
      expect(next).toHaveLength(IDS.length);
      expect([...next].sort((l, r) => l - r)).toEqual([...IDS].sort((l, r) => l - r));
    }
  });

  it("is a no-op on a list of one", () => {
    expect(movedTo([7], 7, 0)).toEqual([7]);
    expect(movedTo([7], 7, 5)).toEqual([7]);
  });
});

describe("steppedBy", () => {
  it("steps one place either way", () => {
    expect(steppedBy(IDS, 12, 1, 5)).toEqual([4, 11, 30, 12, 31]);
    expect(steppedBy(IDS, 12, -1, 5)).toEqual([4, 12, 11, 30, 31]);
  });

  /** A row of the board is `columns` places, which is how the up and down arrows reach the tile
   *  directly above and below on a grid. */
  it("steps a whole row when it is given one", () => {
    expect(steppedBy(IDS, 4, 3, 5)).toEqual([11, 12, 30, 4, 31]);
    expect(steppedBy(IDS, 31, -3, 5)).toEqual([4, 31, 11, 12, 30]);
  });

  it("stops at the front and at the last drawn tile rather than wrapping", () => {
    expect(steppedBy(IDS, 4, -1, 5)).toEqual([...IDS]);
    expect(steppedBy(IDS, 31, 1, 5)).toEqual([...IDS]);
    expect(steppedBy(IDS, 4, -9, 5)).toEqual([...IDS]);
  });

  /**
   * ⚠️ **`within` is the board's tile count, and it is what keeps a note on the board.** A card
   * that draws three tiles of five notes must not let an arrow key push a note into the two
   * nobody can see: the gesture would look like the note vanishing.
   */
  it("never steps a note past the last tile the board is drawing", () => {
    expect(steppedBy(IDS, 4, 9, 3)).toEqual([11, 12, 4, 30, 31]);
    expect(steppedBy(IDS, 11, 1, 2)).toEqual([...IDS]);
  });

  /** A board with room for more tiles than there are notes is not a licence to step past the
   *  end — the cap is the smaller of the two. */
  it("clamps against the list's own length when the board has room to spare", () => {
    expect(steppedBy(IDS, 4, 9, 99)).toEqual([11, 12, 30, 31, 4]);
  });

  /** Zero tiles is a real answer for a card with room for none, and a press there writes the
   *  order it already had rather than throwing. */
  it("answers the same order when the board draws no tiles at all", () => {
    expect(steppedBy(IDS, 12, 1, 0)).toEqual([...IDS]);
  });

  it("answers a copy for an id the list does not hold", () => {
    expect(steppedBy(IDS, 999, 1, 5)).toEqual([...IDS]);
  });
});

describe("the sticky note drag's own mark", () => {
  it("reads back an id it wrote", () => {
    expect(readStickyNoteDrag(stickyNoteDragData(7))).toBe(7);
  });

  it("carries a payload no other reader in the window can read", () => {
    expect(stickyNoteDragData(4)).toEqual({ "mtg-grimoire/sticky-note-order": true, stickyNoteId: 4 });
  });

  /**
   * The fence this mark exists for, from the other side. A deck category being reordered is the
   * gesture this one is modelled on and the one it must never be mistaken for — so a category
   * payload, and a card payload, both read as nothing at all.
   */
  it("refuses a drag that is not a sticky note being moved", () => {
    expect(readStickyNoteDrag({})).toBeNull();
    expect(
      readStickyNoteDrag({ "mtg-grimoire/category-order": true, categoryId: 3 }),
    ).toBeNull();
    expect(
      readStickyNoteDrag({ dragSource: "mtg-grimoire/deck-drag", cardId: "abc" }),
    ).toBeNull();
    // The mark alone is not enough: the field it names has to be there too.
    expect(readStickyNoteDrag({ "mtg-grimoire/sticky-note-order": true })).toBeNull();
  });

  /** An id addressing every row or no row, refused before it can reach a command. */
  it("refuses an id no row could have", () => {
    const mark = "mtg-grimoire/sticky-note-order";
    expect(readStickyNoteDrag({ [mark]: true, stickyNoteId: 0 })).toBeNull();
    expect(readStickyNoteDrag({ [mark]: true, stickyNoteId: -3 })).toBeNull();
    expect(readStickyNoteDrag({ [mark]: true, stickyNoteId: 1.5 })).toBeNull();
    expect(readStickyNoteDrag({ [mark]: true, stickyNoteId: "4" })).toBeNull();
    expect(readStickyNoteDrag({ [mark]: true, stickyNoteId: Number.NaN })).toBeNull();
  });

  /** A mark that is merely *present* is not a mark that was set: the reader tests for `true`, so
   *  a foreign payload carrying the key with anything else in it is still refused. */
  it("refuses a mark that is not the literal true", () => {
    expect(readStickyNoteDrag({ "mtg-grimoire/sticky-note-order": 1, stickyNoteId: 4 })).toBeNull();
  });
});

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

/**
 * One tile: a `<button>` that is both the drag source and the drop target, as the board draws it.
 *
 * `boxed` is not optional — jsdom lays nothing out and dnd-kit hit-tests by coordinate, so an
 * element with no rectangle is a degenerate box at the origin that silently wins any drop.
 */
function mountTile(id: number, onMove: (dragged: number, target: number) => void, top: number) {
  const element = boxed(document.createElement("button"), top);
  document.body.append(element);
  const view = renderHook(() => useStickyNoteTile(id, onMove));
  let stop: (() => void) | undefined;
  act(() => {
    stop = view.result.current.attach(element);
  });
  undo.push(() => {
    stop?.();
    element.remove();
  });
  return {
    element,
    get state() {
      return view.result.current;
    },
  };
}

describe("the note reorder, as a pointer gesture", () => {
  it("moves a note onto the tile it was let go over", async () => {
    const onMove = vi.fn();
    const target = mountTile(12, onMove, 400);
    const source = mountTile(4, vi.fn(), 0);

    const held = await startPointerDrag(source.element);
    expect(held.started).toBe(true);
    await held.over(target.element);
    await held.drop();

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(4, 12);
  });

  it("arms every other tile and never the one being dragged", async () => {
    const other = mountTile(12, vi.fn(), 400);
    const itself = mountTile(4, vi.fn(), 0);

    const held = await startPointerDrag(itself.element);
    expect(other.state.armed).toBe(true);
    expect(itself.state.armed).toBe(false);

    await held.cancel();
    expect(other.state.armed).toBe(false);
  });

  it("writes nothing when the reorder is cancelled", async () => {
    const onMove = vi.fn();
    const target = mountTile(12, onMove, 400);
    const source = mountTile(4, vi.fn(), 0);

    const held = await startPointerDrag(source.element);
    await held.over(target.element);
    expect(target.state.over).toBe(true);
    await held.cancel();

    expect(onMove).not.toHaveBeenCalled();
    expect(target.state.over).toBe(false);
  });

  /**
   * ⚠️ **A press on a tile is still a press, and that is what opens the editor.** The tile
   * declares no handle, so dnd-kit's own activation constraints are in force and a press alone
   * is not yet a drag. A source that declared a handle would switch them off — and would also be
   * the source that erases this manager's sensor options (issue #331), which is the second reason
   * there is no handle here.
   *
   * ⚠️ **What this cannot assert is that a *small* move stays a press, and the reason is worth
   * knowing before someone adds it back.** `test-drag.ts`'s own header states it: dnd-kit's two
   * default constraints are 5px of travel **and a 200ms delay**, and *either one alone* activates.
   * So an assertion that 3px of travel has not started a drag is really an assertion about how
   * long the two lines above it took to run — it passed alone and failed inside a full `verify`
   * on 2026-09-20, where the press was simply held past 200ms. The press-and-hold it was
   * measuring is dnd-kit's touch affordance working, not a threshold failing. Pinning the
   * distance half honestly would mean controlling the clock, which this file deliberately does
   * not do.
   */
  it("needs more than a press before a drag begins", async () => {
    const source = mountTile(4, vi.fn(), 0);

    // `boxed(…, 0)` puts the tile's centre at (100, 20), so the move below is 20px of travel —
    // past the library's own 5, and the only half of this that does not depend on the clock.
    const held = await startPointerDrag(source.element, { move: false });
    expect(held.started).toBe(false);
    await held.moveTo(120, 20);
    expect(held.started).toBe(true);
    await held.cancel();
  });
});
