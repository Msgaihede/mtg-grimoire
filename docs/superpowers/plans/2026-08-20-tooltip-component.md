# Tooltip Component Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One tooltip the app draws itself — styled, rich-content capable, selectable where asked
for — and every native `title` / SVG `<title>` in the app moved onto it.

**Architecture:** A `TooltipProvider` at the app root holds the one open tooltip in a vanilla
zustand store and renders a single `position: fixed` panel as a sibling of the whole app, outside
every transform and every clipped scroller. Call sites bind with a spread from `useTooltip()`,
which adds no DOM node and takes its anchor from `event.currentTarget`. Placement is a pure
function in `src/lib/tooltip.ts`.

**Tech Stack:** React 19, TypeScript 6, zustand 5 (vanilla store), `motion` 13, Tailwind v4,
Vitest 4 + Testing Library, Storybook 10.

**Spec:** `docs/superpowers/specs/2026-08-20-tooltip-component-design.md` — read it before Task 1.
It carries the reasons; this plan carries the steps.

## Global Constraints

- **Never write a raw z-index.** Every one comes from `LAYER` in `src/lib/layers.ts`;
  `src/lib/layers.test.ts` sweeps `src/` and fails otherwise.
- **Never write a raw duration or easing at a call site.** They come from `src/lib/motion.ts`.
  The tooltip's *timers* are not durations in that sense (see Task 3) and get their own named
  constants with a stated reason.
- **Tailwind v4 scans source text for whole class names.** A class built by interpolation emits no
  rule at all. Every `origin-*` variant is written out whole.
- **Dim text is `text-dim`, never `text-muted`** (`src/lib/tokens.test.ts` guards it).
- **Never install a dependency.** Nothing in this plan adds one. In particular do not install
  `@types/node`, `@radix-ui/*`, or anything from the shadcn registry.
- **The shipped CSP is `style-src 'self'; style-src-attr 'unsafe-inline'`.** Inline `style`
  attributes are fine; an injected `<style>` **element** is blocked in the packaged exe only.
  `motion`'s `AnimatePresence` out-of-flow exit mode and its view-transition builder both inject
  one and are banned by `src/lib/tokens.test.ts`. This plan uses neither.
- **Run commands from the worktree root** `D:\Code\mtg-grimoire\.claude\worktrees\tooltip-element`.
  `npm install` has already been run there.
- **Commit after every task** with `feat:` / `fix:` / `test:` / `docs:` / `chore:`.
- **Do not run `npm run verify` inside a fanned-out subagent** — your slice compiles against a tree
  your siblings are still changing. Run the targeted test file named in your task; the controller
  runs `verify` once after fan-in.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/tooltip.ts` | Pure placement: preferred side, flip, clamp, transform origin. No DOM. |
| `src/lib/tooltip.test.ts` | Its tests, on fabricated rects. |
| `src/components/tooltip/tooltipStore.ts` | The vanilla zustand store: which tooltip is open. |
| `src/components/tooltip/tooltipStore.test.ts` | Its tests. |
| `src/components/tooltip/useTooltip.ts` | The context, the no-op default, the binder hook. |
| `src/components/tooltip/TooltipProvider.tsx` | Timers, the pointer bridge, dismissal, `aria-describedby`, and the one panel. |
| `src/components/tooltip/TooltipPanel.tsx` | The panel: measurement, placement, look, motion. |
| `src/components/tooltip/tooltip.test.tsx` | Provider + hook behaviour under fake timers. |
| `src/components/tooltip/Tooltip.stories.tsx` | The workbench entry, `Primitives/Tooltip`. |
| `src/lib/layers.ts` | +1 rung: `tooltip: "z-46"`. |
| `src/App.tsx` | Mounts `<TooltipProvider>`. |
| `.storybook/preview.tsx` | Mounts it too, mirroring `App.tsx`'s order. |

---

# PR 1 — the primitive

## Task 1: The placement arithmetic

**Files:**
- Create: `src/lib/tooltip.ts`
- Create: `src/lib/tooltip.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type TooltipSide = "top" | "bottom" | "left" | "right"`;
  `interface AnchorRect { top; bottom; left; right; width; height: number }`;
  `interface TooltipSize { width; height: number }`;
  `interface TooltipPlacement { left: number; top: number; origin: string }`;
  `placeTooltip(anchor: AnchorRect, size: TooltipSize, side: TooltipSide, view: TooltipSize): TooltipPlacement`;
  `const TOOLTIP_GAP = 8`; `const TOOLTIP_EDGE_GUTTER = 8`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/tooltip.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { placeTooltip, TOOLTIP_EDGE_GUTTER, TOOLTIP_GAP, type AnchorRect } from "./tooltip";

/**
 * The placement is arithmetic on purpose, for `shouldFlipUp`'s stated reason: jsdom lays nothing
 * out, so every rectangle a *component* test could read is zero and a test of a rendered tooltip
 * would pass over any decision at all. These hand it rectangles.
 */
const VIEW = { width: 1280, height: 800 };

/** A 40×20 control in the middle of the window. */
const middle: AnchorRect = { left: 600, right: 640, top: 400, bottom: 420, width: 40, height: 20 };
const size = { width: 200, height: 40 };

describe("placeTooltip", () => {
  it("puts a top-side panel above the anchor, centred, growing from its bottom edge", () => {
    expect(placeTooltip(middle, size, "top", VIEW)).toEqual({
      // 400 − 8 gap − 40 tall
      top: 352,
      // centre 620, minus half of 200
      left: 520,
      origin: "origin-bottom",
    });
  });

  it("puts a bottom-side panel below the anchor, growing from its top edge", () => {
    expect(placeTooltip(middle, size, "bottom", VIEW)).toEqual({
      top: 428,
      left: 520,
      origin: "origin-top",
    });
  });

  it("flips a top-side panel down when there is no room above", () => {
    const high: AnchorRect = { left: 600, right: 640, top: 10, bottom: 30, width: 40, height: 20 };
    expect(placeTooltip(high, size, "top", VIEW)).toEqual({
      top: 38,
      left: 520,
      origin: "origin-top",
    });
  });

  it("keeps the preferred side when neither direction fits", () => {
    const tall = { width: 200, height: 780 };
    const high: AnchorRect = { left: 600, right: 640, top: 10, bottom: 30, width: 40, height: 20 };
    // Flipping a panel that does not fit either way only moves it; it opens where it was asked to.
    expect(placeTooltip(high, tall, "top", VIEW).origin).toBe("origin-bottom");
  });

  it("clamps a panel that would hang off the left of the window", () => {
    const left: AnchorRect = { left: 4, right: 24, top: 400, bottom: 420, width: 20, height: 20 };
    expect(placeTooltip(left, size, "top", VIEW).left).toBe(TOOLTIP_EDGE_GUTTER);
  });

  it("clamps a panel that would hang off the right of the window", () => {
    const right: AnchorRect = {
      left: 1250, right: 1276, top: 400, bottom: 420, width: 26, height: 20,
    };
    expect(placeTooltip(right, size, "top", VIEW).left).toBe(
      VIEW.width - size.width - TOOLTIP_EDGE_GUTTER,
    );
  });

  it("places a right-side panel beside the anchor, vertically centred", () => {
    expect(placeTooltip(middle, size, "right", VIEW)).toEqual({
      left: middle.right + TOOLTIP_GAP,
      // centre 410, minus half of 40
      top: 390,
      origin: "origin-left",
    });
  });

  it("flips a right-side panel to the left when the window edge is in the way", () => {
    const right: AnchorRect = {
      left: 1200, right: 1240, top: 400, bottom: 420, width: 40, height: 20,
    };
    expect(placeTooltip(right, size, "right", VIEW)).toEqual({
      left: 1200 - TOOLTIP_GAP - size.width,
      top: 390,
      origin: "origin-right",
    });
  });

  it("rounds to whole pixels, so text is never painted on a half pixel", () => {
    const odd: AnchorRect = { left: 600, right: 641, top: 400, bottom: 420, width: 41, height: 20 };
    const placed = placeTooltip(odd, size, "top", VIEW);
    expect(Number.isInteger(placed.left)).toBe(true);
    expect(Number.isInteger(placed.top)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```
npx vitest run src/lib/tooltip.test.ts
```

Expected: FAIL — `Failed to resolve import "./tooltip"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/tooltip.ts`:

```ts
/**
 * Where the app's one tooltip goes, given the control it belongs to and the room it needs.
 *
 * Pure, and that is the point rather than tidiness: **every rectangle in jsdom is zero**, so a
 * component test of a rendered tooltip would pass over any arithmetic at all — the same reason
 * `shouldFlipUp.ts` gives for being a function rather than a hook. What can go wrong here is a
 * flip, a clamp and an origin, and all three are testable only against numbers.
 *
 * Sibling to `components/menu/panel.ts`'s `placeMenu`, which answers the same question for a
 * point rather than for an element, and keeps the same 8px gutter.
 */

/** Which side of its anchor the panel is asked for. Flipped by {@link placeTooltip} if it must. */
export type TooltipSide = "top" | "bottom" | "left" | "right";

/**
 * The anchor's box. A `DOMRect` satisfies this structurally, and a test can write one out —
 * which `DOMRect` itself, with its `x`, `y` and `toJSON`, makes tedious.
 */
export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface TooltipSize {
  width: number;
  height: number;
}

export interface TooltipPlacement {
  /** Viewport coordinates, which is what a `fixed` box is laid out against. */
  left: number;
  top: number;
  /** One of the four whole `origin-*` literals below. */
  origin: string;
}

/** The standoff between the control and the panel, in px. */
export const TOOLTIP_GAP = 8;

/** How much of the window edge the panel keeps clear. `MENU_EDGE_GUTTER`'s value, on purpose. */
export const TOOLTIP_EDGE_GUTTER = 8;

const OPPOSITE: Record<TooltipSide, TooltipSide> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

/**
 * The transform origin per side, written out whole.
 *
 * **Tailwind scans source text for whole class names**, so `` `origin-${side}` `` emits no rule at
 * all and the panel would grow from its own middle — the one thing this app's anchored-popup rule
 * forbids, because a panel pinned by one edge and growing from another reads as unrelated to the
 * control that produced it. The panel is centred on its anchor, so the edge it is pinned by is the
 * edge facing the anchor: a panel *above* grows from its bottom.
 */
const ORIGIN: Record<TooltipSide, string> = {
  top: "origin-bottom",
  bottom: "origin-top",
  left: "origin-right",
  right: "origin-left",
};

function fits(side: TooltipSide, anchor: AnchorRect, size: TooltipSize, view: TooltipSize): boolean {
  switch (side) {
    case "top":
      return anchor.top - TOOLTIP_GAP - size.height >= TOOLTIP_EDGE_GUTTER;
    case "bottom":
      return anchor.bottom + TOOLTIP_GAP + size.height <= view.height - TOOLTIP_EDGE_GUTTER;
    case "left":
      return anchor.left - TOOLTIP_GAP - size.width >= TOOLTIP_EDGE_GUTTER;
    case "right":
      return anchor.right + TOOLTIP_GAP + size.width <= view.width - TOOLTIP_EDGE_GUTTER;
  }
}

const clamp = (value: number, size: number, viewport: number): number =>
  Math.max(TOOLTIP_EDGE_GUTTER, Math.min(value, viewport - size - TOOLTIP_EDGE_GUTTER));

export function placeTooltip(
  anchor: AnchorRect,
  size: TooltipSize,
  side: TooltipSide,
  view: TooltipSize,
): TooltipPlacement {
  // The preferred side wins ties and wins the case where neither fits: flipping a panel that is
  // clipped either way only moves it, and it should be where the caller said.
  const chosen =
    fits(side, anchor, size, view) || !fits(OPPOSITE[side], anchor, size, view)
      ? side
      : OPPOSITE[side];
  const vertical = chosen === "top" || chosen === "bottom";

  const rawLeft = vertical
    ? anchor.left + anchor.width / 2 - size.width / 2
    : chosen === "left"
      ? anchor.left - TOOLTIP_GAP - size.width
      : anchor.right + TOOLTIP_GAP;
  const rawTop = vertical
    ? chosen === "top"
      ? anchor.top - TOOLTIP_GAP - size.height
      : anchor.bottom + TOOLTIP_GAP
    : anchor.top + anchor.height / 2 - size.height / 2;

  // **Both axes are clamped, including the one the side decides.** On the cross axis that is the
  // ordinary "do not hang off the window" clamp; on the main axis it only ever bites in the case
  // above — a panel that fits neither way — where without it the panel would be placed off-screen
  // rather than merely against the edge. Nothing clips a `fixed` panel, so an overflow there is
  // unreachable rather than ugly.
  return {
    left: Math.round(clamp(rawLeft, size.width, view.width)),
    top: Math.round(clamp(rawTop, size.height, view.height)),
    origin: ORIGIN[chosen],
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```
npx vitest run src/lib/tooltip.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tooltip.ts src/lib/tooltip.test.ts
git commit -m "feat(tooltip): place a tooltip against its anchor, flipping and clamping"
```

---

## Task 2: The store

**Files:**
- Create: `src/components/tooltip/tooltipStore.ts`
- Create: `src/components/tooltip/tooltipStore.test.ts`

**Interfaces:**
- Consumes: `TooltipSide` from `@/lib/tooltip`.
- Produces: `interface OpenTooltip { openId: number; anchor: HTMLElement; content: ReactNode; side: TooltipSide; interactive: boolean; describes: boolean }`;
  `interface TooltipState { open: OpenTooltip | null; show(next: Omit<OpenTooltip, "openId">): void; hide(anchor: HTMLElement): void; hideAny(): void }`;
  `createTooltipStore(): StoreApi<TooltipState>`.

- [ ] **Step 1: Write the failing test**

Create `src/components/tooltip/tooltipStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTooltipStore } from "./tooltipStore";

const anchorOf = (id: string): HTMLElement => {
  const el = document.createElement("button");
  el.id = id;
  return el;
};

const shown = (anchor: HTMLElement) => ({
  anchor,
  content: "words",
  side: "top" as const,
  interactive: false,
  describes: true,
});

describe("the tooltip store", () => {
  it("holds the one tooltip that is open", () => {
    const store = createTooltipStore();
    expect(store.getState().open).toBeNull();
    const a = anchorOf("a");
    store.getState().show(shown(a));
    expect(store.getState().open?.anchor).toBe(a);
  });

  it("bumps openId per open, so the panel knows to measure again", () => {
    const store = createTooltipStore();
    store.getState().show(shown(anchorOf("a")));
    const first = store.getState().open?.openId;
    store.getState().show(shown(anchorOf("b")));
    expect(store.getState().open?.openId).toBe((first ?? 0) + 1);
  });

  it("ignores a close aimed at a control that is not the one showing", () => {
    // The pointer left A, but the tooltip on screen is B's: A's leave arriving late must not
    // close it. Two controls a pixel apart in a table row produce exactly this order.
    const store = createTooltipStore();
    const a = anchorOf("a");
    const b = anchorOf("b");
    store.getState().show(shown(a));
    store.getState().show(shown(b));
    store.getState().hide(a);
    expect(store.getState().open?.anchor).toBe(b);
  });

  it("closes when the control that is showing asks", () => {
    const store = createTooltipStore();
    const a = anchorOf("a");
    store.getState().show(shown(a));
    store.getState().hide(a);
    expect(store.getState().open).toBeNull();
  });

  it("closes whatever is open when the window asks", () => {
    const store = createTooltipStore();
    store.getState().show(shown(anchorOf("a")));
    store.getState().hideAny();
    expect(store.getState().open).toBeNull();
  });

  it("does not write when there is nothing open, so a scroll costs no render", () => {
    const store = createTooltipStore();
    let writes = 0;
    store.subscribe(() => {
      writes += 1;
    });
    store.getState().hideAny();
    store.getState().hide(anchorOf("a"));
    expect(writes).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```
npx vitest run src/components/tooltip/tooltipStore.test.ts
```

Expected: FAIL — cannot resolve `./tooltipStore`.

- [ ] **Step 3: Write the implementation**

Create `src/components/tooltip/tooltipStore.ts`:

```ts
import type { ReactNode } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { TooltipSide } from "@/lib/tooltip";

/** The one tooltip that is open, all of it. */
export interface OpenTooltip {
  /**
   * Bumped per open, so the panel can tell a fresh control from a re-render and measure again.
   * The panel is rendered under a constant key — it *moves* between two controls rather than
   * cross-fading — so a changed anchor is not a remount and there is no other signal.
   */
  openId: number;
  anchor: HTMLElement;
  content: ReactNode;
  side: TooltipSide;
  /** The pointer may enter the panel, and its text may be selected. */
  interactive: boolean;
  /** Wire `aria-describedby` on the anchor while this is open. */
  describes: boolean;
}

export interface TooltipState {
  open: OpenTooltip | null;
  show: (next: Omit<OpenTooltip, "openId">) => void;
  /**
   * Close, but only if `anchor` is the control currently showing.
   *
   * **The guard is the whole point.** Two controls a pixel apart in a table row produce
   * `enter(B)` before `leave(A)`, and an unguarded close would take B's tooltip away the instant
   * it appeared.
   */
  hide: (anchor: HTMLElement) => void;
  /** Close whatever is open — a scroll, a resize, a press, Escape. */
  hideAny: () => void;
}

/**
 * A store per provider rather than a module global, which is `ActivityProvider`'s pattern and
 * here it is load-bearing twice over.
 *
 * **A `useState` in a provider wrapping the whole app would re-render the entire application on
 * every pointer-enter and every pointer-leave** — for a surface driven by hover, the worst
 * possible place to keep state. The context value is the store, whose identity never changes, so
 * no consumer re-renders and only the panel subscribes.
 *
 * And a store owned by a provider is the one shape Storybook's per-story world can isolate; CLAUDE.md
 * already records `useAppStore` as *the* global that cannot be, and this should not become the second.
 */
export const createTooltipStore = (): StoreApi<TooltipState> =>
  createStore<TooltipState>((set, get) => ({
    open: null,
    show: (next) => set({ open: { ...next, openId: (get().open?.openId ?? 0) + 1 } }),
    hide: (anchor) => {
      if (get().open?.anchor === anchor) set({ open: null });
    },
    // The `!== null` check is not a micro-optimisation: `hideAny` is called from a capture-phase
    // `scroll` listener, i.e. on every frame of every scroll in the app. Writing `null` over
    // `null` would notify every subscriber each time.
    hideAny: () => {
      if (get().open !== null) set({ open: null });
    },
  }));
```

- [ ] **Step 4: Run the tests and confirm they pass**

```
npx vitest run src/components/tooltip/tooltipStore.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/tooltip/tooltipStore.ts src/components/tooltip/tooltipStore.test.ts
git commit -m "feat(tooltip): hold the one open tooltip in a store the provider owns"
```

---

## Task 3: The provider, the hook and the panel

This is the heart of the feature. Read the spec's §3, §4 and §5 before starting.

**Files:**
- Create: `src/components/tooltip/useTooltip.ts`
- Create: `src/components/tooltip/TooltipProvider.tsx`
- Create: `src/components/tooltip/TooltipPanel.tsx`
- Create: `src/components/tooltip/tooltip.test.tsx`
- Modify: `src/lib/layers.ts` (add the `tooltip` rung — needed by the panel, so it lands here)

**Interfaces:**
- Consumes: `placeTooltip`, `TooltipSide`, `TOOLTIP_GAP` from `@/lib/tooltip`; `createTooltipStore`, `OpenTooltip`, `TooltipState` from `./tooltipStore`; `popup` from `@/lib/motion`; `LAYER` from `@/lib/layers`; `cn` from `@/lib/utils`.
- Produces:
  - `interface TooltipOptions { side?: TooltipSide; interactive?: boolean; whenClipped?: boolean; describes?: boolean }`
  - `type TooltipBinder = (content: ReactNode, options?: TooltipOptions) => TooltipBinding`
  - `useTooltip(): TooltipBinder`
  - `TooltipProvider({ children }: { children: ReactNode })`
  - `TOOLTIP_OPEN_MS = 400`, `TOOLTIP_WARM_MS = 300`, `TOOLTIP_BRIDGE_MS = 120`, `TOOLTIP_PANEL_ID = "app-tooltip"`

**Facts measured in this worktree on 2026-08-20 (jsdom 30, vitest 4.1.10) — do not re-derive:**

- `element.matches(":focus-visible")` **does not throw** in jsdom and returns `true` for *any*
  focused element, `false` for an unfocused one. So jsdom cannot tell a mouse focus from a
  keyboard one: a test asserting "clicking does not open a tooltip" would fail against a correct
  implementation. **That discrimination is a live-CDP check (Task 8), never a jsdom one.**
- `userEvent.hover` fires `pointerenter` then `mouseenter`; `unhover` fires `pointerleave`.
- `fireEvent.pointerEnter` reaches an `onPointerEnter` handler and `PointerEvent` is a real
  constructor here.
- `scrollWidth` and `clientWidth` are both `0` and can be faked with `Object.defineProperty`.

- [ ] **Step 1: Add the layer rung**

In `src/lib/layers.ts`, insert between the `overlay` and `gate` entries:

```ts
  /**
   * The app's one tooltip, over anything a view or a dialog draws.
   *
   * **Above {@link LAYER.overlay} because a hint is shown over the deck editor's dialogs** — a
   * control inside a modal has as much to explain as one outside it, and a tooltip painted behind
   * the scrim would be a tooltip that never appears. Below {@link LAYER.gate} because
   * `SyncProgress` takes the window: a hint floating over it would describe a control the reader
   * cannot see or reach.
   *
   * One rung and one panel — the provider holds at most one open tooltip, so there is no second
   * one for a number to order against.
   */
  tooltip: "z-46",
```

- [ ] **Step 2: Write the failing test**

Create `src/components/tooltip/tooltip.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider, TOOLTIP_BRIDGE_MS, TOOLTIP_OPEN_MS, TOOLTIP_WARM_MS } from "./TooltipProvider";
import { useTooltip, type TooltipOptions } from "./useTooltip";

/**
 * Fake timers throughout: everything this component decides is a schedule — a delay, a warm
 * period, a bridge across a gap — and a real-clock test of any of them is a flake waiting for a
 * loaded machine. Vitest's fake timers mock `Date.now()` too, which the warm period reads.
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function Trigger({
  words,
  options,
  label = "Sort by name",
}: {
  words: React.ReactNode;
  options?: TooltipOptions;
  label?: string;
}) {
  const tip = useTooltip();
  return (
    <button type="button" {...tip(words, options)}>
      {label}
    </button>
  );
}

const mount = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);
const tooltip = () => screen.queryByRole("tooltip");
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("the tooltip", () => {
  it("waits out the delay before it opens", () => {
    mount(<Trigger words="Newest first" />);
    fireEvent.pointerEnter(screen.getByRole("button"));

    advance(TOOLTIP_OPEN_MS - 1);
    expect(tooltip()).toBeNull();

    advance(1);
    expect(tooltip()).toHaveTextContent("Newest first");
  });

  it("does not open at all when the pointer only passes over", () => {
    mount(<Trigger words="Newest first" />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS - 100);
    fireEvent.pointerLeave(button);
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).toBeNull();
  });

  it("closes when the pointer leaves", () => {
    mount(<Trigger words="Newest first" />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).not.toBeNull();

    fireEvent.pointerLeave(button);
    expect(tooltip()).toBeNull();
  });

  it("opens with no delay while it is still warm", () => {
    // Reading along a row of icon buttons should not cost the full delay per icon.
    mount(
      <>
        <Trigger words="Duplicate" label="one" />
        <Trigger words="Archive" label="two" />
      </>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "one" }));
    advance(TOOLTIP_OPEN_MS);
    fireEvent.pointerLeave(screen.getByRole("button", { name: "one" }));

    advance(TOOLTIP_WARM_MS - 50);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "two" }));
    expect(tooltip()).toHaveTextContent("Archive");
  });

  it("waits again once the warm period has passed", () => {
    mount(<Trigger words="Duplicate" label="one" />);
    const button = screen.getByRole("button", { name: "one" });
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    fireEvent.pointerLeave(button);

    advance(TOOLTIP_WARM_MS + 1);
    fireEvent.pointerEnter(button);
    expect(tooltip()).toBeNull();
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).not.toBeNull();
  });

  it("survives the pointer crossing the gap into an interactive panel", () => {
    mount(<Trigger words="Check the printing and re-add it" options={{ interactive: true }} />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    const panel = screen.getByRole("tooltip");

    fireEvent.pointerLeave(button);
    // Still on screen while the pointer is between the two.
    advance(TOOLTIP_BRIDGE_MS - 20);
    expect(tooltip()).not.toBeNull();

    fireEvent.pointerEnter(panel);
    advance(TOOLTIP_BRIDGE_MS * 4);
    expect(tooltip()).not.toBeNull();

    fireEvent.pointerLeave(panel);
    advance(TOOLTIP_BRIDGE_MS);
    expect(tooltip()).toBeNull();
  });

  it("takes the pointer's events only when it is interactive", () => {
    mount(<Trigger words="Game changer" />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);
    expect(screen.getByRole("tooltip")).toHaveClass("pointer-events-none");
  });

  it("closes on Escape and does not consume the press", () => {
    // **The press is not consumed on purpose.** A hint that appeared because a pointer drifted is
    // not a layer the reader navigated into, and one that called `preventDefault()` would swallow
    // the Escape meant for the dialog underneath it. That this leaves the dialog's own rung free
    // to act is a *ladder* claim and a synthetic `dispatchEvent` cannot prove it — it collapses
    // capture into registration order. The ladder is Task 8's live pass; this is the local half.
    mount(<Trigger words="Newest first" />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);

    const press = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void window.dispatchEvent(press));

    expect(tooltip()).toBeNull();
    expect(press.defaultPrevented).toBe(false);
  });

  it("closes when the page scrolls under it", () => {
    mount(<Trigger words="Newest first" />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);
    act(() => void window.dispatchEvent(new Event("scroll")));
    expect(tooltip()).toBeNull();
  });

  it("says nothing when the text it would show is not actually cut off", () => {
    mount(<Trigger words="Modern Horizons 3" options={{ whenClipped: true }} />);
    const button = screen.getByRole("button");
    // jsdom lays nothing out, so both are 0 and the text is by definition not clipped.
    expect(button.scrollWidth).toBe(button.clientWidth);
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).toBeNull();
  });

  it("says it when the text is cut off", () => {
    mount(<Trigger words="Modern Horizons 3" options={{ whenClipped: true }} />);
    const button = screen.getByRole("button");
    Object.defineProperty(button, "scrollWidth", { value: 200, configurable: true });
    Object.defineProperty(button, "clientWidth", { value: 100, configurable: true });
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).toHaveTextContent("Modern Horizons 3");
  });

  it("describes the control while it is open, and leaves it as it found it", () => {
    mount(<Trigger words="The cards a format's size rule counts" />);
    const button = screen.getByRole("button");
    expect(button).not.toHaveAttribute("aria-describedby");

    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    expect(button.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);

    fireEvent.pointerLeave(button);
    expect(button).not.toHaveAttribute("aria-describedby");
  });

  it("does not describe a control whose words are already its name", () => {
    mount(<Trigger words="Duplicate" options={{ describes: false }} />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    expect(button).not.toHaveAttribute("aria-describedby");
    // Nor is it in the accessibility tree twice.
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByText("Duplicate", { selector: "div" })).toHaveAttribute("aria-hidden", "true");
  });

  it("binds nothing at all when there are no words", () => {
    mount(<Trigger words={null} />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).toBeNull();
  });

  it("opens on focus with no delay", () => {
    // jsdom answers `true` to `:focus-visible` for any focused element, so this proves the focus
    // path opens and *not* that a mouse press is excluded from it. That half is Task 8's.
    mount(<Trigger words="Newest first" />);
    act(() => screen.getByRole("button").focus());
    expect(tooltip()).not.toBeNull();
  });

  it("is a no-op with no provider above it, rather than a crash", () => {
    // Every surface that binds a tooltip is also a story and a test that renders it alone; a
    // throw here would be `src/stories.test.tsx` red for everybody. `NO_MENU` in
    // `menu/useContextMenu.ts` made the same trade for the same reason.
    render(<Trigger words="Newest first" />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).toBeNull();
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```
npx vitest run src/components/tooltip/tooltip.test.tsx
```

Expected: FAIL — cannot resolve `./TooltipProvider`.

- [ ] **Step 4: Write `useTooltip.ts`**

```ts
import { createContext, useContext, useMemo, type FocusEventHandler, type PointerEventHandler, type ReactNode } from "react";
import type { TooltipSide } from "@/lib/tooltip";

export interface TooltipOptions {
  /** Preferred side. `placeTooltip` flips it when the window is in the way. Default `"top"`. */
  side?: TooltipSide;
  /**
   * The pointer may enter the panel and its text may be selected.
   *
   * A pointer affordance and nothing else — the panel never takes focus, so a keyboard reader
   * hears the words through `aria-describedby` and cannot select them. A panel Tab could reach
   * would need a rung on the dismissal ladder and a focus hand-back, at which point it has
   * stopped being a tooltip and is `AnchoredPopup`.
   */
  interactive?: boolean;
  /**
   * Open only when the anchor's own text is genuinely cut off — `scrollWidth > clientWidth`.
   *
   * For the largest group of call sites: a `truncate` cell whose tooltip is its own full text.
   * The measurement happens at pointer-enter and costs nothing until then, which is what makes
   * this free on four hundred virtualised rows. **Implies `describes: false`**: the text in the
   * DOM is complete and the accessibility tree already has all of it — only the paint is clipped,
   * so describing it would make a screen reader say the set name twice.
   */
  whenClipped?: boolean;
  /** Wire `aria-describedby` while open. Default `true`. */
  describes?: boolean;
}

/** What a bound element gets. Every field optional, so "no tooltip" is `{}`. */
export interface TooltipBinding {
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onBlur?: FocusEventHandler<HTMLElement>;
}

/** What the provider hands every surface. */
export interface TooltipApi {
  enter: (anchor: HTMLElement, content: ReactNode, options: TooltipOptions) => void;
  focus: (anchor: HTMLElement, content: ReactNode, options: TooltipOptions) => void;
  leave: (anchor: HTMLElement) => void;
}

/**
 * What a surface gets when nothing has mounted a `TooltipProvider` above it: no tooltip.
 *
 * **A no-op rather than a thrown "missing provider", and it is the same trade `NO_MENU` makes in
 * `menu/useContextMenu.ts`.** After the sweep, most surfaces in the app bind a tooltip, and every
 * one of them is also a Storybook story and a test that renders it on its own — so a throw here
 * would not be a helpful error at the one call site that forgot, it would be
 * `src/stories.test.tsx` red for everybody. The cost is that a forgotten provider is a hint that
 * never appears rather than a message saying why, which is why the two mounts that matter —
 * `src/App.tsx` and `.storybook/preview.tsx` — are pinned by `src/lib/tokens.test.ts`.
 */
const NO_TOOLTIP_API: TooltipApi = { enter: () => {}, focus: () => {}, leave: () => {} };

export const TooltipContext = createContext<TooltipApi>(NO_TOOLTIP_API);

/** Nothing bound, as one frozen object, so a re-render is not a new prop identity. */
const NO_BINDING: TooltipBinding = {};

export type TooltipBinder = (content: ReactNode, options?: TooltipOptions) => TooltipBinding;

/**
 * The one door a surface uses: `{...tip(words)}` on the element it already has.
 *
 * **The anchor is `event.currentTarget`, so there is no ref to merge and no wrapper element.**
 * That is the whole reason this is a spread rather than a `<Tooltip>` component: it cannot break a
 * `min-w-0` chain in a truncating flex cell or displace an absolutely positioned card corner, and
 * the edit at a call site is the one line the `title` attribute occupied.
 *
 * `content` of `null`, `undefined`, `false` or `""` binds nothing — the same shape as the
 * `title={… ?? undefined}` that nine sites in this app already used, and as `cond && "words"`.
 */
export function useTooltip(): TooltipBinder {
  const api = useContext(TooltipContext);
  return useMemo<TooltipBinder>(
    () => (content, options = {}) => {
      if (content === null || content === undefined || content === false || content === "") {
        return NO_BINDING;
      }
      return {
        onPointerEnter: (e) => api.enter(e.currentTarget, content, options),
        onPointerLeave: (e) => api.leave(e.currentTarget),
        onFocus: (e) => api.focus(e.currentTarget, content, options),
        onBlur: (e) => api.leave(e.currentTarget),
      };
    },
    [api],
  );
}
```

- [ ] **Step 5: Write `TooltipPanel.tsx`**

```tsx
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { motion } from "motion/react";
import { LAYER } from "@/lib/layers";
import { popup } from "@/lib/motion";
import { placeTooltip, type TooltipPlacement } from "@/lib/tooltip";
import { cn } from "@/lib/utils";
import type { OpenTooltip } from "./tooltipStore";

/** One panel, so one id — which is what `aria-describedby` on the anchor points at. */
export const TOOLTIP_PANEL_ID = "app-tooltip";

/**
 * The app's one tooltip, drawn.
 *
 * **`fixed`, and mounted at the app root by the provider** — which is what escapes the two things
 * that would otherwise clip it. A virtualised row is `position: absolute` *and* transformed, so it
 * caps every `z-index` inside it and becomes the containing block for every `fixed` descendant;
 * an `overflow-hidden` scroller cuts off anything anchored within it. A panel whose DOM node is
 * outside both needs neither a raised number nor `PrintingPreview`'s scroll-offset arithmetic.
 */
export function TooltipPanel({
  open,
  panelRef,
  onPointerEnter,
  onPointerLeave,
}: {
  open: OpenTooltip;
  /** Handed up to the provider, whose `pointerdown` listener must not dismiss a press *inside* it. */
  panelRef: RefObject<HTMLDivElement | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const measured = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);

  // A *layout* effect, so the panel is never painted at 0,0 on its way to the control it belongs
  // to — React flushes this and the re-render it schedules before the browser paints.
  // `offsetWidth`/`offsetHeight` rather than `getBoundingClientRect()`: they are the layout box
  // and ignore the entry animation's `scale`, which a rect taken in this same tick would be 4%
  // short of. `ContextMenu` measures itself the same way for the same reason.
  useLayoutEffect(() => {
    const el = measured.current;
    if (!el) return;
    panelRef.current = el;
    setPlacement(
      placeTooltip(
        open.anchor.getBoundingClientRect(),
        { width: el.offsetWidth, height: el.offsetHeight },
        open.side,
        {
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
        },
      ),
    );
    return () => {
      panelRef.current = null;
    };
  }, [open.openId, open.anchor, open.side, panelRef]);

  return (
    <motion.div
      {...popup}
      ref={measured}
      id={TOOLTIP_PANEL_ID}
      // A tooltip in the accessibility tree only when something is pointed at it. Where the words
      // are redundant — a clipped cell, a mark whose text is already visible — the panel is a
      // picture, and saying it again would be a screen reader repeating itself.
      role={open.describes ? "tooltip" : undefined}
      aria-hidden={open.describes ? undefined : true}
      onPointerEnter={open.interactive ? onPointerEnter : undefined}
      onPointerLeave={open.interactive ? onPointerLeave : undefined}
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        // The one frame before the layout effect lands. It never reaches a paint, but a panel
        // that did flash would flash at the top-left corner of the window, which is the one place
        // it is certainly wrong.
        visibility: placement === null ? "hidden" : undefined,
      }}
      className={cn(
        "fixed max-w-xs rounded-md border border-border bg-surface px-2 py-1",
        "text-xs text-text shadow-lg whitespace-pre-line",
        LAYER.tooltip,
        // Whole literals, chosen by the placement. See `lib/tooltip.ts`.
        placement?.origin,
        // A tooltip is not in the way of the thing it describes — unless the caller asked for one
        // whose text can be reached and copied.
        open.interactive ? "select-text" : "pointer-events-none select-none",
      )}
    >
      {open.content}
    </motion.div>
  );
}
```

- [ ] **Step 6: Write `TooltipProvider.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { useStore } from "zustand";
import { TooltipPanel, TOOLTIP_PANEL_ID } from "./TooltipPanel";
import { createTooltipStore } from "./tooltipStore";
import { TooltipContext, type TooltipApi, type TooltipOptions } from "./useTooltip";

/**
 * How long the pointer rests on a control before its tooltip opens, in ms.
 *
 * A timer, where almost nothing in this app has one, and it is allowed for `SUBMENU_HOVER_MS`'s
 * reason: **it is not a transition.** Nothing about the panel's *arrival* is decided here — that
 * is `popup`'s, and `MotionConfig` turns it down for a reader who asked the OS for less. All this
 * decides is when a pointer that is passing over a control becomes a pointer that is asking about
 * it. 400ms is a shade under Windows' own, which is what a reader's hand is calibrated to.
 */
export const TOOLTIP_OPEN_MS = 400;

/**
 * How long after one closes another opens with no delay at all.
 *
 * Reading along a row of icon buttons is one act, not six, and paying {@link TOOLTIP_OPEN_MS} per
 * icon makes the row feel stuck. Short enough that a pointer crossing the app on its way
 * somewhere else has gone cold by the time it arrives.
 */
export const TOOLTIP_WARM_MS = 300;

/**
 * How long an `interactive` panel outlives the pointer leaving its control.
 *
 * Exactly the gap the pointer has to cross — `TOOLTIP_GAP` in `lib/tooltip.ts` is 8px — and no
 * more. Long enough for a deliberate move into the panel, too short to leave a hint hanging over
 * the thing the reader has moved on to.
 */
export const TOOLTIP_BRIDGE_MS = 120;

export { TOOLTIP_PANEL_ID };

const clipped = (el: HTMLElement): boolean => el.scrollWidth > el.clientWidth;

/**
 * The app's one tooltip, and the door every surface opens it through.
 *
 * Three responsibilities and deliberately nothing else: it **holds the open tooltip** (in a store,
 * not in its own `useState` — see `tooltipStore.ts`, and note that a `useState` here would
 * re-render the whole app on every hover), it **owns every schedule** — the delay, the warm
 * period, the bridge — and it **renders at most one panel** as a sibling of whatever it wraps.
 *
 * ## Where it goes, and why that is not arbitrary
 *
 * Above `ContextMenuProvider` in `App.tsx`, for the reason that file's comment gives about
 * `CardToDeckProvider`: the menu provider draws its panel as a **sibling** of `children`, so a
 * context mounted inside it would be around every view and around none of the menu's own rows —
 * and a menu row that binds a tooltip would silently get the no-op API. Inside
 * `QueryClientProvider`, because a caller's `content` is rendered *here* and may be a component
 * that reads the cache.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createTooltipStore);
  // **This component re-renders on every open and every close, and that is not the cost the store
  // was avoiding.** `children` is the same element object it was handed last render, so React
  // bails out of those subtrees — nothing below here re-renders. What the store buys is that the
  // state does not live in `App.tsx`'s render, which is what would have made a hover re-render
  // every view in the window.
  const open = useStore(store, (s) => s.open);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef({ open: 0, close: 0, lastHiddenAt: 0 });

  const api = useMemo(() => {
    const clearOpenTimer = () => {
      if (timers.current.open) {
        clearTimeout(timers.current.open);
        timers.current.open = 0;
      }
    };
    const clearCloseTimer = () => {
      if (timers.current.close) {
        clearTimeout(timers.current.close);
        timers.current.close = 0;
      }
    };
    const show = (anchor: HTMLElement, content: ReactNode, options: TooltipOptions) => {
      store.getState().show({
        anchor,
        content,
        side: options.side ?? "top",
        interactive: options.interactive ?? false,
        // `whenClipped` wins: the anchor's own text is already complete in the accessibility
        // tree, so describing it would say the same words twice.
        describes: options.whenClipped ? false : (options.describes ?? true),
      });
    };
    const hideNow = () => {
      clearOpenTimer();
      clearCloseTimer();
      if (store.getState().open !== null) timers.current.lastHiddenAt = Date.now();
      store.getState().hideAny();
    };

    return {
      enter(anchor: HTMLElement, content: ReactNode, options: TooltipOptions) {
        if (options.whenClipped && !clipped(anchor)) return;
        clearOpenTimer();
        clearCloseTimer();
        if (Date.now() - timers.current.lastHiddenAt < TOOLTIP_WARM_MS) {
          show(anchor, content, options);
          return;
        }
        timers.current.open = window.setTimeout(() => {
          timers.current.open = 0;
          show(anchor, content, options);
        }, TOOLTIP_OPEN_MS);
      },
      focus(anchor: HTMLElement, content: ReactNode, options: TooltipOptions) {
        if (options.whenClipped && !clipped(anchor)) return;
        // A press should not pop a hint at a pointer user; a Tab onto the control should show one
        // at once. **jsdom answers `true` here for any focused element**, so the suite can prove
        // the focus path opens and not that a mouse press is excluded from it — that half is a
        // live pass.
        if (!anchor.matches(":focus-visible")) return;
        clearOpenTimer();
        clearCloseTimer();
        show(anchor, content, options);
      },
      leave(anchor: HTMLElement) {
        clearOpenTimer();
        const current = store.getState().open;
        if (current?.anchor !== anchor) return;
        if (current.interactive) {
          clearCloseTimer();
          timers.current.close = window.setTimeout(() => {
            timers.current.close = 0;
            hideNow();
          }, TOOLTIP_BRIDGE_MS);
          return;
        }
        hideNow();
      },
      /** The pointer made it into an interactive panel. */
      keep() {
        clearCloseTimer();
      },
      /** It left again. */
      release() {
        clearCloseTimer();
        timers.current.close = window.setTimeout(() => {
          timers.current.close = 0;
          hideNow();
        }, TOOLTIP_BRIDGE_MS);
      },
      hideNow,
    };
  }, [store]);

  // Every way a tooltip ends that is not the pointer leaving its control.
  useEffect(() => {
    const dismiss = () => api.hideNow();
    const onPointerDown = (e: PointerEvent) => {
      // A press inside an interactive panel is a reader starting a selection, not a reader moving
      // on. Everything else — including a press on the control itself — means they are done.
      if (panelRef.current?.contains(e.target as Node)) return;
      dismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // **No `preventDefault()`, and this deliberately does not join `useDismissOnEscape`'s
      // ladder.** That stack is for layers a reader navigated *into*, and its top token consumes
      // the press. A hint that appeared because a pointer drifted is not one of those, and one
      // that ate Escape would swallow the press meant for the dialog underneath it.
      if (e.key === "Escape") dismiss();
    };
    // Capture, because a scroll inside a scroller does not bubble to `window`.
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("dragstart", dismiss, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("dragstart", dismiss, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [api]);

  // `aria-describedby` is set on the anchor from here rather than by re-rendering the trigger:
  // four hundred table rows subscribing to a store to learn they are *not* the open one is exactly
  // the cost the single panel exists to avoid. React does not manage this attribute on these
  // elements, so it will not fight over it — and whatever was there is put back.
  useEffect(() => {
    if (open === null || !open.describes) return;
    const el = open.anchor;
    const previous = el.getAttribute("aria-describedby");
    el.setAttribute("aria-describedby", TOOLTIP_PANEL_ID);
    return () => {
      if (previous === null) el.removeAttribute("aria-describedby");
      else el.setAttribute("aria-describedby", previous);
    };
  }, [open]);

  // Every timer dropped with the provider, so a pending open cannot fire into an unmounted tree.
  useEffect(() => () => api.hideNow(), [api]);

  const value = useMemo<TooltipApi>(
    () => ({ enter: api.enter, focus: api.focus, leave: api.leave }),
    [api],
  );

  return (
    <TooltipContext.Provider value={value}>
      {children}
      {/* A constant key, so moving between two controls *moves* this panel rather than
          cross-fading one into another — and so there is structurally never a moment with two of
          them in the document. `ContextMenuProvider` renders its panel the same way. */}
      <AnimatePresence>
        {open !== null && (
          <TooltipPanel
            key="tooltip"
            open={open}
            panelRef={panelRef}
            onPointerEnter={api.keep}
            onPointerLeave={api.release}
          />
        )}
      </AnimatePresence>
    </TooltipContext.Provider>
  );
}
```

- [ ] **Step 7: Run the tests and confirm they pass**

```
npx vitest run src/components/tooltip/tooltip.test.tsx src/lib/layers.test.ts
```

Expected: PASS. If the `describes: false` case fails on the `getByText(..., { selector: "div" })`
query, read what the panel actually renders and fix **the query**, not the component — the
assertion's job is to prove the panel is `aria-hidden` and carries no `role`.

- [ ] **Step 8: Lint the new files**

```
npx eslint src/components/tooltip src/lib/tooltip.ts
```

Expected: no output. **`setState` inside a `useEffect` is a lint error in this repo** (it only
shows up here and at `npm run verify`, never in `tsc` or vitest). The panel's `setPlacement` is
inside a `useLayoutEffect`, which is the shape `PrintingPreview.tsx` already ships — if the rule
flags it anyway, the fix is to fold the placement into the state it derives from, never a
suppression.

- [ ] **Step 9: Commit**

```bash
git add src/components/tooltip src/lib/layers.ts
git commit -m "feat(tooltip): one provider, one panel, and the spread that binds a control"
```

---

## Task 4: Mount it — the app and the workbench

**Files:**
- Modify: `src/App.tsx`
- Modify: `.storybook/preview.tsx`
- Modify: `src/lib/tokens.test.ts`

**Interfaces:**
- Consumes: `TooltipProvider` from `@/components/tooltip/TooltipProvider`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/tokens.test.ts`:

```ts
/**
 * **The two mounts that make `useTooltip` do anything.**
 *
 * The hook falls back to a no-op API when no provider is above it — deliberately, because after
 * the sweep most surfaces bind a tooltip and every one of them is also a story and a test that
 * renders it alone, so a throw would be `stories.test.tsx` red for everybody. The cost of that
 * choice is that a dropped provider is *silent*: every hint in the app, or every hint in the
 * workbench, simply stops appearing. This is what makes it loud.
 */
describe("the tooltip provider is mounted where it has to be", () => {
  it("wraps the app", () => {
    const app = readFileSync(resolve(import.meta.dirname, "../App.tsx"), "utf8");
    expect(app).toContain("<TooltipProvider>");
  });

  it("wraps every story too", () => {
    const preview = readFileSync(
      resolve(import.meta.dirname, "../../.storybook/preview.tsx"),
      "utf8",
    );
    expect(preview).toContain("<TooltipProvider>");
  });
});
```

Match the file's existing import style for `readFileSync`/`resolve` — read the top of
`src/lib/tokens.test.ts` first and reuse whatever it already imports rather than adding a second
way of reading a file.

- [ ] **Step 2: Run it and confirm it fails**

```
npx vitest run src/lib/tokens.test.ts
```

Expected: FAIL, 2 tests — `expected '…' to contain '<TooltipProvider>'`.

- [ ] **Step 3: Mount it in `src/App.tsx`**

Import it beside the other component imports:

```tsx
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
```

and wrap `CardToDeckProvider` with it, inside `QueryClientProvider`:

```tsx
      <QueryClientProvider client={queryClient}>
        {/* **Above `ContextMenuProvider` for the reason `CardToDeckProvider` is**: that provider
            draws its panel as a *sibling* of `children`, so a context mounted inside it would be
            around every view and around none of the menu's own rows — and a menu row binding a
            tooltip would silently get the no-op API. Inside `QueryClientProvider`, because a
            caller's tooltip `content` is rendered here and may be a component that reads the
            cache. Nothing between here and the root transforms, which is what lets the panel be
            `fixed` against the window rather than against a virtualised row. */}
        <TooltipProvider>
          <CardToDeckProvider>
            …unchanged…
          </CardToDeckProvider>
        </TooltipProvider>
      </QueryClientProvider>
```

- [ ] **Step 4: Mount it in `.storybook/preview.tsx`**

Inside `withFake`, wrap the same way and in the same order — outside `CardToDeckProvider` and
`ContextMenuProvider`, inside `FakeWorld` (which supplies the `QueryClientProvider` they need).
Extend the existing comment there that explains the two menu providers, adding a sentence:

```
// `TooltipProvider` stands in for `src/App.tsx`'s the same way and sits outside both, for the
// reason that file gives: the menu provider draws its rows as a sibling of its children, so a
// tooltip context mounted inside it would not reach them.
```

- [ ] **Step 5: Run the tests and confirm they pass**

```
npx vitest run src/lib/tokens.test.ts src/components/tooltip
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx .storybook/preview.tsx src/lib/tokens.test.ts
git commit -m "feat(tooltip): mount the provider in the app and in the workbench"
```

---

## Task 5: The workbench entry

**Files:**
- Create: `src/components/tooltip/Tooltip.stories.tsx`

**Interfaces:**
- Consumes: `TooltipProvider`, `useTooltip`.
- Produces: nothing.

Read `.storybook/CLAUDE.md` before writing this. Follow `src/components/menu/ContextMenu.stories.tsx`'s
shape: a local `Stage` component is the `component:`, and a `fixed` panel needs
`docs: { story: { inline: false, height: "…" } }` so each docs story gets its own iframe rather
than drawing over the page.

- [ ] **Step 1: Write the story file**

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TooltipProvider, TOOLTIP_OPEN_MS } from "./TooltipProvider";
import { useTooltip, type TooltipOptions } from "./useTooltip";

/**
 * One control with a tooltip bound to it — the whole of what a call site does.
 *
 * The provider is mounted here as well as globally in `preview.tsx`, so that this file reads as
 * the documentation of how to use it rather than relying on a decorator the reader cannot see.
 */
function Stage({ words, options, label }: { words: string; options?: TooltipOptions; label: string }) {
  return (
    <TooltipProvider>
      <div className="grid min-h-[220px] place-items-center bg-bg p-8">
        <Control words={words} options={options} label={label} />
      </div>
    </TooltipProvider>
  );
}

function Control({ words, options, label }: { words: string; options?: TooltipOptions; label: string }) {
  const tip = useTooltip();
  return (
    <button
      type="button"
      className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text"
      {...tip(words, options)}
    >
      {label}
    </button>
  );
}

const meta = {
  title: "Primitives/Tooltip",
  component: Stage,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    docs: { story: { inline: false, height: "260px" } },
    description: {
      component:
        "The app's one tooltip. A single `fixed` panel mounted at the app root — outside every " +
        "transform and every clipped scroller, which is what lets it be shown from a virtualised " +
        "table row or from inside a modal without a raised z-index or any scroll arithmetic.\n\n" +
        "A call site binds it by spreading `useTooltip()`'s result onto the element it already " +
        "has: `<span {...tip(words)}>`. There is no wrapper element, so it cannot change a " +
        "layout.",
    },
  },
} satisfies Meta<typeof Stage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The ordinary one: a sentence describing a control that is already named. It opens after the
 * pointer has rested, and while it is open the control carries `aria-describedby`.
 */
export const Default: Story = {
  args: { label: "Size rule", words: "The cards a format's size rule counts.", options: {} },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "Size rule" });
    await userEvent.hover(button);
    const panel = await canvas.findByRole("tooltip", undefined, { timeout: TOOLTIP_OPEN_MS + 1000 });
    await expect(panel).toHaveTextContent("size rule counts");
    await expect(button).toHaveAttribute("aria-describedby", panel.id);
    await userEvent.unhover(button);
    await waitFor(async () => await expect(canvas.queryByRole("tooltip")).toBeNull());
  },
};

/**
 * A hint the reader is meant to act on, so the pointer can enter it and the text can be selected.
 * The panel takes its own pointer events; the default one does not.
 */
export const Interactive: Story = {
  args: {
    label: "Needs review",
    words: "Check the printing and re-add it, or remove this entry.",
    options: { interactive: true },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByRole("button", { name: "Needs review" }));
    const panel = await canvas.findByRole("tooltip", undefined, { timeout: TOOLTIP_OPEN_MS + 1000 });
    await expect(panel).toHaveClass("select-text");
    await expect(panel).not.toHaveClass("pointer-events-none");
  },
};

/**
 * The keyboard's half. A Tab onto the control opens it with no delay — there is no "resting" for
 * a caret, and a reader who has just arrived should not be made to wait.
 */
export const OnFocus: Story = {
  args: { label: "Newest first", words: "Sorted by release date, newest first.", options: {} },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole("button", { name: "Newest first" })).toHaveFocus();
    await expect(await canvas.findByRole("tooltip")).toHaveTextContent("release date");
  },
};

/**
 * The largest group of call sites: a clipped cell whose tooltip is its own full text. It says
 * nothing when the text is *not* cut off — which is most rows most of the time, and is why this
 * costs a virtualised table nothing.
 */
export const OnlyWhenClipped: Story = {
  args: {
    label: "A set name long enough to be cut off",
    words: "A set name long enough to be cut off",
    options: { whenClipped: true },
  },
};
```

- [ ] **Step 2: Run the story tests**

```
npx vitest run src/stories.test.tsx -t Tooltip
```

Expected: PASS. If `findByRole("tooltip")` times out, remember `MotionGlobalConfig.skipAnimations`
is on in the suite but the **open delay is a real timer** — the explicit `timeout` above is why.

- [ ] **Step 3: Commit**

```bash
git add src/components/tooltip/Tooltip.stories.tsx
git commit -m "docs(tooltip): the workbench entry, with the four shapes a call site uses"
```

---

## Task 6: Five proof call sites

Five, chosen so that every shape the sweep will need is proven once before ninety-odd sites are
converted onto it. **Update each site's tests in the same commit.**

**Files:**
- Modify: `src/components/table/SortableHeader.tsx` (~line 91)
- Modify: `src/features/collection/CollectionTable.tsx` (~lines 95, 117, 230)
- Modify: `src/features/decks/CategoriesDialog.tsx` (~line 450)
- Modify: whichever tests/stories query those sites by title (find them in Step 1)

**Interfaces:**
- Consumes: `useTooltip` from `@/components/tooltip/useTooltip`.
- Produces: nothing.

- [ ] **Step 1: Find what asserts on these titles today**

```
npx vitest run src/components/table src/features/collection src/features/decks/DeckDialog.test.tsx
```

and

```
grep -rn "ByTitle\|toHaveAttribute(\"title\"" src/components/table src/features/collection src/features/decks
```

Note what you find; those assertions move in Step 5.

- [ ] **Step 2: The multi-line hint on a named button — `SortableHeader.tsx`**

The button has visible text and an `aria-label` when the two differ, so the words here are a
**description**: the default. This is also the one site whose text contains a `\n`, which is what
the panel's `whitespace-pre-line` exists for.

Replace:

```tsx
        title={title ? `${title}\n${SORT_HINT(label)}` : SORT_HINT(label)}
```

with:

```tsx
        {...tip(title ? `${title}\n${SORT_HINT(label)}` : SORT_HINT(label))}
```

and add `const tip = useTooltip();` at the top of the component, with the import. Update the
comment above it — it currently explains why the `title` sits on the button rather than the cell,
and that reason is unchanged and still worth keeping; append that the two-line hint now needs the
panel's `whitespace-pre-line` to keep its break.

- [ ] **Step 3: The clipped cell and the already-labelled remove button — `CollectionTable.tsx`**

Three sites in one file, one of each kind.

**Line ~117, a truncated set name.** The full text is already in the accessibility tree — only the
paint is clipped — so this is `whenClipped`, which implies it does not describe:

```tsx
          <span className="truncate" {...tip(row.setName, { whenClipped: true })}>
```

(`row.setName` is `string | null`, and `tip(null)` binds nothing — the `?? undefined` the attribute
needed is gone.)

**Line ~95, the needs-review band.** This is both: a clipped sentence *and* one the reader is meant
to act on. The comment already there says the reconciler writes 130–190 characters "of which the
second half is what to do about it". So it is `whenClipped` **and** `interactive`, and it is the
site that proves selectable text is worth having:

```tsx
            <span
              {...tip(row.needsReview, { whenClipped: true, interactive: true })}
              className="absolute inset-x-3 bottom-0.5 truncate text-[0.7rem] text-dim"
            >
```

Extend the comment above it: the instruction can now be selected and copied rather than only read.

**Line ~230, the remove button.** It already has an `aria-label`, and the `title` repeats it in
shorter words — so this describes nothing and must not be announced twice:

```tsx
            {...tip("Remove from your collection", { describes: false })}
```

- [ ] **Step 4: The hint inside a modal — `CategoriesDialog.tsx`**

The drag handle sits inside a `DeckDialog`, which draws at `LAYER.overlay`. This is what proves
the `z-46` rung. It already has an `aria-label` naming the control, and the `title` explains how to
work it — two different sentences, so this one **does** describe:

```tsx
          {...tip("Drag to reorder, or press the up and down arrow keys")}
```

- [ ] **Step 5: Move the assertions**

Any test that did `getByTitle("Remove from your collection")` no longer has a `title` attribute to
find. Rewrite it as one of:

- `getByRole("button", { name: /Remove .* from your collection/ })` — preferred, and it was
  already the more honest query, since the `aria-label` is what a screen reader uses.
- Hover the control and assert on `findByRole("tooltip")` — only where the tooltip's *appearance*
  is the thing under test.

Do **not** keep a title-based query alive by adding a `title` back.

- [ ] **Step 6: Run every affected suite**

```
npx vitest run src/components/table src/features/collection src/features/decks src/components/tooltip
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src/components/table src/features/collection src/features/decks
git commit -m "feat(tooltip): move five hints off title, one of each shape"
```

---

## Task 7: The documentation

**Files:**
- Modify: `docs/reference/frontend-design.md`
- Modify: `src/CLAUDE.md`

- [ ] **Step 1: Add a section to `docs/reference/frontend-design.md`**

In the bullet list of binding rules, add an entry covering, in the file's own voice — a rule, then
the measurement or the failure that produced it:

- A hint is `useTooltip()`'s spread, never a `title` attribute and never an SVG `<title>`.
- The panel is one, `fixed`, at the app root, at `LAYER.tooltip` — and the reason is that a
  virtualised row is transformed, so it caps `z-index` *and* is the containing block for `fixed`.
- The three classifications from the spec's §4, with the measurement — **corrected at `e4fcf59`**,
  after Task 7 shipped and its review found the original script sliced each element at its first
  `>` (which truncates before `aria-label` on any button whose `onClick` is an arrow function): 28
  of 108 `title`s were on a button and 3 of those had no `aria-label`, and **none** of the three is
  icon-only — each already has its own visible text, and the `title` is a conditional description
  shown in one state. See the spec's §4/§7 for the two named sites this used to (wrongly) call
  icon-only, and for the two real SVG `<title>` elements (not eight — see Task 9).
- `whenClipped` never describes, because the DOM text is complete and only the paint is clipped.
- Escape closes it without consuming the press, and why it is not on the dismissal ladder.
- **`pointer-events` inherits, so a tooltip bound to anything inside a `pointer-events-none`
  subtree can never be shown** — unchanged from the `<title>` era, and worth restating at the new
  API, since it fails silently and no test can see it.

- [ ] **Step 2: Add the rule to `src/CLAUDE.md`**

One bullet in the "Binding rules" list, pointing at the reference section, in the file's style —
short, with the consequence rather than the API listing.

- [ ] **Step 3: Check the counts you just wrote down**

CLAUDE.md: *"a prose-only edit routes to neither CI job, so nothing goes red when a document
rots."* Re-run the inventory and make the numbers in the prose match it:

```
git rev-parse --short HEAD
```

and count with the script the spec used. Cite the sha beside the numbers.

- [ ] **Step 4: Commit**

```bash
git add docs/reference/frontend-design.md src/CLAUDE.md
git commit -m "docs(tooltip): the rule, the classifications, and the pointer-events trap"
```

---

## Task 8: Verify, drive the real window, and ship PR 1

- [ ] **Step 1: `npm run verify`**

```
npm run verify > verify.log 2>&1
```

then read the summary out of the file. **Do not pipe it to `tail`** — the exit code through a pipe
is the pipe's, and a failing run reads as green. Never run two verifies at once in this repo:
concurrent runs fake ~18 Rust schema failures.

- [ ] **Step 2: `cargo fmt` and `clippy`, which `verify` does not run**

```
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

No Rust changed in this PR, so both should be clean; they are the only reds a fully green `verify`
can still hide.

- [ ] **Step 3: The live pass**

Take the app lock and launch, per the `running-the-app` skill. Drive the window with
`scripts/cdp.mjs` — read `docs/reference/live-ui-verification.md` first; it documents traps that
have each cost a session. From a worktree, use the **PowerShell** tool for `cdp.mjs`, and note
that `click` is a no-op on a cold pointer, so `hover --rest 200` first; that a click and a read in
one `eval` answers about the frame *before* React re-rendered, so split them; and that every
binding in an `eval` needs wrapping in an IIFE, since the scope is shared between commands.

Check, and record what you saw:

1. **A tooltip inside a virtualised table row** (the collection's set-name cell) is not clipped by
   the scroller and is not painted under the sticky header.
2. **A tooltip inside a modal** (`CategoriesDialog`'s drag handle) paints over the scrim.
3. **The window edge** — hover a control in the rightmost column and confirm the panel is clamped
   inside the window rather than causing a horizontal scroll. Put `innerWidth` and `scrollWidth` in
   the same `eval` as the rect: a wide desk reads exactly like an overflow.
4. **The flip** — hover a control near the top of the window and confirm the panel opens downward.
5. **`:focus-visible` discrimination**, which jsdom cannot answer: *click* a control that has a
   tooltip and confirm no panel appears; then Tab to it and confirm one does.
6. **Escape** — open a `DeckDialog`, hover a control inside it until the tooltip shows, press
   Escape once, and confirm **the dialog closes**. This is the claim the unit test cannot make.
7. **Selecting text** — hover the collection's needs-review band, move the pointer into the panel,
   and confirm the panel survives the gap and the text can be selected.

- [ ] **Step 4: Release the lock and clean up**

```
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 release app
```

- [ ] **Step 5: Ship it**

Follow the `auto-pr` skill. Merge `main` in (never rebase), push, open the PR, arm auto-merge, and
watch for the only two states GitHub abandons — a real conflict and a red `ci-ok`. The agent does
not press Merge.

---

# PR 2 — the sweep

Branch off PR 1 once it has merged. Five agents, each given files no sibling touches.

## The recipe every sweep task follows

Read it in full; it is repeated in each task rather than cross-referenced, because a task may be
read on its own.

**For each `title=` attribute and each SVG `<title>` element in your files:**

1. **Decide whether it is a tooltip at all.** `DeckDialog`, `Notice`, `Figure`, `AppShell`,
   `ExportDialog`, `SettingsSection` and `CountTag` all take a `title` **prop**. A prop that the
   component draws as a heading is not a tooltip and is left alone. A prop that the component
   passes through to a DOM `title` attribute is converted **inside that component**, and the prop
   keeps its name.
2. **Classify it**, and let the classification choose the option:

   | The words are… | What you write |
   | --- | --- |
   | the element's **only** name — an icon-only button with no `aria-label` | add `aria-label={words}` **and** bind `{...tip(words, { describes: false })}` |
   | a **description** of an element that is already named | `{...tip(words)}` |
   | the **full text of a clipped cell** — a `truncate`/`text-ellipsis` element whose title is its own text | `{...tip(words, { whenClipped: true })}` |
   | **redundant** — already visible text, or already in an `aria-label` | `{...tip(words, { describes: false })}` |

3. **Add the hook** once per component: `const tip = useTooltip();` with
   `import { useTooltip } from "@/components/tooltip/useTooltip";`. A hook cannot be called
   conditionally; bind with `tip(maybeWords)` and let it return `{}` when the words are absent,
   rather than branching.
4. **An SVG `<title>` element** is deleted and the words bound on the element the pointer actually
   hits — usually the `<svg>` itself, sometimes its wrapper. **`pointer-events` inherits**: if that
   element is inside a `pointer-events-none` subtree the tooltip can never be shown, and nothing
   will go red. Check the wrapper before you move it. Keep whatever `aria-label` the glyph has and
   pass `describes: false`, since the label already says the words.
5. **Do not add a wrapper element.** The spread goes on the element that carried the attribute.
6. **Move any assertion that queried the title.** `getByTitle` matches both the attribute and an
   SVG `<title>` element. Rewrite as `getByRole(role, { name })` where the words were the
   accessible name, or as hover-then-`findByRole("tooltip")` where the tooltip's appearance is the
   thing under test. A greyed menu row's accessible name includes its reason, so use a regex there
   rather than an exact string.
7. **Run only your own files' tests.** `npm run verify` in a fanned-out agent compiles against a
   tree your siblings are still changing.
8. **Report** back: every file touched, the classification you gave each site, and any site you
   could not classify confidently.

**Added 2026-08-20, from the final review of PR 1:**

9. **A `disabled` control needs a look before it gets the mechanical swap.** `{...tip()}` binds
   `onPointerEnter`/`onPointerLeave`/`onFocus`/`onBlur`, and a `disabled` button fires none of
   those — so swapping its `title` for the spread makes the tooltip vanish with **nothing going
   red**: no test in this app can click through a `disabled` button to hover it, and the sweep's
   own recipe reads as satisfied either way. It is a real regression and not a no-op, because
   Chromium draws its native tooltip on a `disabled` button whether or not it is reachable by
   pointer events — the reader loses a hint they had. `FolderTree.tsx:552`
   (`<button disabled={...} title={submitLabel}>`) and `AllPrintingsDialog.tsx:270` are this
   shape and need reading, not just converting; the app's `aria-disabled` pattern
   (`DeckEditor.tsx:2808`, greyed rather than removed from the tab order) is unaffected, since
   `aria-disabled` alone still fires every event `tip()` binds to. Where a site is genuinely
   `disabled`, decide deliberately whether the hint is worth losing or the control is worth
   switching to `aria-disabled` — do not convert it silently.
10. **`{...tip()}` overwrites a handler written before it and loses to one written after, and
    that is a written rule now, not a bug to fix.** React last-write-wins on a duplicate prop key,
    so `{...tip(words)} onPointerEnter={somethingElse}` silently drops the tooltip's handler and
    `onPointerEnter={somethingElse} {...tip(words)}` silently drops the other one — whichever
    loses fails with no error and no red test. The reviewer checked all 108 sites in this sweep
    against every existing `onPointerEnter`/`onPointerLeave`/`onFocus`/`onBlur` in the same files
    and found **zero collisions today**, so nothing here needs an ordering fix — but the next
    hundred sites will include one eventually, and the fix when it happens is to compose the two
    handlers explicitly rather than to spread twice.
11. **Where the JSX is built by a plain function rather than a component, thread the binder as a
    parameter.** A hook cannot be called from a non-component helper, so a `title=` inside a
    `(row) => TableColumn` builder or similar cannot call `useTooltip()` itself. `CollectionTable.tsx`'s
    `columnsFor(onSetQuantity, onRemove, marketplace, tip)` is the pattern already in this
    codebase: the component calls `useTooltip()` once and passes the binder down, the helper
    spreads `tip(...)` at each cell it draws. Do not reach for a second hook call or a module-level
    workaround.

## Task 9: Sweep `src/components/` — 13 files, 24 sites

**Files (yours alone):** `AppShell.tsx`, `CardArt.tsx`, `CountTag.tsx`, `Figure.tsx`,
`FilterChips.tsx`, `FinishMark.tsx`, `GameChangerMark.tsx`, `OwnedBadge.tsx`, `RarityGem.tsx`,
`Ribbon.tsx`, `TitleBar.tsx`, `table/SortableHeader.tsx`, `table/VirtualTable.tsx` — plus their
own `.test.tsx` and `.stories.tsx`.

`SortableHeader.tsx` was converted in PR 1; check it and leave it.

**`TitleBar.tsx:56` was missing from every bucket until the final review of PR 1 caught it, and
it is worth more than one more site.** `CaptionButton`'s `title={label}` is ordinary and
redundant (the button already carries `aria-label={label}`, so `describes: false`), but its
anchors sit inside the 34px caption bar at the very top of the window — the only controls in this
app close enough to the top edge to force `placeTooltip`'s downward flip. PR 1's live pass could
check the flip's *sibling* claims (the clamp, the modal, the virtualised row) but had no anchor
near enough to the top to prove the flip itself; converting this site gives PR 2 one. Add it to
Task 14's live pass: hover a caption button and confirm the panel opens **downward** rather than
being clamped against — or clipped by — the window's top edge.

Note the two hard ones: **the two real SVG `<title>` elements are in your files** —
`FinishMark.tsx:49` and `GameChangerMark.tsx:62`, one each, not the "five" (or "eight" app-wide)
an earlier measurement claimed, which counted this codebase's own doc comments quoting `<title>`
in backticks alongside the rendered elements. `CardArt.tsx` has **no** `<title>` of its own to
convert — but it does render both glyphs, inside `FoilOverlay`'s marks chip, which is the
documented `pointer-events` case: the chip carries `pointer-events-auto` against its wrapper's
`none` precisely so those two glyphs can be hovered. Bind on the chip, not on the sheen.
`CountTag` and `Figure` take `title` **props** that they pass to a DOM attribute: convert inside
the component and keep the prop name.

Then: apply the recipe above, run `npx vitest run src/components`, commit.

## Task 10: Sweep `src/features/decks/` core — 11 files, ~28 sites

**Files (yours alone):** `CardMarks.tsx`, `CardStack.tsx`, `DeckCoverPicker.tsx`, `DeckEditor.tsx`,
`DeckSearchPanel.tsx`, `DeckStats.tsx`, `DeckTile.tsx`, `FolderCard.tsx`, `FolderTree.tsx`,
`QuickZones.tsx`, `ValidationPanel.tsx` — plus their own tests and stories.

`DeckTile.tsx` has four icon-only buttons in a row ("Move to a folder", "Duplicate", "Archive",
"Delete") — check each for an existing `aria-label` before choosing between the first and fourth
rows of the classification table.

Then: apply the recipe above, run `npx vitest run src/features/decks`, commit.

## Task 11: Sweep `src/features/decks/` dialogs and views — 14 files, ~30 sites

**Files (yours alone):** `CategoriesDialog.tsx`, `CreateDeckDialog.tsx`, `DeckDialog.tsx`,
`DeckHistoryDialog.tsx`, `DeckSettingsDialog.tsx`, `TagColorPicker.tsx`, `TagsDialog.tsx`,
`TheoryDiffDialog.tsx`, `export/ExportDialog.tsx`, `import/ImportDeckDialog.tsx`,
`views/GroupHeader.tsx`, `views/StackView.tsx`, `views/TableView.tsx`, `views/TextView.tsx` —
plus their own tests and stories.

Most of the `title=` in the dialogs are the **`DeckDialog` shell's `title` prop**, which the shell
draws as a heading — not tooltips, left alone. `CategoriesDialog`'s drag handle was converted in
PR 1; check it and leave it. `DeckHistoryDialog`'s `Notice title=` is likewise a prop.

**`TagColorPicker.tsx:79,210` was missing from every bucket until the final review of PR 1 caught
it, and both are real.** `TagColorButton`'s `title="Choose tag colour"` (line 79) and each swatch
button's `title={c.label}` (line 210) are both **redundant** — each already carries the matching
`aria-label`, so both bind `describes: false`. **`NewTagDialog.tsx:68`'s `title="New tag"` is not
one more site to add here** — it is a prop passed straight through to `DeckDialog`'s own `title`,
drawn as a heading, and needs no edit. It was missing from every bucket too, but unlike
`TagColorPicker.tsx` there was nothing to miss; this note exists only so nobody spends time
rediscovering that.

Then: apply the recipe above, run `npx vitest run src/features/decks`, commit.

## Task 12: Sweep `src/features/card/` and `src/features/search/` — 6 files, 15 sites

**Files (yours alone):** `card/AllPrintingsDialog.tsx`, `card/CardDetailPane.tsx`,
`card/PrintingsFilterBar.tsx`, `search/FilterBar.tsx`, `search/SearchPage.tsx`,
`search/SetCombobox.tsx` — plus their own tests and stories.

`CardDetailPane`'s three are all truncated set names — the `whenClipped` row. `SetCombobox` was
substantially rewritten on `main` very recently; re-read it rather than working from memory.

Then: apply the recipe above, run `npx vitest run src/features/card src/features/search`, commit.

## Task 13: Sweep `collection/`, `wishlist/` and `settings/` — 8 files, 16 sites

**Files (yours alone):** `collection/CollectionSummary.tsx`, `collection/CollectionTable.tsx`,
`settings/ErrorLogPanel.tsx`, `settings/MarketplacePanel.tsx`, `settings/UpdatePanel.tsx`,
`wishlist/WishlistGrid.tsx`, `wishlist/WishlistPage.tsx`, `wishlist/WishlistTable.tsx` — plus their
own tests and stories.

Three of `CollectionTable.tsx`'s four were converted in PR 1; check them and leave them. The one
left is `<abbr title={conditionLabel(row.condition)}>` at ~line 137, and it is **not** an ordinary
tooltip: on `<abbr>`, `title` is the standard expansion mechanism, and `aria-label` on a roleless
element is not reliably announced. Convert it to a visible abbreviation with an `sr-only`
expansion beside it plus `{...tip(conditionLabel(row.condition), { describes: false })}`, so the
expansion reaches assistive technology as text. Say so in a comment at the site.

`WishlistTable.tsx:212` is icon-only but **not** an only-name case — checked directly, it already
carries `` aria-label={`Remove ${wishLabel(row)} from your wishlist`} `` beside
`title="Remove from your wishlist"`, the same shape `CollectionTable.tsx`'s remove button had
before PR 1 converted it. It is the **redundant** row: bind
`{...tip("Remove from your wishlist", { describes: false })}` and leave the `aria-label` alone.

**Three more `settings/` files hold `title=` and none of it is yours to convert, so grepping the
directory will turn up sites that belong to no task.** `CachePanel.tsx:31` and
`DangerZonePanel.tsx:114` are `SettingsSection`'s own `title` prop, drawn as a heading.
`CachePanel.tsx:56` and `DangerZonePanel.tsx:162` are `ConfirmDialog`'s `title` prop, also a
heading (via `DeckDialog`). `ConfirmDialog.tsx:90` is that same prop drawn inside the component
itself. All five were missing from every task's file list, same as `TitleBar.tsx` and
`TagColorPicker.tsx` above — but unlike those two, there is nothing real underneath any of them.
This note is only so nobody re-derives that.

Then: apply the recipe above, run `npx vitest run src/features/collection src/features/wishlist src/features/settings`, commit.

## Task 14: Fan in, verify, drive the window, ship PR 2

- [ ] **Step 1: Confirm nothing is left**

```
grep -rn "\btitle=\|<title>" src --include=*.tsx | grep -v "\.test\.tsx\|\.stories\.tsx"
```

Every remaining hit must be a component `title` **prop** that is drawn as a heading. List them and
say why each stays.

- [ ] **Step 2: `npm run verify`**

```
npm run verify > verify.log 2>&1
```

Read the summary from the file, not through a pipe.

- [ ] **Step 3: A live pass over the surfaces the sweep touched**

The search wall, the collection table, the deck editor's stack view, the wishlist, and one dialog.
Confirm hints appear where they used to and that no surface shows the OS tooltip any more. A card
tile's corner marks are the place to check `pointer-events` — those were `<title>` elements inside
a chip that only works because it carries `pointer-events-auto`.

**Added 2026-08-20, from the final review of PR 1: the flip, at the one anchor that can prove
it.** Hover a caption button in the title bar (`TitleBar.tsx:56`, Task 9) and confirm the panel
opens **downward** — every other anchor in this app sits far enough from the top edge that
`placeTooltip` never has to flip a `"top"`-preferred tooltip, so PR 1's own live pass could not
prove this half of the placement arithmetic in the running window. This is the one check PR 1
left for PR 2.

- [ ] **Step 4: Ship it**

Follow the `auto-pr` skill.

---

## Self-review notes

Checked against the spec, 2026-08-20:

- §1 (nothing to install) → no task adds a dependency; the Global Constraints forbid it.
- §2 (provider, panel, layer, placement) → Tasks 1, 2, 3, 4.
- §3 (the binder, `whenClipped`) → Task 3 Step 4, tested in Task 3 Step 2.
- §4 (the a11y classification, SVG `<title>`, the `<abbr>`) → Task 6 proves each shape; Tasks 9–13
  apply them; the `<abbr>` is named in Task 13.
- §5 (behaviour, every dismissal, Escape, the bridge, focus-visible) → Task 3, with the two claims
  jsdom cannot make routed to Task 8's live pass.
- §6 (look) → Task 3 Step 5.
- §7 (inventory) → Tasks 9–13's file lists. **Corrected 2026-08-20, after the final review of
  PR 1**: the buckets as first written listed 50 files and claimed their site counts summed to
  110, which the final review found arithmetically false against this tree — a fresh count comes
  to **108 sites across 53 files**. The gap was three whole files the sweep never listed:
  `TitleBar.tsx` and `TagColorPicker.tsx` (real sites, now folded into Tasks 9 and 11) and, held
  apart from that count because they carry no convertible site at all, `NewTagDialog.tsx`,
  `CachePanel.tsx`, `ConfirmDialog.tsx` and `DangerZonePanel.tsx` (`title` **props** passed
  through to `DeckDialog`/`SettingsSection`/`ConfirmDialog`, noted at Tasks 11 and 13 so nobody
  re-derives that). There was no coincidence in the "110 either way" arithmetic the previous
  version of this note offered — it did not survive a re-count.
- §8 (verification) → Tasks 1, 2, 3, 5 for the suites; Task 8 for the window.
- §9 (delivery) → PR 1 = Tasks 1–8, PR 2 = Tasks 9–14.
- §10 (what it does not do) → nothing in the plan adds an arrow, a portal, a `popover`, a
  per-site delay, or a click trigger.

One thing this plan settles that the spec left open: **`useTooltip` falls back to a no-op API
rather than throwing when no provider is above it**, following `NO_MENU` in
`menu/useContextMenu.ts` — a throw would turn every isolated component test and every story into a
failure. The cost is a silent failure mode, which Task 4 pins with two sweeps in
`src/lib/tokens.test.ts`.
