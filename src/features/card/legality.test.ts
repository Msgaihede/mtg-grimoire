import { describe, expect, it } from "vitest";
import { formatLabel, legalityRows, legalitySummary, statusClass, statusWord } from "./legality";

describe("legalityRows", () => {
  it("keeps every format, the ones the card is not legal in included", () => {
    // Catches: `legalityChips`' filter arriving here, which loses about half the grid.
    const rows = legalityRows('{"modern":"legal","standard":"not_legal"}');
    expect(rows).toEqual([
      { format: "standard", status: "not_legal" },
      { format: "modern", status: "legal" },
    ]);
  });

  it("draws a format it has never heard of last rather than dropping it", () => {
    const rows = legalityRows('{"explorer":"legal","vintage":"restricted","modern":"legal"}');
    expect(rows.map((r) => r.format)).toEqual(["modern", "vintage", "explorer"]);
  });

  it("answers no rows for no blob and for a blob that is not the shape it claims", () => {
    expect(legalityRows(null)).toEqual([]);
    expect(legalityRows("not json")).toEqual([]);
    expect(legalityRows('{"modern":3}')).toEqual([]);
  });
});

describe("the words", () => {
  it("names a multi-word format from its table and the rest by their first letter", () => {
    expect(formatLabel("paupercommander")).toBe("Pauper Commander");
    expect(formatLabel("explorer")).toBe("Explorer");
  });

  it("says an unknown status in Scryfall's own word, dimly", () => {
    expect(statusWord("not_legal")).toBe("Not legal");
    expect(statusWord("suspended")).toBe("suspended");
    expect(statusClass("suspended")).toBe("border-border/60 text-dim");
  });
});

describe("legalitySummary", () => {
  it("counts a restricted format as playable and the bans apart", () => {
    const rows = legalityRows(
      '{"standard":"not_legal","modern":"legal","vintage":"restricted","legacy":"banned"}',
    );
    expect(legalitySummary(rows)).toBe("Legal in 2 of 4 formats · banned in 1");
  });

  it("says nothing about bans a card has none of, and nothing at all for no rows", () => {
    expect(legalitySummary(legalityRows('{"modern":"legal"}'))).toBe("Legal in 1 of 1 format");
    expect(legalitySummary([])).toBeNull();
  });
});
