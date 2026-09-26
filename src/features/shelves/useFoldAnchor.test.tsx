import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SHELF_HEADING_ATTR } from "@/features/shelves/ShelfHeading";
import { useFoldAnchor } from "./useFoldAnchor";

function Wall({ folding }: { folding: boolean }) {
  useFoldAnchor(folding);
  return (
    <main>
      <div {...{ [SHELF_HEADING_ATTR]: "3" }}>Trade binder</div>
      <p>Not a heading</p>
    </main>
  );
}

/** jsdom lays nothing out: the scroller's `scrollTop` is a plain property here, and each case
 *  says where the heading's box is. */
function mount() {
  const view = render(<Wall folding={false} />);
  const main = view.container.querySelector("main")!;
  let top = 1000;
  Object.defineProperty(main, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (next: number) => {
      top = next;
    },
  });
  const heading = view.container.querySelector<HTMLElement>(`[${SHELF_HEADING_ATTR}]`)!;
  const at = (y: number) => {
    heading.getBoundingClientRect = () => new DOMRect(0, y, 200, 40);
  };
  const press = (target: Element, clientY: number) =>
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY }));
  return { view, heading, at, press, scrollTop: () => top };
}

describe("useFoldAnchor", () => {
  it("scrolls the folded wall so the carried heading is back under the pointer", () => {
    const { view, heading, at, press, scrollTop } = mount();
    press(heading, 300);
    at(500);

    view.rerender(<Wall folding />);

    // The heading's centre (500 + 20) moves to the pointer's 300.
    expect(scrollTop()).toBe(1000 + 520 - 300);
  });

  it("anchors again when the wall unfolds, at wherever the pointer let go", () => {
    const { view, heading, at, press, scrollTop } = mount();
    press(heading, 300);
    at(300 - 20);
    view.rerender(<Wall folding />);
    expect(scrollTop()).toBe(1000);

    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 120 }));
    at(900);
    view.rerender(<Wall folding={false} />);

    expect(scrollTop()).toBe(1000 + 920 - 120);
  });

  it("moves nothing when the press that started the drag was not on a heading", () => {
    const { view, at, press, scrollTop } = mount();
    press(view.container.querySelector("p")!, 300);
    at(500);

    view.rerender(<Wall folding />);

    expect(scrollTop()).toBe(1000);
  });
});
