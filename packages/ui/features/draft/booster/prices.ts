/**
 * Every card a set's boosters can hold, priced at the marketplaces the Packs page names — the one
 * read the page's figures stand on (spec §2: prices are not in the booster wire; `printingPrices`
 * is the one place a printing's per-finish price is read).
 *
 * **Several marketplaces, and a card is worth the lowest any of them quotes** (issue #1446): one
 * read per marketplace, each in its own cache entry so a marketplace added to the pick asks for
 * its own prices and nobody else's, then {@link lowestPrices} per finish. **Every answer is in the
 * page's currency before it is compared** (issue #1463): each source carries the factor its
 * marketplace's prices are multiplied by (`packs/currency.ts`), 1 for one in the page's own
 * currency. The cache holds each marketplace's prices as it quoted them, so a new rate converts
 * without asking again. No price is ever taken from a marketplace the reader did not pick.
 */
import { useCallback, useMemo } from "react";
import { skipToken, useQueries } from "@tanstack/react-query";
import { ipc, type BoosterSet, type FinishPrices } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import type { PriceSource } from "../packs/currency";
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

/** The lower of two quotes, where `null` is "not quoted" rather than free. */
function lower(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * Each card's lowest quote **per finish** across `answers` — one map per marketplace.
 *
 * Per finish and not per card, so `finishPrice`'s fallback stays a finish's: a foil one
 * marketplace quotes and another does not is that marketplace's foil price, never the other's
 * non-foil standing in for it.
 */
export function lowestPrices(
  answers: readonly ReadonlyMap<string, FinishPrices>[],
): ReadonlyMap<string, FinishPrices> {
  if (answers.length === 1) return answers[0];
  const out = new Map<string, FinishPrices>();
  for (const answer of answers) {
    for (const [cardId, prices] of answer) {
      const seen = out.get(cardId);
      out.set(
        cardId,
        seen === undefined
          ? prices
          : {
              nonfoil: lower(seen.nonfoil, prices.nonfoil),
              foil: lower(seen.foil, prices.foil),
              etched: lower(seen.etched, prices.etched),
            },
      );
    }
  }
  return out;
}

/** `null` stays "not quoted"; anything else is multiplied by `factor`. */
function scaled(price: number | null, factor: number): number | null {
  return price === null ? null : price * factor;
}

/**
 * One marketplace's answer in the page's currency: every finish of every card multiplied by
 * `factor`. A factor of 1 is the answer itself, untouched.
 */
export function convertPrices(
  answer: ReadonlyMap<string, FinishPrices>,
  factor: number,
): ReadonlyMap<string, FinishPrices> {
  if (factor === 1) return answer;
  const out = new Map<string, FinishPrices>();
  for (const [cardId, prices] of answer) {
    out.set(cardId, {
      nonfoil: scaled(prices.nonfoil, factor),
      foil: scaled(prices.foil, factor),
      etched: scaled(prices.etched, factor),
    });
  }
  return out;
}

/**
 * The reads, side by side. **At module scope on purpose**: TanStack re-runs a `combine` it is
 * handed a new reference to on every render, and only a stable one when the reads themselves
 * change — so the answers, and the `priceOf` built on them, keep their identity between renders.
 */
function combine(
  results: readonly { data?: ReadonlyMap<string, FinishPrices>; isSuccess: boolean }[],
) {
  return {
    answers: results.map((r) => r.data ?? NONE),
    ready: results.length > 0 && results.every((r) => r.isSuccess),
  };
}

/**
 * `priceOf` for every card of `set`, in `currency`, at the lowest of `sources` once each is
 * converted; `ready` once every read has answered. Before then (and for a card MTGJSON alone
 * knows, `inCorpus: false`) every price is `null` — drawn as an em dash, counted as 0.
 */
export function useBoosterPrices(
  set: BoosterSet | undefined,
  sources: readonly PriceSource[],
  currency: Currency,
): {
  priceOf: PriceOf;
  ready: boolean;
  currency: Currency;
} {
  const ids = useMemo(
    () =>
      set === undefined
        ? []
        : [...new Set(set.cards.filter((c) => c.inCorpus).map((c) => c.cardId))].sort(),
    [set],
  );
  const { answers, ready } = useQueries({
    queries: sources.map(({ marketplace }) => ({
      queryKey: boosterPricesKey(marketplace.id, set),
      queryFn:
        set === undefined
          ? skipToken
          : async (): Promise<ReadonlyMap<string, FinishPrices>> => {
              const chunks: string[][] = [];
              for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
              const rows = await Promise.all(
                chunks.map((chunk) => ipc.printingPrices(chunk, marketplace.id)),
              );
              return new Map(rows.flat().map((row) => [row.cardId, row.finishPrices]));
            },
    })),
    combine,
  });
  // The factors as one value, so a render that names the same rates converts nothing again.
  const factors = sources.map((s) => s.factor).join(",");
  const prices = useMemo(() => {
    const each = factors.split(",").map(Number);
    return lowestPrices(answers.map((answer, i) => convertPrices(answer, each[i] ?? 1)));
  }, [answers, factors]);
  const priceOf = useCallback<PriceOf>(
    (cardId, foil) => finishPrice(prices.get(cardId), foil),
    [prices],
  );
  return {
    priceOf,
    ready: set !== undefined && ready,
    currency,
  };
}
