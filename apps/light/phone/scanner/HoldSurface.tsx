import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { FOCUS_INSET } from "@grimoire/ui/lib/focus";
import { cn } from "@grimoire/ui/lib/utils";

/**
 * The picture itself, held: point and shoot on the phone — the scanner reads while a finger is on
 * the picture and pauses the moment it lifts (the owner's decisions, 2026-10-22 and the scanner
 * redesign, 2026-10-24). A phone is held in one hand and the cards fed with the other, and the
 * picture is the biggest thing on the page for a thumb to find without looking.
 *
 * **A transparent button laid over the whole camera box**, under the HUD's presses (`ScanHud`
 * sits on `LAYER.raised`, this on no rung at all) and over the picture's notes, which let every
 * press through. What the picture says before and during a hold is the page's to draw
 * (`HoldPrompt`, `HeldChip`); this draws nothing but the keyboard's focus outline, inside its own
 * edge because the box clips it (`FOCUS_INSET`).
 *
 * **Named and pressed, never a bare gesture**: `Hold to scan` is its accessible name and
 * `aria-pressed` says a hold is running — the gold chip over the picture is drawn for the eye and
 * is not announced. So the platform's own long press is kept off it — no context menu, no text
 * selection, no scroll or zoom starting under the finger (`touch-none`).
 *
 * **The finger is captured**, so a thumb that slides off the picture while it holds still ends
 * the shot when it lifts, and a cancel (the system taking the touch, a call coming in) or the
 * capture being lost ends it too; so does the focus leaving it (a sheet opening over the page).
 * The page ends a hold for everything that pauses the pump besides (`usePointAndShoot`'s
 * `interrupted`).
 *
 * **A keyboard holds Space**, as a pointer holds the picture. Enter, and an assistive tech's
 * activation — a click no pointer went down for (`detail === 0`) — cannot hold, so each is one
 * card's shot instead (`onTap`), ended by the card or by the same press again.
 */
export function HoldSurface({
  shooting,
  onHold,
  onTap,
}: {
  /** A shot is running. */
  shooting: boolean;
  /** `true` as a finger (or Space) goes down on the picture, `false` as it lifts or is taken away. */
  onHold: (held: boolean) => void;
  /** A press with no finger behind it — assistive tech's activation, or Enter: one card's shot. */
  onTap: () => void;
}) {
  const down = (e: PointerEvent<HTMLButtonElement>) => {
    // The primary button only: a right press is not a hold.
    if (e.button > 0) return;
    // jsdom has no pointer capture; a browser without it still ends on the surface's own `up`.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onHold(true);
  };
  const up = () => onHold(false);
  // Space's own click on release would read as a tap; the hold was the whole of it.
  const spaced = useRef(false);
  const key = (e: KeyboardEvent<HTMLButtonElement>, held: boolean) => {
    if (e.key !== " ") {
      // Space's click may never have come (a browser that took the `preventDefault`).
      spaced.current = false;
      return;
    }
    e.preventDefault();
    if (held && e.repeat) return;
    spaced.current = !held;
    onHold(held);
  };
  return (
    <button
      type="button"
      aria-label="Hold to scan"
      aria-pressed={shooting}
      data-hold-surface=""
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onKeyDown={(e) => key(e, true)}
      onKeyUp={(e) => key(e, false)}
      onBlur={up}
      onClick={(e) => {
        const space = spaced.current;
        spaced.current = false;
        if (e.detail === 0 && !space) onTap();
      }}
      onContextMenu={(e) => e.preventDefault()}
      className={cn("absolute inset-0 touch-none rounded-lg select-none", FOCUS_INSET)}
    />
  );
}
