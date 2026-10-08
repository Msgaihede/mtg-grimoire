/**
 * What one scanned card costs, at the marketplace the reader picked — the tray's price line.
 *
 * **Rust quotes, TypeScript picks.** `printing_prices` answers three figures per printing, one per
 * finish, built by the crate's one `price_expr`; which of the three a tray row is, is this
 * module's. It is the row's finish and nothing else, with one arm for a finish not settled yet.
 */
import type { FinishPrices, PrintingPrices, ScannerTrayRow } from "@/lib/ipc";
import { FINISHES } from "@/lib/finish";
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
  const quoted = prices.get(row.cardId);
  if (quoted === undefined) return null;
  if (isKnownFinish(row.finish)) return quoted[row.finish];
  for (const finish of FINISHES) {
    if (quoted[finish] !== null) return quoted[finish];
  }
  return null;
}
