/**
 * The scan history's sentences (issue #989) — pure, so the dialog, its stories and its tests read
 * one spelling of each.
 */
import { plural } from "@/lib/counts";
import type { ScanBatchSummary } from "@/lib/ipc";

/** The dialog's heading, and the name its opener on the Scanner's bar points at. */
export const SCAN_HISTORY_TITLE = "Scan history";

/** What an empty history says — both ways a pile gets here, so a reader knows which presses do. */
export const EMPTY_HISTORY = "Scans you add to your collection or archive will appear here.";

/** Said in the detail column while no batch is picked — the list is never empty then. */
export const PICK_A_SCAN = "Pick a scan to see its cards.";

/**
 * The month as three letters, day first — the trade list's `tradeDay` grammar (`2 Oct`), spelled
 * again here rather than imported so the Scanner's chunk does not carry the Trade page's words.
 * en-US's month, because en-GB's CLDR data abbreviates September with four letters.
 */
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short" });
const CLOCK = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * When a pile was put away: `2 Oct 2026, 14:05`, in the reader's own clock.
 *
 * **With the time, where a trade's day has none**: a trade is one a day at most, and a scanning
 * session is several piles in an evening — `Scan 12` and `Scan 13` on the same day are told apart
 * by the minute or not at all.
 */
export function scanWhen(unixSeconds: number): string {
  const at = new Date(unixSeconds * 1000);
  return `${at.getDate()} ${MONTH.format(at)} ${at.getFullYear()}, ${CLOCK.format(at)}`;
}

/**
 * Where the batch went, as its chip says it: `Added to “Binder”`, `Added to collection`, or
 * `Archived`.
 *
 * **The folder's name as it was when the batch was written** (`folderName`), never looked up
 * again: a folder deleted since still says where those cards went, which is the question a reader
 * opens the history to answer.
 */
export function batchStatusWords(batch: Pick<ScanBatchSummary, "status" | "folderName">): string {
  if (batch.status === "archived") return "Archived";
  return batch.folderName === null ? "Added to collection" : `Added to “${batch.folderName}”`;
}

/** The dim line under a batch's name in the list: `2 Oct 2026, 14:05 · 12 cards`. */
export function batchLine(batch: Pick<ScanBatchSummary, "createdAt" | "copies">): string {
  return `${scanWhen(batch.createdAt)} · ${plural(batch.copies, "card")}`;
}

/**
 * The delete question's sentence. **It names what is not touched**, the one thing a reader
 * deleting a record of cards they filed is afraid of: a filed batch's cards stay in the
 * collection, and an archived one's were never there.
 */
export function deleteSentence(batch: Pick<ScanBatchSummary, "name" | "status">): string {
  return batch.status === "filed"
    ? `“${batch.name}” will be removed from your scan history. The cards it added stay in your collection.`
    : `“${batch.name}” will be removed from your scan history. Your collection is not affected.`;
}
