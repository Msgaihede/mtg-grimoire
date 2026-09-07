# Plan — the keyboard shortcut map

**Spec:** [`docs/superpowers/specs/2026-09-03-keyboard-shortcut-map-design.md`](../specs/2026-09-03-keyboard-shortcut-map-design.md)
**Worktree:** `D:\Code\mtg-grimoire\.claude\worktrees\keyboard-shortcut-map`

## Global constraints

- **Every path is relative to the worktree above.** A subagent is pinned to the project root
  `D:\Code\mtg-grimoire`, not to this worktree — read and write only under the worktree path.
- **Do not run `npm run verify`, `npm run test:run` across the tree, or `cargo test`.** Tests
  run once, at the end, after fan-in. Task 1 is the one exception (it runs solo, and only its
  own file).
- **Do not commit.** The git index is shared across parallel agents; the controller commits.
- **Touch only the files your task lists.** A sibling is editing the others in the same tree.
- Conventional style: doc comments carry the *argument*, not a restatement of the code. Match
  the density of the file you are editing.
- Never install `@types/node`. TypeScript stays on 6.0.x.
- No `setState` inside an effect (lint only catches it at `npm run verify`).

## The pinned cross-task contract

Tasks 2, 3 and 4 run at the same time against interfaces that do not exist yet in their tree.
These signatures are binding — implement and consume them exactly.

```ts
// src/lib/shortcuts.ts — Task 1 creates it; Tasks 2, 3, 4 import from it.
export type Chord =
  | { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }
  | { pointer: "click" | "wheel"; ctrl?: boolean; shift?: boolean };
export interface Shortcut { id: string; label: string; chords: readonly Chord[] }
export type ShortcutScope = "global" | ViewId | "deckEditor";
export const SHORTCUTS: Record<ShortcutScope, readonly Shortcut[]>;
export function matchesChord(chord: Chord, e: KeyboardEvent): boolean;
export function matchesShortcut(s: Shortcut, e: KeyboardEvent): boolean;
export function chordParts(chord: Chord): readonly string[];
export function activeScopes(s: {
  activeView: ViewId;
  openDeckId: number | null;
}): readonly ShortcutScope[];
export function shortcut(scope: ShortcutScope, id: string): Shortcut; // throws if absent
```

```ts
// src/lib/store.ts — Task 2 adds these two members; Task 3 consumes them.
keyMapOpen: boolean;              // default false, in memory only
setKeyMapOpen: (open: boolean) => void;
```

**Shortcut ids that other tasks call by name** (Task 1 must use these exact strings):

| Scope | id | Label | Chords |
| --- | --- | --- | --- |
| `global` | `switchView` | `Jump to a section` | `Ctrl+1` … `Ctrl+6` — see note |
| `global` | `keyMap` | `Show this list` | `F1` |
| `global` | `dismiss` | `Close what is open` | `Escape` |
| `global` | `contextMenu` | `Open the menu for what is focused` | `Shift+F10` |
| `global` | `zoom` | `Resize the cards` | `Ctrl+wheel` (pointer) |
| `global` | `select` | `Pick more than one card` | `Ctrl+click`, `Shift+click` (pointer) |
| `deckEditor` | `undo` | `Undo the last change` | `Ctrl+Z` |
| `deckEditor` | `redo` | `Redo the change you undid` | `Ctrl+Y`, `Ctrl+Shift+Z` |
| `deckEditor` | `remove` | `Remove the picked cards` | `Delete` |

`switchView` carries six chords, `{ key: "1", ctrl: true }` … `{ key: "6", ctrl: true }`, in
`NAV` order. It is one row in the panel showing the range, and Task 2 matches against its
chords by index.

`search`, `tags`, `decks`, `collection`, `wishlist`, `settings` are all present in `SHORTCUTS`
with an empty array. That is not a placeholder — it is the honest state of those pages, and
§7.4 of the spec says an empty scope draws nothing.

---

## Task 1 — the catalogue

**Files:** `src/lib/shortcuts.ts` (new), `src/lib/shortcuts.test.ts` (new)
**Runs solo. Run `npx vitest run src/lib/shortcuts.test.ts` and the mutation check below.**

Implement the pinned contract above. Spec §4 is the requirement; read it.

- `matchesChord`: `ctrl: true` matches `e.ctrlKey || e.metaKey` (the rule `multiSelect.ts:61`
  already states). **Every modifier the chord does not name must be absent** — `{key:"z",
  ctrl:true}` must not match `Ctrl+Alt+Z` or `Ctrl+Shift+Z`. Single-character keys compare
  case-insensitively. A pointer chord never matches, by construction (it has no `key`).
- `matchesShortcut` is `chords.some(matchesChord)`.
- `chordParts`: `["Ctrl", "Shift", "Z"]`. Modifier order is always Ctrl, Alt, Shift, then the
  key. Display table: `" "` → `Space`, `ArrowLeft/Right/Up/Down` → `←/→/↑/↓`, `wheel` →
  `Scroll`, `click` → `Click`, `Escape` → `Esc`, a single letter upper-cased, everything else
  verbatim (`F1`, `Delete`, `F10`).
- `activeScopes`: `["global", openDeckId !== null ? "deckEditor" : activeView]`.
- `shortcut(scope, id)` throws on a missing id — it is what makes a typo in a caller a red
  test rather than a silently missing binding.
- **Do not** put `isTextField` yielding in the matcher. Spec §4.2 says why.

**Tests:** modifier exactness in both directions, meta-as-ctrl, case folding, pointer chords
never matching, `matchesShortcut` across multi-chord entries, every `chordParts` display-table
branch, `activeScopes` swapping `decks` for `deckEditor`, `shortcut` throwing.
An assertion must not read its own constant — write `Ctrl+Alt+Z` out literally in the test.

**Mutation check (required):** after the suite is green, break `matchesChord` so unlisted
modifiers are ignored, confirm the exactness tests go red, and restore. Report what went red.

---

## Task 2 — the store flag and the two new bindings

**Files:** `src/lib/store.ts`, `src/components/AppShell.tsx`, `src/components/AppShell.test.tsx`
**Runs in parallel with Tasks 3 and 4. Do not run any test command.**

1. **`store.ts`** — add `keyMapOpen: boolean` (default `false`) and `setKeyMapOpen`. In memory
   only, like `openDeckId`. Match the file's doc-comment density; the argument to record is
   that the flag is shared because `F1` is bound in `AppShell` while the panel lives in
   `TitleBar`.
2. **`AppShell.tsx`** — one `useEffect` binding `keydown` on `window`:
   - `switchView`: match `SHORTCUTS.global` `switchView`'s chords by index → `setActiveView(NAV[i].id)`,
     `preventDefault()`. **Guard:** return early if
     `document.querySelector('[aria-modal="true"]') !== null`. Do **not** guard on `isTextField`.
   - `keyMap`: `F1` → `setKeyMapOpen(!keyMapOpen)`, `preventDefault()`. No guard.
   - Read `NAV` from `@/components/nav` — do not restate the six ids.
   - The effect must not depend on values that change every render in a way that rebinds the
     listener on each keystroke; use the store's setters (stable) and a ref or the functional
     form for the toggle.
3. **`AppShell.test.tsx`** — `Ctrl+3` switches to `decks`; it does **not** while an element with
   `aria-modal="true"` is in the document; `F1` flips `keyMapOpen`; `F1` again flips it back.

`SHORTCUTS`, `matchesChord` and `shortcut` come from `@/lib/shortcuts` — the file does not
exist in your tree yet. Import it per the pinned contract and do not create it.

**Mutation check (required, by reading not running):** state in your report which single line
you would change to make each new test fail, and why that line is the one under test.

---

## Task 3 — the button and the popover

**Files:** `src/components/KeyMap.tsx`, `KeyMap.test.tsx`, `KeyMap.stories.tsx` (all new);
`src/components/TitleBar.tsx`, `TitleBar.test.tsx`, `TitleBar.stories.tsx`
**Runs in parallel with Tasks 2 and 4. Do not run any test command.**

Spec §7 is the requirement; read it. Read `src/CLAUDE.md` before writing any UI.

1. **`CaptionButton` in `TitleBar.tsx`** gains `expanded?: boolean` → sets `aria-expanded` and
   draws the open state by reusing the existing `forceHover` styling branch (do not add a third
   styling path).
2. **The button**: a fourth `CaptionButton` **before** Minimize, lucide `Keyboard`, `aria-label`
   `"Keyboard shortcuts"`. **No `data-tauri-drag-region`** — a drag region swallows the click.
3. **`KeyMap.tsx`**: the panel. Use `usePopupPlacement` from
   `@/components/Dropdown/usePopupPlacement` and `PopupPanel` from `@/components/PopupListbox`,
   the pair `Dropdown` already uses — anchored and `position: fixed` from measured numbers,
   **never portalled** (the shipped CSP is `style-src 'self'`; an injected `<style>` is blank in
   a packaged build). `align: "end"`. The hook wants `triggerRef`, `frameRef` (a zero-size
   `fixed` element the panel draws inside), `panelRef`, `open` and `onClose`.
   - Escape closes through `useDismissOnEscape` on the `"outer"` rung, registered on the
     **flag** rather than the element, and hands focus back to the trigger.
   - Sections in `activeScopes` order. A scope with no shortcuts renders **nothing** — no
     heading. Section headings: `Everywhere` for `global`, the `NAV` label for a view,
     `Deck editor` for `deckEditor`.
   - A row is its `label` and its chords; a chord is one `<kbd>` per `chordParts` entry.
     Multiple chords for one shortcut are separated by the word `or`.
   - **No new `LAYER` rung.** `TitleBar`'s root already carries `LAYER.caption` (`z-60`) and
     that makes it a stacking context; the panel inherits its place in the app-wide order.
     Do not edit `src/lib/layers.ts`.
4. **State**: `keyMapOpen` / `setKeyMapOpen` from the store per the pinned contract. The store
   member does not exist in your tree yet — consume it, do not add it.
5. **Stories**: at minimum the panel open on `decks` with the editor open (three sections, one
   of them empty and therefore absent) and open on `search` (global only). Read
   `.storybook/CLAUDE.md` first.
6. **Tests**: the button's accessible name and `aria-expanded` in both states; the panel's
   sections for a given scope; an empty scope drawing no heading; Escape closing and handing
   the caret back to the trigger.

**Mutation check (required, by reading not running):** name the single line whose change makes
each new test fail.

---

## Task 4 — the deck editor reads the catalogue

**Files:** `src/features/decks/DeckEditor.tsx` only
**Runs in parallel with Tasks 2 and 3. Do not run any test command. Do not touch
`DeckEditor.test.tsx` — its existing undo/redo/delete tests staying green unchanged is the
point of this task.**

Spec §5 is the requirement.

1. **`DeckEditor.tsx:1889-1904`** (the `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` effect): replace the
   hand-rolled comparisons with `matchesShortcut(shortcut("deckEditor", "undo"), e)` and the
   same for `"redo"`. **Keep** the `isTextField(e.target)` yield and its doc comment — spec §4.2
   says that argument belongs at the call site, not in the matcher. **Keep** `preventDefault`.
   The early `if (!(e.ctrlKey || e.metaKey) || e.altKey) return;` line becomes redundant once
   the matcher is exact; remove it only if you are certain behaviour is identical, and say so
   in your report either way.
2. **`DeckEditor.tsx:3102-3110`** (the `Delete` effect): same, against `shortcut("deckEditor",
   "remove")`. Keep the `layerOpen` guard, the `isTextField` yield, the `held.length < 2` floor
   and `preventDefault`.
3. Update the two doc comments so they name the catalogue as the source of the chord rather
   than restating the keys — but keep every *argument* they already make (why undo yields in a
   text field, why `Ctrl+Y` and `Ctrl+Shift+Z` both redo, what `Delete` costs in undo steps).

`shortcut` and `matchesShortcut` come from `@/lib/shortcuts`, which does not exist in your tree
yet. Import per the pinned contract.

**Mutation check (required, by reading not running):** confirm by reading that the three
existing behaviours are byte-for-byte identical in effect, and state in your report the one
input for each that would have differed under the old code if the matcher were not exact.

---

## Task 5 — the record

**Files:** `docs/reference/keyboard-shortcuts.md` (new), `src/CLAUDE.md`, `CLAUDE.md`
**Runs solo, after Tasks 1-4 are in.**

- `docs/reference/keyboard-shortcuts.md`: what the catalogue is, why it is both the panel's
  content and the handlers' matcher, the scope rule and why the editor replaces `decks`, the
  text-field decision and where it lives, why the panel needs no `LAYER` rung, and what the
  live checks found (the controller supplies those results).
- `src/CLAUDE.md`: one line — a chord is written down in `src/lib/shortcuts.ts` and nowhere
  else.
- `CLAUDE.md`: one row in the reference-docs table.
- Do not write down a number a build already answers. Re-count anything you do write.
