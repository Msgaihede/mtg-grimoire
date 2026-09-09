import { beforeEach, describe, expect, it, vi } from "vitest";
import { openExternal } from "@/lib/externalLinks";
import type { TcgplayerIds } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";

/**
 * The door out of the app, mocked, because this file's subject is **which URL** a press is handed
 * rather than what a webview does with it — and `openExternal` is the app's single impure call, so
 * stubbing it is what makes the whole module testable. The rest of `externalLinks` keeps its real
 * implementation on purpose: the URLs asserted below are what a reader's browser would receive, so
 * a builder faked here would prove nothing about them.
 */
vi.mock("@/lib/externalLinks", async (original) => ({
  ...(await original<typeof import("@/lib/externalLinks")>()),
  openExternal: vi.fn(() => Promise.resolve()),
}));

/**
 * **Only `cardTcgplayerIds` is faked, and it answers exactly the shape the Rust command
 * serialises** — `{ productId, etchedProductId }`, both `number | null`, `null`s spelled out. A
 * `vi.fn()` standing in for the whole `ipc` object erases the hand-written mirror that stands in
 * for the compiler across this boundary, and a fake answering a shape the command cannot produce
 * (an absent field, an `undefined`, a bare number) is a suite passing over a defect. So the real
 * module is spread and one method replaced, which also keeps {@link TcgplayerIds} the type both
 * sides are written against.
 */
const cardTcgplayerIds = vi.fn<(id: string) => Promise<TcgplayerIds>>();
vi.mock("@/lib/ipc", async (original) => {
  const actual = await original<typeof import("@/lib/ipc")>();
  // Through an arrow, never the binding itself: `vi.mock` is hoisted above every `const` in this
  // file, so naming the spy directly is a TDZ error at import time and the whole suite fails to
  // collect. The repo's other `ipc` mocks are written this way for the same reason.
  return {
    ...actual,
    ipc: { ...actual.ipc, cardTcgplayerIds: (id: string) => cardTcgplayerIds(id) },
  };
});

import { chooseTcgplayerLink, linkFinish, openMarketplaceForCard } from "./openMarketplace";

/** The two ids as the command answers them — `null` for a product TCGplayer does not have. */
function ids(productId: number | null, etchedProductId: number | null): TcgplayerIds {
  return { productId, etchedProductId };
}

beforeEach(() => {
  vi.mocked(openExternal).mockClear();
  cardTcgplayerIds.mockReset();
});

describe("linkFinish", () => {
  it("takes the finish the surface named over the printing's own", () => {
    // A collection row's `finish`, a deck row's, a wishlist's `preferred_finish` — each is the
    // reader's statement about the very copy they are going shopping for, so it outranks the
    // object's. `playedFinish`'s order, one surface over.
    expect(linkFinish("foil", '["nonfoil","foil"]')).toBe("foil");
    expect(linkFinish("nonfoil", '["nonfoil","foil"]')).toBe("nonfoil");
    expect(linkFinish("etched", '["nonfoil","foil","etched"]')).toBe("etched");
    // **The rows above cannot tell the two orders apart, and these can.** A printing sold in more
    // than one finish makes the sole-finish arm answer `null` whichever rule is tried first, so an
    // order assertion over one is vacuous — it needs a fixture that *disagrees*. These two do: a
    // printing listed in exactly one finish, and a surface naming a different one. Measured, not
    // reasoned: an implementation that read the printing first passed all three rows above and
    // failed only here.
    expect(linkFinish("foil", '["nonfoil"]')).toBe("foil");
    expect(linkFinish("nonfoil", '["etched"]')).toBe("nonfoil");
  });

  it("falls back to the printing's sole finish when the surface says nothing", () => {
    expect(linkFinish(null, '["foil"]')).toBe("foil");
    expect(linkFinish(undefined, '["etched"]')).toBe("etched");
  });

  it("answers `nonfoil` for a nonfoil-only printing, where `soleFinish` deliberately answers null", () => {
    // The one row where this function and `@/lib/finish`'s `soleFinish` differ, and the divergence
    // is the point: `soleFinish` says "draw no foil mark" about a plain card, which is honest for
    // card art. Here the printing is sold in exactly one finish and TCGplayer has a word for it,
    // so `Normal` is the right thing to assert rather than nothing.
    expect(linkFinish(null, '["nonfoil"]')).toBe("nonfoil");
  });

  it("answers null for a printing sold in more than one finish with nothing said about it", () => {
    // Which one the reader wants is genuinely unknown; the unfiltered page beats a guess.
    expect(linkFinish(null, '["nonfoil","foil"]')).toBe(null);
    expect(linkFinish(undefined, '["nonfoil","foil","etched"]')).toBe(null);
  });

  it("answers null for a finishes column that says nothing at all", () => {
    // `parseFinishes` drops what it cannot read rather than guessing, so a null column, a broken
    // blob and an empty list all arrive here as "no printing statement".
    expect(linkFinish(null, null)).toBe(null);
    expect(linkFinish(null, "not json")).toBe(null);
    expect(linkFinish(null, "[]")).toBe(null);
    // An unknown word is dropped too, which leaves one recognised finish and therefore an answer.
    expect(linkFinish(null, '["glossy","foil"]')).toBe("foil");
  });
});

describe("chooseTcgplayerLink", () => {
  it("opens the etched product at Foil when there is an etched id", () => {
    // The etched product's own subtype is `Foil` — `484936 The Ur-Dragon (Foil Etched)`, measured
    // 2026-09-09. Etched is not a third `Printing` word.
    expect(chooseTcgplayerLink(ids(1174, 484936), "etched")).toEqual({
      productId: 484936,
      printing: "Foil",
    });
  });

  it("opens the ordinary product with no printing for etched when there is no etched id", () => {
    // The closest page for the card, but the etched copy is not sold under it, so naming a
    // printing would be a guess about a row that is not the one asked for.
    expect(chooseTcgplayerLink(ids(1174, null), "etched")).toEqual({
      productId: 1174,
      printing: null,
    });
  });

  it("opens either product at Foil for a foil, preferring the ordinary one", () => {
    // Both products sell a `Foil` row. 333 printings carry both ids, and on those "foil" means the
    // plain foil rather than the etched card.
    expect(chooseTcgplayerLink(ids(1174, 484936), "foil")).toEqual({
      productId: 1174,
      printing: "Foil",
    });
    expect(chooseTcgplayerLink(ids(null, 484936), "foil")).toEqual({
      productId: 484936,
      printing: "Foil",
    });
  });

  it("opens the ordinary product at Normal for a nonfoil", () => {
    expect(chooseTcgplayerLink(ids(1174, 484936), "nonfoil")).toEqual({
      productId: 1174,
      printing: "Normal",
    });
  });

  it("opens the etched product with no printing for a nonfoil that has only that id", () => {
    // An etched product has no `Normal` row, so this appends nothing rather than asking for one.
    expect(chooseTcgplayerLink(ids(null, 484936), "nonfoil")).toEqual({
      productId: 484936,
      printing: null,
    });
  });

  it("asserts no printing at all when the finish is unknown", () => {
    // Neither the reader nor the printing named one, so the page opens unfiltered — which the
    // bare URL was measured to be: neither checkbox checked, every listing shown.
    expect(chooseTcgplayerLink(ids(1174, 484936), null)).toEqual({
      productId: 1174,
      printing: null,
    });
    expect(chooseTcgplayerLink(ids(null, 484936), null)).toEqual({
      productId: 484936,
      printing: null,
    });
  });

  it("answers null when there is no id to open, for every finish", () => {
    // 1.62 % of paper English non-token printings, and every digital-only card. The caller's cue
    // to search by name instead — never a URL built from a missing id.
    expect(chooseTcgplayerLink(ids(null, null), "nonfoil")).toBe(null);
    expect(chooseTcgplayerLink(ids(null, null), "foil")).toBe(null);
    expect(chooseTcgplayerLink(ids(null, null), "etched")).toBe(null);
    expect(chooseTcgplayerLink(ids(null, null), null)).toBe(null);
  });
});

describe("openMarketplaceForCard", () => {
  /**
   * The URLs below are written out as literal strings rather than built from the builders under
   * test: an assertion that reads its own constant passes whatever the constant becomes, which has
   * cost this repo three green tests over one defect before.
   */
  const BOLT = {
    marketplace: MARKETPLACES.tcgplayer,
    cardId: "bolt-lea",
    cardName: "Lightning Bolt",
  };

  it("opens the exact product page at the printing the surface named", async () => {
    // Lightning Bolt (LEA) really is `tcgplayer_id: 1174`, and this URL answered 200 live on
    // 2026-09-09. That the parameter *selects* rather than decorates was driven in Chrome over CDP
    // the same day, on product 484935: Foil and Normal each 4 listings with the matching checkbox
    // checked, the bare URL all 8 with neither — 4 + 4 = 8. Chrome and not the app's WebView2, so
    // it settles TCGplayer's end of this press and not the app's.
    cardTcgplayerIds.mockResolvedValue(ids(1174, null));
    await openMarketplaceForCard({ ...BOLT, finish: "foil", finishes: '["nonfoil","foil"]' });
    expect(cardTcgplayerIds).toHaveBeenCalledExactlyOnceWith("bolt-lea");
    expect(vi.mocked(openExternal)).toHaveBeenCalledExactlyOnceWith(
      "https://www.tcgplayer.com/product/1174?Printing=Foil",
    );
  });

  it("opens the printing's sole finish when the surface named none", async () => {
    cardTcgplayerIds.mockResolvedValue(ids(1174, null));
    await openMarketplaceForCard({ ...BOLT, finish: null, finishes: '["nonfoil"]' });
    expect(vi.mocked(openExternal)).toHaveBeenCalledExactlyOnceWith(
      "https://www.tcgplayer.com/product/1174?Printing=Normal",
    );
  });

  it("opens the etched product for an etched copy", async () => {
    cardTcgplayerIds.mockResolvedValue(ids(1174, 484936));
    await openMarketplaceForCard({
      marketplace: MARKETPLACES.tcgplayer,
      cardId: "urdragon-cmm",
      cardName: "The Ur-Dragon",
      finish: "etched",
      finishes: '["nonfoil","foil","etched"]',
    });
    expect(vi.mocked(openExternal)).toHaveBeenCalledExactlyOnceWith(
      "https://www.tcgplayer.com/product/484936?Printing=Foil",
    );
  });

  it("appends nothing when the id chosen cannot be sold in the finish asked for", async () => {
    // The governing rule, end to end: an etched copy on a printing with no etched id lands on the
    // ordinary product, unfiltered.
    cardTcgplayerIds.mockResolvedValue(ids(1174, null));
    await openMarketplaceForCard({ ...BOLT, finish: "etched", finishes: '["nonfoil","etched"]' });
    expect(vi.mocked(openExternal)).toHaveBeenCalledExactlyOnceWith(
      "https://www.tcgplayer.com/product/1174",
    );
  });

  it("falls back to the name search when the printing has neither id", async () => {
    cardTcgplayerIds.mockResolvedValue(ids(null, null));
    await openMarketplaceForCard({ ...BOLT, finish: "foil", finishes: '["nonfoil","foil"]' });
    expect(vi.mocked(openExternal)).toHaveBeenCalledExactlyOnceWith(
      "https://www.tcgplayer.com/search/magic/product?q=Lightning%20Bolt",
    );
  });

  it("falls back to the name search when the command rejects", async () => {
    // The command is built to answer two `null`s rather than reject, so this arm is for the
    // failures that are not about the card — a locked database, a webview that lost the bridge.
    // A press must never do nothing, so the rejection is swallowed and the site still opens.
    cardTcgplayerIds.mockRejectedValue(new Error("database is locked"));
    await expect(
      openMarketplaceForCard({ ...BOLT, finish: null, finishes: '["nonfoil"]' }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(openExternal)).toHaveBeenCalledExactlyOnceWith(
      "https://www.tcgplayer.com/search/magic/product?q=Lightning%20Bolt",
    );
  });

  it("asks for no id at all at a marketplace that is not TCGplayer", async () => {
    // Written as an absence, because that is the claim: the other four publish no derivable
    // product URL, so a Cardmarket press has no business spending a TCGplayer lookup. The
    // opened URL is asserted beside it so the absence cannot be the absence of the whole call.
    await openMarketplaceForCard({
      marketplace: MARKETPLACES.cardmarket,
      cardId: "bolt-lea",
      cardName: "Lightning Bolt",
      finish: "foil",
      finishes: '["nonfoil","foil"]',
    });
    expect(cardTcgplayerIds).not.toHaveBeenCalled();
    expect(vi.mocked(openExternal)).toHaveBeenCalledExactlyOnceWith(
      "https://www.cardmarket.com/en/Magic/Products/Search?searchString=Lightning%20Bolt",
    );
  });

  it("asks for no id at any of the other four marketplaces", async () => {
    // The whole complement rather than one sample, so a fifth marketplace added to
    // `MARKETPLACE_IDS` cannot quietly start spending a TCGplayer lookup.
    for (const id of ["cardmarket", "cardkingdom", "manapool", "cardtrader"] as const) {
      await openMarketplaceForCard({
        marketplace: MARKETPLACES[id],
        cardId: "bolt-lea",
        cardName: "Lightning Bolt",
        finish: "foil",
        finishes: '["nonfoil","foil"]',
      });
    }
    expect(cardTcgplayerIds).not.toHaveBeenCalled();
    expect(vi.mocked(openExternal)).toHaveBeenCalledTimes(4);
  });
});
