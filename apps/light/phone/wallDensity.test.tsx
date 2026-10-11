import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useWallColumns, useWallDensity } from "./wallDensity";

function Wall({ width }: { width: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const columns = useWallColumns(scroller, width);
  return (
    <div ref={scroller} data-testid="wall">
      {columns}
    </div>
  );
}

const finger = (x: number) => ({ clientX: x, clientY: 0 });

/** Two fingers down `from` px apart, then moved to `to` px apart. */
function pinch(el: HTMLElement, from: number, to: number) {
  fireEvent.touchStart(el, { touches: [finger(0), finger(from)] });
  fireEvent.touchMove(el, { touches: [finger(0), finger(to)] });
  fireEvent.touchEnd(el, { touches: [] });
}

beforeEach(() => useWallDensity.getState().setOffset(0));

describe("a pinch on a card wall", () => {
  it("draws smaller cards when the fingers close, and bigger when they open", () => {
    render(<Wall width={336} />);
    const wall = screen.getByTestId("wall");
    expect(wall).toHaveTextContent("2");

    pinch(wall, 200, 100);
    expect(wall).toHaveTextContent("3");

    pinch(wall, 100, 200);
    pinch(wall, 100, 200);
    expect(wall).toHaveTextContent("1");
  });

  it("is remembered for every wall, and stops where the width does", () => {
    const { unmount } = render(<Wall width={336} />);
    const wall = screen.getByTestId("wall");
    for (let i = 0; i < 6; i++) pinch(wall, 200, 100);
    expect(wall).toHaveTextContent("4");
    unmount();

    render(<Wall width={336} />);
    expect(screen.getByTestId("wall")).toHaveTextContent("4");
    // One step back in, whatever the pinches past the stop asked for.
    pinch(screen.getByTestId("wall"), 100, 200);
    expect(screen.getByTestId("wall")).toHaveTextContent("3");
  });

  it("leaves one finger to the wall's own scroll", () => {
    render(<Wall width={336} />);
    const wall = screen.getByTestId("wall");
    fireEvent.touchStart(wall, { touches: [finger(0)] });
    fireEvent.touchMove(wall, { touches: [finger(200)] });
    expect(wall).toHaveTextContent("2");
  });
});
