import { useRef, useState, type ReactNode } from "react";
import type { ScannerTrayRow } from "@/lib/ipc";
import { ipcError } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import { takenRows, totalCopies } from "./reader/tray";
import { withoutCommitted } from "./reader/trayCommit";
import type { TrayState } from "./useTray";

/**
 * **Somewhere a scan session's tray goes that is not the collection** — handed to a Scanner surface
 * by whoever opened it, and absent on the Scanner view itself.
 *
 * With one, the surface is the same scanner over the same tray and only the last step differs:
 * the press reads `Add 4 to {name}`, it hands the rows to {@link TrayDestination.commit} instead
 * of filing them with `scanner_tray_commit`, and what belongs to the collection alone is not drawn
 * — the folder, *Create deck…*. The two refusals stand as they are (`tray.ts`' `takenRows`): a row
 * waiting on a printing stops the press, and a row of unknown finish is left behind, out loud.
 *
 * The first user is a side of a trade (`tradeScan.tsx`).
 */
export interface TrayDestination {
  /** Heads the tray in place of `Scanned cards`: `Scanned for their side`. */
  title: string;
  /**
   * The place as the end of a sentence — `their side` — for `Add 4 to their side`, the pending
   * `Adding to their side…` and the clear question's `…without being added to their side`.
   */
  name: string;
  /** Whose prices the rows are quoted at. Absent is the reader's own marketplace. */
  marketplace?: MarketplaceId;
  /**
   * What stands where the folder picker stood, beside the press — a running total, say. Handed
   * the rows on screen; absent draws nothing there.
   */
  summary?: (rows: readonly ScannerTrayRow[]) => ReactNode;
  /**
   * Write these rows to the destination. **Every one has a printing and a known finish.** A
   * rejection is the refusal's own sentence, drawn where a refused Add is; the tray is then left
   * exactly as it was.
   */
  commit: (rows: readonly ScannerTrayRow[]) => Promise<void>;
  /**
   * The rows have left the tray. `left` is how many rows it still holds — cards waiting on a
   * finish, and cards scanned while the write was out — so a surface that closes itself when
   * there is nothing more to review knows whether there is.
   */
  onCommitted?: (left: number) => void;
}

/** The half of a destination a tray *draws*, for the two presentational trays. */
export type TrayDestinationFace = Pick<
  TrayDestination,
  "title" | "name" | "marketplace" | "summary"
>;

export interface TrayDestinationCommit {
  /**
   * Hand the tray's ready rows to the destination. **Never rejects**, as `useTrayCommit`'s does
   * not: a refusal is {@link TrayDestinationCommit.error}'s sentence and a `null` answer. Answers
   * the copies it added.
   */
  commit: () => Promise<number | null>;
  committing: boolean;
  /** The last refusal — the destination's own words, or the plan's. Cleared by the next press. */
  error: string | null;
  /**
   * **What the tray already held when this surface opened**, said out loud, or `null`.
   *
   * The tray is one stored row and every Scanner surface reads it, so a pile scanned on the
   * Scanner view and never filed is in this list too, and the press would send it to the
   * destination with the rest. That is the tray working as built; what it must not be is a
   * surprise. The sentence stands while any of those rows is still in the tray, and goes with
   * them — filed, removed one by one, or cleared.
   */
  notice: string | null;
}

/**
 * Rows a destination write is carrying right now, by identity.
 *
 * **Per module rather than per mount**, for the reason `useTrayCommit` builds its lines at send
 * time: `committing` is one mount's state, and a surface that unmounted with its write still out
 * and came back — the dialog closed and opened again, the app dragged across its two faces — could
 * be pressed over the very rows the first press took. A destination has no transaction to notice
 * that in; the rows are what is known, and `useTray` keeps them the same objects from one read to
 * the next (`structuralSharing: false`). A row leaves the set when its write has settled: at once
 * on a refusal, so the next press can carry it again, and after the trim on a success, by when it
 * is no longer in the tray to be pressed.
 */
const inFlight = new WeakSet<ScannerTrayRow>();

/** {@link TrayDestinationCommit.notice}'s words. */
export function heldNotice(copies: number, name: string): string {
  const were = copies === 1 ? "1 card was" : `${copies} cards were`;
  const they = copies === 1 ? "It is in this list and goes" : "They are in this list and go";
  return `${were} already in the scanner's tray. ${they} onto ${name} with the rest. Remove any that do not belong, or use Clear all… to empty the list.`;
}

/**
 * The tray onto a {@link TrayDestination} — `useTrayCommit`'s counterpart for a place that is not
 * the collection, called beside it by both Scanner surfaces and inert without a destination.
 *
 * **Two writes, and the order is what keeps a card from being lost.** `scanner_tray_commit` files
 * the collection and stores what is left of the tray in one transaction; nothing does that for a
 * destination, and none is being added. So the destination is written **first** and the tray is
 * trimmed **after it answers**: a write that is refused leaves every row where it was, and an app
 * closed between the two — or a trim that is itself refused — leaves rows in the tray that the
 * destination already holds. That worst case is a card offered twice, which the reader can see
 * and remove; the other order's worst case is a card that is nowhere.
 *
 * **The trim is `withoutCommitted`**, the commit's and *Clear all…*'s own subtraction, against the
 * tray as it is when the write answers: the camera keeps running, so a card scanned meanwhile
 * stays and a row bumped meanwhile keeps the copies added since. It is stored by the tray's
 * ordinary debounced write, or by its unmount flush if the surface closes on the answer.
 */
export function useTrayDestination({
  tray,
  destination,
}: {
  tray: Pick<TrayState, "rows" | "loaded" | "latest" | "setRows">;
  destination: TrayDestination | undefined;
}): TrayDestinationCommit {
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A second press in the tick before `committing` is drawn must not start a second write.
  const busy = useRef(false);

  // What the tray held as it loaded, by key and count — taken once, on the first render that has
  // the rows, and only where there is a destination to say it about. State set during render
  // rather than in an effect: it is derived from the first loaded tray and nothing else.
  const [opened, setOpened] = useState<ReadonlyMap<string, number> | null>(null);
  if (destination !== undefined && opened === null && tray.loaded) {
    setOpened(new Map(tray.rows.map((row) => [row.key, row.quantity])));
  }
  // The copies of those rows still here: a row scanned again since is counted as it stood.
  const held =
    opened === null
      ? 0
      : tray.rows.reduce(
          (sum, row) => sum + Math.min(row.quantity, opened.get(row.key) ?? 0),
          0,
        );

  const commit = async (): Promise<number | null> => {
    if (destination === undefined || busy.current) return null;
    let taken: ScannerTrayRow[];
    try {
      taken = takenRows(tray.latest()).filter((row) => !inFlight.has(row));
    } catch (e) {
      setError(ipcError(e));
      return null;
    }
    if (taken.length === 0) return null;
    busy.current = true;
    taken.forEach((row) => inFlight.add(row));
    setCommitting(true);
    setError(null);
    try {
      // The destination first; the tray only once it has answered. See the order's reason above.
      await destination.commit(taken);
    } catch (e) {
      taken.forEach((row) => inFlight.delete(row));
      setError(ipcError(e));
      return null;
    } finally {
      busy.current = false;
      setCommitting(false);
    }
    const now = tray.latest();
    const left = withoutCommitted(now, taken);
    // An empty answer is also what `latest()` gives for a tray this client no longer holds — the
    // surface gone and its cache entry dropped behind it — and `[]` written over that would empty
    // the stored row (`useTray`, "no write stores what is not there"). There is nothing to trim
    // from an empty tray either way.
    if (now.length > 0) tray.setRows(left);
    taken.forEach((row) => inFlight.delete(row));
    destination.onCommitted?.(left.length);
    return totalCopies(taken);
  };

  return {
    commit,
    committing,
    error,
    notice: destination !== undefined && held > 0 ? heldNotice(held, destination.name) : null,
  };
}
