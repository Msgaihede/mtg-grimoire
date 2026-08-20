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
