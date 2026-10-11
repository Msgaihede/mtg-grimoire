import { describe, expect, it } from "vitest";

import type { CollectionFolder, HomeWidget, WishlistFolder } from "@/lib/ipc";

import { moverScopeOf, priceMoversConfig, priceWatchOf } from "./priceMoversScope";

function widget(config: unknown, kind = "priceMovers", id = "m"): HomeWidget {
  return { id, kind, x: 0, y: 0, w: 2, h: 3, config };
}

const card = (id: string) => ({ id, name: id, setCode: "lea", collectorNumber: "1" });

describe("priceMoversConfig", () => {
  it("drops what a hand edit or a newer build left that this one cannot read", () => {
    expect(
      priceMoversConfig(
        widget({
          collectionFolderIds: [7, "8", 1.5, null],
          wishlistFolderIds: "all",
          cards: [card("bolt"), { id: "" }, "ring", { id: "lotus" }],
        }),
      ),
    ).toEqual({ collectionFolderIds: [7], wishlistFolderIds: [], cards: [card("bolt")] });
  });
});

describe("moverScopeOf", () => {
  it("is no scope at all for a widget over everything owned", () => {
    expect(moverScopeOf(widget({ cards: [card("bolt")] }), [], [])).toBeNull();
  });

  it("expands each cabinet through its own tree, sorted, and keeps each card once", () => {
    const collection = [
      { id: 3, parentId: null },
      { id: 4, parentId: 3 },
      { id: 5, parentId: 4 },
    ] as CollectionFolder[];
    const wishlist = [
      { id: 3, parentId: null },
      { id: 9, parentId: null },
    ] as WishlistFolder[];
    expect(
      moverScopeOf(
        widget({
          scope: "chosen",
          collectionFolderIds: [3, 0, 99],
          wishlistFolderIds: [9],
          cards: [card("ring"), card("bolt"), card("ring")],
        }),
        collection,
        wishlist,
      ),
    ).toEqual({ collectionFolders: [0, 3, 4, 5], wishlistFolders: [9], cards: ["bolt", "ring"] });
  });
});

describe("priceWatchOf", () => {
  it("is every card every Price movers widget names, once and sorted, and nothing else's", () => {
    expect(
      priceWatchOf({
        version: 2,
        widgets: [
          widget({ scope: "chosen", cards: [card("ring"), card("bolt")] }, "priceMovers", "a"),
          widget({ scope: "owned", cards: [card("bolt"), card("lotus")] }, "priceMovers", "b"),
          widget({ cards: [card("ignored")] }, "recentCards", "c"),
        ],
      }),
    ).toEqual(["bolt", "lotus", "ring"]);
  });
});
