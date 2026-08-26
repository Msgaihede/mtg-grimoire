# Unified Dropdowns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every native `<select>` element and rebuild `SetCombobox` on one `Dropdown`
component, so every option list in the app is drawn by the app, looks the same, and can be given a
search box with one prop.

**Architecture:** A private `<DropdownShell>` owns the trigger, the panel, the search box, the rows,
the keyboard walk, dismissal and placement. Two components are exported over it — `<Dropdown>`
(single-select, replacing them all) and `<MultiDropdown>` (multi-select, which `SetCombobox` becomes a
caller of). The panel is positioned by pure arithmetic in `placeDropdown()` and drawn `absolute`
inside a zero-size `fixed` frame, which is what makes it escape a scroller *and* survive a
transformed ancestor.

**Tech Stack:** React 19, TypeScript 6, Tailwind v4, `motion@13.1.0`, Vitest + Testing Library,
Storybook 9, Tauri 2.11.

**Spec:** `docs/superpowers/specs/2026-08-25-unified-dropdowns-design.md` — read it before Task 1.
Sections 5, 6 and 7 carry constraints no test in this repo can enforce.

## Global Constraints

- **Never install a dependency for this.** The shipped CSP is
  `style-src 'self'; style-src-attr 'unsafe-inline'`; a portalled overlay primitive injects a runtime
  `<style>` **element**, which is green under `tauri dev`, green in the suite, green in Storybook, and
  blank in the packaged exe. Inline `style` attributes are allowed and are what this shell uses.
- **Z-indexes come from `LAYER` in `src/lib/layers.ts`** and nowhere else. `src/lib/layers.test.ts`
  sweeps `src/` to keep it that way. The panel takes `LAYER.popup` (`z-30`).
- **Timings come from a preset in `src/lib/motion.ts`**, never a number. The panel uses `popup`.
  `AnimatePresence mode="popLayout"` and `animateView()` are forbidden — both append a `<style>` to
  `document.head`.
- **Focus rings come from `FOCUS` in `src/lib/focus.ts`.** Never a hand-written outline.
- **The shell never sorts.** Callers pass their list in the order they want it drawn; every one of
  them already runs it through `sortOptions` in `src/lib/options.ts` and carries a comment saying
  which rule or exemption it takes.
- **Never `disabled` on a control that greys as the reader types** — `aria-disabled`, so the tab
  order does not change under their hands. Rows are walked by `aria-activedescendant` and are never
  in the tab order at all, so a row uses `aria-disabled`.
- **Never install `@types/node`.**
- **`npm run verify` before every commit** (`build && lint && test:run && cargo test`). It does
  **not** run `cargo fmt` or `cargo clippy`; CI does, and they are the only reds a green verify can
  still produce. No Rust changes in this plan, so `cargo` is unaffected — but do not skip verify.
- **Never run two `npm run verify` at once** in any worktree. Concurrent runs fake ~18 Rust schema
  failures.
- **Commit small, with `feat:` / `fix:` / `chore:` / `test:` / `docs:`.** End every commit message
  with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **jsdom has no layout engine.** Nothing in the suite can go red for placement, flipping, the
  containing-block correction, min-width, or overflow. Say so at each site rather than writing a
  test that cannot fail.

## Deviations from the spec

Two things this plan adds that the spec does not name. Both were found while working out the
interfaces; neither changes a decision.

- **`onOpen?: () => void`** on `SharedProps` (introduced in Task 8). `SetCombobox`'s
  `startOpening()` resets the cursor, the page depth and the `pinned` snapshot in the **same batch**
  as the open — deliberately not an effect, because an effect would take that snapshot one commit
  after the first render of the list it is meant to order. With the shell owning `open`, a caller has
  no other way to hook one.
- **The listbox holds the caret on a dropdown with no search box**, and carries
  `aria-activedescendant`. The spec described the searchable shape (`SetCombobox`'s, where the
  search box is the combobox and holds both); a non-searchable dropdown has no such element, and
  `aria-activedescendant` on anything but the focused element points from the wrong place.

---

## File Structure

**Created**

| Path | Responsibility |
| --- | --- |
| `src/components/Dropdown/types.ts` | `DropdownOption`, `DropdownSize`, `Placement` — types only, no runtime code |
| `src/components/Dropdown/place.ts` | `placeDropdown()` — pure arithmetic, fully unit-testable |
| `src/components/Dropdown/place.test.ts` | its tests |
| `src/components/Dropdown/usePopupPlacement.ts` | the hook: measure, call `placeDropdown`, correct for the containing block, listen for scroll/resize |
| `src/components/Dropdown/Dropdown.tsx` | `<Dropdown>`, `<MultiDropdown>`, private `<DropdownShell>` and `<Row>` |
| `src/components/Dropdown/Dropdown.test.tsx` | behaviour the suite can see |
| `src/components/Dropdown/Dropdown.stories.tsx` | the workbench |
| `src/test-dropdown.ts` | `pickOption()` / `openDropdown()` for the 72 rewritten call sites |

**Modified**

| Path | Change |
| --- | --- |
| `src/components/PopupListbox.tsx` | `PopupPanel` gains an optional `style` prop |
| `src/features/search/SetCombobox.tsx` | rebuilt on `<MultiDropdown>` |
| 12 feature files | every native `<select>` → `<Dropdown>` |
| `src/features/card/AllPrintingsDialog.tsx` | `ARROW_OWNERS` / `ownsArrowKeys` |
| 25 test and story files | 72 `selectOptions` calls |
| `docs/reference/frontend-design.md`, `src/CLAUDE.md` | the new rules and the live readings |

---

## Task 1: The placement arithmetic

Pure functions first, because they are the only part of the placement any test can see.

**Files:**
- Create: `src/components/Dropdown/types.ts`
- Create: `src/components/Dropdown/place.ts`
- Test: `src/components/Dropdown/place.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DropdownOption = { value: string; label: string; icon?: ReactNode; hint?: string; disabled?: boolean; title?: string }`
  - `type DropdownSize = "md" | "sm"`
  - `type Placement = { left: number; top: number; flipX: boolean; flipY: boolean }`
  - `const PANEL_GAP = 4`, `const VIEWPORT_GUTTER = 8`
  - `function placeDropdown(input: PlaceInput): Placement`
  - `type PlaceInput = { trigger: Box; panel: Size; viewport: Size; align: "start" | "end" }`
  - `type Box = { left: number; top: number; right: number; bottom: number }`
  - `type Size = { width: number; height: number }`

- [ ] **Step 1: Write `types.ts`**

```ts
import type { ReactNode } from "react";

/**
 * One row of a dropdown.
 *
 * Six fields, and deliberately **no render prop**. All 45 `<option>` bodies this app replaced were
 * plain strings and the set picker's row is exactly `icon + label + hint + tick`, so there is
 * nothing today a `renderRow` would serve — and a render prop is how two dropdowns start looking
 * different again, which is the whole thing this component exists to stop.
 */
export type DropdownOption = {
  /** The value round-tripped to the caller. A string, because a select speaks strings. */
  value: string;
  /**
   * What the reader sees, and what an **uncontrolled** search box matches against.
   *
   * A caller that supplies `query`/`onQueryChange` filters the list itself and this is never
   * matched against — see `DropdownShell`.
   */
  label: string;
  /** Drawn at the head of the row. The set picker's keyrune glyph is the only one today. */
  icon?: ReactNode;
  /** A dim, right-aligned second fact — the set picker's code. */
  hint?: string;
  /**
   * Out of reach: greyed with `FILTER_UNAVAILABLE`, `aria-disabled`, refused by both the pointer
   * and Enter, and skipped by the arrow keys.
   *
   * **`aria-disabled` and not `disabled`.** The house rule is that a control which greys as the
   * reader types must not leave the tab order under their hands; a row is never *in* the tab order
   * (the walk is `aria-activedescendant`, not focus), so the same argument lands on the same
   * attribute for a different reason — there is no `disabled` to set on a `<li>` at all.
   */
  disabled?: boolean;
  /**
   * The row's tooltip, through `useTooltip`. **Never its accessible name** — the row's own content
   * is that, and an `aria-label` here would replace the label, the hint and the tick with a
   * sentence that has neither in it.
   */
  title?: string;
};

/**
 * The two geometries, and there are only two.
 *
 * `md` **is** `FilterChips`' private `FILTER_SHAPE` (`h-9 rounded-md border text-sm`), so a
 * dropdown in a filter row shares a line with the chips beside it. `sm` is the card pane's
 * density. Four geometries existed before this component and nobody had decided on any of them.
 */
export type DropdownSize = "md" | "sm";

/** A rectangle in viewport coordinates. */
export type Box = { left: number; top: number; right: number; bottom: number };

export type Size = { width: number; height: number };

/**
 * Where the panel goes, in **viewport** coordinates.
 *
 * The hook converts these to the frame's coordinates before they reach the DOM; see
 * `usePopupPlacement`. The two flags are not redundant with the numbers — they pick the
 * `origin-*` class, and a panel has to grow from the corner it is pinned by.
 */
export type Placement = { left: number; top: number; flipX: boolean; flipY: boolean };
```

- [ ] **Step 2: Write the failing tests**

Create `src/components/Dropdown/place.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PANEL_GAP, VIEWPORT_GUTTER, placeDropdown } from "./place";

/** A 1280x800 window with a 120px-wide trigger at (100, 200). */
const base = {
  trigger: { left: 100, top: 200, right: 220, bottom: 236 },
  panel: { width: 200, height: 300 },
  viewport: { width: 1280, height: 800 },
  align: "start" as const,
};

describe("placeDropdown", () => {
  it("opens below and left-aligned when there is room for both", () => {
    expect(placeDropdown(base)).toEqual({
      left: 100,
      top: 236 + PANEL_GAP,
      flipX: false,
      flipY: false,
    });
  });

  it("right-aligns when the panel would run past the right edge", () => {
    // Trigger near the right edge: 1200 + 200 = 1400 > 1280 - 8.
    const at = { ...base, trigger: { left: 1200, top: 200, right: 1260, bottom: 236 } };
    const out = placeDropdown(at);
    expect(out.flipX).toBe(true);
    // Pinned by the trigger's RIGHT edge, which is the corner it then grows from.
    expect(out.left).toBe(1260 - 200);
  });

  it("honours align=end as the first guess even with room on both sides", () => {
    const out = placeDropdown({ ...base, align: "end" });
    expect(out.flipX).toBe(true);
    expect(out.left).toBe(220 - 200);
  });

  it("opens above when there is no room below", () => {
    // bottom 700 + gap + 300 = 1004 > 800 - 8, and 700 has more room above than below.
    const at = { ...base, trigger: { left: 100, top: 664, right: 220, bottom: 700 } };
    const out = placeDropdown(at);
    expect(out.flipY).toBe(true);
    expect(out.top).toBe(664 - PANEL_GAP - 300);
  });

  it("stays below when neither side fits and below has more room", () => {
    // A 700px panel in an 800px window: 100px above the trigger, 564px below.
    const at = { ...base, panel: { width: 200, height: 700 } };
    const out = placeDropdown(at);
    expect(out.flipY).toBe(false);
    expect(out.top).toBe(236 + PANEL_GAP);
  });

  it("never places the panel past the left gutter", () => {
    // A trigger at the very left with align=end would pin the panel at a negative left.
    const at = {
      ...base,
      trigger: { left: 4, top: 200, right: 60, bottom: 236 },
      align: "end" as const,
    };
    expect(placeDropdown(at).left).toBe(VIEWPORT_GUTTER);
  });

  it("never places the panel past the top gutter", () => {
    const at = { ...base, trigger: { left: 100, top: 10, right: 220, bottom: 46 } };
    const tall = { ...at, panel: { width: 200, height: 790 } };
    expect(placeDropdown(tall).top).toBeGreaterThanOrEqual(VIEWPORT_GUTTER);
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run src/components/Dropdown/place.test.ts`
Expected: FAIL — `Failed to resolve import "./place"`.

- [ ] **Step 4: Write `place.ts`**

```ts
import type { Box, Placement, Size } from "./types";

/**
 * The air between the trigger and its panel, in px.
 *
 * 4px — `SetCombobox`'s `mt-1`, which is what this component's panel replaced. Written as a number
 * rather than a class because the panel's offset is computed and set inline; a Tailwind margin
 * would be added *on top of* a measured `top` and put the panel 4px lower than the arithmetic said.
 */
export const PANEL_GAP = 4;

/**
 * How close to the window's edge a panel may come, in px.
 *
 * Nothing in this app clips a popup, so a panel that overflows does not get a scrollbar — it
 * scrolls the whole app sideways the moment anything calls `scrollIntoView` on it. The gutter is
 * what keeps the flip from landing exactly on the edge it was avoiding.
 */
export const VIEWPORT_GUTTER = 8;

export type PlaceInput = {
  /** The trigger, in viewport coordinates. */
  trigger: Box;
  /**
   * The panel's **layout** size — `offsetWidth`/`offsetHeight`, never a rect.
   *
   * `popup` holds the panel at `scale: 0.96` for the length of its entry tween, so a
   * `getBoundingClientRect()` taken on the mount frame is 4% short in both axes. The same
   * confusion cost `AnchoredPopup` a session: measured in the shipped window on 2026-08-22,
   * that scale dropped its scroller's `scrollTop` maximum from 257 to 246 and no scroll margin
   * could recover it. `offsetHeight` is the layout box and no transform touches it.
   */
  panel: Size;
  /**
   * `document.documentElement.clientWidth` / `clientHeight`, **never** `innerWidth`/`innerHeight`.
   *
   * The window's inner size includes the scrollbar, so a panel flipped against it is flipped to
   * a position underneath one. `menu/panel.ts` states the rule; this is its third instance.
   */
  viewport: Size;
  /**
   * The caller's first guess at which edge the panel is pinned by, which the arithmetic below may
   * still overrule.
   *
   * It is a guess worth having because the caller often knows the layout better than one
   * measurement does: the two search-shaped set pickers sit at the **right end** of a wrapping
   * filter row and pass `"end"`, and `AllPrintingsDialog` puts one second in its row and passes
   * `"start"` because there is nothing to the left to open back across.
   */
  align: "start" | "end";
};

/**
 * Where a dropdown panel goes.
 *
 * Pure, and separated from the hook for the reason `menu/panel.ts` is: jsdom measures every
 * rectangle as zero, so the *arithmetic* is the only part of the placement a test can ever reach.
 * Whether the numbers this returns put the panel where a reader can see it is a question only the
 * shipped window answers.
 *
 * **The corner it is pinned by is the corner it grows from** — that is this app's standing rule for
 * an anchored popup, and it is why the two flags come back rather than being folded into the
 * numbers. A panel that grew from its own middle reads as unrelated to the control that opened it.
 */
export function placeDropdown({ trigger, panel, viewport, align }: PlaceInput): Placement {
  // Horizontal. `start` pins the panel's left edge to the trigger's left; `end` pins its right
  // edge to the trigger's right. Whichever the caller asked for, a panel that would then run past
  // the far gutter takes the other — a flip is cheaper to read than a panel half off the window.
  const startLeft = trigger.left;
  const endLeft = trigger.right - panel.width;
  const startFits = startLeft + panel.width <= viewport.width - VIEWPORT_GUTTER;
  const endFits = endLeft >= VIEWPORT_GUTTER;
  const flipX = align === "end" ? endFits || !startFits : !startFits && endFits;
  // Clamped last and in both directions: a panel wider than the window has no correct edge, and
  // the left one is the one a reader's eye starts at.
  const left = Math.max(
    VIEWPORT_GUTTER,
    Math.min(flipX ? endLeft : startLeft, viewport.width - VIEWPORT_GUTTER - panel.width),
  );

  // Vertical. Below by default. Above only when below genuinely does not fit *and* above has more
  // room — a panel taller than either side is drawn below, where a reader is already looking, and
  // its own scroller takes the strain.
  const below = trigger.bottom + PANEL_GAP;
  const above = trigger.top - PANEL_GAP - panel.height;
  const belowFits = below + panel.height <= viewport.height - VIEWPORT_GUTTER;
  const roomAbove = trigger.top;
  const roomBelow = viewport.height - trigger.bottom;
  const flipY = !belowFits && roomAbove > roomBelow;
  const top = Math.max(VIEWPORT_GUTTER, flipY ? above : below);

  return { left, top, flipX, flipY };
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/components/Dropdown/place.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Mutate one branch and confirm a test catches it**

Change `const flipY = !belowFits && roomAbove > roomBelow;` to `const flipY = !belowFits;` and
re-run. Expected: the "stays below when neither side fits" test goes RED. Put the line back and
re-run to green. **If any mutation survives, the test is decorative — say so and fix it.**

- [ ] **Step 7: Commit**

```bash
git add src/components/Dropdown/types.ts src/components/Dropdown/place.ts src/components/Dropdown/place.test.ts
git commit -m "feat(dropdown): place a panel against the viewport

Pure arithmetic, separated from the hook because jsdom measures every
rectangle as zero and the numbers are the only part a test can reach.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: The placement hook

**Files:**
- Create: `src/components/Dropdown/usePopupPlacement.ts`
- Modify: `src/components/PopupListbox.tsx` (add a `style` prop to `PopupPanel`)

**Interfaces:**
- Consumes: `placeDropdown`, `Placement`, `PANEL_GAP`, `VIEWPORT_GUTTER` from Task 1.
- Produces:
  - `function usePopupPlacement(args: { triggerRef, frameRef, panelRef, open, align, onClose }): { placement: Placement | null; minWidth: number }`
  - `PopupPanel` accepts `style?: CSSProperties`.

- [ ] **Step 1: Add `style` to `PopupPanel`**

In `src/components/PopupListbox.tsx`, change the signature and pass it through:

```tsx
export function PopupPanel({
  className,
  style,
  children,
}: {
  className?: string;
  /**
   * Inline position, for a panel placed from measured numbers rather than from a Tailwind offset.
   *
   * Allowed by the shipped CSP — it carries `style-src-attr 'unsafe-inline'` beside its
   * `style-src 'self'`, which is why a measured panel is possible here at all and an injected
   * `<style>` element is not. `ContextMenu` places itself the same way.
   */
  style?: CSSProperties;
  children: ReactNode;
}) {
  const present = useIsPresent();
  return (
    <motion.div
      {...popup}
      style={style}
      aria-hidden={present ? undefined : true}
      className={cn(className, !present && "pointer-events-none")}
    >
      {children}
    </motion.div>
  );
}
```

Add `type CSSProperties` to the existing `import { type ReactNode } from "react"`.

- [ ] **Step 2: Write `usePopupPlacement.ts`**

```ts
import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { placeDropdown } from "./place";
import type { Placement } from "./types";

/**
 * Where the panel is, measured — and corrected for whatever containing block it landed in.
 *
 * ## Why there is a frame at all
 *
 * `position: fixed` is viewport-relative **only** while no ancestor carries a `transform`,
 * `scale`, `rotate`, `translate`, `filter`, `contain` or `backdrop-filter`. `Dialog`'s panel
 * animates through the `dialog` preset — `scale: 0.97 → 1` — and motion leaves the `scale`
 * longhand on the element at rest. **`scale: 1` is not `none`**, so a settled dialog panel is a
 * containing block, and eight of this app's dropdowns live inside one. `TheoryDiffDialog` and
 * `menu/panel.ts` each record the same trap for their own elements.
 *
 * The fix is not a walk up the ancestor chain looking for the seven properties above — that list
 * grows, and a property nobody thought of is a panel in the wrong place with nothing red. Instead
 * the shell renders a zero-size `fixed` element at `left: 0; top: 0` and reads **its** rect: that
 * is exactly where the containing block's origin sits in viewport coordinates, whatever put it
 * there. The panel is `absolute` inside that frame at `viewport position − frame origin`, so the
 * panel's own entry transform stops mattering too.
 *
 * The one case this does not cover is an ancestor mid-tween whose transform is not a pure
 * translation — a dialog at `scale: 0.97` on its way in. A dropdown cannot be open then: the
 * dialog's entry tween finishes before anything inside it can be pressed.
 *
 * ## What is measured with what
 *
 * **Positions come from `getBoundingClientRect()`; sizes come from `offsetWidth`/`offsetHeight`.**
 * Not interchangeable. `popup` holds the panel at `scale: 0.96` for the length of its entry tween,
 * so a rect taken on the mount frame is 4% short in both axes — the offset properties are the
 * layout box and no transform touches them.
 *
 * ## Two passes, and the first one is invisible
 *
 * `placement` is `null` on the render that mounts the panel, because the panel's own size cannot be
 * known before it exists. The shell draws it at `opacity: 0` on that frame — which `popup` already
 * does — and this hook fills the numbers in a **layout** effect, before the browser paints. A
 * `useEffect` here would paint one frame of panel in the top-left corner of its frame.
 *
 * ## Nothing here can go red
 *
 * jsdom measures every rectangle as zero and implements no layout, so every number this returns is
 * `0` under the suite and the whole of this file is exercised without being *tested*. The
 * arithmetic it calls is tested in `place.test.ts`; whether these measurements are the right ones
 * is a question only the shipped window answers. See the plan's live checks.
 */
export function usePopupPlacement({
  triggerRef,
  frameRef,
  panelRef,
  open,
  align,
  onClose,
}: {
  triggerRef: RefObject<HTMLElement | null>;
  /** The zero-size `fixed` element the panel is drawn inside. */
  frameRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  open: boolean;
  align: "start" | "end";
  /**
   * Called when an ancestor scrolls.
   *
   * **Closed rather than followed**, which is `ContextMenu`'s choice for its reason: a trigger
   * that scrolls out from under an open panel leaves an orphan, and a dropdown is open for about
   * two seconds. Following it would mean re-measuring on every scroll frame for a control nobody
   * scrolls while using.
   */
  onClose: () => void;
}): { placement: Placement | null; minWidth: number } {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [minWidth, setMinWidth] = useState(0);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    const frame = frameRef.current;
    const panel = panelRef.current;
    if (!trigger || !frame || !panel) return;

    const t = trigger.getBoundingClientRect();
    const origin = frame.getBoundingClientRect();
    const next = placeDropdown({
      trigger: { left: t.left, top: t.top, right: t.right, bottom: t.bottom },
      // Layout box, not rect — see this hook's doc comment.
      panel: { width: panel.offsetWidth, height: panel.offsetHeight },
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      align,
    });
    // Viewport coordinates, minus wherever the frame's own origin turned out to be.
    setPlacement({ ...next, left: next.left - origin.left, top: next.top - origin.top });
    // A picker never opens narrower than the control that produced it.
    setMinWidth(trigger.offsetWidth);
  }, [triggerRef, frameRef, panelRef, align]);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => measure();
    // Capture, so an inner scroller counts — the import previews and every dialog body scroll
    // without the window ever seeing it.
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, measure, onClose]);

  return { placement, minWidth };
}
```

- [ ] **Step 3: Run lint on the new file specifically**

Run: `npx eslint src/components/Dropdown/usePopupPlacement.ts src/components/PopupListbox.tsx --max-warnings 0`
Expected: clean.

**This step exists because of a known trap, and it is worth reading before you write the file.** This
repo's lint objects to `setState` inside an effect, and it only fires at `npm run verify` — which
nothing in this task runs. The `setPlacement` here is a **measurement**, not derived state: a panel's
size does not exist until the panel is mounted, so there is nothing to compute during render and the
rule's usual cure (derive it instead) has nothing to derive from.

If the rule fires anyway, do **not** reach for a suppression first. In order:

1. Guard the write — `setPlacement((prev) => (same(prev, next) ? prev : next))` — so the effect
   cannot re-enter. Often enough on its own.
2. Hold the numbers in a ref and expose them through `useSyncExternalStore`, which is what the rule
   is steering toward.
3. Only if neither works: a scoped `eslint-disable-next-line` **with the reason written out on the
   line above it**, naming what cannot be derived and why. A bare suppression is a defect in this
   repo; a suppression with its argument is a decision.

Report which of the three you used.

- [ ] **Step 4: Confirm nothing regressed**

Run: `npx vitest run src/components/AnchoredPopup.test.tsx src/features/decks/QuickAdd.test.tsx`
Expected: PASS. Both render `PopupPanel`; the new optional prop must not disturb them.

- [ ] **Step 5: Commit**

```bash
git add src/components/Dropdown/usePopupPlacement.ts src/components/PopupListbox.tsx
git commit -m "feat(dropdown): measure a panel through a zero-size fixed frame

position: fixed is not viewport-relative under a transformed ancestor,
and a settled Dialog panel sits at scale: 1, which is one. The frame's
own rect is where the containing block starts, whatever put it there.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The shell and `<Dropdown>`

The single-select component, without the search box (Task 4) and without multi-select (Task 5).

**Files:**
- Create: `src/components/Dropdown/Dropdown.tsx`
- Test: `src/components/Dropdown/Dropdown.test.tsx`

**Interfaces:**
- Consumes: `DropdownOption`, `DropdownSize` (Task 1); `usePopupPlacement` (Task 2);
  `PopupPanel` from `@/components/PopupListbox`; `FOCUS` from `@/lib/focus`; `LAYER` from
  `@/lib/layers`; `FILTER_UNAVAILABLE` from `@/components/FilterChips`; `useTooltip` from
  `@/components/tooltip/useTooltip`; `useDismissOnEscape` from `@/lib/useDismissOnEscape`;
  `PRESS` from `@/lib/motion`; `cn` from `@/lib/utils`; `Check` and `ChevronDown` from
  `lucide-react`; `AnimatePresence` from `motion/react`.
- Produces:

**`SharedProps` is declared once, here, in full.** Task 4 implements the search half and Task 8
implements `onOpen`; nothing re-declares the type.

```ts
type SharedProps = {
  options: readonly DropdownOption[];
  size?: DropdownSize;              // default "md"
  align?: "start" | "end";          // default "start"
  fill?: boolean;                   // stretch to the container, chevron to the far edge
  active?: boolean;                 // gold border and text — "this is not where the control opens"
  disabled?: boolean;
  id?: string;                      // the trigger's id, so a visible <label htmlFor> still presses it
  label?: string;                   // aria-label, when there is no visible label
  labelledBy?: string;              // id of the visible <label> — see the naming rule below
  className?: string;               // on the trigger
  panelClassName?: string;          // on the panel
  // Implemented in Task 4:
  searchable?: boolean;
  searchPlaceholder?: string;       // default "Search"
  query?: string;                   // controlled: the caller filters
  onQueryChange?: (query: string) => void;
  emptyLine?: string;               // default "No matches."
  footer?: ReactNode;
  onReachEnd?: () => void;
  // Implemented in Task 8:
  onOpen?: () => void;
};
```

```ts
function Dropdown(props: SharedProps & {
  value: string;
  onChange: (value: string) => void;
  /** Trigger text when `value` matches no option. Defaults to an em dash. */
  placeholder?: string;
}): JSX.Element;
```

**The naming rule, and it is not the one a `<select>` used.** A native `<select>` is *labelable*:
`<label htmlFor="deck-view">View</label>` names it, and a screen reader says "View, combobox,
Table". A `<button>` is labelable too — the label still presses it — **but a native `<label>` is
not in a button's accessible-name computation**, so the same markup would announce "Table, button"
and never say which field it is. The name has to come from `aria-labelledby`.

So a call site with a visible label passes **both**:

```tsx
<label id="deck-view-label" htmlFor="deck-view" className="text-[0.6875rem] text-dim">
  View
</label>
<Dropdown id="deck-view" labelledBy="deck-view-label" … />
```

`id` keeps the pointer behaviour (clicking the label opens the dropdown); `labelledBy` is what makes
the name "View" while the *content* stays the value. That split is `SetCombobox`'s, stated on its
own `labelId`: the button's content is the value, so its name has to come from somewhere else or
assistive tech announces the value twice and the field never.

**This changes how tests find these controls.** `getByLabelText("View")` becomes
`getByRole("button", { name: "View" })`, which is exactly what `pickOption(user, "View", "Table")`
does — so the 72 rewrites need no extra thought, but a test that reached for a control any other way
does.

- [ ] **Step 1: Write the failing tests**

Create `src/components/Dropdown/Dropdown.test.tsx`:

```tsx
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Dropdown } from "./Dropdown";
import type { DropdownOption } from "./types";

const FORMATS: DropdownOption[] = [
  { value: "commander", label: "Commander" },
  { value: "modern", label: "Modern" },
  { value: "pauper", label: "Pauper", disabled: true },
  { value: "standard", label: "Standard" },
];

function Harness({ initial = "modern" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <Dropdown label="Format" value={value} onChange={setValue} options={FORMATS} />;
}

describe("Dropdown", () => {
  it("draws the picked option's label on the trigger", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Modern");
  });

  it("draws the placeholder when the value matches no option", () => {
    // The native select's worst habit, and the reason FilterBar carries a seeded-key guard:
    // a <select> whose value matches nothing silently reports its FIRST row. This draws a
    // placeholder instead, so the control cannot claim a filter it is not applying.
    render(
      <Dropdown
        label="Format"
        value="alchemy"
        onChange={vi.fn()}
        options={FORMATS}
        placeholder="Pick a format"
      />,
    );
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Pick a format");
  });

  it("opens a listbox on click and closes it on a pick", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Commander" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Commander");
  });

  it("marks the picked row aria-selected and nothing else", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.getByRole("option", { name: "Modern" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Commander" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("opens on ArrowDown from the closed trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // Clicked, not focused programmatically: starting a keyboard flow with el.focus() tests a
    // caret no reader can produce.
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("walks with the arrow keys and skips a disabled row", async () => {
    const user = userEvent.setup();
    render(<Harness initial="commander" />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    const listbox = screen.getByRole("listbox");
    // Opens on the picked row: Commander, index 0. The listbox is what holds the caret on a
    // dropdown with no search box, so it is what carries aria-activedescendant.
    expect(listbox).toHaveAttribute("aria-activedescendant", expect.stringContaining("option-0"));
    await user.keyboard("{ArrowDown}"); // Modern
    await user.keyboard("{ArrowDown}"); // skips Pauper (disabled) -> Standard
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Standard");
  });

  it("refuses a disabled row to the pointer as well as to Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Dropdown label="Format" value="modern" onChange={onChange} options={FORMATS} />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.click(screen.getByRole("option", { name: "Pauper" }));
    expect(onChange).not.toHaveBeenCalled();
    // A list that refuses the click and takes the keystroke is a list with two rules.
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("hands the caret back to the trigger on Escape", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Format" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    // An element that unmounts with focus on it drops the caret to <body>, and the next Tab
    // restarts from the top of the app.
    expect(trigger).toHaveFocus();
  });

  it("reports aria-expanded on the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Format" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("jumps to a row by type-ahead from the closed trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.keyboard("{Escape}");
    await user.keyboard("s");
    expect(screen.getByRole("listbox")).toHaveAttribute(
      "aria-activedescendant",
      expect.stringContaining("option-3"), // Standard
    );
  });

  it("draws an option's icon and hint beside its label", async () => {
    const user = userEvent.setup();
    render(
      <Dropdown
        label="Set"
        value="lea"
        onChange={vi.fn()}
        options={[{ value: "lea", label: "Limited Edition Alpha", hint: "LEA" }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Set" }));
    // The name is the row's own content — label and hint both, and no aria-label replacing them.
    expect(screen.getByRole("option", { name: /Limited Edition Alpha/ })).toHaveTextContent("LEA");
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/components/Dropdown/Dropdown.test.tsx`
Expected: FAIL — `Failed to resolve import "./Dropdown"`.

- [ ] **Step 3: Write `Dropdown.tsx`**

The shell. Key requirements, each of which one of the tests above pins:

- The trigger is a `<button type="button">` with `aria-haspopup="listbox"`, `aria-expanded`, and its
  name from `label` (as `aria-label`) or `labelledBy`. Its **content** is the picked option's
  `label`, or `placeholder` (default `"—"`) when `value` matches nothing.
- Size recipes, written out whole because Tailwind scans source text:
  - `md`: `"h-9 rounded-md border px-2.5 text-sm"`
  - `sm`: `"h-8 rounded-md border px-2 text-xs"`
  - plus `PRESS` from `@/lib/motion` and `disabled:active:scale-100`, and `FOCUS`.
  - `active ? "border-accent text-accent" : "border-border text-dim hover:text-text"`.
  - `fill && "flex w-full justify-between"`, otherwise `inline-flex items-center gap-1.5`.
- A `<ChevronDown className="size-3.5" aria-hidden="true" />` at the end.
- The panel is drawn inside `<AnimatePresence>` only while `open`, as:

```tsx
<div ref={frameRef} className={cn("fixed left-0 top-0 size-0", LAYER.popup)}>
  <PopupPanel
    key="panel"
    style={{ left: placement?.left ?? 0, top: placement?.top ?? 0, minWidth }}
    className={cn(
      "absolute rounded-md border border-border bg-surface p-2 shadow-lg",
      // The corner it is pinned by is the corner it grows from — this app's standing rule for an
      // anchored popup. All four spellings written out whole: Tailwind scans source text, so a
      // class built by interpolation emits no rule at all.
      placement?.flipY
        ? placement.flipX
          ? "origin-bottom-right"
          : "origin-bottom-left"
        : placement?.flipX
          ? "origin-top-right"
          : "origin-top-left",
      // Invisible until measured. `placement` is null for exactly one frame — the one that mounts
      // the panel, before its own size exists — and `popup` already has it at opacity 0 there, so
      // this is belt and braces rather than the only guard.
      placement === null && "invisible",
      panelClassName,
    )}
  >
```

- **The `<ul role="listbox" tabIndex={-1}>` is what takes the caret on open**, and it is therefore
  what carries `aria-activedescendant`. That attribute belongs on the **focused** element, so a
  panel that took focus while the listbox advertised the active row would be pointing from the
  wrong element — the caret's owner is the only place a screen reader reads it from. When the
  dropdown is `searchable` (Task 4) the search box takes the caret instead and carries the
  attribute, and the listbox carries neither: exactly `SetCombobox`'s shape today.
  Also `max-h-64 overflow-auto`. Rows are `<li role="option" aria-selected id={optionId(id, i)}>`,
  with the id built at module scope so the scroll effect can depend on it without re-running every
  render:

```ts
const optionId = (id: string, index: number) => `${id}-option-${index}`;
```

  Rows are never focused.
- Rows call `onMouseDown={(e) => e.preventDefault()}` so a pointer never steals the caret.
- Row classes: `"flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"` plus
  `"transition-colors duration-150 motion-reduce:transition-none"`, then
  `option.disabled ? FILTER_UNAVAILABLE : "cursor-pointer"`, then `active && "bg-bg"`.
  On a `sm` dropdown the row is `text-xs`.
- Row body: `{icon}`, `<span className="min-w-0 flex-1 truncate">{label}</span>`,
  `{hint && <span className="shrink-0 font-mono text-xs text-dim">{hint}</span>}`, and — on
  `<Dropdown>` — a `w-3.5 shrink-0` slot holding a `<Check>` when picked, so a pick does not
  shuffle the column.
- The keyboard, on whichever element holds the caret (the listbox here, the search box in Task 4):
  ArrowDown/ArrowUp move to the next/previous **enabled** row, wrapping at neither end;
  Home/End go to the first/last enabled row; Enter picks the active row and closes; Escape
  dismisses through `useDismissOnEscape({ layer: "inner", enabled: open })` and returns focus to
  the trigger. On the **closed trigger**: ArrowDown opens, and any single printable character
  opens and jumps (Task 4 shares the matcher).
- **Opening sets the active index to the picked row, or 0.** On `<MultiDropdown>` (Task 5) "the
  picked row" is the **first** `selected` value that is in the drawn list — several may be picked,
  and the first is where a reader's eye starts. Falls back to 0 when none of them is drawn, which is
  the set picker's normal state once a query has narrowed the list past the ticked sets.
- Dismissal: a `window` `mousedown` outside the root closes without moving focus (the reader is
  already somewhere else); `onBlur` on the root closes when focus leaves it.
- `onReachEnd` is called when ArrowDown is pressed on the last row or End is pressed twice — it is
  a no-op prop here and is consumed by `<MultiDropdown>` in Task 5. Add the prop and the call now
  so the keyboard has one implementation.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/components/Dropdown/Dropdown.test.tsx`
Expected: PASS, 11 tests.

- [ ] **Step 5: Mutate three behaviours and confirm the tests catch each**

1. Delete the `option.disabled` guard in the row's `onClick`. Expected: "refuses a disabled row"
   goes RED.
2. Remove `buttonRef.current?.focus()` from `dismiss`. Expected: "hands the caret back" goes RED.
3. Change the trigger's fallback from `placeholder` to `options[0].label`. Expected: "draws the
   placeholder" goes RED.

Put each back and re-run to green. **Report any mutation that survives** — that test is decorative.

- [ ] **Step 6: Commit**

```bash
git add src/components/Dropdown/Dropdown.tsx src/components/Dropdown/Dropdown.test.tsx
git commit -m "feat(dropdown): the shell, and a single-select over it

A disclosure button, a measured panel, rows walked by
aria-activedescendant, and a placeholder where a native select would
have silently reported its first row.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: The search box

**Files:**
- Modify: `src/components/Dropdown/Dropdown.tsx`
- Test: `src/components/Dropdown/Dropdown.test.tsx`

**Interfaces:**
- Consumes: Task 3's shell and the `SharedProps` it declared in full.
- Produces: no new type. This task **implements** the fields Task 3 declared under
  "Implemented in Task 4" — `searchable`, `searchPlaceholder`, `query`, `onQueryChange`,
  `emptyLine`, `footer`, `onReachEnd`.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/Dropdown/Dropdown.test.tsx`:

```tsx
describe("Dropdown search", () => {
  it("has no search box unless asked for one", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("filters by label substring, case-insensitively, when uncontrolled", async () => {
    const user = userEvent.setup();
    render(
      <Dropdown label="Format" value="modern" onChange={vi.fn()} options={FORMATS} searchable />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.type(screen.getByRole("combobox"), "an");
    // Commander and Standard; Modern and Pauper are gone.
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Commander",
      "Standard",
    ]);
  });

  it("filters nothing when the caller controls the query", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    render(
      <Dropdown
        label="Format"
        value="modern"
        onChange={vi.fn()}
        options={FORMATS}
        searchable
        query="zzz"
        onQueryChange={onQueryChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    // A controlled caller has already filtered; the shell must not filter a second time or the
    // set picker's rank ordering would be silently re-cut by a substring test.
    expect(screen.getAllByRole("option")).toHaveLength(4);
    await user.type(screen.getByRole("combobox"), "x");
    expect(onQueryChange).toHaveBeenCalledWith("zzzx");
  });

  it("says so when nothing matches", async () => {
    const user = userEvent.setup();
    render(
      <Dropdown
        label="Format"
        value="modern"
        onChange={vi.fn()}
        options={FORMATS}
        searchable
        emptyLine="No formats match that."
      />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.type(screen.getByRole("combobox"), "zzz");
    expect(screen.getByText("No formats match that.")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("keeps the caret in the search box while the pointer picks", async () => {
    const user = userEvent.setup();
    render(
      <Dropdown label="Format" value="" onChange={vi.fn()} options={FORMATS} searchable />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    const box = screen.getByRole("combobox");
    expect(box).toHaveFocus();
    await user.click(screen.getByRole("option", { name: "Pauper" })); // disabled: no close
    expect(box).toHaveFocus();
  });

  it("calls onReachEnd when ArrowDown is pressed on the last row", async () => {
    const user = userEvent.setup();
    const onReachEnd = vi.fn();
    render(
      <Dropdown
        label="Format"
        value="standard"
        onChange={vi.fn()}
        options={FORMATS}
        onReachEnd={onReachEnd}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.keyboard("{ArrowDown}");
    expect(onReachEnd).toHaveBeenCalled();
  });

  it("draws a footer below the list", async () => {
    const user = userEvent.setup();
    render(
      <Dropdown
        label="Format"
        value="modern"
        onChange={vi.fn()}
        options={FORMATS}
        footer={<p>Showing 4 of 40.</p>}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.getByText("Showing 4 of 40.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/components/Dropdown/Dropdown.test.tsx -t "Dropdown search"`
Expected: FAIL — 7 failures.

- [ ] **Step 3: Implement**

- `searchable` renders an `<input type="text" role="combobox">` above the list, taking the caret on
  open instead of the panel. `aria-expanded="true"`, `aria-controls={listboxId}`,
  `aria-activedescendant` moves onto it. Classes:
  `"mb-2 h-8 w-full rounded-md border border-border bg-bg px-2 text-sm placeholder:text-dim focus:border-accent focus:outline-none"`.
  Placeholder is `searchPlaceholder ?? "Search"`.
- **Controlled vs uncontrolled.** `const controlled = query !== undefined`. When controlled, the
  shell renders `options` verbatim; when not, it renders
  `options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()))`. **Write the
  reason at the site**: a caller that supplies a query has already filtered with its own idea of a
  match — the set picker's is name-contains, code-prefix and a three-level rank — and a second
  substring test here would silently re-cut it.
- `emptyLine` (default `"No matches."`) is drawn as
  `<li role="presentation" className="px-2 py-3 text-center text-xs text-dim">` when the drawn list
  is empty. **`role="presentation"`, because a bare `<li>` in a listbox is a `listitem` where only
  options are allowed.**
- `footer` is rendered after the `<ul>`.
- A new query resets the active index to 0.
- Type-ahead on the closed trigger uses the same matcher (`label.toLowerCase().startsWith(buffer)`),
  with a 600ms buffer. On a `searchable` dropdown the character opens it and lands in the search box
  instead — same gesture, same place.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/components/Dropdown/Dropdown.test.tsx`
Expected: PASS, 18 tests.

- [ ] **Step 5: Mutate and confirm**

Delete the `controlled` branch so the shell always filters. Expected: "filters nothing when the
caller controls the query" goes RED. Restore and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/components/Dropdown/Dropdown.tsx src/components/Dropdown/Dropdown.test.tsx
git commit -m "feat(dropdown): an optional search box, controlled or not

Uncontrolled it matches a label substring, which is all 23 selects
need. Controlled it filters nothing, so a caller with its own idea of a
match is not silently re-cut by a second one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `<MultiDropdown>` and the stories

**Files:**
- Modify: `src/components/Dropdown/Dropdown.tsx`
- Test: `src/components/Dropdown/Dropdown.test.tsx`
- Create: `src/components/Dropdown/Dropdown.stories.tsx`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces:

```ts
function MultiDropdown(props: SharedProps & {
  selected: readonly string[];
  onToggle: (value: string) => void;
  /** What the trigger says — "Any set", "2 sets". A count, never a value. */
  triggerLabel: string;
}): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

Widen the file's existing import to `import { Dropdown, MultiDropdown } from "./Dropdown";`, then
append:

```tsx
describe("MultiDropdown", () => {
  function MultiHarness() {
    const [picked, setPicked] = useState<string[]>(["modern"]);
    return (
      <MultiDropdown
        label="Format"
        triggerLabel={picked.length === 0 ? "Any format" : `${picked.length} formats`}
        selected={picked}
        onToggle={(v) =>
          setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]))
        }
        options={FORMATS}
      />
    );
  }

  it("says a count on the trigger, not a value", async () => {
    const user = userEvent.setup();
    render(<MultiHarness />);
    const trigger = screen.getByRole("button", { name: "Format" });
    expect(trigger).toHaveTextContent("1 formats");
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Commander" }));
    expect(trigger).toHaveTextContent("2 formats");
  });

  it("stays open across several picks", async () => {
    const user = userEvent.setup();
    render(<MultiHarness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.click(screen.getByRole("option", { name: "Commander" }));
    // The whole purpose of a multi-select is picking several in a row.
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Standard" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("marks the listbox multiselectable and every picked row selected", async () => {
    const user = userEvent.setup();
    render(<MultiHarness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-multiselectable", "true");
    expect(screen.getByRole("option", { name: "Modern" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("toggles the active row on Enter without closing", async () => {
    const user = userEvent.setup();
    render(<MultiHarness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.keyboard("{Enter}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Any format");
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/components/Dropdown/Dropdown.test.tsx -t MultiDropdown`
Expected: FAIL, 4 failures.

- [ ] **Step 3: Implement**

`<MultiDropdown>` renders the same shell with `multi` set: the listbox takes
`aria-multiselectable="true"`, `aria-selected` reads `selected.includes(value)`, Enter and a click
call `onToggle` and **do not close**, and the trigger draws `triggerLabel`.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/components/Dropdown/Dropdown.test.tsx`
Expected: PASS, 22 tests.

- [ ] **Step 5: Write the stories**

Create `src/components/Dropdown/Dropdown.stories.tsx`, titled `Primitives/Dropdown` — the
namespaces in this repo are `Primitives` / `Chrome` / `Cards` / a feature area, and there is no
`Components` one. Follow the house conventions:
`import type { Meta, StoryObj } from "@storybook/react-vite"` and
`import { expect, fn, userEvent, within } from "storybook/test"`. A controlled component needs a
stateful wrapper (see `FilterChips.stories.tsx`, which explains why: rendered against a fixed value
the control reports its click and then visibly does not move — a story of a control that does not
work).

Stories, one per state that changes behaviour and no redundant ones:

1. `Default` — a closed `md` single-select.
2. `Open` — with a play function that clicks the trigger and asserts the listbox.
3. `Small` — `size="sm"`, so the two densities are readable side by side.
4. `Searchable` — with a play function that types and asserts the list narrowed.
5. `WithDisabledRows` — greyed rows, with a play asserting a click on one reports nothing.
6. `Multi` — `<MultiDropdown>` with a play picking two rows and asserting the panel stayed open.
7. `RichRows` — icon and hint, the set picker's shape.
8. `Fill` — `fill` inside a narrow container, so the chevron-to-the-far-edge case has a home.

- [ ] **Step 6: Run the story tests**

Run: `npx vitest run src/stories.test.tsx -t Dropdown`
Expected: PASS. **If the filter selects zero tests, that is not a pass** — report the selected
count, because a `cargo test`-style filter matching nothing exits 0 and reads as green.

- [ ] **Step 7: Commit**

```bash
git add src/components/Dropdown/
git commit -m "feat(dropdown): multi-select, and the workbench

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: The test helper

**Files:**
- Create: `src/test-dropdown.ts`
- Test: exercised by every later task; no test file of its own.

**Interfaces:**
- Consumes: nothing from earlier tasks (it drives the DOM).
- Produces:
  - `async function openDropdown(user: UserEvent, name: string | RegExp): Promise<HTMLElement>`
  - `async function pickOption(user: UserEvent, name: string | RegExp, option: string | RegExp): Promise<void>`
  - `async function searchDropdown(user: UserEvent, name: string | RegExp, text: string): Promise<void>`

- [ ] **Step 1: Write it**

```ts
import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/**
 * Drive a `Dropdown` from a test, the way `test-drag.ts` drives a drag.
 *
 * **Why a helper and not 72 hand-written pairs of clicks.** These replaced 72
 * `userEvent.selectOptions` calls across 25 files when the app's native `<select>`s became one
 * component. Written out at each site, the component's internals would be pinned in 72 places and
 * the next change to them would be a 25-file sweep; here it is one edit.
 *
 * **A dropdown's trigger is a `button`, not a `combobox`.** The combobox is the search box the
 * trigger reveals, and only a `searchable` one has it. `getByRole("combobox")` therefore finds
 * nothing on most of these, which is the first thing a reader converting an old test trips over.
 */

/** Open a dropdown by its accessible name and return its trigger. */
export async function openDropdown(user: UserEvent, name: string | RegExp): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name });
  await user.click(trigger);
  // The listbox is mounted inside an AnimatePresence, so it exists on the same tick the click
  // flushes — no findBy needed, and a findBy here would hide a genuinely missing panel behind a
  // timeout.
  await screen.findByRole("listbox");
  return trigger;
}

/**
 * Open a dropdown and pick one row.
 *
 * The direct replacement for `userEvent.selectOptions(select, "value")` — but note the second
 * argument is what the reader **sees**, not the underlying value. A test that pinned a value now
 * pins a label, which is the honest thing for a control whose rows are text.
 *
 * **A greyed row's accessible name is still its own text**, so a `getByRole("option", { name })`
 * finds a disabled row and the click is simply refused. Assert on `aria-disabled` when that is
 * what the test is about.
 */
export async function pickOption(
  user: UserEvent,
  name: string | RegExp,
  option: string | RegExp,
): Promise<void> {
  await openDropdown(user, name);
  await user.click(screen.getByRole("option", { name: option }));
}

/** Open a searchable dropdown and type into its search box. */
export async function searchDropdown(
  user: UserEvent,
  name: string | RegExp,
  text: string,
): Promise<void> {
  await openDropdown(user, name);
  await user.type(screen.getByRole("combobox"), text);
}
```

- [ ] **Step 2: Prove it against the shell's own stories**

Add `import { pickOption } from "@/test-dropdown";` to `src/components/Dropdown/Dropdown.test.tsx`
and one test that uses it end to end — the helper is what 25 other files will trust, so it is worth
one test against the component it drives:

```tsx
it("is driveable through the test helper", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await pickOption(user, "Format", "Commander");
  expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Commander");
});
```

- [ ] **Step 3: Run**

Run: `npx vitest run src/components/Dropdown/Dropdown.test.tsx`
Expected: PASS, 23 tests.

- [ ] **Step 4: Commit**

```bash
git add src/test-dropdown.ts src/components/Dropdown/Dropdown.test.tsx
git commit -m "test: one helper for driving a dropdown

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Prove the placement in the shipped window

**Before 23 files depend on it.** This task writes no product code — its deliverable is a set of
readings and a go/no-go.

**Files:**
- Create: `src/components/Dropdown/PlacementProbe.stories.tsx` (a story that puts a dropdown in each
  hostile position — inside a scroller, inside a transformed box, at the bottom of the viewport)
- Modify: `docs/reference/frontend-design.md` (the readings)

- [ ] **Step 1: Write the probe story**

Three stories, each putting a `<Dropdown>` in one of the three containers this component's placement
has to survive. They are a probe rather than a catalogue entry — the panel is a *layout* fact and
`Dropdown.stories.tsx` is where its *appearance* lives.

```tsx
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Dropdown } from "./Dropdown";
import type { DropdownOption } from "./types";

const SETS: DropdownOption[] = Array.from({ length: 8 }, (_, i) => ({
  value: `s${i}`,
  label: `Set number ${i + 1}`,
}));

function Probe() {
  const [value, setValue] = useState("s0");
  return <Dropdown label="Set" value={value} onChange={setValue} options={SETS} />;
}

const meta = {
  // Titles in this repo are one of Primitives / Chrome / Cards / a feature area - never
  // "Components". Grep an existing stories file before inventing a namespace.
  title: "Primitives/Dropdown/PlacementProbe",
  component: Probe,
} satisfies Meta<typeof Probe>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The import previews' shape: a control inside a scroller a native list escaped and an
 *  absolutely-positioned panel would not. */
export const InAScroller: Story = {
  render: () => (
    <div className="h-40 overflow-y-auto border border-border p-3">
      {Array.from({ length: 20 }, (_, i) => (
        <p key={i} className="text-sm text-dim">
          Filler line {i + 1}
        </p>
      ))}
      <Probe />
      {Array.from({ length: 20 }, (_, i) => (
        <p key={i} className="text-sm text-dim">
          Filler line {i + 21}
        </p>
      ))}
    </div>
  ),
};

/** Exactly what a settled `Dialog` panel is: motion leaves the `scale` longhand at rest, and
 *  `scale: 1` is not `none`, so this box is a containing block for a `fixed` descendant. */
export const InATransformedBox: Story = {
  render: () => (
    <div style={{ scale: 1 }} className="border border-border p-6">
      <Probe />
    </div>
  ),
};

/** No room below — the flip. */
export const AtTheBottom: Story = {
  render: () => (
    <div className="flex h-screen items-end">
      <Probe />
    </div>
  ),
};
```

- [ ] **Step 2: Take the app lock and run Storybook**

Read `.claude/skills/running-the-app/SKILL.md` first. **Only one Storybook runs across every
worktree**, and a second one silently leaves the MCP server answering from the first agent's
stories. Claim the lock through `.claude/skills/running-the-app/lock.ps1`. A `FREE` reading does not
prove no app is running — check for a stray `node` on 6006 before believing it.

- [ ] **Step 3: Measure**

For each of the three stories, open the dropdown and record, in one evaluation each:

```js
(() => {
  const t = document.querySelector('[aria-haspopup="listbox"]').getBoundingClientRect();
  const p = document.querySelector('[role="listbox"]').closest('.absolute').getBoundingClientRect();
  return {
    href: location.href,          // DevTools steals the first `type: page` target — prove which
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    trigger: { l: t.left, t: t.top, b: t.bottom },
    panel: { l: p.left, t: p.top, b: p.bottom, w: p.width },
    gapFromTrigger: p.top - t.bottom,
  };
})();
```

Wrap it in an IIFE — `cdp.mjs eval` shares one scope, so a top-level `const` outlives its command
and the next call fails with "already been declared".

**Expected:** `panel.l` within 1px of `trigger.l`; `gapFromTrigger` of 4 below or −4 above; `panel.b`
inside `innerHeight`; and in `InAScroller`, `panel.b` **greater** than the scroller's own bottom —
that is the whole point, the panel escaping its container.

- [ ] **Step 4: Decide**

If `InATransformedBox` puts the panel at the wrong offset, the frame correction is wrong and
**Tasks 8–14 do not start**. Report the numbers and stop. If all three land, write the readings into
`docs/reference/frontend-design.md` under a new "The dropdown's panel" heading, with the date and the
build (`storybook dev`, debug).

- [ ] **Step 5: Release the lock and commit**

```bash
git add src/components/Dropdown/PlacementProbe.stories.tsx docs/reference/frontend-design.md
git commit -m "test(dropdown): probe the panel in the three hostile containers

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Rebuild `SetCombobox` on `<MultiDropdown>`

The riskiest migration, and it goes first because it is the one with a fence: its existing test file
and stories describe behaviour nobody wants to lose.

**Files:**
- Modify: `src/features/search/SetCombobox.tsx`
- Test: `src/features/search/SetCombobox.test.tsx` (expected to change as little as possible)
- Modify: `src/features/search/SetCombobox.stories.tsx`
- Modify: `src/components/Dropdown/Dropdown.tsx` — implement `onOpen`, which Task 3 declared

**Interfaces:**
- Consumes: `<MultiDropdown>` (Task 5).
- Produces: `SetCombobox`'s **public props are unchanged** — `selected`, `onToggle`, `counts`,
  `options`, `align`, `fill`. Four call sites depend on them and none of them is touched.

- [ ] **Step 1: Run the existing suite and record the baseline**

Run: `npx vitest run src/features/search/SetCombobox.test.tsx > /tmp/setcombobox-before.txt 2>&1`
then `grep -E "Tests|Test Files" /tmp/setcombobox-before.txt`.
**Redirect and grep — do not pipe to `tail`**: a pipe reports the pipe's exit code, so a failing run
reads as 0.

- [ ] **Step 2: Rewrite the component**

What stays in `SetCombobox.tsx`, unchanged in behaviour:

- `MAX_OPTIONS = 100`, `MORE_STEP = 50`, `MAX_SETS = 64`, `rank()`.
- The `useQuery(["sets"])` with `enabled: options === undefined` and its
  `staleTime: (q) => (q.state.data?.length ? Infinity : 0)`.
- `matches`: the `cardCount > 0` filter, the needle test, and the `sortOptions` call with its three
  grouping levels — `pinned`, then `optionDisabled`, then `rank`.
- `page`, `moreCount`, `revealMore`.
- The `pinned` snapshot and `startOpening()`.
- `emptyLine`'s three-way answer, `full`, and `canToggle`.
- `label` — `"Any set"` / `"N sets"`.

What is **deleted** and comes from the shell instead: `open`, `active`, `activeIndex`, the refs, the
`useId` plumbing, `onListKeyDown`, the `useDismissOnEscape` call, the `window` mousedown effect, the
`scrollIntoView` effect, the `onBlur`, the trigger's markup, the `PopupPanel`, the `<input>`, the
`<ul>`, and the whole `Option` component.

The new body ends roughly:

```tsx
const dropdownOptions = page.map((s) => ({
  value: s.code,
  label: s.name,
  hint: s.code.toUpperCase(),
  // keyrune covers 441 of ~1 050 sets and its own `.ss` rule draws a generic symbol for the rest,
  // so every row has a glyph and the code rides along as text for the ones where that glyph is not
  // the set's own.
  icon: <i className={cn(setGlyphClass(s.code), "w-4 shrink-0 text-center")} aria-hidden="true" />,
  // One predicate for both the mouse and the Enter key: a list that refuses the click and takes
  // the keystroke is a list with two rules. The cap and a facet zero look the same because they
  // mean the same.
  disabled: !canToggle(s.code),
  title: facetTitle(s.name, counts?.[s.code]),
}));

return (
  <MultiDropdown
    label="Set"
    triggerLabel={label}
    selected={selected}
    onToggle={onToggle}
    options={dropdownOptions}
    align={align}
    fill={fill}
    active={selected.length > 0}
    searchable
    searchPlaceholder="Name or code"
    query={query}
    onQueryChange={(next) => {
      setQuery(next);
      // A new query is a new list, and neither the old cursor position nor how far the reader had
      // paged into the old one means anything in it.
      setShown(MAX_OPTIONS);
    }}
    emptyLine={emptyLine}
    onReachEnd={revealMore}
    onOpen={startOpening}
    panelClassName="w-72"
    footer={footer}
  />
);
```

`onOpen` was declared on `SharedProps` in Task 3 and is **implemented here**, called on every
opening. It is what `startOpening` needs and there is no other way for a caller to hook one: the
shell owns `open`, and an effect on it would take the `pinned` snapshot one commit after the first
render of the list it is meant to order.

`footer` is the two existing blocks, unchanged:

```tsx
const footer = (
  <>
    {full && (
      <p className="pt-2 text-center text-[0.7rem] text-dim">
        {MAX_SETS} sets is the most one search can name — remove one to add another.
      </p>
    )}
    {moreCount > 0 && (
      <div className="pt-2 text-center text-[0.7rem] text-dim">
        <p>Showing {page.length} of {matches.length} — keep typing to narrow it down.</p>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={revealMore}
          className={cn(
            FOCUS,
            "mt-1 rounded-md px-1.5 py-0.5 underline underline-offset-2",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
          )}
        >
          Show {moreCount} more
        </button>
      </div>
    )}
  </>
);
```

- [ ] **Step 3: Run the suite and read every failure as a signal**

Run: `npx vitest run src/features/search/SetCombobox.test.tsx > /tmp/setcombobox-after.txt 2>&1`
then `diff /tmp/setcombobox-before.txt /tmp/setcombobox-after.txt`.

**Every failure is either a test that pinned an internal (fix the test, and say which) or a
behaviour the rewrite lost (fix the component).** Write down which each one was — that list is the
whole value of doing this component first.

- [ ] **Step 4: Run the four call sites' suites**

Run:
`npx vitest run src/features/search/FilterBar.test.tsx src/features/collection/CollectionFilterBar.test.tsx src/features/card/AllPrintingsDialog.test.tsx src/features/card/PrintingsFilterBar.test.tsx`
Expected: PASS. Two of them mock `SetCombobox` entirely; the other two drive the real one.

- [ ] **Step 5: Commit**

```bash
git add src/features/search/SetCombobox.tsx src/features/search/SetCombobox.test.tsx src/features/search/SetCombobox.stories.tsx src/components/Dropdown/Dropdown.tsx
git commit -m "refactor(search): the set picker is a MultiDropdown

Keeps everything about sets - the page cap, MAX_SETS, the keyrune glyph,
the facet greying, the pinned snapshot - and gives up its popup,
keyboard walk, ARIA and dismissal to the shell.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tasks 9–14: The six migration buckets

**These six run in parallel.** Each owns files no sibling touches. Dispatch them in one message.

**Rules every bucket follows.** Repeat these into each subagent's brief — a subagent sees only its
own task.

1. **Do not commit.** Parallel agents in one worktree share the git index, so a bare `git commit`
   takes whatever a sibling staged. Report what you changed; the controller commits.
2. **Do not run `npm run verify`** — it is too slow to pay for six times and your slice compiles
   against a tree your siblings are still changing. Run only the named test files.
3. **The transformation.** For each `<select>`:
   - Build a `readonly DropdownOption[]` immediately above the JSX, keeping the existing
     `sortOptions` call and its comment exactly where it is. `label` is what the `<option>` body
     drew; `value` is what it carried. **Number values become `String(n)` at the boundary and are
     parsed back in `onChange`, exactly as they already are.**
   - `<select className={cn(FILTER_CONTROL, FILTER_FOCUS, …)}>` becomes
     `<Dropdown size="md" … />`; a `h-8` one becomes `size="sm"`.
   - `value` / `onChange={(e) => f(e.target.value)}` becomes `value` / `onChange={f}` — the shell
     hands over the string, not an event.
   - **A visible `<label>` needs two things now, not one.** Give the label an `id` and pass
     `labelledBy` as well as `id` — see the naming rule in Task 3. A native `<label>` is not in a
     `<button>`'''s accessible-name computation, so `htmlFor` alone leaves the control announcing
     its *value* and never its name. A select that had only an `aria-label` passes `label` and
     needs nothing else.
   - A select drawn gold when a filter is on passes `active={…}` rather than a className.
   - **Move every existing comment with the code it explains.** These files carry the reasoning for
     decisions that were expensive to reach; a comment left behind on a deleted line is the finding
     lost.
4. **Search is off unless the list can exceed about a dozen rows.** Formats (~30) and the deck's
   category and folder pickers get `searchable`; a three-row Finish picker does not.
5. **Rewrite your bucket's `selectOptions` calls** with `pickOption` from `@/test-dropdown`.
6. **Mutate one behaviour per file you touched and confirm a test catches it.** Say so if one
   survives — a test that cannot fail is worse than no test, and this sweep has found real defects
   in just-written code before.
7. **Report**: files changed, controls converted, tests rewritten, mutations that survived.

### Task 9: Search

**Files:**
- Modify: `src/features/search/FilterBar.tsx` — 2 controls: **Sort results** and **Format**
- Test: `src/features/search/FilterBar.test.tsx` (3 calls), `src/features/search/SearchPage.test.tsx`
  (4), `src/features/search/SearchPage.stories.tsx` (2),
  `src/features/decks/DeckSearchPanel.test.tsx` (3),
  `src/features/decks/DeckSearchPanel.stories.tsx` (2)

**`DeckSearchPanel` is in this bucket even though it lives under `features/decks`.** PR #235 made
the deck's docked collection search *be* the card search — `DeckSearchPanel.tsx:1224` renders
`<FilterBar>` directly, and all five of its `selectOptions` calls target **your** format control.
The bucket follows the component, not the directory.

**Interfaces:** consumes `<Dropdown>`; produces nothing other tasks read.

Notes for this bucket:

- **Both ids are templated off `labels.idStem`, and the label ids must be too.** PR #235 made this
  row drawable on more than one surface (`SEARCH_LABELS.idStem` is `"card-search"`; the deck panel
  passes its own), so a hardcoded `id` would collide the moment both are on screen. Follow the
  existing pattern: `` id={`${labels.idStem}-sort`} `` and
  `` labelledBy={`${labels.idStem}-sort-label`} ``, with the matching id on the `<label>`.
- **The sort's label is `sr-only` and the format's comes from `TrayField`.** Two different label
  mechanisms on one row — read each before you touch it, and give the `TrayField` label an id
  rather than inventing a second label beside it.

- **The sort select is never gold** — pass no `active`. The comment at `:524` says why and must
  travel with it: a list is always in *some* order, so a sort cannot be inactive, and a gold sort
  picker would claim a filter is on about the one control on the row that is not a filter.
- **The format select is gold when it is not at its default** — `active={search.format !== ""}`.
- **The seeded-key guard at `:302` stays.** It exists because a native `<select>` with an unmatched
  value silently reports its first row — since the `Unplayable` chip merged, the pinned `Any card`,
  the widest row it has. The shell draws a placeholder instead, so the guard is now belt and
  braces; leave it and add one line to its comment saying so rather than deleting a fence in a
  refactor.
- The format list's `disabled` rows come straight across as `DropdownOption.disabled`.
- `searchable` on the format picker; not on the sort picker (7 rows).

### Task 10: Collection

**Files:**
- Modify: `src/features/collection/CollectionFilterBar.tsx` — 2 controls: **Format** and **Sort**
- Modify: `src/features/collection/AddToCollection.tsx` — 1 control: **Condition**
- Test: `src/features/collection/CollectionFilterBar.test.tsx` (2),
  `src/features/collection/CollectionPage.test.tsx` (1),
  `src/features/collection/AddToCollection.test.tsx` (1),
  `src/features/collection/AddToCollection.stories.tsx` (1)

Notes:

- **`AddToCollection`'s conditions must not be sorted.** `CONDITIONS` is a grade scale and its own
  comment beside it says it: *the kind whose order is the information*. Leave `sortOptions` out, and
  carry that comment over verbatim. No `searchable` — six grades.
- **`CollectionFilterBar`'s sort keeps its pinned `Custom…` row**, drawn only while
  `sortSelection === ""`, as `{ value: "", label: "Custom…", disabled: true }` placed first. Its
  comment explains that it is the *state of the control* rather than an order to pick — carry it.
- The `disabled`-vs-`aria-disabled` half of that comment now needs one line: an `<option>` was the
  house rule's exception because it was never in the tab order; a row is not either, so it takes
  `aria-disabled` for the same reason and a different mechanism.

### Task 11: Wishlist and import

**Files:**
- Modify: `src/features/wishlist/WishlistFilterBar.tsx` — 1 control: **Sort**
- Modify: `src/features/transfer/import/destinations/CollectionPreview.tsx` — 2 controls:
  **Condition when the file doesn't say** and **Finish when the file doesn't say**
- Modify: `src/features/transfer/import/destinations/WishlistPreview.tsx` — 1 control: **Finish when
  the file doesn't say**
- Test: `src/features/wishlist/WishlistPage.test.tsx` (1),
  `src/features/transfer/import/ImportDialog.test.tsx` (1),
  `src/features/transfer/import/ImportDialog.stories.tsx` (1)

Notes:

- **All three import-preview controls take `size="sm"`** — they are `h-8` today and stay `h-8`; only
  their text shrinks from `text-sm` to `text-xs`. **Delete the four hand-written class strings**
  (`cn("h-8 rounded-md border border-border bg-surface px-2", FOCUS)` and its siblings) rather than
  passing them through `className`; they are the geometry the `size` prop now owns, and a call site
  that keeps its own copy is where the next drift starts.
- **These three are the clipping case.** They sit inside `min-h-0 flex-1 space-y-4 overflow-y-auto`,
  which a native list escaped and an `absolute` panel would not. Nothing in the suite can see this;
  it is on Task 15's live list.
- The finish pickers round-trip `""` ↔ `null` — keep the existing `onChange` mapping exactly, just
  reading a string instead of `e.target.value`.
- `WishlistFilterBar`'s sort has the same pinned `Custom…` row as the collection's. Same treatment.
- No `searchable` in this bucket.

### Task 12: Card

**Files:**
- Modify: `src/features/card/CardDetailPane.tsx` — 1 control: **Group printings by**; delete the
  private `CONTROL` recipe near the top of the file
- Modify: `src/features/card/PrintingsFilterBar.tsx` — 1 control: **Sort printings by**
- Modify: `src/features/card/AllPrintingsDialog.tsx` — `ARROW_OWNERS` and `ownsArrowKeys`
- Test: `src/features/card/CardDetailPane.test.tsx` (2),
  `src/features/card/CardDetailPane.stories.tsx` (2),
  `src/features/card/AllPrintingsDialog.test.tsx`

**This bucket carries the one edit both suites are blind to.** `ARROW_OWNERS` is

```ts
const ARROW_OWNERS = "input, textarea, select, [contenteditable=''], [contenteditable='true']";
```

and it exists because ArrowLeft on a focused `<select>` changes its value in Chromium and WebView2,
so a reader narrowing the printings wall by set would step to the next card instead. After this
bucket, **`PrintingsFilterBar` has no `<select>` in it** and that clause matches nothing. Replace it
with the two shapes a dropdown presents:

```ts
/**
 * … (keep the existing doc comment, and add:)
 *
 * **`select` was the original clause and is now the dead one.** `PrintingsFilterBar`'s controls
 * became `Dropdown`s on 2026-08-25, so what has to be exempted is a dropdown's two shapes instead:
 * the **trigger** while its panel is open — ArrowLeft/ArrowRight there belong to the control the
 * reader is inside, not to the walk — and anything **inside the panel**, which is where the caret
 * actually sits. `select` stays in the list because the app may grow one back, and a stale clause
 * that matches nothing costs nothing.
 */
const ARROW_OWNERS =
  "input, textarea, select, [contenteditable=''], [contenteditable='true']," +
  '[aria-haspopup="listbox"][aria-expanded="true"], [role="listbox"]';
```

**The fence already exists — rewrite it, do not add a second one.**
`AllPrintingsDialog.test.tsx` carries `it("yields the arrow keys to a focused select in the filter
row")`, and it will go red the moment the sort control stops being a `<select>`: it reaches for it
with `getByRole("combobox", { name: "Sort printings by" })`, which finds nothing once the trigger is
a `button`. **That red is the point.** Rewrite it as:

```tsx
  /**
   * **An open dropdown owns the arrow keys**, and this is the guard that would otherwise have
   * shipped — twice now, in two shapes.
   *
   * It was a `<select>` until 2026-08-25, where ArrowLeft *changes the value* in Chromium and in
   * WebView2 with it, so a reader re-sorting the wall would step to another card as well. A
   * `Dropdown` has the opposite shape: a **closed** trigger does nothing with ArrowLeft, so the
   * walk is welcome to it — and an **open** panel is where the caret is and where the arrows
   * belong. `ARROW_OWNERS` was rewritten to match the second shape and this test moved with it.
   *
   * **Opened the way a reader opens it**, not with `focus()`. Starting a keyboard flow from a
   * programmatic focus tests a caret nobody can produce, and here it would skip the very state
   * being tested: the panel has to be open for the exemption to be in force at all.
   */
  it("yields the arrow keys to an open dropdown in the filter row", async () => {
    const user = userEvent.setup();
    renderDialog();
    withDeckWalk();
    open(WALK[1]);
    await screen.findByRole("dialog", { name: /Sol Ring/ });

    await openDropdown(user, "Sort printings by");

    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowLeft}");

    expect(useAppStore.getState().printingsRequest).toEqual(stepped(WALK[1]));
  });
```

`openDropdown` comes from `@/test-dropdown`; `renderDialog`, `withDeckWalk`, `open`, `WALK` and
`stepped` are already in that file.

**Then mutate it**: delete the two new clauses from `ARROW_OWNERS` and re-run. Expected: RED. If it
stays green, the exemption is not doing anything and the test is decorative — say so.

Other notes:

- Both controls take `size="sm"` — the card pane's density, unchanged.
- `CardDetailPane`'s select is labelled for a screen reader alone (`aria-label="Group printings by"`,
  no visible label) — pass `label`, not `id`.
- No `searchable` — both lists are short.

### Task 13: Deck editor

**Files:**
- Modify: `src/features/decks/DeckEditor.tsx` — 3 controls: **View**, **Group by**, **Sort**; delete
  the private `CONTROL` recipe near the top of the file
- Test: `src/features/decks/DeckEditor.test.tsx` (16),
  `src/features/decks/DeckEditor.stories.tsx` (5)

**Two things left this bucket after the plan was written, and both are because `main` moved.**
`CollectionSearchFilters.tsx` **no longer exists** — PR #235 replaced the deck's own filter row with
the card search's `FilterBar`, so its two controls are Task 9's now. `DeckSearchPanel`'s tests and
stories went with them, for the same reason. Do not go looking for either.

**This is the bucket with the geometry risk.** The three toolbar pickers are `h-9 text-xs` today and
become `md` — `h-9 text-sm`. `QuickZones.tsx:161` records a toolbar `<select>` hanging **66px** past
its row at both 1024 and 1920, so three pickers each gaining 2px of font is exactly the kind of
change that reopens it. **Convert them to `md`, note in your report that this is the untested case,
and leave the decision to Task 15's live measurement** — if the toolbar overflows there, the whole
row moves to `sm` in a follow-up commit and the reason gets written at the call site.

Other notes:

- **One call in your bucket drives a control you do not own.** `DeckEditor.stories.tsx`'s `Add cards to` call opens
  Deck settings and picks `Add cards to` — that is `DeckSettingsForm`'s default-category picker, and
  it belongs to Task 14. Rewrite the call mechanically
  (`pickOption(user, "Add cards to", "Main deck")`) and **do not try to run that play**: it is red
  until Task 14 lands, and story plays are Task 15's round in any case because `stories.test.tsx`
  collects the whole tree. Say in your report that you left it unverified.
- 16 `selectOptions` calls in `DeckEditor.test.tsx` is the largest single rewrite in the plan.
  Convert them one at a time and run the file after each three or four; the file is long enough that
  a batch of sixteen failures is unreadable.

### Task 14: Deck forms

**Files:**
- Modify: `src/features/decks/DeckSettingsForm.tsx` — 4 controls: **Game**, **Format**, **Add cards
  to** (the default category) and **Folder**
- Modify: `src/features/decks/FormatSelect.tsx` — 2 controls: **Format** and **Game**; delete its private
  `<select>` recipe
- Modify: `src/features/decks/CategoriesDialog.tsx` — 1 control: where a deleted category's cards go
- Test: `src/features/decks/DeckSettingsForm.test.tsx` (6),
  `src/features/decks/DeckSettingsForm.stories.tsx` (2),
  `src/features/decks/DeckSettingsDialog.test.tsx` (6),
  `src/features/decks/DeckSettingsDialog.stories.tsx` (2),
  `src/features/decks/CreateDeckDialog.test.tsx` (3),
  `src/features/decks/CreateDeckDialog.stories.tsx` (2),
  `src/features/decks/CategoriesDialog.test.tsx` (2),
  `src/features/decks/CategoriesDialog.stories.tsx` (1),
  `src/features/decks/DecksPage.test.tsx` (1)

Notes:

- **`FormatSelect`'s public props must not change.** `CreateDeckDialog`, `DeckSettingsForm` and
  `src/features/transfer/import/destinations/NewDeckPreview.tsx` all render it, and
  **`NewDeckPreview` is owned by no task in this fan-out and must not be edited by anyone** — it
  sits in Task 11's directory and is deliberately absent from Task 11's file list, because it
  contains no `<select>` of its own. If `FormatSelect`'s props move, that file breaks and no bucket
  will notice.
- **Keep the `formatKey` guard.** It injects a synthetic option so a value the picker has
  no row for still matches one, and it exists because a native select would otherwise report row 0
  while the dialog read something else. The shell draws a placeholder now, so the guard is belt and
  braces — leave it, and add a line to its comment saying which of the two is load-bearing.
- **`AUTO_CATEGORY` and the folder ids are numbers.** They are already `String(n)` at the
  `<option value>` boundary and parsed back in `onChange`; keep exactly that, and keep the comment
  that explains it.
- **The folder picker's `""` is "Top level"** — a real row, not a placeholder.
- `searchable` on the format picker, the default-category picker and the folder picker. Not on the
  game picker (2 rows) and not on `CategoriesDialog`'s (a handful).
- `CategoriesDialog`'s control lives inside `min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4` — the
  second clipping case, and on Task 15's live list.

---

## Task 15: Fan-in, the story-play round, and the live pass

**Files:** whatever the six buckets touched, plus `src/stories.test.tsx` fallout.

- [ ] **Step 1: Read every bucket's report**

Collect: files changed, controls converted, tests rewritten, **mutations that survived**. A surviving
mutation is a real finding — fix it before running anything.

- [ ] **Step 2: Sweep for a `<select>` nobody owned**

Run: `grep -rn "^\s*<select" src --include=*.tsx`
Expected: **no output.** A file not in the bucket table is a file nobody converted, and a
diff-scoped sweep cannot find it.

Run: `grep -rn "selectOptions" src --include=*.tsx --include=*.ts`
Expected: **no output.**

- [ ] **Step 3: Run the whole suite, sharded**

Long runs get killed. Run three shards sequentially and sum them:

```bash
npx vitest run --shard=1/3 > /tmp/v1.txt 2>&1; grep -E "Tests|Test Files" /tmp/v1.txt
npx vitest run --shard=2/3 > /tmp/v2.txt 2>&1; grep -E "Tests|Test Files" /tmp/v2.txt
npx vitest run --shard=3/3 > /tmp/v3.txt 2>&1; grep -E "Tests|Test Files" /tmp/v3.txt
```

Redirect and grep rather than piping — `| tail` reports the pipe's exit code, so a failing run reads
as 0.

- [ ] **Step 4: The story-play fix round**

`src/stories.test.tsx` collects the whole tree, so no subagent could run a play. Expect breakage in
the 10 story files that carried `selectOptions`, and expect it to be concentrated in
`DeckEditor.stories.tsx` (5) and the four dialog story files. Fix them here.

If the failure output truncates, raise `DEBUG_PRINT_LIMIT` so the real numbers are visible.

- [ ] **Step 5: `npm run verify`**

Run: `npm run verify > /tmp/verify.txt 2>&1; grep -E "Tests|Test Files|error|✖" /tmp/verify.txt`
Expected: green. **Never run two verifies at once in any worktree** — concurrent runs fake ~18 Rust
schema failures and you will spend an hour on SQLite.

- [ ] **Step 6: Commit the fan-in**

```bash
git add -A
git commit -m "refactor: every option list is a Dropdown

Every native select in the app, and the selectOptions calls that
drove them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: The live pass**

Read `.claude/skills/running-the-app/SKILL.md` and claim the app lock. Under `tauri dev` the database
is `src-tauri/target/debug/data/mtg.db`. `docs/reference/live-ui-verification.md` is the harness
contract — it documents traps that have each cost a session, including that `cdp.mjs` takes the
first `type: page` target, so **put `location.href` in every payload** or DevTools answers instead of
the app.

Five checks, and each has a number to write down:

1. **The flip.** Open the wishlist's sort dropdown with the window short enough that the panel would
   run off the bottom. Assert `panel.bottom <= innerHeight` and that `panel.bottom <= trigger.top`.
2. **The scroller.** Open the import dialog to a collection preview, scroll its body, open the
   Condition dropdown. Assert the panel's bottom is **past** the scroller's bottom.
3. **The dialog.** Open Deck settings and its Format dropdown. Assert `panel.left` is within 1px of
   `trigger.left` — this is the containing-block correction, and getting it wrong puts the panel off
   by the dialog's own offset rather than nowhere, which looks like a styling bug.
4. **The deck toolbar at 1024 and 1280.** Measure the toolbar row's `scrollWidth` against its
   `clientWidth` at both. Put `innerWidth` in the **same** evaluation as the rect — the window can
   resize mid-pass and a wide desk reads exactly like an overflow. If it overflows, move the row to
   `size="sm"` and write the reason at the call site.
5. **The set picker, unchanged.** ~1 050 sets, the 100-row page, the footer's "Show 50 more", the
   tick column, and Escape handing the caret back.

Two mechanics worth having in hand: `cdp.mjs click` needs a `hover --rest 200` first or a cold
pointer makes it a silent no-op, and **clicking and reading in one `eval` answers about the frame
before React re-rendered** — split them into two.

- [ ] **Step 8: Write the readings down and commit**

Into `docs/reference/frontend-design.md`, under the heading Task 7 opened. Name the build (debug) and
the date. Do **not** write down a number a build already answers.

```bash
git add docs/reference/frontend-design.md
git commit -m "docs: what the dropdown's panel does in the shipped window

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: The rules move into the CLAUDE.md files

A prose-only edit routes to neither CI job, so nothing goes red when a document rots. These edits are
the ones that keep the next agent from rebuilding what this plan just settled.

**Files:**
- Modify: `src/CLAUDE.md`
- Modify: `docs/reference/frontend-design.md`

- [ ] **Step 1: `src/CLAUDE.md`**

Add to **Binding rules**:

> - **Every option list is `components/Dropdown`** — `<Dropdown>` for one value, `<MultiDropdown>`
>   for several. There are no native `<select>`s in `src/`, and a new one is a review comment rather
>   than a style choice: the browser draws a surface this app cannot style, put a set symbol in, or
>   give a focus ring. Search is **opt-in** (`searchable`), because most of these lists are six rows
>   long. Two sizes and only two: `md` is `FILTER_SHAPE`, `sm` is the card pane's density.
> - **A dropdown's trigger is a `button`, not a `combobox`** — the combobox is the search box it
>   reveals, and only a `searchable` one has it. `src/test-dropdown.ts` is how a test drives one.

Amend the existing anchored-popup rule (`An anchored popup is pinned to, and grows from, the corner
nearest its trigger's own edge`) with:

> `Dropdown` does this from a **measurement** rather than from a class: `placeDropdown()` picks the
> corner and the flip, and the panel is drawn `absolute` inside a zero-size `fixed` frame so it
> escapes a scroller *and* survives a transformed ancestor. **`position: fixed` is not
> viewport-relative under one, and a settled `Dialog` panel sits at `scale: 1`, which is one.**

Amend the `sortOptions` rule with:

> **`Dropdown` never sorts** — a caller passes its list in the order it wants drawn, which is what
> keeps every exemption above working.

- [ ] **Step 2: `docs/reference/frontend-design.md`**

Under the heading Task 7 opened, add the long form: the two sizes and what each replaced, the
placement arithmetic and its constants, the frame and the containing-block reasoning, and the live
readings from Task 15. Name the date and the build for every figure.

- [ ] **Step 3: Re-count anything you changed**

Counts and lists in these files have each drifted at least once. If you changed a number, re-count it
in the same commit. **Better still, delete a number a build already answers.**

- [ ] **Step 4: Commit**

```bash
git add src/CLAUDE.md docs/reference/frontend-design.md
git commit -m "docs: one dropdown, and where its rules live

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Ship

- [ ] **Step 1: Final verify**

Run: `npm run verify > /tmp/verify-final.txt 2>&1; grep -E "Tests|Test Files|error" /tmp/verify-final.txt`
Expected: green.

- [ ] **Step 2: Rust formatters, which verify does not run**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and
`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
Expected: clean. No Rust changed in this plan, so a red here means the branch picked one up from a
merge.

- [ ] **Step 3: Merge `main` in — never rebase**

```bash
git fetch origin
git merge origin/main
```

A worktree's base is a stale `main`; budget for three or more merges before this lands. If a conflict
arrives, resolve it by hand — **`git checkout --ours <file>` drops `main`'s non-conflicting hunks
from that file too**, and a rename on `main` turns a string-literal assertion into a vacuous pass.
Re-run verify even on a clean merge.

- [ ] **Step 4: Open the PR and arm auto-merge**

Use the `auto-pr` skill. `pr-auto.ps1 open` **skips a reused branch** — after that branch's PR has
merged it reports `MERGED` and silently creates no second PR — so if this branch has shipped before,
use `gh pr create` then `pr-auto.ps1 arm -Pr <n>`. `open` also loses a `Closes #N` line when the
branch has two or more real commits, which this one will; put the issue link in the body by hand and
check `closingIssuesReferences`.

- [ ] **Step 5: Watch, but hold the arming until the review is in**

`ci-ok` goes green in minutes and a review takes twenty; arming before the review lands merges the
branch out from under it. Poll from a node file — `gh pr checks --watch` gets killed, and Monitor's
inline bash is refused in a worktree. Do not chase `BEHIND`; auto-merge handles it. **The agent does
not press Merge.**

---

## Notes for whoever executes this

- **Two subagents editing the same files in one tree clobber each other.** Tasks 9–14 are disjoint by
  construction; do not widen a bucket mid-flight. If a file turns out to be shared, stop and re-cut
  the buckets rather than "just quickly" touching it.
- **A test filter that matches nothing exits 0.** Whenever you run `vitest -t`, report the selected
  count — "expected PASS" proves nothing about a filter that selected no tests.
- **`git commit` in a shared worktree takes whatever a sibling staged.** Only the controller commits
  during the fan-out, and it names paths rather than using `-A` until Task 15.
