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

/**
 * The press that lands a past scan back in the tray (issue #1374), where the reader files or
 * archives it again — the way back from a pile filed by mistake and taken out again.
 */
export const PUT_BACK_LABEL = "Put back in tray";

/** What the press does, for its tooltip: nothing is filed until the tray's own Add. */
export const PUT_BACK_HINT =
  "Puts these cards back in the scanner's tray, to add to your collection or archive again.";

/** The toast's title once a pile has landed: `Put 12 cards from “Scan 4” back in the tray`. */
export function putBackTitle(batch: Pick<ScanBatchSummary, "name">, copies: number): string {
  return `Put ${plural(copies, "card")} from “${batch.name}” back in the tray`;
}

/**
 * The cards a put-back left out because their printing has left the card database — the toast's
 * body, or `undefined` when none was. **Said, never silent**: a reader counting the pile back in
 * must not find it short with no word why.
 */
export function leftOutSentence(left: number): string | undefined {
  if (left === 0) return undefined;
  return `${plural(left, "card")} ${left === 1 ? "is" : "are"} no longer in the card database and ${left === 1 ? "was" : "were"} left out.`;
}

/** A put-back with nothing to land: every printing in the batch has left the card database. */
export const NOTHING_TO_PUT_BACK =
  "None of its cards are in the card database any more, so there is nothing to put back.";
