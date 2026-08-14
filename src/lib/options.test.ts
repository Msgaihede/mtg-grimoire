import { describe, expect, it } from "vitest";
import { compareLabels, sortOptions } from "./options";

/** The shape every caller passes: a display label and whatever else the control needs. */
const opts = (...labels: string[]) => labels.map((label) => ({ label }));
const labels = (rows: { label: string }[]) => rows.map((r) => r.label);

describe("compareLabels", () => {
  /**
   * A bare `localeCompare` with no locale is what this replaces, and the failure it had is
   * not hypothetical: it sorts by code unit, so every capital letter sorts before every
   * lower-case one and "The List" lands above "the list" in a list of set names that mixes
   * both. Case is not information here — the words are.
   */
  it("ignores case", () => {
    expect(compareLabels("modern", "Modern")).toBe(0);
    expect(compareLabels("apple", "Banana")).toBeLessThan(0);
    expect(compareLabels("Banana", "apple")).toBeGreaterThan(0);
  });

  /**
   * Set names are full of years and edition numbers, and a code-unit comparison reads them a
   * character at a time — which puts "Arena League 2001" between "Arena League 1999" and
   * "Arena League 200" and is wrong in the one place the reader is most likely to be scanning
   * a column of near-identical names.
   */
  it("reads numbers as numbers", () => {
    expect(compareLabels("Set 2", "Set 10")).toBeLessThan(0);
    expect(compareLabels("Arena League 1999", "Arena League 2001")).toBeLessThan(0);
  });

  /** `sensitivity: "base"` — an accent is a spelling, not a sort key. */
  it("ignores accents", () => {
    expect(compareLabels("Sejour", "Séjour")).toBe(0);
    expect(compareLabels("Éclat", "Fable")).toBeLessThan(0);
  });

  /**
   * Pinned to `"en"` rather than to the host locale. The assertion that catches a drift back
   * to the machine's own is a pair whose order differs between locales: in Swedish collation
   * "ä" sorts after "z", in English it sorts with "a".
   */
  it("collates in English wherever it runs", () => {
    expect(compareLabels("äpple", "zebra")).toBeLessThan(0);
  });
});

describe("sortOptions", () => {
  it("orders by the display label with no groups", () => {
    expect(labels(sortOptions(opts("Vintage", "Commander", "modern"), (o) => o.label))).toEqual([
      "Commander",
      "modern",
      "Vintage",
    ]);
  });

  /**
   * The headline rule, in one assertion: a greyed option is still offered — dropping it would
   * make the list jump under the cursor on every keystroke — but it is offered *below*
   * everything the reader can actually pick, and both halves read alphabetically.
   */
  it("settles every group before it consults the alphabet", () => {
    const rows = [
      { label: "Zendikar", dead: false },
      { label: "Alpha", dead: true },
      { label: "Mirrodin", dead: false },
      { label: "Beta", dead: true },
    ];

    expect(labels(sortOptions(rows, (o) => o.label, (o) => [o.dead ? 1 : 0]))).toEqual([
      "Mirrodin",
      "Zendikar",
      "Alpha",
      "Beta",
    ]);
  });

  /**
   * Levels are settled left to right, which is what lets the set picker say "picked, then
   * available, then how well the typed code matches, then the alphabet" as one call rather
   * than as a comparator nobody can read.
   */
  it("settles levels left to right", () => {
    const rows = [
      { label: "Beta", picked: false, rank: 0 },
      { label: "Alpha", picked: false, rank: 1 },
      { label: "Zed", picked: true, rank: 1 },
    ];

    expect(
      labels(sortOptions(rows, (o) => o.label, (o) => [o.picked ? 0 : 1, o.rank])),
    ).toEqual(["Zed", "Beta", "Alpha"]);
  });

  /** A caller may return fewer levels for some rows than others; the short one reads as
   *  zeroes rather than sorting last by accident. */
  it("treats a missing level as zero", () => {
    const rows = [
      { label: "Beta", keys: [] as number[] },
      { label: "Alpha", keys: [1] },
      { label: "Gamma", keys: [0, 0] },
    ];

    expect(labels(sortOptions(rows, (o) => o.label, (o) => o.keys))).toEqual([
      "Beta",
      "Gamma",
      "Alpha",
    ]);
  });

  /**
   * **The arrays reaching here are React Query's own.** `ipc.listSets()` and
   * `ipc.formatSpecs()` are cached for the session and shared by every reader of the key, so
   * a sort in place would reorder the cache under components that never asked for it — and
   * the set picker sorts on every keystroke.
   */
  it("does not touch the array it was given", () => {
    const rows = opts("Vintage", "Commander");

    const sorted = sortOptions(rows, (o) => o.label);

    expect(labels(rows)).toEqual(["Vintage", "Commander"]);
    expect(sorted).not.toBe(rows);
  });

  it("keeps the input order of two rows the collator cannot separate", () => {
    const rows = [
      { label: "Modern", id: 1 },
      { label: "modern", id: 2 },
    ];

    expect(sortOptions(rows, (o) => o.label).map((o) => o.id)).toEqual([1, 2]);
  });
});
