import { describe, expect, it } from "vitest";
import { count, plural } from "./counts";

describe("plural", () => {
  /** Moved here from `FolderTree.test.tsx` when the fourth definition of this was deleted. */
  it("is one derivation, so a count and the sentence quoting it cannot disagree", () => {
    expect(plural(1, "deck")).toBe("1 deck");
    expect(plural(0, "deck")).toBe("0 decks");
    expect(plural(2, "folder")).toBe("2 folders");
  });

  /** The case `ImportDeckDialog` carried a private `categoryCount` for: the default argument
   *  already answered it, and the workaround was the reason a fourth definition existed. */
  it("takes an irregular plural rather than deriving one", () => {
    expect(plural(1, "category", "categories")).toBe("1 category");
    expect(plural(6, "category", "categories")).toBe("6 categories");
    expect(plural(2, "copy", "copies")).toBe("2 copies");
  });

  /** Zero is plural in English, which is the arm a naive `n > 1` gets wrong. */
  it("makes zero plural", () => {
    expect(plural(0, "change", "changes")).toBe("0 changes");
  });
});

describe("count", () => {
  it("writes the separators the app's figures carry", () => {
    expect(count(0)).toBe("0");
    expect(count(999)).toBe("999");
    expect(count(1196)).toBe("1,196");
    expect(count(116703)).toBe("116,703");
  });

  /** Pinned to `en-US` rather than the host locale, so one screen cannot separate its figures
   *  differently from the next. */
  it("does not follow the machine's locale", () => {
    expect(count(1234567)).toBe("1,234,567");
  });
});
