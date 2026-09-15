/**
 * The pieces every widget body is drawn from — a figure line, horizontal bars, a list of bordered
 * rows, a footer, a sentence — so nine bodies are one visual language rather than nine.
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
 * * **A gain or a loss is spent as a *fill*, never as ink.** `--color-pie-g` at a figure's size on
 *   this background reads 3.3:1, under the floor — so a delta is body ink on a tinted chip, with a
 *   green or red glyph beside it. (There is no `text-pie-g` utility either: the name compiles and
 *   paints in the body colour.)
 */
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { RarityGem } from "@/components/RarityGem";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

import type { WidgetFit } from "./fit";

/** A gain's fill — the green of a forest pip. */
export const UP_FILL = "var(--color-pie-g)";
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

/**
 * A wrapping line of figures.
 *
 * The number grows to 1.375rem on a card at least four cells wide and two tall, 1.125rem otherwise.
 * **A note is dropped on a two-cell tile, and dropped when three or more figures share the line and
 * the note is longer than a unit** — three figures leave each about 120px, where `12 unpriced` after
 * `$4,812.55` runs off the end of its own column.
 */
export function WidgetFigures({
  figures,
  fit,
  divided = false,
}: {
  figures: readonly WidgetFigureItem[];
  fit: WidgetFit;
  /** Draw a rule under the line — when bars or rows follow it. */
  divided?: boolean;
}): ReactElement {
  const tip = useTooltip();
  const big = fit.tier >= 2 && fit.h >= 2;
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap gap-x-3.5 gap-y-1.5",
        divided && "border-b border-border pb-2",
      )}
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
                "block font-mono leading-[1.2] tabular-nums",
                big ? "text-[1.375rem]" : "text-[1.125rem]",
                figure.tone === "accent" ? "text-accent" : "text-text",
              )}
            >
              {figure.value}
              {note !== "" && (
                <span className="ml-1.5 whitespace-nowrap text-xs text-dim">{note}</span>
              )}
            </span>
          </>
        );
        return figure.onPress === undefined ? (
          <div key={figure.key} className="min-w-0 flex-1 basis-[120px]">
            {body}
          </div>
        ) : (
          <button
            key={figure.key}
            type="button"
            aria-label={figure.pressLabel}
            onClick={figure.onPress}
            className={cn(
              "min-w-0 flex-1 basis-[120px] rounded-md text-left hover:bg-surface",
              PRESS,
              FOCUS,
            )}
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
}: {
  bars: readonly WidgetBarItem[];
  fit: WidgetFit;
}): ReactElement {
  return (
    <ul className="m-0 flex shrink-0 list-none flex-col p-0" style={{ gap: fit.compact ? 5 : 8 }}>
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
 * A list of bordered rows, laid out in `fit.listColumns` columns.
 *
 * A column template is an inline style rather than an arbitrary class, because Tailwind scans
 * source text and a count interpolated into a class name emits nothing.
 */
export function WidgetRowList({
  fit,
  label,
  children,
}: {
  fit: WidgetFit;
  /** The list's accessible name, when the card's own title does not already say what it lists. */
  label?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <ul
      aria-label={label}
      className="m-0 grid shrink-0 list-none p-0"
      style={{
        gridTemplateColumns: `repeat(${fit.listColumns}, minmax(0, 1fr))`,
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
  const box = "flex w-full items-center gap-2 rounded-md border border-border px-1.5 py-[5px] text-left";
  return (
    <li>
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

/** A dim line at the foot of a body — where the prices came from, what the window is. */
export function WidgetFooter({ children }: { children: ReactNode }): ReactElement {
  return <p className="m-0 shrink-0 text-xs text-dim">{children}</p>;
}

/**
 * The one sentence a body draws instead of its content: *counting*, *nothing yet*, or a refusal.
 * A refusal is the destructive colour; everything else is dim.
 */
export function WidgetMessage({
  tone = "dim",
  children,
}: {
  tone?: "dim" | "destructive";
  children: ReactNode;
}): ReactElement {
  return (
    <p className={cn("m-0 text-sm", tone === "destructive" ? "text-destructive" : "text-dim")}>
      {children}
    </p>
  );
}
