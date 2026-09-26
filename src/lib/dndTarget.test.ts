import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Draggable } from "@dnd-kit/dom";
import { dndId, dndManager, registerNow } from "@/lib/dndManager";
import { useDndDragging, useDndDropTarget, useDragRecord } from "@/lib/dndTarget";
import { startPointerDrag } from "@/test-drag";

/** A payload of this file's own, under a key nothing else in the app writes — so a reader that
 *  stopped checking its mark cannot pass here on somebody else's record. */
const MARK_KEY = "dndTargetTestSource";
const MARK = "mtg-grimoire/dnd-target-test";
interface Thing {
  id: number;
}
const data = (id: number): Record<string, unknown> => ({ [MARK_KEY]: MARK, id });
const read = (record: Record<string, unknown>): Thing | null =>
  record[MARK_KEY] === MARK && typeof record.id === "number" ? { id: record.id } : null;

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

/** jsdom measures every box as zero and dnd-kit hit-tests by coordinate, so a target a drag is
 *  meant to arrive at has to be given somewhere to be. `folderDrag.test.ts`'s helper. */
function boxed(element: HTMLElement, top: number, height = 40): HTMLElement {
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: top,
      top,
      left: 0,
      right: 200,
      bottom: top + height,
      width: 200,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
}

function mountSource(id: number, top = 0): HTMLElement {
  const element = boxed(document.createElement("div"), top);
  element.textContent = "a thing";
  document.body.append(element);
  const draggable = new Draggable(
    { id: dndId("test-source"), element, data: data(id), register: false },
    dndManager,
  );
  registerNow(draggable);
  undo.push(() => {
    draggable.destroy();
    element.remove();
  });
  return element;
}

interface Props {
  canDrop: (thing: Thing) => boolean;
  onDrop: (thing: Thing) => void;
  /** The shelves' opt-in: arm on a payload that was already in the air at mount. */
  armOnMount?: boolean;
  /** The shelves' other opt-in: a collision only while the pointer is inside the target. */
  pointerOnly?: boolean;
}

function mountTarget({
  top = 200,
  height = 40,
  ...props
}: Partial<Props> & { top?: number; height?: number } = {}) {
  const element = boxed(document.createElement("div"), top, height);
  document.body.append(element);
  undo.push(() => element.remove());
  const initialProps: Props = { canDrop: () => true, onDrop: () => {}, ...props };
  const ref = { current: element as HTMLElement | null };
  const view = renderHook((current: Props) => useDndDropTarget({ ref, read, ...current }), {
    initialProps,
  });
  let current = initialProps;
  return {
    element,
    get state() {
      return view.result.current;
    },
    rerender(next: Partial<Props>) {
      current = { ...current, ...next };
      act(() => view.rerender(current));
    },
  };
}

describe("useDndDropTarget", () => {
  it("arms every target that would take the payload, and no others", async () => {
    const takes = mountTarget();
    const refuses = mountTarget({ top: 400, canDrop: () => false });
    const held = await startPointerDrag(mountSource(7));

    expect(takes.state.armed).toBe(true);
    expect(refuses.state.armed).toBe(false);

    await held.cancel();
    expect(takes.state.armed).toBe(false);
  });

  it("is blind to a payload it cannot read", async () => {
    const target = mountTarget();
    const element = boxed(document.createElement("div"), 0);
    document.body.append(element);
    const stranger = new Draggable(
      { id: dndId("stranger"), element, data: { somethingElse: true }, register: false },
      dndManager,
    );
    registerNow(stranger);
    undo.push(() => {
      stranger.destroy();
      element.remove();
    });

    const held = await startPointerDrag(element);
    expect(target.state.armed).toBe(false);
    await held.over(target.element);
    expect(target.state.over).toBe(false);
    await held.cancel();
  });

  /**
   * **A target that would refuse the payload is out of the collision pass entirely, and that is
   * what `accept` is for rather than the two flags.** `armed` and `over` each ask `canDrop` for
   * themselves, so a droppable that accepted everything would still *read* correctly — it would
   * simply take the drop target away from the one underneath it. `computeCollisions` skips any
   * droppable whose `accepts(source)` is false **before it measures**; without that skip the two
   * are ranked by `1 / distance-to-centre`, and the refusing box below is the one the pointer is
   * dead centre of.
   */
  it("does not compete for the target with a payload it would refuse", async () => {
    // Overlapping boxes: the pointer lands at 200..240's exact centre, so its distance is zero
    // and it wins any contest it is allowed to enter. The taller box that *would* take the drop
    // is 20px away from its own centre and loses on geometry alone.
    const takes = mountTarget({ top: 200, height: 80 });
    const refuses = mountTarget({ top: 200, height: 40, canDrop: () => false });
    const held = await startPointerDrag(mountSource(7));

    await held.over(refuses.element);
    expect(takes.state.over).toBe(true);
    expect(refuses.state.over).toBe(false);
    await held.cancel();
  });

  it("says `over` for the one target under the pointer, and takes it back on the way out", async () => {
    const here = mountTarget();
    const there = mountTarget({ top: 400 });
    const held = await startPointerDrag(mountSource(7));

    await held.over(here.element);
    expect(here.state.over).toBe(true);
    expect(there.state.over).toBe(false);

    await held.over(there.element);
    expect(here.state.over).toBe(false);
    expect(there.state.over).toBe(true);

    await held.leave();
    expect(there.state.over).toBe(false);
    await held.cancel();
  });

  it("runs the handler on the target the pointer was over, with the payload", async () => {
    const onDrop = vi.fn();
    const target = mountTarget({ onDrop });
    const held = await startPointerDrag(mountSource(9));
    await held.over(target.element);
    await held.drop();

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith({ id: 9 });
  });

  /** Escape ends the drag the same way a drop does, so both flags have to stand down without this
   *  hook hearing a keypress — and nothing may be written. */
  it("writes nothing and stands down when the drag is cancelled", async () => {
    const onDrop = vi.fn();
    const target = mountTarget({ onDrop });
    const held = await startPointerDrag(mountSource(9));
    await held.over(target.element);
    await held.cancel();

    expect(onDrop).not.toHaveBeenCalled();
    expect(target.state.armed).toBe(false);
    expect(target.state.over).toBe(false);
  });

  /**
   * **`canDrop` is asked again on the drop, and the second answer is the one that writes.** The
   * two questions can be a second apart — a refetch lands, a folder is deleted — and only the
   * second one is in front of a write.
   */
  it("refuses on the drop a payload it accepted on the way in", async () => {
    const onDrop = vi.fn();
    const target = mountTarget({ onDrop });
    const held = await startPointerDrag(mountSource(9));
    await held.over(target.element);
    target.rerender({ canDrop: () => false });
    await held.drop();

    expect(onDrop).not.toHaveBeenCalled();
  });

  /** The handlers are read through a ref rather than through the effect's deps, so a page that
   *  re-renders mid-drag does not unregister the target the pointer is over. */
  it("keeps one registration across a re-render with new handlers", async () => {
    const onDrop = vi.fn();
    const target = mountTarget();
    const held = await startPointerDrag(mountSource(9));
    await held.over(target.element);
    target.rerender({ onDrop });
    await held.drop();

    expect(onDrop).toHaveBeenCalledWith({ id: 9 });
  });
});

describe("useDndDragging", () => {
  it("answers the payload while it is in the air and null before and after", async () => {
    const view = renderHook(() => useDndDragging(read));
    expect(view.result.current).toBeNull();

    const held = await startPointerDrag(mountSource(3));
    expect(view.result.current).toEqual({ id: 3 });

    await held.cancel();
    expect(view.result.current).toBeNull();
  });

  it("stays null for a drag it cannot read", async () => {
    const view = renderHook(() => useDndDragging(read));
    const element = boxed(document.createElement("div"), 0);
    document.body.append(element);
    const stranger = new Draggable(
      { id: dndId("stranger"), element, data: { somethingElse: true }, register: false },
      dndManager,
    );
    registerNow(stranger);
    undo.push(() => {
      stranger.destroy();
      element.remove();
    });

    const held = await startPointerDrag(element);
    expect(view.result.current).toBeNull();
    await held.cancel();
  });
});

/**
 * **A target that mounts in the middle of a drag.** Every target above is registered before the
 * press, which is the case the `dragstart` listener was written for. A virtualised wall mounts its
 * rows as they scroll in — and a reader carrying a card is exactly a reader who scrolls — so the
 * shelves' headings ask for `armOnMount` (spec §6). The plain target beside it is the fence that
 * the old rule is unchanged for everybody who did not ask.
 */
describe("useDndDropTarget with armOnMount", () => {
  it("arms a target that mounts in the middle of a drag, and only when asked to", async () => {
    const held = await startPointerDrag(mountSource(7));
    const asked = mountTarget({ armOnMount: true });
    const plain = mountTarget({ top: 400 });

    expect(asked.state.armed).toBe(true);
    expect(plain.state.armed).toBe(false);

    await held.cancel();
    expect(asked.state.armed).toBe(false);
  });

  it("does not arm a late target for a payload it would refuse", async () => {
    const held = await startPointerDrag(mountSource(7));
    const target = mountTarget({ armOnMount: true, canDrop: (thing) => thing.id !== 7 });

    expect(target.state.armed).toBe(false);
    await held.cancel();
  });

  it("takes the drop on a target that mounted mid-drag", async () => {
    const onDrop = vi.fn();
    const held = await startPointerDrag(mountSource(9));
    const target = mountTarget({ armOnMount: true, onDrop });

    await held.over(target.element);
    expect(target.state.over).toBe(true);
    await held.drop();
    expect(onDrop).toHaveBeenCalledWith({ id: 9 });
  });

  /** An `armOnMount` target reads the page's answer on every render rather than once at
   *  `dragstart` — the counts a page gates on can land while the reader is still holding. */
  it("follows the page's answer live while the drag is in the air", async () => {
    const target = mountTarget({ armOnMount: true });
    const held = await startPointerDrag(mountSource(9));
    expect(target.state.armed).toBe(true);

    target.rerender({ canDrop: () => false });
    expect(target.state.armed).toBe(false);
    await held.cancel();
  });
});

describe("useDragRecord", () => {
  it("answers the record in the air — before, during, after, and on a mount mid-drag", async () => {
    const early = renderHook(() => useDragRecord());
    expect(early.result.current).toBeNull();

    const held = await startPointerDrag(mountSource(5));
    expect(read(early.result.current!)).toEqual({ id: 5 });
    const late = renderHook(() => useDragRecord());
    expect(read(late.result.current!)).toEqual({ id: 5 });

    await held.cancel();
    expect(early.result.current).toBeNull();
    expect(late.result.current).toBeNull();
  });

  it("answers null when disabled, whatever is in the air", async () => {
    const off = renderHook(() => useDragRecord(false));
    const held = await startPointerDrag(mountSource(5));

    expect(off.result.current).toBeNull();
    await held.cancel();
  });
});

/**
 * **A target that is over only while the pointer is inside it** — the shelves' opt-in, from the live
 * pass's "Extra, found during 3". dnd-kit's default detector is `pointerIntersection ??
 * shapeIntersection`, and the fallback compares the **dragged card's whole rectangle** with the
 * target: a card carried over one shelf's tiles overlaps the next shelf's heading, which went over
 * and took the drop. Measured in the shipped window: a card released on tile 50 of `Foils` filed
 * into `Showcase`, 22px below.
 *
 * **Where the overlap is staged, and why there.** dnd-kit measures the carried card once, off the
 * source's own box, and jsdom never re-runs the effect that would move that measurement with the
 * pointer (`test-drag.ts`'s `settle` has the reading). So here the card's rectangle *is* the
 * source's: a source at 230–270 overlaps the 200–240 target by 10px, and its centre — where the
 * press lands — is 10px below the target. That is the shipped case exactly: the pointer outside, the
 * card it carries reaching in. The pointer is then walked further off, so nothing is under it.
 */
describe("useDndDropTarget with pointerOnly", () => {
  /** 10px of the carried card inside the 200–240 target; its centre 10px below it. */
  const OVERLAPPING = 230;
  /** Past the target and past the source: the pointer is over nothing at all. */
  const OFF = { x: 100, y: 330 };

  /** The fence for everybody who did not ask — the deck editor's piles, the sidebar, the quick
   *  zones: a card whose rectangle overlaps a target still lands on it, as it always has. */
  it("leaves a plain target taking a card that overlaps it with the pointer outside", async () => {
    const onDrop = vi.fn();
    const target = mountTarget({ onDrop });
    const held = await startPointerDrag(mountSource(7, OVERLAPPING));

    await held.moveTo(OFF.x, OFF.y);
    expect(target.state.over).toBe(true);
    await held.drop();
    expect(onDrop).toHaveBeenCalledWith({ id: 7 });
  });

  it("is not over, and takes nothing, while the pointer is outside it", async () => {
    const onDrop = vi.fn();
    const target = mountTarget({ onDrop, pointerOnly: true });
    const held = await startPointerDrag(mountSource(7, OVERLAPPING));

    await held.moveTo(OFF.x, OFF.y);
    expect(target.state.armed).toBe(true);
    expect(target.state.over).toBe(false);
    await held.drop();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("is over, and takes the drop, once the pointer is inside it", async () => {
    const onDrop = vi.fn();
    const target = mountTarget({ onDrop, pointerOnly: true });
    const held = await startPointerDrag(mountSource(7, OVERLAPPING));

    await held.moveTo(OFF.x, OFF.y);
    await held.over(target.element);
    expect(target.state.over).toBe(true);
    await held.drop();
    expect(onDrop).toHaveBeenCalledWith({ id: 7 });
  });
});
