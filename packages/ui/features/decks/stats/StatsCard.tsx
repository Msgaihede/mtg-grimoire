/**
 * The deck stats band's shared furniture: the bordered card every readout is drawn in, the
 * vertical bar chart three of them draw, and the horizontal track two of them draw.
 *
 * **These exist because the same rules were about to be written three times.** The band holds
 * three vertical bar charts — the mana curve, the six colour curves and the card distribution —
 * that differ in height, in fill and in type size and agree on everything else, including the one
 * rule that is genuinely easy to get wrong: **where a bar's number is printed**. The card
 * distribution keeps the original rule — above the fill where the empty track leaves room, inside
 * the fill's top where it does not. The two mana charts use `variant="mana"` (2026-09-28), where
 * **every count sits above its own fill and never inside it**, in a clear strip over the track
 * that the tallest bar's count lands in — and where the curve's creature split stacks two parts
 * per bar, each printing its own count inside itself when it is tall enough. Three copies of any
 * of that arithmetic is three chances for one of them to clip a count at some zoom nobody tested,
 * which is why the stacked chart is a mode of this one rather than a sibling of it.
 *
 * **Nothing here is a control.** The design these are built from makes every bar a button that
 * narrows the deck list beneath it; that is a cross-component feature reaching into all four of
 * the editor's views and is deliberately not in this pass. So a bar is a `<span>`, and the whole
 * drawing is `aria-hidden` with the numbers spoken beside it — which is the band's standing rule
 * and the reason it never needed a chart library.
 */
import type { JSX, ReactNode } from "react";
import { useId } from "react";
import { plural } from "@/lib/counts";
import { cn } from "@/lib/utils";

/**
 * One readout of the band — a bordered card with a heading and, optionally, something at the
 * right-hand end of that heading's line.
 *
 * **A card here, where the band itself is emphatically not one.** `DeckEditor`'s own comment
 * settles that: the band is *"a rule and the content under it"* rather than *"a panel you
 * opened"*, because it is part of the page. These are the readouts **inside** it, and each one is
 * a separate question about the deck — a curve, a manabase, a price — so the border is what says
 * where one answer stops and the next begins. Six unbordered readouts down two columns is a
 * column of numbers with nothing saying which caption belongs to which chart.
 */
export function StatsCard({
  title,
  actions,
  children,
  className,
}: {
  title: string;
  /** Drawn at the right-hand end of the heading's line — a select, or a figure like the curve's
   *  average. Wraps under the heading rather than squeezing it at a narrow column. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "flex min-w-0 flex-col gap-2.5 rounded-lg border border-border p-3",
        className,
      )}
    >
      {/* `items-baseline` so a mono figure in the actions slot sits on the heading's own
          baseline rather than being centred against a taller box; `flex-wrap` because the
          editor column is a few hundred pixels wide with the card pane docked, and a heading
          squeezed by its own controls is a heading that truncates. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <h3 id={id} className="text-base font-medium text-text">
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** One column of a {@link BarChart}. */
export interface ChartBar {
  key: string;
  /** What the eye reads under the bar — `0`…`7`, `8+`, `Creature`. */
  label: string;
  count: number;
  /**
   * The tail of the spoken sentence, after `"3 cards"` — `"at mana value 1"`, `"are creatures"`.
   *
   * **The one place the pair is spoken**, so a screen reader hears *"8 cards at mana value 1"*
   * rather than the two loose numbers the eye reads as a column.
   */
  said: string;
  /**
   * The bar split into stacked parts, **listed from the foot upward** — the curve's creatures
   * then noncreatures. Honoured by `variant="mana"` only; the default variant draws `count` as
   * one fill and ignores this.
   *
   * **The parts must sum to `count`**, which stays the bar's height and the number printed over
   * it. The spoken sentence becomes the parts' own — *"5 creatures and 5 noncreatures at mana
   * value 2"* — because a split the eye can see and the ear cannot is the drawing saying more
   * than the words, which the band's rule forbids.
   */
  parts?: readonly ChartPart[];
}

/** One stacked part of a {@link ChartBar}. */
export interface ChartPart {
  key: string;
  count: number;
  /** The singular noun the sentence counts it in — `"creature"`, pluralised by `plural`. */
  noun: string;
  /** The part's fill, as a CSS colour — a custom property for the reason {@link BarChart}'s
   *  `fill` is one. */
  fill: string;
  /** The colour its own count is printed in, on that fill. */
  fg: string;
}

/**
 * How large a chart is drawn — which decides its type sizes and, with them, the headroom a count
 * needs before it can be printed above its own bar.
 *
 * `md` is a chart read on its own (the mana curve, the card distribution); `sm` is one of six
 * drawn in a grid (the colour curves). The **height** is a separate prop, because the curve is
 * taller than the distribution at the same type size.
 */
export type ChartSize = "md" | "sm";

/**
 * How much clear track a count needs above its fill before it is printed there instead of inside
 * it — the count's own line height plus the air under it.
 *
 * Below this the number goes **inside** the fill, at the top, which is why the fill carries a
 * foreground colour at all. A number printed above a fill that has risen to meet it is a number
 * overlapping its own bar, and a number forced inside a two-pixel fill is invisible; the
 * threshold is where those two failures meet.
 *
 * **`variant="mana"` spends the same number differently**: as a clear strip drawn *above* the
 * track, so the tallest bar still fills its track to the top and its count has somewhere to go
 * that is not its own fill. One constant for both, because it is one measurement — the room a
 * count needs over a fill — and two would drift.
 */
const HEADROOM: Record<ChartSize, number> = { md: 24, sm: 19 };

/**
 * The shortest a nonzero fill (or stacked part) is drawn, in px.
 *
 * A count of one against a max of a hundred rounds to nothing, and an invisible bar under a label
 * reads as a bug rather than as a small number.
 */
const MIN_FILL: Record<ChartSize, number> = { md: 3, sm: 2 };

/**
 * How tall a stacked part must be before it prints its own count inside itself — a 12px line,
 * the 4px of air above it and a little under it. Below this the part is drawn silent and the
 * sentence and the legend carry its number; a count squeezed into a sliver is a count nobody can
 * read and one that overhangs the part below it reads as that part's.
 */
export const PART_COUNT_MIN_PX = 18;

/**
 * The axis glyph in `variant="mana"` — a mono numeral in a bordered circle.
 *
 * `min(100%, …)` because the curve draws ten columns in a card that can be 22rem wide, where a
 * column is narrower than the circle wants to be; the circle shrinks with its column rather than
 * pushing its neighbours apart. Two literal strings, never one assembled from the size, because
 * Tailwind finds a class by reading the source for its whole name.
 */
const CIRCLE_LABEL: Record<ChartSize, string> = {
  md: "flex aspect-square w-[min(100%,36px)] shrink-0 items-center justify-center rounded-full border border-border font-mono text-[1.25rem] font-bold leading-none tabular-nums text-text",
  sm: "flex aspect-square w-[min(100%,22px)] shrink-0 items-center justify-center rounded-full border border-border font-mono text-[0.8125rem] font-bold leading-none tabular-nums text-text",
};

/** The count's own type, and the padding that separates it from the fill it sits above or in. */
const COUNT_TYPE: Record<ChartSize, string> = {
  md: "font-mono text-sm font-semibold leading-none tabular-nums",
  sm: "font-mono text-[0.6875rem] font-semibold leading-none tabular-nums",
};

/** The word under a bar, in its bordered box. */
const LABEL_TYPE: Record<ChartSize, string> = {
  md: "font-mono text-sm font-medium leading-none tabular-nums text-text",
  sm: "font-mono text-xs font-medium leading-none tabular-nums text-dim",
};

/**
 * A row of vertical bars with their counts on them and their words under them.
 *
 * **The whole drawing is `aria-hidden` and each bar carries an `sr-only` sentence**, which is the
 * band's rule for every chart in it: the picture is decoration over numbers that are already
 * text. That is also why there is no `role="img"` and no chart library — the accessible story is
 * the sentences, and they are complete without the bars.
 *
 * `max` is the caller's, not `Math.max(...counts)`, because the six colour curves are each read
 * against **their own** tallest bar rather than against the deck's — see
 * `DeckStatsSummary.curveByColor`. Passing the wrong one is the way to make five of six charts
 * unreadable, so it is required rather than defaulted.
 */
export function BarChart({
  bars,
  max,
  height,
  fill,
  size = "md",
  labelWraps = false,
  labelMinHeight,
  variant = "default",
}: {
  bars: readonly ChartBar[];
  /** The count the tallest bar is drawn at full height for. Floored at 1 here, so a chart of
   *  nothing draws a row of empty tracks rather than dividing by zero. */
  max: number;
  /** Track height in px — 152 for the mana curve, 120 for the distribution, 88 for a colour. */
  height: number;
  /**
   * The fill, as a CSS colour — `var(--color-accent)`, or a `MANA_FILL` entry for a colour curve.
   *
   * **A custom property rather than a Tailwind class**, because Tailwind scans source text for
   * whole class names and a `bg-mana-${key}` assembled at runtime emits no rule at all.
   */
  fill: string;
  size?: ChartSize;
  /** Whether a label may break across lines — true for words (`Planeswalker`), false for the
   *  single mono glyphs a curve is labelled with. */
  labelWraps?: boolean;
  /** A floor under the label boxes so that a one-line word and a two-line one leave their bars
   *  on the same baseline. Only worth setting where {@link labelWraps} is. */
  labelMinHeight?: number;
  /**
   * `"mana"` for the mana curve and the colour curves: circled numerals under the bars, and
   * **every count above its own fill, never inside it** — see {@link ManaColumn}. It also honours
   * {@link ChartBar.parts}. `"default"` is the card distribution's word boxes and its
   * above-or-inside count; {@link labelWraps} and {@link labelMinHeight} are for that one and
   * ignored here, because a circled numeral neither wraps nor needs a floor.
   */
  variant?: "default" | "mana";
}): JSX.Element {
  const ceiling = Math.max(max, 1);
  if (variant === "mana") {
    return (
      <ul className="flex items-end gap-2" style={{ gap: size === "sm" ? 3 : undefined }}>
        {bars.map((bar) => (
          <ManaColumn
            key={bar.key}
            bar={bar}
            ceiling={ceiling}
            height={height}
            fill={fill}
            size={size}
          />
        ))}
      </ul>
    );
  }
  return (
    <ul className="flex items-end gap-2" style={{ gap: size === "sm" ? 3 : undefined }}>
      {bars.map((bar) => {
        const filled = (bar.count / ceiling) * height;
        // The bar's own headroom: how much empty track is left above its fill. A count goes
        // above the fill when it fits there and inside the fill when it does not.
        const above = bar.count > 0 && height - filled >= HEADROOM[size];
        const inside = bar.count > 0 && !above;
        return (
          <li key={bar.key} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className="sr-only">
              {bar.count} {bar.count === 1 ? "card" : "cards"} {bar.said}
            </span>
            <span
              aria-hidden="true"
              className="flex w-full items-end overflow-hidden rounded-sm bg-surface"
              style={{ height }}
            >
              <span className="flex h-full w-full flex-col justify-end">
                <span
                  className={cn(
                    "flex items-end justify-center text-text",
                    COUNT_TYPE[size],
                    size === "sm" ? "pb-1.5" : "pb-2",
                  )}
                  style={{ height: above ? HEADROOM[size] : 0 }}
                >
                  {above ? bar.count : ""}
                </span>
                <span
                  className={cn(
                    "flex w-full items-start justify-center rounded-sm text-accent-fg",
                    COUNT_TYPE[size],
                    bar.count > 0 && (size === "sm" ? "pt-0.5" : "pt-1"),
                  )}
                  style={{
                    height: `${(bar.count / ceiling) * 100}%`,
                    // A bar the reader can see is a bar that has something in it: a count of one
                    // against a max of a hundred rounds to nothing, and an invisible bar under a
                    // label reads as a bug rather than as a small number.
                    minHeight: bar.count === 0 ? 0 : size === "sm" ? 2 : 3,
                    background: fill,
                  }}
                >
                  {inside ? bar.count : ""}
                </span>
              </span>
            </span>
            <span
              aria-hidden="true"
              // Horizontal, on one baseline, and broken at a hyphen where a word is wider than
              // its column — a tilted axis and a staggered one both make the reader work for a
              // word. `lang="en"` is what lets the browser hyphenate at all.
              lang={labelWraps ? "en" : undefined}
              className={cn(
                "flex w-full items-center justify-center rounded border border-border px-0.5 py-[3px] text-center",
                labelWraps
                  ? "hyphens-auto break-words text-[0.6875rem] font-medium leading-[1.15] text-text"
                  : LABEL_TYPE[size],
              )}
              style={{ minHeight: labelMinHeight }}
            >
              {bar.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One column of a `variant="mana"` {@link BarChart}: a track, a clear strip above it, the count
 * riding on top of the fill, and a circled numeral under it all.
 *
 * **The count is positioned rather than flowed.** The track and the strip are one relative box
 * `height + HEADROOM` tall with the track at its foot, and the count is an absolute box
 * `HEADROOM` tall whose `bottom` is the fill's own height in px — so it sits directly on the fill
 * whatever the fill's height, and on the tallest bar (whose fill is the whole track) it lands in
 * the strip. The default variant's alternative, printing inside the fill when the track runs out
 * of room, is what this mode exists to refuse: a column of numbers at one height above their bars
 * and one inside the tallest reads as two kinds of number.
 *
 * **Every px here is computed, not a percentage**, because the count's `bottom` and the fill's
 * height have to be the same number — a `%` fill with a `minHeight` floor under it is a fill
 * whose drawn height the count cannot know.
 *
 * With {@link ChartBar.parts}, the fill is those parts stacked from the foot, a 1px
 * `--color-bg` rule between two drawn parts, and each part tall enough
 * ({@link PART_COUNT_MIN_PX}) prints its own count at its own top. The **total** still rides
 * above the whole stack, so the split never costs the reader the number the unsplit chart gave
 * them.
 */
function ManaColumn({
  bar,
  ceiling,
  height,
  fill,
  size,
}: {
  bar: ChartBar;
  ceiling: number;
  height: number;
  fill: string;
  size: ChartSize;
}): JSX.Element {
  const px = (count: number) =>
    count > 0 ? Math.max((count / ceiling) * height, MIN_FILL[size]) : 0;
  const parts = bar.parts?.filter((part) => part.count > 0);
  // The stack's drawn height is the sum of its parts' drawn heights, floors included, so the
  // total lands on the top part rather than a hair inside it. Clamped to the track: two floored
  // slivers on the tallest bar can sum past it, and the track clips the overhang anyway.
  const drawn = Math.min(
    height,
    parts === undefined ? px(bar.count) : parts.reduce((sum, part) => sum + px(part.count), 0),
  );
  return (
    <li className="flex min-w-0 flex-1 flex-col items-center gap-1">
      <span className="sr-only">{spokenBar(bar)}</span>
      <span
        aria-hidden="true"
        className="relative block w-full"
        style={{ height: height + HEADROOM[size] }}
      >
        <span
          className="absolute inset-x-0 bottom-0 flex flex-col justify-end overflow-hidden rounded-sm bg-surface"
          style={{ height }}
        >
          {parts === undefined ? (
            bar.count > 0 && (
              <span
                className="block w-full rounded-sm"
                style={{ height: drawn, background: fill }}
              />
            )
          ) : (
            // Foot-first in the data, so reversed in the flow: the first part is the bottom one.
            <span className="flex w-full flex-col-reverse overflow-hidden rounded-sm">
              {parts.map((part, index) => {
                const partPx = px(part.count);
                return (
                  <span
                    key={part.key}
                    className={cn(
                      "flex w-full shrink-0 items-start justify-center pt-1",
                      "font-mono text-xs font-semibold leading-none tabular-nums",
                    )}
                    style={{
                      height: partPx,
                      background: part.fill,
                      color: part.fg,
                      // The rule sits on the upper part's foot, so it is drawn exactly where
                      // two parts meet and never under the foot-most one.
                      borderBottom: index > 0 ? "1px solid var(--color-bg)" : undefined,
                    }}
                  >
                    {partPx >= PART_COUNT_MIN_PX ? part.count : ""}
                  </span>
                );
              })}
            </span>
          )}
        </span>
        {bar.count > 0 && (
          <span
            className={cn(
              "absolute inset-x-0 flex items-end justify-center text-text",
              COUNT_TYPE[size],
              size === "sm" ? "pb-1.5" : "pb-2",
            )}
            style={{ bottom: drawn, height: HEADROOM[size] }}
          >
            {bar.count}
          </span>
        )}
      </span>
      <span aria-hidden="true" className={CIRCLE_LABEL[size]}>
        {bar.label}
      </span>
    </li>
  );
}

/**
 * The sentence a `variant="mana"` bar is spoken as — `"8 cards at mana value 1"`, or with parts
 * `"5 creatures and 5 noncreatures at mana value 2"`. Every part is named, a zero included: a
 * sentence that dropped the empty half would leave the reader to infer it from a missing word.
 */
export function spokenBar(bar: ChartBar): string {
  if (bar.parts === undefined) {
    return `${plural(bar.count, "card")} ${bar.said}`;
  }
  const said = bar.parts.map((part) => plural(part.count, part.noun));
  const listed =
    said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}` : said[0];
  return `${listed} ${bar.said}`;
}

/**
 * A horizontal track with a fill in it — the shape the Mana pips tile draws twice per colour and
 * the Opening hand odds draws once per row.
 *
 * `aria-hidden` like every other drawing here: whatever it stands beside says the number in text.
 */
export function Track({
  share,
  fill,
  height = 12,
  className,
  style,
}: {
  /** `0`…`1`. Clamped, because a share computed from two independently rounded counts can land a
   *  hair outside and a 101%-wide fill overhangs its own track. */
  share: number;
  fill: string;
  height?: number;
  className?: string;
  style?: React.CSSProperties;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn("block min-w-0 flex-1 overflow-hidden rounded-sm bg-surface", className)}
      style={{ height }}
    >
      <span
        className="block h-full rounded-sm"
        style={{
          width: `${Math.max(0, Math.min(1, share)) * 100}%`,
          background: fill,
          ...style,
        }}
      />
    </span>
  );
}

/** A percentage as the band writes one — whole numbers, and an em dash where there is nothing to
 *  take a percentage **of**, which is a different statement from `0%`. */
export function percent(share: number | null): string {
  return share === null ? "—" : `${Math.round(share * 100)}%`;
}
