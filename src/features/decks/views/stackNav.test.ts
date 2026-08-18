import { describe, expect, it } from "vitest";
import { nextStackPosition, type StackPosition } from "./stackNav";

/**
 * The deck every case below is about, unless it says otherwise: three flowing piles of 3, 1 and
 * 2 cards, then the rail's Sideboard of 2.
 *
 * **The single-card pile in the middle is what makes the up/down clamp testable at all** — its
 * only card is both the top and the bottom of its pile, so a movement that leaked past either
 * end would land somewhere rather than answering `null`. And the rail on the end is what proves
 * the walk does not stop at the flow: `StackView` concatenates the two before it asks anything,
 * so a rail pile is one more pile here and carries no mark of its own.
 */
const SIZES = [3, 1, 2, 2];

/** Reads as the sentence the movement is: from here, this press, to there. */
const step = (at: StackPosition, key: string) => nextStackPosition(SIZES, at, key);

describe("nextStackPosition", () => {
  /** Down the pile, one card at a time — the movement inside a stack, which is the one axis a
   *  reader can point at without knowing how wide the window is. */
  it("steps down the cards of the pile the caret is in", () => {
    expect(step({ pile: 0, card: 0 }, "ArrowDown")).toEqual({ pile: 0, card: 1 });
    expect(step({ pile: 0, card: 1 }, "ArrowDown")).toEqual({ pile: 0, card: 2 });
  });

  it("steps back up the same pile", () => {
    expect(step({ pile: 0, card: 2 }, "ArrowUp")).toEqual({ pile: 0, card: 1 });
    expect(step({ pile: 0, card: 1 }, "ArrowUp")).toEqual({ pile: 0, card: 0 });
  });

  /**
   * **Both ends of a pile are a clamp and never a jump into the pile beside it.**
   *
   * The flow is a masonry: a pile that will not fit on a line starts at the foot of the pile
   * above it, so what is "above" the top card of a pile is whatever the window's width put
   * there — a different card at a different desk width, and nothing the reader can aim at. The
   * one-card pile answers `null` in both directions from its only card, which is the same rule
   * seen from both sides at once.
   */
  it("clamps at the top and the bottom of a pile rather than leaving it", () => {
    expect(step({ pile: 0, card: 0 }, "ArrowUp")).toBeNull();
    expect(step({ pile: 0, card: 2 }, "ArrowDown")).toBeNull();
    expect(step({ pile: 1, card: 0 }, "ArrowUp")).toBeNull();
    expect(step({ pile: 1, card: 0 }, "ArrowDown")).toBeNull();
  });

  /**
   * **Sideways is a pile at a time, and it lands on the top card.**
   *
   * The reader was offered "the same depth, clamped" and chose this: the top of a pile is a
   * place that always exists, so one press means one thing whatever the neighbour is holding.
   * Stepping right out of the *third* card of a pile and landing on card 0 is what says so.
   */
  it("steps to the next pile and lands on its top card", () => {
    expect(step({ pile: 0, card: 2 }, "ArrowRight")).toEqual({ pile: 1, card: 0 });
    expect(step({ pile: 1, card: 0 }, "ArrowRight")).toEqual({ pile: 2, card: 0 });
  });

  it("steps back to the previous pile, also at its top", () => {
    expect(step({ pile: 2, card: 1 }, "ArrowLeft")).toEqual({ pile: 1, card: 0 });
    expect(step({ pile: 1, card: 0 }, "ArrowLeft")).toEqual({ pile: 0, card: 0 });
  });

  /**
   * **The rail is reachable from the last pile of the flow**, and that is a claim about the
   * walk's shape rather than about this function: the caller hands over `flow` then `rail` as
   * one list, so the Sideboard is simply the pile after the last flowing one. Nothing here knows
   * which side of the desk a pile is drawn on, and nothing should — the rail is a *place*, and
   * a caret that could not reach it would make the piles played beside the deck keyboard-only
   * by accident.
   */
  it("reaches the rail from the last pile of the flow, and stops there", () => {
    expect(step({ pile: 2, card: 0 }, "ArrowRight")).toEqual({ pile: 3, card: 0 });
    expect(step({ pile: 3, card: 0 }, "ArrowRight")).toBeNull();
  });

  /** No wrapping, at either end: the first pile has nothing to its left and the last nothing to
   *  its right. A walk that wrapped would take a reader arrowing steadily right back to the card
   *  they started on with nothing on screen saying they had been all the way round. */
  it("clamps at both ends of the walk rather than wrapping", () => {
    expect(step({ pile: 0, card: 0 }, "ArrowLeft")).toBeNull();
    expect(step({ pile: 0, card: 2 }, "ArrowLeft")).toBeNull();
    expect(step({ pile: 3, card: 1 }, "ArrowRight")).toBeNull();
  });

  /**
   * **An empty pile is stepped over, in both directions.**
   *
   * `CardStack` draws nothing at all for a pile with no cards in it — the heading stands over
   * the words "Nothing here yet." — so landing on one would put the caret on a card that does
   * not exist. And empty piles are ordinary rather than exotic here: every pile the reader made
   * draws while it is empty, because it is where the next card of that kind goes.
   */
  it("skips a pile that holds no cards", () => {
    const gappy = [2, 0, 0, 1];

    expect(nextStackPosition(gappy, { pile: 0, card: 0 }, "ArrowRight")).toEqual({
      pile: 3,
      card: 0,
    });
    expect(nextStackPosition(gappy, { pile: 3, card: 0 }, "ArrowLeft")).toEqual({
      pile: 0,
      card: 0,
    });
  });

  /** Nothing but empty piles that way is the end of the walk, which is the clamp again — the
   *  skip must not run off the end looking for a card that is not there. */
  it("answers nothing when every pile that way is empty", () => {
    expect(nextStackPosition([1, 0, 0], { pile: 0, card: 0 }, "ArrowRight")).toBeNull();
    expect(nextStackPosition([0, 0, 1], { pile: 2, card: 0 }, "ArrowLeft")).toBeNull();
  });

  /**
   * Anything that is not one of the four arrows is not this movement's press, and `null` is how
   * the caller is told to leave the event alone. The three below are the ones that would do real
   * damage if they were swallowed: Tab is the browser's own walk, Enter opens the card, and a
   * plain letter belongs to whatever is typing.
   */
  it("answers nothing for a key that is not an arrow", () => {
    for (const key of ["Tab", "Enter", "a", "Home", "PageDown", " "]) {
      expect(step({ pile: 0, card: 0 }, key)).toBeNull();
    }
  });

  /** A deck with nothing in it at all. There is no card to be on, so there is no press that can
   *  move — including the sideways ones, which have no pile to find. */
  it("answers nothing for a deck of no piles", () => {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(nextStackPosition([], { pile: 0, card: 0 }, key)).toBeNull();
    }
  });

  /**
   * A position naming a card that is not there — a caret read out of the DOM a render after the
   * card left it, which the editor really can produce: a stepper reaching zero removes the row.
   * Every arrow answers `null`, so the press falls through rather than moving the caret somewhere
   * derived from an index nobody owns any more.
   */
  it("answers nothing from a position that names no card", () => {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(step({ pile: 9, card: 0 }, key)).toBeNull();
      expect(step({ pile: -1, card: 0 }, key)).toBeNull();
      expect(step({ pile: 0, card: 3 }, key)).toBeNull();
      expect(step({ pile: 0, card: -1 }, key)).toBeNull();
    }
  });
});
