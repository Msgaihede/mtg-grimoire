import { describe, expect, it } from "vitest";
import { INSPECT_MAX, INSPECT_MIN, placePreview, wheelWidth } from "./Inspect";

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
