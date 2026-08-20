import { describe, expect, it } from "vitest";
import type { CollectionRow, DeckCard, WishRow } from "@/lib/ipc";
import { fromCollectionRow, fromDeckCard, fromWishRow } from "./TransferCard";

describe("fromDeckCard", () => {
  it("carries the three category facts and leaves the collection's fields null", () => {
    const card = { name: "Sol Ring", quantity: 2, setCode: "LTC", collectorNumber: "285",
      finish: "foil", lang: "en", categoryName: "Ramp", categoryKind: "main",
      categoryActive: true, setName: "Commander Masters", rarity: "uncommon",
      typeLine: "Artifact", unitPrice: 1.5 } as unknown as DeckCard;

    const t = fromDeckCard(card);

    expect(t).toMatchObject({ name: "Sol Ring", quantity: 2, categoryName: "Ramp",
      categoryKind: "main", categoryActive: true });
    // A deck does not record a condition. `null` is "this surface has no such fact",
    // which is what `availableFields` reads.
    expect(t.condition).toBeNull();
    expect(t.purchasePrice).toBeNull();
  });
});

describe("fromCollectionRow", () => {
  it("carries condition and acquisition, and has no category at all", () => {
    const row = { name: "Sol Ring", quantity: 3, setCode: "LTC", collectorNumber: "285",
      finish: "nonfoil", lang: "en", condition: "LP", tradelistQuantity: 1,
      purchasePrice: 2.5, purchaseCurrency: "USD", acquiredAt: "2026-01-02",
      acquisitionSource: "LGS", serialNumber: null, grading: null, altered: false,
      signed: false, proxy: false, misprint: false, tags: "[]", notes: "box 3",
      setName: "Commander Masters", rarity: "uncommon", typeLine: "Artifact",
      unitPrice: 1.5 } as unknown as CollectionRow;

    const t = fromCollectionRow(row);

    expect(t).toMatchObject({ condition: "LP", purchasePrice: 2.5, notes: "box 3" });
    expect(t.categoryName).toBeNull();
    expect(t.categoryKind).toBeNull();
  });

  it("reads `nonfoil` as the regular copy, which is null everywhere else in this app", () => {
    const row = { name: "Sol Ring", quantity: 1, setCode: "LTC", collectorNumber: "285",
      finish: "nonfoil" } as unknown as CollectionRow;
    expect(fromCollectionRow(row).finish).toBeNull();
  });
});

describe("fromWishRow", () => {
  it("has no set name, because a wishlist row does not carry one", () => {
    const row = { name: "Sol Ring", quantity: 1, setCode: "LTC", collectorNumber: "285",
      preferredFinish: null, lang: "en", notes: null, unitPrice: 1.5, rarity: "uncommon",
      typeLine: "Artifact" } as unknown as WishRow;

    const t = fromWishRow(row);

    expect(t.setName).toBeNull();
    expect(t.finish).toBeNull();
    expect(t.condition).toBeNull();
  });
});
