import { describe, expect, it } from "vitest";
import type { GameCard } from "@/lib/ipc";
import { INSPECT_MAX, INSPECT_MIN, changedStats, placePreview, wheelWidth } from "./Inspect";

describe("placePreview", () => {
  const box = { width: 1440, height: 900 };
  const size = { width: 336, height: 480 };

  it("opens below and right of the pointer", () => {
    expect(placePreview({ x: 100, y: 100 }, size, box)).toEqual({ left: 124, top: 124 });
  });

  it("flips left of the pointer at the right edge and stays inside the bottom", () => {
    const at = placePreview({ x: 1300, y: 800 }, size, box);
    expect(at.left).toBe(1300 - 24 - 336);
    expect(at.top + size.height).toBeLessThanOrEqual(box.height);
  });
});

describe("wheelWidth", () => {
  it("grows on a wheel up and shrinks on a wheel down, within the bounds", () => {
    expect(wheelWidth(320, -100)).toBeGreaterThan(320);
    expect(wheelWidth(320, 100)).toBeLessThan(320);
    expect(wheelWidth(INSPECT_MAX, -100)).toBe(INSPECT_MAX);
    expect(wheelWidth(INSPECT_MIN, 100)).toBe(INSPECT_MIN);
  });
});

describe("changedStats", () => {
  const pt = (
    power: number | null,
    toughness: number | null,
    basePower: number | null,
    baseToughness: number | null,
  ) => ({ power, toughness, basePower, baseToughness }) as GameCard;

  it("is nothing for a creature as printed, and for a non-creature", () => {
    expect(changedStats(pt(2, 2, 2, 2))).toBeNull();
    expect(changedStats(pt(null, null, null, null))).toBeNull();
  });

  it("gives both stats once either has moved, each with which way", () => {
    expect(changedStats(pt(4, 4, 2, 2))).toEqual({
      power: 4,
      toughness: 4,
      powerTone: "up",
      toughnessTone: "up",
    });
    expect(changedStats(pt(1, 3, 2, 3))).toEqual({
      power: 1,
      toughness: 3,
      powerTone: "down",
      toughnessTone: "same",
    });
  });

  it("marks a creature with no base as changed, neither up nor down", () => {
    expect(changedStats(pt(3, 3, null, null))).toEqual({
      power: 3,
      toughness: 3,
      powerTone: "same",
      toughnessTone: "same",
    });
  });
});
