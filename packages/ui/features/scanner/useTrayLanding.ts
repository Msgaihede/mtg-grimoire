import { useEffect, useRef, useState } from "react";
import { landedFrom, type LandedCard } from "./reader/AddedToast";
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
   * The card laid over the camera for the length of its hold — what just landed, drawn from the
   * tray's head row rather than from the decision, because the row is what was filed: a bump,
   * a re-read and a row waiting for a pick all say something different to a reader holding the
   * card. Cleared through {@link TrayLanding.clearLanded} by the overlay once its hold runs out.
   */
  landed: LandedCard | null;
  clearLanded: () => void;
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
): TrayLanding {
  const [lastAdded, setLastAdded] = useState<LastAdded>(null);
  const [landed, setLanded] = useState<LandedCard | null>(null);
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
    setLanded(landedFrom(head, bumped, replaced));
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

  return { onDecision, onPicked, lastAdded, landed, clearLanded: () => setLanded(null), flashKey };
}
