/**
 * **What Open Packs prices in, and how each picked marketplace's prices get there** (issue
 * #1463). Pure: the page's hooks hand it the pick, the app's currency and the exchange rate's
 * state, and it answers which marketplaces are read and the factor each one's prices are
 * multiplied by.
 *
 * - **One currency picked: that currency, nothing converted.** Cardmarket alone stays in euros
 *   even when the app quotes TCGplayer — the figures are the marketplace's own, to the cent.
 * - **Both picked: the app's currency** (the owner's decision, 2026-11-02), so the page reads in
 *   the money every other price surface does. The other currency's prices are converted at the
 *   ECB's daily rate (`packs_exchange_rate`) and only then compared, finish by finish.
 * - **No rate yet: wait.** A mixed pick's figures are not drawn until the rate answers, so they
 *   never jump from one marketplace's prices to the lowest of two.
 * - **No rate at all** (the ECB unreachable and nothing cached): the marketplaces in the app's
 *   currency alone, and the page says which were left out and why. A price in euros is never
 *   compared with one in dollars unconverted.
 */
import type { ExchangeRate } from "@/lib/ipc";
import type { Currency, Marketplace } from "@/lib/marketplace";

/** Where the exchange rate stands: unasked or answering, answered, or refused. */
export type RateState =
  | { status: "loading" }
  | { status: "ready"; rate: ExchangeRate }
  | { status: "failed"; reason: string };

/** One marketplace the page reads, and what its prices are multiplied by to reach the page's. */
export interface PriceSource {
  marketplace: Marketplace;
  factor: number;
}

export interface PricingPlan {
  /** What every figure on the page is in. */
  currency: Currency;
  /** The marketplaces read, in picker order — never empty. */
  sources: PriceSource[];
  /** Picked, but not read: in the other currency, with no rate to convert them by. */
  leftOut: Marketplace[];
  /** The rate the sources were converted at — `null` when nothing was converted. */
  rate: ExchangeRate | null;
  /** A mixed pick still waiting on its rate: draw no figure yet. */
  waiting: boolean;
}

/** Whether a pick names marketplaces of more than one currency — the one case a rate is read. */
export function isMixed(picked: readonly Marketplace[]): boolean {
  return picked.some((m) => m.currency !== picked[0]?.currency);
}

/** What a price in `from` is multiplied by to read in `to`, at `usdPerEur` dollars a euro. */
export function conversionFactor(from: Currency, to: Currency, usdPerEur: number): number {
  if (from === to) return 1;
  return from === "eur" ? usdPerEur : 1 / usdPerEur;
}

/** The page's currency, sources and what is left out, for `picked` (never empty). */
export function pricingPlan(
  picked: readonly Marketplace[],
  appCurrency: Currency,
  rate: RateState,
): PricingPlan {
  const one = (m: Marketplace): PriceSource => ({ marketplace: m, factor: 1 });
  if (!isMixed(picked)) {
    return {
      currency: picked[0]?.currency ?? appCurrency,
      sources: picked.map(one),
      leftOut: [],
      rate: null,
      waiting: false,
    };
  }
  const own = picked.filter((m) => m.currency === appCurrency);
  const other = picked.filter((m) => m.currency !== appCurrency);
  if (rate.status === "ready") {
    return {
      currency: appCurrency,
      sources: picked.map((m) => ({
        marketplace: m,
        factor: conversionFactor(m.currency, appCurrency, rate.rate.usdPerEur),
      })),
      leftOut: [],
      rate: rate.rate,
      waiting: false,
    };
  }
  return {
    currency: appCurrency,
    sources: own.map(one),
    leftOut: rate.status === "failed" ? other : [],
    rate: null,
    waiting: rate.status === "loading",
  };
}
