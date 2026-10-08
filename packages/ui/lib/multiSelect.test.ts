import { describe, expect, it } from "vitest";
import {
  applySelect,
  dragsWholeSelection,
  EMPTY_SELECTION,
  PLAIN_PICK,
  pruneSelection,
  readModifiers,
  type Selection,
} from "./multiSelect";

const ORDER = ["a", "b", "c", "d", "e"];
const TOGGLE = { toggle: true, range: false };
const RANGE = { toggle: false, range: true };
const BOTH = { toggle: true, range: true };

/** The four fields every consumer reads, in one place, so a case reads as a sentence. */
function sel(keys: string[], anchor: string | null = null): Selection {
  return { keys, anchor };
}

describe("readModifiers", () => {
  it("reads Ctrl as toggle", () => {
    expect(readModifiers({ ctrlKey: true })).toEqual({ toggle: true, range: false });
  });

  // Windows-only app, jsdom-reachable chord — see the doc on `readModifiers`.
  it("reads Meta as toggle too", () => {
    expect(readModifiers({ metaKey: true })).toEqual({ toggle: true, range: false });
  });

  it("reads Shift as range", () => {
    expect(readModifiers({ shiftKey: true })).toEqual({ toggle: false, range: true });
  });

  it("reads both at once", () => {
    expect(readModifiers({ ctrlKey: true, shiftKey: true })).toEqual({ toggle: true, range: true });
  });

  it("reads a bare event as a plain pick", () => {
    expect(readModifiers({})).toEqual(PLAIN_PICK);
  });
});

describe("applySelect — a plain click", () => {
  it("picks one card and anchors on it", () => {
    expect(applySelect(EMPTY_SELECTION, "c", ORDER, PLAIN_PICK)).toEqual(sel(["c"], "c"));
  });

  it("collapses a set of four to the one that was pressed", () => {
    expect(applySelect(sel(["a", "b", "c", "d"], "a"), "e", ORDER, PLAIN_PICK)).toEqual(
      sel(["e"], "e"),
    );
  });

  it("collapses to a card that was already in the set", () => {
    expect(applySelect(sel(["a", "b", "c"], "a"), "b", ORDER, PLAIN_PICK)).toEqual(sel(["b"], "b"));
  });
});

describe("applySelect — Ctrl", () => {
  it("adds a card to the set", () => {
    expect(applySelect(sel(["a"], "a"), "c", ORDER, TOGGLE)).toEqual(sel(["a", "c"], "c"));
  });

  it("takes a card back out", () => {
    expect(applySelect(sel(["a", "b", "c"], "c"), "b", ORDER, TOGGLE)).toEqual(sel(["a", "c"], "b"));
  });

  // The anchor moves whichever way the toggle went — the press is a statement about where you are.
  it("moves the anchor even when it removed the card", () => {
    expect(applySelect(sel(["a", "b"], "a"), "b", ORDER, TOGGLE).anchor).toBe("b");
  });

  it("keeps the reader's pick order rather than screen order", () => {
    const picked = applySelect(applySelect(sel(["e"], "e"), "a", ORDER, TOGGLE), "c", ORDER, TOGGLE);
    expect(picked.keys).toEqual(["e", "a", "c"]);
  });

  it("picks the first card when nothing is selected", () => {
    expect(applySelect(EMPTY_SELECTION, "d", ORDER, TOGGLE)).toEqual(sel(["d"], "d"));
  });
});

describe("applySelect — Shift", () => {
  it("takes the run from the anchor down to here", () => {
    expect(applySelect(sel(["b"], "b"), "d", ORDER, RANGE)).toEqual(sel(["b", "c", "d"], "b"));
  });

  it("takes the run upward in screen order, not press order", () => {
    expect(applySelect(sel(["d"], "d"), "b", ORDER, RANGE)).toEqual(sel(["b", "c", "d"], "d"));
  });

  it("replaces what was there rather than adding to it", () => {
    expect(applySelect(sel(["a", "e"], "b"), "c", ORDER, RANGE)).toEqual(sel(["b", "c"], "b"));
  });

  // The whole point of holding the anchor still: a second press adjusts the same run.
  it("holds the anchor so a second press shrinks the same run", () => {
    const grown = applySelect(sel(["b"], "b"), "e", ORDER, RANGE);
    expect(grown.keys).toEqual(["b", "c", "d", "e"]);
    expect(applySelect(grown, "c", ORDER, RANGE)).toEqual(sel(["b", "c"], "b"));
  });

  it("is one card when the anchor and the press are the same", () => {
    expect(applySelect(sel(["c"], "c"), "c", ORDER, RANGE)).toEqual(sel(["c"], "c"));
  });

  it("picks one card when nothing was anchored", () => {
    expect(applySelect(EMPTY_SELECTION, "c", ORDER, RANGE)).toEqual(sel(["c"], "c"));
  });

  // The failure this prevents: `indexOf` answers -1 for a departed anchor, and a slice from -1
  // would run from the top of the wall.
  it("picks one card when the anchor has left the surface", () => {
    expect(applySelect(sel(["z"], "z"), "d", ORDER, RANGE)).toEqual(sel(["d"], "d"));
  });
});

describe("applySelect — Ctrl+Shift", () => {
  it("adds the run to what was already there", () => {
    expect(applySelect(sel(["a", "b"], "b"), "d", ORDER, BOTH)).toEqual(
      sel(["a", "b", "c", "d"], "b"),
    );
  });

  it("does not duplicate a card the run and the set share", () => {
    const out = applySelect(sel(["c", "e"], "c"), "a", ORDER, BOTH);
    expect(out.keys).toEqual(["c", "e", "a", "b"]);
    expect(new Set(out.keys).size).toBe(out.keys.length);
  });

  // Shift outranks Ctrl — Explorer's rule. If it did not, this would have removed "a".
  it("extends rather than toggling when both are held", () => {
    expect(applySelect(sel(["a"], "a"), "a", ORDER, BOTH).keys).toEqual(["a"]);
  });
});

describe("pruneSelection", () => {
  it("drops keys whose rows have left the surface", () => {
    expect(pruneSelection(sel(["a", "z", "c"], "a"), ORDER)).toEqual(sel(["a", "c"], "a"));
  });

  it("drops an anchor that has left", () => {
    expect(pruneSelection(sel(["a"], "z"), ORDER)).toEqual(sel(["a"], null));
  });

  it("empties a selection whose whole surface is gone", () => {
    expect(pruneSelection(sel(["a", "b"], "a"), [])).toEqual(sel([], null));
  });

  // Identity, so a wall that is not selecting anything pays nothing per render.
  it("returns the same object when nothing changed", () => {
    const before = sel(["a", "b"], "a");
    expect(pruneSelection(before, ORDER)).toBe(before);
  });
});

describe("dragsWholeSelection", () => {
  it("carries the set when the dragged card is in it", () => {
    expect(dragsWholeSelection(sel(["a", "b", "c"], "a"), "b")).toBe(true);
  });

  // The stray-drag rule: an unselected card moves alone even with four others highlighted.
  it("does not carry the set when the dragged card is outside it", () => {
    expect(dragsWholeSelection(sel(["a", "b", "c"], "a"), "e")).toBe(false);
  });

  it("is not a group when only one card is picked", () => {
    expect(dragsWholeSelection(sel(["a"], "a"), "a")).toBe(false);
  });

  it("is not a group when nothing is picked", () => {
    expect(dragsWholeSelection(EMPTY_SELECTION, "a")).toBe(false);
  });
});
