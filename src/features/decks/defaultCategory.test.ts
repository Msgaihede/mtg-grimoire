import { describe, expect, it } from "vitest";
import { AUTO_CATEGORY } from "./autoCategory";
import { defaultPileFor } from "./defaultCategory";

/** The Actual list's piles — what Deck settings offers, and so what the stored id names. */
const LIVE = [
  { id: 1, name: "Commander" },
  { id: 2, name: "Sideboard" },
  { id: 3, name: "Ramp" },
];
/** The plan's own piles since user schema v53: ids of their own, and no Ramp. */
const THEORY = [
  { id: 11, name: "Commander" },
  { id: 12, name: "Sideboard" },
  { id: 14, name: "ramp" },
];

describe("defaultPileFor", () => {
  it("answers Auto for Auto on either list", () => {
    expect(defaultPileFor(AUTO_CATEGORY, LIVE, undefined)).toBe(AUTO_CATEGORY);
    expect(defaultPileFor(AUTO_CATEGORY, THEORY, LIVE)).toBe(AUTO_CATEGORY);
  });

  it("answers the stored id itself when the list on screen carries it", () => {
    expect(defaultPileFor(2, LIVE, undefined)).toBe(2);
    // The live list handed as its own second argument changes nothing.
    expect(defaultPileFor(2, LIVE, LIVE)).toBe(2);
  });

  /** The case the whole function exists for: the reader pointed the deck at their Sideboard,
   *  and on the Theory tab that is the plan's Sideboard — a different row with the same name. */
  it("resolves a live pile to the plan's pile of the same name", () => {
    expect(defaultPileFor(2, THEORY, LIVE)).toBe(12);
  });

  /** Exact, like the grain: the plan's "ramp" is not the reader's "Ramp". */
  it("answers Auto when the plan has no pile of that exact name", () => {
    expect(defaultPileFor(3, THEORY, LIVE)).toBe(AUTO_CATEGORY);
  });

  /** A deleted pile caught between the deck row and the category list, or a live read not yet
   *  back: Auto rather than a guess. */
  it("answers Auto for an id neither list carries, and while the live list is unread", () => {
    expect(defaultPileFor(99, THEORY, LIVE)).toBe(AUTO_CATEGORY);
    expect(defaultPileFor(99, LIVE, undefined)).toBe(AUTO_CATEGORY);
    expect(defaultPileFor(2, THEORY, undefined)).toBe(AUTO_CATEGORY);
  });
});
