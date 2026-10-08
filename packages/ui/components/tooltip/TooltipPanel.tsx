import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
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
 * outside both needs neither a raised number nor the scroll-offset arithmetic a panel anchored
 * *inside* a scroller is forced into — which is what the docked pane's `PrintingPreview` did,
 * until it was deleted with that pane on 2026-09-03.
 */
export function TooltipPanel({
  open,
  panelRef,
  onPointerEnter,
  onPointerLeave,
  onAnchorGone,
}: {
  open: OpenTooltip;
  /** Handed up to the provider, whose `pointerdown` listener must not dismiss a press *inside* it. */
  panelRef: RefObject<HTMLDivElement | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  /**
   * The anchor is no longer in the document — either by the time this panel goes to measure it
   * (a race `TooltipProvider`'s own delayed-open guard cannot close by itself, since `show()` can
   * write the store in the same tick an unrelated unmount takes the anchor out from under it), or
   * some time after, while the panel is already showing (see the `MutationObserver` effect
   * below). Called instead of computing a placement, or in place of the `pointerleave` that a
   * detached node can never dispatch; the caller closes the tooltip.
   */
  onAnchorGone: () => void;
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
    // `getBoundingClientRect()` on a detached node answers all zeros, which `placeTooltip` reads
    // as "does not fit either way": it flips to the opposite side and clamps to the window's
    // corner — a hint pinned at (8, 8), attached to nothing. This is the one place every open
    // measures, so it is the one place that can catch a doomed anchor before painting there.
    if (!open.anchor.isConnected) {
      onAnchorGone();
      return;
    }
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
  }, [open.openId, open.anchor, open.side, panelRef, onAnchorGone]);

  // The layout effect above catches a doomed anchor **once, at the moment this panel (re)opens or
  // re-measures** — it has no reason to run again, and does not, while the panel just sits open
  // showing the same anchor. That is precisely the gap the review named: a filter chip a cleared
  // filter drops, a deck tile a mutation deletes, a row a background refetch no longer returns —
  // none of those press a key, scroll, or resize the window, and a delegated `pointerleave` on a
  // control that already left the tree never dispatches at all, so nothing tells this panel its
  // anchor is gone and it hangs until the reader happens to do one of those things anyway.
  //
  // A `MutationObserver` is the reliable trigger, not merely a likely one: it is the platform API
  // built to fire on exactly this — a node leaving the document — so unlike the two alternatives,
  // it does not trade reliability for a bound. A low-frequency poll only narrows the average wait
  // to its interval, and it still needs a timer running for as long as a tooltip is open, which
  // this avoids. Folding the check into an event the app already receives while a tooltip is open
  // is what the finding already ruled out by naming this case: a background removal fires none of
  // scroll, resize, a press, or Escape, so there is no existing event to fold it into. The
  // callback re-checks `isConnected` rather than reading the mutation record, because what
  // disconnects the anchor is often a `childList` change to one of its *ancestors* — the anchor
  // itself is never touched — so the record's own target and `removedNodes` do not reliably name
  // it; `isConnected` is a live, O(1) answer to the only question that matters.
  //
  // `document.body` with `subtree: true` is the narrowest root that is guaranteed to see every
  // removal in the app, because the anchor can sit anywhere in it and there is no stable ancestor
  // in between to observe instead. That sounds broader than it is: a `MutationObserver` coalesces
  // every mutation between two microtask checkpoints into one callback, so a virtualised list
  // re-rendering many rows under an open tooltip still costs one callback and one boolean read,
  // not one per row. And the entire cost lives and dies with the panel — created here, on mount,
  // and disconnected in this effect's cleanup on every close — so a hover surface with nothing
  // open pays nothing at all, which is the one constraint every version of this guard has to hold.
  useEffect(() => {
    // Nothing to watch for an anchor the layout effect above has already reported as gone (it
    // will unmount this panel before this effect would matter); and no repeat work needed here
    // when only `openId` or `side` changed on the *same* still-connected anchor.
    if (!open.anchor.isConnected) return;
    const observer = new MutationObserver(() => {
      if (!open.anchor.isConnected) onAnchorGone();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open.anchor, onAnchorGone]);

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
