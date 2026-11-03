import { useId, useMemo, useState, type JSX } from "react";
import { ChartColumnStacked } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { curveLabel, CURVE_BUCKETS } from "@/features/decks/deckBuckets";
import {
  CREATURE_FILL,
  CREATURE_SPLIT_LABEL,
  LegendEntry,
  NONCREATURE_FILL,
  splitParts,
} from "@/features/decks/stats/ManaCurveChart";
import { BarChart, percent, StatsCard, type ChartBar } from "@/features/decks/stats/StatsCard";
import { Pie, swatch } from "@/features/decks/stats/TypeBreakdown";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import type { DraftCard } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { pickStats } from "./pickStatsCounts";

/**
 * **The deck's stats beside the pick** — on a page wide enough for them (`PickScreen`'s
 * `STATS_MIN_WIDTH`, a 1920 window and up), and hidden by the heading row's toggle: the mana curve
 * split into creatures and noncreatures, the cards by type, and the nonland cards by color. Only
 * the deck's picks are counted, never the sideboard's (`pickStats`).
 *
 * Drawn with the deck editor's own pieces — `StatsCard`, `BarChart`, the curve's split and
 * legend, the land pie — so the draft and the deck it builds into read one way.
 */
export function PickStats({ cards }: { cards: readonly DraftCard[] }): JSX.Element {
  const headingId = useId();
  const stats = useMemo(() => pickStats(cards), [cards]);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-3">
          <h3 id={headingId} className="m-0 font-heading text-lg font-semibold leading-none">
            Deck stats
          </h3>
          <span className="font-mono text-sm tabular-nums text-dim">
            {plural(cards.length, "card")}
          </span>
        </div>
        <p className="m-0 text-xs text-dim">
          Your deck’s picks only — the sideboard isn’t counted.
        </p>
      </div>
      <Curve curve={stats.curve} creatures={stats.curveCreatures} average={stats.average} />
      <Types types={stats.types} />
      <Colors colors={stats.colors} total={stats.nonland} />
    </section>
  );
}

/**
 * The mana curve, `ManaCurveChart`'s picture: buckets 0 … 8+, the average, and the creature split
 * on a toggle. **The 0 bucket is drawn only when the deck holds a 0-cost spell** — a draft deck
 * rarely does, and an empty first column is room the other eight could use.
 */
function Curve({
  curve,
  creatures,
  average,
}: {
  curve: readonly number[];
  creatures: readonly number[];
  average: number | null;
}): JSX.Element {
  const tip = useTooltip();
  const [split, setSplit] = useState(true);
  const bars: ChartBar[] = curve.flatMap((copies, bucket) => {
    if (bucket === 0 && copies === 0) return [];
    const open = bucket === CURVE_BUCKETS - 1;
    return [
      {
        key: `mv-${bucket}`,
        label: curveLabel(bucket),
        count: copies,
        said: `at mana value ${open ? `${bucket} or more` : bucket}`,
        parts: split ? splitParts(copies, creatures[bucket] ?? 0, `mv-${bucket}`) : undefined,
      },
    ];
  });
  const max = Math.max(...bars.map((bar) => bar.count));
  const creatureCount = bars.reduce((sum, bar) => sum + (bar.parts?.[0]?.count ?? 0), 0);
  const noncreatureCount = bars.reduce((sum, bar) => sum + (bar.parts?.[1]?.count ?? 0), 0);
  return (
    <StatsCard
      title="Mana curve"
      actions={
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-pressed={split}
            aria-label={CREATURE_SPLIT_LABEL}
            onClick={() => setSplit(!split)}
            {...tip(
              split ? "Show one bar per mana value" : "Split bars into creatures and noncreatures",
            )}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs",
              PRESS,
              FOCUS,
              split ? "border-accent text-accent" : "border-border text-dim hover:text-text",
            )}
          >
            <ChartColumnStacked aria-hidden="true" className="size-3.5" />
            <span aria-hidden="true">Creatures</span>
          </button>
          <p className="flex items-baseline gap-1.5">
            <span className="font-mono text-lg tabular-nums text-accent">
              {average === null ? "—" : average.toFixed(2)}
            </span>
            <span className="text-xs text-dim">average</span>
          </p>
        </div>
      }
    >
      <BarChart bars={bars} max={max} height={152} fill="var(--color-accent)" variant="mana" />
      {split && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <LegendEntry fill={CREATURE_FILL} label="Creatures" count={creatureCount} />
          <LegendEntry fill={NONCREATURE_FILL} label="Noncreatures" count={noncreatureCount} />
        </div>
      )}
    </StatsCard>
  );
}

/** The deck's cards by type — `CardDistribution`'s `Types` cut, the lands among them. */
function Types({ types }: { types: readonly { label: string; count: number }[] }): JSX.Element {
  const bars: ChartBar[] = types.map(({ label, count }) => ({
    key: label,
    label,
    count,
    said: `of type ${label}`,
  }));
  return (
    <StatsCard title="Card distribution">
      <BarChart
        bars={bars}
        max={Math.max(0, ...types.map((t) => t.count))}
        height={120}
        fill="var(--color-accent)"
        labelWraps
      />
    </StatsCard>
  );
}

/**
 * The nonland cards by color, as the land pie draws a deck's lands: a slice per color and per
 * combination, a two-color slice striped in both, colorless last, and the legend beside it.
 */
function Colors({
  colors,
  total,
}: {
  colors: ReturnType<typeof pickStats>["colors"];
  total: number;
}): JSX.Element {
  return (
    <StatsCard title="Card colors">
      {total === 0 ? (
        <p className="text-xs text-dim">No spells in your deck yet.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Pie slices={colors} total={total} />
          <ul aria-label="Cards by color" className="flex min-w-44 flex-1 flex-col gap-1">
            {colors.map((slice) => (
              <li
                key={slice.key}
                className="grid items-center gap-2"
                style={{ gridTemplateColumns: "10px minmax(0, 1fr) auto 2.25rem" }}
              >
                <span className="sr-only">
                  {`${slice.label}: ${plural(slice.count, "card")}, ${percent(slice.count / total)}`}
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
                  {percent(slice.count / total)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[0.6875rem] text-dim">
        Nonland cards. A card of two colors is a slice of its own, striped in both.
      </p>
    </StatsCard>
  );
}
