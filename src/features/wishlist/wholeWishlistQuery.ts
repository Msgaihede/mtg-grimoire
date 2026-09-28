import type { MarketplaceId } from "@/lib/marketplace";

import type { OptimizeQuery } from "./useWishlistOptimize";

/**
 * Which wishes a savings sweep over "the whole wishlist" is taken over — the home page's
 * **Wishlist savings** widget's two settings, and the hand-off that opens the Wishlist's dialog on
 * the same question ([issue #598](https://github.com/Msgaihede/mtg-grimoire/issues/598)).
 */
export interface SweepScope {
  /**
   * Whether the decks' **managed wishlists** are in scope. They are still wishlists — a managed
   * wish is money the reader has yet to spend — so the widget counts them unless its reader
   * switches them off. The plan marks each of their moves `managed`, and the dialog offers none of
   * them: the wish is the deck's printing, and only the deck can change it.
   */
  includeManaged: boolean;
  /**
   * The shelves to plan — folder ids, `0` for the root — **already expanded to every folder
   * inside the ones the reader chose**, because `WishlistQuery.shelves` answers direct members
   * only. `null` is every wish, wherever it is filed.
   */
  shelves: readonly number[] | null;
}

/** Every wish in every folder, the managed ones left out — the question as it stood before
 *  issue #598, and what a caller that names no scope still asks. */
export const WHOLE_WISHLIST: SweepScope = { includeManaged: false, shelves: null };

/**
 * The question the home page's **Wishlist savings** widget and the Wishlist page's
 * `pendingOptimize` hand-off both put to `wishlist_optimize_plan`: **every wish the widget's scope
 * names, wherever it is filed, with no filter on** — `flatten: true`, the marketplace, and the two
 * {@link SweepScope} fields where they differ from {@link WHOLE_WISHLIST}.
 *
 * **One builder rather than two literals, because the two must be one question.** The widget
 * counts what the sweep would save and a press on it opens the sweep's dialog, so a reader who
 * pressed a row saving `$18.40` has to meet a dialog planning the same wishes. Built through here
 * the two are also **one cache entry**: `optimizePlanKey` puts this object in the key and TanStack
 * hashes it by value, so the dialog opens on the widget's answer rather than asking again.
 *
 * **A default is left out rather than spelled**, so the whole-list question keeps the two-field
 * key it has always had, and a scope's fields appear in the key exactly when they change the
 * answer.
 *
 * **An `OptimizeQuery`, not a whole `WishlistQuery`.** `useWishlistOptimize` adds `limit: 0` and
 * `offset: 0` itself — the command ignores both, because a plan covers the whole query rather than
 * a page — and a `sort` cannot change a plan. Neither is part of the question, and carrying either
 * would put it in the key. `marketplace` is always sent because it decides every figure in the
 * answer, which `src/CLAUDE.md` requires of every priced query's key.
 */
export function wholeWishlistQuery(
  marketplace: MarketplaceId,
  scope: SweepScope = WHOLE_WISHLIST,
): OptimizeQuery {
  return {
    flatten: true,
    marketplace,
    ...(scope.includeManaged ? { includeManaged: true } : {}),
    ...(scope.shelves === null ? {} : { shelves: [...scope.shelves] }),
  };
}
