import type { MarketplaceId } from "@/lib/marketplace";

import type { OptimizeQuery } from "./useWishlistOptimize";

/**
 * The question the home page's **Wishlist savings** widget and the Wishlist page's
 * `pendingOptimize` hand-off both put to `wishlist_optimize_plan`: **every wish, wherever it is
 * filed, with no filter on** — `flatten: true`, and nothing else but the marketplace.
 *
 * **One builder rather than two literals, because the two must be one question.** The widget
 * counts what the sweep would save and a press on it opens the sweep's dialog, so a reader who
 * pressed a row saving `$18.40` has to meet a dialog planning the same wishes. Built through here
 * the two are also **one cache entry**: `optimizePlanKey` puts this object in the key and TanStack
 * hashes it by value, so the dialog opens on the widget's answer rather than asking again.
 *
 * **An `OptimizeQuery`, not a whole `WishlistQuery`.** `useWishlistOptimize` adds `limit: 0` and
 * `offset: 0` itself — the command ignores both, because a plan covers the whole query rather than
 * a page — and a `sort` cannot change a plan. Neither is part of the question, and carrying either
 * would put it in the key. `marketplace` is always sent because it decides every figure in the
 * answer, which `src/CLAUDE.md` requires of every priced query's key.
 */
export function wholeWishlistQuery(marketplace: MarketplaceId): OptimizeQuery {
  return { flatten: true, marketplace };
}
