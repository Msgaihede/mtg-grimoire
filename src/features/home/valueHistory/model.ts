/**
 * What the collection value graph says, before anything is drawn: the range, the fold into lines,
 * the scale, the readout's sentences, the date labels and where every region of the card goes.
 *
 * Rust answers `collection_value_history` with facts — a total and one value per bucket for every
 * kept period, today's live point last, and the price-only part of each step (`moved`). Every
 * conclusion is drawn here, and nothing here touches the DOM, a query or a clock: `today` arrives
 * with the history, so one answer stays the same answer however long the page stays open, and the
 * widget, its stories and its tests all read the same functions.
 *
 * ## The range is a cutoff, and short means the history, not the range
 *
 * A range keeps the points on or after `today − days`. **A history is short only when its oldest
 * point is after that cutoff** — not when the range's own first point is. Beyond 35 days the table
 * keeps one point a week, so a 90-day range over a year of history can open on day 86 with nothing
 * on day 90 itself; calling that *History starts 86 days ago* would be a false sentence about a
 * history that goes back a year.
 *
 * ## The fold
 *
 * Colour keeps every bucket Rust gave, in Rust's WUBRG order, because its seven lines are a fixed
 * vocabulary with a colour each. Card type and set keep the **first five named buckets** — Rust has
 * already ranked them by today's value — and fold everything else, Rust's own `other` included,
 * into one grey line, because five is what the categorical palette separates and a sixth colour
 * would have to repeat one. **A bucket worth nothing anywhere in the range is dropped before the
 * five are chosen**: Rust keeps a set that is non-zero somewhere in the whole history, and a set
 * sold a year ago would otherwise hold a palette slot and a list row in a 30-day range, drawn flat
 * at zero.
 *
 * ## Change is measured from a bucket's first price
 *
 * `Change` plots percent since the range's first point — except that a set bought inside the range
 * *has* no first price, and `v / 0` is the `Infinity` that would reach the path. So a line is
 * measured from its first non-zero point and is flat at zero before it. "Non-zero" means half a
 * cent or more: a fold's sum can leave `1e-13` where there was nothing, and a base that small is
 * `Infinity` by another name.
 */
import type { ValueHistory, ValueSplit } from "@/lib/ipc";
import { MANA_LABEL } from "@/lib/mana";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { TYPE_BUCKETS } from "@/features/decks/deckBuckets";

import type { WidgetFit } from "../fit";
import { DAY_SECONDS, formatDay, signedPercent } from "../priceHistory/priceAnalytics";
import { signedMoney } from "../widgets/PriceMoversWidget";

export type ValueWindow = "30d" | "90d" | "1y" | "all";
export type ValueMeasure = "value" | "change";

/** How far back each range reaches, in days; `null` keeps every point the table kept. */
export const WINDOW_DAYS: Record<ValueWindow, number | null> = {
  "30d": 30,
  "90d": 90,
  "1y": 365,
  all: null,
};

/**
 * The categorical palette for card type and set, in slot order — validated for colour-blind
 * separation against `--color-bg` (worst adjacent-pair CVD ΔE 9.4). The design spec has the
 * measurement; five is why the fold keeps five.
 */
export const CATEGORICAL: readonly string[] = [
  "#4c88d3",
  "#d5753a",
  "#009b8f",
  "#9460b7",
  "#819f47",
];

/** The folded line. Grey, so the one line that is not a bucket reads as not one. */
export const OTHER_FILL: string = "#55585f";

/**
 * Colour identity, keyed as `collection_breakdown` keys it. **Not** the `--color-mana-*` pastels
 * the Collection value widget uses: those were measured for this chart and fail (Black against
 * Colourless ΔE 2.0). White, colourless and multicolour sit outside the validator's band on purpose
 * — they have to read as white, grey and gold — which is why identity is carried by the list's
 * words and the readout, never by the line's colour alone.
 */
export const IDENTITY_FILL: Record<string, string> = {
  W: "#dfd19d",
  U: "#1f86cd",
  B: "#725195",
  R: "#cc3f2f",
  G: "#53be70",
  c: "#5c6b7a",
  multi: "#deb459",
};

/** Money is the accent, so the collection's own line is too. */
export const TOTAL_FILL: string = "var(--color-accent)";

/** Rust's key for everything past its own cap, and the folded line's key here. */
const OTHER_KEY = "other";

/** The minus sign every signed figure on the home page draws — never a hyphen. */
const MINUS = "−";

/** Below half a cent is nothing: a float's residue, and a figure `formatPrice` prints as zero. */
const HALF_CENT = 0.005;

export interface Series {
  key: string;
  label: string;
  fill: string;
  values: number[];
}

export interface HistoryView {
  /** Unix seconds, oldest first, inside the range. */
  days: number[];
  totals: number[];
  /** Same length as `days`; null on the range's first point, whose previous point is not drawn. */
  moved: (number | null)[];
  /** `[total]` for Total; the folded buckets otherwise. */
  series: Series[];
  /** The kept history starts after the range would — see the module doc. */
  historyShort: boolean;
  today: number;
}

/** A number, or nothing where Rust sent something that is not one. */
function finite(x: number | null | undefined): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

/** Adding zero turns `-0` into `0` and leaves every other number alone. */
function unsigned(x: number): number {
  return x + 0;
}

/** Whole cents — money here is priced in cents, so anything finer is float residue. */
function cents(x: number): number {
  return unsigned(Math.round(x * 100) / 100);
}

/** The deck editor's own words for a card type — one answer to "what type is this card". */
const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TYPE_BUCKETS.map((word) => [word.toLowerCase(), word]),
);

/** `CollectionValueWidget`'s words: WUBRG from `MANA_LABEL`, `c` lowercase on the wire. */
const COLOUR_LABEL: Record<string, string> = {
  W: MANA_LABEL.W,
  U: MANA_LABEL.U,
  B: MANA_LABEL.B,
  R: MANA_LABEL.R,
  G: MANA_LABEL.G,
  c: MANA_LABEL.C,
  multi: "Multicolour",
};

function typeLabel(key: string): string {
  return TYPE_LABEL[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

function fold(
  h: ValueHistory,
  split: Exclude<ValueSplit, "total">,
  valuesOf: (j: number) => number[],
): Series[] {
  const present = h.buckets
    .map((bucket, j) => ({ bucket, values: valuesOf(j) }))
    .filter(({ values }) => values.some((v) => Math.abs(v) >= HALF_CENT));

  if (split === "color") {
    return present.map(({ bucket, values }) => ({
      key: bucket.key,
      label: COLOUR_LABEL[bucket.key] ?? bucket.key,
      fill: IDENTITY_FILL[bucket.key] ?? OTHER_FILL,
      values,
    }));
  }

  const named = present.filter(({ bucket }) => bucket.key !== OTHER_KEY);
  const kept = named.slice(0, CATEGORICAL.length);
  const rest = [
    ...named.slice(CATEGORICAL.length),
    ...present.filter(({ bucket }) => bucket.key === OTHER_KEY),
  ];
  const series: Series[] = kept.map(({ bucket, values }, i) => ({
    key: bucket.key,
    label: split === "type" ? typeLabel(bucket.key) : (bucket.name ?? bucket.key.toUpperCase()),
    fill: CATEGORICAL[i],
    values,
  }));
  if (rest.length > 0) {
    series.push({
      key: OTHER_KEY,
      label: split === "type" ? "Other types" : "Every other set",
      fill: OTHER_FILL,
      values: rest[0].values.map((_, i) => rest.reduce((sum, r) => sum + r.values[i], 0)),
    });
  }
  return series;
}

/** Range, fold and label. Pure. */
export function viewOf(h: ValueHistory, split: ValueSplit, window: ValueWindow): HistoryView {
  const reach = WINDOW_DAYS[window];
  const cutoff = reach === null ? null : h.today - reach * DAY_SECONDS;
  const points = cutoff === null ? h.points : h.points.filter((p) => p.day >= cutoff);
  const oldest = h.points.length > 0 ? h.points[0].day : null;

  const totals = points.map((p) => finite(p.total));
  const moved = points.map((p, i) =>
    i === 0 || p.moved === null || !Number.isFinite(p.moved) ? null : p.moved,
  );
  const series: Series[] =
    split === "total"
      ? [{ key: "total", label: "Total", fill: TOTAL_FILL, values: totals }]
      : fold(h, split, (j) => points.map((p) => finite(p.values[j])));

  return {
    days: points.map((p) => p.day),
    totals,
    moved,
    series,
    historyShort: cutoff !== null && oldest !== null && oldest > cutoff,
    today: h.today,
  };
}

/** Percent change since the range's first point (×100), or the raw values. */
export function shownValues(s: Series, measure: ValueMeasure): number[] {
  if (measure === "value") return s.values.slice();
  const start = s.values.findIndex((v) => Math.abs(v) >= HALF_CENT);
  if (start < 0) return s.values.map(() => 0);
  const base = s.values[start];
  // `(v − base) × 100 / base` rather than `(v / base − 1) × 100`: the same number, without the
  // `10.000000000000009` that dividing first leaves on a ten-percent move.
  return s.values.map((v, i) => (i < start ? 0 : unsigned(((v - base) * 100) / base)));
}

/**
 * What the reader added (positive) or removed (negative) in the step into point `i`: the step less
 * what prices moved. `0` at `i = 0` and wherever the move is unknown — a step with no price part is
 * a step nothing can be said about, not one that was all collection.
 */
export function collectionChange(v: HistoryView, i: number): number {
  if (i <= 0 || i >= v.totals.length) return 0;
  const moved = v.moved[i];
  if (moved === null || moved === undefined) return 0;
  return cents(v.totals[i] - v.totals[i - 1] - moved);
}

/** The days a marker goes on: every step in which the collection itself changed. */
export function markerDays(v: HistoryView): number[] {
  return v.days.filter((_, i) => Math.abs(collectionChange(v, i)) >= HALF_CENT);
}

/* ---------------------------------------------------------------------------- the scale --- */

export interface Scale {
  lo: number;
  hi: number;
  ticks: number[];
}

/** Three or four ticks, never more — enough to read a figure off, few enough to stay quiet. */
const MAX_TICKS = 4;

/** The multiples of `step` inside `[lo, hi]`, rounded to whole cents so `0.1 * 3` is `0.3`. */
function ticksIn(lo: number, hi: number, step: number): number[] {
  const first = Math.ceil(lo / step - 1e-9);
  const last = Math.floor(hi / step + 1e-9);
  const out: number[] = [];
  // `unsigned`: a domain starting just below zero puts `first` at `-0`, and a `-0` tick is a
  // `−0%` label.
  for (let i = first; i <= last; i++) out.push(unsigned(Math.round(i * step * 100) / 100));
  return out;
}

/**
 * The smallest clean step — 1, 2, 2.5 or 5 of a power of ten — that puts at most four ticks in the
 * domain. **A money step must be a whole unit**, because {@link tickLabel} writes money without
 * cents: a `2.5` step would print `$3` for a tick at `2.5`, a figure sitting where it does not
 * belong. A percent may take the half, since its label keeps one decimal where it needs one.
 */
function tickStep(lo: number, hi: number, whole: boolean): number {
  for (let exp = 0; exp <= 15; exp++) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * 10 ** exp;
      if (whole && !Number.isInteger(step)) continue;
      if (ticksIn(lo, hi, step).length <= MAX_TICKS) return step;
    }
  }
  return 10 ** 16;
}

/**
 * The y domain and its clean figures.
 *
 * **Value** is `PriceChart.tsx`'s `priceScale`, with its reasons: half the spread plus 12% of it
 * either side, or a twentieth of the value, or one unit, whichever is widest — so a flat line is a
 * line across the middle rather than one hugging an axis, and a small wobble on a large collection
 * is drawn as the wobble it is rather than stretched to the full height. The floor is one unit
 * where the price chart's is a cent, because these ticks are labelled in whole units. Money is
 * never below nothing, so the scale is not either.
 *
 * **Change** always includes zero — the line every bucket starts on, and the one a reader reads
 * gain against loss from — padded by 12% of the span or one point, whichever is wider.
 */
export function scaleFor(values: readonly number[], measure: ValueMeasure): Scale {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) {
    min = 0;
    max = 0;
  }

  if (measure === "value") {
    const centre = (min + max) / 2;
    const half = Math.max((max - min) * 0.62, max * 0.05, 1);
    const lo = unsigned(Math.max(0, centre - half));
    const hi = centre + half;
    return { lo, hi, ticks: ticksIn(lo, hi, tickStep(lo, hi, true)) };
  }

  const low = Math.min(0, min);
  const high = Math.max(0, max);
  const pad = Math.max((high - low) * 0.12, 1);
  const lo = low - pad;
  const hi = high + pad;
  return { lo, hi, ticks: ticksIn(lo, hi, tickStep(lo, hi, false)) };
}

/** A percent tick's figure: grouped, one decimal only where the tick has one. */
const TICK_PERCENT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/**
 * A tick's label. Change: `+10%`, `0%`, `−7.5%` — zero carries no sign, since a plus or a minus in
 * front of a zero claims a direction it cannot show. Value: whole units in the marketplace's
 * currency, through `formatPrice` so the symbol and grouping are the ones every other price here
 * wears; the ticks are whole units by {@link tickStep}, so the cents it writes are always `.00`.
 */
export function tickLabel(t: number, measure: ValueMeasure, currency: Currency): string {
  if (measure === "change") {
    const tenths = Math.round(Math.abs(t) * 10);
    if (tenths === 0) return "0%";
    return `${t < 0 ? MINUS : "+"}${TICK_PERCENT.format(tenths / 10)}%`;
  }
  return formatPrice(unsigned(Math.round(t)), currency).replace(/\.00(?!\d)/, "");
}

/* ------------------------------------------------------------------------------ readout --- */

export interface Readout {
  /** `Today` for the live point, else the day in full. */
  date: string;
  /** `change since 4 Jul`, the start's year written when the range crosses one; empty on Total,
   *  whose facts say it on a row of their own. */
  since: string;
  total: { value: string; change: string; up: boolean };
  /** Every line's value and change, the followed one lit. Empty on Total. */
  rows: {
    key: string;
    label: string;
    fill: string;
    value: string;
    change: string;
    up: boolean;
    lit: boolean;
  }[];
  /** Total only: value, change since the start, and the step split into the reader's part and the
   *  prices'. */
  facts: { label: string; value: string; change?: string; up?: boolean }[];
  /** What the reader added or removed in the step, on a split; null where they changed nothing,
   *  and always on Total, whose facts carry it. */
  note: string | null;
}

function yearOf(day: number): number {
  return new Date(day * 1000).getUTCFullYear();
}

/** Whether a range's ends are in two different years — which decides whether a date says its
 *  year: a year of history reads `26 Sept` to `26 Sept` otherwise, a range of no length at all. */
function crossesYear(v: HistoryView): boolean {
  return v.days.length > 1 && yearOf(v.days[0]) !== yearOf(v.days[v.days.length - 1]);
}

/**
 * Money with its sign, or none on a figure that rounds to zero cents — `signedPercent`'s rule, for
 * `signedMoney`'s figures: `+$0.00` claims a direction nobody moved in.
 */
function signed(x: number, currency: Currency): string {
  return Math.round(Math.abs(x) * 100) === 0 ? formatPrice(0, currency) : signedMoney(x, currency);
}

/** Whether a percent's chip is the gain fill: anything that does not print as a loss. */
function upOf(pct: number): boolean {
  return !(pct < 0 && Math.round(Math.abs(pct) * 10) !== 0);
}

/** The step into point `i` in words: a day apart, a week apart, or since the previous point's day
 *  — the weekly region's points sit on a period's *latest* day, which is not always seven apart. */
function stepWord(v: HistoryView, i: number): string {
  const gap = Math.round((v.days[i] - v.days[i - 1]) / DAY_SECONDS);
  if (gap === 1) return "that day";
  if (gap === 7) return "that week";
  return `since ${formatDay(v.days[i - 1], "short")}`;
}

function isTotal(v: HistoryView): boolean {
  return v.series.length === 1 && v.series[0].key === "total";
}

/** Everything the hovered point holds, as the readout writes it. */
export function readoutAt(v: HistoryView, i: number, litKey: string, currency: Currency): Readout {
  const n = v.days.length;
  if (n === 0) {
    return {
      date: "",
      since: "",
      total: { value: formatPrice(null, currency), change: "", up: true },
      rows: [],
      facts: [],
      note: null,
    };
  }
  const at = Math.max(0, Math.min(n - 1, Math.round(i)));
  const start = formatDay(v.days[0], crossesYear(v) ? "long" : "short");
  const total = v.totals[at];
  const totalPct = shownValues({ key: "", label: "", fill: "", values: v.totals }, "change")[at];
  const date = v.days[at] === v.today ? "Today" : formatDay(v.days[at], "long");
  const head = {
    date,
    total: {
      value: formatPrice(total, currency),
      change: signedPercent(totalPct / 100),
      up: upOf(totalPct),
    },
  };
  const change = collectionChange(v, at);
  const per = at > 0 ? stepWord(v, at) : "";

  if (isTotal(v)) {
    const facts: Readout["facts"] = [
      { label: "Value", value: formatPrice(total, currency) },
      {
        label: `Since ${start}`,
        value: signed(total - v.totals[0], currency),
        change: signedPercent(totalPct / 100),
        up: upOf(totalPct),
      },
    ];
    if (at > 0) {
      const step = total - v.totals[at - 1];
      facts.push(
        { label: `Change ${per}`, value: signed(step, currency) },
        {
          label: `Collection changes ${per}`,
          value: change === 0 ? "none" : signed(change, currency),
        },
        { label: `Price moves ${per}`, value: signed(step - change, currency) },
      );
    }
    return { ...head, since: "", rows: [], facts, note: null };
  }

  const rows = v.series.map((s) => {
    const pct = shownValues(s, "change")[at];
    return {
      key: s.key,
      label: s.label,
      fill: s.fill,
      value: formatPrice(finite(s.values[at]), currency),
      change: signedPercent(pct / 100),
      up: upOf(pct),
      lit: s.key === litKey,
    };
  });
  const note =
    change === 0
      ? null
      : `${signed(change, currency)} of cards ${change > 0 ? "added" : "removed"} ${per}`;
  return { ...head, since: `change since ${start}`, rows, facts: [], note };
}

/* -------------------------------------------------------------------------- date labels --- */

/** The date type, in px — `PriceChart`'s. */
const TICK_SIZE = 11;
/** Geist's advance at the tick size, a little wide of the measured ~5.6px: the dates are set in the
 *  proportional face, so their widths are estimated, and an estimate that errs wide drops a label
 *  rather than overlapping two. */
const SANS_CHAR = TICK_SIZE * 0.55;
/** The least air between two dates. */
const DATE_GAP = 12;

function wide(text: string): number {
  return text.length * SANS_CHAR;
}

/**
 * The dates under the plot, `PriceChart`'s rule: the last always, the first where it fits beside
 * it, and a middle one only where it clears both. The last is the live point, so it says `Today`.
 *
 * **A range that crosses a new year writes the year on the first date**; where that does not fit
 * beside the last, only the last is drawn. **A short history says so on its first date** —
 * `History starts 6 Sept` — and drops the words before it drops the date. The middle label is a
 * day that really is in the series, the one nearest the midpoint, rather than an interpolated date
 * nothing was kept on.
 */
export function dateTicks(
  v: HistoryView,
  xs: readonly number[],
): { x: number; text: string; anchor: "start" | "middle" | "end" }[] {
  const n = Math.min(v.days.length, xs.length);
  if (n === 0) return [];
  const lastDay = v.days[n - 1];
  const crosses = yearOf(v.days[0]) !== yearOf(lastDay);
  const lasts =
    lastDay === v.today
      ? ["Today"]
      : crosses
        ? [formatDay(lastDay, "long"), formatDay(lastDay, "short")]
        : [formatDay(lastDay, "short")];
  if (n === 1) return [{ x: xs[0], text: lasts[lasts.length - 1], anchor: "middle" }];

  const firstDate = formatDay(v.days[0], crosses ? "long" : "short");
  const firsts = v.historyShort ? [`History starts ${firstDate}`, firstDate] : [firstDate];
  const span = xs[n - 1] - xs[0];
  let ends: [string, string] | null = null;
  for (const a of firsts) {
    const b = lasts.find((l) => wide(a) + wide(l) + DATE_GAP <= span);
    if (b !== undefined) {
      ends = [a, b];
      break;
    }
  }
  if (ends === null) return [{ x: xs[n - 1], text: lasts[lasts.length - 1], anchor: "end" }];

  const first = { x: xs[0], text: ends[0], anchor: "start" as const };
  const last = { x: xs[n - 1], text: ends[1], anchor: "end" as const };
  const midX = (xs[0] + xs[n - 1]) / 2;
  let mid = 0;
  for (let i = 1; i < n; i++) if (Math.abs(xs[i] - midX) < Math.abs(xs[mid] - midX)) mid = i;
  const midText = formatDay(v.days[mid], "short");
  const half = wide(midText) / 2;
  const clear =
    mid > 0 &&
    mid < n - 1 &&
    xs[mid] - half - DATE_GAP >= xs[0] + wide(first.text) &&
    xs[mid] + half + DATE_GAP <= xs[n - 1] - wide(last.text);
  return clear ? [first, { x: xs[mid], text: midText, anchor: "middle" }, last] : [first, last];
}

/* ------------------------------------------------------------------------------- layout --- */

export type Tier = WidgetFit["tier"];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  figures: Rect | null;
  controls: Rect | null;
  chart: Rect | null;
  rail: Rect | null;
  /** Where the bucket rows go: under the figures inside the rail (one column, `railRows` of them),
   *  or a band's two-column list sized to exactly its rows — `(h + 3) / 27` rows a column. */
  list: Rect | null;
  strip: Rect | null;
  controlsHaveRanges: boolean;
  controlsHaveMeasure: boolean;
  /** Whole rows that fit under the rail's figure block; 0 without a rail. */
  railRows: number;
  listColumns: 1 | 2;
}

/** One list row: a 24px bordered row and the 3px between rows. */
const ROW_PITCH = 27;
const ROW_GAP = 3;
/** The in-card chips' row, and the strip of bucket names. */
const CONTROLS_H = 26;
const STRIP_H = 24;
/** The rail beside the chart on a row, and the air between them. */
const RAIL_W = 214;
const RAIL_W_WIDE = 236;
const RAIL_GAP = 12;
/** Body widths at which the chips row takes the range chips, then the measure chips too. */
const RANGES_AT = 400;
const MEASURE_AT = 520;
/**
 * The least chart worth keeping beside a rail, and under the rest of a band. The grid never comes
 * near either — the smallest cell (68px) leaves a six-cell row a 220px chart and a four-cell band
 * a 48px one — so these decide only the stacked page on a phone and a catalogue box, where the
 * alternative is a chart of no width or a list drawn over it.
 */
const MIN_CHART_W = 160;
const MIN_CHART_H = 40;

type Bottom = "list" | "strip" | null;

/**
 * Body-pixel rectangles for every region, per the spec's fit table.
 *
 * - **2 cells** — the figure line and the chart.
 * - **3 cells** — the figure line, the chart, and a strip of bucket names at 3+ tall.
 * - **4–5 cells** — the figure line; the in-card chips at 3+ tall (the range chips from 400px of
 *   body, the measure chips from 520); the chart; a two-column list at 4+ tall, else the strip.
 * - **6+ cells** — the chips across the top at 3+ tall; the chart on the left; a rail on the right
 *   holding the figures and the rows under them.
 *
 * `bucketCount` is the folded series' count ({@link HistoryView.series}), which is what the list
 * draws a row for. **Every rect lies inside the body** at every footprint the page allows: where a
 * box is too small for the table's arrangement, the list gives way to the strip, then the chips,
 * then the strip too, before the chart is squeezed — and a row too narrow for its rail is laid out
 * as a band.
 */
export function layoutFor(
  fit: WidgetFit,
  opts: { split: ValueSplit; figures: boolean; bucketCount: number },
): Layout {
  const bodyW = Math.max(0, fit.bodyWidthPx);
  const bodyH = Math.max(0, fit.bodyHeightPx);
  const gap = fit.compact ? 5 : 8;
  // The label, the figure line (the bigger figure from a band up), its padding and its rule.
  const figuresH = 16 + (fit.tier >= 2 ? 28 : 24) + (fit.compact ? 5 : 8) + 1;
  const wantControls = fit.tier >= 2 && fit.h >= 3;
  const buckets = opts.split !== "total" && opts.bucketCount > 0;
  const railW = fit.w >= 7 ? RAIL_W_WIDE : RAIL_W;

  const chips = (controls: Rect | null) => ({
    controlsHaveRanges: controls !== null && bodyW >= RANGES_AT,
    controlsHaveMeasure: controls !== null && bodyW >= MEASURE_AT,
  });

  if (fit.tier === 3 && bodyW >= railW + RAIL_GAP + MIN_CHART_W) {
    const withControls = wantControls && bodyH - CONTROLS_H - gap >= MIN_CHART_H;
    const controls = withControls ? { x: 0, y: 0, w: bodyW, h: CONTROLS_H } : null;
    const top = withControls ? CONTROLS_H + gap : 0;
    const h = bodyH - top;
    const rail = { x: bodyW - railW, y: top, w: railW, h };
    const figures = opts.figures && figuresH <= h ? { ...rail, h: figuresH } : null;
    const head = figures === null ? 0 : figuresH + gap;
    const list = h - head > 0 ? { x: rail.x, y: top + head, w: railW, h: h - head } : null;
    return {
      figures,
      controls,
      chart: { x: 0, y: top, w: bodyW - railW - RAIL_GAP, h },
      rail,
      list,
      strip: null,
      ...chips(controls),
      railRows: list === null ? 0 : Math.max(0, Math.floor((list.h + ROW_GAP) / ROW_PITCH)),
      listColumns: 1,
    };
  }

  // A band's arrangement — and a row's, when the row is too narrow for its rail.
  const tier = Math.min(fit.tier, 2);
  const figures =
    opts.figures && figuresH + gap <= bodyH ? { x: 0, y: 0, w: bodyW, h: figuresH } : null;
  const below = figures === null ? 0 : figuresH + gap;
  const listH = Math.ceil(opts.bucketCount / 2) * ROW_PITCH - ROW_GAP;
  const bottomH = (b: Bottom) => (b === "list" ? listH + gap : b === "strip" ? STRIP_H + gap : 0);

  const bottoms: Bottom[] = [];
  if (buckets && tier === 2 && fit.h >= 4) bottoms.push("list");
  if (buckets && tier >= 1 && fit.h >= 3) bottoms.push("strip");
  // The table's arrangement first; then the list gives way to the strip, the chips go, and the
  // strip goes last — a line with no word naming it is the one thing this chart must not draw.
  const tries: [boolean, Bottom][] = [];
  for (const withControls of wantControls ? [true, false] : [false]) {
    for (const bottom of bottoms) tries.push([withControls, bottom]);
  }
  if (wantControls) tries.push([true, null]);
  tries.push([false, null]);

  const fits = ([withControls, bottom]: [boolean, Bottom]) =>
    bodyH - below - (withControls ? CONTROLS_H + gap : 0) - bottomH(bottom) >= MIN_CHART_H;
  const [withControls, bottom] = tries.find(fits) ?? [false, null];

  const controls = withControls ? { x: 0, y: below, w: bodyW, h: CONTROLS_H } : null;
  const top = below + (withControls ? CONTROLS_H + gap : 0);
  const chartH = Math.max(0, bodyH - top - bottomH(bottom));
  return {
    figures,
    controls,
    chart: { x: 0, y: Math.min(top, bodyH), w: bodyW, h: chartH },
    rail: null,
    list: bottom === "list" ? { x: 0, y: bodyH - listH, w: bodyW, h: listH } : null,
    strip: bottom === "strip" ? { x: 0, y: bodyH - STRIP_H, w: bodyW, h: STRIP_H } : null,
    ...chips(controls),
    railRows: 0,
    listColumns: bottom === "list" ? 2 : 1,
  };
}
