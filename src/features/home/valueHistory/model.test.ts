import { describe, expect, it } from "vitest";

import type { ValueHistory, ValueSplit } from "@/lib/ipc";
import { MANA_LABEL } from "@/lib/mana";

import { makeFit, spanPx, type WidgetFit } from "../fit";
import { DAY_SECONDS } from "../priceHistory/priceAnalytics";
import {
  CATEGORICAL,
  collectionChange,
  dateTicks,
  IDENTITY_FILL,
  layoutFor,
  markerDays,
  OTHER_FILL,
  readoutAt,
  scaleFor,
  shownValues,
  tickLabel,
  TOTAL_FILL,
  viewOf,
  WINDOW_DAYS,
  type HistoryView,
  type Layout,
  type Rect,
  type Series,
} from "./model";

/** Saturday 26 September 2026, 00:00 UTC — every fixture's today. */
const TODAY = Date.UTC(2026, 8, 26) / 1000;

/** The UTC midnight `n` days before {@link TODAY}. */
function ago(n: number): number {
  return TODAY - n * DAY_SECONDS;
}

type Bucket = ValueHistory["buckets"][number];

interface Row {
  ago: number;
  total: number;
  values?: number[];
  /** Defaults to Rust's shape: null on the history's first point, 0 after it. */
  moved?: number | null;
}

/** A history the way Rust answers one: oldest first, the `ago: 0` row as today's live point. */
function history(buckets: (Bucket | string)[], rows: Row[]): ValueHistory {
  return {
    buckets: buckets.map((b) => (typeof b === "string" ? { key: b, name: null } : b)),
    points: rows.map((r, i) => ({
      day: ago(r.ago),
      total: r.total,
      values: r.values ?? [],
      moved: r.moved !== undefined ? r.moved : i === 0 ? null : 0,
      live: r.ago === 0,
    })),
    today: TODAY,
  };
}

function keys(series: readonly Series[]): string[] {
  return series.map((s) => s.key);
}

/* ------------------------------------------------------------------------------ viewOf --- */

describe("viewOf — the window", () => {
  const long = history(
    [],
    [
      { ago: 120, total: 10 },
      { ago: 95, total: 20 },
      { ago: 90, total: 30 },
      { ago: 60, total: 40, moved: 2 },
      { ago: 1, total: 50, moved: 3 },
      { ago: 0, total: 60, moved: 4 },
    ],
  );

  it("keeps the points on or after the cutoff, oldest first", () => {
    const v = viewOf(long, "total", "90d");
    expect(v.days).toEqual([ago(90), ago(60), ago(1), ago(0)]);
    expect(v.totals).toEqual([30, 40, 50, 60]);
    expect(v.today).toBe(TODAY);
  });

  it("drops the first point's move, because its previous point is outside the window", () => {
    const v = viewOf(long, "total", "90d");
    // Rust's ago-90 point measured a move against ago 95, which the range does not draw.
    expect(v.moved).toEqual([null, 2, 3, 4]);
  });

  it("keeps everything for all, and only a month for 30d", () => {
    expect(viewOf(long, "total", "all").days).toHaveLength(6);
    expect(viewOf(long, "total", "30d").days).toEqual([ago(1), ago(0)]);
    expect(WINDOW_DAYS).toEqual({ "30d": 30, "90d": 90, "1y": 365, all: null });
  });

  it("is not short when the history reaches past the cutoff", () => {
    expect(viewOf(long, "total", "90d").historyShort).toBe(false);
    expect(viewOf(long, "total", "30d").historyShort).toBe(false);
  });

  it("is short when the whole history starts after the cutoff", () => {
    const young = history(
      [],
      [
        { ago: 20, total: 5 },
        { ago: 0, total: 6 },
      ],
    );
    expect(viewOf(young, "total", "90d").historyShort).toBe(true);
    expect(viewOf(young, "total", "30d").historyShort).toBe(true);
    // All asks for everything kept, which is never shorter than itself.
    expect(viewOf(young, "total", "all").historyShort).toBe(false);
  });

  it("is not short when weekly thinning left no point exactly on the cutoff", () => {
    // Weekly buckets beyond 35 days: nothing at ago 90, one at 93 and one at 86.
    const thinned = history(
      [],
      [
        { ago: 93, total: 1 },
        { ago: 86, total: 2 },
        { ago: 0, total: 3 },
      ],
    );
    const v = viewOf(thinned, "total", "90d");
    expect(v.days[0]).toBe(ago(86));
    expect(v.historyShort).toBe(false);
  });

  it("answers an empty view for an empty collection", () => {
    const v = viewOf(history(["creature"], []), "type", "90d");
    expect(v.days).toEqual([]);
    expect(v.totals).toEqual([]);
    expect(v.moved).toEqual([]);
    expect(v.series).toEqual([]);
    expect(v.historyShort).toBe(false);
  });
});

describe("viewOf — the fold", () => {
  it("draws Total as one series in the accent", () => {
    const h = history(
      [],
      [
        { ago: 1, total: 100 },
        { ago: 0, total: 120 },
      ],
    );
    expect(viewOf(h, "total", "90d").series).toEqual([
      { key: "total", label: "Total", fill: TOTAL_FILL, values: [100, 120] },
    ]);
    expect(TOTAL_FILL).toBe("var(--color-accent)");
  });

  it("keeps five named card types and folds the rest, and Rust's other, into Other types", () => {
    const order = [
      "creature",
      "land",
      "artifact",
      "instant",
      "enchantment",
      "sorcery",
      "planeswalker",
      "battle",
      "other",
    ];
    const h = history(order, [
      { ago: 1, total: 45, values: [9, 8, 7, 6, 5, 4, 3, 2, 1] },
      { ago: 0, total: 90, values: [18, 16, 14, 12, 10, 8, 6, 4, 2] },
    ]);
    const v = viewOf(h, "type", "90d");
    expect(v.series).toEqual([
      { key: "creature", label: "Creature", fill: CATEGORICAL[0], values: [9, 18] },
      { key: "land", label: "Land", fill: CATEGORICAL[1], values: [8, 16] },
      { key: "artifact", label: "Artifact", fill: CATEGORICAL[2], values: [7, 14] },
      { key: "instant", label: "Instant", fill: CATEGORICAL[3], values: [6, 12] },
      { key: "enchantment", label: "Enchantment", fill: CATEGORICAL[4], values: [5, 10] },
      // sorcery + planeswalker + battle + other, point by point.
      { key: "other", label: "Other types", fill: OTHER_FILL, values: [10, 20] },
    ]);
    expect(CATEGORICAL).toEqual(["#4c88d3", "#d5753a", "#009b8f", "#9460b7", "#819f47"]);
    expect(OTHER_FILL).toBe("#55585f");
  });

  it("labels every card type the deck editor names", () => {
    const all = [
      "creature",
      "planeswalker",
      "instant",
      "sorcery",
      "artifact",
      "enchantment",
      "battle",
      "land",
    ];
    const labels = all.map((key) => {
      const v = viewOf(history([key], [{ ago: 0, total: 1, values: [1] }]), "type", "90d");
      return v.series[0].label;
    });
    expect(labels).toEqual([
      "Creature",
      "Planeswalker",
      "Instant",
      "Sorcery",
      "Artifact",
      "Enchantment",
      "Battle",
      "Land",
    ]);
  });

  it("keeps Rust's own other as the folded row when there are five named or fewer", () => {
    const h = history(
      ["creature", "land", "other"],
      [{ ago: 0, total: 6, values: [3, 2, 1] }],
    );
    expect(keys(viewOf(h, "type", "90d").series)).toEqual(["creature", "land", "other"]);
    expect(viewOf(h, "type", "90d").series[2]).toMatchObject({
      label: "Other types",
      fill: OTHER_FILL,
    });
  });

  it("adds no Other row when there is nothing to fold", () => {
    const h = history(["creature", "land"], [{ ago: 0, total: 5, values: [3, 2] }]);
    expect(keys(viewOf(h, "type", "90d").series)).toEqual(["creature", "land"]);
  });

  it("names a set by its name, an orphan by its code, and folds the tail into Every other", () => {
    const sets: Bucket[] = [
      { key: "mh3", name: "Modern Horizons 3" },
      { key: "cmm", name: "Commander Masters" },
      { key: "2x2", name: "Double Masters 2022" },
      { key: "ltr", name: "The Lord of the Rings: Tales of Middle-earth" },
      { key: "zzz", name: null },
      { key: "dmu", name: "Dominaria United" },
      { key: "other", name: null },
    ];
    const h = history(sets, [{ ago: 0, total: 28, values: [7, 6, 5, 4, 3, 2, 1] }]);
    const v = viewOf(h, "set", "90d");
    expect(v.series.map((s) => [s.label, s.fill, s.values])).toEqual([
      ["Modern Horizons 3", CATEGORICAL[0], [7]],
      ["Commander Masters", CATEGORICAL[1], [6]],
      ["Double Masters 2022", CATEGORICAL[2], [5]],
      ["The Lord of the Rings: Tales of Middle-earth", CATEGORICAL[3], [4]],
      ["ZZZ", CATEGORICAL[4], [3]],
      ["Every other set", OTHER_FILL, [3]],
    ]);
  });

  it("keeps every colour in Rust's order, in the identity palette, folding nothing", () => {
    const colours = ["W", "U", "B", "R", "G", "c", "multi"];
    const h = history(colours, [{ ago: 0, total: 28, values: [1, 2, 3, 4, 5, 6, 7] }]);
    const v = viewOf(h, "color", "90d");
    expect(v.series.map((s) => [s.key, s.label, s.fill])).toEqual([
      ["W", "White", "#dfd19d"],
      ["U", "Blue", "#1f86cd"],
      ["B", "Black", "#725195"],
      ["R", "Red", "#cc3f2f"],
      ["G", "Green", "#53be70"],
      ["c", MANA_LABEL.C, "#5c6b7a"],
      ["multi", "Multicolour", "#deb459"],
    ]);
    expect(IDENTITY_FILL).toEqual({
      W: "#dfd19d",
      U: "#1f86cd",
      B: "#725195",
      R: "#cc3f2f",
      G: "#53be70",
      c: "#5c6b7a",
      multi: "#deb459",
    });
  });

  it("drops a bucket worth nothing anywhere in the window, so it takes no palette slot", () => {
    // `neo` was sold before the 30-day window opened; it is still in Rust's list (it is non-zero
    // somewhere in the kept history) but not in this range.
    const h = history(
      [
        { key: "neo", name: "Kamigawa: Neon Dynasty" },
        { key: "mh3", name: "Modern Horizons 3" },
      ],
      [
        { ago: 60, total: 9, values: [9, 0] },
        { ago: 1, total: 4, values: [0, 4] },
        { ago: 0, total: 5, values: [0, 5] },
      ],
    );
    const v = viewOf(h, "set", "30d");
    expect(v.series).toEqual([
      { key: "mh3", label: "Modern Horizons 3", fill: CATEGORICAL[0], values: [4, 5] },
    ]);
    expect(keys(viewOf(h, "set", "all").series)).toEqual(["neo", "mh3"]);
  });

  it("reads a missing or non-finite bucket value as nothing, never NaN", () => {
    const h: ValueHistory = {
      buckets: [
        { key: "creature", name: null },
        { key: "land", name: null },
      ],
      points: [
        { day: ago(1), total: 3, values: [3], moved: null, live: false },
        { day: ago(0), total: Number.NaN, values: [Number.NaN, 2], moved: 1, live: true },
      ],
      today: TODAY,
    };
    const v = viewOf(h, "type", "90d");
    expect(v.totals).toEqual([3, 0]);
    expect(v.series.find((s) => s.key === "creature")?.values).toEqual([3, 0]);
    expect(v.series.find((s) => s.key === "land")?.values).toEqual([0, 2]);
  });
});

/* -------------------------------------------------------------------------- shownValues --- */

function series(values: number[]): Series {
  return { key: "k", label: "K", fill: "#000", values };
}

describe("shownValues", () => {
  it("answers the money itself for Value", () => {
    expect(shownValues(series([100, 110, 90]), "value")).toEqual([100, 110, 90]);
  });

  it("answers percent change since the first point for Change", () => {
    expect(shownValues(series([100, 110, 90]), "change")).toEqual([0, 10, -10]);
  });

  it("measures a bucket bought inside the window from its first non-zero point", () => {
    const shown = shownValues(series([0, 0, 50, 75]), "change");
    expect(shown).toEqual([0, 0, 0, 50]);
    expect(shown.every(Number.isFinite)).toBe(true);
  });

  it("draws a bucket worth nothing throughout flat at zero", () => {
    expect(shownValues(series([0, 0, 0]), "change")).toEqual([0, 0, 0]);
  });

  it("never answers negative zero", () => {
    for (const x of shownValues(series([100, 100, 0]), "change")) {
      expect(Object.is(x, -0)).toBe(false);
    }
    expect(shownValues(series([100, 100, 0]), "change")).toEqual([0, 0, -100]);
  });

  it("does not measure against a sub-cent float residue", () => {
    // A fold's sum can leave 1e-13 where there was nothing; a base that small is Infinity by
    // another name.
    const shown = shownValues(series([1e-13, 40, 60]), "change");
    expect(shown).toEqual([0, 0, 50]);
  });
});

/* --------------------------------------------------------------------- collectionChange --- */

function view(totals: number[], moved: (number | null)[], gapDays = 1): HistoryView {
  const n = totals.length;
  return {
    days: totals.map((_, i) => ago((n - 1 - i) * gapDays)),
    totals,
    moved,
    series: [{ key: "total", label: "Total", fill: TOTAL_FILL, values: totals }],
    historyShort: false,
    today: TODAY,
  };
}

describe("collectionChange", () => {
  it("is the step less what prices moved", () => {
    const v = view([100, 180, 150], [null, 5.4, -10]);
    expect(collectionChange(v, 1)).toBe(74.6);
    expect(collectionChange(v, 2)).toBe(-20);
  });

  it("is zero on the first point and wherever the move is unknown", () => {
    const v = view([100, 180, 150], [null, null, 30]);
    expect(collectionChange(v, 0)).toBe(0);
    expect(collectionChange(v, 1)).toBe(0);
    expect(collectionChange(v, 5)).toBe(0);
  });

  it("is a whole number of cents, and never negative zero", () => {
    const v = view([0.1 + 0.2, 0.6], [null, 0.3]);
    expect(collectionChange(v, 1)).toBe(0);
    expect(Object.is(collectionChange(v, 1), -0)).toBe(false);
  });
});

describe("markerDays", () => {
  it("marks the days a reader added or removed cards, and nothing else", () => {
    const v = view([100, 180, 150, 151, 151.004], [null, 5.4, -10, 1, 0]);
    expect(markerDays(v)).toEqual([v.days[1], v.days[2]]);
  });
});

/* ------------------------------------------------------------------------------ scaleFor --- */

function expectClean(scale: { lo: number; hi: number; ticks: number[] }, whole: boolean) {
  expect(Number.isFinite(scale.lo)).toBe(true);
  expect(Number.isFinite(scale.hi)).toBe(true);
  expect(scale.hi).toBeGreaterThan(scale.lo);
  expect(scale.ticks.length).toBeGreaterThanOrEqual(2);
  expect(scale.ticks.length).toBeLessThanOrEqual(4);
  for (const t of scale.ticks) {
    expect(t).toBeGreaterThanOrEqual(scale.lo);
    expect(t).toBeLessThanOrEqual(scale.hi);
    expect(Object.is(t, -0)).toBe(false);
    if (whole) expect(Number.isInteger(t)).toBe(true);
  }
}

describe("scaleFor", () => {
  it("pads a small money range and ticks it in whole units", () => {
    const s = scaleFor([1000, 1010], "value");
    // Centre 1005, padded by a twentieth of the value either side.
    expect(s.lo).toBeCloseTo(954.5);
    expect(s.hi).toBeCloseTo(1055.5);
    expect(s.ticks).toEqual([975, 1000, 1025, 1050]);
    expectClean(s, true);
  });

  it("pads a large money range by 12% of the spread either side", () => {
    const s = scaleFor([1200, 4800], "value");
    expect(s.lo).toBeCloseTo(768);
    expect(s.hi).toBeCloseTo(5232);
    expect(s.ticks).toEqual([2000, 4000]);
    expectClean(s, true);
  });

  it("never takes money below nothing", () => {
    const s = scaleFor([0, 10], "value");
    expect(s.lo).toBe(0);
    expectClean(s, true);
  });

  it("centres a flat line and still ticks it", () => {
    expectClean(scaleFor([0, 0, 0], "value"), true);
    expectClean(scaleFor([0.3, 0.3], "value"), true);
    expectClean(scaleFor([], "value"), true);
  });

  it("always includes zero for Change, padded 12% of the span", () => {
    const s = scaleFor([0, 5, 12], "change");
    expect(s.lo).toBeCloseTo(-1.44);
    expect(s.hi).toBeCloseTo(13.44);
    expect(s.ticks).toEqual([0, 5, 10]);
    expectClean(s, false);
  });

  it("draws a falling collection below zero with clean steps", () => {
    const s = scaleFor([0, -8, -3], "change");
    expect(s.lo).toBe(-9);
    expect(s.hi).toBe(1);
    expect(s.ticks).toEqual([-7.5, -5, -2.5, 0]);
    expectClean(s, false);
  });

  it("gives a zero tick that is positive zero, even when the step starts below it", () => {
    const s = scaleFor([0, 30], "change");
    expect(s.ticks).toEqual([0, 10, 20, 30]);
    expect(Object.is(s.ticks[0], 0)).toBe(true);
  });

  it("gives a flat Change line a span of one either side of zero", () => {
    const s = scaleFor([0, 0], "change");
    expect(s).toEqual({ lo: -1, hi: 1, ticks: [-1, 0, 1] });
  });
});

describe("tickLabel", () => {
  it("writes a percent with its sign, a real minus, and a decimal only when it needs one", () => {
    expect(tickLabel(10, "change", "usd")).toBe("+10%");
    expect(tickLabel(0, "change", "usd")).toBe("0%");
    expect(tickLabel(-5, "change", "usd")).toBe("−5%");
    expect(tickLabel(2.5, "change", "usd")).toBe("+2.5%");
    expect(tickLabel(-7.5, "change", "eur")).toBe("−7.5%");
  });

  it("writes money in whole units of the marketplace's currency", () => {
    expect(tickLabel(1000, "value", "usd")).toBe("$1,000");
    expect(tickLabel(0, "value", "usd")).toBe("$0");
    expect(tickLabel(2500, "value", "eur")).toBe("€2,500");
  });
});

/* ----------------------------------------------------------------------------- readoutAt --- */

/** Creature and land over three days: a reader adds $74.60 of cards, then removes $20.00. */
const THREE_DAYS = history(
  ["creature", "land"],
  [
    { ago: 2, total: 100, values: [60, 40], moved: null },
    { ago: 1, total: 180, values: [130, 50], moved: 5.4 },
    { ago: 0, total: 150, values: [110, 40], moved: -10 },
  ],
);

describe("readoutAt — a split", () => {
  const v = viewOf(THREE_DAYS, "type", "90d");

  it("dates a past point in full and the live point as Today", () => {
    expect(readoutAt(v, 1, "land", "usd").date).toBe("25 Sept 2026");
    expect(readoutAt(v, 2, "land", "usd").date).toBe("Today");
  });

  it("says what the change is measured from", () => {
    expect(readoutAt(v, 1, "land", "usd").since).toBe("change since 24 Sept");
  });

  it("gives the total and every bucket's value and change, the followed one lit", () => {
    const r = readoutAt(v, 1, "land", "usd");
    expect(r.total).toEqual({ value: "$180.00", change: "+80.0%", up: true });
    expect(r.rows).toEqual([
      {
        key: "creature",
        label: "Creature",
        fill: CATEGORICAL[0],
        value: "$130.00",
        change: "+116.7%",
        up: true,
        lit: false,
      },
      {
        key: "land",
        label: "Land",
        fill: CATEGORICAL[1],
        value: "$50.00",
        change: "+25.0%",
        up: true,
        lit: true,
      },
    ]);
    expect(r.facts).toEqual([]);
  });

  it("notes cards added that day", () => {
    expect(readoutAt(v, 1, "land", "usd").note).toBe("+$74.60 of cards added that day");
  });

  it("notes cards removed, with a real minus sign", () => {
    expect(readoutAt(v, 2, "land", "usd").note).toBe("−$20.00 of cards removed that day");
  });

  it("notes nothing where the collection did not change, and nothing on the first point", () => {
    const quiet = viewOf(
      history(
        ["creature"],
        [
          { ago: 1, total: 10, values: [10] },
          { ago: 0, total: 12, values: [12], moved: 2 },
        ],
      ),
      "type",
      "90d",
    );
    expect(readoutAt(quiet, 1, "creature", "usd").note).toBeNull();
    expect(readoutAt(v, 0, "land", "usd").note).toBeNull();
  });

  it("writes an unchanged figure without a sign, and counts it as up", () => {
    const r = readoutAt(v, 0, "land", "usd");
    expect(r.total).toEqual({ value: "$100.00", change: "0.0%", up: true });
  });

  it("says that week for a weekly step and since a date for an irregular one", () => {
    const weekly = viewOf(
      history(
        ["creature"],
        [
          { ago: 70, total: 10, values: [10] },
          { ago: 63, total: 30, values: [30], moved: 0 },
          { ago: 57, total: 50, values: [50], moved: 0 },
        ],
      ),
      "type",
      "all",
    );
    expect(readoutAt(weekly, 1, "creature", "usd").note).toBe("+$20.00 of cards added that week");
    expect(readoutAt(weekly, 2, "creature", "usd").note).toBe(
      "+$20.00 of cards added since 25 Jul",
    );
  });

  it("writes the start's year when the window crosses one", () => {
    const year = viewOf(
      history(
        ["creature"],
        [
          { ago: 300, total: 10, values: [10] },
          { ago: 0, total: 12, values: [12], moved: 2 },
        ],
      ),
      "type",
      "1y",
    );
    expect(readoutAt(year, 1, "creature", "usd").since).toBe("change since 30 Nov 2025");
  });

  it("quotes the marketplace's currency", () => {
    const r = readoutAt(v, 1, "land", "eur");
    expect(r.total.value).toBe("€180.00");
    expect(r.note).toBe("+€74.60 of cards added that day");
  });

  it("measures a bucket bought inside the window from its first price, never Infinity", () => {
    const bought = viewOf(
      history(
        ["creature", "land"],
        [
          { ago: 2, total: 10, values: [10, 0] },
          { ago: 1, total: 30, values: [10, 20], moved: 0 },
          { ago: 0, total: 35, values: [10, 25], moved: 5 },
        ],
      ),
      "type",
      "90d",
    );
    expect(readoutAt(bought, 0, "land", "usd").rows[1].change).toBe("0.0%");
    expect(readoutAt(bought, 2, "land", "usd").rows[1].change).toBe("+25.0%");
  });
});

describe("readoutAt — Total", () => {
  const v = viewOf(THREE_DAYS, "total", "90d");

  it("lists value, change since the start, and the step split into collection and prices", () => {
    const r = readoutAt(v, 1, "total", "usd");
    expect(r.rows).toEqual([]);
    expect(r.facts).toEqual([
      { label: "Value", value: "$180.00" },
      { label: "Since 24 Sept", value: "+$80.00", change: "+80.0%", up: true },
      { label: "Change that day", value: "+$80.00" },
      { label: "Collection changes that day", value: "+$74.60" },
      { label: "Price moves that day", value: "+$5.40" },
    ]);
  });

  it("carries the collection change in its facts, so it has no note and no since line", () => {
    const r = readoutAt(v, 2, "total", "usd");
    expect(r.date).toBe("Today");
    expect(r.note).toBeNull();
    expect(r.since).toBe("");
    expect(r.facts.slice(2)).toEqual([
      { label: "Change that day", value: "−$30.00" },
      { label: "Collection changes that day", value: "−$20.00" },
      { label: "Price moves that day", value: "−$10.00" },
    ]);
  });

  it("says none where the reader changed nothing", () => {
    const quiet = viewOf(
      history(
        [],
        [
          { ago: 1, total: 10 },
          { ago: 0, total: 12, moved: 2 },
        ],
      ),
      "total",
      "90d",
    );
    expect(readoutAt(quiet, 1, "total", "usd").facts[3]).toEqual({
      label: "Collection changes that day",
      value: "none",
    });
  });

  it("has no step on the first point", () => {
    expect(readoutAt(v, 0, "total", "usd").facts).toEqual([
      { label: "Value", value: "$100.00" },
      { label: "Since 24 Sept", value: "$0.00", change: "0.0%", up: true },
    ]);
  });
});

/* ----------------------------------------------------------------------------- dateTicks --- */

function totalView(agos: number[], window: "30d" | "90d" | "1y" | "all" = "all"): HistoryView {
  return viewOf(
    history(
      [],
      agos.map((a) => ({ ago: a, total: 1 })),
    ),
    "total",
    window,
  );
}

describe("dateTicks", () => {
  it("writes the first date, the middle one where it clears both, and Today", () => {
    expect(dateTicks(totalView([60, 30, 0]), [0, 200, 400])).toEqual([
      { x: 0, text: "28 Jul", anchor: "start" },
      { x: 200, text: "27 Aug", anchor: "middle" },
      { x: 400, text: "Today", anchor: "end" },
    ]);
  });

  it("leaves the middle date out where it would crowd an end", () => {
    expect(dateTicks(totalView([60, 30, 0]), [0, 50, 100])).toEqual([
      { x: 0, text: "28 Jul", anchor: "start" },
      { x: 100, text: "Today", anchor: "end" },
    ]);
  });

  it("writes the year on the first date when the range crosses one", () => {
    const ticks = dateTicks(totalView([300, 0]), [0, 400]);
    expect(ticks[0]).toEqual({ x: 0, text: "30 Nov 2025", anchor: "start" });
  });

  it("draws only Today where the ends do not both fit", () => {
    expect(dateTicks(totalView([300, 0]), [0, 90])).toEqual([
      { x: 90, text: "Today", anchor: "end" },
    ]);
  });

  it("says where a short history starts", () => {
    const ticks = dateTicks(totalView([20, 0], "90d"), [0, 400]);
    expect(ticks[0]).toEqual({ x: 0, text: "History starts 6 Sept", anchor: "start" });
  });

  it("centres a single point's date, and draws nothing for no points", () => {
    expect(dateTicks(totalView([0]), [120])).toEqual([{ x: 120, text: "Today", anchor: "middle" }]);
    expect(dateTicks(totalView([]), [])).toEqual([]);
  });
});

/* ----------------------------------------------------------------------------- layoutFor --- */

function fitAt(
  w: number,
  h: number,
  { cell = 104, compact = false }: { cell?: number; compact?: boolean } = {},
): WidgetFit {
  return makeFit({
    w,
    h,
    widthPx: spanPx(w, cell),
    heightPx: spanPx(h, cell),
    density: compact ? "compact" : "comfortable",
  });
}

describe("layoutFor — the fit table", () => {
  it("lays a 6×3 row out as chips across the top, the chart left and the rail right", () => {
    const fit = fitAt(6, 3); // body 662 × 284
    const l = layoutFor(fit, { split: "type", figures: true, bucketCount: 6 });
    expect(l.controls).toEqual({ x: 0, y: 0, w: 662, h: 26 });
    expect(l.chart).toEqual({ x: 0, y: 34, w: 436, h: 250 });
    expect(l.rail).toEqual({ x: 448, y: 34, w: 214, h: 250 });
    // The figure block heads the rail: 16 label + 28 line + 8 padding + 1 rule.
    expect(l.figures).toEqual({ x: 448, y: 34, w: 214, h: 53 });
    expect(l.list).toEqual({ x: 448, y: 95, w: 214, h: 189 });
    expect(l.railRows).toBe(7);
    expect(l.listColumns).toBe(1);
    expect(l.strip).toBeNull();
    expect(l.controlsHaveRanges).toBe(true);
    expect(l.controlsHaveMeasure).toBe(true);
  });

  it("widens the rail at seven and eight cells", () => {
    expect(layoutFor(fitAt(7, 3), { split: "type", figures: true, bucketCount: 6 }).rail?.w).toBe(
      236,
    );
    expect(layoutFor(fitAt(8, 3), { split: "type", figures: true, bucketCount: 6 }).rail?.w).toBe(
      236,
    );
  });

  it("gives the whole rail to rows when the totals are off", () => {
    const l = layoutFor(fitAt(6, 3), { split: "total", figures: false, bucketCount: 1 });
    expect(l.figures).toBeNull();
    expect(l.list).toEqual({ x: 448, y: 34, w: 214, h: 250 });
    expect(l.railRows).toBe(9);
  });

  it("drops the chips on a row two cells tall", () => {
    const l = layoutFor(fitAt(6, 2), { split: "type", figures: true, bucketCount: 6 });
    expect(l.controls).toBeNull();
    expect(l.chart?.y).toBe(0);
    expect(l.rail?.y).toBe(0);
  });

  it("stacks a 4×4 band: figures, chips with ranges, the chart, a two-column list", () => {
    const fit = fitAt(4, 4); // body 430 × 400
    const l = layoutFor(fit, { split: "type", figures: true, bucketCount: 6 });
    expect(l.figures).toEqual({ x: 0, y: 0, w: 430, h: 53 });
    expect(l.controls).toEqual({ x: 0, y: 61, w: 430, h: 26 });
    // Three rows of two, 24px rows 3px apart, flush with the foot of the body.
    expect(l.list).toEqual({ x: 0, y: 322, w: 430, h: 78 });
    expect(l.chart).toEqual({ x: 0, y: 95, w: 430, h: 219 });
    expect(l.listColumns).toBe(2);
    expect(l.strip).toBeNull();
    expect(l.rail).toBeNull();
    expect(l.controlsHaveRanges).toBe(true);
    expect(l.controlsHaveMeasure).toBe(false);
  });

  it("puts the measure chips on a five-cell band", () => {
    const l = layoutFor(fitAt(5, 3), { split: "type", figures: true, bucketCount: 6 });
    expect(l.controlsHaveMeasure).toBe(true);
  });

  it("draws a strip of names under a band three cells tall", () => {
    const l = layoutFor(fitAt(4, 3), { split: "color", figures: true, bucketCount: 7 });
    expect(l.strip).toEqual({ x: 0, y: 260, w: 430, h: 24 });
    expect(l.chart).toEqual({ x: 0, y: 95, w: 430, h: 157 });
    expect(l.list).toBeNull();
  });

  it("gives a 3×3 panel figures, the chart and a strip, and no chips", () => {
    const l = layoutFor(fitAt(3, 3), { split: "set", figures: true, bucketCount: 6 });
    expect(l.controls).toBeNull();
    // The small figure line: 16 + 24 + 8 + 1.
    expect(l.figures).toEqual({ x: 0, y: 0, w: 314, h: 49 });
    expect(l.strip).toEqual({ x: 0, y: 260, w: 314, h: 24 });
    expect(l.chart).toEqual({ x: 0, y: 57, w: 314, h: 195 });
  });

  it("gives a 2×2 tile the figure line and the chart alone", () => {
    const l = layoutFor(fitAt(2, 2), { split: "type", figures: true, bucketCount: 6 });
    expect(l.figures).toEqual({ x: 0, y: 0, w: 198, h: 49 });
    expect(l.chart).toEqual({ x: 0, y: 57, w: 198, h: 111 });
    expect([l.controls, l.rail, l.list, l.strip]).toEqual([null, null, null, null]);
  });

  it("draws no list or strip for Total", () => {
    for (const [w, h] of [
      [4, 4],
      [4, 3],
      [3, 3],
    ]) {
      const l = layoutFor(fitAt(w, h), { split: "total", figures: true, bucketCount: 1 });
      expect([l.list, l.strip]).toEqual([null, null]);
    }
  });

  it("tightens the gaps and the figure block when compact", () => {
    const l = layoutFor(fitAt(4, 4, { compact: true }), {
      split: "type",
      figures: true,
      bucketCount: 6,
    });
    // 16 + 28 + 5 + 1, then a 5px gap.
    expect(l.figures?.h).toBe(50);
    expect(l.controls?.y).toBe(55);
    expect(l.chart?.y).toBe(86);
  });

  it("falls back to the band's arrangement when a row is too narrow for its rail", () => {
    // The stacked page draws an eight-cell row at the canvas's width — here a phone's.
    const fit = makeFit({
      w: 8,
      h: 4,
      widthPx: 340,
      heightPx: spanPx(4, 68),
      density: "comfortable",
    });
    const l = layoutFor(fit, { split: "type", figures: true, bucketCount: 6 });
    expect(l.rail).toBeNull();
    expect(l.chart?.w).toBe(fit.bodyWidthPx);
    expect(l.figures?.y).toBe(0);
  });
});

/** Two rectangles share area — touching edges do not count. */
function overlaps(a: Rect, b: Rect): boolean {
  if (a.w === 0 || a.h === 0 || b.w === 0 || b.h === 0) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w + 1e-9 &&
    inner.y + inner.h <= outer.y + outer.h + 1e-9
  );
}

function rects(l: Layout): Rect[] {
  return [l.figures, l.controls, l.chart, l.rail, l.list, l.strip].filter(
    (r): r is Rect => r !== null,
  );
}

describe("layoutFor — every footprint", () => {
  const splits: ValueSplit[] = ["total", "type", "color", "set"];
  const fits: { label: string; fit: WidgetFit }[] = [];
  for (let w = 2; w <= 8; w++) {
    for (let h = 2; h <= 6; h++) {
      for (const compact of [false, true]) {
        for (const cell of [68, 104, 150]) {
          fits.push({
            label: `${w}×${h} @${cell}${compact ? " compact" : ""}`,
            fit: fitAt(w, h, { cell, compact }),
          });
        }
        // The stacked page: the canvas's width, the smallest cell's height. 200 is narrower than
        // any rail, so a row drawn there has to give its rail up.
        for (const width of [200, 300, 480]) {
          fits.push({
            label: `${w}×${h} stacked @${width}${compact ? " compact" : ""}`,
            fit: makeFit({
              w,
              h,
              widthPx: width,
              heightPx: spanPx(h, 68),
              density: compact ? "compact" : "comfortable",
            }),
          });
        }
      }
    }
  }

  it("keeps every region inside the body, apart from one another, and sized in whole rows", () => {
    const problems: string[] = [];
    for (const { label, fit } of fits) {
      const body: Rect = { x: 0, y: 0, w: fit.bodyWidthPx, h: fit.bodyHeightPx };
      for (const split of splits) {
        for (const figures of [true, false]) {
          const bucketCount = split === "total" ? 1 : split === "color" ? 7 : 6;
          const l = layoutFor(fit, { split, figures, bucketCount });
          const at = `${label} ${split}${figures ? "" : " no-figures"}`;
          for (const r of rects(l)) {
            const finite = [r.x, r.y, r.w, r.h].every(Number.isFinite);
            if (!finite || r.w < 0 || r.h < 0 || !inside(r, body)) {
              problems.push(`${at}: ${JSON.stringify(r)} outside ${JSON.stringify(body)}`);
            }
          }
          // The rail holds the figures and the list; everything else is laid side by side.
          const side = l.rail ? [] : [l.figures, l.list, l.strip];
          const placed = [l.controls, l.chart, l.rail, ...side].filter(
            (r): r is Rect => r !== null,
          );
          for (let i = 0; i < placed.length; i++) {
            for (let j = i + 1; j < placed.length; j++) {
              if (overlaps(placed[i], placed[j])) {
                problems.push(`${at}: regions ${i} and ${j} overlap`);
              }
            }
          }
          if (l.rail) {
            for (const r of [l.figures, l.list]) {
              if (r && !inside(r, l.rail)) {
                problems.push(`${at}: ${JSON.stringify(r)} outside the rail`);
              }
            }
            if (l.figures && l.list && overlaps(l.figures, l.list)) {
              problems.push(`${at}: the rail's figures and list overlap`);
            }
            if (l.list && l.railRows > 0 && l.railRows * 27 - 3 > l.list.h) {
              problems.push(`${at}: ${l.railRows} rail rows in ${l.list.h}px`);
            }
          } else if (l.railRows !== 0) {
            problems.push(`${at}: rail rows without a rail`);
          }
          if (l.list && !l.rail && (l.list.h + 3) % 27 !== 0) {
            problems.push(`${at}: a list ${l.list.h}px tall is not whole rows`);
          }
          if (split === "total" && (l.strip || (l.list && !l.rail))) {
            problems.push(`${at}: Total drew a bucket list`);
          }
          if (!figures && l.figures) problems.push(`${at}: figures drawn while off`);
          if (!l.controls && (l.controlsHaveRanges || l.controlsHaveMeasure)) {
            problems.push(`${at}: range or measure chips without controls`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("always leaves the chart a region", () => {
    for (const { fit } of fits) {
      for (const split of splits) {
        expect(layoutFor(fit, { split, figures: true, bucketCount: 7 }).chart).not.toBeNull();
      }
    }
  });
});
