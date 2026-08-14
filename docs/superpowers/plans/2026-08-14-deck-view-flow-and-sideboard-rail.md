# Deck views: columns flow down, the sideboard stays on the right

**Spec basis:** `docs/superpowers/specs/2026-08-04-mtg-collection-tracker-design.md` §7 (the
editor's three-part desk) and the app's own floor — no horizontal scrollbar at 1024px.

## The problem

`StackView` and `TextView` both lay a deck out as fixed-width columns inside a
`flex … overflow-auto` row. `packColumns` caps each column at the desk's height and then opens
another one **to the right**. A deck with more categories than a window is wide therefore grows
sideways, and the reader gets an X scrollbar across the whole desk — the one thing the 1024px
floor in `DeckEditor`'s `DECK_FLOOR` was written to prevent, arriving by a route that floor
never measured.

`StackView.tsx`'s own comment says it out loud: *"Scrolls both ways: sideways because a
fifteen-category deck is more columns than a window is wide."*

The Sideboard makes it worse. It is a category like any other, so the greedy in-order pack drops
it wherever it lands — usually the far right of a long sideways run, i.e. off screen.

## The shape of the fix

**Columns wrap instead of running off the edge.** The row of packed columns becomes a
`flex-wrap` container: when the next column will not fit, it goes *below* the first row of
columns and the reader scrolls **down**, which the desk already does.

**The Sideboard is lifted out of the flow entirely** and drawn as its own column, pinned to the
right of the wrapping area. It is never packed, never reordered into somebody else's run, and
never wrapped away from the right edge while there is room for it.

**Room is decided by CSS, not by a measurement.** The flowing area carries a `minWidth` of one
column, so when the desk is too narrow to hold a column *and* the rail side by side, the outer
container's own `flex-wrap` drops the rail onto the next line rather than producing the X
scrollbar this whole change exists to remove. `min-w-0`/`flex-1` cannot express that; a
`ResizeObserver` inside the view could, and is refused — `StackView`'s doc is explicit that this
view has no business observing its own box.

## Global constraints

- **`packColumns` keeps its contract**: greedy, in the reader's order, never reordering, never
  splitting a group, an over-tall group gets a column of its own. Nothing in this change touches
  its body.
- **A column width is an inline style, never an interpolated Tailwind class** — the scanner reads
  source text, so a computed class emits no rule at all (`src/CLAUDE.md`). Both halves of the
  `flex` shorthand and the `width`.
- **Zoom reaches every derived number.** `stackColumnWidth(zoom)` sizes the column, the flow
  area's `minWidth` and the rail alike — three reads of one number, not three numbers.
- **Chrome around a card does not zoom** (`SECTION_PADDING`, the border, the gaps).
- **`aria`, drop targets and the group's markup are unchanged.** A group in the rail is the same
  `StackGroup`/`TextGroup` as a group in the flow, so a drop into the Sideboard keeps working
  without a second definition.
- Tailwind v4 utility classes only; no new dependency.

## Task 1 — `splitSideboard`, in `views/columns.ts`

Files: `src/features/decks/views/columns.ts`, `src/features/decks/views/columns.test.ts`.

Add, beside `packColumns` and documented in the same register as the file around it:

```ts
/** How a test finds the rail the Sideboard is drawn in — the reason `STACK_COLUMN_ATTR`
 *  is an attribute rather than a role, for the same reason. */
export const SIDEBOARD_ATTR = "data-sideboard-rail";

/**
 * The groups that flow, and the ones that are pinned to the right.
 *
 * `kind === "side"` and nothing else: the name is the user's — `DECK_CATEGORY_GRAIN` lets
 * them call any pile "Sideboard" — and the kind is what the rules read.
 */
export function splitSideboard<T extends { kind: CategoryKind | null }>(
  groups: readonly T[],
): { flow: T[]; sideboard: T[] };
```

- Generic on a structural `{ kind }` rather than taking `CardGroup`, so this file stays what its
  header says it is: how the two column views arrange things, knowing nothing about a deck
  beyond the one word it splits on. `CategoryKind` is a `import type` from `@/lib/ipc`.
- Order is preserved inside both halves.
- Tests, in `columns.test.ts`'s existing style (plain literal items, not built `CardGroup`s):
  - splits a `side` group out and leaves the rest in order
  - keeps a **derived** group (`kind: null`) in the flow
  - carries **every** `side` group to the rail, in order, when there is more than one
  - answers two empty arrays for no groups, and an empty `sideboard` for a deck with no
    sideboard category

## Task 2 — `StackView` flows and grows a rail

Files: `src/features/decks/views/StackView.tsx`, `src/features/decks/views/StackView.stories.tsx`.

`splitSideboard` and `SIDEBOARD_ATTR` are being added to `./columns.ts` by a sibling task with
the signature above — **import them; do not write them.**

The root becomes two boxes inside the scroller:

```tsx
<div ref={scrollRef} className={cn("flex min-w-0 flex-1 flex-wrap items-start gap-4 overflow-auto pb-2", className)}>
  <div style={{ minWidth: columnWidth }} className="flex flex-1 flex-wrap content-start items-start gap-4">
    {columns.map(…)}   {/* unchanged: STACK_COLUMN_ATTR, the inline width, the flex basis */}
  </div>
  {sideboard.length > 0 && (
    <div
      {...{ [SIDEBOARD_ATTR]: "" }}
      style={{ width: columnWidth, flex: `0 0 ${columnWidth}px` }}
      className="ml-auto flex flex-col gap-5"
    >
      {sideboard.map((group) => <StackGroup … />)}
    </div>
  )}
</div>
```

- `packColumns` is fed **`flow`**, not `groups`.
- `items-start` on both containers: without it a column stretches to its flex line's height and
  the switched-off pile's dashed border grows to the tallest thing beside it.
- `content-start` so wrapped lines sit at the top of the box rather than being spread down it.
- `ml-auto` on the rail is a no-op while the flowing area is `flex-1` and does the work in the
  one case that matters — when the rail has wrapped onto its own line and should still be on the
  right.
- `overflow-auto` stays rather than becoming `overflow-y-auto`: one column zoomed past the whole
  desk's width is genuinely wider than its box, and clipping a card is worse than a scrollbar
  the reader asked for. Wrapping is what makes that case rare instead of ordinary.
- Update the root's comment — it currently explains why the view scrolls sideways, which is now
  the thing it does not do.
- Stories: add one that shows the wrap (many groups in a short, narrow decorator) and one that
  shows the rail beside the flow. Keep `Default`, `NarrowColumns`, `ByManaValue`, `ByType` and
  their `play` assertions working.

## Task 3 — `TextView` flows and grows a rail

Files: `src/features/decks/views/TextView.tsx`, `src/features/decks/views/TextView.stories.tsx`.

The same change, with this view's own numbers: `COLUMN_WIDTH` is the fixed `18.75rem` and does
not zoom, so the flowing area's `minWidth` and the rail's width are both that string. Same
imports from `./columns`, same `ml-auto`, same `items-start`/`content-start`, same rule that
`packColumns` is fed `flow`. Add a story for the wrap and one for the rail.

## Task 4 — the view tests

File: `src/features/decks/views/views.test.tsx`.

The existing `StackView columns` block keeps passing unchanged — its fixtures are Commander,
Ramp and Maybeboard, none of them `side`. Add, in that file's register (a comment that says what
the failure would look like, not what the code does):

- A `side` category is **not** packed into a column: with a Sideboard between two other
  categories, `[data-stack-column]` holds the other groups in order and the Sideboard's heading
  is inside `[data-sideboard-rail]`, not inside any column.
- The rail is drawn for an **empty** Sideboard too — an empty pile is where the next sideboard
  card goes, and a rail that appeared with the first card would move the whole layout under the
  reader's hand.
- The rail carries the zoomed column width, inline, both halves of the shorthand (StackView).
- The same two claims for `TextView`, whose rail is the fixed `18.75rem`.
- The flowing area carries a `minWidth` of one column — the thing that makes the rail wrap
  instead of forcing a sideways scroll.
- Neither view renders a rail when no group has `kind: "side"`.

Use the existing `category()`/`card()` helpers and `buildGroups`; add a `SIDE` category beside
`RAMP`, `COMMANDER` and `MAYBE` rather than reshaping the ones already there.

## Task 5 — the record

Files: `src/features/decks/CLAUDE.md`, `docs/reference/frontend-design.md`.

- `src/features/decks/CLAUDE.md`, in **Views and interaction**: the columns wrap rather than
  running sideways; the Sideboard is lifted out of the pack and pinned right; the narrow case
  drops the rail below rather than reintroducing the scrollbar; `packColumns` still never
  reorders what it is given, and it is simply given less.
- `docs/reference/frontend-design.md`: the same rule as a layout law with its reason — a fixed
  column layout that grows sideways is an X scrollbar with extra steps, and the app's floor is
  1024px wide.
- Re-count anything either file states as a number if this change moves it (a prose-only edit
  routes to neither CI job, so nothing goes red when a document rots).
