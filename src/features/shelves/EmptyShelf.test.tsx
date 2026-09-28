import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DROP_EDGE, DROP_OVER } from "@/lib/dropMarks";
import { EMPTY_SHELF_ATTR, EMPTY_SHELF_COPY, EmptyShelf } from "./EmptyShelf";

const box = () => document.querySelector<HTMLElement>(`[${EMPTY_SHELF_ATTR}]`)!;
const marked = (element: Element, mark: string) =>
  mark.split(" ").every((one) => element.classList.contains(one));

describe("EmptyShelf", () => {
  /** The words are the spec's (§3.8), fenced as a literal so a rewording is a diff about them. */
  it("says what to do with an empty folder", () => {
    render(<EmptyShelf />);
    expect(EMPTY_SHELF_COPY).toBe(
      "Empty. Drag cards here or use Move to folder…",
    );
    expect(screen.getByText(EMPTY_SHELF_COPY)).toBeInTheDocument();
  });

  /** Dashed: the container vocabulary the folder cards already use — this is a drawer, empty. */
  it("is dashed at rest, and carries no drop mark", () => {
    render(<EmptyShelf />);
    expect(box()).toHaveClass("border-dashed");
    expect(marked(box(), DROP_EDGE)).toBe(false);
    expect(marked(box(), DROP_OVER)).toBe(false);
  });

  it("hands the box to the page as a drop target", () => {
    const dropRef = vi.fn();
    render(<EmptyShelf dropRef={dropRef} />);
    expect(dropRef).toHaveBeenCalledWith(box());
  });

  it("golds its dash while it could take a card, and washes under the pointer", () => {
    const view = render(<EmptyShelf dropMark="armed" />);
    expect(marked(box(), DROP_EDGE)).toBe(true);
    expect(marked(box(), DROP_OVER)).toBe(false);

    view.rerender(<EmptyShelf dropMark="over" />);
    expect(marked(box(), DROP_OVER)).toBe(true);
    expect(box()).toHaveClass("border-accent");
  });
});
