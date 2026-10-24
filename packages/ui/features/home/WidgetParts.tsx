/**
 * The pieces every widget body is drawn from — a figure line, horizontal bars, a list of bordered
 * rows, a footer, a sentence — so every body speaks one visual language rather than its own.
 *
 * **Drawn to the grid redesign (`Widget.dc.html`) and shared rather than restated**: a body that
 * wants a row draws a `WidgetRow`, and the day the design moves a row's padding it moves in one
 * place. A body is free to draw something none of these fit (the activity feed's day sections,
 * the recent cards' film strip), and should say why at its own site.
 *
 * Two colour rules hold for all of them, both from the design's own notes:
 *
 * * **Money is the accent, counts are body ink.** A value figure is gold wherever it appears; a row
 *   of four golds would emphasise nothing.
 * * **A gain or a loss is spent as a *fill*, never as ink.** A delta is body ink on a tinted chip,
 *   with a green or red glyph beside it. The rule was measured against the saturated green deep
 *   that was the gain colour until 2026-09-28, which read 3.3:1 on this background; the gain is
 *   `--color-mana-g` now (11.4:1 as a glyph), but the chip stays the figure's colour so that a
 *   gain and a loss are one weight of type and differ only in their tint.
 */
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { RarityGem } from "@/components/RarityGem";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

import type { ListLayout, WidgetFit } from "./fit";

/** A gain's fill — the green of a forest pip, `--color-mana-g`. It is pale, so it is spent as a
 *  20–24% tint under body ink or as a glyph on the dark ground, and never as a solid fill with
 *  light text on it (1.4:1). */
export const UP_FILL = "var(--color-mana-g)";
/** A loss's fill — the destructive red. */
export const DOWN_FILL = "var(--color-destructive)";

/** One figure: a small label over a large number, with an optional qualification beside it. */
export interface WidgetFigureItem {
  key: string;
  label: string;
  value: string;
  /** A unit or a qualification — `cards`, `12 unpriced`. Dropped where there is no room to read
   *  it; see {@link WidgetFigures}. */
  note?: string;
  /** `accent` for money, `text` for a count. */
  tone: "accent" | "text";
  /** A hint on the number — where a price came from, say. */
  hint?: string;
  /** Makes the figure a press — Summary's figures open the view they count. */
  onPress?: () => void;
  /** The press's accessible name. Required with `onPress`: a bare number is not a name. */
  pressLabel?: string;
}

/** The type sizes a filling figure's number steps through, smallest first, in pixels. */
export const FIGURE_SIZES_PX = [18, 22, 28, 34] as const;
/** A figure's label line: one line of `text-xs`. */
const FIGURE_LABEL_PX = 16;
/** `gap-x-3.5` and `gap-y-1.5` between two figures — the line's own gaps, spelled for arithmetic. */
const FIGURE_GAP_X_PX = 14;
const FIGURE_GAP_Y_PX = 6;
/** Geist Mono's advance, as a share of its size — the figures are `font-mono tabular-nums`. */
const MONO_ADVANCE = 0.6;
/** A generous average advance of the label's 12px Geist, per character. */
const LABEL_ADVANCE_PX = 6.5;

/** How a filling figure line is arranged: `rows` × `columns` cells, each number `sizePx` tall. */
export interface FigureGrid {
  rows: number;
  columns: number;
  sizePx: number;
}

/**
 * The arrangement of `count` figures that draws their numbers largest in a box this big — or
 * `null` when not even the smallest size fits, at any arrangement.
 *
 * `longest` is the longest number in characters; a number is mono, so its width is a product
 * rather than a measurement. `longestLabel` is the longest label, held to a generous average
 * advance, so an arrangement that would cut a label is not taken. **A size is taken only when the
 * label and the number fit the cell's height and the number fits its width**, so a filling line can
 * never be wider or taller than the body that was measured for it. Ties go to fewer rows: four
 * figures across a wide card read as one line, which is what a summary is.
 */
export function figureGrid(
  count: number,
  longest: number,
  box: { widthPx: number; heightPx: number },
  longestLabel = 0,
): FigureGrid | null {
  let best: FigureGrid | null = null;
  for (let rows = 1; rows <= count; rows++) {
    const columns = Math.ceil(count / rows);
    // Every row holds `columns` cells, so `count` figures need no more rows than this.
    if (Math.ceil(count / columns) !== rows) continue;
    const cellW = (box.widthPx - FIGURE_GAP_X_PX * (columns - 1)) / columns;
    const cellH = (box.heightPx - FIGURE_GAP_Y_PX * (rows - 1)) / rows;
    // A label cut to `Collec…` is a figure nobody can name, so the label must fit its cell too.
    if (longestLabel * LABEL_ADVANCE_PX > cellW) continue;
    for (const sizePx of FIGURE_SIZES_PX) {
      const fits =
        FIGURE_LABEL_PX + sizePx * 1.2 <= cellH && longest * MONO_ADVANCE * sizePx <= cellW;
      if (fits && (best === null || sizePx > best.sizePx)) best = { rows, columns, sizePx };
    }
  }
  return best;
}

/**
 * A wrapping line of figures.
 *
 * The number grows to 1.375rem on a card at least four cells wide and two tall, 1.125rem otherwise.
 * **A note is dropped on a two-cell tile, and dropped when three or more figures share the line and
 * the note is longer than a unit** — three figures leave each about 120px, where `12 unpriced` after
 * `$4,812.55` runs off the end of its own column. A note that still finds no room ends in an
 * ellipsis rather than running under the next figure, which the value cards' three-cell width did
 * with `2 unpriced` (issue #1379); the number itself never gives way to its note.
 *
 * **`fill` makes the figures the whole body** (Summary, which has nothing else to draw): they are
 * laid out by {@link figureGrid} over the body's box, each centred in its cell, and the number is
 * drawn at the largest size that grid allows — so a taller or wider card draws bigger figures
 * rather than the same small line over an empty card.
 */
export function WidgetFigures({
  figures,
  fit,
  divided = false,
  fill = false,
}: {
  figures: readonly WidgetFigureItem[];
  fit: WidgetFit;
  /** Draw a rule under the line — when bars or rows follow it. */
  divided?: boolean;
  /** Spread the figures over the whole body, at the largest size it holds. See above. */
  fill?: boolean;
}): ReactElement {
  const tip = useTooltip();
  const big = fit.tier >= 2 && fit.h >= 2;
  const grid = fill
    ? figureGrid(
        figures.length,
        Math.max(1, ...figures.map((figure) => figure.value.length)),
        { widthPx: fit.bodyWidthPx, heightPx: fit.bodyHeightPx },
        Math.max(0, ...figures.map((figure) => figure.label.length)),
      )
    : null;
  return (
    <div
      className={cn(
        grid === null
          ? "flex shrink-0 flex-wrap gap-x-3.5 gap-y-1.5"
          : "grid flex-1 gap-x-3.5 gap-y-1.5",
        divided && "border-b border-border pb-2",
      )}
      style={
        grid === null
          ? undefined
          : {
              gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
            }
      }
    >
      {figures.map((figure) => {
        const note =
          fit.tier === 0 || (figures.length > 2 && (figure.note ?? "").length > 6)
            ? ""
            : (figure.note ?? "");
        const body = (
          <>
            <span className="block truncate text-xs text-dim">{figure.label}</span>
            <span
              {...(figure.hint === undefined ? {} : tip(figure.hint))}
              className={cn(
                "flex min-w-0 items-baseline overflow-hidden font-mono leading-[1.2] tabular-nums",
                grid === null && (big ? "text-[1.375rem]" : "text-[1.125rem]"),
              )}
              style={grid === null ? undefined : { fontSize: grid.sizePx }}
            >
              <span
                className={cn("shrink-0", figure.tone === "accent" ? "text-accent" : "text-text")}
              >
                {figure.value}
              </span>
              {note !== "" && (
                <span className="ml-1.5 min-w-0 truncate text-xs text-dim">{note}</span>
              )}
            </span>
          </>
        );
        // A filling figure is centred in its cell, so the spare height is shared above and below
        // the figures rather than left in one block under them.
        const cell =
          grid === null ? "min-w-0 flex-1 basis-[120px]" : "flex min-w-0 flex-col justify-center";
        return figure.onPress === undefined ? (
          <div key={figure.key} className={cell}>
            {body}
          </div>
        ) : (
          <button
            key={figure.key}
            type="button"
            aria-label={figure.pressLabel}
            onClick={figure.onPress}
            className={cn(cell, "rounded-md text-left hover:bg-surface", PRESS, FOCUS)}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}

/** One horizontal bar. */
export interface WidgetBarItem {
  key: string;
  label: string;
  /** The formatted money or count at the right. */
  value: string;
  /** `0..=1` of the widest bar. */
  share: number;
  /** A CSS colour for the fill. **Never an interpolated `bg-…` class** — Tailwind emits no rule
   *  for one. The value text takes this colour too unless it is the accent. */
  fill: string;
  /** Draw a rarity gem before the label. */
  rarity?: string;
  /** The one sentence a screen reader gets for the bar; the drawing is `aria-hidden`. */
  said: string;
}

/**
 * Bars that run across: a word and a figure over a 6px track.
 *
 * **The drawing is `aria-hidden` and each bar carries one `sr-only` sentence** — the deck stats
 * band's standing rule, and why nothing here is a chart library: the picture is decoration over
 * numbers that are already text. A bar with any share draws at least 2% so a small bucket beside a
 * figure is never an invisible fill.
 */
export function WidgetBars({
  bars,
  fit,
  fill = false,
}: {
  bars: readonly WidgetBarItem[];
  fit: WidgetFit;
  /**
   * The bars were cut to every whole bar the body holds: spread them over the body, so the sliver a
   * whole-bar cut leaves is shared between the bars rather than left under the last one.
   */
  fill?: boolean;
}): ReactElement {
  return (
    <ul
      className={cn(
        "m-0 flex list-none flex-col p-0",
        fill && bars.length > 1 ? "flex-1 justify-between" : "shrink-0",
      )}
      style={{ gap: fit.compact ? 5 : 8 }}
    >
      {bars.map((bar) => (
        <li key={bar.key}>
          <span className="sr-only">{bar.said}</span>
          <div aria-hidden="true" className="flex flex-col gap-[3px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-center gap-[5px]">
                {bar.rarity !== undefined && <RarityGem rarity={bar.rarity} />}
                <span className="min-w-0 truncate text-sm text-text">{bar.label}</span>
              </span>
              <span
                className="shrink-0 font-mono text-sm tabular-nums"
                style={{
                  color: bar.fill === "var(--color-accent)" ? "var(--color-dim)" : bar.fill,
                }}
              >
                {bar.value}
              </span>
            </div>
            <span className="block h-1.5 overflow-hidden rounded-sm bg-surface">
              <span
                className="block h-full rounded-sm"
                style={{
                  background: bar.fill,
                  width: `${bar.share > 0 ? Math.max(2, bar.share * 100).toFixed(1) : 0}%`,
                }}
              />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * A list of bordered rows, laid out in `fit.listColumns` columns — or in a body's
 * {@link ListLayout} when it passes one, which every list cut to whole rows should (issue #1379):
 * the fewest columns that hold its rows, and, when the rows reach the foot of the box, rows
 * stretched over the sliver a whole-row cut leaves rather than that sliver left empty.
 *
 * A column template is an inline style rather than an arbitrary class, because Tailwind scans
 * source text and a count interpolated into a class name emits nothing. **A stretched row is never
 * shorter than its content** (`1fr` is `minmax(auto, 1fr)`), so an estimate that was a few pixels
 * out still scrolls rather than clipping a row.
 */
export function WidgetRowList({
  fit,
  label,
  layout,
  children,
}: {
  fit: WidgetFit;
  /** The list's accessible name, when the card's own title does not already say what it lists. */
  label?: string;
  /** `fit.listLayout` over the rows this list draws. */
  layout?: ListLayout;
  children: ReactNode;
}): ReactElement {
  const columns = layout?.columns ?? fit.listColumns;
  const full = layout?.full ?? false;
  return (
    <ul
      aria-label={label}
      className={cn("m-0 grid list-none p-0", full ? "flex-1" : "shrink-0")}
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridAutoRows: full ? "1fr" : undefined,
        gap: fit.rowGap,
      }}
    >
      {children}
    </ul>
  );
}

/** Which way a row's money went. */
export type RowDelta = "up" | "down";

export interface WidgetRowProps {
  name: string;
  /** A second line under the name. */
  caption?: string;
  /** Draw the caption in body ink rather than dim — for a tile that moved its figure under the
   *  name. */
  captionStrong?: boolean;
  /** The figure at the right. */
  value?: string;
  /** A gain or a loss: the value sits on a tinted chip. */
  delta?: RowDelta;
  /** A small glyph before the name, already sized (`size-3.5`) and `aria-hidden`. */
  icon?: ReactNode;
  /** The glyph's colour, as CSS. */
  iconColor?: string;
  /** A card-art frame before the name, already sized by the caller. */
  art?: ReactNode;
  /** A `0..=1` progress track under the name. */
  track?: number;
  /** Makes the row a press. */
  onPress?: () => void;
  /** The press's accessible name, when the visible text is not a good one. */
  pressLabel?: string;
  /** A hint on the row. */
  hint?: string;
}

/**
 * One bordered row: an optional picture or glyph, a name over an optional caption or track, and a
 * figure.
 *
 * **On a two-cell tile a row has no width for a name and a figure side by side**, so a body passes
 * the figure as the caption there (with `captionStrong`) and no `value` — which is how every folder
 * tile in this app already reads its own face. That choice is the body's, because only the body
 * knows which of its figures is the one worth keeping.
 */
export function WidgetRow({
  name,
  caption,
  captionStrong = false,
  value,
  delta,
  icon,
  iconColor,
  art,
  track,
  onPress,
  pressLabel,
  hint,
}: WidgetRowProps): ReactElement {
  const tip = useTooltip();
  const chip: CSSProperties | undefined =
    delta === undefined
      ? undefined
      : {
          borderRadius: 4,
          padding: "1px 5px",
          background: `color-mix(in oklab, ${delta === "up" ? UP_FILL : DOWN_FILL} 20%, transparent)`,
        };
  const inner = (
    <>
      {art !== undefined && <span className="w-[34px] flex-none">{art}</span>}
      {icon !== undefined && (
        <span className="flex flex-none" style={{ color: iconColor ?? "var(--color-dim)" }}>
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-text">{name}</span>
        {caption !== undefined && caption !== "" && (
          <span
            className={cn("truncate text-xs tabular-nums", captionStrong ? "text-text" : "text-dim")}
          >
            {caption}
          </span>
        )}
        {track !== undefined && (
          <span className="mt-1 block h-1 overflow-hidden rounded-sm bg-surface">
            <span
              className="block h-full rounded-sm bg-accent"
              style={{ width: `${Math.round(Math.max(0, Math.min(1, track)) * 100)}%` }}
            />
          </span>
        )}
      </span>
      {value !== undefined && value !== "" && (
        <span className="flex-none font-mono text-sm tabular-nums text-text" style={chip}>
          {value}
        </span>
      )}
    </>
  );
  // `h-full`, so a row in a stretched list (`WidgetRowList`'s `layout`) fills its track.
  const box =
    "flex h-full w-full items-center gap-2 rounded-md border border-border px-1.5 py-[5px] text-left";
  return (
    <li className="min-w-0">
      {onPress === undefined ? (
        <div className={box} {...(hint === undefined ? {} : tip(hint))}>
          {inner}
        </div>
      ) : (
        <button
          type="button"
          aria-label={pressLabel}
          onClick={onPress}
          {...(hint === undefined ? {} : tip(hint))}
          className={cn(box, "hover:border-dim hover:bg-surface", PRESS, FOCUS)}
        >
          {inner}
        </button>
      )}
    </li>
  );
}

/** A footer's two spellings: the `line` it draws, and the whole sentence it is `said` as. */
export interface FooterWords {
  line: string;
  /** Omitted when the line is already the whole sentence. */
  said?: string;
}

/**
 * A footer that is **exactly one line at any width** — `truncate`, so a sentence too long for the
 * box ends in an ellipsis instead of wrapping onto a second line nothing reserved.
 *
 * **It is the only footer there is.** A wrapping `WidgetFooter` stood beside it until issue #1379,
 * reserved at a guessed 22px: the live pass of 2026-09-26 found three of those footers on two and
 * three lines and a body scrolling under them. Every body counts its rows against `fit.ts`'
 * `footerLinePx` and draws its footer here, which is what makes that figure a reservation rather
 * than an estimate.
 *
 * **Two spellings, and the short one is what makes the ellipsis rare**: `line` is drawn, and `said`
 * — the whole sentence — is both the hint and what a screen reader hears, so the words a cut line
 * lost are never lost to anybody. The drawn line is `aria-hidden` beside an `sr-only` sentence
 * rather than an `aria-label`, because a `<p>` is a role whose name is prohibited. **`relative`**,
 * so that `sr-only`'s absolute span has this line for its containing block rather than whatever
 * positioned box is above the body's scroller (`packages/ui/CLAUDE.md`'s scroll-container rule). The hint
 * does not describe: the sentence is already this element's text, and describing it again would
 * say it twice. A line that is its own sentence is drawn once and hinted only when cut.
 */
export function WidgetFooterLine({ line, said }: FooterWords): ReactElement {
  const tip = useTooltip();
  const box = "relative m-0 shrink-0 truncate text-xs text-dim";
  if (said === undefined || said === line) {
    return (
      <p className={box} {...tip(line, { whenClipped: true })}>
        {line}
      </p>
    );
  }
  return (
    <p className={box} {...tip(said, { describes: false })}>
      <span aria-hidden="true">{line}</span>
      <span className="sr-only">{said}</span>
    </p>
  );
}

/**
 * The one sentence a body draws instead of its content: *counting*, *nothing yet*, or a refusal.
 * A refusal is the destructive colour; everything else is dim.
 *
 * **Alone in a body it is centred in the card** — `WidgetCard` keys that on its
 * `data-widget-message` mark — because one short sentence in the top-left corner of a large card
 * reads as a card that failed to draw the rest (issue #1379). Beside a figure line or a list it
 * stays in the flow where it was put.
 */
export function WidgetMessage({
  tone = "dim",
  children,
}: {
  tone?: "dim" | "destructive";
  children: ReactNode;
}): ReactElement {
  return (
    <p
      data-widget-message=""
      className={cn("m-0 text-sm", tone === "destructive" ? "text-destructive" : "text-dim")}
    >
      {children}
    </p>
  );
}
