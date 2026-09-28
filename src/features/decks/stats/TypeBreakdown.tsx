/**
 * The two panels at the foot of Card distribution's chart half (2026-09-28): **Creature**, the
 * deck's creature types as ranked rows, and **Land**, its manabase as a pie of basic land types.
 *
 * **A pie again, and this reverses the 2026-09-10 note that the two pies are gone** — which was
 * right about what it removed and is not contradicted by what this adds. Those pies answered
 * *what colours is this deck* and *how many lands*, and the colour curves and the `by Types` bars
 * answer both better. This one answers a question no bar in the band asks: *which basic types do
 * my lands carry*, which is what a fetch land, a Nature's Lore or a Blood Moon reads. A partition
 * of one small whole into a handful of named parts is what a pie is for, and the legend beside it
 * is the accessible story — a real list with every count and share in it — so the circle is
 * decoration over numbers that are already text, like every drawing in this band.
 *
 * **Filled with the mana fills.** `MANA_FILL`'s `--color-mana-*` are the app's only palette for a
 * Magic colour (`mana.ts` says so, and why); a dual's slice is **striped** in each of its colours
 * rather than blended into a colour no land is, and a land with no basic type is colourless.
 *
 * Both panels count over the same active copies the distribution bars count, and which of them
 * are lands and which creatures is `typeBreakdown`'s doc — the short version is `isLand` (so the
 * heading agrees with the ledger's Lands) and `isCreature` less the lands.
 */
import { useId, useMemo, type JSX } from "react";
import { plural } from "@/lib/counts";
import type { DeckCard } from "@/lib/ipc";
import { MANA_FILL, type ManaKey } from "@/lib/mana";
import { percent, Track } from "./StatsCard";
import { typeBreakdown, type LandSlice, type SubtypeRow } from "./typeBreakdownCounts";

/**
 * How many creature types are drawn before the rest are summarised in a line.
 *
 * A Commander deck's thirty creatures carry twenty-odd types, most of them once, and a list that
 * long would stand the Creature panel a screen taller than the Land panel beside it. Twelve is
 * `DISTRIBUTION_BAR_LIMIT`, the same count the bars above fold at. The rest are **not** folded
 * into an `Other` row the way the bars fold, because subtypes overlap: a summed tail would be a
 * count of nothing in particular.
 */
export const CREATURE_ROW_LIMIT = 12;

/** A panel's heading — the rung under the card's own `h3`, as the odds table's is. */
const PANEL_HEADING = "text-sm font-medium text-text";

/** The count set beside a heading word. */
const HEADING_COUNT = "ml-1 font-mono text-xs tabular-nums text-dim";

/** The small dim line under a panel. */
const NOTE = "text-[0.6875rem] text-dim";

/** The pie's drawn size, in px. */
const PIE_SIZE = 112;

/** The width of one stripe in a multi-type slice's pattern, in the pie's own units (px). */
const STRIPE = 4;

export function TypeBreakdown({ cards }: { cards: readonly DeckCard[] }): JSX.Element {
  const breakdown = useMemo(() => typeBreakdown(cards), [cards]);
  return (
    <div
      className="grid gap-4"
      // A column template is an inline style, never an arbitrary value (src/CLAUDE.md). Side by
      // side where the card allows two 15rem panels, stacked where it does not; `min(100%, …)`
      // is what lets one panel shrink under 15rem in a card narrower than that.
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 15rem), 1fr))" }}
    >
      <CreaturePanel count={breakdown.creatures} rows={breakdown.creatureTypes} />
      <LandPanel
        count={breakdown.lands}
        slices={breakdown.landSlices}
        mdfcLands={breakdown.mdfcLands}
      />
    </div>
  );
}

function CreaturePanel({
  count,
  rows,
}: {
  count: number;
  rows: readonly SubtypeRow[];
}): JSX.Element {
  const shown = rows.slice(0, CREATURE_ROW_LIMIT);
  const hidden = rows.length - shown.length;
  // Scaled to the largest row, so the commonest type fills its track — the rows are a ranking,
  // and a ranking read against the creature count would draw every bar short.
  const max = rows[0]?.count ?? 1;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className={PANEL_HEADING}>
        Creature <span className={HEADING_COUNT}>{count}</span>
      </h4>
      {count === 0 ? (
        <p className="text-xs text-dim">No creatures in this list.</p>
      ) : (
        <>
          <ul aria-label="Creature types" className="flex flex-col gap-1">
            {shown.map((row) => (
              <li
                key={row.name}
                className="grid items-center gap-2"
                style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 3fr) 2rem" }}
              >
                <span className="sr-only">{`${row.name}: ${plural(row.count, "creature")}`}</span>
                <span aria-hidden="true" className="truncate text-xs text-text">
                  {row.name}
                </span>
                <Track share={row.count / max} fill="var(--color-accent)" height={6} />
                <span
                  aria-hidden="true"
                  className="text-right font-mono text-xs tabular-nums text-text"
                >
                  {row.count}
                </span>
              </li>
            ))}
          </ul>
          {hidden > 0 ? (
            <p className={NOTE}>{`And ${plural(hidden, "more type")}.`}</p>
          ) : null}
          <p className={NOTE}>
            {rows.length > 0
              ? "A creature with two types counts under both."
              : "None of these creatures prints a creature type."}
          </p>
        </>
      )}
    </div>
  );
}

function LandPanel({
  count,
  slices,
  mdfcLands,
}: {
  count: number;
  slices: readonly LandSlice[];
  mdfcLands: number;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className={PANEL_HEADING}>
        Land <span className={HEADING_COUNT}>{count}</span>
      </h4>
      {count === 0 ? (
        <p className="text-xs text-dim">No lands in this list.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Pie slices={slices} total={count} />
          {/* `min-w-44` is what wraps the legend under the pie rather than beside it when the
              panel cannot hold both: beside a 112px pie in the three-column band's ~250px panel
              the names had ~60px and truncated to "No ba…" (shipped window, 2026-09-28). */}
          <ul aria-label="Land types" className="flex min-w-44 flex-1 flex-col gap-1">
            {slices.map((slice) => (
              <li
                key={slice.key}
                className="grid items-center gap-2"
                style={{ gridTemplateColumns: "10px minmax(0, 1fr) auto 2.25rem" }}
              >
                <span className="sr-only">
                  {`${slice.label}: ${plural(slice.count, "land")}, ${percent(slice.count / count)}`}
                </span>
                <span
                  aria-hidden="true"
                  className="size-2.5 rounded-sm"
                  style={{ background: swatch(slice.types) }}
                />
                <span aria-hidden="true" className="truncate text-xs text-text">
                  {slice.label}
                </span>
                <span
                  aria-hidden="true"
                  className="text-right font-mono text-xs tabular-nums text-text"
                >
                  {slice.count}
                </span>
                <span
                  aria-hidden="true"
                  className="text-right font-mono text-xs tabular-nums text-dim"
                >
                  {percent(slice.count / count)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {mdfcLands > 0 ? (
        // The ledger's `+2 MDFC`, said in words: these can be played as a land and are not in
        // the count above, for `isMdfcLand`'s reason.
        <p className={NOTE}>
          {`Plus ${plural(mdfcLands, "modal double-faced card")} with a land back, counted as ${mdfcLands === 1 ? "a spell" : "spells"}.`}
        </p>
      ) : null}
    </div>
  );
}

/** The mana fills a slice is drawn in — its types', or colourless for none. */
function fills(types: readonly ManaKey[]): string[] {
  return types.length === 0 ? [MANA_FILL.C] : types.map((key) => MANA_FILL[key]);
}

/** A legend swatch: the fill, or the slice's stripes as a CSS gradient at the same angle. */
function swatch(types: readonly ManaKey[]): string {
  const colours = fills(types);
  if (colours.length === 1) return colours[0];
  const stops = colours.map((colour, i) => `${colour} ${i * 3}px ${(i + 1) * 3}px`);
  return `repeating-linear-gradient(45deg, ${stops.join(", ")})`;
}

/**
 * The pie itself — `aria-hidden`, since the legend beside it is the whole of what it says.
 *
 * Slices start at twelve o'clock and run clockwise in the legend's order, so the eye can walk the
 * two together. A slice with two or more types is filled with an SVG `<pattern>` of its fills in
 * stripes; the pattern ids carry this instance's `useId`, because two decks' pies on one page (or
 * one pie drawn twice across a layout switch) sharing an id would fill one from the other's
 * definition.
 */
function Pie({ slices, total }: { slices: readonly LandSlice[]; total: number }): JSX.Element {
  // `useId` answers with characters (`:`, `«`) that are legal in an id and not in a bare
  // `url(#…)` reference, so they are stripped rather than escaped.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const r = PIE_SIZE / 2;
  const fillOf = (slice: LandSlice) =>
    slice.types.length > 1 ? `url(#land-${uid}-${slice.key})` : fills(slice.types)[0];

  const paths = wedges(slices, total);

  return (
    <svg
      aria-hidden="true"
      width={PIE_SIZE}
      height={PIE_SIZE}
      viewBox={`0 0 ${PIE_SIZE} ${PIE_SIZE}`}
      className="shrink-0"
    >
      <defs>
        {slices
          .filter((slice) => slice.types.length > 1)
          .map((slice) => {
            const colours = fills(slice.types);
            const width = STRIPE * colours.length;
            return (
              <pattern
                key={slice.key}
                id={`land-${uid}-${slice.key}`}
                patternUnits="userSpaceOnUse"
                width={width}
                height={width}
                patternTransform="rotate(45)"
              >
                {colours.map((colour, i) => (
                  <rect
                    key={colour}
                    x={i * STRIPE}
                    y={0}
                    width={STRIPE}
                    height={width}
                    fill={colour}
                  />
                ))}
              </pattern>
            );
          })}
      </defs>
      {paths.length === 1 ? (
        // A whole circle: an arc from a point back to itself draws nothing.
        <circle cx={r} cy={r} r={r} fill={fillOf(paths[0].slice)} />
      ) : (
        paths.map(({ slice, start, end, sweep }) => (
          <path
            key={slice.key}
            d={wedge(r, start, end, sweep > Math.PI)}
            fill={fillOf(slice)}
            // The separator: the page's own colour, so a seam reads as a gap between slices.
            stroke="var(--color-bg)"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        ))
      )}
    </svg>
  );
}

/** Each slice's start and end angle, in radians from twelve o'clock, laid end to end in order. */
function wedges(slices: readonly LandSlice[], total: number) {
  const out: { slice: LandSlice; start: number; end: number; sweep: number }[] = [];
  for (const slice of slices) {
    const start = out.length > 0 ? out[out.length - 1].end : 0;
    const sweep = (slice.count / total) * Math.PI * 2;
    out.push({ slice, start, end: start + sweep, sweep });
  }
  return out;
}

/** One wedge of a circle of radius `r` centred in the pie, angles in radians from twelve o'clock
 *  clockwise. */
function wedge(r: number, start: number, end: number, large: boolean): string {
  const point = (a: number) => `${r + r * Math.sin(a)} ${r - r * Math.cos(a)}`;
  return `M ${r} ${r} L ${point(start)} A ${r} ${r} 0 ${large ? 1 : 0} 1 ${point(end)} Z`;
}
