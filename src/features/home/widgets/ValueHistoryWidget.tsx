/**
 * The collection's value over time — in total, or one line per card type, colour or set — with one
 * line lit and the rest as context, a list of the lines beside or under it, and a readout of every
 * figure the hovered day holds.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the chip that says *Card type*, and the
 * settings popover where the split, the range, the measure and the two switches are chosen — the
 * registry rows `split`, `window`, `measure`, `figures` and `markers` in `widgets.ts`. **The in-card
 * chips write the same keys through `onConfig`**, so the popover and the card can never disagree
 * about what the widget is showing; they are drawn only where `layoutFor` finds room for them.
 *
 * ## One read, and everything past it is arithmetic
 *
 * `collection_value_history` answers every kept point for the split and the marketplace — both in
 * `valueHistoryKey` — and **the range and the measure never reach Rust**: `viewOf` windows and folds
 * the answer and `shownValues` turns it into percent, so stepping from 90 days to a year, or from
 * Change to Value, re-draws one cached answer. `collection_summary` is read beside it, exactly as
 * `CollectionValueWidget` reads it, for two things the history cannot say: *nothing owned* (a real
 * answer, and a different sentence from *reading*), and the `N unpriced` note that travels with the
 * figure it qualifies.
 *
 * ## Where everything goes
 *
 * **Absolutely, in body pixels, from `layoutFor`** — the spec's fit table: a tile is the figure line
 * and the chart; a panel adds a strip of line names; a band the in-card chips and, four tall, a
 * two-column list; a row puts the chips across the top, the chart on the left and a rail on the
 * right holding the figures and the list. Every region is a whole number of rows, so nothing is
 * drawn through the card's edge.
 *
 * ## What is local, and what is not
 *
 * **The followed line and the hovered day are `useState`**, not config: a reader pinning *Land* for
 * a look is not changing their widget. Hovering a list row previews its line; pressing pins it
 * (`aria-pressed`). The readout is opened at the app root through the tooltip's machinery
 * (`valueHistory/ValueReadout.tsx` says why); **on a two-cell tile the figure line is the
 * readout** — its label takes the hovered date and its figures the hovered values — so no panel
 * opens over a card that small.
 *
 * ## Still and editing
 *
 * A catalogue preview and a card in Customize draw everything and take nothing: no slider (so no
 * tab stop and no readout), and chips and rows that are buttons with no press. `WidgetCard` makes
 * the body inert as well; this is the half that holds for a body drawn on its own.
 */
import { useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";

import { useTooltip } from "@/components/tooltip/useTooltip";
import { count, plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type CollectionSummary, type ValueSplit } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { PRESS, PRESS_SOFT } from "@/lib/motion";
import { formatPrice } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";

import type { WidgetFit } from "../fit";
import { collectionTotalKey, valueHistoryKey } from "../keys";
import { DAY_SECONDS, formatDay } from "../priceHistory/priceAnalytics";
import {
  collectionChange,
  layoutFor,
  readoutAt,
  viewOf,
  type HistoryView,
  type Readout,
  type Rect,
  type Series,
  type ValueMeasure,
  type ValueWindow,
} from "../valueHistory/model";
import { ValueChart } from "../valueHistory/ValueChart";
import { DeltaChip } from "../valueHistory/ValueReadout";
import { WidgetMessage } from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";
import { pickOf, toggleOnOf } from "../widgetSettings";
import { widgetMeta } from "../widgets";

import { signedMoney } from "./PriceMoversWidget";

/**
 * A pick, narrowed to its type. `pickOf` has already refused a word no option carries; the
 * registry's default here is the answer for the one case it cannot resolve — a kind this build
 * does not know, which never reaches this body.
 */
function splitOf(value: string | number | undefined): ValueSplit {
  return value === "total" || value === "color" || value === "set" ? value : "type";
}
function windowOf(value: string | number | undefined): ValueWindow {
  return value === "30d" || value === "1y" || value === "all" ? value : "90d";
}
function measureOf(value: string | number | undefined): ValueMeasure {
  return value === "value" ? "value" : "change";
}

/** The registry's own options, so a chip's word and the popover's are one word. */
const PICKS = widgetMeta("valueHistory").picks;
function optionsOf(key: string): readonly { id: string; label: string }[] {
  return (PICKS.find((p) => p.key === key)?.options ?? []).map((o) => ({
    id: String(o.id),
    label: o.label,
  }));
}
const SPLIT_OPTIONS = optionsOf("split");
const WINDOW_OPTIONS = optionsOf("window");

/** A range as the in-card chips write it — the popover's `30 days` is the chip's tooltip. */
const WINDOW_SHORT: Record<ValueWindow, string> = { "30d": "30D", "90d": "90D", "1y": "1Y", all: "All" };

/** A range as a sentence says it. */
const WINDOW_WORD: Record<ValueWindow, string> = {
  "30d": "30 days",
  "90d": "90 days",
  "1y": "1 year",
  all: "all kept history",
};

/** A split as a sentence says it. */
const SPLIT_WORD: Record<Exclude<ValueSplit, "total">, string> = {
  type: "card type",
  color: "colour",
  set: "set",
};

/**
 * One in-card chip — `WidgetSettingsPanel`'s `CHIP` look, restated whole because Tailwind scans
 * source text for class names and that constant is private to its file. Pressed is the accent,
 * which means *on* everywhere in this app.
 */
const CHIP = cn(
  "shrink-0 rounded-md border px-2 py-[3px] text-[0.8125rem] leading-snug whitespace-nowrap",
  PRESS,
  FOCUS,
);
const CHIP_ON = "border-accent text-accent";
const CHIP_OFF = "border-border text-dim hover:text-text";

/** A list row — `WidgetRow`'s bordered box at the design's 24px, pressed in the accent. */
const ROW = cn(
  "flex h-6 w-full min-w-0 items-center gap-[7px] rounded-md border px-1.5 text-left text-text hover:bg-surface",
  PRESS_SOFT,
  FOCUS,
);
const ROW_ON = "border-accent";
const ROW_OFF = "border-border hover:border-dim";
/** A row that is a figure rather than a line to follow. */
const PLAIN_ROW = "flex h-6 min-w-0 items-center gap-[7px] rounded-md border border-border px-1.5";

/** A strip entry: a pip and a name, bordered only when pressed or pointed at. */
const LEG = cn(
  "inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-md border px-1.5 text-xs whitespace-nowrap text-text",
  PRESS,
  FOCUS,
);
const LEG_ON = "border-accent";
const LEG_OFF = "border-transparent hover:border-border";

/** Room left under the rail's rows for its one-line footer. */
const RAIL_FOOT = 22;
/** One list row and the 3px after it — `layoutFor`'s pitch. */
const ROW_PITCH = 27;

/** What a pressable line carries — nothing at all in a still or editing body. */
interface RowHandlers {
  onClick?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}

function place(r: Rect): CSSProperties {
  return { left: r.x, top: r.y, width: r.w, height: r.h };
}

/** Money with a sign, or none on a figure that rounds to zero — `+$0.00` claims a direction. */
function signed(x: number, currency: Currency): string {
  return Math.round(Math.abs(x) * 100) === 0 ? formatPrice(0, currency) : signedMoney(x, currency);
}

function Pip({ fill, small = false }: { fill: string; small?: boolean }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn("shrink-0 rounded-full", small ? "size-[7px]" : "size-2")}
      style={{ background: fill }}
    />
  );
}

export function ValueHistoryWidget({
  widget,
  fit,
  editing,
  still,
  onConfig,
}: WidgetBodyProps): ReactElement {
  const { marketplace, currency } = useMarketplace();
  const split = splitOf(pickOf(widget, "split"));
  const range = windowOf(pickOf(widget, "window"));
  const measure = measureOf(pickOf(widget, "measure"));
  const figuresOn = toggleOnOf(widget, "figures");
  const markersOn = toggleOnOf(widget, "markers");
  /** A body a reader can use — not a catalogue picture, not a card being arranged. */
  const live = !editing && !still;

  /** The pinned line, with the split it was pinned in: a key means nothing under another split. */
  const [followed, setFollowed] = useState<{ split: ValueSplit; key: string } | null>(null);
  /** The line a list row under the pointer previews. */
  const [peek, setPeek] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const summary = useQuery({
    queryKey: collectionTotalKey(marketplace.id),
    // `CollectionValueWidget`'s read, word for word: every copy, and `limit: 0` makes it a count.
    queryFn: (): Promise<CollectionSummary> =>
      ipc.collectionSummary({ limit: 0, offset: 0, marketplace: marketplace.id }),
  });
  const history = useQuery({
    queryKey: valueHistoryKey(split, marketplace.id),
    queryFn: () => ipc.collectionValueHistory(split, marketplace.id),
  });

  // The split and the range are read again inside, off the widget itself, rather than closed over:
  // the React Compiler cannot see that a pick narrowed by a function is a string, and a dependency
  // it thinks a later call might mutate is `react-hooks/preserve-manual-memoization` going red.
  const view = useMemo(
    () =>
      history.data === undefined
        ? null
        : viewOf(
            history.data,
            splitOf(pickOf(widget, "split")),
            windowOf(pickOf(widget, "window")),
          ),
    [history.data, widget],
  );
  const n = view?.days.length ?? 0;
  const keys = view?.series.map((s) => s.key) ?? [];
  const chosen =
    followed !== null && followed.split === split && keys.includes(followed.key)
      ? followed.key
      : (keys[0] ?? "total");
  const litKey = peek !== null && keys.includes(peek) ? peek : chosen;
  const hot = live && hover !== null && hover < n ? hover : null;
  const at = hot ?? n - 1;
  const readout = useMemo(
    () => (view === null || n === 0 ? null : readoutAt(view, at, litKey, currency)),
    [view, n, at, litKey, currency],
  );

  // Three sentences and the order is what keeps them apart — `CollectionValueWidget`'s: a refusal
  // wins, because a card that went on saying *reading* over a read that will never answer is the
  // one failure a reader cannot act on.
  const failure = summary.error ?? history.error;
  if (failure !== null) {
    return (
      <WidgetMessage tone="destructive">
        Your price history could not be read. {ipcError(failure)}
      </WidgetMessage>
    );
  }
  if (summary.data === undefined || history.data === undefined || view === null) {
    return <WidgetMessage>Reading your price history…</WidgetMessage>;
  }
  // Rust answers no points at all for an empty collection, and the live point is always inside
  // the range, so `n === 0` and *nothing owned* are one state.
  if (summary.data.totalCards === 0 || n === 0 || readout === null) {
    return <WidgetMessage>Nothing in your collection yet.</WidgetMessage>;
  }

  const layout = layoutFor(fit, { split, figures: figuresOn, bucketCount: view.series.length });
  /** Only today's live point: a database that has not yet kept a day with copies in it —
   *  a first launch, or one upgraded from before `price_snapshots.copies` existed. */
  const firstDay = history.data.points.length === 1;
  const lit = view.series.find((s) => s.key === litKey) ?? view.series[0];
  const litRow = readout.rows.find((row) => row.key === litKey) ?? null;
  const unpriced = summary.data.unpriced;
  const tile = fit.tier === 0;
  const inRail = layout.rail !== null;

  // The in-card chips. A still or editing body draws them and gives them no press.
  const pickSplit = (id: string) => {
    setFollowed(null);
    setPeek(null);
    setHover(null);
    onConfig({ split: id });
  };
  const pickWindow = (id: string) => {
    setHover(null);
    onConfig({ window: id });
  };
  const pickMeasure = (id: ValueMeasure) => onConfig({ measure: id });

  // A list row: hover previews, a press pins.
  const follow = (key: string) => {
    setFollowed({ split, key });
    setPeek(null);
  };
  const rowHandlers = (key: string): RowHandlers =>
    live
      ? {
          onClick: () => follow(key),
          onPointerEnter: () => setPeek(key),
          onPointerLeave: () => setPeek(null),
        }
      : {};

  /** A row's figure: the change on its chip, or the money — and the money on the first day,
   *  when every change is a zero measured against itself. */
  const rowFigure = (key: string) => {
    const row = readout.rows.find((r) => r.key === key);
    if (row === undefined) return null;
    return measure === "change" && !firstDay ? (
      <DeltaChip text={row.change} up={row.up} small />
    ) : (
      <span className="shrink-0 font-mono text-[0.78125rem] text-text tabular-nums">{row.value}</span>
    );
  };

  const spanDays = n > 1 ? Math.round((view.days[n - 1] - view.days[0]) / DAY_SECONDS) : 0;
  // A history younger than the range says how long it is, rather than naming a range it has not
  // reached.
  const spanWord = view.historyShort
    ? `the ${plural(spanDays, "day")} kept so far`
    : WINDOW_WORD[range];
  const subject =
    split === "total" ? "Collection value" : `Collection value by ${SPLIT_WORD[split]}`;
  const chartLabel =
    split === "total"
      ? `Collection value, ${spanWord}`
      : `Value by ${SPLIT_WORD[split]}, ${spanWord}`;
  const valueText =
    `${readout.date}: ` +
    (split === "total" || litRow === null
      ? readout.total.value
      : `${litRow.label} ${litRow.value}, total ${readout.total.value}`);
  const from = formatPrice(view.totals[0] ?? 0, currency);
  const to = formatPrice(view.totals[n - 1] ?? 0, currency);
  const sentence =
    n > 1 ? `${subject} over ${spanWord}: ${from} to ${to}.` : `${subject} today: ${to}.`;

  const figureLabel = `Value (${currency.toUpperCase()})${hot !== null ? ` · ${readout.date}` : ""}`;
  const note = unpriced > 0 && !tile && hot === null ? `${count(unpriced)} unpriced` : null;

  return (
    <div className="relative w-full shrink-0" style={{ height: Math.floor(fit.bodyHeightPx) }}>
      {layout.figures !== null && (
        <FigureBlock
          rect={layout.figures}
          fit={fit}
          inRail={inRail}
          label={figureLabel}
          readout={readout}
          withChange={n > 1}
          note={note}
          second={
            !inRail && !tile && split !== "total" && litRow !== null && lit !== undefined
              ? {
                  fill: lit.fill,
                  label: litRow.label,
                  value: litRow.value,
                  change: litRow.change,
                  up: litRow.up,
                }
              : null
          }
          withSecondChange={n > 1}
        />
      )}

      {layout.controls !== null && (
        <div className="absolute flex items-center gap-1" style={place(layout.controls)}>
          <ChipGroup
            label="Split by"
            options={SPLIT_OPTIONS.map((o) => ({ id: o.id, text: o.label }))}
            on={split}
            onPick={live ? pickSplit : undefined}
          />
          <div className="grow" />
          {layout.controlsHaveMeasure && (
            <ChipGroup
              label="Measure"
              options={[
                {
                  id: "value",
                  // The currency's own sign, off the house formatter rather than spelled here.
                  text: formatPrice(0, currency).replace(/[\d.,\s]/g, ""),
                  aria: `Value in ${currency.toUpperCase()}`,
                },
                { id: "change", text: "%", aria: "Change since the start of the range" },
              ]}
              on={measure}
              onPick={live ? (id) => pickMeasure(measureOf(id)) : undefined}
              square
            />
          )}
          {layout.controlsHaveMeasure && layout.controlsHaveRanges && (
            <div aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
          )}
          {layout.controlsHaveRanges && (
            <ChipGroup
              label="Range"
              options={WINDOW_OPTIONS.map((o) => ({
                id: o.id,
                text: WINDOW_SHORT[windowOf(o.id)],
                hint: o.label,
              }))}
              on={range}
              onPick={live ? pickWindow : undefined}
            />
          )}
        </div>
      )}

      {layout.chart !== null && (
        <div className="absolute" style={place(layout.chart)}>
          {n > 1 ? (
            <ValueChart
              view={view}
              measure={measure}
              currency={currency}
              litKey={litKey}
              width={layout.chart.w}
              height={layout.chart.h}
              hover={hot}
              onHover={live ? setHover : undefined}
              markers={markersOn}
              // On a tile the figure line is the readout; a tile with its figures off has only this.
              readout={tile && layout.figures !== null ? null : readout}
              label={chartLabel}
              valueText={valueText}
              summary={sentence}
            />
          ) : (
            <p className="m-0 text-[0.8125rem] leading-[18px] text-dim">
              {firstDay
                ? "Prices are kept once a day, so the line starts tomorrow."
                : "No prices were kept in this range. A longer range draws the line."}
            </p>
          )}
        </div>
      )}

      {layout.rail !== null && layout.list !== null && (
        <RailList
          rect={layout.list}
          rows={layout.railRows}
          view={view}
          split={split}
          at={at}
          chosen={chosen}
          currency={currency}
          rowHandlers={rowHandlers}
          rowFigure={rowFigure}
          foot={`${marketplace.label} prices${markersOn ? " · ◇ collection changes" : ""}`}
        />
      )}

      {layout.rail === null && layout.list !== null && (
        <div
          role="group"
          aria-label="Line to follow"
          className="absolute grid content-start gap-x-2 gap-y-[3px] overflow-hidden"
          style={{
            ...place(layout.list),
            gridTemplateColumns: `repeat(${layout.listColumns}, minmax(0, 1fr))`,
          }}
        >
          {view.series.map((s) => (
            <BucketRow
              key={s.key}
              series={s}
              pressed={s.key === chosen}
              handlers={rowHandlers(s.key)}
              figure={rowFigure(s.key)}
            />
          ))}
        </div>
      )}

      {layout.strip !== null && (
        <Strip
          rect={layout.strip}
          series={view.series}
          chosen={chosen}
          handlers={rowHandlers}
        />
      )}
    </div>
  );
}

/** The figure line: the collection's value and its change, and — on a panel or a band — the
 *  followed line beside it. In the rail it heads the list, a size down. `WidgetFigures`' look,
 *  drawn here because a figure there carries no chip and no pip. */
function FigureBlock({
  rect,
  fit,
  inRail,
  label,
  readout,
  withChange,
  note,
  second,
  withSecondChange,
}: {
  rect: Rect;
  fit: WidgetFit;
  inRail: boolean;
  label: string;
  readout: Readout;
  withChange: boolean;
  note: string | null;
  second: { fill: string; label: string; value: string; change: string; up: boolean } | null;
  withSecondChange: boolean;
}): ReactElement {
  const line = fit.tier >= 2 ? "h-7" : "h-6";
  const big = fit.tier >= 2 && !inRail;
  const chip = withChange ? (
    <DeltaChip text={readout.total.change} up={readout.total.up} glyph />
  ) : null;
  const noteEl =
    note === null ? null : (
      <span className="min-w-0 truncate text-xs text-dim">{note}</span>
    );
  return (
    <div
      className="absolute flex flex-wrap content-start gap-x-3.5 gap-y-1.5 overflow-hidden border-b border-border"
      style={{ ...place(rect), paddingBottom: fit.compact ? 5 : 8 }}
    >
      <div className="min-w-0 flex-1 basis-[120px]">
        <div className="truncate text-xs leading-4 text-dim">{label}</div>
        {/* Clipped, with the note the one part that truncates: on a panel three cells wide the
            value, its note and its chip can outgrow the box, and a figure line that ran into the
            followed line beside it would be two figures printed over each other. */}
        <div className={cn("flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap", line)}>
          <span
            className={cn(
              "shrink-0 font-mono leading-[1.2] text-accent tabular-nums",
              big ? "text-[1.375rem]" : "text-[1.125rem]",
            )}
          >
            {readout.total.value}
          </span>
          {/* The note travels with the figure it qualifies — except in the narrow rail, where it
              goes last so the chip is not the one that gives way. */}
          {inRail ? (
            <>
              {chip}
              {noteEl}
            </>
          ) : (
            <>
              {noteEl}
              {chip}
            </>
          )}
        </div>
      </div>
      {second !== null && (
        <div className="min-w-0 flex-1 basis-[120px]">
          <div className="flex items-center gap-[5px] text-xs leading-4 text-dim">
            <Pip fill={second.fill} small />
            <span className="min-w-0 truncate">{second.label}</span>
          </div>
          <div className={cn("flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap", line)}>
            <span className="shrink-0 font-mono text-base text-text tabular-nums">{second.value}</span>
            {withSecondChange && <DeltaChip text={second.change} up={second.up} small />}
          </div>
        </div>
      )}
    </div>
  );
}

/** A row of chips that picks one of several — a registry pick, pressed where it is on. */
function ChipGroup({
  label,
  options,
  on,
  onPick,
  square = false,
}: {
  label: string;
  options: { id: string; text: string; aria?: string; hint?: string }[];
  on: string;
  /** Absent in a still or editing body: the chips are drawn and press nothing. */
  onPick: ((id: string) => void) | undefined;
  /** The measure's one-glyph chips hold a width, so `$` and `%` read as a pair. */
  square?: boolean;
}): ReactElement {
  const tip = useTooltip();
  return (
    <div role="group" aria-label={label} className="flex shrink-0 gap-1">
      {options.map((option) => {
        const pressed = option.id === on;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={pressed}
            aria-label={option.aria}
            {...(option.hint === undefined ? {} : tip(option.hint))}
            onClick={onPick === undefined ? undefined : () => onPick(option.id)}
            className={cn(CHIP, pressed ? CHIP_ON : CHIP_OFF, square && "min-w-[30px]")}
          >
            {option.text}
          </button>
        );
      })}
    </div>
  );
}

/** One line to follow: its pip, its name and its figure — a press pins it, a hover previews it. */
function BucketRow({
  series,
  pressed,
  handlers,
  figure,
}: {
  series: Series;
  pressed: boolean;
  handlers: RowHandlers;
  figure: ReactElement | null;
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      {...handlers}
      className={cn(ROW, pressed ? ROW_ON : ROW_OFF)}
    >
      <Pip fill={series.fill} />
      <span className="min-w-0 flex-1 truncate text-[0.8125rem] leading-[18px] font-medium">
        {series.label}
      </span>{" "}
      {figure}
    </button>
  );
}

/** A row that states a figure — the `N more` fold, and Total's facts. */
function PlainRow({
  label,
  value,
  caption,
  chip,
}: {
  label: string;
  value: string;
  caption?: string;
  /** Draw the value on a gain or loss chip. */
  chip?: boolean;
}): ReactElement {
  const up = !value.startsWith("−");
  return (
    <div className={PLAIN_ROW}>
      <span className="min-w-0 flex-1 truncate text-[0.8125rem] leading-[18px] text-dim">
        {label}
      </span>{" "}
      {chip === true ? (
        <DeltaChip text={value} up={up} small />
      ) : (
        <span className="shrink-0 font-mono text-[0.78125rem] text-text tabular-nums">{value}</span>
      )}
      {caption !== undefined && (
        <>
          {" "}
          <span className="shrink-0 text-[0.6875rem] text-dim">{caption}</span>
        </>
      )}
    </div>
  );
}

/**
 * The rail's list: the lines to follow, cut to the whole rows it has with the tail folded into one
 * `N more` row — or, on Total, the range's own figures: the change, the part prices moved and the
 * part the reader did, and the high and the low. A one-line footer names the marketplace where
 * there is room under the rows.
 */
function RailList({
  rect,
  rows,
  view,
  split,
  at,
  chosen,
  currency,
  rowHandlers,
  rowFigure,
  foot,
}: {
  rect: Rect;
  rows: number;
  view: HistoryView;
  split: ValueSplit;
  at: number;
  chosen: string;
  currency: Currency;
  rowHandlers: (key: string) => RowHandlers;
  rowFigure: (key: string) => ReactElement | null;
  foot: string;
}): ReactElement {
  let drawn: ReactElement[];
  if (split !== "total") {
    const series = view.series;
    const cut = series.length > rows ? Math.max(0, rows - 1) : series.length;
    const rest = series.slice(cut);
    drawn = series.slice(0, cut).map((s) => (
      <BucketRow
        key={s.key}
        series={s}
        pressed={s.key === chosen}
        handlers={rowHandlers(s.key)}
        figure={rowFigure(s.key)}
      />
    ));
    if (rest.length > 0 && rows > 0) {
      const sum = rest.reduce((total, s) => total + (s.values[at] ?? 0), 0);
      drawn.push(
        <PlainRow key="more" label={`${count(rest.length)} more`} value={formatPrice(sum, currency)} />,
      );
    }
  } else {
    drawn = totalFacts(view, at, currency).slice(0, rows);
  }
  const used = drawn.length === 0 ? 0 : drawn.length * ROW_PITCH - 3;
  return (
    <>
      <div
        role="group"
        aria-label={split === "total" ? "Figures" : "Line to follow"}
        className="absolute flex flex-col gap-[3px] overflow-hidden"
        style={{ left: rect.x, top: rect.y, width: rect.w, maxHeight: rect.h }}
      >
        {drawn}
      </div>
      {rect.h - used >= RAIL_FOOT && (
        <p
          className="absolute m-0 truncate text-xs leading-4 text-dim"
          style={{ left: rect.x, top: rect.y + rect.h - 16, width: rect.w }}
        >
          {foot}
        </p>
      )}
    </>
  );
}

/** Total's rail: the change over the range to the hovered day, split into what the reader did and
 *  what prices did — the two sum to it exactly, because the second is the first less the other —
 *  and the range's high and low. */
function totalFacts(view: HistoryView, at: number, currency: Currency): ReactElement[] {
  const n = view.days.length;
  const change = n > 0 ? view.totals[at] - view.totals[0] : 0;
  let collection = 0;
  for (let i = 1; i <= at; i++) collection += collectionChange(view, i);
  const prices = change - collection;
  let high = 0;
  let low = 0;
  for (let i = 1; i < n; i++) {
    if (view.totals[i] > view.totals[high]) high = i;
    if (view.totals[i] < view.totals[low]) low = i;
  }
  const when = (i: number) => (view.days[i] === view.today ? "today" : formatDay(view.days[i], "short"));
  return [
    <PlainRow key="change" label="Change" value={signed(change, currency)} chip />,
    <PlainRow key="prices" label="Price moves" value={signed(prices, currency)} chip />,
    <PlainRow
      key="collection"
      label="Collection changes"
      value={Math.round(Math.abs(collection) * 100) === 0 ? "none" : signed(collection, currency)}
    />,
    <PlainRow
      key="high"
      label="High"
      value={formatPrice(view.totals[high] ?? 0, currency)}
      caption={n > 0 ? when(high) : undefined}
    />,
    <PlainRow
      key="low"
      label="Low"
      value={formatPrice(view.totals[low] ?? 0, currency)}
      caption={n > 0 ? when(low) : undefined}
    />,
  ];
}

/**
 * A strip of line names under the chart — as many whole names as fit, and `+N` for the rest.
 * Widths are estimated at a little over the face's advance, so an estimate that errs drops a name
 * rather than clipping one.
 */
function Strip({
  rect,
  series,
  chosen,
  handlers,
}: {
  rect: Rect;
  series: readonly Series[];
  chosen: string;
  handlers: (key: string) => RowHandlers;
}): ReactElement {
  // Pulled 6px left so the first pip lines up with the text column above it.
  const budget = rect.w + 6 - 30;
  let spent = 0;
  const shown: Series[] = [];
  for (const s of series) {
    // Padding, the pip, the gap, the name at 12px, the border and the strip's own gap.
    const wide = 6 + 7 + 5 + s.label.length * 6.4 + 6 + 2 + 2;
    if (spent + wide > budget) break;
    spent += wide;
    shown.push(s);
  }
  const more = series.length - shown.length;
  return (
    <div
      role="group"
      aria-label="Line to follow"
      className="absolute flex items-center gap-0.5 overflow-hidden"
      style={{ left: rect.x - 6, top: rect.y, width: rect.w + 12, height: rect.h }}
    >
      {shown.map((s) => {
        const pressed = s.key === chosen;
        return (
          <button
            key={s.key}
            type="button"
            aria-pressed={pressed}
            {...handlers(s.key)}
            className={cn(LEG, pressed ? LEG_ON : LEG_OFF)}
          >
            <Pip fill={s.fill} small />
            {s.label}
          </button>
        );
      })}
      {more > 0 && <span className="px-1.5 text-xs whitespace-nowrap text-dim">+{more}</span>}
    </div>
  );
}
