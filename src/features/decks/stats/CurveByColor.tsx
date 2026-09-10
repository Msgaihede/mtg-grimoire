/**
 * Six mana curves, one per colour, each read on its own.
 *
 * **Each panel's `max` is that colour's own tallest bucket and never the deck's**, which is the
 * one prop here that decides whether the readout says anything at all. Normalised against the
 * deck's biggest bar, a two-colour deck's splash would be five flat lines beside one real chart —
 * and the question this answers is "what does my red half cost", which is a question about
 * *shape*. Comparing the six against each other is what the panel captions and the Mana pips
 * readout beside this one are for; nothing here is drawn to be measured across panels.
 *
 * **A card is in every colour it is**, so a gold spell stands in two curves and the six sum to
 * more than the deck's nonlands — see `DeckStatsSummary.curveByColor`. The `C` curve is the one
 * key that partitions rather than overlaps: it is the cards with no colours at all.
 */
import type { JSX } from "react";
import { ManaText } from "@/components/ManaText";
import { plural } from "@/lib/counts";
import { MANA_FILL, MANA_KEYS, MANA_LABEL, type ManaKey } from "@/lib/mana";
import { cn } from "@/lib/utils";
import { CURVE_BUCKETS, curveLabel } from "../deckBuckets";
import type { DeckStatsSummary } from "../DeckStats";
import { BarChart, type ChartBar, StatsCard } from "./StatsCard";

/** How tall one of the six tracks is. Short enough that six panels fit two columns without the
 *  card becoming the tallest thing in the band; tall enough for `BarChart`'s `sm` headroom rule
 *  to print a count above a small bar rather than inside it. */
const PANEL_HEIGHT = 88;

export function CurveByColor({ stats }: { stats: DeckStatsSummary }): JSX.Element {
  return (
    <StatsCard title="Curve by color">
      <ul className="grid grid-cols-2 gap-x-3 gap-y-3">
        {MANA_KEYS.map((key) => (
          <ColorCurve
            key={key}
            colour={key}
            buckets={stats.curveByColor[key]}
            spells={stats.spellsByColor[key]}
          />
        ))}
      </ul>
    </StatsCard>
  );
}

function ColorCurve({
  colour,
  buckets,
  spells,
}: {
  colour: ManaKey;
  /** {@link CURVE_BUCKETS} counts — 0 through 7 exactly, then 8-or-more. */
  buckets: readonly number[];
  spells: number;
}): JSX.Element {
  const bars: ChartBar[] = buckets.map((count, bucket) => ({
    key: `${colour}-${bucket}`,
    label: curveLabel(bucket),
    count,
    // Reads after `BarChart`'s own "3 cards" — "3 cards at mana value 2". The open-ended bucket
    // is spelled out rather than drawn as `8+`, which a screen reader says as "eight plus".
    said: `at mana value ${bucket === CURVE_BUCKETS - 1 ? "8 or more" : bucket}`,
  }));

  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-1.5",
        // Dimmed and still drawn, for the Mana pips grid's reason: six panels in fixed places is
        // a shape a reader learns, and one that lost a cell whenever a colour emptied would have
        // to be read from scratch after every edit. Nine empty tracks are also a real answer —
        // this deck casts nothing of this colour — which no absent panel can state.
        spells === 0 && "opacity-45",
      )}
    >
      {/*
        The colour goes in the spoken story as a **heading over the panel** rather than as a
        clause in each bar's `said`. Nine sentences each ending "of white" is one fact repeated
        nine times, and `said` is composed by `BarChart` into a sentence about a count — where the
        colour is a fact about the whole panel. A heading is also what a screen reader's own
        navigation steps between, so a reader can reach the green curve without walking the blue
        one. `h4` because `StatsCard`'s own title is the `h3` above it.
      */}
      <h4 className="sr-only">
        {MANA_LABEL[colour]} — {plural(spells, "spell")}
      </h4>
      {/* Hidden because the heading above says both facts in words: the glyph is a wire token
          ("W") to a screen reader and the caption would be the count a second time.

          ⚠️ **The symbol and its count sit together at the left, and `justify-between` here is a
          bug rather than a taste.** Six panels are drawn two to a row, so pushing the count to
          the right-hand end of its panel parks it directly against the *next* panel's symbol —
          and with a 12px column gap between panels and 6px between a symbol and its own count,
          the eye pairs the count with the wrong colour. Read in the shipped window at 1657px
          (2026-09-10, debug build): `☀ ......... 0 spells 💧 ......... 22 spells`, where the
          blue panel is the one with 22 and the white one is the one with none. Keeping them a
          `gap-1.5` apart is what the design does and is the whole of the fix. */}
      <div aria-hidden="true" className="flex items-baseline gap-1.5">
        <ManaText source={`{${colour}}`} className="text-[0.875rem]" />
        <span className="font-mono text-[0.6875rem] tabular-nums text-dim">
          {plural(spells, "spell")}
        </span>
      </div>
      <BarChart
        bars={bars}
        // This colour's own tallest bucket — see this file's header. `BarChart` floors it at 1,
        // so a colour the deck plays none of draws nine empty tracks rather than dividing by zero.
        max={Math.max(0, ...buckets)}
        height={PANEL_HEIGHT}
        fill={MANA_FILL[colour]}
        size="sm"
      />
    </li>
  );
}
