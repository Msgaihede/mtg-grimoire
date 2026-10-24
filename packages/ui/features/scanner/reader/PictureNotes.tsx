/**
 * What the camera picture says about itself while it is not reading — stopped, between two shots,
 * waiting for a finger — and while a finger holds it. Both Scanner surfaces draw these over their
 * camera box, which the page makes `relative` and the size of the picture.
 *
 * **Every one of them lets a press through** (`pointer-events-none`): under the phone's point and
 * shoot the picture itself is what a finger holds, and a note that caught the touch would be a
 * dead spot in the middle of it. None takes a `LAYER` rung either; DOM order puts each over the
 * video and the detector's overlay, and the HUD's presses (`ScanHud`) stay above them.
 *
 * Three of the four are `role="status"`: each stands where the one stopped sentence under the
 * camera used to, and says what the reader is to do next. The held chip says only what the reader
 * is already doing with their finger, so it is drawn and not announced as news.
 */
import { Crosshair, Hand } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  HOLD_NOTE,
  HOLD_TITLE,
  SCANNING_CHIP,
  SHOT_READY_CLICK,
  STOPPED_NOTE,
  STOPPED_TITLE,
} from "./readerText";

/**
 * Continuous and not scanning: the picture dims behind a centred "Scanning stopped" and the press
 * that begins it. **The camera stays on** — the veil is a wash of the page's ground over a live
 * picture, so a reader can still line a card up before pressing Start.
 */
export function StoppedVeil() {
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-bg/70 p-6 text-center"
    >
      <p className="font-heading text-xl leading-tight text-text">{STOPPED_TITLE}</p>
      <p className="text-sm text-dim">{STOPPED_NOTE}</p>
    </div>
  );
}

/**
 * Point and shoot between two shots, on the desktop: a pill at the top centre naming the press
 * that takes the next one. Over the picture rather than dimming it — between shots the reader is
 * lining the next card up, and wants to see it.
 */
export function ShotReadyPill() {
  return (
    <p
      role="status"
      className="pointer-events-none absolute inset-x-0 top-4 flex justify-center px-3"
    >
      <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-bg/80 px-3.5 py-1.5 text-[13px] text-text">
        <Crosshair aria-hidden className="size-4 shrink-0 text-accent" />
        {SHOT_READY_CLICK}
      </span>
    </p>
  );
}

/**
 * Point and shoot on the phone, before a hold: at the foot of the picture, how the picture itself
 * is pressed. `compact` is the picture on a phone on its side, which is short: the glyph rides on
 * the title's line rather than above it, and the type steps down.
 */
export function HoldPrompt({ compact = false }: { compact?: boolean }) {
  return (
    <div
      role="status"
      className={cn(
        "pointer-events-none absolute inset-x-0 flex justify-center px-4",
        compact ? "bottom-3" : "bottom-5",
      )}
    >
      <div
        className={cn(
          "flex max-w-full flex-col items-center rounded-lg border border-border bg-bg/80 text-center",
          compact ? "gap-0.5 px-3 py-2" : "gap-1 px-4 py-3",
        )}
      >
        {compact ? (
          <p className="flex items-center gap-1.5 text-[15px] font-medium text-text">
            <Hand aria-hidden className="size-4 shrink-0 text-accent" />
            {HOLD_TITLE}
          </p>
        ) : (
          <>
            <Hand aria-hidden className="size-6 text-accent" />
            <p className="text-base font-medium text-text">{HOLD_TITLE}</p>
          </>
        )}
        <p className={cn("text-dim", compact ? "text-xs" : "text-[13px]")}>{HOLD_NOTE}</p>
      </div>
    </div>
  );
}

/** While a finger holds the picture: a gold chip at the top centre, a dot and "Scanning". */
export function HeldChip() {
  return (
    <p className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-fg">
        <span aria-hidden className="size-1.5 rounded-full bg-accent-fg" />
        {SCANNING_CHIP}
      </span>
    </p>
  );
}
