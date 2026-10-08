import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";

import { DAY_SECONDS, type ChartPoint } from "./priceAnalytics";
import { PriceChart } from "./PriceChart";

/** The day every story ends on — a UTC midnight, like every day the chart is handed. */
const TODAY = Date.UTC(2026, 8, 24) / 1000;

/** Whole cents, as a price is stored. */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * One snapshot a day ending yesterday, then today's live price — `rangeSeries`' shape. `at(i, n)`
 * prices the `i`th of `n` points, oldest first.
 */
function daily(n: number, at: (i: number, n: number) => number): ChartPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    day: TODAY - (n - 1 - i) * DAY_SECONDS,
    price: cents(at(i, n)),
    live: i === n - 1,
  }));
}

/**
 * A year of history as the store keeps it: **weekly beyond 35 days, daily inside them**, then
 * today's live price — so the x axis has to be time rather than an index, or eleven months would
 * be drawn as if they were five weeks. A spike around seven months ago, settling higher than it
 * started.
 */
function yearThinned(): ChartPoint[] {
  const priceAt = (daysAgo: number) =>
    18 +
    11 * Math.exp(-(((daysAgo - 210) / 28) ** 2)) -
    7 * (daysAgo / 365) +
    0.6 * Math.sin(daysAgo * 0.7);
  const points: ChartPoint[] = [];
  for (let ago = 364; ago >= 1; ago--) {
    if (ago > 35 && ago % 7 !== 0) continue;
    points.push({ day: TODAY - ago * DAY_SECONDS, price: cents(priceAt(ago)), live: false });
  }
  points.push({ day: TODAY, price: cents(priceAt(0)), live: true });
  return points;
}

/** The dialog's panel, at a width it can plausibly give the chart. */
function Panel({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div className="bg-bg p-4" style={{ width, maxWidth: "100%" }}>
      {children}
    </div>
  );
}

const meta = {
  title: "Home/PriceChart",
  component: PriceChart,
  tags: ["autodocs"],
  // `panelWidth` is this file's own parameter: the column the dialog gives the chart, which is
  // what the chart measures.
  decorators: [
    (Story, { parameters }) => (
      <Panel width={typeof parameters.panelWidth === "number" ? parameters.panelWidth : 560}>
        <Story />
      </Panel>
    ),
  ],
  args: {
    currency: "usd",
    points: daily(30, (i, n) => 12.4 + (6.55 * i) / (n - 1) + 0.35 * Math.sin(i * 1.3)),
    summary: "Up from $12.40 to $18.95 over the last 30 days.",
  },
  parameters: {
    docs: {
      description: {
        component:
          "One printing's price over a range, in the price movers' dialog. **Hand-drawn SVG**, " +
          "like every picture on the home page: the drawing is `aria-hidden` and `summary` is " +
          "the one sentence a screen reader gets.\n\n" +
          "**Money is the accent, text is never the series colour**: the line and its 10% wash " +
          "are gold, the price scale and the dates are dim ink, and direction is not coloured at " +
          "all — the dialog's figures say which way it went.\n\n" +
          "**The price scale is on the right**, where a ticker keeps it, beside *now*. The width " +
          "follows the container; hover a point to read it, and the tooltip flips to stay inside " +
          "the chart near either edge.",
      },
    },
  },
} satisfies Meta<typeof PriceChart>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A month's climb, with the day-to-day wobble a real price has. */
export const Rising: Story = {};

/** The same shape the other way — still gold. A loss is a figure beside the chart, not a red line. */
export const Falling: Story = {
  args: {
    points: daily(30, (i, n) => 42.1 - (14.5 * i) / (n - 1) + 0.9 * Math.sin(i * 0.9)),
    summary: "Down from $42.10 to $28.34 over the last 30 days.",
  },
};

/**
 * A bulk common that has not moved in a fortnight: **a line across the middle**, on the middle of
 * three ticks, rather than one lying on the floor of the plot.
 */
export const Flat: Story = {
  args: {
    points: daily(14, () => 0.25),
    summary: "Unchanged at $0.25 over the last 14 days.",
  },
};

/** Only today's price is known yet: the dot alone, with no line to draw between one point. */
export const SinglePoint: Story = {
  args: {
    points: daily(1, () => 3.49),
    summary: "$3.49 today — no earlier price has been kept yet.",
  },
};

/**
 * All kept history — a year, weekly beyond 35 days and daily inside them. The spacing is by date,
 * so the thinned months are as wide as they were long.
 */
export const Long: Story = {
  args: {
    points: yearThinned(),
    summary: "Up from $10.82 to $18.00 across all kept history, with a high of $25.34 in February.",
  },
};

/** The same year in a narrow column: the width is measured rather than assumed, and the middle
 *  date is drawn only where it has room clear of both ends' — here it has none. */
export const Narrow: Story = {
  args: Long.args,
  parameters: { panelWidth: 220 },
};

/** Cardmarket quotes euros; the scale and the tooltip follow the currency they are handed. */
export const InEuros: Story = {
  args: {
    currency: "eur",
    points: daily(30, (i, n) => 9.8 + (2.4 * i) / (n - 1) + 0.25 * Math.sin(i * 1.7)),
    summary: "Up from €9.80 to €11.99 over the last 30 days.",
  },
};
