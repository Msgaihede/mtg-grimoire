import { describe, expect, it } from "vitest";
import { carriedPick, pickDragData, readPickDrag } from "./pickDrag";

describe("pickDrag", () => {
  it("reads back what it writes and nothing else", () => {
    expect(readPickDrag(pickDragData({ ids: ["Shock#0.0.0"] }))).toEqual({ ids: ["Shock#0.0.0"] });
    expect(readPickDrag({ ids: ["Shock#0.0.0"] })).toBeNull();
    expect(readPickDrag(pickDragData({ ids: [] }))).toBeNull();
    expect(readPickDrag({ ...pickDragData({ ids: [] }), ids: [3] })).toBeNull();
  });

  it("carries the dragged card alone in a pick of one", () => {
    expect(carriedPick([2], 0, 1)).toEqual([0]);
  });

  it("carries the choice with the dragged card added last in a pick of more", () => {
    expect(carriedPick([], 1, 2)).toEqual([1]);
    expect(carriedPick([0], 2, 2)).toEqual([0, 2]);
    expect(carriedPick([0, 2], 2, 2)).toEqual([0, 2]);
    // Past the pick's size the oldest choice lets go, as a click past it does.
    expect(carriedPick([0, 1], 2, 2)).toEqual([1, 2]);
  });
});
