import { describe, expect, it } from "vitest";
import { colorsOf, PRODUCT, priceOf, SET } from "./fixture";
import { mulberry32 } from "./rng";
import {
  chanceToBeat,
  expectedValue,
  finishPrice,
  histogram,
  median,
  packValue,
  percentileOf,
  sealedFigures,
  simulate,
  variance,
} from "./value";

/*
 * The figures, by hand from `fixture.ts`:
 *
 * - common: 10¢ every card — mean 0.1, variance 0.
 * - rare: (7·1 + 1·9) / 8 = 2; E[p²] = (7·1 + 81) / 8 = 11, variance 11 − 4 = 7.
 * - foil: (1·2 + 3·6) / 4 = 5; E[p²] = (4 + 108) / 4 = 28, variance 3.
 * - land: fixed, 0.5.
 *
 * Variant A (¾): 5·0.1 + 2 + 0.5 = 3.0, variance 7.
 * Variant B (¼): 4·0.1 + 2 + 5 + 0.5 = 7.9, variance 7 + 3 = 10.
 *
 * EV = ¾·3 + ¼·7.9 = 4.225.
 * Var = ¾·(7 + 1.225²) + ¼·(10 + 3.675²) = 6.37546875 + 5.87640625 = 12.251875.
 */
const EV = 4.225;
const VAR = 12.251875;

describe("finishPrice", () => {
  const p = (nonfoil: number | null, foil: number | null, etched: number | null) => ({
    nonfoil,
    foil,
    etched,
  });

  it("prices a foil at foil, else nonfoil, else etched", () => {
    expect(finishPrice(p(1, 2, 3), true)).toBe(2);
    expect(finishPrice(p(1, null, 3), true)).toBe(1);
    expect(finishPrice(p(null, null, 3), true)).toBe(3);
  });

  it("prices a non-foil at nonfoil, else foil, else etched", () => {
    expect(finishPrice(p(1, 2, 3), false)).toBe(1);
    expect(finishPrice(p(null, 2, 3), false)).toBe(2);
    expect(finishPrice(p(null, null, 3), false)).toBe(3);
  });

  it("is null for a card with no price, or none answered", () => {
    expect(finishPrice(p(null, null, null), false)).toBeNull();
    expect(finishPrice(undefined, true)).toBeNull();
  });
});

describe("expectedValue and variance", () => {
  it("match the figures worked by hand", () => {
    expect(expectedValue(PRODUCT, priceOf)).toBeCloseTo(EV, 10);
    expect(variance(PRODUCT, priceOf)).toBeCloseTo(VAR, 10);
  });

  it("count an unpriced card as 0", () => {
    // Nothing priced but the mythic: ¾·(1/8·9) + ¼·(1/8·9) = 1.125.
    const mythicOnly = (cardId: string) => (cardId === "mythic" ? 9 : null);
    expect(expectedValue(PRODUCT, mythicOnly)).toBeCloseTo(1.125, 10);
    expect(expectedValue(PRODUCT, () => null)).toBe(0);
    expect(variance(PRODUCT, () => null)).toBe(0);
  });
});

describe("packValue", () => {
  it("sums the cards in their finishes, unpriced as 0", () => {
    expect(
      packValue(
        [
          { cardId: "mythic", foil: false, sheet: "rare" },
          { cardId: "f2", foil: true, sheet: "foil" },
          { cardId: "unknown", foil: false, sheet: "common" },
        ],
        priceOf,
      ),
    ).toBeCloseTo(15, 10);
  });
});

describe("simulate", () => {
  it("is sorted, deterministic, and agrees with the theory", () => {
    const values = simulate(PRODUCT, priceOf, 20000, mulberry32(3), colorsOf);
    expect(values).toHaveLength(20000);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    expect(simulate(PRODUCT, priceOf, 50, mulberry32(3))).toEqual(
      simulate(PRODUCT, priceOf, 50, mulberry32(3)),
    );
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const v = values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length;
    expect(Math.abs(mean - EV)).toBeLessThan(0.1);
    expect(Math.abs(v - VAR) / VAR).toBeLessThan(0.08);
    // The cheapest pack is variant A with the rare: 0.5 + 1 + 0.5.
    expect(values[0]).toBeCloseTo(2, 10);
  });
});

describe("the distribution's figures", () => {
  const sorted = Float64Array.from([1, 2, 2, 3]);

  it("percentileOf is the mid-rank, 0–100", () => {
    expect(percentileOf(sorted, 2)).toBe(50);
    expect(percentileOf(sorted, 0)).toBe(0);
    expect(percentileOf(sorted, 5)).toBe(100);
    expect(percentileOf(sorted, 3)).toBe(87.5);
    expect(percentileOf(new Float64Array(0), 1)).toBe(0);
  });

  it("median", () => {
    expect(median(Float64Array.from([1, 2, 3]))).toBe(2);
    expect(median(sorted)).toBe(2);
    expect(median(Float64Array.from([1, 2, 3, 4]))).toBe(2.5);
    expect(median(new Float64Array(0))).toBe(0);
  });

  it("chanceToBeat counts only packs worth more", () => {
    expect(chanceToBeat(sorted, 2)).toBe(0.25);
    expect(chanceToBeat(sorted, 0)).toBe(1);
    expect(chanceToBeat(sorted, 3)).toBe(0);
  });

  it("histogram holds every value, the tail in the last bin", () => {
    const values = Float64Array.from({ length: 1000 }, (_, i) => (i === 999 ? 500 : i / 100));
    const bins = histogram(values, 10);
    expect(bins).toHaveLength(10);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(1000);
    expect(bins[0].from).toBe(0);
    expect(bins[9].to).toBe(500);
    // Equal widths up to the 99th percentile (9.89).
    expect(bins[1].from - bins[0].from).toBeCloseTo(0.989, 6);
    expect(histogram(Float64Array.from([2, 2, 2]), 10)).toEqual([{ from: 2, to: 2, count: 3 }]);
    expect(histogram(new Float64Array(0), 10)).toEqual([]);
  });
});

describe("sealedFigures", () => {
  it("adds its boosters' figures and its fixed cards", () => {
    const { ev, sd, simulated } = sealedFigures(SET, "box", priceOf, 4000, mulberry32(8));
    // Five openable boosters and the $4 foil promo.
    expect(ev).toBeCloseTo(5 * EV + 4, 10);
    expect(sd).toBeCloseTo(Math.sqrt(5 * VAR), 10);
    expect(simulated).toHaveLength(4000);
    const mean = simulated.reduce((s, v) => s + v, 0) / simulated.length;
    expect(Math.abs(mean - ev) / ev).toBeLessThan(0.03);
    expect(simulated[0]).toBeGreaterThanOrEqual(5 * 2 + 4);
  });
});
