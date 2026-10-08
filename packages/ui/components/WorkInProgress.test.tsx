import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkInProgress } from "@/components/WorkInProgress";
import { PlaytestingPage } from "@/features/playtesting/PlaytestingPage";
import { TradePage } from "@/features/trade/TradePage";

describe("the work-in-progress placeholder", () => {
  /**
   * The sentence and the heading are two different things and only one of them is drawn.
   *
   * The ribbon already renders the view's name as the window's `<h1>`, so a visible copy here
   * would be the same word twice on one screen — and a region with no heading at all is one a
   * reader navigating by landmark cannot name. `sr-only` is what every real page in this app does
   * about that, and this asserts it as a class rather than as a query, because `getByRole`
   * answers for a visually hidden heading exactly as it does for a painted one: the assertion
   * that it is *found* cannot tell the two apart, which is the whole thing being pinned.
   */
  it("names itself for a screen reader and paints only the sentence", () => {
    render(<WorkInProgress view="Trade" />);

    expect(screen.getByRole("heading", { level: 2, name: "Trade" })).toHaveClass("sr-only");
    expect(screen.getByText("Work in progress")).toBeInTheDocument();
  });

  /**
   * Each page passes its own word, which is the one thing the shared component cannot supply.
   *
   * Written out as the words a reader would say rather than read off `NAV`, per the rule that an
   * assertion must not read its own constant — a test that looked the labels up would pass over
   * a page handed the wrong one.
   */
  it("takes each page's own name", () => {
    const { unmount } = render(<TradePage />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Trade");
    unmount();

    render(<PlaytestingPage />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Playtesting");
  });
});
