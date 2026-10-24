import { scannerStatusFacts } from "@grimoire/ui/features/scanner/useScannerStatus";
import type { ScannerStatus } from "@grimoire/ui/lib/ipc";

/**
 * **The slot for what the scanner's status still has to say** — under the camera, where this page
 * says what is wrong with the scanner's own files: the recogniser there and not loaded, in the
 * load's own sentence (`useScannerStatus`' `assetNotes`).
 *
 * **Nothing about files that are not there, and no instruction to place one.** The recogniser is
 * built into an Android install and fetched from the app's origin by a web page, so a reader
 * holding this page has nothing to put anywhere and no restart to make. Until 2026-10-24 this was
 * where the old scanner's three files were offered for download; they went with it.
 *
 * Nothing at all — no element — while there is nothing to say.
 */
export function ScannerDataSlot({ status }: { status: ScannerStatus | null }) {
  const notes = scannerStatusFacts(status).assetNotes;
  if (notes.length === 0) return null;
  return (
    <div data-scanner-data-slot="" className="space-y-1 text-xs text-dim">
      {notes.map((note) => (
        // An error may carry a path, which is one unbreakable word, and the column is a phone's.
        <p key={note} className="break-words">
          {note}
        </p>
      ))}
    </div>
  );
}
