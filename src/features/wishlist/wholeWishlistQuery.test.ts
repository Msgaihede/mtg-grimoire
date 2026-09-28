import { describe, expect, it } from "vitest";

import { optimizePlanKey } from "./useWishlistOptimize";
import { WHOLE_WISHLIST, wholeWishlistQuery } from "./wholeWishlistQuery";

describe("wholeWishlistQuery", () => {
  /** Every wish, wherever it is filed, with no filter on — and the marketplace that prices it. */
  it("asks about the whole list, flattened, at the marketplace it is handed", () => {
    expect(wholeWishlistQuery("cardkingdom")).toEqual({ flatten: true, marketplace: "cardkingdom" });
  });

  /**
   * **No paging, no order, no folder and no filter.** `useWishlistOptimize` adds `limit`/`offset`
   * itself and the command ignores both; a `sort` cannot change a plan; and any key present here
   * is a segment of the cache key the widget and the page share.
   */
  it("carries nothing but the two fields the question is made of", () => {
    expect(Object.keys(wholeWishlistQuery("tcgplayer")).sort()).toEqual(["flatten", "marketplace"]);
  });

  /**
   * **The widget's read and the hand-off's dialog are one cache entry.** `optimizePlanKey` puts the
   * object in the key and TanStack hashes it by value, so two builds of the same question are one
   * key — and a marketplace switch is a different one.
   */
  it("files two builds of one question under one plan key, and a second marketplace under another", () => {
    expect(optimizePlanKey(wholeWishlistQuery("manapool"))).toEqual(
      optimizePlanKey(wholeWishlistQuery("manapool")),
    );
    expect(optimizePlanKey(wholeWishlistQuery("manapool"))).not.toEqual(
      optimizePlanKey(wholeWishlistQuery("tcgplayer")),
    );
  });

  /**
   * **A scope's fields appear exactly when they change the answer** (issue #598), so the
   * whole-list question keeps its two-field key and a widget counting the managed wishlists or a
   * few folders is a question — and a cache entry — of its own.
   */
  it("adds the managed switch and the shelves only where the scope asks for them", () => {
    expect(wholeWishlistQuery("tcgplayer", WHOLE_WISHLIST)).toEqual(wholeWishlistQuery("tcgplayer"));
    expect(wholeWishlistQuery("tcgplayer", { includeManaged: true, shelves: null })).toEqual({
      flatten: true,
      marketplace: "tcgplayer",
      includeManaged: true,
    });
    expect(wholeWishlistQuery("tcgplayer", { includeManaged: false, shelves: [0, 3] })).toEqual({
      flatten: true,
      marketplace: "tcgplayer",
      shelves: [0, 3],
    });
  });
});
