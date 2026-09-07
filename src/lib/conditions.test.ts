import { describe, expect, it } from "vitest";
import {
  CONDITIONS,
  CONDITION_LABEL,
  CONDITION_NOT_SET,
  MENU_CONDITION,
  normalizeCondition,
} from "./conditions";

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
      condition: "NONE",
      original: "Poor-ish",
      matched: false,
    });
    expect(normalizeCondition(null)).toEqual({ condition: "NONE", original: null, matched: true });
    expect(normalizeCondition("  near mint  ").original).toBe("near mint");
  });

  /**
   * Silence is not a grade, and since schema v35 it does not have to be read as one.
   *
   * All four spellings of nothing answer the same way — `null`, `undefined`, an empty string
   * and a cell of spaces — and `matched: true`, because a file that said nothing is a file this
   * app read correctly. Only `matched: false` draws the preview's warning row, so a blank
   * Condition column must never light one up on every line.
   */
  it("reads every spelling of silence as the not-set sentinel, with nothing to warn about", () => {
    for (const raw of [null, undefined, "", "   "] as const) {
      expect(normalizeCondition(raw), String(raw)).toEqual({
        condition: CONDITION_NOT_SET,
        original: null,
        matched: true,
      });
    }
  });

  /**
   * A file that spells the absence out loud lands where an empty cell lands.
   *
   * These three are in `SYNONYMS` rather than being read as unknown grades, and the difference
   * is the warning row: `Not set` is a word this app understands, so a re-import of its own
   * export must not flag every ungraded copy as a condition it could not read.
   */
  it("recognises the words for no grade at all", () => {
    for (const raw of ["None", "NONE", "unset", "Not set", "  not set  "]) {
      expect(normalizeCondition(raw), raw).toMatchObject({
        condition: CONDITION_NOT_SET,
        matched: true,
      });
    }
  });

  it("has six values, the absence first and the worst grade last", () => {
    expect(CONDITIONS).toEqual(["NONE", "NM", "LP", "MP", "HP", "DMG"]);
    // First because it is the default a picker opens on, not because it is the best of
    // anything — the scale itself is the five entries behind it, in order. The database sorts
    // the other way (`NM 0 … DMG 4, NONE 5`); that order is `COLLECTION_SORTS`' and is not
    // derived from this one.
    expect(CONDITIONS[0]).toBe(CONDITION_NOT_SET);
    expect(CONDITIONS.slice(1)).toEqual(["NM", "LP", "MP", "HP", "DMG"]);
  });

  /**
   * The one decision a menu used to make on the reader's behalf, and no longer does.
   *
   * Asserted as *the sentinel* rather than as `"NONE"`: this is the statement that a quick add
   * records no grade, and it would still be that statement if the sentinel were ever respelled.
   * Every value in the picker needs a label, so the census is asserted too — a sixth entry with
   * no `CONDITION_LABEL` row would draw a blank option rather than fail to compile.
   */
  it("records no grade for a menu add, and labels every value it can hold", () => {
    expect(MENU_CONDITION).toBe(CONDITION_NOT_SET);
    expect(CONDITION_LABEL[CONDITION_NOT_SET]).toBe("Not set");
    expect(Object.keys(CONDITION_LABEL)).toHaveLength(CONDITIONS.length);
    for (const c of CONDITIONS) expect(CONDITION_LABEL[c], c).toBeTruthy();
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
      expect(result.condition, raw).toBe("NONE");
      expect(CONDITIONS, raw).toContain(result.condition);
    }
  });
});
