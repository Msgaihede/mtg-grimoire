import { describe, expect, it } from "vitest";
import { damageHappened, turnFive } from "./fixtures";
import { popsFor } from "./pops";

describe("popsFor", () => {
  it("pops damage over the creature hit, found on the side the source is not on", () => {
    const t = turnFive();
    expect(popsFor(damageHappened(t), t.view)).toEqual([
      { key: "0", anchor: { card: t.goyf.id }, text: "−3", tone: "damage" },
      { key: "1", anchor: { card: t.ragavan.id }, text: "−4", tone: "damage" },
      { key: "2", anchor: { plate: "opponent" }, text: "−3", tone: "loss" },
      { key: "3", anchor: { plate: "you" }, text: "+2", tone: "gain" },
    ]);
  });

  it("pops nothing for a creature no longer on the table, a life set by hand, or no change", () => {
    const t = turnFive();
    expect(
      popsFor(
        [
          {
            type: "dealt",
            source: "Lightning Bolt",
            target: "Gone Creature",
            targetId: 999,
            seat: "opponent",
            amount: 3,
          },
          { type: "lifeSet", seat: "you", life: 10, was: 17 },
          { type: "life", seat: "you", amount: 0, total: 10 },
          {
            type: "dealt",
            source: "Fog",
            target: t.goyf.name,
            targetId: t.goyf.id,
            seat: "you",
            amount: 0,
          },
        ],
        t.view,
      ),
    ).toEqual([]);
  });
});
