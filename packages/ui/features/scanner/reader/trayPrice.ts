/**
 * What one scanned card costs, at the marketplace the reader picked — the tray's price line.
 *
 * **Rust quotes, TypeScript picks.** `printing_prices` answers three figures per printing, one per
 * finish, built by the crate's one `price_expr`; which of the three a tray row is, is this
 * module's. It is the row's finish and nothing else, with one arm for a finish not settled yet.
 */
import type { FinishPrices, PrintingPrices, ScannerTrayFinish, ScannerTrayRow } from "@/lib/ipc";
import { FINISHES } from "@/lib/finish";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import type { LandedCard } from "./AddedToast";
import { isKnownFinish } from "./trayFinish";

/** The answer of `printing_prices`, keyed by printing id. */
export type TrayPriceMap = ReadonlyMap<string, FinishPrices>;

/** Index the batch read's rows by printing — the shape {@link trayRowPrice} looks up in. */
export function trayPriceMap(rows: readonly PrintingPrices[]): TrayPriceMap {
  return new Map(rows.map((row) => [row.cardId, row.finishPrices]));
}

/**
 * The printings a tray prices — every resolved row's, once each, sorted so the query key does
 * not move when a scan only reorders the pile or bumps a count.
 *
 * **A waiting row asks nothing**: until the reader picks a printing there is no card to price,
 * and quoting its first candidate would be a figure for a card nobody said they hold.
 */
export function trayPriceIds(rows: readonly ScannerTrayRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) if (row.choices.length === 0) ids.add(row.cardId);
  return [...ids].sort();
}

/**
 * One copy of the row's card, or `null` for *unpriced* — which the tray draws as an em dash.
 *
 * - **A known finish is that finish's figure and no other.** The reader (or the camera) has said
 *   which object is in the sleeve, and a foil row quoted at the nonfoil rate is a price nobody
 *   quoted — the crate's rule wherever a finish is named.
 * - **`unknown` is the printing's chain, `nonfoil → foil → etched`** — what every row in this app
 *   that names no finish is priced at (`sorting::printing_price_by_finish_expr`), so a foil-only
 *   promo the camera could not settle still reads its foil price rather than a dash.
 * - **A printing the answer does not hold is unpriced**: the corpus does not know it, or the read
 *   has not landed. The caller tells those two apart, not this.
 */
export function trayRowPrice(row: ScannerTrayRow, prices: TrayPriceMap): number | null {
  return printingPrice(row.cardId, row.finish, prices);
}

/** {@link trayRowPrice}'s rule for one printing in one tray finish — the row's, or a candidate's. */
function printingPrice(
  cardId: string,
  finish: ScannerTrayFinish,
  prices: TrayPriceMap,
): number | null {
  const quoted = prices.get(cardId);
  if (quoted === undefined) return null;
  if (isKnownFinish(finish)) return quoted[finish];
  for (const chained of FINISHES) {
    if (quoted[chained] !== null) return quoted[chained];
  }
  return null;
}

/** The cheapest and the dearest figure a landing could be — one figure twice for a settled card. */
export interface PriceSpan {
  low: number;
  high: number;
}

/**
 * The printings the scan popup (`AddedToast`) prices — the card it filed, or every candidate of a
 * landing still waiting on a pick (issue #1321). Sorted, so the key is the tray's own when the
 * tray holds just this one card.
 *
 * **Unlike {@link trayPriceIds}, a waiting landing asks about its candidates**: the popup quotes
 * no single figure for it, only the span the pick will land in — which is what the reader weighs
 * when deciding whether a pick is worth the bother.
 */
export function landedPriceIds(card: LandedCard): string[] {
  const ids = card.kind === "pick" ? card.choices.map((choice) => choice.cardId) : [card.cardId];
  return [...new Set(ids)].sort();
}

/**
 * What the scan popup quotes: the filed card's figure, or the span across a pick's candidates —
 * each in the landing's finish, by {@link trayRowPrice}'s rule. A candidate the marketplace does
 * not quote is left out of the span rather than read as free; `null` when nothing is quoted.
 */
export function landedPrice(card: LandedCard, prices: TrayPriceMap): PriceSpan | null {
  let span: PriceSpan | null = null;
  for (const cardId of landedPriceIds(card)) {
    const price = printingPrice(cardId, card.finish, prices);
    if (price === null) continue;
    span =
      span === null
        ? { low: price, high: price }
        : { low: Math.min(span.low, price), high: Math.max(span.high, price) };
  }
  return span;
}

/** `$1.50`, or `$0.25 – $12.00` for a span whose ends differ. */
export function formatPriceSpan(span: PriceSpan, currency: Currency): string {
  return span.low === span.high
    ? formatPrice(span.low, currency)
    : `${formatPrice(span.low, currency)} – ${formatPrice(span.high, currency)}`;
}
