import type { Currency, Marketplace } from "./marketplace";

/**
 * Money, as this app writes it.
 *
 * Three call sites had their own `Intl.NumberFormat` and two had their own copy of the
 * as-of sentence — which is exactly the kind of duplication that ends with two screens
 * making different promises about the same number. Prices come from one place (whatever
 * the last sync wrote, quoted by whichever marketplace the reader picked), so they say so
 * in one sentence.
 */

/**
 * One formatter per currency, built once.
 *
 * Module-level on purpose: an `Intl.NumberFormat` is expensive to construct and these are
 * called once per price cell in a virtualised table. Building one per call is the thing this
 * module was written to stop, and switching marketplace must not reintroduce it — the switch
 * changes which constant is *looked up*, never how many exist.
 */
const FORMATTERS: Record<Currency, Intl.NumberFormat> = {
  usd: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }),
  eur: new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }),
};

/** A price, or an em dash. Never `$0.00`, which is a price nobody quoted. */
export function formatPrice(value: number | null, currency: Currency): string {
  return value === null ? "—" : FORMATTERS[currency].format(value);
}

/**
 * The provenance sentence, which now has to name the marketplace.
 *
 * It was a constant while there was only one answer. With five in the picker, a bare "prices
 * as of the last sync" would leave the reader to guess whose prices they are looking at — and
 * the whole point of the setting is that the answer changed.
 */
export function pricesAsOf(marketplace: Marketplace): string {
  return `${marketplace.label} prices as of the last card-data sync.`;
}
