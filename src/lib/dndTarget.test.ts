import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Draggable } from "@dnd-kit/dom";
import { dndId, dndManager, registerNow } from "@/lib/dndManager";
import { useDndDragging, useDndDropTarget } from "@/lib/dndTarget";
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

function mountSource(id: number): HTMLElement {
  const element = boxed(document.createElement("div"), 0);
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
