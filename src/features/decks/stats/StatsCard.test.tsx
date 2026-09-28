import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BarChart, PART_COUNT_MIN_PX, spokenBar, type ChartBar, type ChartPart } from "./StatsCard";

/**
 * A bar — `key` doubles as the spoken tail so each sentence is unique. The label is a letter so
 * that no axis glyph can be mistaken for a count by an exact `getByText`.
 */
function bar(key: string, count: number, parts?: ChartPart[]): ChartBar {
  return { key, label: `L${key}`, count, said: `at mana value ${key}`, parts };
}

/** The creature/noncreature pair `ManaCurveChart` builds, foot first. */
function split(creatures: number, noncreatures: number): ChartPart[] {
  return [
    { key: "c", count: creatures, noun: "creature", fill: "var(--c)", fg: "var(--c-fg)" },
    { key: "n", count: noncreatures, noun: "noncreature", fill: "var(--n)", fg: "var(--n-fg)" },
  ];
}

/**
 * The fill a printed count sits on, if any — the nearest ancestor carrying an inline
 * `background`, which is how every fill and part in `BarChart` is painted.
 */
function fillUnder(count: HTMLElement): HTMLElement | null {
  return count.closest<HTMLElement>('[style*="background"]');
}

describe("BarChart variant=mana", () => {
  /**
   * The rule the mode exists for: the default variant prints the tallest bar's count **inside**
   * its fill (there is no track left above it), and the mana variant must not — every count rides
   * on top of its own fill, the tallest one's landing in the strip above the track.
   */
  it("prints every nonzero count above its own fill, the tallest included, and never inside", () => {
    const bars = [bar("1", 0), bar("2", 3), bar("3", 10)];
    const { unmount } = render(<BarChart bars={bars} max={10} height={152} fill="gold" />);
    // The control: the default variant does put the tallest count inside its fill.
    expect(fillUnder(screen.getByText("10"))).not.toBeNull();
    unmount();

    render(<BarChart bars={bars} max={10} height={152} fill="gold" variant="mana" />);
    const tallest = screen.getByText("10");
    const short = screen.getByText("3");
    expect(fillUnder(tallest)).toBeNull();
    expect(fillUnder(short)).toBeNull();
    // Each count's foot is its own fill's top: the tallest at the full track height, which is
    // the strip above the track, and the short one at 3/10 of it.
    expect(tallest).toHaveStyle({ bottom: "152px", height: "24px" });
    expect(short).toHaveStyle({ bottom: `${0.3 * 152}px` });
    // The strip is added above the track rather than taken out of it.
    expect(tallest.parentElement).toHaveStyle({ height: `${152 + 24}px` });
    // Zero draws no count at all.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("keeps the drawing hidden and the numbers in one sentence per bar", () => {
    render(
      <BarChart
        bars={[bar("2", 1), bar("3", 4)]}
        max={4}
        height={88}
        fill="gold"
        size="sm"
        variant="mana"
      />,
    );
    for (const item of screen.getAllByRole("listitem")) {
      expect(item.querySelector(".sr-only")?.textContent).toMatch(/^\d+ cards? at mana value/);
      for (const drawn of item.querySelectorAll(":scope > span:not(.sr-only)")) {
        expect(drawn).toHaveAttribute("aria-hidden", "true");
      }
    }
    expect(screen.getByText("1 card at mana value 2")).toBeInTheDocument();
  });

  /**
   * Heights at max 12 over a 152px track: 1 copy is 12.7px (under the threshold, silent), 2 is
   * 25.3px, 3 is 38px, 11 is 139.3px — so the one silent part is exactly the one below
   * {@link PART_COUNT_MIN_PX}, and the totals ride above each stack as in the unsplit chart.
   */
  it("prints a part's own count inside it only when the part is tall enough", () => {
    expect((1 / 12) * 152).toBeLessThan(PART_COUNT_MIN_PX);
    expect((2 / 12) * 152).toBeGreaterThanOrEqual(PART_COUNT_MIN_PX);
    render(
      <BarChart
        bars={[bar("2", 12, split(1, 11)), bar("3", 5, split(2, 3))]}
        max={12}
        height={152}
        fill="gold"
        variant="mana"
      />,
    );

    // The totals: above, on no fill.
    expect(fillUnder(screen.getByText("12"))).toBeNull();
    expect(fillUnder(screen.getByText("5"))).toBeNull();
    // The parts tall enough carry their own count, on their own fill, in their own foreground.
    expect(fillUnder(screen.getByText("11"))).toHaveStyle({
      background: "var(--n)",
      color: "var(--n-fg)",
    });
    expect(fillUnder(screen.getByText("2"))).toHaveStyle({
      background: "var(--c)",
      color: "var(--c-fg)",
    });
    expect(fillUnder(screen.getByText("3"))).toHaveStyle({ background: "var(--n)" });
    // The one sliver under the threshold is drawn silent.
    expect(screen.queryByText("1")).not.toBeInTheDocument();
    // And the split is spoken, not only drawn.
    expect(screen.getByText("1 creature and 11 noncreatures at mana value 2")).toBeInTheDocument();
  });

  it("stacks the total's foot on the whole stack, not on one part", () => {
    render(
      <BarChart
        bars={[bar("2", 4, split(2, 2)), bar("3", 8, split(3, 5))]}
        max={8}
        height={152}
        fill="gold"
        variant="mana"
      />,
    );
    expect(screen.getByText("4")).toHaveStyle({ bottom: `${0.5 * 152}px` });
    expect(screen.getByText("8")).toHaveStyle({ bottom: "152px" });
  });
});

describe("spokenBar", () => {
  it("names every part, a zero and a singular included", () => {
    expect(spokenBar(bar("2", 5, split(0, 5)))).toBe(
      "0 creatures and 5 noncreatures at mana value 2",
    );
    expect(spokenBar(bar("2", 2, split(1, 1)))).toBe(
      "1 creature and 1 noncreature at mana value 2",
    );
    expect(spokenBar(bar("2", 1))).toBe("1 card at mana value 2");
  });
});
