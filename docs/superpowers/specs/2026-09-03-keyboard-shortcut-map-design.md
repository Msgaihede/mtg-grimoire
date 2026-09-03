# The keyboard shortcut map — design

**Date:** 2026-09-03
**Branch:** `worktree-keyboard-shortcut-map`
**Status:** approved, ready to plan

## 1. What this is

A panel that answers "what can I press here". A `Keyboard` button in the window's caption row,
left of Minimize, opens a popover listing the chords that are live **on the page the reader is
actually on**. `F1` opens the same panel.

It is a *desktop* object by construction rather than by a flag: it lives in `TitleBar`, which
`AppShell` already draws only when the target is neither Android nor the web build
(`AppShell.tsx:335`). The **bindings** it documents are bound everywhere there is a keyboard.

## 2. The problem the design is actually solving

A sweep of `src/` on 2026-09-03 found the shipped shortcut inventory is thin, and almost all of
it is widget-local:

| Where | Chord | Bound at |
| --- | --- | --- |
| Deck editor | `Ctrl+Z` undo | `DeckEditor.tsx:1895` |
| Deck editor | `Ctrl+Y`, `Ctrl+Shift+Z` redo | `DeckEditor.tsx:1898` |
| Deck editor | `Delete` remove the picked cards | `DeckEditor.tsx:3103` |
| Any scroll container | `Ctrl+wheel` step the card zoom | `useCardZoomGesture.ts:83` |
| Any card wall or table | `Ctrl+click` toggle, `Shift+click` range | `multiSelect.ts:76` |
| Everywhere | `Escape` dismiss | `useDismissOnEscape.ts` |
| Everywhere | `Shift+F10` context menu | `useContextMenu.ts` |

Everything else — arrows in a menu, `Home`/`End` in `QuickAdd`, `Enter` in a field, the `Tab`
trap in `Dialog` — is standard-issue widget navigation that every reader already assumes, and
listing it would bury the four rows that are specific to this app.

So there are two problems, not one. The map has to be **honest** (a documented chord and its
handler are otherwise two facts that drift, and this repo's own rule notes that a prose-only
edit routes to neither CI job), and it has to have **something to say** on the five views that
bind nothing at all.

## 3. Decisions

| Question | Decision |
| --- | --- |
| Source of truth | One catalogue that is *both* the panel's content and what the handlers match against |
| New bindings | `Ctrl+1…6` switch view; `F1` opens the map. No `Ctrl+F`. |
| Depth | Global + the active view + the open surface. No widget navigation keys. |
| Icon | lucide `Keyboard` |
| Other targets | Bindings everywhere; the button on desktop only |

## 4. The catalogue — `src/lib/shortcuts.ts`

```ts
export type Chord =
  | { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }
  | { pointer: "click" | "wheel"; ctrl?: boolean; shift?: boolean };

export interface Shortcut {
  id: string;
  /** The imperative — "Undo the last change", not "Undo". */
  label: string;
  /** More than one when a chord has two spellings a reader's hands might know. */
  chords: readonly Chord[];
}

export type ShortcutScope = "global" | ViewId | "deckEditor";

export const SHORTCUTS: Record<ShortcutScope, readonly Shortcut[]>;

export function matchesChord(chord: Chord, e: KeyboardEvent): boolean;
export function matchesShortcut(s: Shortcut, e: KeyboardEvent): boolean;
export function chordParts(chord: Chord): readonly string[];
export function activeScopes(s: { activeView: ViewId; openDeckId: number | null }):
  readonly ShortcutScope[];
```

### 4.1 `matchesChord`

- `ctrl: true` matches `e.ctrlKey || e.metaKey`. That is not hedging about macOS — it is the
  rule `multiSelect.ts:61` already states and tests, and a second spelling of it here is the
  drift this module exists to stop.
- **Every modifier the chord does not name must be absent.** `{ key: "z", ctrl: true }` does
  not match `Ctrl+Alt+Z`. Without this, `Ctrl+Shift+Z` would fire undo *and* redo, which is
  exactly the bug the current hand-rolled `key === "z" && !e.shiftKey` is written to avoid.
- Single-character keys compare case-insensitively (`e.key` is `"Z"` while Shift is held).
- **A pointer chord never matches.** It carries no `key`, so the function returns `false` by
  construction rather than by a guard that could be forgotten.

### 4.2 What the matcher deliberately does not do

**It does not yield inside a text field.** `DeckEditor`'s undo handler does, and says why: the
quick-add box, the deck name and the notes need the browser's own undo, which the app cannot
replace and must not swallow. That is a fact about *that binding*, not about chord matching —
`Ctrl+1` has no native meaning in a text field and yielding there would make view-switching
dead exactly where the reader's caret usually is. So `isTextField` stays at the call site,
where the argument for it is.

### 4.3 `chordParts`

Returns the caps to draw, in order: `["Ctrl", "Shift", "Z"]`. Display names are a small table —
`" "` → `Space`, `ArrowLeft` → `←`, `wheel` → `Scroll`, `click` → `Click`, single letters
upper-cased. The panel renders one `<kbd>` per part; the joining glyph is the panel's, not the
string's, so nothing has to parse a `"Ctrl+Z"` back apart.

### 4.4 Scopes

```
activeScopes = ["global", openDeckId !== null ? "deckEditor" : activeView]
```

Two fields already in the store, and no registration machinery. The editor **replaces** rather
than nests: `App.tsx:44` is `openDeckId === null ? <DecksPage/> : <DeckEditor/>`, so a
`decks` section under an open editor would list chords for a page that is not on screen.

`"global"` is always first and always present. If a dialog ever earns a section of its own,
that is an additive change to this function — deliberately not built now.

## 5. The handlers consume the catalogue

Three call sites change, and none of them gains an abstraction layer:

- `DeckEditor.tsx:1889-1904` — the `onKey` body becomes `matchesShortcut(SHORTCUTS.deckEditor…)`
  against the `undo` and `redo` entries. The `isTextField` yield and the `preventDefault` stay.
- `DeckEditor.tsx:3102-3110` — same, against the `remove` entry.
- `useCardZoomGesture.ts` and `multiSelect.ts` keep their own logic. Their catalogue rows are
  pointer chords, which no matcher can serve; the fence there is that the *label* and the
  *chord* live next to the code they describe.

**The fence being bought:** the map cannot advertise a keyboard chord that nothing binds,
because the binding reads its chord out of the same object the panel draws.

## 6. Two new bindings — in `AppShell`

A single `useEffect` on `window`, `keydown`:

- **`Ctrl+1` … `Ctrl+6`** → `setActiveView(NAV[n].id)`, in the rail's own order (Search,
  Tagger, Decks, Collection, Wishlist, Settings). Reading the order out of `NAV` rather than
  restating it is the same argument `nav.ts` already makes about the label being the ribbon's
  `<h1>`: one list, not two that can drift.
  **Guarded by `document.querySelector('[aria-modal="true"]')`** — `Dialog.tsx:363` is the one
  modal chrome in the app and always sets it, so a view cannot switch out from under an open
  dialog. Not guarded by `isTextField`, per §4.2.
- **`F1`** → toggle the map. Unguarded: its content is *more* useful with a dialog up, and F1
  has no meaning inside a text field.

Both bind on every target. `Ctrl+1…8` is reserved by Chrome for tab switching and a page
cannot `preventDefault` it, so on the web build that family may simply never arrive — that is
the host's call, costs nothing, and is why the affordance is desktop-only anyway.

## 7. The button and the panel

### 7.1 The button

A fourth `CaptionButton` in `TitleBar`, before Minimize, `Keyboard` glyph, `aria-label`
`"Keyboard shortcuts"`.

`CaptionButton` gains one prop, `expanded`, which sets `aria-expanded` and draws the open
state. The component already proves that shape with `forceHover` — the same two declarations
applied by state rather than by the pointer — so `expanded` reuses that branch rather than
adding a third styling path.

It carries **no `data-tauri-drag-region`**. The buttons in that row deliberately do not: a drag
region swallows the click.

The 46×34 square, the missing radius and the missing press-scale all stay. The corner argument
in `TitleBar`'s doc is about Minimize/Maximize/Close specifically, but a rounded chip dropped
into a row of three square full-height buttons reads as foreign, and coherence of the row wins
over a rule that was written about Fitts's law at the screen's edge.

### 7.2 The panel

`usePopupPlacement` + `PopupPanel`, the pair `Dropdown` and the set picker already use:
anchored and `position: fixed` from measured numbers, **never portalled**. The shipped CSP is
`style-src 'self'` with `style-src-attr 'unsafe-inline'` beside it — a measured inline `style`
is legal, an injected `<style>` element is blank in a packaged build. `align: "end"`, so the
panel's right edge tracks the button rather than running off the window.

The hook wants three refs — `triggerRef`, `frameRef` (the zero-size `fixed` element the panel
draws inside) and `panelRef` — plus `onClose` for the scroll case.

Escape closes through `useDismissOnEscape`, on the `"outer"` rung, registered on the *flag*
rather than on the element so a panel on its way out is not still eating Escape.

### 7.3 No new `LAYER` rung

`TitleBar`'s root carries `LAYER.caption` (`z-60`) and z-index on a flex item creates a
stacking context whatever its position — so a panel rendered inside `TitleBar` paints above
`gate` (`z-50`) and `overlay` (`z-45`) without a number of its own. This is the one claim in
the design that jsdom cannot check; §10 drives it in the real window.

### 7.4 Contents

Sections in `activeScopes` order, each a heading and a list of rows; a row is its label and its
caps. A scope with no shortcuts draws nothing rather than an empty heading — five of the six
views are in that state today, which is what `Ctrl+1…6` in `"global"` is for.

### 7.5 Open state

`keyMapOpen: boolean` in the store, in memory like `openDeckId`, because `F1` is bound in
`AppShell` and the panel lives in `TitleBar`. `setKeyMapOpen` and nothing more; the toggle is
the caller's.

## 8. Files

**New**

- `src/lib/shortcuts.ts`, `src/lib/shortcuts.test.ts`
- `src/components/KeyMap.tsx`, `KeyMap.test.tsx`, `KeyMap.stories.tsx`
- `docs/reference/keyboard-shortcuts.md`

**Changed**

- `src/components/TitleBar.tsx` — the button, `CaptionButton`'s `expanded`, the panel's mount
- `src/components/AppShell.tsx` — the two new bindings
- `src/features/decks/DeckEditor.tsx` — three handler sites read the catalogue
- `src/lib/store.ts` — `keyMapOpen`
- `src/CLAUDE.md` — a line pointing at the catalogue as the one place a chord is written down

## 9. Testing

- `shortcuts.test.ts` — the matcher's modifier exactness (`Ctrl+Alt+Z` is not undo,
  `Ctrl+Shift+Z` is not undo), meta-as-ctrl, case folding, pointer chords never matching,
  `chordParts` display names, `activeScopes` swapping `decks` for `deckEditor`.
- `KeyMap.test.tsx` — the button's name and `aria-expanded`, the panel's sections per scope, an
  empty scope drawing no heading, Escape closing and handing focus back.
- `AppShell.test.tsx` — `Ctrl+3` switches view; it does **not** while `[aria-modal]` is in the
  document; `F1` toggles `keyMapOpen`.
- `DeckEditor.test.tsx` — the existing undo/redo/delete tests must stay green unchanged. That
  is the point of the refactor: same behaviour, one source.

**Mutation check:** every subagent flips its own assertion (change a chord, expect the test to
go red) before reporting done. A matcher test that reads its own constant proves nothing.

## 10. Live checks — the shipped window, not the suite

1. `F1` reaches the page in WebView2 (Chrome reserves it for its own help; WebView2 has no help
   page, so it should arrive — but that is a prediction until it is driven).
2. `Ctrl+1…6` switches view, and does not while a dialog is open.
3. The panel paints **above** an open `Dialog`'s scrim and above `SyncProgress`'s gate — §7.3's
   claim, which is exactly the shape of the bug `LAYER.caption` was added to fix.
4. The panel opens downward and its right edge stays inside the window at the narrowest width
   the app allows.
5. The button does not become a drag region — press and drag on it moves nothing.

## 11. Out of scope

- A Settings surface for the map on web/Android.
- `Ctrl+F` to focus the active page's search box.
- Rebindable shortcuts, or persisting anything about them.
- Listing widget navigation keys (arrows, `Home`/`End`, `Tab` traps).
