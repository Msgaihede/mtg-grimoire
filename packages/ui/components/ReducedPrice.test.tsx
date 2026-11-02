import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { reducedValue } from "@/lib/collectionValue";
import { ReducedBreakdown, ReducedPrice } from "./ReducedPrice";

const VALUE = reducedValue(
  6247.11,
  { cards: 466, value: 58.84 },
  { sellPercent: 70, minimumValue: 0.5 },
)!;

describe("ReducedPrice", () => {
  it("draws the price in brackets, as a control the keyboard can reach", () => {
    render(<ReducedPrice value={VALUE} currency="usd" />);
    const button = screen.getByRole("button", { name: "Reduced price $4,331.79" });
    expect(button).toHaveTextContent("$4,331.79");
    expect(button.parentElement).toHaveTextContent("($4,331.79)");
  });

  /** Inside a press a second button would be invalid HTML, so `plain` draws none. */
  it("draws no control of its own when it is plain", () => {
    render(<ReducedPrice value={VALUE} currency="usd" plain />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("$4,331.79")).toBeInTheDocument();
  });
});

describe("ReducedBreakdown", () => {
  it("states each line in the order the sum runs", () => {
    render(<ReducedBreakdown value={VALUE} currency="usd" />);
    expect(screen.getByText("Full value")).toBeInTheDocument();
    expect(screen.getByText("$6,247.11")).toBeInTheDocument();
    expect(screen.getByText("Under $0.50 · 466 cards")).toBeInTheDocument();
    expect(screen.getByText("−$58.84")).toBeInTheDocument();
    expect(screen.getByText("Sell at 70%")).toBeInTheDocument();
    expect(screen.getByText("−$1,856.48")).toBeInTheDocument();
    expect(screen.getByText("$4,331.79")).toBeInTheDocument();
  });

  /** Issue #1477: Open Packs' bulk price, after the percentage it is not reduced by. */
  it("states the bulk price as a line of its own, added after the percentage", () => {
    const bulk = reducedValue(
      6247.11,
      { cards: 466, value: 58.84 },
      { sellPercent: 70, minimumValue: 0.5, bulkPrice: 0.01 },
    )!;
    render(<ReducedBreakdown value={bulk} currency="usd" />);
    expect(screen.getByText("Bulk at $0.01 · 466 cards")).toBeInTheDocument();
    expect(screen.getByText("+$4.66")).toBeInTheDocument();
    expect(screen.getByText("$4,336.45")).toBeInTheDocument();
  });

  it("leaves out a line whose setting is not set, and says one card alone", () => {
    const one = reducedValue(10, { cards: 1, value: 0.25 }, { sellPercent: 100, minimumValue: 0.5 })!;
    render(<ReducedBreakdown value={one} currency="eur" />);
    expect(screen.getByText(/· 1 card$/)).toBeInTheDocument();
    expect(screen.queryByText(/^Sell at/)).toBeNull();
    expect(screen.queryByText(/^Bulk at/)).toBeNull();
  });
});
