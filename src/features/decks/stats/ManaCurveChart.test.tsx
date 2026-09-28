import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckStatsSummary } from "../DeckStats";
import { CREATURE_SPLIT_LABEL, ManaCurveChart } from "./ManaCurveChart";

/** The fields `ManaCurveChart` reads. A `Pick` so a renamed field fails `tsc` here. */
type CurveFields = Pick<
  DeckStatsSummary,
  | "curve"
  | "curveCreatures"
  | "variableCost"
  | "variableCostCreatures"
  | "averageManaValue"
  | "unknownManaValue"
>;

/**
 * A summary carrying only the curve's fields. The cast is the price of not building a whole deck
 * to test one card; the `Pick` above is what keeps it honest about which fields those are.
 */
function stats(over: Partial<CurveFields> = {}): DeckStatsSummary {
  const fields: CurveFields = {
    //      0  1  2  3  4  5  6  7  8+
    curve: [0, 4, 10, 6, 3, 0, 0, 0, 0],
    curveCreatures: [0, 2, 5, 1, 3, 0, 0, 0, 0],
    variableCost: null,
    variableCostCreatures: null,
    averageManaValue: 2.52,
    unknownManaValue: 0,
    ...over,
  };
  return fields as DeckStatsSummary;
}

function toggle(): HTMLElement {
  return screen.getByRole("button", { name: CREATURE_SPLIT_LABEL });
}

/** The legend — the element holding the `Noncreatures` caption's row. */
function legend(): HTMLElement {
  const row = screen.getByText("Noncreatures").closest("p");
  if (row?.parentElement == null) throw new Error("no legend drawn");
  return row.parentElement;
}

describe("ManaCurveChart", () => {
  it("flips the split through its caller and reflects it in aria-pressed", async () => {
    const user = userEvent.setup();
    const onSplitChange = vi.fn();
    const { rerender } = render(
      <ManaCurveChart stats={stats()} split={false} onSplitChange={onSplitChange} />,
    );
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle());
    expect(onSplitChange).toHaveBeenLastCalledWith(true);

    rerender(<ManaCurveChart stats={stats()} split onSplitChange={onSplitChange} />);
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle());
    expect(onSplitChange).toHaveBeenLastCalledWith(false);
  });

  it("speaks each bar as cards and draws no legend while the split is off", () => {
    render(<ManaCurveChart stats={stats()} split={false} onSplitChange={() => {}} />);
    expect(screen.getByText("10 cards at mana value 2")).toBeInTheDocument();
    expect(screen.queryByText(/noncreature/)).not.toBeInTheDocument();
  });

  it("speaks each bar's split, X included, and sums the legend over the bars drawn", () => {
    render(
      <ManaCurveChart
        stats={stats({ variableCost: 3, variableCostCreatures: 1 })}
        split
        onSplitChange={() => {}}
      />,
    );
    expect(screen.getByText("5 creatures and 5 noncreatures at mana value 2")).toBeInTheDocument();
    expect(screen.getByText("0 creatures and 0 noncreatures at mana value 0")).toBeInTheDocument();
    expect(
      screen.getByText("1 creature and 2 noncreatures with X in their cost"),
    ).toBeInTheDocument();

    // 11 creatures on the curve and 1 on the X bar; 12 noncreatures and 2.
    const drawn = legend();
    expect(within(drawn).getByText("Creatures").closest("p")).toHaveTextContent("Creatures 12");
    expect(within(drawn).getByText("Noncreatures").closest("p")).toHaveTextContent(
      "Noncreatures 14",
    );
  });

  it("leaves the X bar out of the legend when it is not drawn", () => {
    render(<ManaCurveChart stats={stats()} split onSplitChange={() => {}} />);
    expect(screen.queryByText(/with X in their cost/)).not.toBeInTheDocument();
    expect(within(legend()).getByText("Creatures").closest("p")).toHaveTextContent("Creatures 11");
  });
});
