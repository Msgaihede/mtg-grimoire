/**
 * The Price movers widget's popup: one owned printing's price over a range, beside the card it is
 * the price of (issue #515).
 *
 * **Mounted once at `App` level and opened by a store field**, `priceHistory` — the card modal's
 * arrangement, for the home grid's reason: the grid spends the reader's zoom as a CSS `zoom` on its
 * box, `zoom` is inherited whatever a descendant's `position`, and a dialog is chrome that belongs at
 * the app's scale rather than the dashboard's (`App.tsx` carries the whole argument at the mount).
 * So the widget row writes the request and this reads it from out here, and nothing here takes a
 * prop.
 *
 * ## It is drawn in the card details popup's shape, on purpose and in its parts
 *
 * The reader asked for the preview to *look like the card details popup*, and a resemblance is N
 * independent decisions that happen to agree today (`src/CLAUDE.md`, on `Dialog`). So the pieces
 * are the modal's own rather than lookalikes: the left column **is** `CardModalArt` — the frame,
 * the chin, the view controls and the per-finish price cells — the heading is the modal's `Title`,
 * the footer buttons are `actionButtons.ts`' two strings, the ceiling is its `PANEL_MAX_H`, and
 * the credit is its `artistOf`. What is this file's own is the right-hand column: the range, the
 * figures, where today sits, and the line.
 *
 * ## Money
 *
 * Every figure is quoted at the marketplace the reader picked, with that id in **both** query
 * keys, so a switch re-reads the card and the history together. Money is the accent and a move is
 * a *fill* — `WidgetParts.tsx`'s two rules, carried over from the row this opened from so the
 * popup and the row agree about what gold and green mean.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { TrendingDown, TrendingUp } from "lucide-react";

import { Dialog } from "@/components/Dialog";
import { ACTION, ACTION_PRIMARY } from "@/features/card/actionButtons";
import { cardDetailKey } from "@/features/card/cardDetailKey";
import { artistOf, PANEL_MAX_H, Title } from "@/features/card/CardDetailModal";
import { CardModalArt } from "@/features/card/CardModalArt";
import { openMarketplaceForCard } from "@/features/card/openMarketplace";
import { plural } from "@/lib/counts";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import {
  ipc,
  ipcError,
  type CardDetail,
  type PriceHistory,
  type PriceMoverWindow,
} from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { PRESS } from "@/lib/motion";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useAppStore, type PriceHistoryRequest } from "@/lib/store";
import { finishTreatments, treatmentName } from "@/lib/treatment";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";

import { priceHistoryKey } from "../keys";
import { DOWN_FILL, UP_FILL } from "../WidgetParts";
import { widgetMeta } from "../widgets";
import { signedMoney } from "../widgets/PriceMoversWidget";

import { PriceChart } from "./PriceChart";
import {
  formatDay,
  rangePhrase,
  rangeSeries,
  rangeStats,
  signedPercent,
  type ChartPoint,
  type RangeStats,
} from "./priceAnalytics";

/**
 * The panel's size per rung — `CardDetailModal`'s `PANEL_SIZE` with its third column taken out.
 *
 * **Viewport queries, all of them `min-[…]`, for that constant's two reasons**: `Dialog`'s
 * `container` puts `@container/card` on this same element, so a container query here would be the
 * panel asking its own width to decide its own width; and a named `sm:` beside arbitrary
 * `min-[…]`s is emitted in a later group and silently wins at every width.
 *
 * **The same two rungs the art column folds at, and the same art widths**: `18.75rem` from 640 and
 * `20rem` from 900, so the picture is the size it is in the card modal at the same window.
 *
 * * **640: `47.75rem`, the card modal's own 640 width.** That rung is two columns in both popups
 *   (the modal puts its rail under the middle column there), so the two draw one panel.
 * * **900: `58rem` rather than the modal's `66.25rem`**, because there is no rail. The modal's
 *   third track is `minmax(11rem, max-content)` plus a gap and a `pl-5` rule — about 13.5rem —
 *   and what is left after the 20rem art, the gutter and the padding is **~34rem (≈546px)** for the
 *   figures and the line: two figure cells at ~265px each, which holds `$1,234.56` beside a date
 *   without truncating, and a month of daily points at ~18px apiece. Wider buys a chart with more
 *   air and no more information.
 * * **No 1200 rung.** The modal's 23.5rem art column is reached by a 77.5rem panel; a two-column
 *   price popup that wide is ~48rem of chart for thirty points.
 *
 * **The heights are the modal's floors**, `min(…,80vh,825px)` at each rung — the height is what
 * sizes the picture (`CardModalArt`'s sizer fits the card to the row), so the same floor is what
 * draws the same card. `h-auto` lets a taller column grow the panel up to {@link PANEL_MAX_H}, the
 * modal's ceiling, imported rather than respelled.
 */
const PANEL_SIZE =
  "w-full h-full " +
  "min-[640px]:w-[47.75rem] min-[640px]:h-auto min-[640px]:min-h-[min(52.5rem,80vh,825px)] " +
  "min-[900px]:w-[58rem] min-[900px]:min-h-[min(47.5rem,80vh,825px)] " +
  PANEL_MAX_H;

/**
 * The three ranges, **in the widget's own words**.
 *
 * Read off the registry's `window` pick rather than spelled here, because the switch below and the
 * widget's settings popover are one question asked in two places — a reader who picked `30 days`
 * there must meet `30 days` here, not `30D`. The order is the pick's, which is shortest first.
 */
const RANGES: readonly { id: PriceMoverWindow; label: string }[] = (() => {
  const pick = widgetMeta("priceMovers").picks.find((p) => p.key === "window");
  const ids: readonly PriceMoverWindow[] = ["7d", "30d", "all"];
  return ids.map((id) => ({
    id,
    label: pick?.options.find((option) => option.id === id)?.label ?? rangePhrase(id),
  }));
})();

/**
 * The sentence a printing with no remembered days is answered with. It says *not yet* rather than
 * *nothing moved* — the widget's own two-sentence rule, one printing narrower: the first refresh
 * after install has no yesterday to compare with, and that heals by itself.
 */
export const NO_HISTORY_SENTENCE =
  "No price history for this copy yet. Prices are remembered from each refresh, and a trend will show here once there are a few days to draw.";

/**
 * What this copy is called: the treatment's word where the printing has one (`Surge Foil`), the
 * finish's otherwise — the same fence `CardModalArt`'s price cells draw their label through, so the
 * subtitle and the cell beside the picture name the copy the same way.
 */
function copyWord(card: CardDetail | null, finish: Finish): string {
  if (card === null) return FINISH_LABEL[finish];
  return treatmentName(finishTreatments(card.promoTypes, finish)) ?? FINISH_LABEL[finish];
}

export function PriceHistoryDialog(): ReactElement {
  const request = useAppStore((s) => s.priceHistory);
  const closePriceHistory = useAppStore((s) => s.closePriceHistory);
  const { marketplace } = useMarketplace();

  /**
   * The request the panel is *drawing*, which outlives the flag by the length of the exit —
   * `CardDetailModal`'s `shown`, for its reason: `Dialog` keeps the panel mounted while it fades
   * and `open` is already false on the render that starts the fade, so a body drawn straight off
   * the store would blank the popup for the whole of its own exit. It only ever moves to a
   * non-null request, and it is written during render rather than in an effect so no frame shows
   * the last card under the new one's name.
   */
  const [shown, setShown] = useState(request);
  if (request !== null && request !== shown) setShown(request);

  const card = useQuery({
    // **The card modal's own entry** — see `cardDetailKey`. Pressing *Open card details* is then
    // a cache read, and a card already opened in the modal paints here without a round trip.
    queryKey: cardDetailKey(shown?.cardId ?? null, marketplace.id),
    queryFn: shown === null ? skipToken : () => ipc.cardDetail(shown.cardId, marketplace.id),
  });
  const detail = card.data ?? null;

  /**
   * Whatever had the caret when the popup opened — the widget row, almost always. Written by
   * {@link Body}'s mount effect, which runs before `Dialog`'s own focus effect takes the caret, and
   * handed back on Escape and the ✕ exactly as the card modal hands back its opener. A press on
   * the scrim does not: the reader has already moved on (`src/CLAUDE.md`'s rule for every layer).
   */
  const openerRef = useRef<HTMLElement | null>(null);
  const dismiss = () => {
    const opener = openerRef.current;
    closePriceHistory();
    if (opener?.isConnected) opener.focus();
  };

  return (
    <Dialog
      open={request !== null}
      // The card modal's panel — it puts `@container/card` on the panel, which is what every
      // `@min-[…]/card:` class in `CardModalArt`, `Title` and the footer buttons is asking about.
      container
      size={PANEL_SIZE}
      title={
        <>
          {/* **The heading is the card, and this says which popup about the card it is.** The eye
              has the subtitle and the line for that; a screen reader meeting two dialogs both
              named "Lightning Bolt" — this one, and the card modal its footer opens — would have
              nothing. An `sr-only` sibling rather than `ariaLabel`, so the name still comes from
              the words on screen, and a space *between* the two elements rather than inside the
              first, because the name computation trims each element's contribution. */}
          <span className="sr-only">Price history of</span>{" "}
          <Title card={detail} pending={card.isPending} />
        </>
      }
      subtitle={
        shown === null
          ? undefined
          : [
              detail?.setCode.toUpperCase(),
              copyWord(detail, shown.finish),
              `${marketplace.label} prices`,
            ]
              .filter((part) => part !== undefined)
              .join(" · ")
      }
      closeLabel="Close price history"
      onDismiss={dismiss}
      onClose={closePriceHistory}
    >
      {/* **Keyed on the request**, so a new question starts clean — the face, and the range seeded
          from the widget's own window — without an effect and without a render-phase reset. */}
      {shown !== null && (
        <Body
          key={`${shown.cardId}:${shown.finish}:${shown.window}`}
          request={shown}
          card={detail}
          pending={card.isPending}
          error={card.isError ? ipcError(card.error) : null}
          openerRef={openerRef}
        />
      )}
    </Dialog>
  );
}

function Body({
  request,
  card,
  pending,
  error,
  openerRef,
}: {
  request: PriceHistoryRequest;
  card: CardDetail | null;
  pending: boolean;
  error: string | null;
  openerRef: React.RefObject<HTMLElement | null>;
}): ReactElement {
  const { marketplace, currency } = useMarketplace();
  const closePriceHistory = useAppStore((s) => s.closePriceHistory);
  const openCardAsFinish = useAppStore((s) => s.openCardAsFinish);
  const setSelectedCardId = useAppStore((s) => s.setSelectedCardId);
  const showSetInSearch = useAppStore((s) => s.showSetInSearch);

  /** Which face the picture is of. The body is keyed on the request, so a new card starts on 0. */
  const [face, setFace] = useState(0);
  /** The range on screen, seeded from the widget's window — the span the reader was looking at. */
  const [range, setRange] = useState<PriceMoverWindow>(request.window);

  // The opener, stashed once — `CardDetailModal`'s own guard, for its reasons: never `<body>`, and
  // never something inside a dialog (StrictMode's second mount pass runs after `Dialog` has
  // already taken the caret into this panel).
  useMountOpener(openerRef);

  const history = useQuery({
    queryKey: priceHistoryKey(request.cardId, request.finish, marketplace.id),
    queryFn: () => ipc.priceHistory(request.cardId, request.finish, marketplace.id),
  });

  const artist = card === null ? null : artistOf(card, face, null);

  return (
    // The flex column `Dialog`'s panel expects a body to be. `flex-auto` rather than `flex-1`, for
    // `CardDetailModal`'s measured reason: a zero basis reports no content height, and the panel's
    // `h-auto` would then sit at its floor at every window size.
    <div className="flex min-h-0 flex-auto flex-col">
      {error !== null && (
        <p role="alert" className="mx-5 mt-3 text-sm text-destructive">
          Could not read this card — {error}
        </p>
      )}
      {!pending && error === null && card === null && (
        <p className="mx-5 mt-3 text-sm text-dim">
          This printing is not in the card database any more. It may have been removed by the last
          sync.
        </p>
      )}

      {card !== null && (
        <div
          className={cn(
            // **The card modal's Body grid, less its third column.** One scroller below the fold,
            // where the grid is the scroller and the columns are not.
            "scrollbar-slim grid min-h-0 flex-auto grid-cols-1 gap-5 overflow-y-auto p-5",
            // At and above it the grid stops scrolling and each column starts. One explicit
            // `minmax(0,1fr)` row, because an implicit row is `auto` and sizes to its content —
            // the columns' `overflow-y-auto` would have every pixel it asked for and never scroll.
            "@min-[640px]/card:grid-rows-[minmax(0,1fr)] @min-[640px]/card:overflow-y-visible",
            // The modal's art widths at the modal's rungs, so the picture is the modal's picture.
            "@min-[640px]/card:grid-cols-[18.75rem_1fr]",
            "@min-[900px]/card:grid-cols-[20rem_1fr]",
          )}
        >
          <div
            // The modal's art-column wrapper, character for character: a flex column with a
            // definite height is what `CardModalArt`'s fit-to-height sizer fits the card into. It
            // never scrolls and is never clipped — a card mid-quarter-turn is wider than its box.
            className="min-w-0 @min-[640px]/card:flex @min-[640px]/card:min-h-0 @min-[640px]/card:flex-col"
          >
            <CardModalArt
              key={card.id}
              card={card}
              face={face}
              onFlip={() => setFace((f) => (f === 0 ? 1 : 0))}
              marketplace={marketplace}
              // No deck behind this popup, so the foil control is a *view* and says so.
              deckRow={null}
              // The copy the row was about: a foil mover opens on the foil sheen.
              openedAs={request.finish}
              // A view change and nothing else — there is no row here for it to write to.
              onToggleFoil={() => {}}
              // No meld read: the chart is one printing's price, and a meld view would swap the
              // picture for a card this line is not about. `[]` draws no meld controls at all.
              meld={{
                relations: [],
                melded: null,
                onMeld: () => {},
                onOpen: (id) => {
                  closePriceHistory();
                  setSelectedCardId(id);
                },
              }}
              // A navigation: the popup is a question about a home-page row, so it goes with the
              // page (`setActiveView` clears it too — this says so rather than relying on it).
              onShowSet={(code) => {
                closePriceHistory();
                showSetInSearch(code);
              }}
            />
          </div>

          <div
            className={cn(
              // **`relative` because this box scrolls** — `src/CLAUDE.md`'s phantom-scrollbar
              // rule: the range bar's sentence is `sr-only`, which is `position: absolute`.
              "relative flex min-w-0 flex-col gap-4",
              "scrollbar-slim @min-[640px]/card:min-h-0 @min-[640px]/card:overflow-y-auto",
            )}
          >
            <RangeSwitch value={range} onChange={setRange} />
            <HistoryFigures
              history={history.data ?? null}
              pending={history.isPending}
              error={history.isError ? ipcError(history.error) : null}
              range={range}
              currency={currency}
              chartName={`${copyWord(card, request.finish)} ${card.name} at ${marketplace.label}`}
            />
          </div>
        </div>
      )}

      {/* The card modal's footer, arranged exactly as it is: the two footnotes in the left corner
          as a `flex-1` item that can never push the buttons onto a second line, and the presses on
          the right. Outside the scrollers, so the way on is never somewhere to scroll to. */}
      <div className="shrink-0 border-t border-border px-5 py-3">
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 text-[0.7rem] leading-relaxed text-dim">
            {/* **Required wherever art is shown** — Scryfall's usage rule, and `artistOf` is the
                modal's one answer for whose name goes under the picture on screen. */}
            {card !== null && (
              <p>
                {artist !== null && <>Illustrated by {artist}. </>}
                Card images © Wizards of the Coast · Data © Scryfall
              </p>
            )}
            {/* Spec §5: a price is never shown without saying how old it is and whose it is — and
                every figure in this popup is a price, so the line is unconditional. */}
            <p>{pricesAsOf(marketplace)}</p>
          </div>

          <div className="flex w-full flex-wrap items-center justify-end gap-2 @min-[640px]/card:w-auto">
            <button
              type="button"
              // This popup closes and the card modal opens on the same copy — `openCardAsFinish`,
              // so a foil mover opens on the foil sheen there too.
              onClick={() => {
                closePriceHistory();
                openCardAsFinish(request.cardId, request.finish);
              }}
              className={cn(ACTION, PRESS, FOCUS)}
            >
              Open card details
            </button>
            <button
              type="button"
              // Out of reach only for the length of the card read: the name search the helper
              // falls back to needs the card's name.
              disabled={card === null}
              onClick={() => {
                if (card === null) return;
                // `void` rather than a `catch`, as `CardModalRail`'s row does: every way the exact
                // page cannot be had already falls back to the name search inside the helper.
                void openMarketplaceForCard({
                  marketplace,
                  cardId: request.cardId,
                  cardName: card.name,
                  finish: request.finish,
                  finishes: card.finishes,
                });
              }}
              className={cn(ACTION_PRIMARY, "disabled:opacity-40", PRESS, FOCUS)}
            >
              Open on {marketplace.label}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Stash whatever held the caret when the body mounted, into the host's ref.
 *
 * **This runs before `Dialog`'s own focus effect, and that ordering is the mechanism**: React runs
 * a child's effects before its parent's, and the body is rendered inside the panel whose mount
 * effect takes the caret — so `document.activeElement` is still the row the reader pressed. An
 * effect rather than a render-time write, because a render may be thrown away; nothing is set in
 * React state, only a ref.
 */
function useMountOpener(openerRef: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active === null || active === document.body) return;
    if (active.closest('[role="dialog"]') !== null) return;
    openerRef.current = active;
  }, [openerRef]);
}

/**
 * **7 days · 30 days · All time**, one of them always on.
 *
 * A real radio group rather than three toggles: exactly one range is true at a time, and
 * `aria-checked` is the only thing that says which to a reader who cannot see the fill.
 *
 * **Every range is a Tab stop, as in the app's other button radio groups** (`NoteCardsDialog`,
 * `TheoryDiffDialog`, `ExportDialog`), and the arrows move the choice as well. Not a roving
 * `tabIndex`: `trapTab` counts every `<button>` in the panel as a stop whatever its `tabIndex`, so
 * a roving group is a list that disagrees with the trap's — harmless in the middle of the panel,
 * and the silent Tab-out-of-an-`aria-modal` bug that file documents the day the group is first or
 * last.
 *
 * **Drawn as the deck editor's `Theory | Actual` switch** — one bordered, clipped group, the
 * pressed half filled — because it is the same kind of control: a choice of which one thing the
 * panel below is about. Two things follow from the clip. The focus mark is `FOCUS_INSET`, since an
 * outset outline on a segment is drawn outside a box that clips it; and there is no `PRESS` dip,
 * since a segment scaling inside a rounded, clipped group pulls its edges off the border it shares.
 * 44px below the card's 640 fold and 36px above it, `CardModalArt`'s control heights, so the row
 * matches the view controls under the picture beside it.
 */
function RangeSwitch({
  value,
  onChange,
}: {
  value: PriceMoverWindow;
  onChange: (next: PriceMoverWindow) => void;
}): ReactElement {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const step = (from: number, by: number) => {
    const next = (from + by + RANGES.length) % RANGES.length;
    onChange(RANGES[next].id);
    buttons.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Price history range"
      className="flex w-fit shrink-0 overflow-hidden rounded-md border border-border"
    >
      {RANGES.map((option, i) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                step(i, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                step(i, -1);
              }
            }}
            className={cn(
              "h-11 px-3 text-xs @min-[640px]/card:h-9",
              "transition-colors duration-[var(--duration-fast)] ease-standard motion-reduce:transition-none",
              on ? "bg-accent font-medium text-accent-fg" : "text-dim hover:text-text",
              FOCUS_INSET,
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A figure cell — `CardModalArt`'s price cell, class for class, so the figures on the right and
 * the prices under the picture read as one panel rather than two components side by side.
 */
function Cell({
  label,
  wide = false,
  children,
}: {
  label: string;
  /** Across both columns — for a figure whose value is a phrase or a drawing, not a number. */
  wide?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className={cn("min-w-0 rounded-md border border-border px-2.5 py-1.5", wide && "col-span-2")}
    >
      <dt className="truncate text-xs text-dim">{label}</dt>
      {children}
    </div>
  );
}

/** A cell's value line, in the data face — the price cell's `dd`. */
const VALUE = "truncate font-mono text-sm tabular-nums";

/**
 * Everything the history says: the figures, where today sits, and the line — or the one sentence
 * that stands in for them.
 */
function HistoryFigures({
  history,
  pending,
  error,
  range,
  currency,
  chartName,
}: {
  history: PriceHistory | null;
  pending: boolean;
  error: string | null;
  range: PriceMoverWindow;
  currency: Currency;
  /** Which copy at which marketplace, for the chart's one sentence: `Foil Lightning Bolt at TCGplayer`. */
  chartName: string;
}): ReactElement {
  // Memoised on the answer and the range, so the chart is handed the same array across renders
  // that change neither — a range press is the only thing that should redraw the line.
  const series = useMemo(
    () => (history === null ? null : rangeSeries(history, range)),
    [history, range],
  );
  const stats = useMemo(
    () => (history === null ? null : rangeStats(history, range)),
    [history, range],
  );

  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not read price history — {error}
      </p>
    );
  }
  if (pending || history === null || series === null || stats === null) {
    return <p className="text-sm text-dim">Reading price history…</p>;
  }

  const money = (value: number) => formatPrice(value, currency);

  // **Nothing remembered yet** is its own answer and never *nothing moved*: the first refresh
  // after install has no yesterday to compare with. Today's price still stands if there is one.
  if (history.points.length === 0) {
    return (
      <>
        {stats.now !== null && (
          <dl className="grid grid-cols-2 gap-2">
            <Cell label="Now">
              <dd className={cn(VALUE, "text-accent")}>{money(stats.now)}</dd>
            </Cell>
          </dl>
        )}
        <p className="text-sm text-dim">{NO_HISTORY_SENTENCE}</p>
      </>
    );
  }

  return (
    <>
      <dl className="grid grid-cols-2 gap-2">
        <Cell label="Now">
          {/* Money is the accent — and this is the one gold figure, so it is the one read first. */}
          <dd className={cn(VALUE, "text-accent")}>
            {stats.now === null ? "—" : money(stats.now)}
          </dd>
        </Cell>
        <Cell label={`Change over ${rangePhrase(range)}`}>
          <ChangeValue stats={stats} range={range} currency={currency} />
        </Cell>
        {/* Low on the left and high on the right, the way the bar below runs. */}
        <Cell label="Low">
          <dd className={VALUE}>
            {stats.low === null ? "—" : <Dated price={money(stats.low.price)} day={stats.low.day} />}
          </dd>
        </Cell>
        <Cell label="High">
          <dd className={VALUE}>
            {stats.high === null ? (
              "—"
            ) : (
              <Dated price={money(stats.high.price)} day={stats.high.day} />
            )}
          </dd>
        </Cell>
        {stats.position !== null && stats.low !== null && stats.high !== null && stats.now !== null && (
          <Cell label={`Range over ${rangePhrase(range)}`} wide>
            <RangeBar
              position={stats.position}
              low={money(stats.low.price)}
              high={money(stats.high.price)}
              now={money(stats.now)}
              range={range}
            />
          </Cell>
        )}
        <Cell label="Tracked since" wide>
          <dd className={VALUE}>
            {stats.trackedSince === null ? (
              "—"
            ) : (
              <>
                {formatDay(stats.trackedSince, "long")}{" "}
                <span className="font-sans text-xs text-dim">
                  · {plural(stats.trackedDays, "day")} of prices
                </span>
              </>
            )}
          </dd>
        </Cell>
      </dl>

      {series.points.length >= 2 ? (
        <PriceChart
          points={series.points}
          currency={currency}
          summary={chartSummary(chartName, range, series.points, stats, money)}
        />
      ) : (
        <p className="text-sm text-dim">
          Not enough history to draw a line yet — it needs two days of prices.
        </p>
      )}
    </>
  );
}

/** A price with the day it was seen, the day dim and in the text face. */
function Dated({ price, day }: { price: string; day: number }): ReactElement {
  return (
    <>
      {price} <span className="font-sans text-xs text-dim">{formatDay(day, "short")}</span>
    </>
  );
}

/**
 * The move, as `WidgetRow` draws one: body ink on a tinted chip, with the green or red spent on
 * the fill and on the glyph beside it — **never on the ink**, which reads 3.3:1 at this size.
 */
function ChangeValue({
  stats,
  range,
  currency,
}: {
  stats: RangeStats;
  range: PriceMoverWindow;
  currency: Currency;
}): ReactElement {
  if (stats.change === null) {
    return (
      <>
        <dd className={VALUE}>—</dd>
        {/* Not *nothing moved*: the history does not reach back that far yet, which heals by
            itself as refreshes happen. A second `dd`, because a `dl`'s cell holds nothing else. */}
        <dd className="truncate text-xs text-dim">
          {range === "all"
            ? "Not enough history yet"
            : `Not enough history for ${rangePhrase(range)} yet`}
        </dd>
      </>
    );
  }
  if (stats.change === 0) {
    return <dd className={VALUE}>No change</dd>;
  }
  const up = stats.change > 0;
  const Glyph = up ? TrendingUp : TrendingDown;
  const fill = up ? UP_FILL : DOWN_FILL;
  return (
    <dd className={cn(VALUE, "flex items-center gap-1.5")}>
      <Glyph aria-hidden="true" className="size-3.5 shrink-0" style={{ color: fill }} />
      <span
        className="min-w-0 truncate text-text"
        style={{
          borderRadius: 4,
          padding: "1px 5px",
          background: `color-mix(in oklab, ${fill} 20%, transparent)`,
        }}
      >
        {signedMoney(stats.change, currency)}
        {stats.changePct !== null && <> · {signedPercent(stats.changePct)}</>}
      </span>
    </dd>
  );
}

/**
 * Where today sits between the range's low and its high — a stock app's *day's range*, drawn on
 * `WidgetRow`'s track colour with the accent marking today, because today's price is money.
 *
 * **The drawing is `aria-hidden` and one `sr-only` sentence says it**, the widget bars' rule: the
 * picture is decoration over figures that are already text in the cells above. The marker is
 * placed with `left`/`top` arithmetic rather than a translate, so it lands on the pixel grid.
 */
function RangeBar({
  position,
  low,
  high,
  now,
  range,
}: {
  position: number;
  low: string;
  high: string;
  now: string;
  range: PriceMoverWindow;
}): ReactElement {
  const pct = Math.round(position * 100);
  return (
    <dd>
      <span className="sr-only">
        Today&rsquo;s {now} is {pct}% of the way from the low of {low} to the high of {high} over{" "}
        {rangePhrase(range)}.
      </span>
      <span aria-hidden="true" className="mt-1 flex items-center gap-2.5">
        <span className="shrink-0 font-mono text-xs tabular-nums text-dim">{low}</span>
        <span className="relative h-1.5 min-w-0 flex-1 rounded-sm bg-surface">
          <span
            className="absolute size-2.5 rounded-full bg-accent ring-2 ring-bg"
            style={{ left: `calc(${pct}% - 5px)`, top: "calc(50% - 5px)" }}
          />
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-dim">{high}</span>
      </span>
    </dd>
  );
}

/**
 * The chart's one sentence — what the line says, for a reader who cannot see it: which copy,
 * where, over what; the first point and the last; the high and the low.
 */
function chartSummary(
  name: string,
  range: PriceMoverWindow,
  points: readonly ChartPoint[],
  stats: RangeStats,
  money: (value: number) => string,
): string {
  const first = points[0];
  const last = points[points.length - 1];
  const at = (p: ChartPoint) => (p.live ? "today" : `on ${formatDay(p.day, "short")}`);
  let sentence = `${name} over ${rangePhrase(range)}: from ${money(first.price)} ${at(first)} to ${money(last.price)} ${at(last)}`;
  if (stats.high !== null && stats.low !== null) {
    sentence +=
      `, a high of ${money(stats.high.price)} on ${formatDay(stats.high.day, "short")}` +
      ` and a low of ${money(stats.low.price)} on ${formatDay(stats.low.day, "short")}`;
  }
  return `${sentence}.`;
}
