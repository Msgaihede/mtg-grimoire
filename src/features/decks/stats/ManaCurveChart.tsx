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
 */
import type { JSX } from "react";
import { plural } from "@/lib/counts";
import { CURVE_BUCKETS, curveLabel } from "../deckBuckets";
import type { DeckStatsSummary } from "../DeckStats";
import { X_GROUP_KEY } from "../grouping";
import { BarChart, StatsCard, type ChartBar } from "./StatsCard";

export function ManaCurveChart({ stats }: { stats: DeckStatsSummary }): JSX.Element {
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
    });
  }

  // The tallest bar drawn, X included, so the two are on one scale. Read off `bars` rather than
  // off `stats.curve` and `stats.variableCost` separately, because a bar added to this chart
  // later must not be able to overflow a ceiling computed without it. `BarChart` floors it at 1,
  // so a deck of nothing draws a row of empty tracks rather than dividing by zero.
  const max = Math.max(...bars.map((bar) => bar.count));

  return (
    <StatsCard
      title="Mana curve"
      actions={
        // Two elements rather than one string, because they are two type sizes — and siblings
        // rather than one element's contents, so the figure and the word stay two runs to read
        // instead of concatenating into `3.24average`.
        <p className="flex items-baseline gap-1.5">
          <span className="font-mono text-lg tabular-nums text-accent">
            {/* An em dash rather than a zero for a deck of nothing but lands: an average of no
                numbers is not 0. `toFixed(2)` is `DeckLedger`'s spelling of the same figure, so
                the head of the page and the band at the foot of it print one number one way. */}
            {stats.averageManaValue === null ? "—" : stats.averageManaValue.toFixed(2)}
          </span>
          <span className="text-xs text-dim">average</span>
        </p>
      }
    >
      <BarChart bars={bars} max={max} height={152} fill="var(--color-accent)" />
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
