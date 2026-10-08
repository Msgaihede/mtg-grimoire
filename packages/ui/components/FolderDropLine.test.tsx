import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FOLDER_DROP_LINE_ATTR, FolderDropLine } from "./FolderDropLine";

/**
 * The line has no role, no name and no text, so `FOLDER_DROP_LINE_ATTR` is the only handle these
 * tests have — which is the attribute's whole reason for existing, and why it carries the edge as
 * its value rather than an empty string.
 */
function line(container: HTMLElement): HTMLElement | null {
  return container.querySelector(`[${FOLDER_DROP_LINE_ATTR}]`);
}

describe("FolderDropLine", () => {
  it("names the end of the folder it is drawn on", () => {
    for (const edge of ["before", "after"] as const) {
      const { container } = render(<FolderDropLine edge={edge} axis="vertical" />);
      expect(line(container)).toHaveAttribute(FOLDER_DROP_LINE_ATTR, edge);
    }
  });

  /**
   * **`inside` is not this component's mark.** A folder taking the drag already wears
   * `DROP_RING`, the ring every folder-shaped target in the window uses; a second vocabulary for
   * one meaning is the thing worth refusing. Taking the whole `FolderEdge` rather than only its
   * two positional words is what keeps the three call sites from each writing this ternary.
   */
  it("draws nothing for a nest, and nothing for no landing at all", () => {
    for (const edge of ["inside", null] as const) {
      const { container } = render(<FolderDropLine edge={edge} axis="vertical" />);
      expect(line(container)).toBeNull();
      expect(container).toBeEmptyDOMElement();
    }
  });

  /**
   * The axis is the whole of what a tree row and a card in a grid differ by, so it has to reach
   * the drawing — `before` is the top edge of a row and the leading side of a card, and a line on
   * the wrong axis is a promise to file the folder somewhere it is not going.
   *
   * **jsdom applies no stylesheet**, so this is an assertion about the class list rather than
   * about pixels: `classList.contains`, not `className.includes`, because a substring match is
   * satisfied by `inset-x-0` inside `inset-x-0` and by every `top-*` there might one day be.
   * Where the line actually lands is the live pass's to prove.
   */
  it("lies across the axis the folders are laid out along", () => {
    const at = (edge: "before" | "after", axis: "vertical" | "horizontal") => {
      const { container } = render(<FolderDropLine edge={edge} axis={axis} />);
      return [...line(container)!.classList];
    };

    expect(at("before", "vertical")).toEqual(
      expect.arrayContaining(["inset-x-0", "h-0.5", "top-0"]),
    );
    expect(at("after", "vertical")).toEqual(
      expect.arrayContaining(["inset-x-0", "h-0.5", "bottom-0"]),
    );
    expect(at("before", "horizontal")).toEqual(
      expect.arrayContaining(["inset-y-0", "w-0.5", "left-0"]),
    );
    expect(at("after", "horizontal")).toEqual(
      expect.arrayContaining(["inset-y-0", "w-0.5", "right-0"]),
    );
  });

  /**
   * Two properties with a shipped failure each behind them, both invisible to a rendering test
   * that only looked at the picture.
   *
   * `pointer-events-none`: a native drag hit-tests with `elementFromPoint`, so a decoration that
   * can answer it is a decoration that decides where the folder goes — and it is drawn *at* the
   * edge the pointer has to reach to mean "beside this one".
   *
   * `aria-hidden`: this narrates a gesture only a pointer can make, and announcing a line to a
   * reader who cannot be dragging anything is noise with no action behind it.
   */
  it("is inert to the pointer and silent to a screen reader", () => {
    const { container } = render(<FolderDropLine edge="before" axis="vertical" />);
    const mark = line(container)!;
    expect(mark.classList.contains("pointer-events-none")).toBe(true);
    expect(mark).toHaveAttribute("aria-hidden", "true");
  });

  /** The app's own accent, from the app's own token — the direction doc reserves gold for
   *  interactive emphasis and a drop landing is exactly that. Nothing here mixes a colour of its
   *  own, which is half of why the component is twelve lines rather than a dependency. */
  it("draws the app's accent and nothing it mixed itself", () => {
    const { container } = render(<FolderDropLine edge="after" axis="horizontal" />);
    expect(line(container)!.classList.contains("bg-accent")).toBe(true);
  });
});
