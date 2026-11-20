import { describe, expect, it } from "vitest";
import { LIFE_MAX, LIFE_MIN, clampLife, deltaText, grouped, humanize } from "./lifeNumber";

describe("humanize", () => {
  /** Never more than three digits and a unit, cut and never rounded up. */
  it.each([
    [0n, "0", ""],
    [7n, "7", ""],
    [40n, "40", ""],
    [999n, "999", ""],
    [1000n, "1.00k", "1,000"],
    [1009n, "1.00k", "1,009"],
    [1250n, "1.25k", "1,250"],
    [12_500n, "12.5k", "12,500"],
    [12_599n, "12.5k", "12,599"],
    [125_000n, "125k", "125,000"],
    [999_999n, "999k", "999,999"],
    [1_000_000n, "1.00m", "1,000,000"],
    [1_250_000n, "1.25m", "1,250,000"],
    [5_670_000_000n, "5.67b", "5,670,000,000"],
    [12_000_000_000_000n, "12.0t", "12,000,000,000,000"],
    [999_000_000_000_000_000n, "999qa", "999,000,000,000,000,000"],
    [LIFE_MAX, "9.22qi", "9,223,372,036,854,775,807"],
  ])("draws %s as %s", (value, text, exact) => {
    expect(humanize(value)).toEqual({ text, exact });
  });

  it("puts a real minus sign on a negative, short and exact alike", () => {
    expect(humanize(-4n)).toEqual({ text: "−4", exact: "" });
    expect(humanize(-12_500n)).toEqual({ text: "−12.5k", exact: "−12,500" });
    expect(humanize(LIFE_MIN)).toEqual({ text: "−9.22qi", exact: "−9,223,372,036,854,775,808" });
  });

  it("never draws more than three digits", () => {
    for (let v = 1n; v < LIFE_MAX / 7n; v = v * 7n + 3n) {
      expect(humanize(v).text.replace(/\D/g, "").length).toBeLessThanOrEqual(3);
    }
  });
});

describe("clampLife", () => {
  it("holds a total to a signed 64-bit integer", () => {
    expect(clampLife(LIFE_MAX + 1n)).toBe(LIFE_MAX);
    expect(clampLife(LIFE_MIN - 10n)).toBe(LIFE_MIN);
    expect(clampLife(-3n)).toBe(-3n);
  });
});

describe("the small print", () => {
  it("groups thousands", () => {
    expect(grouped(0n)).toBe("0");
    expect(grouped(999n)).toBe("999");
    expect(grouped(1234567n)).toBe("1,234,567");
    expect(grouped(-1000n)).toBe("−1,000");
  });

  it("spells a delta with its sign", () => {
    expect(deltaText(3n)).toBe("+3");
    expect(deltaText(-12n)).toBe("−12");
    expect(deltaText(1_250_000n)).toBe("+1.25m");
  });
});
