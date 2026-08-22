import { describe, expect, it } from "vitest";
import { dragData, readDragData } from "@/features/decks/dnd";
import { readWishDrag, wishDragData } from "./wishDrag";

const WISH = { wishId: 7, name: "Lightning Bolt", folderId: null } as const;

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
