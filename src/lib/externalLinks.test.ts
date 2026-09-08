import { describe, expect, it } from "vitest";
import { edhrecCardUrl, marketplaceSearchUrl, scryfallCardUrl } from "./externalLinks";
import { MARKETPLACE_IDS } from "./marketplace";

describe("edhrecCardUrl", () => {
  it("asks EDHREC's router for the card by name, the way Scryfall's own link does", () => {
    // Scryfall's `related_uris.edhrec` for this card is `https://edhrec.com/route/?cc=Lightning+Bolt`
    // (read live 2026-09-08); the router answered `/cards/lightning-bolt` for either encoding.
    expect(edhrecCardUrl("Lightning Bolt")).toBe("https://edhrec.com/route/?cc=Lightning%20Bolt");
  });

  it("sends the whole name of a two-faced card, slashes included", () => {
    // Slugging is EDHREC's job, not this app's: its router landed `Fire // Ice` on the split
    // card's page and `Delver of Secrets // Insectile Aberration` on the front face's (live,
    // 2026-09-08). A local slugger would be a second spelling of a rule only EDHREC owns.
    expect(edhrecCardUrl("Fire // Ice")).toBe("https://edhrec.com/route/?cc=Fire%20%2F%2F%20Ice");
  });

  it("encodes a space, a comma and an accent, and leaves an apostrophe as the legal character it is", () => {
    // `encodeURIComponent` keeps `'` — RFC 3986 lists it as a sub-delimiter, and EDHREC's router
    // answered `?cc=Urza's%20Saga` with the card's page (live, 2026-09-08). Scryfall spells it
    // `%27`; the two are the same request. The exact string rather than a list of `not.toContain`s,
    // because the first draft of this test asserted the apostrophe away and was wrong about it.
    expect(edhrecCardUrl("Jinnie Fay, Jetmir's Æther")).toBe(
      "https://edhrec.com/route/?cc=Jinnie%20Fay%2C%20Jetmir's%20%C3%86ther",
    );
  });
});

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
