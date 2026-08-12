import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKETPLACE,
  FEED_MARKETPLACES,
  MARKETPLACES,
  MARKETPLACE_IDS,
  MARKETPLACE_LIST,
  isMarketplaceId,
  resolveMarketplace,
} from "./marketplace";

describe("the marketplace table", () => {
  /**
   * The table is a `Record` keyed by the same union it stores, so a typo in a key is a type
   * error — but a typo in an entry's own `id` is not, and that field is what a click writes
   * back to the database. A mismatch would store a marketplace nobody can resolve.
   */
  it("keys every entry by its own id", () => {
    for (const id of MARKETPLACE_IDS) {
      expect(MARKETPLACES[id].id).toBe(id);
    }
  });

  it("offers the five the user asked for, in picker order", () => {
    expect(MARKETPLACE_LIST.map((m) => m.label)).toEqual([
      "TCGplayer",
      "Cardmarket",
      "Card Kingdom",
      "Mana Pool",
      "Card trader",
    ]);
  });

  /**
   * Currency is the axis every price function turns on, so getting one wrong here quotes a
   * whole marketplace in the wrong money — silently, and everywhere at once.
   */
  it("knows which money each one deals in", () => {
    expect(MARKETPLACES.tcgplayer.currency).toBe("usd");
    expect(MARKETPLACES.cardkingdom.currency).toBe("usd");
    expect(MARKETPLACES.manapool.currency).toBe("usd");
    expect(MARKETPLACES.cardmarket.currency).toBe("eur");
    expect(MARKETPLACES.cardtrader.currency).toBe("eur");
  });

  /**
   * **Four priced, and Card trader is the one that is not.**
   *
   * This assertion was written to fail exactly when a third source landed, and it did: two
   * marketplaces came out of Scryfall's `prices` blob, and Card Kingdom and Mana Pool now come
   * out of their own public bulk feeds — keyed by `scryfall_id`, so the join is exact rather
   * than fuzzy, which is the fact that made them possible at all.
   *
   * It still fails the day someone flips `priced` without wiring a feed, or wires one and
   * forgets to flip it. Card trader stays out for a reason that is not a matter of effort: its
   * API needs a per-user JWT and publishes no bulk download, so there is nothing this app could
   * sync on the reader's behalf.
   */
  it("can quote the four with a feed, and not the one without", () => {
    const priced = MARKETPLACE_LIST.filter((m) => m.priced).map((m) => m.id);
    expect(priced).toEqual(["tcgplayer", "cardmarket", "cardkingdom", "manapool"]);
    expect(MARKETPLACES.cardtrader.priced).toBe(false);
  });

  /**
   * **Which prices are downloaded, and which arrive with the card data** — the one thing
   * outside this module anything is allowed to branch on, and only ever to talk *about* a feed.
   *
   * `feed` is not `priced`: TCGplayer and Cardmarket are quotable and have no download of their
   * own, so they have no age, no refresh and no state to show. Card trader is neither, because
   * "no feed" and "a feed we have not built" are the same thing from here.
   */
  it("knows which two marketplaces it downloads prices for", () => {
    expect(FEED_MARKETPLACES.map((m) => m.id)).toEqual(["cardkingdom", "manapool"]);
    expect(MARKETPLACES.tcgplayer.feed).toBe(false);
    expect(MARKETPLACES.cardmarket.feed).toBe(false);
    expect(MARKETPLACES.cardtrader.feed).toBe(false);
    // Every feed-backed one is quotable: a feed nobody may select is a download nobody wants.
    for (const m of FEED_MARKETPLACES) expect(m.priced).toBe(true);
  });

  it("defaults to the one every price in the app used to be", () => {
    expect(DEFAULT_MARKETPLACE).toBe("tcgplayer");
    expect(MARKETPLACES[DEFAULT_MARKETPLACE].priced).toBe(true);
  });
});

describe("resolving a stored id", () => {
  it("takes one it knows", () => {
    expect(resolveMarketplace("cardmarket").id).toBe("cardmarket");
  });

  /**
   * The setting is written by *some* build of this app. A newer build's id landing in an older
   * one is a downgrade, not a corruption, and failing every price query over it would be the
   * worse answer — so an unreadable setting reads as the default.
   */
  it("falls back rather than failing on anything else", () => {
    expect(resolveMarketplace("ebay").id).toBe(DEFAULT_MARKETPLACE);
    expect(resolveMarketplace("").id).toBe(DEFAULT_MARKETPLACE);
    expect(resolveMarketplace(null).id).toBe(DEFAULT_MARKETPLACE);
    expect(resolveMarketplace(undefined).id).toBe(DEFAULT_MARKETPLACE);
  });

  it("narrows a raw string only when it is really one of them", () => {
    expect(isMarketplaceId("manapool")).toBe(true);
    expect(isMarketplaceId("ManaPool")).toBe(false);
    expect(isMarketplaceId("")).toBe(false);
  });
});
