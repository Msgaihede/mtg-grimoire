import { describe, expect, it } from "vitest";
import { findLabelByName, labelNameKey } from "./labelNames";

/**
 * **The same table `deck_meta::tests::deck_label_create_compares_names_case_insensitively_and_
 * normalised` walks**, and that pairing is the whole reason this file is worth its size: the
 * authority is Rust's `schema::label_name_key` and the UNIQUE index behind it, so what these cases
 * check is that the webview's courtesy answers the same way. A drift shows up as the dialogs
 * offering to create something the backend then refuses — annoying rather than dangerous, and
 * invisible without a test on each side.
 */
describe("labelNameKey", () => {
  it("folds case, using the full Unicode mapping rather than an ASCII one", () => {
    expect(labelNameKey("Removal")).toBe("removal");
    expect(labelNameKey("REMOVAL")).toBe(labelNameKey("removal"));
    // Beyond ASCII, which is the half `COLLATE NOCASE` could not have done in SQLite.
    expect(labelNameKey("RAMPÉ")).toBe(labelNameKey("rampé"));
  });

  it("trims, because a name is what was typed minus the whitespace nobody meant", () => {
    expect(labelNameKey("  Cut candidate  ")).toBe("cut candidate");
    expect(labelNameKey("   ")).toBe("");
  });

  /**
   * The Unicode half. `Café` is typeable two ways — a precomposed `é`, or `e` followed by
   * U+0301 — and which one arrives depends on the reader's keyboard and operating system rather
   * than on what they meant. Two rows spelling one word is exactly what the app-wide grain
   * exists to prevent.
   */
  it("normalises a combining accent onto the letter before it", () => {
    const precomposed = "Café";
    const combining = "Café";
    expect(precomposed).not.toBe(combining);
    expect(labelNameKey(precomposed)).toBe(labelNameKey(combining));
    expect(labelNameKey("CAFÉ")).toBe(labelNameKey(combining));
  });

  /** The second NFC pass, which looks redundant and is not: lowercasing can un-normalise, so a
   *  key taken without it is one no re-normalised lookup ever matches again. */
  it("comes back composed even after the lowercase pass", () => {
    const key = labelNameKey("Café");
    expect(key).toBe(key.normalize("NFC"));
  });

  it("keeps two genuinely different names apart", () => {
    expect(labelNameKey("Removal")).not.toBe(labelNameKey("Removals"));
    expect(labelNameKey("Cut")).not.toBe(labelNameKey("Cut candidate"));
  });
});

describe("findLabelByName", () => {
  const LABELS = [
    { id: 1, name: "Removal" },
    { id: 2, name: "Café" },
  ];

  it("finds a label whatever capitals or accent form the reader typed", () => {
    expect(findLabelByName(LABELS, "removal")?.id).toBe(1);
    expect(findLabelByName(LABELS, "  REMOVAL ")?.id).toBe(1);
    expect(findLabelByName(LABELS, "café")?.id).toBe(2);
  });

  /** A rename must not be refused by the row being renamed — which is what lets a reader
   *  recapitalise `removal` to `Removal` without being told the name is taken by itself. */
  it("does not count the row that is allowed to hold the name", () => {
    expect(findLabelByName(LABELS, "REMOVAL", 1)).toBeUndefined();
    expect(findLabelByName(LABELS, "REMOVAL", 2)?.id).toBe(1);
  });

  /** A half-typed field is not a duplicate. `valid_name` refuses a blank on the way in, so
   *  there is no row called nothing to find. */
  it("matches nothing for an empty name", () => {
    expect(findLabelByName([...LABELS, { id: 3, name: " " }], "   ")).toBeUndefined();
  });
});
