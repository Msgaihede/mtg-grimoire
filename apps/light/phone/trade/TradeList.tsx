import { useRef, useState } from "react";
import { Archive, ChevronRight, Plus } from "lucide-react";
import { isOpen, tradeMoney } from "@grimoire/ui/features/trade/trade";
import { listLine, tradeUnpricedNote } from "@grimoire/ui/features/trade/tradeWords";
import { useTradeList } from "@grimoire/ui/features/trade/useTrades";
import { FOCUS_INSET } from "@grimoire/ui/lib/focus";
import type { TradeSummary } from "@grimoire/ui/lib/ipc";
import { cn } from "@grimoire/ui/lib/utils";
import type { Place } from "../../routes";
import { DimNote, ReadError } from "../pages/parts";
import { linkTo, navigate } from "../router";
import { NewTradeSheet } from "./NewTradeSheet";
import { GOLD_BUTTON } from "./parts";
import { listBalance } from "./text";

/** A trade as a place — `/trade/5`. */
export const tradePlace = (tradeId: number): Place => ({
  view: "trade",
  deckId: null,
  cardId: null,
  tradeId,
});

/** The list of them — `/trade`. */
export const TRADES_PLACE: Place = { view: "trade", deckId: null, cardId: null };

/**
 * Every trade the reader keeps: the ones still open, then the ones put away.
 *
 * **Two sections, and the second holds two statuses.** A finished trade and one archived without
 * finishing are both *put away* — neither can be edited, both keep the prices they closed with —
 * so they share a heading, and each row says which it is in its second line. Newest first inside
 * each, which is the order the backend answers in.
 *
 * **Each row states its balance**, drawn from the same `tradeMoney` the open trade's foot uses
 * (through `text.ts`), so the list and the page cannot disagree about one trade. A closed trade's
 * is dimmed: it is a record, not a thing still to settle. The line under the name is the desktop
 * pane's own (`tradeWords.ts`). **A balance that leaves cards out says so under itself** — a line
 * with no price is in neither total, and `Even trade` over two of them is not an even trade.
 *
 * **A row is a link**: opening a trade changes the URL, and a trade is worth a link.
 */
export function TradeList() {
  const list = useTradeList();
  const [creating, setCreating] = useState(false);
  const newRef = useRef<HTMLButtonElement>(null);
  const trades = list.data ?? [];
  const open = trades.filter((trade) => isOpen(trade.status));
  const closed = trades.filter((trade) => !isOpen(trade.status));

  return (
    <>
      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
        <div className="px-4 py-3">
          <button
            ref={newRef}
            type="button"
            aria-haspopup="dialog"
            onClick={() => setCreating(true)}
            className={cn(GOLD_BUTTON, "w-full")}
          >
            <Plus aria-hidden className="size-4 shrink-0" />
            New trade
          </button>
        </div>

        {list.isLoadingError ? (
          <ReadError>Your trades could not be read.</ReadError>
        ) : list.data === undefined ? (
          <DimNote>Loading trades…</DimNote>
        ) : trades.length === 0 ? (
          <DimNote>No trades yet.</DimNote>
        ) : (
          <>
            {open.length > 0 && <Section label="Open" trades={open} />}
            {closed.length > 0 && <Section label="Archived" trades={closed} spaced={open.length > 0} />}
          </>
        )}
      </div>

      <NewTradeSheet
        open={creating}
        onClose={() => setCreating(false)}
        onDismiss={() => {
          setCreating(false);
          newRef.current?.focus();
        }}
        onCreated={(tradeId) => {
          setCreating(false);
          navigate(tradePlace(tradeId));
        }}
      />
    </>
  );
}

/** One heading and its rows. The count rides in the heading: `Open · 2`. */
function Section({
  label,
  trades,
  spaced = false,
}: {
  label: string;
  trades: readonly TradeSummary[];
  /** Under another section, where the heading stands off the rows above it. */
  spaced?: boolean;
}) {
  const heading = `${label} · ${trades.length}`;
  return (
    <section aria-label={heading}>
      <h2
        className={cn(
          "border-b border-border px-4 pb-1.5 text-xs font-normal text-dim",
          spaced ? "pt-[1.125rem]" : "pt-1.5",
        )}
      >
        {heading}
      </h2>
      <ul>
        {trades.map((trade) => (
          <TradeRow key={trade.id} trade={trade} />
        ))}
      </ul>
    </section>
  );
}

function TradeRow({ trade }: { trade: TradeSummary }) {
  const when = listLine(trade);
  const balance = listBalance(trade);
  const unpriced = tradeUnpricedNote(tradeMoney(trade));
  const live = isOpen(trade.status);
  return (
    <li className="border-b border-border">
      <a
        {...linkTo(tradePlace(trade.id))}
        // Spelled out: the name, the line under it and the balance are three boxes a gap apart,
        // which the name algorithm would run together.
        aria-label={[trade.name, when, balance, ...(unpriced === null ? [] : [unpriced])].join(". ")}
        className={cn(
          "flex min-h-16 items-center gap-3 py-2.5 pr-2 pl-4 text-text active:bg-surface",
          FOCUS_INSET,
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-[0.9375rem] font-medium">
            {!live && <Archive aria-hidden className="size-3.5 shrink-0 text-dim" />}
            <span className="truncate">{trade.name}</span>
          </span>
          <span className="text-xs text-dim">{when}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-right text-xs">
          <span className={cn("font-mono tabular-nums", live ? "text-text" : "text-dim")}>
            {balance}
          </span>
          {unpriced !== null && <span className="text-dim">{unpriced}</span>}
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-dim" />
      </a>
    </li>
  );
}
