import { describe, expect, it } from "vitest";
import type { PlaytestCounters } from "@/lib/ipc";
import {
  canTakeMore,
  counterRows,
  countersAction,
  countersConfirm,
  countersCounter,
  stepCounters,
} from "./counters";

const ref = (id: number, name: string) => ({ id, name, cardId: null, text: null, cause: null });

/** Tetravus with three +1/+1 counters, removed; or moved onto two creatures. */
function counters(over: Partial<PlaytestCounters> = {}): PlaytestCounters {
  return {
    source: ref(1, "Tetravus"),
    kinds: [
      { kind: "+1/+1", count: 3 },
      { kind: "charge", count: 1 },
    ],
    destinations: [],
    maxTotal: null,
    ...over,
  };
}

describe("counters taken off a card", () => {
  it("is one row a kind for a removal, a kind and destination for a move", () => {
    expect(counterRows(counters()).map((r) => [r.kind, r.to])).toEqual([
      ["+1/+1", null],
      ["charge", null],
    ]);
    const move = counters({ destinations: [ref(2, "Bear"), ref(3, "Elf")] });
    expect(counterRows(move).map((r) => [r.kind, r.to?.id])).toEqual([
      ["+1/+1", 2],
      ["+1/+1", 3],
      ["charge", 2],
      ["charge", 3],
    ]);
  });

  it("never takes more of a kind than the card has", () => {
    const c = counters({ destinations: [ref(2, "Bear"), ref(3, "Elf")] });
    let t = [0, 0, 0, 0];
    t = stepCounters(c, t, 0, 1);
    t = stepCounters(c, t, 0, 1);
    t = stepCounters(c, t, 1, 1);
    expect(t).toEqual([2, 1, 0, 0]);
    expect(canTakeMore(c, t, 1)).toBe(false);
    expect(stepCounters(c, t, 1, 1)).toEqual(t);
    expect(canTakeMore(c, t, 2)).toBe(true);
    expect(stepCounters(c, [0, 0, 0, 0], 0, -1)).toEqual([0, 0, 0, 0]);
  });

  it("keeps the whole within the most that may be taken", () => {
    const c = counters({ maxTotal: 2 });
    const t = stepCounters(c, stepCounters(c, [0, 0], 0, 1), 1, 1);
    expect(t).toEqual([1, 1]);
    expect(canTakeMore(c, t, 0)).toBe(false);
    expect(countersCounter(c, t)).toBe("2 taken of up to 2");
  });

  it("answers with the rows taken from, none at all included", () => {
    expect(countersConfirm(counters(), [0, 0])).toBe("Remove none");
    expect(countersAction(counters(), [0, 0])).toEqual({ type: "moveCounters", shares: [] });
    expect(countersConfirm(counters(), [2, 0])).toBe("Remove 2");
    expect(countersAction(counters(), [2, 0])).toEqual({
      type: "moveCounters",
      shares: [{ kind: "+1/+1", to: null, count: 2 }],
    });
    const move = counters({ destinations: [ref(2, "Bear")] });
    expect(countersConfirm(move, [1, 1])).toBe("Move 2");
    expect(countersAction(move, [1, 1])).toEqual({
      type: "moveCounters",
      shares: [
        { kind: "+1/+1", to: 2, count: 1 },
        { kind: "charge", to: 2, count: 1 },
      ],
    });
  });
});
