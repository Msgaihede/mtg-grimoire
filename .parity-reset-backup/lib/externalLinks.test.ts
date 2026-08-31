import { describe, expect, it } from "vitest";
import { marketplaceSearchUrl, scryfallCardUrl } from "./externalLinks";
import { MARKETPLACE_IDS } from "./marketplace";

describe("scryfallCardUrl", () => {
  it("builds the permalink from the set and the collector number", () => {
    expect(scryfallCardUrl("lea", "161")).toBe("https://scryfall.com/card/lea/161");
  });

  it("lowercases the set code", () => {
    // Scryfall's own URLs are lowercase; the corpus stores codes as they arrive.
    expect(scryfallCardUrl("LEA", "161")).toBe("https://scryfall.com/card/lea/161");
  });

  it("escapes a collector number that is not a plain integer", () => {
    // Collector numbers are TEXT, not numbers: "★", "123a" and "S-1" are all real.
    expect(scryfallCardUrl("sld", "1556★")).toBe(
      "https://scryfall.com/card/sld/1556%E2%98%85",
    );
  });
});

describe("marketplaceSearchUrl", () => {
  it("answers a real URL for every marketplace this app knows", () => {
    // Card trader has no price feed we can reach, but its website exists -- and if a new id
    // is ever added to MARKETPLACE_IDS this test is what says the link was forgotten.
    for (const id of MARKETPLACE_IDS) {
      const url = marketplaceSearchUrl(id, "Lightning Bolt");
      expect(() => new URL(url), `${id} must build a valid URL`).not.toThrow();
      expect(url.startsWith("https://"), `${id} must be https`).toBe(true);
    }
  });

  it("percent-encodes the card name rather than pasting it in", () => {
    const url = marketplaceSearchUrl("tcgplayer", "Jinnie Fay // Jinnie Fay");
    expect(url).not.toContain(" ");
    expect(url).not.toContain("//Jinnie");
  });

  it("encodes an apostrophe and an accent", () => {
    const url = marketplaceSearchUrl("cardmarket", "Ach! Hans, Run! Æther");
    expect(() => new URL(url)).not.toThrow();
    expect(url).not.toContain(" ");
  });
});
