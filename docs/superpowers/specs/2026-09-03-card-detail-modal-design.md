# The card detail modal

**Date:** 2026-09-03
**Status:** approved, not implemented
**Mockup:** claude.ai/design project `23751e36-afca-4778-b315-9c8b053ee8c9`, file `Card Info Modal.dc.html`,
artboards `1a` / `2a` / `2b` / `2c`. Drawn on this repo's own design-system bundle
(`_ds/mtg-grimoire-6738b546-…`, the id in `.design-sync/config.json`), so its `ManaText` and
`RarityGem` are the shipped components rather than lookalikes.

## 1. What this replaces

`CardDetailPane` is a 384px column docked beside a view. It is mounted in three places and drawn
in two boxes:

| site | shape |
| --- | --- |
| `App.tsx` | docked column beside the active view, for collection / wishlist / tags |
| `App.tsx` | `CardDetailDialog`, a centred modal, for the search page — **uncommitted work on this branch** |
| `DeckEditor.tsx` | its own sticky overlay inside a measured frame (issue #183) |

All three become **one centred modal**, on `Dialog`, mounted once. The docked shape is deleted
rather than kept behind a flag: `chrome: "docked" | "modal"` was written on this branch to let the
search page differ from everything else, and with one shape everywhere it is a fork with nothing on
the other side of it.

**What is explicitly not touched:** the deck editor's collapsible search sidebar
(`DeckSearchPanel`). It is a different surface that happens to sit on the same side of the window,
and a card opened *from* it lands in the modal like a card opened from anywhere else.

### 1.1 Deletions

* `App.tsx` — the `<AnimatePresence>` docked column, the `paneAsModal` selector, and the
  `inDeckEditor` guard that existed to keep the editor from drawing a second pane.
* `DeckEditor.tsx` — `paneFrameRef`, `PANE_OVER_ATTR`, the `dockWidth` state and its
  `ResizeObserver`, the dock effect that writes the frame's `top`/`height`, and the
  `sticky top-0 -mb-3 h-0` box the pane hung in.
* `CardDetailPane.tsx` — `PaneChrome`, the `chrome` prop, the `modal` branches inside the pane and
  its `Body`, and `origin-right`.

**`deskWidth` stays.** It reads as the pane's measurement and is not: `wideHeader`,
`settingsIcon`, `tightHeader`, `roomForPanel` and `maxPanelWidth` all depend on it, and only the
`dockWidth`-relative frame positioning is the pane's.

### 1.2 What survives unchanged

`AllPrintingsDialog` **is** the mockup's printings overlay — the same `Dialog` shell, the same
search / sets / languages / treatments / sort row, the same tile grid, and it already carries
`flanks` chevrons that walk `cardWalk`. `View all printings (N)` calls the `openAllPrintings` that
exists today. No part of that file is in scope beyond the `StepChevron` extraction in §6.

## 2. Layout

The panel is a three-part grid over a scrim, with the card's name, type line and mana cost in
`Dialog`'s header and a bordered action row at the foot.

```
┌──────────────────────────────────────────────────────────────────┐
│ Lightning Bolt   Instant   {R}                               ✕   │  Dialog header
├────────────────┬───────────────────────────┬─────────────────────┤
│ card image     │ Quantity                  │ OPTIONS             │
│  + chin        │ Printing ▾  View all (4)  │  Legality           │
│                │                           │  Oracle tags        │
│ Set as foil    │ Deck category ▾   Tag ▾   │  Card text          │
│ Flip card      │                           │  Set as commander   │
│                │                           │  Set deck image     │
│ Nonfoil  Foil  │                           │  Open on Scryfall ↗ │
│ $620.00   —    │ prices as of… / illus. by │ ─────────────────── │
│                │                           │ IN YOUR GRIMOIRE    │
│                │                           │  2 owned  1 wished  │
│                │                           │  3 decks            │
│                │                           │  4× in Burn · main  │
├────────────────┴───────────────────────────┴─────────────────────┤
│              Add to wishlist  Add to collection  [Add to deck]   │  action row
└──────────────────────────────────────────────────────────────────┘
   ‹                                                              ›   Dialog flanks
```

Columns are `376px 1fr max-content`. The left and centre columns each own their own
`min-h-0 overflow-y-auto`; the action row does not scroll.

### 2.1 Breakpoints are container queries, not viewport branches

`src/lib/viewports.ts` states the rule: its constants are "widths to look at, not breakpoints to
branch on", and nothing may grow a `sm:`/`md:`/`lg:` layout branch off them "without saying at its
own site why the *window* is the thing it is asking about."

**The window is not the thing this panel is asking about.** At the top rung the panel is a fixed
1240px, and how much glass sits either side of it changes nothing about how its own columns should
fold. `AppShell` is the counter-example that proves the rule — it *is* the window, drawn in exactly
one box that is the viewport — and this panel is a box inside a scrim inside that.

So the panel carries `@container/card` and the folds are measured on it:

| rung | panel size | layout |
| --- | --- | --- |
| `< 640px` | full-bleed, `h-full w-full` | one column, everything stacked in one scroller; 44px touch targets; sticky action row |
| `@[640px]/card` | `w-[47.75rem] h-[52.5rem]` | two columns `300px 1fr`; options as a 2-up grid under the controls; chevrons in the action row's left corner |
| `@[900px]/card` | `w-[66.25rem] h-[47.5rem]` | three columns `320px 1fr max-content`; **no grimoire counts** in the rail; chevrons as flanks |
| `@[1200px]/card` | `w-[77.5rem] h-[50rem]` | three columns `376px 1fr max-content`; grimoire counts in the rail |

The mockup's artboards are 390 / 820 / 1180 / 1400 wide with panels of 390 (full-bleed) / 764 / 1060
/ 1240, and its own labels give the ranges as 206–640, 647–899, 906–1501 and 1502+. The seven-pixel
gaps are artboard sampling rather than intent; the folds above are 640 / 900 / 1200 measured on the
panel, which lands each artboard in its own rung.

Every width is written out whole. **Tailwind scans source text for whole class names**, so a class
built by interpolation emits no rule at all — silently, and only in a build. This is the same rule
`Dialog`'s `width` prop is documented under.

**Two `Dialog` changes follow from this table**, and neither is the card modal's alone:

* **`Dialog` applies `@container/card` to the panel, and only when the host asks for it.** It has
  to be on the panel rather than inside `children`: the header is `Dialog`'s and the body is the
  host's, both fold on the same measurement — at `< 640px` the header stacks the type line and mana
  cost under the name — and a container declared inside `children` cannot be queried by a `title`
  node rendered above it.

  Opt-in rather than unconditional, because of §2.2: a container is a containing block for `fixed`
  descendants, so switching it on for every dialog in the app would arm that trap under every body
  at once. Checked rather than assumed — `TooltipProvider` and `ContextMenuProvider` both render
  their panels as siblings of `{children}` at provider level, above `AppShell` and therefore above
  every dialog, so nothing today would break. But "nothing today" is what the flag is protecting,
  and this file's own rule for `flanks` and `onPanelKeyDown` is that a prop added for one surface
  may not move the rest of them.
* **`width` carries a height too.** The panel's size is `w-… h-…` per rung, and the prop is a class
  string the host spells out whole, so this is a doc change and a rename rather than a mechanism.
  `Dialog`'s existing `max-h-full` still clamps it — a fixed height taller than the window is
  exactly the case that clamp exists for. **All three heights are taller than the window can be**:
  760, 800 and 840 against `DESKTOP_FLOOR_HEIGHT_PX` of 700, so at the app's minimum window height
  every rung is clamped and both scrolling columns are doing real work. The clamp is not an edge
  case here, it is the normal state, which makes `Dialog`'s `grid-rows-[minmax(0,1fr)]` scrim rule
  a prerequisite of this layout rather than a detail — that pair is what makes `max-h-full` mean
  anything at all, and it went two days meaning nothing.

### 2.2 The containment trap this creates

`container-type` implies layout containment, and a layout-contained box **is a containing block for
its `fixed` descendants**. `App.tsx` already documents this hazard from the other side — the card
modal's scrim survives being rendered inside `<main>` only because "there is neither a `@container`
nor a `transform` between here and the root."

Putting `@container/card` on the panel therefore means **no nested overlay may render inside it**.
That is what §3 is shaped around, and it is a constraint rather than a preference: a nested
`Dialog` rendered as a child of this panel would have its `fixed inset-0` scrim resolve against the
panel, so it would cover the card modal and nothing else.

### 2.3 Full-bleed at phone width goes into `Dialog`

Below 640px the panel fills the window: no scrim padding, no rounded corners, no border. This lands
in `Dialog` **for every modal in the app**, not behind an opt-in prop.

A 16px inset and a rounded border on a 358px-wide panel is chrome nobody chose, and Deck settings,
Categories and History are as wrong at that width as this one would be. One rule here is the whole
reason `Dialog` exists — four hand-rolled copies had drifted into two scrim darknesses, two ✕
geometries and three `max-h` values before it was written. Desktop is untouched at every rung.

Concretely: the scrim's `p-4 sm:p-6` becomes **`p-0 sm:p-6`**, and the panel's `rounded-xl border
border-border` becomes `sm:rounded-xl sm:border sm:border-border`. Tailwind's `sm` is 640px, which
is this fold exactly — an intermediate `min-[640px]:p-4` would be the same breakpoint spelled twice
and would emit `p-4` for a zero-width range.

This is the one place a **viewport** query is correct rather than a container one, and §2.1's rule
demands the reason be given here: the scrim is `fixed inset-0`, so it *is* the window, and how much
inset to leave around a panel is a question about the glass and nothing else. It is the same
argument `useNarrowWindow` makes for `AppShell`.

`Dialog.test.tsx` pins the untouched shape; it gains a case for each half of this.

## 3. The four nested overlays

Each is a `Dialog`. Each renders in `App.tsx` **as a sibling of the card modal**, for §2.2's
reason.

| overlay | width | state | source |
| --- | --- | --- | --- |
| **Printings** | existing | `printingsRequest` | exists — `AllPrintingsDialog` |
| **Legality** | `w-[45rem]` | new store field | `card.legalities`, via `legalityChips` |
| **Oracle tags** | `w-[38.75rem]` | new store field | `ipc.oracleTagsForCards([oracleId])` |
| **Card text** | `w-[38.75rem]` | new store field | `card.faces` / `card.oracleText` |

At `< 640px` all four are full-bleed, which §2.3 gives them for free.

Their open-state lives in the store as fields beside `printingsRequest`, each with a single writer,
mirroring `openAllPrintings` / `closeAllPrintings`. That is the pattern this app already uses for a
modal that must render at `App` level while being opened from a component several layers down; a
provider or a context would be a second answer to a question already settled.

### 3.1 Legality

The two-column grid of `status badge + format name` and **nothing else**. The mockup's footer —
"On the Commander Game Changer list · view all" and "Canadian Highlander: 3 points" — is dropped:

* `CardDetail` carries no `gameChanger`. The column exists and `CardSummary` and `DeckCard` both
  expose it, so adding it is a small Rust change — but the line is not wanted, so it is not made.
* **Canadian Highlander points exist nowhere.** Not in `CardDetail`, not anywhere in `src/`, and
  not in any Scryfall bulk file — the points list is maintained by that format's own committee. A
  hardcoded table would be a number with no refresh path and no build to go red when it rots, which
  is exactly the failure `CLAUDE.md` names for counts written into prose.

`legalityChips` currently **drops every `not_legal` key before anything is drawn**, and the pane
says so in a caption ("Formats not listed are not legal"). The mockup shows `not_legal` rows
explicitly, in a dim badge. The popup therefore reads the legalities JSON directly rather than
through `legalityChips`, which stays as it is for any caller that still wants the filtered list.
Statuses and their colours: `legal`, `not_legal`, `banned`, `restricted`.

### 3.2 Card text

This is §7's answer to what the mockup drops. The mockup has no oracle text, no type line beyond
the header, no P/T and no rarity anywhere — the card's art is expected to carry all of it. An image
is not text: it is unreachable by a screen reader, unselectable, un-searchable, and absent entirely
on a printing whose picture has not cached. So `Facts`' content survives, one click away, in the
rail beside Legality and Oracle tags.

It carries the type line, the oracle text per face, P/T or loyalty, and the rarity gem with its
label. It does **not** carry the prices — those move to the panel's left column, per §4.

## 4. The price block keeps one row per finish

The mockup hardcodes a Nonfoil/Foil pair. `Facts` today draws **one row per finish**, named through
`finishTreatments` / `treatmentName`, because `finishes` has three words for how shiny a copy is and
`promoTypes` is what tells a Surge Foil from a Halo Foil from an ordinary one (issue #160).

A literal reading of the mockup would price an etched-only or surge-foil-only printing as "—" while
the app holds a number for it. So the left column draws one cell per finish the printing actually
has, in the mockup's two-up bordered style, and `pricesAsOf(marketplace)` keeps its caption — Spec
§5's rule that a price is never shown without saying how old it is and whose it is.

## 5. Stacking

### 5.1 Escape needs no change

`useDismissOnEscape` keeps a capture-phase stack in which only the top token acts, and a layer's
position on it is decided by mount order. A nested overlay mounts after the card modal, so it is on
top, so it takes the press and `preventDefault`s it; the card modal takes the next one. Menu →
nested overlay → card modal → view is already the ladder that hook was built for, and its own doc
names this case ("a context menu open over a dialog opened over the card pane and give one press to
each").

The `useDismissOnEscape({ layer: "outer", enabled: !modal })` line added on this branch goes with
the docked shape. The modal's rung is `Dialog`'s `"inner"`, registered on the open flag.

### 5.2 Paint order needs a rung split

`LAYER.overlay` is one rung for every dialog in the app, and its doc justifies that by "**at most
one is ever mounted** — there is no pair for a second number to order, and inventing one would be a
claim about an overlap that cannot occur." Stacking makes that false. That doc also says what to do
about it: "If a layer ever has to open *over* one of these, that is the day the rung splits, and the
split will have a real overlap to point at."

```
overlay:        z-45   the card modal, and every dialog that is not opened over one
overlayStacked: z-46   an overlay opened over another overlay
tooltip:        z-47   was z-46
gate:           z-50   unchanged
caption:        z-60   unchanged
```

`tooltip` moves rather than staying put: its own doc requires it above every dialog, because "a
control inside a modal has as much to explain as one outside it, and a tooltip painted behind the
scrim would be a tooltip that never appears."

Relying on document order instead — two `z-45` scrims resolved by which renders later in `App.tsx`
— would work today and is refused. `LAYER`'s opening paragraph is a bug report about exactly that:
two surfaces at one number, neither inside the other, resolved by document order, and the wrong one
won.

## 6. Stepping between cards

The circular `‹ ›` controls walk the list the card was opened from. **The infrastructure exists.**
`AppState.cardWalk` is already published by `SearchPage`, `CollectionPage`, `WishlistPage`,
`TagResults` and `DeckEditor` through `usePublishCardWalk`, and `AllPrintingsDialog` already walks
it — finding its own stop through `sameDeckSlot` for a deck row and `cardId` for everything else,
then writing `openCardFromDeck` or `setSelectedCardId` so the list behind the scrim follows.

The card modal does the same thing against the same field. `StepChevron` is currently private to
`AllPrintingsDialog`; it moves to its own module and both import it.

Placement follows §2.1: `Dialog` `flanks` at `@[900px]/card` and above, the action row's left corner
below that. **Hidden when the walk holds no stop for the open card** — a card reached from a meld
relation or from a printing swap has no position in any list, and a chevron that cannot say where it
would go is worse than no chevron.

## 7. Per-view content

One layout everywhere; what does not apply is not drawn. Two store fields decide, both of which
already exist: `paneDeckContext` (the deck row a card was opened out of, or `null`) and
`activeView`.

| | search | collection | wishlist | tags | deck editor |
| --- | --- | --- | --- | --- | --- |
| Quantity stepper | — | owned count | wished count | — | deck quantity |
| Deck category ▾ | — | — | — | — | ✓ |
| Tag ▾ | — | — | — | — | ✓ |
| Set as commander / Set deck image | — | — | — | — | ✓ |
| Legality / Oracle tags / Card text / Open on Scryfall | ✓ | ✓ | ✓ | ✓ | ✓ |
| In your grimoire | ✓ | ✓ | ✓ | ✓ | ✓ + `4× in Burn · mainboard` |
| Add to wishlist / Add to collection | ✓ | ✓ | ✓ | ✓ | ✓ |
| Add to deck | ✓ | ✓ | ✓ | ✓ | ✓ |

`Add to deck` is present everywhere — outside a deck it opens the existing `CardToDeckProvider`
picker, which is already how every other surface in the app adds a card to a deck.

The rail is a list rather than a fixed set of slots, so a view contributing three entries and a view
contributing six draw the same component. At `@[640px]/card` and below the rail's entries join the
single-column stack under a shared **Options** heading, which is what artboards `2a` and `2b` do.

## 8. Testing

* **`Dialog.test.tsx`** — the full-bleed fold, both halves (scrim padding, panel frame); the
  container class present when a host opts in and **absent when it does not**, which is the half
  that keeps §2.2's trap disarmed for every other dialog; and the existing untouched-shape
  assertions still passing.
* **`CardDetailModal.test.tsx`** — the per-view table in §7, one case per column; the price block
  drawing a row for a finish that is neither nonfoil nor foil (§4); the chevrons hidden when
  `cardWalk` has no stop for the open card.
* **`App.test.tsx`** — the Escape ladder with a nested overlay open over the card modal, one press
  each; the existing Escape-stack test extended rather than replaced.
* **Legality popup** — a card with a `banned` and a `restricted` format, since `legalityChips`'
  filtering is bypassed and `not_legal` rows now draw.
* **Stories** — `CardDetailPane.stories.tsx` becomes the modal's, with a story per rung so the four
  layouts are visible in the workbench.

**jsdom sees none of the layout.** It has no layout engine, so every container query resolves to
nothing and every box is 0 — the same blind spot `Dialog`'s own `max-h` bug was invisible to for two
days. The four rungs are verified in the running window over CDP per
`docs/reference/live-ui-verification.md`, and the numbers from that pass belong in a reference doc
rather than in a test.

## 9. Out of scope

* Any change to `DeckSearchPanel`.
* `CardDetail.gameChanger` and Canadian Highlander points (§3.1).
* Redesigning `AllPrintingsDialog`, which the mockup already matches.
* The deck editor's `deskWidth` measurement and everything else that reads it (§1.1).
