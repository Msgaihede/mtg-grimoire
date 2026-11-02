import { describe, expect, it } from "vitest";
import {
  imageUpdatedDay,
  isUnreleased,
  localDay,
  unreleasedLabel,
  unreleasedLines,
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

  /** Issue #1214: the day the preview's picture last changed rides on the stamp when it is known. */
  it("carries the image's UTC day when the corpus has one", () => {
    expect(unreleasedStamp("tla", "2026-11-14", "2026-10-11", "2026-10-09T23:30:00Z")).toEqual({
      set: "TLA",
      date: "2026-11-14",
      imageUpdated: "2026-10-09",
    });
    // A printing that is out is not stamped at all, image date or no.
    expect(unreleasedStamp("lea", "1993-08-05", "2026-10-11", "2026-10-09T00:00:00Z")).toBeNull();
  });

  it("reads the image's day off the timestamp and nothing off a malformed one", () => {
    expect(imageUpdatedDay("2026-07-21T16:44:09Z")).toBe("2026-07-21");
    expect(imageUpdatedDay(null)).toBeNull();
    expect(imageUpdatedDay(undefined)).toBeNull();
    expect(imageUpdatedDay("")).toBeNull();
    expect(imageUpdatedDay("yesterday")).toBeNull();
  });

  it("says the date in words", () => {
    expect(unreleasedLabel("2026-11-14")).toBe("Unreleased — out 2026-11-14");
  });

  /** Issue #1458: the chin's mark is an icon, so its tooltip carries both dates. */
  it("says the release date, then the image's day when the stamp has one", () => {
    expect(unreleasedLines({ set: "TLA", date: "2026-11-14" })).toEqual([
      "Unreleased — out 2026-11-14",
    ]);
    expect(unreleasedLines({ set: "TLA", date: "2026-11-14", imageUpdated: "2026-10-09" })).toEqual(
      ["Unreleased — out 2026-11-14", "Image updated 2026-10-09"],
    );
  });
});
