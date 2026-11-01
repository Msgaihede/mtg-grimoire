import { describe, expect, it } from "vitest";
import type { PlaytestDamage } from "@/lib/ipc";
import {
  assignAction,
  canAssign,
  canTrample,
  damageCounter,
  left,
  lethalTo,
  NO_SPLIT,
  stepBlocker,
  stepExcess,
} from "./damage";

function damage(over: Partial<PlaytestDamage> = {}): PlaytestDamage {
  const ref = (id: number) => ({ id, name: `Blocker ${id}`, cardId: null, text: null, cause: null });
  return {
    attacker: ref(9),
    total: 3,
    blockers: [
      { card: ref(1), lethal: 1 },
      { card: ref(2), lethal: 3 },
    ],
    trample: false,
    defender: "opponent",
    target: null,
    ...over,
  };
}

describe("dividing an attacker's combat damage (issue #1448)", () => {
  it("takes the whole total, in any split the attacker likes", () => {
    const d = damage();
    // All on the second blocker, none on the first: the first lives.
    const all = stepBlocker(d, NO_SPLIT, 2, 3);
    expect(canAssign(d, all)).toBe(true);
    expect(assignAction(d, all)).toEqual({
      type: "assignDamage",
      blockers: [{ blocker: 2, amount: 3 }],
      excess: 0,
    });
    // Short of the total is no answer yet.
    const short = stepBlocker(d, NO_SPLIT, 1, 1);
    expect(canAssign(d, short)).toBe(false);
    expect(left(d, short)).toBe(2);
    expect(damageCounter(d, short)).toBe("1 of 3 assigned");
  });

  it("never steps past the total or below none", () => {
    const d = damage();
    const over = stepBlocker(d, NO_SPLIT, 1, 10);
    expect(over.amounts[1]).toBe(3);
    expect(stepBlocker(d, over, 2, 1).amounts[2]).toBe(0);
    expect(stepBlocker(d, NO_SPLIT, 1, -1).amounts[1]).toBe(0);
  });

  it("gives a clicked blocker lethal, then everything left", () => {
    const d = damage();
    const once = lethalTo(d, NO_SPLIT, 1);
    expect(once.amounts[1]).toBe(1);
    const twice = lethalTo(d, once, 1);
    expect(twice.amounts[1]).toBe(3);
    // Lethal is capped by what is left.
    expect(lethalTo(d, once, 2).amounts[2]).toBe(2);
  });

  it("tramples past the blockers only once each has lethal", () => {
    const d = damage({ trample: true, total: 5 });
    expect(stepExcess(d, NO_SPLIT, 1)).toBe(NO_SPLIT);
    const lethal = lethalTo(d, lethalTo(d, NO_SPLIT, 1), 2);
    expect(canTrample(d, lethal)).toBe(true);
    const through = stepExcess(d, lethal, 5);
    expect(through.excess).toBe(1);
    expect(canAssign(d, through)).toBe(true);
    // A blocker cut below lethal takes the excess back.
    const cut = stepBlocker(d, through, 2, -1);
    expect(cut.excess).toBe(0);
    expect(canAssign(d, cut)).toBe(false);
  });

  it("sends no excess for an attacker without trample", () => {
    const d = damage();
    const split = stepBlocker(d, NO_SPLIT, 1, 3);
    expect(stepExcess(d, split, 1)).toBe(split);
  });
});
