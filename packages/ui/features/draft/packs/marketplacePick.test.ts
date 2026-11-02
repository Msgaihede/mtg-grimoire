import { describe, expect, it } from "vitest";
import { MARKETPLACES } from "@/lib/marketplace";
import { effectiveMarketplaces, parseStored, toggleMarketplace } from "./marketplacePick";

describe("toggleMarketplace", () => {
  it("adds one in the selection's currency, in picker order", () => {
    expect(toggleMarketplace(["manapool"], "tcgplayer")).toEqual(["tcgplayer", "manapool"]);
    expect(toggleMarketplace(["tcgplayer"], "cardkingdom")).toEqual(["tcgplayer", "cardkingdom"]);
  });

  it("drops a picked one, but never the last", () => {
    expect(toggleMarketplace(["tcgplayer", "cardkingdom"], "tcgplayer")).toEqual(["cardkingdom"]);
    expect(toggleMarketplace(["tcgplayer"], "tcgplayer")).toEqual(["tcgplayer"]);
  });

  it("adds one in the other currency beside the pick, dollars and euros together", () => {
    expect(toggleMarketplace(["tcgplayer", "manapool"], "cardmarket")).toEqual([
      "tcgplayer",
      "cardmarket",
      "manapool",
    ]);
    expect(toggleMarketplace(["cardmarket"], "cardkingdom")).toEqual(["cardmarket", "cardkingdom"]);
  });
});

describe("effectiveMarketplaces", () => {
  const all = () => true;

  it("is the app's marketplace until the reader picks", () => {
    expect(effectiveMarketplaces(null, MARKETPLACES.cardmarket, all)).toEqual([
      MARKETPLACES.cardmarket,
    ]);
  });

  it("is the reader's pick once there is one, whatever the app's marketplace", () => {
    expect(effectiveMarketplaces(["manapool", "tcgplayer"], MARKETPLACES.cardmarket, all)).toEqual([
      MARKETPLACES.tcgplayer,
      MARKETPLACES.manapool,
    ]);
  });

  it("leaves out what cannot be priced at, and falls back when nothing is left", () => {
    const notManaPool = (id: string) => id !== "manapool";
    expect(
      effectiveMarketplaces(["tcgplayer", "manapool"], MARKETPLACES.cardkingdom, notManaPool),
    ).toEqual([MARKETPLACES.tcgplayer]);
    expect(effectiveMarketplaces(["manapool"], MARKETPLACES.cardkingdom, notManaPool)).toEqual([
      MARKETPLACES.cardkingdom,
    ]);
    expect(effectiveMarketplaces(["cardtrader"], MARKETPLACES.tcgplayer, all)).toEqual([
      MARKETPLACES.tcgplayer,
    ]);
  });

  it("keeps a pick of two currencies whole", () => {
    expect(effectiveMarketplaces(["cardmarket", "tcgplayer"], MARKETPLACES.tcgplayer, all)).toEqual(
      [MARKETPLACES.tcgplayer, MARKETPLACES.cardmarket],
    );
  });
});

describe("parseStored", () => {
  it("reads a list of marketplace ids, and nothing else", () => {
    expect(parseStored('["tcgplayer","cardkingdom"]')).toEqual(["tcgplayer", "cardkingdom"]);
    expect(parseStored('["tcgplayer","nope",3,"tcgplayer"]')).toEqual(["tcgplayer"]);
    expect(parseStored(null)).toBeNull();
    expect(parseStored("[]")).toBeNull();
    expect(parseStored("{")).toBeNull();
    expect(parseStored('"tcgplayer"')).toBeNull();
  });
});
