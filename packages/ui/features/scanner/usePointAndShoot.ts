import { useCallback, useState } from "react";

/** How a shot ends besides an interruption: on the card it was for, or only when let go. */
export type ShotEnd = "card" | "release";

export interface PointAndShoot {
  /** A shot is running — the pump is live for it, and for nothing else under point and shoot. */
  shooting: boolean;
  /**
   * Begin a shot. `forget` is the loop's `clearReads`: **every shot is news**, the card left
   * standing in front of the lens by the last one included — a press is the reader saying
   * "this card", and a second copy laid where the first lay is a card of its own. `end` is
   * `"card"` for a click (the shot is over once a card lands) and `"release"` for a hold.
   */
  start: (forget: () => void, end: ShotEnd) => void;
  /** End the shot: a hold let go, a second click, a press that cancels. */
  stop: () => void;
  /** A card landed — the loop's `onDecision`'s other half. Ends a shot that was for one card. */
  landed: () => void;
}

/**
 * **Point and shoot** — recognition for the length of a press, rather than from Start until Stop.
 *
 * The Neural mode decides on one clear frame, so a camera carried from one card to the next reads
 * whatever passes under it — the table, a card in the pile, the one just filed — and files it. A
 * shot is the reader saying when: **a click on the desktop face** (*Scan card*) runs the pump
 * until one card lands, and **a hold on the phone's** (*Scan*) runs it until the finger lifts.
 * Neither replaces Start and Stop: `on` is the stored pref, and with it off nothing here moves.
 *
 * **Session-only, and always over when it should be.** A shot ends when the switch goes off and
 * the moment the page is `interrupted` — a window minimized, a dialog over the camera — because a
 * hold whose release landed somewhere else (a sheet, another app) would otherwise scan on with
 * no finger on the button, and a click left running would read the first card after the dialog.
 * React's "adjusting state when a prop changes", as `useScanLoop` empties its latches, so the pump
 * stops in the same commit.
 *
 * Shared by the desktop's Scanner view and the light app's phone page: each face draws its own
 * press, and this decides what a press does.
 */
export function usePointAndShoot({
  on,
  interrupted,
}: {
  /** The stored pref (`ScannerPrefs.pointAndShoot`). */
  on: boolean;
  /** Anything that pauses the pump from outside: a parked window, a dialog over the camera. */
  interrupted: boolean;
}): PointAndShoot {
  const [shot, setShot] = useState<ShotEnd | null>(null);
  if (shot !== null && (!on || interrupted)) setShot(null);

  const start = useCallback(
    (forget: () => void, end: ShotEnd) => {
      if (!on || interrupted) return;
      forget();
      setShot(end);
    },
    [on, interrupted],
  );
  const stop = useCallback(() => setShot(null), []);
  const landed = useCallback(() => setShot((s) => (s === "card" ? null : s)), []);

  return { shooting: shot !== null, start, stop, landed };
}
