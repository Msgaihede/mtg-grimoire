import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GAME_CHANGER_HINT, GAME_CHANGER_LABEL, GameChangerMark } from "./GameChangerMark";

describe("GameChangerMark", () => {
  /**
   * A crown, not the deck views' `GC` letters — the one design decision this component exists
   * to hold. A search tile's chip is about two glyphs wide, where an abbreviation of an
   * abbreviation is read by nobody, so the glyph has to carry the meaning on its own. Asserted
   * by lucide's own icon class, because that is the only thing in the rendered markup that says
   * *which* glyph was chosen; swapping it for a star would otherwise pass every other test here.
   */
  it("draws a crown", () => {
    const { container } = render(<GameChangerMark />);
    expect(container.querySelector("svg")).toHaveClass("lucide-crown");
  });

  /**
   * Two strings for two readers. The name is what a screen reader announces beside a card and
   * stays to the point; the `<title>` is what a pointer gets on hover, where there is room to
   * say which rules count the card. The same split `FinishMark` makes.
   */
  it("names the fact briefly and explains it on hover", () => {
    render(<GameChangerMark />);

    const mark = screen.getByRole("img", { name: GAME_CHANGER_LABEL });
    expect(mark.querySelector("title")).toHaveTextContent(GAME_CHANGER_HINT);
  });

  /** Placement is the caller's — a chip over card art and a badge in a row want different
   *  boxes — while the size and the gold stay here, so one fact keeps one colour. */
  it("takes placement from its caller and keeps its own gold", () => {
    render(<GameChangerMark className="absolute top-1" />);

    const mark = screen.getByRole("img", { name: GAME_CHANGER_LABEL });
    expect(mark).toHaveClass("absolute", "top-1", "text-pie-gold", "size-3");
  });
});
