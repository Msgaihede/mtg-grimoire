import { describe, expect, it } from "vitest";
import { DEFAULT_SCANNER_OPTIONS, SLIDERS } from "./scannerOptions";

describe("the scanner options", () => {
  it("start where the debug page's sliders start", () => {
    expect(DEFAULT_SCANNER_OPTIONS).toEqual({
      work_long_edge: 1024,
      method: "both",
      canny_low: 40,
      canny_high: 100,
      aspect_tolerance: 0.18,
      min_cardness: 0,
      stages: false,
      rule: "votes",
      decide_at: 8,
      lead_margin: 1.3,
    });
  });

  it("draws one slider per numeric field, each holding its default", () => {
    for (const s of SLIDERS) {
      const v = DEFAULT_SCANNER_OPTIONS[s.key];
      expect(typeof v).toBe("number");
      expect(v).toBeGreaterThanOrEqual(s.min);
      expect(v).toBeLessThanOrEqual(s.max);
      expect(s.format(v as number).length).toBeGreaterThan(0);
    }
    expect(SLIDERS.map((s) => s.key)).toEqual([
      "decide_at",
      "lead_margin",
      "work_long_edge",
      "canny_low",
      "canny_high",
      "aspect_tolerance",
      "min_cardness",
    ]);
  });
});
