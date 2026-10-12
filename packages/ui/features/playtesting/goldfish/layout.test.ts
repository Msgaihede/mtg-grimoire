import { describe, expect, it } from "vitest";
import type { GameCard } from "@/lib/ipc";
import {
  BACK_MAX,
  CREATURE_MAX,
  FLOOR,
  GAP,
  PILE,
  fanHand,
  fitWidth,
  layoutTable,
  pileWidth,
  pilesOf,
} from "./layout";

let next = 1;
function card(name: string, over: Partial<GameCard> = {}): GameCard {
  return {
    id: next++,
    cardId: `p-${name}`,
    name,
    typeLine: "",
    lane: "land",
    manaValue: 0,
    isLand: true,
    isToken: false,
    isCommander: false,
    tapped: false,
    counters: [],
    power: null,
    toughness: null,
    tax: 0,
    ...over,
  };
}

describe("pilesOf", () => {
  it("piles cards that look the same, and keeps tapped and countered ones apart", () => {
    const cards = [
      card("Forest"),
      card("Forest"),
      card("Forest", { tapped: true }),
      card("Plains"),
      card("Bear", { lane: "creature", counters: [{ kind: "+1/+1", count: 2 }] }),
      card("Bear", { lane: "creature" }),
    ];
    const lands = pilesOf(cards, "land");
    expect(lands.map((p) => [p.card.name, p.ids.length, p.tapped])).toEqual([
      ["Forest", 2, false],
      ["Forest", 1, true],
      ["Plains", 1, false],
    ]);
    expect(pilesOf(cards, "creature")).toHaveLength(2);
  });

  it("keeps two printings of one card apart, since they look different", () => {
    const piles = pilesOf(
      [card("Forest", { cardId: "a" }), card("Forest", { cardId: "b" })],
      "land",
    );
    expect(piles).toHaveLength(2);
  });
});

describe("fitWidth", () => {
  it("draws a sparse row at its largest", () => {
    const piles = pilesOf([card("Forest")], "land");
    expect(fitWidth(piles, { row: 1100, laneHeight: 296, max: BACK_MAX })).toBe(BACK_MAX);
  });

  it("shrinks a crowded row until every pile fits across it", () => {
    const piles = pilesOf(
      Array.from({ length: 30 }, (_, i) => card(`Land ${i}`)),
      "land",
    );
    const w = fitWidth(piles, { row: 1100, laneHeight: 296, max: BACK_MAX });
    const used = piles.reduce((n, p) => n + pileWidth(p, w), 0) + GAP * (piles.length - 1);
    expect(w).toBeLessThan(BACK_MAX);
    expect(used).toBeLessThanOrEqual(1100);
  });

  it("counts a tapped card as lying on its side, and each card underneath as its edge", () => {
    const tapped = pilesOf([card("Forest", { tapped: true })], "land")[0];
    const stacked = pilesOf([card("Plains"), card("Plains"), card("Plains")], "land")[0];
    expect(pileWidth(tapped, 100)).toBe(140);
    expect(pileWidth(stacked, 100)).toBe(100 + 2 * PILE);
  });

  it("never goes under the floor", () => {
    const piles = pilesOf(
      Array.from({ length: 400 }, (_, i) => card(`L${i}`)),
      "land",
    );
    expect(fitWidth(piles, { row: 300, laneHeight: 296, max: BACK_MAX })).toBe(FLOOR);
  });
});

describe("layoutTable", () => {
  it("lays creatures in front and lands with the rest behind, at sizes of their own", () => {
    const t = layoutTable(
      [card("Bear", { lane: "creature" }), card("Forest"), card("Sol Ring", { lane: "other" })],
      { width: 1100, height: 600 },
    );
    expect(t.creatures).toHaveLength(1);
    expect(t.lands).toHaveLength(1);
    expect(t.others).toHaveLength(1);
    expect(t.creatureWidth).toBe(CREATURE_MAX);
    expect(t.backWidth).toBe(BACK_MAX);
  });
});

describe("fanHand", () => {
  it("fans seven cards 96 px apart and closes up past seven", () => {
    expect(fanHand(7, null).slots[1].left).toBe(96);
    expect(fanHand(9, null).slots[1].left).toBe(70);
  });

  it("leans the edges out and lifts the card pointed at", () => {
    const fan = fanHand(5, 0);
    expect(fan.slots[0]).toEqual({ left: 0, top: 0, rotate: 0 });
    expect(fan.slots[4].rotate).toBe(8);
    expect(fan.slots[2].rotate).toBe(0);
    expect(fan.slots[4].top).toBeGreaterThan(fan.slots[2].top);
  });
});
