/**
 * Money, as this app writes it.
 *
 * Three call sites had their own `Intl.NumberFormat` and two had their own copy of the
 * as-of sentence — which is exactly the kind of duplication that ends with two screens
 * making different promises about the same number. Prices come from one place (whatever
 * the last sync wrote), so they say so in one sentence.
 */
export const PRICES_AS_OF = "Prices as of the last card-data sync.";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const EUR = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });

/** A price, or an em dash. Never `$0.00`, which is a price nobody quoted. */
export function usdPrice(value: number | null): string {
  return value === null ? "—" : USD.format(value);
}

export function eurPrice(value: number | null): string {
  return value === null ? "—" : EUR.format(value);
}
