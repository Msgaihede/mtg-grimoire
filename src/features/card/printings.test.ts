import { describe, expect, it } from "vitest";
import type { Printing } from "@/lib/ipc";
import {
  faceCount,
  finishPrice,
  groupByIllustration,
  legalityChips,
  parseFinishes,
} from "./printings";

const printing = (over: Partial<Printing>): Printing => ({
  id: "p",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  releasedAt: "1993-08-05",
  rarity: "common",
  illustrationId: "art-a",
  artist: "Christopher Rush",
  lang: "en",
  finishes: '["nonfoil"]',
  prices:
    '{"usd":"5.00","usd_foil":null,"usd_etched":null,"eur":"4.20","eur_foil":null,"tix":"0.03"}',
  promo: false,
  fullArt: false,
  frameEffects: null,
  borderColor: "black",
  layout: "normal",
  ...over,
});

describe("groupByIllustration", () => {
  it("puts printings that share artwork together, in first-seen order", () => {
    const groups = groupByIllustration([
      printing({ id: "a", illustrationId: "art-b" }),
      printing({ id: "b", illustrationId: "art-a" }),
      printing({ id: "c", illustrationId: "art-b" }),
    ]);

    expect(groups.map((g) => g.illustrationId)).toEqual(["art-b", "art-a"]);
    expect(groups[0].printings.map((p) => p.id)).toEqual(["a", "c"]);
  });

  /**
   * "Newly spoiled cards may not have this field yet", so a null illustration is a real
   * case. Every one of them is its own group: lumping them together would claim a set of
   * unrelated cards share artwork.
   */
  it("never merges printings that have no illustration id", () => {
    const groups = groupByIllustration([
      printing({ id: "a", illustrationId: null }),
      printing({ id: "b", illustrationId: null }),
    ]);

    expect(groups).toHaveLength(2);
  });
});

describe("finishPrice", () => {
  /**
   * The carryover's sharpest warning: `price_usd` is a display fallback chain
   * (nonfoil→foil→etched) and would price a nonfoil at foil rates. A finish price is a
   * lookup by finish in the blob, and nothing else.
   */
  it("reads the key that belongs to the finish", () => {
    const prices =
      '{"usd":"5.00","usd_foil":"40.00","usd_etched":"71.50","eur":"4.20","eur_foil":null,"tix":"0.03"}';

    expect(finishPrice(prices, "nonfoil")).toBe(5);
    expect(finishPrice(prices, "foil")).toBe(40);
    expect(finishPrice(prices, "etched")).toBe(71.5);
  });

  it("is null when that finish has no price, and never falls back to another one", () => {
    const prices =
      '{"usd":null,"usd_foil":null,"usd_etched":"0.71","eur":null,"eur_foil":null,"tix":null}';

    expect(finishPrice(prices, "nonfoil")).toBeNull();
    expect(finishPrice(prices, "foil")).toBeNull();
    expect(finishPrice(prices, "etched")).toBe(0.71);
  });

  it("survives an absent or unparseable blob", () => {
    expect(finishPrice(null, "foil")).toBeNull();
    expect(finishPrice("not json", "foil")).toBeNull();
  });
});

describe("parseFinishes", () => {
  it("reads the enum, and etched is one of its values", () => {
    expect(parseFinishes('["nonfoil","foil","etched"]')).toEqual(["nonfoil", "foil", "etched"]);
  });

  it("drops anything that is not a finish, and tolerates nothing at all", () => {
    expect(parseFinishes('["nonfoil","glossy"]')).toEqual(["nonfoil"]);
    expect(parseFinishes(null)).toEqual([]);
    expect(parseFinishes("{}")).toEqual([]);
  });
});

describe("legalityChips", () => {
  it("shows only the formats the card is playable or banned in, in a fixed order", () => {
    const chips = legalityChips(
      '{"modern":"legal","standard":"not_legal","vintage":"restricted","commander":"banned"}',
    );

    expect(chips).toEqual([
      { format: "modern", status: "legal" },
      { format: "vintage", status: "restricted" },
      { format: "commander", status: "banned" },
    ]);
  });

  /** The key set GROWS — `tlr` is newer than most published field lists. An unknown key
   *  is rendered at the end, never dropped. */
  it("keeps a format it has never heard of", () => {
    const chips = legalityChips('{"modern":"legal","newformat":"legal"}');

    expect(chips.map((c) => c.format)).toEqual(["modern", "newformat"]);
  });

  it("survives an absent blob", () => {
    expect(legalityChips(null)).toEqual([]);
  });
});

describe("faceCount", () => {
  it("counts two sides only for the layouts that physically have them", () => {
    expect(faceCount("transform", 2)).toBe(2);
    expect(faceCount("modal_dfc", 2)).toBe(2);
    expect(faceCount("reversible_card", 2)).toBe(2);
    // Two faces, one physical side: the back of a split card is a normal Magic back.
    expect(faceCount("split", 2)).toBe(1);
    expect(faceCount("adventure", 2)).toBe(1);
    expect(faceCount("flip", 2)).toBe(1);
    // `meld` has top-level images and no `card_faces` at all.
    expect(faceCount("meld", 0)).toBe(1);
    expect(faceCount("normal", 0)).toBe(1);
  });

  /**
   * A two-sided layout that arrived with one face — a malformed or partially ingested row
   * — must not offer a flip: `card.faces[1]` is `undefined`, and the control would name a
   * face that is not there and swap to an image the protocol answers with a card back.
   */
  it("needs both faces present, not just a layout that usually has them", () => {
    expect(faceCount("transform", 1)).toBe(1);
    expect(faceCount("transform", 0)).toBe(1);
  });
});
