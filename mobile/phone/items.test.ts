import { describe, expect, it } from "vitest";
import type { CardSummary, CollectionRow, DeckCard, WishRow } from "@/lib/ipc";
import { collectionItem, deckCardItem, searchItem, wishItem } from "./items";

/** A printing sold both ways — which is most of them, and the one a wall leaves unmarked. */
const BOTH = '["nonfoil","foil"]';
/** A printing that exists only in foil: the mark states what the object is. */
const FOIL_ONLY = '["foil"]';

const summary = (over: Partial<CardSummary> = {}): CardSummary =>
  ({
    id: "card-1",
    name: "Lightning Bolt",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "161",
    rarity: "common",
    price: 1.5,
    finishes: BOTH,
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

  it("marks a printing that exists only in foil, and says so in the tile's name", () => {
    const item = searchItem(summary({ finishes: FOIL_ONLY }), "usd");
    expect(item.finish).toBe("foil");
    expect(item.pressLabel).toBe("Lightning Bolt, LEA 161, Foil");
  });

  it("leaves a printing sold both ways unmarked", () => {
    expect(searchItem(summary(), "usd").finish).toBeNull();
    // An orphan's `finishes` is null: nothing is known, so nothing is claimed.
    expect(searchItem(summary({ finishes: null }), "usd").finish).toBeNull();
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

  it("names a foil copy and a plain one of one printing differently", () => {
    expect(collectionItem(entry(), "usd").pressLabel).toBe("Lightning Bolt, LEA 161, Foil");
    expect(collectionItem(entry({ finish: "nonfoil" }), "usd").pressLabel).toBe(
      "Lightning Bolt, LEA 161",
    );
  });

  it("leaves the count out of the name, because the wall writes it", () => {
    expect(collectionItem(entry({ quantity: 4 }), "usd").pressLabel).not.toMatch(/cop/);
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

  it("says the finish a wish asks for, pinned or not", () => {
    expect(wishItem(wish({ preferredFinish: "foil" }), "usd").pressLabel).toBe(
      "Sol Ring, any printing, Foil",
    );
    expect(
      wishItem(
        wish({ cardId: "card-9", setCode: "c21", collectorNumber: "263", preferredFinish: "etched" }),
        "usd",
      ).pressLabel,
    ).toBe("Sol Ring, C21 263, Etched");
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
    finishes: BOTH,
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

  it("leaves a row that has said nothing unmarked when its printing is sold both ways", () => {
    expect(deckCardItem(deckCard(), "usd").finish).toBeNull();
  });

  it("marks a row that has said nothing when its printing exists only in foil", () => {
    // `null` on a deck row is "the deck has not said", not "regular": a foil-only printing is
    // foil whatever the row says.
    const item = deckCardItem(deckCard({ finishes: FOIL_ONLY }), "usd");
    expect(item.finish).toBe("foil");
    expect(item.pressLabel).toBe("Lightning Bolt, 2X2 117, Foil");
  });

  it("lets the deck's own statement win over the printing's", () => {
    expect(deckCardItem(deckCard({ finish: "etched", finishes: FOIL_ONLY }), "usd").finish).toBe(
      "etched",
    );
  });
});
