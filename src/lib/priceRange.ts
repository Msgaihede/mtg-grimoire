import type { Currency } from "./marketplace";
import { formatPrice } from "./prices";

/**
 * What a collapsed row's Price cell says: the spread across the printings it stands for.
 *
 * Equal ends collapse to one price rather than repeating it — 17 588 of the corpus's 37 553
 * cards have exactly one printing, and `$2.15–$2.15` is noise on every one of them. It is
 * also what an *uncollapsed* row renders, where `priceLow` and `priceHigh` are both the
 * row's own price, so one function serves both modes.
 *
 * A missing end stays missing: `formatPrice` never invents `$0.00`, and a range that quoted a
 * price nobody quoted would be worse than a half-open one. `—–$9.00` reads as "from
 * unknown", which is the truth about a group where only some printings are priced.
 */
export function priceRange(
  low: number | null,
  high: number | null,
  currency: Currency,
): string {
  if (low === null && high === null) return "—";
  if (low === high) return formatPrice(low, currency);
  return `${formatPrice(low, currency)}–${formatPrice(high, currency)}`;
}
