import { describe, expect, it } from "vitest";
import type { DeckCategory } from "@/lib/ipc";
import { ALREADY_HERE, finishChoices, zoneClaims } from "./deckCardRules";
import { card, spec } from "./validation/fixtures";

/**
 * The rules a deck card's rows are refused by, out of `deckCardMenu.tsx` so the light app's phone
 * face asks them too. The menu's own tests still pin how the menu *draws* each answer — greyed and
 * wordless on a zone row; these pin the answers, and the one thing the menu never shows: the
 * refusal's words, which the phone's action sheet draws under the row.
 */

function category(id: number, name: string, kind: DeckCategory["kind"]): DeckCategory {
  return {
    id,
    deckId: 4,
    name,
    kind,
    isActive: true,
    origin: "user",
    sortOrder: id,
    cardCount: 0,
    totalPrice: null,
    variant: "live",
  };
}

const PILES: DeckCategory[] = [
  category(3, "Commander", "commander"),
  category(1, "Main deck", "main"),
  category(4, "Companion", "companion"),
];

const bolt = () => card({ name: "Lightning Bolt", quantity: 1 });

describe("finishChoices", () => {
  it("reads nonfoil as the regular copy, and keeps the printing's own order", () => {
    expect(finishChoices('["nonfoil","foil","etched"]')).toEqual([null, "foil", "etched"]);
  });

  it("offers only the regular copy where the finishes are unknown", () => {
    expect(finishChoices(null)).toEqual([null]);
    expect(finishChoices("")).toEqual([null]);
  });
});

describe("zoneClaims", () => {
  it("claims nothing where the format has no zones", () => {
    expect(zoneClaims(bolt(), PILES, [], spec("modern")).map((c) => c.zone)).toEqual(["companion"]);
    expect(zoneClaims(bolt(), PILES, [], null)).toEqual([]);
  });

  it("refuses an ineligible commander in the validation panel's own words", () => {
    const [commander] = zoneClaims(bolt(), PILES, [], spec("commander"));
    expect(commander).toMatchObject({
      zone: "commander",
      label: "Set as commander",
      categoryId: 3,
    });
    expect(commander.refusal).toEqual(expect.any(String));
    expect(commander.refusal).not.toBe(ALREADY_HERE);
  });

  it("offers an eligible commander, and refuses the one already in the zone as already here", () => {
    const atraxa = card({
      name: "Atraxa, Praetors' Voice",
      typeLine: "Legendary Creature — Phyrexian Angel Horror",
      power: "4",
      toughness: "4",
      quantity: 1,
    });
    expect(zoneClaims(atraxa, PILES, [], spec("commander"))[0].refusal).toBeNull();
    const reigning = { ...atraxa, categoryId: 3, categoryKind: "commander" as const };
    expect(zoneClaims(reigning, PILES, [], spec("commander"))[0].refusal).toBe(ALREADY_HERE);
  });

  it("refuses a card with no companion ability as a companion", () => {
    const companion = zoneClaims(bolt(), PILES, [bolt()], spec("commander")).find(
      (c) => c.zone === "companion",
    );
    expect(companion?.refusal).toEqual(expect.any(String));
  });

  it("claims no zone the deck has no pile for", () => {
    const main = PILES.filter((c) => c.kind === "main");
    expect(zoneClaims(bolt(), main, [], spec("commander"))).toEqual([]);
  });
});
