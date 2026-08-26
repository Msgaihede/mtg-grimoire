# One dropdown

**Date:** 2026-08-25
**Status:** proposed
**Branch:** `worktree-unify-dropdowns`

The app draws option lists two ways. **23 native `<select>` elements across 13 files** are drawn
by WebView2 — a surface this app does not style, cannot lay out, cannot put a set symbol in, and
whose rows have no hover, no focus ring and no typeface anybody chose. **One hand-rolled listbox**,
`features/search/SetCombobox.tsx`, is drawn by the app: a searchable multi-select with the app's
own panel, its own rows and its own keyboard.

Counted at `2f8ff5c` on 2026-08-25. None of the 23 uses `<optgroup>`; none uses `multiple`. All 45
`<option>` bodies are plain strings.

This replaces the 23 with one component, and rebuilds the set picker on the same shell so there is
one dropdown in the app rather than two that have to be kept looking alike by hand.

---

## 1. What is being unified, and what is not

**In.** The 23 `<select>`s and `SetCombobox`.

| File | Controls | What they pick |
| --- | --- | --- |
| `features/search/FilterBar.tsx` | 2 | sort, format |
| `features/decks/DeckSettingsForm.tsx` | 4 | game, format, default category, folder |
| `features/decks/DeckEditor.tsx` | 3 | view, group by, sort by |
| `features/decks/FormatSelect.tsx` | 2 | format (two callers), game |
| `features/collection/CollectionFilterBar.tsx` | 2 | format, sort |
| `features/decks/CollectionSearchFilters.tsx` | 2 | format, sort |
| `features/transfer/import/destinations/CollectionPreview.tsx` | 2 | default condition, default finish |
| `features/card/CardDetailPane.tsx` | 1 | group printings by |
| `features/card/PrintingsFilterBar.tsx` | 1 | sort printings by |
| `features/collection/AddToCollection.tsx` | 1 | condition |
| `features/decks/CategoriesDialog.tsx` | 1 | where a deleted category's cards go |
| `features/transfer/import/destinations/WishlistPreview.tsx` | 1 | default finish |
| `features/wishlist/WishlistFilterBar.tsx` | 1 | sort |

**Out, and each for its own reason.**

- **`components/menu/`** — a right-click menu is a list of *actions*, not a value being picked.
  It has its own primitive, its own placement arithmetic and its own rules, all of which this
  shell borrows from rather than replaces.
- **`features/decks/QuickAdd.tsx`** — a typeahead over the whole card corpus. Its list is a
  *search result*, not a set of options, and it has no closed state showing a current value.
- **`components/AnchoredPopup.tsx`** — a small square trigger opening a panel that holds a
  *form*, not a list. It stays.
- **`components/FilterChips.tsx`** — chips are a row of toggles the reader sees all of at once,
  which is the opposite trade from a dropdown.

---

## 2. There is still nothing to install

`components.json` is configured for shadcn and `src/components/ui/` still does not exist. The
reason has not changed since the tooltip spec of 2026-08-20 wrote it down: the shipped CSP is

```
style-src 'self'; style-src-attr 'unsafe-inline'
```

and `devCsp` carries `style-src 'self' 'unsafe-inline'`. An overlay primitive that injects a
runtime `<style>` **element** — which every portalled Radix overlay in reach does, through
`react-remove-scroll` — is green under `tauri dev`, green in the suite, green in Storybook, and
blank in the packaged exe. `SetCombobox` and `AnchoredPopup` each rejected one in writing on those
grounds.

What `style-src-attr 'unsafe-inline'` *does* buy is the one thing this shell needs: an inline
`style` attribute is allowed, so a panel may be positioned from measured numbers.
`ContextMenu.tsx:789` already ships exactly that (`style={{ left, top }}` on a `fixed` panel).

---

## 3. The shell

```
src/components/Dropdown/types.ts              DropdownOption
src/components/Dropdown/usePopupPlacement.ts  measure, flip, correct the containing block
src/components/Dropdown/Dropdown.tsx          <Dropdown>, <MultiDropdown>, private <DropdownShell>
src/components/Dropdown/Dropdown.stories.tsx  the workbench
src/components/Dropdown/Dropdown.test.tsx     behaviour the suite can see
src/test-dropdown.ts                          pickOption(), for the 72 rewritten calls
```

Two exported components over one private shell.

```tsx
<Dropdown
  value={search.format}
  onChange={search.setFormat}
  options={formatOptions}
  label="Format"           // the accessible name; visible <label> callers pass labelledBy instead
  size="md"
  searchable                // optional
  align="start"
/>
```

```tsx
<MultiDropdown
  selected={selected}
  onToggle={onToggle}
  options={page}
  triggerLabel={label}      // "2 sets" — a multi-select's trigger says a count, not a value
  searchable
  query={query}             // controlled: the caller filters
  onQueryChange={setQuery}
  footer={footer}
  onReachEnd={revealMore}
/>
```

### The three props that let the set picker keep its complexity

`SetCombobox` is 640 lines and most of them are about *sets*: the session-cached `list_sets`
query, the `MAX_SETS` ceiling that mirrors `filters.rs`, the 100-row page with its 50-row step,
the keyrune glyph, `optionDisabled` greying, and the `pinned` snapshot that keeps the list still
under a press. **None of that moves into the shell.** Three props are the seam:

- **`query` / `onQueryChange` are optional and go together.** Absent, the shell owns the search
  box's state and filters by case-insensitive substring of `label` — which is the whole of what
  the 23 need. Present, **the shell filters nothing**: the caller has its own matching (the set
  picker's is name-contains, code-prefix, and a three-level rank) and hands down the page it wants
  drawn. One prop pair, and the shell never learns a second idea of what a match is.
- **`footer?: ReactNode`.** The cap sentence (`64 sets is the most one search can name`) and the
  `Show N more` control are the set picker's own and are drawn below the list.
- **`onReachEnd?: () => void`.** ArrowDown on the last row, or a second End, calls it. The shell
  does not know what "more" is; the set picker reveals another 50.

### The shell never sorts

Every call site already runs its list through `sortOptions` (`src/lib/options.ts`) and carries a
comment saying which rule it takes — the search filter bar pins `Any format` and `Any card`
outside the alphabet; `AddToCollection`'s condition grades run Near Mint → Damaged because **the
order is the information**; `DeckSettingsForm`'s folder paths arrive already ordered by the host
that made them. A shell that re-sorted would overrule all of them silently, and the exemptions are
precisely the cases nobody would notice breaking. **Callers pass the list in the order they want
it drawn**, as they do today.

### What the shell does own

- The trigger button, the panel, the search box, the rows, the empty line.
- The keyboard walk, `aria-activedescendant`, and type-ahead.
- Dismissal: Escape, outside `mousedown`, focus leaving the root.
- Placement.
- The two size recipes.

---

## 4. The option model

```ts
export type DropdownOption = {
  /** The value round-tripped to the caller. A string, because a select speaks strings. */
  value: string;
  /** What the reader sees, and what an uncontrolled search box matches against. */
  label: string;
  /** Drawn at the head of the row — the set picker's keyrune glyph, and nothing else today. */
  icon?: ReactNode;
  /** A dim, right-aligned second fact — the set picker's code. */
  hint?: string;
  /** Out of reach: FILTER_UNAVAILABLE, aria-disabled, and skipped by the keyboard walk. */
  disabled?: boolean;
  /** The row's tooltip, through useTooltip. Never its accessible name. */
  title?: string;
};
```

Six fields, and they cover all 24 controls with **no `renderRow` escape hatch** — which is the
point. A render prop is how two dropdowns start looking different again, and there is nothing in
the app today that needs one: all 45 `<option>` bodies are plain strings, and the set picker's row
is exactly `icon + label + hint + tick`.

**`disabled` keeps the three shapes it already has.** `FilterBar`'s format select greys formats
this search has nothing for; `CollectionFilterBar` and `WishlistFilterBar` each pin a disabled
`Custom…` row that is the *state of the control* rather than an order to pick, shown only while
the sort came from a column header. Both survive as `{ value: "", label: "Custom…", disabled: true }`
passed first, and both keep the comment explaining why.

**The house rule against `disabled` gets its exception back, one level up.** `<option disabled>`
was the rule's one exception because the reason behind the rule — a disabled control leaves the tab
order — is about something that was in it to begin with, and an `<option>` never is. A shell row is
not in the tab order either (rows are walked by `aria-activedescendant`, not focused), so the same
argument carries: rows take `aria-disabled` and the pointer/keyboard both refuse them, which is
`SetCombobox`'s `canToggle` shape today.

---

## 5. Placement

`usePopupPlacement(triggerRef, panelRef, open)` returns `{ left, top, minWidth, flipped }`.

**Sizes come from `offsetWidth`/`offsetHeight`; positions come from `getBoundingClientRect()`.**
Not interchangeable here, and the confusion has already cost this repo a session: `popup` holds
the panel at `scale: 0.96` for the length of its entry tween, so a rect taken on the mount frame is
4% short — measured on 2026-08-22 in the shipped window, applying that scale to `AnchoredPopup`'s
open panel dropped the scroller's `scrollTop` maximum from **257 to 246**, and no scroll margin
could recover it. `offsetHeight` is the layout box and is unaffected by transforms.

**Flipped against `document.documentElement.clientWidth`/`clientHeight`, never `innerWidth`.**
That is `menu/panel.ts`'s rule and this is its third instance: `innerWidth` includes the scrollbar,
so a panel flipped against it sits under one.

**A zero-size `fixed` frame is the containing-block correction, and it is not optional.**
`position: fixed` is viewport-relative only while no ancestor carries a `transform`, `scale`,
`rotate`, `translate`, `filter`, `contain` or `backdrop-filter`. `Dialog`'s panel animates through
the `dialog` preset — `scale: 0.97 → 1` — and motion leaves the `scale` longhand on the element at
rest. **`scale: 1` is not `none`**, so a settled dialog panel is a containing block, and eight of
the 23 controls live inside one. `TheoryDiffDialog.tsx:358` and `menu/panel.ts` both already record
this trap for their own elements.

The shell therefore renders

```tsx
<div ref={frameRef} className={cn("fixed left-0 top-0 size-0", LAYER.popup)}>
  <PopupPanel style={{ left, top }} className="absolute …">
```

and reads `frameRef.current.getBoundingClientRect()` to learn where the containing block's origin
sits in viewport coordinates. `left`/`top` are the target viewport position minus that origin. No
enumeration of causes, no walk up the ancestor chain, and the panel's own transform stops mattering
because the panel is `absolute` inside a frame that has none.

The one case this does not cover is an ancestor mid-tween whose transform is not a pure translation
— a dialog at `scale: 0.97` on its way in. A dropdown cannot be open then: the dialog's own entry
tween finishes before anything inside it can be pressed.

**`min-width` is the trigger's width**, so a picker never opens narrower than the control that
produced it. `SetCombobox` keeps its 288px through an explicit `panelClassName`.

**Horizontal:** pinned to the trigger's left edge, flipped to right-aligned when
`left + panelWidth > clientWidth - GUTTER`. **Vertical:** below the trigger, flipped above when
`bottom + panelHeight > clientHeight - GUTTER`. `origin-top-left` / `origin-top-right` /
`origin-bottom-*` follow the pinned corner, which is this app's standing rule for an anchored
popup: *the corner it is pinned by is the corner it grows from*, or the panel reads as unrelated to
the control that opened it.

`align` survives as a prop for the callers that already know better than the measurement — the two
search-shaped set pickers pass `"end"`, `AllPrintingsDialog` passes `"start"` — and it seeds the
first guess that the flip may still override.

**Closes on scroll, repositions on resize.** A `scroll` listener in the capture phase (so an inner
scroller counts) closes the panel; `resize` recomputes. A trigger that scrolls out from under an
open panel leaves an orphan otherwise, and a dropdown is open for about two seconds. This is
`ContextMenu`'s choice for the same reason.

---

## 6. Keyboard, ARIA, dismissal

Lifted from `SetCombobox` because it is already right, and it is what the dependency would have
provided:

- A disclosure `<button>` carrying `aria-haspopup="listbox"` and `aria-expanded` — **not** the
  combobox itself. On a `searchable` dropdown the combobox is the text field the button reveals,
  which is where the caret goes and what `aria-activedescendant` is read from.
- The caret moves into the panel on open. Escape hands it back to the trigger, because an element
  that unmounts with focus on it drops the caret to `<body>` and the next Tab restarts from the top
  of the app. An outside click deliberately does not: the reader is already somewhere else.
- `useDismissOnEscape({ layer: "inner", enabled: open })`, registered **on the flag** rather than
  on the panel's mount — the panel outlives `open` by the length of its fade.
- Rows are `role="option"` inside a `role="listbox"`, with `onMouseDown` prevented so a pointer
  never steals the caret from the arrow keys mid-gesture.
- The exiting panel is `aria-hidden` and `pointer-events-none` from the render that starts the
  fade. `PopupPanel` already owns this and is reused unchanged.
- ArrowDown, ArrowUp, Home, End, Enter, Escape. On a single-select, Enter picks and closes; on a
  multi-select it toggles and leaves the panel open.

Two additions.

**Type-ahead on a closed trigger.** A printable character opens the dropdown and lands on the
first label match — what a reader's fingers already know from every native select on the OS, and
what all 23 of these did until today. On a `searchable` dropdown the character goes into the search
box instead, which is the same gesture arriving at the same place. The buffer clears after ~600ms
of no typing, matching the platform.

**`ownsArrowKeys` has to change in the same commit, and it is the one edit both suites are blind
to.** `AllPrintingsDialog.tsx` walks card-to-card on ArrowLeft/ArrowRight and exempts elements
that own the arrow keys — naming `<select>` explicitly, because ArrowLeft on a focused select
changes its value in Chromium and WebView2 alike, so a reader narrowing the wall by set would step
to the next card instead. After this refactor **none of the elements it names is a select any
more**. The predicate must recognise an open dropdown (`[aria-expanded="true"][aria-haspopup="listbox"]`,
and the panel's own subtree) or the printings modal's walk starts fighting its filter row. jsdom
will not catch it and neither will Storybook.

---

## 7. Geometry

| `size` | classes | callers |
| --- | --- | --- |
| `md` (default) | `h-9 rounded-md border text-sm` | filter rows, dialog forms, deck editor toolbar |
| `sm` | `h-8 rounded-md border text-xs` | card detail pane header, both import previews |

`md` **is** `FILTER_SHAPE` — the string `FilterChips.tsx` keeps private so every control in a
filter row shares a line. A dropdown that invented its own height would sit 2px off the chips
beside it, which is the failure that constant exists to prevent.

Four geometries exist today and two of them change:

| today | file | becomes |
| --- | --- | --- |
| `h-9 text-sm` | `FilterBar`, `CollectionFilterBar`, `CollectionSearchFilters`, `WishlistFilterBar` | `md`, unchanged |
| `h-9 text-xs` | `DeckEditor`'s `CONTROL` | `md` — **text grows 12→14px** |
| `h-8 text-xs` | `CardDetailPane`'s `CONTROL` | `sm`, unchanged |
| `h-8 text-sm` | both import previews | `sm` — text shrinks 14→12px |

**The deck editor toolbar is the risk, and it cannot be settled on paper.** `QuickZones.tsx:161`
records a toolbar `<select>` hanging **66px** past its row at both 1024 and 1920. Three pickers on
that toolbar gaining 2px of font each is exactly the kind of change that reopens it. Measuring it
in the shipped window at 1024 and 1280 is an acceptance step, not a nicety; if it overflows, that
whole toolbar takes `sm` and the buttons beside it follow, and the reason is written at the call
site.

Three private class recipes are deleted on the way through: `DeckEditor`'s `CONTROL`,
`CardDetailPane`'s `CONTROL`, and `FormatSelect`'s one-file `<select>` recipe — plus the four
hand-written class strings in the two import previews.

---

## 8. Migration

**13 files, 23 controls, fanned out after the shell lands.** Two subagents editing one tree clobber
each other, so each takes files no sibling touches, and the suite runs once at fan-in rather than
inside each.

**72 `userEvent.selectOptions` calls across 25 files, 10 of them Storybook play functions.** There
is no way to keep them: a native option list cannot be styled, and a visually-hidden mirror
`<select>` kept in sync would put two comboboxes in the accessibility tree and make every
`getByRole("combobox")` ambiguous.

They go through one helper, `src/test-dropdown.ts`, beside the existing `src/test-drag.ts` which is
the precedent for exactly this:

```ts
/** Open a dropdown by its accessible name and pick the row whose text is `label`. */
export async function pickOption(user: UserEvent, name: string | RegExp, label: string | RegExp)
```

72 call sites become one-line swaps, and the next change to the shell's internals is one edit
rather than a 25-file sweep. **Story plays are their own fix round**: `stories.test.tsx` collects
the whole tree, so a play cannot be verified inside a fan-out — they are checked and repaired by
the controller after the merge.

`SetCombobox`'s existing test file and stories are the fence for its rewrite. They go **unchanged**
where they can, and every one that has to change is a place where the rewrite altered behaviour —
which is the signal worth having.

---

## 9. What the suite cannot see

jsdom has no layout engine. **Nothing in the suite can go red for the placement, the flip, the
containing-block correction, the min-width, or the toolbar's overflow.** The suite pins what opens,
what the keyboard does, which row is active, and what value comes back — and that is the whole of
its reach.

A CDP pass in the shipped window is the only witness for the rest, and it needs at minimum:

1. A dropdown near the **bottom** of the window — does it flip above rather than run off?
2. One inside the import preview's `overflow-y-auto` — does it escape the scroller?
3. One inside a `Dialog` — does the containing-block correction land it on the trigger?
4. The **deck editor toolbar at 1024 and 1280** — section 7's open question.
5. The set picker, unchanged in behaviour: 1 047 sets, the page cap, the footer, the tick column.

`docs/reference/live-ui-verification.md` is the harness contract.

---

## 10. Success criteria

- One component draws every dropdown in the app. `grep -rn "^\s*<select" src --include=*.tsx`
  returns nothing outside the shell's own tests.
- `SetCombobox` still does everything it does today — the cap, the paging, the glyphs, the
  greying, the pinned snapshot — and its own test file says so.
- Any dropdown can be given a search box with one prop, and none has one it was not given.
- `npm run verify` is green, and `cargo fmt` and `cargo clippy` with it.
- The five live checks in section 9 pass in the shipped window, with the readings written into
  `docs/reference/frontend-design.md`.
