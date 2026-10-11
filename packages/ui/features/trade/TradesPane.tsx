import type { JSX, Ref } from "react";
import { Archive, Plus } from "lucide-react";
import type { TradeSummary } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { PRESS_SOFT } from "@/lib/motion";
import { formatPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";
import { balanceLine, fromCents, isOpen, isSettled, tradeMoney } from "./trade";
import { FIGURE, TRADE_BUTTON_ACCENT } from "./tradeControls";
import { listLine, tradeCurrency, tradeUnpricedNote } from "./tradeWords";

/**
 * Every trade the reader has, in two groups, and the way to start another.
 *
 * **Open, then Archived** — and *Archived* holds both ways a trade stops being open. A finished
 * trade and one put away unfinished are told apart inside the group, by the line under the name
 * (`Finished 6 Sep · 3 for 3 cards` against `Archived 23 Aug · not finished`) and by the tense of
 * the balance, rather than by a third heading: the reader's question about either is the same
 * one — *what was that trade* — and they look for it in one place.
 *
 * **Each entry states its balance**, through the same {@link tradeMoney} the open trade uses, so
 * the figure here and the figure in the panel beside it cannot disagree. It is each trade's own
 * marketplace and currency, never the app's: a list can hold a dollar trade above a euro one.
 * **And each says when that balance leaves cards out**: a line with no price is in neither total,
 * so an entry reading `Even trade` over two of them carries `2 without a price` under it.
 *
 * **Selection is the page's state and an entry is a button**, not a link. Nothing about which
 * trade is on screen is in the address or the store; `aria-current` says which one is.
 */
export function TradesPane({
  trades,
  selectedId,
  onSelect,
  onNew,
  newRef,
}: {
  /** Newest first, as the backend lists them. */
  trades: readonly TradeSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  /** The New trade button, so a dialog it opened — or a deleted trade — can hand the caret back. */
  newRef: Ref<HTMLButtonElement>;
}): JSX.Element {
  const open = trades.filter((trade) => isOpen(trade.status));
  const closed = trades.filter((trade) => !isOpen(trade.status));

  return (
    <aside
      aria-label="Trades"
      className="flex min-h-0 w-[15.5rem] shrink-0 flex-col gap-3.5 overflow-y-auto"
    >
      <button
        ref={newRef}
        type="button"
        onClick={onNew}
        className={cn(TRADE_BUTTON_ACCENT, "w-full")}
      >
        <Plus className="size-4" aria-hidden="true" />
        New trade
      </button>
      <Group title="Open" trades={open} selectedId={selectedId} onSelect={onSelect} />
      <Group title="Archived" trades={closed} selectedId={selectedId} onSelect={onSelect} />
    </aside>
  );
}

function Group({
  title,
  trades,
  selectedId,
  onSelect,
}: {
  title: string;
  trades: readonly TradeSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  // A heading over nothing is a heading the reader has to read past.
  if (trades.length === 0) return null;
  return (
    <section aria-label={`${title} trades`} className="flex flex-col gap-1">
      <h3 className="px-3 text-xs font-normal text-dim">
        {title} · {trades.length}
      </h3>
      <ul className="flex flex-col gap-1">
        {trades.map((trade) => (
          <li key={trade.id}>
            <Entry
              trade={trade}
              selected={trade.id === selectedId}
              onSelect={() => onSelect(trade.id)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Entry({
  trade,
  selected,
  onSelect,
}: {
  trade: TradeSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const money = tradeMoney(trade);
  const amount =
    money.balance.kind === "even"
      ? ""
      : formatPrice(fromCents(money.balance.cents), tradeCurrency(trade));
  const unpriced = tradeUnpricedNote(money);
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "relative flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left",
        selected ? "border-border bg-surface" : "border-transparent hover:bg-surface",
        PRESS_SOFT,
        FOCUS,
      )}
    >
      {selected && (
        <span
          aria-hidden="true"
          className="absolute inset-y-2.5 -left-px w-0.5 rounded-[2px] bg-accent"
        />
      )}
      <span
        className={cn(
          "flex items-center gap-1.5 text-sm font-medium",
          selected ? "text-accent" : "text-text",
        )}
      >
        {!isOpen(trade.status) && (
          <Archive className="size-3.5 shrink-0 text-dim" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">{trade.name}</span>
      </span>
      <span className="text-xs text-dim">{listLine(trade)}</span>
      <span className={cn(FIGURE, "text-xs text-text")}>
        {balanceLine(money.balance, isSettled(trade.status), amount)}
      </span>
      {/* The balance above leaves these cards out, so the row that states it says so. */}
      {unpriced !== null && <span className="text-xs text-dim">{unpriced}</span>}
    </button>
  );
}
