import { describe, expect, it } from "vitest";
import { deckDetailKey, deckDetailQuery } from "./deckQuery";

/** The one spelling of a deck's read key — the editor's `useDeck` and the phone's deck page both
 *  ask through it, which is what lets a resize across 1024px paint a deck from the cache. */
describe("deckDetailQuery", () => {
  it("keys a deck under the decks root, by id, list and marketplace", () => {
    expect(deckDetailKey(4, "theory", "tcgplayer")).toEqual([
      "decks",
      "detail",
      4,
      "theory",
      "tcgplayer",
    ]);
    expect(deckDetailQuery(4, "live", "cardmarket").queryKey).toEqual(
      deckDetailKey(4, "live", "cardmarket"),
    );
  });

  it("asks nothing for no deck", () => {
    expect(deckDetailQuery(null, "live", "tcgplayer").enabled).toBe(false);
    expect(deckDetailQuery(7, "live", "tcgplayer").enabled).toBe(true);
  });
});
