/**
 * The deck stats band's shared furniture: the bordered card every readout is drawn in, the
 * vertical bar chart three of them draw, and the horizontal track two of them draw.
 *
 * **These exist because the same rules were about to be written three times.** The band holds
 * three vertical bar charts — the mana curve, the six colour curves and the card distribution —
 * that differ in height, in fill and in type size and agree on everything else, including the one
 * rule that is genuinely easy to get wrong: **a number that will not fit inside its own fill is
 * printed above the bar instead**. Three copies of that arithmetic is three chances for one of
 * them to clip a count at some zoom nobody tested.
 *
 * **Nothing here is a control.** The design these are built from makes every bar a button that
 * narrows the deck list beneath it; that is a cross-component feature reaching into all four of
 * the editor's views and is deliberately not in this pass. So a bar is a `<span>`, and the whole
 * drawing is `aria-hidden` with the numbers spoken beside it — which is the band's standing rule
 * and the reason it never needed a chart library.
 */
import type { JSX, ReactNode } from "react";
import { useId } from "react";
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
 */
const HEADROOM: Record<ChartSize, number> = { md: 24, sm: 19 };

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
}): JSX.Element {
  const ceiling = Math.max(max, 1);
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
