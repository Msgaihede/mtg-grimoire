import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CardImage } from "./CardImage";

const BOLT = "http://mtgimg.localhost/grid/aaa/0";
const RECALL = "http://mtgimg.localhost/grid/bbb/0";

describe("CardImage", () => {
  /**
   * The whole reason this component exists. A browser keeps painting an `<img>`'s last
   * decoded frame until the new `src` decodes, and every card frame in this app belongs to
   * a *slot* rather than to a card — a tile in a virtualised wall, a deck's cover, the open
   * card in the pane. So the caption, the badge and the price flip the instant the data
   * lands while the picture stays on the card before it, which reads as the app showing the
   * wrong card's art.
   */
  it("draws a new element for a new card rather than repainting the one before it", () => {
    const { rerender } = render(<CardImage src={BOLT} alt="Lightning Bolt" />);
    const first = screen.getByAltText("Lightning Bolt");

    rerender(<CardImage src={RECALL} alt="Ancestral Recall" />);

    // A *different* element, not the same one wearing a new `src`: the old one is what was
    // holding the old card's pixels, so it has to leave with the card it belonged to.
    expect(screen.getByAltText("Ancestral Recall")).not.toBe(first);
    expect(first).not.toBeInTheDocument();
  });

  /**
   * The other half, and the one that would make this component a bug: the wall re-renders
   * on every scrolled row, and an element replaced on every render is an image re-requested
   * and re-decoded on every render — a flicker where there used to be a picture.
   */
  it("keeps the element it has for as long as the card is the same", () => {
    const { rerender } = render(<CardImage src={BOLT} alt="Lightning Bolt" />);
    const first = screen.getByAltText("Lightning Bolt");

    rerender(<CardImage src={BOLT} alt="Lightning Bolt" className="changed" />);

    expect(screen.getByAltText("Lightning Bolt")).toBe(first);
  });

  /** Whatever the caller hangs on it — this stands in for a bare `<img>`, not beside one. */
  it("passes the caller's own attributes through to the image", () => {
    render(<CardImage src={BOLT} alt="Lightning Bolt" draggable={false} className="size-full" />);

    const img = screen.getByAltText("Lightning Bolt");
    expect(img).toHaveAttribute("draggable", "false");
    expect(img).toHaveClass("size-full");
  });
});
