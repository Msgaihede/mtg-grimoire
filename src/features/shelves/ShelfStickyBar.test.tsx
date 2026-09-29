import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { SHELF_STICKY_HEIGHT } from "@/lib/shelfLayout";
import type { Shelf } from "@/lib/shelves";
import { SHELF_STICKY_ATTR, ShelfStickyBar } from "./ShelfStickyBar";

function shelfOf(over: Partial<Shelf> & { id: number; name: string }): Shelf {
  return {
    kind: "folder",
    group: "own",
    pathIds: [over.id],
    path: [over.name],
    depth: 0,
    indent: 0,
    lead: [],
    leadIds: [],
    headless: false,
    collapsed: false,
    locked: false,
    ...over,
  };
}

const FETCHLANDS = shelfOf({
  id: 12,
  name: "Fetchlands",
  depth: 2,
  indent: 2,
  pathIds: [3, 8, 12],
  path: ["Binder", "Staples", "Fetchlands"],
});

const onOpen = vi.fn();
const onTop = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
});

const bar = () => document.querySelector<HTMLElement>(`[${SHELF_STICKY_ATTR}]`)!;
const marked = (element: Element, mark: string) =>
  mark.split(" ").every((one) => element.classList.contains(one));

describe("ShelfStickyBar", () => {
  it("draws nothing when no shelf is under the top of the wall", () => {
    const { container } = render(<ShelfStickyBar shelf={null} onOpen={onOpen} onTop={onTop} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the shelf the reader is inside, root-most first, and opens each step", async () => {
    const user = userEvent.setup();
    render(<ShelfStickyBar shelf={FETCHLANDS} onOpen={onOpen} onTop={onTop} />);

    const nav = screen.getByRole("navigation", { name: "Current shelf" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Binder",
      "Staples",
      "Fetchlands",
    ]);
    await user.click(within(nav).getByRole("button", { name: "Staples" }));
    expect(onOpen).toHaveBeenCalledWith(8);
    expect(within(nav).getByRole("button", { name: "Fetchlands" })).toHaveAttribute(
      "aria-current",
      "location",
    );
    expect(within(nav).getByRole("button", { name: "Binder" })).not.toHaveAttribute("aria-current");
  });

  it("draws Not sorted as words rather than a door", () => {
    render(
      <ShelfStickyBar
        shelf={shelfOf({ id: 0, name: "Not sorted", kind: "unfiled" })}
        onOpen={onOpen}
        onTop={onTop}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Current shelf" });
    expect(within(nav).queryAllByRole("button")).toHaveLength(0);
    expect(within(nav).getByText("Not sorted")).toHaveAttribute("aria-current", "location");
  });

  /**
   * **The bar is exactly as tall as the room the wall reserves for it.** `CardGrid` hands the
   * virtualiser `SHELF_STICKY_HEIGHT` as its scroll padding at the start (final review S-M2), so a
   * row a reveal or an arrow walk aligns to the top lands under the bar's bottom edge. A bar sized
   * by a class of its own could drift from that number and put the row back under the bar; sized
   * from the constant, there is one number. No `h-*` class may sit beside it and win or lose.
   */
  it("takes its height from the room the wall reserves for it", () => {
    render(<ShelfStickyBar shelf={FETCHLANDS} onOpen={onOpen} onTop={onTop} />);
    expect(bar().style.height).toBe(`${SHELF_STICKY_HEIGHT}px`);
    expect([...bar().classList].filter((name) => /^h-/.test(name))).toEqual([]);
  });

  it("goes back to the top", async () => {
    const user = userEvent.setup();
    render(<ShelfStickyBar shelf={FETCHLANDS} onOpen={onOpen} onTop={onTop} />);

    const top = screen.getByRole("button", { name: "Top" });
    expect(top).toHaveAccessibleName("Top");
    await user.click(top);
    expect(onTop).toHaveBeenCalledTimes(1);
  });

  /**
   * **One Top on screen** (filter quick bar, spec §6.2): while the quick bar is docked over the
   * wall it carries the page's Top, so the page hands this bar no `onTop` and the button is not
   * drawn — absent rather than greyed, because a second Top a few pixels under the first is only
   * a second thing to read.
   */
  it("draws Top only when given onTop", () => {
    const { rerender } = render(
      <ShelfStickyBar shelf={FETCHLANDS} onOpen={() => {}} onTop={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /top/i })).toBeInTheDocument();
    rerender(<ShelfStickyBar shelf={FETCHLANDS} onOpen={() => {}} />);
    expect(screen.queryByRole("button", { name: /top/i })).toBeNull();
  });

  /** Spec §5.3/§6: the bar is a permanent target for a card — "file it into the shelf I am in". */
  it("hands the whole bar to the page as one drop target", () => {
    const dropRef = vi.fn();
    render(<ShelfStickyBar shelf={FETCHLANDS} onOpen={onOpen} onTop={onTop} dropRef={dropRef} />);
    expect(dropRef).toHaveBeenCalledWith(bar());
  });

  /** No border of its own around it, so the borderless vocabulary: `DROP_RING`, then `DROP_OVER`. */
  it("rings while it could take a card, and washes under the pointer", () => {
    const view = render(<ShelfStickyBar shelf={FETCHLANDS} onOpen={onOpen} onTop={onTop} />);
    expect(marked(bar(), DROP_RING)).toBe(false);

    view.rerender(
      <ShelfStickyBar shelf={FETCHLANDS} onOpen={onOpen} onTop={onTop} dropMark="armed" />,
    );
    expect(marked(bar(), DROP_RING)).toBe(true);
    expect(marked(bar(), DROP_OVER)).toBe(false);

    view.rerender(
      <ShelfStickyBar shelf={FETCHLANDS} onOpen={onOpen} onTop={onTop} dropMark="over" />,
    );
    expect(marked(bar(), DROP_OVER)).toBe(true);
    // The ring stays and goes to full strength — `ring-accent` replaces `ring-accent/45` in the
    // colour group, and the width is untouched.
    expect(bar()).toHaveClass("ring-1");
    expect(bar()).not.toHaveClass("ring-accent/45");
  });
});
