import { describe, expect, it } from "vitest";
import { nextStackPosition, type StackPosition } from "./stackNav";

/**
 * The deck every case below is about, unless it says otherwise: three flowing piles of 3, 1 and
 * 2 cards, then the rail's Sideboard of 2.
 *
 * **The single-card pile in the middle is what makes the crossing testable at all** — its only
 * card is both the head and the foot of its pile, so a press from it has to leave in whichever
 * direction it was made, and a movement that still thought a pile boundary was a stop would sit
 * there. And the rail on the end is what proves the walk does not stop at the flow:
 * `StackView` concatenates the runs before it asks anything, so a rail pile is one more pile here
 * and carries no mark of its own.
 */
const SIZES = [3, 1, 2, 2];

/** Reads as the sentence the movement is: from here, this press, to there. */
const step = (at: StackPosition, key: string) => nextStackPosition(SIZES, at, key);

describe("nextStackPosition", () => {
  /** One card at a time, inside the pile the caret is in — the ordinary press, and the half of
   *  the walk that never leaves a pile. */
  it("steps along the cards of the pile the caret is in", () => {
    expect(step({ pile: 0, card: 0 }, "ArrowRight")).toEqual({ pile: 0, card: 1 });
    expect(step({ pile: 0, card: 1 }, "ArrowRight")).toEqual({ pile: 0, card: 2 });
    expect(step({ pile: 0, card: 2 }, "ArrowLeft")).toEqual({ pile: 0, card: 1 });
    expect(step({ pile: 0, card: 1 }, "ArrowLeft")).toEqual({ pile: 0, card: 0 });
  });

  /**
   * **A pile boundary is not a stop**, which is the whole of the change of 2026-08-21: the foot
   * of a pile leads to the head of the next one, so the two keys walk the entire deck rather than
   * clamping inside a column. The one-card pile is crossed in both directions from its only card,
   * which is the same rule seen from both sides at once.
   */
  it("crosses into the next pile rather than clamping at a pile's end", () => {
    expect(step({ pile: 0, card: 2 }, "ArrowRight")).toEqual({ pile: 1, card: 0 });
    expect(step({ pile: 1, card: 0 }, "ArrowRight")).toEqual({ pile: 2, card: 0 });
    expect(step({ pile: 2, card: 1 }, "ArrowRight")).toEqual({ pile: 3, card: 0 });
  });

  /**
   * **And it enters a pile at the near edge, which is what makes the walk reversible.** Left off
   * the head of a pile lands on the pile before it at its **last** card, not its first — so one
   * press and then the other puts the reader back where they were. Entering from the top both
   * ways would send them a pile further back every time they changed their mind.
   */
  it("steps back into the previous pile at its last card", () => {
    expect(step({ pile: 1, card: 0 }, "ArrowLeft")).toEqual({ pile: 0, card: 2 });
    expect(step({ pile: 2, card: 0 }, "ArrowLeft")).toEqual({ pile: 1, card: 0 });
    expect(step({ pile: 3, card: 0 }, "ArrowLeft")).toEqual({ pile: 2, card: 1 });
  });

  /** The reversibility stated as the property rather than as three pairs of coordinates: every
   *  stop of the walk, stepped forward and straight back, is the stop it started on. */
  it("undoes every forward step with a backward one", () => {
    for (let pile = 0; pile < SIZES.length; pile += 1) {
      for (let card = 0; card < SIZES[pile]; card += 1) {
        const forward = step({ pile, card }, "ArrowRight");
        if (forward === null) continue;
        expect(nextStackPosition(SIZES, forward, "ArrowLeft")).toEqual({ pile, card });
      }
    }
  });

  /** No wrapping, at either end: the first card of the deck has nothing before it and the last
   *  nothing after it. A walk that wrapped would take a reader arrowing steadily right back to
   *  the card they started on with nothing on screen saying they had been all the way round. */
  it("clamps at both ends of the walk rather than wrapping", () => {
    expect(step({ pile: 0, card: 0 }, "ArrowLeft")).toBeNull();
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

    expect(nextStackPosition(gappy, { pile: 0, card: 1 }, "ArrowRight")).toEqual({
      pile: 3,
      card: 0,
    });
    expect(nextStackPosition(gappy, { pile: 3, card: 0 }, "ArrowLeft")).toEqual({
      pile: 0,
      card: 1,
    });
  });

  /** Nothing but empty piles that way is the end of the walk, which is the clamp again — the
   *  skip must not run off the end looking for a card that is not there. */
  it("answers nothing when every pile that way is empty", () => {
    expect(nextStackPosition([1, 0, 0], { pile: 0, card: 0 }, "ArrowRight")).toBeNull();
    expect(nextStackPosition([0, 0, 1], { pile: 2, card: 0 }, "ArrowLeft")).toBeNull();
  });

  /**
   * **Up and down are not this movement's presses any more**, and `null` is how the caller is
   * told to leave the event alone — which is the point of them rather than a gap. This view has
   * no scrollport of its own, so what those two keys reach on a focused card is the page's
   * scrolling, and a reader pressing them on a wall of card art wants exactly that.
   */
  it("answers nothing for up and down", () => {
    for (const at of [
      { pile: 0, card: 0 },
      { pile: 0, card: 1 },
      { pile: 0, card: 2 },
      { pile: 1, card: 0 },
    ]) {
      expect(step(at, "ArrowUp")).toBeNull();
      expect(step(at, "ArrowDown")).toBeNull();
    }
  });

  /**
   * Anything else is not this movement's press either. The three below are the ones that would do
   * real damage if they were swallowed: Tab is the browser's own walk, Enter opens the card, and a
   * plain letter belongs to whatever is typing.
   */
  it("answers nothing for a key that is not one of the two arrows", () => {
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
