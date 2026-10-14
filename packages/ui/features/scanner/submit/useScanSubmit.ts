import { useCallback, useRef, useState } from "react";
import type { ScanFilters, ScanMode, ScannerStatus, ScannerVerdict } from "../types";
import type { ScanLoop } from "../useScanLoop";
import { RUN_MIN_FRAMES, runAtPress, runClock, scanRun, type ScanRun } from "./run";
import { SCAN_TOO_SHORT } from "./submitText";

/** What a Scanner page gets back: the press, the dialog's one prop, and its two ways out. */
export interface ScanSubmit {
  /** The run the dialog is open on, or `null` — which is the dialog closed. */
  run: ScanRun | null;
  /**
   * A press that came too soon to have a scan to send, in a sentence — `null` otherwise, and
   * again on the next press. The page says it where it says a refused reset: a press that opened
   * nothing and said nothing is a button that looks broken.
   */
  error: string | null;
  /** *Send scan…*: freeze the run as it stands and open the dialog on it. Handed the press. */
  open: (opener: HTMLElement) => void;
  /** Escape, the ✕, Cancel and Done: close, and hand the caret back to the press. */
  onDismiss: () => void;
  /** The scrim: close without moving the caret — the reader is already somewhere else. */
  onClose: () => void;
}

/**
 * *Send scan…*, for both Scanner pages: one press freezes the last couple of seconds the scanner
 * was shown and what it was saying at the end of them, and a dialog asks the reader which card
 * that really was.
 *
 * **The page's own idiom for a question** — `clearOpener` and `deckOpener` beside it: the state
 * that opens the dialog is the snapshot it is about, and the press that asked is kept for the
 * caret. Shared rather than written into each page because the two pages would otherwise have to
 * agree by hand about what a snapshot holds, and one of them is the phone's.
 *
 * **Nothing is taken for it.** The run is the pump's own (`ScanLoop.recent`): the frames the
 * scanner was given, already made and already answered. A press reads them and the page's state
 * in one synchronous step — there is no grab to wait for, so nothing can move between the press
 * and the snapshot, and nothing is sent that the scanner did not see.
 *
 * **A press too soon opens nothing and says why.** Fewer than `RUN_MIN_FRAMES` is a camera that
 * has only just started, or evidence only just reset — not a scan, and the engine would refuse
 * it. There is no falling back to the one picture on screen: a scan is all of the run or none.
 * **Counted after the frames too old to be the last few seconds are left out** (`runAtPress`):
 * a pump that has stalled is holding what it sent a while ago, and that is not enough either.
 *
 * **What the scanner had said is the run's last frame's, not the page's.** The press reads the
 * ring as it stands and everything else as the last render had it, and the ring can be a frame
 * ahead — so `scanRun` takes the reported printing, the two figures and the mode off the last
 * frame of the run itself. The `verdict` here is only what the reader was looking at: the name
 * the search opens on.
 *
 * **Recognition pauses for it** (issue #977): the pages hold their pump while `run` is not
 * `null`, so no card lands in the tray while the reader picks a printing. The camera stays open.
 * The run is a value in state: no later frame can reach it, and a second press cannot replace
 * it — one is refused while a dialog is open, so the pictures the reader is looking through are
 * the ones Send sends.
 *
 * Takes the loop's `recent` and `verdict` rather than the whole loop, with the page's own word
 * for whether the press is offered at all (`ready`): the press is drawn only then, and a sentence
 * about a press is dropped when the press goes away — *press again* over a stopped scanner, with
 * nothing there to press, would be an instruction nobody can follow.
 */
export function useScanSubmit({
  recent,
  verdict,
  mode,
  status,
  filters,
  ready,
}: {
  /** `useScanLoop`'s run: the last frames the pump sent and had answered, oldest first. */
  recent: ScanLoop["recent"];
  /**
   * What the page is showing the scanner to say — `null` while it shows nothing. **Read for the
   * name the search opens on and for nothing that is sent.**
   */
  verdict: ScannerVerdict | null;
  /** The reader's mode. What is sent is the mode the run's last frame was judged in. */
  mode: ScanMode;
  /** `useScannerStatus`' answer, or `null` before it has one. */
  status: ScannerStatus | null;
  /**
   * The sets and dates the scanner is narrowed to: **the ones its session last accepted**
   * (`useScannerPrefs`' `inForce`), never the ones the popover is drawing. A change the session
   * has not answered yet, or has refused, is not what any frame of the run was judged under.
   */
  filters: ScanFilters;
  /**
   * The press is offered — the page's `sendable`: a camera is live and recognition is running,
   * the page is not mounted over a trade, and the device may send scans (`useMaySendScans`).
   * `false` refuses a press, and drops the sentence of one that came too soon; it does not close
   * a dialog that is already open.
   */
  ready: boolean;
}): ScanSubmit {
  const [run, setRun] = useState<ScanRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** A dialog is open. A ref beside the state: two presses can land inside one render. */
  const opened = useRef(false);

  // **The sentence goes when the press does.** React's "adjusting state when a prop changes",
  // as `useScanLoop` empties its latches: applied in this render, where an effect writing state
  // would cost a second one and is what the linter refuses anyway.
  const [wasReady, setWasReady] = useState(ready);
  if (wasReady !== ready) {
    setWasReady(ready);
    if (!ready) setError(null);
  }

  const open = (from: HTMLElement) => {
    if (!ready || opened.current) return;
    const ring = recent();
    // The clock is read after the ring: every frame in it was grabbed before this line. The
    // run's own clock (`runClock`) — the one the pump stamped those frames by.
    const pressedAt = runClock.now();
    // Only what is still the last few seconds, and then whether that is enough of a scan.
    const frames = runAtPress(ring, pressedAt);
    if (frames.length < RUN_MIN_FRAMES) {
      setError(SCAN_TOO_SHORT);
      return;
    }
    opened.current = true;
    opener.current = from;
    setError(null);
    setRun(scanRun(frames, pressedAt, verdict, mode, status, filters));
  };

  // The two ways out are stable, which `open` cannot be: the dialog's body is memoised on them,
  // so the printings it has drawn are not drawn again for every verdict the page takes behind it.
  const onDismiss = useCallback(() => {
    opened.current = false;
    setRun(null);
    opener.current?.focus();
  }, []);
  const onClose = useCallback(() => {
    opened.current = false;
    setRun(null);
  }, []);

  return { run, error, open, onDismiss, onClose };
}
