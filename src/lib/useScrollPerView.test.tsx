import { render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { useScrollPerView } from "./useScrollPerView";

/**
 * A page with one scroller and a view key, the shape the deck editor has.
 *
 * The scroller's `overflow-y` is **inline**, because jsdom applies no stylesheet and
 * `nearestScroller` would otherwise find nothing — which is the state every other suite that
 * mounts the editor is in, and why this hook is proved here rather than there. `park` is handed
 * out through a callback so a case can press it the way the view picker does: before the key moves.
 */
function Page({ view, onPark }: { view: string; onPark: (park: () => void) => void }) {
  const anchor = useRef<HTMLDivElement>(null);
  const park = useScrollPerView(anchor, view);
  onPark(park);
  return (
    <div data-testid="scroller" style={{ overflowY: "auto" }}>
      <div ref={anchor}>{view}</div>
    </div>
  );
}

function mount(view: string) {
  let park = () => {};
  const utils = render(<Page view={view} onPark={(p) => (park = p)} />);
  const scroller = utils.getByTestId("scroller");
  const switchTo = (next: string) => {
    park();
    utils.rerender(<Page view={next} onPark={(p) => (park = p)} />);
  };
  return { scroller, switchTo };
}

describe("useScrollPerView", () => {
  it("opens a view never visited at the top, whatever the last one was scrolled to", () => {
    const { scroller, switchTo } = mount("stacks");
    scroller.scrollTop = 2000;

    switchTo("grid");
    expect(scroller.scrollTop).toBe(0);
  });

  it("hands each view back the position it was left at", () => {
    const { scroller, switchTo } = mount("stacks");
    scroller.scrollTop = 2000;
    switchTo("grid");
    scroller.scrollTop = 350;

    switchTo("stacks");
    expect(scroller.scrollTop).toBe(2000);
    switchTo("grid");
    expect(scroller.scrollTop).toBe(350);
  });

  it("leaves the scroller alone on the first render and on a render that keeps the view", () => {
    const { scroller, switchTo } = mount("stacks");
    scroller.scrollTop = 640;

    switchTo("stacks");
    expect(scroller.scrollTop).toBe(640);
  });
});
