import {
  balanceLine,
  fromCents,
  isSettled,
  tradeMoney,
} from "@grimoire/ui/features/trade/trade";
import { tradeCurrency } from "@grimoire/ui/features/trade/tradeWords";
import type { TradeSide, TradeSummary } from "@grimoire/ui/lib/ipc";
import type { Currency } from "@grimoire/ui/lib/marketplace";
import { formatPrice } from "@grimoire/ui/lib/prices";

/**
 * The little the phone's trade pages word for themselves.
 *
 * **Every figure is `trade.ts`'s and every sentence both faces say is `tradeWords.ts`'s** — when a
 * trade was opened, what a closed one says about itself, which copy of a card a line is. What is
 * left here is what only this face needs: cents as money in one call, the other side's name, and
 * the list row's balance.
 */

/** Cents as money, in the trade's own currency — an em dash for a card with no price. */
export function money(cents: number | null, currency: Currency): string {
  return formatPrice(fromCents(cents), currency);
}

export const otherSide = (side: TradeSide): TradeSide => (side === "mine" ? "theirs" : "mine");

/** A phrase with its first letter raised — `Your side`, at the head of a line. */
export const capital = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

/**
 * A trade's balance as the list states it: `You owe $22.70`, `They owed you $2.35`, `Even trade`.
 *
 * Drawn from `tradeMoney`, the one door the open trade's foot goes through too, so the list and
 * the page cannot state two balances for one trade. **Past tense only for a finished trade**
 * (`isSettled`): one archived without finishing changed no hands, so whoever owed still does.
 */
export function listBalance(trade: TradeSummary): string {
  const { balance } = tradeMoney(trade);
  const cents = balance.kind === "even" ? 0 : balance.cents;
  return balanceLine(balance, isSettled(trade.status), money(cents, tradeCurrency(trade)));
}
