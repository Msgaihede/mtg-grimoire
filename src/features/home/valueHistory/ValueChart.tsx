/**
 * The collection's value over a range, drawn: one line lit in its colour with a wash under it, the
 * others as faint context, a scale on the right, the dates beneath, a diamond on the baseline for
 * every step in which the reader added or removed cards — and, over the plot, a `role="slider"`
 * that walks the days by pointer and by key.
 *
 * **`PriceChart.tsx`'s drawing, grown to many lines, and its rules kept**: hand-drawn SVG because
 * every picture here is decoration over numbers that are already text; the drawing is
 * `aria-hidden` and one `sr-only` sentence is what a screen reader gets for it; **time, not index,
 * on x**, because the history is thinned to one point a week beyond a month and an index scale
 * would draw a year as if its first eleven months were five weeks; hairlines on a pixel's centre;
 * the end dot in a ring of the surface it sits on; the scale on the right, where the eye ends a
 * line at *now*.
 *
 * **One line is lit and the rest are context** — the design's answer to seven lines on one small
 * plot. The followed line is 2px in its colour with a 10% wash down to the baseline (to zero, on
 * Change, so the wash says which side of the start the line is on); every other line is 1.5px at
 * 30%. On hover every line gets a dot on the crosshair, the context ones smaller and fainter.
 *
 * **The slider is the readout's keyboard**: ←/→ a point, PageUp/PageDown a week of points,
 * Home/End the ends, Escape lets go. A pointer that leaves lets go too — unless the keys were
 * walking it, so a reader nudging the mouse aside does not lose the day they arrowed to. Focus by
 * keyboard lands on today. The readout itself is `ValueReadout.tsx`'s, mounted at the app root.
 *
 * **A still or editing body passes no `onHover`**, and then there is no slider at all — nothing to
 * focus, nothing to press — while the drawing stays whole.
 */
import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";

import { FOCUS } from "@/lib/focus";
import type { Currency } from "@/lib/marketplace";
import { cn } from "@/lib/utils";

import {
  dateTicks,
  markerDays,
  scaleFor,
  shownValues,
  tickLabel,
  type HistoryView,
  type Readout,
  type ValueMeasure,
} from "./model";
import { useReadoutPanel } from "./ValueReadout";

export interface ValueChartProps {
  view: HistoryView;
  measure: ValueMeasure;
  currency: Currency;
  /** The followed line's key — `view.series`' first when it names none of them. */
  litKey: string;
  /** The box the chart is drawn in — the layout's chart rect, in body pixels. */
  width: number;
  height: number;
  /** The point under the pointer or the keys, by index into `view.days`; `null` for none. */
  hover: number | null;
  /** Move or drop the hovered point. **Absent in a still or editing body**, which draws no slider. */
  onHover?: (index: number | null) => void;
  /** Draw the collection-change diamonds. */
  markers: boolean;
  /** The readout to open beside the crosshair, or `null` for none — a tile whose figure line is
   *  the readout passes `null` while hovered. */
  readout: Readout | null;
  /** The slider's name. */
  label: string;
  /** The hovered (or last) day, spoken — the slider's `aria-valuetext`. */
  valueText: string;
  /** The one sentence a screen reader gets for the drawing. */
  summary: string;
}

/** Tick type, in px — `PriceChart`'s. */
const TICK_SIZE = 11;
/** Geist Mono's advance: 600 units to the em. The scale is set in the mono so its gutter can be
 *  computed rather than measured. */
const MONO_CHAR = TICK_SIZE * 0.6;
/** Between the plot's right edge and the scale's labels, and after them. */
const LABEL_GAP = 8;
const LABEL_TAIL = 4;
/** No scale on a plot narrower than this — a 2×2 tile, whose figure line already says the value. */
const SCALE_MIN_WIDTH = 260;
/** No dates under a plot shorter than this. */
const DATES_MIN_HEIGHT = 96;

/** The end dot: 8px across, in a 2px ring of the surface. A context line's hover dot: 6px in 1.5. */
const DOT_R = 4;
const RING = 2;
const SMALL_R = 3;
const SMALL_RING = 1.5;
/** The first point sits this far in, so its dot and ring are never clipped at the left edge. */
const INSET = DOT_R + RING;
const TOP = 8;
/** The band under the plot the dates are written in, and the foot left when there are none. */
const AXIS = 22;
const FOOT = 4;

/** Half the diagonal of a marker diamond. */
const MARK_R = 4;

/** Half the width of the band the readout is anchored to: the air between crosshair and panel. */
const ANCHOR_HALF = 6;

/** A week of points, for PageUp / PageDown. */
const PAGE = 7;

/** The surface the dots are ringed in — the page's, since a widget card draws no fill of its own. */
const SURFACE = "var(--color-bg)";
/** The zero line on Change: the start, stated a shade louder than the other rules. */
const ZERO_RULE = "color-mix(in oklab, var(--color-dim) 55%, transparent)";

/** One decimal place is all a pixel can use; it keeps a long path's `d` short. */
function px(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A hairline on a pixel's centre rather than across two, which is what makes 1px *look* 1px. */
function crisp(value: number): number {
  return Math.round(value) + 0.5;
}

function pathOf(xs: readonly number[], ys: readonly number[]): string {
  return xs.map((x, i) => `${i === 0 ? "M" : "L"}${x} ${ys[i]}`).join(" ");
}

/**
 * The width the chart is drawn at, measured, and the ref that measures it — `PriceChart`'s
 * `useMeasuredWidth`, copied because it is not exported, and for its reasons: a callback ref runs
 * in the commit, so the first paint is already at the measured width, and its state write is not
 * an effect body's. `0` is unmeasured. **`clientWidth` answers in the grid's local pixels** under
 * the home page's CSS `zoom`, which are the pixels this drawing's view box is in.
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

/** A dot in a ring of the surface, so it stays legible where it sits on its line. */
function Dot({
  x,
  y,
  fill,
  r = DOT_R,
  ring = RING,
  opacity,
}: {
  x: number;
  y: number;
  fill: string;
  r?: number;
  ring?: number;
  opacity?: number;
}): ReactElement {
  return (
    <g opacity={opacity}>
      <circle cx={x} cy={y} r={r + ring} fill={SURFACE} />
      <circle cx={x} cy={y} r={r} fill={fill} />
    </g>
  );
}

export function ValueChart({
  view,
  measure,
  currency,
  litKey,
  width,
  height,
  hover,
  onHover,
  markers,
  readout,
  label,
  valueText,
  summary,
}: ValueChartProps): ReactElement {
  const [measureRef, measured] = useMeasuredWidth();
  const anchor = useRef<HTMLDivElement>(null);
  /** The keys are walking the line: a pointer leaving does not let go. */
  const keyed = useRef(false);

  const n = view.days.length;
  const hot = hover !== null && hover < n ? hover : null;

  const w = measured > 0 ? measured : width;
  const h = height;

  const shown = view.series.map((s) => shownValues(s, measure));
  const scale = scaleFor(shown.flat(), measure);
  const tickLabels = scale.ticks.map((t) => tickLabel(t, measure, currency));
  const withScale = w >= SCALE_MIN_WIDTH;
  const withDates = h >= DATES_MIN_HEIGHT;
  const gutter = withScale
    ? Math.ceil(Math.max(0, ...tickLabels.map((l) => l.length)) * MONO_CHAR) + LABEL_GAP + LABEL_TAIL
    : INSET;

  const left = INSET;
  const right = Math.max(left + 1, w - gutter);
  const top = TOP;
  const bottom = Math.max(top + 1, h - (withDates ? AXIS : FOOT));

  const first = view.days[0] ?? 0;
  const last = view.days[n - 1] ?? 0;
  const xOfDay = (day: number): number =>
    last > first ? left + ((day - first) / (last - first)) * (right - left) : (left + right) / 2;
  const xs = view.days.map((day, i) =>
    px(n === 1 ? (left + right) / 2 : last > first ? xOfDay(day) : left + (i / (n - 1)) * (right - left)),
  );
  const span = scale.hi - scale.lo || 1;
  const yOf = (value: number): number => bottom - ((value - scale.lo) / span) * (bottom - top);

  const litIndex = Math.max(
    0,
    view.series.findIndex((s) => s.key === litKey),
  );
  const lit = view.series[litIndex];
  const litYs = lit === undefined ? [] : shown[litIndex].map((v) => px(yOf(v)));
  const litLine = pathOf(xs, litYs);
  // The wash runs down to the start on Change, so it says which side of the start the line is on.
  const floor = px(measure === "change" ? yOf(0) : bottom);
  const wash = n > 1 ? `${litLine} L${xs[n - 1]} ${floor} L${xs[0]} ${floor} Z` : "";

  const marks = markers ? markerDays(view).map((day) => px(xOfDay(day))) : [];
  const dates = withDates ? dateTicks(view, xs) : [];

  // Away from the half the pointer is in, so the line under it stays visible.
  const side = hot !== null && xs[hot] > (left + right) / 2 ? "left" : "right";
  useReadoutPanel(anchor, hot === null ? null : readout, side);

  /**
   * The nearest point to the pointer **by x alone** — the reader aims at a date, never at a 2px
   * line — with a tie going to the later point. The pointer's x is scaled from the element's drawn
   * width into the plot's own, which is what makes it land under the home grid's CSS `zoom`: the
   * rect is in viewport pixels and zoomed, the plot is in local ones.
   */
  function indexAt(event: ReactPointerEvent<HTMLDivElement>): number | null {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || n === 0) return null;
    const at = (event.clientX - rect.left) * (right / rect.width);
    let best = 0;
    for (let i = 0; i < n; i++) if (Math.abs(xs[i] - at) <= Math.abs(xs[best] - at)) best = i;
    return best;
  }

  function onPointer(event: ReactPointerEvent<HTMLDivElement>) {
    keyed.current = false;
    const at = indexAt(event);
    if (at !== null && at !== hot) onHover?.(at);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const from = hot ?? n - 1;
    const to: Record<string, number> = {
      ArrowLeft: from - 1,
      ArrowRight: from + 1,
      ArrowDown: from - 1,
      ArrowUp: from + 1,
      Home: 0,
      End: n - 1,
      PageUp: from - PAGE,
      PageDown: from + PAGE,
    };
    const next = to[event.key];
    if (next !== undefined) {
      event.preventDefault();
      keyed.current = true;
      onHover?.(Math.max(0, Math.min(n - 1, next)));
    } else if (event.key === "Escape" && hot !== null) {
      // Consumed only when there is a readout to put down, so a press with nothing to undo falls
      // through to whatever layer is underneath.
      event.preventDefault();
      onHover?.(null);
    }
  }

  return (
    <div ref={measureRef} className="relative h-full w-full min-w-0">
      <p className="sr-only">{summary}</p>
      <svg
        aria-hidden="true"
        width="100%"
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="block overflow-visible select-none"
      >
        <g data-axis="grid" strokeWidth={1} shapeRendering="crispEdges">
          {scale.ticks.map((t) => (
            <line
              key={t}
              x1={0}
              x2={right}
              y1={crisp(yOf(t))}
              y2={crisp(yOf(t))}
              stroke={measure === "change" && t === 0 ? ZERO_RULE : "var(--color-border)"}
            />
          ))}
          <line x1={0} x2={right} y1={crisp(bottom)} y2={crisp(bottom)} stroke="var(--color-border)" />
        </g>

        {n > 1 &&
          view.series.map((s, i) =>
            i === litIndex ? null : (
              <path
                key={s.key}
                data-mark="context"
                data-key={s.key}
                d={pathOf(
                  xs,
                  shown[i].map((v) => px(yOf(v))),
                )}
                fill="none"
                stroke={s.fill}
                strokeOpacity={0.3}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ),
          )}

        {n > 1 && lit !== undefined && (
          <>
            <path data-mark="area" d={wash} fill={lit.fill} fillOpacity={0.1} />
            <path
              data-mark="line"
              data-key={lit.key}
              d={litLine}
              fill="none"
              stroke={lit.fill}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </>
        )}

        {marks.map((x, i) => (
          <path
            key={`${x}:${i}`}
            data-mark="change"
            d={`M${x} ${bottom - MARK_R} L${x + MARK_R} ${bottom} L${x} ${bottom + MARK_R} L${x - MARK_R} ${bottom} Z`}
            fill={SURFACE}
            stroke="var(--color-accent)"
            strokeWidth={1.5}
            strokeLinejoin="miter"
          />
        ))}

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

        {lit !== undefined && n > 0 && <Dot x={xs[n - 1]} y={litYs[n - 1]} fill={lit.fill} />}

        {hot !== null &&
          view.series.map((s, i) =>
            i === litIndex ? null : (
              <Dot
                key={s.key}
                x={xs[hot]}
                y={px(yOf(shown[i][hot]))}
                fill={s.fill}
                r={SMALL_R}
                ring={SMALL_RING}
                opacity={0.75}
              />
            ),
          )}
        {hot !== null && hot !== n - 1 && lit !== undefined && (
          <Dot x={xs[hot]} y={litYs[hot]} fill={lit.fill} />
        )}

        {withScale && (
          <g
            data-axis="value"
            className="font-mono text-dim tabular-nums"
            fill="currentColor"
            fontSize={TICK_SIZE}
          >
            {scale.ticks.map((t, i) => (
              <text key={t} x={right + LABEL_GAP} y={yOf(t)} dominantBaseline="middle">
                {tickLabels[i]}
              </text>
            ))}
          </g>
        )}

        <g data-axis="date" className="text-dim" fill="currentColor" fontSize={TICK_SIZE}>
          {dates.map((d) => (
            <text key={`${d.anchor}:${d.x}`} x={d.x} y={h - 7} textAnchor={d.anchor}>
              {d.text}
            </text>
          ))}
        </g>
      </svg>

      {/* What the readout is placed against: a band centred on the crosshair, as tall as the
          plot. Only while a day is hovered — it leaving the document is itself a close. */}
      {hot !== null && (
        <div
          ref={anchor}
          aria-hidden="true"
          data-readout-anchor=""
          className="pointer-events-none absolute"
          style={{
            left: xs[hot] - ANCHOR_HALF,
            top,
            width: 2 * ANCHOR_HALF,
            height: bottom - top,
          }}
        />
      )}

      {onHover !== undefined && n > 0 && (
        <div
          role="slider"
          tabIndex={0}
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={n - 1}
          aria-valuenow={hot ?? n - 1}
          aria-valuetext={valueText}
          // `pan-y`: on a phone a sideways drag scrubs the line and an upright one still scrolls
          // the page. A press answers at once, so a tap reads a point without a drag.
          className={cn("absolute top-0 left-0 cursor-crosshair touch-pan-y rounded-sm", FOCUS)}
          style={{ width: right, height: bottom }}
          onPointerDown={onPointer}
          onPointerMove={onPointer}
          onPointerLeave={() => {
            if (!keyed.current) onHover(null);
          }}
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            // A Tab onto the chart reads today at once; a press is about to say which day itself.
            if (hot === null && event.currentTarget.matches(":focus-visible")) {
              keyed.current = true;
              onHover(n - 1);
            }
          }}
          onBlur={() => {
            keyed.current = false;
            onHover(null);
          }}
        />
      )}
    </div>
  );
}
