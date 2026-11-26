import { describe, expect, it } from "vitest";
import type { PlaytestStackItem } from "@/lib/ipc";
import {
  conditionWords,
  exiledWithLines,
  paidLine,
  stackChip,
  stackFacts,
  turnsToCome,
} from "./details";
import { emptySeat, gameCard } from "../table/fixtures";

const plain: Pick<PlaytestStackItem, "copy" | "modes" | "paid" | "revealed" | "causes"> = {
  copy: false,
  modes: [],
  paid: [],
  revealed: [],
  causes: [],
};

describe("stackFacts", () => {
  it("says nothing of a plain spell", () => {
    expect(stackFacts(plain)).toEqual([]);
    expect(stackChip(plain)).toBeNull();
  });

  it("says a copy, its modes, what was paid and what was revealed, in that order", () => {
    const item = {
      copy: true,
      modes: ["Deal 2 damage to any target"],
      paid: [
        { type: "x" as const, value: 3 },
        { type: "manaSpent" as const, amount: 5 },
        { type: "kicked" as const, count: 2 },
        { type: "variant" as const, variant: "Flashback" },
      ],
      revealed: ["Forest"],
      causes: [
        { event: "ZoneChanged", id: 1, name: "Bear", player: null },
        { event: "ZoneChanged", id: 2, name: "Elf", player: null },
      ],
    };
    expect(stackFacts(item)).toEqual([
      "A copy",
      "Mode: Deal 2 damage to any target",
      "X is 3",
      "Kicked twice",
      "Cast by flashback",
      "Revealed: Forest",
      "Set off by 2 events at once",
    ]);
    expect(stackChip(item)).toBe("Copy");
    expect(stackChip({ ...item, copy: false })).toBe("X=3");
  });

  it("words every paid fact", () => {
    expect(paidLine({ type: "kicked", count: 1 })).toBe("Kicked");
    expect(paidLine({ type: "additionalCost" })).toBe("Additional cost paid");
    expect(paidLine({ type: "convoked", count: 1 })).toBe("Convoked with 1 creature");
    expect(paidLine({ type: "colorsSpent", distinct: 2 })).toBe("2 colors of mana spent");
    expect(paidLine({ type: "variant", variant: "WithoutPayingManaCost" })).toBe(
      "Cast by without paying mana cost",
    );
  });
});

describe("exiledWithLines", () => {
  const ring = gameCard("Oblivion Ring");
  const goyf = gameCard("Tarmogoyf");
  const view = {
    you: emptySeat("you", { battlefield: [ring] }),
    opponents: [emptySeat("opponent", { exile: [goyf] })],
    exiledWith: [{ source: ring.id, cards: [goyf.id] }],
  };

  it("names what a permanent holds, and what an exiled card is held by", () => {
    expect(exiledWithLines(view, ring.id)).toEqual(["Exiled with it: Tarmogoyf"]);
    expect(exiledWithLines(view, goyf.id)).toEqual(["Exiled with Oblivion Ring"]);
    expect(exiledWithLines({ ...view, exiledWith: [] }, ring.id)).toEqual([]);
  });

  it("names a face-down card by its back", () => {
    const hidden = { ...goyf, name: "" };
    const veiled = { ...view, opponents: [emptySeat("opponent", { exile: [hidden] })] };
    expect(exiledWithLines(veiled, ring.id)).toEqual(["Exiled with it: a face-down card"]);
  });
});

describe("conditionWords", () => {
  it("words a condition, and the zones a cast is held to", () => {
    expect(conditionWords({ kind: "cantGainLife", source: null, zones: [] })).toEqual({
      text: "No life gain",
      label: "Can't gain life",
    });
    expect(
      conditionWords({ kind: "castOnlyFrom", source: null, zones: ["hand", "graveyard"] }).label,
    ).toBe("May cast spells only from hand or graveyard");
  });
});

describe("turnsToCome", () => {
  const opponents = [emptySeat("opponent"), emptySeat("opponent2"), emptySeat("opponent3")];

  it("names the turns after this one, an extra turn where a player comes twice", () => {
    const turns = turnsToCome({
      turnOrder: ["you", "you", "opponent", "opponent2"],
      opponents,
    });
    expect(turns.map((t) => [t.text, t.extra, t.you])).toEqual([
      ["You", true, true],
      ["Opp 1", false, false],
      ["Opp 2", false, false],
    ]);
  });

  it("is empty in a game of two", () => {
    expect(turnsToCome({ turnOrder: [], opponents: [emptySeat("opponent")] })).toEqual([]);
  });
});
