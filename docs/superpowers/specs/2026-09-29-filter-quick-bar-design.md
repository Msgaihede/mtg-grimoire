# The filter quick bar — design

**Date:** 2026-09-29 · **Canvas:** https://claude.ai/artifact/PXnLSk6oqFPjxYazsbEPrQ (the
`QuickBar.dc.html` board is the component; `Main`, `TrayOpen`, the four `Rung*` boards and
`Collection` / `Wishlist` / `Tags` are the pages).

## 1. What it is

A single-row toolbar that docks at the top of `AppShell`'s `main` once a page's filter row has
scrolled out of view, carrying that row's filters so a reader deep in a wall can narrow it without
scrolling back up. It is the deck editor's undocked bar (issue #577, `DeckHeaderBar`) drawn for
the filter row: the same 53px surface strip, the same shadow, the same slide-down, the same `Top`.

It goes on **four pages**: card search, the collection, the wishlist and Tags.

**Grid view only, on every page.** In table view each page's section is `h-full` and the table is
its own scroller (`VirtualTable`), so the filter row never leaves the screen and there is nothing
to dock. The bar is fenced on `view === "grid"` rather than left to discover that.

## 2. When it shows

- **The trigger is the whole `FilterBar` block** — its root `div`, which holds the row, the open
  tray, the "Filtering by" line and `TagQueryRow`. The bar comes down when that block's bottom edge
  is at or above the scroller's top, and goes when any of it is back. `useUndocked` answers exactly
  that with an `IntersectionObserver` and re-renders only on the flip.
- **It stays while the caret holds it** — a text field inside it has focus, or the reader is on
  the keyboard (`KEYBOARD_MODALITY_ATTR`). The deck bar's `holdsBar` rule, for the deck bar's
  reason: a bar that vanishes under a caret takes the caret with it.
- It never shows in table view (§1), and under jsdom it never shows at all (the stub observer
  never fires) unless a test installs a driven observer.
- **A changed search starts the wall at the top** (`CardGrid`'s `listKey` reset), so a chip
  pressed in the bar scrolls the page row back into view and the bar leaves — the reader lands on
  the page row showing the same state, over the new first results. That is the intended outcome,
  not a flicker to suppress. Typing does not do it to the reader mid-word: the caret holds the bar.

## 3. Geometry and look

Everything here is the deck bar's, moved to a shared module (`components/DockedBar.tsx`) so the
two bars cannot drift:

- A `sticky top-0 left-0 h-0` wrapper as the **first child of the page's section**, with a
  negative bottom margin equal to that section's `gap` so it costs no layout. The panel inside is
  `absolute`, `top/left/right: -20px` (`main`'s `p-5`), `height: 53px`, `padding-inline: 20px`,
  `border-b border-border bg-surface py-2`, and the three-layer docked shadow.
- Enter/exit is `dockBar` from `lib/motion.ts` (slides from `-100%` with a fade).
- Controls are 36px (`h-9`). Presses are `text-xs`. Hairline dividers are `h-5 w-px bg-border`.
- Colour chips and the Within/Exact chip are **32px** (`size-8`) with the ring offset on
  `surface` (the bar's fill) rather than `bg`. Mana-value chips are `size-8`. The page row keeps
  its 36px chips.
- **A new layer rung, `LAYER.quickBar` (`z-35`)**: the tray hangs from the bar over the
  collection's and wishlist's docked search column, which is `LAYER.popup` (`z-30`) when it
  overlays the list and comes **later** in the DOM, so at an equal rung the column would paint
  through the tray. Below `dragTray` (`z-40`) and every dialog.

## 4. Contents, left to right

1. **Top** — `ArrowUpToLine`. Scrolls `main` to 0 (smooth unless reduced motion) and puts the
   caret in the page's own search field (`#${labels.idStem}-text`), `preventScroll`.
2. **Lead** — a page's own slot, followed by a divider. Only Tags uses it (§6.4).
3. **Search** — the page's text, bound to the same `search.text` / `setText`. `bg-bg` field with a
   `Search` glyph, placeholder `${labels.search}…`, Escape clears. It is the one control that gives
   up width: `flex-1 basis-50 min-w-30`, capped at `max-w-70` (`max-w-90` at the widest rung).
4. **Colour identity** — six `ManaChip`s and `ColorExactChip`, with the page row's facet greying.
5. **Mana value** — `ManaValueChips` inline, or folded (§5) into one press that opens them in an
   `AnchoredPopup`. The press reads `Mana value` and the picked values (`4, 5`, with `X` last) in
   mono, gold while any is picked.
6. A flexible gap (`min-w-2 flex-1`).
7. **Filters** — `FiltersButton`, same count, opens the tray **under the bar** (§7).
8. **Sort** — the page's sort `Dropdown` and the direction arrow, exactly as the row draws them.
9. **Reset all** — `aria-disabled` and dimmed at zero, the count badge otherwise.

## 5. One row at every width

The bar is its own container (`@container/qb`), and the rung is the **content box** width —
`main`'s content width, since the panel's padding restores `main`'s 20px:

| Rung | Content width | What changes |
| --- | --- | --- |
| widest | ≥ 1500 | `Top`, `Filters` and `Reset all` carry their words; search caps at 360 |
| wide | 1100 – 1499 | words go (icons with names and tooltips); mana values inline |
| normal | 860 – 1099 | mana values fold into the `Mana value` press |
| tight | < 860 | sort leaves the bar |

Reference windows: 1920 → ~1672 content (widest), 1440 → 1192 (wide), 1024 with the sidebar
collapsed → 916 (normal), 1024 → 776 (tight). **Tags folds its mana values one rung earlier**
(below 1500), because its picked tags take ~250px of the row.

## 6. Per page

The bar takes the same `search`, `labels`, `sortRows` and `tray` its page hands its `FilterBar`, so
it can never offer a filter the page row does not.

### 6.1 Card search
Nothing else. Section gap is `gap-4`, so the wrapper is `-mb-4`.

### 6.2 Collection and 6.3 Wishlist
- **The shelf bar stacks under the quick bar.** `CardGrid` grows a `stickyTop` offset: while the
  bar is down the shelf anchor's `top` is `53 − stickyInset` (flush under the bar) instead of
  `−stickyInset`, and `stickyShelfAt` measures from the same edge, `scrollOffset + 53`, so the bar
  names the shelf that is actually under it.
- **The shelf bar drops its own `Top` while the quick bar is down** — one `Top` on screen.
  `ShelfStickyBar`'s `onTop` becomes optional and the button is not drawn without it.
- **The docked search column starts under the bar**: its dock's `top` is `41px` (53 − 20 + 8,
  the deck bar's clearance) and `useDockHeight` is handed the same number, as the deck editor does.
- Section gap is `gap-3`, so the wrapper is `-mb-3`. The bar is the section's first child, above
  the figures band.

### 6.4 Tags — becomes one scrolling page in grid view
- **In grid view the section is no longer `h-full`**, the wall is `CardGrid grow` and `main`
  scrolls the page, exactly as card search does. Table view is unchanged (section `h-full`,
  bounded rail, `VirtualTable` its own scroller).
- **The rail pins**: `sticky self-start`, `top` = the same 41px clearance while the bar is down
  (0 otherwise), height from `useDockHeight(railRef, bodyRef, top)`, so its tree still scrolls in
  its own box while the wall scrolls the page beside it.
- **The picked tags ride in the bar as its lead**: `TagChips` with a new `singleLine` prop — one
  unwrapped line that scrolls sideways with its scrollbar hidden, capped at `min(28rem, 32%)` —
  and no `onFloorChange` (the background toggle stays on the page row). Empty, it reads
  `No tags picked`. Include/exclude and remove work from the bar.

## 7. The tray under the bar

- Pressing `Filters` in the bar opens the page's `FilterTray` (same cells) in a box hanging 8px
  below the bar, inset 20px each side, scrolling inside itself past `100vh − 12rem`, with the
  docked shadow. The page's own tray keeps its own open state — the two are independent.
- It closes on `Filters` again, on Escape (an `inner` dismiss layer, so an open set picker inside
  it closes first), and on a pointer press outside the bar. Escape returns the caret to `Filters`.
- It unmounts with the bar.

## 8. Accessibility

- The bar is `role="group"` named **`Filter quick bar`**. Its controls use `aria-label`, never the
  page row's `id`s; the sort's hidden label is `${idStem}-qb-sort-label`, so nothing collides.
- While the bar is down, `main` carries `scroll-padding-top: <main's padding> + 41px` (WCAG
  2.4.11): a caret walking the wall must not land under the bar. The deck editor's effect for
  this becomes `lib/useScrollPaddingTop.ts`, used by both.

## 9. Out of scope

Table views (§1); the docked search columns' own narrow filter rows (they never scroll away — the
column is pinned); the deck editor's bar (unchanged except that its primitives move to
`components/DockedBar.tsx`).

## 10. How it is tested

- `useFilterQuickBar` against a driven `IntersectionObserver` (the one `useUndocked.test.ts`
  installs): hidden in table view, shown when the row crosses, clearances and scroll padding.
- `FilterQuickBar` rendered with `shown`: the controls reach the shared `search`, Top scrolls and
  focuses the page field, the tray opens/closes (button, Escape, outside press), Reset is
  disabled at zero, the lead renders, the fold press opens the mana values.
- `CardGrid`'s `stickyTop` sets the anchor's `top`; `ShelfStickyBar` without `onTop` has no Top.
- The rungs, the stacking and the Tags scroll are container-query and sticky layout that jsdom
  does not compute: **verified in the running app over CDP**, at 1920, 1440 and 1024.
