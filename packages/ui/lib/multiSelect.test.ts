import { describe, expect, it } from "vitest";
import {
  applySelect,
  dragsWholeSelection,
  EMPTY_SELECTION,
  PLAIN_PICK,
  pruneSelection,
  readModifiers,
  selectEverything,
  selectStacks,
  settleSelection,
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

/** Issue #938: the deck editor's Ctrl+A, over three stacks. */
describe("selectStacks — Ctrl+A on a desk of stacks", () => {
  const STACKS = [["a", "b"], ["c", "d"], ["e"]];

  it("picks every card of the stack a picked card is in", () => {
    expect(selectStacks(sel(["b"], "b"), STACKS)).toEqual(sel(["b", "a"], "b"));
  });

  it("widens each stack that has a pick and leaves the others alone", () => {
    expect(selectStacks(sel(["e", "a"], "a"), STACKS)).toEqual(sel(["e", "a", "b"], "a"));
  });

  // `Ctrl+A`, `Delete` must not be a deck emptied in two keys.
  it("picks nothing when nothing is picked", () => {
    expect(selectStacks(EMPTY_SELECTION, STACKS)).toBe(EMPTY_SELECTION);
  });

  it("never reaches a key no visible stack holds", () => {
    expect(selectStacks(sel(["z"], "z"), STACKS)).toEqual(sel(["z"], "z"));
  });

  it("answers with the same object when every picked stack is already whole", () => {
    const whole = sel(["c", "d"], "c");
    expect(selectStacks(whole, STACKS)).toBe(whole);
  });

  it("is never all of a list", () => {
    expect(selectStacks(sel(["a"], "a"), STACKS).allOf).toBeUndefined();
  });
});

describe("selectEverything — Ctrl+A", () => {
  it("picks every key on the surface, in screen order, and says which list they are all of", () => {
    expect(selectEverything(EMPTY_SELECTION, ORDER, "goblins")).toEqual({
      keys: ["a", "b", "c", "d", "e"],
      anchor: "a",
      allOf: "goblins",
    });
  });

  // Explorer's rule: a Shift-click after Ctrl+A measures from the card last pressed.
  it("leaves the anchor where the reader put it", () => {
    expect(selectEverything(sel(["c"], "c"), ORDER, "goblins").anchor).toBe("c");
  });

  it("anchors on the first key when the old anchor has left the surface", () => {
    expect(selectEverything(sel(["z"], "z"), ORDER, "goblins").anchor).toBe("a");
  });

  // An empty surface told to hold "all of this list" would pick whatever arrived on it later.
  it("does nothing at all on an empty surface", () => {
    const before = sel([], null);
    expect(selectEverything(before, [], "goblins")).toBe(before);
  });

  // A second press, and every render of a settled wall, writes nothing.
  it("answers with the same object for a set that is already all of the list", () => {
    const all = selectEverything(sel(["c"], "c"), ORDER, "goblins");
    expect(selectEverything(all, ORDER, "goblins")).toBe(all);
    expect(selectEverything(all, ORDER, "elves")).not.toBe(all);
  });

  it("is ended by any press, because a press builds a fresh set", () => {
    const all = selectEverything(EMPTY_SELECTION, ORDER, "goblins");
    expect(applySelect(all, "b", ORDER, TOGGLE)).toEqual(sel(["a", "c", "d", "e"], "b"));
    expect(applySelect(all, "b", ORDER, PLAIN_PICK)).toEqual(sel(["b"], "b"));
    expect(applySelect(all, "c", ORDER, RANGE)).toEqual(sel(["a", "b", "c"], "a"));
  });
});

describe("settleSelection", () => {
  const all = (keys: string[], anchor: string | null, allOf: string): Selection => ({
    keys,
    anchor,
    allOf,
  });

  it("prunes a set built by presses, exactly as pruneSelection does", () => {
    expect(settleSelection(sel(["a", "z", "c"], "a"), ORDER, "goblins")).toEqual(
      sel(["a", "c"], "a"),
    );
    const untouched = sel(["a", "b"], "a");
    expect(settleSelection(untouched, ORDER, "goblins")).toBe(untouched);
  });

  // The whole reason `allOf` exists: a wall pages, so the keys at the press are a scroll position.
  it("grows a set that is all of this list to a page that landed after the press", () => {
    const pressed = all(["a", "b", "c"], "a", "goblins");
    expect(settleSelection(pressed, ORDER, "goblins")).toEqual(
      all(["a", "b", "c", "d", "e"], "a", "goblins"),
    );
  });

  it("shrinks it to a list that lost a row, and moves an anchor that left with it", () => {
    const pressed = all(["a", "b", "c", "d", "e"], "a", "goblins");
    expect(settleSelection(pressed, ["b", "c", "d", "e"], "goblins")).toEqual(
      all(["b", "c", "d", "e"], "b", "goblins"),
    );
  });

  // Identity — the hook writes back whatever comes out as a new object, so this is a render loop
  // if it is ever new for a set that did not move.
  it("returns the same object when the set is already the whole of the list", () => {
    const whole = all([...ORDER], "c", "goblins");
    expect(settleSelection(whole, ORDER, "goblins")).toBe(whole);
  });

  // "All forty goblins" must not become "all three thousand cards" when the box is cleared.
  it("stops being all of anything once the list is a different list", () => {
    const pressed = all(["a", "b"], "a", "goblins");
    const settled = settleSelection(pressed, ORDER, "everything");
    expect(settled).toEqual(sel(["a", "b"], "a"));
    expect(settled.allOf).toBeUndefined();
  });

  it("prunes on the way out of a list, like any other set", () => {
    const pressed = all(["a", "b", "z"], "z", "goblins");
    expect(settleSelection(pressed, ORDER, "everything")).toEqual(sel(["a", "b"], null));
  });

  it("drops the instruction when the surface empties", () => {
    const settled = settleSelection(all(["a", "b"], "a", "goblins"), [], "goblins");
    expect(settled).toEqual(sel([], null));
    expect(settled.allOf).toBeUndefined();
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
