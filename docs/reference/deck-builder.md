# Deck Builder Architecture & Frontend Rules

The frontend deck builder lives in `src/features/decks/`. It manages deck authoring, card categorization,
validation, notes, and to-do lists across desktop and mobile.

Storage tables, IPC commands, and audit logs are documented in [decks-storage.md](decks-storage.md);
live UI measurements and historical verification findings are in [decks-live-findings.md](decks-live-findings.md).

---

## The Validation Layer

Validation is executed entirely in TypeScript:
- **Rust provides facts**: The backend returns `DeckCardRow` containing per-printing facts: `legalities`, `color_identity`, power/toughness, `ever_uncommon`, and `game_changer`.
- **TypeScript draws conclusions**: `src/features/decks/engine.ts` evaluates deck size, copy limits, format legality, commander color identity, and banned/restricted status.

### `validateDeck` vs `validateForMarks`
1. **`validateDeck`**: Evaluates the whole deck for overall legality and format compliance.
2. **`validateForMarks`**: Evaluates individual cards to display error marks/warnings in the UI. Crucially, cards placed in disabled category piles (e.g., Sideboard, Maybeboard, or custom excluded piles) are excluded from deck copy and legality counts.

### Commander Bracket Estimation
- `estimateBracket` calculates a **floor**, never an absolute bracket.
- Commander bracket rules are formulated as negative prohibitions (e.g., Bracket 2 may not run mass land denial; Bracket 3 may run at most three Game Changers).
- The estimation computes the lowest bracket that does not prohibit any card in the deck list. Full specifications are documented in [commander-brackets.md](commander-brackets.md).

---

## The Notes Band (`deck_notes`)

The Notes band (`DeckNotesPanel.tsx`) renders markdown notes attached to decks and specific cards:

1. **Hook Ordering & TDZ Prevention**:
   - In `DeckEditor.tsx`, `useDeckNotes(deckId)` **must be declared above `deckCardMenu`**.
   - `notes.notes` is referenced in `deckCardMenu`'s `useCallback` dependency array. Because dependency arrays are evaluated during the render phase, declaring the hook below the callback results in a Temporal Dead Zone (`ReferenceError`) on first paint.
2. **Ref-Guarded Request Effects**:
   - The note request effect is guarded by a `useRef`, not a local boolean flag.
   - It executes `onToggle(true)` on request; `useRef` ensures re-runs in React 19 `StrictMode` do not trigger infinite loops or `react-hooks/set-state-in-effect` lint failures.
3. **Lazy Loading Invariant**:
   - `NoteEditor` must strictly be loaded via `React.lazy`.
   - `DeckNotesPanel.test.tsx` asserts via static analysis that no static import of `NoteEditor` exists in the feature bundle. This ensures decks without open notes do not load heavy markdown editor bundles.

---

## The To-do Band (`deck_todo_lists`)

The To-do band manages multiple titled checklist documents per deck (`DeckTodosPanel.tsx`, `TodoListCard.tsx`, `TodoListDialog.tsx`):

1. **Compare-and-Set (`expected`) Updates**:
   - Ticking a checkbox calls `deck_todo_list_update(deckId, id, null, nextBody, expectedBody)`.
   - `expectedBody` is the text currently rendered on the card. If the list was concurrently modified by another window, the home widget, or background sync, the update is safely refused rather than clobbering unseen edits.
2. **Autosave in `TodoListDialog`**:
   - Moving the editor into a dialog preserves the 600ms debounced autosave behavior.
   - Saves are automatically flushed when the text caret blurs, when the dialog closes, and upon unmount.
   - **Atomic Title & Body**: Both the title `<input>` and checklist body ride the same autosave payload so they never drift apart.
   - Unlike in-place card toggles, authoring inside `TodoListDialog` writes without `expectedBody` (the open draft is the author's intentional truth).
3. **Card Rendering Isolation**:
   - Summary cards render parsed markdown blocks (`parseTodoBody`) and lightweight checkboxes. They never mount or import `NoteEditor`.

---

## The Category Model & Piles

- **Category Assignment**: Cards are categorized by custom category, tag match, or automatic fallback (`type_line` heuristics).
- **Excluded Piles**: A category may be marked as excluded from main deck totals. Cards in these piles do not contribute to copy limit warnings or format size constraints.
- **Tokens & Emblems**: Token rows are managed via `DeckTokensPanel.tsx`, `TokenArtPicker.tsx`, and `views/TokenPile.tsx`. Tokens are separated from library cards and evaluated under dedicated token stack rules.
