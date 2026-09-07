import { describe, expect, it } from "vitest";
import {
  availableFields,
  defaultFields,
  SURFACE_FIELDS,
  SURFACE_HAS_PILES,
  TRANSFER_FIELD_IDS,
  TRANSFER_FIELDS,
} from "./fields";
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
 * Archidekt carries the colour **inside** `^Keeper,#4aab08^`, so it offers `label` and no colour
 * box — a checkbox that changed nothing would be worse than its absence. A CSV spends one column
 * per value, so it offers both.
 */
describe("the deck label's fields", () => {
  it("offers Archidekt the label and not a colour of its own", () => {
    const offered = availableFields("archidekt", "deck");
    expect(offered).toContain("label");
    expect(offered).not.toContain("labelColor");
  });

  it("offers CSV both, because a cell holds one value", () => {
    expect(availableFields("csv", "deck")).toEqual(
      expect.arrayContaining(["label", "labelColor"]),
    );
  });

  it("offers neither to a surface with no labels", () => {
    for (const surface of ["collection", "wishlist"] as const) {
      const offered = availableFields("csv", surface);
      expect(offered, surface).not.toContain("label");
      expect(offered, surface).not.toContain("labelColor");
    }
  });

  /** The collection's free-text `Tags` and the deck's `Label` are two different facts. They can
   *  never be drawn together — no surface holds both — which was already what made the old
   *  one-letter gap between `Tag` and `Tags` safe rather than merely survived, and is still what
   *  keeps the two apart now the words are further off. */
  it("never offers the collection's Tags beside the deck's Label", () => {
    for (const surface of ["deck", "collection", "wishlist"] as const) {
      const offered = new Set(availableFields("csv", surface));
      expect(offered.has("label") && offered.has("tags"), surface).toBe(false);
    }
  });

  it("ticks the label on Archidekt and leaves it for the reader on CSV", () => {
    // Archidekt's defaults are everything Archidekt can say, and the caret group is something
    // Archidekt itself emits.
    expect(defaultFields("archidekt", "deck")).toContain("label");
    // CSV's are a deliberate core; everything else is opt-in, the colour included.
    expect(defaultFields("csv", "deck")).not.toContain("label");
    expect(defaultFields("csv", "deck")).not.toContain("labelColor");
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

/**
 * Whether a surface files its cards into piles at all — the third declaration in this file, and
 * the one that is **not** derivable from the two above it.
 *
 * The tempting spelling is `SURFACE_FIELDS[surface].includes("category")`, and it answers
 * correctly today for all three surfaces, which is exactly what makes it worth a test rather
 * than a refactor. `category` is a *field*: a column a reader can switch on, and a statement
 * about what a line can say. `SURFACE_HAS_PILES` is a statement about the **data** — whether
 * `TransferCard.categoryActive` is ever anything but `null` on a row from this surface. A
 * surface that filed cards into piles and offered no category column would satisfy one and not
 * the other, and the derived spelling would then quietly answer the wrong question: the export
 * dialog would stop drawing `Include inactive categories` on a surface that has inactive
 * categories. The two agreeing today is a coincidence of three surfaces, not an invariant.
 *
 * The reverse holds too and is the reading that matters for the dialog: on the collection and
 * the wishlist every row carries `categoryActive: null`, so the box would be a control over
 * nothing — furniture, which `src/CLAUDE.md` forbids — and `isActivePile` would answer `true`
 * for every row it was handed whichever way the box was set.
 */
describe("SURFACE_HAS_PILES", () => {
  /**
   * The type already makes this map total — `Record<TransferSurface, boolean>` is a compile
   * error one key short — so what this pins is the *census* rather than the totality: a fourth
   * surface added to the union arrives here as a red test rather than as a `false` somebody
   * typed to make `tsc` stop complaining. It is `decklists.test.ts`'s `READABLE` pin in a
   * different file, and for the same reason — the failure it guards against is an omission,
   * which no compiler and no count can see.
   *
   * Compared against `SURFACE_FIELDS` as well as against the three names, because the two are
   * the pair a new surface has to answer *both* of.
   */
  it("answers for every surface SURFACE_FIELDS knows, and for no other", () => {
    expect(Object.keys(SURFACE_HAS_PILES).sort()).toEqual(["collection", "deck", "wishlist"]);
    expect(Object.keys(SURFACE_HAS_PILES).sort()).toEqual(Object.keys(SURFACE_FIELDS).sort());
  });

  /** Only the deck. Written as the whole record rather than three lookups so that a surface
   *  gaining piles cannot be half-declared — the answer is one object and it is read as one. */
  it("gives the piles to the deck and to nothing else", () => {
    expect(SURFACE_HAS_PILES).toEqual({ deck: true, collection: false, wishlist: false });
  });

  /** The coincidence stated as a measurement rather than left implied: today the derived
   *  spelling agrees on all three, which is why the doc comment above has to say why it is
   *  still the wrong question. If this ever goes red the *declaration* is what to argue with —
   *  a surface with piles and no category column is legal, and this test is then the thing to
   *  delete rather than the thing to fix. */
  it("agrees with the category field today, which is the coincidence it exists to outlive", () => {
    for (const surface of ["deck", "collection", "wishlist"] as const) {
      expect(SURFACE_HAS_PILES[surface], surface).toBe(
        SURFACE_FIELDS[surface].includes("category"),
      );
    }
  });
});

describe("TRANSFER_FIELDS", () => {
  it("names every id exactly once, with a unique CSV header", () => {
    const headers = TRANSFER_FIELD_IDS.map((id) => TRANSFER_FIELDS[id].csvHeader.toLowerCase());
    expect(new Set(headers).size).toBe(TRANSFER_FIELD_IDS.length);
  });
});
