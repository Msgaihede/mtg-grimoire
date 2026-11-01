import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HistogramBin } from "../booster/value";
import { shareText, ValueHistogram } from "./ValueHistogram";

const BINS: HistogramBin[] = [
  { from: 4, to: 6, count: 9_000 },
  { from: 6, to: 8, count: 539 },
  { from: 8, to: 10, count: 460 },
  { from: 10, to: 30, count: 1 },
];

function draw() {
  return render(
    <ValueHistogram
      bins={BINS}
      marked={5}
      markedLabel="Yours $5.00"
      paid={null}
      currency="usd"
      unit="packs"
      summary="10,000 simulated packs."
    />,
  );
}

describe("shareText", () => {
  it("is a percent with one decimal", () => {
    expect(shareText(539, 10_000)).toBe("5.4%");
    expect(shareText(9_000, 10_000)).toBe("90%");
    expect(shareText(0, 10_000)).toBe("0%");
    expect(shareText(10_000, 10_000)).toBe("100%");
  });

  it("never rounds a held value to nothing, or a missed one to everything", () => {
    expect(shareText(1, 10_000)).toBe("<0.1%");
    expect(shareText(9_999, 10_000)).toBe(">99.9%");
  });

  it("is 0% of nothing", () => {
    expect(shareText(0, 0)).toBe("0%");
  });
});

describe("ValueHistogram", () => {
  it("tabulates each band as its share of the simulation, not a count", () => {
    draw();
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "% of packs" })).toBeTruthy();
    const cells = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[1].textContent);
    expect(cells).toEqual(["90%", "5.4%", "4.6%", "<0.1%"]);
    expect(within(table).queryByText("539")).toBeNull();
  });

  it("says a hovered bar's chance in its tooltip", () => {
    const { container } = draw();
    const svg = container.querySelector("svg");
    if (svg === null) throw new Error("no drawing");
    svg.getBoundingClientRect = () => ({ left: 0, width: 400 }) as DOMRect;
    // The second of four slots.
    fireEvent.pointerMove(svg, { clientX: 150 });
    expect(screen.getByText("5.4% of packs")).toBeTruthy();
  });
});
