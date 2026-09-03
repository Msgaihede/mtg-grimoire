import { describe, expect, it } from "vitest";
import {
  activeScopes,
  chordParts,
  matchesChord,
  matchesShortcut,
  SHORTCUTS,
  shortcut,
  type Shortcut,
} from "./shortcuts";

/**
 * A press, spelled the way a reader makes it rather than the way the DOM records it.
 *
 * Every chord in a test below is written out **literally** — `Ctrl+Alt+Z` as `press("z", { ctrl:
 * true, alt: true })`, never derived from the chord under test. A test that builds its event out
 * of the object it is checking agrees with that object by construction and would stay green
 * through any change to it.
 */
function press(
  key: string,
  mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: mods.ctrl === true,
    metaKey: mods.meta === true,
    shiftKey: mods.shift === true,
    altKey: mods.alt === true,
  });
}

describe("matchesChord — the modifiers a chord names", () => {
  it("matches the chord it was written for", () => {
    expect(matchesChord({ key: "z", ctrl: true }, press("z", { ctrl: true }))).toBe(true);
  });

  it("does not match without the modifier it names", () => {
    expect(matchesChord({ key: "z", ctrl: true }, press("z"))).toBe(false);
  });

  it("matches a chord that names two modifiers", () => {
    expect(
      matchesChord({ key: "z", ctrl: true, shift: true }, press("z", { ctrl: true, shift: true })),
    ).toBe(true);
  });

  it("does not match when a named modifier is missing", () => {
    expect(matchesChord({ key: "z", ctrl: true, shift: true }, press("z", { ctrl: true }))).toBe(
      false,
    );
  });

  it("matches a chord that names no modifier at all", () => {
    expect(matchesChord({ key: "Delete" }, press("Delete"))).toBe(true);
  });
});

describe("matchesChord — the modifiers a chord does not name", () => {
  // The pair that makes the whole module worth having: without exactness, one press fires undo
  // *and* redo.
  it("Ctrl+Alt+Z is not Ctrl+Z", () => {
    expect(matchesChord({ key: "z", ctrl: true }, press("z", { ctrl: true, alt: true }))).toBe(
      false,
    );
  });

  it("Ctrl+Shift+Z is not Ctrl+Z", () => {
    expect(matchesChord({ key: "z", ctrl: true }, press("z", { ctrl: true, shift: true }))).toBe(
      false,
    );
  });

  it("Ctrl+Shift+Alt+Z is not Ctrl+Shift+Z", () => {
    expect(
      matchesChord(
        { key: "z", ctrl: true, shift: true },
        press("z", { ctrl: true, shift: true, alt: true }),
      ),
    ).toBe(false);
  });

  it("Ctrl+Delete is not Delete", () => {
    expect(matchesChord({ key: "Delete" }, press("Delete", { ctrl: true }))).toBe(false);
  });

  it("Shift+Delete is not Delete", () => {
    expect(matchesChord({ key: "Delete" }, press("Delete", { shift: true }))).toBe(false);
  });

  it("Alt+Delete is not Delete", () => {
    expect(matchesChord({ key: "Delete" }, press("Delete", { alt: true }))).toBe(false);
  });

  it("plain F10 is not Shift+F10", () => {
    expect(matchesChord({ key: "F10", shift: true }, press("F10"))).toBe(false);
  });

  it("Shift+F10 is Shift+F10", () => {
    expect(matchesChord({ key: "F10", shift: true }, press("F10", { shift: true }))).toBe(true);
  });
});

describe("matchesChord — Meta counts as Ctrl", () => {
  // `multiSelect.ts:61`'s rule, not a second one: jsdom's `{Meta>}` is as reachable as
  // `{Control>}`, so refusing it would be a rule with nothing behind it.
  it("Meta+Z is Ctrl+Z", () => {
    expect(matchesChord({ key: "z", ctrl: true }, press("z", { meta: true }))).toBe(true);
  });

  it("Meta+Shift+Z is Ctrl+Shift+Z", () => {
    expect(
      matchesChord({ key: "z", ctrl: true, shift: true }, press("z", { meta: true, shift: true })),
    ).toBe(true);
  });

  it("Meta is still a modifier the chord has to name", () => {
    expect(matchesChord({ key: "Delete" }, press("Delete", { meta: true }))).toBe(false);
  });

  it("Meta+Alt+Z is not Ctrl+Z", () => {
    expect(matchesChord({ key: "z", ctrl: true }, press("z", { meta: true, alt: true }))).toBe(
      false,
    );
  });
});

describe("matchesChord — the key itself", () => {
  // `e.key` is "Z" while Shift is held, so a case-sensitive test kills every shifted letter.
  it("folds case on a single character", () => {
    expect(
      matchesChord({ key: "z", ctrl: true, shift: true }, press("Z", { ctrl: true, shift: true })),
    ).toBe(true);
  });

  it("folds case the other way round too", () => {
    expect(matchesChord({ key: "Z", ctrl: true }, press("z", { ctrl: true }))).toBe(true);
  });

  it("does not fold a named key", () => {
    expect(matchesChord({ key: "Delete" }, press("delete"))).toBe(false);
  });

  it("does not match a different key", () => {
    expect(matchesChord({ key: "z", ctrl: true }, press("y", { ctrl: true }))).toBe(false);
  });
});

describe("matchesChord — a pointer chord never matches", () => {
  it("refuses Ctrl+wheel against a keypress holding Ctrl", () => {
    expect(matchesChord({ pointer: "wheel", ctrl: true }, press("z", { ctrl: true }))).toBe(false);
  });

  it("refuses Ctrl+click against a bare press", () => {
    expect(matchesChord({ pointer: "click", ctrl: true }, press("Control", { ctrl: true }))).toBe(
      false,
    );
  });

  it("refuses Shift+click against Shift+F10", () => {
    expect(matchesChord({ pointer: "click", shift: true }, press("F10", { shift: true }))).toBe(
      false,
    );
  });
});

describe("matchesShortcut", () => {
  const twoSpellings: Shortcut = {
    id: "redoLike",
    label: "Redo the change you undid",
    chords: [
      { key: "y", ctrl: true },
      { key: "z", ctrl: true, shift: true },
    ],
  };

  it("matches the first spelling", () => {
    expect(matchesShortcut(twoSpellings, press("y", { ctrl: true }))).toBe(true);
  });

  it("matches the second spelling", () => {
    expect(matchesShortcut(twoSpellings, press("z", { ctrl: true, shift: true }))).toBe(true);
  });

  it("matches neither on a press that is neither", () => {
    expect(matchesShortcut(twoSpellings, press("z", { ctrl: true }))).toBe(false);
  });

  it("answers false for a shortcut whose chords are all pointer gestures", () => {
    const pointerOnly: Shortcut = {
      id: "selectLike",
      label: "Pick more than one card",
      chords: [
        { pointer: "click", ctrl: true },
        { pointer: "click", shift: true },
      ],
    };
    expect(matchesShortcut(pointerOnly, press("a", { ctrl: true }))).toBe(false);
  });
});

describe("the catalogue's own entries answer the presses they document", () => {
  // The fence the module exists for: these are the real rows the panel draws, against presses
  // written out here by hand.
  it("Ctrl+Z is undo and Ctrl+Shift+Z is not", () => {
    const undo = shortcut("deckEditor", "undo");
    expect(matchesShortcut(undo, press("z", { ctrl: true }))).toBe(true);
    expect(matchesShortcut(undo, press("z", { ctrl: true, shift: true }))).toBe(false);
    expect(matchesShortcut(undo, press("z", { ctrl: true, alt: true }))).toBe(false);
  });

  it("both redo spellings redo, and Ctrl+Z does not", () => {
    const redo = shortcut("deckEditor", "redo");
    expect(matchesShortcut(redo, press("y", { ctrl: true }))).toBe(true);
    expect(matchesShortcut(redo, press("z", { ctrl: true, shift: true }))).toBe(true);
    expect(matchesShortcut(redo, press("z", { ctrl: true }))).toBe(false);
  });

  it("Delete removes and Ctrl+Delete does not", () => {
    const remove = shortcut("deckEditor", "remove");
    expect(matchesShortcut(remove, press("Delete"))).toBe(true);
    expect(matchesShortcut(remove, press("Delete", { ctrl: true }))).toBe(false);
  });

  it("F1 opens the map and Shift+F1 does not", () => {
    const keyMap = shortcut("global", "keyMap");
    expect(matchesShortcut(keyMap, press("F1"))).toBe(true);
    expect(matchesShortcut(keyMap, press("F1", { shift: true }))).toBe(false);
  });

  it("Escape dismisses", () => {
    expect(matchesShortcut(shortcut("global", "dismiss"), press("Escape"))).toBe(true);
  });

  it("Shift+F10 opens the context menu", () => {
    expect(matchesShortcut(shortcut("global", "contextMenu"), press("F10", { shift: true }))).toBe(
      true,
    );
  });

  it("the pointer rows match no keypress at all", () => {
    expect(matchesShortcut(shortcut("global", "zoom"), press("z", { ctrl: true }))).toBe(false);
    expect(matchesShortcut(shortcut("global", "select"), press("z", { ctrl: true }))).toBe(false);
  });
});

describe("chordParts", () => {
  it("draws a chord's modifiers before its key", () => {
    expect(chordParts({ key: "z", ctrl: true, shift: true })).toEqual(["Ctrl", "Shift", "Z"]);
  });

  // `chordParts` reads named properties, so the order the chord's fields were *written* in
  // cannot reach it — the fixed order is a property of the function and this is where it is
  // pinned. A reader scanning a column of caps reads the shape of a row, so two rows spelling
  // one pair of modifiers two ways would read as two different chords.
  it("draws all three modifiers in Ctrl, Alt, Shift order", () => {
    expect(chordParts({ key: "z", ctrl: true, alt: true, shift: true })).toEqual([
      "Ctrl",
      "Alt",
      "Shift",
      "Z",
    ]);
  });

  it("upper-cases a single letter", () => {
    expect(chordParts({ key: "y", ctrl: true })).toEqual(["Ctrl", "Y"]);
  });

  it("leaves a digit alone", () => {
    expect(chordParts({ key: "3", ctrl: true })).toEqual(["Ctrl", "3"]);
  });

  it("names the space bar", () => {
    expect(chordParts({ key: " " })).toEqual(["Space"]);
  });

  it("draws the four arrows as arrows", () => {
    expect(chordParts({ key: "ArrowLeft" })).toEqual(["←"]);
    expect(chordParts({ key: "ArrowRight" })).toEqual(["→"]);
    expect(chordParts({ key: "ArrowUp" })).toEqual(["↑"]);
    expect(chordParts({ key: "ArrowDown" })).toEqual(["↓"]);
  });

  it("shortens Escape to the word on the key", () => {
    expect(chordParts({ key: "Escape" })).toEqual(["Esc"]);
  });

  it("draws a wheel gesture as Scroll", () => {
    expect(chordParts({ pointer: "wheel", ctrl: true })).toEqual(["Ctrl", "Scroll"]);
  });

  it("draws a click as Click", () => {
    expect(chordParts({ pointer: "click", shift: true })).toEqual(["Shift", "Click"]);
  });

  it("draws a bare pointer gesture with no modifier at all", () => {
    expect(chordParts({ pointer: "click" })).toEqual(["Click"]);
  });

  it("draws every other key name verbatim", () => {
    expect(chordParts({ key: "F1" })).toEqual(["F1"]);
    expect(chordParts({ key: "Delete" })).toEqual(["Delete"]);
    expect(chordParts({ key: "F10", shift: true })).toEqual(["Shift", "F10"]);
  });
});

describe("activeScopes", () => {
  it("is global and the view the reader is on", () => {
    expect(activeScopes({ activeView: "search", openDeckId: null })).toEqual(["global", "search"]);
  });

  // The other side of the swap: with no deck open, `decks` is the section drawn — so a matcher
  // that always answered `deckEditor` would go red here rather than only in the pair below.
  it("names decks itself when no deck is open", () => {
    expect(activeScopes({ activeView: "decks", openDeckId: null })).toEqual(["global", "decks"]);
  });

  it("swaps decks for deckEditor when a deck is open", () => {
    expect(activeScopes({ activeView: "decks", openDeckId: 12 })).toEqual(["global", "deckEditor"]);
  });

  it("puts global first", () => {
    expect(activeScopes({ activeView: "settings", openDeckId: null })[0]).toBe("global");
  });

  it("names exactly two scopes", () => {
    expect(activeScopes({ activeView: "wishlist", openDeckId: null })).toHaveLength(2);
  });

  it("treats deck 0 as an open deck rather than as nothing open", () => {
    expect(activeScopes({ activeView: "decks", openDeckId: 0 })).toEqual(["global", "deckEditor"]);
  });
});

describe("shortcut", () => {
  it("finds an entry by id", () => {
    expect(shortcut("global", "keyMap").label).toBe("Show this list");
  });

  it("throws on an id the scope does not have", () => {
    expect(() => shortcut("global", "undo")).toThrow(/undo/);
  });

  it("throws on an id nothing has", () => {
    expect(() => shortcut("deckEditor", "unod")).toThrow(/deckEditor/);
  });

  it("throws on an empty scope", () => {
    expect(() => shortcut("search", "switchView")).toThrow();
  });
});

describe("the catalogue's shape", () => {
  it("carries the ids the other surfaces call by name", () => {
    expect(SHORTCUTS.global.map((s) => s.id)).toEqual([
      "switchView",
      "keyMap",
      "dismiss",
      "contextMenu",
      "zoom",
      "select",
    ]);
    expect(SHORTCUTS.deckEditor.map((s) => s.id)).toEqual(["undo", "redo", "remove"]);
  });

  // The other half of the cross-task contract: the panel renders these strings, so a reworded
  // label is a change to what a reader is told and belongs in a diff rather than in a sweep that
  // only counts words. Keyed by id so a reordering of the rows is the id test's business alone.
  it("carries the labels the panel draws, word for word", () => {
    expect(Object.fromEntries(SHORTCUTS.global.map((s) => [s.id, s.label] as const))).toEqual({
      switchView: "Jump to a section",
      keyMap: "Show this list",
      dismiss: "Close what is open",
      contextMenu: "Open the menu for what is focused",
      zoom: "Resize the cards",
      select: "Pick more than one card",
    });
    expect(Object.fromEntries(SHORTCUTS.deckEditor.map((s) => [s.id, s.label] as const))).toEqual({
      undo: "Undo the last change",
      redo: "Redo the change you undid",
      remove: "Remove the picked cards",
    });
  });

  it("has an entry for every scope, and the six views are honestly empty", () => {
    expect(SHORTCUTS.search).toEqual([]);
    expect(SHORTCUTS.tags).toEqual([]);
    expect(SHORTCUTS.decks).toEqual([]);
    expect(SHORTCUTS.collection).toEqual([]);
    expect(SHORTCUTS.wishlist).toEqual([]);
    expect(SHORTCUTS.settings).toEqual([]);
  });

  it("gives switchView one chord per rail entry, Ctrl+1 through Ctrl+6", () => {
    const chords = shortcut("global", "switchView").chords;
    expect(chords.map((c) => chordParts(c))).toEqual([
      ["Ctrl", "1"],
      ["Ctrl", "2"],
      ["Ctrl", "3"],
      ["Ctrl", "4"],
      ["Ctrl", "5"],
      ["Ctrl", "6"],
    ]);
  });

  it("binds each switchView chord to its own press and to no other", () => {
    const chords = shortcut("global", "switchView").chords;
    expect(matchesChord(chords[2], press("3", { ctrl: true }))).toBe(true);
    expect(matchesChord(chords[2], press("4", { ctrl: true }))).toBe(false);
    expect(matchesChord(chords[2], press("3"))).toBe(false);
    expect(matchesChord(chords[2], press("3", { ctrl: true, shift: true }))).toBe(false);
  });

  // A row with no chords would draw a label and nothing to press. The labels themselves are
  // pinned literally above rather than counted here, where any two words would pass.
  it("gives every row at least one chord", () => {
    for (const rows of Object.values(SHORTCUTS)) {
      for (const row of rows) {
        expect(row.chords.length).toBeGreaterThan(0);
      }
    }
  });
});
