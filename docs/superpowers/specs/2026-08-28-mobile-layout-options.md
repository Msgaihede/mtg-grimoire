# The phone layout: four rounds, twelve options — Mobile layout 9a

**Built and measured 2026-08-29**, against `main` at the merge of PR #274 (the 9a foundation).
Four surfaces, three options each, every option built on the **real** components in a 390×844
frame and looked at in Storybook. The option stories are deleted once the decision is taken —
**the ASCII wireframes below are what survives them**, which is why each one is drawn properly.

This document is a **decision record**, not a proposal. The losing options are kept with their
wireframes and their costs, because the reason an option was *not* chosen is the thing a later
reader needs and the thing that always gets thrown away.

> **9b is planned from the foot of this file and from nowhere else.** Spec §6.1 says the options
> come to Markus before anything is built; naming the components 9b would create requires a choice
> nobody had made. That choice is what this document holds.

---
## The decision

**Taken by Markus on 2026-08-29**, through the option cards, with all twelve stories live in
Storybook at the moment of choosing. The chrome and the filter bar were put first because the
filter bar is independent and the chrome constrains everything else; the wall and the deck editor
were then asked against a settled 324px wall and 350px desk rather than against a range.

| Round | Chosen | What it commits the app to |
| --- | --- | --- |
| 1 — chrome | **R2 — a bottom tab bar** | The rail goes below `PHONE_PX`; the six `NAV` entries move to the thumb zone inside `--safe-b`; the ribbon becomes one title row and **the status line moves** |
| 2 — the wall | **G1 — a 144px phone tile** | `baseTileWidth={144}` below `PHONE_PX`: two columns on a 324px wall, gutter exactly `GAP`, the zoom ladder untouched |
| 3 — deck editor | **D1 — the rail opens a full-width overlay** | The search panel's rail keeps its fallback and its open state becomes a full-width overlay over the deck, the pattern #183 already established |
| 4 — filter bar | **F1 — raise the target sizes and nothing else** | The `coarse:` variant and `--target-min` get their first consumer; the four-band container layout is otherwise untouched |

**The through-line is that three of the four are the cheapest option in their round**, and that is
a result rather than a compromise: the tree turned out to have more of the phone answer in it than
the spec assumed — a collapsed rail already built, a search panel that already falls back, a filter
bar whose narrow band was designed for a box half a phone's width. The one place the expensive
option won is the chrome, and it won on a number: the rail is half the card art on screen.

---

## What 9b has to do, per surface

**This is the brief 9b's plan is written from. It is not that plan.**

### R2 — the bottom tab bar

- **`NAV`, `NavItem`, `NavNote` and `NavToggle` are module-private** — `AppShell.tsx` has exactly
  one `export`, at line 100. A bar begins by exporting or rebuilding the 44px row, its gold
  hairline, its `aria-current` and its `useDndDropTarget` registration. **The plan costed none of
  this**, and `NAV`'s own comment says it exists so there is one word per view rather than two that
  can drift — so copying the list is the wrong repair.
- **The bar sits inside `--safe-b`.** That token shipped in PR #274 published and deliberately
  unapplied; this is the consumer it was published for.
- **`useSidebarDrops` follows the bar**, which is possible only because `@dnd-kit/dom` is
  pointer-based. **Nothing in 9a proved it** — these stories carry no `play`, so no drag was
  driven. R2's frame draws the shipped `DROP_RING` under a `dragging` control so it can be looked
  at; that is a picture, not a proof, and re-verifying the drop is 9b's first job on this surface.
- **The status line has to go somewhere.** It does not fit on a 390px ribbon row in any option —
  89px of the 244 it needs, with the whole window and no rail. It is a permanently-mounted
  `role="status"` live region whose number is `aria-hidden`, and **a live region that only
  sometimes exists announces nothing**, so it must stay mounted wherever it lands.
- **Two facts live *only* in the ribbon's tooltip and have no other door**: which data folder is
  live, and how many card images could not be cached (`Ribbon.tsx:96` and `:97–98`). A phone reader
  has no hover. Settings names **neither** today (`SettingsPage.tsx:154`, `DangerZonePanel.tsx:117`),
  and it is the obvious home.
- Cost accepted: 53px of height, on the axis that turned out to be the scarce one.

### G1 — the 144px tile

- Pass `baseTileWidth={144}` at the wall's call sites below `PHONE_PX`. The prop exists and already
  has a caller (the deck panel passes 150), so this is one argument at one call site per wall.
- **Do not use 160.** On the real wall — `rowsRef`, inside the scroller's `border` and `p-3` —
  `columnsFor(324, 160)` is **1**. The plan's suggested 160 is the failure it was meant to fix,
  arriving one inset later.
- **The chin does not scale with the tile.** `--mark-scale` and `--control-scale` come from
  `cardScaleVars(zoom)`, so the chin stays 28px with 10px type and becomes proportionally taller —
  12.4 % of tile height at 144 against 10.7 % at 170. 9b decides whether that is accepted or
  whether the chin earns a phone treatment of its own.
- **Nothing steps `cardZoom` on a touchscreen, and G1's answer is that the default size is right.**
  That is a legitimate answer and it was chosen knowingly, but record the consequence: the sixteen
  stops of `ZOOM_STEPS` stay unreachable on a phone and `cardZoom` is frozen at whatever
  `hydrateCardZoom` restored. The one caller is `useCardZoomGesture.ts:86`.
- **The quick-add trigger is unaimable and G1 does not fix it.** `--control-scale` does not move,
  so it stays `24 × 0.85 = 20.4px` — under WCAG 2.5.8's 24×24 before 2.5.5's 44 is discussed — and
  it is `opacity-0`, which `CardGrid.tsx:1474` says in as many words is **still a hit target**. A
  finger that lands on it presses it, and nothing on screen says it is there. G3 was the only
  option with room to fix it; that room was not taken, so this is now an open item.

### D1 — the rail opens a full-width overlay

- **`roomForPanel`'s consequence has to change first.** At 390 the disclosure is `aria-disabled`
  and refuses — `onClick={() => roomy && setOpen(!open)}` (`DeckSearchPanel.tsx:580`) — so today
  the rail **cannot be pressed at all**. The fallback exists; the door out of it does not.
- The open state is a full-width overlay over the deck, drawn the way the card pane already is
  (`PANE_OVER_ATTR`, issue #183).
- **`TextView` overflows by 14px** and no option could fix it from outside: `COLUMN_WIDTH` is a
  module constant of 300px (`TextView.tsx:68`) against a 286px view box, contained by the view's
  own `overflow-x-auto`. Either it becomes a prop or the overhang is accepted deliberately.
- **Accepted cost: while the overlay covers the deck there is nothing to drag into**, so adding a
  card from search is a tap and dragging is for rearranging within the deck. Every in-deck drag is
  unaffected — dnd-kit's `PointerSensor` delivers those regardless.
- Re-measure the header's `deskWidth` ladder (1400 / 1100 / 900) at phone widths; a fourth rung is
  a smaller change than a new mechanism.

### F1 — raised targets

- Apply `coarse:` and `var(--target-min)` to the controls below 36px. **First consumer of both**,
  which shipped unapplied in PR #274 precisely so this decision could take them.
- **`ManaChip` and `LayoutToggle` have no `className` or size prop**, so this edit lives inside
  `FilterChips.tsx` rather than at a call site.
- **`coarse:` must come last and unconditional.** Stacking it onto a container variant
  (`@min-[640px]/fb:coarse:size-11`) has **no specificity answer** — source order decides.
- **`ActiveFilterChip` at 26px is where the 44px floor and the app's stated design conflict.** Grow
  the *target* with a `::before`, not the chip.
- The ten mana-value chips **already wrap at 350px** (`10×32 + 9×4 = 356`), which is why raising
  them costs no extra line.
- **F2 is the named follow-on for the one state F1 leaves bad** — the open tray is 493px in flow,
  774px against a 602px column — and it is conditional on somebody driving the open tray on a
  device first. It is not part of 9b unless that reading says so.

### Cross-cutting, and the thing to measure before anything else

- **The vertical is tighter than the horizontal.** Ribbon 58 + `main`'s 40 + a 273px shut filter
  bar leaves roughly **329px** of wall against a ~700px visible viewport — one tile row and a
  sliver. Every option above spends or saves on that axis, and **nothing in 9a measured the
  assembled stack**, because until one option per surface was chosen there was no stack to measure.
  **9b's first measurement is the whole chrome end to end on a device**, not any single surface.
- **`touch-action` already exists at two sites** — `index.css:464` (the mirrored `@dnd-kit/dom`
  rules) and `DeckSearchPanel.tsx:1072`. A second registration on one element silently replaces the
  first, so 9b must check before adding.
- **Re-verify every shipped drag at touch sizes**, and remember that a working new drop is never
  evidence the old one survived.
- **The dialog against a real URL bar is still owed** — the recipe is in
  `docs/reference/frontend-design.md`, and it needs hardware because `cdp.mjs size` hardcodes
  `mobile: false`.

---

## Read this first: the four rounds are not independent

**The plan treated the four surfaces as four separate questions. They are not, and the coupling
runs one way: Round 1 decides how much width Rounds 2 and 3 have to spend.** This was found by
driving the shipped window rather than by reading the plan, and it is the single most important
thing on this page.

### The wall, corrected

⚠️ **`main`'s content box is not the wall, and the 26px between them is worth a column.**
`CardGrid`'s `ResizeObserver` is on `rowsRef` (`CardGrid.tsx:646–648`), which sits **inside** the
scroller's `border` and `p-3` (`:1020`) — 1px + 12px each side. `rowsRef`'s own comment says it,
having no padding of its own, "is the honest answer to how wide a row of tiles may be."

**Every `columnsFor` figure inside the four round sections below that was computed on `main`'s
content box is 26px optimistic. This table is the authoritative one.**

390px window, less the rail, less `main`'s `p-5` (40), less the scroller's 26:

| Chrome | `nav` | `main` content | **wall** | @170 | @160 | @144 | **largest tile giving 2 columns** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Today** — rail expanded | 208 | 142 | **116** | 1 | 1 | 1 | **52** — impossible |
| **R1** — rail collapsed | 68 | 282 | **256** | 1 | 1 | 1 | **122** |
| **R2 / R3** — no rail | 0 | 350 | **324** | 1 | 1 | **2** | **156** |

`columnsFor` is `max(1, floor((width + 12) / (tile + 12)))` (`CardGrid.tsx:180`). A desktop
scrollbar takes another ~15px off the wall; a phone's overlay scrollbar takes none.

### What that means for each round

- **The plan's suggested 160px phone tile draws a single column on a phone**, under every chrome
  option. It is not a smaller version of the fix; it is the failure the round exists to answer,
  arriving one inset later. **144** is the working number, and only if the rail is gone — at 144
  on a 324px wall the leftover is 24 and the gutter is exactly `GAP`, so the margins and the
  inter-card gap become one measurement.
- **"The rail is worth a column" is true only for a tile of 156 or less.** At today's 170 and at
  the plan's 160, both chromes floor at one column and the rail buys nothing. Keeping R1's
  collapsed rail *and* wanting two columns costs a **122px** tile.
- **Round 3 is downstream of Round 1 too.** At today's expanded rail the deck editor's desk is
  142px — below `DECK_FLOOR` (192) outright. With R1's collapsed rail the desk is 282, D1's deck
  view box is 218, and `StackView`'s own 224px pile **overflows by 6px**. With no rail the desk is
  350 and it fits.
- **Round 4 is the one that is genuinely independent**, and it is also the one with least to
  decide — see its section.

**So Round 1 is answered first, and Rounds 2 and 3 are answered against it.**

### And the vertical is tighter than the horizontal — which the plan half-anticipated

The 9a plan's self-review named this as the thing that could still be wrong: *"the vertical budget
may matter more than any of the four horizontal answers."* **It does, and the plan's own estimate
of it was optimistic by 170px.**

Measured in headless Chromium over the built stylesheet at a 350px container: **the shut filter bar
is 273px**, not the "two-or-three lines at ~36–40" the plan assumed. It is four lines, and two of
them are zero-height `basis-full` breaks that still cost 8px of `gap-y-2` each, over an
always-drawn `Reset all` row of 49.

| | px |
| --- | --- |
| Visible viewport on a phone browser | ~700 |
| less the ribbon block (`h-14` + the 2px `ManaLine`) | −58 |
| less `main`'s `p-5`, top and bottom | −40 |
| less the **shut** filter bar | −273 |
| **left for the wall** | **≈ 329** |

A 144px tile draws its art at about 200px, plus a 28px chin — so **329px of wall is one row and a
sliver of the next**, whichever chrome option wins. The plan's "~500px" is right against the full
844 frame and wrong against a browser's visible one.

**Two consequences.** The filter bar's round stops being cosmetic and becomes the one with the
most vertical to give back. And a second column is worth proportionally more than it looks — at one
row visible, two columns is the difference between 1 card on screen and 2.

---

## What a narrower tile does not do

**It does not shrink the chin's type**, and the plan says it does. `--mark-scale` and
`--control-scale` come from `cardScaleVars(zoom)` and know nothing about `baseTileWidth`, so the
chin stays 28px with 10px type at any base. A narrower tile makes the chin proportionally
**taller** — 10.7 % of tile height at 170, 12.4 % at 144 — which is a cost in the opposite
direction from the one "a 6 % shrink on the type" suggests.

## Two things every round had to work around

**`RibbonProps` has ten members and no slot, no `children`, no `onOpenNav` and no
`onStatusPress`** (`Ribbon.tsx:9–53`). Several options here are asking for a prop that does not
exist. That is drawn as the option's cost rather than papered over by inventing one.

**`NAV`, `NavItem`, `NavNote` and `NavToggle` are module-private** — `AppShell.tsx` has exactly
one `export`, at line 100. Any option that draws navigation somewhere else begins by exporting or
rebuilding a 44px row, its gold hairline, its `aria-current` and its drop-target registration. The
plan costed none of that.

## How these options were verified, and what that does not cover

Each option was opened in Storybook at 390×844 and looked at. **That is the only thing that
proves one renders**: `src/stories.test.tsx:277` reads `if (plays.length === 0) continue;`, and
these options carry no `play` functions by design, so **not one of the twelve is rendered by the
suite**. `composeStories` still runs at module scope (`:253`), so an import-time break goes red
and a render-time one does not. `npm run build-storybook` compiles them and never plays them.

**The Storybook MCP was unavailable for this whole session** (`ConnectionRefused` — it is an HTTP
endpoint at `localhost:6006/mcp` and nothing was serving it at session start). `src/CLAUDE.md`
requires component props be verified through it. The substitute used throughout was stricter
rather than looser: every prop was read out of the component's own literal TypeScript props type
and quoted back before use, and no option invents a prop. Where an option needs one that does not
exist, the write-up says so and the frame draws the consequence.

**No drag was driven.** With no `play` functions nothing drags in these stories, so every claim
about a drop target here is an argument from the shipped code, not a demonstration. R2's frame
draws the shipped `DROP_RING` so it can be looked at; that is a picture and not a proof.

---

## Round 1 — the ribbon and the rail

**The frame.** `TitleBar` is absent on web and Android — parity §5 gives the window's edge to the
browser and to the OS — so on a phone the chrome is the ribbon and the rail, and the caption's
34px comes back. What is left to arrange is 390 × 844.

### What the ribbon actually does at these widths

Measured 2026-08-29, headless Edge, built stylesheet, real fonts. The markup is `Ribbon.tsx`'s,
transcribed verbatim; the sentence is the app's own `statusLine()` over a 116,590-card status.

| Ribbon's box | `<h1>` gets | `<h1>` needs (`Collection`) | status gets | status needs | `Refresh data` |
| --- | --- | --- | --- | --- | --- |
| **322px** (R1 — 390 less the rail) | **62** | 125.75 | **37** | 243.95 | 150.91 × 42 |
| **350px** | 69 | 125.75 | 58 | 243.95 | 150.91 × 42 |
| **390px** (R2, R3 — no rail) | **78** | 125.75 | **89** | 243.95 | 150.91 × 42 |

The ribbon block is **58px**: the `h-14` row (56) plus the 2px `ManaLine`. The six view titles at
20px Cinzel are `Decks` 63.39, `Search` 75.42, `Tagger` 76.50, `Wishlist` 88.84, `Settings` 91.64,
`Collection` **125.75**.

**Three things follow, and they are facts about the round rather than about any one option.**

1. **`Refresh data` is 150.91px — 43% of a 390px window — and it is the single reason nothing else
   in the row fits.** 390 less `px-5`'s 40 is 350 of content; the button and the two `gap-4`s take
   182.91 of it, and the 167.09 left is split between a title that wants 125.75 and a sentence that
   wants 243.95.
2. **No option puts that sentence on this row.** At the full 390, with no rail at all, the status
   line gets 89 of the 244 it needs. Whichever option wins, the ribbon's line either moves or is
   permanently a truncation.
3. **The title cannot be shrunk to fit.** Cinzel never below 18px, so 20px stays or the title goes;
   `TitleBar`'s 13px wordmark is the app's one exception and is paid for by being a wordmark.

### The wall each option leaves

`main` is `relative min-h-0 flex-1 overflow-auto p-5` — the app's only scroller, and its `p-5`
costs 40px of a 390px window. `columnsFor`/`sideGutterFor` below are `CardGrid`'s **own** exported
functions, and the option stories call them live rather than quoting them.

| | wall | `columnsFor` @170 | gutter @170 | `columnsFor` @160 | cards on screen |
| --- | --- | --- | --- | --- | --- |
| **R1** | **282 × 746** | 1 | 56px each side | **1** | ~2–3 |
| **R2** | **350 × 693** | 1 | 90px each side | **2** | ~5 |
| **R3** | **350 × 746** | 1 | 90px each side | **2** | ~5 |

**The rail is worth a column.** At today's 170px tile every option floors at one; at the 160px tile
Round 2's G1 proposes, 350 gives two and 282 gives one. On the app whose whole subject is card
art, that is the number this round turns on.

---

### R1 — the rail holds, the ribbon sheds

Story export: **`RailHolds`** · id `mobile-chrome--rail-holds`

```
        0             68                                          390
        ├─────────────┼───────────────────────────────────────────┤
    0   ┌─────────────┬─────────────────────────────────────────────┐ ─┐
        │             │ Collec…  116,5…  [ ⟳  Refresh data       ] │  │ 56
   56   │    [ Q ]    ├─────────────────────────────────────────────┤ ─┤
   58   │             │▓▓▓▓▓▓▓ ManaLine 2px, 322 wide ▓▓▓▓▓▓▓▓▓▓▓▓▓│  │ 2
        │    [ # ]    │                                             │ ─┘
        │             │  ┌───────────────────────────────────────┐  │
        │    [ ▤ ]    │  │                                       │  │
        │             │  │   main · p-5                          │  │
        │    [ ▦ ]    │  │   wall 282 × 746                      │  │
        │             │  │                                       │  │
        │    [ ♥ ]    │  │   columnsFor(282, 170) = 1            │  │
        │             │  │   sideGutterFor          = 56px       │  │
        │    [ ⚙ ]    │  │   columnsFor(282, 160) = 1            │  │
        │             │  │                                       │  │
        │             │  │                                       │  │
        │  ─────────  │  └───────────────────────────────────────┘  │
        │    [ ◧ ]    │                                             │
  844   └─────────────┴─────────────────────────────────────────────┘
         68px rail                      322px column
         (43 × 44 targets)              (ribbon + main)

         Q Search · # Tagger · ▤ Decks · ▦ Collection · ♥ Wishlist
         ⚙ Settings · ◧ Expand sidebar
```

**Costs.** 68 of 390 on every screen — **17.4% of the window, permanently**. The wall is 282 × 746
against R2's and R3's 350, which at a 160px tile is one column against two. The ribbon is squeezed
to a 322px box, where the title gets 62 of the 125.75 `Collection` needs and the status line gets
37 of 244. And navigation sits in the top-left, the corner a thumb reaches last.

**Buys.** Everything else. This is the shipped app at 390 with one boolean flipped, and the option
story is the real `AppShell` rather than a drawing of it. The rail's entries are already **44px
tall** — they already meet the `--target-min` Task 3 wrote down — and collapsed they are **43 × 44**
(the missing pixel is the rail's own `border-r`, inside its 68px `box-sizing: border-box`). Nothing
is designed, nothing is rebuilt, and nothing is stranded.

**Machinery.** Reuses `useNavCollapsed`, `useNavLabels`, `useSidebarDrops`, `NavItem`, `NavNote`,
`NavToggle` — **untouched, all six**. Strands nothing. The one change is forcing the collapsed
state below `PHONE_PX` instead of merely defaulting to it, and `useNavCollapsed` persists a
reader's choice in `app_meta`, so 9b has to decide whether a phone *overrides* that row or seeds
it. Overriding is right: an expanded 208px rail leaves 182px of window, narrower than one 170px
tile.

**The sidebar drop.** Nowhere to go, because it does not move. `useSidebarDrops` keeps its two
targets on the two entries that already carry them, at 43 × 44 each. **This is R1's strongest
argument and it is worth stating plainly**: the Search wall and the deck editor never coexist, so
a card found in Search has nowhere else to be dropped, and R1 is the only option that does not have
to invent somewhere.

**The status line.** R1's other half is to shed it, and **the shed needs a prop `Ribbon` has not
got.** `statusLine: string | null` can be emptied — which is a genuinely good shed, because the
`role="status"` stays mounted and goes `sr-only` rather than unmounting, so the live region
survives and a screen reader keeps the sentence. What does not exist is the press that brings it
back: no `onStatusPress`, no slot, no children. `AppShell` computes that prop from its own
`sync_status` poll, so the story cannot even pass the empty one — the option's frame shows the
shipped ribbon truncating instead, which is the honest picture of R1 without the prop.

**What the shed costs, from the census.** `Ribbon.tsx`'s tooltip on that line is the **only** place
in the app that names the live data folder or the count of card images that could not be cached —
`features/settings/SettingsPage.tsx` says "Data folder and import. Coming in a later plan." So
shedding the line on a target that also has no hover to read a tooltip with takes both facts off
the phone entirely. The press is not a nicety; it is where those two facts go.

---

### R2 — a bottom tab bar

Story export: **`BottomTabBar`** · id `mobile-chrome--bottom-tab-bar`

```
        0                                                        390
        ├────────────────────────────────────────────────────────┤
    0   ┌──────────────────────────────────────────────────────────┐ ─┐
        │ Collect…   116,590 c…    [ ⟳  Refresh data            ] │  │ 56
   56   ├──────────────────────────────────────────────────────────┤ ─┤
   58   │▓▓▓▓▓▓▓▓▓▓ ManaLine 2px, full 390 wide ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  │ 2
        ├──────────────────────────────────────────────────────────┤ ─┘
        │   ┌──────────────────────────────────────────────────┐   │
        │   │                                                  │   │
        │   │   main · p-5                                     │   │
        │   │   wall 350 × 693                                 │   │
        │   │                                                  │   │
        │   │   columnsFor(350, 170) = 1 · gutter 90px         │   │
        │   │   columnsFor(350, 160) = 2                       │   │
        │   │                                                  │   │
        │   └──────────────────────────────────────────────────┘   │
  791   ├──────────────────────────────────────────────────────────┤ ─┐  1px border-t
        │  [ Q ] │ [ # ] │ [ ▤ ] │ [ ▦ ] │ [ ♥ ] │ [ ⚙ ]           │  │
        │ Search │ Tagger│ Decks │Collect│Wishlst│Settings         │  │ 52
  844   └──────────────────────────────────────────────────────────┘ ─┘
          65px    65px    65px    65px    65px    65px      + --safe-b

          The mana line stays at the top. The bar gets a plain hairline.
```

**Costs.** 53px of height (52 plus the `border-t`), before `--safe-b`. The wall goes from 746 tall
to **693**. And the option begins by paying for a copy of a private list: `NAV` — the one table
pairing each view's id, word and icon, and the table `Ribbon`'s `<h1>` is looked up in — is a
module-private `const` in `AppShell.tsx`, whose own comment says it is one list *"so there is one
word per view rather than two that can drift."* Drawing the six entries anywhere but the rail
means exporting it or writing it twice. The **icons** are free (`components/icons.ts` and lucide
are both importable); the **entry** is not — `NavItem` is private too, so its 44px row, its gold
hairline, its `aria-current` and its `useDndDropTarget` registration all have to be rebuilt or
exported.

**Buys.** The wall's full **350px**, and with it the second column at a 160px tile — the difference
between roughly 5 cards on screen and roughly 2–3. Navigation moves from the top-left to the thumb
zone. **Six tabs at 390 is 65px each and it is legible rather than merely possible**: measured, each
tab draws **65 × 52**, and every one of the six labels fits at `text-xs` with room to spare —
`Collection`, the longest, is 54.98px. 65 × 52 clears `--target-min` (44) in both directions with
no `coarse:` branch needed. And it gives `--safe-b` its first consumer: Task 2 published that
inset and deliberately applied it nowhere, "for whatever 9b puts down there", and a bar anchored
to the window's bottom edge is exactly that thing.

**The one design decision in the option, and it is a decision to spend nothing.** The app now has
chrome at two edges. The templated answer is a second 2px gradient under the bar so the frame is
"bracketed" — and that draws the signature twice. `Ribbon`'s own comment is the argument: the line
marks *the app's edge rather than the content's*, and a mark at both edges marks neither. So the
2px rule stays at the top, spanning the full 390 for the first time, and the bar carries
`border-t border-border` — this app's ordinary word for an edge. The signature keeps its single
job.

**Machinery.** Reuses `useSidebarDrops` **whole** — the drop *policy* is exported and knows nothing
about where the entries are drawn. Reuses `useAppStore.setActiveView` and `components/icons.ts`.
**Strands `useNavCollapsed` and `useNavLabels` outright** on this target: there is no rail to
collapse and no word to hold back for a width tween. Neither is deleted — desktop still uses both —
but a phone build runs neither, which means the `nav_collapsed` row is desktop-only state.
**Needs `NAV` exported and `NavItem` either exported or rebuilt.**

**The sidebar drop.** It follows the bar, and this is possible now in a way it was not before:
`@dnd-kit/react` is pointer-based, so a bottom bar can be a drop target and a finger dragging a
card down to it is the same gesture the library already serves. **It is also the better place for
it** — a drag that ends at the bottom of a phone ends where the thumb already is, where the rail's
top-left ends where it is not. The shipped `DROP_RING` is `ring-2 ring-accent` on a 65px tab
rather than a 183px row, so the ring is smaller; the option story draws it under a `dragging`
control so it can be looked at, and nothing on this page drags, so that is a picture and not a
proof. **Two things 9b must check on hardware**: that a 65px ring reads as an invitation, and that
`DROP_MARK_ROOM` is not needed — the bar is not inside a scroller, so the ring is not clipped.

**The status line.** Unchanged and still wrong: at 390 it gets 89 of 244. R2's own description
calls the ribbon "one title row", and the honest reading of the measurement is that R2 needs the
same shed R1 does — the same missing prop, and the same question about where `dataDir` and
`imageStoreFailures` go. **R2 has an answer R1 does not**: the Settings tab is now a permanent
44px target in the thumb zone, so "the data folder is named on Settings" stops being a page a
reader has to find and becomes one tap. That is the cheapest home for both facts and it is a
Settings change, not a ribbon change.

---

### R3 — a drawer behind the ribbon

Story export: **`DrawerBehindRibbon`** · id `mobile-chrome--drawer-behind-ribbon`

```
        0    44                                                  390
        ├─────┼──────────────────────────────────────────────────┤
    0   ┌─────┬────────────────────────────────────────────────────┐ ─┐
        │ ≡   │ Col…   116,5…    [ ⟳  Refresh data              ] │  │ 56
   56   │     ├────────────────────────────────────────────────────┤ ─┤
   58   │     │▓▓▓▓ ManaLine — starts 44px in ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  │ 2
        ├─────┴────────────────────────────────────────────────────┤ ─┘
        │   ┌────────────────────────────────────────────────────┐ │
        │   │   main · p-5                                       │ │
        │   │   wall 350 × 746 — the largest of the three        │ │
        │   │   columnsFor(350, 160) = 2                         │ │
        │   └────────────────────────────────────────────────────┘ │
  844   └──────────────────────────────────────────────────────────┘

   open: ┌───────────────────────────┬──────────────────────────────┐
         │ Views                 [✕] │▒▒▒▒▒▒▒ scrim ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
         │ [Q] Search                │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
         │ [#] Tagger                │▒▒▒ the wall, unreachable ▒▒▒▒│
         │ [▤] Decks                 │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
         │ [▦] Collection            │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
         │ [♥] Wishlist              │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
         │ [⚙] Settings              │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
         └───────────────────────────┴──────────────────────────────┘
          w-52 = 208px = 53% of the window, while it is open
```

**Costs — and the first one is not the taps.** `RibbonProps` has ten members and not one of them
is a slot, a child or an `onOpenNav`; the row is `<h1>` then an `ml-auto` group, and nothing can be
put in front of it. So the option story could only put the trigger *beside* the ribbon in a flex
row, **which insets the mana line by 44px**. Look at the wireframe: the 2px rule starts at x=44.
The constraint this round was handed says a signature that *grows* with its frame is a border;
this is the same sentence from the other end — a signature that stops 44px short of the window's
edge is not marking the app's edge at all. R3 is therefore **not a layout that can be built out of
what exists**. The prop is cheap; the arithmetic behind it is not.

**The title has nowhere to go.** At the full 390 the `<h1>` already gets 78 of the 125.75
`Collection` needs. A 44px trigger and a 16px gap take 60 of the 167.09 shared between title and
status, leaving each about 50. Cinzel may not go below 18px. So R3 keeps its title only if
`Refresh data` — 150.91px, 43% of the window — leaves the ribbon, and Refresh is a property of the
*app*, which is the whole argument for it being in a row that never changes.

**Two more things it needs that do not exist.** There is **no motion preset for a drawer**:
`motion.ts` had `drawerRight` and it was deleted on 2026-08-14 when the editor's two drawers became
centred modals, and a sheet that *travels* belongs on one of the top three tiers rather than on a
number invented here. And `src/CLAUDE.md`'s surface rule has to be argued rather than inherited — a
*consulted* surface is a `Dialog`, a surface *worked out of* earns a place in the layout, and
navigation is neither: it is where the reader is standing.

**Buys.** The most wall of the three — **350 × 746**, the full window less `main`'s padding, with
no chrome at the bottom at all. On an app that is a wall of card faces that is a real argument, and
it is the only one R3 has.

**Machinery.** Same as R2's: reuses `useAppStore`, `components/icons.ts`; needs `NAV` exported and
`NavItem` exported or rebuilt; strands `useNavCollapsed` and `useNavLabels`. **Additionally needs a
`RibbonProps` member and a motion preset**, neither of which R2 needs. The open sheet is drawn at
`w-52` — the rail's own 208px, so it is the rail lifted out of the layout rather than a new width
invented for one surface — which is **53% of the window** while it is open.

**The sidebar drop — this is what kills it.** You cannot drop onto a drawer that is closed, and the
whole point of the option is that it is closed. The two doors both fail on this target:

- **Open the drawer mid-drag by dwelling on the trigger.** Buildable — `@dnd-kit` is pointer-based
  — but it is a dwell, and the census records that every dwell in this app belongs to a pointer
  that arrives and does not leave. A finger holding a card over a 44px button for 250ms, with the
  card under the finger, is a gesture nobody will find.
- **Give up the drag and use the card's menu instead.** The census closes this one: `menuClick` —
  the plain-click door to a context menu — exists at exactly **two** surfaces in the whole app, the
  collection's and the wishlist's folder cards. Every other menu opens on right-click, Shift+F10 or
  the ContextMenu key, none of which a touchscreen has. So the fallback is itself unreachable.

R3 therefore does not merely move the drop; **it removes the app's only way to put a card found in
Search into a deck or a wishlist**, and the replacement is a second feature 9b would have to
design.

**The status line.** Worst of the three. R3 adds a fourth element to a row that already cannot hold
three, so the sentence is not truncated — it is gone, and so is most of the title. The prop R1
needs is compulsory here, and it is not enough on its own.

---

### Recommendation

**Recommended: R2 — the bottom tab bar.**

Because the number that decides this round is the column. At Round 2's candidate 160px tile,
`columnsFor(350, 160)` is **2** and `columnsFor(282, 160)` is **1**: the rail's 68px is not 17% of
the chrome, it is half the card art on screen — roughly 5 cards against roughly 2–3. R2 pays 53px
of height for 68px of width, and on a wall of 5:7 cards that is not the even trade it sounds like.
It puts navigation in the thumb zone, it gives `--safe-b` the consumer Task 2 published it for, and
its six tabs are measured legible at 65 × 52 rather than argued to be. Most importantly it keeps
the drop: `useSidebarDrops` is reusable whole, and a drag that ends at the bottom of a phone ends
where the thumb already is.

Its honest price is one `export` keyword on `NAV` and a second drawing of a nav entry — real, and
small beside what R3 needs.

**R1 is the fallback and it is not free.** If 9b's budget will not stretch, R1 ships today: the
option story is the shipped app with one boolean flipped, and it is the only option whose drop
target needs no thought at all. But it costs a column of card art on every screen forever, and that
cost is invisible in a wireframe and obvious on a phone.

**R3 should not be built.** Not for the extra 53px of height it buys back, which is real — but
because it needs a `RibbonProps` member, a motion preset the app deleted, and a whole replacement
for the sidebar drop, and because its own arithmetic takes the ribbon's title away: 78px is already
less than the 125.75 `Collection` needs, and a trigger takes most of what is left.

**One thing this round does not decide, and 9b owes an answer whichever option wins.** The ribbon's
status line does not fit on a 390px row in any of the three — 89px of the 244 it needs, with the
whole window and no rail. `Ribbon` needs a prop, or the sentence moves; and the two facts that live
**only** in its tooltip — which data folder is live, and how many card images could not be cached —
have to land somewhere a reader with no hover can reach. Settings is the obvious home and it does
not name either of them today.

---

## Round 2 — the wall of card faces

`src/features/search/MobileCardGrid.stories.tsx`, title **`Mobile/Card grid`**, three stories and
no `play` functions. Every option is drawn with the real component (G1 and G2) or the real card
pieces (G3) over the fake's 52-printing corpus, boxed at 390×844.

### The wall is 324px, not 350 — and that correction moves the answer

**The plan's Task 6 brief is arithmetically right and measures the wrong box.** `390 − main`'s
`p-5` = 350 is `CardGrid`'s **outer** box. Its `ResizeObserver` is on `rowsRef`, which sits inside
the scroller's own 1px border and its `p-3`, so what the column count is computed from is
`350 − 2 − 24` = **324**, less whatever a vertical scrollbar takes. That is the same subtraction
the docked panel's own note already writes down — "384 is 331 once the panel's left padding (12),
the scrollbar (17) and this wall's padding (24) are off it".

| | wall the observer sees | `columnsFor` | drawn | gutter each side |
| --- | --- | --- | --- | --- |
| shipped, phone | 324 | **1** | 170 | **77** |
| shipped, desktop Storybook frame (17px scrollbar) | 307 | 1 | 170 | 68.5 |
| the plan's figure | 350 | 1 | 170 | 90 |

The failure is the same either way — one card, half the screen as felt — but the fix is not:

| base | at 324 (phone) | at 307 (desktop frame) |
| --- | --- | --- |
| **160** — the plan's suggestion | **1 column**, 82px gutters | **1 column**, 73.5px gutters |
| 156 | 2 columns, 0 gutter | **1 column**, 75.5px gutters |
| 148 | 2 columns, 8px gutters | **1 column**, 79.5px gutters |
| **144** | **2 columns, 12px gutters** | **2 columns, 3.5px gutters** |
| 140 | 2 columns, 16px gutters | 2 columns, 7.5px gutters |

**`baseTileWidth = 160` draws one column on a phone.** 144 is the largest round width that
reaches two columns at both ends of that range, and it is chosen over 148 for a reason that is a
design decision rather than a safety margin: at 144 the leftover is 24px, so **the gutter either
side is 12 — exactly `GAP`**. The margins and the space between the cards become one measurement
and the wall reads as a 12px grid instead of as two cards with something left over.

Two more corrections to the brief, both about what `baseTileWidth` cannot do:

- **"A 6 % shrink on the chin's type" is not a thing this prop does.** `--mark-scale` is
  `cardScaleVars(zoom)` — the reader's *zoom* — and it knows nothing about `baseTileWidth`. The
  chin stays `chinHeight(zoom)` = 28px with 10px type at every base width. A narrower tile makes
  the chin proportionally **taller**: 10.7 % of the tile at 170, 12.4 % at 144.
- **`--control-scale` does not move either.** The quick-add's trigger is
  `size-[calc(1.5rem*var(--control-scale,1))]` = 24 × 0.85 = **20.4px** at 1×, on all three
  options. That is under WCAG 2.5.8's 24×24 (AA) before 2.5.5's 44 is even discussed, and the
  census already records that `REVEAL_ON_HOVER` leaves it `opacity-0` and still pressable on a
  touchscreen. **No option here fixes that**; G3 is the only one with room to.

Heights, for the comparison below. `tileHeight` is `round(width × 7/5) + chinHeight(1) − CHIN_RISE`
= `round(w × 1.4) + 24`. The story frame's wall is 844 − 40 (`p-5`) − 2 − 24 = **778px** of
content, with no ribbon and no filter bar in it — Tasks 5 and 8 own those, so treat the visible
counts as a ranking rather than as a figure.

---

### G1 — a phone tile width · `G1PhoneTile`

`baseTileWidth={144}`. One prop, and it is the prop the component already has: the deck editor's
docked panel passes 150 through the same seam, so this option is its **second caller** and adds no
code to `CardGrid` at all.

```
┌─ 390 phone ──────────────────────────────────────────────────────┐
│←20 main p-5                                                  20→ │
│   ┌─ CardGrid  outer 350 ────────────────────────────────────┐   │
│   │ border 1 + p-3 12                                        │   │
│   │  ┌───────────────────── wall 324 ──────────────────────┐ │   │
│   │  │←12→┌──── 144 ────┐←12→┌──── 144 ────┐←12→           │ │   │
│   │  │gutr│             │gap │             │gutr           │ │   │
│   │  │    │   CardArt   │    │   CardArt   │               │ │   │
│   │  │    │    5:7      │    │    5:7      │               │ │   │
│   │  │    │    202px    │    │    202px    │               │ │   │
│   │  │    │        [◈]  │    │        [◈]  │  ◈ = FoilOverlay│   │
│   │  │    │  ×3         │    │             │      top-right │ │  │
│   │  │    ├─CardChin 24─┤    ├─────────────┤               │ │   │
│   │  │    │◆ LEA · 161 F│    │◆ 2X2 · 117  │               │ │   │
│   │  │    └─────────────┘    └─────────────┘               │ │   │
│   │  │                   gap 12 ↕                          │ │   │
│   │  │    ┌─────────────┐    ┌─────────────┐               │ │   │
│   │  │    │             │    │             │               │ │   │
│   │  └────┴─────────────┴────┴─────────────┴───────────────┘ │   │
│   └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
   gutter 12 == gap 12 — one rhythm across the whole wall
```

**Costs and buys.** 2 columns × 144px drawn, 12px gutters, tile 226px tall, row pitch 238 — so
**6 whole cards** in the story frame's 778px and a sliver of a seventh. Against the shipped 170 it
is a 15 % narrower face (29,088 px² of art per card against 40,460) in exchange for twice as many
of them. The chin is unchanged: 28px tall, 10px type, gem + `SET · number` + finish mark + price,
all four still fitting because the middle item is `truncate flex-1`.

**Machinery.** Reuses everything. `columnsFor`/`tileWidthFor`/`sideGutterFor` all answer exactly as
they do on the desktop wall — `tileWidthFor`'s cap cannot bind at two columns by construction, and
`sideGutterFor`'s padding stays on the **row**, untouched. `arrowNav`/`gridNav` keep working
because `nextGridIndex` is handed a column count and gets 2. `CardArt` and `CardChin` are drawn
identically. `--mark-scale`/`--control-scale` are untouched, which is the option's one blemish as
well as its economy — the marks and the 20.4px quick-add are drawn at desktop size on a 15 %
smaller card. Strands nothing.

**What steps `cardZoom` on a phone: nothing, and that is the answer.** The ladder still works
wherever a wheel exists, and 144 is a size a reader does not have to correct. The reachable range
on this wall is four stops — 80 % draws 115 at 41px gutters, 90 % draws 130 at 26, 100 % draws 144
at 12 — and **110 % is 158, which is one column and an 83px margin**, i.e. the failure again. A
ladder whose useful span here is four of sixteen stops is an argument for getting the default right
rather than for building a gesture. Cost of "nothing": **zero**. Cost of the alternative, a control
at the filter bar's grid-or-table end: a new `zoomCards` caller (there is exactly one today,
`useCardZoomGesture.ts:86`), a second `FilterSurface` cell, and a control that steers a range four
stops wide.

---

### G2 — the gutter is the bug, not the tile · `G2StretchToFill`

The tiles share the leftover out and the wall reaches both edges.

```
┌─ 390 phone ──────────────────────────────────────────────────────┐
│←20 main p-5                                                  20→ │
│   ┌─ CardGrid  outer 350 ────────────────────────────────────┐   │
│   │  ┌───────────────────── wall 324 ──────────────────────┐ │   │
│   │  │┌───── 156 ─────┐←12→┌───── 156 ─────┐               │ │   │
│   │  ││               │gap │               │  no gutter    │ │   │
│   │  ││    CardArt    │    │    CardArt    │  either side  │ │   │
│   │  ││     5:7       │    │     5:7       │               │ │   │
│   │  ││     218px     │    │     218px     │               │ │   │
│   │  ││          [◈]  │    │          [◈]  │               │ │   │
│   │  │├─CardChin  24 ─┤    ├───────────────┤               │ │   │
│   │  ││◆ LEA · 161  F │    │◆ 2X2 · 117    │               │ │   │
│   │  │└───────────────┘    └───────────────┘               │ │   │
│   │  └─────────────────────────────────────────────────────┘ │   │
│   └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
   flush to both edges — 12px more card per tile than G1, 24px of margin gone
```

**Costs and buys.** 2 columns × 156px drawn, 0 gutter, tile 242px tall, pitch 254 — **6 whole
cards** in 778px, the same six as G1 at 34,008 px² of art each instead of 29,088. That is the whole
of what G2 buys over G1: **12px more card per tile and no margin.** It is not an alternative to
G1's number, it is G1 *plus* flush — the floor underneath the stretch still has to be a phone
number, because a 170px floor on a 324px wall is one column drawn at 324, which is the failure with
the margin painted over rather than removed.

**This is a settled decision being re-opened, and here is the record.** Stretch-to-fill was
`CardGrid`'s behaviour until commit **`f4c4326`, "feat(decks): resize the card search column, and
zoom that moves every step", Markus, Fri 14 Aug 2026**. Its message and `TILE_BASE_WIDTH`'s doc
comment give the same reason: the drawn width was a function of the **column count**, which is a
step function of the zoom. Measured on the deck editor's 330px column, the ten-stop ladder of the
day collapsed to three distinct widths — 102, 102, 159, 159, 159, 331, 331, 331, 331, 331 — "seven
gestures in a row that moved nothing on screen." The same measurement is written up in
`docs/reference/frontend-design.md` with the full table and the note that the sixteen-stop ladder of
2026-08-22 changed nothing it was about.

**On a 324px wall it is worse than it was on 330, not better.** The same sum against today's
sixteen stops and a 144px floor:

| stop | 50 % | 60 % | 70 % | 80 % | 90 % | 100 % | 110 % … 200 % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| columns | 4 | 3 | 2 | 2 | 2 | 2 | 1 |
| drawn | 72 | 100 | **156** | **156** | **156** | **156** | **324** ×10 |

**Four distinct widths across sixteen stops; twelve stops draw exactly what the stop before them
drew.** The 2026-08-14 argument does not merely still apply, it applies harder.

So the re-opening rests entirely on the sub-question, and it has to be argued that way: **on a
touchscreen nothing steps the ladder**, so there is no gesture for a step function to spoil and the
wall is drawn at one width forever. That is a real argument. Its price is that it makes the two
halves of this round's sub-question mutually exclusive — **G2 and any future phone zoom are
incompatible**, and the day somebody ships a pinch handler or a `−`/`+` pair at the filter bar's
grid-or-table end, this measurement comes back with twelve dead stops instead of seven. It would
also have to be conditional (phone stretches, desktop does not), which puts a second layout rule
inside `tileWidthFor` — a function whose entire body is currently one `min`.

**Machinery.** `columnsFor` is reused; `tileWidthFor` is **replaced** — the option is precisely a
change to that function, and it cannot be expressed through any prop the component has. The story
proves that: `StretchedWall` has to run its own `ResizeObserver` over `CardGrid`'s scroller,
mirror the module's unexported `GAP`, and feed the answer back in through `baseTileWidth`, dividing
by the zoom because `CardGrid` re-applies `scaled()`. `sideGutterFor` is **stranded** — it always
returns 0 under a stretch, and it is the function that exists because a one-sided remainder reads
as a column that failed to draw. `arrowNav`/`gridNav`, `CardArt`, `CardChin`,
`--mark-scale`/`--control-scale` are all untouched, exactly as in G1.

**What steps `cardZoom` on a phone: nothing, and this option requires that to stay true.** Cost of
"nothing": zero today, and the option's whole viability tomorrow.

---

### G3 — one column, art beside data · `G3RowList`

The tile turns on its side and the wall becomes a list.

```
┌─ 390 phone ──────────────────────────────────────────────────────┐
│←20 main p-5                                                  20→ │
│   ┌─ scroller  outer 350, p-3 ───────────────────────────────┐   │
│   │  ┌───────────────────── wall 324 ──────────────────────┐ │   │
│   │  │ ┌─ li  bg-surface border rounded-lg  p-2 ─────────┐ │ │   │
│   │  │ │┌── 96 ──┐                                       │ │ │   │
│   │  │ ││ CardArt│ Lightning Bolt                        │ │ │   │
│   │  │ ││  5:7   │ ── name, 14px sans, line-clamp-2      │ │ │   │
│   │  │ ││ 134px  │                                       │ │ │   │
│   │  │ ││    [◈] │ ◆ LEA · 161            F     ×3 ♥     │ │ │   │
│   │  │ │└────────┘ ── the chin's line, 10px mono, dim    │ │ │   │
│   │  │ └───────────────────────────────────────────────  ┘ │ │   │
│   │  │                    gap 12 ↕                         │ │   │
│   │  │ ┌─────────────────────────────────────────────────┐ │ │   │
│   │  │ │┌────────┐ Lightning Bolt                        │ │ │   │
│   │  │ ││        │ ◆ 2X2 · 117           F     ×1 ♥      │ │ │   │
│   │  │ │└────────┘                                       │ │ │   │
│   │  │ └─────────────────────────────────────────────────┘ │ │   │
│   │  └─────────────────────────────────────────────────────┘ │   │
│   └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
   art 96 · gap 12 · text 200 (li inner 308 after p-2)
   the chin's material becomes the plate the card sits on
```

**Costs and buys.** 1 column, 96px face = 134px of art, row 150px tall, pitch 162 — **4 whole rows
in 778px against G1's 6 cards**. A phone reads a list better than a wall; it does not fit more
cards on one. Art per card is 12,864 px² — under half G1's and under a third of the shipped
tile's. What it buys is the two things a 144px tile cannot hold: **the card's name in readable
14px type on every row**, and 200px of horizontal room at the right end of the row, which is where
a resident quick-add could live instead of the 20.4px `opacity-0` chip a finger cannot find today.

**Machinery.** It **strands `CardGrid` outright**, and that is the honest headline.

- **Stranded:** the virtualiser (the story is 43 fixtures; a browse is ~117 k printings, so
  shipping G3 means a second virtualised list or a row mode inside `CardGrid`);
  `columnsFor`/`tileWidthFor`/`sideGutterFor` — a one-column list has no column arithmetic;
  `arrowNav` and `gridNav`'s `nextGridIndex`, which take a column count and answer
  left/right/up/down, where at one column left and right mean nothing;
  `GRID_INDEX_ATTR`, the `pendingIndex` effect and the reflow retry, all of which exist because
  the 384px detail pane re-flows the grid *as the press that opened it is handled* — and on a
  phone that pane is an overlay over the whole window, so the premise is gone as well as the
  arithmetic. Also `--mark-scale`/`--control-scale`, which are simply not set: a row draws these
  marks at the size the three tables draw them, which is what the `, 1` fallback already gives.
- **Reused:** `CardArt` — the 5:7 frame, `CardImage`'s keying, `useImageRetry`, the no-art
  fallback and the **top-right `FoilOverlay`/`GameChangerMark` chip**, so the corner rule is
  honoured by the component that owns it rather than by this layout remembering to. And
  `CardChin`'s *vocabulary* rather than `CardChin`: the component is a bar with a height, a rise
  and three of its own edges, built to fuse to the bottom of a card, and laid beside one it is a
  bar fused to nothing. What moves across is the line it draws — `RarityGem`, `SET · number` in
  the mono face at 10px `text-dim`, `FinishMark` — and the plate the row sits on is that bar's own
  material (`bg-surface`, `border-border`), grown to hold the card instead of hanging under it.
  **The chin becomes the row**; that is the option's signature and it is borrowed from the app
  rather than invented for it.
- **Preserved by construction:** `scroll-m-1.5` on every row, for `CardGrid`'s reason —
  `scrollIntoView({ block: "nearest" })` parks a row flush against the scrollport's padding box and
  `FOCUS` paints 4px proud of the border box, so 6px is `DROP_MARK_ROOM`'s number written the same
  way in both places. And the tile's own accessible-name arrangement: the art is the `<button>`
  and the text beside it is a sibling with a click of its own — exactly what the tile's two corner
  marks are — so the row is tappable end to end, has one tab stop, and the button is still called
  "Lightning Bolt" rather than "Lightning Bolt LEA · 161 Foil".

**What steps `cardZoom` on a phone: nothing, and here nothing needs to.** `cardZoom.search` is read
by no part of this option — a row's height is a decision about a list rather than a size a reader
would steer — so the frozen ladder costs G3 exactly nothing, where for G1 it costs four usable
stops and for G2 it is a load-bearing assumption. That is the one axis on which G3 is the cheapest
of the three.

---

### The three side by side

| | G1 · `G1PhoneTile` | G2 · `G2StretchToFill` | G3 · `G3RowList` |
| --- | --- | --- | --- |
| columns at 324 | 2 | 2 | 1 |
| drawn width | 144 | 156 | 96 (art) |
| gutter each side | 12 (= `GAP`) | 0 | n/a |
| row pitch | 238 | 254 | 162 |
| cards in 778px of wall | 6 | 6 | 4 |
| art per card | 29,088 px² | 34,008 px² | 12,864 px² |
| card name in type | no (art only) | no | **yes, 14px** |
| code changed in `CardGrid` | **none** | `tileWidthFor` | the whole component is bypassed |
| `sideGutterFor` | reused | stranded (always 0) | stranded |
| `arrowNav` / `gridNav` | works, 2 columns | works, 2 columns | stranded |
| `--mark-scale` / `--control-scale` | unchanged (desktop-size marks on a 15 % smaller card) | same | unset; table-size marks on a 96px face |
| zoom ladder usable stops | 4 of 16 | 4 distinct widths of 16 stops | not read at all |
| 20.4px quick-add | unfixed | unfixed | **room to fix** |

---

### Recommended: G1, because it is the only one whose cost is a number rather than a decision

`baseTileWidth={144}` is one argument at one call site, on a prop that already exists and already
has a caller. It doubles the cards on screen, it puts the wall on a single 12px rhythm, and it
strands nothing — `columnsFor`, `tileWidthFor`, `sideGutterFor`, `arrowNav`, `gridNav`, `CardArt`,
`CardChin` and both scale variables all keep working unchanged, which no other option on this page
can say. Against the shipped desktop tile it gives up 15 % of the card's width, and that is the
entire bill.

The case against G2 is that it buys 12px of card in exchange for re-opening a decision whose
measurement is **worse now than when it was taken** — four distinct widths across sixteen stops,
twelve of them dead — and it can only be defended by promising that nothing will ever step
`cardZoom` on a phone. That is a promise this plan is not in a position to make: the sub-question
it is answering is precisely *what should* step it. Twelve pixels is not worth spending a future
option on.

The case against G3 is not that it is wrong; it is the most interesting of the three and it is the
only one that puts the card's **name** on screen in readable type, which on a wall of four
Lightning Bolts is the thing a reader is actually looking for. It is a strong candidate the day
this app decides a phone is a *finding* device rather than a *browsing* one. But it shows fewer
cards than G1 in the same height, it gives up the wall of faces the app's whole feel rests on, and
it costs a second virtualised list, a second keyboard walk and a second definition of what a card
row is — three things this repo has spent a year deleting duplicates of. Take it deliberately in
9b if the browse-versus-find question is re-opened, not as a phone tweak.

**One thing to look at before choosing, which none of these stories can settle:** the three frames
are drawn against the whole 390px window, because the ribbon and the rail are Task 5's round. If
R1 wins and the 68px collapsed rail stays, the wall drops to `390 − 68 − 40 − 26` = **256**, where
`columnsFor(256, 144)` is **1** again — 144 would have to become 122 (2 columns, 0 gutter) or 113
(2 columns, 9px gutters), i.e. a 33 % smaller card than the desktop's. **G1's number is a function
of Task 5's answer**, and that dependency runs one way only: R2 and R3 give the wall the full
window and 144 stands.

---

## Round 3 — the deck editor

`src/features/decks/MobileDeckEditor.stories.tsx`, title **`Mobile/Deck editor`**, three stories
and no `play` functions. All three mount the real `DeckEditor` and the real `DeckSearchPanel` over
the fake's seeded decks, boxed at 390×844 by a decorator declared in that file.

**Two things about how this was checked, because both change what the previews prove.** The
`mtg-grimoire-sb-mcp` server refused every connection for the whole of this session, so **every
prop used below and in the story file was read out of the component's own TypeScript props type
and quoted verbatim in the task report** — the substitute the controller set, which is stricter
than the MCP rather than looser. And `src/stories.test.tsx` **skips a story file that has no
`play`** — `if (plays.length === 0) continue;`. `composeStories` still runs at module scope, so
an import-time break goes red, but nothing here is *rendered* by the suite. The plan's global
constraint says these stories "will go red if an option throws"; that is true of an import and
not of a render, and the only proof they draw is opening the three URLs.

**The shipped code already answers the question this round was written to ask, and the round is
therefore about something narrower.** `roomForPanel` is `deskWidth === 0 || maxPanelWidth >=
MIN_PANEL_WIDTH_PX`, and its threshold is `DECK_FLOOR` (192, `DeckEditor.tsx:215`) + `DESK_GAP`
(16, `:219`) + `MIN_PANEL_WIDTH_PX` (206, `DeckSearchPanel.tsx:74`) = **414**. A phone's desk is
350 at its widest, so the docked search column is *already* railed to its 36px chevron, and the
chevron is *already* `aria-disabled` with the sentence `Not enough room — close the card details
or widen the window` on it. Nothing is broken and nothing overflows the page. **What is missing is
an answer**: the rail says no and offers nothing instead. So the three options below are three
things the rail could open into, not three ways to make two columns coexist.

### The desk is 350 only if the nav rail goes — this round is downstream of Round 1

Driven at 390×844 in the shipped window on 2026-08-29 (the same pass as the wall's round):
`main`'s content is **142px** with today's expanded 208px nav rail, **282px** with the collapsed
68px one, and **350px** only with no rail at all. `TitleBar` is 34 and the ribbon plus its
`ManaLine` is 58, leaving `main` 752 tall and 712 of content.

**142 is below `DECK_FLOOR` outright** — the deck side of the desk row is guaranteed 192 and there
are 142 to give — so at a 390px window with the rail as it ships today, the deck builder is
already past the width its own arithmetic is written for. That is not one of the three options'
doing and none of them fixes it: **every number below assumes Round 1 takes the rail off a phone.**

| desk | docked column | deck view box | `StackView` flow (needs 224) | `TextView` flow (needs 300) |
| --- | --- | --- | --- | --- |
| 350 (no nav rail) | railed, 36 + 16 gap | 298 → **286** inside `DROP_MARK_ROOM` | fits, 62 spare | **overflows by 14** |
| 350 | deleted | 350 → **338** | fits, 114 spare | fits, 38 spare |
| 282 (collapsed nav rail) | railed | 230 → **218** | **overflows by 6** | **overflows by 82** |
| 282 | deleted | 282 → **270** | fits, 46 spare | **overflows by 30** |
| 142 (today's default) | railed | 90 → **78** | **overflows by 146** | **overflows by 222** |

`DROP_MARK_ROOM` is `p-1.5` (`src/lib/dropMarks.ts:66`), 12px off the width, and it is not
negotiable: it is what keeps a `DROP_RING` and a `FOCUS` outline off the scrollport's clip edge.

**Two corrections to the plan's Task 7 brief fall out of this table.** The brief says `TextView`'s
300px column is "one column, no overflow" — true against 350, false against the box the view is
actually given, because the railed panel and the desk gap take 52px first. And **`COLUMN_WIDTH` is
a module constant, not a prop** (`TextView.tsx:68`; `columnHeight` is the prop, and it is the other
axis), so no option can narrow it from outside: the 14px overhang is D1's to live with and 9b's to
fix. It is contained — the view root is `overflow-x-auto` — so it is a scrollbar inside the deck
rather than the page-wide one the desktop floor forbids. It is still a horizontal scrollbar on a
phone in a view that has one column in it.

### The header ladder does not discriminate, and all three want the same fourth rung

`WIDE_HEADER_PX` 1400, `SETTINGS_ICON_PX` 1100, `TIGHT_HEADER_PX` 900, read off `deskWidth`
(`DeckEditor.tsx:769–771`). At 298, 350 or 282 the answer is the same on every option: `tightHeader`
and `settingsIcon` both on, `wideHeader` off — every action word dropped, the back link's `Decks`
dropped, the check chip keeping its count and dropping its word, and the toolbar splitting into two
lines by `order` plus a zero-height `basis-full` break. **A fourth rung is a smaller change than a
new mechanism and it is orthogonal to which option wins**, which is worth saying plainly: it is 9b
work whatever is chosen, and it is not an argument for any of the three.

What the ladder cannot fix at this width is the **actions row**, which wraps: back link 36 + the
name field's `NAME_FLOOR` (`min-w-40`, 160) + six 36px glyphs on `gap-2` (256) is about **470px of
min-content against 350**. That is arithmetic off the classes, not a measurement — see the owed
reading at the foot of this section.

---

### D1 — the rail opens into a full-width overlay · `RailOpensAnOverlay`

```
 390 ×844                          rail open (the arg's default)
┌────────────────────────────────────────────────────────┐
│ ░░ main p-5, 20px ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ ┌────────────────────────────────────────────────────┐ │
│ │ ‹  Add cards                            [chevron ▸]│ │  DeckSearchPanel
│ │  [ Collection ][ All cards ]                       │ │  drawn at 350,
│ │  [ search your collection ......................  ]│ │  roomy = true
│ │  WUBRG [0][1][2][3][4][5][6][7][8][X]  [Filters]   │ │  (FilterBar's
│ │ ───────────────────────────────────────────────────│ │   sub-640 band)
│ │  ┌──────────┐                                      │ │
│ │  │  card    │   one tile, wide gutters, Round 2's  │ │
│ │  │  face    │   finding, inherited unchanged       │ │
│ │  └──────────┘                                      │ │
│ │  [ Add Sol Ring to Ramp ]                          │ │
│ └────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
                    ▲ the deck is entirely behind this

 rail closed — the shipped state, unchanged
┌────────────────────────────────────────────────────────┐
│ ‹ [ Kenrith Two-Drops ]   ⇄ ⇆ ⚙ ⟲ ⟳ ⚖   ← row wraps    │
│ cards · lands · avg mv · price · owned · ~bracket · ⚠  │
│ [Theory|Actual] [Compare]  [Grid▾][Category▾][A–Z▾]    │
│ [ quick add a card ]          ⟲ ⟳   [ filter cards ]   │
│ ┌──────────────────────────────────────────────┐ ┌──┐  │
│ │ COMMAND ZONE            224 ────────────────┐│ │▸ │  │
│ │ ┃ Kenrith, the Returned King              ┃ ││ │  │  │
│ │ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ ││ │  │  │
│ │ Main deck                    17 rows, 871px ││ │36│  │
│ │ ┃▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓┃ ││ │px│  │
│ │ ┃▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓┃ ││ │  │  │
│ │ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ ││ │  │  │
│ │        62px blank      ┌────────────────┐   ││ │  │  │
│ │        ───────────────▶│ RAIL  Sideboard│   ││ └──┘  │
│ │        (rail wraps to  │       Maybeboard   ││  ▲    │
│ │         its own line)  └────────────────┘   ││  the  │
│ └──────────────────────────────────────────────┘ handle│
│   deck view box 298 ──────────────────────┘  16 gap ─┘ │
└────────────────────────────────────────────────────────┘
```

**What it costs and buys.** The rail is 36 + `DESK_GAP` 16 = **52px of desk, permanently**, and
that is the whole of the option's price. It leaves the deck view box at 298 → 286 inside
`DROP_MARK_ROOM`: `StackView` is one 224px pile per line with 62px spare, the rail (Sideboard,
Maybeboard) wraps to a line of its own and lands at its right edge on `ml-auto` with those 62px
blank in front of it, and `TextView` overflows its box by 14px. Below 900 of `deskWidth` the
header is already at its tightest rung, so D1 changes nothing there.

**Machinery reused or stranded.** It reuses the most of the three by a wide margin. `roomForPanel`
stays, `deskWidth` stays, `PANE_OVER_ATTR`'s overlay pattern is borrowed whole — the card pane
already draws over whichever of the two columns the reader was *not* looking at, so an overlay
over the deck is a pattern this editor ships rather than one it learns. `StackView`, `TextView`
and `GridView` are untouched. Nothing is stranded.

**What it needs that it has not got.** One thing, and it is not free: `roomForPanel`'s *consequence*
has to change. Today it is a boolean meaning "draw the column beside the deck", and where it is
false the disclosure is `aria-disabled` and refuses the press outright
(`onClick={() => roomy && setOpen(!open)}`, `DeckSearchPanel.tsx:580`). D1 makes it a three-way
question — beside the deck, over the deck, or not at all — and there is no prop that says the
middle one. That is why the story hands the open state to Controls rather than to a control in the
frame: the shipped rail *cannot be pressed* at 390.

**Cross-surface drag.** Gone while the overlay is up, and honestly so: the overlay covers the deck,
so there is nothing to drag *into*. Adding is a tap on the panel's own `Add <card> to <pile>`
button — which is not a fallback but the path this editor already names, since the pile is a deck
setting (`decks.default_category_id`) and every Add button says which one it is. Drag *inside* the
deck is untouched: pile reorder, card between piles, the remove tray.

---

### D2 — the search becomes a bottom sheet · `SearchAsABottomSheet`

```
 390 ×844                                     sheet up (40 % = 338px)
┌────────────────────────────────────────────────────────┐
│ ┌──────┬──────┬──────┬──────┐  ← QuickZones, sticky    │  92px, and only
│ │ Auto │ New  │Maybe │Side  │    top-0, for the length │  while a card is
│ │      │categ.│board │board │    of a drag             │  in the air
│ └──────┴──────┴──────┴──────┘    70.5 × 76px each      │
│ ‹ [ Kenrith Two-Drops ]  ⇄ ⇆ ⚙ ⟲ ⟳ ⚖                   │
│ cards · lands · avg mv · price · owned · ~bracket · ⚠  │
│ [Theory|Actual] [Compare] [Grid▾][Category▾][A–Z▾]     │
│ ┌──────────────────────────────────────────────┐ ┌──┐  │
│ │ COMMAND ZONE                                 │ │▸ │  │  ← the shipped
│ │ ┃ Kenrith, the Returned King               ┃ │ │36│  │    rail, which
│ │ Main deck                                    │ │px│  │    D2 deletes
│ │ ┃▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓┃ │ │  │  │    and has no
│ └──────────────────────────────────────────────┘ └──┘  │    prop for
│▓▓▓▓▓ prices · cut cards go to Recently removed ▓▓▓▓▓▓▓▓│  ← PriceStrip, and
│════════════════════ ▬▬▬▬ ═════════════════════════════ │    the remove tray
│  ‹  Add cards                           [chevron ▸]    │    at sticky
│   [ Collection ][ All cards ]                          │    bottom-0 —
│   [ search your collection ........................ ]  │    UNDER the sheet
│   WUBRG [0][1]…[X]                      [Filters]      │
│  ┌──────────┐                                          │  338px, less the
│  │  card    │  ← drag up, past the sheet's edge,       │  handle and p-5:
│  │  face    │    over the deck, onto a pile or one     │  ~150px of wall,
│  └──────────┘    of the four zones above               │  one tile row
└────────────────────────────────────────────────────────┘
```

**Correct the headline first: D2 is not the only option that spends what the dnd-kit migration
bought.** `@dnd-kit/dom@0.5.0`'s `PointerSensor` is what makes *every* drag in this editor
touch-capable — the card between piles, the category grip's reorder, the drop onto the remove
tray, the four quick zones. All of those survive under D1 and D3 too. What is at stake here is
**only the search→deck drag**, and that is one gesture of six.

**What it costs and buys.** It buys the one gesture the other two give up, and the reason it can is
not the sheet — it is `QuickZones`, which already draws `Auto`, `New category`, the Maybeboard and
the Sideboard as four dashed boxes `sticky top-0` for the length of a drag, 92px tall on a
`gap-3`/`px-4` bar. At a 350px desk each is **70.5 × 76px**, above WCAG 2.5.5's 44 on both axes, so
the top half of the corridor a drag out of a sheet needs is **already built and already the right
size**. (At 282 they are 53.5px wide; at today's 142 they are 18.5, under even 2.5.8's 24.)
`New category` will not fit on one line inside 70px.

Deleting the docked column gives the deck its full 350 → 338 of view content: `StackView` gets
114px of spare and `TextView` **stops overflowing**. That is bought back only while the sheet is
down; with it up, the bottom 338 of 844 is the sheet.

**Machinery reused or stranded.** `deskWidth` is reused and `roomForPanel` is **stranded** — the
measurement it makes is still true and its answer stops being the one anybody wants, so it becomes
a rung nothing reads. `PANE_OVER_ATTR` is unaffected but now has a peer: the card pane and the
sheet are both `LAYER.popup`, ordered only by document order, and a card opened from inside the
sheet has to draw over the sheet rather than under it. That is a real 9b question and the layer
scale has no rung for it. `StackView`/`TextView`/`GridView` are untouched.

**Three things it needs that it has not got.**

1. **`DeckEditor` has no prop that stops it drawing the docked column.** The dock is unconditional
   (`DeckEditor.tsx:3996`), so the 36px rail in the frame above is the shipped code showing
   through. D2 deletes it and there is nothing to pass.
2. **`DeckSearchPanel`'s left hairline is a statement about a column.** Its own comment says the
   whole of it: "Everything right of the line is not your deck." That is true of a column and false
   of a sheet, and there is no prop to turn it off.
3. **A sheet lands on the remove tray.** `PriceStrip` goes `sticky bottom-0` while a card is in the
   air (`PriceStrip.tsx:173`) precisely so the tray sits at the foot of the *window* rather than at
   the foot of a 7 000px deck — which on a phone is under the sheet. Either the tray moves for the
   length of a drag out of the sheet, or the sheet does.

**How a sheet extends `src/CLAUDE.md`'s rule rather than breaking it.** The rule is:

> **A surface opened from a view is a centred modal over a scrim, not a docked column — unless the
> reader works _out of_ it while editing beside it.** […] Only a surface that is _worked out of_
> earns a place in the layout — the deck editor's card search column, whose tiles are drag sources
> into the deck's own category columns, and the card detail pane […] — and both of those are
> collapsible or dismissible.

and, from the same bullet after issue #183:

> a consulted surface is a modal, a worked-out-of surface earns its place — **and a surface worked
> out of _beside_ another one may not take the other's width to do it.**

A sheet is unambiguously the second kind: its tiles are drag sources into the deck, so a scrim
would end the drag path — which is the rule's own test, and it is why this cannot be a `Dialog`.
What the rule does not anticipate is a window with **no width to give**. The extension is one
sentence and it is a strengthening rather than an exception: *a worked-out-of surface earns a place
in the layout, and where the window has no width to spare it takes that place out of the **other**
axis — the foot of the window rather than the side of it — and stays dismissible.* Every clause of
the original survives: no scrim, no `aria-modal`, no `trapTab`, the drag path intact, the surface
collapsible. What is added is that "a place in the layout" is not necessarily a column. The thing
to watch is the sentence it must not become — "any surface may be a sheet" — because a *consulted*
surface drawn as a sheet is a `Dialog` with the modality quietly removed, and history, categories,
tags and deck settings all stay `Dialog`s.

**Cross-surface drag.** Kept, and it is the only option that keeps it. The gesture is: press a
tile in the sheet, drag up across the sheet's top edge, and either land on a pile (224px wide, and
the reader may have to scroll the deck to reach the one they want — which cannot be done mid-drag)
or on one of the four quick zones at the top of the window, which need no scrolling and are the
larger targets. **The quick zones are the honest answer and the piles are not**, which is worth
saying because it changes what D2 is buying: not "drag a card to the pile you want" but "drag a
card out of the search and let the deck file it", which is `{ kind: "auto" }` — a write that
already exists and already files by what the card does.

---

### D3 — `Deck | Find`, one pane at a time · `DeckAndFindOneAtATime`

```
 390 ×844                                            Find pressed
┌────────────────────────────────────────────────────────┐
│  [  Deck  ] [ ▓Find▓ ]      ← two ToggleChips, 36px,   │  36 + gap ≈ 48px
│                               aria-pressed, in a        │  of height, on
│                               role="group"              │  every screen
│ ┌────────────────────────────────────────────────────┐ │
│ │ ‹  Add cards                            [chevron ▸]│ │
│ │  [ Collection ][ All cards ]                       │ │  the panel at
│ │  [ search your collection ......................  ]│ │  the full 350
│ │  WUBRG [0][1]…[X]                      [Filters]   │ │
│ │ ───────────────────────────────────────────────────│ │
│ │  ┌──────────┐                                      │ │
│ │  │  card    │                                      │ │
│ │  └──────────┘  [ Add Sol Ring to Ramp ]            │ │
│ └────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘

                                                    Deck pressed
┌────────────────────────────────────────────────────────┐
│  [ ▓Deck▓ ] [  Find  ]   ← and directly under it:      │
│ ‹ [ Kenrith Two-Drops ]  ⇄ ⇆ ⚙ ⟲ ⟳ ⚖                   │
│ cards · lands · … · ⚠                                  │
│ [Theory|Actual] [Compare] …   ← a SECOND segmented pair│
│ ┌──────────────────────────────────────────────┐ ┌──┐  │
│ │ COMMAND ZONE                                 │ │▸ │  │ ← the shipped
│ │ Main deck            224 ───────────┐        │ │36│  │   rail, which
│ │ ┃▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓┃│  114px │ │px│  │   D3 deletes
│ │ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛│  spare  │ └──┘  │
│ └──────────────────────────────────────────────┘       │
└────────────────────────────────────────────────────────┘
```

**What it costs and buys.** It buys the deck the whole desk — 350 → 338 of view content, so
`StackView` has 114px spare and `TextView` fits with 38 to spare. It is the only option that
removes the 14px `TextView` overhang without a change to `COLUMN_WIDTH`. It costs about **48px of
height on every screen** (a 36px `ToggleChip` row plus its gap), on the axis the phone has least
of: the visible viewport on a mobile browser is roughly 700, `main`'s `p-5` takes 40, and the
editor's own header is three fixed lines of which two already wrap.

**And it puts a second segmented pair on a screen that has one.** `Theory | Actual` sits four lines
below it, drawn the same way — `aria-pressed` over a `.map`, deliberately not `role="tab"` — and
means a completely different kind of thing: which of the deck's two *lists* is on screen, against
which of the editor's two *panes*. Two identical-looking pairs one above the other, one about the
deck's contents and one about the app's navigation, is a vocabulary lesson the reader has to be
given.

**Machinery reused or stranded.** `deskWidth` reused; `roomForPanel` **stranded**, as in D2 —
there is no second column for it to measure against. `PANE_OVER_ATTR` is stranded *in the Find
pane* specifically: a card opened from a search tile draws its pane "over the deck", and there is
no deck on screen to draw over — the pane's own geometry (`right: 0, width: deskWidth`) still
works, but the sentence the arrangement exists to make ("cover what the reader was not looking at")
stops being true when there is only one thing to look at. The views are untouched.

**What it needs that it has not got.** The same missing prop as D2: `DeckEditor` draws its docked
column unconditionally, and D3 has no use for it at all.

**Cross-surface drag.** None, by construction — the two surfaces are never on screen together. Drag
inside the deck is untouched. This is the same cost D1 pays while its overlay is up, made
permanent.

---

### The three side by side

| | D1 overlay | D2 sheet | D3 one pane |
| --- | --- | --- | --- |
| story export | `RailOpensAnOverlay` | `SearchAsABottomSheet` | `DeckAndFindOneAtATime` |
| desk left to the deck | **298** (52 to the rail, always) | 350 | 350 |
| `StackView` at 1× | 1 pile/line, 62 spare | 1 pile/line, 114 spare | 1 pile/line, 114 spare |
| `TextView` | **overflows 14px** | fits | fits |
| height spent on chrome | 0 | 0 at rest, **338 with the sheet up** | **~48, always** |
| new surface type | none | **a sheet** | none |
| new vocabulary | none | a grab handle | **a second segmented pair** |
| props it needs and has not got | `roomForPanel` becomes three-way | no dock; no hairline; the tray moves | no dock |
| search→deck drag | no (while open) | **yes** | no |
| drag inside the deck | yes | yes | yes |
| `roomForPanel` | **reused** | stranded | stranded |
| `PANE_OVER_ATTR` | **reused whole** | needs a rung against the sheet | half-stranded |

### The measurement this round owes, and the exact recipe for it

**Not taken.** The controller holds the app lock for the whole of this session, so the shipped
editor was not driven at a phone width by this task. Everything above the D1 heading that is not
attributed to the 2026-08-29 chrome pass is **arithmetic over the shipped constants**, and the
overflow figures in particular are derived rather than read. Take this before 9b:

```powershell
node scripts/cdp.mjs size 390 844
# Open a multi-category deck first — deck 4 in the fake, or any Commander deck in the real db —
# and run the eval once per view, switching the toolbar picker across Stacks / Text / Grid.
# Single quotes throughout and no $: a double quote cannot survive the PowerShell hop into
# cdp.mjs eval, so the selectors are attributes the views already stamp and the one string
# compare is single-quoted.
node scripts/cdp.mjs eval "(() => { const r = e => e ? { w: Math.round(e.getBoundingClientRect().width), sw: e.scrollWidth, cw: e.clientWidth, over: e.scrollWidth - e.clientWidth } : null; const g = document.querySelector('[data-deck-group]'); let root = g; while (root && getComputedStyle(root).overflowX !== 'auto') root = root.parentElement; const box = root && root.parentElement; const desk = box && box.parentElement; const panel = [...document.querySelectorAll('section')].find(s => s.getAttribute('aria-label') === 'Add cards'); return { innerWidth: window.innerWidth, clientWidth: document.documentElement.clientWidth, bodyScrollWidth: document.body.scrollWidth, desk: r(desk), viewBox: r(box), viewRoot: r(root), panel: r(panel), stack: r(document.querySelector('[data-deck-stack]')), rail: r(document.querySelector('[data-deck-rail]')), command: r(document.querySelector('[data-deck-command]')) }; })()"
node scripts/cdp.mjs size 1280 800
```

Three things about that recipe, each of which has cost somebody a pass:

- **`size` hardcodes `mobile: false`**, so this emulates a narrow *desktop*: no URL bar, no
  `visualViewport` behaviour, no coarse pointer. It measures width arithmetic, which is all this
  round needs, and it measures nothing at all about touch.
- **WebView2 ignores `clearDeviceMetricsOverride`**, so the third line is not optional. The window
  does not come back on its own.
- **`innerWidth`, `scrollWidth` and the rect must be in the same `eval`.** The window can be
  resized between two invocations, and a wide desk reads exactly like an absence of overflow.

**What an overhang would mean.** `DeckEditor`'s section is not the scroller any more — `AppShell`'s
`main` is, and it is `overflow-auto`, which computes `overflow-x` to `auto` as well. So a flex item
that cannot shrink below its min-content hangs out of the desk row and becomes **a horizontal
scrollbar across the whole deck builder**, arriving with nothing on screen naming the culprit and
nothing in the box tree wrong. That is the one failure the desktop floor forbids and the one this
folder has twice gone looking for. `body.scrollWidth` against `documentElement.clientWidth` in the
payload above is what tells it from the *contained* overflow the three views' own `overflow-x-auto`
draws, which is a scrollbar inside the deck and is a different (smaller) problem.

### Recommended: D1, because its cost is 52px and every other cost on the table is a decision

`RailOpensAnOverlay`. Three reasons, in the order they should be weighed.

**It is the only option whose price is a number.** 52px of desk, permanently, and a 14px overhang
in one of four views. D2's price is a surface type this app does not have, a rule that has to be
extended, a layer contest with the card pane, and a collision with the remove tray. D3's price is
48px of the scarcest axis plus a second segmented pair meaning something different from the one
under it. A number can be traded against; the other two have to be got right.

**The gesture D2 buys is already answered by a control.** Cross-surface drag exists on the desktop
because a drop is how a reader says *which pile*. On a phone that question is already answered
somewhere better: the pile is a deck setting (`decks.default_category_id`), and every Add button in
the panel is named for the card **and** the pile it will land in. The drag D2 preserves, honestly
described, is "drag out of the sheet and let the deck file it" — which is `{ kind: "auto" }`, and
which the Add button does in one tap with the destination written on it. Meanwhile every drag D2 is
credited with keeping that a reader would actually make on a phone — a card between piles, a pile
reordered, a card onto the remove tray — is kept by all three options, because `@dnd-kit/dom`'s
`PointerSensor` is what delivers those and no option touches it.

**It is the only option that adds nothing to learn.** The rail is where the search already lives,
the chevron is the control the reader already presses, and a surface drawn over the column you were
not looking at is what the card pane in this editor already does. D1 is the shipped fallback with
an answer attached to it.

**What recommending it commits 9b to**, stated so the next plan does not have to infer it:
`roomForPanel` stops being a boolean and becomes a three-way answer — beside the deck, over the
deck, not at all — with the disclosure's refusal replaced by the middle one at phone widths; and
`TextView`'s `COLUMN_WIDTH` gains a way to be narrower than 300 at a 286px box, or the Text view is
taken off the phone's view picker. Neither is large. Both are named.

**And the condition on all of it**: this round is drawn against a 350px desk, which exists only if
Round 1 takes the nav rail off a phone. If the collapsed 68px rail is kept, the desk is 282, D1's
deck view box is 218 and `StackView`'s own 224px pile overflows by 6px — at which point D1 stops
being the cheap option and D3 becomes the recommendation instead. **The two rounds have to be
decided together, and Round 1 is decided first.**

**If drag turns out to matter after all**, D2 is the option to revisit and the revisit is cheap,
because the expensive half of it is already built: the four quick zones are 70.5 × 76px at a 350px
desk and they are the drop targets a phone drag can actually hit.

---

## Round 4 — the filter bar

**This round is narrower than the other three, and the tree is why.** `FilterBar` already lays out
by its own width in four bands at 640 / 900 / 1500, and the sub-640 band was not drawn for a phone
by accident — it was drawn for the deck editor's docked search panel at its **206px floor**, a
~193px content box, half a phone. Below 640 the search box already takes a whole line through
`basis-full`, the row's gaps already close from 12 to 8, and `ManaValueChips` already drops from
`size-9` to `size-8`. Confirmed against the source. The spec listed this surface as open; the tree
says most of it is answered, and **the honest result of this round is that there was less here than
the spec assumed.**

**What is left is the vertical budget, and it is the only thing that decides between the three.**
At 390×844 a mobile browser leaves roughly **700px** visible. The ribbon block takes 58 (Round 1's
measurement — `h-14`'s 56 plus `ManaLine`'s 2) and `main`'s `p-5` takes 40, leaving a **602px**
content column. Out of the full 844 frame the same column is **746**, which is exactly Round 1's
R3 figure — the two rounds reconcile. Anything the bar spends is spent out of the only thing the
reader opened the app for.

### What the shipped bar actually costs, measured

Measured 2026-08-29 in headless Chromium over the built stylesheet
(`dist/assets/index-HbsLLTR6.css`), with `FilterBar`'s own class strings transcribed at a **350px**
container — 390 less `main`'s `p-5`. The container is `@container/fb` with `container-type:
inline-size` confirmed live, so every band below 640 is the one the app really applies.

| The bar, tray shut, nothing filtered | px |
| --- | --- |
| line 1 — search box, `basis-full` | 36 |
| line 2 — six colour chips (246) + `Filters` (96) | 36 |
| the `order-[10]` break — zero height, but a flex **line**, so `gap-y-2` costs 8 either side | 0 |
| line 3 — ten mana-value chips at `size-8`, **wrapped 9 + 1** | 68 |
| the `order-[28]` break | 0 |
| line 4 — sort trigger (266 incl. its arrow) + the grid/table pair (76) | 36 |
| the row, with five `gap-y-2` line gaps | **216** |
| `gap-2` + the rule and the always-drawn `Reset all` | 8 + 49 |
| **whole bar** | **273** |

**Three of those are worth stating on their own.**

1. **The plan's brief is out by ~170px.** It estimated "two-or-three lines at ~36–40 each" and a
   wall of "about 500px". The bar is **four** lines plus two zero-height break lines plus the
   `Reset all` row, and against the 602px visible column the wall gets **329px** — one 262px tile
   row (238 of art at 170 wide, plus `chinHeight(1) - CHIN_RISE`'s 24) and 67px of nothing. Against
   the full 844 frame it is 473, which is where the ~500 came from.
2. **The ten mana-value chips already wrap at 350px.** `10 × 32 + 9 × 4` = **356 > 350**, so they
   draw 9 + 1 today. That is the fact that makes F1 cheap, and it is invisible from the source.
3. **The in-flow tray is 493px at one column** (six cells, Rarity taking two rows of chips in
   `grid-cols-3`). Open, the bar and its tray are **774px against a 602px column** — the wall is
   not pushed down, it is gone, and the bottom of the tray is itself below the fold.

With five filter kinds on, the stated-filter row goes 49 → **151** (a caption, five 26px chips
wrapping over three lines, and the full-width `Reset all`), so every figure below has a second
column for a search that is actually narrowed.

---

### F1 — change nothing but the target size

Story: **`RaisedTargets`**.

```
┌───────────────────────────────────────┐  390 × 844
│  Ribbon · 58                          │   58
├───────────────────────────────────────┤
│ ┌── main p-5 ─── 350 container ─────┐ │
│ │ [ Search cards…               ]44 │ │   basis-full, unchanged
│ │ (W)(U)(B)(R)(G)(C)         [ ☰ ]  │ │   6×44 = 294 + 44 button
│ │ [0][1][2][3][4][5][6]             │ │   ten 44px chips: 7 + 3
│ │ [7][8+][X]                        │ │   (they wrap at 32 too)
│ │ [ Best match             ▾ ][↑]│▦▤│ │
│ │ ───────────────────────────────── │ │
│ │ [          Reset all  0         ] │ │
│ └───────────────────────────────────┘ │  bar = 329
│ ┌ card wall ─────────────────── 273 ┐ │
│ │ ┌───────────┐                     │ │
│ │ │  170×238  │  one tile row       │ │
│ │ │  + 24 chin│  11px over          │ │
│ │ └───────────┘                     │ │
│ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │ ← 700px: the URL bar
│ │                                   │ │
│ └───────────────────────────────────┘ │
└───────────────────────────────────────┘
```

**Vertical.** Bar 273 → **329** (+56). Wall 329 → **273** out of 602. Still one tile row, with 11px
left over instead of 67. With five filters on: bar ~439 (the row's `Reset all` grows too), wall
**~163** — the top 163px of a 262px card, i.e. no complete row. **Nothing wraps differently and no
line is added**: the colour group goes 246 → 294 and still shares its line with `Filters`, and the
value chips go from two rows of 32 to two rows of 44. That is the whole cost.

**Machinery.** Reuses everything and strands nothing. The four `@container/fb` bands are untouched;
`order`/`basis-full` is untouched; `labels`/`idStem` untouched; `FilterChips` untouched in shape;
the disclosure untouched.

**`coarse:` and `--target-min`: this is the first thing in the app to use either.** Five sites, and
all of them are one-line:

| Site | Edit |
| --- | --- |
| `FILTER_SHAPE` (`FilterChips.tsx`) | `h-9` → `h-9 coarse:h-11`. Reaches `FILTER_CONTROL` and `FILTER_FIELD`, hence the search box, `Filters`, the sort trigger, `ResetAll`, `ToggleChip`, `RarityChip` |
| `ManaChip`'s own class list | add `coarse:size-11` — it has **no** `className` or size prop, so the edit is inside the component |
| `LayoutToggle`'s buttons | the same; also no class prop |
| `FilterBar`'s sort-direction button | `size-9` → `size-9 coarse:size-11` at the call site |
| `FilterBar`'s `chipClass` on `ManaValueChips` | `"size-8 @min-[640px]/fb:size-9"` → append `coarse:size-11` |

**One hazard found while writing that last row, and it is not obvious.** Stacking `coarse:` *onto*
a container variant — `@min-[640px]/fb:coarse:size-11` — puts a media rule and a container rule at
the same specificity, and which wins is decided by **source order in the generated CSS**, not by
anything readable. Do not stack them. The sound spelling is `coarse:size-11` **last and
unconditional**, which is also the right rule: a container's width says nothing about whether a
finger is aiming at it.

**`FilterChips.tsx` is shared, so this edit reaches four other rows** — the collection's, the
wishlist's, `PrintingsFilterBar`'s and the deck panel's. That is correct rather than collateral:
every one of them is drawn on the phone too, and a floor that applied to one filter row would be a
second answer to the same question.

**The one control deliberately left at 26px is F1's real design decision.** `ActiveFilterChip` is
`h-[1.625rem]` on purpose — `FilterChips.tsx` says in as many words that a statement must never be
mistaken for a control — and 26 already clears WCAG 2.5.8's 24×24. Growing it to 44 would spend the
distinction the chip exists to draw. **So it takes the room and not the box**: a transparent
`::before` bled to `(1.625rem - var(--target-min)) / 2` above and below, which meets 2.5.5 without
moving a pixel a reader can see. The story draws it.

**How the story shows it, since a desktop Storybook has a fine pointer.** A `coarse:`-gated rule
would not apply in the preview and F1 would be a picture of today, so `TARGET_SIZE_CSS` in the
story file declares the same rules **with the gate taken off**, selected by the class each control's
height is written as (`.h-9`, `.size-9`, `.size-8`). There is no media query in the file at all —
`src/lib/touchTargets.test.ts` sweeps `src/` for a second spelling of the coarse question and would
name it.

---

### F2 — the disclosure becomes a sheet

Story: **`TrayAsSheet`** (drawn with the sheet **open**, since F2's shut bar is byte-identical to
today's).

```
   shut: today's bar, 273              pressed: today            pressed: F2
┌─────────────────────┐            ┌─────────────────────┐   ┌─────────────────────┐
│ Ribbon · 58         │            │ Ribbon · 58         │   │ Ribbon · 58         │
├─────────────────────┤            ├─────────────────────┤   ├─────────────────────┤
│ [ Search cards…   ] │            │ [ Search cards…   ] │   │▓▓▓▓▓▓ scrim ▓▓▓▓▓▓▓▓│
│ (W)(U)(B)(R)(G)(C)☰ │            │ (W)(U)(B)(R)(G)(C)☰ │   │▓┌─────────────────┐▓│
│ [0][1]…[8+][X]      │            │ [0][1]…[8+][X]      │   │▓│ Filters       ✕ │▓│
│ [ Best match ▾][↑]▦▤│            │ [ Best match ▾][↑]▦▤│   │▓├─────────────────┤▓│
│ ─────────────────── │            │ ─────────────────── │   │▓│ SET   [       ]▾│▓│
│ [   Reset all  0  ] │            │ [   Reset all  0  ] │   │▓│ FORMAT[       ]▾│▓│
├─────────────────────┤            │ ┌─ tray ──────────┐ │   │▓│ OWNED [ ][    ]│▓│
│ ┌ wall ── 329 ────┐ │            │ │ SET             │ │   │▓│ RARITY[][][]  │▓│
│ │ ┌───────────┐   │ │            │ │ FORMAT          │ │   │▓│ PRICE [  ][  ]│▓│
│ │ │  170×262  │   │ │            │ │ OWNED           │ │   │▓│ PRINTINGS [  ]│▓│
│ │ └───────────┘   │ │            │ │ RARITY          │ │   │▓├─────────────────┤▓│
│ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │ ← 700       │ │ PRICE           │ │   │▓│  Reset all  0   │▓│
│ └─────────────────┘ │            │ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │←700│▓└─────────────────┘▓│
└─────────────────────┘            │ │ PRINTINGS       │ │   │▓ chips still legible│
                                   │ └─────────────────┘ │   │▓ through the scrim ▓│
                                   │  wall: gone         │   └─────────────────────┘
                                   └─────────────────────┘     wall: covered, not lost
```

**Vertical.** The bar is unchanged at **273**, so shut, F2 is today: wall **329**. Open, today's
tray puts bar + tray at **774 against a 602px column** — the wall gone, the tray's own last two
cells below the fold, and the way out (`Filters` again) scrolled off the top. As a modal it costs
the flow **0** and covers the wall it would otherwise have pushed away, which is honest: a reader
choosing filters is not looking at cards. The stated-filter chips stay on the bar under the scrim
(`bg-bg/75`), so what is on stays readable while it is being changed.

**Machinery.** Reuses the bar whole — all four bands, `order`/`basis-full`, `labels`/`idStem`. It
**strands the tray's own two thresholds**: `FilterTray`'s `@min-[640px]/fb:grid-cols-2
@min-[900px]/fb:grid-cols-3` never fires in a 358px sheet, which costs nothing today but means the
tray's grid is dead code on the phone path.

**`coarse:`/`--target-min`:** none of its own. F2 composes with F1 and does not replace it.

**Three costs, and the third decides the option.**

1. **`Dialog` has no height prop.** `width` is its only geometry prop; the panel is `max-h-full`
   inside a `place-items-center` scrim, so a body shorter than the window draws a **centred card,
   not a sheet**. A full-height surface needs a prop `Dialog` has not got — a `height`, or a
   `sheet` boolean. The story is drawn with `width="w-full"` and says so.
2. **`FilterTray` is module-private and `trayOpen` has no prop.** Nothing outside `FilterBar.tsx`
   can put the shipped tray in a `Dialog`, which is why the story's sheet body is assembled from
   `FilterChips`' exports over the same real `useCardSearch`. Shipping F2 means the tray leaves
   that file's privacy.
3. **A sheet is modality, and modality is a different element tree — CSS cannot switch it.**
   `FilterBar` chooses its whole arrangement in `@container/fb`. Making the tray a sheet *only*
   below some width therefore needs a `ResizeObserver` in that file: **a second layout mechanism
   beside the container query, answering the same question**, which is exactly the drift the
   container query was chosen to avoid. The CSS-only escape — a `fixed inset-0` tray at narrow
   widths — is a modal with no scrim, no `aria-modal`, no focus trap and no Escape, which
   `src/CLAUDE.md` forbids outright. The alternative to the observer is making the sheet
   unconditional, i.e. changing the desktop bar too.

**One artefact of framing a phone inside a desktop canvas, and it affects every option story
with a `Dialog` in it.** `Dialog`'s scrim is `fixed inset-0`, so the story frame needs a
`transform` on an ancestor or the sheet covers the whole Storybook canvas instead of the 390px
box (verified: 390×844 with it, 2000-wide without). What the transform cannot fix is the scrim's
own `p-4 sm:p-6` — `sm:` is a **viewport** query, so in a canvas wider than 640 the sheet draws
**342px** where a real 390px phone gives it **358**. Read the shape off the story; take the width
from here.

---

### F3 — a sticky one-line bar

Story: **`OneLineSticky`** (sheet shut, since the 558px wall is the proposal).

```
┌───────────────────────────────────────┐  390 × 844
│  Ribbon · 58                          │   58
├───────────────────────────────────────┤
│ ┌───────────────────────────────────┐ │
│ │▓[ Search cards…         ]300 [☰]42│ │  sticky top-0, 44px,
│ │▓ bg-bg, -mx-5 px-5, LAYER.header ▓│ │  bleeds over main's gutters
│ ├───────────────────────────────────┤ │
│ │ ┌ card wall ────────────── 558 ──┐│ │
│ │ │ ┌───────────┐                  ││ │
│ │ │ │  170×262  │                  ││ │
│ │ │ └───────────┘                  ││ │
│ │ │ ┌───────────┐  two full rows   ││ │
│ │ │ │  170×262  │  + 22px over     ││ │
│ │ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ ││ ← 700
│ │ │ └───────────┘  (scrolls under  ││ │
│ │ │                 the strip)     ││ │
│ │ └────────────────────────────────┘│ │
│ └───────────────────────────────────┘ │
└───────────────────────────────────────┘
   everything else — colours, mana values, sort, layout
   pair, the stated filters and Reset all — in F2's sheet
```

**Vertical.** Strip **44**, wall **558** out of 602: **two full tile rows and 22px over** (`CardGrid`'s `GAP` is 12), against
one row and a sliver today. With five filters on it is still 44, because the chips are in the sheet
— which is the largest single win available and also the largest thing given up.

**Machinery.** This is the option that strands the most. The four `@container/fb` bands collapse to
one; the `order` plus `basis-full` arrangement has nothing left to arrange; the four controls that
"never fold away" all fold away. `labels`/`idStem` survive and are what keeps the strip's box and
the sheet's apart. **The real loss is the stated-filter chips.** `FilterBar`'s own doc says what is
*on* is stated as 26px chips under a rule, "where a search can be read in a glance and undone one
filter at a time" — drawn precisely because a filter behind a shut disclosure has no control on
screen at all. With them in the sheet, a badge reading `4` is the whole of what a reader is told,
and finding out which four is a press. Measured, that row is **151px** with five kinds on, which is
most of what this option is buying.

**`coarse:`/`--target-min`:** yes, on the strip's two controls, and it is F1's edit — `FILTER_SHAPE`
and nothing else, since `Filters` and the search box are the only things left on the bar.

**Sticky mechanics are real work.** `position: sticky` sticks against the scroller's **padding
box**, so the strip needs `-mx-5 px-5` and `-mt-5 pt-5` or the wall scrolls through `main`'s 20px
gutters beside and above it; it needs an opaque `bg-bg`; and it needs `LAYER.header`, the rung
`layers.ts` names for exactly this pairing (its own doc's example is a table header versus a filter
bar). None of that is expensive; all of it is invisible to jsdom.

**And it depends on a round that has not reported.** At 390px `columnsFor(350, 170)` is **1**, so
"two rows" is two cards. If Round 2 moves the tile to 160px the wall is two columns and F3 buys
four cards instead of two — but the geometry F3 is buying pixels for belongs to that round, not
this one.

---

### The three side by side

Out of the **602px** content column (700 visible, less the 58 ribbon block and `main`'s 40):

| | bar | wall | complete tile rows | with 5 filters on: bar / wall |
| --- | --- | --- | --- | --- |
| **shipped** | 273 | **329** | 1 (+67) | 375 / 227 → **0** |
| **F1** | 329 | **273** | 1 (+11) | ~439 / ~163 → **0** |
| **F2** (shut) | 273 | **329** | 1 (+67) | 375 / 227 → **0** |
| **F2** (open) | 273 + sheet | covered | — | unchanged |
| **shipped, tray open in flow** | 774 | **−172** | 0 | worse |
| **F3** | 44 | **558** | 2 (+22) | 44 / 558 → **2** |

---

**Recommended: F1**, and it is the round's finding rather than a compromise. The container query
already answers a 390px box; the one thing genuinely wrong with the shipped bar under a finger is
that every control on it was drawn for a mouse, and that is five one-line edits behind a variant
`src/index.css` already declares. It costs 56px out of a wall that has one tile row either way, it
wraps nothing differently, it strands nothing, and it is the only one of the three that does not
require a structural change to `FilterBar.tsx`. Take the `::before` answer for the stated-filter
chips with it — that is the one place where the 44px floor and the app's own design intent
genuinely conflict, and growing the target rather than the chip settles it without spending the
distinction.

**F2 is the answer to the one state F1 leaves bad, and it should be taken second rather than
instead — but only after somebody drives it.** 774px of bar-plus-tray against a 602px column is
arithmetic, not a reading; nobody has opened that tray on a phone. If it is as bad as the number
says, F2's three costs (a `Dialog` height prop, `FilterTray` losing its privacy, and a
`ResizeObserver` beside the container query) are worth paying, and the third is the one to argue
about. If it turns out that scrolling `main` to reach the last two cells is merely poor rather than
broken, none of them is.

**F3 is not recommended.** It buys the most — 229px, and it is the only option that moves the
budget in the reader's favour — by spending `FilterBar`'s one legible statement of what the search
is currently narrowed by, on a wall whose column count Round 2 has not settled. That is trading a
piece of the app's design for pixels another round may hand back for free. Hold it: if Round 2
lands on a tile that still gives one column at 390, F3 becomes worth reopening, because at one card
per screen the argument changes.
