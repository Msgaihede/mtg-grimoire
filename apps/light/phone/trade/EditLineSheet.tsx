import { useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Layers, Trash2, TriangleAlert } from "lucide-react";
import { ToggleChip } from "@grimoire/ui/components/FilterChips";
import { RarityGem } from "@grimoire/ui/components/RarityGem";
import { cardPrintingsKey } from "@grimoire/ui/features/card/cardKeys";
import { holdingOf, lineMoney, rateOf } from "@grimoire/ui/features/trade/trade";
import { givenMark, printingLine, sideWords } from "@grimoire/ui/features/trade/tradeWords";
import { FINISH_LABEL, parseFinishes } from "@grimoire/ui/lib/finish";
import { ipc, ipcError } from "@grimoire/ui/lib/ipc";
import type { Trade, TradeLine, TradeLineChange } from "@grimoire/ui/lib/ipc";
import type { Currency } from "@grimoire/ui/lib/marketplace";
import { formatPrice } from "@grimoire/ui/lib/prices";
import { cn } from "@grimoire/ui/lib/utils";
import { PRINTING_ROW, PrintingFace, printingCode } from "../card/Printings";
import { ActionSheet, SheetBack, SheetChoice, SheetRow, SheetStepper } from "../deck/sheet";
import { Refusal, Thumb } from "./parts";
import { capital, money, otherSide } from "./text";

type Page = "main" | "printing";

/**
 * Whose side a line is on, and the one gold mark it can wear there.
 *
 * **Never the deck's mark**: a line that would reach into a deck says so in the sheet's body, in
 * the destructive colour and under the stepper that causes it ({@link MainPage}) — and while it
 * does, *from your collection* is not said beside it. The sheet is only ever open on an open
 * trade, which is what `givenMark` is told.
 */
function sideLabel(line: TradeLine, trade: Trade): string {
  const side = capital(sideWords(line.side));
  // A line the reader picked out of their collection is one a finish can take back out of it;
  // a card they are being given that they have wished for is the reason for the trade.
  const mark = givenMark(holdingOf(line, trade.lines), true);
  if (mark?.place === "collection") return `${side} · ${mark.words}`;
  if (line.side === "theirs" && line.wished > 0) return `${side} · on your wishlist`;
  return side;
}

/**
 * One line of a trade, opened: how many, which finish, which printing, whose side — and the way
 * out of the trade.
 *
 * The desktop edits a line where it stands, with a stepper, two dropdowns and a remove on the row.
 * A 180px column has room for none of them, so the row is the press and this sheet is the row's
 * controls, each at a thumb's size.
 *
 * - **Copies** — the sheet's stepper, the one a deck row's and a wish's draw: `−` at one copy is
 *   the removal and says so, the same write as `Remove from trade` below it. Stepped past what
 *   the reader holds outside their decks, a line appears under it in the destructive colour
 *   saying how many copies would come out of which deck.
 * - **Finish** — a chip for each finish *this printing* comes in, each with today's price, so the
 *   reader sees what the change costs before pressing it. The backend refuses a finish the
 *   printing does not have; offering only the ones it has is what keeps that sentence unseen.
 * - **Printing** — every printing of the card as a page of this sheet, the card sheet's own rows,
 *   priced **at the trade's marketplace** rather than the reader's current one. A press swaps the
 *   line's printing and keeps its finish where the new printing has it.
 * - **Move** — to the other side. The line lands in the other column, so the sheet closes and the
 *   reader watches it arrive.
 *
 * **Every write is made as it is pressed** — a trade has no Save — through the page's own
 * `onChange`, which is `useTradeWrites` with the refusal caught: said here, in the sheet's foot,
 * while the sheet is up.
 */
export function EditLineSheet({
  line,
  trade,
  currency,
  refusal,
  onChange,
  onRemove,
  onClose,
  onDismiss,
}: {
  /** The line the sheet is open on, as the trade holds it now — `null` is closed. */
  line: TradeLine | null;
  trade: Trade;
  currency: Currency;
  refusal: string | null;
  onChange: (line: TradeLine, change: TradeLineChange) => void;
  onRemove: (line: TradeLine) => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const [page, setPage] = useState<Page>("main");
  // Back on its first page on the render that closes it, however it closed: a line that leaves
  // the trade while its printings are up closes the sheet with no press on a way out.
  const open = line !== null;
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setPage("main");
  }

  return (
    <ActionSheet
      open={open}
      title={line?.name ?? "Card"}
      subtitle={line === null ? undefined : sideLabel(line, trade)}
      closeLabel="Close card"
      onClose={onClose}
      onDismiss={onDismiss}
      footer={
        refusal === null ? undefined : (
          <div className="shrink-0 border-t border-border px-4 py-2">
            <Refusal>{refusal}</Refusal>
          </div>
        )
      }
    >
      {line !== null &&
        (page === "printing" ? (
          <PrintingPage
            line={line}
            trade={trade}
            currency={currency}
            onBack={() => setPage("main")}
            onPick={(cardId) => {
              onChange(line, { cardId });
              setPage("main");
            }}
          />
        ) : (
          <MainPage
            line={line}
            trade={trade}
            currency={currency}
            onChange={(change) => onChange(line, change)}
            onPrinting={() => setPage("printing")}
            // `onClose`, not `onDismiss`, for both: the press that opened this sheet is the line's
            // own row, which a move takes to the other column and a removal takes off the page —
            // a caret handed back to it would be handed to nothing a tick later.
            onMove={() => {
              onChange(line, { side: otherSide(line.side) });
              onClose();
            }}
            onRemove={() => {
              onRemove(line);
              onClose();
            }}
          />
        ))}
    </ActionSheet>
  );
}

function MainPage({
  line,
  trade,
  currency,
  onChange,
  onPrinting,
  onMove,
  onRemove,
}: {
  line: TradeLine;
  trade: Trade;
  currency: Currency;
  onChange: (change: TradeLineChange) => void;
  onPrinting: () => void;
  onMove: () => void;
  onRemove: () => void;
}) {
  const rate = rateOf(trade, line.side);
  const figures = lineMoney(line, rate);
  // Both prices only where they differ and there is one: a line at 100%, or with no price at
  // all, has nothing to set beside its figure.
  const rated = rate !== 100 && figures.total !== null;
  const finishes = parseFinishes(line.finishes);
  const toTheirs = line.side === "mine";
  const mark = givenMark(holdingOf(line, trade.lines), true);
  const fromDeck = mark?.place === "deck" ? mark.words : null;

  return (
    <>
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3.5 border-b border-border px-4 py-3.5">
        <Thumb cardId={line.cardId} className="w-24 rounded-[5px]" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm">{line.setName ?? line.setCode.toUpperCase()}</span>
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-dim tabular-nums">
            <RarityGem rarity={line.rarity} className="shrink-0" />
            <span className="truncate">
              {printingLine(line.setCode, line.collectorNumber, line.finish)}
            </span>
          </span>
          <span className="mt-auto flex flex-col gap-0.5 font-mono tabular-nums">
            <span className="text-xs text-dim">
              {`${line.quantity} × ${money(figures.unit, currency)}`}
            </span>
            <span className="text-[1.375rem] leading-tight font-semibold">
              {money(figures.total, currency)}
            </span>
            {rated && (
              <span className="text-xs text-dim">
                {`${money(figures.fullTotal, currency)} at 100%`}
              </span>
            )}
          </span>
        </div>
      </div>

      <SheetStepper
        quantity={line.quantity}
        name={line.name}
        onSet={(quantity) => {
          // The stepper's own rule: below one copy is the removal, never a line of none — which
          // the backend would refuse in a sentence the reader did nothing to earn.
          if (quantity < 1) onRemove();
          else onChange({ quantity });
        }}
      />

      {/* What the copies above now cost a deck — `1 from your deck Serah`, the page's own mark.
          Under the stepper and not over it, so the press that brings it does not move the next
          press out from under the thumb. A live region that is always mounted and only filled:
          the line arriving is what a screen reader should hear after `+`. */}
      <p
        role="status"
        data-mark="deck"
        className={cn(
          "text-[0.8125rem] leading-snug font-medium text-destructive",
          fromDeck !== null && "flex items-start gap-1.5 border-b border-border px-4 py-2.5",
        )}
      >
        {fromDeck !== null && (
          <>
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">{capital(fromDeck)}</span>
          </>
        )}
      </p>

      {/* The chips are the desktop's own, floored for a thumb from outside them — the search
          sheet's arrangement. Each carries its finish's price today, at the trade's marketplace. */}
      <div className="flex min-h-13 items-center gap-3 border-b border-border px-4 py-2.5 [&_button]:min-h-11">
        <span className="shrink-0 text-sm text-dim">Finish</span>
        <div
          role="group"
          aria-label={`Finish of ${line.name}`}
          className="flex min-w-0 flex-1 flex-wrap justify-end gap-1.5"
        >
          {finishes.map((finish) => (
            <ToggleChip
              key={finish}
              label={`${FINISH_LABEL[finish]} ${formatPrice(line.finishPrices[finish], currency)}`}
              pressed={finish === line.finish}
              onClick={() => {
                if (finish !== line.finish) onChange({ finish });
              }}
            />
          ))}
        </div>
      </div>

      <ul>
        <SheetRow
          label="Printing"
          value={`${line.setName ?? line.setCode.toUpperCase()} · #${line.collectorNumber}`}
          Icon={Layers}
          opens
          reason={line.oracleId === null ? "this card has left the card database" : null}
          onPress={onPrinting}
        />
        <SheetRow
          label={toTheirs ? "Move to their side" : "Move to your side"}
          Icon={toTheirs ? ArrowRight : ArrowLeft}
          onPress={onMove}
        />
        <SheetRow label="Remove from trade" Icon={Trash2} destructive onPress={onRemove} />
      </ul>
    </>
  );
}

/**
 * Every printing of the line's card — `WishActions`' page, with one difference that matters: the
 * list is read **at the trade's marketplace** and drawn in its currency. The key carries that
 * marketplace, so a trade priced where the reader is anyway answers from the card sheet's cache,
 * and one priced elsewhere reads its own.
 */
function PrintingPage({
  line,
  trade,
  currency,
  onBack,
  onPick,
}: {
  line: TradeLine;
  trade: Trade;
  currency: Currency;
  onBack: () => void;
  onPick: (cardId: string) => void;
}) {
  const oracleId = line.oracleId;
  const printings = useQuery({
    queryKey: cardPrintingsKey(oracleId, trade.marketplace),
    queryFn: oracleId !== null ? () => ipc.cardPrintings(oracleId, trade.marketplace) : skipToken,
  });
  const items = printings.data?.items ?? [];
  return (
    <>
      <SheetBack label="Printing" onBack={onBack} />
      {printings.isPending ? (
        <p className="px-4 py-3 text-sm text-dim">Loading printings…</p>
      ) : printings.isError ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {`Couldn't load the printings — ${ipcError(printings.error)}`}
        </p>
      ) : items.length === 0 ? (
        <p className="px-4 py-3 text-sm text-dim">This card has no paper printings.</p>
      ) : (
        <ul aria-label="Printings" className="px-2">
          {items.map((printing) => {
            const current = printing.id === line.cardId;
            return (
              <SheetChoice
                key={printing.id}
                label={`${current ? "" : "Use "}${printing.setName ?? printing.setCode.toUpperCase()}, ${printingCode(printing)}`}
                current={current}
                onPick={() => onPick(printing.id)}
              >
                <span className={cn(PRINTING_ROW, "min-w-0 flex-1 px-0")}>
                  <PrintingFace printing={printing} currency={currency} />
                </span>
              </SheetChoice>
            );
          })}
        </ul>
      )}
    </>
  );
}
