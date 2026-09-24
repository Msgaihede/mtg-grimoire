/**
 * One printing's price over a range, drawn: a gold line, a wash under it, a price scale on the
 * right and the dates beneath.
 *
 * **Hand-drawn SVG, for `WidgetParts.tsx`'s reason** — nothing in this app is a chart library,
 * because every picture here is decoration over numbers that are already text. The drawing is
 * `aria-hidden`; the host's one-sentence `summary` is what a screen reader gets, and the figures
 * beside the chart in the dialog are what the tooltip merely enhances.
 *
 * **The scale is on the right, which is a price ticker's convention and not a web chart's.** The
 * eye ends a price line at *now*, at the right-hand edge, and the figures it wants to read that end
 * against are beside it rather than across the whole plot.
 *
 * **Colour follows the house's two money rules and dataviz's one text rule, and they agree.** The
 * line and its wash are the accent, because money is the accent; every word and figure drawn here
 * — ticks, dates, the tooltip — wears text tokens, because a mark's colour never carries text.
 * Direction is not coloured at all: a chart whose line turned red on a loss would be spending the
 * gain/loss fills on ink, which `WidgetParts.tsx` forbids.
 *
 * **The y domain is padded, and floored at a twentieth of the price either side**, so a flat
 * series is a line across the middle rather than one hugging an axis, and a one-cent wobble on a
 * five-dollar card is drawn as the wobble it is rather than stretched to the full height.
 */
import {
  useCallback,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";

import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";

import { formatDay, type ChartPoint } from "./priceAnalytics";

export interface PriceChartProps {
  /** Oldest first — `rangeSeries(...).points`. */
  points: readonly ChartPoint[];
  currency: Currency;
  /** The one sentence a screen reader gets; the drawing is aria-hidden. */
  summary: string;
  /** Plot height in px — the whole drawing, date labels included; default 220. */
  height?: number;
}

/** What the drawing is laid out at before anything has been measured — jsdom, which lays nothing
 *  out, and nothing else in practice (the measure lands in the commit, before the first paint). */
const FALLBACK_WIDTH = 480;
const DEFAULT_HEIGHT = 220;

/** Tick type, in px. The drawing's user units are CSS px, because the view box is the measured
 *  width. */
const TICK_SIZE = 11;
/** Geist Mono's advance is 600 units to the em, so a price label's width is its length times this
 *  — which is the one reason the price scale is set in the mono: its gutter can be *computed*. */
const MONO_CHAR = TICK_SIZE * 0.6;
/** Between the plot's right edge and the price labels. */
const LABEL_GAP = 8;

/** The end dot: 8px across, in a 2px ring of the surface it sits on. */
const DOT_R = 4;
const RING = 2;
/** The first point sits this far in, so its dot and ring are never clipped at the left edge. */
const INSET = DOT_R + RING;
const TOP = 8;
/** The band under the plot the dates are written in. */
const AXIS = 24;
/** Geist's advance at the tick size, a little wide of the measured ~5.6px — the dates are set in
 *  the proportional face, so their widths are estimated rather than computed, and an estimate that
 *  errs wide drops a label rather than overlapping two. */
const SANS_CHAR = TICK_SIZE * 0.55;
/** The least air between two dates. */
const DATE_GAP = 12;

/** The tooltip's box, estimated wide — a price over a long date — for choosing where it goes. */
const TIP_W = 120;
/** The tooltip's distance from the crosshair. */
const TIP_OFFSET = 10;

/** Three or four ticks, never more — enough to read a figure off, few enough to stay quiet. */
const MAX_TICKS = 4;

/**
 * The surface the dots are ringed in. `Dialog`'s panel is `bg-bg`, and this chart is drawn in the
 * price movers' dialog — a host that set it on a `bg-surface` box would want that token here.
 */
const SURFACE = "var(--color-bg)";
const ACCENT = "var(--color-accent)";

/** The padded price domain and the clean figures inside it. */
interface PriceScale {
  lo: number;
  hi: number;
  ticks: number[];
}

/** The multiples of `step` inside `[lo, hi]`, rounded to whole cents so `0.1 * 3` is `0.3`. */
function ticksIn(lo: number, hi: number, step: number): number[] {
  const first = Math.ceil(lo / step - 1e-9);
  const last = Math.floor(hi / step + 1e-9);
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(Math.round(i * step * 100) / 100);
  return out;
}

/**
 * The smallest clean step — 1, 2, 2.5 or 5 of a power of ten — that puts at most four ticks in the
 * domain. **A step must be a whole number of cents**, because the labels are written by
 * `formatPrice` at two places: a `0.025` step would print `$0.03` for a tick at `0.025`, a figure
 * sitting where it does not belong.
 */
function tickStep(lo: number, hi: number): number {
  for (let exp = -2; exp <= 12; exp++) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * 10 ** exp;
      const cents = step * 100;
      if (Math.abs(Math.round(cents) - cents) > 1e-6) continue;
      if (ticksIn(lo, hi, step).length <= MAX_TICKS) return step;
    }
  }
  return 10 ** 12;
}

function priceScale(prices: readonly number[]): PriceScale {
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const centre = (min + max) / 2;
  // Half the spread plus 12% of it either side — or a twentieth of the price, or a cent, whichever
  // is widest: a flat series is centred, and a tiny move stays tiny.
  const half = Math.max((max - min) * 0.62, max * 0.05, 0.01);
  // A price is never below nothing, so the scale is not either.
  const lo = Math.max(0, centre - half);
  const hi = centre + half;
  return { lo, hi, ticks: ticksIn(lo, hi, tickStep(lo, hi)) };
}

interface DateLabel {
  key: string;
  x: number;
  text: string;
  anchor: "start" | "middle" | "end";
}

function yearOf(day: number): number {
  return new Date(day * 1000).getUTCFullYear();
}

/**
 * The dates under the plot: the last always, the first where it fits beside it, and a middle one
 * only where it clears both.
 *
 * **A range that crosses a new year writes the year on its ends** — a year of history reads
 * `25 Sept` to `24 Sept` otherwise, which looks like a range of no length at all. Where both long
 * forms do not fit, the first keeps its year and the last drops it, which still reads as a year
 * later; where not even that fits, only the last date is drawn. The middle label is a day that
 * really is in the series, the one nearest the range's midpoint, rather than an interpolated date
 * no price was kept on.
 */
function dateLabels(points: readonly ChartPoint[], xs: readonly number[]): DateLabel[] {
  const n = points.length;
  if (n === 1) {
    return [{ key: "only", x: xs[0], text: formatDay(points[0].day, "short"), anchor: "middle" }];
  }
  const wide = (text: string) => text.length * SANS_CHAR;
  const first = points[0].day;
  const last = points[n - 1].day;
  const span = xs[n - 1] - xs[0];
  const ladder: ["short" | "long", "short" | "long"][] =
    yearOf(first) !== yearOf(last)
      ? [
          ["long", "long"],
          ["long", "short"],
        ]
      : [["short", "short"]];
  const ends = ladder
    .map(([a, b]) => [formatDay(first, a), formatDay(last, b)] as const)
    .find(([a, b]) => wide(a) + wide(b) + DATE_GAP <= span);

  if (ends === undefined) {
    return [{ key: "last", x: xs[n - 1], text: formatDay(last, "short"), anchor: "end" }];
  }
  const firstLabel: DateLabel = { key: "first", x: xs[0], text: ends[0], anchor: "start" };
  const lastLabel: DateLabel = { key: "last", x: xs[n - 1], text: ends[1], anchor: "end" };

  const midX = (xs[0] + xs[n - 1]) / 2;
  let mid = 0;
  for (let i = 1; i < n; i++) if (Math.abs(xs[i] - midX) < Math.abs(xs[mid] - midX)) mid = i;
  const midText = formatDay(points[mid].day, "short");
  const half = wide(midText) / 2;
  const clear =
    mid > 0 &&
    mid < n - 1 &&
    xs[mid] - half - DATE_GAP >= xs[0] + wide(firstLabel.text) &&
    xs[mid] + half + DATE_GAP <= xs[n - 1] - wide(lastLabel.text);
  return clear
    ? [firstLabel, { key: "mid", x: xs[mid], text: midText, anchor: "middle" }, lastLabel]
    : [firstLabel, lastLabel];
}

/** One decimal place is all a pixel can use; it keeps a long path's `d` short. */
function px(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A hairline on a pixel's centre rather than across two, which is what makes 1px *look* 1px. */
function crisp(value: number): number {
  return Math.round(value) + 0.5;
}

/**
 * The width the chart is drawn at, measured, and the ref that measures it — `HomePage`'s
 * `useCanvasWidth`, and its reasons: a callback ref runs in the commit, so the first paint is
 * already at the measured width, and its state write is not an effect body's. React 19 runs the
 * returned function as the ref's cleanup. `0` is unmeasured.
 */
function useMeasuredWidth(): [(el: HTMLDivElement | null) => (() => void) | undefined, number] {
  const [width, setWidth] = useState(0);
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (el === null) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** A dot in a ring of the surface, so it stays legible where it sits on the line. */
function Dot({ x, y }: { x: number; y: number }): ReactElement {
  return (
    <g>
      <circle cx={x} cy={y} r={DOT_R + RING} fill={SURFACE} />
      <circle cx={x} cy={y} r={DOT_R} fill={ACCENT} />
    </g>
  );
}

export function PriceChart({
  points,
  currency,
  summary,
  height = DEFAULT_HEIGHT,
}: PriceChartProps): ReactElement {
  const [measure, measured] = useMeasuredWidth();
  /** The point under the pointer, by index — `null` while the pointer is elsewhere. */
  const [hover, setHover] = useState<number | null>(null);

  // The dialog draws the empty state; a chart of nothing is nothing.
  if (points.length === 0) return <></>;

  const width = measured > 0 ? measured : FALLBACK_WIDTH;
  const n = points.length;
  const scale = priceScale(points.map((p) => p.price));
  const tickLabels = scale.ticks.map((t) => formatPrice(t, currency));
  const labelWidth = Math.max(0, ...tickLabels.map((l) => l.length)) * MONO_CHAR;

  const left = INSET;
  const right = Math.max(left + 1, width - LABEL_GAP - Math.ceil(labelWidth));
  const top = TOP;
  const bottom = height - AXIS;

  // Time is the x axis, not the index: the history is thinned to weekly beyond a month, so an
  // index scale would draw a year as if its first eleven months were five weeks.
  const first = points[0].day;
  const last = points[n - 1].day;
  const xOf = (p: ChartPoint, i: number): number =>
    n === 1
      ? (left + right) / 2
      : last > first
        ? left + ((p.day - first) / (last - first)) * (right - left)
        : left + (i / (n - 1)) * (right - left);
  const yOf = (price: number): number =>
    bottom - ((price - scale.lo) / (scale.hi - scale.lo)) * (bottom - top);

  const xs = points.map((p, i) => px(xOf(p, i)));
  const ys = points.map((p) => px(yOf(p.price)));

  const line = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x} ${ys[i]}`).join(" ");
  const area = `${line} L${xs[n - 1]} ${bottom} L${xs[0]} ${bottom} Z`;

  const dates = dateLabels(points, xs);

  const hot = hover !== null && hover < n ? hover : null;

  /**
   * The nearest point to the pointer **by x alone** — the reader aims at a date, never at a 2px
   * line. A tie goes to the later point, so the live price wins where it shares an x.
   *
   * The pointer's x is scaled from the element's drawn width into the view box's, so a box drawn
   * at a different size from the one measured still finds the right point.
   */
  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const at = (event.clientX - rect.left) * (width / rect.width);
    let best = 0;
    for (let i = 0; i < n; i++) if (Math.abs(xs[i] - at) <= Math.abs(xs[best] - at)) best = i;
    setHover(best);
  }

  /**
   * Where the tooltip goes: beside the crosshair on the side with the room, and against the top or
   * the bottom of the plot — whichever leaves more air between it and the line **across the
   * tooltip's own width**. Pinning it to the half the point is not in covered a spike just beside
   * the point, which is the one thing a reader hovering there is looking at.
   */
  function tipPlacement(i: number) {
    const flip = xs[i] > width / 2;
    const from = flip ? xs[i] - TIP_OFFSET - TIP_W : xs[i] + TIP_OFFSET;
    const to = from + TIP_W;
    let high = Number.POSITIVE_INFINITY;
    let low = Number.NEGATIVE_INFINITY;
    // Every segment that reaches into the span, so a sparse weekly stretch with no vertex under
    // the tooltip still counts the line crossing it.
    for (let k = 0; k < n; k++) {
      const a = xs[Math.max(0, k - 1)];
      if (xs[k] >= from && a <= to) {
        high = Math.min(high, ys[k], ys[Math.max(0, k - 1)]);
        low = Math.max(low, ys[k], ys[Math.max(0, k - 1)]);
      }
    }
    const above = high - top;
    const below = bottom - low;
    return {
      ...(flip ? { right: width - xs[i] + TIP_OFFSET } : { left: xs[i] + TIP_OFFSET }),
      ...(below > above ? { bottom: AXIS + 4 } : { top }),
    };
  }

  const tip = hot === null ? null : { point: points[hot], style: tipPlacement(hot) };

  return (
    <div ref={measure} className="relative w-full min-w-0">
      <p className="sr-only">{summary}</p>
      <svg
        aria-hidden="true"
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        // `pan-y`: on a phone a sideways drag scrubs the line and an upright one still scrolls
        // the dialog. A press answers at once, so a tap reads a point without a drag.
        className="block touch-pan-y select-none"
        onPointerDown={onPointerMove}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
      >
        <g data-axis="grid" stroke="var(--color-border)" strokeWidth={1} shapeRendering="crispEdges">
          {scale.ticks.map((t) => (
            <line key={t} x1={0} x2={right} y1={crisp(yOf(t))} y2={crisp(yOf(t))} />
          ))}
          <line x1={0} x2={right} y1={crisp(bottom)} y2={crisp(bottom)} />
        </g>

        {n > 1 && (
          <>
            <path data-mark="area" d={area} fill={ACCENT} fillOpacity={0.1} />
            <path
              data-mark="line"
              d={line}
              fill="none"
              stroke={ACCENT}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </>
        )}

        {hot !== null && (
          <line
            data-mark="crosshair"
            x1={crisp(xs[hot])}
            x2={crisp(xs[hot])}
            y1={top}
            y2={bottom}
            stroke="var(--color-dim)"
            strokeOpacity={0.5}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        )}

        <Dot x={xs[n - 1]} y={ys[n - 1]} />
        {hot !== null && hot !== n - 1 && <Dot x={xs[hot]} y={ys[hot]} />}

        <g
          data-axis="price"
          className="font-mono tabular-nums text-dim"
          fill="currentColor"
          fontSize={TICK_SIZE}
        >
          {scale.ticks.map((t, i) => (
            <text key={t} x={right + LABEL_GAP} y={yOf(t)} dominantBaseline="middle">
              {tickLabels[i]}
            </text>
          ))}
        </g>

        <g data-axis="date" className="text-dim" fill="currentColor" fontSize={TICK_SIZE}>
          {dates.map((d) => (
            <text key={d.key} x={d.x} y={height - 7} textAnchor={d.anchor}>
              {d.text}
            </text>
          ))}
        </g>
      </svg>

      {tip !== null && (
        <div
          aria-hidden="true"
          data-chart-tip=""
          className="pointer-events-none absolute select-none whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 shadow-lg"
          style={tip.style}
        >
          <span className="block font-mono text-sm tabular-nums text-text">
            {formatPrice(tip.point.price, currency)}
          </span>
          <span className="block text-xs text-dim">
            {tip.point.live ? "Today" : formatDay(tip.point.day, "long")}
          </span>
        </div>
      )}
    </div>
  );
}
