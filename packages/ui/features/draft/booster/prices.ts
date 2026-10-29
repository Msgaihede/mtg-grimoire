/**
 * Every card a set's boosters can hold, priced at the reader's marketplace — the one read the Packs
 * page's figures stand on (spec §2: prices are not in the booster wire; `printingPrices` is the
 * one place a printing's per-finish price is read).
 */
import { useCallback, useMemo } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { ipc, type BoosterSet, type FinishPrices } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { useMarketplace } from "@/lib/useMarketplace";
import { finishPrice, type PriceOf } from "./value";

/**
 * Ids per `printing_prices` call. A play booster's set names 300–400 printings and a collector
 * booster's twice that with its showcase sheets; a call of 500 is a single indexed read the host
 * answers in milliseconds, and the chunking keeps one IPC payload bounded for the sets that name
 * thousands (a masters set with every frame treatment).
 */
const CHUNK = 500;

/**
 * Under `["cards", "prices"]` — the root `useMarketplace`'s feed refresh invalidates — so a Card
 * Kingdom refresh that lands while the page is open re-prices it like every other priced surface.
 * The set's `fetchedAt` is in the key: a Refresh that brings new sheets asks again.
 */
export function boosterPricesKey(marketplace: string, set: BoosterSet | undefined) {
  return ["cards", "prices", "boosters", marketplace, set?.code ?? null, set?.fetchedAt ?? null];
}

const NONE: ReadonlyMap<string, FinishPrices> = new Map();

/**
 * `priceOf` for every card of `set`, at the reader's marketplace; `ready` once the read has
 * answered. Before then (and for a card MTGJSON alone knows, `inCorpus: false`) every price is
 * `null` — drawn as an em dash, counted as 0.
 */
export function useBoosterPrices(set: BoosterSet | undefined): {
  priceOf: PriceOf;
  ready: boolean;
  currency: Currency;
} {
  const { marketplace } = useMarketplace();
  const ids = useMemo(
    () =>
      set === undefined
        ? []
        : [...new Set(set.cards.filter((c) => c.inCorpus).map((c) => c.cardId))].sort(),
    [set],
  );
  const query = useQuery({
    queryKey: boosterPricesKey(marketplace.id, set),
    queryFn:
      set === undefined
        ? skipToken
        : async (): Promise<ReadonlyMap<string, FinishPrices>> => {
            const chunks: string[][] = [];
            for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
            const answers = await Promise.all(
              chunks.map((chunk) => ipc.printingPrices(chunk, marketplace.id)),
            );
            return new Map(answers.flat().map((row) => [row.cardId, row.finishPrices]));
          },
  });
  const prices = query.data ?? NONE;
  const priceOf = useCallback<PriceOf>(
    (cardId, foil) => finishPrice(prices.get(cardId), foil),
    [prices],
  );
  return { priceOf, ready: set !== undefined && query.isSuccess, currency: marketplace.currency };
}
