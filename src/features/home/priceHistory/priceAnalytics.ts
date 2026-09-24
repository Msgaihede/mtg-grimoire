/**
 * What a price mover's dialog says about one printing's history — the chart's points for a range,
 * and the figures beside it. Rust supplies the snapshots as a `PriceHistory`; this draws every
 * conclusion from them, and touches no DOM, no query and no clock: `today` arrives with the
 * history, so one answer is the same answer however long the dialog stays open.
 *
 * ## The baseline is the widget's, to the snapshot
 *
 * The dialog opens from a row that already printed a move, and the move at the top of the dialog
 * is that same number or the dialog is contradicting the widget it opened from. So the baseline
 * here is `price_history.rs`' `Window::baseline`, restated: a week is the **latest** snapshot at
 * least seven days old, a month the latest at least thirty, all history the **oldest** before
 * today. **There is no fallback to a younger snapshot**, for the widget's reason: a range the
 * history does not yet reach is *not enough history yet*, which heals by itself as refreshes
 * happen, and a move measured over five days and labelled a week is a claim about a comparison
 * nobody made. The chart still draws what little there is; only the change goes to null.
 */
import type { PriceHistory, PriceMoverWindow } from "@/lib/ipc";

export const DAY_SECONDS = 86_400;

/** The minus sign every signed figure on the home page draws — never a hyphen. */
const MINUS = "−";

/** One drawn point; `live` marks the appended today/now point. */
export interface ChartPoint {
  day: number;
  price: number;
  live: boolean;
}

export interface RangeSeries {
  /** Oldest first: the baseline (if any), every snapshot after it, then today's live price (if
   *  priced). */
  points: ChartPoint[];
  /** The snapshot the range's change is measured against, or null when the history does not reach
   *  back that far. */
  baseline: ChartPoint | null;
}

export interface Extreme {
  price: number;
  day: number;
}

export interface RangeStats {
  now: number | null;
  /** The baseline's price. */
  then: number | null;
  thenDay: number | null;
  /** `now - then`; null when either is null. */
  change: number | null;
  /** `change / then`, a fraction (`0.124` is 12.4%); null when `then` is null or 0. */
  changePct: number | null;
  /** Over the range series' points, the live point included; the earliest day wins a tie. */
  high: Extreme | null;
  low: Extreme | null;
  /** Where today sits between the range's low (0) and high (1); null when unpriced or flat. */
  position: number | null;
  /** The oldest day in the **whole** history, not the range's; today when only `now` exists. */
  trackedSince: number | null;
  /** Distinct days across the whole history, today counted when it is priced. */
  trackedDays: number;
}

/** How far back a range's baseline must be, or null for `all`, which has no minimum age. */
function minimumAge(range: PriceMoverWindow): number | null {
  return range === "7d" ? 7 * DAY_SECONDS : range === "30d" ? 30 * DAY_SECONDS : null;
}

/** The snapshot `price_history::movers` measures `range` against — see the module doc. */
function baselineOf(history: PriceHistory, range: PriceMoverWindow): ChartPoint | null {
  const age = minimumAge(range);
  let found: { day: number; price: number } | null = null;
  for (const p of history.points) {
    if (age === null) {
      // `p.day < date('now')`: a row snapshotted this morning is never its own baseline.
      if (p.day < history.today && (found === null || p.day < found.day)) found = p;
    } else if (p.day <= history.today - age && (found === null || p.day > found.day)) {
      found = p;
    }
  }
  return found === null ? null : { day: found.day, price: found.price, live: false };
}

/**
 * The points a range draws, oldest first. With a baseline, that snapshot and everything after it;
 * without one, whatever the range reaches — so a week-old history still draws a week's line while
 * its change reads null. Today's live price closes the line when it is priced.
 */
export function rangeSeries(history: PriceHistory, range: PriceMoverWindow): RangeSeries {
  const baseline = baselineOf(history, range);
  const age = minimumAge(range);
  const after = baseline?.day ?? (age === null ? null : history.today - age);
  const points: ChartPoint[] = [];
  if (baseline !== null) points.push(baseline);
  for (const p of history.points) {
    if (p.day >= history.today) continue;
    if (after === null || p.day > after) points.push({ day: p.day, price: p.price, live: false });
  }
  if (history.now !== null) points.push({ day: history.today, price: history.now, live: true });
  return { points, baseline };
}

/** The highest or lowest point, the earliest day winning a tie whatever order the points came in. */
function extreme(points: ChartPoint[], beats: (a: number, b: number) => boolean): Extreme | null {
  let best: ChartPoint | null = null;
  for (const p of points) {
    const tie = best !== null && p.price === best.price && p.day < best.day;
    if (best === null || beats(p.price, best.price) || tie) best = p;
  }
  return best === null ? null : { price: best.price, day: best.day };
}

export function rangeStats(history: PriceHistory, range: PriceMoverWindow): RangeStats {
  const { points, baseline } = rangeSeries(history, range);
  const now = history.now;
  const then = baseline?.price ?? null;
  const change = now !== null && then !== null ? now - then : null;
  const high = extreme(points, (a, b) => a > b);
  const low = extreme(points, (a, b) => a < b);
  const position =
    now === null || high === null || low === null || high.price === low.price
      ? null
      : Math.min(1, Math.max(0, (now - low.price) / (high.price - low.price)));

  // Tracking is about the printing, not the range: a week's dialog on a card watched for a year
  // still says a year. A set, so a snapshot that somehow shares today's day is not counted twice.
  const days = new Set(history.points.map((p) => p.day));
  if (now !== null) days.add(history.today);
  let trackedSince: number | null = null;
  for (const day of days) if (trackedSince === null || day < trackedSince) trackedSince = day;

  return {
    now,
    then,
    thenDay: baseline?.day ?? null,
    change,
    changePct: change !== null && then !== null && then !== 0 ? change / then : null,
    high,
    low,
    position,
    trackedSince,
    trackedDays: days.size,
  };
}

// The house day formats (`NewPrintingsWidget.tsx`), built once. `timeZone: "UTC"` is load-bearing:
// every day here is a UTC midnight, and a local-time format writes it as the day before anywhere
// west of Greenwich. en-GB's CLDR data abbreviates September as `Sept`, as that widget's heading
// does — so `12 Sept`, and `Jun` for every other month's three letters.
const DAY_SHORT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const DAY_LONG = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** A day as the page writes it, in UTC (the days ARE UTC midnights — a local-time format shifts
 *  them a day west of Greenwich): "short" → "12 Jun", "long" → "12 Jun 2026". */
export function formatDay(day: number, style: "short" | "long"): string {
  return (style === "short" ? DAY_SHORT : DAY_LONG).format(day * 1000);
}

/** One decimal, grouped — en-US, the locale `formatPrice` quotes dollars in. */
const PERCENT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * "+12.4%", "−3.0%" — one decimal, a real minus sign U+2212 like `signedMoney` in
 * PriceMoversWidget.tsx; "0.0%" for zero. `pct` is a fraction, as {@link RangeStats.changePct}
 * holds it.
 *
 * Rounded to tenths **before** the sign is chosen, half away from zero on both sides, so a move that
 * reads `0.0%` carries no sign: a plus or a minus in front of a zero claims a direction the figure
 * cannot show.
 */
export function signedPercent(pct: number): string {
  const tenths = Math.round(Math.abs(pct) * 1000);
  const figure = `${PERCENT.format(tenths / 10)}%`;
  if (tenths === 0) return figure;
  return `${pct < 0 ? MINUS : "+"}${figure}`;
}

/** The range as a phrase for sentences: 7d → "7 days", 30d → "30 days", all → "all kept
 *  history". */
export function rangePhrase(range: PriceMoverWindow): string {
  return range === "7d" ? "7 days" : range === "30d" ? "30 days" : "all kept history";
}
