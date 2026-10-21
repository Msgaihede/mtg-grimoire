import { describe, expect, it } from "vitest";
import type { GameCard } from "@/lib/ipc";
import {
  ATTACHED,
  ASPECT,
  BACK_MAX,
  CREATURE_MAX,
  FLOOR,
  GAP,
  PILE,
  SPLIT,
  UNDER,
  HAND_CARD_W,
  HAND_GAP,
  HAND_LIFT,
  HAND_MIN_STEP,
  HAND_ROW_MAX,
  acrossTables,
  arrangeHand,
  attachmentsOf,
  fitWidth,
  handRow,
  handSlotAt,
  landsFirst,
  layoutTable,
  moveInHand,
  pileHeight,
  pileWidth,
  underOf,
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
    basePower: null,
    baseToughness: null,
    tax: 0,
    attachedTo: null,
    foretold: false,
    canForetell: false,
    castable: false,
    gaps: [],
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

  it("keeps two creatures of one name apart when their power and toughness differ", () => {
    const piles = pilesOf(
      [
        card("Bear", { lane: "creature", power: 2, toughness: 2 }),
        card("Bear", { lane: "creature", power: 5, toughness: 5 }),
        card("Bear", { lane: "creature", power: 2, toughness: 2 }),
      ],
      "creature",
    );
    expect(piles.map((p) => [p.card.power, p.ids.length])).toEqual([
      [2, 2],
      [5, 1],
    ]);
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
  it("draws a sparse row at its largest in a tall lane", () => {
    const piles = pilesOf([card("Forest")], "land");
    expect(fitWidth(piles, { row: 1100, laneHeight: 600, max: BACK_MAX })).toBe(BACK_MAX);
  });

  it("draws a sparse row as tall as its lane allows", () => {
    const piles = pilesOf([card("Forest")], "land");
    const w = fitWidth(piles, { row: 1100, laneHeight: 296, max: BACK_MAX });
    expect(w).toBeLessThan(BACK_MAX);
    expect(pileHeight(piles[0], w)).toBeLessThanOrEqual(296);
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

  it("draws five cards of a pile at most, however many it holds", () => {
    const pile = pilesOf(
      Array.from({ length: 9 }, () => card("Forest")),
      "land",
    )[0];
    expect(UNDER).toBe(4);
    expect(underOf(pile)).toBe(UNDER);
    expect(pileWidth(pile, 100)).toBe(100 + UNDER * PILE);
  });

  it("never goes under the floor", () => {
    const piles = pilesOf(
      Array.from({ length: 400 }, (_, i) => card(`L${i}`)),
      "land",
    );
    expect(fitWidth(piles, { row: 300, laneHeight: 296, max: BACK_MAX })).toBe(FLOOR);
  });
});

describe("layoutTable's emblems (issue #1333)", () => {
  it("shares the back row's width with them, a card and a divider each set", () => {
    const lands = Array.from({ length: 12 }, (_, i) => card(`Land ${i}`));
    const box = { width: 1100, height: 600 };
    const without = layoutTable(lands, box);
    const withTwo = layoutTable(lands, box, undefined, undefined, 2);
    expect(withTwo.backWidth).toBeLessThan(without.backWidth);
    const used =
      withTwo.lands.reduce((n, p) => n + pileWidth(p, withTwo.backWidth), 0) +
      2 * withTwo.backWidth +
      GAP * (withTwo.lands.length + 1) +
      SPLIT;
    expect(used).toBeLessThanOrEqual(1100);
  });

  it("draws emblems alone on the row at the row's largest", () => {
    expect(layoutTable([], { width: 1100, height: 2000 }, undefined, undefined, 1).backWidth).toBe(
      BACK_MAX,
    );
  });
});

describe("layoutTable", () => {
  it("lays creatures in front and lands with the rest behind, at sizes of their own", () => {
    const t = layoutTable(
      [card("Bear", { lane: "creature" }), card("Forest"), card("Sol Ring", { lane: "other" })],
      { width: 1100, height: 1000 },
    );
    expect(t.creatures).toHaveLength(1);
    expect(t.lands).toHaveLength(1);
    expect(t.others).toHaveLength(1);
    expect(t.creatureWidth).toBe(CREATURE_MAX);
    expect(t.backWidth).toBe(BACK_MAX);
  });
});

describe("attachments (issue #1073)", () => {
  const creature = (name: string, over: Partial<GameCard> = {}) =>
    card(name, { lane: "creature", isLand: false, ...over });
  const gear = (name: string, on: GameCard) =>
    card(name, { lane: "other", isLand: false, attachedTo: on.id });

  it("takes an attachment out of its lane and puts it under its card, a pile of its own", () => {
    const bear = creature("Bear");
    const twin = creature("Bear");
    const sword = gear("Bonesplitter", bear);
    const t = layoutTable([bear, twin, sword, card("Forest")], { width: 1100, height: 1000 });
    expect(t.others).toEqual([]);
    expect(t.creatures.map((p) => [p.ids, p.attached.map((a) => a.name)])).toEqual([
      [[bear.id], ["Bonesplitter"]],
      [[twin.id], []],
    ]);
  });

  it("tucks an Aura on an Equipment under the creature at the bottom of the chain", () => {
    const bear = creature("Bear");
    const sword = gear("Bonesplitter", bear);
    const aura = gear("Spirit Link", sword);
    const { lanes, attached } = attachmentsOf([bear, sword, aura]);
    expect(lanes).toEqual([bear]);
    expect(attached.get(bear.id)).toEqual([sword, aura]);
  });

  it("leaves an attachment whose card is on no table in its own lane", () => {
    const aura = card("Pacifism", { lane: "other", isLand: false, attachedTo: 9999 });
    expect(attachmentsOf([aura]).lanes).toEqual([aura]);
  });

  it("draws an Aura on another player's creature on that player's table", () => {
    const goblin = creature("Goblin");
    const aura = gear("Pacifism", goblin);
    const [mine, theirs] = acrossTables([[aura], [goblin]]);
    expect(mine.guests).toEqual([]);
    expect(theirs.guests).toEqual([aura]);
    expect(attachmentsOf([aura], mine).lanes).toEqual([]);
    expect(attachmentsOf([goblin], theirs).attached.get(goblin.id)).toEqual([aura]);
  });

  it("makes room above a card for each attachment's edge, and still fits the lane", () => {
    const bear = creature("Bear");
    const piles = layoutTable([bear, gear("A", bear), gear("B", bear)], {
      width: 1100,
      height: 600,
    }).creatures;
    const w = fitWidth(piles, { row: 1100, laneHeight: 300, max: CREATURE_MAX });
    expect(pileHeight(piles[0], w)).toBeLessThanOrEqual(300);
    expect(pileHeight(piles[0], 100)).toBe(100 * ASPECT + 2 * 100 * ATTACHED + 14);
  });
});

describe("handRow", () => {
  it("sits up to seven cards side by side, and overlaps more to stay the width of seven", () => {
    expect(handRow(7).lefts[1]).toBe(HAND_CARD_W + HAND_GAP);
    expect(handRow(7).width).toBe(HAND_ROW_MAX);
    const ten = handRow(10);
    expect(ten.lefts[1]).toBeLessThan(HAND_CARD_W);
    expect(ten.width).toBeLessThanOrEqual(HAND_ROW_MAX);
  });

  it("never shows less than a sliver of a card, however many are held", () => {
    expect(handRow(60).lefts[1]).toBe(HAND_MIN_STEP);
  });

  it("lifts a card by the lift, inside the band", () => {
    const row = handRow(3);
    expect(row.restTop - row.liftTop).toBe(HAND_LIFT);
    expect(row.liftTop).toBeGreaterThanOrEqual(0);
  });
});

describe("arrangeHand", () => {
  const forest = card("Forest");
  const bolt = card("Bolt", { isLand: false, lane: "other" });
  const island = card("Island");
  const ponder = card("Ponder", { isLand: false, lane: "other" });

  it("holds a hand picked up fresh lands first, each group in the order it came", () => {
    expect(landsFirst([bolt, forest, ponder, island]).map((c) => c.name)).toEqual([
      "Forest",
      "Island",
      "Bolt",
      "Ponder",
    ]);
    expect(arrangeHand([], [bolt, forest, ponder, island])).toEqual([
      forest.id,
      island.id,
      bolt.id,
      ponder.id,
    ]);
  });

  it("puts a card drawn later on the right, even a land, and closes up a gap", () => {
    const drawn = card("Mountain");
    expect(arrangeHand([forest.id, bolt.id, ponder.id], [bolt, ponder, forest, drawn])).toEqual([
      forest.id,
      bolt.id,
      ponder.id,
      drawn.id,
    ]);
    expect(arrangeHand([forest.id, bolt.id, ponder.id], [ponder, forest])).toEqual([
      forest.id,
      ponder.id,
    ]);
  });
});

describe("handSlotAt", () => {
  it("takes the slot whose card's middle is nearest the pointer", () => {
    const row = handRow(5);
    expect(handSlotAt(0, 5)).toBe(0);
    expect(handSlotAt(row.lefts[3] + HAND_CARD_W / 2, 5)).toBe(3);
    expect(handSlotAt(row.lefts[3] + HAND_CARD_W / 2 + 10, 5)).toBe(3);
    expect(handSlotAt(row.width + 200, 5)).toBe(4);
    expect(handSlotAt(-200, 5)).toBe(0);
  });

  it("reads an overlapping row by its narrower step", () => {
    const row = handRow(12);
    expect(handSlotAt(row.lefts[9] + HAND_CARD_W / 2, 12)).toBe(9);
  });

  it("has one slot for one card, and none to choose for none", () => {
    expect(handSlotAt(500, 1)).toBe(0);
    expect(handSlotAt(500, 0)).toBe(0);
  });
});

describe("moveInHand", () => {
  it("takes the card out and puts it back at the slot, the rest closing up", () => {
    expect(moveInHand([1, 2, 3, 4], 1, 2)).toEqual([2, 3, 1, 4]);
    expect(moveInHand([1, 2, 3, 4], 4, 0)).toEqual([4, 1, 2, 3]);
    expect(moveInHand([1, 2, 3, 4], 2, 1)).toEqual([1, 2, 3, 4]);
  });

  it("puts a slot past either end at that end", () => {
    expect(moveInHand([1, 2, 3], 2, 9)).toEqual([1, 3, 2]);
    expect(moveInHand([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
  });

  it("leaves the order as it was for a card not held", () => {
    expect(moveInHand([1, 2, 3], 7, 0)).toEqual([1, 2, 3]);
  });
});
