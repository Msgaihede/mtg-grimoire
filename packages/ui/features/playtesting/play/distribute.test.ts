import { describe, expect, it } from "vitest";
import type { PlaytestDistribute } from "@/lib/ipc";
import {
  canDivide,
  divideAction,
  divisionCounter,
  leftToDivide,
  startDivision,
  stepShare,
} from "./distribute";

const bears = { id: 7, name: "Grizzly Bears", cardId: null, text: null, cause: null };

/** Forked Bolt as it is cast: 2 damage between a creature and a player, at least 1 each. */
function fork(min = 1): PlaytestDistribute {
  return {
    total: 3,
    unit: "Damage",
    targets: [
      { card: bears, player: null, min },
      { card: null, player: "opponent", min },
    ],
  };
}

describe("a division among targets", () => {
  it("starts each target at its least", () => {
    expect(startDivision(fork())).toEqual([1, 1]);
    expect(startDivision(fork(0))).toEqual([0, 0]);
    expect(leftToDivide(fork(), [1, 1])).toBe(1);
    expect(divisionCounter(fork(), [1, 1])).toBe("1 of 3 left");
    expect(divisionCounter(fork(), [2, 1])).toBe("All 3 divided");
  });

  it("steps a share between its least and what is left", () => {
    const d = fork();
    expect(stepShare(d, [1, 1], 0, 1)).toEqual([2, 1]);
    expect(stepShare(d, [2, 1], 1, 1)).toEqual([2, 1]);
    expect(stepShare(d, [2, 1], 0, -1)).toEqual([1, 1]);
    expect(stepShare(d, [1, 1], 0, -1)).toEqual([1, 1]);
    expect(stepShare(d, [1, 1], 5, 1)).toEqual([1, 1]);
    expect(stepShare(fork(0), [0, 0], 1, 5)).toEqual([0, 3]);
  });

  it("is an answer once all of it is given, each target at its least", () => {
    expect(canDivide(fork(), [1, 1])).toBe(false);
    expect(canDivide(fork(), [2, 1])).toBe(true);
    expect(canDivide(fork(), [3, 0])).toBe(false);
    expect(canDivide(fork(0), [3, 0])).toBe(true);
    expect(canDivide(fork(), [2])).toBe(false);
  });

  it("names a card target by its id and a player target by its player", () => {
    expect(divideAction(fork(), [2, 1])).toEqual({
      type: "distribute",
      shares: [
        { id: 7, player: null, amount: 2 },
        { id: null, player: "opponent", amount: 1 },
      ],
    });
  });
});
