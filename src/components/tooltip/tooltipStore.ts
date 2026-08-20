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
   * Close whatever is open — a scroll, a resize, a press, Escape, or the pointer leaving the
   * control that is actually showing.
   *
   * **There is deliberately no anchor-guarded `hide(anchor)`.** Two controls a pixel apart in a
   * table row produce `enter(B)` before `leave(A)`, and a `leave` that closed unconditionally
   * would take B's tooltip away the instant it appeared — but `TooltipProvider.leave` already
   * guards against exactly that, by anchor, before it ever calls down to the store
   * (`if (current?.anchor !== anchor) return;`). A second guard here would be a second place
   * carrying the same rule, one of them unreachable.
   */
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
  createStore<TooltipState>((set, get) => {
    // **Outside `open`, so it survives a close.** An id that restarted at 1 on every reopen would
    // collide with the id the panel last measured for: `TooltipPanel` is rendered under a constant
    // key inside `AnimatePresence` and its measuring layout effect keys on this, so a reopen on the
    // same control while the exit fade is still running would leave the panel holding a measurement
    // it never re-took. Monotonic here means the panel never has to reason about that.
    let opens = 0;
    return {
      open: null,
      show: (next) => {
        opens += 1;
        set({ open: { ...next, openId: opens } });
      },
      // The `!== null` check is not a micro-optimisation: `hideAny` is called from a capture-phase
      // `scroll` listener, i.e. on every frame of every scroll in the app. Writing `null` over
      // `null` would notify every subscriber each time.
      hideAny: () => {
        if (get().open !== null) set({ open: null });
      },
    };
  });
