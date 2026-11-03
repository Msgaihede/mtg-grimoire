import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLLECTION_VALUE,
  addBelow,
  belowMinimumOf,
  bulkOf,
  minimumOf,
  parseBulkPrice,
  parseMinimumValue,
  parseSellPercent,
  reducedCopy,
  reducedPoint,
  reducedValue,
  reducesValue,
} from "./collectionValue";

const BOTH = { sellPercent: 70, minimumValue: 0.5, bulkPrice: 0 };

describe("the reduced price", () => {
  /** The design's own figures, line by line: the lines on screen add up to the total on screen. */
  it("takes the minimum out first, then the percentage of what is left", () => {
    expect(reducedValue(6247.11, { cards: 466, value: 58.84 }, BOTH)).toEqual({
      full: 6247.11,
      below: { minimum: 0.5, cards: 466, value: 58.84 },
      sale: { percent: 70, lost: 1856.48 },
      bulk: null,
      reduced: 4331.79,
    });
  });

  it("states a line only for the setting that made it", () => {
    const sell = reducedValue(100, undefined, { sellPercent: 68, minimumValue: 0, bulkPrice: 0 });
    expect(sell).toMatchObject({ below: null, reduced: 68, sale: { percent: 68, lost: 32 } });

    const minimum = reducedValue(100, { cards: 3, value: 1.2 }, {
      sellPercent: 100,
      minimumValue: 0.5,
      bulkPrice: 0,
    });
    expect(minimum).toMatchObject({ sale: null, reduced: 98.8 });
    expect(minimum?.below).toEqual({ minimum: 0.5, cards: 3, value: 1.2 });
  });

  it("has nothing to say with no settings, or nothing priced", () => {
    expect(reducedValue(100, undefined, DEFAULT_COLLECTION_VALUE)).toBeNull();
    expect(reducedValue(null, { cards: 1, value: 1 }, BOTH)).toBeNull();
  });

  /** `keepPreviousData` holds the last answer while a new minimum is asked: a figure drawn from it
   *  would ignore the minimum for a moment and then jump. */
  it("waits for the read that answers the minimum rather than guessing", () => {
    expect(reducedValue(100, undefined, BOTH)).toBeNull();
  });

  /** Issue #1477: a card under the minimum is worth the bulk price, not nothing — added after the
   *  percentage, which is a cut of the market price and never of a bulk rate. */
  it("counts each card under the minimum back at the bulk price", () => {
    expect(
      reducedValue(6247.11, { cards: 466, value: 58.84 }, { ...BOTH, bulkPrice: 0.01 }),
    ).toEqual({
      full: 6247.11,
      below: { minimum: 0.5, cards: 466, value: 58.84 },
      sale: { percent: 70, lost: 1856.48 },
      bulk: { price: 0.01, cards: 466, value: 4.66 },
      reduced: 4336.45,
    });
    // At 100%, the issue's own example: every card under $1 is $0.01.
    expect(
      reducedValue(
        10,
        { cards: 4, value: 2 },
        { sellPercent: 100, minimumValue: 1, bulkPrice: 0.01 },
      ),
    ).toMatchObject({ sale: null, bulk: { cards: 4, value: 0.04 }, reduced: 8.04 });
  });

  it("counts no bulk price without a minimum, or at zero", () => {
    const sell = reducedValue(100, undefined, { sellPercent: 50, minimumValue: 0, bulkPrice: 0.1 });
    expect(sell).toMatchObject({ below: null, bulk: null, reduced: 50 });
    expect(reducedValue(100, { cards: 3, value: 1.2 }, { ...BOTH, bulkPrice: 0 })?.bulk).toBeNull();
    // A bulk price alone reduces nothing.
    expect(
      reducedValue(100, undefined, { ...DEFAULT_COLLECTION_VALUE, bulkPrice: 0.1 }),
    ).toBeNull();
    expect(bulkOf({ ...DEFAULT_COLLECTION_VALUE, bulkPrice: 0.1 })).toBeUndefined();
    expect(bulkOf({ ...BOTH, bulkPrice: 0.1 })).toBe(0.1);
    expect(bulkOf(BOTH)).toBeUndefined();
  });

  it("reaches zero and stops there", () => {
    expect(reducedValue(4.1, { cards: 18, value: 4.1 }, BOTH)?.reduced).toBe(0);
    expect(reducedValue(4.1, { cards: 18, value: 4.2 }, BOTH)?.reduced).toBe(0);
  });
});

describe("what a read asks", () => {
  it("asks no minimum where none is set", () => {
    expect(minimumOf(DEFAULT_COLLECTION_VALUE)).toBeUndefined();
    expect(minimumOf(BOTH)).toBe(0.5);
  });

  it("calls either setting a reduction, and the defaults none", () => {
    expect(reducesValue(DEFAULT_COLLECTION_VALUE)).toBe(false);
    expect(reducesValue({ sellPercent: 99, minimumValue: 0, bulkPrice: 0 })).toBe(true);
    expect(reducesValue({ sellPercent: 100, minimumValue: 0.01, bulkPrice: 0 })).toBe(true);
  });
});

describe("addBelow", () => {
  it("adds a folder's to what is under it, and stays absent while nothing was asked", () => {
    expect(addBelow({ cards: 1, value: 2 }, { cards: 3, value: 4 })).toEqual({ cards: 4, value: 6 });
    expect(addBelow({ cards: 1, value: 2 }, undefined)).toEqual({ cards: 1, value: 2 });
    expect(addBelow(undefined, undefined)).toBeUndefined();
  });
});

describe("reducedPoint", () => {
  it("ignores a below no minimum asked for, and never goes under zero", () => {
    expect(reducedPoint(100, 40, 5, { sellPercent: 50, minimumValue: 0, bulkPrice: 0 })).toBe(50);
    expect(reducedPoint(100, 40, 5, BOTH)).toBe(42);
    expect(reducedPoint(10, 40, 5, BOTH)).toBe(0);
  });

  /** Issue #1477: the period's copies under the minimum at the bulk price, after the percentage —
   *  {@link reducedValue}'s order. */
  it("adds the period's copies under the minimum at the bulk price", () => {
    expect(reducedPoint(100, 40, 5, { ...BOTH, bulkPrice: 0.1 })).toBeCloseTo(42.5, 10);
    // No minimum, no bulk: there is nothing under it to price.
    expect(reducedPoint(100, 40, 5, { sellPercent: 50, minimumValue: 0, bulkPrice: 0.1 })).toBe(50);
    // A read too old to carry the copies counts none rather than guessing.
    expect(reducedPoint(100, 40, undefined, { ...BOTH, bulkPrice: 0.1 })).toBe(42);
  });
});

describe("the boxes and the per-copy minimum", () => {
  it("reads a percentage box, empty as 100 and out of bounds as a refusal", () => {
    expect(parseSellPercent("70")).toBe(70);
    expect(parseSellPercent(" 70,5 % ")).toBe(70.5);
    expect(parseSellPercent("")).toBe(100);
    expect(parseSellPercent("0")).toBeNull();
    expect(parseSellPercent("101")).toBeNull();
    expect(parseSellPercent("lots")).toBeNull();
  });

  it("reads a minimum box, empty as none and an unreadable price as a refusal", () => {
    expect(parseMinimumValue("0.50")).toBe(0.5);
    expect(parseMinimumValue("")).toBe(0);
    expect(parseMinimumValue("-1")).toBeNull();
  });

  it("reads a bulk box the minimum's way", () => {
    expect(parseBulkPrice("0.01")).toBe(0.01);
    expect(parseBulkPrice("")).toBe(0);
    expect(parseBulkPrice("cheap")).toBeNull();
  });

  /** The collection's SQL rule, here over a list: strictly below, each copy at its own price, and
   *  an unpriced copy below nothing. */
  it("counts each priced copy strictly below the minimum", () => {
    const below = belowMinimumOf([0.1, 0.1, 0.5, null, 9, 0.49], 0.5);
    expect(below.cards).toBe(3);
    expect(below.value).toBeCloseTo(0.69, 10);
    expect(belowMinimumOf([], 0.5)).toEqual({ cards: 0, value: 0 });
  });
});

/** Issue #1502: Open Packs' expected value and simulation count card by card. */
describe("reducedCopy", () => {
  const PRICES = [0.1, 0.1, 0.49, 0.5, null, 2.35, 9, 16.14];

  it("counts a copy under the minimum at the bulk price or nothing, the rest at the percentage", () => {
    expect(reducedCopy(0.1, BOTH)).toBe(0);
    expect(reducedCopy(0.5, BOTH)).toBeCloseTo(0.35, 10);
    expect(reducedCopy(0.1, { ...BOTH, bulkPrice: 0.01 })).toBe(0.01);
    expect(reducedCopy(null, BOTH)).toBeNull();
    expect(reducedCopy(0.1, DEFAULT_COLLECTION_VALUE)).toBe(0.1);
    // No minimum, no bulk price: a bulk price prices only what is under a minimum.
    expect(reducedCopy(0.1, { sellPercent: 50, minimumValue: 0, bulkPrice: 0.01 })).toBe(0.05);
  });

  it("adds up to reducedValue's figure over the same copies", () => {
    const full = PRICES.reduce<number>((s, p) => s + (p ?? 0), 0);
    for (const settings of [
      BOTH,
      { ...BOTH, bulkPrice: 0.02 },
      { sellPercent: 100, minimumValue: 0.41, bulkPrice: 0 },
      { sellPercent: 85, minimumValue: 0, bulkPrice: 0 },
    ]) {
      const sum = PRICES.reduce<number>((s, p) => s + (reducedCopy(p, settings) ?? 0), 0);
      const reduced = reducedValue(full, belowMinimumOf(PRICES, settings.minimumValue), settings);
      expect(sum).toBeCloseTo(reduced?.reduced ?? Number.NaN, 2);
    }
  });
});
