import { describe, expect, it } from "vitest";
import type { DeckCard } from "@/lib/ipc";
import type { CardGroup } from "../grouping";
import { sameDrawnProps, sameGroup, sameItems } from "./sameDrawn";

// Two rows, and nothing in them is read: the comparator's whole contract is the rows' identity,
// so a field a builder would fill in could only make this file look like it tested more.
const bolt = { id: 1, name: "Lightning Bolt" } as unknown as DeckCard;
const bear = { id: 2, name: "Grizzly Bears" } as unknown as DeckCard;

/** A pile as `buildGroups` answers one — rebuilt fresh by every call, which is the point. */
function pile(cards: CardGroup["cards"], over: Partial<CardGroup> = {}): CardGroup {
  return {
    key: "cat-1",
    name: "Main",
    kind: "main",
    categoryId: 1,
    isActive: true,
    isPredefined: false,
    isAuto: false,
    cards,
    count: cards.length,
    totalPrice: null,
    ...over,
  };
}

describe("sameDrawnProps", () => {
  it("holds a rebuilt pile whose rows are the same objects in the same order", () => {
    const onSelect = () => {};
    expect(
      sameDrawnProps(
        { group: pile([bolt, bear]), onSelect },
        { group: pile([bolt, bear]), onSelect },
      ),
    ).toBe(true);
    // CardStack's shape: the rows as a bare array prop.
    expect(sameDrawnProps({ cards: [bolt, bear] }, { cards: [bolt, bear] })).toBe(true);
  });

  it("lets go of a pile the filter narrowed, reordered, or a re-read replaced a row of", () => {
    expect(sameDrawnProps({ group: pile([bolt, bear]) }, { group: pile([bolt]) })).toBe(false);
    expect(sameDrawnProps({ cards: [bolt, bear] }, { cards: [bear, bolt] })).toBe(false);
    // Equal fields are not the same row: a re-read is when a price or a count may have moved.
    expect(sameDrawnProps({ cards: [bolt] }, { cards: [{ ...bolt }] })).toBe(false);
  });

  it("is still `Object.is` for everything that is not an array or the group", () => {
    expect(sameDrawnProps({ onSelect: () => {} }, { onSelect: () => {} })).toBe(false);
    expect(sameDrawnProps({ zoom: 1 }, { zoom: 1.25 })).toBe(false);
    expect(sameDrawnProps({ group: pile([bolt]) }, { group: pile([bolt], { name: "Burn" }) })).toBe(
      false,
    );
  });

  it("counts an optional prop going from absent to present as a change", () => {
    expect(sameDrawnProps({}, { hidden: undefined })).toBe(false);
  });
});

describe("sameGroup / sameItems", () => {
  it("compares a group by its fields and an array by its slots", () => {
    expect(sameGroup(pile([bolt]), pile([bolt]))).toBe(true);
    expect(sameGroup(pile([bolt]), pile([bear]))).toBe(false);
    expect(sameItems([1, 2], [1, 2])).toBe(true);
    expect(sameItems([1, 2], [1])).toBe(false);
  });
});
