# The app draws its own tooltips

**Date:** 2026-08-20
**Status:** proposed
**Branch:** `worktree-tooltip-element`

Every hint in this app is a native `title` attribute or an SVG `<title>` element — 102 of the
first across 48 files and 8 of the second, measured at `06572dc`. The browser draws all of them,
which means the app has one surface it does not style, cannot lay out, cannot put a mana symbol
in, and whose text nobody can select or copy. It is also the only surface here with a delay and
a typeface nobody chose.

This replaces the lot with one component: a tooltip the app draws, in the app's own panel, with
text that can be selected where the caller asks for it.

---

## 1. There is nothing to install

`components.json` is configured for shadcn (`style: "radix-nova"`), and it has never been used:
**`src/components/ui/` does not exist**, nothing in `src/` or `.storybook/` imports
`@/components/ui`, and there is no `@radix-ui/*` in `package.json` or in `package-lock.json`. The
`shadcn` devDependency is a CLI with nothing installed through it.

Two reasons not to start now, and only the first is about this repo:

**The shipped CSP.** `SetCombobox.tsx` and `AnchoredPopup.tsx` each rejected a portalled Radix
overlay in writing, on the grounds that the packaged app runs under
`style-src 'self'; style-src-attr 'unsafe-inline'` — an injected `<style>` **element** is blocked,
and it is blocked *only in the shipped exe*, because `devCsp` carries `'unsafe-inline'`. An
overlay primitive that fails this way is green through `tauri dev`, green through the suite, green
through Storybook, and blank for the reader.

**A tooltip you can select text in is not what Radix's Tooltip is.** Its content is not intended
to be interactive; the interactive-content answer in that library is HoverCard, which has no
keyboard-focus trigger. The one thing this task exists to do is the thing that component
documents itself as not doing.

So: our own, built on what is already here — `menu/ContextMenuProvider` for the shape,
`menu/panel.ts` for the placement arithmetic, `lib/motion.ts`, `lib/layers.ts`, `lib/focus.ts`.

---

## 2. One provider, one panel, at the root

```
src/lib/tooltip.ts                        placeTooltip() — pure arithmetic
src/components/tooltip/tooltipStore.ts    the vanilla store: which tooltip is open
src/components/tooltip/TooltipProvider.tsx  timers, pointer bridge, dismissal, the layer
src/components/tooltip/TooltipPanel.tsx   the panel itself
src/components/tooltip/useTooltip.ts      the binder hook
```

`<TooltipProvider>` goes in `src/App.tsx`, outside every transform, and renders **at most one
panel** as a sibling of the whole app. That is `ContextMenuProvider`'s shape and it is chosen for
the same reason plus one more:

**Mount point is what escapes the clipping.** A virtualised row is `position: absolute` *and*
`transform`ed, so it caps every `z-index` inside it and becomes the containing block for every
`position: fixed` descendant — `layers.ts` and `menu/panel.ts` both say so, and `PrintingPreview`
pays for it with `frame.scrollTop` / `clientLeft` arithmetic to place one preview. A panel whose
DOM node lives at the app root is outside every transform and every `overflow-hidden` scroller by
construction, and needs none of that. Doing it the other way — a panel per trigger, anchored in
the cascade — means inheriting that arithmetic at 102 call sites, and **jsdom has no layout
engine, so nothing in the suite could go red when one of them is clipped.**

**The state is a vanilla zustand store created by the provider, not its `useState`.** This is
`ActivityProvider`'s pattern and here it is load-bearing rather than tidy: a `useState` in a
provider wrapping the whole app would re-render the entire application on every pointer-enter and
every pointer-leave, which for a surface driven by hover is the worst possible place to put state.
The context value is the store, so its identity never changes and no consumer re-renders; only
the panel subscribes.

### The layer

One new rung in `lib/layers.ts`:

```ts
/** The one tooltip, over anything a view or a dialog draws — and under a sync taking the window. */
tooltip: "z-46",
```

Above `overlay` (45) because a tooltip is shown over the deck editor's dialogs; below `gate` (50)
because `SyncProgress` covers the window and a hint floating over it would be a hint about
something the reader cannot see. `layers.test.ts` sweeps `src/` for raw z-indexes, so it has to
be an entry rather than a class.

### The placement

`src/lib/tooltip.ts`, one pure function, sibling to `placeMenu`:

```ts
export type TooltipSide = "top" | "bottom" | "left" | "right";

export function placeTooltip(
  anchor: DOMRect,
  size: { width: number; height: number },
  side: TooltipSide,
): { left: number; top: number; origin: string };
```

Preferred side first; flip to the opposite when it does not fit; clamp along the other axis to the
viewport with the same `MENU_EDGE_GUTTER` the menus use. `origin` is one of the four whole
`origin-*` literals — never interpolated, because Tailwind scans source text.

**It is pure for `shouldFlipUp`'s stated reason: every rectangle in jsdom is zero, so a component
test of a flip passes over any arithmetic at all.** Its tests hand it fabricated rects.

---

## 3. The binder

```ts
const tip = useTooltip();

// today                                      // after
<span className="truncate" title={row.setName}>   <span className="truncate" {...tip(row.setName, { whenClipped: true })}>
<button title="Duplicate">                        <button aria-label="Duplicate" {...tip("Duplicate", { describes: false })}>
```

```ts
export interface TooltipOptions {
  /** Preferred side. Flipped by `placeTooltip` when it does not fit. Default `"top"`. */
  side?: TooltipSide;
  /** The pointer may enter the panel and the text may be selected. Default `false`. */
  interactive?: boolean;
  /** Open only when the anchor's own text is actually cut off. Implies `describes: false`. */
  whenClipped?: boolean;
  /** Wire `aria-describedby` while open. Default `true`. */
  describes?: boolean;
}

export function useTooltip(): (content: ReactNode, options?: TooltipOptions) => TooltipBinding;
```

`TooltipBinding` is `onPointerEnter`, `onPointerLeave`, `onFocus`, `onBlur` — and nothing else.

**No ref, because the anchor is `event.currentTarget`.** That is the whole reason this is a spread
rather than a wrapper component: it adds no DOM node, so it cannot break a `min-w-0` chain in a
truncating flex cell or displace an absolutely positioned card corner, and the edit at each of the
102 sites is one line where one line stands today.

**`content` of `null` or `undefined` returns `{}`**, so `tip(cond ? words : undefined)` is inert —
the same shape as today's `title={… ?? undefined}`, which nine sites already use.

`whenClipped` compares `scrollWidth` to `clientWidth` on the anchor at pointer-enter and does
nothing when they agree. That is what makes the truncation group — the largest one — free on a
virtualised table: no measurement, no state and no subscription per row, only a handler that
usually declines. (Width only. Every current site is `truncate`; a line-clamped one would need the
height comparison and there are none.)

---

## 4. What a tooltip means to a screen reader

`title` does two jobs at once, and deleting it deletes both. Measured at `06572dc`: **27 of the
102 sit on a `<button>`, and 12 of those carry no `aria-label` on the same element.** Most of the
twelve have visible text, but `CollectionTable.tsx:230` (`"Remove from your collection"`) and
`WishlistTable.tsx:212` are icon-only — delete the attribute and those buttons have no accessible
name at all, and **nothing in the suite goes red for it.**

So the sweep classifies each site, and the option it picks is the classification:

| The words are… | What the site does |
| --- | --- |
| the element's **only** name | add `aria-label`, bind with `describes: false` — otherwise a reader hears "Duplicate, Duplicate" |
| a **description** of something already named | the default: `aria-describedby` while open |
| **redundant** — `whenClipped`, or a mark whose words are already visible text | `describes: false`; the panel is `aria-hidden` |

`aria-describedby` is set on the anchor **imperatively by the provider** when a tooltip opens,
pointing at the panel's stable id, and the previous value is saved and restored on close. Not by
re-rendering the trigger: four hundred rows subscribing to a store to learn they are *not* the
open one is exactly the cost the singleton exists to avoid. React does not manage that attribute
on these elements, so it will not fight over it.

**`whenClipped` never describes**, and that is a fact about truncation rather than a default: the
text in the DOM is complete and the accessibility tree already has all of it. Only the *paint* is
cut off. A tooltip repeating it would make a screen reader say the set name twice.

### The eight SVG `<title>` elements

`FinishMark` and `GameChangerMark` draw the glyph; the words move to whoever draws the glyph,
because that is also where `pointer-events` is decided. **`pointer-events` inherits, so a `<title>`
inside anything `pointer-events-none` is a tooltip nobody can ever see** — `frontend-design.md`
records that `FinishMark`'s had never once been shown over card art until `FoilOverlay`'s chip took
`pointer-events-auto`. Our handlers inherit that constraint exactly: an element the pointer cannot
hit gets no tooltip. No worse than today, and no better — worth one sentence in the docs so the
next person does not rediscover it.

### The one site that is not a tooltip

`CollectionTable.tsx:137` is `<abbr title={conditionLabel(row.condition)}>`, where `title` is the
standard expansion mechanism and not decoration. `aria-label` on a roleless element is not
reliably announced, so that site becomes a visible abbreviation with an `sr-only` expansion beside
it plus the tooltip — the expansion then reaches assistive technology through text, which is the
one route that always works.

---

## 5. Behaviour

- **Opens 400ms after the pointer comes to rest.** A timer, which almost nothing here has;
  allowed on `SUBMENU_HOVER_MS`'s precedent — it is **not a transition**, so `MotionConfig` has
  nothing to turn down and reduced motion has nothing to say about it. A named constant with its
  reason at its own site, never a literal.
- **A warm period of 300ms.** Once one tooltip has been shown, moving to another trigger inside
  that window opens with no delay, so reading along a row of icon buttons does not cost 400ms an
  icon.
- **Focus opens it with no delay, but only on `:focus-visible`.** Clicking a button should not pop
  a hint at a pointer user; a Tab onto it should show one immediately.
- **Closes** on pointer-leave, blur, pointer-down, `dragstart`, `scroll` (capture, window) and
  resize. A `fixed` panel still pointing at a row that has scrolled away is a lie, and this app
  has drag sources under most of these hints.
- **`interactive`** holds the close for 120ms so the pointer can cross the gap to the panel, and
  the panel's own pointer-enter cancels it. That panel is hittable and `select-text`; the default
  panel is `pointer-events-none`, as a tooltip normally is.
- **`interactive` is a pointer affordance and nothing else — the panel never takes focus.** A
  keyboard reader gets the words through `aria-describedby` and cannot select them, which is the
  asymmetry being accepted here rather than overlooked. A panel Tab could reach would need a rung
  on the dismissal ladder, a focus hand-back to the trigger and a reason a hover can put the caret
  somewhere the reader did not ask for — at which point it has stopped being a tooltip and is
  `AnchoredPopup`, which already exists. A hint whose text a keyboard reader must be able to copy
  belongs on screen, not in a tooltip.
- **Anchored to the element, never following the pointer.** A pointer-tracked tooltip cannot be
  entered and has nowhere to be when the trigger is reached by keyboard.
- **Escape closes it and does not consume the press.** It deliberately does **not** join
  `useDismissOnEscape`'s ladder: that stack is for layers a reader navigated *into*, and its top
  token calls `preventDefault()`. A hint that appeared because a pointer drifted is not such a
  layer, and one that took the press would swallow the Escape meant for the dialog underneath it.
  A plain bubble-phase `keydown` while open, no `preventDefault`.

---

## 6. Look

```
rounded-md border border-border bg-surface px-2 py-1 text-xs text-text shadow-lg
max-w-xs whitespace-pre-line
```

`PANEL_CLASS`'s materials with a hint's proportions: same border, same surface, same shadow, and
`text-xs` with tighter padding because this is a sentence rather than a list of controls.
`max-w-xs` so a long hint wraps instead of running off the window; `whitespace-pre-line` because
`SortableHeader` already puts a `\n` in its title and that break should survive the move.

Motion is `popup` from `lib/motion.ts`, with the `origin-*` literal chosen by `placeTooltip`, so
the panel grows from the corner nearest its trigger. No arrow — neither `ContextMenu` nor
`AnchoredPopup` draws one, and a second positioned element is a second thing to place.

---

## 7. What the sweep touches

Measured at `06572dc`, production `.tsx` only:

| | count |
| --- | --- |
| `title=` occurrences | 102, across 48 files |
| …of those, on a `<button>` | 27 |
| …of those, with no `aria-label` on the same element | 12 |
| SVG `<title>` elements | 8 |
| `*ByTitle` queries in tests and stories | 17 |

Not all 102 are tooltips: `DeckDialog`, `Notice`, `Figure`, `AppShell`, `ExportDialog` and
`CountTag` each take a `title` **prop**, and some of those pass it on to a `title` attribute while
others draw it as a heading. The sweep reads each one; a regex cannot tell the two apart, and the
`aria-label` classification in §4 could not be automated even if it could.

The 17 `*ByTitle` queries move with their sites. `getByTitle` matches both the attribute and an
SVG `<title>` element, so those queries currently pass for two different reasons and will need
reading rather than replacing.

---

## 8. Verification

- **`placeTooltip`** — unit tests on fabricated rects: fits, flips on each side, clamps at each
  edge, and returns the matching `origin` literal.
- **The provider**, in jsdom under fake timers: opens after the delay and not before, the warm
  period, leave closes, focus opens only when `:focus-visible`, Escape closes **without**
  `preventDefault`, the interactive bridge survives a pointer crossing the gap, `whenClipped`
  declines when `scrollWidth === clientWidth` (both are 0 in jsdom, so the test defines them).
- **`aria-describedby`** is set on open and the prior value restored on close.
- **A `Primitives/Tooltip` story** with plays for hover, keyboard focus and selecting text in an
  interactive one.
- **A live CDP pass in the running window** — over a dialog, inside a virtualised table row, at
  the right edge of the window, and at the foot of a scroller. `CLAUDE.md`'s rule, and it is the
  rule here specifically because jsdom cannot see a flip, a clip or a stacking context, which is
  three of the four things that can go wrong with this.

---

## 9. Delivery

Two pull requests, both through `auto-pr`.

**PR 1 — the primitive.** `lib/tooltip.ts`, `components/tooltip/*`, the `LAYER` rung, `App.tsx`,
stories, tests, the docs (a `frontend-design.md` section and a rule in `src/CLAUDE.md`), and about
five proof call sites chosen to cover the shapes: a truncated table cell, an icon-only button, an
SVG glyph, an interactive one, and one shown over a dialog.

**PR 2 — the sweep.** The remaining sites and the 17 test queries, fanned out to parallel
subagents split by directory — `components/`, `features/decks/`, `features/card/` +
`features/search/`, `features/collection/` + `features/wishlist/` + `features/settings/` — with
each agent given files no sibling touches, and `npm run verify` run once after fan-in rather than
inside each agent.

---

## 10. What this deliberately does not do

- **No arrow, no offset knob, no `delayDuration` per call site.** One delay, one gap, one look;
  a surface that needs its own is a conversation, not a prop.
- **No portal and no `popover`.** Root-mounting already escapes every transform and every clipped
  scroller. The native top layer would too, and it would rest on the Chromium version inside the
  reader's installed WebView2 runtime — which this repo has never measured — to buy nothing we do
  not already have.
- **No tooltip on disabled controls.** A `disabled` button fires no pointer events; the app's
  existing answer is a greyed row whose accessible name carries the reason, and that stays.
- **Nothing follows the pointer, and nothing opens on click.** Both were considered; both make it
  a different component.
