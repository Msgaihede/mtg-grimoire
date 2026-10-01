import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ipc, type ScannerTrayRow } from "@/lib/ipc";
import type { Currency, MarketplaceId } from "@/lib/marketplace";
import { useMarketplace } from "@/lib/useMarketplace";
import { trayPriceIds, trayPriceMap, trayRowPrice, type TrayPriceMap } from "./trayPrice";

/**
 * The root every tray price query sits under — `["cards", "prices"]`, which
 * `useMarketplace`'s feed-refresh sweep invalidates, so a Card Kingdom refresh that lands while
 * the tray is open re-prices it like every other priced surface.
 */
export const TRAY_PRICES_KEY = ["cards", "prices"] as const;

/** What one answered read holds: where and for which ids it was asked, and what it quoted. */
interface Answered {
  marketplace: MarketplaceId;
  asked: ReadonlySet<string>;
  prices: TrayPriceMap;
}

/**
 * Each tray row's price, at the marketplace the reader picked.
 *
 * **One round trip for the whole tray**, keyed on the marketplace and the sorted printing ids —
 * so a second copy of a card already there, a finish change or a reorder asks nothing, and a new
 * printing asks once. `keepPreviousData` keeps the figures already drawn on screen while that
 * one read is in flight, so scanning a card does not blank every price in the pile.
 *
 * **`undefined` is "not answered yet" and draws nothing; `null` is "unpriced" and draws an em
 * dash.** They are different statements, which is why the answer carries the ids it was asked
 * about: a card that has only just landed is absent from the previous key's answer, and reading
 * that absence as unpriced would flash a dash under every new scan. It carries its marketplace
 * for the same reason one switch over: the previous key's dollars, kept while the euro read is in
 * flight, would otherwise be drawn in the new currency.
 */
export function useTrayPrices(rows: readonly ScannerTrayRow[]): {
  priceOf: (row: ScannerTrayRow) => number | null | undefined;
  currency: Currency;
  marketplaceLabel: string;
} {
  const { marketplace } = useMarketplace();
  const ids = useMemo(() => trayPriceIds(rows), [rows]);
  const query = useQuery({
    queryKey: [...TRAY_PRICES_KEY, marketplace.id, ids],
    queryFn:
      ids.length === 0
        ? skipToken
        : async (): Promise<Answered> => ({
            marketplace: marketplace.id,
            asked: new Set(ids),
            prices: trayPriceMap(await ipc.printingPrices(ids, marketplace.id)),
          }),
    placeholderData: keepPreviousData,
  });
  const answered = query.data;

  return {
    priceOf: (row) =>
      answered === undefined ||
      answered.marketplace !== marketplace.id ||
      row.choices.length > 0 ||
      !answered.asked.has(row.cardId)
        ? undefined
        : trayRowPrice(row, answered.prices),
    currency: marketplace.currency,
    marketplaceLabel: marketplace.label,
  };
}
