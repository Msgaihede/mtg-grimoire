import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
  TooltipProvider,
} from "@/components/tooltip/TooltipProvider";
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
   * stays to the point; the tooltip is what a pointer gets on hover, where there is room to
   * say which rules count the card. The same split `FinishMark` makes.
   *
   * `describes: false`, since `GAME_CHANGER_LABEL` is already this glyph's `aria-label` — so the
   * panel carries no `role="tooltip"` and is found by its stable id instead.
   */
  it("names the fact briefly and explains it on hover", () => {
    vi.useFakeTimers();
    render(
      <TooltipProvider>
        <GameChangerMark />
      </TooltipProvider>,
    );

    const mark = screen.getByRole("img", { name: GAME_CHANGER_LABEL });
    fireEvent.pointerEnter(mark);
    act(() => void vi.advanceTimersByTime(TOOLTIP_OPEN_MS));
    expect(document.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent(GAME_CHANGER_HINT);
    expect(mark).not.toHaveAttribute("aria-describedby");
    vi.useRealTimers();
  });

  /** Placement is the caller's — a chip over card art and a badge in a row want different
   *  boxes — while the size and the gold stay here, so one fact keeps one colour. */
  it("takes placement from its caller and keeps its own gold", () => {
    render(<GameChangerMark className="absolute top-1" />);

    const mark = screen.getByRole("img", { name: GAME_CHANGER_LABEL });
    // 12px is the glyph on a card at 100% zoom: every surface that draws this draws a card the
    // reader can zoom, so the size is a multiple of the card's own `--mark-scale` rather than a
    // constant. The `, 1` fallback is what leaves it at 12px anywhere the variable is unset.
    expect(mark).toHaveClass(
      "absolute",
      "top-1",
      "text-pie-gold",
      "size-[calc(0.75rem*var(--mark-scale,1))]",
    );
  });
});
