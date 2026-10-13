import { describe, expect, it } from "vitest";
import {
  isUnreleased,
  localDay,
  releaseChipLabel,
  unreleasedLabel,
  unreleasedStamp,
} from "./unreleased";

describe("unreleased", () => {
  it("reads today in the reader's own zone, zero-padded", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  /** A card dated today is out — the rule `upcoming_sets` reads the corpus by. */
  it("is unreleased strictly after today, and never without a date", () => {
    expect(isUnreleased("2026-10-12", "2026-10-11")).toBe(true);
    expect(isUnreleased("2026-10-11", "2026-10-11")).toBe(false);
    expect(isUnreleased("1993-08-05", "2026-10-11")).toBe(false);
    expect(isUnreleased(null, "2026-10-11")).toBe(false);
  });

  it("stamps an unreleased printing with its upper-cased set and its date", () => {
    expect(unreleasedStamp("tla", "2026-11-14", "2026-10-11")).toEqual({
      set: "TLA",
      date: "2026-11-14",
    });
    expect(unreleasedStamp("lea", "1993-08-05", "2026-10-11")).toBeNull();
    expect(unreleasedStamp("lea", null, "2026-10-11")).toBeNull();
  });

  it("says the date in words", () => {
    expect(unreleasedLabel("2026-11-14")).toBe("Unreleased — out 2026-11-14");
  });

  it("says the chip's words", () => {
    expect(releaseChipLabel("2026-11-14")).toBe("Releases 2026-11-14");
  });
});
