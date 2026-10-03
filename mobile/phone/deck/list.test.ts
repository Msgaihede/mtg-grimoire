import { describe, expect, it } from "vitest";
import { shownList } from "./list";

/** The one rule the deck page and the card sheet over it both read for which list is on screen. */
describe("shownList", () => {
  const plan = { theoryEnabled: true, lastVariant: "theory" as const };

  it("opens a deck that keeps a plan on the list it remembers", () => {
    expect(shownList(plan, null)).toBe("theory");
    expect(shownList({ ...plan, lastVariant: "live" }, null)).toBe("live");
  });

  it("follows the reader's press over the memory", () => {
    expect(shownList(plan, "live")).toBe("live");
  });

  it("reads Actual on a deck that keeps no plan, whatever was pressed", () => {
    expect(shownList({ theoryEnabled: false, lastVariant: "theory" }, "theory")).toBe("live");
  });

  it("answers the press before the deck has, and nothing with neither", () => {
    expect(shownList(null, "theory")).toBe("theory");
    expect(shownList(null, null)).toBeNull();
  });
});
