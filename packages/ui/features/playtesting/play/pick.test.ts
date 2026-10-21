import { describe, expect, it } from "vitest";
import type { PlaytestPick } from "@/lib/ipc";
import {
  canConfirm,
  confirmLabel,
  pickCounter,
  pickedPower,
  pickOffer,
  pickTitle,
  pickZones,
  togglePick,
} from "./pick";
import { fixedStop, hasStop, toggleStop } from "./stops";

function pick(over: Partial<PlaytestPick>): PlaytestPick {
  const cards = [1, 2, 3].map((id) => ({
    id,
    name: `Card ${id}`,
    cardId: null,
    text: null,
    cause: null,
  }));
  return {
    purpose: "choose",
    cards,
    eligible: [1, 2, 3],
    min: 0,
    max: 3,
    ordered: false,
    powerCap: null,
    zone: null,
    ...over,
  };
}

describe("the picker's words", () => {
  it("says what picking does, by purpose and bounds", () => {
    expect(pickTitle(pick({ purpose: "scry" }))).toBe("Scry 3");
    expect(pickTitle(pick({ purpose: "discard", min: 2, max: 2 }))).toBe("Discard 2");
    expect(pickTitle(pick({ purpose: "search", min: 0, max: 1 }))).toBe("Choose up to 1 to find");
    expect(pickTitle(pick({ purpose: "targets", min: 1, max: 2 }))).toBe("Choose 1 to 2 targets");
    expect(confirmLabel(pick({ purpose: "discard" }), 2)).toBe("Discard 2");
    expect(confirmLabel(pick({ purpose: "search" }), 0)).toBe("Find nothing");
    expect(pickCounter(pick({ max: 3 }), 2)).toBe("2 of up to 3");
    expect(pickCounter(pick({ min: 2, max: 2 }), 1)).toBe("1 of 2");
  });

  it("sorts a scry and a surveil into two zones", () => {
    expect(pickZones(pick({ purpose: "scry" }))).toEqual({ picked: "Keep on top", rest: "Bottom" });
    expect(pickZones(pick({ purpose: "surveil" }))).toEqual({ picked: "Top", rest: "Graveyard" });
    expect(pickZones(pick({ purpose: "discard" }))).toBeNull();
  });
});

describe("the picker's rules", () => {
  it("confirms only within the bounds", () => {
    const exact = pick({ min: 2, max: 2 });
    expect(canConfirm(exact, 1)).toBe(false);
    expect(canConfirm(exact, 2)).toBe(true);
    expect(canConfirm(pick({ min: 0, max: 3 }), 0)).toBe(true);
  });

  it("picks in order, puts back, and refuses an ineligible card or one past the max", () => {
    const p = pick({ eligible: [1, 2], max: 1 });
    expect(togglePick([], 3, p)).toEqual([]);
    expect(togglePick([], 2, p)).toEqual([2]);
    expect(togglePick([2], 1, p)).toEqual([2]);
    expect(togglePick([2], 2, p)).toEqual([]);
    expect(togglePick(togglePick([], 3, pick({})), 1, pick({}))).toEqual([3, 1]);
  });
});

describe("a keep within a total power (issue #1079)", () => {
  // Card n has power n: 1, 2 and 3.
  const powerOf = (id: number) => id;
  const keep = pick({ purpose: "keep", powerCap: 4 });

  it("says the cap, the power picked, and what confirming keeps", () => {
    expect(pickTitle(keep)).toBe("Keep total power 4 or less");
    expect(pickTitle(pick({ purpose: "keep", min: 2, max: 2 }))).toBe("Keep 2");
    expect(pickCounter(keep, 2, 4)).toBe("2 kept, power 4 of 4");
    expect(confirmLabel(keep, 0)).toBe("Sacrifice all");
    expect(confirmLabel(keep, 2)).toBe("Keep 2");
  });

  it("refuses a creature that would pass the cap, and confirms only under it", () => {
    expect(togglePick([1], 3, keep, powerOf)).toEqual([1, 3]);
    expect(togglePick([1, 3], 2, keep, powerOf)).toEqual([1, 3]);
    expect(togglePick([3], 2, keep, powerOf)).toEqual([3]);
    expect(pickedPower([1, 3], powerOf)).toBe(4);
    expect(canConfirm(keep, 0, 0)).toBe(true);
    expect(canConfirm(keep, 2, 4)).toBe(true);
    expect(canConfirm(keep, 2, 5)).toBe(false);
  });
});

describe("stops", () => {
  it("keeps the reader's main phases on, and toggles the rest", () => {
    expect(fixedStop("you", "main1")).toBe(true);
    expect(fixedStop("opponent", "main1")).toBe(false);
    expect(hasStop([], "you", "main2")).toBe(true);
    expect(toggleStop([], "you", "main1")).toEqual([]);
    const on = toggleStop([], "opponent", "upkeep");
    expect(on).toEqual([{ seat: "opponent", step: "upkeep" }]);
    expect(hasStop(on, "opponent", "upkeep")).toBe(true);
    expect(toggleStop(on, "opponent", "upkeep")).toEqual([]);
  });
});

describe("an optional cast (issue #1329)", () => {
  it("asks whether to cast, from where, before it shows the cards", () => {
    const cast = pick({ purpose: "cast", min: 0, max: 1, zone: "graveyard" });
    expect(pickOffer(cast)).toEqual({
      question: "Cast a spell from your graveyard?",
      yes: "Choose a card",
      no: "Don’t cast",
    });
    expect(pickOffer({ ...cast, zone: "exile" })?.question).toBe("Cast a spell from exile?");
    expect(pickOffer({ ...cast, zone: null, max: 2 })?.question).toBe("Cast spells?");
    expect(pickTitle(cast)).toBe("Choose up to 1 to cast");
    expect(confirmLabel(cast, 0)).toBe("Cast nothing");
    expect(confirmLabel(cast, 1)).toBe("Cast it");
  });

  it("asks nothing first of a cast that must be made, or of any other pick", () => {
    expect(pickOffer(pick({ purpose: "cast", min: 1, max: 1 }))).toBeNull();
    expect(pickOffer(pick({ purpose: "search", min: 0, max: 1 }))).toBeNull();
    expect(pickOffer(pick({ purpose: "choose", min: 0 }))).toBeNull();
  });
});
