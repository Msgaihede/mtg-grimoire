import { describe, expect, it } from "vitest";
import { CONDITION_NOT_SET } from "@/lib/conditions";
import type { CollectionRow, DeckCard, WishRow } from "@/lib/ipc";
import { TRANSFER_FIELDS } from "./fields";
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

  /**
   * The sentinel stops at the database.
   *
   * `NONE` exists because `condition` is the third term of a UNIQUE index and SQLite counts two
   * NULLs as distinct — a storage decision, not a fact about the card. Written into a file it
   * would export the mechanism: every other tool the reader opens that CSV in would show a
   * column of `NONE` where the truthful answer is a blank, and `fields.ts` spells a `null`
   * condition as `""` already.
   *
   * **This test is one of the two things holding that contract, so it asserts the written
   * cell.** `src-tauri/src/mirror/read.rs`' `from_collection_row` makes the identical
   * substitution and its own test asserts the same thing on that side — and `__golden__/`
   * fences neither, because the corpus holds already-built cards and the row → card step runs
   * upstream of every golden case. A green golden suite says nothing about this line.
   */
  it("exports a copy nobody has graded as an empty condition, not as the sentinel", () => {
    const row = { name: "Sol Ring", quantity: 1, setCode: "LTC", collectorNumber: "285",
      finish: "nonfoil", condition: CONDITION_NOT_SET } as unknown as CollectionRow;

    const t = fromCollectionRow(row);

    expect(t.condition).toBeNull();
    expect(TRANSFER_FIELDS.condition.read(t)).toBe("");
  });

  /**
   * The substitution is exact: a real grade is carried through untouched, and only the four
   * letters of the sentinel, spelled that way, become `null`.
   *
   * The last two entries are what make that assertion mean something rather than restate the
   * line above it. `NONE-ish` is the sentinel as a *prefix* and `none` is it in the wrong case —
   * neither is a value the column's CHECK can hold, and both are here because a `startsWith` or
   * a `toUpperCase()` in that one-line helper would be invisible to every grade in the list.
   */
  it("leaves every real grade alone, matching the sentinel exactly", () => {
    for (const grade of ["NM", "LP", "MP", "HP", "DMG", "NONE-ish", "none"]) {
      const row = { name: "Sol Ring", quantity: 1, condition: grade } as unknown as CollectionRow;
      expect(fromCollectionRow(row).condition, grade).toBe(grade);
    }
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
