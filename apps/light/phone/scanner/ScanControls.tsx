import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { Crosshair, Play, SlidersHorizontal, Square } from "lucide-react";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { PRESS } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";

/** The bar's box for a press: the touch floor, a hairline, the page's own type. */
const CONTROL = cn(
  "inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border",
  "px-3 text-sm text-text",
  PRESS,
  FOCUS,
);

/**
 * The reader's controls over the camera, a thumb's size: whether the scanner is reading, and the
 * way into everything else.
 *
 * **The desktop's bar in the phone's idiom** (`ScanBar`): its four popovers are anchored panels
 * 256–300px wide and its hints are tooltips, neither of which a finger at 360px has. So the bar
 * keeps the one thing a reader changes mid-pile — *Stop* — and one `Options` press opens a sheet
 * for the rest (`OptionsSheet`), where each hint is a sentence under its name rather than a hover.
 *
 * **Start and Stop are the desktop's own**, to the word (issue #774): Stop pauses recognition and
 * keeps the picture and the tray; Start resumes on the same stream.
 */
export function ScanControls({
  scanning,
  onScanning,
  pointAndShoot,
  shooting,
  onHold,
  onTap,
  onOptions,
}: {
  scanning: boolean;
  onScanning: (scanning: boolean) => void;
  /** Point and shoot is on: *Scan*, held, is drawn where Start and Stop were. */
  pointAndShoot: boolean;
  /** A shot is running. */
  shooting: boolean;
  /** `true` as a finger (or Space) goes down on *Scan*, `false` as it lifts or is taken away. */
  onHold: (held: boolean) => void;
  /** A press with no finger behind it — assistive tech's activation, or Enter: one card's shot. */
  onTap: () => void;
  /** Open the options sheet. Handed the press, for the caret to come back to. */
  onOptions: (opener: HTMLElement) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {pointAndShoot ? (
        <HoldToScan shooting={shooting} onHold={onHold} onTap={onTap} />
      ) : (
        <button type="button" onClick={() => onScanning(!scanning)} className={CONTROL}>
          {scanning ? (
            <Square aria-hidden className="size-3.5" />
          ) : (
            <Play aria-hidden className="size-3.5" />
          )}
          {scanning ? "Stop scanning" : "Start scanning"}
        </button>
      )}

      {/* At the row's end: the one way into everything else, where a thumb finds it. */}
      <button
        type="button"
        aria-label="Scanner options"
        aria-haspopup="dialog"
        onClick={(e) => onOptions(e.currentTarget)}
        className={cn(CONTROL, "ml-auto w-11 px-0")}
      >
        <SlidersHorizontal aria-hidden className="size-4" />
      </button>
    </div>
  );
}

/**
 * *Scan*, held: point and shoot on this face — the scanner reads while a finger is on the button
 * and pauses the moment it lifts (the owner's decision, 2026-10-22). A phone is held in one hand
 * and the cards fed with the other, so the thumb that steadies the phone is the trigger.
 *
 * **The one hold in this face** (`apps/light/CLAUDE.md`'s *no long-press* is about a row's
 * actions, which stay a visible `⋯`): the press is drawn and named, and the sentence over the
 * picture says to hold it. So the platform's own long press is kept off it — no context menu, no
 * text selection, no scroll or zoom starting under the finger (`touch-none`).
 *
 * **The finger is captured**, so a thumb that slides off the button while it holds still ends the
 * shot when it lifts, and a cancel (the system taking the touch, a call coming in) ends it too.
 *
 * **A keyboard holds Space**, as a pointer holds the button. Enter, and an assistive tech's
 * activation — a click no pointer went down for (`detail === 0`) — cannot hold, so each is one
 * card's shot instead (`onTap`), ended by the card or by the same press again.
 */
function HoldToScan({
  shooting,
  onHold,
  onTap,
}: {
  shooting: boolean;
  onHold: (held: boolean) => void;
  onTap: () => void;
}) {
  const down = (e: PointerEvent<HTMLButtonElement>) => {
    // The primary button only: a right press is not a hold.
    if (e.button > 0) return;
    // jsdom has no pointer capture; a browser without it still ends on the button's own `up`.
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
      aria-pressed={shooting}
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
      className={cn(
        CONTROL,
        "touch-none select-none px-5",
        shooting
          ? "border-accent bg-accent font-medium text-accent-fg"
          : "border-accent text-accent",
      )}
    >
      <Crosshair aria-hidden className="size-4" />
      Scan
    </button>
  );
}
