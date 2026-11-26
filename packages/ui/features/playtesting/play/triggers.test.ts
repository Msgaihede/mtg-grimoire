import { describe, expect, it } from "vitest";
import { moveTrigger, orderAction, startResolving } from "./triggers";

describe("triggers put in order by hand", () => {
  it("starts as the engine would put them, the last put on resolving first", () => {
    expect(startResolving(5)).toEqual([4, 3, 2, 1, 0]);
    expect(orderAction(startResolving(5))).toEqual({
      type: "orderTriggers",
      order: [0, 1, 2, 3, 4],
    });
  });

  it("moves one up or down, never past either end", () => {
    expect(moveTrigger([4, 3, 2, 1, 0], 2, -1)).toEqual([4, 2, 3, 1, 0]);
    expect(moveTrigger([4, 3, 2, 1, 0], 0, -1)).toEqual([4, 3, 2, 1, 0]);
    expect(moveTrigger([4, 3, 2, 1, 0], 4, 1)).toEqual([4, 3, 2, 1, 0]);
  });

  it("answers with the order put on the stack: the reverse of the order resolving", () => {
    expect(orderAction([0, 1, 2, 3, 4])).toEqual({ type: "orderTriggers", order: [4, 3, 2, 1, 0] });
  });
});
