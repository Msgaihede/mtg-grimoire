import { describe, expect, it } from "vitest";
import type { DraftCard } from "@/lib/ipc";
import { pickStats } from "./pickStatsCounts";
import { poolRows, shelfColumns } from "./pool";
import { parseStored, STATS_STORAGE_KEY, useDraftStatsShown } from "./trayLayout";

function card(name: string, over: Partial<DraftCard> = {}): DraftCard {
  return {
    instanceId: `${name}#0.0.${Math.random()}`,
    cardId: `id-${name}`,
    name,
    setCode: "tst",
    collectorNumber: "1",
    rarity: "common",
    colors: ["R"],
    cmc: 1,
    typeLine: "Instant",
    manaCost: "{R}",
    ...over,
  };
}

describe("poolRows (issue #1474)", () => {
  it("lists the curve's non-empty columns in order, a name once with its count", () => {
    const rows = poolRows([
      card("Shock"),
      card("Island", { typeLine: "Basic Land — Island", cmc: 0, colors: [] }),
      card("Inferno Titan", { cmc: 6 }),
      card("Shock", { cardId: "id-Shock-2" }),
      card("Bolt"),
      card("Ornithopter", { cmc: 0, colors: [] }),
      card("Emrakul", { cmc: 15, colors: [] }),
    ]);
    expect(rows.map((g) => [g.column, g.count])).toEqual([
      ["0", 1],
      ["1", 3],
      ["6+", 2],
      ["lands", 1],
    ]);
    // Headed in symbols (issue #1498's tray), named in words.
    expect(rows.map((g) => [g.symbols, g.spoken])).toEqual([
      ["{0}", "Mana value 0"],
      ["{1}", "Mana value 1"],
      ["{6}+", "Mana value 6 or more"],
      [null, "Lands"],
    ]);
    expect(rows[1]!.rows).toEqual([
      { name: "Bolt", cardId: "id-Bolt", count: 1, colors: ["R"], manaCost: "{R}" },
      // The first printing picked under the name is the one its preview draws.
      { name: "Shock", cardId: "id-Shock", count: 2, colors: ["R"], manaCost: "{R}" },
    ]);
    expect(rows[2]!.rows.map((r) => r.name)).toEqual(["Emrakul", "Inferno Titan"]);
  });

  it("lists nothing for an empty pool", () => {
    expect(poolRows([])).toEqual([]);
  });
});

describe("shelfColumns (issue #1499)", () => {
  const pool = [
    card("Bolt"),
    card("Ornithopter", { cmc: 0, colors: [] }),
    card("Ogre", { cmc: 3 }),
    card("Titan", { cmc: 6 }),
    card("Island", { typeLine: "Basic Land — Island", cmc: 0, colors: [] }),
  ];

  it("draws the deck as the curve, every column kept", () => {
    const columns = shelfColumns(pool, "curve");
    expect(columns.map((c) => [c.symbols, c.cards.length])).toEqual([
      ["{0}", 1],
      ["{1}", 1],
      ["{2}", 0],
      ["{3}", 1],
      ["{4}", 0],
      ["{5}", 0],
      ["{6}+", 1],
      [null, 1],
    ]);
  });

  it("folds the sideboard's curve into four columns", () => {
    const columns = shelfColumns(pool, "grouped");
    expect(columns.map((c) => [c.symbols, c.spoken, c.cards.map((x) => x.name)])).toEqual([
      ["{0}–{2}", "Mana value 0 to 2", ["Bolt", "Ornithopter"]],
      ["{3}–{4}", "Mana value 3 to 4", ["Ogre"]],
      ["{5}+", "Mana value 5 or more", ["Titan"]],
      [null, "Lands", ["Island"]],
    ]);
  });
});

describe("pickStats (the deck's stats)", () => {
  const deck = [
    card("Bolt"),
    card("Bolt", { instanceId: "Bolt#2" }),
    card("Ogre", { cmc: 3, typeLine: "Creature — Ogre" }),
    card("Charm", { cmc: 2, colors: ["R", "W"] }),
    card("Ring", { cmc: 1, colors: [], typeLine: "Artifact" }),
    card("Titan", { cmc: 9, typeLine: "Creature — Giant" }),
    card("Mountain", { typeLine: "Basic Land — Mountain", cmc: 0, colors: [] }),
  ];

  it("curves the nonland cards, 8+ open-ended, creatures split out", () => {
    const stats = pickStats(deck);
    expect(stats.curve).toEqual([0, 3, 1, 1, 0, 0, 0, 0, 1]);
    expect(stats.curveCreatures).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(stats.average).toBeCloseTo((1 + 1 + 3 + 2 + 1 + 9) / 6);
    expect(stats.nonland).toBe(6);
  });

  it("counts every card by type, the lands among them", () => {
    expect(pickStats(deck).types).toEqual([
      { label: "Creature", count: 2 },
      { label: "Instant", count: 3 },
      { label: "Artifact", count: 1 },
      { label: "Land", count: 1 },
    ]);
  });

  it("slices the nonland cards by color, a pair its own slice and colorless last", () => {
    expect(pickStats(deck).colors.map((s) => [s.label, s.types, s.count])).toEqual([
      ["Red", ["R"], 4],
      ["White–red", ["W", "R"], 1],
      ["Colorless", [], 1],
    ]);
  });

  it("has no average for a deck of lands", () => {
    expect(pickStats([card("Island", { typeLine: "Basic Land — Island" })]).average).toBeNull();
  });
});

describe("the tray layout's stored value", () => {
  it("reads the two layouts and falls back to the bottom for anything else", () => {
    expect(parseStored("side")).toBe("side");
    expect(parseStored("bottom")).toBe("bottom");
    expect(parseStored(null)).toBe("bottom");
    expect(parseStored("left")).toBe("bottom");
  });
});

describe("the deck stats toggle's stored value", () => {
  it("is on until hidden, and keeps the reader's choice on the device", () => {
    expect(useDraftStatsShown.getState().shown).toBe(true);
    useDraftStatsShown.getState().keep(false);
    expect(useDraftStatsShown.getState().shown).toBe(false);
    expect(window.localStorage.getItem(STATS_STORAGE_KEY)).toBe("hidden");
  });
});
