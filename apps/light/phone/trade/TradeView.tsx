import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import {
  Archive,
  Check,
  ChevronLeft,
  Copy,
  Ellipsis,
  Plus,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { ConfirmDialog } from "@grimoire/ui/features/settings/ConfirmDialog";
import { TOUCH_FLOOR } from "@grimoire/ui/features/settings/controls";
import { BalanceBar } from "@grimoire/ui/features/trade/BalanceBar";
import {
  cardCount,
  isOpen,
  isSettled,
  lineMoney,
  linesOf,
  tradeMoney,
  type SideMoney,
} from "@grimoire/ui/features/trade/trade";
import {
  closedBanner,
  fullPriceNote,
  givenMark,
  printingLine,
  rateName,
  sideHeading,
  sideWords,
  tradeCurrency,
  unpricedNote,
} from "@grimoire/ui/features/trade/tradeWords";
import { useTrade, useTradeWrites } from "@grimoire/ui/features/trade/useTrades";
import { FOCUS, FOCUS_INSET } from "@grimoire/ui/lib/focus";
import { ipcError } from "@grimoire/ui/lib/ipc";
import type { Trade, TradeLine, TradeSide, TradeStatus } from "@grimoire/ui/lib/ipc";
import type { Currency } from "@grimoire/ui/lib/marketplace";
import { PRESS } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";
import { DimNote, ReadError } from "../pages/parts";
import { linkTo, navigate } from "../router";
import { AddCardsSheet } from "./AddCardsSheet";
import { EditLineSheet } from "./EditLineSheet";
import { FinishSheet } from "./FinishSheet";
import { MoreSheet } from "./MoreSheet";
import { BalanceFigure, GOLD_BUTTON, PLAIN_BUTTON, Refusal, Thumb, useOpener } from "./parts";
import { RateSheet } from "./RateSheet";
import { money } from "./text";
import { TRADES_PLACE, tradePlace } from "./TradeList";
import { TradeScan } from "./TradeScan";

/**
 * One trade: the reader's side and theirs as two columns, and what the difference comes to.
 *
 * **Read through `useTrade`, the desktop page's own query**, so a resize across the floor paints
 * the trade from the cache in either direction and a write either face makes refreshes it.
 *
 * The page's own header row carries the way back to the list — a link, since it changes the URL —
 * and it is drawn whatever the read answers, so a trade that is gone or would not load is never a
 * page with no way off it.
 *
 * **"Gone" is an answer, and a `null` that is being asked again is not one yet.** A trade's id is
 * handed out again once the trade is deleted (`useTrades.ts`), so the cache can hold "no such
 * trade" under the id of one made a moment ago; the page says nothing until the read in the air
 * has answered for the trade this place names *now*.
 */
export function TradeView({ tradeId }: { tradeId: number }) {
  const query = useTrade(tradeId);
  const trade = query.data;

  if (trade !== undefined && trade !== null) return <TradeBody trade={trade} />;
  return (
    <>
      <HeaderRow name={null} />
      {query.isLoadingError ? (
        // The read failed, which says nothing about the trade. "Gone" is the sentence below, for
        // a read that succeeded and answered no trade.
        <ReadError>That trade could not be read.</ReadError>
      ) : trade === null && !query.isFetching ? (
        <DimNote>That trade is gone.</DimNote>
      ) : null}
    </>
  );
}

/** The row under the title bar: back to the list, the trade's name, and what can be done to it. */
function HeaderRow({
  name,
  nameRef,
  children,
}: {
  name: string | null;
  /** The trade's name, as somewhere for the caret to land. See `TradeBody`. */
  nameRef?: Ref<HTMLHeadingElement>;
  children?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-1 py-1">
      <a
        {...linkTo(TRADES_PLACE)}
        aria-label="All trades"
        className={cn("flex size-11 shrink-0 items-center justify-center rounded-md text-dim", FOCUS)}
      >
        <ChevronLeft aria-hidden className="size-[1.375rem]" />
      </a>
      {/* Only once there is a name: an empty heading is a stop with nothing to hear at it. */}
      {name !== null ? (
        // A landing pad (`tabIndex={-1}`), so it carries no ring: nothing Tab reaches.
        <h2
          ref={nameRef}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate font-heading text-lg outline-none"
        >
          {name}
        </h2>
      ) : (
        <span className="flex-1" />
      )}
      {children}
    </div>
  );
}

/**
 * The header row's one worded press — `Archive`, or `Reopen` in its place. 36px beside a 44px
 * way back, as the canvas draws it, and the shared floor under a finger.
 */
const HEADER_BUTTON = cn(PLAIN_BUTTON, "h-9 shrink-0 px-3", TOUCH_FLOOR);

/** Which of the page's sheets is up. One at a time: each covers the page. */
type Sheet =
  | { kind: "add"; side: TradeSide }
  | { kind: "edit"; lineId: number }
  | { kind: "rate"; side: TradeSide }
  | { kind: "scan" }
  | { kind: "finish" }
  | { kind: "more" }
  | { kind: "delete" }
  | null;

/**
 * The trade itself, once it has answered.
 *
 * **Two columns at every width, and no container asks for them.** The trade *is* two lists side
 * by side — that is the picture of a trade — so there is no narrower arrangement to fall back to
 * and no query to pick one. The page's sheets are mounted inside it, and a box that was a
 * container would be the containing block for their `fixed` scrims (`apps/light/CLAUDE.md`).
 *
 * **Open, it is edited where it stands**: each line is a press that opens its sheet, each column
 * ends in `Add cards`, each column's percentage is a press, and the foot holds both totals, the
 * balance and `Finish trade`. Every write is `useTradeWrites`', made as it is pressed — a trade
 * has no Save — and a refusal is the backend's own sentence, drawn in the sheet that is up or,
 * with none up, above the totals.
 *
 * **Closed, it is a record**: no `Add cards`, lines that are text and not presses, and a note
 * saying which kind of closed it is — finished, with what the finish did and the columns headed
 * *You gave* / *They gave*, or put away without finishing, which touched nothing and so keeps the
 * present tense (`tradeWords.ts`, the desktop page's own sentences). `Reopen` stands where
 * `Archive` did and `Duplicate` where `Finish trade` did: the two things a record can still
 * become.
 */
function TradeBody({ trade }: { trade: Trade }) {
  const writes = useTradeWrites();
  const currency = tradeCurrency(trade);
  const figures = useMemo(() => tradeMoney(trade), [trade]);
  const live = isOpen(trade.status);
  const past = isSettled(trade.status);

  const [sheet, setSheet] = useState<Sheet>(null);
  const [scanSide, setScanSide] = useState<TradeSide>("theirs");
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The status a one-shot write was pressed on, until the page shows another. See {@link once}. */
  const [spent, setSpent] = useState<TradeStatus | null>(null);
  // Let go the moment the page shows another status, so the hold is about one press and cannot
  // come back when the trade later returns to the status it was pressed on.
  if (spent !== null && spent !== trade.status) setSpent(null);
  const busy = spent === trade.status;
  const opener = useOpener();
  const nameRef = useRef<HTMLHeadingElement>(null);
  /** Counts the times the caret is owed to the trade's name. See {@link land}. */
  const [landed, setLanded] = useState(0);

  // Looked up in the trade as it is now, so a line that left — removed here, or by the other
  // face — closes its sheet rather than leaving it open on a card that has gone.
  const editing =
    sheet?.kind === "edit" ? (trade.lines.find((line) => line.id === sheet.lineId) ?? null) : null;
  const sheetUp = sheet !== null && (sheet.kind !== "edit" || editing !== null);

  const open = (next: NonNullable<Sheet>, from: HTMLElement | null) => {
    opener.remember(from);
    setRefusal(null);
    setSheet(next);
  };
  /** A press on the scrim: closed, the caret left where the reader put it. */
  const close = () => setSheet(null);
  /** Escape, the ✕, Done and Cancel: closed, and the caret back on the press that opened it. */
  const dismiss = () => {
    setSheet(null);
    opener.restore();
  };

  /**
   * Put the caret on the trade's name: the one thing in the header row that is there whatever the
   * trade's status and whichever lines it holds.
   *
   * **For a sheet that closes with nothing to hand the caret back to.** A finish replaces the
   * press that opened its sheet; a line that is removed, moved across or folded into another
   * takes its own row — the press that opened *its* sheet — off the page or to the other column.
   * The caret was inside the sheet, the sheet is going, and an element that unmounts holding it
   * drops it on `<body>`, where the next Tab starts from the top of the app.
   *
   * **Never the opener, even while it is still connected**: after a finish or a move it is, for
   * the length of one read, and a caret handed to it then is on `<body>` a moment later. And
   * after the render, not in the handler — the name has to be the one the page draws next.
   */
  const land = () => setLanded((n) => n + 1);
  useEffect(() => {
    if (landed > 0) nameRef.current?.focus({ preventScroll: true });
  }, [landed]);

  // The edit sheet's line has left the trade under it — folded into another by a change of
  // printing or finish, or removed by the other face. Adjusted during render, as `FinishSheet`
  // forgets its answers: the sheet is put down and the caret owed in the render that noticed.
  if (sheet?.kind === "edit" && editing === null) {
    setSheet(null);
    land();
  }

  /** A write whose only answer the page needs is a refusal. */
  const run = (write: Promise<unknown>) => {
    setRefusal(null);
    write.catch((error: unknown) => setRefusal(ipcError(error)));
  };

  /**
   * The trade's one-shot writes — archive, reopen, duplicate, delete, finish — one at a time, and
   * none of them twice.
   *
   * Each is a press that should happen once and whose button is still on the page for a while
   * after it has: a thumb lands twice, and the second press used to be sent. Two Duplicates made
   * two copies; a second Archive was refused — *that trade is no longer open* — over a trade that
   * had archived perfectly well.
   *
   * **Held until the page has caught up, not until the write answers.** Between the answer and
   * the read that follows it the trade on screen is still the one from before the press, with the
   * same button — so the hold is on the *status the press was made on*, and it lets go by itself
   * when the page draws another. A refusal lets go at once: nothing changed, and the reader may
   * try again. A duplicate and a delete never draw another status here; both end by leaving this
   * page, and until they do the hold is right.
   */
  const once = <T,>(write: () => Promise<T>, then?: (answer: T) => void) => {
    if (busy) return;
    setSpent(trade.status);
    setRefusal(null);
    write()
      .then(then)
      .catch((error: unknown) => {
        setSpent(null);
        setRefusal(ipcError(error));
      });
  };
  const duplicate = () =>
    once(
      () => writes.duplicate(trade.id),
      // The copy's own page, a push — Back is the trade it was made from.
      (id) => navigate(tradePlace(id)),
    );

  const side = (which: TradeSide) => (
    <Column
      side={which}
      heading={sideHeading(which, trade.status)}
      lines={linesOf(trade.lines, which)}
      money={which === "mine" ? figures.mine : figures.theirs}
      currency={currency}
      live={live}
      onRate={(from) => open({ kind: "rate", side: which }, from)}
      onEdit={(line, from) => open({ kind: "edit", lineId: line.id }, from)}
      onAdd={(from) => open({ kind: "add", side: which }, from)}
    />
  );

  return (
    <>
      <HeaderRow name={trade.name} nameRef={nameRef}>
        {live ? (
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={() => once(() => writes.archive(trade.id))}
            className={HEADER_BUTTON}
          >
            <Archive aria-hidden className="size-4 shrink-0" />
            Archive
          </button>
        ) : (
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={() => once(() => writes.reopen(trade.id))}
            className={HEADER_BUTTON}
          >
            <RotateCcw aria-hidden className="size-4 shrink-0" />
            Reopen
          </button>
        )}
        <button
          type="button"
          aria-label="More actions"
          aria-haspopup="dialog"
          onClick={(event) => open({ kind: "more" }, event.currentTarget)}
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-md text-dim",
            PRESS,
            FOCUS,
          )}
        >
          <Ellipsis aria-hidden className="size-5" />
        </button>
      </HeaderRow>

      {!live && (
        <p className="shrink-0 border-b border-border px-4 py-2.5 text-[0.8125rem] leading-snug text-dim">
          {closedBanner(trade)}
        </p>
      )}

      {/* One row, bounded: left to size itself by its content the row would be as tall as the
          longer side, and neither column would ever scroll. */}
      <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-[minmax(0,1fr)]">
        {side("mine")}
        {side("theirs")}
      </div>

      <section
        aria-label="Balance"
        className="flex shrink-0 flex-col items-center border-t border-border bg-surface px-3 pt-2 pb-2.5"
      >
        {/* Quiet while a sheet is up: the sheet says it instead, where the reader is looking. */}
        {!sheetUp && <Refusal className="mb-2 w-full">{refusal}</Refusal>}
        <div className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
          <Total
            heading={sideHeading("mine", trade.status)}
            money={figures.mine}
            currency={currency}
            end={false}
          />
          <BalanceFigure balance={figures.balance} past={past} currency={currency} />
          <Total
            heading={sideHeading("theirs", trade.status)}
            money={figures.theirs}
            currency={currency}
            end
          />
        </div>
        <BalanceBar
          mineTotal={figures.mine.total}
          theirsTotal={figures.theirs.total}
          className="mt-2 w-full"
        />
        {live ? (
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={(event) => open({ kind: "finish" }, event.currentTarget)}
            className={cn(GOLD_BUTTON, "mt-2 w-full")}
          >
            <Check aria-hidden className="size-4 shrink-0" />
            Finish trade
          </button>
        ) : (
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={duplicate}
            className={cn(PLAIN_BUTTON, "mt-2 w-full")}
          >
            <Copy aria-hidden className="size-4 shrink-0" />
            Duplicate
          </button>
        )}
      </section>

      <AddCardsSheet
        side={sheet?.kind === "add" ? sheet.side : null}
        trade={trade}
        currency={currency}
        refusal={refusal}
        onAdd={(to, card) =>
          run(
            writes.addLines(trade.id, to, [
              { cardId: card.cardId, finish: card.finish, quantity: 1, source: card.source },
            ]),
          )
        }
        onScan={(to) => {
          // The scanner is a view of its own over the page, so the sheet gives way to it. The
          // caret's way back is still the `Add cards` press that started this.
          setScanSide(to);
          setRefusal(null);
          setSheet({ kind: "scan" });
        }}
        onClose={close}
        onDismiss={dismiss}
      />

      <EditLineSheet
        line={editing}
        trade={trade}
        currency={currency}
        refusal={refusal}
        onChange={(line, change) => {
          run(writes.updateLine(trade.id, line.id, change));
          // A move closes the sheet and takes the row that opened it to the other column.
          if (change.side !== undefined) land();
        }}
        onRemove={(line) => {
          run(writes.removeLine(trade.id, line.id));
          land();
        }}
        onClose={close}
        onDismiss={dismiss}
      />

      <RateSheet
        side={sheet?.kind === "rate" ? sheet.side : null}
        trade={trade}
        currency={currency}
        refusal={refusal}
        onRate={(which, rate) => run(writes.setRate(trade.id, which, rate))}
        onClose={close}
        onDismiss={dismiss}
      />

      <FinishSheet
        open={sheet?.kind === "finish"}
        trade={trade}
        currency={currency}
        refusal={refusal}
        finishing={busy}
        onFinish={(options) =>
          once(
            () => writes.finish(trade.id, options),
            // The sheet goes and the page stays: it redraws as the finished trade, whose note
            // says what the finish just did. `Finish trade` is about to be `Duplicate`, so the
            // caret goes to the name rather than back to the press that opened the sheet.
            () => {
              setSheet(null);
              land();
            },
          )
        }
        onClose={close}
        onDismiss={dismiss}
      />

      <MoreSheet
        open={sheet?.kind === "more"}
        trade={trade}
        refusal={refusal}
        onRename={(name) => {
          setRefusal(null);
          return writes.rename(trade.id, name).catch((error: unknown) => {
            setRefusal(ipcError(error));
            throw error;
          });
        }}
        onDuplicate={() => {
          setSheet(null);
          duplicate();
        }}
        // The question takes the sheet's place; the caret's way back is still the `⋯`.
        onDelete={() => setSheet({ kind: "delete" })}
        onClose={close}
        onDismiss={dismiss}
      />

      <ConfirmDialog
        open={sheet?.kind === "delete"}
        title="Delete this trade"
        confirmLabel="Delete trade"
        // Nothing typed: a trade is a list the reader wrote, not copies their collection holds.
        typeToConfirm={false}
        pending={busy}
        onConfirm={() =>
          once(
            () => writes.remove(trade.id),
            // A replace: the trade's own entry would be a page that says it is gone.
            () => navigate(TRADES_PLACE, { replace: true }),
          )
        }
        onDismiss={dismiss}
        onClose={close}
      >
        {`${trade.name} and every card on it will be deleted. ${
          past
            ? "What finishing it did to your collection and wishlist stays as it is."
            : "Your collection and wishlist are not touched."
        }`}
      </ConfirmDialog>

      <TradeScan
        open={sheet?.kind === "scan"}
        trade={trade}
        side={scanSide}
        onSide={setScanSide}
        onClose={dismiss}
      />
    </>
  );
}

/**
 * One side: its head — whose it is, how many cards, its percentage — and its lines.
 *
 * **The head stays put and the lines scroll under it**, each column on its own: a side of twelve
 * cards against a side of two is the ordinary lopsided trade, and one scroller for both would
 * carry the short side's `Add cards` off the screen with the long side's lines.
 *
 * The percentage is a press on an open trade and plain text on a closed one, gold either way
 * while it is not 100 — the one colour here that says "this side is not at market price".
 */
function Column({
  side,
  heading,
  lines,
  money: sideMoney,
  currency,
  live,
  onRate,
  onEdit,
  onAdd,
}: {
  side: TradeSide;
  /** `You give`, or `You gave` once the cards have changed hands. */
  heading: string;
  lines: readonly TradeLine[];
  money: SideMoney;
  currency: Currency;
  live: boolean;
  onRate: (from: HTMLElement) => void;
  onEdit: (line: TradeLine, from: HTMLElement) => void;
  onAdd: (from: HTMLElement) => void;
}) {
  const chip = cn(
    "flex h-7 items-center rounded-md border px-2 font-mono text-xs tabular-nums",
    sideMoney.rated ? "border-accent text-accent" : "border-border text-text",
  );
  return (
    <section
      aria-label={heading}
      className={cn("flex min-h-0 min-w-0 flex-col", side === "mine" && "border-r border-border")}
    >
      <div className="flex h-13 shrink-0 items-center gap-1.5 border-b border-border pr-1 pl-2.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="truncate text-sm font-semibold">{heading}</h3>
          <span className="text-[0.6875rem] text-dim">{cardCount(sideMoney.copies)}</span>
        </div>
        {live ? (
          <button
            type="button"
            // The value rides in the name: the chip's own text is a bare number.
            aria-label={rateName(side, sideMoney.rate)}
            aria-haspopup="dialog"
            onClick={(event) => onRate(event.currentTarget)}
            // 44px tall for the thumb; the chip inside it is the 28px the eye sees.
            className={cn("flex h-11 shrink-0 items-center rounded-md px-1", PRESS, FOCUS)}
          >
            <span className={chip}>{`${sideMoney.rate}%`}</span>
          </button>
        ) : (
          <span className="flex h-11 shrink-0 items-center px-1">
            <span className={chip}>
              <span className="sr-only">{`Priced at `}</span>
              {`${sideMoney.rate}%`}
            </span>
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1.5">
        {lines.length === 0 ? (
          <p className="px-2.5 pt-3 text-xs leading-snug text-dim">Nothing on this side yet.</p>
        ) : (
          <ul aria-label={`Cards on ${sideWords(side)}`}>
            {lines.map((line) => (
              <LineItem
                key={line.id}
                line={line}
                rate={sideMoney.rate}
                currency={currency}
                onEdit={live ? (from) => onEdit(line, from) : null}
              />
            ))}
          </ul>
        )}
        {live && (
          <div className="p-1.5">
            <button
              type="button"
              aria-label={`Add cards to ${sideWords(side)}`}
              aria-haspopup="dialog"
              onClick={(event) => onAdd(event.currentTarget)}
              className={cn(
                "inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed",
                "border-border text-sm font-medium text-accent",
                PRESS,
                FOCUS,
              )}
            >
              <Plus aria-hidden className="size-4 shrink-0" />
              Add cards
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * One line: the card's picture, its name, which copy it is, and what it comes to.
 *
 * **The name wraps rather than truncating** — the column is 180px at 360 and a finger has no
 * hover to read the rest by — and the code line under it is what tells two printings apart.
 * `2 × $3.25` and the line's total share a row and part company where the column is too narrow
 * for both. On a side that is not at 100% the full figure rides underneath, dimmed: both prices,
 * so neither party has to work out what the percentage took.
 *
 * **A line that would reach into a deck says so, in the destructive colour, under its code**:
 * `1 from your deck Serah` — `tradeWords.ts`'s mark, the desktop line's own words. It is read from
 * the facts that arrive with the trade, so it comes and goes as the copies are stepped past what
 * the collection holds outside the reader's decks.
 *
 * On an open trade the whole item is the press that opens its sheet; on a closed one it is the
 * same picture with nothing to press.
 */
function LineItem({
  line,
  rate,
  currency,
  onEdit,
}: {
  line: TradeLine;
  rate: number;
  currency: Currency;
  /** `null` on a closed trade: the line is a record. */
  onEdit: ((from: HTMLElement) => void) | null;
}) {
  const id = useId();
  const figures = lineMoney(line, rate);
  const code = printingLine(line.setCode, line.collectorNumber, line.finish);
  // Only the deck's mark, and only on an open trade (`givenMark`): the gold *from your
  // collection* is the edit sheet's to say, and a 180px column has no line to spare for it.
  const mark = givenMark(line, onEdit !== null);
  const fromDeck = mark?.place === "deck" ? mark.words : null;
  const box =
    "mx-1.5 mt-1.5 grid grid-cols-[2.25rem_minmax(0,1fr)] gap-2 rounded-lg border border-border bg-surface p-2 text-left text-text";
  const body = (
    <>
      <Thumb cardId={line.cardId} className="w-9 rounded-[2px]" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[0.8125rem] leading-tight font-medium break-words">{line.name}</span>
        <span className="truncate font-mono text-[0.6875rem] text-dim tabular-nums">{code}</span>
        {fromDeck !== null && (
          // Wraps, never truncates: it names the deck this line leaves a card short.
          <span
            id={`${id}-deck`}
            data-mark="deck"
            className="flex items-start gap-1 text-[0.6875rem] leading-tight font-medium break-words text-destructive"
          >
            <TriangleAlert aria-hidden className="mt-px size-3 shrink-0" />
            <span className="min-w-0">{fromDeck}</span>
          </span>
        )}
        <span
          id={id}
          className="flex flex-wrap items-baseline justify-between gap-x-1 font-mono tabular-nums"
        >
          <span className="text-[0.6875rem] text-dim">
            {`${line.quantity} × ${money(figures.unit, currency)}`}
          </span>
          <span className="text-[0.8125rem] font-semibold">{money(figures.total, currency)}</span>
        </span>
        {rate !== 100 && figures.fullTotal !== null && (
          <span className="text-right font-mono text-[0.6875rem] text-dim tabular-nums">
            {`${money(figures.fullTotal, currency)} at 100%`}
          </span>
        )}
      </span>
    </>
  );
  return (
    <li className="flex flex-col">
      {onEdit === null ? (
        <div className={box}>{body}</div>
      ) : (
        <button
          type="button"
          // Named for what the press does and which copy it is about; the figures are the
          // button's description, so they are still read with it — and so is the deck's mark,
          // first, where the line has one.
          aria-label={`Edit ${line.name}, ${code}`}
          aria-describedby={fromDeck === null ? id : `${id}-deck ${id}`}
          aria-haspopup="dialog"
          onClick={(event) => onEdit(event.currentTarget)}
          className={cn(box, "active:bg-bg", FOCUS_INSET)}
        >
          {body}
        </button>
      )}
    </li>
  );
}

/** A side's total in the foot, with the 100% figure under it where the side is rated. */
function Total({
  heading,
  money: sideMoney,
  currency,
  end,
}: {
  heading: string;
  money: SideMoney;
  currency: Currency;
  /** Their side's, set against the far edge under their column. */
  end: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col", end ? "items-end" : "items-start")}>
      <span className="text-[0.6875rem] text-dim">{heading}</span>
      <span className="font-mono text-lg leading-tight font-semibold tabular-nums">
        {money(sideMoney.total, currency)}
      </span>
      {sideMoney.rated && (
        <span className="font-mono text-[0.6875rem] text-dim tabular-nums">
          {fullPriceNote(money(sideMoney.fullTotal, currency))}
        </span>
      )}
      {/* A card with no price is in neither figure, and the total says so rather than rounding
          down in silence. */}
      {sideMoney.unpriced > 0 && (
        <span className="text-[0.6875rem] text-dim">{unpricedNote(sideMoney.unpriced)}</span>
      )}
    </div>
  );
}
