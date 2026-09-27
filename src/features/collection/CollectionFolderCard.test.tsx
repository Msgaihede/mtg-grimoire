import { describe, expect, it } from "vitest";
import { folderFace } from "./CollectionFolderCard";

/**
 * `folderFace` — the one sentence about a collection folder's figures, in the two spellings the
 * home page's Folders widget draws (on screen and aloud). The card that used to draw it is gone;
 * the widget is its reader now.
 */
describe("folderFace", () => {
  it("draws an em dash, and says so in words, before the summary has answered", () => {
    expect(folderFace(null, "usd")).toEqual({ shown: "—", spoken: "still counting" });
  });

  it("shows an empty drawer's count and no money at all", () => {
    expect(folderFace({ cards: 0, value: null }, "usd")).toEqual({
      shown: "0 cards",
      spoken: "0 cards",
    });
  });

  it("joins the count and the value with the app's middot on screen and a comma aloud", () => {
    expect(folderFace({ cards: 1204, value: 1300 }, "usd")).toEqual({
      shown: "1,204 cards · $1,300.00",
      spoken: "1,204 cards, $1,300.00",
    });
    expect(folderFace({ cards: 1, value: 4 }, "usd").shown).toBe("1 card · $4.00");
  });

  it("says an unpriced drawer is not priced, rather than reading a dash aloud", () => {
    expect(folderFace({ cards: 3, value: null }, "usd")).toEqual({
      shown: "3 cards · —",
      spoken: "3 cards, not priced",
    });
  });

  it("leads with the lock in both spellings, the still-counting face included", () => {
    expect(folderFace(null, "usd", true)).toEqual({
      shown: "Locked · —",
      spoken: "locked, still counting",
    });
    expect(folderFace({ cards: 2, value: 10 }, "usd", true)).toEqual({
      shown: "Locked · 2 cards · $10.00",
      spoken: "locked, 2 cards, $10.00",
    });
  });
});
