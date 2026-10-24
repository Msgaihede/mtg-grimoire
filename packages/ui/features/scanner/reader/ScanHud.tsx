/**
 * What the Scanner draws **on** the camera picture rather than above it: how close the scanner is
 * to a card, the two presses a reader reaches for mid-pile, and the one error it has to say.
 *
 * The redesign's replacement for the old Match strip above the camera: its pill, name and
 * sentence are gone from view — the Added popup names the card that landed — and what is left is
 * a 4px bar along the picture's top edge, the presses in its top-right corner and a chip under
 * the bar at the top-left. **The strip's accessibility arrangement carried over unchanged**: the
 * same `Scanner status` live region, always mounted and now visually hidden, the leaning leader
 * kept out of what it announces, and the bar and the presses outside it.
 */
import { RotateCcw, Send } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { SEND_SCAN } from "../submit/submitText";
import type { StripState } from "./readerText";

/** Reset's words, which are its accessible name in both shapes. */
const RESET_EVIDENCE = "Reset evidence";

/**
 * Both presses' ground: the page's own colour, a little see-through, with a hairline — legible
 * over a white card and over a dark mat alike. **`pointer-events-auto`** because the layer they
 * sit in lets every other press through to the picture.
 */
const PRESS_GROUND = cn(
  "pointer-events-auto inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-bg/80 text-text hover:bg-bg",
  PRESS,
  FOCUS,
);

/** The desktop's shape: a 38px pill holding its glyph and its words. */
const LABELLED_PRESS = cn(PRESS_GROUND, "h-9.5 gap-1.5 px-3.5 text-[13px]");

/** The phone's: a 44px round glyph under a thumb, its words its accessible name. */
const ICON_PRESS = cn(PRESS_GROUND, "size-11");

export interface ScanHudProps {
  /** Everything the strip would have said — `matchStrip`'s value, which this draws and announces. */
  strip: StripState;
  /**
   * Recognition is running on a live picture. Off, there is nothing being matched: no bar, and an
   * empty announcement — the picture's own notes (`PictureNotes`) say why.
   */
  live: boolean;
  /**
   * How the presses are drawn: `labelled` (glyph and words, the desktop's camera column) or `icon`
   * (a 44px round glyph named by `aria-label`, the phone's picture).
   */
  variant: "labelled" | "icon";
  /**
   * *Reset evidence* — throw away what the scanner is holding, so the next card is weighed from
   * nothing (issue #740). **Absent draws no button**: the page decides where it is offered.
   */
  onReset?: () => void;
  /**
   * *Send scan…*, handed the press for the caret to come back to when the dialog closes (issue
   * #776). **Absent where the page does not offer it, and then no button is drawn** — the page's
   * three conditions (a run to send, the Scanner view itself, a supporter's device) are its own,
   * and of the last nothing is ever said: no greyed press, no hint, no name for what is missing.
   */
  onSend?: (opener: HTMLElement) => void;
  /**
   * What else the picture has to say — a refused frame or reset, a *Send scan…* pressed too soon —
   * or `null`. **The strip's own error outranks it**: a recogniser that is not loaded is the
   * reason every other sentence is moot.
   */
  note?: string | null;
  /**
   * What the picture says at its top centre — the desktop's point and shoot pill between shots
   * (`ShotReadyPill`) — or nothing. **Drawn in the HUD's own top flow, under the corner row**, so
   * it can never run under a press or the chip however narrow the column: centred on its own over
   * a 22rem column, the 274px pill met the 143px *Reset evidence* below a 584px column.
   */
  notice?: ReactNode;
}

/**
 * Laid over the camera box, which the page makes `relative` and the size of the picture: one
 * `absolute inset-0` layer that **lets every press through** but its two buttons — so on the
 * phone, where under point and shoot the picture itself is held, the layer is no dead spot over
 * it — and that sits on {@link LAYER.raised}, so its buttons stay above a hold surface laid over
 * the same box.
 *
 * **The live region is always mounted** and named `Scanner status`, as the strip's row was, so a
 * screen reader is watching it before the first card lands. **The leader is in it and not
 * announced** while the agreement is still weighing (`aria-hidden` on the name and printing): it
 * can change from one frame to the next, and a region re-reading every flip would bury "hold
 * steady". **The bar is outside it** — its value moves on almost every frame — and so are the
 * presses, because a button is not news.
 *
 * **The note chip's region is always mounted too, and only its words come and go**: a region
 * that first appears with its sentence already inside announces nothing.
 *
 * **The bar's fill is a transform, not a width**: its value moves on almost every frame, and a
 * `scaleX` from the left edge is composited where a width would lay the box out again each time.
 */
export function ScanHud({
  strip,
  live,
  variant,
  onReset,
  onSend,
  note = null,
  notice = null,
}: ScanHudProps) {
  const leaning = strip.tone === "progress";
  const hidden = leaning ? true : undefined;
  const chip = strip.tone === "error" ? strip.sentence : note;
  const labelled = variant === "labelled";

  return (
    <div className={cn("pointer-events-none absolute inset-0", LAYER.raised)}>
      {live && (
        <div
          role="progressbar"
          aria-label="Match progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(strip.fill * 100)}
          className="absolute inset-x-0 top-0 h-1 bg-bg/40"
        >
          <div
            className={cn(
              "h-full origin-left transition-transform motion-reduce:transition-none",
              strip.committed ? "bg-accent" : "bg-dim",
            )}
            style={{ transform: `scaleX(${strip.fill})` }}
          />
        </div>
      )}

      {/* The `{" "}`s keep the region's text from reading `MatchedStorm of SarumanLTR 72` as
          run-together words; `aria-atomic` is what `role="status"` implies, spelled out. */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label="Scanner status"
        className="sr-only"
      >
        {live && (
          <>
            <span>{strip.word}</span>{" "}
            {strip.name !== null && (
              <>
                <span aria-hidden={hidden}>{strip.name}</span>{" "}
              </>
            )}
            {strip.printing !== null && (
              <>
                <span aria-hidden={hidden}>{strip.printing}</span>{" "}
              </>
            )}
            <span>{strip.sentence}</span>
          </>
        )}
      </p>

      {/* The top of the picture under the bar, in one flow: the corner row, then the page's
          notice — which so stands below whatever that row holds, and never under it. */}
      <div data-hud-top="" className="absolute inset-x-3 top-3 flex flex-col gap-2">
        {/* The corner row: the presses against the right edge, the chip in what they leave and
            wrapping in it, so a long sentence never runs under a button. **Reversed and
            wrapping, the presses first**: where the room beside them is under the chip's 12rem
            (both labelled presses leave it 47px in a 22rem column), the chip drops to a row of
            its own under them rather than stand a word to a line. An empty chip asks for no room,
            so it never wraps a row of nothing. */}
        <div data-hud-corner="" className="flex flex-row-reverse flex-wrap items-start gap-2">
          {(onReset !== undefined || onSend !== undefined) && (
            <div className="flex shrink-0 items-center gap-2">
              {onReset !== undefined && (
                <CornerPress
                  words={RESET_EVIDENCE}
                  glyph={<RotateCcw aria-hidden className="size-4" />}
                  labelled={labelled}
                  onClick={onReset}
                />
              )}
              {onSend !== undefined && (
                <CornerPress
                  words={SEND_SCAN}
                  glyph={<Send aria-hidden className="size-4" />}
                  labelled={labelled}
                  opensDialog
                  onClick={(e) => onSend(e.currentTarget)}
                />
              )}
            </div>
          )}
          <p role="alert" className={cn("min-w-0 grow", chip !== null && "basis-48")}>
            {chip !== null && (
              // An error may carry a path, which is one unbreakable word.
              <span className="inline-block max-w-full rounded bg-bg/85 px-2 py-1 text-xs leading-snug break-words text-text">
                {chip}
              </span>
            )}
          </p>
        </div>
        {notice}
      </div>
    </div>
  );
}

/**
 * One corner press in the HUD's shape. Labelled, its words are drawn beside the glyph and are its
 * name. As an icon the words are the accessible name and the pointer's hint (`describes: false`,
 * since the name already says them) — the phone's arrangement too; a finger sees
 * neither, and the glyph is the one a reader already knows from the desktop.
 */
function CornerPress({
  words,
  glyph,
  labelled,
  opensDialog = false,
  onClick,
}: {
  words: string;
  glyph: ReactNode;
  labelled: boolean;
  /** The press opens a dialog — *Send scan…*'s. */
  opensDialog?: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const tip = useTooltip();
  return (
    <button
      type="button"
      aria-haspopup={opensDialog ? "dialog" : undefined}
      aria-label={labelled ? undefined : words}
      {...(labelled ? {} : tip(words, { describes: false }))}
      onClick={onClick}
      className={labelled ? LABELLED_PRESS : ICON_PRESS}
    >
      {glyph}
      {labelled && words}
    </button>
  );
}
