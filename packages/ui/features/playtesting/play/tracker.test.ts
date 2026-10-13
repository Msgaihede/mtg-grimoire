import { describe, expect, it } from "vitest";
import { openingHand, respondStep, turnFive } from "./fixtures";
import { trackerOf } from "./tracker";

describe("trackerOf", () => {
  it("lights the phase the turn is in, and dims the ones it has passed", () => {
    const t = trackerOf({ ...turnFive().view, phase: "combat" });
    expect(t.turn).toBe(5);
    expect(t.whose).toBe("you");
    expect(t.steps.map((s) => [s.label, s.lit, s.past])).toEqual([
      ["Beginning", false, true],
      ["Main 1", false, true],
      ["Combat", true, false],
      ["Main 2", false, false],
      ["End", false, false],
    ]);
  });

  it("says whose turn it is and that the reader may respond", () => {
    const t = trackerOf(respondStep().view);
    expect(t.whose).toBe("opponent");
    expect(t.steps.find((s) => s.lit)?.label).toBe("Beginning");
    expect(t.caption).toBe("Turn 6 · Opponent's turn · Upkeep — you may respond");
  });

  it("lights nothing during the opening hands", () => {
    const t = trackerOf(openingHand());
    expect(t.turn).toBe(0);
    expect(t.steps.some((s) => s.lit)).toBe(false);
    expect(t.caption).toBe("Opening hands");
  });
});
