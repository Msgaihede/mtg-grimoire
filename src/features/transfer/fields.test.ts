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

/**
 * The deck label's two fields, which are the one place the two declarations disagree on purpose.
 *
 * Archidekt carries the colour **inside** `^Keeper,#4aab08^`, so it offers `tag` and no colour
 * box — a checkbox that changed nothing would be worse than its absence. A CSV spends one column
 * per value, so it offers both.
 */
describe("the deck label's fields", () => {
  it("offers Archidekt the label and not a colour of its own", () => {
    const offered = availableFields("archidekt", "deck");
    expect(offered).toContain("tag");
    expect(offered).not.toContain("tagColor");
  });

  it("offers CSV both, because a cell holds one value", () => {
    expect(availableFields("csv", "deck")).toEqual(
      expect.arrayContaining(["tag", "tagColor"]),
    );
  });

  it("offers neither to a surface with no labels", () => {
    for (const surface of ["collection", "wishlist"] as const) {
      const offered = availableFields("csv", surface);
      expect(offered, surface).not.toContain("tag");
      expect(offered, surface).not.toContain("tagColor");
    }
  });

  /** The collection's free-text `Tags` and the deck's `Tag` are two different facts. They can
   *  never be drawn together — no surface holds both — which is what makes the near-collision
   *  safe rather than merely survived. */
  it("never offers the collection's Tags beside the deck's Tag", () => {
    for (const surface of ["deck", "collection", "wishlist"] as const) {
      const offered = new Set(availableFields("csv", surface));
      expect(offered.has("tag") && offered.has("tags"), surface).toBe(false);
    }
  });

  it("ticks the label on Archidekt and leaves it for the reader on CSV", () => {
    // Archidekt's defaults are everything Archidekt can say, and the caret group is something
    // Archidekt itself emits.
    expect(defaultFields("archidekt", "deck")).toContain("tag");
    // CSV's are a deliberate core; everything else is opt-in, the colour included.
    expect(defaultFields("csv", "deck")).not.toContain("tag");
    expect(defaultFields("csv", "deck")).not.toContain("tagColor");
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
