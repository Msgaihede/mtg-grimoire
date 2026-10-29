import { describe, expect, it } from "vitest";
import { SET } from "@/features/draft/booster/fixture";
import { mulberry32 } from "@/features/draft/booster/rng";
import type { BoosterCard, ImportResolveRow, SetSummary } from "@/lib/ipc";
import {
  COMMANDER_SETS,
  cubeCards,
  dealCube,
  dealSetPacks,
  minDeckSizeFor,
  playable,
  POD_SEATS,
  podSeats,
  readCubeList,
  setsLabel,
  shuffled,
  soloSeats,
  suggestedFirst,
  WINSTON_SEATS,
} from "./deal";

describe("the table", () => {
  it("seats the reader first and seven bots after", () => {
    const seats = soloSeats();
    expect(seats).toHaveLength(8);
    expect(seats[0]).toEqual({ name: "You", bot: false, peer: null });
    expect(seats[7]).toEqual({ name: "Bot 7", bot: true, peer: null });
  });

  it("seats a pod's host, the guests who are online, then bots", () => {
    const seats = podSeats("Host", [
      { peer: "p1", name: "Ada", online: true },
      { peer: "p2", name: "Gone", online: false },
      { peer: "p3", name: "Bea", online: true },
    ]);
    expect(seats.map((s) => s.name)).toEqual([
      "Host",
      "Ada",
      "Bea",
      "Bot 1",
      "Bot 2",
      "Bot 3",
      "Bot 4",
      "Bot 5",
    ]);
    expect(seats[1].peer).toBe("p1");
    expect(seats[3].bot).toBe(true);
  });

  it("seats a smaller pod within its format's bounds", () => {
    expect(POD_SEATS.booster).toEqual({ min: 2, max: 8, start: 8 });
    expect(POD_SEATS.commander).toEqual({ min: 3, max: 8, start: 4 });
    expect(POD_SEATS.winston).toEqual({ min: 2, max: 4, start: 2 });
    const seats = podSeats("Host", [{ peer: "p1", name: "Ada", online: true }], 3);
    expect(seats.map((s) => s.name)).toEqual(["Host", "Ada", "Bot 1"]);
  });

  it("asks 60 cards of a Commander draft's deck, and 40 of every other", () => {
    expect(minDeckSizeFor("commander")).toBe(60);
    expect(minDeckSizeFor("pod", "commander")).toBe(60);
    expect(minDeckSizeFor("pod", "winston")).toBe(40);
    expect(minDeckSizeFor("winston")).toBe(40);
    expect(minDeckSizeFor("quick")).toBe(40);
  });

  it("puts the sets a draft is made for first, when the corpus has them", () => {
    const set = (code: string): SetSummary => ({
      code,
      name: code,
      setType: "expansion",
      releasedAt: "2026-01-01",
      cardCount: 1,
    });
    const sets = [set("fdn"), set("clb"), set("dsk"), set("cmr")];
    expect(suggestedFirst(sets, COMMANDER_SETS).map((s) => s.code)).toEqual([
      "cmr",
      "clb",
      "fdn",
      "dsk",
    ]);
    expect(suggestedFirst([set("fdn")], COMMANDER_SETS).map((s) => s.code)).toEqual(["fdn"]);
  });

  it("names each set once, in the order first opened", () => {
    expect(setsLabel(["Foundations", "The Hobbit", "The Hobbit"])).toBe("Foundations · The Hobbit");
  });
});

describe("dealSetPacks", () => {
  it("opens a booster per seat per round, and one seed always deals one table", () => {
    const packs = dealSetPacks([SET, SET, SET], 8, mulberry32(7));
    expect(packs).toHaveLength(8);
    for (const seat of packs) {
      expect(seat).toHaveLength(3);
      // The fixture's boosters hold seven cards, whichever variant is drawn.
      for (const pack of seat) expect(pack).toHaveLength(7);
    }
    expect(dealSetPacks([SET, SET, SET], 8, mulberry32(7))).toEqual(packs);
  });

  it("deals a Commander table and a Winston table as [seat][round]", () => {
    const commander = dealSetPacks([SET, SET, SET], soloSeats(4).length, mulberry32(5));
    expect(commander).toHaveLength(4);
    expect(commander.every((seat) => seat.length === 3)).toBe(true);
    const winston = dealSetPacks([SET, SET, SET], soloSeats(WINSTON_SEATS).length, mulberry32(5));
    expect(winston).toHaveLength(2);
    expect(winston.every((seat) => seat.length === 3 && seat.every((p) => p.length === 7))).toBe(
      true,
    );
    // The first two seats of a table are dealt the same boosters whatever its size: one seed, one
    // deal, round by round.
    expect(winston[0][0]).toEqual(commander[0][0]);
  });

  it("never deals a card this corpus lacks", () => {
    const missing = SET.products[0].sheets[0].cards[0].cardId;
    const unknown: BoosterCard = {
      cardId: missing,
      name: "Unknown",
      setCode: SET.code,
      collectorNumber: "1",
      rarity: null,
      typeLine: null,
      manaCost: null,
      cmc: null,
      colors: null,
      inCorpus: false,
    };
    const set = { ...SET, cards: [...SET.cards, unknown] };
    const packs = dealSetPacks([set, set, set], 8, mulberry32(3));
    expect(packs.flat(2)).not.toContain(missing);
    const product = playable(set.products[0], set);
    for (const sheet of product.sheets) {
      expect(sheet.cards.map((c) => c.cardId)).not.toContain(missing);
      expect(sheet.totalWeight).toBe(sheet.cards.reduce((sum, c) => sum + c.weight, 0));
    }
  });

  it("refuses a set with nothing to draft from", () => {
    const collectorOnly = { ...SET, name: "Shiny", products: [{ ...SET.products[1] }] };
    expect(() => dealSetPacks([collectorOnly], 8, mulberry32(1))).toThrow(
      "Shiny has no booster to draft from.",
    );
  });
});

describe("dealCube", () => {
  const cards = Array.from({ length: 40 }, (_, i) => `card-${i}`);

  it("deals packs × seats boosters of the pack size, every card at most once", () => {
    const packs = dealCube(cards, { seats: 4, packs: 2, packSize: 5 }, mulberry32(3));
    expect(packs).toHaveLength(4);
    expect(packs.every((seat) => seat.length === 2 && seat.every((p) => p.length === 5))).toBe(
      true,
    );
    const dealt = packs.flat(2);
    expect(new Set(dealt).size).toBe(40);
  });

  it("says how many cards a cube too short is missing", () => {
    expect(() => dealCube(cards, { seats: 8, packs: 3, packSize: 15 }, mulberry32(3))).toThrow(
      "needs 360 cards; the list has 40",
    );
  });

  it("shuffles without losing or adding a card", () => {
    expect(shuffled(cards, mulberry32(9)).sort()).toEqual([...cards].sort());
  });
});

describe("a cube list", () => {
  it("reads counts and names, and joins the resolver's answer back to them", () => {
    const list = readCubeList("2 Lightning Bolt\n1 Counterspell\n1 Nonsense Card");
    expect(list.lines.map((l) => [l.quantity, l.resolve.name])).toEqual([
      [2, "Lightning Bolt"],
      [1, "Counterspell"],
      [1, "Nonsense Card"],
    ]);
    const matched = (cardId: string) =>
      ({ cardId }) as unknown as NonNullable<ImportResolveRow["matched"]>;
    const rows: ImportResolveRow[] = [
      { index: 0, matched: matched("bolt"), hintMissed: false },
      { index: 1, matched: matched("cs"), hintMissed: false },
      { index: 2, matched: null, hintMissed: false },
    ];
    expect(cubeCards(list, rows)).toEqual({
      cardIds: ["bolt", "bolt", "cs"],
      unresolved: ["Nonsense Card"],
    });
  });
});
