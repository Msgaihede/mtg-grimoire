import type { ScannerVerdict } from "../types";
import { FIGURES, Panel, Row } from "./Panel";

/** One part of the frame's cost, in the order it is spent. */
interface Part {
  name: string;
  ms: number;
}

/**
 * The six parts a round trip breaks into.
 *
 * **`transport` is a residue, not a measurement.** The five before it are the crate's own
 * timings; what is left of the round trip after them is everything this side paid for —
 * the JPEG on the way out, the JSON on the way back, the IPC hop, and whatever the event loop
 * was doing meanwhile. Floored at zero, because the two clocks are not the same clock and a
 * round trip that reads a hair short of the work it contains is a rounding artefact rather
 * than negative time.
 */
export function budgetParts(verdict: ScannerVerdict | null, roundTripMs: number | null): Part[] {
  const t = verdict?.timings ?? null;
  const parts: Part[] = [
    { name: "decode", ms: verdict?.decode_ms ?? 0 },
    { name: "resize", ms: t?.resize_ms ?? 0 },
    { name: "mask", ms: t?.mask_ms ?? 0 },
    { name: "contour", ms: t?.contour_ms ?? 0 },
    { name: "rectify", ms: t?.rectify_ms ?? 0 },
  ];
  const spent = parts.reduce((sum, p) => sum + p.ms, 0);
  parts.push({ name: "transport", ms: Math.max(0, (roundTripMs ?? 0) - spent) });
  return parts;
}

/** Where a frame's time went — the stacked bar, then the same six figures as numbers. */
export function BudgetPanel({
  verdict,
  roundTripMs,
}: {
  verdict: ScannerVerdict | null;
  roundTripMs: number | null;
}) {
  const parts = budgetParts(verdict, roundTripMs);
  const total = parts.reduce((sum, p) => sum + p.ms, 0);

  return (
    <Panel id="budget" title="Frame budget">
      {/* `aria-hidden`: the same six figures are spelled out immediately below, and a bar
          divided into six unlabelled slivers is one announcement per sliver saying nothing. */}
      <div aria-hidden="true" className="flex h-2 overflow-hidden rounded bg-bg">
        {parts.map((p, i) => (
          <i
            key={p.name}
            className={i % 2 === 0 ? "bg-accent" : "bg-dim"}
            style={{ width: total === 0 ? "0%" : `${(p.ms / total) * 100}%` }}
          />
        ))}
      </div>

      <dl className={FIGURES}>
        {parts.map((p) => (
          <Row key={p.name} label={p.name} value={`${p.ms.toFixed(1)} ms`} />
        ))}
        {/* `toFixed(1)` like the six rows above it, and not decoration: this is a
            `performance.now()` delta straight off the clock, so a bare interpolation drew
            `288.39999999999998 ms` in the shipped window. */}
        <Row
          label="round trip"
          value={roundTripMs === null ? "—" : `${roundTripMs.toFixed(1)} ms`}
        />
      </dl>
    </Panel>
  );
}
