import { describe, expect, it } from "vitest";
import type { CardDetail, CardFace } from "@/lib/ipc";
import { facesOf } from "./faces";

/** A one-faced card — `faces: []`, which is what Scryfall sends for a `normal` or a `meld` one. */
const BOLT: CardDetail = {
  id: "p1",
  oracleId: "o1",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  layout: "normal",
  lang: "en",
  manaCost: "{R}",
  cmc: 1,
  typeLine: "Instant",
  oracleText: "Deal 3 damage.",
  illustrationId: "art-a",
  artist: "Christopher Rush",
  releasedAt: "1993-08-05",
  legalities: null,
  finishPrices: { nonfoil: null, foil: null, etched: null },
  finishes: '["nonfoil"]',
  promoTypes: null,
  imageStatus: "highres_scan",
  faces: [],
};

const face = (over: Partial<CardFace>): CardFace => ({
  name: "",
  typeLine: null,
  oracleText: null,
  manaCost: null,
  artist: null,
  ...over,
});

describe("facesOf", () => {
  it("synthesises one unnamed face from the printing's own words when it has none", () => {
    // Catches: reading `card.faces` alone, which draws an empty card for most of the game.
    expect(facesOf(BOLT)).toEqual([
      {
        name: "",
        typeLine: "Instant",
        oracleText: "Deal 3 damage.",
        manaCost: "{R}",
        artist: "Christopher Rush",
      },
    ]);
  });

  it("hands back every face of a card that has them, and none of the printing's own words", () => {
    // Catches: a `face` index creeping back in and printing half of a transforming card — and
    // the printing's own `oracleText`, which is `null` for these, being drawn as a third face.
    const front = face({ name: "Delver of Secrets", typeLine: "Creature — Human Wizard" });
    const back = face({ name: "Insectile Aberration", typeLine: "Creature — Human Insect" });
    const delver = { ...BOLT, layout: "transform", oracleText: null, faces: [front, back] };
    expect(facesOf(delver)).toEqual([front, back]);
  });
});
