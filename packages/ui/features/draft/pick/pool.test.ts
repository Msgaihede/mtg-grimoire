import { describe, expect, it } from "vitest";
import type { DraftCard } from "@/lib/ipc";
import { poolRows } from "./pool";
import { parseStored } from "./trayLayout";

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
    expect(rows[1]!.rows).toEqual([
      { name: "Bolt", cardId: "id-Bolt", count: 1, colors: ["R"] },
      // The first printing picked under the name is the one its preview draws.
      { name: "Shock", cardId: "id-Shock", count: 2, colors: ["R"] },
    ]);
    expect(rows[2]!.rows.map((r) => r.name)).toEqual(["Emrakul", "Inferno Titan"]);
  });

  it("lists nothing for an empty pool", () => {
    expect(poolRows([])).toEqual([]);
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
