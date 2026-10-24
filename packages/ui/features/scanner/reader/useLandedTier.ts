import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { resolveMarketplace, type MarketplaceId } from "@/lib/marketplace";
import { useMarketplace } from "@/lib/useMarketplace";
import { landingNeedsInput, priceTier, type PriceTier } from "../sounds/scanSounds";
import { useScanSoundSettings } from "../sounds/useScanSoundSettings";
import type { LandedCard } from "./AddedToast";
import { landedPrice, landedPriceIds } from "./trayPrice";
import { trayPricesQuery } from "./useTrayPrices";

/**
 * The tier the landing's price reaches, for the popup to colour its figure by — **the sound's own
 * ladder** (`useScanSounds`): the span's high end against the reader's floors.
 *
 * It reads `useLandedPrice`'s query, so the popup asks the corpus once. `null` while unanswered,
 * for a landing that asks the reader something (`landingNeedsInput` — a price for a card they have
 * not said they hold is no tier), unpriced, and below the first floor.
 */
export function useLandedTier(card: LandedCard | null, at?: MarketplaceId): PriceTier | null {
  const { marketplace: own } = useMarketplace();
  const marketplace = at === undefined ? own : resolveMarketplace(at);
  const { sounds } = useScanSoundSettings();
  const ids = useMemo(() => (card === null ? [] : landedPriceIds(card)), [card]);
  const { data } = useQuery(trayPricesQuery(marketplace.id, ids));

  if (card === null || landingNeedsInput(card)) return null;
  if (data === undefined || data.marketplace !== marketplace.id) return null;
  if (!ids.every((id) => data.asked.has(id))) return null;
  const span = landedPrice(card, data.prices);
  return span === null ? null : priceTier(span.high, sounds);
}
