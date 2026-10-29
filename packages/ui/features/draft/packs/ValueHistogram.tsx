/**
 * The simulated distribution of a product's value, drawn: one bar per value band, the opened pack
 * marked where it fell, and — once the reader types what they paid — the bands that beat it in
 * full accent and the rest washed back.
 *
 * **Hand-drawn SVG, `PriceChart`'s reason**: nothing in this app is a chart library. Single
 * series, so no legend — the heading above names it. Money is the accent, so the bars are; every
 * word and figure wears a text token (dataviz: text never wears the data colour). Bars are 24px at
 * most with a 2px surface gap and a 4px rounded top on a square baseline. A bar's hit target is
 * its whole slot, full height, and its tooltip says the band and the count; the same figures are
 * in the table under it, so the tooltip never gates a number.
 *
 * **The x scale is the bins' index, not money.** `histogram` folds the long right tail into the
 * last bin, so the last bar is wider in money than the others and the right-hand label says
 * "and up". A value is placed inside its bin linearly.
 */
import { useCallback, useState, type JSX, type PointerEvent } from "react";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import type { HistogramBin } from "../booster/value";

const HEIGHT = 156;
const FALLBACK_WIDTH = 320;
const TOP = 22;
const AXIS = 22;
const BAR_MAX = 24;
const GAP = 2;
const RADIUS = 4;
const TICK = 11;
const ACCENT = "var(--color-accent)";

/** The width the drawing is laid out at, measured in the commit (`PriceChart`'s way). */
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

/** A column with a rounded top and a square foot, `h` tall, from `x` at the baseline `y`. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h);
  return (
    `M${x} ${y}V${y - h + r}Q${x} ${y - h} ${x + r} ${y - h}` +
    `H${x + w - r}Q${x + w} ${y - h} ${x + w} ${y - h + r}V${y}Z`
  );
}

/** Where `value` falls on the index scale: bin `i` spans `[i, i + 1)`. */
function position(bins: readonly HistogramBin[], value: number): number {
  const n = bins.length;
  if (value <= bins[0].from) return 0;
  for (let i = 0; i < n; i++) {
    const b = bins[i];
    if (value < b.to || i === n - 1) {
      const span = b.to - b.from;
      return i + (span > 0 ? Math.min(1, (value - b.from) / span) : 0.5);
    }
  }
  return n;
}

export function ValueHistogram({
  bins,
  marked,
  markedLabel,
  paid,
  currency,
  unit,
  summary,
}: {
  bins: readonly HistogramBin[];
  /** The opened value, drawn as a rule with `markedLabel` over it; `null` draws none. */
  marked: number | null;
  markedLabel: string;
  /** What the reader paid: bars at or under it are washed back. */
  paid: number | null;
  currency: Currency;
  /** What a simulated value is, plural — "packs", "boxes" — for the tooltip and the table. */
  unit: string;
  /** The one sentence a screen reader gets; the drawing is `aria-hidden`. */
  summary: string;
}): JSX.Element | null {
  const [measure, measured] = useMeasuredWidth();
  const [hover, setHover] = useState<number | null>(null);
  if (bins.length === 0) return null;

  const width = measured > 0 ? measured : FALLBACK_WIDTH;
  const n = bins.length;
  const slot = width / n;
  const barW = Math.max(1, Math.min(BAR_MAX, slot - GAP));
  const bottom = HEIGHT - AXIS;
  const tallest = Math.max(1, ...bins.map((b) => b.count));
  const xOf = (p: number) => (p / n) * width;
  const hot = hover !== null && hover < n ? bins[hover] : null;

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const at = Math.floor(((event.clientX - rect.left) / rect.width) * n);
    setHover(Math.max(0, Math.min(n - 1, at)));
  };

  const markX = marked === null ? null : Math.round(xOf(position(bins, marked))) + 0.5;
  const left = formatPrice(bins[0].from, currency);
  const right = `${formatPrice(bins[n - 1].from, currency)}+`;

  return (
    <figure className="m-0 flex flex-col gap-2">
      <div ref={measure} className="relative w-full min-w-0">
        <p className="sr-only">{summary}</p>
        <svg
          aria-hidden="true"
          width="100%"
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="block select-none"
          onPointerMove={onPointerMove}
          onPointerDown={onPointerMove}
          onPointerLeave={() => setHover(null)}
        >
          {bins.map((b, i) => {
            const h = b.count === 0 ? 0 : Math.max(2, (b.count / tallest) * (bottom - TOP));
            const x = i * slot + (slot - barW) / 2;
            const beaten = paid === null || b.from >= paid;
            return (
              h > 0 && (
                <path
                  key={i}
                  data-mark="bar"
                  d={barPath(x, bottom, barW, h)}
                  fill={ACCENT}
                  fillOpacity={(beaten ? 1 : 0.35) * (hover === i ? 0.8 : 1)}
                />
              )
            );
          })}
          <line
            x1={0}
            x2={width}
            y1={bottom + 0.5}
            y2={bottom + 0.5}
            stroke="var(--color-border)"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          {markX !== null && (
            <g data-mark="opened">
              <line
                x1={markX}
                x2={markX}
                y1={TOP - 4}
                y2={bottom}
                stroke="var(--color-text)"
                strokeWidth={2}
              />
              <text
                x={Math.min(Math.max(markX, 4), width - 4)}
                y={TOP - 8}
                textAnchor={markX < width * 0.2 ? "start" : markX > width * 0.8 ? "end" : "middle"}
                className="text-text"
                fill="currentColor"
                fontSize={TICK}
              >
                {markedLabel}
              </text>
            </g>
          )}
          <g className="font-mono tabular-nums text-dim" fill="currentColor" fontSize={TICK}>
            <text x={0} y={HEIGHT - 6} textAnchor="start">
              {left}
            </text>
            <text x={width} y={HEIGHT - 6} textAnchor="end">
              {right}
            </text>
          </g>
        </svg>
        {hot !== null && hover !== null && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 select-none whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 shadow-lg"
            style={
              hover < n / 2
                ? { left: Math.min(width - 8, (hover + 1) * slot + 4) }
                : { right: Math.min(width - 8, (n - hover) * slot + 4) }
            }
          >
            <span className="block font-mono text-sm tabular-nums text-text">
              {hot.count.toLocaleString("en-US")} {unit}
            </span>
            <span className="block font-mono text-xs tabular-nums text-dim">
              {formatPrice(hot.from, currency)}–{formatPrice(hot.to, currency)}
            </span>
          </div>
        )}
      </div>
      <details className="text-xs text-dim">
        <summary className="cursor-pointer select-none">Distribution as a table</summary>
        <table className="mt-2 w-full border-collapse font-mono tabular-nums">
          <thead>
            <tr className="text-left">
              <th className="py-0.5 font-normal">Value</th>
              <th className="py-0.5 text-right font-normal capitalize">{unit}</th>
            </tr>
          </thead>
          <tbody>
            {bins.map((b, i) => (
              <tr key={i} className="text-text">
                <td className="py-0.5">
                  {formatPrice(b.from, currency)}–{formatPrice(b.to, currency)}
                </td>
                <td className="py-0.5 text-right">{b.count.toLocaleString("en-US")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
