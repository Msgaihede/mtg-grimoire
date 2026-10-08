import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CardWall, type WallItem } from "./CardWall";
import { installLayout } from "./testing";

// A wall is virtualised and jsdom lays nothing out: without this no row is ever drawn.
beforeAll(installLayout);

const item = (n: number, over: Partial<WallItem> = {}): WallItem => ({
  key: `k${n}`,
  // A card to open: a tile with none is no control at all (`WallTile`), which one case below holds.
  cardId: `card-${n}`,
  name: `Card ${n}`,
  rarity: "common",
  chin: { setCode: "lea", collectorNumber: String(n) },
  finish: null,
  money: "$1.00",
  count: 1,
  pressLabel: `Card ${n}, LEA ${n}`,
  ...over,
});

const many = (length: number): WallItem[] => Array.from({ length }, (_, n) => item(n));

const noop = () => undefined;

const tile = (n: number) => screen.queryByRole("button", { name: `Card ${n}, LEA ${n}` });

describe("the wall's tiles", () => {
  it("draws a card with nothing to open as a tile that is no control", () => {
    render(
      <CardWall
        label="Wall"
        items={[item(0), item(1, { cardId: null })]}
        onOpen={noop}
        resetKey="a"
      />,
    );
    expect(tile(0)).toBeInTheDocument();
    expect(tile(1)).toBeNull();
    expect(screen.getAllByText("Card 1").length).toBeGreaterThan(0);
  });

  it("draws a tile for every card of a short list, two to a row", () => {
    render(<CardWall label="Wall" items={many(3)} onOpen={noop} resetKey="a" />);
    const wall = screen.getByRole("list", { name: "Wall" });

    expect(
      within(wall)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Card 0, LEA 0", "Card 1, LEA 1", "Card 2, LEA 2"]);
    // Unmeasured, a wall is two columns: three cards are a full row and a short one.
    expect(within(wall).getAllByRole("listitem")).toHaveLength(2);
  });

  it("draws a window of a long list, not all of it", () => {
    render(<CardWall label="Wall" items={many(400)} onOpen={noop} resetKey="a" />);
    const wall = screen.getByRole("list", { name: "Wall" });

    // A named tile at each end rather than a count: how many rows the window holds is the
    // harness's two numbers, and a count would re-measure them.
    expect(tile(0)).toBeInTheDocument();
    expect(tile(399)).toBeNull();
    expect(within(wall).getAllByRole("button").length).toBeLessThan(400);
  });

  it("hands a press to onOpen with the tile's own item", () => {
    const items = many(3);
    const onOpen = vi.fn();
    render(<CardWall label="Wall" items={items} onOpen={onOpen} resetKey="a" />);

    fireEvent.click(tile(2) as HTMLElement);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(items[2]);
  });
});

describe("the wall's count", () => {
  it("says the copies in the tile's name, because the tag itself is hidden from a reader", () => {
    render(
      <CardWall
        label="Wall"
        items={[item(0), item(1, { count: 4 })]}
        onOpen={noop}
        resetKey="a"
      />,
    );

    // The whole computed name, on the element: the tag is `aria-hidden` and inside the button,
    // so a name asserted in parts would pass with the count reaching nobody.
    expect(screen.getByRole("button", { name: /^Card 1, / })).toHaveAccessibleName(
      "Card 1, LEA 1, 4 copies",
    );
    expect(screen.getByRole("button", { name: /^Card 0, / })).toHaveAccessibleName("Card 0, LEA 0");
  });

  it("draws the tag on the art itself, and only above one copy", () => {
    render(
      <CardWall
        label="Wall"
        items={[item(0), item(1, { count: 4 })]}
        onOpen={noop}
        resetKey="a"
      />,
    );
    const counted = screen.getByRole("button", { name: /^Card 1, / });
    const tag = within(counted).getByText("4");

    expect(tag).toHaveAttribute("aria-hidden", "true");
    // No chip around it: the tag is a filled banner already, and a backed box round one is the
    // square chip that reads as something to press.
    expect(tag.parentElement).toBe(counted);
    expect(within(screen.getByRole("button", { name: /^Card 0, / })).queryByText("1")).toBeNull();
  });
});

describe("asking for more", () => {
  it("asks once for a list short enough to be all on screen", () => {
    const onNearEnd = vi.fn();
    render(<CardWall label="Wall" items={many(3)} onOpen={noop} onNearEnd={onNearEnd} resetKey="a" />);
    // Once, and after the rows are drawn. The first render draws none — the scroller has not been
    // measured — and "no row yet" must not read as "the reader is at the end".
    expect(onNearEnd).toHaveBeenCalledTimes(1);
  });

  it("asks nothing of a wall that has drawn no row", () => {
    // A scroller with no height: what every wall is on its first render, held for the whole test.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 0 });
    try {
      const onNearEnd = vi.fn();
      render(<CardWall label="Wall" items={many(3)} onOpen={noop} onNearEnd={onNearEnd} resetKey="a" />);
      const wall = screen.getByRole("list", { name: "Wall" });

      // The premise first — or this passes on a wall that drew its rows after all.
      expect(within(wall).queryAllByRole("button")).toHaveLength(0);
      expect(onNearEnd).not.toHaveBeenCalled();
    } finally {
      installLayout();
    }
  });

  it("asks nothing while the reader is far from the end", () => {
    const onNearEnd = vi.fn();
    render(<CardWall label="Wall" items={many(400)} onOpen={noop} onNearEnd={onNearEnd} resetKey="a" />);
    expect(onNearEnd).not.toHaveBeenCalled();
  });

  it("does not ask again because the callback is a new function", () => {
    const items = many(3);
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <CardWall label="Wall" items={items} onOpen={noop} onNearEnd={first} resetKey="a" />,
    );
    rerender(<CardWall label="Wall" items={items} onOpen={noop} onNearEnd={second} resetKey="a" />);

    // A page hands down a new closure whenever its query moves. That is not the reader moving.
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("asks the newest callback when more rows arrive and the end is still near", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <CardWall label="Wall" items={many(3)} onOpen={noop} onNearEnd={first} resetKey="a" />,
    );
    rerender(<CardWall label="Wall" items={many(5)} onOpen={noop} onNearEnd={second} resetKey="a" />);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("a different list", () => {
  it("starts at its top, and the same list stays where the reader left it", async () => {
    const items = many(400);
    const { container, rerender } = render(
      <CardWall label="Wall" items={items} onOpen={noop} resetKey="a" />,
    );
    const scroller = container.firstElementChild as HTMLElement;
    // jsdom scrolls nothing, and the harness's `scrollTo` is a stub. Give this one scroller what
    // a browser's has: the offset moves, and the `scroll` event follows in a task of its own.
    // (Defined, not assigned — the stub on the prototype is read-only.)
    Object.defineProperty(scroller, "scrollTo", {
      configurable: true,
      value: (to: ScrollToOptions) => {
        scroller.scrollTop = to.top ?? 0;
        setTimeout(() => fireEvent.scroll(scroller));
      },
    });

    fireEvent.scroll(scroller, { target: { scrollTop: 10_000 } });
    expect(tile(0)).toBeNull();

    rerender(<CardWall label="Wall" items={items} onOpen={noop} resetKey="a" />);
    expect(scroller.scrollTop).toBe(10_000);

    rerender(<CardWall label="Wall" items={items} onOpen={noop} resetKey="b" />);
    expect(scroller.scrollTop).toBe(0);
    expect(await screen.findByRole("button", { name: "Card 0, LEA 0" })).toBeInTheDocument();
  });
});
