/**
 * Every chord this app binds a reader can be told about — written down once, and read by both
 * the handler that fires and the panel that lists it.
 *
 * A shortcut is otherwise **two** facts: a comparison buried in a `keydown` handler and a
 * sentence somewhere describing it. Those two drift, and they drift silently — a prose-only edit
 * routes to neither CI job ({@link ../../CLAUDE.md}), so a documented chord whose handler moved
 * goes wrong with nothing red. The whole of what this module buys is that the map cannot
 * advertise a keyboard chord nothing binds, because the binding matches against the same object
 * the panel draws.
 *
 * **The pointer rows are the exception, and they are honest about it.** `Ctrl+wheel` and
 * `Ctrl`/`Shift`-click are gestures no `KeyboardEvent` matcher can serve, so
 * {@link useCardZoomGesture} and `multiSelect.ts` keep their own logic and these entries are
 * label-and-chord only. {@link matchesChord} answers `false` for them *by construction* rather
 * than by a guard, which is the difference between a rule and something a caller can forget.
 *
 * Rust supplies facts and TS draws conclusions: a chord is a conclusion about what a press
 * means, so it is pure data over a plain event and checkable as a truth table with no DOM, no
 * store and no window behind it.
 */

import type { ViewId } from "./store";

/**
 * One pressable thing — a key with its modifiers, or a mouse gesture with its modifiers.
 *
 * A modifier left out is a modifier that must be **absent**, never one that is unspecified; see
 * {@link matchesChord}, where that is the whole reason the two arms of a `Ctrl+Z` / `Ctrl+Shift+Z`
 * pair can coexist.
 */
export type Chord =
  | { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }
  | { pointer: "click" | "wheel"; ctrl?: boolean; shift?: boolean };

/** One row of the map, and one binding. */
export interface Shortcut {
  /** Stable across labels and chords — it is what a call site names, so a rename is free. */
  id: string;
  /** The imperative — "Undo the last change", not "Undo". */
  label: string;
  /** More than one when a chord has two spellings a reader's hands might know. */
  chords: readonly Chord[];
}

/**
 * Where a shortcut is live.
 *
 * `ViewId` rather than a list of its own, so a seventh view is a type error here rather than a
 * section the map silently never draws. `deckEditor` is not a view and never will be — it is the
 * surface `App.tsx` swaps *in place of* `DecksPage`, which is why {@link activeScopes} replaces
 * rather than nests.
 */
export type ShortcutScope = "global" | ViewId | "deckEditor";

/**
 * The catalogue.
 *
 * **A `Record` over every scope rather than a partial map**, so the six views are each present
 * with an empty array. That is not a placeholder waiting to be filled: it is the honest state of
 * those pages, and an empty scope draws nothing at all in the panel — no heading. Making the
 * emptiness explicit is what stops a scope being forgotten when a view starts binding something.
 *
 * Ids are the cross-file contract. {@link shortcut} throws on one that is absent, so a typo in a
 * handler is a red test rather than a binding that quietly never fires.
 */
export const SHORTCUTS: Record<ShortcutScope, readonly Shortcut[]> = {
  global: [
    {
      id: "switchView",
      label: "Jump to a section",
      /**
       * Six chords in `NAV` order, and the *index* is the binding: `AppShell` walks these and
       * activates `NAV[i]`, so the rail's own order stays the single list rather than being
       * restated as a sixth-and-seventh copy here. One row in the panel, showing the range.
       */
      chords: [
        { key: "1", ctrl: true },
        { key: "2", ctrl: true },
        { key: "3", ctrl: true },
        { key: "4", ctrl: true },
        { key: "5", ctrl: true },
        { key: "6", ctrl: true },
      ],
    },
    { id: "keyMap", label: "Show this list", chords: [{ key: "F1" }] },
    { id: "dismiss", label: "Close what is open", chords: [{ key: "Escape" }] },
    {
      id: "contextMenu",
      label: "Open the menu for what is focused",
      chords: [{ key: "F10", shift: true }],
    },
    { id: "zoom", label: "Resize the cards", chords: [{ pointer: "wheel", ctrl: true }] },
    {
      id: "select",
      label: "Pick more than one card",
      chords: [
        { pointer: "click", ctrl: true },
        { pointer: "click", shift: true },
      ],
    },
  ],
  search: [],
  tags: [],
  decks: [],
  collection: [],
  wishlist: [],
  settings: [],
  deckEditor: [
    { id: "undo", label: "Undo the last change", chords: [{ key: "z", ctrl: true }] },
    {
      id: "redo",
      label: "Redo the change you undid",
      /**
       * Both spellings, because both are muscle memory somewhere: `Ctrl+Y` is Windows' and
       * `Ctrl+Shift+Z` is what an editor-shaped app teaches. They are two chords rather than one
       * with a loose modifier test, which is exactly what keeps `Ctrl+Shift+Z` out of `undo`.
       */
      chords: [
        { key: "y", ctrl: true },
        { key: "z", ctrl: true, shift: true },
      ],
    },
    { id: "remove", label: "Remove the picked cards", chords: [{ key: "Delete" }] },
  ],
};

/**
 * Whether a keypress *is* this chord.
 *
 * Three rules, each with a failure behind it:
 *
 * * **`ctrl: true` matches `ctrlKey` or `metaKey`.** Not hedging about macOS — it is the rule
 *   `multiSelect.ts:61` already states and tests, and this app's whole component suite runs in
 *   jsdom where `userEvent`'s `{Meta>}` is as reachable as `{Control>}`. A second, stricter
 *   spelling of that rule here is the drift this module exists to stop.
 * * **Every modifier the chord does not name must be absent.** `{ key: "z", ctrl: true }` does
 *   not match `Ctrl+Alt+Z` and does not match `Ctrl+Shift+Z` — without that, one press would fire
 *   undo *and* redo, which is the bug the hand-rolled `key === "z" && !e.shiftKey` comparisons
 *   were written to avoid. Exactness is what lets the catalogue stop writing those by hand.
 * * **A single-character key compares case-insensitively.** `e.key` is `"Z"` while Shift is
 *   held, so a case-sensitive test would make every shifted letter chord dead. Longer names
 *   (`F1`, `Delete`, `ArrowLeft`) are compared verbatim, because they are already canonical and
 *   folding them would let `"delete"` through as a chord nobody wrote.
 *
 * **A pointer chord returns `false` and there is nothing to configure about that** — it carries
 * no `key`, so the answer falls out of the shape rather than out of a guard. See the module doc.
 *
 * What this deliberately does **not** do is yield inside a text field. That is a fact about a
 * particular binding rather than about chord matching: the deck editor's undo yields because the
 * quick-add box and the notes need the browser's own undo, while `Ctrl+1` has no native meaning
 * in a field and yielding there would kill view-switching exactly where the caret usually is. So
 * `isTextField` stays at each call site, next to the argument for it.
 */
export function matchesChord(chord: Chord, e: KeyboardEvent): boolean {
  if (!("key" in chord)) return false;
  if ((e.ctrlKey || e.metaKey) !== (chord.ctrl === true)) return false;
  if (e.shiftKey !== (chord.shift === true)) return false;
  if (e.altKey !== (chord.alt === true)) return false;
  return chord.key.length === 1
    ? chord.key.toLowerCase() === e.key.toLowerCase()
    : chord.key === e.key;
}

/**
 * Whether a keypress is *any* of a shortcut's spellings.
 *
 * This is what a handler calls, and it is why `redo` can hold two chords without either call
 * site knowing there are two: a spelling added to the catalogue is bound the moment it is
 * written, with no edit anywhere else.
 */
export function matchesShortcut(s: Shortcut, e: KeyboardEvent): boolean {
  return s.chords.some((chord) => matchesChord(chord, e));
}

/**
 * The caps to draw, in order: `["Ctrl", "Shift", "Z"]`.
 *
 * **Parts rather than a joined string**, so the panel draws one `<kbd>` per cap and the joining
 * glyph is the panel's decision — nothing downstream has to parse a `"Ctrl+Z"` back apart to
 * render it as keys.
 *
 * Modifier order is fixed at Ctrl, Alt, Shift regardless of the order the chord's fields were
 * written in, because a reader scanning a column of caps is reading the *shape* of a row: two
 * rows spelling the same pair of modifiers two ways read as two different chords.
 */
export function chordParts(chord: Chord): readonly string[] {
  const parts: string[] = [];
  if (chord.ctrl === true) parts.push("Ctrl");
  if ("key" in chord && chord.alt === true) parts.push("Alt");
  if (chord.shift === true) parts.push("Shift");
  parts.push(cap("key" in chord ? chord.key : chord.pointer));
  return parts;
}

/**
 * What a cap says, where the event's own name for it is not what a reader calls it.
 *
 * The pointer names share the table with the keys because a cap is a cap: a row reading
 * `Ctrl` `Scroll` is the same object as one reading `Ctrl` `Z`, and splitting the two would be a
 * second table to keep in agreement with the first.
 */
const CAPS: Record<string, string> = {
  " ": "Space",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  wheel: "Scroll",
  click: "Click",
};

/**
 * A single character is upper-cased and everything else is drawn verbatim.
 *
 * Verbatim is the right default rather than a gap in the table: `F1`, `Delete` and `F10` are
 * already the words on the keyboard, so a name this table has never heard of is far more likely
 * to be one of those than to be a mistake worth hiding behind a placeholder.
 */
function cap(name: string): string {
  const named = CAPS[name];
  if (named !== undefined) return named;
  return name.length === 1 ? name.toUpperCase() : name;
}

/**
 * Which scopes are live, in the order the panel draws them.
 *
 * `"global"` first and always, then exactly one more. **The editor replaces `decks` rather than
 * nesting under it**: `App.tsx` renders `openDeckId === null ? <DecksPage/> : <DeckEditor/>`, so
 * a `decks` section under an open editor would list chords for a page that is not on screen.
 *
 * Two fields already in the store and no registration machinery — a scope that registered itself
 * on mount would be a second source of truth about what is drawn, and the store already answers
 * that question. If a dialog ever earns a section, it is an addition here and nowhere else.
 */
export function activeScopes(s: {
  activeView: ViewId;
  openDeckId: number | null;
}): readonly ShortcutScope[] {
  return ["global", s.openDeckId !== null ? "deckEditor" : s.activeView];
}

/**
 * One entry by id — **throwing when there is none**, which is the whole point of the function.
 *
 * A handler that names a shortcut that has been renamed or deleted would otherwise get
 * `undefined`, match nothing, and go quiet: the key simply stops working, with no error and
 * nothing red. Throwing turns that into a failed test on the first render or the first press,
 * which is the earliest anything can notice.
 */
export function shortcut(scope: ShortcutScope, id: string): Shortcut {
  const found = SHORTCUTS[scope].find((s) => s.id === id);
  if (found === undefined) throw new Error(`No shortcut "${id}" in scope "${scope}"`);
  return found;
}
