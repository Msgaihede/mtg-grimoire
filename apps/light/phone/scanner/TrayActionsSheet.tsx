import { Archive, History, Layers, Trash2 } from "lucide-react";
import { SCAN_HISTORY_TITLE } from "@grimoire/ui/features/scanner/history/historyWords";
import { deckRefusal, EMPTY_REASON } from "@grimoire/ui/features/scanner/reader/tray";
import type { TrayDestinationFace } from "@grimoire/ui/features/scanner/useTrayDestination";
import type { ScannerTrayRow } from "@grimoire/ui/lib/ipc";
import { ActionSheet, SheetRow } from "../deck/sheet";
import { ARCHIVING } from "./TrayBar";

/**
 * The tray's other acts — *Archive*, *Create deck…*, *Clear all…* and *Scan history* — as sheet
 * rows, each saying why it is refused where it is (`SheetRow`'s second line) in place of the
 * desktop menu's tooltip. It was the tray footer's own `⋯` sheet until the scanner redesign
 * (2026-10-24) moved the `⋯` into the tray's header, which the page draws in two places (the tray
 * sheet's header, and the tray's column on a phone on its side); **the page owns the press and
 * opens this**, so the press can be wherever the tray's header is.
 *
 * - **Archive** (issue #989) puts away the rows Add would take, into the scan history and not
 *   the collection — the desktop tray's Archive, refused on *Clear all…*'s terms (an empty tray,
 *   or either press in flight). A row waiting on a printing is said by the press, in the plan's
 *   sentence in the alert over the tray's bar, as it would be for an Add. **Either press in
 *   flight holds the other**: they put the same rows away.
 * - **Create deck…** and **Clear all…** are requests: the page owns the dialog and the question.
 * - **Scan history** opens the history's sheet — a request; the page owns it. Never refused.
 *
 * **The caret**: Archive closes the sheet by {@link onDismiss}, which hands the caret back to the
 * press that opened it; the three requests close it by {@link onClose} and leave the caret to the
 * dialog or sheet the page opens next, which hands it back to the same press when it shuts.
 *
 * **With a `destination`** — the tray filing onto a side of a trade — it holds *Clear all…* alone:
 * a deck is a question about the collection, and the archive and its history are the Scanner
 * tab's own record.
 */
export function TrayActionsSheet({
  open,
  onClose,
  onDismiss,
  rows,
  committing,
  archiving = false,
  destination,
  onCreateDeck,
  onClearAll,
  onArchive,
  onHistory,
}: {
  open: boolean;
  /** A press on the scrim, and every row that opens something of the page's. */
  onClose: () => void;
  /** Escape, the ✕ and Archive: close, and hand the caret back to the press that opened this. */
  onDismiss: () => void;
  rows: readonly ScannerTrayRow[];
  /** An Add is in flight: every row is held, saying where the cards are going. */
  committing: boolean;
  /** An Archive is in flight — {@link committing}'s counterpart; it holds the same rows. */
  archiving?: boolean;
  /** Where the tray files when that is not the collection. Only *Clear all…* is drawn. */
  destination?: TrayDestinationFace;
  /** *Create deck…* — a request; the page owns the dialog. Not drawn with a {@link destination}. */
  onCreateDeck: () => void;
  /** *Clear all…* — a request, never the clear itself: the page asks first. */
  onClearAll: () => void;
  /** *Archive* — the tray into the scan history. Absent draws no row, and so does a
   *  {@link destination}. */
  onArchive?: () => void;
  /** *Scan history* — a request; the page owns the sheet. Absent draws no row, and so does a
   *  {@link destination}. */
  onHistory?: () => void;
}) {
  // Add and Archive put the same rows away, so either one in flight holds every row here.
  const busy = committing || archiving;
  // What a row says while the press is out.
  const adding = archiving ? ARCHIVING : `Adding to ${destination?.name ?? "your collection"}…`;
  const archiveShown = onArchive !== undefined && destination === undefined;
  const historyShown = onHistory !== undefined && destination === undefined;

  return (
    <ActionSheet
      open={open}
      title="Scanned cards"
      closeLabel="Close tray actions"
      onClose={onClose}
      onDismiss={onDismiss}
    >
      <ul>
        {archiveShown && (
          <SheetRow
            label="Archive"
            Icon={Archive}
            // Clear all's terms: what a commit is about to file, or nothing at all, cannot be
            // archived. Said in words on the row, where the desktop has a tooltip.
            reason={busy ? adding : rows.length === 0 ? EMPTY_REASON : null}
            onPress={() => {
              onDismiss();
              onArchive();
            }}
          />
        )}
        {destination === undefined && (
          <SheetRow
            label="Create deck…"
            Icon={Layers}
            reason={busy ? adding : deckRefusal(rows)}
            onPress={() => {
              onClose();
              onCreateDeck();
            }}
          />
        )}
        <SheetRow
          label="Clear all…"
          Icon={Trash2}
          destructive
          // Nothing to clear, or a commit about to file these very rows — a card waiting on a
          // printing or a finish can still be thrown away.
          reason={busy ? adding : rows.length === 0 ? EMPTY_REASON : null}
          onPress={() => {
            onClose();
            onClearAll();
          }}
        />
        {/* Last, and never refused: the history is there whatever the tray holds — an empty
            tray is the usual moment to look back at what was put away. */}
        {historyShown && (
          <SheetRow
            label={SCAN_HISTORY_TITLE}
            Icon={History}
            opens
            onPress={() => {
              onClose();
              onHistory();
            }}
          />
        )}
      </ul>
    </ActionSheet>
  );
}
