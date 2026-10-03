import { describe, expect, it } from "vitest";
import type { DeckRow } from "@/lib/ipc";
import { coverUrl, hasCover } from "./deckCover";

/** The cover rules, out of `DeckTile` so the phone gallery draws them too. A crop is drawn only
 *  where the illustrator can be credited — Scryfall's rule for an `art` crop. */
describe("a deck's cover", () => {
  const deck = (coverCardId: string | null, coverArtist: string | null) =>
    ({ coverCardId, coverArtist }) as DeckRow;

  it("is the printing's art crop where there is an illustrator to credit", () => {
    expect(hasCover(deck("abc", "Simon Dominic"))).toBe(true);
    expect(coverUrl(deck("abc", "Simon Dominic"))).toMatch(/abc/);
  });

  it("is nothing for a printing with no illustrator, or no printing", () => {
    expect(hasCover(deck("abc", null))).toBe(false);
    expect(coverUrl(deck("abc", null))).toBeNull();
    expect(coverUrl(deck(null, null))).toBeNull();
  });
});
