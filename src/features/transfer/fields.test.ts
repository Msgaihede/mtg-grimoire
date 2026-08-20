import { describe, expect, it } from "vitest";
import { availableFields, defaultFields, TRANSFER_FIELD_IDS, TRANSFER_FIELDS } from "./fields";
import { EXPORT_FORMATS } from "./formats";

describe("availableFields", () => {
  it("is the intersection of what the format can carry and what the surface has", () => {
    // Archidekt has a bracket for a pile; a wishlist has no piles.
    expect(availableFields("archidekt", "deck")).toContain("category");
    expect(availableFields("archidekt", "wishlist")).not.toContain("category");
  });

  it("offers no finish where the format has nowhere to put one", () => {
    // Arena's line is `1 Sol Ring (LTC) 285` and nothing else.
    expect(availableFields("arena", "deck")).not.toContain("finish");
    expect(availableFields("moxfield", "deck")).toContain("finish");
  });

  it("offers the collection's own fields in CSV and in nothing else", () => {
    expect(availableFields("csv", "collection")).toContain("purchasePrice");
    expect(availableFields("plain", "collection")).not.toContain("purchasePrice");
  });

  it("always offers quantity and name, in every format on every surface", () => {
    for (const format of EXPORT_FORMATS) {
      for (const surface of ["deck", "collection", "wishlist"] as const) {
        expect(availableFields(format, surface)).toEqual(
          expect.arrayContaining(["quantity", "name"]),
        );
      }
    }
  });

  it("answers in registry order, so a CSV's columns are stable", () => {
    const fields = availableFields("csv", "collection");
    const positions = fields.map((f) => TRANSFER_FIELD_IDS.indexOf(f));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("defaultFields", () => {
  it("reproduces today's deck CSV columns exactly", () => {
    expect(defaultFields("csv", "deck")).toEqual([
      "quantity", "name", "setCode", "collectorNumber", "category", "finish",
    ]);
  });

  it("drops the category on a surface that has none and keeps condition where there is one", () => {
    expect(defaultFields("csv", "collection")).toEqual([
      "quantity", "name", "setCode", "collectorNumber", "finish", "condition",
    ]);
  });

  it("is a subset of what is available, in every pair", () => {
    for (const format of EXPORT_FORMATS) {
      for (const surface of ["deck", "collection", "wishlist"] as const) {
        const available = availableFields(format, surface);
        for (const id of defaultFields(format, surface)) expect(available).toContain(id);
      }
    }
  });
});

describe("TRANSFER_FIELDS", () => {
  it("names every id exactly once, with a unique CSV header", () => {
    const headers = TRANSFER_FIELD_IDS.map((id) => TRANSFER_FIELDS[id].csvHeader.toLowerCase());
    expect(new Set(headers).size).toBe(TRANSFER_FIELD_IDS.length);
  });
});
