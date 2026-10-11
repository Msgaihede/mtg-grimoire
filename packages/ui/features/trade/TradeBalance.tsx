import type { JSX, ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";
import { BalanceBar } from "./BalanceBar";
import { balanceHeading, fromCents, type Balance, type SideMoney, type TradeMoney } from "./trade";
import { FIGURE } from "./tradeControls";
import { fullPriceNote, unpricedNote } from "./tradeWords";

/**
 * Who owes whom, in two lines: the sentence, and the figure with an arrow.
 *
 * **The arrow points at the side that is owed** — right when the reader owes them, left when they
 * owe the reader — and it sits on that side of the figure, so the pair reads as a direction
 * rather than as a number with a decoration. An even trade has no arrow and no gold: a tick and
 * two words in the app's "this is fine" green, which is the one place this page uses it.
 *
 * Shared by the balance panel and the Finish dialog's summary, which draw it at two sizes and
 * must never word it two ways.
 */
export function BalanceFigure({
  balance,
  past,
  currency,
  size,
}: {
  balance: Balance;
  /** A finished trade's balance is a record: *You owed them*. */
  past: boolean;
  currency: Currency;
  size: "panel" | "summary";
}): JSX.Element {
  const panel = size === "panel";
  const glyph = panel ? "size-[1.125rem]" : "size-3.5";
  return (
    <>
      <div className="text-[0.8125rem] text-dim">{balanceHeading(balance, past)}</div>
      {balance.kind === "even" ? (
        <div
          className={cn(
            "flex items-center justify-center gap-2 leading-tight font-semibold text-ok",
            panel ? "text-lg" : "text-[0.9375rem]",
          )}
        >
          <Check className={glyph} aria-hidden="true" />
          <span>Even trade</span>
        </div>
      ) : (
        <div
          className={cn(
            FIGURE,
            "flex items-center justify-center gap-2 leading-tight font-semibold text-accent",
            panel ? "text-[1.375rem]" : "text-lg",
          )}
        >
          {balance.kind === "theyOwe" && <ArrowLeft className={glyph} aria-hidden="true" />}
          <span data-figure="balance">{formatPrice(fromCents(balance.cents), currency)}</span>
          {balance.kind === "youOwe" && <ArrowRight className={glyph} aria-hidden="true" />}
        </div>
      )}
    </>
  );
}

/**
 * The panel under the two sides: both totals, the balance between them, and the way out.
 *
 * Three columns, and the outer two are mirrors — the reader's total against the left edge under
 * their own side, the other party's against the right under theirs — so each figure sits below
 * the list it sums. The middle is the balance, the bar that draws it, and whatever the caller puts
 * under that: **Finish trade** on an open trade, nothing on a closed one.
 *
 * **A side's total is the figure the two people agree on, so it is the adjusted one**, with the
 * full price dimmed beneath it whenever the two differ. And a side with a line that has no price
 * says how many: such a line adds nothing to the total, and a total that leaves a card out in
 * silence is a number that lies by rounding down.
 */
export function TradeBalance({
  money,
  currency,
  past,
  labels,
  children,
}: {
  money: TradeMoney;
  currency: Currency;
  past: boolean;
  /** The two sides' headings, in the tense the trade is in. */
  labels: { mine: string; theirs: string };
  children?: ReactNode;
}): JSX.Element {
  return (
    <section
      aria-label="Balance"
      className={cn(
        "grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-6",
        "rounded-[10px] border border-border bg-surface px-5 py-3.5",
      )}
    >
      <SideTotal label={labels.mine} money={money.mine} currency={currency} align="start" />
      <div className="flex flex-col items-center text-center">
        <BalanceFigure balance={money.balance} past={past} currency={currency} size="panel" />
        <BalanceBar
          mineTotal={money.mine.total}
          theirsTotal={money.theirs.total}
          className="mt-2"
        />
        {children}
      </div>
      <SideTotal label={labels.theirs} money={money.theirs} currency={currency} align="end" />
    </section>
  );
}

function SideTotal({
  label,
  money,
  currency,
  align,
}: {
  label: string;
  money: SideMoney;
  currency: Currency;
  align: "start" | "end";
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5",
        align === "start" ? "items-start" : "items-end",
      )}
    >
      <div className="text-xs text-dim">{label}</div>
      <div
        className={cn(FIGURE, "text-[1.625rem] leading-[1.15] font-semibold")}
        data-figure="side"
      >
        {formatPrice(fromCents(money.total), currency)}
      </div>
      {money.rated && (
        <div className={cn(FIGURE, "text-xs text-dim")}>
          {fullPriceNote(formatPrice(fromCents(money.fullTotal), currency))}
        </div>
      )}
      {money.unpriced > 0 && (
        <div className="text-xs text-dim">{unpricedNote(money.unpriced)}</div>
      )}
    </div>
  );
}
