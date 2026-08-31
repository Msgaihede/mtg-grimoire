import { describe, expect, it } from "vitest";
import { CONDITIONS, normalizeCondition } from "./conditions";

describe("normalizeCondition", () => {
  it("maps every spelling in the research doc's synonym table", () => {
    const cases: [string, string][] = [
      ["Mint", "NM"],
      ["M", "NM"],
      ["MT", "NM"],
      ["Near Mint", "NM"],
      ["nm", "NM"],
      ["SP", "LP"],
      ["Excellent", "LP"],
      ["EX", "LP"],
      ["Good (Lightly Played)", "LP"],
      ["Moderately Played", "MP"],
      ["GD", "MP"],
      ["Played", "MP"],
      ["Heavily Played", "HP"],
      // Cardmarket's two worst grades, from the research doc's mapping row: `PL→HP,
      // PO→DMG`. `PO` is *not* Heavily Played — the EU scale has one more grade below
      // Played than the NA scale does, and Poor is the bottom of it.
      ["PL", "HP"],
      ["PO", "DMG"],
      ["Poor", "DMG"],
      ["Damaged", "DMG"],
      ["DM", "DMG"],
      ["D", "DMG"],
    ];
    for (const [raw, expected] of cases) {
      expect(normalizeCondition(raw), raw).toMatchObject({ condition: expected, matched: true });
    }
  });

  /**
   * The false friend, ruled on: a bare `LP` is the NA scale's Lightly Played, because the
   * NA scale is this app's own. Cardmarket's LP sits at NA Played, but *which scale a file
   * is on* is a property of the file — so that re-reading belongs to the importer, which
   * knows the source, and not to a function that only sees two letters.
   */
  it("reads a bare LP on the app's own scale", () => {
    expect(normalizeCondition("LP").condition).toBe("LP");
    expect(normalizeCondition("Lightly Played").condition).toBe("LP");
  });

  /** The original string is always kept: the normalisation is lossy and the user's file is
   *  the only place the difference still exists. */
  it("keeps what it was given, and says when it did not recognise it", () => {
    expect(normalizeCondition("Poor-ish")).toEqual({
      condition: "NM",
      original: "Poor-ish",
      matched: false,
    });
    expect(normalizeCondition(null)).toEqual({ condition: "NM", original: null, matched: true });
    expect(normalizeCondition("  near mint  ").original).toBe("near mint");
  });

  it("has five grades, worst last", () => {
    expect(CONDITIONS).toEqual(["NM", "LP", "MP", "HP", "DMG"]);
  });

  /**
   * A cell in someone's CSV is not a property name.
   *
   * This is the importer's seam (Plan 5), so the strings it sees come from a file rather
   * than from us — and read as an object key, `constructor` answers with the `Object`
   * function and `__proto__` with `Object.prototype`. Both then look *recognised*
   * (`matched: true`), which is the worse half: an unknown condition is supposed to become a
   * warning row in the import preview, and these two would sail past it carrying a function
   * where a grade belongs.
   *
   * Note which spellings are dangerous and which are not: the lookup lower-cases first, so
   * `toString` and `hasOwnProperty` arrive as `tostring` and `hasownproperty` and miss by
   * accident. Only the all-lowercase members of `Object.prototype` get through — which is
   * exactly why this is a lookup that must not consult a prototype at all, rather than a
   * list of names to exclude.
   */
  it("treats a JavaScript property name as the unknown condition it is", () => {
    for (const raw of ["constructor", "__proto__", "Constructor", "  __proto__  "]) {
      const result = normalizeCondition(raw);
      expect(result.matched, raw).toBe(false);
      expect(result.condition, raw).toBe("NM");
      expect(CONDITIONS, raw).toContain(result.condition);
    }
  });
});
