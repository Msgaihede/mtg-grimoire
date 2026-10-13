import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkInProgress } from "@/components/WorkInProgress";

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
    render(<WorkInProgress view="Playtesting" />);

    expect(screen.getByRole("heading", { level: 2, name: "Playtesting" })).toHaveClass("sr-only");
    expect(screen.getByText("Work in progress")).toBeInTheDocument();
  });
});
