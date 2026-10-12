import { describe, expect, it } from "vitest";
import { LANDING_MAX, freshIds } from "./landing";

describe("freshIds", () => {
  it("names the ids that are new since the last view", () => {
    expect(freshIds(new Set([1, 2, 3]), new Set([2, 3, 7]))).toEqual([7]);
  });

  it("names none on the first view, or for a step too big to be a landing", () => {
    expect(freshIds(null, new Set([1, 2]))).toEqual([]);
    const many = new Set(Array.from({ length: LANDING_MAX + 1 }, (_, i) => 100 + i));
    expect(freshIds(new Set([1]), many)).toEqual([]);
  });
});
