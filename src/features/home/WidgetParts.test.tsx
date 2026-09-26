import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TOOLTIP_PANEL_ID } from "@/components/tooltip/TooltipPanel";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";

import { WidgetFooterLine } from "./WidgetParts";

/**
 * **A footer that may wrap is a second line nothing reserved** — the live pass of 2026-09-26 found
 * Wishlist savings' `1 more has no price at Cardmarket to compare against` on two and three lines
 * and a body scrolling under it. So the four round-two widgets draw their footers through this one
 * piece, which is one line at any width: the short wording, truncated, with the whole sentence as
 * its hint and as what a screen reader hears. jsdom lays nothing out, so what can be pinned here is
 * the structure — the class that makes it one line, the two spellings and which one is spoken.
 */
describe("WidgetFooterLine", () => {
  const LINE = "1 more: no Cardmarket price";
  const SAID = "1 more has no price at Cardmarket to compare against";

  it("draws the short line on one line and speaks the whole sentence", () => {
    render(<WidgetFooterLine line={LINE} said={SAID} />);

    const drawn = screen.getByText(LINE);
    expect(drawn).toHaveAttribute("aria-hidden", "true");
    const footer = drawn.closest("p");
    expect(footer).not.toBeNull();
    // One line, cut with an ellipsis rather than wrapped: `truncate` is `nowrap` + `ellipsis`.
    expect(footer?.classList.contains("truncate")).toBe(true);
    // The sentence is the footer's text for a screen reader, and only the sentence.
    const spoken = screen.getByText(SAID);
    expect(spoken.classList.contains("sr-only")).toBe(true);
    expect(footer).toContainElement(spoken);
    // `sr-only` is absolutely positioned; a positioned footer is its containing block, so the
    // span cannot stretch a scroller above it (`src/CLAUDE.md`'s scroll-container rule).
    expect(footer?.classList.contains("relative")).toBe(true);
  });

  /** Drawn under the app's `TooltipProvider`: without one `useTooltip` is a no-op, and a hover test
   *  would pass by never being asked. */
  it("hints the whole sentence under the pointer", async () => {
    render(
      <TooltipProvider>
        <WidgetFooterLine line={LINE} said={SAID} />
      </TooltipProvider>,
    );

    fireEvent.pointerEnter(screen.getByText(LINE).closest("p") as HTMLElement);

    await waitFor(
      () => expect(document.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent(SAID),
      { timeout: 2000 },
    );
  });

  /** A line with no shorter spelling is its own sentence: drawn once, and hinted when cut. */
  it("draws a line that is its own sentence once, as plain text", () => {
    render(<WidgetFooterLine line="4 more save $11.45" />);

    const footer = screen.getByText("4 more save $11.45");
    expect(footer.tagName).toBe("P");
    expect(footer).not.toHaveAttribute("aria-hidden");
    expect(footer.classList.contains("truncate")).toBe(true);
  });
});
