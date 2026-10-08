import { describe, expect, it } from "vitest";
import type { CardWalkStop, PaneDeckContext } from "@/lib/store";
import { departureFrom, isSameStop, stopAfterRemoval } from "./cardReturn";

/** A deck row's six-field address — five parts of the grain plus the pile's name. */
function slot(patch: Partial<PaneDeckContext> = {}): PaneDeckContext {
  return {
    deckId: 1,
    categoryId: 2,
    categoryName: "Burn spells",
    cardId: "c1",
    variant: "live",
    finish: null,
    ...patch,
  };
}

/** A stop on a wall's walk — a printing and nothing to write to. */
function plain(cardId: string): CardWalkStop {
  return { cardId, oracleId: `o-${cardId}`, name: cardId, deck: null };
}

/** A stop on a deck's walk, whose `deck.cardId` is the same id by construction. */
function row(patch: Partial<PaneDeckContext> = {}): CardWalkStop {
  const deck = slot(patch);
  return { cardId: deck.cardId, oracleId: `o-${deck.cardId}`, name: deck.cardId, deck };
}

describe("where the modal lands when the row behind the open card is removed", () => {
  const walk = [plain("c0"), plain("c1"), plain("c2")];

  // The whole feature: a cut is something a reader does *while going through a deck*, and the key
  // they press next is the arrow.
  it("steps forwards, because that is the direction the reader was already going", () => {
    expect(stopAfterRemoval(walk, 1)).toBe(walk[2]);
  });

  // The last stop has no next, and at that end "carry on" can only mean the card before it.
  // Falling back the other way round — previous before next — would re-show a card the reader
  // had just decided to keep, on every cut in the middle of a deck.
  it("falls back to the previous stop at the end of the walk", () => {
    expect(stopAfterRemoval(walk, 2)).toBe(walk[1]);
  });

  // A one-card deck. There is nowhere to go, and saying so is what lets the caller keep the card
  // on screen rather than inventing a stop.
  it("answers nothing when the walk holds no other stop", () => {
    expect(stopAfterRemoval([plain("c1")], 0)).toBeNull();
  });

  // A card reached by a meld relation or a printing swap is on no list, so a removal of it moves
  // nobody — the same *nothing to step to* the walk's two ends give.
  it("answers nothing for a card that is on no walk", () => {
    expect(stopAfterRemoval(walk, -1)).toBeNull();
    expect(stopAfterRemoval([], -1)).toBeNull();
  });

  // The plan is made at the press and spent a round trip later, so it has to carry the stop being
  // left as well as the one being stepped to: by the time it is spent, the walk no longer holds
  // the first and nothing could reconstruct it.
  it("carries the stop being left as well as the one being stepped to", () => {
    expect(departureFrom(walk, 1)).toEqual({ leaving: walk[1], to: walk[2] });
  });

  it("plans nothing for a card that is on no walk", () => {
    expect(departureFrom(walk, -1)).toBeNull();
  });

  // A departure with nowhere to go is still a departure: the caller leaves the card on screen and
  // remembers it, which is what hands the stepper back when Ctrl+Z puts the row into the deck.
  it("plans a departure with no destination rather than no departure", () => {
    const only = plain("c1");
    expect(departureFrom([only], 0)).toEqual({ leaving: only, to: null });
  });
});

describe("recognising a remembered stop when it comes back on the walk", () => {
  // A deck can hold one printing in two piles and in two finishes. Those are different rows and a
  // removal removes one of them, so a match on `cardId` alone would call a cut Burn-spells Bolt
  // "back" the moment the reader's Sideboard copy was drawn — and walk them onto the wrong row.
  it("tells two rows of one printing apart by the whole grain", () => {
    const burn = row({ categoryId: 2, categoryName: "Burn spells" });
    const side = row({ categoryId: 9, categoryName: "Sideboard" });
    expect(isSameStop(burn, burn)).toBe(true);
    expect(isSameStop(side, burn)).toBe(false);
  });

  it("tells one row's two finishes apart", () => {
    expect(isSameStop(row({ finish: "foil" }), row({ finish: null }))).toBe(false);
  });

  // `categoryName` is `categoryId` spelled out for a surface with no category list to translate an
  // id with, so it is derived from a field this already compares. Matching on it would make a pile
  // renamed while the card was gone read as a different row.
  it("ignores the pile's name, which is not part of the address", () => {
    expect(isSameStop(row({ categoryName: "Removal" }), row({ categoryName: "Burn spells" }))).toBe(
      true,
    );
  });

  // The two kinds of list are both watched by one hook, and a deck row is not the collection entry
  // for the same printing — neither one coming back says anything about the other.
  it("never matches a deck row against a plain printing", () => {
    expect(isSameStop(row(), plain("c1"))).toBe(false);
    expect(isSameStop(plain("c1"), row())).toBe(false);
  });

  it("matches a plain stop by its printing", () => {
    expect(isSameStop(plain("c1"), plain("c1"))).toBe(true);
    expect(isSameStop(plain("c2"), plain("c1"))).toBe(false);
  });

  // Both are facts *about* the card rather than parts of its address, and `name` is denormalized
  // at write time — a match on it would break when a corpus refresh corrected a spelling.
  it("ignores the card's name and oracle id", () => {
    const remembered = plain("c1");
    const redrawn = { ...remembered, name: "Lightning Bolt", oracleId: "corrected" };
    expect(isSameStop(redrawn, remembered)).toBe(true);
  });
});
