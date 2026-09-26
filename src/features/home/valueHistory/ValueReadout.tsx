/**
 * The value graph's readout — every figure the hovered day holds — and the one door it is opened
 * through.
 *
 * ## Mounted at the app root, through the tooltip's own machinery
 *
 * **The panel is `useTooltip`'s panel**, opened through `TooltipContext`: one `fixed` box at
 * `LAYER.tooltip`, a sibling of the whole app, placed from the measured rect of an anchor the chart
 * draws at the crosshair. Three things would clip or misplace a panel drawn inside the widget, and
 * root-mounting escapes all three at once:
 *
 * * **The card and its body scroller.** `WidgetCard`'s body is the one box that clips, so a
 *   readout drawn inside it is cut off at the card's edge — and on a 2×2 tile the readout is taller
 *   than the chart it describes.
 * * **The home grid's CSS `zoom`.** A `fixed` box *inside* the zoomed grid lays its `left`/`top`
 *   out in the grid's local pixels and paints them scaled, so a panel placed at the pointer's
 *   viewport `clientX` lands half again as far from the corner at 150%. The root is never zoomed,
 *   and `getBoundingClientRect()` on the anchor already answers in viewport pixels — the zoom is
 *   in the rect, so nothing here divides by it.
 * * **A dragged card's `transform`**, which makes the card the containing block for every `fixed`
 *   descendant.
 *
 * So there is no second tooltip in this app: `TooltipPanel` measures, flips and clamps against
 * `document.documentElement.clientWidth` as it does for every hint, and this file supplies the
 * content and the anchor.
 *
 * **`immediate`, because a scrubbing pointer is already asking.** A hint waits `TOOLTIP_OPEN_MS`
 * for a pointer that is passing over a control to become one asking about it; a reader drawing
 * the pointer along a line is asking at every pixel, and a readout that caught up 400ms after the
 * pointer stopped would describe a day the crosshair has left. Every move re-opens the panel on
 * the same anchor, which bumps its `openId` and re-measures.
 *
 * **`describes: false`**: the drawing is a `role="slider"` whose `aria-valuetext` already speaks
 * the hovered day, so the panel is a picture of words a screen reader has, and is `aria-hidden`.
 *
 * ## The colours
 *
 * `WidgetParts.tsx`'s two rules, unchanged: money is the accent on the page and body ink here, and
 * **a gain or a loss is a fill, never ink** — every change figure is body ink on a chip tinted
 * with `UP_FILL` or `DOWN_FILL` at 20%. A pip carries a line's colour, and the line's word beside
 * it carries its identity, because white, colourless and multicolour sit outside the palette's
 * lightness band on purpose and cannot be told apart by colour alone.
 */
import { useContext, useEffect, type ReactElement, type RefObject } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";

import { TooltipContext } from "@/components/tooltip/useTooltip";
import { cn } from "@/lib/utils";

import { DOWN_FILL, UP_FILL } from "../WidgetParts";

import type { Readout } from "./model";

/** The panel's outer width — the design's `tip.w`: wider on a split, which has a column of names. */
const SPLIT_WIDTH = 264;
const TOTAL_WIDTH = 236;
/**
 * What `TooltipPanel` spends around the content: `px-2` and its 1px border on each side, plus the
 * `px-px` this content adds to reach the design's 9px of air.
 */
const PANEL_CHROME = 2 * 8 + 2 * 1 + 2 * 1;

/** The accent's pip, square-cornered — the total is not one of the lines. */
const TOTAL_PIP = "var(--color-accent)";

/**
 * A change on its chip: body ink on a tinted fill. `glyph` adds the trend arrow in green or red —
 * the figure line's larger chip carries one, the rows' small ones do not.
 */
export function DeltaChip({
  text,
  up,
  small = false,
  glyph = false,
}: {
  text: string;
  up: boolean;
  small?: boolean;
  glyph?: boolean;
}): ReactElement {
  const Glyph = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-[4px] px-[5px] font-mono whitespace-nowrap text-text tabular-nums",
        small ? "text-xs leading-4" : "py-px text-[0.8125rem] leading-[18px]",
      )}
      style={{ background: `color-mix(in oklab, ${up ? UP_FILL : DOWN_FILL} 20%, transparent)` }}
    >
      {glyph && (
        <Glyph aria-hidden="true" className={cn("size-[13px]", up ? "text-ok" : "text-destructive")} />
      )}
      {text}
    </span>
  );
}

/** A line's colour, as a dot. */
function Pip({ fill, square = false }: { fill: string; square?: boolean }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0", square ? "rounded-[2px]" : "rounded-full")}
      style={{ background: fill }}
    />
  );
}

function Rule(): ReactElement {
  return <div className="my-[5px] h-px bg-border" />;
}

/** One line of the readout: a name, a figure, and — on a split — the change in a fixed column so
 *  the figures line up down the panel. */
function Line({
  pip,
  square,
  name,
  value,
  change,
  up,
  strong,
  column,
}: {
  pip?: string;
  square?: boolean;
  name: string;
  value: string;
  change?: string;
  up?: boolean;
  strong: boolean;
  /** Keep a 62px column for the change whether or not this line has one. */
  column: boolean;
}): ReactElement {
  const chip =
    change === undefined ? null : <DeltaChip text={change} up={up ?? true} small />;
  return (
    <div className="flex items-center gap-1.5 text-xs leading-[19px] whitespace-nowrap">
      {pip !== undefined && <Pip fill={pip} square={square} />}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          strong ? "font-semibold text-text" : "text-dim",
        )}
      >
        {name}
      </span>
      <span className="font-mono text-text tabular-nums">{value}</span>
      {column ? <span className="flex w-[62px] shrink-0 justify-end">{chip}</span> : chip}
    </div>
  );
}

/**
 * The readout's content — drawn inside `TooltipPanel`, which supplies the surface, the border,
 * the shadow and the placement.
 *
 * A split reads: the date and what the change is measured from, the total, then every line's
 * value and change with the followed one in bold, then a note where the reader added or removed
 * cards in that step. Total reads: value, change since the start, and the step split into what
 * the reader did and what prices did — the facts `readoutAt` lists.
 */
export function ValueReadout({ readout }: { readout: Readout }): ReactElement {
  const split = readout.facts.length === 0;
  const width = (split ? SPLIT_WIDTH : TOTAL_WIDTH) - PANEL_CHROME;
  return (
    <div data-value-readout="" className="px-px pt-[3px] pb-1" style={{ width }}>
      <div className="flex items-baseline justify-between gap-2.5 text-[0.78125rem] leading-[18px] font-medium whitespace-nowrap text-text">
        <span>{readout.date}</span>
        {readout.since !== "" && (
          <span className="text-[0.6875rem] font-normal text-dim">{readout.since}</span>
        )}
      </div>
      <Rule />
      {split ? (
        <>
          <Line
            pip={TOTAL_PIP}
            square
            name="Total"
            value={readout.total.value}
            change={readout.total.change}
            up={readout.total.up}
            strong
            column
          />
          <Rule />
          {readout.rows.map((row) => (
            <Line
              key={row.key}
              pip={row.fill}
              name={row.label}
              value={row.value}
              change={row.change}
              up={row.up}
              strong={row.lit}
              column
            />
          ))}
        </>
      ) : (
        readout.facts.map((fact, i) => (
          <Line
            key={fact.label}
            name={fact.label}
            value={fact.value}
            change={fact.change}
            up={fact.up}
            strong={i === 0}
            column={false}
          />
        ))
      )}
      {readout.note !== null && (
        <div className="mt-[5px] text-[0.71875rem] leading-4 text-dim">{readout.note}</div>
      )}
    </div>
  );
}

/**
 * Open the readout beside `anchor` while `readout` is set, move it whenever the readout or the
 * side changes, and close it when the readout ends or the chart goes away.
 *
 * **The anchor is the chart's**: a band a few pixels wide centred on the crosshair and as tall as
 * the plot, so `placeTooltip` puts the panel beside the hovered day, vertically centred on the
 * plot, with the band's half-width as the air between the crosshair and the panel. `side` is
 * *away from* the half of the plot the pointer is in, so the line under the pointer stays in view;
 * `placeTooltip` still flips it where the window is in the way.
 *
 * Effects rather than calls from the pointer handler, and that is what keeps it one answer: a
 * refetch, a row hovered in the list or a key press all change `readout` the same way a pointer
 * does, and the anchor has been moved by the commit before the panel measures it.
 */
export function useReadoutPanel(
  anchor: RefObject<HTMLElement | null>,
  readout: Readout | null,
  side: "left" | "right",
): void {
  const api = useContext(TooltipContext);
  const open = readout !== null;

  useEffect(() => {
    const el = anchor.current;
    if (el === null || readout === null) return;
    api.enter(el, <ValueReadout readout={readout} />, {
      side,
      describes: false,
      immediate: true,
    });
  }, [api, anchor, readout, side]);

  // Keyed on *whether* it is open, so its cleanup runs once when the readout ends — or when the
  // chart unmounts under it — rather than between two moves along the line.
  useEffect(() => {
    if (!open) return undefined;
    const el = anchor.current;
    return () => {
      if (el !== null) api.leave(el);
    };
  }, [api, anchor, open]);
}
