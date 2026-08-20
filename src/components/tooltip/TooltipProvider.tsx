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
