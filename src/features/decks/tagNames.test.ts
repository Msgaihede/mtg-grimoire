import { describe, expect, it } from "vitest";
import { findTagByName, tagNameKey } from "./tagNames";

/**
 * **The same table `deck_meta::tests::deck_tag_create_compares_names_case_insensitively_and_
 * normalised` walks**, and that pairing is the whole reason this file is worth its size: the
 * authority is Rust's `schema::tag_name_key` and the UNIQUE index behind it, so what these cases
 * check is that the webview's courtesy answers the same way. A drift shows up as the dialogs
 * offering to create something the backend then refuses — annoying rather than dangerous, and
 * invisible without a test on each side.
 */
describe("tagNameKey", () => {
  it("folds case, using the full Unicode mapping rather than an ASCII one", () => {
    expect(tagNameKey("Removal")).toBe("removal");
    expect(tagNameKey("REMOVAL")).toBe(tagNameKey("removal"));
    // Beyond ASCII, which is the half `COLLATE NOCASE` could not have done in SQLite.
    expect(tagNameKey("RAMPÉ")).toBe(tagNameKey("rampé"));
  });

  it("trims, because a name is what was typed minus the whitespace nobody meant", () => {
    expect(tagNameKey("  Cut candidate  ")).toBe("cut candidate");
    expect(tagNameKey("   ")).toBe("");
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
    expect(tagNameKey(precomposed)).toBe(tagNameKey(combining));
    expect(tagNameKey("CAFÉ")).toBe(tagNameKey(combining));
  });

  /** The second NFC pass, which looks redundant and is not: lowercasing can un-normalise, so a
   *  key taken without it is one no re-normalised lookup ever matches again. */
  it("comes back composed even after the lowercase pass", () => {
    const key = tagNameKey("Café");
    expect(key).toBe(key.normalize("NFC"));
  });

  it("keeps two genuinely different names apart", () => {
    expect(tagNameKey("Removal")).not.toBe(tagNameKey("Removals"));
    expect(tagNameKey("Cut")).not.toBe(tagNameKey("Cut candidate"));
  });
});

describe("findTagByName", () => {
  const TAGS = [
    { id: 1, name: "Removal" },
    { id: 2, name: "Café" },
  ];

  it("finds a tag whatever capitals or accent form the reader typed", () => {
    expect(findTagByName(TAGS, "removal")?.id).toBe(1);
    expect(findTagByName(TAGS, "  REMOVAL ")?.id).toBe(1);
    expect(findTagByName(TAGS, "café")?.id).toBe(2);
  });

  /** A rename must not be refused by the row being renamed — which is what lets a reader
   *  recapitalise `removal` to `Removal` without being told the name is taken by itself. */
  it("does not count the row that is allowed to hold the name", () => {
    expect(findTagByName(TAGS, "REMOVAL", 1)).toBeUndefined();
    expect(findTagByName(TAGS, "REMOVAL", 2)?.id).toBe(1);
  });

  /** A half-typed field is not a duplicate. `valid_name` refuses a blank on the way in, so
   *  there is no row called nothing to find. */
  it("matches nothing for an empty name", () => {
    expect(findTagByName([...TAGS, { id: 3, name: " " }], "   ")).toBeUndefined();
  });
});
