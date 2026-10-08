import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DAY_SECONDS, formatDay, type ChartPoint } from "./priceAnalytics";
import { PriceChart } from "./PriceChart";

/** 1 September 2026, a UTC midnight like every day the chart is handed. */
const T0 = Date.UTC(2026, 8, 1) / 1000;

/** One point a day from `T0`, the last one live. */
function series(prices: number[]): ChartPoint[] {
  return prices.map((price, i) => ({
    day: T0 + i * DAY_SECONDS,
    price,
    live: i === prices.length - 1,
  }));
}

function draw(points: ChartPoint[], currency: "usd" | "eur" = "usd") {
  return render(<PriceChart points={points} currency={currency} summary="The price, drawn." />);
}

/** The drawing — `aria-hidden`, so no role query reaches it. */
function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error("no drawing");
  return svg;
}

/** Every `x y` pair a path's `d` visits, in order. */
function vertices(d: string): { x: number; y: number }[] {
  return [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: +m[1], y: +m[2] }));
}

/** The price scale's labels, top to bottom as written in the document. */
function priceLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-axis="price"] text')].map((t) => t.textContent ?? "");
}

/**
 * One pointer event with a real `clientX` on it — jsdom ships no `PointerEvent`, so Testing
 * Library's pointer helpers fall back to a plain `Event` and the coordinate never arrives. React
 * dispatches on the event's type, not on its class (`ResizeHandle.test.tsx`'s note).
 */
function pointer(target: Element, type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}

describe("PriceChart", () => {
  it("draws one line through every point, with the wash under it", () => {
    const { container } = draw(series([10, 12, 11, 14, 13]));
    const line = container.querySelector('[data-mark="line"]');
    expect(vertices(line?.getAttribute("d") ?? "")).toHaveLength(5);
    // Oldest on the left, time running right.
    const xs = vertices(line?.getAttribute("d") ?? "").map((v) => v.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(container.querySelector('[data-mark="area"]')).not.toBeNull();
  });

  it("draws a lone price as a dot, with no line and no wash", () => {
    const { container } = draw(series([4.2]));
    expect(container.querySelectorAll("circle").length).toBeGreaterThan(0);
    expect(container.querySelector('[data-mark="line"]')).toBeNull();
    expect(container.querySelector('[data-mark="area"]')).toBeNull();
  });

  it("draws nothing at all for no points — the dialog says why", () => {
    const { container } = draw([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels the price scale in money, at clean figures", () => {
    const { container, unmount } = draw(series([10, 12, 11, 14]));
    expect(priceLabels(container)).toEqual(["$10.00", "$12.00", "$14.00"]);
    unmount();

    const eur = draw(series([10, 12, 11, 14]), "eur");
    expect(priceLabels(eur.container)).toEqual(["€10.00", "€12.00", "€14.00"]);
  });

  // A flat price is a line across the middle, not one hugging the floor or the ceiling.
  it("centres a flat price on the middle of the scale", () => {
    const { container } = draw(series([5, 5, 5]));
    expect(priceLabels(container)).toEqual(["$4.80", "$5.00", "$5.20"]);
    const middle = screen.getByText("$5.00").getAttribute("y");
    const ys = vertices(container.querySelector('[data-mark="line"]')?.getAttribute("d") ?? "");
    for (const v of ys) expect(v.y).toBeCloseTo(Number(middle), 0);
  });

  // A year of history otherwise reads "25 Sept" to "24 Sept" — a range of no length at all.
  it("writes the year on the dates when the range crosses one", () => {
    const start = Date.UTC(2025, 8, 25) / 1000;
    const end = Date.UTC(2026, 8, 24) / 1000;
    const { container } = draw([
      { day: start, price: 10, live: false },
      { day: end, price: 18, live: true },
    ]);
    const dates = [...container.querySelectorAll('[data-axis="date"] text')].map(
      (t) => t.textContent,
    );
    expect(dates).toEqual([formatDay(start, "long"), formatDay(end, "long")]);
  });

  it("gives a screen reader the summary and hides the drawing", () => {
    const { container } = draw(series([10, 12]));
    expect(screen.getByText("The price, drawn.")).toHaveClass("sr-only");
    expect(svgOf(container)).toHaveAttribute("aria-hidden", "true");
  });

  it("reads the nearest point under the pointer, and lets go when it leaves", () => {
    const { container } = draw(series([10.4, 25.3, 12.15]));
    const svg = svgOf(container);
    // jsdom lays nothing out; the chart is drawn at its 480px fallback, so the box says the same.
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, x: 0, y: 0, width: 480, height: 220, right: 480, bottom: 220 }) as DOMRect;
    const tip = () => container.querySelector<HTMLElement>("[data-chart-tip]");

    expect(tip()).toBeNull();

    // Left of the first point: the first point, its date written out, and the tip to its right.
    pointer(svg, "pointermove", 0);
    expect(tip()).toHaveTextContent("$10.40");
    expect(tip()).toHaveTextContent(formatDay(T0, "long"));
    expect(tip()?.style.left).not.toBe("");
    expect(container.querySelector('[data-mark="crosshair"]')).not.toBeNull();

    // Nearer the middle point than either end.
    pointer(svg, "pointermove", 240);
    expect(tip()).toHaveTextContent("$25.30");

    // Past the last: the live price is today's, and the tip flips to stay inside the chart.
    pointer(svg, "pointermove", 480);
    expect(tip()).toHaveTextContent("$12.15");
    expect(tip()).toHaveTextContent("Today");
    expect(tip()?.style.right).not.toBe("");
    expect(tip()?.style.left).toBe("");

    fireEvent.pointerLeave(svg);
    expect(tip()).toBeNull();
    expect(container.querySelector('[data-mark="crosshair"]')).toBeNull();
  });
});
