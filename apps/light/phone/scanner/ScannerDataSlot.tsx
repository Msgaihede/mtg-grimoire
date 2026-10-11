import { ScannerAssets } from "@grimoire/ui/features/scanner/ScannerAssets";
import type { ScannerStatus } from "@grimoire/ui/lib/ipc";

/**
 * **The slot for the scanner's data** — under the camera, where this page says what the scanner
 * is missing and offers to fetch it.
 *
 * A light install does not carry the card hashes and the two reading models inside its binary,
 * so "absent" is the state it starts in. What is drawn here is `ScannerAssets`, the one
 * component both faces share: it asks the host which files this install owes (`scanner_assets`)
 * and, where the host lists any, draws the offer — one sentence with the measured size, what
 * each file is, a Download button at a finger's size, then the bar, then the engine's sentence
 * and a Retry if it failed. **Drawn from what the host answers and from nothing else**: a host
 * that owes nothing, or refuses the question, gets no offer, and then all that is left is what
 * `scanner_status` still has to say — card names that did not load, a file that would not read.
 * It replaced the status's own sentences, which named a path to put files at and told the
 * reader to restart: an instruction nobody holding this page can follow.
 *
 * `onLoaded` is the page's half of a download landing. The engine lets its session go for the
 * files that arrived, so the next one is new: the page gives it the reader's filters again and
 * drops what the last one said.
 *
 * Nothing at all — no element — while there is nothing to offer and nothing to say.
 */
export function ScannerDataSlot({
  status,
  onLoaded,
}: {
  status: ScannerStatus | null;
  onLoaded?: () => void;
}) {
  return (
    <ScannerAssets status={status} onLoaded={onLoaded} marks={{ "data-scanner-data-slot": "" }} />
  );
}
