import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TOOLTIP_PANEL_ID } from "@/components/tooltip/TooltipPanel";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";

import { makeFit } from "./fit";
import { figureGrid, WidgetFigures, WidgetFooterLine, WidgetRowList } from "./WidgetParts";

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
  const SAID = "1 more has no Cardmarket price";

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
    // span cannot stretch a scroller above it (`packages/ui/CLAUDE.md`'s scroll-container rule).
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

/**
 * Summary's figures are the whole body (issue #1379): every arrangement in rows is tried and the
 * one drawing the numbers largest is kept, so a bigger card draws bigger figures rather than the
 * same small line over an empty card. Never an arrangement wider or taller than the box.
 */
describe("figureGrid", () => {
  it("draws the numbers larger in a larger box", () => {
    const small = figureGrid(4, 6, { widthPx: 430, heightPx: 62 });
    const large = figureGrid(4, 6, { widthPx: 900, heightPx: 400 });
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(large!.sizePx).toBeGreaterThan(small!.sizePx);
  });

  it("puts four figures on one line in a wide, short box, and in a column in a tall, narrow one", () => {
    expect(figureGrid(4, 5, { widthPx: 900, heightPx: 62 })).toMatchObject({ rows: 1, columns: 4 });
    expect(figureGrid(4, 5, { widthPx: 120, heightPx: 400 })).toMatchObject({
      rows: 4,
      columns: 1,
    });
  });

  it("answers null when no arrangement holds the figures, or their labels", () => {
    expect(figureGrid(4, 9, { widthPx: 120, heightPx: 62 })).toBeNull();
    expect(figureGrid(1, 2, { widthPx: 40, heightPx: 62 }, 10)).toBeNull();
  });
});

describe("WidgetFigures", () => {
  const fit = makeFit({ w: 3, h: 2, widthPx: 336, heightPx: 220, density: "comfortable" });

  /** `$1,101.28 2 unpriced` ran under the next figure at three cells wide (issue #1379): the note
   *  is cut with an ellipsis now, and the number never gives way to it. */
  it("cuts a note that does not fit rather than letting it run into the next figure", () => {
    render(
      <TooltipProvider>
        <WidgetFigures
          fit={fit}
          figures={[
            { key: "v", label: "Value", value: "$1,101.28", note: "2 unpriced", tone: "accent" },
            { key: "c", label: "Cards", value: "21", tone: "text" },
          ]}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText("2 unpriced").classList.contains("truncate")).toBe(true);
    expect(screen.getByText("$1,101.28").classList.contains("shrink-0")).toBe(true);
  });
});

describe("WidgetRowList", () => {
  const fit = makeFit({ w: 4, h: 2, widthPx: 452, heightPx: 220, density: "comfortable" });

  it("draws the layout's columns, and stretches its rows only when it is full", () => {
    const { rerender } = render(
      <WidgetRowList fit={fit} label="Rows" layout={{ columns: 1, full: true }}>
        <li>One</li>
      </WidgetRowList>,
    );
    const list = screen.getByRole("list", { name: "Rows" });
    expect(list.style.gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))");
    expect(list.style.gridAutoRows).toBe("1fr");
    expect(list.classList.contains("flex-1")).toBe(true);

    rerender(
      <WidgetRowList fit={fit} label="Rows" layout={{ columns: 2, full: false }}>
        <li>One</li>
      </WidgetRowList>,
    );
    expect(list.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    expect(list.style.gridAutoRows).toBe("");
    expect(list.classList.contains("flex-1")).toBe(false);
  });

  it("falls back to the width's columns without a layout", () => {
    render(
      <WidgetRowList fit={fit} label="Rows">
        <li>One</li>
      </WidgetRowList>,
    );
    expect(screen.getByRole("list", { name: "Rows" }).style.gridTemplateColumns).toBe(
      `repeat(${fit.listColumns}, minmax(0, 1fr))`,
    );
  });
});
