/**
 * What *Send scan…* says, on both Scanner surfaces: the press, the dialog it opens, the two
 * reasons it will not send yet, what is sent and to whom, and the thanks afterwards.
 *
 * One module for `readerText.ts`'s reason — the desktop strip and the phone's line draw the same
 * press, and both mount the same dialog, so a sentence written at a call site is a sentence the
 * other face says differently by the next edit. And for its rule: **these are a reader's words**.
 * The scanner's own vocabulary — what it measured, what it was leaning towards and by how much —
 * is `verdictText.ts`'s and never reaches here; a reader is sending *pictures* of *a card* — a
 * scan is a run of them, and to a reader each one is a picture — and `submitText.test.ts` sweeps
 * every string below for the words that would say otherwise.
 */
import { count } from "@/lib/counts";

/** The press on both faces — its words on the desktop strip, its name on the phone's icon. */
export const SEND_SCAN = "Send scan…";

/** The dialog's heading, and so its accessible name. */
export const SEND_TITLE = "Send this scan";

/**
 * A press too soon: the scanner has not been shown enough yet for there to be a scan to send —
 * a camera that has only just started, or evidence only just reset. Said over the picture, where
 * a refused reset is, and it says what to do, which is all there is to do.
 */
export const SCAN_TOO_SHORT =
  "Not enough of the scan yet. Hold the card under the camera a moment and press again.";

/** `Picture 7 of 18` — which of the scan's pictures, as the slider says its value. */
export function pictureOf(n: number, total: number): string {
  return `Picture ${n} of ${total}`;
}

/**
 * A picture's `alt`: which one it is, and what it is *for* — what it shows is whatever was in
 * front of the lens.
 */
export function pictureAlt(n: number, total: number): string {
  return `${pictureOf(n, total)} that will be sent`;
}

/** The slider's name. Its value is said by {@link pictureOf}. */
export const PICTURE = "Picture";

/**
 * Under the picture: which one is showing, and when it was taken — `Picture 7 of 18 · 1.2 s
 * before you pressed`, and for the last `Picture 18 of 18 · the moment you pressed`.
 *
 * **The last is "the moment you pressed" whatever its clock says**: it is the newest thing the
 * scanner had been shown at the press, and it is the picture the reader's answer is about — so
 * it is named for what it is to them. Every other is given in tenths of a second and never as
 * `0.0`, which would say two pictures were taken at once.
 */
export function pictureLine(n: number, total: number, ms: number): string {
  if (n >= total) return `${pictureOf(n, total)} · the moment you pressed`;
  const seconds = Math.max(0.1, Math.round(-ms / 100) / 10).toFixed(1);
  return `${pictureOf(n, total)} · ${seconds} s before you pressed`;
}

/** The press that walks the pictures once, first to last — and what it says while it does. */
export const PLAY = "Play";
export const STOP_PLAYING = "Stop";

/**
 * Over the search box — and its label, so the question and the box's name are one sentence.
 * **The last picture**, because a run can begin on one card and end on another, and the answer
 * names the one under the camera at the press.
 */
export const WHICH_CARD = "Which card is in the last picture?";

export const SEARCH_PLACEHOLDER = "Card name…";

/**
 * The other answer to {@link WHICH_CARD}: there is no card in the last picture — the scanner was
 * looking for one in an empty desk, a sleeve, a hand. A switch, beside the question it answers.
 * **"Picture" and never "frame"**, for this file's rule: to a reader each one is a picture.
 */
export const NO_CARD = "No card in the picture";

/** Under the switch while it is on: what the answer is for, so it is not mistaken for a skip. */
export const NO_CARD_NOTE =
  "Sent as a scan with nothing to find, so the scanner can learn what is not a card.";

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
export const CHOOSE_THE_CARD = "Choose the card in the last picture.";
export const CHOOSE_ITS_FINISH = "Choose its finish.";

/**
 * What is sent, to whom, and what is not — above the press, always, and never behind one.
 *
 * **It counts the pictures**, because the count is the thing a reader could not have guessed: a
 * press on *Send scan…* sends the last couple of seconds the scanner saw, not the one picture on
 * screen, and every one of them is theirs to look through first.
 *
 * **Every clause is a promise the engine keeps**: the submission is the pictures, the
 * printing's id and finish, what the scanner had answered and how it was set — its mode, and the
 * sets and dates it was narrowed to (`ScannerSubmission` in `lib/ipc.ts`) — and the app's version
 * and which app it is, which the engine adds (`Label` in `scanner_submit.rs`); nothing of the
 * collection rides with it. **It lists what is sent rather
 * than saying "nothing else"**, because there is a little else and a reader is owed the list.
 *
 * **And it says nothing is _kept_ that says who they are — not that nothing is sent.** A request
 * arrives from an address, as every request does, and the inbox uses it to limit how often one
 * address may send; what it stores has no address, device or account in it. The privacy policy
 * says the same at length. A field added to either struct is a sentence owed here, and there.
 */
export function disclosure(pictures: number): string {
  return (
    `These ${pictures} pictures — the last couple of seconds the scanner saw — and the card you ` +
    "choose, or that there is none, are sent to MTG Grimoire's maker, with what the scanner read and how it was set, the " +
    "app's version and which app it is, and kept to improve the scanner. Nothing from your " +
    "collection is sent, and nothing is kept that says who you are. Look through them and check " +
    "they show only what you mean to send."
  );
}

export const CANCEL = "Cancel";
/** The dialog's own press: no ellipsis, because this one opens nothing — it sends. */
export const SEND = "Send scan";
export const SENDING = "Sending…";

export const SENT = "Sent — thank you.";
export const REFERENCE = "Reference:";
/** Nothing kept says who sent it, so the reference is the only way back to one scan. */
export const KEEP_THE_REFERENCE = "Keep the reference if you ever want these pictures deleted.";
export const DONE = "Done";
