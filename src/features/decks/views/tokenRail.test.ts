import { describe, expect, it } from "vitest";
import { categoryDragData, readCategoryDrag } from "../categoryDrag";
import {
  isTokenPileDrag,
  storedRailIndex,
  tokenPileDragData,
  tokenRailSlot,
  withTokenPile,
} from "./tokenRail";

describe("tokenRailSlot", () => {
  it.each([
    [-1, 3, 3],
    [0, 3, 0],
    [2, 3, 2],
    [3, 3, 3],
    [5, 3, 3],
    [2, 0, 0],
    [Number.NaN, 2, 2],
  ])("stored %d over %d rail piles is slot %d", (stored, len, slot) => {
    expect(tokenRailSlot(stored, len)).toBe(slot);
  });

  /** A fraction is not a slot any rail has, and reads as last rather than as a rounding of one. */
  it("reads a fractional index as last", () => {
    expect(tokenRailSlot(1.5, 3)).toBe(3);
  });
});

describe("storedRailIndex", () => {
  it("stores the last slot as -1, so piles added later stay above the pile", () => {
    expect(storedRailIndex(3, 3)).toBe(-1);
    expect(storedRailIndex(1, 3)).toBe(1);
  });

  /** The round trip the grip and a drop both make: a slot stored and read back is the same slot,
   *  whatever the rail's length — the last one included, which is stored as `-1`. */
  it("reads back as the slot it stored", () => {
    for (const length of [0, 1, 4]) {
      for (let slot = 0; slot <= length; slot += 1) {
        expect(tokenRailSlot(storedRailIndex(slot, length), length)).toBe(slot);
      }
    }
  });
});

it("inserts the pile at its slot", () => {
  expect(withTokenPile(["side", "maybe"], 1, "T")).toEqual(["side", "T", "maybe"]);
  expect(withTokenPile([], 0, "T")).toEqual(["T"]);
});

/** Total, like `tokenRailSlot`: a slot the list does not have puts the pile last, never nowhere
 *  and never first. */
it("puts the pile last for a slot the list does not have", () => {
  expect(withTokenPile(["side", "maybe"], 7, "T")).toEqual(["side", "maybe", "T"]);
  expect(withTokenPile(["side", "maybe"], -1, "T")).toEqual(["side", "maybe", "T"]);
  expect(withTokenPile(["side", "maybe"], Number.NaN, "T")).toEqual(["side", "maybe", "T"]);
});

it("recognises its own payload and nobody else's", () => {
  expect(isTokenPileDrag(tokenPileDragData())).toBe(true);
  expect(isTokenPileDrag({ "mtg-grimoire/category-order": true, categoryId: 3 })).toBe(false);
  // The category gesture's own writer, so the two marks cannot come to share a key by a rename.
  expect(isTokenPileDrag(categoryDragData(3))).toBe(false);
  expect(isTokenPileDrag({})).toBe(false);
  // …and the other way round: a category target reads the token pile as no pile of its own.
  expect(readCategoryDrag(tokenPileDragData())).toBeNull();
});
