import { describe, expect, it } from "vitest";
import { dragData, readDragData } from "@/features/decks/dnd";
import { searchCardDragData, type SearchCardDrag } from "@/features/search/searchCardDrag";
import { readWishDrag, readWishDrop, wishDragData } from "./wishDrag";

const WISH = { wishId: 7, name: "Lightning Bolt", folderId: null } as const;

/** A printing off the search column that is on nobody's list yet — the second thing a folder card
 *  can be handed since 2026-09-07. */
const CARD: SearchCardDrag = {
  cardId: "c1",
  name: "Lightning Bolt",
  finish: "nonfoil",
  oracleId: "o-bolt",
};

describe("wishDragData / readWishDrag", () => {
  it("round-trips a wish", () => {
    expect(readWishDrag(wishDragData(WISH))).toEqual(WISH);
  });

  it("refuses a payload that is not a wish", () => {
    // Built with `dnd.ts`'s own `dragData` rather than a hand-written mark string, so this test
    // stays true if that module's mark ever changes -- the task brief's placeholder string
    // ("mtg-grimoire/card-drag") does not match the real one ("mtg-grimoire/deck-drag" under
    // `dragSource`, dnd.ts:133-134), and a hand-copied literal would drift from it silently.
    const card = dragData({ kind: "card", cardId: "c1", name: "Bolt", typeLine: null });
    expect(readWishDrag(card)).toBeNull();
  });

  it("refuses a malformed wish id", () => {
    for (const wishId of [0, -1, 1.5, "7", undefined]) {
      expect(readWishDrag({ ...wishDragData(WISH), wishId })).toBeNull();
    }
  });

  /**
   * The whole reason this file uses its own key rather than `dnd.ts`'s value: a *pinned* wish
   * is both a card you can put in a deck and a wish you can file, and both readers have to say
   * yes to the same payload.
   */
  it("lets a pinned wish be read as a card and as a wish at once", () => {
    const both = { ...dragData({ kind: "card", cardId: "c1", name: "Bolt", typeLine: null }),
                   ...wishDragData(WISH) };
    expect(readDragData(both)).not.toBeNull();
    expect(readWishDrag(both)).toEqual(WISH);
  });

  /** And an any-printing wish is only the second -- there is no printing to carry. */
  it("reads an any-printing wish as a wish and not as a card", () => {
    const only = wishDragData(WISH);
    expect(readDragData(only)).toBeNull();
    expect(readWishDrag(only)).toEqual(WISH);
  });
});

describe("readWishDrop", () => {
  it("reads a wish as a wish and a search tile as a new card", () => {
    expect(readWishDrop(wishDragData(WISH))).toEqual({ kind: "wish", wish: WISH });
    expect(readWishDrop(searchCardDragData(CARD))).toEqual({ kind: "new", card: CARD });
  });

  /** A card payload carrying neither mark is not this feature's drag at all — which is what keeps
   *  a deck tile from raising every folder's ring. */
  it("refuses a record carrying neither mark", () => {
    expect(readWishDrop(dragData({ kind: "card", cardId: "c1", name: "Bolt", typeLine: null })))
      .toBeNull();
    expect(readWishDrop({})).toBeNull();
  });

  /** A malformed record of either shape is refused outright rather than falling through to the
   *  other reader and being reported as the thing it is not. */
  it("refuses a malformed record of either shape", () => {
    expect(readWishDrop({ ...wishDragData(WISH), wishId: 0 })).toBeNull();
    expect(readWishDrop({ ...searchCardDragData(CARD), finish: "shiny" })).toBeNull();
  });

  /**
   * The two keys are disjoint by construction, so a record with both can only be a bug upstream —
   * and the wish is the narrower fact to act on: it re-files a row that exists where the other
   * creates one.
   */
  it("takes the wish when a record somehow carries both", () => {
    const both = { ...searchCardDragData(CARD), ...wishDragData(WISH) };
    expect(readWishDrop(both)).toEqual({ kind: "wish", wish: WISH });
  });
});
