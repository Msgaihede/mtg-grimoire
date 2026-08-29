# Mobile layout 9b: build the four chosen layouts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app usable on a 390px phone by building the four layouts Markus chose on 2026-08-29 — a bottom tab bar, a 144px card tile, a deck search rail that opens over the deck, and filter controls a finger can hit.

**Architecture:** Nothing here is a new mechanism. Task 1 lifts the navigation vocabulary and the sidebar's drop behaviour out of `AppShell` so a second drawing of a nav entry cannot drift from the first; Tasks 2–3 add the bar and let the shell choose between it and the rail; Tasks 4–5 deal with what the ribbon can no longer hold. Tasks 6–8 are one decision each on surfaces that already have the machinery. Task 9 is the measurement the whole plan is answerable to.

**Tech Stack:** React 19, TypeScript 6.0.x, Tailwind v4 (`@theme`/`@custom-variant` in `src/index.css`), `@dnd-kit/dom` 0.5.0, Vitest, Storybook 10.5.7, `scripts/cdp.mjs`.

**Spec:** [2026-08-28-mobile-layout-options.md](../specs/2026-08-28-mobile-layout-options.md) — the decision and the per-surface brief. Read "What 9b has to do, per surface" before starting; every task below argues from it. The widths come from [the cross-platform spec](../specs/2026-08-27-cross-platform-design.md) §6.1 and the parity matrix §7.

---

## Global Constraints

- **`npm run verify` before every commit.** It does **not** run `cargo fmt` or `clippy`; nothing here touches Rust, so neither is at risk — but say so rather than assuming it.
- **Never install `@types/node`.** TypeScript stays on 6.0.x. `xlsx` is banned. **No task here needs a new runtime dependency** — if one seems to, stop and report.
- **Read the surface's own rules before touching it.** [`src/CLAUDE.md`](../../../src/CLAUDE.md) is binding throughout; [`src/features/decks/CLAUDE.md`](../../../src/features/decks/CLAUDE.md) for Task 8; [`.storybook/CLAUDE.md`](../../../.storybook/CLAUDE.md) for any story.
- **Verify every component prop through the Storybook MCP tools** (`list-all-documentation`, then `get-documentation`). **It was `ConnectionRefused` for the whole of 9a**; if it is again, read the component's literal TypeScript props type and quote it in the report. Never infer a prop from a naming convention.
- **Only one app and one Storybook run across every worktree**, and both collisions are silent. Take the lock through `.claude/skills/running-the-app/lock.ps1`. A `FREE` lock does not mean nothing is running.
- **`touch-action` already exists at two sites** — `src/index.css:464` and `src/features/decks/DeckSearchPanel.tsx:1072`. **A second drop-target or `touch-action` registration on one element silently replaces the first**, so check before adding either.
- **A working new drop is never evidence the old one survived.** Every task that touches a drag re-verifies the drags that were already there.
- **Tailwind scans source text for whole class names**, so a class named in a doc comment emits a rule and a class built by interpolation emits nothing. `src/lib/tokens.test.ts` and `src/lib/layers.test.ts` sweep for both.
- **jsdom has no layout engine, no container queries and no service worker.** Nothing about *pixels* can go red in the suite. Say at each site which assertions are class pins and which numbers came from a browser.

---

## The arithmetic every task is answerable to

Measured in the shipped WebView2 at `cdp.mjs size 390 844` on 2026-08-29, and recorded in [frontend-design.md](../../reference/frontend-design.md).

| | px |
| --- | --- |
| Window | 390 |
| less the rail — **208 expanded, 68 collapsed, 0 with the bar** | — |
| less `main`'s `p-5` | 40 |
| less `CardGrid`'s scroller `border` + `p-3` | 26 |
| **wall, with the bar** | **324** |

`columnsFor(w, t) = max(1, floor((w + 12) / (t + 12)))` (`CardGrid.tsx:180`). At 324 the largest tile giving **two** columns is **156**; 144 is the chosen width because its leftover is exactly 24, so the side gutters and the inter-card gap are one number.

**The vertical is the scarce axis and it is what Task 9 measures.** Ribbon 58 + `main`'s 40 + a 273px shut filter bar leaves ≈329px of wall against a ~700px visible viewport — one tile row and a sliver. **The bar costs 53 more.** Nothing in 9a measured the assembled stack, because until one option per surface was chosen there was no stack to measure.

---

### Task 1: Lift the navigation vocabulary out of `AppShell`

**Files:**
- Create: `src/components/nav.ts`
- Create: `src/components/nav.test.ts`
- Modify: `src/components/AppShell.tsx` — remove `NAV`, import it back
- Modify: `src/components/AppShell.test.tsx` — one added assertion

**Interfaces:**
- Consumes: nothing.
- Produces: `NAV: readonly NavEntry[]` and `type NavEntry = { id: ViewId; label: string; Icon: LucideIcon }` from `@/components/nav`, used by Task 2's bar and by `AppShell`.

> **Why the list moves and the row does not.** `NAV`'s own comment says it exists "so there is one word per view rather than two that can drift", and a bottom bar that copies six labels is exactly that drift. The **row** is a different matter: a rail entry is a full-width button with a left-anchored icon and a tooltip when narrow, and a tab is a square with its word under the glyph — they are two drawings, not one component with a flag. What must not be duplicated is the *list* and the *drop behaviour*, which is why this task moves one and Task 2 shares the other.

- [ ] **Step 1: Write the failing test**

Create `src/components/nav.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NAV } from "@/components/nav";

describe("the navigation census", () => {
  it("names every view exactly once", () => {
    const ids = NAV.map((e) => e.id);
    expect(ids).toEqual(["search", "tags", "decks", "collection", "wishlist", "settings"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The label is also the ribbon's `<h1>`, so a second list of words is a second thing to keep
   * in step — which is the whole reason this module exists rather than the bar copying six
   * strings out of the rail.
   */
  it("gives every entry a word and a glyph", () => {
    for (const entry of NAV) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.Icon).toBeTypeOf("function");
    }
  });
});
```

> ⚠️ **`toBeTypeOf("function")` is wrong and fails on all six — corrected 2026-08-29 while executing this step.** Under `lucide-react` 1.x a `LucideIcon` is a `forwardRef` **object** (`$$typeof: Symbol(react.forward_ref)`, keys `["$$typeof", "render"]`), and that is true of lucide's own icons and of `icons.ts`'s `createLucideIcon` copies alike. **Do not weaken it to `"object"`** — that is equally true of the `null` the case exists to catch. **Draw the glyph instead**, which is the only assertion here that tells one from anything else:
>
> ```ts
> const { container, unmount } = render(createElement(entry.Icon));
> expect(container.querySelector("svg")).not.toBeNull();
> unmount();
> ```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/components/nav.test.ts 2>&1 | tail -15`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/components/nav.ts` by **moving** the `NAV` const out of `AppShell.tsx` (currently at `:70`) with its whole doc comment intact, plus:

```ts
import type { LucideIcon } from "lucide-react";
import type { ViewId } from "@/lib/store";

export interface NavEntry {
  id: ViewId;
  label: string;
  Icon: LucideIcon;
}
```

and type the const `export const NAV: readonly NavEntry[] = [...]`.

In `AppShell.tsx`, delete the const and add `import { NAV } from "@/components/nav";`.

> ⚠️ **"Nothing else in that file changes" is not achievable, corrected 2026-08-29.** Deleting the const orphans six imports — `Heart`, `Search`, `Settings`, `Tags`, the whole `@/components/icons` line, and `type ViewId` — and an unused import is a **TS6133 error** in this repo, so removing them is entailed by the move rather than scope creep. `LucideIcon` stays: `NavItem`'s props still use it. The true diff is **2 insertions, 29 deletions**, and no rail markup, no `NavItem` and no class string is touched. That is the claim to check.

- [ ] **Step 4: Run, and prove the move changed no behaviour**

Run: `npm run test -- src/components/nav.test.ts src/components/AppShell.test.tsx 2>&1 | tail -10`
Expected: PASS, and `AppShell.test.tsx`'s existing count is unchanged — the rail still draws six entries and its tests never mentioned `NAV`.

- [ ] **Step 5 — mutation:** delete `"tags"` from `NAV`. `nav.test.ts`'s first case must FAIL naming the array, **and** `AppShell.test.tsx` must fail on the missing rail entry. Restore. **If only one of the two fails, say so** — it tells you which file is actually holding the rail's contents.

- [ ] **Step 6: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/components/nav.ts src/components/nav.test.ts src/components/AppShell.tsx src/components/AppShell.test.tsx
git commit -m "refactor(nav): the six destinations become a module, so a second drawing cannot drift

NAV's own comment says it exists so there is one word per view rather than two that can
drift. A bottom tab bar that copied six labels out of the rail would be exactly that, so the
list moves out before the second drawing arrives. The rail's row does not move: a rail entry
is a full-width button with a left-anchored icon and a tab is a square with its word under
the glyph, and those are two drawings rather than one component with a flag."
```

---

### Task 2: The bottom tab bar

**Files:**
- Create: `src/components/BottomTabBar.tsx`
- Create: `src/components/BottomTabBar.test.tsx`
- Create: `src/components/BottomTabBar.stories.tsx`

**Interfaces:**
- Consumes: `NAV` from Task 1; `SidebarDrop` and `useSidebarDrops`'s return from `@/components/useSidebarDrops`.
- Produces: `<BottomTabBar activeView onSelect dragging decks wishlist />` for Task 3 — five props, spreading `useSidebarDrops()`'s return directly.

  > ⚠️ **This line first read `… dragging drops`, which disagreed with this task's own test code and with the Self-Review — corrected 2026-08-29.** `useSidebarDrops()` returns `{ dragging, decks, wishlist }`, so the spread shape is the right one and there is no `drops` object to pass. Worth noting as a plan-writing failure rather than a typo: **the Interfaces block is the only thing a task's implementer sees of its neighbours**, so a name that disagrees with the code beside it is exactly the kind of error it exists to prevent.

**Read first:** `src/components/AppShell.tsx`'s `NavItem` (`:514` onward) in full — particularly the `useDndDropTarget` block and its long comment about registrations standing while the shell re-renders mid-drag — and `src/components/useSidebarDrops.ts`.

**The constraints, from the brief:**

- **It sits inside `--safe-b`.** That token shipped in PR #274 published and deliberately unapplied; this is the consumer it was published for. Padding, as an **inline style** — a mistyped Tailwind arbitrary value emits nothing, silently, with `tsc` and the suite green.
- **Six tabs across 390px is 65px each**, and the row is 53px tall. Both were measured in 9a's option story; re-check them here rather than trusting the number.
- **`aria-current="page"`** on the active tab, exactly as the rail's entry does it.
- **Every tab is a drop target**, including the four that refuse — `NavItem`'s comment explains that a droppable whose `accepts()` is false costs a registry entry and nothing else, and that the refusing entries register anyway so the set does not change shape mid-drag.
- **Do not add `touch-action` here.** `index.css:464` already applies it to whatever is mid-drag, and a second registration silently replaces the first.

- [ ] **Step 1: Write the failing test**

Create `src/components/BottomTabBar.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BottomTabBar } from "@/components/BottomTabBar";
import { NAV } from "@/components/nav";

const noDrops = { dragging: false, decks: null, wishlist: null };

describe("the bottom tab bar", () => {
  it("draws every destination", () => {
    render(<BottomTabBar activeView="search" onSelect={() => {}} {...noDrops} />);
    for (const entry of NAV) {
      expect(screen.getByRole("button", { name: new RegExp(entry.label, "i") })).toBeInTheDocument();
    }
  });

  /**
   * The rail says which entry is the open view with `aria-current`, and a second drawing of
   * navigation that said it a different way would be two answers to one question.
   */
  it("marks the open view the way the rail does", () => {
    render(<BottomTabBar activeView="decks" onSelect={() => {}} {...noDrops} />);
    const decks = screen.getByRole("button", { name: /decks/i });
    expect(decks).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /search/i })).not.toHaveAttribute("aria-current");
  });

  it("reports the press", async () => {
    const onSelect = vi.fn();
    render(<BottomTabBar activeView="search" onSelect={onSelect} {...noDrops} />);
    await userEvent.click(screen.getByRole("button", { name: /wishlist/i }));
    expect(onSelect).toHaveBeenCalledWith("wishlist");
  });

  /**
   * The token shipped in PR #274 published and deliberately unapplied, for this. An inline
   * style rather than an arbitrary-value class: a mistyped arbitrary value emits **nothing**,
   * silently, with `tsc` and this suite both green.
   */
  it("sits inside the safe area", () => {
    const { container } = render(
      <BottomTabBar activeView="search" onSelect={() => {}} {...noDrops} />,
    );
    const bar = container.querySelector("nav");
    expect(bar).toHaveStyle({ paddingBottom: "var(--safe-b)" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/components/BottomTabBar.test.tsx 2>&1 | tail -15`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/components/BottomTabBar.tsx`. Draw a `<nav>` with `role` left implicit, six buttons from `NAV`, each a column of glyph over label. Requirements the tests above do not state and the brief does:

- The bar carries `paddingBottom: "var(--safe-b)"` as an inline style.
- Each tab registers `useDndDropTarget` with the same `canDrop`/`onDrop`-through-a-ref shape `NavItem` uses. **Copy that block's reasoning into a comment here or, better, extract it — see the note below.**
- The active tab gets `aria-current="page"`.
- Type scale: the label is the app's smallest interface size; do **not** invent a new one. Read `src/CLAUDE.md`'s chrome ladder and pick from it.

> **On sharing the drop block.** If extracting `NavItem`'s `useDndDropTarget` wiring into a hook is a clean lift, do it and have both call it — that is the drift this plan is trying to prevent. **If it is not clean, do not force it**: duplicate the block with a comment naming `NavItem` as the other copy and say so in the commit, because a bad abstraction over a drag registration is worse than two honest copies. Decide by trying, not by guessing.

- [ ] **Step 4: Run, then draw it**

Run: `npm run test -- src/components/BottomTabBar.test.tsx 2>&1 | tail -10` — expected: 4 passed.

Then a story file at `Mobile/Bottom tab bar` with the phone decorator from 9a's rounds (`PHONE_PX`/`PHONE_HEIGHT_PX` from `@/lib/viewports`), `tags: ["autodocs"]`, and **a `play` that presses a tab** — unlike 9a's option stories, this one ships, so it earns a play. Take the Storybook lock and look at it.

- [ ] **Step 5 — mutations, both of them**

- Remove `aria-current` → the second test must FAIL. Restore.
- Change the inline `paddingBottom` to a Tailwind class `pb-[var(--safe-b)]` → the fourth test must FAIL. Restore. **This one is the point**: the class may well work, and the test still has to prove which mechanism shipped, because the failure mode of the other is silence.

- [ ] **Step 6: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/components/BottomTabBar.tsx src/components/BottomTabBar.test.tsx src/components/BottomTabBar.stories.tsx
git commit -m "feat(mobile): a bottom tab bar, in the thumb zone and inside the safe area

Six destinations at 65px across a 390px window, 53px tall. It is the first consumer of
--safe-b, which shipped in PR #274 published and deliberately unapplied for exactly this.

Every tab registers a drop target, the four that refuse included: a droppable whose accepts()
is false costs a registry entry and nothing else, and registering them all is what keeps the
target set from changing shape mid-drag.

The padding is an inline style rather than an arbitrary-value class, and a mutation proves
which one shipped — a mistyped arbitrary value emits nothing at all, silently, with tsc and
the suite both green."
```

---

### Task 3: The shell chooses the bar below the phone width

**Files:**
- Create: `src/lib/useNarrowWindow.ts`
- Create: `src/lib/useNarrowWindow.test.ts`
- Modify: `src/components/AppShell.tsx`
- Modify: `src/components/AppShell.test.tsx`

**Interfaces:**
- Consumes: Task 2's `BottomTabBar`; `PHONE_PX` from `@/lib/viewports`.
- Produces: `useNarrowWindow(): boolean`.

> **This is the one viewport branch in the app, and `src/lib/viewports.ts` demands a reason at its site.** That module says its constants are "widths to look at, not breakpoints to branch on", because the same component is drawn in a 1500px bar and a 206px docked panel and a viewport query answers about the wrong box. **`AppShell` is the exception that proves it**: the shell *is* the window, and "is there room for a rail beside the content" is a question about the window and nothing else. Write that reason in the hook's doc comment — a later reader will find this branch and be right to challenge it.
>
> **`matchMedia` has zero occurrences in shipped code today** (`src/test-setup.ts:147` is a jsdom stub). This is the first, which is why it is one hook with one test rather than a call in a component.

- [ ] **Step 1: Write the failing test**

Create `src/lib/useNarrowWindow.test.ts`:

```ts
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PHONE_PX } from "@/lib/viewports";
import { useNarrowWindow } from "@/lib/useNarrowWindow";

/** jsdom's `matchMedia` is a stub that never matches, so the query is driven by hand. */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return listeners;
}

describe("useNarrowWindow", () => {
  it("asks about the phone width and nothing else", () => {
    let asked = "";
    vi.stubGlobal("matchMedia", (query: string) => {
      asked = query;
      return { matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} };
    });
    renderHook(() => useNarrowWindow());
    // The number comes from `viewports.ts` rather than being typed here, so a change there
    // moves the branch with it.
    expect(asked).toContain(String(PHONE_PX));
    vi.unstubAllGlobals();
  });

  it("answers what the query says", () => {
    stubMatchMedia(true);
    expect(renderHook(() => useNarrowWindow()).result.current).toBe(true);
    stubMatchMedia(false);
    expect(renderHook(() => useNarrowWindow()).result.current).toBe(false);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/lib/useNarrowWindow.test.ts 2>&1 | tail -15`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the hook**

`useNarrowWindow` subscribes to `matchMedia(\`(max-width: ${PHONE_PX}px)\`)` with `useSyncExternalStore`, which is the React-19 way to read an external source without an effect that sets state — and the rule against `setState` inside an effect makes the alternative a lint failure at `npm run verify`, not at edit time.

> ⚠️ **This step first cited `src/lib/CLAUDE.md`, which does not exist — corrected 2026-08-29.** That rule lives in `src/CLAUDE.md`. A plan that cites a file by a plausible path nobody checked is the same failure class as a prop inferred from a naming convention, and it is worth naming as one.

- [ ] **Step 4: Wire the shell**

In `AppShell.tsx`: when `useNarrowWindow()` is true, render `<BottomTabBar>` after `<main>` and **do not render the `<nav>` rail at all**; otherwise exactly what it renders today. Extend `AppShell.test.tsx` with a case for each direction — the rail's entries absent and the bar's present when narrow, and the reverse when not.

**The drops go to the bar unchanged.** `useSidebarDrops()` is already called once in `Shell`; pass its result to whichever of the two is drawn. **Do not call it twice** — it holds a `dragging` flag and a report, and two instances are two live regions saying different things.

- [ ] **Step 5 — mutation:** make `useNarrowWindow` return a constant `false`. The shell's narrow case must FAIL. Then return a constant `true` and the wide case must FAIL. Restore. **Both directions matter**: a branch stuck on either answer passes half a suite.

- [ ] **Step 6: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/lib/useNarrowWindow.ts src/lib/useNarrowWindow.test.ts src/components/AppShell.tsx src/components/AppShell.test.tsx
git commit -m "feat(mobile): the shell draws a tab bar instead of a rail below the phone width

The one viewport branch in this app, and viewports.ts demands a reason at its site: the shell
IS the window, and 'is there room for a rail beside the content' is a question about the
window and nothing else. Every other fold in this app is a container query or a
ResizeObserver, because the same component is drawn in a 1500px bar and a 206px panel.

First matchMedia in shipped code, which is why it is one hook with one test rather than a
call in a component. useSidebarDrops is still called once and handed to whichever of the two
is drawn: it holds a dragging flag and a report, and two instances are two live regions
saying different things."
```

---

### Task 4: The ribbon sheds, and the status line keeps its live region

**Files:**
- Modify: `src/components/Ribbon.tsx`, `src/components/Ribbon.test.tsx`
- Modify: `src/components/AppShell.tsx`

**The measurement this task exists for**, taken in headless Edge over the built stylesheet with real fonts on 2026-08-29: at the full 390px with no rail, the `<h1>` gets **78px** of the **125.75** `Collection` needs and the status line gets **89** of **243.95**. `Refresh data` alone is **150.91 × 42** — 43% of the window, and the single reason nothing else fits.

**Cinzel never goes below 18px**, so the 20px title cannot be shrunk to fit: it stays or it goes.

- **The status line must stay mounted.** It is a permanently-mounted `role="status"` whose number is `aria-hidden`, and **a live region that only sometimes exists announces nothing**. Moving it off the row means `sr-only` on the row and the sentence drawn somewhere the reader can see it — not unmounting it.

> ⚠️ **This task has three sentences to place, not one — the other two were found by Tasks 2 and 3 and are recorded at their call sites.** All three are live regions that the phone's chrome currently has no column to draw:
>
> 1. **The status line** — above.
> 2. **The sidebar's drop report** (`SidebarDrop.report`). `BottomTabBar` mounts a `role="status"` per droppable tab so the sentence is *announced*, but a 65px tab has no room to *paint* it. A drop on a phone therefore says nothing to the eye.
> 3. **The card-menu refusal `role="alert"`** (`cardToDeckRefusal`). It lives on the rail, so **it disappears entirely below the phone width** — the one of the three that is currently lost rather than merely unpainted. That makes it the most urgent.
>
> The collapse toggle also goes with the rail, and that one is *correct* — a bar has nothing to collapse. Do not put it back.
- `RibbonProps` has ten members and **no slot, no `children`, no `onStatusPress`** (`Ribbon.tsx:9–53`). This task adds whatever it needs; it is the task that is allowed to.

- [ ] **Step 1: Write the failing test** — the live region is still in the document when the ribbon is narrow, and the title is not truncated by CSS but genuinely absent or genuinely whole.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** Decide *at this site* what the narrow ribbon holds and write the reason down; the brief does not decide it for you, because 9a measured that no arrangement fits and left the choice to whoever sees the assembled stack.
- [ ] **Step 4: Run.**
- [ ] **Step 5 — mutation:** unmount the status line when narrow. The test must FAIL. Restore.
- [ ] **Step 6 — one comment Task 5 could not reach.** `Ribbon.tsx:93` still reads *"A settings screen (Plan 6) is where this graduates to a visible number."* **That has now happened** — Task 5 gave `imageStoreFailures` and `dataDir` a home in Settings' `Data folder` section — so the sentence is a promise that has been kept and reads as one still outstanding. Point it at the section instead. Task 5 was fenced out of this file and flagged it rather than reaching in, which is why it is here.
- [ ] **Step 7: Commit.**

---

### Task 5: The two facts that live only in a tooltip get a home

**Files:**
- Modify: `src/features/settings/SettingsPage.tsx` and its test

**The finding, from 9a's touch census.** Two things reach the UI at exactly one place each and that place is a hover tooltip: **which data folder is live** (`Ribbon.tsx:96`) and **how many card images could not be cached** (`Ribbon.tsx:97–98`). A phone reader has no hover. Settings names **neither** today — `SettingsPage.tsx:154` reads "Data folder and import. Coming in a later plan." and `DangerZonePanel.tsx:117` records that the folder is named nowhere on Settings.

- [ ] **Step 1: Write the failing test** — Settings names the data folder and states the image-failure count.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** Draw both as text in Settings. **Keep the ribbon's tooltip**: a pointer reader loses nothing, and this is a second door rather than a move.
- [ ] **Step 4: Run.**
- [ ] **Step 5 — mutation:** remove the count from Settings. The test must FAIL naming it. Restore.
- [ ] **Step 6: Commit.**

---

### Task 6: G1 — the 144px tile

**Files:**
- Modify: the wall's call sites — `src/features/search/SearchPage.tsx`, `src/features/collection/CollectionPage.tsx`, `src/features/wishlist/WishlistGrid.tsx`, `src/features/tags/TagResults.tsx`
- Modify: `src/features/search/CardGrid.test.tsx`

**Interfaces:** Consumes `useNarrowWindow` from Task 3 and `baseTileWidth` on `CardGrid` (`CardGrid.tsx:617`, `number | undefined`, defaulting to the module-private `TILE_BASE_WIDTH = 170`).

**Do not use 160.** On the real wall — `rowsRef`, inside the scroller's `border` and `p-3` — `columnsFor(324, 160)` is **1**. 160 is the failure this round exists to fix, arriving one inset later. **144** is the number: `columnsFor(324, 144)` is 2 and the leftover is exactly 24, so the gutters and the gap are one measurement.

**Two things this does not fix, and both are to be recorded rather than quietly absorbed:**

- **The chin does not scale.** `--mark-scale`/`--control-scale` come from `cardScaleVars(zoom)` and know nothing about `baseTileWidth`, so the chin stays 28px with 10px type and becomes proportionally **taller** — 12.4% of tile height at 144 against 10.7% at 170. **Decide in this task whether that is accepted**, and write the decision at the call site.
- **The quick-add trigger stays unaimable** at `24 × 0.85 = 20.4px`, under WCAG 2.5.8's 24×24, and it is `opacity-0` — which `CardGrid.tsx:1474` says in as many words is **still a hit target**. A finger that lands on it presses it and nothing on screen says it is there. **This task does not fix it; it records it as open** unless Task 7's `coarse:` work can reach it, which is worth trying since `--control-scale` is a variable and `coarse:` is a variant.

- [ ] **Step 1: Write the failing test** — at the phone width the wall is given 144, and at the desktop width it is given nothing (so the default stands). Assert the **prop**, not a pixel: jsdom lays nothing out.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — `baseTileWidth={narrow ? 144 : undefined}` at each wall, with the arithmetic in a comment at one of them and a pointer to it at the others.
- [ ] **Step 4: Run.**
- [ ] **Step 5 — mutation:** change 144 to 160. The test must FAIL. **Then check the number the test asserts is not simply `144` typed twice** — if the test and the source both spell the literal, extract it to a named constant so the two cannot agree by accident while both being wrong.
- [ ] **Step 6: Commit.**

---

### Task 7: F1 — controls a finger can hit

**Files:**
- Modify: `src/components/FilterChips.tsx`
- Modify: `src/components/FilterChips.test.tsx` (or the filter bar's test, wherever the chips are covered)

**This is the first consumer of `coarse:` and `--target-min`**, which shipped in PR #274 unapplied precisely so this decision could take them.

**Four things measured in 9a and each of which shapes the edit:**

- **`ManaChip` and `LayoutToggle` have no `className` or size prop**, so the edit lives inside `FilterChips.tsx` rather than at a call site.
- ~~**`coarse:` must come last and unconditional.**~~ Stacking a `coarse:` **size** onto a container variant (`@min-[640px]/fb:coarse:size-11`) has no specificity answer — source order decides, so a conditional spelling is a coin toss.

  > ✅ **Answered better than this asked, 2026-08-29.** Express the floor as `min-height`/`min-width`, not as a size. Those are **not in that contest at all** — a `min-*` beats a `height`/`width` in the cascade whatever order the two are emitted in — so the coin toss is *removed* rather than won. It then holds against `FILTER_CONTROL`'s `h-9`, `TagQueryRow`'s `h-7` and the bar's `size-8 @min-[640px]/fb:size-9` without any of them knowing, and `ManaValueChips`' `chipClass` — which `FilterBar.tsx:1021` merges **last**, the one place the floor could have been silently dropped — cannot drop it either. **A floor is a minimum, not a size, and saying so in CSS is what makes the ordering question disappear.**
- **`ActiveFilterChip` at 26px is where the 44px floor and the app's stated design conflict.** Grow the **target** with a `::before`, not the chip.
- The ten mana-value chips **already wrap at 350px** (`10×32 + 9×4 = 356`), which is why raising them costs no extra line.

- [ ] **Step 1: Write the failing test** — the chips carry a `coarse:` rule reaching `var(--target-min)`, and the sweep in `src/lib/touchTargets.test.ts` still passes (no raw `(pointer: coarse)` anywhere in `src/`).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Prove the rules emit.** A `coarse:` utility that Tailwind does not accept fails **silently**. Build and grep the built sheet. Tailwind minifies to `@media(pointer:coarse)` with **no space**, and the rules **nest** — and once the block holds more than one utility the single-rule pattern exits 1 with no output, which reads exactly like "it did not compile". Use the repeating form:

  ```
  grep -oE "@media\(pointer:coarse\)\{(\.[^{]*\{[^}]*\})*\}" dist/assets/*.css
  ```

  ⚠️ **And do not name a full class in a doc comment in a `.tsx` while doing it.** Measured on 2026-08-29: a comment explaining the specificity argument named `coarse:size-11` verbatim and the build emitted a live `.coarse\:size-11{…}` rule nothing used. `frontend-design.md`'s 9a note exempts **`index.css`'s own** comments and says not to generalise that to `.tsx` — this is that warning measured true.
- [ ] **Step 5 — mutation:** remove the `coarse:` variant from one chip. The test must FAIL naming it. Restore.
- [ ] **Step 6: Commit.**

---

### Task 8: D1 — the deck search rail opens over the deck

**Files:**
- Modify: `src/features/decks/DeckSearchPanel.tsx` and its test
- Modify: `src/features/decks/DeckEditor.tsx` and its test

**Read `src/features/decks/CLAUDE.md` in full first. It is binding and it is long.**

**The door out of the fallback does not exist, and that is the first thing to fix.** `roomForPanel` is `deskWidth === 0 || maxPanelWidth >= MIN_PANEL_WIDTH_PX` with a threshold of `DECK_FLOOR` 192 + `DESK_GAP` 16 + `MIN_PANEL_WIDTH_PX` 206 = **414**. A 350px desk is below it, so the panel already falls back to its rail and says so in words — but at 390 the disclosure is `aria-disabled` and refuses: `onClick={() => roomy && setOpen(!open)}` (`DeckSearchPanel.tsx:580`). **The rail cannot be pressed at all today.**

**The open state is the pattern issue #183 already established** for the card pane: a full-width overlay over the deck, drawn by `PANE_OVER_ATTR`. This is a reuse, not a new surface.

**One number no option could fix from outside:** `TextView`'s `COLUMN_WIDTH` is a module constant of **300px** (`TextView.tsx:68`) against a **286px** view box, so it overflows by 14px, contained by the view's own `overflow-x-auto`. **Either make it a prop or accept the overhang deliberately** — decide here and write it down.

**Accepted cost:** while the overlay covers the deck there is nothing to drag into, so adding a card from search is a tap. **Every in-deck drag is unaffected** — dnd-kit's `PointerSensor` delivers those regardless — and re-verifying that is part of this task rather than an assumption.

- [ ] **Step 1: Write the failing test** — at a phone-width desk the disclosure is **not** `aria-disabled` and pressing it opens the panel over the deck.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then re-measure the header's `deskWidth` ladder (1400 / 1100 / 900) at phone widths and decide whether a fourth rung is wanted — the brief notes a rung is a smaller change than a new mechanism.
- [ ] **Step 5 — mutation:** restore the `roomy &&` guard. The test must FAIL. Restore. **Then drive one in-deck drag in the live window** and confirm it still lands: a working new overlay is never evidence the old drag survived.
- [ ] **Step 6: Commit.**

---

### Task 9: Measure the assembled stack on a device, which is the only thing that can judge this plan

**Files:**
- Modify: `docs/reference/frontend-design.md`

> **Nothing in 9a measured this**, because until one option per surface was chosen there was no stack to measure. Every task above spends or saves on the vertical, and the vertical is the scarce axis: ribbon 58 + `main`'s 40 + a 273px shut filter bar left ≈**329px** of wall against a ~700px visible viewport *before* the bar's 53px. **If the assembled answer is one tile row, this plan has not succeeded**, and the thing to re-open is what the chrome spends vertically rather than which layout won.

- [ ] **Step 1** — Build the web target and serve it (`npm run build:wasm`, `npm run web:build`, then `vite preview --config vite.web.config.ts`). **`npm run web:dev` registers no service worker at all**, so a dev-server reading answers nothing about caching — and it cost a pass on 2026-08-29.
- [ ] **Step 2** — `adb reverse tcp:4173 tcp:4173` and open it on the phone. **This is the only instrument where the URL bar, the safe area and a coarse pointer are real rather than emulated**: `cdp.mjs size` hardcodes `mobile: false` and emulates a narrow *desktop*.
- [ ] **Step 3** — In one expression, read `visualViewport.height`, the ribbon's box, `main`'s content box, the filter bar's height, the bar's height, and how many tile rows are visible. One expression because a rect and a viewport taken minutes apart can be at two different sizes.
- [ ] **Step 3b — the one thing Task 8 could not settle without a device, and it is the sharpest open question in this plan.** **dnd-kit hit-tests by rect, not by DOM hit-testing**, so the deck's piles *underneath* the search overlay stay droppable while invisible. A drag begun from a search tile at 390px can therefore land in a pile the reader cannot see. `QuickZones` (`LAYER.dragTray`) and the remove tray both paint **above** the overlay, so those four targets stay visible and usable — it is the piles that are the hazard. Task 8 recorded this rather than fencing it, correctly: a `canDrop` fence means touching drop registrations, and a second registration on one element silently replaces the first. **Drive it on the device and decide.** Three outcomes are legitimate — it is unreachable in practice (a finger starting on a tile inside a full-width overlay has nowhere to travel that is not the overlay); it wants a fence; or the overlay wants to not cover the piles at all. Do not leave it undecided a second time.
- [ ] **Step 4** — Take the **dialog** reading that has been owed since PR #274: whether `Dialog`'s `fixed inset-0` scrim resolves against the large or the small viewport. The recipe, both branches and where the `h-dvh` pin would go are in `frontend-design.md` under "The dialog against a real URL bar". **Record the numbers either way** — "we looked and it was already right" is a result, and without it the next person pays for the same measurement.
- [ ] **Step 5** — Write all of it into `frontend-design.md` with the device, the build and the date. Commit.

---

## Self-Review

**Spec coverage.** Every bullet of the options document's "What 9b has to do, per surface" maps to a task: R2's nav-vocabulary lift (1), the bar and `--safe-b` and the drop targets (2), the shell's branch (3), the status line (4), the two tooltip-only facts (5); G1's 144 and its two recorded non-fixes (6); F1's four measured constraints (7); D1's disabled disclosure, the #183 overlay, `TextView`'s 14px and the drag re-verification (8); and the cross-cutting vertical measurement plus the owed dialog reading (9). **`touch-action`'s two existing sites** are in the Global Constraints, where every task inherits them.

**Placeholders.** Tasks 4, 5, 6, 7 and 8 give the step *shape* without literal code, and that is deliberate rather than a lapse: each is one decision on a surface whose exact markup this plan must not pre-empt — Task 4's arrangement in particular, because 9a measured that **no** arrangement fits a 390px ribbon row and explicitly left the choice to whoever sees the assembled stack. **What each of them does carry is the measurement, the constraint and the mutation**, which is the part a plan can be wrong about. Tasks 1, 2 and 3 carry literal code because they create modules whose names later tasks import.

**Type consistency.** `NAV: readonly NavEntry[]` (Task 1) is imported by Task 2's bar and by `AppShell`. `useNarrowWindow(): boolean` (Task 3) is consumed by Tasks 3 and 6. `BottomTabBar`'s props — `activeView`, `onSelect`, `dragging`, `decks`, `wishlist` — match `useSidebarDrops()`'s return shape (`{ dragging, decks, wishlist }`, each a `SidebarDrop | null`) as read from `useSidebarDrops.ts:177`.

**What could still be wrong.** Three things.

1. **Task 2 may find that `NavItem`'s drop wiring does not lift cleanly**, and the plan deliberately permits two honest copies over a bad abstraction. If that happens, the *list* is still shared, which is the drift `NAV`'s own comment is about.
2. **Task 3 introduces the app's first `matchMedia` and its first viewport branch**, against a codebase whose every other fold is a container query. The justification is that the shell is the window — but a reviewer is right to challenge it, which is why it is one hook with one test and a doc comment arguing the case.
3. **Task 9 may find the vertical does not work**, and that is the honest risk this plan carries rather than hides. Six tabs at 53px buy horizontal room on the axis that had some and spend it on the axis that had none. If the assembled stack leaves one tile row, the answer is not another layout round — it is to re-open what the chrome spends vertically, and F2 (the filter tray as a sheet, 493px in flow) is already named and costed for exactly that.
