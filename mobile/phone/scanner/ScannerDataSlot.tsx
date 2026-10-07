import { scannerStatusFacts } from "@/features/scanner/useScannerStatus";
import type { ScannerStatus } from "@/lib/ipc";

/**
 * **The slot for the scanner's data** — where this page says what the scanner is missing, and
 * where a later step of phase 7 draws the offer to download it.
 *
 * A light install does not ship the reference bundle and the two reading models inside its
 * binary the way the desktop does, so "absent" is the state a phone starts in. Today the slot
 * draws what `scanner_status` already says about that, in the desktop's own sentences
 * (`bundleSentence`, `modelsSentence`) — which name a path to put files at, an instruction a phone
 * cannot follow. The step that brings the download replaces the body here and nothing else: the
 * page hands the slot the whole status and draws it under the camera whatever it says.
 *
 * Nothing at all while the status is unanswered or every asset loaded.
 */
export function ScannerDataSlot({ status }: { status: ScannerStatus | null }) {
  const { assetNotes } = scannerStatusFacts(status);
  if (assetNotes.length === 0) return null;
  return (
    <div data-scanner-data-slot="" className="flex flex-col gap-1 text-xs leading-snug text-dim">
      {assetNotes.map((note) => (
        // A path is one unbreakable word, and this column is a phone's width.
        <p key={note} className="break-words">
          {note}
        </p>
      ))}
    </div>
  );
}
