# Multi-select for cards — plan

Issue [#214](https://github.com/Msgaihede/mtg-grimoire/issues/214). Ctrl/⌘-click builds a set of
cards, Shift-click takes a range, and a drag from any member carries the whole set.

**The shape of the change is additive.** `DragPayload`, `readDragData` and `dropWrite` do not
move: a group travels under a _second_ key beside the primary payload, so a drop target that has
not learned about groups still acts on the primary alone and behaves exactly as it does today.
That is what lets this land in steps without a flag day.

## Decisions taken before the first line

| Question              | Answer                                                                                       | Because                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Surfaces              | The deck editor's four views **and** the walls (`CardGrid`)                                    | The walls are one component behind search, collection, wishlist, tags and the deck's docked panel  |
| Beyond drag           | The card menus act on the set; Delete removes it **in the deck editor only**                   | No Delete binding exists anywhere today, and on a search wall "delete" names nothing               |
| The mark              | `SELECTED_CARD`'s gold ring for the whole set, plus a `3 cards` chip on the drag preview        | One vocabulary — gold already means _picked_ — and the chip says what you are holding mid-gesture  |
| Range wins over toggle | Ctrl+Shift **adds** the run to what was there; Shift alone replaces it                        | Windows Explorer's rule, which is the one every reader of this app already has                     |

**A cost this plan accepts rather than solves.** Undo is per-audit-entry in Rust (`deck_undo`),
so removing four cards writes four entries and putting them back is four presses of Ctrl+Z.
Batching it is a schema-and-command change well outside this issue. Record it in
`docs/reference/decks-live-findings.md` rather than hiding it.

## Steps

### 1. `src/lib/multiSelect.ts` — the algebra

Pure, no React, no store. A selection is an ordered key list and an anchor; keys are opaque
strings whose meaning belongs to the surface.

- `applySelect(selection, key, order, mods)` — the four cases in the table above
- `pruneSelection(selection, order)` — drop keys whose rows are gone, so a set that outlived a
  refetch never writes to a slot that no longer exists
- `readModifiers(event)` — `ctrlKey || metaKey` is toggle, `shiftKey` is range

Tested as a truth table. This is the file that draws the conclusions; everything below is wiring.

### 2. `src/lib/store.ts` — one scoped slice

`cardSelection: { scope, keys, anchor } | null`. `scope` is a string the surface owns
(`deck:12`, `search`, `collection`, `wishlist`, `tags`, `deck-panel:12`). A write from another
scope replaces the whole thing, so leaving a surface discards the set without anything having to
remember to clear it. `setActiveView` and `setOpenDeckId` null it in the same write that already
nulls `selectedCardId`.

### 3. `src/lib/useCardSelection.ts` — the hook every surface takes

`useCardSelection(scope, order)` returns `{ selected(key), keys, count, pick(key, event), clear }`.
`pick` returns whether the click was a _selection_ gesture — a plain click returns `false` after
collapsing the set to one key, and the caller then does what it always did (open the pane).

### 4. `src/features/decks/dnd.ts` — the group

- `dragData(payload, group?)` writes `dragGroup` beside the existing keys
- `readDragGroup(data)` → the group, or `[readDragData(data)]`, or `[]`
- `dropWrites(payloads, target)` → every write the drop means, refusals dropped
- `cardDraggable` / `composedDraggable` take an optional `group` and an optional preview

`canDrop` becomes "at least one member yields a write", so a mixed set dropped on the remove tray
takes the deck cards out and ignores the rest rather than refusing the gesture whole.

### 5. `src/lib/dragPreview.tsx` — the count chip

`setCustomNativeDragPreview` (present at
`@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview`), drawn only when the
group holds two or more. A single-card drag keeps the native preview it has today.

### 6. The deck editor

- `cardControl.tsx` — `useDeckCardDrag` carries the group; `deckCardProps` marks every member;
  `useCategoryDrop`'s `onDrop` takes `DeckWrite[]`
- the four views — the click's modifiers reach the editor, and the selected mark comes from the set
- `DeckEditor.tsx` — `applyDrops`, the `deck:<id>` scope over the flattened grouped order, the
  Delete binding
- `deckCardMenu.tsx` — `Remove`, `Move to`, `Finish` and `Tag` go plural when the right-clicked
  card is in the set
- `QuickZones.tsx`, `PriceStrip.tsx` — `onDrop(writes)`

### 7. The walls

- `CardGrid.tsx` — a `selectionScope` prop, opt-in exactly as `arrowNav` is. **`AllPrintingsDialog`
  passes none**: left/right and a click already mean something else inside that modal.
- `SearchPage`, `CollectionPage`, `WishlistGrid`, `TagResults`, `DeckSearchPanel` pass a scope
- `cardMenu.tsx` — the **writes** pluralise (`Add to → Deck/Collection/Wishlist`, the collection's
  `Move to → folder`). `Copy card image`, `Open on`, `View all printings` stay addressed to the one
  card that was right-clicked, because they cannot mean anything else.
- `useSidebarDrops.ts` / `AppShell.tsx` and the two folder walls accept a group

### 8. Verify

`npm run verify`, then a live CDP pass in the real window for the chords and a real multi-drag —
the class of thing the suite cannot see.
