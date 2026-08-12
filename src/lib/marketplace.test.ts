import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKETPLACE,
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
   * Exactly the two Scryfall feeds. This is the assertion that fails the day someone wires up
   * a third feed and forgets to flip `priced` — or, worse, flips `priced` without wiring one.
   */
  it("can only quote the two marketplaces Scryfall supplies", () => {
    const priced = MARKETPLACE_LIST.filter((m) => m.priced).map((m) => m.id);
    expect(priced).toEqual(["tcgplayer", "cardmarket"]);
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
