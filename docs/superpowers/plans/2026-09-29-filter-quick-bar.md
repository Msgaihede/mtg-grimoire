# Filter Quick Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-row filter bar that docks at the top of `main` when a page's filter row scrolls away, on card search, the collection, the wishlist and Tags (grid view only).

**Architecture:** The deck editor's undocked bar (`DeckHeaderBar`) already solves docking; its primitives move to `lib/dockedBar.ts` + `components/DockedBar.tsx`, and a hook `useFilterQuickBar` wraps `useUndocked` + scroll padding into the three numbers a page needs. `FilterQuickBar` draws the page's own `FilterSurface` in one row whose rungs are container queries. Each page mounts it as the first child of its section, observes its `FilterBar` root, and offsets its other sticky things (shelf bar, docked search column, Tags rail) by the hook's clearances.

**Tech Stack:** React 19, TypeScript 6, Tailwind v4 (container queries), motion 13, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-29-filter-quick-bar-design.md`

## Global Constraints

- Bar geometry is the deck bar's: height **53px**, shell pad **20px**, gap **8px**, dock clearance **41px** (53 − 20 + 8).
- Rungs by the bar's container content width: tight **< 860**, normal **860–1099**, wide **1100–1499**, widest **≥ 1500**. Tags folds mana values below **1500**.
- Grid view only: every page passes `enabled = view === "grid"`.
- New layer rung `LAYER.quickBar = "z-35"`.
- The bar's group is named **`Filter quick bar`**; the bar's tray and sort use `idStem` + `-qb` so no `id` collides with the page row's.
- No new dependencies. Never install `@types/node`. `cn` is `twMerge(clsx(...))`.
- **Tests run once at the end, after fan-in.** An implementer may run *its own* test file with `npx vitest run <file>`; never `npm run verify`, never `cargo`.
- The `mtg-grimoire-sb-mcp` Storybook MCP server is **not reachable this session**: read a component's source and its `.stories.tsx` for its props instead, and invent none.
- Comment density: this repo writes long "why" comments on non-obvious lines. Match it — every new constant and every offset gets its reason.

## Review Focus

1. **Tray open, then the reader scrolls back up** — the bar unmounts; the tray must not reopen on the next undock. Test in Task 4 (`closes the tray when the bar leaves`).
2. **Page tray and bar tray open at once** — no duplicate `id`s. Test in Task 4 (`the bar's tray uses its own id stem`).
3. **A chip pressed in the bar resets the wall to the top** — the bar leaves and the page row shows the same state. Verified live (Task 9); nothing to suppress.
4. **The shelf bar's Top comes back when the quick bar leaves** — Task 3 test (`draws Top only when given onTop`) plus the page wiring passing `undefined` only while `shown`.
5. **Tags switched grid → table** leaves no inline height on the rail — Task 1's `useDockHeight` change clears the height on unwire; test in Task 1.

---

## Wave plan

- **Wave A (parallel):** Task 1, Task 2, Task 3 — disjoint files.
- **Wave B:** Task 4 (needs 1 and 2).
- **Wave C (parallel):** Tasks 5, 6, 7, 8 — one page each (6 and 7 also need Task 3).
- **Then:** Task 9 (docs, `npm run verify`, live pass) — the controller's own.

---

### Task 1: Docked-bar primitives and the quick-bar hook

**Files:**
- Create: `src/lib/dockedBar.ts`
- Create: `src/components/DockedBar.tsx`
- Create: `src/lib/useScrollPaddingTop.ts`
- Create: `src/lib/useFilterQuickBar.ts`
- Create: `src/lib/useFilterQuickBar.test.ts`
- Modify: `src/lib/layers.ts` (add `quickBar` after `popup`)
- Modify: `src/lib/useDockHeight.ts` (clear the dock's height when unwiring)
- Modify: `src/lib/useDockHeight.test.ts` (one case)
- Modify: `src/features/decks/DeckHeaderBar.tsx` (import the moved primitives)
- Modify: `src/features/decks/DeckEditor.tsx` (use `useScrollPaddingTop`)

**Interfaces:**
- Produces: `DOCKED_BAR_HEIGHT_PX = 53`, `DOCKED_BAR_SHELL_PAD_PX = 20`, `DOCKED_BAR_GAP_PX = 8`, `DOCKED_BAR_CLEARANCE_PX = 41`, `DOCKED_SHADOW: string` (all from `@/lib/dockedBar`); `DockedPanel({ children })`, `holdsBar(target: EventTarget | null): boolean` (from `@/components/DockedBar`); `useScrollPaddingTop(target: HTMLElement | null | RefObject<HTMLElement | null>, clearance: number): void`; `useFilterQuickBar(row: HTMLElement | null, enabled: boolean): { shown: boolean; dockTop: number; stickyTop: number }`; `LAYER.quickBar`.
- `DECK_BAR_CLEARANCE_PX` stays exported from `DeckHeaderBar.tsx` (it is named in `features/decks/CLAUDE.md`), now `= DOCKED_BAR_CLEARANCE_PX`.

- [ ] **Step 1: Write the failing hook test** — `src/lib/useFilterQuickBar.test.ts`. Copy the driven `IntersectionObserver` stub from `src/lib/useUndocked.test.ts` (its `observers` array, `entry(...)` helper and `vi.stubGlobal` setup — read that file and reuse its shape exactly), then:

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCKED_BAR_CLEARANCE_PX, DOCKED_BAR_HEIGHT_PX } from "./dockedBar";
import { useFilterQuickBar } from "./useFilterQuickBar";

// …the driven observer stub from useUndocked.test.ts goes here…

function page() {
  const main = document.createElement("main");
  main.style.overflowY = "auto";
  main.style.paddingTop = "20px";
  const row = document.createElement("div");
  main.appendChild(row);
  document.body.appendChild(main);
  return { main, row };
}

describe("useFilterQuickBar", () => {
  it("is hidden, with no clearance, until the row has scrolled above the scroller", () => {
    const { row } = page();
    const { result } = renderHook(() => useFilterQuickBar(row, true));
    expect(result.current).toEqual({ shown: false, dockTop: 0, stickyTop: 0 });
  });

  it("shows once the row is above the top, with the deck bar's clearances", () => {
    const { main, row } = page();
    const { result } = renderHook(() => useFilterQuickBar(row, true));
    act(() => fireCrossing(row, { isIntersecting: false, bottom: -5, rootTop: 0 }));
    expect(result.current).toEqual({
      shown: true,
      dockTop: DOCKED_BAR_CLEARANCE_PX,
      stickyTop: DOCKED_BAR_HEIGHT_PX,
    });
    // The scroller's own 20px padding plus the clearance (WCAG 2.4.11).
    expect(main.style.scrollPaddingTop).toBe(`${20 + DOCKED_BAR_CLEARANCE_PX}px`);
  });

  it("never shows while disabled (table view), whatever the row does", () => {
    const { main, row } = page();
    const { result } = renderHook(() => useFilterQuickBar(row, false));
    act(() => fireCrossing(row, { isIntersecting: false, bottom: -5, rootTop: 0 }));
    expect(result.current.shown).toBe(false);
    expect(main.style.scrollPaddingTop).toBe("");
  });

  it("takes the scroll padding off again when the bar goes", () => {
    const { main, row } = page();
    renderHook(() => useFilterQuickBar(row, true));
    act(() => fireCrossing(row, { isIntersecting: false, bottom: -5, rootTop: 0 }));
    act(() => fireCrossing(row, { isIntersecting: true, bottom: 40, rootTop: 0 }));
    expect(main.style.scrollPaddingTop).toBe("");
  });
});
```

`fireCrossing` is whatever the copied stub calls its "deliver an entry" helper — name it to match. If `nearestScroller` needs a computed `overflow-y` (it reads `getComputedStyle`), the inline style above satisfies jsdom.

- [ ] **Step 2: Run it — fails** (`npx vitest run src/lib/useFilterQuickBar.test.ts`: cannot resolve `./useFilterQuickBar`).

- [ ] **Step 3: Create `src/lib/dockedBar.ts`** — move the constants and the shadow out of `DeckHeaderBar.tsx` (lines ~28–35 and the `DOCKED_SHADOW` string), **with their existing doc comments moved verbatim** and one added paragraph saying the filter quick bar draws from the same numbers:

```ts
/** `AppShell`'s `main` padding (`p-5`) — the docked panel reaches back over it on three sides. */
export const DOCKED_BAR_SHELL_PAD_PX = 20;
/** The docked bar's height: `py-2` around one 36px row, plus its 1px bottom border. */
export const DOCKED_BAR_HEIGHT_PX = 53;
/** Air between the bar's foot and the first sticky thing pinned under it. */
export const DOCKED_BAR_GAP_PX = 8;
/**
 * How far below the scroller's padding edge a `sticky` element must pin to clear the bar with
 * {@link DOCKED_BAR_GAP_PX} to spare — a sticky inset is measured from the padding edge, the bar
 * from the scrollport's top, so the shell pad comes off.
 */
export const DOCKED_BAR_CLEARANCE_PX =
  DOCKED_BAR_HEIGHT_PX - DOCKED_BAR_SHELL_PAD_PX + DOCKED_BAR_GAP_PX;
export const DOCKED_SHADOW =
  "shadow-[0_1px_2px_rgb(0_0_0/0.55),0_10px_24px_-4px_rgb(0_0_0/0.75),0_24px_48px_-12px_rgb(0_0_0/0.55)]";
```

(Keep the original comments' wording where they exist in `DeckHeaderBar.tsx`; the lines above are the minimum.)

- [ ] **Step 4: Create `src/components/DockedBar.tsx`** — move `DockedPanel` and `holdsBar` out of `DeckHeaderBar.tsx` unchanged, exported, importing the constants from `@/lib/dockedBar`:

```tsx
import type { ReactElement, ReactNode } from "react";
import { motion, useIsPresent } from "motion/react";
import { isTextField } from "@/components/menu/useContextMenu";
import {
  DOCKED_BAR_HEIGHT_PX,
  DOCKED_BAR_SHELL_PAD_PX,
  DOCKED_SHADOW,
} from "@/lib/dockedBar";
import { KEYBOARD_MODALITY_ATTR } from "@/lib/keyboardModality";
import { dockBar } from "@/lib/motion";
import { cn } from "@/lib/utils";

export function holdsBar(target: EventTarget | null): boolean {
  return isTextField(target) || document.documentElement.hasAttribute(KEYBOARD_MODALITY_ATTR);
}

export function DockedPanel({ children }: { children: ReactNode }): ReactElement {
  const present = useIsPresent();
  return (
    <motion.div
      {...dockBar}
      aria-hidden={present ? undefined : true}
      style={{
        top: -DOCKED_BAR_SHELL_PAD_PX,
        left: -DOCKED_BAR_SHELL_PAD_PX,
        right: -DOCKED_BAR_SHELL_PAD_PX,
        height: DOCKED_BAR_HEIGHT_PX,
        paddingInline: DOCKED_BAR_SHELL_PAD_PX,
      }}
      className={cn(
        "absolute border-b border-border bg-surface py-2",
        DOCKED_SHADOW,
        !present && "pointer-events-none",
      )}
    >
      {children}
    </motion.div>
  );
}
```

Carry the two functions' existing doc comments from `DeckHeaderBar.tsx` along with them. Then in `DeckHeaderBar.tsx` delete the moved code, import `DockedPanel`, `holdsBar` and the constants, and keep:

```ts
/** The deck editor's name for {@link DOCKED_BAR_CLEARANCE_PX} — named in `features/decks/CLAUDE.md`. */
export const DECK_BAR_CLEARANCE_PX = DOCKED_BAR_CLEARANCE_PX;
```

- [ ] **Step 5: Add the layer rung** in `src/lib/layers.ts`, directly after `popup`:

```ts
  /**
   * The filter quick bar (spec 2026-09-29), docked over the top of `main` on the four card walls.
   *
   * **Above {@link LAYER.popup} because its tray hangs over the collection's and the wishlist's
   * docked search column**, which is `popup` while it overlays the list and comes *later* in the
   * DOM — at an equal rung the column would paint through the tray. Below `dragTray` and every
   * dialog, which must still cover it.
   */
  quickBar: "z-35",
```

- [ ] **Step 6: Create `src/lib/useScrollPaddingTop.ts`** — the deck editor's effect (DeckEditor.tsx ~1296–1316), generalised. Move its doc comment here and leave a one-line pointer in the editor:

```ts
import { useEffect, type RefObject } from "react";
import { nearestScroller } from "./useDockHeight";

export function useScrollPaddingTop(
  target: HTMLElement | null | RefObject<HTMLElement | null>,
  clearance: number,
): void {
  useEffect(() => {
    const el = target !== null && "current" in target ? target.current : target;
    const scroller = el ? nearestScroller(el) : null;
    if (!scroller || clearance === 0) return;
    const edge = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
    scroller.style.scrollPaddingTop = `${edge + clearance}px`;
    return () => {
      scroller.style.scrollPaddingTop = "";
    };
  }, [target, clearance]);
}
```

In `DeckEditor.tsx` replace the effect with `useScrollPaddingTop(editorRef, barClearance);`.

- [ ] **Step 7: Create `src/lib/useFilterQuickBar.ts`:**

```ts
import { DOCKED_BAR_CLEARANCE_PX, DOCKED_BAR_HEIGHT_PX } from "./dockedBar";
import { useScrollPaddingTop } from "./useScrollPaddingTop";
import { useUndocked } from "./useUndocked";

export interface FilterQuickBarState {
  /** The page's filter row has scrolled above `main`'s top, and the page is in grid view. */
  shown: boolean;
  /** `top` for a `sticky` column beside the wall (a docked search column, the Tags rail). */
  dockTop: number;
  /** Added to a wall's sticky shelf bar so it pins flush under the quick bar. */
  stickyTop: number;
}

export function useFilterQuickBar(row: HTMLElement | null, enabled: boolean): FilterQuickBarState {
  const undocked = useUndocked(enabled ? row : null);
  const shown = enabled && undocked;
  useScrollPaddingTop(row, shown ? DOCKED_BAR_CLEARANCE_PX : 0);
  return {
    shown,
    dockTop: shown ? DOCKED_BAR_CLEARANCE_PX : 0,
    stickyTop: shown ? DOCKED_BAR_HEIGHT_PX : 0,
  };
}
```

Doc comment on the hook: why grid only (table views scroll in their own box), why the row is the whole `FilterBar` root, and the `listKey` reset in spec §2.

- [ ] **Step 8: `useDockHeight` clears the height it set when it unwires.** In `wired.off`, after `observer.disconnect()`, add `dockEl.style.height = "";` with a comment: a caller that stops handing a dock (Tags switching to table view) must not keep a pinned height the flex layout then cannot override. Add a case to `useDockHeight.test.ts`: render with a dock ref, then rerender passing a ref whose `current` is `null`, and assert the old element's `style.height` is `""`. Read the existing test file for its harness first.

- [ ] **Step 9: Run** `npx vitest run src/lib/useFilterQuickBar.test.ts src/lib/useDockHeight.test.ts src/features/decks/DeckHeaderBar.test.tsx` — all pass.

- [ ] **Step 10: Commit** — `git add` the files above; `git commit -m "feat(ui): share the docked bar's primitives and add useFilterQuickBar"`.

---

### Task 2: Seams in the filter chips and the filter row

**Files:**
- Modify: `src/components/FilterChips.tsx` (`ManaChip`, `ColorExactChip`)
- Modify: `src/features/search/FilterBar.tsx`
- Test: `src/components/FilterChips.test.tsx`, `src/features/search/FilterBar.test.tsx`

**Interfaces:**
- Produces: `ManaChip` and `ColorExactChip` accept `className?: string`, merged **last** through `cn` (so `size-8` beats `size-9`). `FilterBar` accepts `rootRef?: Ref<HTMLDivElement>` on its root `div`. Exported from `FilterBar.tsx`: `FilterTray` (unchanged signature `{ id, search, cells, labels, formatOptions }`), `useFormatOptions<SortKey extends string>(search: FilterSurface<SortKey>): { value: string; label: string; disabled: boolean }[]`, `sortDirectionName(dir: SortDir | undefined): string`.

- [ ] **Step 1: Failing tests.** In `FilterChips.test.tsx`:

```tsx
it("lets a caller resize the round chips", () => {
  render(<ManaChip symbol="W" pressed={false} onClick={() => {}} className="size-8" />);
  const chip = screen.getByRole("button", { name: "White" });
  expect(chip.classList.contains("size-8")).toBe(true);
  expect(chip.classList.contains("size-9")).toBe(false);
});
```

(Use whatever render wrapper the file already uses — a `TooltipProvider` if its other cases have one.) In `FilterBar.test.tsx`, using its `search()` factory:

```tsx
it("hands its root element to rootRef, so a page can watch it scroll away", () => {
  let root: HTMLDivElement | null = null;
  render(<FilterBar search={search()} rootRef={(el) => { root = el; }} />, { wrapper: TooltipProvider });
  expect(root).not.toBeNull();
  expect(root!.contains(screen.getByRole("searchbox", { name: "Search cards" }))).toBe(true);
});
```

(Match how the file already renders a `FilterBar` — copy its wrapper.)

- [ ] **Step 2: Run** both files — the new cases fail.

- [ ] **Step 3: Implement.** `ManaChip`: add `className?: string` to props and change `className={cn(roundChipClass(pressed, disabled), "text-black")}` to `cn(roundChipClass(pressed, disabled), "text-black", className)`. `ColorExactChip`: same, appended after its own classes. Doc each prop: "the filter quick bar's 32px chips and its `ring-offset-surface` — the only caller".

`FilterBar.tsx`: add `rootRef?: Ref<HTMLDivElement>` to the props and `ref={rootRef}` on the `@container/fb` root. Lift the `formatOptions` `useMemo` into an exported hook and call it from `FilterBar`:

```ts
export function useFormatOptions<SortKey extends string>(search: FilterSurface<SortKey>) {
  const facets = search.facets;
  return useMemo(
    () =>
      sortOptions(
        search.formats.map((f) => ({
          ...f,
          disabled: optionDisabled(facets?.formats, f.value, search.format === f.value),
        })),
        (f) => f.label,
        (f) => [f.disabled ? 1 : 0],
      ),
    [facets?.formats, search.format, search.formats],
  );
}
```

Add `export` to `function FilterTray` and `function sortDirectionName`. Doc `rootRef`: "the whole block — row, tray, stated filters, tag row — is what the quick bar stands in for, so its bottom edge is the trigger".

- [ ] **Step 4: Run** both files — pass.

- [ ] **Step 5: Commit** — `feat(search): expose the filter row's seams for the quick bar`.

---

### Task 3: Shelf-bar seams — `stickyTop` and an optional Top

**Files:**
- Modify: `src/features/search/CardGrid.tsx` (new `stickyTop` prop)
- Modify: `src/features/shelves/ShelfStickyBar.tsx` (`onTop` optional)
- Modify: `src/features/collection/CollectionShelfParts.tsx` (`CollectionShelfSticky` `onTop` optional)
- Modify: `src/features/wishlist/WishShelfHeading.tsx` (`WishShelfSticky` `onTop` optional)
- Modify: `src/features/wishlist/WishlistGrid.tsx` (pass `stickyTop` through)
- Test: `src/features/search/CardGrid.shelves.test.tsx`, the `ShelfStickyBar` test file (find it with a glob; create `src/features/shelves/ShelfStickyBar.test.tsx` if none exists)

**Interfaces:**
- Produces: `CardGrid` prop `stickyTop?: number` (default `0`); `WishlistGrid` prop `stickyTop?: number` forwarded to its `CardGrid`; `ShelfStickyBar`'s, `CollectionShelfSticky`'s and `WishShelfSticky`'s `onTop?: () => void` — **no Top button is drawn without it**.

- [ ] **Step 1: Failing tests.** In `CardGrid.shelves.test.tsx`, reuse the file's existing sectioned-wall render helper and add:

```tsx
it("pins the shelf bar stickyTop below the scroller's top, and names the shelf from there", () => {
  // …render the file's usual sectioned wall with stickyTop={53}…
  const anchor = document.querySelector<HTMLElement>("[data-shelf-sticky]");
  // jsdom computes no padding, so stickyInset is 0 and top is exactly the offset.
  expect(anchor?.style.top).toBe("53px");
});
```

In the ShelfStickyBar test:

```tsx
it("draws Top only when given onTop", () => {
  const { rerender } = render(<ShelfStickyBar shelf={shelf} onOpen={() => {}} onTop={() => {}} />);
  expect(screen.getByRole("button", { name: /top/i })).toBeInTheDocument();
  rerender(<ShelfStickyBar shelf={shelf} onOpen={() => {}} />);
  expect(screen.queryByRole("button", { name: /top/i })).toBeNull();
});
```

Build `shelf` the way the existing shelves tests do (grep `kind: "unfiled"` or a `Shelf` fixture in `src/features/shelves/`). Wrap in `TooltipProvider` if the component's tooltip needs it.

- [ ] **Step 2: Run** — both fail.

- [ ] **Step 3: Implement `stickyTop` in `CardGrid.tsx`.** Add the prop with a doc comment (what it is: a docked bar's height over `main`, so the shelf bar stacks under it; `0` otherwise). Change the anchor's style:

```tsx
style={stickyInset || stickyTop ? { top: stickyTop - stickyInset } : undefined}
```

and the edge the shelf is named from:

```ts
(virtualizer.scrollOffset ?? 0) - (grow ? 0 : WALL_INSET_PX) + stickyTop,
```

Update the two comments that say the bar is "flush with the top of the scrollport" to say "flush with the top of the scrollport, or with the foot of a docked bar `stickyTop` below it".

- [ ] **Step 4: Optional Top.** In `ShelfStickyBar.tsx` make `onTop?: () => void` and render the `Top` button only when `onTop` is defined (`{onTop && (<button …>)}`), with a comment: the filter quick bar carries the page's one Top while it is docked. Make `onTop` optional in `CollectionShelfSticky` and `WishShelfSticky` and pass it straight through. In `WishlistGrid.tsx` add `stickyTop?: number` to its props and pass it to its `CardGrid`.

- [ ] **Step 5: Run** the two test files — pass.

- [ ] **Step 6: Commit** — `feat(shelves): let a docked bar stack the shelf bar under it`.

---

### Task 4: `FilterQuickBar`

**Files:**
- Create: `src/features/search/FilterQuickBar.tsx`
- Create: `src/features/search/FilterQuickBar.test.tsx`
- Create: `src/features/search/FilterQuickBar.stories.tsx`

**Interfaces:**
- Consumes: Task 1 (`DockedPanel`, `holdsBar`, `DOCKED_SHADOW`, `LAYER.quickBar`), Task 2 (`FilterTray`, `useFormatOptions`, `sortDirectionName`, chip `className`).
- Produces:

```ts
export interface FilterQuickBarProps<SortKey extends string> {
  search: FilterSurface<SortKey>;
  /** From `useFilterQuickBar` — the page row has scrolled away in grid view. */
  shown: boolean;
  labels?: FilterLabels;          // default SEARCH_LABELS
  sortRows?: readonly { value: SortKey; label: string; disabled?: boolean }[]; // default SEARCH_SORT_ROWS
  tray?: readonly TrayCell[];     // default SEARCH_TRAY
  /** A page's own control, drawn after Top with a divider — Tags' picked tags. */
  lead?: ReactNode;
  /** The rung from which the mana values are drawn inline rather than folded. */
  manaValuesFrom?: "wide" | "widest"; // default "wide"
  /** The wrapper's negative bottom margin, cancelling the section's `gap`. */
  className?: string;
}
export function FilterQuickBar<SortKey extends string>(props: FilterQuickBarProps<SortKey>): ReactElement;
```

- [ ] **Step 1: Failing tests** — `FilterQuickBar.test.tsx`. Copy the `search()` factory from `FilterBar.test.tsx` (it is a local `const`, so copy it — every field). Then:

```tsx
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { FilterQuickBar } from "./FilterQuickBar";

const bar = () => screen.getByRole("group", { name: "Filter quick bar" });

describe("FilterQuickBar", () => {
  it("draws nothing until shown", () => {
    render(<FilterQuickBar search={search()} shown={false} />, { wrapper: TooltipProvider });
    expect(screen.queryByRole("group", { name: "Filter quick bar" })).toBeNull();
  });

  it("writes to the page's own search", async () => {
    const s = search();
    render(<FilterQuickBar search={s} shown />, { wrapper: TooltipProvider });
    await userEvent.type(within(bar()).getByRole("searchbox", { name: "Search cards" }), "d");
    expect(s.setText).toHaveBeenCalledWith("d");
    await userEvent.click(within(bar()).getByRole("button", { name: "Red" }));
    expect(s.toggleColor).toHaveBeenCalledWith("R");
  });

  it("scrolls back to the top and hands the caret to the page's field", async () => {
    const main = document.createElement("main");
    main.style.overflowY = "auto";
    main.scrollTo = vi.fn();
    const field = document.createElement("input");
    field.id = "card-search-text";
    document.body.append(main, field);
    render(<FilterQuickBar search={search()} shown />, { wrapper: TooltipProvider, container: main.appendChild(document.createElement("div")) });
    await userEvent.click(within(bar()).getByRole("button", { name: "Back to the top" }));
    expect(main.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    expect(document.activeElement).toBe(field);
  });

  it("opens the tray under the bar and closes it on Escape, caret back on Filters", async () => {
    render(<FilterQuickBar search={search()} shown />, { wrapper: TooltipProvider });
    const filters = within(bar()).getByRole("button", { name: /filters/i });
    await userEvent.click(filters);
    expect(filters).toHaveAttribute("aria-expanded", "true");
    const trayId = filters.getAttribute("aria-controls")!;
    expect(document.getElementById(trayId)).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(document.getElementById(trayId)).toBeNull();
    expect(document.activeElement).toBe(filters);
  });

  it("closes the tray on a press outside the bar", async () => {
    render(<><button>elsewhere</button><FilterQuickBar search={search()} shown /></>, { wrapper: TooltipProvider });
    const filters = within(bar()).getByRole("button", { name: /filters/i });
    await userEvent.click(filters);
    await userEvent.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(filters).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the tray when the bar leaves", async () => {
    const s = search();
    const { rerender } = render(<FilterQuickBar search={s} shown />, { wrapper: TooltipProvider });
    await userEvent.click(within(bar()).getByRole("button", { name: /filters/i }));
    (document.activeElement as HTMLElement).blur();
    rerender(<FilterQuickBar search={s} shown={false} />);
    rerender(<FilterQuickBar search={s} shown />);
    expect(within(bar()).getByRole("button", { name: /filters/i })).toHaveAttribute("aria-expanded", "false");
  });

  it("the bar's tray uses its own id stem, so it cannot collide with the page row's", async () => {
    render(<FilterQuickBar search={search()} shown />, { wrapper: TooltipProvider });
    await userEvent.click(within(bar()).getByRole("button", { name: /filters/i }));
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.some((id) => id.startsWith("card-search-qb"))).toBe(true);
    expect(ids).not.toContain("card-search-sort");
    expect(ids).not.toContain("card-search-text");
  });

  it("greys Reset all at zero and resets otherwise", async () => {
    const zero = search();
    const { unmount } = render(<FilterQuickBar search={zero} shown />, { wrapper: TooltipProvider });
    const reset = within(bar()).getByRole("button", { name: /reset all/i });
    expect(reset).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(reset);
    expect(zero.resetAll).not.toHaveBeenCalled();
    unmount();
    const some = search({ activeCount: 2 });
    render(<FilterQuickBar search={some} shown />, { wrapper: TooltipProvider });
    await userEvent.click(within(bar()).getByRole("button", { name: "Reset all — 2 filters active" }));
    expect(some.resetAll).toHaveBeenCalled();
  });

  it("draws a page's lead after Top", () => {
    render(<FilterQuickBar search={search()} shown lead={<span>picked tags here</span>} />, { wrapper: TooltipProvider });
    expect(within(bar()).getByText("picked tags here")).toBeInTheDocument();
  });

  it("the folded mana-value press says what is picked and opens the chips", async () => {
    render(<FilterQuickBar search={search({ manaValues: [5, 4], manaX: true })} shown />, { wrapper: TooltipProvider });
    const press = within(bar()).getByRole("button", { name: "Mana value — 4, 5, X" });
    await userEvent.click(press);
    expect(screen.getAllByRole("group", { name: "Mana value" }).length).toBeGreaterThan(0);
  });
});
```

Adjust only what the real components force (e.g. `FiltersButton`'s accessible name is `Show filters — N active`, hence the `/filters/i` regex; the tray's field `id`s come from `labels.idStem`). Do not weaken an assertion to make it pass — if one cannot hold, stop and report why.

- [ ] **Step 2: Run** `npx vitest run src/features/search/FilterQuickBar.test.tsx` — fails (no module).

- [ ] **Step 3: Implement `src/features/search/FilterQuickBar.tsx`:**

```tsx
import { useEffect, useId, useState, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, ArrowUpToLine, ChevronDown, RotateCcw, Search } from "lucide-react";
import { AnchoredPopup } from "@/components/AnchoredPopup";
import { DockedPanel, holdsBar } from "@/components/DockedBar";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import {
  ColorExactChip,
  FILTER_CONTROL,
  FILTER_FOCUS,
  FILTER_UNAVAILABLE,
  filterChipState,
  FiltersButton,
  ManaChip,
  ManaValueChips,
} from "@/components/FilterChips";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { DOCKED_SHADOW } from "@/lib/dockedBar";
import { LAYER } from "@/lib/layers";
import { MANA_KEYS, MANA_LABEL } from "@/lib/mana";
import { TRANSITION } from "@/lib/motion";
import { nearestScroller } from "@/lib/useDockHeight";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { colorDisabled, countDisabled, facetTitle, optionDisabled } from "./facets";
import {
  FilterTray,
  SEARCH_LABELS,
  SEARCH_SORT_ROWS,
  SEARCH_TRAY,
  sortDirectionName,
  useFormatOptions,
  type FilterLabels,
  type FilterSurface,
  type TrayCell,
} from "./FilterBar";

/** A bar press: the row's 36px control in the deck bar's `text-xs`, on the bar's own fill. */
const PRESS = "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-border bg-surface px-2.5 text-xs";
/** The round chips at 32px, their pressed ring offset on the bar's `surface` rather than `bg`. */
const CHIP_SM = "size-8 text-base ring-offset-surface";
const BADGE = "rounded-full bg-accent px-1.5 font-mono text-[0.7rem] leading-4 text-accent-foreground";
/** Literal strings, because Tailwind reads source text: one pair per `manaValuesFrom`. */
const MV_INLINE = { wide: "hidden @min-[1100px]/qb:flex", widest: "hidden @min-[1500px]/qb:flex" } as const;
const MV_FOLDED = { wide: "@min-[1100px]/qb:hidden", widest: "@min-[1500px]/qb:hidden" } as const;

function Divider(): ReactElement {
  return <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />;
}

export function FilterQuickBar<SortKey extends string>({
  search,
  shown,
  labels = SEARCH_LABELS,
  sortRows = SEARCH_SORT_ROWS as readonly { value: SortKey; label: string }[],
  tray = SEARCH_TRAY,
  lead,
  manaValuesFrom = "wide",
  className,
}: FilterQuickBarProps<SortKey>): ReactElement {
  const tip = useTooltip();
  const [caretHolds, setCaretHolds] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [group, setGroup] = useState<HTMLDivElement | null>(null);
  const trayId = useId();
  const mounted = shown || caretHolds;
  // Put down during render, never in an effect: a tray left "open" behind an unmounted bar would
  // come back open on the next undock, over a wall the reader has since scrolled.
  if (!mounted && trayOpen) setTrayOpen(false);

  const facets = search.facets;
  const formatOptions = useFormatOptions(search);
  // The bar's own id stem, so its tray and sort never share an `id` with the page row's.
  const qbLabels: FilterLabels = { ...labels, idStem: `${labels.idStem}-qb` };
  const sortDir = search.sortDir;
  const count = search.activeCount;
  const sortOptions: readonly DropdownOption[] = sortRows.map((s) => ({
    value: s.value,
    label: s.label,
    disabled: s.disabled,
  }));
  const picked = [...search.manaValues].sort((a, b) => a - b).map((v) => (v >= 8 ? "8+" : String(v)));
  if (search.manaX) picked.push("X");
  const mvSummary = picked.join(", ");
  const resetName = `Reset all — ${count} filter${count === 1 ? "" : "s"} active`;

  useEffect(() => {
    if (!trayOpen || group === null) return;
    const onDown = (e: PointerEvent) => {
      if (!group.contains(e.target as Node)) setTrayOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [trayOpen, group]);

  const backToTop = () => {
    setCaretHolds(false);
    const scroller = group ? nearestScroller(group) : null;
    if (scroller) {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      if (typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
      } else {
        scroller.scrollTop = 0;
      }
    }
    document.getElementById(`${labels.idStem}-text`)?.focus({ preventScroll: true });
  };

  const manaValues = (
    <ManaValueChips
      chipClass="size-8"
      selected={search.manaValues}
      onToggle={search.toggleManaValue}
      disabled={(value) =>
        optionDisabled(facets?.manaValues, String(value), search.manaValues.includes(value))
      }
      title={(value, label) => facetTitle(label, facets?.manaValues[String(value)])}
      xSelected={search.manaX}
      onToggleX={search.toggleManaX}
      xDisabled={countDisabled(facets?.manaX, search.manaX)}
      xTitle={(label) => facetTitle(label, facets?.manaX)}
    />
  );

  return (
    <AnimatePresence>
      {mounted && (
        <div key="filter-quick-bar" className={cn("sticky top-0 left-0 h-0", LAYER.quickBar, className)}>
          <DockedPanel>
            <div
              ref={setGroup}
              role="group"
              aria-label="Filter quick bar"
              onFocus={(e) => setCaretHolds(holdsBar(e.target))}
              onBlur={(e) => {
                if (e.currentTarget.contains(e.relatedTarget)) return;
                if (e.relatedTarget === null && !document.hasFocus()) return;
                setCaretHolds(false);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Escape" || !trayOpen || e.defaultPrevented) return;
                e.preventDefault();
                setTrayOpen(false);
                group?.querySelector<HTMLButtonElement>(`[aria-controls="${trayId}"]`)?.focus();
              }}
              className="@container/qb relative flex h-full items-center gap-2"
            >
              <button
                type="button"
                aria-label="Back to the top"
                {...tip("Back to the top", { describes: false })}
                onClick={backToTop}
                className={cn(FILTER_CONTROL, FILTER_FOCUS, PRESS, "w-9 px-0 text-dim hover:text-text @min-[1500px]/qb:w-auto @min-[1500px]/qb:px-2.5")}
              >
                <ArrowUpToLine aria-hidden="true" className="size-4 shrink-0" />
                <span className="hidden @min-[1500px]/qb:inline">Top</span>
              </button>

              {lead && (
                <>
                  {lead}
                  <Divider />
                </>
              )}

              <div className="relative flex min-w-30 flex-1 basis-50 items-center max-w-70 @min-[1500px]/qb:max-w-90">
                <Search aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-2.5 my-auto size-3.5 text-dim" />
                <input
                  type="search"
                  aria-label={labels.search}
                  placeholder={`${labels.search}…`}
                  value={search.text}
                  onChange={(e) => search.setText(e.target.value)}
                  onKeyDown={(e) => clearFieldOnEscape(e, search.text, () => search.setText(""))}
                  className={cn("h-9 w-full min-w-0 rounded-md border border-border bg-bg pr-2.5 pl-8 text-xs placeholder:text-dim", FILTER_FOCUS)}
                />
              </div>

              <Divider />

              <div role="group" aria-label="Color identity" className="flex shrink-0 items-center gap-1.5 px-0.5">
                {MANA_KEYS.map((key) => (
                  <ManaChip
                    key={key}
                    symbol={key}
                    className={CHIP_SM}
                    pressed={search.colors.includes(key)}
                    disabled={colorDisabled(facets?.colors[key], facets?.total ?? 0, search.colors.includes(key))}
                    title={facetTitle(MANA_LABEL[key], facets?.colors[key])}
                    onClick={() => search.toggleColor(key)}
                  />
                ))}
                <ColorExactChip className={CHIP_SM} pressed={search.colorsStrict} onClick={search.toggleColorsStrict} />
              </div>

              <Divider />

              <div className={cn("shrink-0 items-center", MV_INLINE[manaValuesFrom])}>{manaValues}</div>
              <div className={cn("shrink-0", MV_FOLDED[manaValuesFrom])}>
                <AnchoredPopup
                  label={`Mana value — ${mvSummary || "any"}`}
                  panelLabel="Mana value"
                  align="start"
                  triggerContent={
                    <>
                      <span>Mana value</span>
                      {mvSummary && <span className="font-mono tabular-nums">{mvSummary}</span>}
                      <ChevronDown aria-hidden="true" className="size-3.5" />
                    </>
                  }
                  triggerClassName={cn(FILTER_CONTROL, PRESS, "bg-transparent pr-2", filterChipState(picked.length > 0))}
                  panelClassName="p-2.5"
                >
                  {manaValues}
                </AnchoredPopup>
              </div>

              <span aria-hidden="true" className="min-w-2 flex-1" />

              <FiltersButton
                open={trayOpen}
                count={count}
                onToggle={() => setTrayOpen((open) => !open)}
                controls={trayId}
                labelClass="hidden @min-[1500px]/qb:inline"
                className="text-xs"
              />

              <div className="hidden shrink-0 items-center gap-2 @min-[860px]/qb:flex">
                <Divider />
                <label id={`${qbLabels.idStem}-sort-label`} htmlFor={`${qbLabels.idStem}-sort`} className="sr-only">
                  Sort results
                </label>
                <div className="flex items-center gap-1">
                  <Dropdown
                    id={`${qbLabels.idStem}-sort`}
                    labelledBy={`${qbLabels.idStem}-sort-label`}
                    value={search.sortSelection}
                    onChange={(key) => search.setSortKey(key as SortKey)}
                    options={sortOptions}
                  />
                  <span {...tip(sortDirectionName(sortDir), { describes: false })}>
                    <button
                      type="button"
                      onClick={search.flipSortDir}
                      disabled={!sortDir}
                      aria-label={sortDirectionName(sortDir)}
                      className={cn(FILTER_CONTROL, FILTER_FOCUS, "flex size-9 items-center justify-center", filterChipState(false, !sortDir))}
                    >
                      <motion.span aria-hidden="true" initial={false} animate={{ rotate: sortDir === "desc" ? 180 : 0 }} transition={TRANSITION.fast} className="flex">
                        <ArrowUp className="size-4" />
                      </motion.span>
                    </button>
                  </span>
                </div>
              </div>

              <Divider />
              <button
                type="button"
                onClick={() => {
                  if (count > 0) search.resetAll();
                }}
                aria-disabled={count <= 0 || undefined}
                aria-label={resetName}
                {...tip(resetName, { describes: false })}
                className={cn(FILTER_CONTROL, FILTER_FOCUS, PRESS, "min-w-9 gap-2 px-2 text-dim @min-[1500px]/qb:px-2.5", count <= 0 ? FILTER_UNAVAILABLE : "hover:text-text")}
              >
                <RotateCcw aria-hidden="true" className="size-4 shrink-0 @min-[1500px]/qb:hidden" />
                <span className="hidden @min-[1500px]/qb:inline">Reset all</span>
                {count > 0 && <span aria-hidden="true" className={BADGE}>{count}</span>}
              </button>

              {trayOpen && (
                <div className={cn("absolute inset-x-0 top-full mt-4 max-h-[calc(100vh-12rem)] overflow-y-auto rounded-lg", DOCKED_SHADOW)}>
                  <FilterTray id={trayId} search={search} cells={tray} labels={qbLabels} formatOptions={formatOptions} />
                </div>
              )}
            </div>
          </DockedPanel>
        </div>
      )}
    </AnimatePresence>
  );
}
```

Then write the doc comments this file needs — the component (what it stands in for, the rung table, why a container query rather than a measured rung like `DeckHeaderBar`'s), `mounted`, the outside-press listener (capture phase; nothing in the tray portals, checked 2026-09-29), `backToTop`, the tray's `mt-4` (the group's foot is the panel's 8px padding above its bottom, so 16px lands 8px under the bar), and the Escape handler (bubbling on purpose, so an open set picker or dropdown inside the tray — capture-phase `inner` layers — closes first and consumes the key). If `tsc` finds a mismatch with a real prop (e.g. `FiltersButton` has no `className` merge, `Dropdown`'s `value` type), fix the call to the real API and say so in your report — do not add props to shared components beyond Task 2's.

- [ ] **Step 4: Run** the test file — pass. Then `npx tsc --noEmit -p .` (whole project type-check; it is fast) and fix only errors in files you own.

- [ ] **Step 5: Stories.** `FilterQuickBar.stories.tsx`, following `FilterBar.stories.tsx`'s conventions (its meta, its fake search surface, its decorators). Three stories, each inside a `relative` box 1232px wide with `padding: 20px` and a 400px-tall block under the bar so the tray has room: `Docked` (a filtered search, `shown`), `TrayOpen` (a play that clicks Filters and asserts `aria-expanded="true"`), `TagsLead` (`lead` = a `TagChips singleLine` — only once Task 8 lands; until then use a plain `span` lead and leave a comment). Keep plays minimal.

- [ ] **Step 6: Commit** — `feat(search): the filter quick bar`.

---

### Task 5: Card search page

**Files:**
- Modify: `src/features/search/SearchPage.tsx` (the `SearchPage` component around lines 294–400)

**Interfaces:** Consumes `useFilterQuickBar`, `FilterQuickBar`, `FilterBar`'s `rootRef`.

- [ ] **Step 1: Wire it.** In `SearchPage`:

```tsx
const [filterRow, setFilterRow] = useState<HTMLDivElement | null>(null);
const quick = useFilterQuickBar(filterRow, view === "grid");
```

As the section's **first** child (before the `sr-only` `h2`):

```tsx
<FilterQuickBar search={search} shown={quick.shown} className="-mb-4" />
```

and `<FilterBar search={search} rootRef={setFilterRow} />`. `-mb-4` because the section is `gap-4`: the wrapper is `h-0`, so the margin cancels the gap it would otherwise add.

- [ ] **Step 2: Fix the stale comment** at the section's `h-full` note: it says `FilterBar` is `sticky top-0`, which it has not been for a long time. Rewrite that paragraph to say the wall grows and `main` scrolls, so the filter row scrolls away in grid view and `FilterQuickBar` stands in for it (spec 2026-09-29).

- [ ] **Step 3: Run** `npx vitest run src/features/search/SearchPage.test.tsx` — still passes (jsdom never undocks).

- [ ] **Step 4: Commit** — `feat(search): dock the quick bar on the card search`.

---

### Task 6: Collection page

**Files:**
- Modify: `src/features/collection/CollectionPage.tsx`

**Interfaces:** Consumes Task 1's hook, Task 3's `stickyTop` and optional `onTop`, Task 4's bar.

- [ ] **Step 1: The hook**, placed right after `dockRef` is declared (~line 823) so both later users see it:

```tsx
const [filterRow, setFilterRow] = useState<HTMLDivElement | null>(null);
const quick = useFilterQuickBar(filterRow, view === "grid");
```

- [ ] **Step 2: The docked search column starts under the bar.** Change `useDockHeight(dockRef, deskRef);` (~862) to `useDockHeight(dockRef, deskRef, quick.dockTop);`. On the dock `div` (~3906) drop `top-0` from the class list and add `style={{ top: quick.dockTop }}` — an inline length, as the deck editor does, so the height and the inset agree.

- [ ] **Step 3: The shelf bar.** In `renderSticky` (~3196) pass `onTop={quick.shown ? undefined : scrollToTop}` and add `quick.shown` to its dependency list. Pass `stickyTop={quick.stickyTop}` to the **grid's** `CardGrid` (~3645). Leave the table's path alone — the bar never shows in table view.

- [ ] **Step 4: Mount it.** First child of the `<section>` (~3269):

```tsx
<FilterQuickBar
  search={collection}
  shown={quick.shown}
  labels={COLLECTION_LABELS}
  sortRows={collection.sortRows}
  tray={COLLECTION_TRAY}
  className="-mb-3"
/>
```

— the same `search`, `labels`, `sortRows` and `tray` the page's `FilterBar` takes (check that call at ~3357 and mirror it exactly), and add `rootRef={setFilterRow}` to that `FilterBar`.

- [ ] **Step 5: Run** `npx vitest run src/features/collection/CollectionPage.test.tsx` (or the page's test files — glob `src/features/collection/CollectionPage*.test.tsx`) — pass.

- [ ] **Step 6: Commit** — `feat(collection): dock the quick bar over the collection`.

---

### Task 7: Wishlist page

**Files:**
- Modify: `src/features/wishlist/WishlistPage.tsx`

- [ ] **Step 1: The hook**, next to `dockRef`/`deskRef` and before `useDockHeight` (~616):

```tsx
const [filterRow, setFilterRow] = useState<HTMLDivElement | null>(null);
const quick = useFilterQuickBar(filterRow, view === "grid");
```

- [ ] **Step 2:** `useDockHeight(dockRef, deskRef, quick.dockTop);`; the dock `div` (~2618) loses `top-0` and gains `style={{ top: quick.dockTop }}`.

- [ ] **Step 3:** `renderSticky` (~1945): `onTop={quick.shown ? undefined : scrollToTop}`, add `quick.shown` to deps. Pass `stickyTop={quick.stickyTop}` to `WishlistGrid` (~2549). Leave `scrollTableTop`'s table path alone.

- [ ] **Step 4: Mount it** as the section's (~2176) first child with the same props as the page's `FilterBar` (~2285: `labels={WISHLIST_LABELS}`, `sortRows={wishlist.sortRows}`, `tray={WISHLIST_TRAY}`) and `className="-mb-3"`; add `rootRef={setFilterRow}` to the `FilterBar`.

- [ ] **Step 5: Run** the wishlist page's tests (`src/features/wishlist/WishlistPage*.test.tsx`) — pass.

- [ ] **Step 6: Commit** — `feat(wishlist): dock the quick bar over the wishlist`.

---

### Task 8: Tags — one scrolling page in grid view, picked tags in the bar

**Files:**
- Modify: `src/features/tags/TagsPage.tsx`
- Modify: `src/features/tags/TagResults.tsx`
- Modify: `src/features/tags/TagChips.tsx` (new `singleLine` prop)
- Test: `src/features/tags/TagChips.test.tsx` (glob for it; create if absent), `src/features/tags/TagsPage.test.tsx`

- [ ] **Step 1: Failing test for `singleLine`:**

```tsx
it("draws one unwrapped line when singleLine, and says so when empty", () => {
  render(<TagChips selection={EMPTY} onRemove={() => {}} onToggleMode={() => {}} singleLine emptyMessage="No tags picked" />);
  const group = screen.getByRole("group", { name: "Picked tags" });
  expect(group.classList.contains("flex-nowrap")).toBe(true);
  expect(screen.getByText("No tags picked")).toBeInTheDocument();
});
```

(`EMPTY` is the file's / `tagFilters.ts`'s empty selection — `EMPTY_SELECTION` in `TagsPage` imports it from somewhere; reuse that.)

- [ ] **Step 2: Run** — fails.

- [ ] **Step 3: `TagChips` `singleLine`.** Add `singleLine?: boolean` (doc: the filter quick bar's lead — one line that scrolls sideways, never a second row in a 53px bar). When set: the outer row is `flex min-w-0 max-w-[min(28rem,32%)] shrink flex-nowrap items-center gap-1.5 overflow-x-auto [scrollbar-width:none]`, the group is `flex flex-nowrap items-center gap-1.5`, and the empty message is `text-xs whitespace-nowrap text-dim`. Unset, nothing changes.

- [ ] **Step 4: The page.** In `TagsPage`:

```tsx
const view = useAppStore((s) => s.tagsView);
const [filterRow, setFilterRow] = useState<HTMLDivElement | null>(null);
const quick = useFilterQuickBar(filterRow, view === "grid");
const bodyRef = useRef<HTMLDivElement>(null);
const railRef = useRef<HTMLDivElement>(null);
// Grid only: in table view the rail is bounded by the flex column again and must carry no
// pinned height — handing no dock is what makes `useDockHeight` take its height off (Task 1).
useDockHeight(view === "grid" ? railRef : NO_RAIL, bodyRef, quick.dockTop);
```

with `const NO_RAIL: RefObject<HTMLElement | null> = { current: null };` at module scope. Then:

- section: `className={cn("flex flex-col gap-3", view === "table" && "h-full")}` — rewrite the docblock above `TagsPage` (it says the page is two side-by-side scrollers, and still says the rail is 256px — it is `w-72`, 288px): in grid view `main` scrolls the page and the rail pins; in table view it is the old arrangement.
- first child: `<FilterQuickBar search={search} shown={quick.shown} className="-mb-3" manaValuesFrom="widest" lead={<TagChips selection={selection} onRemove={removeTag} onToggleMode={toggleTagMode} singleLine emptyMessage="No tags picked" />} />` — no `onFloorChange`: the background toggle stays on the page row.
- `<FilterBar search={search} layoutFor="tags" rootRef={setFilterRow} />`
- body: `ref={bodyRef} className={cn("flex gap-4", view === "table" && "min-h-0 flex-1")}`
- rail: `ref={railRef}`, classes `flex w-72 shrink-0 flex-col gap-3 border-r border-border pr-4` plus `view === "table" ? "min-h-0" : "sticky self-start"`, and `style={view === "grid" ? { top: quick.dockTop } : undefined}`.
- results column: `cn("flex min-w-0 flex-1 flex-col", view === "table" && "min-h-0")`.

Check `TagTree` scrolls inside the rail (it should be `min-h-0 flex-1 overflow-y-auto` or similar); if it relies on the rail's `min-h-0`, keep `min-h-0` on the rail in both views.

- [ ] **Step 5: `TagResults`.** Its `CardGrid` gets `grow={view === "grid"}` (it already reads `view`). Read how `SearchPage`'s `Results` passes `grow` and whatever else `grow` needs there (a `listKey`, the prefetch) and mirror it; its root keeps `flex min-h-0 flex-1 flex-col gap-2`. The table path is unchanged.

- [ ] **Step 6: Run** `npx vitest run src/features/tags` — pass. A test asserting the section is `h-full` in grid view is now wrong by design: update it to assert `h-full` in table view only, and say so in the report.

- [ ] **Step 7: Commit** — `feat(tags): scroll the Tags page as one page and dock the quick bar`.

---

### Task 9: Docs, verify, live pass, PR (controller)

- [ ] Add a **"The filter quick bar"** section to `docs/reference/frontend-design.md`: the trigger, the rung table, `LAYER.quickBar`'s reason, the clearances (53 / 41), the shelf bar's Top rule, Tags' two layouts, and the `listKey` reset behaviour. Add a row-level mention in `src/CLAUDE.md` only if a binding rule emerged.
- [ ] `npm run verify` — green (one run; never two at once).
- [ ] Live pass over CDP (`running-the-app` skill, `docs/reference/live-ui-verification.md`): on each page in grid view, scroll until the row leaves — the bar slides in; measure its height 53 and its top 0; press Filters → tray under it, over the collection's docked column; Escape closes; Top scrolls up and focuses the page field; collection shelf bar pinned at 53 with no Top; Tags rail pinned at 61 while the wall scrolls. Resize to 1440 and 1024 (sidebar collapsed and not) and read which rung pieces are displayed.
- [ ] `shipping-a-branch` / `auto-pr`: PR, arm auto-merge, CI auto-fix.
