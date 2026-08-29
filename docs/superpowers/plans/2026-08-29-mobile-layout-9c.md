# Mobile layout 9c: give the wall its room back — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the phone's card wall show cards. It currently shows **0.42 of one row** — measured on the device — because the shut filter bar takes 381px of a 545px content box.

**Architecture:** F3, chosen by Markus on 2026-08-29. The search box and one `Filters` button become a 44px strip that sticks to the top of the wall as it scrolls; everything else moves into a sheet. Nothing about `CardGrid`, the tab bar or the ribbon changes — this plan spends only the filter bar's vertical.

**Tech Stack:** React 19, TypeScript 6.0.x, Tailwind v4, Vitest, Storybook 10.5.7, a real Android phone over `adb`.

**Spec:** [the options document](../specs/2026-08-28-mobile-layout-options.md) — F3's write-up and the three-way table. The decision and its inverted rejection are in [the cross-platform spec](../specs/2026-08-27-cross-platform-design.md)'s 9c block. The measurements are in [frontend-design.md](../../reference/frontend-design.md), *"The phone layout on an actual phone"*.

---

## Global Constraints

- **`npm run verify` before every commit.** Nothing here touches Rust, so `cargo fmt`/`clippy` are not at risk — say so rather than assuming. **A full `npx vitest run` is killed mid-flight on this machine with no output**; shard it (`--shard=1/2`, `--shard=2/2`) rather than reading that as a failure.
- **Never install `@types/node`.** TypeScript stays on 6.0.x. `xlsx` is banned. **No task here needs a new runtime dependency.**
- **`src/CLAUDE.md` is binding**, and `.storybook/CLAUDE.md` for any story. Verify every prop through the Storybook MCP; **it was `ConnectionRefused` for all of 9a and 9b**, so if it is again, read the component's literal TypeScript props type and quote it.
- **`FilterBar` is the one filter row for five surfaces** — the search page, the Tags page, both tabs of the deck editor's docked panel, the collection and the wishlist. **Every change here must be gated to the phone**, or it reaches a 1500px bar and a 206px docked panel that are both working today.
- **The arrangement stays `order` plus a `basis-full` break** and never one `<div>` per breakpoint with `hidden` on the rest — that build puts two mana groups and two sort pickers in the tree at once, which is two tab stops and two accessible names per filter.
- **`labels`/`idStem` keep each surface's box its own name and its own `id`**, and they are what will keep the strip's box and the sheet's apart.
- **jsdom applies no container query and loads no stylesheet**, so nothing about pixels can go red in the suite. Class pins here; numbers from the device.

---

## The budget, measured rather than projected

Driven on the OnePlus, Chrome 152, portrait, 2026-08-29. **These are the numbers this plan is answerable to**, and they are not the 390px-frame figures F3's option story was costed against.

| | px |
| --- | --- |
| Visible viewport (URL bar showing) | **696** |
| Ribbon block · tab bar · `main`'s `p-5` | 58 · 53 · 40 |
| `main` content | **545** |
| Shut filter bar **today** | **381** |
| Wall **today** | **99** — 0.42 of a row |
| Strip under F3 | **44** |
| **Wall under F3** | **436** — **1.84 rows** |

A row is **237px** at the shipped 141px tile (art at 5:7, plus the 28px chin, plus `GAP`).

**So F3 buys two whole cards and most of the next two, against nothing today.** ⚠️ **It does not buy two whole rows**: that needs 474 and F3 delivers 436, **short by 38px**. Do not claim two rows anywhere — the option story's "two full rows and 22px over" was computed against a 390px window, a 170px tile and a 602px content box, and all three of those are wrong on the hardware.

**Where a further 38px could come from, if Task 4 finds it wants them** — and none of these is in scope here: `main`'s `p-5` is 40 of vertical on a 360px window; the ribbon block is 58; the tab bar is 53. Each is a decision with its own reasons and none should be taken to make a number work.

---

### Task 1: The sheet, which F3 needs before the strip can shed anything

**Files:**
- Modify: `src/features/search/FilterBar.tsx` and its test
- Create: a story showing the sheet open at a phone width

**Interfaces:**
- Consumes: `useNarrowWindow()` from `@/lib/useNarrowWindow`.
- Produces: the sheet, for Task 2 to move the rest of the bar into.

> **This is F2's mechanism, and F2 was the named follow-on whose condition has been met.** 9a said F2 was worth taking "conditional on somebody actually driving the open tray on a device". Somebody has: **the open tray measures 922px against a 545px content box** — it is not merely tight, it is four times the room available.

**What the sheet is, and the rule it has to satisfy.** `src/CLAUDE.md`: a surface that is *consulted* is a `Dialog`; only a surface *worked out of* earns a place in the layout. **The tray is consulted** — a reader opens it, sets a filter, and goes back to the wall — so a `Dialog` is the right shape and no rule needs extending. (That is the opposite of Task 8's search panel in 9b, which is worked out of and therefore an overlay.)

⚠️ **`Dialog`'s only geometry prop is `width`** (9a measured this), so a full-height sheet needs either a new prop or a class on the panel. Decide at the site and say why.

⚠️ **`FilterTray` is module-private in `FilterBar.tsx`.** Nothing outside that file can mount it, which is a fact in this task's favour: the sheet is built *inside* `FilterBar`, so the tray's contents move without becoming a second implementation.

- [ ] **Step 1: Write the failing test** — below the phone width, opening `Filters` puts the tray's controls inside a dialog rather than in the flow; above it, the tray is in the flow exactly as today.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** Gate on `useNarrowWindow()`. The desktop path must be **byte-identical** — this is five surfaces, four of which have no phone in them.
- [ ] **Step 4: Run**, and check the four non-phone surfaces' suites specifically (`FilterBar`, `PrintingsFilterBar`, the deck panel's two tabs, the collection and the wishlist).
- [ ] **Step 5 — mutation:** remove the narrow gate so the sheet applies everywhere. A desktop-surface test must go red. **If none does, the gate is untested** and that is the finding — write the test before continuing.
- [ ] **Step 6: Commit.**

---

### Task 2: The strip

**Files:**
- Modify: `src/features/search/FilterBar.tsx` and its test

**What is left on the bar:** the search box and one `Filters` button. Everything else — colours, mana values, sort, the layout pair — is in Task 1's sheet.

**The sticky mechanics are the substance of this task, and all of them are invisible to jsdom:**

- **`position: sticky` sticks against the scroller's *padding box***, so the strip needs `-mx-5 px-5` and ~~`-mt-5 pt-5`~~ or the wall scrolls through `main`'s 20px gutters beside and above it.

  > ⚠️ **`-mt-5 pt-5` was built, argued and removed in the same task, 2026-08-29 — and the reason
  > matters more than the class.** **The pin cannot engage in this layout at all**: every page
  > that carries this bar is `<section className="flex h-full flex-col">`, so it exactly fills
  > `main` and `main` never scrolls. `position: sticky` therefore behaves as `relative`.
  >
  > The two bleeds are **not** symmetric in cost. `-mx-5` paints `bg-bg` over `main`'s own `bg-bg`
  > gutters and is invisible at rest. `-mt-5` reaches 20px *up*, and on three of the four pages
  > something is there — `TagChips` at `gap-3`, the collection's summary header and the wishlist's
  > `FigureRow` at `gap-4` — so it eats the last **8px, 4px and 4px** of those boxes. A guaranteed
  > cost in the state that exists, against a benefit in a state that does not.
  >
  > **The test now asserts its absence**, because "completing the set" from the horizontal pair is
  > the obvious wrong repair. Put it back in the same commit as whatever makes `main` scroll.
  >
  > **And be plain about what this task actually buys:** the 337px returned to the wall comes from
  > the bar being **44px instead of 381px**, not from the pin. F3 is "a one-line bar" first and
  > "sticky" second, and only the first half is doing work today.
- It needs an **opaque `bg-bg`**, or the wall shows through.
- It needs **`LAYER.header`** — the rung `src/lib/layers.ts` names for exactly this pairing, and its own doc's example is a table header against a filter bar. **Take it from `LAYER`, never a bare `z-` class**; `layers.test.ts` sweeps for that.

**`coarse:`/`--target-min` apply to the strip's two controls** and it is F1's edit — `FILTER_SHAPE` and nothing else, since the search box and `Filters` are all that is left.

- [ ] **Step 1: Write the failing test** — below the phone width the bar holds the search box and `Filters` and nothing else; above it every control is still there.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement**, with the four sticky requirements above and the reason for each at its site.
- [ ] **Step 4: Run.**
- [ ] **Step 5 — mutation:** drop `-mx-5 px-5`. **jsdom cannot see the consequence**, so pin the classes and say in the test that the numbers came from a device. Then drop `LAYER.header` and confirm `layers.test.ts` or the strip's own test goes red.
- [ ] **Step 6: Commit.**

---

### Task 3: The stated-filter chips — the thing F3 spends, and the only real design question here

**Files:** `src/features/search/FilterBar.tsx` and its test.

> **This is the cost Markus accepted, and it is not a detail.** `FilterBar`'s own doc says what is *on* is stated as 26px chips under a rule, "where a search can be read in a glance and undone one filter at a time" — drawn precisely because **a filter behind a shut disclosure has no control on screen at all**. With them in the sheet, a badge reading `4` is the whole of what a reader is told, and finding out which four is a press. That row measures **151px** with five kinds on, which is most of what F3 is buying.

**The failure mode to design against:** `Reset all` counting a filter the reader cannot see. A reader who cannot tell *what* is on cannot tell whether `Reset all` will undo something they wanted.

**Three shapes, and this task picks one with its reasoning at the site.** None is obviously right, which is why it is its own task rather than a step:

1. **The badge alone**, as F3 was costed. Cheapest, and the weakest: `4` is not a sentence.
2. **The chips scroll horizontally on the strip's second line.** Keeps them visible and legible; costs a second line, which is 26–40px of the 337 F3 just bought, and a horizontal scroller inside a vertical one.
3. **The `Filters` button names them** — `Filters · red, rare, +3`. One line, no new surface, and it degrades honestly as they multiply. Costs a truncation rule and an accessible name that stays readable.

- [ ] **Step 1: Write the failing test** for whichever you choose, asserting **what a reader can learn without pressing anything**.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement**, with the reasoning and the two rejected shapes named at the site.
- [ ] **Step 4: Run**, and check the accessible name is a sentence rather than a concatenation — **a label and a count in two elements compute to one name with no space** (`Filters4`).
- [ ] **Step 5 — mutation:** remove whatever states the filters. The test must go red naming it.
- [ ] **Step 6: Commit.**

---

### Task 4: Drive it on the phone, which is the only thing that can judge this

**Files:** `docs/reference/frontend-design.md`.

> **9b's Task 9 is why this plan exists**, and the same instrument settles whether it worked. The full recipe — the four `adb` commands, the two things that fail silently, the `Runtime.evaluate` script — is in that section of `frontend-design.md`.

- [ ] **Step 1** — `npm run build:wasm && npm run web:build`, serve on 4173, `adb reverse tcp:4173 tcp:4173`, `adb forward tcp:9333 localabstract:chrome_devtools_remote`. **`npm run web:dev` registers no service worker**, so it cannot answer anything about the built shell.
- [ ] **Step 2 — the phone must be unlocked and in portrait, and both fail silently.** A locked phone starts the intent, prints success, and never appears in `/json/list`. Landscape reports `innerWidth` 752 and `narrow: false`, so every reading is wrong and nothing says so. Save and restore `accelerometer_rotation`/`user_rotation`. **Ask Markus to unlock it** — that is not something to work around.
- [ ] **Step 3 — one `Runtime.evaluate`**, because a rect and a viewport taken minutes apart can be at two different sizes: the visible viewport, the strip's height, the wall's height and width, the number of **complete** tile rows, tiles per row, and `documentElement.scrollWidth − innerWidth`.
- [ ] **Step 4 — the honest test.** **The target is more than one whole tile row.** The prediction is 436px of wall and 1.84 rows — two whole cards and most of the next two. **If it comes back at one row or less, F3 has not worked** and the thing to re-open is the 38px, not the filter bar again.
- [ ] **Step 5 — re-ask 9b's Step 3b**, which could not be driven at a 99px wall: can a drag from the deck editor's search overlay land in a pile hidden behind it? dnd-kit hit-tests by **rect**, so the piles stay droppable while invisible. With a wall a reader can actually see, there is now an honest gesture to make.
- [ ] **Step 6** — write it into `frontend-design.md` with the device, the build and the date, then commit.

---

## Self-Review

**Spec coverage.** F3's write-up names four things: the strip, the sheet everything else moves into, the stated-filter chips it spends, and the sticky mechanics. Tasks 1–3 take them in dependency order — the sheet must exist before the strip can shed into it — and the mechanics live in Task 2 where the strip is built. Task 4 is the measurement, and it inherits 9b's unanswered drag question because a 99px wall could not host it.

**Placeholders.** Task 3 deliberately does not choose between its three shapes, and that is the one place this plan leaves a decision open. It is not a placeholder: all three are described, the failure mode to design against is named, and the task's own step 3 requires the rejected two to be written down. Choosing here would be choosing without the assembled strip in front of me, which is exactly the mistake 9a made when it costed F3 against a 390px window and a 170px tile.

**Type consistency.** `useNarrowWindow(): boolean` is the only shared symbol and it already ships. Nothing in this plan adds a cross-task interface — Tasks 1–3 are three edits to one file, which is why they are three tasks rather than three files.

**What could still be wrong.** Two things.

1. **The 38px.** F3 gets 1.84 rows, not 2. If the second whole row turns out to matter more than the plan assumes, the next thing to spend is chrome — `main`'s 40 of vertical padding is the cheapest — and that is a decision, not an optimisation.
2. **Five surfaces, one component.** Every task here gates on the phone, and the gate is the thing most likely to leak. Task 1's mutation exists specifically to prove the desktop path is untouched; if that mutation does not bite, stop, because the failure it is guarding against is a 1500px filter bar losing its controls to a sheet nobody asked for.
