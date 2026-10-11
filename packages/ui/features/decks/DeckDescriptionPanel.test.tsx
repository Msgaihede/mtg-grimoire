import { describe, expect, it } from "vitest";
import { shownDescription } from "./DeckDescriptionPanel";

/** Issue #912: the band is mounted only on a non-null answer, so this is the whole of whether a
 *  deck's description takes a column. */
describe("shownDescription", () => {
  it("trims a description and treats a blank one as none", () => {
    expect(shownDescription("  Bolt the face.\n")).toBe("Bolt the face.");
    expect(shownDescription("Line one\nLine two")).toBe("Line one\nLine two");
    expect(shownDescription("  \n ")).toBeNull();
    expect(shownDescription("")).toBeNull();
    expect(shownDescription(null)).toBeNull();
    expect(shownDescription(undefined)).toBeNull();
  });
});
