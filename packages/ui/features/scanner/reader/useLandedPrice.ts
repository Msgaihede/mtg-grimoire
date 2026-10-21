import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { resolveMarketplace, type MarketplaceId } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import type { LandedCard } from "./AddedToast";
import { formatPriceSpan, landedPrice, landedPriceIds } from "./trayPrice";
import { trayPricesQuery } from "./useTrayPrices";

/**
 * The scan popup's price line (issue #1321): what the card that just landed costs, or the span
 * across its candidates while it waits on a pick — written out, ready to draw.
 *
 * **`undefined` is "not answered yet" and draws nothing; an em dash is "unpriced"** — the tray's
 * two states (`useTrayPrices`), for its reason: a dash under a card whose read is still in flight
 * would say *unpriced* about a card nobody has asked about yet. A pick is unpriced only when none
 * of its candidates is quoted. **No `keepPreviousData`**: a landing drawn with the card before's
 * figure would be a price for a card nobody scanned.
 *
 * **`at` is the tray's** — the destination's marketplace while the tray files onto a trade — so
 * the figure over the camera is the one its row will show. The read is `useTrayPrices`' own query,
 * under the root its feed refresh invalidates.
 */
export function useLandedPrice(card: LandedCard | null, at?: MarketplaceId): string | undefined {
  const { marketplace: own } = useMarketplace();
  const marketplace = at === undefined ? own : resolveMarketplace(at);
  const ids = useMemo(() => (card === null ? [] : landedPriceIds(card)), [card]);
  const { data } = useQuery(trayPricesQuery(marketplace.id, ids));

  if (card === null || data === undefined || data.marketplace !== marketplace.id) return undefined;
  if (!ids.every((id) => data.asked.has(id))) return undefined;
  const span = landedPrice(card, data.prices);
  return span === null
    ? formatPrice(null, marketplace.currency)
    : formatPriceSpan(span, marketplace.currency);
}
