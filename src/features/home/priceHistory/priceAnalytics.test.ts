import { describe, expect, it } from "vitest";

import type { PriceHistory } from "@/lib/ipc";

import { DAY_SECONDS, formatDay, rangeSeries, rangeStats, signedPercent } from "./priceAnalytics";

/** Thursday 24 September 2026, 00:00 UTC — every fixture's today. */
const TODAY = Date.UTC(2026, 8, 24) / 1000;

/** The UTC midnight `n` days before {@link TODAY}. */
function ago(n: number): number {
  return TODAY - n * DAY_SECONDS;
}

/** A history from `[days ago, price]` pairs, oldest first, which is how Rust answers them. */
function history(points: [number, number][], now: number | null): PriceHistory {
  return {
    points: points.map(([days, price]) => ({ day: ago(days), price })),
    now,
    today: TODAY,
  };
}

/**
 * `price_history.rs`' `each_window_measures_against_its_own_baseline`, snapshot for snapshot: live
 * 10, and a week's baseline, a month's and the oldest each a different price, with a row too young
 * for the week in front of all three.
 */
const WIDGET = history(
  [
    [60, 2],
    [31, 4],
    [20, 6],
    [8, 7],
    [3, 9],
  ],
  10,
);

describe("the baseline agrees with the widget", () => {
  // The number on the widget's row and the number in its dialog are one fact. These are the Rust
  // test's own expectations, so a rule that drifted on either side goes red on this one.
  it("measures each range against the same snapshot price_history::movers does", () => {
    const pick = (range: "7d" | "30d" | "all") => {
      const s = rangeStats(WIDGET, range);
      return [s.then, s.thenDay, s.change];
    };
    expect(pick("7d")).toEqual([7, ago(8), 3]);
    expect(pick("30d")).toEqual([4, ago(31), 6]);
    expect(pick("all")).toEqual([2, ago(60), 8]);
  });

  it("takes a snapshot exactly a week or a month old as that range's baseline", () => {
    const h = history(
      [
        [30, 3],
        [29, 4],
        [7, 5],
        [6, 6],
      ],
      10,
    );
    expect(rangeStats(h, "7d").thenDay).toBe(ago(7));
    expect(rangeStats(h, "30d").thenDay).toBe(ago(30));
  });

  // `no_baseline_is_null_since_and_nothing_moving_is_not`: a two-day-old row is no baseline for a
  // week. Falling back to it would put a number in the dialog the widget refuses to show.
  it("never falls back to a younger baseline", () => {
    const young = history([[2, 9]], 10);
    for (const range of ["7d", "30d"] as const) {
      const s = rangeStats(young, range);
      expect(s.then, range).toBeNull();
      expect(s.thenDay, range).toBeNull();
      expect(s.change, range).toBeNull();
      expect(s.changePct, range).toBeNull();
      expect(rangeSeries(young, range).baseline, range).toBeNull();
    }
    expect(rangeStats(young, "all").change).toBe(1);
  });

  it("leaves a month with no baseline even where the week has one", () => {
    const h = history(
      [
        [20, 6],
        [8, 7],
        [3, 9],
      ],
      10,
    );
    expect(rangeStats(h, "7d").change).toBe(3);
    expect(rangeStats(h, "30d").change).toBeNull();
  });

  // Rust's `all` is `p.day < date('now')`: a printing snapshotted this morning is not its own
  // baseline, or every one of them would be a zero move.
  it("never makes a snapshot dated today the all-history baseline", () => {
    const h: PriceHistory = {
      points: [{ day: TODAY, price: 10 }],
      now: 10,
      today: TODAY,
    };
    expect(rangeSeries(h, "all").baseline).toBeNull();
    expect(rangeStats(h, "all").change).toBeNull();
  });
});

describe("rangeSeries", () => {
  it("draws the baseline, every snapshot after it and then today's live price", () => {
    const series = rangeSeries(WIDGET, "7d");
    expect(series.baseline).toEqual({ day: ago(8), price: 7, live: false });
    expect(series.points).toEqual([
      { day: ago(8), price: 7, live: false },
      { day: ago(3), price: 9, live: false },
      { day: TODAY, price: 10, live: true },
    ]);
  });

  it("draws the whole kept history for all", () => {
    expect(rangeSeries(WIDGET, "all").points.map((p) => [p.day, p.price])).toEqual([
      [ago(60), 2],
      [ago(31), 4],
      [ago(20), 6],
      [ago(8), 7],
      [ago(3), 9],
      [TODAY, 10],
    ]);
  });

  // No baseline is no *change*, not no chart: what little history there is still draws.
  it("still draws what the range holds when the history is too young for a baseline", () => {
    const month = rangeSeries(
      history(
        [
          [20, 6],
          [8, 7],
          [3, 9],
        ],
        10,
      ),
      "30d",
    );
    expect(month.baseline).toBeNull();
    expect(month.points.map((p) => p.day)).toEqual([ago(20), ago(8), ago(3), TODAY]);

    const week = rangeSeries(history([[2, 9]], 10), "7d");
    expect(week.points.map((p) => [p.day, p.live])).toEqual([
      [ago(2), false],
      [TODAY, true],
    ]);
  });

  it("appends no live point when today is unpriced", () => {
    const series = rangeSeries(history([[8, 7]], null), "7d");
    expect(series.points).toEqual([{ day: ago(8), price: 7, live: false }]);
  });

  it("is empty when there is nothing at all", () => {
    expect(rangeSeries(history([], null), "all")).toEqual({ points: [], baseline: null });
  });
});

describe("rangeStats", () => {
  it("reads the change as a fraction of the baseline", () => {
    expect(rangeStats(WIDGET, "7d").changePct).toBeCloseTo(3 / 7, 12);
    expect(rangeStats(WIDGET, "all").changePct).toBe(4);
  });

  it("has a change but no percentage against a baseline of zero", () => {
    const s = rangeStats(history([[8, 0]], 5), "7d");
    expect(s.change).toBe(5);
    expect(s.changePct).toBeNull();
  });

  it("counts the live price in the range's high and low", () => {
    const s = rangeStats(WIDGET, "7d");
    expect(s.high).toEqual({ price: 10, day: TODAY });
    expect(s.low).toEqual({ price: 7, day: ago(8) });
    expect(s.position).toBe(1);
  });

  it("places today's price between the range's low and high", () => {
    const s = rangeStats(
      history(
        [
          [10, 8],
          [5, 2],
        ],
        5,
      ),
      "7d",
    );
    expect(s.high).toEqual({ price: 8, day: ago(10) });
    expect(s.low).toEqual({ price: 2, day: ago(5) });
    expect(s.position).toBe(0.5);
  });

  it("gives a tied high or low to its earliest day", () => {
    const s = rangeStats(
      history(
        [
          [20, 5],
          [10, 9],
          [5, 5],
        ],
        9,
      ),
      "all",
    );
    expect(s.high).toEqual({ price: 9, day: ago(10) });
    expect(s.low).toEqual({ price: 5, day: ago(20) });
  });

  // A flat line has no range for today to sit in; `0 / 0` must not reach the page as NaN.
  it("has no position on a flat price", () => {
    const s = rangeStats(
      history(
        [
          [9, 4],
          [3, 4],
        ],
        4,
      ),
      "7d",
    );
    expect(s.change).toBe(0);
    expect(s.changePct).toBe(0);
    expect(s.high).toEqual(s.low);
    expect(s.position).toBeNull();
  });

  it("has no change and no position when today is unpriced", () => {
    const s = rangeStats({ ...WIDGET, now: null }, "7d");
    expect(s.now).toBeNull();
    expect(s.then).toBe(7);
    expect(s.change).toBeNull();
    expect(s.changePct).toBeNull();
    expect(s.position).toBeNull();
    expect(s.high).toEqual({ price: 9, day: ago(3) });
  });

  it("measures tracking over the whole history, whatever the range", () => {
    const week = rangeStats(WIDGET, "7d");
    expect(week.trackedSince).toBe(ago(60));
    expect(week.trackedDays).toBe(6);
    expect(rangeStats({ ...WIDGET, now: null }, "7d").trackedDays).toBe(5);
  });

  it("tracks from today when today's price is all there is", () => {
    const s = rangeStats(history([], 10), "all");
    expect(s.trackedSince).toBe(TODAY);
    expect(s.trackedDays).toBe(1);
    expect(s.high).toEqual({ price: 10, day: TODAY });
    expect(s.low).toEqual({ price: 10, day: TODAY });
    expect(s.change).toBeNull();
    expect(s.position).toBeNull();
  });

  it("answers nothing at all for an empty history", () => {
    expect(rangeStats(history([], null), "30d")).toEqual({
      now: null,
      then: null,
      thenDay: null,
      change: null,
      changePct: null,
      high: null,
      low: null,
      position: null,
      trackedSince: null,
      trackedDays: 0,
    });
  });
});

describe("formatDay", () => {
  const NEW_YEAR = Date.UTC(2027, 0, 1) / 1000;

  it("writes a day short and long", () => {
    const june = Date.UTC(2026, 5, 12) / 1000;
    expect(formatDay(june, "short")).toBe("12 Jun");
    expect(formatDay(june, "long")).toBe("12 Jun 2026");
  });

  // Local time moves a UTC midnight a day west of Greenwich and a late-evening instant a day east,
  // so between them the two ends of one UTC day go wrong on every machine that is not on UTC.
  it("writes every instant of a UTC day as that day", () => {
    expect(formatDay(NEW_YEAR, "long")).toBe("1 Jan 2027");
    expect(formatDay(NEW_YEAR + DAY_SECONDS - 1, "long")).toBe("1 Jan 2027");
    expect(formatDay(NEW_YEAR - 1, "long")).toBe("31 Dec 2026");
  });
});

describe("signedPercent", () => {
  it("writes a gain with a plus and a loss with a real minus sign", () => {
    expect(signedPercent(0.124)).toBe("+12.4%");
    expect(signedPercent(-0.03)).toBe("−3.0%");
    expect(signedPercent(-0.03)).not.toContain("-");
  });

  it("rounds to one decimal, half away from zero in both directions", () => {
    expect(signedPercent(3 / 7)).toBe("+42.9%");
    expect(signedPercent(0.0005)).toBe("+0.1%");
    expect(signedPercent(-0.0005)).toBe("−0.1%");
  });

  // A sign in front of a figure that reads zero claims a direction the figure cannot show.
  it("writes zero, and anything that rounds to it, with no sign", () => {
    expect(signedPercent(0)).toBe("0.0%");
    expect(signedPercent(-0)).toBe("0.0%");
    expect(signedPercent(0.0004)).toBe("0.0%");
    expect(signedPercent(-0.0004)).toBe("0.0%");
  });

  it("groups the thousands of a card that went from pennies to dollars", () => {
    expect(signedPercent(149)).toBe("+14,900.0%");
  });
});
