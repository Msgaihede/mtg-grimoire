import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import {
  SNAP_BUTTON_ID,
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onSnapHover,
  onWindowResized,
  toggleMaximizeWindow,
} from "@/lib/window";
import { cn } from "@/lib/utils";

/** 34px. Windows' own caption is 32 and VS Code's is 35; this sits between them, and the
 *  number is here rather than inline because the snap overlay's rectangle is derived from
 *  this element's box and a change to it moves a native child window. */
const BAR_H = "h-[34px]";

/**
 * A caption button: 46px wide, full-height, square, flush to the window's edge.
 *
 * **The one control family in this app that is not a rounded 8px chip with a press-scale**,
 * and every departure is deliberate. A radius would put a gap of window between the button and
 * the corner it must occupy, so a click landing on the last pixel of the screen — the whole
 * point of a corner button, and Fitts's law's oldest example — would miss. `PRESS`'s
 * `active:scale-[0.97]` is left off for the neighbouring reason: a target that shrinks away
 * from the pointer at the moment of the press reads as a misclick, and at the screen's edge
 * the reader has nowhere to correct to.
 *
 * The focus ring is `ring-inset` for the same geometry: an outset ring on an element flush
 * with the window's top-right corner is drawn outside the window and simply is not there.
 */
function CaptionButton({
  label,
  Icon,
  onSelect,
  id,
  danger = false,
  forceHover = false,
}: {
  label: string;
  Icon: typeof Minus;
  onSelect: () => void;
  id?: string;
  /** Close. The only red control in the chrome, and it fills rather than tints. */
  danger?: boolean;
  /** Draw the hover state regardless of the pointer — see {@link TitleBar}'s snap overlay. */
  forceHover?: boolean;
}) {
  const tip = useTooltip();
  return (
    <button
      type="button"
      id={id}
      onClick={onSelect}
      aria-label={label}
      // `describes: false`: `label` is this button's whole `aria-label` already, so a wired
      // `aria-describedby` would have a screen reader hear "Minimize, Minimize". This is also
      // the one anchor in the app pinned to the window's top edge, so its tooltip is the one
      // `placeTooltip` always has to flip downward rather than open above the window.
      {...tip(label, { describes: false })}
      className={cn(
        "inline-flex h-full w-[46px] shrink-0 items-center justify-center",
        "text-dim transition-colors duration-150 motion-reduce:transition-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
        danger ? "hover:bg-destructive hover:text-white" : "hover:bg-accent/10 hover:text-accent",
        // The same two declarations the `hover:` variants carry, applied by state instead of
        // by the pointer. Tailwind cannot express "hover, or this flag", so the flag restates
        // them — and they are restated rather than extracted because a shared constant would
        // put the danger/normal branch in two places.
        forceHover && (danger ? "bg-destructive text-white" : "bg-accent/10 text-accent"),
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

/**
 * The window's own title bar, drawn by the app rather than by Windows.
 *
 * `decorations: false` in `tauri.conf.json` is what makes this necessary rather than
 * decorative: with the native caption gone, this row is the only way to move, maximize or
 * close the window, so a failure here is an app the reader cannot put down. That is the
 * argument for the wrapper in `src/lib/window.ts` and for this component being testable at
 * all.
 *
 * **The wordmark is here because it stopped being anywhere else.** `Ribbon` drew a dim `MTG`
 * and said why in a comment — "the window title bar already says that in full" — which was
 * true of Windows' caption and is now this component's job. So the mark moved up and grew to
 * the full name, and the ribbon's first slot is the view title.
 *
 * **Three drag regions, not one.** `data-tauri-drag-region` does not inherit: Tauri reads it
 * off the element under the pointer and nothing else, so a child without it is a hole in the
 * grab area. The row carries it (that is the empty middle), and so does the wordmark. The
 * buttons deliberately do not — a drag region swallows the click.
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  // Whether the pointer is inside the native Snap Layouts overlay. See `SNAP_HOVER_EVENTS`:
  // on Windows 11 the maximize button is underneath a transparent Win32 child window, so its
  // CSS `:hover` never fires and this is the only signal that the pointer is on it.
  const [snapHover, setSnapHover] = useState(false);

  useEffect(() => {
    let live = true;
    const read = () => {
      void isWindowMaximized().then((next) => {
        if (live) setMaximized(next);
      });
    };
    read();
    // Every resize, not just a maximize — there is no `onMaximized`. Re-reading rather than
    // toggling is what keeps an edge-drag from flipping the glyph to the wrong one.
    const stop = onWindowResized(read);
    return () => {
      live = false;
      void stop.then((off) => off());
    };
  }, []);

  useEffect(() => {
    const stop = onSnapHover(setSnapHover);
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex shrink-0 items-center justify-between border-b border-border bg-surface pl-4",
        BAR_H,
      )}
    >
      {/* Cinzel, and the one place in the chrome it is allowed below 18px — see the note in
          `index.css`, which fences the display face at "never below 18px, which is the whole
          of Cinzel's brief". A caption bar is 34px tall and a 20px wordmark in it leaves 7px
          above and below, so the rule and the row cannot both be honoured. What pays for the
          exception is that this is a *wordmark* rather than a title: it is the product's name
          in its own face, set once, never read as interface text, and `tracking-[0.2em]` is
          what keeps it legible at 13px where Cinzel's thin strokes would otherwise close up.
          `select-none` because a title bar the reader can accidentally highlight while
          dragging the window is a title bar that fights them. */}
      <span
        data-tauri-drag-region
        className="select-none font-heading text-[13px] leading-none tracking-[0.2em] text-dim"
      >
        MTG GRIMOIRE
      </span>

      <div className="flex h-full shrink-0">
        <CaptionButton label="Minimize" Icon={Minus} onSelect={() => void minimizeWindow()} />
        {/* `id` is read by the native overlay, which finds this button by DOM id and parks
            itself over its rectangle. The constant is shared with the Rust side through
            `SNAP_BUTTON_ID` because a mismatch fails silently in both directions.

            **Two glyphs, one lucide family**: `Square` is one frame, `Copy` is two offset
            frames — the same 24-grid and the same 2px round-cap stroke as every other icon in
            this app, which is what "restore" has meant since Windows 3.1 drawn in the set the
            sidebar and the ribbon already use. */}
        <CaptionButton
          id={SNAP_BUTTON_ID}
          label={maximized ? "Restore Down" : "Maximize"}
          Icon={maximized ? Copy : Square}
          forceHover={snapHover}
          onSelect={() => void toggleMaximizeWindow()}
        />
        <CaptionButton label="Close" Icon={X} danger onSelect={() => void closeWindow()} />
      </div>
    </div>
  );
}
