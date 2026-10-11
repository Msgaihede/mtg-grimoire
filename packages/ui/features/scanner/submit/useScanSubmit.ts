import { useCallback, useRef, useState } from "react";
import type { ScanMode, ScannerStatus, ScannerVerdict } from "../types";
import type { ScanLoop } from "../useScanLoop";
import { scanStill, SUBMIT_LONG_EDGE, SUBMIT_QUALITY, type ScanStill } from "./still";
import { PICTURE_NOT_TAKEN } from "./submitText";

/** What a Scanner page gets back: the press, the dialog's one prop, and its two ways out. */
export interface ScanSubmit {
  /** The picture the dialog is open on, or `null` — which is the dialog closed. */
  still: ScanStill | null;
  /**
   * A press that got no picture, in a sentence — `null` otherwise, and again on the next press.
   * The page says it where it says a refused reset: a press that opened nothing and said nothing
   * is a button that looks broken.
   */
  error: string | null;
  /** *Send scan…*: grab the picture on screen and open the dialog on it. Handed the press. */
  open: (opener: HTMLElement) => void;
  /** Escape, the ✕, Cancel and Done: close, and hand the caret back to the press. */
  onDismiss: () => void;
  /** The scrim: close without moving the caret — the reader is already somewhere else. */
  onClose: () => void;
}

/**
 * *Send scan…*, for both Scanner pages: one press freezes the picture on screen and what the
 * scanner was saying about it, and a dialog asks the reader which card it really is.
 *
 * **The page's own idiom for a question** — `clearOpener` and `deckOpener` beside it: the state
 * that opens the dialog is the snapshot it is about, and the press that asked is kept for the
 * caret. Shared rather than written into each page because the two pages would otherwise have to
 * agree by hand about what a snapshot holds, and one of them is the phone's.
 *
 * **The scanner's half is read at the press, the picture a moment after.** `open` is rebuilt on
 * every render, so the `verdict` it closes over is the one the strip above the camera was drawn
 * from when the reader pressed; the grab then encodes whatever frame the video holds, which at
 * nine verdicts a second is that card. The encode is asynchronous and nothing here reads the
 * page again when it lands.
 *
 * **Nothing stops for it.** The camera and the pump run on behind the dialog exactly as they do
 * behind the tray's two questions, and cards go on landing in the tray. The still is a value in
 * state: no later verdict can reach it, and a second press cannot replace it — one is refused
 * while a grab is in flight and while a dialog is open, so the picture the reader is looking at
 * is the picture Send sends.
 *
 * Takes `grab` and `verdict` rather than the whole loop, so a page that has stopped recognising
 * can hand over `null` for a verdict the scanner is no longer standing behind: the loop keeps its
 * last answer across a Stop, and that answer was about a card that may since have been swapped.
 */
export function useScanSubmit({
  grab,
  verdict,
  mode,
  status,
}: {
  /** `useScanLoop`'s grab: one frame out of the video, or `null` when it has none to give. */
  grab: ScanLoop["grab"];
  /** What the scanner is saying now — `null` while it is saying nothing. */
  verdict: ScannerVerdict | null;
  mode: ScanMode;
  /** `useScannerStatus`' answer, or `null` before it has one. */
  status: ScannerStatus | null;
}): ScanSubmit {
  const [still, setStill] = useState<ScanStill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** A grab is being encoded. A ref: two presses can land inside one render. */
  const grabbing = useRef(false);

  const open = (from: HTMLElement) => {
    if (grabbing.current || still !== null) return;
    grabbing.current = true;
    opener.current = from;
    setError(null);
    grab(SUBMIT_LONG_EDGE, SUBMIT_QUALITY)
      .then((bytes) => {
        // No picture, no dialog: there would be nothing in it to check, and nothing to send.
        if (bytes === null) setError(PICTURE_NOT_TAKEN);
        else setStill(scanStill(bytes, verdict, mode, status));
      })
      // A canvas that would not draw or encode. The browser's own words for that are a
      // developer's; the reader is owed only that the press did not take.
      .catch(() => setError(PICTURE_NOT_TAKEN))
      .finally(() => {
        grabbing.current = false;
      });
  };

  // The two ways out are stable, which `open` cannot be: the dialog's body is memoised on them,
  // so the printings it has drawn are not drawn again for every verdict the page takes behind it.
  const onDismiss = useCallback(() => {
    setStill(null);
    opener.current?.focus();
  }, []);
  const onClose = useCallback(() => setStill(null), []);

  return { still, error, open, onDismiss, onClose };
}
