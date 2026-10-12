import { describe, expect, it } from "vitest";
import type { WishlistFolder } from "@/lib/ipc";
import { WHOLE_WISHLIST_KEY, wishlistShareTarget } from "./wishlistShare";

function folder(over: Partial<WishlistFolder> = {}): WishlistFolder {
  return {
    id: 1,
    parentId: null,
    name: "Buy list",
    sortOrder: 0,
    managedDeckId: null,
    managedTokens: false,
    syncUid: "wuid-buy",
    managedDeckUid: null,
    ...over,
  };
}

/** The four keys `share::wishlist::WishlistKey::parse` reads — spelled on both sides. */
describe("the wishlist's share keys", () => {
  it("shares the whole list from the root, under a key of its own and never null", () => {
    expect(wishlistShareTarget(null, [])).toEqual({
      kind: "wishlist",
      uid: "wishlist:",
      title: "Wishlist",
    });
    expect(WHOLE_WISHLIST_KEY).toBe("wishlist:");
  });

  it("names a folder the reader made by its own uid", () => {
    expect(wishlistShareTarget(folder(), [])).toEqual({
      kind: "wishlist",
      uid: "wishlist:folder:wuid-buy",
      title: "Buy list",
    });
  });

  /** A managed folder's own uid is per device; the deck's syncs, so a second device finds it. */
  it("names a managed wishlist and its Tokens child by their deck's uid", () => {
    const own = folder({
      id: 5,
      name: "Krenko",
      managedDeckId: 4,
      syncUid: null,
      managedDeckUid: "deckuid",
    });
    const tokens = folder({
      id: 6,
      parentId: 5,
      name: "Tokens",
      managedDeckId: 4,
      managedTokens: true,
      syncUid: null,
      managedDeckUid: "deckuid",
    });
    expect(wishlistShareTarget(own, [own, tokens])).toEqual({
      kind: "wishlist",
      uid: "wishlist:deck:deckuid",
      title: "Krenko",
    });
    expect(wishlistShareTarget(tokens, [own, tokens])).toEqual({
      kind: "wishlist",
      uid: "wishlist:deck-tokens:deckuid",
      title: "Krenko tokens",
    });
  });

  /** No fallback: a key for some other set of wishes would publish under the reader's press. */
  it("names no target where the list gave no uid", () => {
    expect(wishlistShareTarget(folder({ syncUid: null }), [])).toBeNull();
    expect(wishlistShareTarget(folder({ syncUid: "" }), [])).toBeNull();
    expect(
      wishlistShareTarget(folder({ managedDeckId: 4, syncUid: "x", managedDeckUid: null }), []),
    ).toBeNull();
  });
});
