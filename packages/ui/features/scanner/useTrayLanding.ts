import { useEffect, useRef, useState } from "react";
import { LANDED_HOLD_MS, landedFrom, type LandedCard } from "./reader/AddedToast";
import type { LastAdded } from "./reader/readerText";
import { addDecision, addPicked, type PickedPrinting } from "./reader/tray";
import { trayFinish } from "./reader/trayFinish";
import type {
  ScannerDecision,
  ScannerFinishPref,
  ScannerTrayFinish,
  ScannerTrayRow,
} from "./types";
import type { TrayState } from "./useTray";

/**
 * How long a row that just landed stays marked as the one to flash.
 *
 * The tray's wash holds for one `slow` tier and fades over the next, so the flash itself is over
 * in about half a second; the key is cleared a while after that so a tray that remounts — a
 * Developer switch that moves the desktop's column — does not replay it.
 */
export const FLASH_MS = 1200;

export interface TrayLanding {
  /** `useScanLoop`'s `onDecision`: one card, into the tray. */
  onDecision: (decision: ScannerDecision) => void;
  /**
   * One card the reader searched for by hand (*Add a card…*), into the tray in the finish they
   * chose — landed with the same marks as a scan: the strip's line, the card over the camera and
   * the row's flash, so a card added by hand is said where a scanned one would be.
   */
  onPicked: (picked: PickedPrinting, finish: ScannerTrayFinish) => void;
  /** The card the tray just took, as the Match strip names it — never cleared. */
  lastAdded: LastAdded;
  /**
   * The newest landing — every one, a hand-add made while stopped included — drawn from the tray's
   * head row rather than from the decision, because the row is what was filed: a bump, a re-read
   * and a row waiting for a pick all say something different to a reader holding the card. **A new
   * object each landing and never cleared**, so `useScanSounds` plays once for each one.
   */
  landed: LandedCard | null;
  /**
   * The card laid over the camera (`AddedToast`, and so the confetti) — {@link TrayLanding.landed}
   * for {@link LANDED_HOLD_MS} after a landing made **while armed**, then `null`.
   *
   * **The hold runs here, not in the overlay** (issue #1555): it used to be the toast's own timer,
   * which ran only while the toast was shown, so a card that landed with the reader stopped — a
   * hand-add, or a Stop inside the hold — was never put away, and the next Start raised it again as
   * news. Now a landing made while not armed is never shown, and a Stop puts the card away at once.
   */
  shown: LandedCard | null;
  /** The row just added or bumped, for the tray's flash — `null` again after {@link FLASH_MS}. */
  flashKey: string | null;
}

/**
 * One card, into the tray — once per `decision_seq`, which the loop is what guarantees.
 *
 * The reducer decides whether it is a new row, a second copy of the newest, or a second opinion
 * that rewrites the newest row's printing (`replaces_previous` — a filter changed with the card
 * still on the mat); this files the answer, marks the row for the flash, and remembers what to say
 * about it. The finish is the Defaults' at the moment the card landed, which is why a change there
 * moves only the next card — and under **Detect**, the default, it is `trayFinish`'s reading of
 * this decision's own facts: the printing's finishes, or `unknown` for the reader to settle.
 *
 * **It builds on `tray.latest()`, never on the rows a render drew**: a decision from the pump can
 * land after more cards were scanned than the render that built its closure knew about. `latest()`
 * is the cache, written synchronously by the write before it, so two writers in one tick cannot
 * each start from the rows before the other.
 *
 * The desktop's Scanner view and the light app's phone page both land their cards through this, so
 * one tray — shared between the two faces of an install — is filled by one rule.
 */
export function useTrayLanding(
  tray: Pick<TrayState, "latest" | "setRows">,
  finishPref: ScannerFinishPref,
  /**
   * Whether the reader is scanning at all — the page's `armed`: continuous scanning running, or
   * point and shoot on. Only a card that lands while it is on is laid over the camera, and the
   * card there is put away the moment it goes off.
   */
  armed: boolean,
): TrayLanding {
  const [lastAdded, setLastAdded] = useState<LastAdded>(null);
  const [landed, setLanded] = useState<LandedCard | null>(null);
  const [shown, setShown] = useState<LandedCard | null>(null);
  // A Stop puts the card over the camera away in the same render — "adjusting state when a prop
  // changes" — so neither the popup nor the confetti draws a frame of it once the reader stopped.
  const [wasArmed, setWasArmed] = useState(armed);
  if (wasArmed !== armed) {
    setWasArmed(armed);
    if (!armed) setShown(null);
  }
  // The hold: each landing is a new object, so a card landing inside the last one's hold gets a
  // whole hold of its own rather than the remainder.
  useEffect(() => {
    if (shown === null) return;
    const timer = setTimeout(() => setShown(null), LANDED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  /** The landing's marks for a write that put `rows[0]` at the head — whoever wrote it. */
  const land = (rows: ScannerTrayRow[], bumped: boolean, replaced: boolean) => {
    tray.setRows(rows);
    const head = rows[0];
    setLastAdded({
      name: head.name,
      setCode: head.setCode,
      collectorNumber: head.collectorNumber,
      bumpedTo: bumped ? head.quantity : null,
      replaced,
    });
    const card = landedFrom(head, bumped, replaced);
    setLanded(card);
    // Read from this render's closure: the loop calls the newest `onDecision` through its ref,
    // and *Add card…* the newest `onPicked`.
    if (armed) setShown(card);
    setFlashKey(head.key);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null;
      setFlashKey(null);
    }, FLASH_MS);
  };

  const onDecision = (decision: ScannerDecision) => {
    const { rows, bumped, replaced } = addDecision(
      tray.latest(),
      decision,
      { finish: trayFinish(finishPref, decision) },
      Date.now(),
      crypto.randomUUID(),
    );
    land(rows, bumped, replaced);
  };

  const onPicked = (picked: PickedPrinting, finish: ScannerTrayFinish) => {
    const { rows, bumped } = addPicked(
      tray.latest(),
      picked,
      finish,
      Date.now(),
      crypto.randomUUID(),
    );
    land(rows, bumped, false);
  };

  return { onDecision, onPicked, lastAdded, landed, shown, flashKey };
}
