import { useEffect, useMemo, useState, type JSX } from "react";
import { Play, Square } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { PANEL_BUTTON, TOUCH_FLOOR } from "@/features/settings/controls";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import type { ScannerSubmissionFrame } from "../types";
import { PICTURE, pictureAlt, pictureLine, pictureOf, PLAY, STOP_PLAYING } from "./submitText";

/**
 * How long *Play* rests on each picture — about the scanner's own cadence, so the pictures go by
 * at roughly the rate they were taken and a reader sees the card laid down as the scanner did.
 * The real spacing is each frame's own; walking them evenly is a way of looking, not a replay.
 */
export const PLAY_STEP_MS = 110;

/**
 * The pictures of a scan, one at a time: the last by default, a slider through all of them, and
 * a press that walks them once.
 *
 * A reader is about to send every one of these and is asked to check them, so every one has to
 * be a thing they can stop on — which is the slider, a native range, because that is the control
 * a keyboard, a finger and a screen reader all already know how to step. **It rests on the last
 * picture**: that is the card the reader's answer names, and the one that was under the camera
 * when they pressed.
 *
 * **State of its own, and a component of its own for that.** Which picture is showing changes
 * nine times a second while *Play* runs, and the dialog around this holds up to two hundred card
 * pictures: kept here, a step redraws these few elements and nothing else.
 *
 * ## Out of the very text that is sent
 *
 * Each picture is `ScannerSubmissionFrame.jpeg` behind a `data:` scheme — the string the dialog
 * sends, not a second encode of the frame. A `data:` address and never an object URL: the shipped
 * policy's image sources allow the first on every host and the second on none. Bare image
 * elements, because these are camera frames, keyed on nothing and fetched from nowhere, and
 * `CardImage` is for a card's picture, which these are not.
 *
 * ## Every picture is mounted, and one is shown
 *
 * **So that a step never blanks the box.** One image element whose address is swapped leaves it
 * to the browser what is drawn while the new picture is made ready — and this dialog is drawn by
 * three hosts' browsers and whichever one a reader opens the web app in. A picture that was
 * mounted with the dialog has been taken in before it is first shown, so showing it is a matter
 * of un-hiding it. `decoding="sync"` is the other half, and `CardImage` records the measurement
 * behind it: asynchronous decoding lets the browser present the frame before the picture, which
 * is exactly the flash, once per picture on its first showing.
 *
 * Hidden by the `hidden` attribute, so the others are out of the accessibility tree as well as
 * off the screen — one picture has a name at a time. The cost is the run in the document: up to
 * twenty addresses, a couple of megabytes of text between them at the run's ceiling, for as long
 * as the dialog is open. The addresses are built once and kept, so a step hands the same twenty
 * strings back and nothing is compared by content. **Not seen in a window**: that a step does
 * not flash is this arrangement's reason, and a browser is where it is checked.
 *
 * ## *Play* is one pass, and not for everyone
 *
 * From the first picture to the last and then it stops — never a loop, and never by itself: a
 * dialog that opened already moving would be showing the reader something other than the picture
 * they are being asked about. Pressed again while it runs, it stops where it is. **A reader who
 * has asked for less motion is not offered it at all**: the pictures changing under a timer is
 * the motion they asked not to be shown, the slider reaches every picture without it, and a
 * press that could only refuse would owe them a sentence about their own settings.
 */
export function RunPictures({
  frames,
}: {
  /** The run, oldest first. Fixed for as long as this is mounted. */
  frames: readonly ScannerSubmissionFrame[];
}): JSX.Element | null {
  const reduced = useReducedMotion() === true;
  const last = frames.length - 1;
  // One value, so a tick moves the picture and ends the pass in one write.
  const [view, setView] = useState({ shown: last, playing: false });
  const urls = useMemo(
    () => frames.map((frame) => `data:image/jpeg;base64,${frame.jpeg}`),
    [frames],
  );

  useEffect(() => {
    if (!view.playing) return;
    const timer = setInterval(() => {
      setView((was) => {
        if (!was.playing) return was;
        const next = was.shown + 1;
        // The last picture ends the pass, and is where it is left.
        return next >= last ? { shown: last, playing: false } : { shown: next, playing: true };
      });
    }, PLAY_STEP_MS);
    return () => clearInterval(timer);
  }, [view.playing, last]);

  if (frames.length === 0) return null;
  const n = view.shown + 1;

  return (
    <div className="space-y-2">
      {/* On black, as the camera's own box is, and never cropped: the reader is asked to check
          what is in each picture, edges included.

          **A block in a block, and deliberately not a centring grid.** A picture is hundreds
          of pixels wide by nature and is held to its box by a percentage; in a grid with no
          stated column that percentage is of a track sized by the picture itself, which clamps
          nothing — the shell's own scrim records that trap, measured. Here the containing block
          is the scroller's column, whose width is settled before the picture is asked, so both
          ceilings bind and the ratio is kept.

          **Shorter where the dialog is the whole screen** (below the shell's own 640px turn): a
          phone held upright takes an upright picture, and at the taller ceiling it left the
          printings a strip to be chosen in. */}
      <div className="overflow-hidden rounded-lg bg-black">
        {urls.map((url, index) => (
          <img
            // By position: the run does not change under this component.
            key={index}
            hidden={index !== view.shown}
            src={url}
            alt={pictureAlt(index + 1, frames.length)}
            decoding="sync"
            className="mx-auto block max-h-48 max-w-full object-contain sm:max-h-64"
          />
        ))}
      </div>

      <div className="flex items-center gap-2">
        {!reduced && (
          <button
            type="button"
            onClick={() =>
              setView((was) =>
                // Mid-pass it stops where it is; otherwise it starts over from the first.
                was.playing ? { ...was, playing: false } : { shown: 0, playing: true },
              )
            }
            className={cn(
              PANEL_BUTTON,
              // A width of its own, so the slider beside it does not change length with the word.
              "min-w-[4.75rem] justify-center border-border text-dim hover:text-text",
            )}
          >
            {view.playing ? (
              <Square aria-hidden="true" className="size-3.5" />
            ) : (
              <Play aria-hidden="true" className="size-3.5" />
            )}
            {view.playing ? STOP_PLAYING : PLAY}
          </button>
        )}
        <input
          type="range"
          min={1}
          max={frames.length}
          step={1}
          value={n}
          aria-label={PICTURE}
          // The position, spoken as what it is: "7" off a track of eighteen says nothing a
          // reader can check a picture by.
          aria-valuetext={pictureOf(n, frames.length)}
          // A hand on the slider is the reader choosing a picture: the pass ends there.
          onChange={(e) => setView({ shown: Number(e.target.value) - 1, playing: false })}
          className={cn("min-w-0 flex-1 accent-accent", TOUCH_FLOOR, FOCUS)}
        />
      </div>

      {/* Not a live region: the slider says its own value as it moves, and a pass would have this
          line announce every picture it went through. */}
      <p className="text-xs text-dim">{pictureLine(n, frames.length, frames[view.shown].ms)}</p>
    </div>
  );
}
