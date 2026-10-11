/**
 * What *Send scan…* says, on both Scanner surfaces: the press, the dialog it opens, the two
 * reasons it will not send yet, what is sent and to whom, and the thanks afterwards.
 *
 * One module for `readerText.ts`'s reason — the desktop strip and the phone's line draw the same
 * press, and both mount the same dialog, so a sentence written at a call site is a sentence the
 * other face says differently by the next edit. And for its rule: **these are a reader's words**.
 * The scanner's own vocabulary — what it measured, what it was leaning towards and by how much —
 * is `verdictText.ts`'s and never reaches here; a reader is sending *a picture* of *a card*, and
 * `submitText.test.ts` sweeps every string below for the words that would say otherwise.
 */
import { count } from "@/lib/counts";

/** The press on both faces — its words on the desktop strip, its name on the phone's icon. */
export const SEND_SCAN = "Send scan…";

/** The dialog's heading, and so its accessible name. */
export const SEND_TITLE = "Send this scan";

/** The picture's `alt`: what it is *for*, since what it shows is whatever was in front of the lens. */
export const PICTURE_ALT = "The picture that will be sent";

/** Over the search box — and its label, so the question and the box's name are one sentence. */
export const WHICH_CARD = "Which card is in the picture?";

export const SEARCH_PLACEHOLDER = "Card name…";

/** The printings' radio group, by name. */
export const PRINTINGS = "Printings";

/** An empty box asks nothing: the reader is told what typing will get them instead. */
export const SEARCH_PROMPT = "Type the card's name to see its printings.";

export const SEARCHING = "Searching…";

export function noPrintingFound(query: string): string {
  return `No printing found for “${query}”.`;
}

/** A search that could not run — `DeckCoverPicker`'s sentence, which is the same failure. */
export function searchFailed(reason: string): string {
  return `Couldn't search the cards — ${reason}`;
}

/**
 * How many printings matched: `1 printing`, `4 printings`, `Showing 24 of 132 printings`,
 * `Showing 24 of 5,000+ printings`.
 *
 * `capped` is the backend having stopped counting — a floor, so it is said as one. A capped
 * count is never the singular: `5,000+ printing` must not print (`lib/counts.ts` names the rule).
 */
export function printingsFound(shown: number, total: number, capped: boolean): string {
  if (!capped && total <= shown) return `${shown} ${shown === 1 ? "printing" : "printings"}`;
  return `Showing ${shown} of ${count(total)}${capped ? "+" : ""} printings`;
}

export const SHOW_MORE = "Show more";

/**
 * What a reader can type to narrow a long answer, as the search box itself reads it.
 *
 * **The app's own syntax, not one written for this hint**: `s:` is a keyword of
 * `features/search/queryLanguage.ts` (`s`, `set`, `e`, `edition`), and `submitText.test.ts`
 * parses this example through that table — a hint naming a term the box reads as plain words
 * would send a reader looking for a card called "s:ltr".
 */
export const SET_HINT_EXAMPLE = "s:ltr";
export const SET_HINT = `A set code narrows it — add ${SET_HINT_EXAMPLE} to the search, for example.`;

/** `LTR 72` — the set upper-cased, then the number, as every card row in the Scanner spells it. */
export function printingWords(printing: { setCode: string; collectorNumber: string }): string {
  return [printing.setCode.toUpperCase(), printing.collectorNumber]
    .filter((part) => part !== "")
    .join(" ");
}

/** A printing's tile, by name: `Lightning Bolt — STA 105`, the tray's spelling of a candidate. */
export function printingLabel(printing: {
  name: string;
  setCode: string;
  collectorNumber: string;
}): string {
  const words = printingWords(printing);
  return words === "" ? printing.name : `${printing.name} — ${words}`;
}

/** The line that keeps the choice on screen whatever the box is searching for now. */
export function chosenLine(printing: {
  name: string;
  setCode: string;
  collectorNumber: string;
}): string {
  const words = printingWords(printing);
  return words === "" ? `Chosen: ${printing.name}` : `Chosen: ${printing.name} · ${words}`;
}

/** The finish group's heading and its name. */
export const FINISH = "Finish";

/** Under the finishes while there is no card to offer them for. */
export const FINISH_NEEDS_CARD = "Choose the card first.";

/** Under a lone finish, which was chosen for the reader: why it already is. */
export const ONE_FINISH = "This printing comes in one finish.";

/** Why Send will not send yet — the card first, because the finishes offered depend on it. */
export const CHOOSE_THE_CARD = "Choose the card in the picture.";
export const CHOOSE_ITS_FINISH = "Choose its finish.";

/**
 * What is sent, to whom, and what is not — above the press, always, and never behind one.
 *
 * **Every clause is a promise the engine keeps**: the submission is the picture, the printing's
 * id and finish, what the scanner had answered (`ScannerSubmission` in `lib/ipc.ts`), and the
 * app's version and which app it is, which the engine adds (`Label` in `scanner_submit.rs`);
 * nothing of the collection rides with it. **It lists what is sent rather than saying "nothing
 * else"**, because there is a little else and a reader is owed the list.
 *
 * **And it says nothing is _kept_ that says who they are — not that nothing is sent.** A request
 * arrives from an address, as every request does, and the inbox uses it to limit how often one
 * address may send; what it stores has no address, device or account in it. The privacy policy
 * says the same at length. A field added to either struct is a sentence owed here, and there.
 */
export const DISCLOSURE =
  "This picture and the card you choose are sent to MTG Grimoire's maker, with what the scanner " +
  "read, the app's version and which app it is, and kept to improve the scanner. Nothing from " +
  "your collection is sent, and nothing is kept that says who you are. Check that the picture " +
  "shows only what you mean to send.";

export const CANCEL = "Cancel";
/** The dialog's own press: no ellipsis, because this one opens nothing — it sends. */
export const SEND = "Send scan";
export const SENDING = "Sending…";

export const SENT = "Sent — thank you.";
export const REFERENCE = "Reference:";
/** Nothing sent says who sent it, so the reference is the only way back to one picture. */
export const KEEP_THE_REFERENCE = "Keep the reference if you ever want this picture deleted.";
export const DONE = "Done";

/** A press that got no picture out of the camera — said over it, where a refused reset is. */
export const PICTURE_NOT_TAKEN = "Couldn't take a picture to send. Try again.";
