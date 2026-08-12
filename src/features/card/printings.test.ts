import { describe, expect, it } from "vitest";
import type { Printing } from "@/lib/ipc";
import { faceCount, groupByIllustration, legalityChips } from "./printings";

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
  finishPrices: { nonfoil: 5.0, foil: null, etched: null },
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
