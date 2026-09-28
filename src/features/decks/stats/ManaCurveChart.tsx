/**
 * The deck's mana curve: nine numbered bars, the X bar that can ride behind them, and the
 * average mana value at the right-hand end of the heading.
 *
 * **A card of its own rather than a chart in a row of charts**, because the average belongs to
 * *this* curve and to nothing else on the band. `StatsCard`'s `actions` slot is what puts it on
 * the heading's line, where it reads as a caption on the picture under it — the figure and the
 * bars it summarises are one answer, and a reader who has to look elsewhere on the page for the
 * number is a reader who will read it against whichever chart it happens to be nearest.
 *
 * **It draws and decides nothing.** Every number here is `deckStats`' — including which cards
 * are X, which is `separateXGroup`'s answer and the deck's own — so this component cannot come
 * to disagree with the columns beside it about what a `{X}` spell costs. See
 * `DeckStatsSummary.variableCost` for why `null` and `0` are two different pictures.
 *
 * **The `Creatures` toggle splits every bar into creatures and noncreatures** (2026-09-28), which
 * is the question a curve alone cannot answer: *is my two-drop slot bodies or tricks?* The split
 * is `DeckStatsSummary.curveCreatures`, a subset of `curve` bucket for bucket, so the noncreature
 * part is a subtraction rather than a third field that could drift from the other two. **Whether
 * it is on is the deck's** — `decks.curve_creatures`, owned by the editor and passed down as
 * `split` — because a reader who builds creature decks wants it on the next time they open this
 * one, where Mana pips' `Hide` is a way of reading one chart in one sitting.
 *
 * Both pictures are `BarChart`'s `variant="mana"`: circled numerals, every count above its own
 * fill. Split, the **total** still rides on top — the reader turned on a detail, not off the
 * number the unsplit chart gave them.
 */
import type { JSX } from "react";
import { ChartColumnStacked } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CURVE_BUCKETS, curveLabel } from "../deckBuckets";
import type { DeckStatsSummary } from "../DeckStats";
import { X_GROUP_KEY } from "../grouping";
import { BarChart, StatsCard, type ChartBar, type ChartPart } from "./StatsCard";

/** The toggle's accessible name. Leads with the visible word (WCAG 2.5.3), names the card it acts
 *  on for `HIDE_COLORLESS_LABEL`'s reason, and stays one string pressed or not — `aria-pressed`
 *  carries the state. */
export const CREATURE_SPLIT_LABEL = "Creatures vs noncreatures in mana curve";

/** The two parts' colours. Custom properties, never `bg-…` classes, for `BarChart`'s `fill`
 *  reason — and the same tokens Card distribution's `Creatures vs noncreatures` band paints
 *  with, so the two halves of one fact are one colour on both cards. */
const CREATURE_FILL = "var(--color-creature)";
const CREATURE_FG = "var(--color-creature-fg)";
const NONCREATURE_FILL = "var(--color-noncreature)";
const NONCREATURE_FG = "var(--color-text)";

/** A bar's two parts, foot first — `ChartBar.parts`' order. */
function splitParts(total: number, creatures: number, key: string): ChartPart[] {
  return [
    { key: `${key}-c`, count: creatures, noun: "creature", fill: CREATURE_FILL, fg: CREATURE_FG },
    {
      key: `${key}-n`,
      // Floored at zero, so a summary that ever disagreed with itself draws a short bar rather
      // than a negative part the stack cannot lay out.
      count: Math.max(0, total - creatures),
      noun: "noncreature",
      fill: NONCREATURE_FILL,
      fg: NONCREATURE_FG,
    },
  ];
}

export function ManaCurveChart({
  stats,
  split,
  onSplitChange,
}: {
  stats: DeckStatsSummary;
  /** Whether each bar is drawn as creatures and noncreatures. The deck's, persisted by the
   *  editor — see this file's header. */
  split: boolean;
  onSplitChange: (next: boolean) => void;
}): JSX.Element {
  const tip = useTooltip();
  const bars: ChartBar[] = stats.curve.map((copies, bucket) => {
    // The same test `curveLabel` makes, off the same constant, so the glyph under the bar and
    // the sentence a screen reader hears cannot come to disagree about which bucket is the
    // open-ended one — `8+` over "at mana value 8" would be the picture and the words saying
    // two different things about one column.
    const open = bucket === CURVE_BUCKETS - 1;
    return {
      key: `mv-${bucket}`,
      label: curveLabel(bucket),
      count: copies,
      said: `at mana value ${open ? `${bucket} or more` : bucket}`,
      parts: split
        ? splitParts(copies, stats.curveCreatures[bucket] ?? 0, `mv-${bucket}`)
        : undefined,
    };
  });

  // Drawn only where the deck is splitting X out: `null` is "there is no X bar" and `0` is "the
  // reader asked for the X bar and this deck has none", and the second is a fact worth an empty
  // bar. Last, and behind the open-ended bucket, because X is not a number and cannot sit on the
  // axis anywhere the eye reads as a quantity.
  if (stats.variableCost !== null) {
    bars.push({
      // `grouping.ts`' own key for the X heading rather than a second spelling of it: the pile
      // on the desk and the bar over it are the same object, and this repo already keeps that
      // word in one place.
      key: X_GROUP_KEY,
      label: "X",
      count: stats.variableCost,
      // The reader's own words, never the `{X}` a card prints — braces are not something a
      // screen reader says.
      said: "with X in their cost",
      // The X bar splits too: it is a pile of the deck's cards like any other, and a legend
      // whose sums skipped it would disagree with the bars drawn above it.
      parts: split
        ? splitParts(stats.variableCost, stats.variableCostCreatures ?? 0, X_GROUP_KEY)
        : undefined,
    });
  }

  // The tallest bar drawn, X included, so the two are on one scale. Read off `bars` rather than
  // off `stats.curve` and `stats.variableCost` separately, because a bar added to this chart
  // later must not be able to overflow a ceiling computed without it. `BarChart` floors it at 1,
  // so a deck of nothing draws a row of empty tracks rather than dividing by zero.
  const max = Math.max(...bars.map((bar) => bar.count));

  // The legend's two figures, summed over the bars drawn — X included exactly when its bar is —
  // so the legend and the chart above it are one arithmetic rather than two that agree today.
  const creatures = bars.reduce((sum, bar) => sum + (bar.parts?.[0]?.count ?? 0), 0);
  const noncreatures = bars.reduce((sum, bar) => sum + (bar.parts?.[1]?.count ?? 0), 0);

  return (
    <StatsCard
      title="Mana curve"
      actions={
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-pressed={split}
            aria-label={CREATURE_SPLIT_LABEL}
            onClick={() => onSplitChange(!split)}
            {...tip(
              split
                ? "Draw each mana value as one bar."
                : "Split each bar into creatures and noncreatures.",
            )}
            className={cn(
              // Mana pips' `Hide` box, so the two toggles on the band are one control.
              "inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs",
              PRESS,
              FOCUS,
              split ? "border-accent text-accent" : "border-border text-dim hover:text-text",
            )}
          >
            <ChartColumnStacked aria-hidden="true" className="size-3.5" />
            {/* One word in both states, for `Hide`'s reason: the edge and `aria-pressed` say
                which, and the visible word stays inside the accessible name. */}
            <span aria-hidden="true">Creatures</span>
          </button>
          {/* Two elements rather than one string, because they are two type sizes — and
              siblings rather than one element's contents, so the figure and the word stay two
              runs to read instead of concatenating into `3.24average`. */}
          <p className="flex items-baseline gap-1.5">
          <span className="font-mono text-lg tabular-nums text-accent">
            {/* An em dash rather than a zero for a deck of nothing but lands: an average of no
                numbers is not 0. `toFixed(2)` is `DeckLedger`'s spelling of the same figure, so
                the head of the page and the band at the foot of it print one number one way. */}
            {stats.averageManaValue === null ? "—" : stats.averageManaValue.toFixed(2)}
          </span>
            <span className="text-xs text-dim">average</span>
          </p>
        </div>
      }
    >
      <BarChart bars={bars} max={max} height={152} fill="var(--color-accent)" variant="mana" />
      {split && (
        // Not a list: the curve's `<ul>` is the one list in this card and each of its items is a
        // bar, which is what a screen reader's list navigation should step through. The legend is
        // two captions read in order, and each bar's own split is already in its sentence.
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <LegendEntry fill={CREATURE_FILL} label="Creatures" count={creatures} />
          <LegendEntry fill={NONCREATURE_FILL} label="Noncreatures" count={noncreatures} />
        </div>
      )}
      {/* Without this line the bars silently fail to sum to the deck: a nonland copy with no
          mana value anywhere is in no bucket at all, so a reader counting the columns against
          their deck size finds cards missing with nothing on screen to account for them. */}
      {stats.unknownManaValue > 0 && (
        <p className="text-xs tabular-nums text-dim">
          {plural(stats.unknownManaValue, "card")} with no mana value, not counted
        </p>
      )}
    </StatsCard>
  );
}

/** One swatch, its word and its count. */
function LegendEntry({
  fill,
  label,
  count,
}: {
  fill: string;
  label: string;
  count: number;
}): JSX.Element {
  return (
    <p className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-sm"
        style={{ background: fill }}
      />
      <span className="text-dim">{label}</span>{" "}
      <span className="font-mono tabular-nums text-text">{count}</span>
    </p>
  );
}
