import { describe, expect, it } from "vitest";
import type { CardSummary, CollectionRow, DeckCard, WishRow } from "@/lib/ipc";
import { collectionItem, deckCardItem, searchItem, wishItem } from "./items";

const summary = (over: Partial<CardSummary> = {}): CardSummary =>
  ({
    id: "card-1",
    name: "Lightning Bolt",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "161",
    rarity: "common",
    price: 1.5,
    ownedQuantity: 0,
    printings: 1,
    ...over,
  }) as CardSummary;

describe("searchItem", () => {
  it("names the tile for the card and its printing", () => {
    const item = searchItem(summary(), "usd");
    expect(item.pressLabel).toBe("Lightning Bolt, LEA 161");
    expect(item.chin).toEqual({
      setCode: "lea",
      collectorNumber: "161",
      printingTitle: "Limited Edition Alpha",
    });
    expect(item.money).toBe("$1.50");
    expect(item.count).toBe(0);
  });

  it("writes an unpriced card as an em dash, never as zero", () => {
    expect(searchItem(summary({ price: null }), "usd").money).toBe("—");
  });

  it("counts what the reader owns", () => {
    expect(searchItem(summary({ ownedQuantity: 3 }), "usd").count).toBe(3);
  });
});

const entry = (over: Partial<CollectionRow> = {}): CollectionRow =>
  ({
    id: 9,
    cardId: "card-1",
    name: "Lightning Bolt",
    setCode: "lea",
    setName: null,
    collectorNumber: "161",
    rarity: "common",
    finish: "foil",
    quantity: 2,
    unitPrice: 4,
    ...over,
  }) as CollectionRow;

describe("collectionItem", () => {
  it("keys on the row, because one printing can be two rows", () => {
    expect(collectionItem(entry(), "usd").key).toBe("9");
  });

  it("marks a foil copy and leaves a plain one unmarked", () => {
    expect(collectionItem(entry(), "usd").finish).toBe("foil");
    expect(collectionItem(entry({ finish: "nonfoil" }), "usd").finish).toBeNull();
  });

  it("names a card the corpus has forgotten rather than drawing nothing", () => {
    expect(collectionItem(entry({ name: null }), "usd").name).toBe("Unknown card");
  });
});

const wish = (over: Partial<WishRow> = {}): WishRow =>
  ({
    id: 3,
    oracleId: "oracle-1",
    cardId: null,
    name: "Sol Ring",
    setCode: null,
    collectorNumber: null,
    rarity: null,
    artCardId: "art-1",
    quantity: 1,
    preferredFinish: null,
    unitPrice: null,
    ...over,
  }) as WishRow;

describe("wishItem", () => {
  it("draws a wish for any printing without a set line", () => {
    const item = wishItem(wish(), "usd");
    expect(item.chin).toEqual({ printing: "Any printing", printingTitle: null });
    expect(item.pressLabel).toBe("Sol Ring, any printing");
    // The picture is the printing the wish is *drawn as*, which is not the one it asks for.
    expect(item.cardId).toBe("art-1");
  });

  it("draws a pinned wish's own printing", () => {
    const item = wishItem(wish({ cardId: "card-9", setCode: "c21", collectorNumber: "263" }), "usd");
    expect(item.chin).toEqual({ setCode: "c21", collectorNumber: "263" });
    expect(item.pressLabel).toBe("Sol Ring, C21 263");
    expect(item.cardId).toBe("card-9");
  });

  it("treats a set with no number as no printing at all", () => {
    // Both halves or neither — a chin reading `c21 · null` is the bug this guards.
    expect(wishItem(wish({ setCode: "c21", collectorNumber: null }), "usd").chin).toEqual({
      printing: "Any printing",
      printingTitle: null,
    });
  });
});

const deckCard = (over: Partial<DeckCard> = {}): DeckCard =>
  ({
    id: 41,
    cardId: "card-1",
    name: "Lightning Bolt",
    setCode: "2x2",
    setName: "Double Masters 2022",
    collectorNumber: "117",
    rarity: "uncommon",
    finish: null,
    quantity: 4,
    unitPrice: 2.25,
    ...over,
  }) as DeckCard;

describe("deckCardItem", () => {
  it("keys on the deck row, and counts its copies", () => {
    // A foil and a regular copy of one printing in one pile are two rows with one card id.
    const item = deckCardItem(deckCard(), "usd");
    expect(item.key).toBe("41");
    expect(item.cardId).toBe("card-1");
    expect(item.count).toBe(4);
    expect(item.money).toBe("$2.25");
    expect(item.pressLabel).toBe("Lightning Bolt, 2X2 117");
  });

  it("leaves the regular copy unmarked, which a deck row spells as null", () => {
    expect(deckCardItem(deckCard(), "usd").finish).toBeNull();
    expect(deckCardItem(deckCard({ finish: "etched" }), "usd").finish).toBe("etched");
  });
});
