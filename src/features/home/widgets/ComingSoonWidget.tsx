/**
 * Sets whose cards are previewed and not yet released — a row per set, soonest first — with how
 * many of their cards are out and how many of those the reader's decks already play.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the `Window` chip, the popover and the
 * Customize tray; this draws two figures and the rows, cut to the box `fit` describes — and in a
 * box too small for both and a row, the first figure alone ({@link layoutFor}).
 *
 * ## Over the corpus's own dates, counted in UTC
 *
 * `upcoming_sets` reads `cards` rather than `sets` — the browser build never fills `sets` — and
 * "today" is SQLite's `date('now')`, which is UTC and **travels back beside the list**
 * (`UpcomingSets.today`). Days are counted from that date and never from this machine's clock
 * ({@link daysUntil}): a reader west of Greenwich in the evening would otherwise read a set as a
 * day nearer than the read that found it, and one list would disagree with itself. Both dates are
 * parsed as `T00:00:00Z` and the release day in a row's hint is formatted with `timeZone: "UTC"`,
 * `NewPrintingsWidget`'s day formatters' rule and their reason: `releasedAt` is a calendar date,
 * and a formatter left on the local zone prints the day before it for everyone west of Greenwich.
 *
 * **A fold, never a sort**: the read answers soonest first, then by code, and re-ordering here would
 * be a second opinion about a question SQL has answered.
 *
 * ## Counts are body ink
 *
 * `Previewed so far` and `Reprints of your deck cards` are counts, so neither is gold —
 * `WidgetParts.tsx`'s rule that the accent is money. The second is the sum of `in_decks`, which is
 * `new_printings`' rule for "your decks": not virtual, live and theory rows, basics left out.
 *
 * ## A press shows the set
 *
 * `showSetInSearch(code)` is the view change and the hand-off in one store action, so no caller can
 * write them in the order that wipes the second — and the Search page answers it with
 * `useCardSearch`'s `showOnlySet`, which puts the format picker on `Any card`, so legality does not
 * hide a card that is not legal anywhere yet. **A row's `seen` is that search's own number** — the
 * set's paper printings, one per card, which is what `upcoming_sets` counts — so the row and the
 * page it opens say one figure. The live pass read `461 seen` over a search of `285 cards` for one
 * set (2026-09-26), before the read stopped counting showcase and borderless printings as cards.
 *
 * ## The face is its own component
 *
 * {@link ComingSoonFace} draws an answer and {@link ComingSoonWidget} reads one. The workbench's
 * `waiting` world answers three invented sets, one per window, so the body's own stories read
 * through the fake; the face is split out so a story can also draw an answer no world holds — five
 * sets across a whole row — without growing the fake's corpus for one picture.
 *
 * **No `@container` here or on the page that draws this**, and no z-index that is not from
 * `LAYER` — `fit.ts`'s module doc has the argument.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { count } from "@/lib/counts";
import { ipc, ipcError, type UpcomingSet, type UpcomingSets } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";

import { bodyGapPx, type WidgetFit } from "../fit";
import { upcomingSetsKey } from "../keys";
import {
  WidgetFigures,
  WidgetMessage,
  WidgetRow,
  WidgetRowList,
  type WidgetFigureItem,
} from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";
import { pickOf } from "../widgetSettings";

const DAY_MS = 86_400_000;

/**
 * The window a card reads when its stored one is not a number — the registry's `dflt`, which
 * `pickOf` already answers for everything but a kind whose pick is not numeric. Restated only so
 * the type narrows, `NewPrintingsWidget`'s `WINDOW_FALLBACK`.
 */
const WINDOW_FALLBACK = 90;

/** A row is a name over a caption, 51px — `SetCompletionWidget`'s `rowPx` sum. */
const ROW_PX = 51;
/** The figure line, comfortable and compact — `CollectionValueWidget`'s two numbers. */
const FIGURES_PX = 74;
const FIGURES_COMPACT_PX = 62;

/** `WidgetFigures`' box for one figure — `basis-[120px]` — and its `gap-x-3.5` between two. */
const FIGURE_BASIS_PX = 120;
const FIGURE_GAP_X_PX = 14;
/** `WidgetFigures`' `gap-y-1.5`: the space above a line the figures wrapped onto. */
const FIGURE_GAP_Y_PX = 6;
/**
 * One figure's height: a 16px `text-xs` label over a 1.125rem number at `leading-[1.2]` (21.6px),
 * rounded up. A wrapped line is always the small number — the 1.375rem one is drawn only from four
 * cells wide, which even at `CELL_MIN` is wider than two figures need to share a line.
 */
const FIGURE_PX = 38;

/**
 * The figure line's reservation, as this body draws it.
 *
 * **Two figures share a line only when the body is at least two bases and a gap wide** (254px). A
 * two-cell tile's body is narrower at every cell the grid draws — about 231px at the widest, eight
 * columns just short of a ninth — so its figures wrap and the line is two lines tall. Counted
 * against one line, the rows promise more than the tile has, and at compact density the last one
 * is cut by the card's edge (derived, not measured) — `SetCompletionWidget`'s `rowPx` failure, one
 * block up. **Asked of the body's width rather than of the tier**: `fit.ts`' rule that what fits
 * is pixels, and a three-cell card on cells under about 84px wraps as well.
 */
function figuresPx(fit: WidgetFit): number {
  const line = fit.compact ? FIGURES_COMPACT_PX : FIGURES_PX;
  const shared = fit.bodyWidthPx >= 2 * FIGURE_BASIS_PX + FIGURE_GAP_X_PX;
  return shared ? line : line + FIGURE_GAP_Y_PX + FIGURE_PX;
}

/**
 * What a body this size draws: both figures or only the first, and how many set rows.
 *
 * **Never a row the body cannot hold, at any footprint down to `CELL_MIN`.** Rows are counted with
 * `fitCount`, whose zero is a real answer, and never with `rowsFit`, which floors at one: that floor
 * drew a set row into a 2×2 on cells of ~100px or less and the body scrolled, 4–28px (the live pass,
 * 2026-09-26, 1100 and 1024px windows). Three answers, tried in order:
 *
 * 1. **Both figures and the rows that fit under them** — a 2×2 from 98px cells up compact and 105
 *    comfortable, and any box three or more cells tall at every cell the grid draws.
 * 2. **The first figure alone and the rows that fit under its one line** — a figure gives way to a
 *    row, because the rows are what the card presses into and the second figure is a total the
 *    wider boxes carry.
 * 3. **No row**, and both figures only where the two fit on their own — the reservation less the
 *    gap nothing follows. At `CELL_MIN` a 2×2 body is 96px comfortable and 98 compact, shorter than
 *    the two wrapped figures (101px measured), so there it is the first figure alone; a stacked 2×2,
 *    as wide as the canvas and as tall as that footprint, keeps both on one line.
 *
 * Every figure here is a reservation the live pass found to cover what is drawn, so no answer can
 * overflow.
 */
export function layoutFor(fit: WidgetFit): { figures: 1 | 2; rows: number } {
  const rows = (reserved: number) => fit.fitCount(ROW_PX, reserved) * fit.listColumns;
  const both = rows(figuresPx(fit));
  if (both > 0) return { figures: 2, rows: both };
  const one = rows(fit.compact ? FIGURES_COMPACT_PX : FIGURES_PX);
  if (one > 0) return { figures: 1, rows: one };
  const alone = figuresPx(fit) - bodyGapPx(fit.h, fit.compact);
  return { figures: alone <= fit.bodyHeightPx ? 2 : 1, rows: 0 };
}

const PENDING = "Looking for announced sets…";

/** A release day in words, in UTC — see the module doc. */
const RELEASE_DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** Whole days from the read's own `today` to a set's release — both UTC midnights, so a clock
 *  change is never an hour short of a day. */
export function daysUntil(today: string, releasedAt: string): number {
  return Math.round(
    (Date.parse(`${releasedAt}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
  );
}

/** `tomorrow`, `in 12 days`. `today` and `date unknown` are the read's contract failing, said
 *  plainly rather than as `in 0 days` or `in NaN days`. */
export function whenLabel(days: number): string {
  if (!Number.isFinite(days)) return "date unknown";
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** `TRK · in 12 days` — the two clauses that tell one set from another, and all a two-cell tile
 *  has room for. {@link setCaption} is this with the counts after it. */
export function shortCaption(set: UpcomingSet, today: string): string {
  return `${set.code.toUpperCase()} · ${whenLabel(daysUntil(today, set.releasedAt))}`;
}

/** A short caption with the counts after it — the last clause only when there is one. */
function withCounts(short: string, set: UpcomingSet): string {
  const parts = [short, `${count(set.previewed)} seen`];
  if (set.inDecks > 0) parts.push(`${count(set.inDecks)} in your decks`);
  return parts.join(" · ");
}

/** `TRK · in 12 days · 79 seen · 3 in your decks` — the last clause only when there is one. */
export function setCaption(set: UpcomingSet, today: string): string {
  return withCounts(shortCaption(set, today), set);
}

/** The window as the empty sentence says it: `90 days`, or `year` for the widest. */
export function windowWords(days: number): string {
  return days === 365 ? "year" : `${days} days`;
}

/** `Nothing announced for the next 90 days.` — the window's own words (spec §6.2). */
export function emptySentence(days: number): string {
  return `Nothing announced for the next ${windowWords(days)}.`;
}

/** The release day in words for a row's hint, or nothing for a date that does not parse. */
function releaseHint(set: UpcomingSet): string | undefined {
  const at = Date.parse(`${set.releasedAt}T00:00:00Z`);
  return Number.isFinite(at) ? `Releases ${RELEASE_DAY.format(new Date(at))}` : undefined;
}

/**
 * One answer, drawn: the empty sentence, or the figures over the rows — as many of each as
 * {@link layoutFor} says the box holds, down to the first figure alone and no row at all.
 *
 * **Rows flow into `fit.listColumns` columns** (`WidgetRowList`), and are cut to whole rows after
 * the figure line is reserved — two lines of it where the figures wrap ({@link figuresPx}). On a
 * two-cell tile the caption keeps the two clauses that tell sets apart — the code and the day
 * ({@link shortCaption}) — and drops the counts the figures already sum.
 */
export function ComingSoonFace({
  answer,
  days,
  fit,
  still,
}: {
  answer: UpcomingSets;
  days: number;
  fit: WidgetFit;
  still: boolean;
}): ReactElement {
  const showSetInSearch = useAppStore((s) => s.showSetInSearch);

  if (answer.sets.length === 0) return <WidgetMessage>{emptySentence(days)}</WidgetMessage>;

  const previewed = answer.sets.reduce((sum, set) => sum + set.previewed, 0);
  const inDecks = answer.sets.reduce((sum, set) => sum + set.inDecks, 0);
  const tile = fit.tier === 0;
  const layout = layoutFor(fit);
  const shown = answer.sets.slice(0, layout.rows);
  const figures: WidgetFigureItem[] = [
    {
      key: "previewed",
      label: "Previewed so far",
      value: count(previewed),
      note: "cards",
      tone: "text",
    },
    { key: "reprints", label: "Reprints of your deck cards", value: count(inDecks), tone: "text" },
  ];

  return (
    <>
      {/* The rule under the figures divides them from rows, so it is drawn only above some. */}
      <WidgetFigures
        fit={fit}
        divided={shown.length > 0}
        figures={figures.slice(0, layout.figures)}
      />
      {/* No list at all when no row fits: an empty one would still take the body's gap. */}
      {shown.length > 0 && (
        <WidgetRowList fit={fit} label="Announced sets">
          {shown.map((set) => {
            // The day counted once per set: the tile draws the short caption, and the press label
            // carries the whole one whatever the box is drawing.
            const short = shortCaption(set, answer.today);
            const caption = withCounts(short, set);
            return (
              <WidgetRow
                key={set.code}
                name={set.name}
                caption={tile ? short : caption}
                hint={releaseHint(set)}
                onPress={still ? undefined : () => showSetInSearch(set.code)}
                // The whole row in one string — a `gap` between the name and the caption computes
                // to "Horizon TrekTRK · in 12 days" (`DecksWidget`'s row press, and the same reason).
                pressLabel={still ? undefined : `${set.name} · ${caption}`}
              />
            );
          })}
        </WidgetRowList>
      )}
    </>
  );
}

export function ComingSoonWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  // The pick only ever answers one of its own options or its `dflt`, so a stored `"90"` or `9999`
  // reads as ninety here and never reaches the backend's clamp.
  const picked = pickOf(widget, "window");
  const days = typeof picked === "number" ? picked : WINDOW_FALLBACK;

  const query = useQuery({
    queryKey: upcomingSetsKey(days),
    queryFn: () => ipc.upcomingSets(days),
  });

  if (query.isError) {
    return (
      <WidgetMessage tone="destructive">
        Could not read what is announced — {ipcError(query.error)}
      </WidgetMessage>
    );
  }
  if (query.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;
  return <ComingSoonFace answer={query.data} days={days} fit={fit} still={still} />;
}
