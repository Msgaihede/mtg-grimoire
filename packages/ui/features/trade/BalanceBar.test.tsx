import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BalanceBar } from "./BalanceBar";

/** The three stretches' grow factors, in the order they are drawn. */
function shares(container: HTMLElement): Record<string, number> {
  const out: Record<string, number> = {};
  for (const el of container.querySelectorAll<HTMLElement>("[data-share]")) {
    out[el.dataset.share as string] = Number(el.style.flexGrow);
  }
  return out;
}

describe("BalanceBar", () => {
  it("draws no gap for an even trade: two halves meeting at the tick", () => {
    const { container } = render(<BalanceBar mineTotal={5000} theirsTotal={5000} />);

    expect(shares(container)).toEqual({ mine: 50, gap: 0, theirs: 50 });
  });

  it("stops the reader's share short of the middle when they owe, by exactly the gap", () => {
    // 25 against 75: the reader's quarter, a quarter of gold, and their half.
    const { container } = render(<BalanceBar mineTotal={2500} theirsTotal={7500} />);

    expect(shares(container)).toEqual({ mine: 25, gap: 25, theirs: 50 });
    const gap = container.querySelector("[data-share=gap]") as HTMLElement;
    expect(gap.classList.contains("bg-accent")).toBe(true);
    // Gold only: `tailwind-merge` has dropped the dim the other two stretches wear.
    expect(gap.classList.contains("bg-dim")).toBe(false);
  });

  it("puts the gap on their half when they owe", () => {
    const { container } = render(<BalanceBar mineTotal={9000} theirsTotal={1000} />);

    expect(shares(container)).toEqual({ mine: 50, gap: 40, theirs: 10 });
  });

  it("draws an empty trade as an even one rather than dividing by nothing", () => {
    const { container } = render(<BalanceBar mineTotal={0} theirsTotal={0} />);

    expect(shares(container)).toEqual({ mine: 50, gap: 0, theirs: 50 });
  });

  it("is a picture of a sentence drawn elsewhere, and takes a caller's width", () => {
    const { container } = render(<BalanceBar mineTotal={1} theirsTotal={2} className="w-full" />);
    const bar = container.firstElementChild as HTMLElement;

    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar.classList.contains("w-full")).toBe(true);
    // The default width is replaced, not joined: two widths on one box is whichever the
    // stylesheet happens to write last.
    expect(bar.classList.contains("w-80")).toBe(false);
  });
});
