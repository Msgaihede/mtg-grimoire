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
  // `openFor` is the anchor a pending *open* timer was armed for — tracked separately from the
  // store's `open`, because the whole point of the delay is that nothing is open yet while it is
  // ticking. `leave(anchor)` needs to know whether *this* anchor is the one waiting, and the
  // store can't answer that; see the comment on `leave` below.
  const timers = useRef({ open: 0, openFor: null as HTMLElement | null, close: 0, lastHiddenAt: 0 });

  const api = useMemo(() => {
    const clearOpenTimer = () => {
      if (timers.current.open) {
        clearTimeout(timers.current.open);
        timers.current.open = 0;
      }
      timers.current.openFor = null;
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
        const current = store.getState().open;
        // A *different* control's tooltip is showing — this pointer has moved on from it, so it
        // closes now rather than riding out a bridge timer that was armed for somewhere else.
        // Left alone, an interactive panel's close timer just got cancelled with nothing to
        // re-arm it: the anchor guard in `leave` below only fires `hideNow` for the anchor that
        // is actually open, and by the time this pointer leaves *this* control, the store still
        // names the old one — so `leave` here would return early and strand it on screen with no
        // timer pending. The same anchor reopening (the pointer back on its own trigger from an
        // interactive panel) is not that case: it just cancels the pending close and keeps
        // showing, which is `clearCloseTimer` alone.
        if (current !== null && current.anchor !== anchor) {
          hideNow();
        } else {
          clearCloseTimer();
        }
        if (Date.now() - timers.current.lastHiddenAt < TOOLTIP_WARM_MS) {
          show(anchor, content, options);
          return;
        }
        timers.current.openFor = anchor;
        timers.current.open = window.setTimeout(() => {
          timers.current.open = 0;
          timers.current.openFor = null;
          // The anchor can leave the DOM during the delay — a filter chip the reader's next
          // keystroke removes, a deck tile a mutation deletes — and there is nothing to arm the
          // tooltip *for* any more. `PrintingPreview`'s dwell timer takes the same guard for the
          // same reason: measuring a detached node answers all zeros, and a hint that opens at
          // the window's corner attached to nothing is worse than one that never opens.
          if (!anchor.isConnected) return;
          show(anchor, content, options);
        }, TOOLTIP_OPEN_MS);
      },
      focus(anchor: HTMLElement, content: ReactNode, options: TooltipOptions) {
        if (options.whenClipped && !clipped(anchor)) return;
        // A press should not pop a hint at a pointer user; a Tab onto the control should show one
        // at once. **jsdom 30 implements a real focus-visible modality**, not a blanket "true for
        // any focused element": a bare `.focus()` with nothing else in the window's history
        // answers `true`, but a `pointerenter` or a `mousedown` anywhere in the window turns it
        // `false` for every focus after it, until a `keydown` restores it. That is a real enough
        // signal for the suite to prove the mouse-press exclusion directly, not just the open
        // path — see `tooltip.test.tsx`.
        if (!anchor.matches(":focus-visible")) return;
        clearOpenTimer();
        clearCloseTimer();
        show(anchor, content, options);
      },
      leave(anchor: HTMLElement) {
        // Only clears a pending *open* if it was armed for **this** anchor. The store has no
        // opinion yet — nothing is open while the delay is ticking — so the guard below (which
        // reads the store) cannot stand in for this one: a leave that arrives before the delay
        // elapses would otherwise find `store.getState().open` still `null`, fail that guard, and
        // return having left the timer armed, which is exactly the bug an earlier version of this
        // fix had ("does not open at all when the pointer only passes over" caught it).
        if (timers.current.openFor === anchor) clearOpenTimer();
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
            onAnchorGone={api.hideNow}
          />
        )}
      </AnimatePresence>
    </TooltipContext.Provider>
  );
}
