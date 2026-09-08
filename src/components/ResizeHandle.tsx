import { useRef, type ReactElement } from "react";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

/** How far one arrow press moves the edge. A pointer drags continuously; a caret needs a step
 *  big enough to be worth pressing and small enough to aim with. */
export const RESIZE_STEP_PX = 24;

export interface ResizeHandleProps {
  /** The id of the element this splitter sizes — the `aria-controls` target. */
  controls: string;
  /**
   * What is being resized, as the reader would name it — `card search`, `folders`.
   *
   * The accessible name is `Resize ${label}`, spelled here rather than taken whole so that a
   * caller cannot hand this a name that says something other than what pulling it does.
   */
  label: string;
  /** The panel's **drawn** width in px: `aria-valuenow`, and what both a drag and a key press
   *  are measured from. */
  width: number;
  /**
   * The narrowest the panel may be dragged, in px — `aria-valuemin`, and where Home lands.
   *
   * A prop rather than a constant in here, which is the whole of what made this component
   * shareable: each surface measures its own floor from what one of its rows or tiles actually
   * holds, and a splitter that knew one number could only ever serve the panel it was written
   * for.
   */
  min: number;
  /** The widest, in px — `aria-valuemax`, and where End lands. The page's measurement: it is what
   *  holds the row this panel is docked in. */
  max: number;
  /**
   * Which edge of the row the panel is docked against.
   *
   * It flips exactly three things and nothing else: which side of the panel the strip is drawn
   * over, which way the pointer moves to widen, and which arrow key does. Everything else — the
   * role, the value, the capture, the grip — is the same control either way.
   */
  side: "left" | "right";
  onResize: (width: number) => void;
}

/**
 * A docked panel's inner edge, as something to pull on.
 *
 * A `separator` with a `tabIndex` and a value, which is the ARIA window-splitter pattern: the
 * pointer path and the keyboard path are one control rather than a drag with a settings dialog
 * beside it for anyone who cannot perform one. `aria-valuenow` is the width in px — the unit the
 * reader is actually choosing, and the one the page's cap is expressed in — so a screen reader
 * announcing "206" is announcing the same number the panel is drawn at.
 *
 * **Absolutely positioned over the hairline, not a flex item beside it.** A docked panel is a
 * `flex-col`, so a child of it would be one row's worth of grab strip at the top of a
 * several-hundred-pixel edge. It straddles the border instead — 9px wide, 4px of it out in the
 * row's own gap and the rest over the panel's padding — which is Fitts' law rather than taste: a
 * 1px hairline is not a target, and every pixel of the strip that is *outside* the panel is a
 * pixel the reader can overshoot into without hitting the list.
 *
 * **Pointer capture rather than window listeners**, which is what makes the drag survive the
 * pointer leaving the strip — and it will, immediately, because the strip moves with the edge
 * and the hand does not track it exactly. Capture also ends the drag correctly when the pointer
 * is released outside the window, where a `pointerup` listener on `window` hears nothing.
 *
 * The grip is drawn only on hover and focus. At rest this edge is the hairline the panel already
 * had — the one piece of chrome it adds — and a permanent handle down it would be a second line
 * saying the same thing, on the border this app spent a lot of care making quiet.
 *
 * **It was `CardSearchPanel`'s own, and the extraction changed nothing about it but a prop**
 * (2026-09-08). The deck gallery's folder tree wanted the same gesture on the other edge of the
 * page, and copying a splitter is the mistake this repo has already made and undone twice — a
 * resemblance is N independent decisions that happen to agree today. {@link ResizeHandleProps.side}
 * is the difference between the two, {@link ResizeHandleProps.min} is what the floor stopped
 * being a constant for, and every other line here is the search column's, verbatim.
 */
export function ResizeHandle({
  controls,
  label,
  width,
  min,
  max,
  side,
  onResize,
}: ResizeHandleProps): ReactElement {
  // Where the drag started, in both senses. `null` is "not dragging", which is also what a
  // `pointermove` over an idle handle has to be told.
  const from = useRef<{ x: number; width: number } | null>(null);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-controls={controls}
      // Named for what pulling it does, not for what it is: "separator" is the role's job and
      // "Resize card search" is the reader's.
      aria-label={`Resize ${label}`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        // The primary button only: a right-press opening a context menu mid-drag would leave the
        // capture on and the panel following the pointer with nothing held down.
        if (e.button !== 0) return;
        e.preventDefault();
        from.current = { x: e.clientX, width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const start = from.current;
        if (!start) return;
        // Away from the edge the panel is docked against is wider — leftward for a panel docked
        // right, rightward for one docked left — because that is its edge moving into the row.
        onResize(
          side === "right"
            ? start.width + (start.x - e.clientX)
            : start.width + (e.clientX - start.x),
        );
      }}
      onPointerUp={(e) => {
        from.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      // A cancelled pointer — the OS taking the gesture, a touch turning into a scroll — is an
      // ended drag and not a dropped one. Without this the handle stays armed and the next
      // ordinary move over it resizes the panel.
      onPointerCancel={() => {
        from.current = null;
      }}
      onKeyDown={(e) => {
        // The key moves the *separator*, which is what the role says this is, rather than moving
        // a value that happens to be a width — so it matches the pointer on whichever edge the
        // panel is docked against. Docked right, Left widens and Right narrows; docked left, it
        // is the other way round, and a reader who has learnt one has learnt the other. Home and
        // End are the two ends of the same range and do not turn over with the side.
        const wider = side === "right" ? "ArrowLeft" : "ArrowRight";
        const narrower = side === "right" ? "ArrowRight" : "ArrowLeft";
        const next =
          e.key === wider
            ? width + RESIZE_STEP_PX
            : e.key === narrower
              ? width - RESIZE_STEP_PX
              : e.key === "Home"
                ? min
                : e.key === "End"
                  ? max
                  : null;
        if (next === null) return;
        // The arrows scroll the page otherwise, and Home and End take it to its ends.
        e.preventDefault();
        onResize(next);
      }}
      // `touch-none` so a drag on a touch screen is a drag rather than the browser deciding
      // partway through that it was a scroll and cancelling the pointer.
      className={cn(
        // No z-index, and none is owed: the strip lives in the panel's own padding and the row's
        // gap, where nothing else in that column paints. `LAYER` is the only place a z-index may
        // come from in this app, and asking it for one here would be asking for a rung this
        // element does not need.
        "group absolute inset-y-0 flex w-[9px] cursor-col-resize touch-none items-center justify-center",
        // The strip straddles the panel's *inner* edge — the one the reader can pull — which is
        // the left edge of a panel docked right and the right edge of one docked left. Both
        // spellings are written out because Tailwind scans source text for whole class names and
        // emits nothing at all for one built by interpolation.
        side === "right" ? "-left-1" : "-right-1",
        FOCUS,
      )}
    >
      {/* The grip: three columns of nothing, drawn as one 2px line the height of a fingertip.
          `bg-border` at rest under the pointer and `bg-accent` while the caret is on it, so the
          keyboard's own state is visible on a control whose whole affordance is otherwise a
          cursor change. */}
      <span
        aria-hidden="true"
        className={cn(
          "h-8 w-0.5 rounded-full bg-border opacity-0",
          "transition-opacity duration-150 motion-reduce:transition-none",
          "group-hover:opacity-100 group-focus-visible:bg-accent group-focus-visible:opacity-100",
        )}
      />
    </div>
  );
}
