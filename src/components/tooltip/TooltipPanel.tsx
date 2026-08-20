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
