import type { MarketplaceId } from "@/lib/marketplace";

/**
 * The card modal's two other `["card", …]` reads, spelled once for **both faces of the app** —
 * the desktop's `CardDetailModal` and the phone's card sheet — for `cardDetailKey`'s reason one
 * read over: two faces share one query client, so a card a reader had open on one side of the
 * 1024px floor paints from the cache on the other only while both ask under the identical key. A
 * second spelling still works, still passes every test, and quietly pays its own round trip.
 */

/**
 * Every printing of one oracle card at one marketplace — `card_printings` with no `limit`, which
 * answers `MAX_PRINTINGS` and a `total` that is not capped.
 *
 * **The page size is part of the question and is not in the key, and that is why the key is
 * this exact shape.** `AllPrintingsDialog` asks for the backend's hard ceiling instead, and keys
 * its read with the page size as a fifth segment for exactly that reason; a reader of *this* key
 * must ask with no `limit`, or it files a different answer under the modal's entry.
 */
export function cardPrintingsKey(oracleId: string | null, marketplace: MarketplaceId) {
  return ["card", "printings", oracleId, marketplace] as const;
}

/**
 * The **In your grimoire** figures' prefix, under `["card", …]` beside the card's other two reads.
 *
 * **`["card"]` and not one of the three roots the answer is derived from, because no key can be
 * under all three.** `invalidateQueries` matches by key *prefix*, so a key rooted at
 * `["collection"]` is refreshed by a collection write and missed by a wish; one rooted at
 * `["decks"]` is missed by both. The old block sidestepped this by being **three** queries, one
 * under each root — that is what it cost to have the app's existing invalidation vocabulary
 * reach it, and folding them into one read gives the property up. `CardDetailModal`'s
 * `useHoldingsFreshness` is what replaces it.
 *
 * The bare prefix is what a caller invalidates: only one oracle card is ever mounted at a time,
 * and a key naming the card would have to be rebuilt at every site that settles a write.
 * `lib/crossWindow.ts` spells the same two segments for the one invalidation it owes.
 */
export const HOLDINGS_KEY = ["card", "holdings"] as const;

/**
 * One oracle card's figures — `card_holdings`, read at the oracle grain because a reader who owns
 * the Alpha Bolt and opens the 2X2 one owns *Lightning Bolt*.
 *
 * **No marketplace**, unlike the printings above: these are counts, and nothing about them moves
 * when the setting does.
 */
export function cardHoldingsKey(oracleId: string | null) {
  return [...HOLDINGS_KEY, oracleId] as const;
}
