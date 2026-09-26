import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHELF_ID_ATTR,
  shelfCarry,
  type ShelfAnchorRequest,
} from "@/features/search/CardGrid";
import { useFoldAnchor } from "./useFoldAnchor";

/**
 * **The page's half of the fold anchor** — what `useFoldAnchor` turns the pointer, the keys and
 * the page's fold flag into. The wall's half (where a row is, the room, the scroll) is
 * `CardGrid.shelves.test.tsx`'s; here a spy stands in for the wall and every request is read off
 * it, so these cases say *which* heading goes *where*, and nothing about pixels in a wall.
 *
 * jsdom lays nothing out: each pressed row states its own box.
 */
function Page({ folding }: { folding: boolean }) {
  useFoldAnchor(folding);
  return (
    <div>
      <div data-shelf-row="heading" {...{ [SHELF_ID_ATTR]: "3" }}>
        <button type="button">Trade binder</button>
      </div>
      <div data-shelf-row="heading" {...{ [SHELF_ID_ATTR]: "9" }}>
        <button type="button">Binder</button>
      </div>
      <p>Not a heading</p>
    </div>
  );
}

let wall: ReturnType<typeof vi.fn<(request: ShelfAnchorRequest) => void>>;
let detach: () => void;
beforeEach(() => {
  shelfCarry.reset();
  wall = vi.fn();
  detach = shelfCarry.attach(wall);
});
afterEach(() => {
  detach();
  Reflect.deleteProperty(document, "elementsFromPoint");
});

function mount() {
  const view = render(<Page folding={false} />);
  const row = (id: string) =>
    view.container.querySelector<HTMLElement>(`[${SHELF_ID_ATTR}="${id}"]`)!;
  /** Press inside a heading row whose top is at `top`. */
  const press = (id: string, top: number, clientY: number) => {
    row(id).getBoundingClientRect = () => new DOMRect(0, top, 400, 40);
    fireEvent.pointerDown(row(id).querySelector("button")!, { clientX: 50, clientY });
  };
  const fold = () => view.rerender(<Page folding />);
  const unfold = () => view.rerender(<Page folding={false} />);
  return { view, row, press, fold, unfold };
}

describe("useFoldAnchor", () => {
  it("anchors the pressed heading at the pointer, less where it was grabbed, when the wall folds", () => {
    const { press, fold } = mount();
    press("3", 280, 300);
    fireEvent.pointerMove(window, { clientX: 50, clientY: 330 });

    fold();

    expect(wall).toHaveBeenCalledTimes(1);
    expect(wall).toHaveBeenLastCalledWith({ shelfId: 3, top: 310, room: true });
  });

  it("brings the heading back to the pointer on Escape, with no room on the real page", () => {
    const { press, fold, unfold } = mount();
    press("3", 280, 300);
    fold();
    fireEvent.pointerMove(window, { clientX: 50, clientY: 120 });

    fireEvent.keyDown(window, { key: "Escape" });
    unfold();

    expect(wall).toHaveBeenLastCalledWith({ shelfId: 3, top: 100, room: false });
    // A cancelled drag moved nothing, so there is nothing to settle on.
    expect(shelfCarry.settling()).toBeNull();
  });

  it("holds the heading the drop was let go over, then settles the moved heading at the pointer", () => {
    const { row, press, fold, unfold } = mount();
    press("3", 280, 300);
    fold();
    row("9").getBoundingClientRect = () => new DOMRect(0, 450, 400, 40);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      // The carried heading's own floating copy is on top under the pointer, and is passed over.
      value: vi.fn(() => [row("3"), row("9")]),
    });

    fireEvent.pointerUp(window, { clientX: 50, clientY: 460 });
    unfold();

    expect(wall).toHaveBeenLastCalledWith({ shelfId: 9, top: 450, room: false });
    expect(shelfCarry.settling()).toEqual({ shelfId: 3, top: 440, room: false });
  });

  it("ends the settling when the reader takes the page — a wheel, or a key", () => {
    const { press, fold, unfold } = mount();
    for (const takeOver of [
      () => fireEvent.wheel(window, { deltaY: 40 }),
      () => fireEvent.keyDown(window, { key: "ArrowDown" }),
    ]) {
      press("3", 280, 300);
      fold();
      fireEvent.pointerUp(window, { clientX: 50, clientY: 460 });
      unfold();
      expect(shelfCarry.settling()).not.toBeNull();

      takeOver();

      expect(shelfCarry.settling()).toBeNull();
    }
  });

  /** Fix round 1, Minor 4: a carry that outlived its drag kept the moved heading force-mounted.
   *  A drop's settling runs out after two seconds, and the carry goes on the frame after. */
  it("lets the carry go when a drop's settling runs out", () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    });
    try {
      const { press, fold, unfold } = mount();
      press("3", 280, 300);
      fold();
      fireEvent.pointerUp(window, { clientX: 50, clientY: 460 });
      unfold();
      expect(shelfCarry.settling()).not.toBeNull();

      vi.advanceTimersByTime(1999);
      expect(shelfCarry.carried()).toBe(3);

      vi.advanceTimersByTime(1 + 32);
      expect(shelfCarry.settling()).toBeNull();
      expect(shelfCarry.carried()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries nothing when the press was not on a heading", () => {
    const { view, fold, unfold } = mount();
    fireEvent.pointerDown(view.container.querySelector("p")!, { clientY: 300 });

    fold();
    unfold();

    expect(shelfCarry.carried()).toBeNull();
    expect(wall).not.toHaveBeenCalled();
  });

  it("forgets a press that came up before any fold, and everything when the page goes", () => {
    const { view, press } = mount();
    press("3", 280, 300);
    expect(shelfCarry.carried()).toBe(3);
    fireEvent.pointerUp(window, { clientX: 50, clientY: 300 });
    expect(shelfCarry.carried()).toBeNull();

    press("9", 100, 110);
    view.unmount();

    expect(shelfCarry.carried()).toBeNull();
  });
});
